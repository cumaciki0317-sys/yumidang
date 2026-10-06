/** 민규: 임시 loopback 네이버·실제 JPEG 업로드·명시 가입 완료 검증 페이지.
 * 실행: node tools/local/run_naver_oauth_local.ts --config /private/tmp/개인임시폴더/config.json
 * 또는 YUMIDANG_NAVER_LIVE_CONFIG에 같은 파일 경로만 전달한다. 저장소 .env를 읽지 않는다.
 * 기존 전용 프로젝트의 회원을 유지하며 다시 실행할 때만 --resume를 명시한다.
 * config는 소유자 전용 임시 폴더0700 안의 regular file0600이어야 한다.
 * TTL600초/body8192바이트/upstream10000ms는 이번 로컬 검증 fixture이며 운영 설정이 아니다.
 * 키·응답·OAuth query·토큰·개인정보를 콘솔/디스크에 기록하지 않는다.
 */
import { createServer, type IncomingMessage } from "node:http";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createSignupRuntimeHandler } from "../../backend/supabase/functions/signup/index.ts";
import { loadRuntimeConfig } from "../../backend/supabase/functions/_shared/config/env.ts";
import { requirePrincipal, getPrincipalToken } from "../../backend/supabase/functions/_shared/auth/principal.ts";

export const LOCAL_ORIGIN = "http://127.0.0.1:5173";
export const LOCAL_API = "http://127.0.0.1:56221";
export const LOCAL_PROJECT = "yumidang-minkyu-naver-live";
// 명시한 격리 release 검증 모드에서만 두 번째 고정 프로젝트를 허용한다.
const RELEASE_HTTP_MODE = process.argv.includes("--release-http");
const ACTIVE_LOCAL_API = RELEASE_HTTP_MODE ? "http://127.0.0.1:59621" : LOCAL_API;
const ACTIVE_LOCAL_PROJECT = RELEASE_HTTP_MODE ? "yumidang-release88-http" : LOCAL_PROJECT;

