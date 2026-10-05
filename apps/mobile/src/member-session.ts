import { ApiError } from "./api.ts";
import { fields, string, uuid, traits } from "./member-service.ts";

export type SignupStatus = "information_required" | "ineligible" | "photo_required" | "completion_required" | "ready";
export interface SessionResult { userId: string; accessToken: string; status: SignupStatus; returnTo: string; }
export interface MemberSessionPort {
  /** Adapter owns approved Origin/native callback and verifies server session; URLs never carry tokens. */
  login(returnTo: string, signal: AbortSignal): Promise<SessionResult | null>;
  callback?(url: string, signal: AbortSignal): Promise<SessionResult>;
  accessToken?(): Promise<string | null>;
  restore(signal: AbortSignal): Promise<SessionResult | null>;
  logout(signal: AbortSignal): Promise<void>;
  signupState(signal: AbortSignal): Promise<unknown>;
  complete(input: { avatarPath: string; interests: string[]; conversationStyles: string[]; mbti: string | null }, signal: AbortSignal): Promise<unknown>;
  /** Real Auth/Storage cleanup HTTP preparation required. No fabricated retirement endpoint. */
  retire?(withdrawalId: string, signal: AbortSignal): Promise<unknown>;
}
export function publicApiKey(value: string) {
  if (!value || /[\r\n]/.test(value) || value.startsWith("sb_secret_")) throw new ApiError(400, "INVALID_PUBLIC_API_KEY");
  if (value.split(".").length === 3) {
    try { const payload = JSON.parse(atob(value.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))); if (payload.role !== "anon") throw new Error("not public"); }
    catch { throw new ApiError(400, "INVALID_PUBLIC_API_KEY"); }
  }
  return value;
}
export function internalPath(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new ApiError(400, "INVALID_RETURN_PATH"); }
  if (!decoded.startsWith("/") || decoded.startsWith("//") || /[\\#\u0000-\u001f]/.test(decoded) || decoded.split("/").some(s => s === ".." || s === ".")) throw new ApiError(400, "INVALID_RETURN_PATH");
  return value === "/login" ? "/" : value;
}
export function sessionResult(value: unknown): SessionResult {
  const r = fields(value, ["userId", "accessToken", "status", "returnTo"]);
  const token = string(r.accessToken);
  if (!token || /[\r\n]/.test(token) || !["information_required", "ineligible", "photo_required", "completion_required", "ready"].includes(string(r.status))) throw new ApiError(502, "INVALID_SESSION_RESPONSE");
  return { userId: uuid(r.userId), accessToken: token, status: r.status as SignupStatus, returnTo: internalPath(string(r.returnTo)) };
}
export function signupState(value: unknown) {
  const r = fields(value, ["status", "avatarPath", "interests", "conversationStyles", "mbti"]);
  if (!["information_required", "ineligible", "photo_required", "completion_required", "ready"].includes(string(r.status))) throw new ApiError(502, "INVALID_SESSION_RESPONSE");
  if (r.avatarPath !== null && !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/i.test(string(r.avatarPath))) throw new ApiError(502, "INVALID_SESSION_RESPONSE");
  return { status: r.status as SignupStatus, avatarPath: r.avatarPath === null ? null : string(r.avatarPath), ...traits(r) };
}
export function retirementResult(value: unknown, id: string) {
  const r = fields(value, ["withdrawalId", "status", "memberAccessRevoked"]);
  if (r.withdrawalId !== id || r.memberAccessRevoked !== true || !["processing", "completed"].includes(string(r.status))) throw new ApiError(502, "INVALID_SERVICE_RESPONSE");
  return { status: r.status as "processing" | "completed", withdrawalId: id, memberAccessRevoked: true as const };
}
