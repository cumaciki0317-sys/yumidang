import type { FreePostInput } from "./posts.ts";
/** 민규담당. 작성자 제안과 신청자 수락을 구분하고 같은 조건 버전을 확인한다. */
/** 첫 채팅과 신청의 같은 전송 재시도에는 동일 messageId를 사용한다. */
export interface JoinRequestInput { messageId: string; message: string }
export interface MatchAcceptance { conditionVersion: string }
/** 최종 동의 철회·거절은 신청 자체의 철회·거절과 별개다. */
export interface MatchConsentEnd { conditionVersion: string }
export type MatchConsentStatus = "awaiting_consent" | "expired" | "withdrawn" | "declined" | "invalidated" | "accepted" | "renewal_required";
export interface ConversationMessage { messageId: string; content: string }
/** 확정 후 변경도 조회한 원본 시각과 별도 재시도 ID를 보존한다. */
export type AppointmentLocationInput = Pick<FreePostInput, "publicArea" | "registeredPlaceName" | "registeredAddress" | "meetingDetail">;
export interface AppointmentScheduleProposal { changeId: string; startsAt: string; endsAt: string; expectedUpdatedAt: string; location?: AppointmentLocationInput }
export interface AppointmentScheduleResponse { changeId: string; conditionVersion: string }
export interface AppointmentCancellation { cancellationId: string; reason: string }
