import { ModelError } from "../../providers/provider-errors.ts";
import { AiPrivacyError } from "../../providers/privacy.ts";
import { AiInputError } from "../../../contracts/ai.ts";
import type { AiChatResult, ChatInput, ChatLimits, TrustedChatContext } from "../../../contracts/ai.ts";
import type { ModelPort } from "../../providers/model-port.ts";
import { buildContext } from "./context.ts";
import { parseIntent, validateFilters } from "./intent.ts";
import { resolveDateRange } from "./date-range.ts";
import { INTENT_PROMPT, EXPLANATION_PROMPT } from "./prompts.ts";
import type { PublicDiscoveryPort } from "./tools.ts";
import { projectCards } from "./result-builder.ts";
import { checkExplanations, type ExplanationCheck } from "./output-check.ts";
/**
 * discovery는 공고 탐색 포트다. events는 행사 탐색 포트이며 연결 전에는 생략한다(행사 요청은 unavailable).
 * verifyExplanation이 없으면 생성 설명을 만들지 않는다(의미 검사 기준 확정 전).
 */
export interface ChatDependencies { model: ModelPort; discovery: PublicDiscoveryPort; events?: PublicDiscoveryPort; limits: ChatLimits; now: () => Date; verifyExplanation?: ExplanationCheck; }
export const CHAT_NOTICES = {
  generic: "탐색을 완료하지 못했습니다. 다시 시도하거나 일반 탐색을 이용해주세요.",
  incomplete: "요청한 조건을 모두 확인하지 못했습니다. 조건을 좁히거나 잠시 후 다시 시도해주세요.",
  changed: "결과가 방금 변경되어 확인하지 못했습니다. 다시 검색해주세요.",
  eventsNotConnected: "행사 AI 탐색은 아직 연결되지 않았습니다. 일반 행사 탐색을 이용해주세요.",
  partial: "요청한 조건을 일부만 확인했어요. 더 찾으려면 조건을 좁혀 다시 요청해주세요.",
  needsCheck: "일부 공고는 요청한 성향이 등록되지 않아 확인이 필요합니다.",
  combineQuestion: "말씀하신 성향 중 하나만 맞아도 될까요, 모두 맞아야 할까요?",
} as const;
export async function runChat(input: ChatInput, principal: TrustedChatContext, deps: ChatDependencies, requestId: string, signal?: AbortSignal): Promise<AiChatResult> {
  // 인증된 공통 서버 계층이 전달한 주체만 사용한다. 클라이언트 본문은 인증 근거가 아니다.
  if(!principal?.userId) throw new Error("UNAUTHENTICATED");
  if (!input || typeof input !== "object") throw new Error("INVALID_INPUT");
  const initial=validateFilters(input.currentFilters);
  const base: AiChatResult={requestId,status:"unavailable",interpretedFilters:initial,cards:[],explanations:[]};
  let context;
  try { context=buildContext(input,principal,deps.limits); }
  catch(error) {
    if(error instanceof Error && error.message==="NEW_EXPLORATION_REQUIRED") return {...base,status:"needs_clarification",clarificationQuestion:"확정한 조건을 유지한 채 새 탐색을 시작할까요?",notice:"대화 길이 한도에 도달했습니다."};
    throw error;
  }
  if (initial.target === "events" && initial.cost === "paid") return { ...base, status:"needs_clarification", clarificationQuestion:"공식 무료 여부만 확인할 수 있어요. 무료 행사만 찾거나 비용 조건 없이 볼까요?" };
  // 지역을 추정하기 위한 외부 모델 전송도 하지 않는다.
  if (!initial.region) return { ...base, status: "needs_clarification", clarificationQuestion: "어느 지역에서 동행이나 행사를 찾을까요?" };
  const checkCancelled=()=>{if(signal?.aborted) throw new Error("CANCELLED");};
  try {
    checkCancelled(); const now=deps.now();
    const interpreted=await deps.model.generate({task:"intent",system:INTENT_PROMPT,input:{...context,referenceTime:now.toISOString(),timeZone:"Asia/Seoul"},maxOutputTokens:deps.limits.maxOutputTokens,signal});
    checkCancelled();
    let intent;
    try { intent=parseIntent(interpreted.value); }
    catch(error) {
      // 여러 원하는 값의 AND/OR가 빠졌으면 서버가 추정하지 않고 질문한다.
      if(error instanceof AiInputError && error.message==="PREFERENCE_COMBINE_REQUIRED") return {...base,status:"needs_clarification",clarificationQuestion:CHAT_NOTICES.combineQuestion};
      throw error;
    }
    intent.filters.region ??= initial.region;
    base.interpretedFilters=intent.filters;
    if(intent.status==="clarify") return {...base,status:"needs_clarification",clarificationQuestion:intent.question};
    const port=intent.filters.target==="events" ? deps.events : deps.discovery;
    if(!port) return {...base,status:"unavailable",notice:CHAT_NOTICES.eventsNotConnected};
    const period=resolveDateRange(intent.filters.date,now);
    const found=await port.search({principal,filters:intent.filters,period,now,signal});
    checkCancelled();
    if(!found || !Array.isArray(found.cards) || !["exhausted","filled","incomplete"].includes(found.coverage)) throw new Error("INVALID_DISCOVERY_RESULT");
    // 한도·예산으로 후보 확인을 끝내지 못했으면(incomplete) 찾은 카드만 ‘일부 확인’으로 보여준다(Q1-A).
    // 찾은 카드가 없으면 결과 없음이 아니라 unavailable이다.
    let partial=found.coverage==="incomplete";
    const versions=new Map(found.cards.map(c=>[`${c?.kind}:${c?.id}`,c?.traitsVersion]));
    const cards=projectCards(found.cards,intent.filters);
    if(!cards.length) {
      if(partial) return {...base,status:"unavailable",notice:CHAT_NOTICES.incomplete};
      if(found.coverage!=="exhausted") throw new Error("INVALID_DISCOVERY_RESULT");
      return {...base,status:"no_results",notice:"조건에 맞는 결과가 없습니다. 조건을 변경해 다시 찾아보세요."};
    }
    let explanations: AiChatResult["explanations"]=[];
    let notice="검색 결과를 확인해주세요.";
    if(deps.verifyExplanation) {
      try {
        const response=await deps.model.generate({task:"explanation",system:EXPLANATION_PROMPT,input:{cards},maxOutputTokens:deps.limits.maxOutputTokens,signal});
        explanations=await checkExplanations(response.value,cards,deps.verifyExplanation); notice="";
      } catch (error) { if (error instanceof AiPrivacyError || (error instanceof ModelError && ["MEMBER_DAILY_LIMIT", "AI_CONSENT_REVOKED", "REQUEST_LEASE_LOST"].includes(error.code))) throw error; notice="설명을 만들지 못했습니다. 검색 결과를 확인해주세요."; }
    }
    checkCancelled();
    const allowed=new Map(cards.map(c=>[`${c.kind}:${c.id}`,JSON.stringify(c)]));
    const rechecked=await port.recheck({principal,filters:intent.filters,period,now,signal,cards:cards.map(c=>({kind:c.kind,id:c.id,
      ...(typeof versions.get(`${c.kind}:${c.id}`)==="string" ? {traitsVersion:versions.get(`${c.kind}:${c.id}`)} : {}),
      ...(c.conditionStatus ? {conditionStatus:{...c.conditionStatus}} : {})}))});
    if(!rechecked || !Array.isArray(rechecked.cards) || typeof rechecked.complete!=="boolean") throw new Error("INVALID_RECHECK");
    if (!rechecked.complete) {
      if (!rechecked.cards.length) return {...base,status:"unavailable",notice:CHAT_NOTICES.incomplete};
      partial = true;
    }
    const refreshed=projectCards(rechecked.cards,intent.filters);
    // 재조회로 새 ID가 섞이면 반환하지 않으며 변경된 카드의 옛 설명도 제거한다.
    if(refreshed.some(c=>!allowed.has(`${c.kind}:${c.id}`))) throw new Error("INVALID_RECHECK");
    const order=new Map(cards.map((c,i)=>[`${c.kind}:${c.id}`,i]));
    refreshed.sort((a,b)=>order.get(`${a.kind}:${a.id}`)!-order.get(`${b.kind}:${b.id}`)!);
    const fresh=new Map(refreshed.map(c=>[`${c.kind}:${c.id}`,JSON.stringify(c)]));
    explanations=explanations.filter(e=>fresh.get(`${e.kind}:${e.id}`)===allowed.get(`${e.kind}:${e.id}`));
    checkCancelled();
    if(!refreshed.length) {
      // 모든 후보를 확인한 뒤 사라졌으면 실제 0건이다. 분량을 채워 멈춘 경우 남은 후보를 보지 않았으므로 결과 없음으로 단정하지 않는다.
      return found.coverage==="exhausted"
        ? {...base,status:"no_results",notice:"조건에 맞는 결과가 없습니다. 조건을 변경해 다시 찾아보세요."}
        : {...base,status:"unavailable",notice:CHAT_NOTICES.changed};
    }
    const needsCheck=refreshed.some(c=>c.conditionStatus && Object.values(c.conditionStatus).includes("needs_check"));
    const notices=[...(partial ? [CHAT_NOTICES.partial] : []),...(needsCheck ? [CHAT_NOTICES.needsCheck] : []),...(!partial && !needsCheck && notice ? [notice] : [])];
    return {...base,status:"results",cards:refreshed,explanations,notice:notices.join(" "),...(partial ? {partial:true as const} : {})};
  } catch (error) {
    if (error instanceof AiPrivacyError) return { ...base, status: "unavailable", cards: [], explanations: [],
      notice: error.direction === "input" ? "개인정보가 포함되어 전송하지 않았어요. 내용을 수정해주세요." : "개인정보가 포함된 답변을 숨겼어요.",
      recovery: { reason: error.direction === "input" ? "input_privacy" : "output_privacy", retryAllowed: error.direction === "output" } };
    if (error instanceof ModelError && ["MEMBER_DAILY_LIMIT", "AI_CONSENT_REVOKED", "REQUEST_LEASE_LOST"].includes(error.code)) {
      const reason = error.code === "MEMBER_DAILY_LIMIT" ? "daily_limit" : error.code === "AI_CONSENT_REVOKED" ? "consent" : "temporary";
      return { ...base, status: "unavailable", notice: reason === "daily_limit" ? "오늘의 AI 이용 한도에 도달했어요. 한국시간 자정 이후 다시 이용해주세요." : reason === "consent" ? "AI 동의 철회로 새 전송이 중단됐어요. 일반 탐색을 이용해주세요." : CHAT_NOTICES.generic,
        recovery: { reason, retryAllowed: false } };
    }
    return {...base,status:"unavailable",notice:CHAT_NOTICES.generic, recovery: { reason: "temporary", retryAllowed: true }};
  }
}
