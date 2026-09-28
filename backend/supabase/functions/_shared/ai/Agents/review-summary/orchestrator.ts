import type { ModelPort } from "../../providers/model-port.ts";
import type {
  ReviewSummaryJob, ReviewSummaryRepository, SummaryCheckpoint, SummaryNode, SummaryWriteResult, PublicTextReview,
} from "../../../db/repositories/review-summaries.ts";
import { loadReviewSource, validateSummaryJob } from "./source-loader.ts";
import { MIN_PUBLIC_TEXT_REVIEWS } from "./eligibility.ts";
import { sameEvidence } from "./evidence-check.ts";
import { checkSummaryOutput } from "./output-check.ts";
import type { SummarySafetyPort } from "./output-check.ts";
import { REVIEW_CHUNK_SYSTEM, REVIEW_MERGE_SYSTEM, REVIEW_SUMMARY_PROMPT_VERSION } from "./prompts.ts";
import { publishSummary } from "./publisher.ts";

export interface ReviewSummarySettings {
  maxInputChars: number;
  maxReviewsPerChunk: number;
  mergeFanIn: number;
  maxOutputTokens: number;
  maxOutputChars: number;
  maxCallsPerStep: number;
}
export type ReviewSummaryResult = {
  status: "published" | "yielded" | "insufficient_reviews" | "superseded" | "lease_lost" | "failed" | "unavailable";
  code?: string;
};
export interface ReviewSummaryDependencies {
  repository: ReviewSummaryRepository;
  model: ModelPort;
  safety: SummarySafetyPort;
  settings: ReviewSummarySettings;
  signal?: AbortSignal;
}

function validateSettings(settings: ReviewSummarySettings) {
  if (!settings || Object.values(settings).some((n) => !Number.isSafeInteger(n) || n < 1) ||
      !["maxInputChars", "maxReviewsPerChunk", "mergeFanIn", "maxOutputTokens", "maxOutputChars", "maxCallsPerStep"]
        .every((key) => Number.isSafeInteger(settings[key as keyof ReviewSummarySettings])) ||
      settings.mergeFanIn < 2) throw new Error("INVALID_SUMMARY_SETTINGS");
}
function validateCheckpoint(checkpoint: SummaryCheckpoint, job: ReviewSummaryJob, ids: string[], maxChars: number) {
  if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.targetUserId !== job.targetUserId ||
      checkpoint.sourceRevision !== job.sourceRevision || checkpoint.promptVersion !== REVIEW_SUMMARY_PROMPT_VERSION ||
      !Array.isArray(checkpoint.sourceReviewIds) || !sameEvidence(checkpoint.sourceReviewIds, ids) ||
      checkpoint.sourceReviewIds.some((id, i) => id !== ids[i]) || !Array.isArray(checkpoint.nodes) ||
      !Number.isSafeInteger(checkpoint.nextReviewIndex) || checkpoint.nextReviewIndex < 0 || checkpoint.nextReviewIndex > ids.length) {
    throw new Error("INVALID_SUMMARY_CHECKPOINT");
  }
  const covered: string[] = [];
  for (const node of checkpoint.nodes) {
    if (!node || typeof node !== "object" || !Array.isArray(node.sourceReviewIds) || !Array.isArray(node.modelVersions) || !node.modelVersions.length ||
        node.modelVersions.some((v) => typeof v !== "string" || !v.trim())) throw new Error("INVALID_SUMMARY_CHECKPOINT");
    checkSummaryOutput({ claims: node.claims }, node.sourceReviewIds, maxChars);
    covered.push(...node.sourceReviewIds);
  }
  if (!sameEvidence(covered, ids.slice(0, checkpoint.nextReviewIndex))) throw new Error("INVALID_SUMMARY_CHECKPOINT");
}
function fitInput(system: string, input: unknown, limit: number) {
  return system.length + JSON.stringify(input).length <= limit;
}
function mergeInput(nodes: SummaryNode[]) {
  // 모델에 전체 후기 ID 목록을 반복하지 않는다. 내부 그룹 ID를 다시 실제 근거 ID로 확장한다.
  return { summaries: nodes.map((node, index) => ({
    evidenceId: "group-" + index, text: node.claims.map((claim) => claim.text).join(" "),
  })) };
}
async function rejectedWrite(repo: ReviewSummaryRepository, job: ReviewSummaryJob, status: SummaryWriteResult): Promise<ReviewSummaryResult> {
  if (status === "lease_lost") return { status: "lease_lost" };
  const discarded = await repo.discardCheckpoint(job);
  if (discarded === "lease_lost") return { status: "lease_lost" };
  if (status === "stale_revision") return { status: "superseded" };
  if (status === "insufficient_reviews") return { status: "insufficient_reviews" };
  return { status: "failed", code: "INVALID_EVIDENCE" };
}

