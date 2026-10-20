/** Existing public DTO only; missing-status support needs a distinct server contract. */
export function canSelectEvent(event: { sourceStatus: string; state: string }): boolean {
  return event.sourceStatus === "active" &&
    (event.state === "upcoming" || event.state === "ongoing");
}

/** A drafting interval never silently narrows the event picker. */
export function eventSelectionQuery(keyword: string): {
  mode: "post_selection";
  query?: string;
} {
  const query = keyword.trim();
  return { mode: "post_selection", ...(query ? { query } : {}) };
}

export function eventSelectionUnavailableLabel(event: { sourceStatus: string; state: string }): string {
  if (event.sourceStatus === "cancelled") return "취소된 행사예요";
  if (event.state === "ended") return "종료된 행사예요";
  return "현재 연결할 수 없는 행사예요";
}

/** Fixed local destination; the identifier comes from the validated event DTO. */
export function eventCreateReturnPath(eventId: string): string {
  return `/create?id=${encodeURIComponent(`event:${eventId}`)}`;
}
