import { ApiError, ServiceApiClient } from "./api.ts";
import type { FreePostInput } from "../../../backend/supabase/functions/_shared/contracts/posts";
import type { ProfilePreferences, ProfileTraits } from "../../../backend/supabase/functions/_shared/contracts/signup";
import type { MemberDecisionNotice, MemberCancellationNotice, MemberReportInput } from "../../../backend/supabase/functions/_shared/contracts/reports";
import type { AppointmentScheduleProposal } from "../../../backend/supabase/functions/_shared/contracts/matching";
import type { ReviewSubmission } from "../../../backend/supabase/functions/_shared/contracts/reviews";

export type Wire = Record<string, unknown>;
const fail = (): never => { throw new ApiError(502, "INVALID_SERVICE_RESPONSE"); };
export function wire(value: unknown): Wire {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Wire;
}
export function string(value: unknown): string { if (typeof value !== "string") return fail(); return value; }
export function uuid(value: unknown): string {
  const s = string(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) return fail();
  return s;
}
export function nullableString(value: unknown): string | null { return value === null ? null : string(value); }
export function timestamp(value: unknown): string {
  const s = string(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(Date.parse(s))) return fail();
  const [year, month, day] = s.slice(0, 10).split("-").map(Number);
  const test = new Date(0); test.setUTCFullYear(year, month - 1, day);
  if (test.getUTCFullYear() !== year || test.getUTCMonth() !== month - 1 || test.getUTCDate() !== day) return fail();
  return s;
}
export function bool(value: unknown): boolean { if (typeof value !== "boolean") return fail(); return value; }
export function rows(value: unknown): Wire[] { if (!Array.isArray(value)) return fail(); return value.map(wire); }
export function one(value: unknown): Wire { const r = rows(value); if (r.length !== 1) return fail(); return r[0]; }
export function fields(value: unknown, keys: string[]): Wire {
  const r = wire(value);
  if (Object.keys(r).length !== keys.length || keys.some(k => !Object.hasOwn(r, k))) return fail();
  return r;
}
export function traits(value: unknown): ProfileTraits {
  const r = wire(value);
  const list = (v: unknown) => {
    if (!Array.isArray(v) || v.length > 20 || v.some(x => typeof x !== "string" || [...x].length < 1 || [...x].length > 40 || x.trim() !== x || /[\u0000-\u001f\u007f]|\s\s/u.test(x)) || new Set(v.map(x => x.toLowerCase())).size !== v.length) return fail();
    return v as string[];
  };
  const mbti = nullableString(r.mbti);
  if (mbti !== null && !/^[EI][NS][TF][JP]$/.test(mbti)) return fail();
  return { interests: list(r.interests), conversationStyles: list(r.conversationStyles), mbti };
}
export interface OwnProfile { userId: string; realName: string; avatarUrl: string | null; bio: string | null; sweetness: number; }
export interface MemberPage { items: Wire[]; nextCursor: string | null; }
export interface ChangeState { appointmentId: string; status: string; startsAt: string | null; endsAt: string | null; updatedAt: string | null; change: Wire | null; cancellation: Wire | null; scheduleProvenance?: string; }
export function change(value: unknown): Wire {
  const r = wire(value);
  uuid(r.appointmentId); uuid(r.changeId); string(r.conditionVersion);
  if (!["awaiting_response", "accepted", "declined", "withdrawn", "expired", "cancelled"].includes(string(r.status))) return fail();
  for (const key of ["oldSchedule", "newSchedule"]) { const s = fields(r[key], ["startsAt", "endsAt"]); timestamp(s.startsAt); timestamp(s.endsAt); }
  bool(r.requestedByMe); timestamp(r.requestedAt); timestamp(r.expiresAt);
  if (r.resolvedAt !== null) timestamp(r.resolvedAt);
  if (Object.hasOwn(r, "locationChanged")) {
    if (r.locationChanged !== true || !Object.hasOwn(r, "newLocation")) return fail();
    if (r.newLocation !== null) {
      const l = fields(r.newLocation, ["publicArea", "registeredPlaceName", "registeredAddress", "meetingDetail"]);
      string(l.publicArea); nullableString(l.registeredPlaceName); string(l.registeredAddress); string(l.meetingDetail);
    }
    if (r.status !== "awaiting_response" && r.newLocation !== null) return fail();
  } else if (Object.hasOwn(r, "newLocation")) return fail();
  return r;
}
export type HiddenTargetType = MemberReportInput["targetType"];
const hiddenTargetTypes = ["post", "chat", "appointment", "member", "event"] as const;
export interface HiddenTarget { targetType: HiddenTargetType; targetId: string; }
export interface NoticeDelivery { deliveryId: string; notice: MemberDecisionNotice; providedAt: string | null; deadlineAt: string | null; appealPolicy: "general_7d"; }
function hiddenTarget(value: unknown): HiddenTarget {
  const r = fields(value, ["targetType", "targetId"]);
  if (!(hiddenTargetTypes as readonly unknown[]).includes(r.targetType)) return fail();
  return { targetType: r.targetType as HiddenTargetType, targetId: uuid(r.targetId) };
}
function decisionNotice(value: unknown): MemberDecisionNotice {
  const r = fields(value, ["noticeId", "appointmentId", "appointmentOutcome", "violationOutcome", "reasonCode", "violationClass", "violationType", "availableAt", "firstReadAt"]);
  uuid(r.noticeId); if (r.appointmentId !== null) uuid(r.appointmentId);
  timestamp(r.availableAt); if (r.firstReadAt !== null && Date.parse(timestamp(r.firstReadAt)) < Date.parse(string(r.availableAt))) return fail();
  if (![null, "normal", "no_show"].includes(r.appointmentOutcome as string | null) || ![null, "confirmed", "invalidated"].includes(r.violationOutcome as string | null)) return fail();
  if (r.appointmentOutcome !== null && r.appointmentId === null) return fail();
  if (r.violationOutcome === null) {
    if (r.appointmentOutcome === null || r.reasonCode !== r.appointmentOutcome || r.violationClass !== null || r.violationType !== null) return fail();
  } else if (r.violationOutcome === "invalidated") {
    if (r.reasonCode !== "decision_corrected" || r.violationClass !== null || r.violationType !== null) return fail();
  } else if (r.violationClass === "none") {
    if (r.reasonCode !== "no_show" || r.appointmentOutcome !== "no_show" || r.violationType !== null) return fail();
  } else {
    const types = r.violationClass === "minor" ? ["spam", "rule_violation"] : r.violationClass === "major" ? ["sexual_harassment", "threat", "violence", "stalking", "privacy_exposure", "sexual_exploitation"] : [];
    if (!types.includes(string(r.violationType)) || r.reasonCode !== r.violationType) return fail();
  }
  return r as unknown as MemberDecisionNotice;
}
function cancellationNotice(value: unknown): MemberCancellationNotice {
  const r = fields(value, ["noticeId", "appointmentId", "appealState", "planState", "eligibleCount", "provisionalCount", "hasCancellationWarning", "restrictedUntil", "availableAt", "firstReadAt"]);
  uuid(r.noticeId); uuid(r.appointmentId); bool(r.hasCancellationWarning);
  timestamp(r.availableAt); if (r.restrictedUntil !== null) timestamp(r.restrictedUntil);
  if (r.firstReadAt !== null && Date.parse(timestamp(r.firstReadAt)) < Date.parse(string(r.availableAt))) return fail();
  if (![null, "reviewing", "accepted", "rejected"].includes(r.appealState as string | null) || !["held", "applied", "corrected", "policy_pending"].includes(string(r.planState))) return fail();
  if (r.eligibleCount === null || r.provisionalCount === null) {
    if (r.eligibleCount !== null || r.provisionalCount !== null || r.planState !== "policy_pending") return fail();
  } else if (![r.eligibleCount, r.provisionalCount].every(n => Number.isSafeInteger(n) && (n as number) >= 0)) return fail();
  return r as unknown as MemberCancellationNotice;
}
function noticeDelivery(value: unknown, noticeId: string, deliveryId?: string): NoticeDelivery {
  const r = fields(value, ["deliveryId", "notice", "providedAt", "deadlineAt", "appealPolicy"]), notice = decisionNotice(r.notice);
  uuid(r.deliveryId);
  if (notice.noticeId !== noticeId || notice.violationOutcome !== "confirmed" || r.appealPolicy !== "general_7d" || (deliveryId !== undefined && r.deliveryId !== deliveryId)) return fail();
  if (r.providedAt === null && r.deadlineAt === null) { if (deliveryId !== undefined) return fail(); }
  else if (Date.parse(timestamp(r.deadlineAt)) - Date.parse(timestamp(r.providedAt)) !== 168 * 3600000) return fail();
  return { deliveryId: string(r.deliveryId), notice, providedAt: r.providedAt as string | null, deadlineAt: r.deadlineAt as string | null, appealPolicy: "general_7d" };
}
export interface GeneralAppeal { appealId: string; noticeId: string; state: "reviewing" | "accepted" | "rejected"; receivedAt: string; deadlineAt: string; alreadyApplied: boolean; }
function generalAppeal(value: unknown, expected: string, byNotice: boolean): GeneralAppeal {
  const r = fields(value, ["appealId", "noticeId", "state", "receivedAt", "deadlineAt", "alreadyApplied"]);
  uuid(r.appealId); uuid(r.noticeId); bool(r.alreadyApplied);
  if (r[byNotice ? "noticeId" : "appealId"] !== expected || !["reviewing", "accepted", "rejected"].includes(string(r.state)) || Date.parse(timestamp(r.receivedAt)) >= Date.parse(timestamp(r.deadlineAt))) return fail();
  return r as unknown as GeneralAppeal;
}
export interface CancellationAppeal { appealId: string | null; appointmentId: string; resultRevision: number; state: "reviewing" | "accepted" | "rejected" | null; cancelledAt: string; deadlineAt: string; receivedAt: string | null; resolvedAt: string | null; alreadyApplied?: boolean; reportId?: string; }
export interface CancellationAppealInput { clientRequestId: string; expectedResultRevision: number; reasonCodes: string[]; description: string; assetIds: string[]; hideTarget: boolean; }
function timestampMicros(value: unknown): bigint {
  const v = timestamp(value), fraction = /\.(\d{1,6})(?:Z|[+-])/.exec(v)?.[1] ?? "";
  return BigInt(Date.parse(v.replace(/\.\d{1,6}(?=Z|[+-])/, ""))) * 1000n + BigInt(fraction.padEnd(6, "0"));
}
function cancellationAppeal(value: unknown, appointmentId: string, revision?: number): CancellationAppeal {
  const submit = revision !== undefined;
  const r = fields(value, ["appealId", "appointmentId", "resultRevision", "state", "cancelledAt", "deadlineAt", "receivedAt", "resolvedAt", ...(submit ? ["alreadyApplied", "reportId"] : [])]);
  if (r.appointmentId !== appointmentId || !Number.isSafeInteger(r.resultRevision) || (r.resultRevision as number) < 1) return fail();
  const cancelled = timestampMicros(r.cancelledAt), deadline = timestampMicros(r.deadlineAt);
  if (deadline - cancelled !== 86_400_000_000n) return fail();
  if (!submit && r.appealId === null) {
    if (r.state !== null || r.receivedAt !== null || r.resolvedAt !== null) return fail();
  } else {
    uuid(r.appealId);
    if (!["reviewing", "accepted", "rejected"].includes(string(r.state))) return fail();
    const received = timestampMicros(r.receivedAt);
    if (received < cancelled || received >= deadline) return fail();
    if (r.state === "reviewing" ? r.resolvedAt !== null : timestampMicros(r.resolvedAt) < received) return fail();
  }
  if (submit) { bool(r.alreadyApplied); uuid(r.reportId); if (r.resultRevision !== revision! + 1 || r.state !== "reviewing") return fail(); }
  return r as unknown as CancellationAppeal;
}
/** Server time plus elapsed time since the response arrived; missing server time stays unknown. */
export function observedServerTime(row: Wire | null, observedAt: number | undefined, now: number): number | null {
  if (!row || !Number.isFinite(observedAt) || !Number.isFinite(now)) return null;
  try { return Date.parse(timestamp(row.server_now)) + Math.max(0, now - observedAt!); } catch { return null; }
}
export function appointmentCancellationGate(row: Wire | null, observedAt: number | undefined, now: number): "before_start" | "started" | "unavailable" {
  if (!row || row.status !== "confirmed") return "unavailable";
  const serverTime = observedServerTime(row, observedAt, now);
  try { return serverTime === null ? "unavailable" : serverTime < Date.parse(timestamp(row.post_starts_at)) ? "before_start" : "started"; } catch { return "unavailable"; }
}
function readState(r: Wire): Wire {
  if (r.last_read_message_id !== null) uuid(r.last_read_message_id);
  if (r.read_at !== null) timestamp(r.read_at);
  if (!Number.isSafeInteger(r.unread_count) || (r.unread_count as number) < 0) return fail();
  return r;
}
export class MemberService {
  private readonly client: ServiceApiClient;
  constructor(client: ServiceApiClient) { this.client = client; }
  private read(path: string, signal?: AbortSignal) { return this.client.request<unknown>(path, { signal }); }
  private send(path: string, body: unknown, signal?: AbortSignal) { return this.client.request<unknown>(path, { method: "POST", body, signal }); }
  async profile(signal?: AbortSignal): Promise<OwnProfile> {
    const r = fields(await this.read("/me", signal), ["userId", "realName", "avatarUrl", "bio", "sweetness"]);
    if (!Number.isInteger(r.sweetness) || (r.sweetness as number) < 0 || (r.sweetness as number) > 100) return fail();
    return { userId: uuid(r.userId), realName: string(r.realName), avatarUrl: nullableString(r.avatarUrl), bio: nullableString(r.bio), sweetness: r.sweetness as number };
  }
  async getTraits(signal?: AbortSignal) { return traits(fields(await this.read("/me/traits", signal), ["interests", "conversationStyles", "mbti"])); }
  async preferences(input: ProfilePreferences, signal?: AbortSignal): Promise<ProfilePreferences> {
    traits(input); if (input.bio !== null && (typeof input.bio !== "string" || [...input.bio].length > 300)) throw new ApiError(400, "INVALID_REQUEST");
    const r = fields(await this.send("/me/preferences", input, signal), ["interests", "conversationStyles", "mbti", "bio"]);
    const bio = nullableString(r.bio); if (bio !== null && [...bio].length > 300) return fail();
    return { ...traits(r), bio };
  }
  async avatar(path: string, signal?: AbortSignal) {
    const r = fields(one(await this.send("/me/avatar", { avatarPath: path }, signal)), ["avatar_url", "previous_avatar_path"]);
    if (r.avatar_url !== path) return fail();
    return { avatarPath: string(r.avatar_url), previousPath: nullableString(r.previous_avatar_path) };
  }
  async conversations(signal?: AbortSignal) { return rows(await this.read("/conversations", signal)).map(r => { uuid(r.request_id); string(r.post_title); string(r.counterpart_masked_name); nullableString(r.last_message); return readState(r); }); }
  async conversation(id: string, signal?: AbortSignal) { const r = one(await this.read(`/conversations/${uuid(id)}`, signal)); if (r.request_id !== id) return fail(); bool(r.can_send); string(r.my_role); string(r.post_title); return readState(r); }
  async markRead(id: string, messageId: string, signal?: AbortSignal) {
    const r = fields(await this.send(`/conversations/${uuid(id)}/read`, { lastReadMessageId: uuid(messageId) }, signal), ["request_id", "last_read_message_id", "read_at", "unread_count"]);
    if (r.request_id !== id) return fail();
    return readState(r);
  }
  async ownPosts(before?: string, signal?: AbortSignal): Promise<MemberPage> {
    const page = await this.page(`/me/posts?limit=20${before ? `&before=${uuid(before)}` : ""}`, signal);
    for (const row of page.items) { uuid(row.postId); string(row.title); timestamp(row.createdAt); if (row.isOwner !== true) return fail(); }
    return page;
  }
  async ownsPost(id: string, signal?: AbortSignal): Promise<boolean> {
    uuid(id); let before: string | undefined; const seen = new Set<string>();
    do {
      const page = await this.ownPosts(before, signal);
      if (page.items.some(row => row.postId === id)) return true;
      if (!page.nextCursor) return false;
      if (seen.has(page.nextCursor)) return fail();
      seen.add(page.nextCursor); before = page.nextCursor;
    } while (true);
  }
  async messages(id: string, before?: string, signal?: AbortSignal): Promise<MemberPage> {
    const r = fields(await this.read(`/conversations/${uuid(id)}/messages?limit=20${before ? `&before=${uuid(before)}` : ""}`, signal), ["items", "nextCursor"]);
    const items = rows(r.items).map(m => { uuid(m.messageId); uuid(m.senderId); string(m.content); timestamp(m.createdAt); return m; });
    return { items, nextCursor: r.nextCursor === null ? null : uuid(r.nextCursor) };
  }
  async sendMessage(id: string, messageId: string, content: string, signal?: AbortSignal) { const r = fields(await this.send(`/conversations/${uuid(id)}/messages`, { messageId: uuid(messageId), content }, signal), ["messageId", "createdAt", "alreadySent"]); if (r.messageId !== messageId) return fail(); timestamp(r.createdAt); bool(r.alreadySent); return r; }
  async leave(id: string, signal?: AbortSignal) { const r = fields(await this.send(`/conversations/${uuid(id)}/leave`, {}, signal), ["requestId", "hidden"]); if (r.requestId !== id || r.hidden !== true) return fail(); return r; }
  async firstMessage(postId: string, messageId: string, message: string, signal?: AbortSignal) { const r = fields(await this.send(`/posts/${uuid(postId)}/requests`, { messageId: uuid(messageId), message }, signal), ["id", "post_id", "status", "created_at", "already_existed", "messageId", "messageCreatedAt", "alreadySent"]); uuid(r.id); if (r.post_id !== postId || r.messageId !== messageId || r.status !== "pending") return fail(); timestamp(r.created_at); timestamp(r.messageCreatedAt); bool(r.already_existed); bool(r.alreadySent); return r; }
  async requests(direction: "sent" | "received", signal?: AbortSignal) { return rows(await this.read(`/requests/${direction}`, signal)); }
  async consent(id: string, signal?: AbortSignal): Promise<Wire | null> {
    const r = wire(await this.read(`/requests/${uuid(id)}/consent`, signal));
    if (r.consent === null && Object.keys(r).length === 1) return null;
    if (r.requestId !== id) return fail(); string(r.conditionVersion);
    if (!["awaiting_consent", "expired", "withdrawn", "declined", "invalidated", "accepted", "renewal_required"].includes(string(r.status))) return fail();
    const conditions = fields(r.conditions, ["postId", "title", "description", "category", "startsAt", "endsAt", "publicArea", "preferenceNote", "tags", "costType", "amount", "paymentDirection"]);
    uuid(conditions.postId); string(conditions.title); string(conditions.description); string(conditions.category); string(conditions.publicArea); nullableString(conditions.preferenceNote);
    if (Date.parse(timestamp(conditions.startsAt)) >= Date.parse(timestamp(conditions.endsAt)) || conditions.costType !== "free" || conditions.amount !== 0 || conditions.paymentDirection !== "none" || !Array.isArray(conditions.tags) || conditions.tags.some(t => typeof t !== "string")) return fail();
    if (r.expiresAt !== null) timestamp(r.expiresAt); return r;
  }
  async requestAction(id: string, action: "propose" | "withdraw" | "decline" | "accept" | "consent/withdraw" | "consent/decline", version?: string, signal?: AbortSignal) {
    if (["accept", "consent/withdraw", "consent/decline"].includes(action) && !version) throw new ApiError(400, "INVALID_REQUEST");
    const result = await this.send(`/requests/${uuid(id)}/${action}`, version ? { conditionVersion: version } : {}, signal);
    const r = action === "withdraw" || action === "decline" ? one(result) : wire(result);
    if ((r.requestId ?? r.id) !== id) return fail(); string(r.status);
    return r;
  }
  async appointments(signal?: AbortSignal) { return rows(await this.read("/appointments", signal)).map(r => { uuid(r.appointment_id); string(r.post_title); string(r.status); return r; }); }
  async appointment(id: string, signal?: AbortSignal) { const r = one(await this.read(`/appointments/${uuid(id)}`, signal)); if (r.appointment_id !== id) return fail(); bool(r.can_confirm_completion); string(r.status); return r; }
  async changeState(id: string, signal?: AbortSignal): Promise<ChangeState> {
    const r = wire(await this.read(`/appointments/${uuid(id)}/schedule-change`, signal)); if (r.appointmentId !== id) return fail();
    const time = (v: unknown) => v === null ? null : timestamp(v);
    return { appointmentId: id, status: string(r.status), startsAt: time(r.startsAt), endsAt: time(r.endsAt), updatedAt: time(r.updatedAt), change: r.change === null ? null : change(r.change), cancellation: r.cancellation === null ? null : wire(r.cancellation), ...(r.scheduleProvenance === undefined ? {} : { scheduleProvenance: string(r.scheduleProvenance) }) };
  }
  async proposeChange(id: string, input: AppointmentScheduleProposal, signal?: AbortSignal) { return change(await this.send(`/appointments/${uuid(id)}/schedule-change/propose`, input, signal)); }
  async changeAction(id: string, action: "accept" | "decline" | "withdraw", changeId: string, conditionVersion: string, signal?: AbortSignal) { return change(await this.send(`/appointments/${uuid(id)}/schedule-change/${action}`, { changeId: uuid(changeId), conditionVersion }, signal)); }
  async cancel(id: string, cancellationId: string, reason: string, signal?: AbortSignal) { const r = wire(await this.send(`/appointments/${uuid(id)}/cancel`, { cancellationId: uuid(cancellationId), reason }, signal)); if (r.appointmentId !== id || r.cancellationId !== cancellationId || r.status !== "cancelled") return fail(); return r; }
  async confirmCompletion(id: string, signal?: AbortSignal) { const r = one(await this.send(`/appointments/${uuid(id)}/confirm-completion`, {}, signal)); if (r.appointment_id !== id || !["confirmed", "completed"].includes(string(r.status))) return fail(); if (r.completed_at !== null) timestamp(r.completed_at); timestamp(r.my_confirmed_at); bool(r.completed_by_me); bool(r.can_dispute); return r; }
  async reviewState(id: string, signal?: AbortSignal) { const r = one(await this.read(`/appointments/${uuid(id)}/reviews`, signal)); if (r.appointment_id !== id) return fail(); for (const k of ["appointment_completed", "disputed", "can_write", "peer_submitted", "released"]) bool(r[k]); if (r.deadline_at !== null) timestamp(r.deadline_at); if (r.released === false && r.peer_review !== null) return fail(); return r; }
  async review(id: string, input: ReviewSubmission, signal?: AbortSignal) { const r = wire(await this.send(`/appointments/${uuid(id)}/reviews`, input, signal)); uuid(r.reviewId); timestamp(r.submittedAt); bool(r.deduplicated); return r; }
  async praises(signal?: AbortSignal) { const r = fields(await this.read("/reviews/praises", signal), ["items"]); return rows(r.items).map(i => { string(i.code); string(i.label); return i; }); }
  async create(postId: string, input: FreePostInput, signal?: AbortSignal) { const r = fields(await this.send("/posts", { postId: uuid(postId), ...input }, signal), ["postId", "alreadyCreated"]); if (r.postId !== postId) return fail(); bool(r.alreadyCreated); return r; }
  async update(postId: string, input: FreePostInput, expectedUpdatedAt: string, signal?: AbortSignal) { const r = wire(await this.send(`/posts/${uuid(postId)}/update`, { ...input, expectedUpdatedAt }, signal)); if (r.postId !== postId) return fail(); string(r.status); timestamp(r.updatedAt); return r; }
  async postAction(id: string, action: "close" | "delete" | "reopen", signal?: AbortSignal) { const r = wire(await this.send(`/posts/${uuid(id)}/${action}`, {}, signal)); if (r.postId !== id) return fail(); string(r.status); timestamp(r.updatedAt); return r; }
  async block(id: string, blocked: boolean, signal?: AbortSignal) { const r = fields(await this.send(`/profiles/${uuid(id)}/${blocked ? "block" : "unblock"}`, {}, signal), ["targetId", "blocked", "alreadyApplied"]); if (r.targetId !== id || r.blocked !== blocked) return fail(); bool(r.alreadyApplied); return r; }
  async blocks(before?: string, signal?: AbortSignal): Promise<MemberPage> { return this.page(`/me/blocks?limit=20${before ? `&before=${uuid(before)}` : ""}`, signal); }
  private async page(path: string, signal?: AbortSignal): Promise<MemberPage> { const r = fields(await this.read(path, signal), ["items", "nextCursor"]); return { items: rows(r.items), nextCursor: r.nextCursor === null ? null : uuid(r.nextCursor) }; }
  async notifications(before?: string, signal?: AbortSignal) { const result = await this.page(`/notifications?limit=20${before ? `&before=${uuid(before)}` : ""}`, signal); result.items.forEach(r => { uuid(r.notificationId); string(r.kind); if (r.requestId !== null) uuid(r.requestId); timestamp(r.createdAt); if (r.readAt !== null) timestamp(r.readAt); }); return result; }
  async readNotification(id: string | null, signal?: AbortSignal) { const r = await this.send(id ? `/notifications/${uuid(id)}/read` : "/notifications/read-all", {}, signal); if (r !== null) return fail(); }
  async safety(signal?: AbortSignal) { const r = fields(await this.read("/me/safety", signal), ["permanent", "restrictedUntil", "hasWarning", "sanctions"]); bool(r.permanent); bool(r.hasWarning); if (r.restrictedUntil !== null) timestamp(r.restrictedUntil); rows(r.sanctions); return r; }
  async hiddenTargets(before?: string, signal?: AbortSignal) {
    const result = await this.page(`/me/hidden-targets?limit=20${before ? `&before=${uuid(before)}` : ""}`, signal);
    const items = result.items.map(hiddenTarget);
    if (new Set(items.map(r => `${r.targetType}:${r.targetId.toLowerCase()}`)).size !== items.length) return fail();
    return { items, nextCursor: result.nextCursor };
  }
  async unhide(target: HiddenTarget, signal?: AbortSignal) {
    const input = hiddenTarget(target), r = fields(await this.send("/me/hidden-targets/unhide", input, signal), ["targetType", "targetId", "hidden"]);
    if (r.targetType !== input.targetType || r.targetId !== input.targetId.toLowerCase() || r.hidden !== false) return fail();
    return r;
  }
  async notices(kind: "decision" | "cancellation", before?: string, signal?: AbortSignal) {
    const result = await this.page(`/${kind}-notices?limit=20${before ? `&before=${uuid(before)}` : ""}`, signal);
    const items = result.items.map((r): MemberDecisionNotice | MemberCancellationNotice => kind === "decision" ? decisionNotice(r) : cancellationNotice(r));
    if (new Set(items.map(r => r.noticeId)).size !== items.length) return fail();
    return { items, nextCursor: result.nextCursor };
  }
  async readNotice(kind: "decision" | "cancellation", id: string, signal?: AbortSignal) {
    const result = await this.send(`/${kind}-notices/${uuid(id)}/read`, {}, signal);
    const notice = kind === "decision" ? decisionNotice(result) : cancellationNotice(result);
    if (notice.noticeId !== id || notice.firstReadAt === null) return fail();
    return notice;
  }
  async prepareNotice(id: string, signal?: AbortSignal) { return noticeDelivery(await this.send(`/decision-notices/${uuid(id)}/prepare-delivery`, {}, signal), id); }
  async acknowledgeNotice(id: string, deliveryId: string, signal?: AbortSignal) { return noticeDelivery(await this.send(`/decision-notices/${uuid(id)}/provided`, { deliveryId: uuid(deliveryId) }, signal), id, deliveryId); }
  async submitGeneralAppeal(noticeId: string, clientRequestId: string, reason: string, signal?: AbortSignal) {
    if (reason.trim() !== reason || [...reason].length < 1 || [...reason].length > 4000 || /[\x00-\x1f\x7f]/.test(reason)) throw new ApiError(400, "INVALID_REQUEST");
    return generalAppeal(await this.send("/me/general-sanction-appeals", { noticeId: uuid(noticeId), clientRequestId: uuid(clientRequestId), reason }, signal), noticeId, true);
  }
  async generalAppeal(id: string, signal?: AbortSignal) { return generalAppeal(await this.read(`/me/general-sanction-appeals/${uuid(id)}`, signal), id, false); }
  async cancellationAppeal(id: string, signal?: AbortSignal) { return cancellationAppeal(await this.read(`/appointments/${uuid(id)}/cancellation-appeals`, signal), id); }
  async submitCancellationAppeal(id: string, input: CancellationAppealInput, signal?: AbortSignal) {
    if (!Number.isSafeInteger(input.expectedResultRevision) || input.expectedResultRevision < 1 || input.expectedResultRevision >= Number.MAX_SAFE_INTEGER) throw new ApiError(400, "INVALID_REQUEST");
    uuid(input.clientRequestId);
    return cancellationAppeal(await this.send(`/appointments/${uuid(id)}/cancellation-appeals/submit`, input, signal), id, input.expectedResultRevision);
  }
  async withdrawAi(kind: "exploration" | "review_summary", signal?: AbortSignal) { const r = fields(await this.send("/me/ai-processing/withdraw", { kind }, signal), ["withdrawn"]); if (r.withdrawn !== true) return fail(); return r; }
  async report(input: MemberReportInput, signal?: AbortSignal) { const r = fields(await this.send("/reports", input, signal), ["reportId", "status", "alreadySubmitted", "hideTarget"]); uuid(r.reportId); string(r.status); bool(r.alreadySubmitted); bool(r.hideTarget); return r; }
  async reports(before?: string, signal?: AbortSignal) { return this.page(`/me/reports?limit=20${before ? `&before=${uuid(before)}` : ""}`, signal); }
  async getReport(id: string, signal?: AbortSignal) { const r = wire(await this.read(`/me/reports/${uuid(id)}`, signal)); if (r.reportId !== id) return fail(); return r; }
  async reserveReportCapture(assetId: string, extension: "jpg" | "png" | "webp", signal?: AbortSignal) { const r = fields(await this.send("/report-captures", { assetId: uuid(assetId), extension }, signal), ["assetId", "bucket", "path", "state"]); if (r.assetId !== assetId || r.bucket !== "report-evidence") return fail(); string(r.path); if (!["reserved", "uploaded", "attached"].includes(string(r.state))) return fail(); return r; }
  async confirmReportCapture(id: string, signal?: AbortSignal) { const r = fields(await this.send(`/report-captures/${uuid(id)}/confirm`, {}, signal), ["assetId", "state"]); if (r.assetId !== id || !["uploaded", "attached"].includes(string(r.state))) return fail(); return r; }
  async cancelReportCapture(id: string, signal?: AbortSignal) { const r = fields(await this.send(`/report-captures/${uuid(id)}/cancel`, {}, signal), ["assetId", "state", "storageDeletionRequired"]); if (r.assetId !== id || r.state !== "cancelled") return fail(); bool(r.storageDeletionRequired); return r; }
}
