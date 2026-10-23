import React from "react";
import { View } from "react-native";
import { Body, Card, Title } from "../ui";
import { formatKoreanDateTime } from "./ux-time";

/** 상태를 표시할 뿐 전이를 만들지 않는다. 서버 모드는 검증 응답, 예시 모드는 명시된 예시 상태를 전달한다. */
export function CompanionStatusCard({ kind, deadline, proposerName }: { kind: "applied" | "response" | "waiting" | "confirmed"; deadline?: unknown; proposerName?: string }) {
  if (kind === "response" || kind === "waiting") return <Card><View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
    <Body style={{ flexShrink: 1 }}>{kind === "waiting" ? "상대 응답 대기" : "내가 응답할 차례"}</Body><View style={{ backgroundColor: "#B62440", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, flexShrink: 1, marginLeft: "auto" }}><Body small style={{ color: "#FFFFFF" }}>마감 {formatKoreanDateTime(deadline)}</Body></View>
    </View><Title>{kind === "waiting" ? "동행 확정 요청" : "조건을 확인해 주세요."}</Title><Body>{kind === "waiting" ? "상대의 최종 동의를 기다리고 있어요." : `${proposerName ? `${proposerName}님이` : "상대가"} 만남 조건을 제안했어요.\n마감 전에 조건을 확인하고 응답해 주세요.`}</Body></Card>;
  return <Card><Body small>{kind === "confirmed" ? "확정" : "신청됨"}</Body><Title>{kind === "confirmed" ? "약속이 확정됐어요" : "답변을 기다리고 있어요"}</Title><Body>{kind === "confirmed" ? "이제 약속을 확인할 수 있어요." : "작성자의 답변을 기다려 주세요.\n아직 확정된 약속은 없어요."}</Body></Card>;
}

/** 현재 약속 상태만 받는다. 신청의 matched 이력은 이 값으로 사용하지 않는다. */
export function AppointmentStatusCard({ status, busy = false, unavailable = false }: { status?: unknown; busy?: boolean; unavailable?: boolean }) {
  if (!busy && !unavailable && status === "confirmed") return <CompanionStatusCard kind="confirmed" />;
  const labels: Record<string, string> = { cancelled: "취소", completed: "완료", disputed: "분쟁 검토 중", no_show: "불발" };
  const label = !busy && !unavailable && typeof status === "string" ? labels[status] : undefined;
  return <Card><Body small>현재 약속 상태</Body><Title>{busy ? "현재 상태를 확인하고 있어요…" : label || "현재 상태 확인 필요"}</Title>{!label && !busy && <Body>현재 약속 상태를 확인하지 못했어요. 상태를 다시 확인해 주세요.</Body>}</Card>;
}
/** 변경 제안 중에도 기존 확정 약속은 유지되므로 신청 대기 문구를 재사용하지 않는다. */
export function ChangeProposalStatusCard({ requestedByMe, deadline, children }: { requestedByMe?: unknown; deadline?: unknown; children: React.ReactNode }) {
  return <Card><View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
    <Body style={{ flexShrink: 1 }}>{requestedByMe === false ? "내가 응답할 차례" : requestedByMe === true ? "상대 응답 대기" : "응답 주체 확인 필요"}</Body><View style={{ backgroundColor: "#B62440", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, flexShrink: 1, marginLeft: "auto" }}><Body small style={{ color: "#FFFFFF" }}>마감 {formatKoreanDateTime(deadline)}</Body></View>
    </View><Title>변경 제안</Title><Body>{requestedByMe === false ? "변경 조건을 확인하고 마감 전에 응답해 주세요." : requestedByMe === true ? "상대의 응답을 기다리고 있어요." : "최신 변경 제안 상태를 다시 확인해 주세요."}</Body>{children}</Card>;
}

/** 저장된 본인 후기의 계약 형태를 확인하며 원문을 화면에 추가 노출하지 않습니다. */
function hasSubmittedReview(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const review = value as Record<string, unknown>;
  if (typeof review.experience !== "string" || !["positive", "neutral", "negative"].includes(review.experience) || typeof review.rating !== "number" || !Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5 || !Array.isArray(review.praises) || review.praises.some(praise => typeof praise !== "string") || !(review.comment === null || typeof review.comment === "string")) return false;
  const submitted = review.submitted_at;
  if (typeof submitted !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(submitted) || !Number.isFinite(Date.parse(submitted))) return false;
  const [year, month, day] = submitted.slice(0, 10).split("-").map(Number);
  const calendar = new Date(0); calendar.setUTCFullYear(year, month - 1, day);
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}

export function reviewUnavailableReason(state: Record<string, unknown>): { title: string; description: string } {
  if (state.disputed === true) return { title: "분쟁 검토 중이에요", description: "검토 중에는 후기 작성과 새 공개가 보류돼요. 이미 공개된 후기의 숨김은 운영 결정에 따라 처리돼요." };
  if (state.can_write === false && hasSubmittedReview(state.own_review)) return { title: "이미 후기를 작성했어요", description: "제출한 후기는 수정하거나 다시 제출할 수 없어요. 약속 상태를 확인하거나 최신 상태를 다시 불러와 주세요." };
  if (state.released === true) return { title: "후기가 공개되었어요", description: "현재 공개된 후기를 확인할 수 있어요. 작성 가능 여부는 최신 상태를 다시 확인해 주세요." };
  return { title: "지금은 후기를 작성할 수 없어요", description: "작성 가능 상태를 확인해 주세요. 약속 상태를 확인하거나 다시 불러와 주세요." };
}
export function mergeNotificationPages<T extends Record<string, unknown>>(current: T[], incoming: T[]): T[] {
  const seen = new Set<string>();
  return [...current, ...incoming].filter(row => { const id = typeof row.notificationId === "string" ? row.notificationId : ""; if (!id || seen.has(id)) return false; seen.add(id); return true; });
}
/** Null means the server response cannot prove the relation; never label that as zero. */
export function requestsForPost<T extends Record<string, unknown>>(items: T[], postId: string): T[] | null {
  if (items.some(row => typeof row.post_id !== "string" || typeof row.id !== "string")) return null;
  return items.filter(row => row.post_id === postId);
}
