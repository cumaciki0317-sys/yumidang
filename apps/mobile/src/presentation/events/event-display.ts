/** Display-only helpers. Availability, privacy and linking remain server decisions. */
export type EventDisplayInput = {
  title: string;
  category: string | null;
  region: string | null;
  placeName: string | null;
  publicAddress: string | null;
  state: "ongoing" | "upcoming" | "ended";
  sourceStatus: "active" | "cancelled" | "unknown";
  admission: { kind: "free" } | { kind: "unknown" } | { kind: "described"; text: string };
  provider: string;
  collectedAt: string;
  posterUrl?: string | null;
  description?: string | null;
  operatingInfo?: string | null;
} & (
  | { precision: "date"; startsOn: string; endsOn: string }
  | { precision: "instant"; startsAt: string; endsAt: string }
);

function koreanDate(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function eventDateLabel(event: EventDisplayInput): string {
  const start = event.precision === "date" ? event.startsOn : koreanDate(event.startsAt);
  const end = event.precision === "date" ? event.endsOn : koreanDate(event.endsAt);
  if (!start || !end) return "기간 정보 없음";
  const from = start.replaceAll("-", ".");
  if (start === end) return from;
  return `${from} ~ ${(start.slice(0, 4) === end.slice(0, 4) ? end.slice(5) : end).replaceAll("-", ".")}`;
}

export function eventCategoryLabel(category: string | null): string {
  const text = category?.trim();
  if (!text || text === "행사/공연/축제") return "행사";
  return ({ "서양음악(클래식)": "클래식", "한국음악(국악)": "국악", "무용(서양/한국무용)": "무용" } as Record<string, string>)[text] ?? text;
}

export function eventStatusLabel(event: Pick<EventDisplayInput, "state" | "sourceStatus">): string {
  if (event.sourceStatus === "cancelled") return "행사 취소";
  if (event.sourceStatus === "unknown") return "행사 정보 확인 필요";
  return { ongoing: "진행 중", upcoming: "예정", ended: "종료" }[event.state];
}

export function eventAdmissionLabel(admission: EventDisplayInput["admission"]): string {
  if (admission.kind === "free") return "무료";
  if (admission.kind === "unknown" || !admission.text.trim()) return "요금 정보 없음";
  // Only an explicitly single amount is shortened. Never infer the minimum from prose.
  const text = admission.text.trim();
  if (text === "무료") return "무료";
  return /^(?:\d+|\d{1,3}(?:,\d{3})+)\s*원$/.test(text) ? `입장료 ${text}` : "요금 상세 확인";
}

export function eventLocationLabel(event: Pick<EventDisplayInput, "region" | "placeName">): string {
  const region = event.region?.trim();
  const place = event.placeName?.trim();
  if (region && place) return region === place ? region : `${region} · ${place}`;
  if (region) return `${region} · 행사장 정보 없음`;
  return place || "장소 정보 확인 필요";
}

export function eventProviderLabel(provider: string): string {
  return ({ kopis: "KOPIS", "tour-api": "한국관광공사 TourAPI", "seoul-open-data": "서울 열린데이터" } as Record<string, string>)[provider] ?? provider;
}
