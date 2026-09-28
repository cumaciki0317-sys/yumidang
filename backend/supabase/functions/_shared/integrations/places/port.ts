/**
 * 공고 작성용 장소 입력 계약. 등록 공고의 검색 카드·공개 지역 계약과 별개다.
 * 인증된 공통 계층이 principal을 제공해야 하며 요청 본문으로 만들지 않는다.
 */
export interface PlaceLookupContext {
  principal: { kind: "member"; userId: string } | null;
  signal?: AbortSignal;
}

export interface PlaceLookupInput {
  query: string;
  page: number;
}

/** 주소는 작성자가 선택하는 입력 후보이며 등록 후 공개 범위를 뜻하지 않는다. */
export interface PlaceInputCandidate {
  source: "kakao";
  sourceId: string;
  placeName: string;
  address: string | null;
  roadAddress: string | null;
}

export interface PlaceLookupResult {
  status: "results" | "no_results";
  places: PlaceInputCandidate[];
  nextPage: number | null;
}

export interface PlaceLookupPort {
  lookup(input: PlaceLookupInput, context: PlaceLookupContext): Promise<PlaceLookupResult>;
}

/** 우편번호 제공사 선정 전에는 구체적인 공급사 응답·페이지 규격을 만들지 않는다. */
export interface PostalAddressLookupPort {
  readonly configured: false;
  lookup(input: { query: string }, context: PlaceLookupContext): Promise<{
    status: "unavailable";
    code: "POSTAL_PROVIDER_UNCONFIGURED";
  }>;
}

export type PlaceLookupErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_PLACE_INPUT"
  | "INVALID_PLACE_CONFIG"
  | "PLACE_PROVIDER_UNCONFIGURED"
  | "SOURCE_AUTH_REJECTED"
  | "SOURCE_RATE_LIMITED"
  | "SOURCE_REJECTED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_INVALID_RESPONSE"
  | "SOURCE_TIMEOUT"
  | "CANCELLED";

/** 공급사 본문·검색어·인증 헤더를 원인/메시지에 넣지 않는다. */
export class PlaceLookupError extends Error {
  readonly code: PlaceLookupErrorCode;
  readonly retryable: boolean;

  constructor(code: PlaceLookupErrorCode) {
    super(code);
    this.name = "PlaceLookupError";
    this.code = code;
    this.retryable = ["SOURCE_RATE_LIMITED", "SOURCE_UNAVAILABLE", "SOURCE_TIMEOUT"].includes(code);
  }
}