export const LOCAL_CALLBACK = LOCAL_ORIGIN + "/naver/callback";
const LOCAL_HOST = "127.0.0.1:5173";
const CONTEXT = "colima-yumidang-minkyu";
const CONTAINER = "supabase_db_" + ACTIVE_LOCAL_PROJECT;
const MAX_BODY_BYTES = 8192;
// 정책의 원본 10MB는 기존 사진 선택 계약과 같은 10 * 1024 * 1024바이트다.
export const MAX_ORIGINAL_PHOTO_BYTES = 10 * 1024 * 1024;
// Storage 저장 한도는 원본 선택 한도와 별개인 재인코딩 JPEG 2MiB다.
export const MAX_PHOTO_BYTES = 2097152;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IMAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_CONFIG_BYTES = 24576;
const STATUS_VALUES = new Set(["information_required", "ineligible", "photo_required", "completion_required", "ready"]);
export interface LocalNaverConfig {
  readonly API_URL: string;
  readonly ANON_KEY: string;
  readonly SERVICE_ROLE_KEY: string;
  readonly NAVER_CLIENT_ID: string;
  readonly NAVER_CLIENT_SECRET: string;
  readonly NAVER_REDIRECT_URI: string;
}
const validatedConfigs = new WeakSet<object>();
const CONFIG_KEYS = ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET", "NAVER_REDIRECT_URI"] as const;
const fail = (): never => { throw new Error("LOCAL_VALIDATION_FAILED"); };
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function validatedConfig(value: unknown): LocalNaverConfig {
  if (value !== null && typeof value === "object" && validatedConfigs.has(value)) return value as LocalNaverConfig;
  const row = object(value);
  if (!row || Object.keys(row).length !== CONFIG_KEYS.length || !CONFIG_KEYS.every((key) => Object.hasOwn(row, key))) return fail();
  for (const key of CONFIG_KEYS) {
    const text = row[key];
    if (typeof text !== "string" || !text || text.trim() !== text || text.length > 8192 || /[\u0000-\u001f\u007f]/u.test(text)) return fail();
  }
  if (row.API_URL !== ACTIVE_LOCAL_API || row.NAVER_REDIRECT_URI !== LOCAL_CALLBACK ||
    (row.ANON_KEY as string).length < 32 || (row.SERVICE_ROLE_KEY as string).length < 32 || row.ANON_KEY === row.SERVICE_ROLE_KEY) return fail();
  const config = Object.create(null);
  for (const key of CONFIG_KEYS) Object.defineProperty(config, key, { value: row[key] });
  Object.defineProperty(config, "toJSON", { value: () => ({ configured: true }) });
  Object.defineProperty(config, Symbol.for("nodejs.util.inspect.custom"), { value: () => ({ configured: true }) });
  Object.freeze(config);
  validatedConfigs.add(config);
  return config as LocalNaverConfig;
}
export function readSecureLocalConfig(filename: string): LocalNaverConfig {
  let descriptor: number | undefined;
  try {
    if (typeof filename !== "string" || !isAbsolute(filename) || /[\u0000-\u001f\u007f]/u.test(filename)) return fail();
    const candidate = resolve(filename);
    const canonical = realpathSync(candidate);
    // macOS의 기본 /tmp, /var 별칭만 허용한다. 사용자 추가 symlink 경로는 거절한다.
    const expected = candidate.startsWith("/tmp/") ? "/private" + candidate
      : candidate.startsWith("/var/") ? "/private" + candidate : candidate;
    if (canonical !== expected || !["/private/tmp/", realpathSync(tmpdir()) + "/"].some((prefix) => canonical.startsWith(prefix))) return fail();
    const uid = process.getuid?.();
    if (uid === undefined) return fail();
    const directory = lstatSync(dirname(canonical));
    const info = lstatSync(candidate);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o777) !== 0o700 ||
      !info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o777) !== 0o600 || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES) return fail();
    descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.uid !== uid || (opened.mode & 0o777) !== 0o600 || opened.nlink !== 1 ||
      opened.size > MAX_CONFIG_BYTES || opened.ino !== info.ino || opened.dev !== info.dev) return fail();
    return validatedConfig(JSON.parse(readFileSync(descriptor, "utf8")));
  } catch { return fail(); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function assertLocalContainer(endpoint: string, container: unknown): void {
  const target = object(container), config = object(target?.Config), labels = object(config?.Labels), state = object(target?.State);
  if (endpoint !== "unix://" + homedir() + "/.colima/yumidang-minkyu/docker.sock" ||
    target?.Name !== "/" + CONTAINER || labels?.["com.supabase.cli.project"] !== ACTIVE_LOCAL_PROJECT ||
    state?.Running !== true) return fail();
}
export function validateLocalTarget(endpoint: string, container: unknown, authUserCount: string, resume = false): void {
  assertLocalContainer(endpoint,container);
  if (!/^(0|[1-9][0-9]{0,8})$/.test(authUserCount) || (!resume && authUserCount !== "0")) return fail();
}
/** 고정된 기존 런타임의 네트워크 범위만 허용한다. redirect를 따라가지 않는다. */
export function createGuardedLocalFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  const rpcPaths = new Set(["begin_naver_login", "consume_naver_login", "resolve_naver_account", "record_naver_session", "get_naver_signup_state", "complete_naver_signup"]);
  return async (input, init) => {
    try {
      const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(address);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.username || url.password || url.search || url.hash) return fail();
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const storagePath = /^\/storage\/v1\/object\/profile-images\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.jpg$/.exec(url.pathname);
      const localUpload = method === "POST" && storagePath !== null && UUID.test(storagePath[1]) && IMAGE_UUID.test(storagePath[2]) &&
        headers.get("content-type") === "image/jpeg" && headers.get("x-upsert") === "false" &&
        /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(headers.get("authorization") ?? "");
      const local = url.origin === ACTIVE_LOCAL_API && (
        (method === "GET" && url.pathname === "/auth/v1/user") ||
        (method === "POST" && ["/auth/v1/admin/generate_link", "/auth/v1/verify"].includes(url.pathname)) ||
        (method === "POST" && url.pathname.startsWith("/rest/v1/rpc/") && rpcPaths.has(url.pathname.slice("/rest/v1/rpc/".length))) || localUpload
      );
      const official = (method === "POST" && url.href === "https://nid.naver.com/oauth2.0/token") ||
        (method === "GET" && url.href === "https://openapi.naver.com/v1/nid/me");
      if (!local && !official) return fail();
      const response = await fetchImpl(input, { ...init, redirect: "error", credentials: "omit" });
      if (response.redirected || response.status >= 300 && response.status < 400) return fail();
      return response;
    } catch { return fail(); }
  };
}
export const LOCAL_PAGE = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>네이버 로컬 로그인 검증</title><script src="/app.js" defer></script></head>
<body><h1>네이버 로컬 로그인 검증</h1>
<p>임시 검증 페이지입니다. 여성·만 19세 이상 자격과 정보 제공 여부를 실제 가입 런타임에서 확인합니다.</p>
<p>자격 미충족 결과는 로그인 연결 결과와 구분합니다. JPEG 업로드 뒤 가입 완료 버튼을 눌러 확인합니다.</p>
<button id="start" type="button">네이버 로그인 시작</button><p id="status" role="status">시작 전</p>
<section id="photo-section" hidden><label for="photo">프로필 사진: JPG·JPEG·PNG 원본 10MB 이하</label>
<input id="photo" type="file" accept="image/jpeg,image/png" disabled>
<button id="upload" type="button" disabled>선택 사진 업로드</button>
<p><label for="interests">관심사(선택, 쉼표로 구분)</label><input id="interests" type="text"></p>
<p><label for="conversationStyles">대화 방식(선택, 쉼표로 구분)</label><input id="conversationStyles" type="text"></p>
<p><label for="mbti">MBTI(선택)</label><input id="mbti" type="text" maxlength="4"></p>
<button id="complete" type="button" disabled>가입 완료</button></section>
</body></html>`;
export const LOCAL_SCRIPT = String.raw`"use strict";
(() => {
  const start = document.getElementById("start");
  const output = document.getElementById("status");
  const photoSection = document.getElementById("photo-section");
  const photo = document.getElementById("photo");
  const upload = document.getElementById("upload");
  const complete = document.getElementById("complete");
  const interests = document.getElementById("interests");
  const conversationStyles = document.getElementById("conversationStyles");
  const mbti = document.getElementById("mbti");
  const allowedStatus = new Set(["information_required", "ineligible", "photo_required", "completion_required", "ready"]);
  const verifierPrefix = "yumidang-local-naver-verifier:";
  let sessionMemory = null;
  let avatarPathMemory = null;
  let signupStatusMemory = null;
  let busy = false;
  function updateButtons() {
    const eligible = sessionMemory !== null && ["photo_required","completion_required"].includes(signupStatusMemory);
    photoSection.hidden = !eligible;
    photo.disabled = busy || !eligible;
    upload.disabled = busy || !eligible || !photo.files || photo.files.length !== 1;
    complete.disabled = busy || !eligible || !avatarPathMemory;
  }
  function applyState(state) {
    if (!allowedStatus.has(state.status)) throw new Error("LOCAL_REQUEST_FAILED");
    signupStatusMemory = state.status;
    if (typeof state.avatarPath === "string" && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/.test(state.avatarPath)) avatarPathMemory = state.avatarPath;
    show(state.status);
    updateButtons();
  }
  function show(value) {
    const guidance = {
      information_required:"네이버 정보 제공이 부족합니다. 이름·성별·생년월일 제공에 동의한 뒤 다시 로그인해 주세요.",
      ineligible:"네이버 로그인 연결은 확인됐지만 여성·만 19세 이상 가입 자격을 충족하지 못했습니다.",
      photo_required:"로그인 확인 완료. 아래에서 JPG·JPEG·PNG 사진을 선택하고 선택 사진 업로드를 누르세요.",
      completion_required:"사진을 확인했습니다. 선택 항목을 입력하거나 비워 두고 가입 완료를 눌러 주세요.",
      ready:"가입 완료 검증 성공",
    };
    output.textContent = guidance[value] || value;
  }
  async function api(path, body, accessToken) {
    const headers = {"Content-Type":"application/json"};
    if (accessToken) headers.Authorization = "Bearer " + accessToken;
    const response = await fetch(path, {method:"POST", headers, credentials:"omit", cache:"no-store", redirect:"error",
      ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    if (!response.ok) throw new Error("LOCAL_REQUEST_FAILED");
    const envelope = await response.json();
    if (!envelope || !envelope.data || typeof envelope.data !== "object") throw new Error("LOCAL_REQUEST_FAILED");
    return envelope.data;
  }
  start.addEventListener("click", async () => {
    sessionMemory = null;
    avatarPathMemory = null;
    signupStatusMemory = null;
    updateButtons();
    start.disabled = true;
    let storedKey = null;
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const verifier = btoa(String.fromCharCode(...bytes)).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
      const codeChallenge = Array.from(hash, (value) => value.toString(16).padStart(2,"0")).join("");
      const result = await api("/api/signup/naver/start", {codeChallenge,returnTo:"/"});
      const authorize = new URL(result.authorizationUrl);
      const state = authorize.searchParams.get("state");
      if (authorize.origin !== "https://nid.naver.com" || authorize.pathname !== "/oauth2.0/authorize" ||
        authorize.username || authorize.password || authorize.hash || !/^[0-9a-f]{64}$/.test(state || "") ||
        authorize.searchParams.get("redirect_uri") !== "http://127.0.0.1:5173/naver/callback" ||
        authorize.searchParams.get("response_type") !== "code") throw new Error("LOCAL_REQUEST_FAILED");
      storedKey = verifierPrefix + state;
      sessionStorage.setItem(storedKey, verifier);
      location.assign(authorize.href);
    } catch {
      if (storedKey) { try { sessionStorage.removeItem(storedKey); } catch {} }
      show("로그인 시작을 확인하지 못했습니다. 다시 시도해 주세요.");
      start.disabled = false;
    }
  });
  photo.addEventListener("change", () => { updateButtons(); });
  upload.addEventListener("click", async () => {
    if (busy || !sessionMemory || !["photo_required","completion_required"].includes(signupStatusMemory)) return;
    busy = true; updateButtons();
    try {
      const file = photo.files && photo.files.length === 1 ? photo.files[0] : null;
      if (!file || !["image/jpeg","image/png"].includes(file.type) || file.size < 1 || file.size > ${MAX_ORIGINAL_PHOTO_BYTES}) throw new Error("LOCAL_REQUEST_FAILED");
      // 실제 픽셀만 새 JPEG로 인코딩해 원본 EXIF/GPS를 전송하지 않는다.
      const bitmap = await createImageBitmap(file);
      let encoded;
      let canvas;
      try {
        canvas = document.createElement("canvas");
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext("2d");
        if (!context || bitmap.width < 1 || bitmap.height < 1) throw new Error("LOCAL_REQUEST_FAILED");
        context.drawImage(bitmap,0,0);
        encoded = await new Promise((resolve,reject) => canvas.toBlob((blob) => {
          if (!blob || blob.type !== "image/jpeg" || blob.size < 1 || blob.size > 2097152) reject(new Error("LOCAL_REQUEST_FAILED"));
          else resolve(blob);
        },"image/jpeg",0.9));
      } finally {
        // Canvas 메모리를 비워도 선택한 원본 파일과 입력은 유지한다.
        if (canvas) { canvas.width = 0; canvas.height = 0; }
        bitmap.close();
      }
      const bytes = await encoded.arrayBuffer();
      if (bytes.byteLength < 1 || bytes.byteLength > 2097152) throw new Error("LOCAL_REQUEST_FAILED");
      const response = await fetch("/api/signup/photo", {method:"POST",credentials:"omit",cache:"no-store",redirect:"error",
        headers:{"Content-Type":"image/jpeg","X-Image-Id":crypto.randomUUID(),Authorization:"Bearer " + sessionMemory.accessToken},body:bytes});
      if (!response.ok) throw new Error("LOCAL_REQUEST_FAILED");
      const envelope = await response.json();
      if (!envelope || !envelope.data || typeof envelope.data.avatarPath !== "string" ||
        !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/.test(envelope.data.avatarPath)) throw new Error("LOCAL_REQUEST_FAILED");
      avatarPathMemory = envelope.data.avatarPath;
      show("사진 등록 완료. 가입 완료를 눌러 주세요.");
    } catch { show("사진 업로드를 확인하지 못했습니다. 선택한 사진과 입력을 유지했습니다."); }
    finally { busy = false; updateButtons(); }
  });
  complete.addEventListener("click", async () => {
    if (busy || !sessionMemory || !avatarPathMemory || !["photo_required","completion_required"].includes(signupStatusMemory)) return;
    busy = true; updateButtons();
    try {
      const values = (input) => input.value.split(",").map((value) => value.trim()).filter(Boolean);
      const traits = {interests:values(interests),conversationStyles:values(conversationStyles),mbti:mbti.value.trim().toUpperCase() || null};
      const result = await api("/api/signup/complete", {avatarPath:avatarPathMemory,...traits}, sessionMemory.accessToken);
      if (result.status !== "ready") throw new Error("LOCAL_REQUEST_FAILED");
      const verified = await api("/api/signup/state", undefined, sessionMemory.accessToken);
      if (verified.status !== "ready") throw new Error("LOCAL_REQUEST_FAILED");
      applyState(verified);
      show("가입 완료 검증 성공");
    } catch { show("가입 완료를 확인하지 못했습니다. 사진과 선택 입력을 유지했습니다."); }
    finally { busy = false; updateButtons(); }
  });
  // callback query는 첫 동기 단계에서 복사하고 즉시 주소창/현재 이력에서 제거한다.
  if (location.pathname === "/naver/callback") {
    const query = new URLSearchParams(location.search);
    history.replaceState(null,"","/naver/callback");
    const state = query.get("state");
    const code = query.get("code");
    const hasError = query.has("error") || query.has("error_description");
    sessionMemory = null;
    let verifier = null;
    if (/^[0-9a-f]{64}$/.test(state || "")) {
      try { verifier = sessionStorage.getItem(verifierPrefix + state); }
      catch { verifier = null; }
      finally { try { sessionStorage.removeItem(verifierPrefix + state); } catch { verifier = null; } }
    }
    start.disabled = true;
    void (async () => {
      try {
        if (hasError || !code || !state || !verifier || query.getAll("code").length !== 1 || query.getAll("state").length !== 1) {
          throw new Error("LOCAL_REQUEST_FAILED");
        }
        const result = await api("/api/signup/naver/callback", {code,state,codeVerifier:verifier});
        if (!allowedStatus.has(result.status)) throw new Error("LOCAL_REQUEST_FAILED");
        if (result.session === null) {
          if (!["information_required","ineligible"].includes(result.status)) throw new Error("LOCAL_REQUEST_FAILED");
          show(result.status);
          return;
        }
        if (!result.session || result.session.tokenType !== "bearer" || typeof result.session.accessToken !== "string" ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(result.session.accessToken)) throw new Error("LOCAL_REQUEST_FAILED");
        sessionMemory = {accessToken:result.session.accessToken};
        // POST wrapper는 strict Origin을 유지하고 서버에서 실제 GET /signup/state로 변환한다.
        const verified = await api("/api/signup/state", undefined, sessionMemory.accessToken);
        if (!allowedStatus.has(verified.status)) throw new Error("LOCAL_REQUEST_FAILED");
        applyState(verified);
      } catch {
        sessionMemory = null;
        show("로그인 검증을 확인하지 못했습니다. 다시 시도해 주세요.");
      } finally { start.disabled = false; }
    })();
  }
})();`;
function protectedResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Content-Security-Policy", "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'");
  return new Response(response.body, {status:response.status, headers});
}
function safeFailure(status: number, code: string): Response {
  return protectedResponse(new Response(JSON.stringify({error:{code}}), {status,headers:{"Content-Type":"application/json; charset=utf-8"}}));
}
/** JPEG marker/segment 구조만 확인한다. 픽셀 디코딩은 브라우저에서 실제 수행한다. */
export function isLocalJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2, frame = false, scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++];
    if (marker === 0xd9) return offset === bytes.length && frame && scan;
    if (marker === 0xd8 || marker === 0x00 || marker >= 0xd0 && marker <= 0xd7) return false;
    if (marker === 0x01) continue;
    if (offset + 2 > bytes.length) return false;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if ([0xc0,0xc1,0xc2].includes(marker)) {
      if (frame || scan || length < 11) return false;
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];
      const components = bytes[offset + 7];
      if (![8,12].includes(bytes[offset + 2]) || height === 0 || width === 0 || components < 1 || components > 4 || length !== 8 + 3 * components) return false;
      frame = true;
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker)) return false;
    if (marker === 0xda) {
      if (!frame || length < 8 || bytes[offset + 2] < 1 || bytes[offset + 2] > 4 || length !== 6 + 2 * bytes[offset + 2]) return false;
      scan = true;
      offset += length;
      let entropy = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { entropy = true; offset++; continue; }
        if (offset + 1 >= bytes.length) return false;
        const next = bytes[offset + 1];
        if (next === 0x00) { entropy = true; offset += 2; }
        else if (next >= 0xd0 && next <= 0xd7) offset += 2;
        else if (next === 0xff) offset++;
        else break;
      }
      if (!entropy) return false;
    } else offset += length;
  }
  return false;
}
async function boundedBody(request: Request, maximum = MAX_BODY_BYTES): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) return fail();
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
  return bytes;
}
/** import 시에는 기동하지 않는다. 검사는 설정과 fetch만 주입한다. */
export function createNaverOAuthLocalHandler(configInput: LocalNaverConfig, fetchImpl: typeof fetch = fetch): (request: Request) => Promise<Response> {
  const config = validatedConfig(configInput);
  const runtimeEnv: Record<string,string> = {
    SUPABASE_URL:ACTIVE_LOCAL_API,SUPABASE_ANON_KEY:config.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:config.SERVICE_ROLE_KEY,
    NAVER_CLIENT_ID:config.NAVER_CLIENT_ID,NAVER_CLIENT_SECRET:config.NAVER_CLIENT_SECRET,NAVER_REDIRECT_URI:LOCAL_CALLBACK,
    ALLOWED_ORIGINS:JSON.stringify([LOCAL_ORIGIN]),MAX_REQUEST_BYTES:String(MAX_BODY_BYTES),
    UPSTREAM_TIMEOUT_MS:"10000",NAVER_STATE_TTL_SECONDS:"600",
  };
  const guardedFetch = createGuardedLocalFetch(fetchImpl);
  const runtimeConfig = loadRuntimeConfig((key) => runtimeEnv[key]);
  const signup = createSignupRuntimeHandler((key) => runtimeEnv[key], guardedFetch);
  const diagnostics: {starts:number;callbacks:number;stateChecks:number;uploads:number;completions:number;rejected:number;lastStatus:string|null;sessionIssued:boolean;authStateVerified:boolean;photoUploaded:boolean;signupCompleted:boolean} =
    {starts:0,callbacks:0,stateChecks:0,uploads:0,completions:0,rejected:0,lastStatus:null,sessionIssued:false,authStateVerified:false,photoUploaded:false,signupCompleted:false};
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (url.origin !== LOCAL_ORIGIN || url.username || url.password || url.hash || request.headers.get("host") !== LOCAL_HOST) {
        diagnostics.rejected++; return safeFailure(403,"LOCAL_ACCESS_DENIED");
      }
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== LOCAL_ORIGIN) { diagnostics.rejected++; return safeFailure(403,"LOCAL_ACCESS_DENIED"); }
      const path = url.pathname;
      const api = ["/api/signup/naver/start", "/api/signup/naver/callback", "/api/signup/state", "/api/signup/photo", "/api/signup/complete"].includes(path);
      const diagnostic = path === "/diagnostics";
      if ((api || diagnostic) && origin !== LOCAL_ORIGIN) { diagnostics.rejected++; return safeFailure(403,"LOCAL_ACCESS_DENIED"); }
      if (path !== "/naver/callback" && url.search) { diagnostics.rejected++; return safeFailure(404,"LOCAL_NOT_FOUND"); }
      if (api) {
        // 브라우저 GET에는 Origin이 없을 수 있어 로컬 POST wrapper만 허용한다. 제품 RPC 계약은 그대로다.
        if (request.method !== "POST") { diagnostics.rejected++; return safeFailure(405,"LOCAL_METHOD_NOT_ALLOWED"); }
        if (path === "/api/signup/photo") {
          if (request.headers.get("content-type") !== "image/jpeg" || !IMAGE_UUID.test(request.headers.get("x-image-id") ?? "")) {
            diagnostics.rejected++; return safeFailure(400,"LOCAL_INVALID_PHOTO");
          }
          let photoBytes: Uint8Array;
          try { photoBytes = await boundedBody(request, MAX_PHOTO_BYTES); }
          catch { diagnostics.rejected++; return safeFailure(413,"LOCAL_BODY_LIMIT"); }
          if (!isLocalJpeg(photoBytes)) { diagnostics.rejected++; return safeFailure(400,"LOCAL_INVALID_PHOTO"); }
          // 클라이언트 UUID/경로를 사용자 신원으로 쓰지 않는다. 기존 Auth 경계로 확인한다.
          let principal;
          try { principal = await requirePrincipal(request, runtimeConfig, guardedFetch); }
          catch { diagnostics.rejected++; return safeFailure(401,"LOCAL_AUTH_REQUIRED"); }
          if (!UUID.test(principal.userId)) return safeFailure(401,"LOCAL_AUTH_REQUIRED");
          const imageId = request.headers.get("x-image-id")!;
          const avatarPath = principal.userId + "/" + imageId + ".jpg";
          diagnostics.uploads++;
          let stored: Response;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(),10000);
          try {
            stored = await guardedFetch(ACTIVE_LOCAL_API + "/storage/v1/object/profile-images/" + avatarPath, {
              method:"POST",headers:{apikey:config.ANON_KEY,Authorization:"Bearer " + getPrincipalToken(principal),
                "Content-Type":"image/jpeg","x-upsert":"false"},body:new Uint8Array(photoBytes).buffer,signal:controller.signal,
            });
          } catch { return safeFailure(503,"LOCAL_UPLOAD_FAILED"); }
          finally { clearTimeout(timer); }
          // 원문 Storage 응답은 반환하지 않는다. 실제 object 생성 성공만 경로로 확인한다.
          await stored.body?.cancel().catch(() => {});
          if (![200,201].includes(stored.status)) return safeFailure([400,401,403,409,413].includes(stored.status) ? stored.status : 503,"LOCAL_UPLOAD_FAILED");
          diagnostics.photoUploaded = true;
          return protectedResponse(Response.json({data:{avatarPath}}));
        }
        let body: Uint8Array;
        try { body = await boundedBody(request); } catch { diagnostics.rejected++; return safeFailure(413,"LOCAL_BODY_LIMIT"); }
        const isState = path === "/api/signup/state";
        if (isState && body.byteLength !== 0) { diagnostics.rejected++; return safeFailure(400,"LOCAL_INVALID_REQUEST"); }
        const headers = new Headers({Origin:LOCAL_ORIGIN});
        if (!isState) headers.set("Content-Type",request.headers.get("content-type") ?? "");
        const bearer = request.headers.get("authorization");
        if (bearer !== null) headers.set("Authorization",bearer);
        const runtimePath = path.slice("/api/".length);
        if (isState) diagnostics.stateChecks++;
        else if (path.endsWith("/start")) diagnostics.starts++;
        else if (path === "/api/signup/complete") diagnostics.completions++;
        else diagnostics.callbacks++;
        const response = await signup(new Request(LOCAL_ORIGIN + "/" + runtimePath, {
          method:isState ? "GET" : "POST",headers,...(isState ? {} : {body:new Uint8Array(body).buffer}),
        }));
        if (response.ok) {
          const envelope = object(await response.clone().json()), data = object(envelope?.data);
          if (typeof data?.status === "string" && STATUS_VALUES.has(data.status)) diagnostics.lastStatus = data.status;
          if (path.endsWith("/callback")) {
            diagnostics.sessionIssued = data?.session !== null && object(data?.session) !== null;
            diagnostics.authStateVerified = false;
          }
          if (isState && typeof data?.status === "string" && STATUS_VALUES.has(data.status)) diagnostics.authStateVerified = true;
          if (path === "/api/signup/complete" && data?.status === "ready") diagnostics.signupCompleted = true;
        }
        return protectedResponse(response);
      }
      if (!["/", "/naver/callback", "/app.js", "/diagnostics"].includes(path)) return safeFailure(404,"LOCAL_NOT_FOUND");
      if (request.method !== "GET") return safeFailure(405,"LOCAL_METHOD_NOT_ALLOWED");
      if (diagnostic) return protectedResponse(Response.json({scope:"local_oauth",...diagnostics}));
      const isScript = path === "/app.js";
      return protectedResponse(new Response(isScript ? LOCAL_SCRIPT : LOCAL_PAGE, {headers:{"Content-Type":isScript ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8"}}));
    } catch { diagnostics.rejected++; return safeFailure(500,"LOCAL_VERIFICATION_FAILED"); }
  };
}
async function incomingBody(request: IncomingMessage, maximum = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maximum) return fail();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks,size);
}
export async function runLocalOAuthServer(configPath: string, resume = false): Promise<void> {
  const config = readSecureLocalConfig(configPath);
  const docker = (...args: string[]) => execFileSync("docker", ["--context",CONTEXT,...args],
    {encoding:"utf8",timeout:20000,maxBuffer:1048576,stdio:["pipe","pipe","pipe"]}).trim();
  const endpoint = docker("context","inspect",CONTEXT,"--format","{{.Endpoints.docker.Host}}");
  const inspected = JSON.parse(docker("inspect",CONTAINER));
  if (!Array.isArray(inspected) || inspected.length !== 1) return fail();
  // 주소/소유 프로젝트를 먼저 확인하고 그 컨테이너에서만 읽기 전용 시작 검사를 수행한다.
  assertLocalContainer(endpoint,inspected[0]);
  const count = docker("exec","-i",CONTAINER,"psql","-X","-qAt","-U","postgres","-d","postgres","-c","select count(*) from auth.users;");
  validateLocalTarget(endpoint,inspected[0],count,resume);
  const handler = createNaverOAuthLocalHandler(config);
  const server = createServer(async (incoming,outgoing) => {
    let response: Response;
    try {
      if (!["127.0.0.1","::ffff:127.0.0.1"].includes(incoming.socket.remoteAddress ?? "") ||
        incoming.headers.host !== LOCAL_HOST || !incoming.url?.startsWith("/") || incoming.url.startsWith("//")) {
        response = safeFailure(403,"LOCAL_ACCESS_DENIED");
      } else {
        const method = incoming.method ?? "GET";
        const body = await incomingBody(incoming, incoming.url === "/api/signup/photo" && method === "POST" ? MAX_PHOTO_BYTES : MAX_BODY_BYTES);
        const headers = new Headers();
        for (const [key,value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value) || value === undefined) continue;
          headers.set(key,value);
        }
        const request = new Request(LOCAL_ORIGIN + incoming.url,{method,headers,...(["GET","HEAD"].includes(method) ? {} : {body:new Uint8Array(body).buffer})});
        response = await handler(request);
      }
    } catch { response = safeFailure(400,"LOCAL_INVALID_REQUEST"); }
    try {
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.destroy(); }
  });
  // 아래 시간 제한도 임시 검증 서버의 fixture다.
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.on("clientError", (_error,socket) => { socket.destroy(); });
  await new Promise<void>((ready,reject) => { server.once("error",reject); server.listen(5173,"127.0.0.1",ready); });
  console.log(JSON.stringify({status:"READY",scope:"local_oauth"}));
  const stop = () => server.close(() => { process.exitCode = 0; });
  process.once("SIGINT",stop); process.once("SIGTERM",stop);
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  const resume = args.includes("--resume");
  const options = args.filter((argument) => argument !== "--resume" && argument !== "--release-http");
  const invalidFlags = args.filter((argument) => argument === "--resume").length > 1 || args.filter((argument) => argument === "--release-http").length > 1;
  const path = invalidFlags ? undefined : options.length === 2 && options[0] === "--config" ? options[1]
    : options.length === 0 ? process.env.YUMIDANG_NAVER_LIVE_CONFIG : undefined;
  if (!path) { console.error(JSON.stringify({status:"FAIL",code:"LOCAL_CONFIGURATION_REQUIRED"})); process.exitCode = 1; }
  else runLocalOAuthServer(path,resume).catch(() => { console.error(JSON.stringify({status:"FAIL",code:"LOCAL_START_FAILED"})); process.exitCode = 1; });
}
