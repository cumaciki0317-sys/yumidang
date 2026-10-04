/** 제공사와 독립적인 구조화 생성 계약. 원문은 요청 메모리에서만 사용한다. */
export type ModelTask = "intent" | "preference_match" | "explanation" | "review_chunk" | "review_merge";
/** HTTP handler는 요청 동안 동일한 서버 scope 객체를 모든 단계에 공유한다. */
export interface MemberModelRequest { userId: string; requestId: string; leaseToken: string }
/** 내부 worker가 설정하는 외부 처리 시작 허가 범위. 원문은 포함하지 않는다. */
export interface SummaryModelRequest {
  jobId: string; leaseToken: string; targetUserId: string; sourceRevision: string;
  workerRunToken: string; modelVersion: string; promptVersion: string; sourceReviewIds: string[];
}
export interface ModelRequest {
  summaryRequest?: SummaryModelRequest;
  /** 서버가 요청 점유 뒤 추가한다. HTTP 본문에서 받아서는 안 된다. */
  memberRequest?: MemberModelRequest;
  task: ModelTask;
  system: string;
  input: unknown;
  maxOutputTokens: number;
  signal?: AbortSignal;
}
/** 공급사가 보고한 토큰 수. 입력/출력 매핑이 확인되지 않았으면 null이며 0으로 채우지 않는다. */
export interface ModelUsage { inputTokens: number; outputTokens: number }
export interface ModelResponse {
  value: unknown;
  /** 요청한 공급사·모델 설정의 표식. 공급사 내부 실제 모델을 검증했다는 뜻이 아니다. */
  modelVersion: string;
  usage: ModelUsage | null;
  /** 응답 본문이 모델 정보를 담은 경우의 보고값. 검증된 실제 모델 식별로 취급하지 않는다. */
  reportedModel?: string;
}
export interface ModelPort { generate(request: ModelRequest): Promise<ModelResponse>; }
