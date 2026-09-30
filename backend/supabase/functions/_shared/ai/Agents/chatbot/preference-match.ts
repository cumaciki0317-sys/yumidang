/**
 * 관심사·대화 방식 C 방식 의미 판단. 모델은 요청 값별로 후보 등록값과의 유사 여부만 답하고,
 * 부정(exclude)·결합(any/all)·미입력 처리는 서버가 계산한다.
 * 세 상태를 구분한다: 불일치 → 제외 / 미입력 → 확인 필요 / 판단 실패 → PreferenceJudgmentError(완료 불가).
 * 모델 입력에는 불투명 ref와 요청·등록값만 넣고 공고 ID·이름·제목을 넣지 않는다.
 */
import type { ConditionState, PreferenceCondition } from "../../../contracts/ai.ts";
import type { ModelPort } from "../../providers/model-port.ts";
import { ModelError } from "../../providers/provider-errors.ts";
import { PREFERENCE_MATCH_PROMPT } from "./prompts.ts";

export type Similarity = "similar" | "different";
export type PreferenceField = "interests" | "conversationStyles";
export const PREFERENCE_FIELDS: readonly PreferenceField[] = ["interests", "conversationStyles"];
export interface PreferenceJudgeCandidate { ref: string; interests?: string[]; conversationStyles?: string[] }
export interface PreferenceJudgeInput {
  requested: { interests?: string[]; conversationStyles?: string[] };
  candidates: PreferenceJudgeCandidate[];
}
export type PreferenceJudgments = Map<string, { interests?: Similarity[]; conversationStyles?: Similarity[] }>;

/** 모델 오류·형식 위반으로 판단을 끝내지 못한 상태. 미입력이나 일치로 바꾸지 않는다. */
export class PreferenceJudgmentError extends Error {
  constructor() { super("PREFERENCE_JUDGMENT_FAILED"); this.name = "PreferenceJudgmentError"; }
}

const refPattern = /^c[1-9][0-9]{0,3}$/;

/** 입력과 1:1로 정렬된 판정만 허용한다. 누락·중복·추가 키·길이 불일치는 전부 판단 실패다. */
export function parsePreferenceJudgments(raw: unknown, input: PreferenceJudgeInput): PreferenceJudgments {
  const fail = (): never => { throw new PreferenceJudgmentError(); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).length !== 1 || !Array.isArray(body.judgments)) return fail();
  const expected = new Map(input.candidates.map((c) => [c.ref, c]));
  const result: PreferenceJudgments = new Map();
  for (const row of body.judgments as unknown[]) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return fail();
    const judgment = row as Record<string, unknown>;
    const ref = judgment.ref;
    if (typeof ref !== "string" || !expected.has(ref) || result.has(ref)) return fail();
    const candidate = expected.get(ref)!;
    const sentFields = PREFERENCE_FIELDS.filter((field) => candidate[field] !== undefined);
    const keys = Object.keys(judgment);
    if (keys.length !== sentFields.length + 1 || keys.some((key) => key !== "ref" && !sentFields.includes(key as PreferenceField))) return fail();
    const parsed: { interests?: Similarity[]; conversationStyles?: Similarity[] } = {};
    for (const field of sentFields) {
      const values = judgment[field];
      const requested = input.requested[field];
      if (!requested || !Array.isArray(values) || values.length !== requested.length ||
        values.some((value) => value !== "similar" && value !== "different")) return fail();
      parsed[field] = [...values] as Similarity[];
    }
    result.set(ref, parsed);
  }
  if (result.size !== expected.size) return fail();
  return result;
}

function assertJudgeInput(input: PreferenceJudgeInput): void {
  const fields = PREFERENCE_FIELDS.filter((field) => input.requested[field] !== undefined);
  if (!fields.length || !input.candidates.length || fields.some((field) => !input.requested[field]!.length)) throw new PreferenceJudgmentError();
  const refs = new Set<string>();
  for (const candidate of input.candidates) {
    if (!refPattern.test(candidate.ref) || refs.has(candidate.ref)) throw new PreferenceJudgmentError();
    refs.add(candidate.ref);
    const present = PREFERENCE_FIELDS.filter((field) => candidate[field] !== undefined);
    // 요청하지 않은 종류·빈 등록값은 보내지 않는다(빈 값은 미입력 = 확인 필요로 서버가 처리).
    if (!present.length || present.some((field) => !fields.includes(field) || !candidate[field]!.length) ||
      Object.keys(candidate).some((key) => key !== "ref" && !PREFERENCE_FIELDS.includes(key as PreferenceField))) throw new PreferenceJudgmentError();
  }
}

/** 한 번의 모델 호출. 호출 횟수·묶음 크기의 한도는 호출자(탐색 어댑터)가 설정값으로 관리한다. */
export async function judgePreferences(model: ModelPort, input: PreferenceJudgeInput,
  options: { maxOutputTokens: number; signal?: AbortSignal }): Promise<PreferenceJudgments> {
  assertJudgeInput(input);
  let response;
  try {
    response = await model.generate({ task: "preference_match", system: PREFERENCE_MATCH_PROMPT, input,
      maxOutputTokens: options.maxOutputTokens, signal: options.signal });
  } catch (error) {
    // 안전한 예산 분류만 보존한다. 공급사 원문 오류나 임의 code 속성은 전달하지 않는다.
    if (error instanceof ModelError && error.code === "BUDGET_EXHAUSTED") throw new ModelError("BUDGET_EXHAUSTED");
    throw new PreferenceJudgmentError();
  }
  return parsePreferenceJudgments(response?.value, input);
}

/**
 * 한 조건의 서버 계산. similarities[i]는 요청 값 i와 후보 등록값 중 하나라도 유사한지다.
 * exclude 값과 유사하면 불일치, include 값은 combine(any/all)으로 결합한다. include가 없으면 exclude만 적용한다.
 */
export function evaluatePreferenceCondition(condition: PreferenceCondition, similarities: readonly Similarity[]): boolean {
  if (similarities.length !== condition.values.length) throw new PreferenceJudgmentError();
  const include: boolean[] = [];
  for (const [index, value] of condition.values.entries()) {
    const similar = similarities[index] === "similar";
    if (value.polarity === "exclude") { if (similar) return false; }
    else include.push(similar);
  }
  if (!include.length) return true;
  if (include.length > 1 && condition.combine === undefined) throw new PreferenceJudgmentError();
  return condition.combine === "all" ? include.every(Boolean) : include.some(Boolean);
}

/** 등록값이 비었으면 needs_check, 아니면 판정 결과로 match/mismatch. 판정이 없으면 실패로 처리한다. */
export function preferenceFieldState(condition: PreferenceCondition, registered: readonly string[],
  similarities: readonly Similarity[] | undefined): ConditionState | "mismatch" {
  if (!registered.length) return "needs_check";
  if (!similarities) throw new PreferenceJudgmentError();
  return evaluatePreferenceCondition(condition, similarities) ? "match" : "mismatch";
}
