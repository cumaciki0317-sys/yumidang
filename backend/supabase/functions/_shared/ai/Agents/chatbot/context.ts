import { AiInputError } from "../../../contracts/ai.ts";
import type { ChatInput, ChatLimits, TrustedChatContext } from "../../../contracts/ai.ts";
import { validateFilters } from "./intent.ts";

export function assertLimits(limits: ChatLimits): void {
  if (!limits || [limits.maxMessages, limits.maxMessageChars, limits.maxTotalChars, limits.maxOutputTokens].some(v => !Number.isSafeInteger(v) || v < 1)) throw new AiInputError("LIMITS_NOT_CONFIGURED");
}
export function buildContext(raw: ChatInput, principal: TrustedChatContext, limits: ChatLimits) {
  if (!principal || typeof principal.userId !== "string" || !principal.userId.trim()) throw new AiInputError("UNAUTHENTICATED");
  assertLimits(limits);
  if (!raw || typeof raw.clientRequestId !== "string" || !raw.clientRequestId.trim() || !Array.isArray(raw.messages) || !raw.messages.length) throw new AiInputError("INVALID_INPUT");
  const currentFilters = validateFilters(raw.currentFilters);
  if (raw.messages.some(m => !m || !["user", "assistant"].includes(m.role) || typeof m.content !== "string" || !m.content.trim())) throw new AiInputError("INVALID_MESSAGE");
  if (raw.messages.length > limits.maxMessages || raw.messages.some(m => m.content.length > limits.maxMessageChars) || raw.messages.reduce((n,m) => n + m.content.length, 0) > limits.maxTotalChars) throw new AiInputError("NEW_EXPLORATION_REQUIRED");
  const preferences = principal.preferences ?? {};
  return {
    messages: raw.messages.map(m => ({ role: m.role, content: m.content })), currentFilters,
    preferences: {
      ...(Array.isArray(preferences.interests) && preferences.interests.every(v => typeof v === "string") ? { interests: [...preferences.interests] } : {}),
      ...(typeof preferences.conversationStyle === "string" ? { conversationStyle: preferences.conversationStyle } : {}),
      ...(typeof preferences.mbti === "string" ? { mbti: preferences.mbti } : {}),
    },
  };
}
