import { ApiError, ServiceApiClient } from "./api.ts";
import type { FreePostInput } from "../../../backend/supabase/functions/_shared/contracts/posts";
import type { ProfilePreferences, ProfileTraits } from "../../../backend/supabase/functions/_shared/contracts/signup";
import type { MemberReportInput } from "../../../backend/supabase/functions/_shared/contracts/reports";
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
  async conversations(signal?: AbortSignal) { return rows(await this.read("/conversations", signal)).map(r => { uuid(r.request_id); string(r.post_title); string(r.counterpart_masked_name); nullableString(r.last_message); return r; }); }
  async conversation(id: string, signal?: AbortSignal) { const r = one(await this.read(`/conversations/${uuid(id)}`, signal)); if (r.request_id !== id) return fail(); bool(r.can_send); string(r.my_role); string(r.post_title); return r; }
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
  async withdrawAi(kind: "exploration" | "review_summary", signal?: AbortSignal) { const r = fields(await this.send("/me/ai-processing/withdraw", { kind }, signal), ["withdrawn"]); if (r.withdrawn !== true) return fail(); return r; }
  async report(input: MemberReportInput, signal?: AbortSignal) { const r = fields(await this.send("/reports", input, signal), ["reportId", "status", "alreadySubmitted", "hideTarget"]); uuid(r.reportId); string(r.status); bool(r.alreadySubmitted); bool(r.hideTarget); return r; }
  async reports(before?: string, signal?: AbortSignal) { return this.page(`/me/reports?limit=20${before ? `&before=${uuid(before)}` : ""}`, signal); }
  async getReport(id: string, signal?: AbortSignal) { const r = wire(await this.read(`/me/reports/${uuid(id)}`, signal)); if (r.reportId !== id) return fail(); return r; }
  async reserveReportCapture(assetId: string, extension: "jpg" | "png" | "webp", signal?: AbortSignal) { const r = fields(await this.send("/report-captures", { assetId: uuid(assetId), extension }, signal), ["assetId", "bucket", "path", "state"]); if (r.assetId !== assetId || r.bucket !== "report-evidence") return fail(); string(r.path); if (!["reserved", "uploaded", "attached"].includes(string(r.state))) return fail(); return r; }
  async confirmReportCapture(id: string, signal?: AbortSignal) { const r = fields(await this.send(`/report-captures/${uuid(id)}/confirm`, {}, signal), ["assetId", "state"]); if (r.assetId !== id || !["uploaded", "attached"].includes(string(r.state))) return fail(); return r; }
  async cancelReportCapture(id: string, signal?: AbortSignal) { const r = fields(await this.send(`/report-captures/${uuid(id)}/cancel`, {}, signal), ["assetId", "state", "storageDeletionRequired"]); if (r.assetId !== id || r.state !== "cancelled") return fail(); bool(r.storageDeletionRequired); return r; }
}
