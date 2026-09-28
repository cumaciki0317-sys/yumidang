/** 서버 내부 계약. HTTP 인증·DB·제공사 스키마와는 별도로 연결한다. */
export type DateSelection = { kind: "this_week" | "this_weekend" | "today" | "tomorrow" } | { kind: "dates"; startsOn: string; endsOn: string };
export interface AiFilters {
  target: "posts" | "events";
  query?: string;
  category?: string;
  region?: string;
  cost?: "all" | "free" | "paid";
  availability?: "all" | "recruiting";
  date?: DateSelection;
  mbti?: string;
  ongoingOnly?: boolean;
  newThisWeek?: boolean;
}
export interface ChatMessage { role: "user" | "assistant"; content: string; }
export interface ChatInput { clientRequestId: string; messages: ChatMessage[]; currentFilters: AiFilters; }
export interface ChatLimits { maxMessages: number; maxMessageChars: number; maxTotalChars: number; maxOutputTokens: number; }
export interface TrustedChatContext { userId: string; preferences?: { interests?: string[]; conversationStyle?: string; mbti?: string }; }
export interface AiCard {
  kind: "post" | "event";
  id: string;
  title: string;
  locationLabel: string;
  startsAtOrDate: string;
  endsAtOrDate: string;
  costLabel: string;
  state: string;
  /** 행사 공식 출처. 모델이 만들지 않고 검색 저장소에서만 제공한다. */
  sourceUrl?: string;
  canApply: boolean;
  /** DB 저장소가 명시한 성향의 일치 여부만 반환한다. 미입력은 후보로 유지한다. */
  preferenceMatch?: "match" | "missing" | "mismatch";
}
export interface AiChatResult {
  requestId: string;
  status: "needs_clarification" | "results" | "no_results" | "unavailable";
  interpretedFilters: AiFilters;
  cards: AiCard[];
  explanations: { id: string; kind: AiCard["kind"]; text: string }[];
  clarificationQuestion?: string;
  notice?: string;
}
export class AiInputError extends Error { constructor(code: string) { super(code); this.name = "AiInputError"; } }
