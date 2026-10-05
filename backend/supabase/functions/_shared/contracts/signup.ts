/** 민규담당. 네이버 OAuth 시작·교환과 명시적 가입 완료의 입력 계약. */
import type { JsonValue } from "./common.ts";
import { HttpError } from "../http/errors.ts";
export type SignupStatus = "information_required" | "ineligible" | "photo_required" | "completion_required" | "ready";
export interface ProfileTraits { interests: string[]; conversationStyles: string[]; mbti: string | null }
export interface ProfilePreferences extends ProfileTraits { bio: string | null }
const invalid = (): never => { throw new HttpError("INVALID_REQUEST"); };
function object(value: JsonValue, required: string[], optional: string[] = []): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))) return invalid();
  return value;
}
function text(value: JsonValue | undefined, min: number, max: number): string {
  if (typeof value !== "string" || value !== value.trim() || [...value].length < min || [...value].length > max ||
    /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}
/** 절대 URL·외부 호스트·역슬래시·제어문자를 복귀 경로로 받지 않는다. */
export function parseReturnTo(value: JsonValue | undefined): string {
  const path = text(value, 1, 2048);
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/u.test(path)) return invalid();
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return invalid(); }
  if (decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/u.test(decoded)) return invalid();
  const url = new URL(path, "https://return.invalid");
  if (url.origin !== "https://return.invalid") return invalid();
  return path;
}
export function parseNaverStart(value: JsonValue): { codeChallenge: string; returnTo: string } {
  const input = object(value, ["codeChallenge"], ["returnTo"]);
  const codeChallenge = text(input.codeChallenge, 64, 64);
  if (!/^[0-9a-f]{64}$/.test(codeChallenge)) return invalid();
  return { codeChallenge, returnTo: parseReturnTo(input.returnTo ?? "/") };
}
export function parseNaverCallback(value: JsonValue): { code: string; state: string; codeVerifier: string } {
  const input = object(value, ["code", "state", "codeVerifier"]);
  const code = text(input.code, 1, 2048), state = text(input.state, 64, 64);
  const codeVerifier = text(input.codeVerifier, 43, 128);
  if (!/^[0-9a-f]{64}$/.test(state) || !/^[A-Za-z0-9_-]+$/.test(codeVerifier)) return invalid();
  return { code, state, codeVerifier };
}
function traits(values: JsonValue | undefined): string[] {
  if (!Array.isArray(values) || values.length > 20) return invalid();
  const result = values.map((item) => text(item, 1, 40));
  if (result.some((item) => /\s\s/u.test(item)) || new Set(result.map((item) => item.toLowerCase())).size !== result.length) return invalid();
  return result;
}
export function parseProfileTraits(value: JsonValue): ProfileTraits {
  const input = object(value, ["interests", "conversationStyles", "mbti"]);
  const mbti = input.mbti === null ? null : text(input.mbti, 4, 4);
  if (mbti !== null && !/^[EI][NS][TF][JP]$/.test(mbti)) return invalid();
  return { interests: traits(input.interests), conversationStyles: traits(input.conversationStyles), mbti };
}
/** 소개는 기존 DB의 nullable·300자 기준을 그대로 적용하며 입력을 정규화하지 않는다. */
export function parseProfilePreferences(value: JsonValue): ProfilePreferences {
  const input = object(value, ["interests", "conversationStyles", "mbti", "bio"]);
  const bio = input.bio;
  if (bio !== null && (typeof bio !== "string" || [...bio].length > 300)) return invalid();
  return { ...parseProfileTraits({ interests: input.interests!, conversationStyles: input.conversationStyles!, mbti: input.mbti! }), bio };
}
export function parseSignupCompletion(value: JsonValue): ProfileTraits & { avatarPath: string } {
  const input = object(value, ["avatarPath"], ["interests", "conversationStyles", "mbti"]);
  const avatarPath = text(input.avatarPath, 77, 77);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/.test(avatarPath)) return invalid();
  return { avatarPath, ...parseProfileTraits({ interests: Object.hasOwn(input, "interests") ? input.interests! : [],
    conversationStyles: Object.hasOwn(input, "conversationStyles") ? input.conversationStyles! : [], mbti: input.mbti ?? null }) };
}
