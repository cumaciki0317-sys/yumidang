/** 민규담당. 네이버 공식 고정 URL만 호출하며 응답·토큰·외부 오류 원문을 기록하지 않는다.
 * https://developers.naver.com/docs/login/api/api.md
 * https://developers.naver.com/docs/login/profile/profile.md
 */
import type { NaverConfig } from "../../config/naver.ts";
import { HttpError } from "../../http/errors.ts";
import type { NaverIdentityPort, NaverProfile } from "./port.ts";

const AUTHORIZE = "https://nid.naver.com/oauth2.0/authorize";
const TOKEN = "https://nid.naver.com/oauth2.0/token";
const PROFILE = "https://openapi.naver.com/v1/nid/me";
const MAX_RESPONSE_BYTES = 65536;
const unavailable = (): never => { throw new HttpError("EXTERNAL_UNAVAILABLE"); };
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return unavailable();
  return value as Record<string, unknown>;
}
function input(value: string): string {
  if (typeof value !== "string" || !value || value.length > 4096 || value.trim() !== value || /\p{Cc}/u.test(value)) {
    throw new HttpError("INVALID_REQUEST");
  }
  return value;
}
function birthDate(year: unknown, birthday: unknown): string | null {
  if (typeof year !== "string" || !/^[0-9]{4}$/.test(year) || Number(year) < 1 ||
    typeof birthday !== "string" || !/^[0-9]{2}-[0-9]{2}$/.test(birthday)) return null;
  const [month, day] = birthday.split("-").map(Number);
  const y = Number(year);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null;
  return `${year}-${birthday}`;
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) return unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_RESPONSE_BYTES) return unavailable();
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function createNaverIdentityAdapter(config: NaverConfig, fetchImpl: typeof fetch = fetch): NaverIdentityPort {
  async function request(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
          if (response.redirected || response.status >= 300 && response.status < 400) return unavailable();
          return { status: response.status, body: await boundedJson(response) };
        })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new HttpError("EXTERNAL_UNAVAILABLE")); }, config.upstreamTimeoutMs);
        }),
      ]);
    } catch { return unavailable(); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  return {
    authorizationUrl(state) {
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, state: input(state) }).toString();
      return url.href;
    },
    async exchange(code, state) {
      const token = await request(TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId,
          client_secret: config.clientSecret, redirect_uri: config.redirectUri, code: input(code), state: input(state) }),
      });
      if (token.body.error === "invalid_request") throw new HttpError("INVALID_REQUEST");
      if (token.body.error === "invalid_grant" || token.body.error === "unauthorized_client") throw new HttpError("AUTH_REQUIRED");
      if (token.status !== 200 || token.body.error !== undefined ||
        typeof token.body.access_token !== "string" || token.body.access_token.length > 8192 ||
        !/^[A-Za-z0-9._~+/-]+=*$/.test(token.body.access_token) ||
        typeof token.body.token_type !== "string" || token.body.token_type.toLowerCase() !== "bearer") return unavailable();
      const profile = await request(PROFILE, {
        method: "GET", headers: { authorization: `Bearer ${token.body.access_token}`, accept: "application/json" },
      });
      if (profile.status === 401) throw new HttpError("AUTH_REQUIRED");
      if (profile.status !== 200 || profile.body.resultcode !== "00") return unavailable();
      const info = object(profile.body.response);
      if (typeof info.id !== "string" || !info.id || info.id.length > 255 || info.id.trim() !== info.id || /\p{Cc}/u.test(info.id)) return unavailable();
      const name = typeof info.name === "string" && info.name.trim() && info.name.length <= 255 && !/\p{Cc}/u.test(info.name) ? info.name.trim() : null;
      const gender = info.gender === "F" || info.gender === "M" || info.gender === "U" ? info.gender : null;
      return { subject: info.id, name, gender, birthDate: birthDate(info.birthyear, info.birthday) } satisfies NaverProfile;
    },
  };
}
