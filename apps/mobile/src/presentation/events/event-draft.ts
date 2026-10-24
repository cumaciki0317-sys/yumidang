import type { Draft, EventItem, ManualEvent } from "../../types";
import { detectPersonalInfo } from "../../domain.ts";

/** Recheck stored/edited input too; restored draft JSON is not a public-data approval. */
export function manualEventError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "직접 입력한 행사 정보를 다시 확인해 주세요.";
  const input = value as Record<string, unknown>;
  if (!["title", "placeName", "publicAddress"].every((key) => typeof input[key] === "string") || typeof input.publicAddressConfirmed !== "boolean") return "직접 입력한 행사 정보를 다시 확인해 주세요.";
  if (Object.keys(input).some((key) => !["title", "placeName", "publicAddress", "publicAddressConfirmed"].includes(key))) return "직접 입력한 행사 정보를 다시 확인해 주세요.";
  const event = value as ManualEvent;
  if (!event.title.trim()) return "직접 입력할 행사명을 입력해 주세요.";
  if ([...event.title.trim()].length > 200 || [...event.placeName.trim()].length > 200 || [...event.publicAddress.trim()].length > 300) return "행사명·장소명은 200자, 공개 주소는 300자 이내로 입력해 주세요.";
  const text = [event.title, event.placeName, event.publicAddress].join("\n");
  if (/[<>\u0000-\u001f\u007f]/u.test([event.title, event.placeName, event.publicAddress].join("")) || detectPersonalInfo(text)) return "행사 정보의 연락처·계좌 등 개인정보를 지우고 다시 확인해 주세요.";
  if (event.publicAddress.trim() && !event.publicAddressConfirmed) return "행사 주소가 공개 행사장 주소인지 확인해 주세요.";
  return null;
}

export function eventDraftError(draft: Pick<Draft, "eventId" | "manualEvent">): string | null {
  if (draft.eventId && draft.manualEvent !== undefined) return "기존 행사와 직접 입력 행사 중 하나만 연결해 주세요.";
  return manualEventError(draft.manualEvent);
}

export function safeManualEvent(value: unknown): ManualEvent | null {
  return value !== undefined && !manualEventError(value) ? value as ManualEvent : null;
}

export function selectedEventPatch(eventId: string): Pick<Draft, "eventId" | "manualEvent"> {
  return { eventId, manualEvent: undefined };
}

export function manualEventPatch(event: ManualEvent): Pick<Draft, "eventId" | "manualEvent"> {
  return { eventId: undefined, manualEvent: { ...event, title: event.title.trim(), placeName: event.placeName.trim(), publicAddress: event.publicAddress.trim() } };
}

export function clearEventPatch(): Pick<Draft, "eventId" | "manualEvent"> {
  return { eventId: undefined, manualEvent: undefined };
}

/** Preview adapter only. Meeting dates never filter or require overlap with an event. */
export function previewEventError(draft: Pick<Draft, "eventId" | "manualEvent">, events: readonly EventItem[], now: number): string | null {
  const error = eventDraftError(draft);
  if (error) return error;
  if (!draft.eventId) return null;
  const event = events.find((item) => item.id === draft.eventId);
  if (!event) return "행사 정보를 확인하지 못했어요. 다시 선택하거나 연결을 삭제해 주세요.";
  return event.endsAt <= now ? "종료된 행사는 새 공고에 연결할 수 없어요. 변경하거나 삭제해 주세요." : null;
}
