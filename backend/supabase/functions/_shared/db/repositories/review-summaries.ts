/**
 * 종현: 요약 저장소 연결 계약과 제안 SQL 03 RPC 어댑터(createRpcReviewSummaryRepository).
 * 원자성·권한은 DB RPC가 보장한다. RPC는 민규 채택·내부 클라이언트 허용 목록 추가 전까지 운영에서 호출할 수 없다.
 */
import type { JsonValue } from "../../contracts/common.ts";
import type { RpcClient } from "../transport.ts";
export interface ReviewSummaryJob {
  jobId: string;
  leaseToken: string;
  targetUserId: string;
  sourceRevision: string;
  /** 요청한 실행 설정 버전. 실제 fallback 모델 목록과 구분한다. */
  modelVersion: string;
  promptVersion: string;
}
export interface PublicTextReview { evidenceId: string; comment: string | null }
export interface ReviewSourceSnapshot {
  targetUserId: string;
  sourceRevision: string;
  /** DB가 회원 공개 자격을 확인한 집합. 당사자 released와 다르다. */
  publicTextReviews: PublicTextReview[];
}
export interface SummaryClaim { text: string; evidenceIds: string[] }
export interface SummaryNode {
  sourceReviewIds: string[];
  claims: SummaryClaim[];
  modelVersions: string[];
}
export interface SummaryCheckpoint {
  schemaVersion: 1;
  targetUserId: string;
  sourceRevision: string;
  modelVersion: string;
  promptVersion: string;
  /** 입력을 자르지 않고 모든 원문을 처리했는지 검증하는 전체 집합. */
  sourceReviewIds: string[];
  nextReviewIndex: number;
  nodes: SummaryNode[];
}
export type SummaryWriteResult =
  | "applied" | "lease_lost" | "stale_revision" | "insufficient_reviews" | "invalid_evidence";
export interface SummaryPublishInput extends ReviewSummaryJob {
  summaryText: string;
  claims: SummaryClaim[];
  sourceReviewIds: string[];
  sourceReviewCount: number;
  promptVersion: string;
  modelVersions: string[];
}
export interface ReviewSummaryRepository {
  /** 조회·모든 쓰기는 현재 점유 토큰과 revision을 확인한다. 원문은 일관된 snapshot. */
  /**
   * already_published: 같은 작업·revision의 게시가 이미 원자 처리됨(settle 전 중단 후 재실행). 모델을 다시 호출하지 않는다.
   * stale_revision: 대상 프로필이 사라지는 등 현재 snapshot을 만들 수 없음.
   */
  loadSource(job: ReviewSummaryJob): Promise<ReviewSourceSnapshot | "lease_lost" | "already_published" | "stale_revision">;
  loadCheckpoint(job: ReviewSummaryJob): Promise<SummaryCheckpoint | null | "lease_lost" | "stale_revision">;
  /** private 저장, raw 원문 없음. 저장 시 token/revision/근거집합을 원자적으로 재확인. */
  saveCheckpoint(job: ReviewSummaryJob, checkpoint: SummaryCheckpoint): Promise<SummaryWriteResult>;
  /**
   * 게시와 checkpoint 삭제를 한 트랜잭션에서 수행. 현재 공개 전체집합과 정확히 일치해야 함.
   * 작업 settle은 별도 호출이므로 (jobId, sourceRevision)의 게시 효과는 멱등이어야 한다.
   * 게시 후 settle 전 중단되어 재실행해도 원래 게시 결과/시각을 다시 쓰거나 알림을 중복 생성하지 않는다.
   * 멱등 재호출도 현재 leaseToken/revision/공개 자격을 검사한 후 applied를 반환한다.
   */
  publish(input: SummaryPublishInput): Promise<SummaryWriteResult>;
  /** 3개 미만 상태와 checkpoint 삭제. DB가 실제 개수·revision·점유를 재확인. */
  markInsufficient(job: ReviewSummaryJob): Promise<SummaryWriteResult>;
  /** 현재 소유자만 해당 작업의 checkpoint를 삭제; 다른 revision의 새 작업에 영향 금지. */
  discardCheckpoint(job: ReviewSummaryJob): Promise<"applied" | "lease_lost">;
}
// 공개 집합 변경의 revision 증가 + 요약 무효화 + checkpoint 삭제 + 재작업 예약(outbox) 기록은
// 원문 변경 DB 트랜잭션에 속한다. 실제 큐 등록은 이후 maintenance가 수행한다.
// 이 포트로 순차 호출해 원자적 처리를 흉내 내지 않는다.

/** PostgreSQL bigint revision을 정밀도 손실 없이 검증한다. Number로 변환하지 않는다. */
export function isSourceRevision(value: unknown): value is string {
  return typeof value === "string" && value.length <= 19 && /^(0|[1-9][0-9]*)$/.test(value) &&
    BigInt(value) <= 9223372036854775807n;
}
/** 요청 설정 버전의 문자·길이는 민규 DB 계약과 동일하다. */
export function isSummaryVersion(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value);
}

