/** 민규: 전용 임시 로컬 Auth·PostgREST·SQL 실제 검증. 네이버만 가상 응답이다.
 * Node 실행: YUMIDANG_NAVER_LOCAL_CONFIG=/private/tmp/.../status.json node 이파일
 * 이 스크립트는 전용 환경에만 합성 계정·사진 객체 메타데이터·공고를 만든다.
 * 실제 이미지 업로드·실제 네이버 인증·Edge gateway 배포 검증은 포함하지 않는다.
 * 환경 생성/마이그레이션 적용/stop --no-backup 정리는 총괄이 수행한다.
 */
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createSignupRuntimeHandler } from "../../../backend/supabase/functions/signup/index.ts";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { sha256 } from "../../../backend/supabase/functions/_shared/services/signup-service.ts";

const API = "http://127.0.0.1:55621";
const ORIGIN = "http://127.0.0.1:5173";
const CONTEXT = "colima-yumidang-minkyu";
const CONTAINER = "supabase_db_yumidang-minkyu-naver";
let stage = "configuration";
let checks = 0;
let diagnostic: { httpStatus: number; errorCode: string } | undefined;
const check = (condition: unknown) => { if (!condition) throw new Error("integration_check_failed"); checks++; };
const nativeFetch = globalThis.fetch;
type ObjectRow = Record<string, any>;
const row = (value: unknown): ObjectRow => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("unexpected_response");
  return value as ObjectRow;
};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const jwtSession = (token: string) => row(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))).session_id;

