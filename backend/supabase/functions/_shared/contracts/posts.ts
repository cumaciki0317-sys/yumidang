/** 민규담당. 신규·수정 무료 공고. HTTP가 생략된 모집 마감을 startsAt으로 채운다. */
export interface FreePostInput {
  title: string; description: string; category: string;
  startsAt: string; endsAt: string; recruitmentEndsAt: string;
  publicArea: string; registeredPlaceName: string | null;
  registeredAddress: string; meetingDetail: string;
  preferenceNote: string | null; tags: string[];
  costType: "free"; amount: 0;
  /** 생략은 수정 시 기존 연결 보존, null은 해제, UUID는 명시적인 행사 선택이다. */
  eventId?: string | null;
  /** 공고 전용 입력. 생략은 보존, null은 해제한다. 공용 행사로 등록하지 않는다. */
  manualEvent?: { title: string; placeName: string; publicAddress: string; publicAddressConfirmed: boolean } | null;
  /** 확정 후 행사 변경 제안에만 사용한다. 실제 적용은 상대의 행사 전용 수락이 필요하다. */
  eventChangeId?: string;
}
/** 수정은 경로의 postId와 조회한 updatedAt으로 오래된 입력 덮어쓰기를 막는다. */
export interface PostUpdateInput { input: FreePostInput; expectedUpdatedAt: string }
