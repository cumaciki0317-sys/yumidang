import type { AuthorAgeFilter, PostRegion } from "./search.ts";
/** 서버 내부 계약. HTTP 인증·DB·제공사 스키마와는 별도로 연결한다. */
export type DateSelection = { kind: "this_week" | "this_weekend" | "today" | "tomorrow" } | { kind: "dates"; startsOn: string; endsOn: string };
/** 관심사·대화 방식 요청 값 하나. exclude는 "시끄러운 대화는 싫어요" 같은 부정 표현이다. */
export interface PreferenceValue { text: string; polarity: "include" | "exclude"; }
/**
 * 관심사·대화 방식 조건(C 방식: 등록값과의 의미 유사 판단). combine은 include 값끼리의 결합이며
 * exclude 값은 항상 모두 적용한다. include 값이 2개 이상이면 combine이 필수다(모호하면 모델이 clarify).
 */
export interface PreferenceCondition { values: PreferenceValue[]; combine?: "any" | "all"; }
export interface AiFilters {
  target: "posts" | "events";
  query?: string;
  category?: string;
  region?: PostRegion;
  cost?: "all" | "free" | "paid";
  availability?: "all" | "recruiting";
  date?: DateSelection;
  mbti?: string;
  ongoingOnly?: boolean;
  includeOngoing?: boolean;
  performanceGenre?: "concert" | "musical" | "play";
  newThisWeek?: boolean;
  /** 공고만. 생략은 등록일 최신순(created_desc). 의미 유사도로 재정렬하지 않는다. */
  sort?: "created_desc" | "starts_asc";
  /** 공고만. 로그인 회원 전용 검색 v2 조건. */
  authorAge?: AuthorAgeFilter;
  /** 공고만. 작성자가 등록한 관심사와의 의미 비교. */
  interests?: PreferenceCondition;
  /** 공고만. 작성자가 등록한 대화 방식과의 의미 비교. */
  conversationStyles?: PreferenceCondition;
}
export interface ChatMessage { role: "user" | "assistant"; content: string; }
export interface ChatInput { outputRetryOf?: string; clientRequestId: string; messages: ChatMessage[]; currentFilters: AiFilters; }
export interface ChatLimits { maxMessages: number; maxMessageChars: number; maxTotalChars: number; maxOutputTokens: number; }
/** 서버가 인증 주체의 본인 성향 RPC로 읽은 값만 넣는다. 요청 본문에서 받지 않는다. */
export interface TrustedChatContext { userId: string; preferences?: { interests?: string[]; conversationStyles?: string[]; mbti?: string }; }
/** 요청한 조건의 카드별 상태. 불일치는 결과에서 제외하므로 상태로 반환하지 않는다. */
export type ConditionState = "match" | "needs_check";
export interface CardConditionStatus { mbti?: ConditionState; interests?: ConditionState; conversationStyles?: ConditionState; }
export interface AiCard {
  kind: "post" | "event";
  id: string;
  title: string;
  locationLabel: string;
  startsAtOrDate: string;
  endsAtOrDate: string;
  costLabel: string;
  state: string;
  /**
   * 행사 공식 출처 링크. 모델이 만들지 않고 검색 저장소에서만 제공한다.
   * 2026-09-30 사용자 결정(Q4-A): 공식 링크 규칙이 없는 제공처(KOPIS)는 null이며 링크 없이 출처 이름만 표시한다.
   */
  sourceUrl?: string | null;
  /** 행사 제공처 표시 이름(예: KOPIS). 행사 카드에서 필수, 공고 카드에는 없다. */
  sourceName?: string;
  canApply: boolean;
  /**
   * 사용자가 요청한 성향 조건별 상태(match / needs_check=미입력 확인 필요)만 포함한다.
   * 유사도 점수·원본 성향 목록·모델 판단 근거는 반환하지 않는다.
   */
  conditionStatus?: CardConditionStatus;
}
export interface AiChatResult {
  recovery?: { reason: "input_privacy" | "output_privacy" | "daily_limit" | "concurrent" | "consent" | "temporary"; retryAllowed: boolean };
  requestId: string;
  status: "needs_clarification" | "results" | "no_results" | "unavailable";
  interpretedFilters: AiFilters;
  cards: AiCard[];
  explanations: { id: string; kind: AiCard["kind"]; text: string }[];
  clarificationQuestion?: string;
  notice?: string;
  /**
   * 2026-09-30 사용자 결정(Q1-A): 실행 한도·예산으로 후보를 끝까지 확인하지 못했지만 찾은 카드가 있으면
   * status "results" + partial:true + ‘일부만 확인’ 안내로 보여준다. 찾은 카드가 없으면 기존대로 unavailable이다.
   */
  partial?: true;
}
export class AiInputError extends Error { constructor(code: string) { super(code); this.name = "AiInputError"; } }

/** AI 문제 접수는 사용자가 확인한 답변 일부 또는 캡처 하나만 받는다. 전체 대화는 없다. */
export type AiFeedbackAttachment = { kind: "answer"; text: string } | { kind: "capture"; assetId: string };
export type AiFeedbackInput =
  | { clientRequestId: string; requestId: string; action: "helpful" }
  | { clientRequestId: string; requestId: string; action: "report"; confirmed: true; attachment: AiFeedbackAttachment };
export type AiFeedbackResult =
  | { status: "accepted"; feedbackId: string; hideAnswer: boolean }
  | { status: "not_enabled"; reason: "AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED" | "AI_FEEDBACK_STORAGE_NOT_CONNECTED" };
