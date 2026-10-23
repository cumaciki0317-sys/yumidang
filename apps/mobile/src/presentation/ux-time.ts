/** Display only: this clock never authorizes an action or changes server expiry. */
function instant(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()) ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : null;
}
export function formatKoreanDateTime(value: unknown): string {
  const parsed = instant(value);
  if (parsed === null) return "일시 확인 필요";
  const parts = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "numeric", hour12: true }).formatToParts(parsed);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? "";
  const minute = Number(part("minute"));
  return `${part("month")}월${part("day")}일 ${part("weekday")} ${part("dayPeriod")} ${part("hour")}시${minute ? ` ${minute}분` : ""}`;
}
export function formatDeadline(value: unknown, now = Date.now()): string {
  const parsed = instant(value);
  if (parsed === null) return "마감 일시 확인 필요";
  const absolute = `마감 ${formatKoreanDateTime(parsed)}`;
  if (!Number.isFinite(now)) return absolute;
  const remaining = parsed - now;
  if (remaining <= 0) return `${absolute} · 응답 가능 상태를 다시 확인해 주세요`;
  const minutes = Math.ceil(remaining / 60_000), days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60), mins = minutes % 60;
  return `${absolute} · 약 ${days ? `${days}일 ` : ""}${hours ? `${hours}시간 ` : ""}${mins || (!days && !hours) ? `${mins}분 ` : ""}남음`;
}