async function run() {
  const filename = process.env.YUMIDANG_NAVER_LOCAL_CONFIG;
  check(typeof filename === "string" && filename.startsWith("/"));
  const info = lstatSync(filename!);
  check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600 && info.uid === process.getuid!());
  const path = realpathSync(filename!);
  check(["/private/tmp/", "/tmp/", realpathSync(tmpdir()) + "/"].some((prefix) => path.startsWith(prefix)));
  const cfg = row(JSON.parse(readFileSync(path, "utf8")));
  check(cfg.API_URL === API && typeof cfg.ANON_KEY === "string" && cfg.ANON_KEY.length > 30 &&
    typeof cfg.SERVICE_ROLE_KEY === "string" && cfg.SERVICE_ROLE_KEY.length > 30 && cfg.ANON_KEY !== cfg.SERVICE_ROLE_KEY);
  const env: Record<string, string> = {
    SUPABASE_URL: API, SUPABASE_ANON_KEY: cfg.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY,
    ALLOWED_ORIGINS: JSON.stringify([ORIGIN]), MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "10000",
    NAVER_CLIENT_ID: "synthetic-local-client", NAVER_CLIENT_SECRET: "synthetic-local-secret",
    NAVER_REDIRECT_URI: `${ORIGIN}/auth/naver/callback`, NAVER_STATE_TTL_SECONDS: "600",
  };
  const subject = `synthetic-local-${crypto.randomUUID()}`;
  let profile: ObjectRow = { id: subject, name: "가상검증회원", gender: "F", birthyear: "2000", birthday: "01-01" };
  let syntheticCalls = 0;
  const guardedFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://nid.naver.com/oauth2.0/token") {
      check(init?.method === "POST" && init?.redirect === "error"); syntheticCalls++;
      return new Response(JSON.stringify({ access_token: "synthetic-naver-access", token_type: "bearer" }));
    }
    if (url === "https://openapi.naver.com/v1/nid/me") {
      check(init?.method === "GET" && new Headers(init.headers).get("authorization") === "Bearer synthetic-naver-access");
      syntheticCalls++;
      return new Response(JSON.stringify({ resultcode: "00", response: profile }));
    }
    const parsed = new URL(url);
    check(parsed.origin === API && !parsed.username && !parsed.password && parsed.pathname.startsWith("/"));
    return nativeFetch(input, { ...init, redirect: "error" });
  };
  globalThis.fetch = guardedFetch;
  const signup = createSignupRuntimeHandler((name) => env[name], guardedFetch);
  const service = createRuntimeHandler((name) => env[name]);
  const request = (namespace: string, endpoint: string, token?: string, body?: unknown) => new Request(`${API}/functions/v1/${namespace}/${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const responseRow = async (response: Response) => {
    diagnostic = { httpStatus: response.status, errorCode: "UNEXPECTED_RESPONSE" };
    const result = row(await response.json());
    const code = result.error && typeof result.error === "object" ? result.error.code : undefined;
    const knownCodes = ["AUTH_REQUIRED", "ACCESS_DENIED", "RESOURCE_NOT_FOUND", "INVALID_REQUEST", "STATE_CONFLICT", "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "METHOD_NOT_ALLOWED"];
    diagnostic.errorCode = knownCodes.includes(code) ? code : result.error ? "UNEXPECTED_RESPONSE" : "NONE";
    return result;
  };
  const success = async (response: Response) => {
    const result = await responseRow(response);
    check([200, 201, 202].includes(response.status)); check(!result.error);
    const data = row(result.data); diagnostic = undefined; return data;
  };
  const failure = async (response: Response, status: number, code: string) => {
    const result = await responseRow(response);
    check(response.status === status); check(row(result.error).code === code); diagnostic = undefined;
  };
  const login = async () => {
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const begin = await success(await signup(request("signup", "naver/start", undefined, { codeChallenge: await sha256(verifier), returnTo: "/" })));
    const authorization = new URL(begin.authorizationUrl);
    check(authorization.origin === "https://nid.naver.com");
    const state = authorization.searchParams.get("state");
    check(typeof state === "string" && /^[0-9a-f]{64}$/.test(state));
    const body = { code: "synthetic-local-code", state, codeVerifier: verifier };
    const result = await success(await signup(request("signup", "naver/callback", undefined, body)));
    return { result, body };
  };
  const auth = async (endpoint: string, token: string, body?: unknown, method?: string) => guardedFetch(`${API}/auth/v1/${endpoint}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { apikey: cfg.ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const sql = (query: string) => execFileSync("docker", ["--context", CONTEXT, "exec", "-i", CONTAINER,
    "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
  { input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576 }).trim();

  stage = "fresh_local_database";
  check(sql("select count(*) from auth.users;") === "0");

  stage = "native_signup_session";
  const first = await login();
  check(first.result.status === "photo_required" && uuid(first.result.userId));
  const uid = first.result.userId as string;
  const token = row(first.result.session).accessToken;
  check(typeof token === "string" && uuid(jwtSession(token)));
  const userResponse = await auth("user", token);
  check(userResponse.status === 200);
  const user = row(await userResponse.json());
  check(user.id === uid && user.role === "authenticated" && user.is_anonymous === false);
  check(typeof user.email === "string" && user.email.endsWith("@naver.yumidang.invalid"));
  check((await success(await signup(request("signup", "state", token)))).status === "photo_required");
  await failure(await signup(request("signup", "naver/callback", undefined, first.body)), 400, "INVALID_REQUEST");

  stage = "profile_photo_completion";
  const imageId = crypto.randomUUID(); check(uuid(imageId));
  const avatarPath = `${uid}/${imageId}.jpg`;
  sql(`insert into storage.objects(bucket_id,name,owner_id,metadata) values ('profile-images','${avatarPath}','${uid}','{"mimetype":"image/jpeg","size":128}'::jsonb);`);
  const completed = await success(await signup(request("signup", "complete", token, { avatarPath, interests: ["산책"], conversationStyles: ["편한 대화"], mbti: "INFJ" })));
  check(completed.status === "ready" && completed.avatarPath === avatarPath);
  check((await success(await signup(request("signup", "state", token)))).status === "ready");
  check((await success(await service(request("service-api", "me/traits", token)))).mbti === "INFJ");
  await success(await service(request("service-api", "me/traits", token, { interests: ["공연"], conversationStyles: [], mbti: null })));
  check((await success(await service(request("service-api", "me/traits", token)))).interests[0] === "공연");
  await success(await service(request("service-api", "me", token)));

  stage = "same_account_refresh";
  const second = await login();
  check(second.result.userId === uid && second.result.status === "ready");
  const secondSession = row(second.result.session);
  const refreshResponse = await auth("token?grant_type=refresh_token", cfg.ANON_KEY, { refresh_token: secondSession.refreshToken });
  check(refreshResponse.status === 200);
  const refreshed = row(await refreshResponse.json());
  check(jwtSession(refreshed.access_token) === jwtSession(secondSession.accessToken));
  check((await success(await signup(request("signup", "state", refreshed.access_token)))).status === "ready");

  const postBody = () => ({ postId: crypto.randomUUID(), title: "합성 로컬 공고", description: "실제 서비스 자료가 아닌 전용 로컬 검증", category: "산책",
    startsAt: new Date(Date.now() + 86400000).toISOString(), endsAt: new Date(Date.now() + 90000000).toISOString(), recruitmentEndsAt: new Date(Date.now() + 3600000).toISOString(),
    publicArea: "서울특별시 강남구 역삼동", registeredPlaceName: "가상 장소", registeredAddress: "서울특별시 강남구 가상주소", meetingDetail: "가상 입구", preferenceNote: null, tags: [], costType: "free", amount: 0 });
  stage = "qualified_new_activity";
  await success(await service(request("service-api", "posts", refreshed.access_token, postBody())));

  stage = "password_session_bypass_denied";
  const password = `Synthetic-only-${crypto.randomUUID()}!`;
  const passwordUpdate = await auth("user", refreshed.access_token, { password }, "PUT");
  check(passwordUpdate.status === 200);
  const passwordGrant = await auth("token?grant_type=password", cfg.ANON_KEY, { email: user.email, password });
  check(passwordGrant.status === 200);
  const bypass = row(await passwordGrant.json());
  check(jwtSession(bypass.access_token) !== jwtSession(refreshed.access_token));
  await failure(await signup(request("signup", "state", bypass.access_token)), 401, "AUTH_REQUIRED");
  await failure(await service(request("service-api", "posts", bypass.access_token, postBody())), 401, "AUTH_REQUIRED");

  stage = "existing_missing_information_restricted";
  profile = { ...profile, name: undefined };
  const restricted = await login();
  check(restricted.result.status === "information_required" && restricted.result.userId === uid && restricted.result.session !== null);
  const restrictedToken = row(restricted.result.session).accessToken;
  check((await success(await signup(request("signup", "state", restrictedToken)))).status === "information_required");
  await success(await service(request("service-api", "me", restrictedToken)));
  await failure(await service(request("service-api", "posts", restrictedToken, postBody())), 403, "ACCESS_DENIED");
  await failure(await signup(request("signup", "complete", restrictedToken, { avatarPath })), 403, "ACCESS_DENIED");

  stage = "new_ineligible_no_auth_account";
  profile = { id: `synthetic-local-${crypto.randomUUID()}`, name: "가상검증미대상", gender: "M", birthyear: "2000", birthday: "01-01" };
  const ineligible = await login();
  check(ineligible.result.status === "ineligible" && ineligible.result.userId === null && ineligible.result.session === null);
  check(uuid(uid));
  // 원문 주제는 SQL로 전달하지 않는다. 총 Auth 계정 수/예약 수로 신규 미대상 생성 금지를 확인한다.
  check(sql("select count(*) from auth.users;") === "1");
  check(sql("select count(*) from private.naver_accounts;") === "1");
  check(syntheticCalls === 8);
  stage = "complete";
  process.stdout.write(JSON.stringify({ status: "PASS", checks, realAuth: true, realDatabase: true, naver: "synthetic", imageUpload: "NOT_RUN" }) + "\n");
}

try { await run(); }
catch { process.stderr.write(JSON.stringify({ status: "FAIL", stage, checks, ...(diagnostic ?? {}) }) + "\n"); process.exitCode = 1; }
finally { globalThis.fetch = nativeFetch; }
