/** 외부 API 형식과 무관한 행사 계약. 실제 제공처 연결은 검증 후 주입한다. */
export interface DateOnlyEvent {
  id: string;
  startsOn: string;
  /** 행사 마지막 날짜도 포함한다. */
  endsOn: string;
  /** 원천 상태를 갖고 온 후보는 기존 helper에서도 취소 상태를 보존한다. */
  sourceStatus?: EventSourceStatus;
}

export type EventTiming =
  | { precision: "date"; startsOn: string; endsOn: string }
  | { precision: "instant"; startsAt: string; endsAt: string };

/** unknown은 정상 상태로 추정하지 않는다. 정규화/조회 시 명시 오류로 처리한다. */
export type EventSourceStatus = "active" | "cancelled" | "unknown";
export type NormalizedEvent = EventTiming & { id: string; sourceStatus: EventSourceStatus };
export type EventState = "ongoing" | "upcoming" | "ended";
export interface EventPeriod { start: string; end: string }
export interface EventTimingQuery {
  /** 일반 목록은 overlapping. 기간이 없으면 과거/진행 중/예정을 모두 조회한다. */
  mode: "overlapping" | "new_this_week" | "post_selection";
  now: Date;
  /** 한국 달력 날짜, 양 끝 날짜 포함. 진행 중 필터와 교집합으로 적용한다. */
  period?: EventPeriod;
  ongoingOnly?: boolean;
}
export interface EventQuery extends EventTimingQuery {
  /** 행사명·장소명·공개 주소 중 한 필드에 부분 일치. 빈 검색어는 다른 필터만 적용한다. */
  query?: string;
  /** 제공처 어댑터가 정규화한 값과 정확히 일치. 지역/종류 매핑은 이 계층에서 만들지 않는다. */
  region?: string;
  category?: string;
}

/** 입장료이며 동행 비용과 섞지 않는다. 누락된 비용을 무료로 보지 않는다. */
export type EventAdmission =
  | { kind: "unknown" }
  | { kind: "free" }
  | { kind: "described"; text: string };

export type SourceEventRecord = EventTiming & {
  provider: string;
  sourceId: string;
  sourceStatus: EventSourceStatus;
  title: string;
  /** 제공처 정보에 없는 값은 null. 지역/종류/장소를 추정하지 않는다. */
  category: string | null;
  region: string | null;
  placeName: string | null;
  publicAddress: string | null;
  admission: EventAdmission;
  sourceUrl: string;
  collectedAt: string;
};
export type StoredEventRecord = SourceEventRecord & { id: string };

export interface EventFetchRequest {
  cursor?: string;
  period?: EventPeriod;
  signal?: AbortSignal;
}
export interface EventProviderPage {
  events: readonly SourceEventRecord[];
  nextCursor?: string;
}
export interface EventProviderPort {
  provider: string;
  fetchPage(request: EventFetchRequest): Promise<EventProviderPage>;
}