// ---- 제안 SQL 03 RPC 어댑터 ------------------------------------------------------------------
/** 요약 worker가 사용하는 신규 RPC. 민규 내부 클라이언트 허용 목록 추가가 필요하다. */
export const REVIEW_SUMMARY_RPCS = [
  "load_review_summary_source", "load_review_summary_checkpoint", "save_review_summary_checkpoint",
  "discard_review_summary_checkpoint", "mark_review_summary_insufficient", "publish_review_summary_for_job",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITE_RESULTS: ReadonlySet<string> = new Set(["applied", "lease_lost", "stale_revision", "insufficient_reviews", "invalid_evidence"]);

export class SummaryWireError extends Error {
  constructor() { super("INVALID_SUMMARY_RESPONSE"); this.name = "SummaryWireError"; }
}
const wire = (): never => { throw new SummaryWireError(); };
function record(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return wire();
  return value;
}
function exactKeys(value: Record<string, JsonValue>, keys: readonly string[]): Record<string, JsonValue> {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) return wire();
  return value;
}
function uuidList(value: JsonValue | undefined, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) ||
      value.some((id) => typeof id !== "string" || !UUID.test(id)) || new Set(value).size !== value.length) return wire();
  return value as string[];
}
/** 작업 식별·revision 인수. DB와 같은 UUID/십진 문자열 규칙을 호출 전에 확인한다. */
function jobArgs(job: ReviewSummaryJob, withRevision: boolean): Record<string, JsonValue> {
  if (!job || typeof job.jobId !== "string" || !UUID.test(job.jobId) || typeof job.leaseToken !== "string" ||
      !UUID.test(job.leaseToken) || typeof job.targetUserId !== "string" || !UUID.test(job.targetUserId) ||
      !isSourceRevision(job.sourceRevision) || !isSummaryVersion(job.modelVersion) || !isSummaryVersion(job.promptVersion)) {
    throw new Error("INVALID_SUMMARY_JOB");
  }
  return withRevision
    ? { p_job_id: job.jobId, p_lease_token: job.leaseToken, p_source_revision: job.sourceRevision }
    : { p_job_id: job.jobId, p_lease_token: job.leaseToken };
}
function status(value: JsonValue): string {
  const body = record(value);
  if (typeof body.status !== "string") return wire();
  return body.status;
}
function writeResult(value: JsonValue): SummaryWriteResult {
  const body = exactKeys(record(value), ["status"]);
  if (typeof body.status !== "string" || !WRITE_RESULTS.has(body.status)) return wire();
  return body.status as SummaryWriteResult;
}
/** DB 중간 저장(원문 없음) → 내부 checkpoint. 이름 차이 profileId→targetUserId를 명시적으로 바꾼다. */
function toCheckpoint(value: JsonValue, job: ReviewSummaryJob): SummaryCheckpoint {
  const row = exactKeys(record(value), ["profileId", "sourceRevision", "modelVersion", "promptVersion",
    "schemaVersion", "sourceReviewIds", "nextReviewIndex", "nodes"]);
  if (row.profileId !== job.targetUserId || row.sourceRevision !== job.sourceRevision || row.modelVersion !== job.modelVersion ||
      row.promptVersion !== job.promptVersion || row.schemaVersion !== 1 || !Array.isArray(row.nodes) ||
      typeof row.nextReviewIndex !== "number" || !Number.isSafeInteger(row.nextReviewIndex) || row.nextReviewIndex < 0) return wire();
  const sourceReviewIds = uuidList(row.sourceReviewIds, true);
  const nodes: SummaryNode[] = row.nodes.map((raw) => {
    const node = exactKeys(record(raw), ["sourceReviewIds", "claims", "modelVersions"]);
    if (!Array.isArray(node.claims) || !node.claims.length || !Array.isArray(node.modelVersions) || !node.modelVersions.length ||
        node.modelVersions.some((v) => typeof v !== "string" || !v.trim())) return wire();
    return {
      sourceReviewIds: uuidList(node.sourceReviewIds, false),
      claims: node.claims.map((rawClaim) => {
        const claim = exactKeys(record(rawClaim), ["text", "evidenceIds"]);
        if (typeof claim.text !== "string" || !claim.text.trim()) return wire();
        return { text: claim.text, evidenceIds: uuidList(claim.evidenceIds, false) };
      }),
      modelVersions: node.modelVersions as string[],
    };
  });
  return {
    schemaVersion: 1, targetUserId: job.targetUserId, sourceRevision: job.sourceRevision,
    modelVersion: job.modelVersion, promptVersion: job.promptVersion,
    sourceReviewIds, nextReviewIndex: row.nextReviewIndex, nodes,
  };
}

