/** 제공사와 독립적인 구조화 생성 계약. 원문은 요청 메모리에서만 사용한다. */
export type ModelTask = "intent" | "preference_match" | "explanation" | "review_chunk" | "review_merge";
export interface ModelRequest {
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
