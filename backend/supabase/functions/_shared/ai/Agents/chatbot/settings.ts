/**
 * AI 탐색 운영 한도의 명시 설정. 모든 값은 서버 환경에서 주입하며 기본값이 없다.
 * 하나라도 없거나 형식이 틀리면 SettingError → AI 탐색은 unavailable(추정값으로 실행하지 않음).
 */
import type { EnvReader } from "../../../config/env.ts";
import type { ChatLimits } from "../../../contracts/ai.ts";
import { requiredPositiveInt } from "../../../jobs/settings.ts";
import { AUTHOR_TRAITS_MAX_IDS } from "./traits.ts";
import type { DiscoveryLimits } from "./discovery.ts";

/** 설정 변수 이름과 용도. 값은 문서·로그·저장소에 기록하지 않는다. */
export const AI_CHAT_ENV = {
  maxMessages: "AI_CHAT_MAX_MESSAGES",
  maxMessageChars: "AI_CHAT_MAX_MESSAGE_CHARS",
  maxTotalChars: "AI_CHAT_MAX_TOTAL_CHARS",
  maxOutputTokens: "AI_CHAT_MAX_OUTPUT_TOKENS",
  pageSize: "AI_CHAT_SEARCH_PAGE_SIZE",
  maxSearchPages: "AI_CHAT_MAX_SEARCH_PAGES",
  recheckMaxPages: "AI_CHAT_RECHECK_MAX_PAGES",
  maxResultCards: "AI_CHAT_MAX_RESULT_CARDS",
  matchBatchSize: "AI_CHAT_MATCH_BATCH_SIZE",
  maxMatchCalls: "AI_CHAT_MAX_MATCH_CALLS",
  matchMaxOutputTokens: "AI_CHAT_MATCH_MAX_OUTPUT_TOKENS",
} as const;

export function loadAiChatSettings(read: EnvReader): { limits: ChatLimits; discovery: DiscoveryLimits } {
  const value = (key: string, maximum?: number) => requiredPositiveInt(read, key, maximum);
  return {
    limits: {
      maxMessages: value(AI_CHAT_ENV.maxMessages),
      maxMessageChars: value(AI_CHAT_ENV.maxMessageChars),
      maxTotalChars: value(AI_CHAT_ENV.maxTotalChars),
      maxOutputTokens: value(AI_CHAT_ENV.maxOutputTokens),
    },
    discovery: {
      // 검색 v2·성향 RPC의 기술 상한(50)을 넘을 수 없다.
      pageSize: value(AI_CHAT_ENV.pageSize, AUTHOR_TRAITS_MAX_IDS),
      maxSearchPages: value(AI_CHAT_ENV.maxSearchPages),
      recheckMaxPages: value(AI_CHAT_ENV.recheckMaxPages),
      maxResultCards: value(AI_CHAT_ENV.maxResultCards),
      matchBatchSize: value(AI_CHAT_ENV.matchBatchSize),
      maxMatchCalls: value(AI_CHAT_ENV.maxMatchCalls),
      matchMaxOutputTokens: value(AI_CHAT_ENV.matchMaxOutputTokens),
    },
  };
}