/**
 * 제안 SQL 03 RPC로 ReviewSummaryRepository를 구현한다.
 * 변환: profileId↔targetUserId, reviewId→evidenceId, text→comment, bigint revision은 십진 문자열 그대로.
 * 점유 손실·revision 불일치 등은 DB가 status 값으로 반환한다. 전송·권한 오류는 그대로 던진다.
 */
export function createRpcReviewSummaryRepository(db: RpcClient): ReviewSummaryRepository {
  if (!db || typeof db.rpc !== "function") throw new TypeError("INVALID_SUMMARY_DB");
  return Object.freeze({
    async loadSource(job: ReviewSummaryJob) {
      const body = record(await db.rpc("load_review_summary_source", jobArgs(job, false)));
      const state = status(body);
      if (state === "lease_lost" || state === "already_published" || state === "stale_revision") {
        exactKeys(body, ["status"]);
        return state;
      }
      if (state !== "applied") return wire();
      exactKeys(body, ["status", "profileId", "sourceRevision", "reviews", "eligibleCount"]);
      if (body.profileId !== job.targetUserId || !isSourceRevision(body.sourceRevision) || !Array.isArray(body.reviews) ||
          body.eligibleCount !== body.reviews.length) return wire();
      const publicTextReviews: PublicTextReview[] = body.reviews.map((raw) => {
        const review = exactKeys(record(raw), ["reviewId", "text"]);
        if (typeof review.reviewId !== "string" || !UUID.test(review.reviewId) || typeof review.text !== "string") return wire();
        return { evidenceId: review.reviewId, comment: review.text };
      });
      if (new Set(publicTextReviews.map((review) => review.evidenceId)).size !== publicTextReviews.length) return wire();
      return { targetUserId: body.profileId, sourceRevision: body.sourceRevision as string, publicTextReviews };
    },
    async loadCheckpoint(job: ReviewSummaryJob) {
      const body = record(await db.rpc("load_review_summary_checkpoint", jobArgs(job, true)));
      const state = status(body);
      if (state === "lease_lost" || state === "stale_revision") {
        exactKeys(body, ["status"]);
        return state;
      }
      if (state !== "applied") return wire();
      exactKeys(body, ["status", "checkpoint"]);
      return body.checkpoint === null ? null : toCheckpoint(body.checkpoint, job);
    },
    async saveCheckpoint(job: ReviewSummaryJob, checkpoint: SummaryCheckpoint) {
      const args = jobArgs(job, true);
      // 다른 작업·버전의 checkpoint를 이 작업 키로 저장하지 않는다. 원문 필드는 보내지 않는다.
      if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.targetUserId !== job.targetUserId ||
          checkpoint.sourceRevision !== job.sourceRevision || checkpoint.modelVersion !== job.modelVersion ||
          checkpoint.promptVersion !== job.promptVersion || !Array.isArray(checkpoint.nodes)) throw new Error("INVALID_SUMMARY_CHECKPOINT");
      const payload: JsonValue = {
        schemaVersion: 1,
        sourceReviewIds: [...checkpoint.sourceReviewIds],
        nextReviewIndex: checkpoint.nextReviewIndex,
        nodes: checkpoint.nodes.map((node) => ({
          sourceReviewIds: [...node.sourceReviewIds],
          claims: node.claims.map((claim) => ({ text: claim.text, evidenceIds: [...claim.evidenceIds] })),
          modelVersions: [...node.modelVersions],
        })),
      };
      return writeResult(await db.rpc("save_review_summary_checkpoint", { ...args, p_checkpoint: payload }));
    },
    async publish(input: SummaryPublishInput) {
      const args = jobArgs(input, true);
      if (typeof input.summaryText !== "string" || !Array.isArray(input.sourceReviewIds) ||
          input.sourceReviewIds.some((id) => typeof id !== "string" || !UUID.test(id)) ||
          input.sourceReviewCount !== input.sourceReviewIds.length) throw new Error("INVALID_SUMMARY_PUBLICATION");
      const body = record(await db.rpc("publish_review_summary_for_job", {
        ...args, p_evidence_review_ids: [...input.sourceReviewIds], p_summary: input.summaryText,
        p_model_version: input.modelVersion, p_prompt_version: input.promptVersion,
      }));
      const state = status(body);
      if (state !== "applied") return writeResult(body);
      exactKeys(body, ["status", "summaryId", "sourceRevision", "sourceCount", "publishedAt"]);
      if (typeof body.summaryId !== "string" || !UUID.test(body.summaryId) || body.sourceRevision !== input.sourceRevision ||
          body.sourceCount !== input.sourceReviewCount || typeof body.publishedAt !== "string") return wire();
      return "applied";
    },
    async markInsufficient(job: ReviewSummaryJob) {
      return writeResult(await db.rpc("mark_review_summary_insufficient", jobArgs(job, true)));
    },
    async discardCheckpoint(job: ReviewSummaryJob) {
      const result = writeResult(await db.rpc("discard_review_summary_checkpoint", jobArgs(job, true)));
      if (result !== "applied" && result !== "lease_lost") return wire();
      return result;
    },
  });
}