/**
 * 모델 호출 수가 제한된 한 번의 실행. 재호출은 같은 job의 최신 lease로 checkpoint부터 이어간다.
 * 실제 DB/RLS, 모델 보관·의미 검사는 주입 포트 구현과 별도 통합 검증이 필요하다.
 */
export async function runReviewSummaryStep(job: ReviewSummaryJob, deps: ReviewSummaryDependencies): Promise<ReviewSummaryResult> {
  validateSummaryJob(job);
  validateSettings(deps.settings);
  const { repository, model, safety, settings, signal } = deps;
  try {
    const source = await loadReviewSource(repository, job);
    if (source === "lease_lost") return { status: "lease_lost" };
    if (source === "stale_revision") return await rejectedWrite(repository, job, source);
    const reviews = source.publicTextReviews;
    if (reviews.length < MIN_PUBLIC_TEXT_REVIEWS) {
      const status = await repository.markInsufficient(job);
      return status === "applied" ? { status: "insufficient_reviews" } : await rejectedWrite(repository, job, status);
    }
    const ids = reviews.map((review) => review.evidenceId);
    const stored = await repository.loadCheckpoint(job);
    if (stored === "lease_lost") return { status: "lease_lost" };
    const checkpoint: SummaryCheckpoint = stored ?? {
      schemaVersion: 1, targetUserId: job.targetUserId, sourceRevision: job.sourceRevision,
      promptVersion: REVIEW_SUMMARY_PROMPT_VERSION, sourceReviewIds: ids, nextReviewIndex: 0, nodes: [],
    };
    validateCheckpoint(checkpoint, job, ids, settings.maxOutputChars);
    let calls = 0;
    while (calls < settings.maxCallsPerStep && !signal?.aborted) {
      if (checkpoint.nextReviewIndex === reviews.length && checkpoint.nodes.length === 1) break;
      let input: unknown;
      let expectedIds: string[];
      let merged: SummaryNode[] | null = null;
      let chunk: PublicTextReview[] = [];
      if (checkpoint.nextReviewIndex < reviews.length) {
        for (const review of reviews.slice(checkpoint.nextReviewIndex, checkpoint.nextReviewIndex + settings.maxReviewsPerChunk)) {
          const candidate = [...chunk, review];
          if (!fitInput(REVIEW_CHUNK_SYSTEM, { reviews: candidate }, settings.maxInputChars)) break;
          chunk = candidate;
        }
        if (!chunk.length) throw new Error("SUMMARY_INPUT_TOO_LARGE");
        input = { reviews: chunk };
        expectedIds = chunk.map((review) => review.evidenceId);
      } else {
        let selectedNodes: SummaryNode[] = [];
        for (const node of checkpoint.nodes.slice(0, settings.mergeFanIn)) {
          const candidate: SummaryNode[] = [...selectedNodes, node];
          if (!fitInput(REVIEW_MERGE_SYSTEM, mergeInput(candidate), settings.maxInputChars)) break;
          selectedNodes = candidate;
        }
        if (selectedNodes.length < 2) throw new Error("SUMMARY_INPUT_TOO_LARGE");
        merged = selectedNodes;
        input = mergeInput(selectedNodes);
        expectedIds = selectedNodes.map((_, index) => "group-" + index);
      }
      let response;
      try {
        response = await model.generate({
          task: merged ? "review_merge" : "review_chunk",
          system: merged ? REVIEW_MERGE_SYSTEM : REVIEW_CHUNK_SYSTEM,
          input, maxOutputTokens: settings.maxOutputTokens, signal,
        });
      } catch {
        return signal?.aborted ? { status: "yielded" } : { status: "unavailable", code: "MODEL_UNAVAILABLE" };
      }
      calls += 1;
      if (!response || typeof response.modelVersion !== "string" || !response.modelVersion.trim()) throw new Error("INVALID_SUMMARY_OUTPUT");
      const validated = checkSummaryOutput(response.value, expectedIds, settings.maxOutputChars);
      const claims = merged ? validated.map((claim) => ({
        text: claim.text,
        evidenceIds: claim.evidenceIds.flatMap((id) => merged![Number(id.slice("group-".length))].sourceReviewIds),
      })) : validated;
      const actualIds = merged ? merged.flatMap((node) => node.sourceReviewIds) : expectedIds;
      const sourceIds = new Set(actualIds);
      if (!await safety.check({ claims, publicTextReviews: reviews.filter((review) => sourceIds.has(review.evidenceId)) })) {
        throw new Error("UNSAFE_SUMMARY_OUTPUT");
      }
      const node: SummaryNode = {
        sourceReviewIds: actualIds, claims,
        modelVersions: [...new Set([...(merged?.flatMap((item) => item.modelVersions) ?? []), response.modelVersion])],
      };
      if (merged) checkpoint.nodes.splice(0, merged.length, node);
      else {
        checkpoint.nodes.push(node);
        checkpoint.nextReviewIndex += chunk.length;
      }
      const write = await repository.saveCheckpoint(job, checkpoint);
      if (write !== "applied") return await rejectedWrite(repository, job, write);
    }
    if (signal?.aborted || checkpoint.nextReviewIndex !== reviews.length || checkpoint.nodes.length !== 1) return { status: "yielded" };
    const final = checkpoint.nodes[0];
    // 재개된 checkpoint도 게시 전에 현재 원문과 함께 의미/개인정보를 검사한다.
    if (!await safety.check({ claims: final.claims, publicTextReviews: reviews })) throw new Error("UNSAFE_SUMMARY_OUTPUT");
    const write = await publishSummary(repository, {
      ...job, summaryText: final.claims.map((claim) => claim.text).join(" "), claims: final.claims,
      sourceReviewIds: final.sourceReviewIds, sourceReviewCount: reviews.length,
      promptVersion: REVIEW_SUMMARY_PROMPT_VERSION, modelVersions: final.modelVersions,
    }, ids);
    return write === "applied" ? { status: "published" } : await rejectedWrite(repository, job, write);
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    const permanent = new Set([
      "INVALID_REVIEW_SOURCE", "DUPLICATE_REVIEW_SOURCE", "INVALID_SUMMARY_CHECKPOINT",
      "INVALID_SUMMARY_OUTPUT", "SUMMARY_OUTPUT_TOO_LARGE", "UNSAFE_SUMMARY_OUTPUT",
      "INVALID_EVIDENCE", "INCOMPLETE_EVIDENCE", "INVALID_SUMMARY_PUBLICATION", "SUMMARY_INPUT_TOO_LARGE",
    ]);
    if (!permanent.has(code)) return { status: "unavailable", code: "DEPENDENCY_UNAVAILABLE" };
    try {
      const result = await repository.discardCheckpoint(job);
      if (result === "lease_lost") return { status: "lease_lost" };
    } catch {
      return { status: "unavailable", code: "DEPENDENCY_UNAVAILABLE" };
    }
    return { status: "failed", code };
  }
}
