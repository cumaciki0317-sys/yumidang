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
}
/** 수정은 경로의 postId와 조회한 updatedAt으로 오래된 입력 덮어쓰기를 막는다. */
export interface PostUpdateInput { input: FreePostInput; expectedUpdatedAt: string }
