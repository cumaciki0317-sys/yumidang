/** 제공사와 독립적인 구조화 생성 계약. 원문은 요청 메모리에서만 사용한다. */
export interface ModelRequest {
  task: "intent" | "explanation" | "review_chunk" | "review_merge";
  system: string;
  input: unknown;
  maxOutputTokens: number;
  signal?: AbortSignal;
}
export interface ModelResponse {
  value: unknown;
  modelVersion: string;
  usage: { inputTokens: number; outputTokens: number };
}
export interface ModelPort { generate(request: ModelRequest): Promise<ModelResponse>; }
