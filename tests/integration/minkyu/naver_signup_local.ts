/** 민규: 전용 임시 로컬 Auth·PostgREST·SQL 실제 검증. 네이버만 가상 응답이다.
 * Node 실행: YUMIDANG_NAVER_LOCAL_CONFIG=/private/tmp/.../status.json node 이파일
 * 이 스크립트는 전용 환경에만 합성 계정·사진 객체 메타데이터·공고를 만든다.
 * 기본 legacy 모드는 사진 객체 metadata만 사용하며 실제 이미지 업로드를 포함하지 않는다.
 * 명시 native60/native62/native63/native64/native65/native67/native68 모드는 실제 Auth·Storage 업로드·회원 HTTP·사진/성향 관리 검증을 수행한다.
 * 각 모드의 네이버 응답은 합성이며 실제 네이버 인증·hosted Edge 배포 검증을 포함하지 않는다.
 * 환경 생성/마이그레이션 적용/stop --no-backup 정리는 총괄이 수행한다.
 */
import { readFileSync, lstatSync, realpathSync, mkdtempSync, writeFileSync, existsSync, unlinkSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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

const native68Reviewed = { manifestPath: "/private/tmp/yumidang-policy68-reviewed/prepared/migration-manifest.json", sha256: "78fcb141e81e0bbcd16e24220c1fce9525f824f4f7bfdb232f68d8082f3fd7a2", edgeSha256: "fbc72f92fc3718b442c55514473825f139eb43c64fdf0a78e9680a6bcd9640d8" }; // 실제 실행은 root의 별도 명시 승인이 필요하다.
const native67Reviewed = { manifestPath: "/private/tmp/yumidang-policy67-final-reviewed/prepared/migration-manifest.json", sha256: "1c56f6353a229bdae16fbb3c4d1106e8d45aec5a9cc9981311ec38b470cb7431", edgeSha256: "9576fa79c91f8645e9064359c8c5c27958dee500c497df081b371e4a043acf9e" }; // 검토 준비본과 실제 적용 증거는 별개이며 실행 승인은 root만 한다.
const native65Reviewed = { manifestPath: "/private/tmp/yumidang-policy65-reviewed-e0hpsl74/prepared/migration-manifest.json", sha256: "2303e3ae6507bfad1859d012ae16b96814563a5ceb2001c44591d116515e5ee6", edgeSha256: "003deb8f7931a9d9c2cd6f9afdaf20a242fdd39a90b50d227cde965248a5650d" }; // 고정 검토 artifact. 실제 실행 NOT_RUN이며 별도 승인이 필요하다.
const native64Reviewed: { manifestPath: string; sha256: string } = { manifestPath: "/private/tmp/yumidang-policy64-reviewed-f_r3zcwp/prepared/migration-manifest.json", sha256: "aa180018d6b5139e1cd378cd9fbec62d3bd2272f75d072b56b06028ecea23085" }; // 검토 artifact를 고정하며 실제 실행 승인은 별도다.
const native63Reviewed = { manifestPath: "/private/tmp/yumidang-policy63-reviewed-khq_kxpq/prepared/migration-manifest.json", sha256: "53c58346cab037e08eb4c6e2842f76b3818700e5ca7bf4c8afb3d45cb5281e68" };

try { if (["--native60-approved", "--native62-approved", "--native63-approved", "--native64-approved", "--native65-approved", "--native67-approved", "--native68-approved"].includes(process.argv[2])) await runNative60Qualification(process.argv[2] !== "--native60-approved", ["--native63-approved", "--native64-approved", "--native65-approved", "--native67-approved", "--native68-approved"].includes(process.argv[2]), ["--native64-approved", "--native65-approved", "--native67-approved", "--native68-approved"].includes(process.argv[2]), ["--native65-approved", "--native67-approved", "--native68-approved"].includes(process.argv[2]), ["--native67-approved", "--native68-approved"].includes(process.argv[2]), process.argv[2] === "--native68-approved"); else await run(); }
catch { process.stderr.write(JSON.stringify({ status: "FAIL", stage, checks, ...(diagnostic ?? {}) }) + "\n"); process.exitCode = 1; }
finally { globalThis.fetch = nativeFetch; }

/** 명시 native60/native62/native63/native64/native65/native67/native68 옵션으로 실행하는 자격 변경·사진·성향 검증. 네이버 응답은 합성이며 hosted/OAuth 증거가 아니다. */
// root가 전달한 native63 검토 manifest를 정확 경로·고정 SHA로 검사한다. 실행 승인은 별도다.
async function runNative60Qualification(native62 = false, native63 = false, native64 = false, native65 = false, native67 = false, native68 = false) {
  if (native68) check(native68Reviewed.manifestPath.startsWith("/private/tmp/") && /^[a-f0-9]{64}$/.test(native68Reviewed.sha256) && /^[a-f0-9]{64}$/.test(native68Reviewed.edgeSha256));
  if (native67) check(native67Reviewed.manifestPath.startsWith("/private/tmp/") && /^[a-f0-9]{64}$/.test(native67Reviewed.sha256) && /^[a-f0-9]{64}$/.test(native67Reviewed.edgeSha256));
  if (native65) check(native65Reviewed.manifestPath.startsWith("/private/tmp/") && /^[a-f0-9]{64}$/.test(native65Reviewed.sha256) && /^[a-f0-9]{64}$/.test(native65Reviewed.edgeSha256));
  if (native64) check(native64Reviewed.manifestPath.startsWith("/private/tmp/") && /^[a-f0-9]{64}$/.test(native64Reviewed.sha256));
  if (native63) check(native63Reviewed.manifestPath.startsWith("/private/tmp/") && /^[a-f0-9]{64}$/.test(native63Reviewed.sha256));
  const count = native68 ? 68 : native67 ? 67 : native65 ? 65 : native64 ? 64 : native63 ? 63 : native62 ? 62 : 60;
  const source = "/Users/minkyu/Documents/GitHub/yumidang/.worktrees/minkyu-foundation";
  const statusPath = "/private/tmp/yumidang-drift-catalog-44g9wt_e/current52-local-status.json";
  const manifestPath = native68 ? native68Reviewed.manifestPath : native67 ? native67Reviewed.manifestPath : native65 ? native65Reviewed.manifestPath : native64 ? native64Reviewed.manifestPath : native63 ? native63Reviewed.manifestPath : native62 ? "/private/tmp/yumidang-policy62-reviewed-omlrmcgb/prepared/migration-manifest.json" : "/private/tmp/yumidang-policy60-reviewed-xze3cqci/prepared/migration-manifest.json";
  check(process.argv[3] === statusPath && process.argv[4] === manifestPath && process.argv[5] === undefined);
  const api = "http://127.0.0.1:56531", host = "unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock";
  const container = "supabase_db_yumidang-minkyu-drift", localOrigin = "http://127.0.0.1:5173";
  const uuidValue = (value: unknown): string => { check(typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)); return value as string; };
  const data = (value: unknown): Record<string, unknown> => { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; };
  const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
  const sql = (query: string): string => execFileSync("docker", ["--host", host, "exec", "-i", container, "psql", "-XqAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"], {
    input: query, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000, maxBuffer: 1048576 }).trim();
  const files = () => { const output = execFileSync("docker", ["--host", host, "exec", "supabase_storage_yumidang-minkyu-drift", "find", "/var/lib/storage", "-type", "f"], { encoding:"utf8", stdio:["pipe","pipe","pipe"], timeout:10000 }).trim(); return output ? output.split("\n").length : 0; };
  const privateFile = (filename: string, fileMode = 0o600) => {
    for (const [path, mode, directory] of [[dirname(filename), 0o700, true], [filename, fileMode, false]] as const) {
      const st = lstatSync(path); check(!st.isSymbolicLink() && st.uid === process.getuid?.() && realpathSync(path) === path && (st.mode & 0o777) === mode);
      check(directory ? st.isDirectory() : st.isFile() && st.nlink === 1 && st.size <= 1048576);
    }
    return readFileSync(filename);
  };
  // 환경값은 실행 승인 후 메모리로만 읽는다. 후보 준비/typecheck는 이 함수 실행이 아니다.
  const settings = data(JSON.parse(privateFile(statusPath).toString()));
  check(settings.API_URL === api && typeof settings.ANON_KEY === "string" && settings.ANON_KEY.length >= 32 && typeof settings.SERVICE_ROLE_KEY === "string" && settings.SERVICE_ROLE_KEY.length >= 32 && settings.ANON_KEY !== settings.SERVICE_ROLE_KEY);
  const anon = settings.ANON_KEY as string, serviceKey = settings.SERVICE_ROLE_KEY as string;
  const manifestBytes = privateFile(manifestPath, 0o644), manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  check(manifestHash === (native68 ? native68Reviewed.sha256 : native67 ? native67Reviewed.sha256 : native65 ? native65Reviewed.sha256 : native64 ? native64Reviewed.sha256 : native63 ? native63Reviewed.sha256 : native62 ? "abbfcac0065c6be95aaec61df99876f3d527fe4675d1e14802b31c719696feb3" : "129cb1f10baf7ca4a225d3e7c7f7de34928de25d1ced9d1a282b7af9ad0e685a"));
  const manifest = data(JSON.parse(manifestBytes.toString()));
  check(manifest.status === "READY" && manifest.mode === "current_policy_gateway" && manifest.count === count && manifest.sql_execution === "NOT_RUN");
  if (native64) check(manifest.edge_execution === "NOT_RUN");
  check(Array.isArray(manifest.migrations) && manifest.migrations.length === count);
  const versions = (manifest.migrations as unknown[]).map(value => {
    const entry = data(value); check(typeof entry.path === "string" && /^backend\/supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/.test(entry.path));
    check(typeof entry.version === "string" && /^\d{14}$/.test(entry.version) && (entry.path as string).split("/").at(-1)?.startsWith(entry.version + "_"));
    const path = join(source, entry.path as string); check(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    check(createHash("sha256").update(readFileSync(path)).digest("hex") === entry.sha256);
    if (native67) { const preparedPath=join(dirname(manifestPath),"supabase/migrations",(entry.path as string).split("/").at(-1)!);check(lstatSync(preparedPath).isFile() && !lstatSync(preparedPath).isSymbolicLink() && createHash("sha256").update(readFileSync(preparedPath)).digest("hex")===entry.sha256); }
    return entry.version as string;
  }).sort();
  check(new Set(versions).size === count && versions.at(-1) === (native68 ? "20261005135215" : native67 ? "20261005041000" : native65 ? "20261005040800" : native64 ? "20261005040700" : native63 ? "20261005040600" : native62 ? "20261005040500" : "20261005040100"));
  if (native68) {check(versions.at(-2)==="20261005041000" && versions.at(-3)==="20261005040900");check((manifest.migrations as unknown[]).some(value=>{const entry=data(value);return entry.version==="20261005135215" && entry.sha256==="c6dfa91e15bf8b97c1878b53ec62d887e18061fa5704aeee8f946a5ea5cc3b8c";}));}
  if (native67) {
    check(JSON.stringify(versions.slice(native68 ? -8 : -7,native68 ? -1 : undefined)) === JSON.stringify(["20261005040300","20261005040500","20261005040600","20261005040700","20261005040800","20261005040900","20261005041000"]));
    for (const [version, hash] of [["20261005040800","afc727a109454d430ab2b39b7d8000c2f7f49638c4351200454827c8a2c1ab80"],["20261005040900","b13e5ade5891e49b049a7243ba3cbe161d8e64545212bc72d8865638a6992fe6"],["20261005041000","b780d364f0d614a160934bd57bb2c1347f24d6a9321275baadbbaf632db3ed50"]]) check((manifest.migrations as unknown[]).some(value => { const entry=data(value);return entry.version===version && entry.sha256===hash; }));
  }
  else if (native65) { check(versions.at(-2) === "20261005040700"); check(versions.at(-3) === "20261005040600"); check(versions.at(-4) === "20261005040500"); check(versions.at(-5) === "20261005040300");
    check((manifest.migrations as unknown[]).some(value => { const entry=data(value);return entry.version==="20261005040800" && entry.sha256==="afc727a109454d430ab2b39b7d8000c2f7f49638c4351200454827c8a2c1ab80"; }));
  }
  else if (native64) { check(versions.at(-2) === "20261005040600"); check(versions.at(-3) === "20261005040500"); check(versions.at(-4) === "20261005040300"); }
  else if (native63) { check(versions.at(-2) === "20261005040500"); check(versions.at(-3) === "20261005040300"); }
  else if (native62) check(versions.at(-2) === "20261005040300");
  if (native64) {
    const edgePath=join(dirname(manifestPath),"edge-manifest.json"), edgeBytes=privateFile(edgePath,0o644);
    check(createHash("sha256").update(edgeBytes).digest("hex")===(native68 ? native68Reviewed.edgeSha256 : native67 ? native67Reviewed.edgeSha256 : native65 ? native65Reviewed.edgeSha256 : "7b2fe68680f5b63825291e56c21188e47139bbafd878ead6577ad0a4bebc114f"));
    const reviewedEdge=data(JSON.parse(edgeBytes.toString()));check(reviewedEdge.status==="READY" && reviewedEdge.migration_count===count && Array.isArray(reviewedEdge.source_files) && reviewedEdge.source_files.length===49);
    for (const value of reviewedEdge.source_files as unknown[]) {
      const file=data(value);check(typeof file.path==="string" && (/^backend\/supabase\/functions\/[a-zA-Z0-9_./-]+\.ts$/.test(file.path) || file.path === "backend/supabase/functions/deno.json") && !file.path.split("/").includes("..") && file.target===file.path.slice("backend/".length));
      const mainPath=join(source,file.path as string), artifactPath=join(dirname(manifestPath),file.target as string);
      for (const filename of [mainPath,artifactPath]) check(lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink() && createHash("sha256").update(readFileSync(filename)).digest("hex")===file.sha256);
    }
  }
  const artifact = mkdtempSync(join(tmpdir(), native68 ? "yumidang-naver-native68-" : native67 ? "yumidang-naver-native67-" : native65 ? "yumidang-naver-native65-" : native64 ? "yumidang-naver-native64-" : native63 ? "yumidang-naver-native63-" : native62 ? "yumidang-naver-native62-" : "yumidang-naver-native60-"));
  const results: string[] = [], report: Record<string, unknown> = { scope: `native${count}_in_process_http_actual_auth_rest_storage`, externalNaver: false, hostedEdge: false, manifestHash, results };
  const proof = (name: string) => results.push(name);
  const signatures = ["claim_member_cleanup_task(uuid)", "check_member_cleanup_task(uuid,uuid,uuid,uuid)", "get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)", "record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)", "complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)", "read_worker_run_budget(uuid)", "read_worker_queue_schedule(text[],text)", "acquire_worker_run(integer,uuid)", "release_worker_run(uuid)"];
  // native60에는 40300이 미적용이다. 전역 점유·해제 service 권한 2개만 기존 true다.
  // native60/native62 모두 기존 service 점유·해제 2개 true와 나머지 25개 false를 검사한다.
  const assertExpectedAcl = () => {
    check(signatures.length === 9);
    let allowed = 0, denied = 0;
    for (const signature of signatures) for (const role of ["anon", "authenticated", "service_role"]) {
      const expected = role === "service_role" && ["acquire_worker_run(integer,uuid)", "release_worker_run(uuid)"].includes(signature);
      check(sql(`select has_function_privilege(${literal(role)},${literal("public."+signature)},'EXECUTE');`) === (expected ? "t" : "f"));
      if (expected) allowed++; else denied++;
    }
    check(allowed === 2 && denied === 25);
    if (native62) {
      check(sql("select count(*) from pg_roles where rolname='yumidang_worker_queue' and not rolcanlogin and not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls and rolconnlimit=-1 and rolvaliduntil is null;") === "1");
      for (const signature of signatures) {
        const expected = ["read_worker_queue_schedule(text[],text)","acquire_worker_run(integer,uuid)","release_worker_run(uuid)"].includes(signature);
        check(sql(`select has_function_privilege('yumidang_worker_queue',${literal("public."+signature)},'EXECUTE');`) === (expected ? "t" : "f"));
      }
      check(sql("select has_function_privilege('yumidang_worker_queue','public.set_my_profile_preferences(text[],text[],text,text)','EXECUTE');") === "f");
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        const privilege = role === "public" ? "exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid='public.set_my_profile_preferences(text[],text[],text,text)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE')" : `has_function_privilege(${literal(role)},'public.set_my_profile_preferences(text[],text[],text,text)','EXECUTE')`;
        check(sql(`select ${privilege};`) === (role === "authenticated" ? "t" : "f"));
      }
      check(sql("select has_column_privilege('authenticated','public.profiles','bio','UPDATE');") === "f");
    }
    if (native63) {
      const signature = "public.withdraw_appointment_schedule_change(uuid,uuid,text)";
      for (const role of ["anon", "authenticated", "service_role", "yumidang_worker_queue"]) {
        check(sql(`select has_function_privilege(${literal(role)},${literal(signature)},'EXECUTE');`) === (role === "authenticated" ? "t" : "f"));
      }
      check(sql(`select exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=${literal(signature)}::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');`) === "f");
    }
  };
  const assertSafetyAcl = () => {
    for (const role of ["anon","authenticated","service_role","yumidang_worker_queue"]) check(sql(`select has_function_privilege(${literal(role)},'public.get_my_safety_state()','EXECUTE');`) === (role === "authenticated" ? "t" : "f"));
    check(sql("select exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid='public.get_my_safety_state()'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');") === "f");
  };
  const assertCompletionAcl = () => {
    for (const signature of ["confirm_appointment_completion(uuid)","get_appointment_review_state(uuid)","submit_appointment_review(uuid,integer,text,text,text[])"]) {
      check(sql(`select has_function_privilege('authenticated',${literal('public.'+signature)},'EXECUTE');`) === "t");
      check(sql(`select has_function_privilege('anon',${literal('public.'+signature)},'EXECUTE');`) === "f");
    }
    for (const signature of ["appointment_review_held(uuid)","enter_appointment_review(uuid,uuid)","resolve_appointment_review(uuid,uuid,bigint,uuid,text)","resume_appointment_review_if_clear(uuid)","sync_appointment_review_terminal_state(uuid)"]) for (const role of ["anon","authenticated","service_role","yumidang_worker_queue"]) check(sql(`select has_function_privilege(${literal(role)},${literal('private.'+signature)},'EXECUTE');`) === "f");
  };
  const assertSanctionHistoryAcl = () => {
    for (const role of ["anon","authenticated","service_role","yumidang_worker_queue"]) check(sql(`select has_function_privilege(${literal(role)},'public.list_my_sanctions(integer,uuid)','EXECUTE');`) === (role === "authenticated" ? "t" : "f"));
    check(sql("select exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid='public.list_my_sanctions(integer,uuid)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');") === "f");
  };
  const syncAudit = () => sql("select coalesce(jsonb_agg(to_jsonb(a) order by migration_version),'[]') from private.appointment_safety_sync_audit a;");
  let baselineSyncAudit = "";
  const configState = () => sql(`select jsonb_build_object('guard',(select external_deletion_approved from private.member_cleanup_guard where singleton),'roles',(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,md5(coalesce(rolconfig::text,''))) order by rolname) from pg_roles),'memberships',(select coalesce(jsonb_agg(jsonb_build_array(r.rolname,m.rolname,g.rolname,a.admin_option,a.inherit_option,a.set_option) order by r.rolname,m.rolname,g.rolname),'[]') from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor),'acls',(select jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,coalesce(p.proacl::text,'')) order by p.oid::regprocedure::text) from pg_proc p where p.oid in(${[...signatures,...(native62 ? ["set_my_profile_preferences(text[],text[],text,text)"] : []),...(native63 ? ["withdraw_appointment_schedule_change(uuid,uuid,text)"] : []), ...(native64 ? ["get_my_safety_state()"] : [])].map(s => literal('public.'+s)+'::regprocedure').join(',')})),'globalIdle',(select (token is null and expires_at is null) from private.global_worker_run where singleton));`);
  const emptyRelations = ["auth.users", "storage.objects", "public.profiles", "public.posts", "public.join_requests", "public.appointments", "private.naver_accounts", "private.naver_sessions", "private.naver_login_challenges", "private.member_episodes", "private.naver_identity_keys", "private.member_reports", "private.report_capture_assets", "private.match_consents", "private.member_retirements", "private.member_cleanup_tasks", "private.member_cleanup_delete_acks", "private.report_access_audit", "private.member_report_details", "private.match_consent_lifecycle", "private.appointment_cancellations", "private.appointment_schedule_changes", "private.completion_reservations", "private.appointment_member_episodes", "private.sweetness_review_contributions", "private.sweetness_incident_decisions", "private.sweetness_incidents", "private.profile_traits", "public.chat_messages", "public.notifications", ...(native67 ? ["public.appointment_completion_confirmations","public.appointment_reviews","private.review_publication","private.appointment_review_holds","private.appointment_review_windows","private.appointment_review_normal_completions"] : []), ...(native64 ? ["private.safety_incidents","private.safety_incident_report_links","private.safety_incident_revisions","private.safety_incident_subjects","private.safety_sanction_applications","private.safety_appointment_results","private.safety_appointment_result_revisions","private.safety_appeals"] : [])];
  const empty = () => { for (const relation of emptyRelations) check(sql(`select count(*) from ${relation};`) === "0"); };
  const allCounts = () => {
    const relations=JSON.parse(sql("select jsonb_agg(format('%I.%I',n.nspname,c.relname) order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage') and c.relkind='r';")) as string[];
    return sql("select jsonb_object_agg(name,n) from ("+relations.map(name=>"select "+literal(name)+" as name,count(*) as n from "+name).join(" union all ")+")counts;");
  };
  const fullCatalog = () => sql(`select jsonb_build_object(
    'functions',(select jsonb_agg(jsonb_build_array(p.oid,p.oid::regprocedure::text,p.proowner,p.proacl::text,p.proconfig::text,p.prosecdef,case when p.prokind in('f','p')then md5(pg_get_functiondef(p.oid))else null end) order by p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth','storage')),
    'constraints',(select jsonb_agg(jsonb_build_array(c.oid,c.conrelid,pg_get_constraintdef(c.oid),c.convalidated) order by c.oid) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in('public','private','auth','storage')),
    'tables',(select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity) order by c.oid) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
    'columns',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attacl::text) order by a.attrelid,a.attnum) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage') and a.attnum>0 and not a.attisdropped),
    'triggers',(select jsonb_agg(jsonb_build_array(t.oid,t.tgrelid,t.tgfoid,t.tgenabled,pg_get_triggerdef(t.oid)) order by t.oid) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
    'indexes',(select jsonb_agg(jsonb_build_array(i.indexrelid,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready) order by i.indexrelid) from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')));
  `);
  let baselineAllCounts="", baselineFullCatalog="", auditBaselineCaptured=false;
  const auditBaselineIds:string[]=[], fixtureAuditIds:string[]=[], fixtureAliases:string[]=[], fixtureUserIds:string[]=[];
  const fixturePostIds: string[] = [], fixtureAppointmentIds: string[] = [];
  const subjects: string[] = [], tokens = new Map<string, string>(), photos: string[] = [], challenges: string[] = [];
  const safetyRows: Array<{ id: string; incident: string; decision: string; owner: string; kind: string; expired: boolean; revoked: boolean }> = [];
  const persistRecovery = () => {
    const path=join(artifact,"fixture-recovery.json"), pending=path+".pending";
    writeFileSync(pending,JSON.stringify({subjects,userIds:Array.from(tokens.keys()),photos,challengeHashes:challenges,...(native65 ? {postIds:fixturePostIds,appointmentIds:fixtureAppointmentIds} : {}),safetyIds:safetyRows.map(({id,incident,decision,owner}) => ({id,incident,decision,owner})),...(native68?{fixtureAliases,fixtureUserIds,fixtureAuditIds,auditBaselineIds,auditBaselineCaptured}: {})}),{mode:0o600});
    const fd=openSync(pending,"r");try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(pending,path);const directory=openSync(artifact,"r");try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  let baseline = "", guarded = false, failed = false;
  const transport = globalThis.fetch;
  const http = async (path: string, token: string, method = "GET", body?: unknown, binary = false) => transport(api + path, {
    method, redirect: "error", signal: AbortSignal.timeout(15000), headers: { apikey: token === serviceKey ? serviceKey : anon, Authorization: `Bearer ${token}`, "Content-Type": binary ? "image/jpeg" : "application/json", "x-upsert": "false" },
    ...(body === undefined ? {} : { body: binary ? body as ArrayBuffer : JSON.stringify(body) }) });
  const publicCodes = new Set(["AUTH_REQUIRED", "ACCESS_DENIED", "RESOURCE_NOT_FOUND", "INVALID_REQUEST", "STATE_CONFLICT", "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "METHOD_NOT_ALLOWED"]);
  const recordHttpError = (response: Response, value: unknown) => {
    report.lastHttpStatus = response.status;
    const envelope = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const error = envelope.error !== null && typeof envelope.error === "object" && !Array.isArray(envelope.error) ? envelope.error as Record<string, unknown> : {};
    report.lastPublicCode = typeof error.code === "string" && publicCodes.has(error.code) ? error.code : "UNEXPECTED_RESPONSE";
  };
  const parse = async (response: Response): Promise<Record<string, unknown>> => {
    if (!response.ok) { let value: unknown; try { value = await response.json(); } catch { value = null; } recordHttpError(response,value); throw new Error("NATIVE60_HTTP_FAILED"); }
    return data(await response.json());
  };
  try {
    stage = `native${count}_preflight`;
    const inspected = JSON.parse(execFileSync("docker", ["--host", host, "inspect", container], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }));
    check(inspected.length === 1 && inspected[0].Name === "/" + container && inspected[0].State.Running && inspected[0].Config.Labels["com.supabase.cli.project"] === "yumidang-minkyu-drift");
    check(inspected[0].HostConfig.PortBindings["5432/tcp"].some((port: { HostPort: string }) => port.HostPort === "56532"));
    check(JSON.stringify(JSON.parse(sql("select coalesce(jsonb_agg(version order by version),'[]') from supabase_migrations.schema_migrations;"))) === JSON.stringify(versions));
    baseline = configState(); const state = data(JSON.parse(baseline)); check(state.guard === false && state.globalIdle === true);
    assertExpectedAcl();
    if (native64) assertSafetyAcl();
    if (native67) assertCompletionAcl();
    if (native68) assertSanctionHistoryAcl();
    if (native65) { baselineSyncAudit=syncAudit(); check(sql("select count(*)=1 and bool_and(migration_version='20261005040800') from private.appointment_safety_sync_audit;")==="t"); }
    empty(); check(files() === 0);
    if(native68) {
      baselineAllCounts=allCounts();baselineFullCatalog=fullCatalog();report.native68BaselineVerification={authAuditCount:288,allRelationCountsSha256:createHash("sha256").update(baselineAllCounts).digest("hex"),fullCatalogSha256:createHash("sha256").update(baselineFullCatalog).digest("hex")};
      check(data(JSON.parse(baselineAllCounts))["auth.audit_log_entries"]===288);
      const ids=JSON.parse(sql("select coalesce(jsonb_agg(id::text order by id),'[]') from auth.audit_log_entries;"));check(Array.isArray(ids) && ids.length===288);auditBaselineIds.push(...ids);auditBaselineCaptured=true;persistRecovery();
    }
    guarded = true; proof(`baseline${count}_empty_guard_false_exact_acl_matrix`);
    // 최신 main의 동일 모듈 그래프를 사용한다.
    const { createSignupRuntimeHandler: signupFactory } = await import(pathToFileURL(join(source, "backend/supabase/functions/signup/index.ts")).href);
    const { createRuntimeHandler: serviceFactory } = await import(pathToFileURL(join(source, "backend/supabase/functions/service-api/index.ts")).href);
    const { sha256: hash } = await import(pathToFileURL(join(source, "backend/supabase/functions/_shared/services/signup-service.ts")).href);
    report.sourceHashes = Object.fromEntries(["backend/supabase/functions/signup/index.ts", "backend/supabase/functions/_shared/services/signup-service.ts", "backend/supabase/functions/service-api/index.ts", "backend/supabase/functions/service-api/routes.ts", ...(native62 ? ["backend/supabase/functions/_shared/contracts/signup.ts", "backend/supabase/functions/_shared/db/repositories/profiles.ts", "backend/supabase/functions/_shared/db/user-client.ts"] : []), ...(native63 ? ["backend/supabase/functions/_shared/db/repositories/completion.ts", "backend/supabase/functions/_shared/services/completion-service.ts"] : []), ...(native67 ? ["backend/supabase/functions/_shared/db/repositories/reviews.ts","backend/supabase/functions/_shared/services/review-service.ts"] : []), ...(native64 ? ["backend/supabase/functions/_shared/db/repositories/reports.ts", "backend/supabase/functions/_shared/services/report-service.ts"] : [])].map(path => [path, createHash("sha256").update(readFileSync(join(source,path))).digest("hex")]));
    let providerProfile: Record<string, unknown> = {};
    const guardedFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://nid.naver.com/oauth2.0/token") { check(init?.method === "POST" && init.redirect === "error"); return new Response(JSON.stringify({ access_token: "synthetic-native60-access", token_type: "bearer" })); }
      if (url === "https://openapi.naver.com/v1/nid/me") { check(init?.method === "GET" && init.redirect === "error" && new Headers(init.headers).get("authorization") === "Bearer synthetic-native60-access"); return new Response(JSON.stringify({ resultcode: "00", response: providerProfile })); }
      check(new URL(url).origin === api);
      if(native68 && new URL(url).pathname.startsWith("/auth/v1/") && (init?.method ?? (input instanceof Request?input.method:"GET"))==="POST") {
        const body=typeof init?.body==="string"?init.body:input instanceof Request?await input.clone().text():null;
        if(body) { const payload=data(JSON.parse(body));if(typeof payload.email==="string") {
          check(/^[a-f0-9-]+@naver\.yumidang\.invalid$/.test(payload.email));
          check(subjects.length>0 && sql(`select exists(select 1 from private.naver_accounts where subject in(${subjects.map(literal).join(",")}) and auth_email=${literal(payload.email)});`)==="t");
          if(!fixtureAliases.includes(payload.email))fixtureAliases.push(payload.email);persistRecovery();
        } }
      }
      return transport(input, { ...init, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(15000) });
    };
    globalThis.fetch = guardedFetch;
    const env: Record<string,string> = { SUPABASE_URL: api, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: serviceKey, ALLOWED_ORIGINS: JSON.stringify([localOrigin]), MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "10000", NAVER_CLIENT_ID: "synthetic-local-client", NAVER_CLIENT_SECRET: "synthetic-local-secret", NAVER_REDIRECT_URI: localOrigin+"/auth/naver/callback", NAVER_STATE_TTL_SECONDS: "600" };
    const signup = signupFactory((name: string) => env[name], guardedFetch), service = serviceFactory((name: string) => env[name]);
    const request = (ns: string, path: string, token?: string, body?: unknown) => new Request(api+"/functions/v1/"+ns+path, { method: body === undefined ? "GET" : "POST", headers: { origin: localOrigin, ...(token ? { authorization: "Bearer "+token } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const success = async (response: Response) => data((await parse(response)).data);
    const operation = (path: string): string => {
      if (path === "/me") return "member_profile_get";
      if (native68 && path.split("?")[0] === "/me/sanctions") return "member_sanction_history";
      if (native64 && path === "/me/safety") return "member_safety_get";
      if (path === "/posts") return "post_create";
      if (path === "/me/traits") return "member_traits";
      if (native62 && path === "/me/preferences") return "member_preferences";
      if (path === "/me/avatar") return "member_avatar_swap";
      if (path === "/reports") return "support_report_submit";
      if (path === "/me/reports") return "support_reports_list";
      if (/^\/posts\/[^/]+\/requests$/.test(path)) return "matching_request_post";
      if (/^\/requests\/[^/]+\/propose$/.test(path)) return "matching_propose";
      if (/^\/requests\/[^/]+\/accept$/.test(path)) return "matching_accept";
      if (/^\/requests\/[^/]+\/consent$/.test(path)) return "matching_consent_get";
      if (native63 && /^\/appointments\/[^/]+\/schedule-change$/.test(path)) return "appointment_change_get";
      if (native63 && /^\/appointments\/[^/]+\/schedule-change\/(propose|withdraw|accept)$/.test(path)) return "appointment_change_"+path.split("/").at(-1);
      if (/^\/appointments\/[^/]+\/cancel$/.test(path)) return "existing_appointment_cancel";
      if (native67 && /^\/appointments\/[^/]+\/(confirm-completion|reviews)$/.test(path)) return path.endsWith("/reviews") ? "appointment_reviews" : "appointment_completion_confirm";
      if (/^\/appointments\/[^/]+$/.test(path)) return "existing_appointment_get";
      throw new Error("NATIVE60_OPERATION_NOT_ALLOWED");
    };
    const app = async (path: string, uid: string, body?: unknown) => { stage = operation(path); return success(await service(request("service-api", path, tokens.get(uid), body))); };
    const deny = async (path: string, uid: string, body: unknown) => { stage = operation(path)+"_expected_denial"; const response = await service(request("service-api",path,tokens.get(uid),body)); const value = data(await response.json()); if (response.status !== 403 || data(value.error).code !== "ACCESS_DENIED") recordHttpError(response,value); check(response.status === 403 && data(value.error).code === "ACCESS_DENIED"); check(!JSON.stringify(value).includes(uid)); };
    const login = async (subject: string, qualification: "qualified"|"missing"|"ineligible") => {
      providerProfile = { id: subject, ...(qualification === "missing" ? {} : { name: "합성검증회원" }), gender: qualification === "ineligible" ? "M" : "F", birthyear: "1990", birthday: "01-01" };
      const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
      stage = "signup_start";
      const start = await success(await signup(request("signup","/naver/start",undefined,{ codeChallenge: await hash(verifier), returnTo: "/" })));
      check(typeof start.authorizationUrl === "string"); const url = new URL(start.authorizationUrl as string); const state = url.searchParams.get("state"); check(state && /^[a-f0-9]{64}$/.test(state)); challenges.push(await hash(state)); if (native64) persistRecovery();
      stage = "signup_callback";
      const result = await success(await signup(request("signup","/naver/callback",undefined,{ code: "synthetic-native60-code", state, codeVerifier: verifier })));
      const uid = uuidValue(result.userId), session = data(result.session); check(typeof session.accessToken === "string"); tokens.set(uid,session.accessToken as string);if(native68 && !fixtureUserIds.includes(uid))fixtureUserIds.push(uid); if (native64) persistRecovery(); return { uid, result };
    };
    stage = "native60_signup";
    const jpegLine = readFileSync(join(source,"tests/integration/minkyu/member_cleanup_provider_local.ts"),"utf8").match(/const image = Buffer.from\("([A-Za-z0-9+/=]+)", "base64"\);/); check(jpegLine);
    const jpeg = Uint8Array.from(Buffer.from(jpegLine![1],"base64")).buffer;
    const member = async () => { const subject = "native60-qualification-"+randomUUID(); subjects.push(subject); if (native64) persistRecovery(); const person = await login(subject,"qualified"); check(person.result.status === "photo_required");
      const path = person.uid+"/"+randomUUID()+".jpg"; photos.push(path); if (native64) persistRecovery(); stage = "signup_storage_upload"; await parse(await http("/storage/v1/object/profile-images/"+path,tokens.get(person.uid)!,"POST",jpeg,true));
      stage = "signup_explicit_complete";
      const ready = await success(await signup(request("signup","/complete",tokens.get(person.uid),{ avatarPath:path, interests:[], conversationStyles:[], mbti:null }))); check(ready.status === "ready"); return { ...person, subject }; };
    const a = await member(), b = await member();
    // 실제 사진 관리 후보. 원본사진/UUID/bytes/hash를 결과에 기록하지 않고 비교 결과만 남긴다.
    stage = "photo_management_snapshot";
    const oldPhoto = photos[0], foreignPhoto = photos[1];
    check(oldPhoto.startsWith(a.uid+"/") && foreignPhoto.startsWith(b.uid+"/"));
    const snapshot = (path: string) => sql(`select jsonb_build_object('pointer',(select avatar_url from public.profiles where id=${literal(a.uid)}::uuid),'object',(select jsonb_build_object('id',id,'bucket',bucket_id,'name',name,'owner',owner_id,'metadata',metadata,'version',version) from storage.objects where bucket_id='profile-images' and name=${literal(path)}));`);
    const downloadHash = async (path: string) => { const response = await http("/storage/v1/object/authenticated/profile-images/"+path,tokens.get(a.uid)!); check(response.status === 200); return createHash("sha256").update(new Uint8Array(await response.arrayBuffer())).digest("hex"); };
    const previous = snapshot(oldPhoto), previousHash = await downloadHash(oldPhoto);
    const preserved = async () => { check(snapshot(oldPhoto) === previous); check(await downloadHash(oldPhoto) === previousHash); };
    const swapRejected = async (path: string, status: number, code: string) => {
      stage = "photo_swap_expected_denial";
      const response = await service(request("service-api","/me/avatar",tokens.get(a.uid),{avatarPath:path})); const result = data(await response.json());
      if (response.status !== status || data(result.error).code !== code) recordHttpError(response,result);
      check(response.status === status && data(result.error).code === code); await preserved();
    };
    await swapRejected(a.uid+"/"+randomUUID()+".jpg",400,"INVALID_REQUEST");
    // 타인 UUID prefix는 assert_owned_profile_image의 경로 검사22023에서 먼저 거절된다.
    await swapRejected(foreignPhoto,400,"INVALID_REQUEST");
    proof("photo_missing_foreign_swap_denied_pointer_metadata_bytes_preserved");
    const protectLastPhoto = async (path: string) => {
      stage = "photo_current_delete_expected_denial";
      const response = await http("/storage/v1/object/profile-images",tokens.get(a.uid)!,"DELETE",{prefixes:[path]}); const result = data(await response.json());
      // Storage v1.70.3: SQL42501→AccessDenied403→default user HTTP400.
      if (response.status !== 400 || result.code !== "AccessDenied" || result.statusCode !== "403") { report.lastHttpStatus = response.status; report.lastProviderCode = result.code === "AccessDenied" ? "AccessDenied" : "UNEXPECTED_RESPONSE"; }
      check(response.status === 400 && result.code === "AccessDenied" && result.statusCode === "403");
    };
    await protectLastPhoto(oldPhoto); await preserved();
    stage = "photo_clear_rpc_expected_denial";
    const clear = await http("/rest/v1/rpc/clear_my_profile_avatar",tokens.get(a.uid)!,"POST",{}); const clearResult = data(await clear.json());
    if (clear.status !== 403 || clearResult.code !== "42501") { report.lastHttpStatus = clear.status; report.lastSqlState = clearResult.code === "42501" ? "42501" : "UNEXPECTED_RESPONSE"; }
    check(clear.status === 403 && clearResult.code === "42501"); await preserved();
    proof("photo_current_delete_and_clear_rpc_denied_pointer_metadata_bytes_preserved");
    stage = "photo_replacement_upload";
    const newPhoto = a.uid+"/"+randomUUID()+".jpg"; photos.push(newPhoto); if (native64) persistRecovery();
    await parse(await http("/storage/v1/object/profile-images/"+newPhoto,tokens.get(a.uid)!,"POST",jpeg,true));
    stage = "photo_replacement_http_swap";
    const swapRows = (await parse(await service(request("service-api","/me/avatar",tokens.get(a.uid),{avatarPath:newPhoto})))).data;
    check(Array.isArray(swapRows) && swapRows.length === 1);
    const swapRow = data((swapRows as unknown[])[0]); check(Object.keys(swapRow).sort().join(',') === 'avatar_url,previous_avatar_path');
    check(swapRow.avatar_url === newPhoto && swapRow.previous_avatar_path === oldPhoto);
    check(sql(`select avatar_url from public.profiles where id=${literal(a.uid)}::uuid;`) === newPhoto);
    const currentSnapshot = snapshot(newPhoto), currentHash = await downloadHash(newPhoto);
    stage = "photo_previous_member_delete";
    const removed = await http("/storage/v1/object/profile-images",tokens.get(a.uid)!,"DELETE",{prefixes:[oldPhoto]}); check(removed.status === 200);
    const removedRows: unknown = await removed.json(); check(Array.isArray(removedRows) && removedRows.length === 1 && data(removedRows[0]).name === oldPhoto);
    check(sql(`select count(*) from storage.objects where bucket_id='profile-images' and name=${literal(oldPhoto)};`) === '0');
    // 정확한 canonical 이름만 조회하며 prefix 일괄 삭제를 사용하지 않는다.
    const remainingOldFiles = execFileSync("docker", ["--host",host,"exec","supabase_storage_yumidang-minkyu-drift","find","/var/lib/storage","-type","f","-path","*"+oldPhoto+"*"], {encoding:"utf8",stdio:["pipe","pipe","pipe"],timeout:10000}).trim(); check(remainingOldFiles === "");
    await protectLastPhoto(newPhoto); check(snapshot(newPhoto) === currentSnapshot && await downloadHash(newPhoto) === currentHash);
    report.photoPreservation = { failedSwapPointerMetadataBytes:true, lastPhotoPointerMetadataBytes:true, successfulSwap:true, exactOldObjectAndBackendAbsent:true, signedUrlRevocation:"NOT_ASSERTED" };
    proof("photo_actual_upload_single_row_swap_member_old_delete_final_photo_protected");

    // 서버 저장 원자성의 증거이며 실제 화면 입력 보존은 주장하지 않는다.
    const { parseProfileTraits } = await import(pathToFileURL(join(source,"backend/supabase/functions/_shared/contracts/signup.ts")).href);
    const selection = parseProfileTraits({interests:["산책"],conversationStyles:["차분한 대화"],mbti:"INFP"});
    stage = "traits_valid_save"; const savedTraits = parseProfileTraits(await app("/me/traits",a.uid,selection));
    check(JSON.stringify(savedTraits) === JSON.stringify(selection));
    check(JSON.stringify(parseProfileTraits(await app("/me/traits",a.uid))) === JSON.stringify(selection));
    const traitsSnapshot = sql(`select to_jsonb(t) from private.profile_traits t where profile_id=${literal(a.uid)}::uuid;`);
    for (const invalid of [{...selection,mbti:"XXXX"},{...selection,interests:["가".repeat(41)]}]) {
      stage = "traits_invalid_expected_denial";
      const response = await service(request("service-api","/me/traits",tokens.get(a.uid),invalid)); const result = data(await response.json());
      if (response.status !== 400 || data(result.error).code !== "INVALID_REQUEST") recordHttpError(response,result);
      check(response.status === 400 && data(result.error).code === "INVALID_REQUEST");
      check(sql(`select to_jsonb(t) from private.profile_traits t where profile_id=${literal(a.uid)}::uuid;`) === traitsSnapshot);
      check(JSON.stringify(parseProfileTraits(await app("/me/traits",a.uid))) === JSON.stringify(selection));
    }
    stage = "traits_explicit_retry"; check(JSON.stringify(parseProfileTraits(await app("/me/traits",a.uid,selection))) === JSON.stringify(selection));
    report.traitsVerification = { serverAtomicity:true, invalidPayloadPriorDatabaseValuesPreserved:true, explicitRetry:true, actualScreenInputPreservation:"NOT_ASSERTED" };
    proof("traits_actual_valid_save_invalid_payload_prior_db_preserved_explicit_retry");
    if (native62) {
      const { parseProfilePreferences } = await import(pathToFileURL(join(source,"backend/supabase/functions/_shared/contracts/signup.ts")).href);
      const preferencesSnapshot = () => sql(`select jsonb_build_object('bio',p.bio,'traits',to_jsonb(t)) from public.profiles p join private.profile_traits t on t.profile_id=p.id where p.id=${literal(a.uid)}::uuid;`);
      const verifyPreferences = async (input: Record<string, unknown>) => {
        check(JSON.stringify(parseProfilePreferences(await app("/me/preferences",a.uid,input))) === JSON.stringify(input));
        check((await app("/me",a.uid)).bio === input.bio);
        check(JSON.stringify(parseProfileTraits(await app("/me/traits",a.uid))) === JSON.stringify({interests:input.interests,conversationStyles:input.conversationStyles,mbti:input.mbti}));
      };
      for (const bio of [null,"","😀".repeat(300)]) await verifyPreferences({...selection,bio});
      const prior = preferencesSnapshot();
      for (const invalid of [{...selection,bio:"😀".repeat(301)},{...selection,mbti:"XXXX",bio:"잘못된 입력"},{...selection,bio:null,userId:a.uid}]) {
        stage = "preferences_invalid_expected_denial";
        const response = await service(request("service-api","/me/preferences",tokens.get(a.uid),invalid)); const result = data(await response.json());
        if (response.status !== 400 || data(result.error).code !== "INVALID_REQUEST") recordHttpError(response,result);
        check(response.status === 400 && data(result.error).code === "INVALID_REQUEST"); check(preferencesSnapshot() === prior);
      }
      stage = "preferences_direct_bio_patch_expected_denial";
      const patched = await http("/rest/v1/profiles?id=eq."+a.uid,tokens.get(a.uid)!,"PATCH",{bio:"직접수정거절"});
      const patchError = data(await patched.json()); check(patched.status === 403 && patchError.code === "42501"); check(preferencesSnapshot() === prior);
      await verifyPreferences({...selection,bio:"  명시 재시도 소개  "});
      report.preferencesVerification = {atomicFourFields:true,unicode300Boundary:true,invalidPayloadPriorValuesPreserved:true,directBioUpdateDenied:true,explicitRetry:true,retiredStaleJwt:"NOT_ASSERTED",actualScreenInputPreservation:"NOT_ASSERTED"};
      proof("preferences_actual_four_fields_readback_invalid_preserved_direct_update_denied_retry");
    }
    const episode = sql(`select id from private.member_episodes where profile_id=${literal(a.uid)}::uuid and ended_at is null;`); check(episode); proof("actual_signup_auth_storage_active_episode");
    const postInput = (offset: number) => ({ postId: randomUUID(), title: "합성자격검증", description: "격리 회귀용 합성 공고", category:"산책", startsAt: new Date(Date.now()+offset*86400000).toISOString(), endsAt:new Date(Date.now()+offset*86400000+3600000).toISOString(), recruitmentEndsAt:new Date(Date.now()+86400000).toISOString(), publicArea:"서울특별시 강남구 역삼동", registeredPlaceName:"가상장소", registeredAddress:"서울특별시 강남구 가상주소", meetingDetail:"가상입구", preferenceNote:null, tags:[], costType:"free", amount:0 });
    const post = async (owner: string, offset: number) => { const input = postInput(offset); if (native65) { fixturePostIds.push(input.postId);persistRecovery(); } await app("/posts",owner,input); return input.postId; };
    const match = async (author: string, requester: string, offset: number, confirm: boolean) => { const postId = await post(author,offset); const joined = await app(`/posts/${postId}/requests`,requester,{ messageId:randomUUID(), message:"합성 신청 메시지입니다" }); const requestId = uuidValue(joined.id); const consent = await app(`/requests/${requestId}/propose`,author,{}); check(typeof consent.conditionVersion === "string"); const appointmentId=confirm ? uuidValue((await app(`/requests/${requestId}/accept`,requester,{ conditionVersion:consent.conditionVersion })).appointmentId) : undefined; if (native65 && appointmentId) { fixtureAppointmentIds.push(appointmentId);persistRecovery(); } return { requestId, version:consent.conditionVersion as string, ...(appointmentId ? {appointmentId} : {}) }; };
    const old = [await match(b.uid,a.uid,3,true), await match(b.uid,a.uid,4,true)];
    const requesterPending = await match(b.uid,a.uid,5,false), authorPending = await match(a.uid,b.uid,6,false), openPost = await post(b.uid,7);
    proof("confirmed_appointments_and_pending_consents_created_through_member_http");
    if (native67) {
      // 회원 HTTP로 새 약속을 확정한다. 일정 경과 준비만 owner SQL 합성이며 시계/실제 대기 검증이 아니다.
      const fresh = await match(b.uid,a.uid,8,true), appointmentId=uuidValue(fresh.appointmentId);
      const path=`/appointments/${appointmentId}`, reviewInput={rating:5,experience:"positive",comment:"합성 공개 후기",praises:[]};
      const rowResponse = async (suffix: string, uid: string, body?: unknown) => {
        stage=operation(path+suffix);
        const payload=(await parse(await service(request("service-api",path+suffix,tokens.get(uid),body)))).data;
        check(Array.isArray(payload) && payload.length===1);if (!Array.isArray(payload)) throw new Error("NATIVE67_ROW_ARRAY_REQUIRED");return data(payload[0]);
      };
      const original=data(JSON.parse(sql(`select jsonb_build_object('postId',post_id) from public.appointments where id=${literal(appointmentId)}::uuid;`)));
      const postId=uuidValue(original.postId);
      stage="completion_owner_synthetic_elapsed_schedule";
      sql(`update public.posts set starts_at=clock_timestamp()-interval '2 hours',ends_at=clock_timestamp()-interval '1 hour',recruitment_ends_at=clock_timestamp()-interval '3 hours' where id=${literal(postId)}::uuid;`);
      const first=await rowResponse("/confirm-completion",b.uid,{});
      check(first.appointment_id===appointmentId && first.status==="confirmed" && first.completed_at===null && typeof first.my_confirmed_at==="string");
      const submitted=await app(path+"/reviews",b.uid,reviewInput);check(typeof submitted.reviewId==="string" && submitted.deduplicated===false);
      const before=await rowResponse("/reviews",a.uid);
      check(before.appointment_completed===false && before.peer_submitted===true && before.released===false && before.peer_review===null);
      const second=await rowResponse("/confirm-completion",a.uid,{});
      check(second.appointment_id===appointmentId && second.status==="completed" && second.completion_method==="manual" && typeof second.completed_at==="string");
      const oneReview=await rowResponse("/reviews",a.uid);check(oneReview.appointment_completed===true && oneReview.released===false && oneReview.peer_review===null);
      check(sql(`select review_deadline_at=completed_at+interval '7 days' and (select count(*)=2 from public.appointment_completion_confirmations where appointment_id=ap.id) from public.appointments ap where id=${literal(appointmentId)}::uuid;`)==="t");
      const final=await app(path+"/reviews",a.uid,reviewInput);check(typeof final.reviewId==="string" && final.deduplicated===false);
      for (const uid of [a.uid,b.uid]) { const value=await rowResponse("/reviews",uid);check(value.appointment_completed===true && value.peer_submitted===true && value.released===true && value.release_reason==="mutual" && data(value.peer_review).comment===reviewInput.comment); }
      const immutable=sql(`select jsonb_build_object('appointment',to_jsonb(ap),'reviews',(select jsonb_agg(to_jsonb(rv) order by id) from public.appointment_reviews rv where appointment_id=ap.id)) from public.appointments ap where id=${literal(appointmentId)}::uuid;`);
      check((await app(path+"/reviews",a.uid,reviewInput)).deduplicated===true);
      check((await rowResponse("/confirm-completion",a.uid,{})).completed_at===second.completed_at);
      check(sql(`select jsonb_build_object('appointment',to_jsonb(ap),'reviews',(select jsonb_agg(to_jsonb(rv) order by id) from public.appointment_reviews rv where appointment_id=ap.id)) from public.appointments ap where id=${literal(appointmentId)}::uuid;`)===immutable);
      report.completionReviewVerification={actualMemberHttpRest:true,syntheticElapsedSchedule:true,bilateralManualCompletion:true,personalEarlyPrivateReview:true,firstCompletionSevenDays:true,mutualRelease:true,deduplicatedRetry:true,ownerReviewDecision:false,hostedEdge:false,trustedReceiptDeadline:"NOT_ASSERTED",operatingDeployment:false};
      proof("completion_reviews_actual_member_http_bilateral_private_first_mutual_public_idempotent");
    }
    if (native63) {
      // 기존 약속을 재사용하며 실제 회원 Auth 검증→PostgREST→40600 철회를 연결한다.
      const appointmentId = uuidValue(old[0].appointmentId), changePath = `/appointments/${appointmentId}/schedule-change`;
      const immutableSnapshot = () => sql(`select jsonb_build_object(
        'post',(select to_jsonb(p) from public.posts p join public.appointments a on a.post_id=p.id where a.id=${literal(appointmentId)}::uuid),
        'appointment',(select to_jsonb(a) from public.appointments a where a.id=${literal(appointmentId)}::uuid),
        'location',(select to_jsonb(l) from private.post_search_locations l join public.appointments a on a.post_id=l.post_id where a.id=${literal(appointmentId)}::uuid),
        'details',(select to_jsonb(d) from public.post_private_details d join public.appointments a on a.post_id=d.post_id where a.id=${literal(appointmentId)}::uuid),
        'reservation',(select to_jsonb(r) from private.completion_reservations r where r.appointment_id=${literal(appointmentId)}::uuid));`);
      const before = immutableSnapshot(), original = await app(changePath,b.uid);
      check(original.status === "confirmed" && typeof original.startsAt === "string" && typeof original.endsAt === "string" && typeof original.updatedAt === "string");
      const changeId = randomUUID();
      const proposal = await app(changePath+"/propose",b.uid,{
        changeId, startsAt:new Date(Date.parse(original.startsAt as string)+1800000).toISOString(),
        endsAt:new Date(Date.parse(original.endsAt as string)+1800000).toISOString(), expectedUpdatedAt:original.updatedAt,
        location:{publicArea:"부산광역시 중구 중앙동",registeredPlaceName:"합성 새 장소",registeredAddress:"부산광역시 중구 새 가상주소",meetingDetail:"합성 새 입구"},
      });
      check(proposal.status === "awaiting_response" && typeof proposal.conditionVersion === "string");
      check(immutableSnapshot() === before);
      const responseBody = {changeId,conditionVersion:proposal.conditionVersion};
      await deny(changePath+"/withdraw",a.uid,responseBody);
      stage = "appointment_change_withdraw_stale_version_expected_denial";
      const staleResponse = await service(request("service-api",changePath+"/withdraw",tokens.get(b.uid),{changeId,conditionVersion:"stale-version"}));
      const stale = data(await staleResponse.json());
      if (staleResponse.status !== 409 || data(stale.error).code !== "STATE_CONFLICT") recordHttpError(staleResponse,stale);
      check(staleResponse.status === 409 && data(stale.error).code === "STATE_CONFLICT");
      check(!JSON.stringify(stale).includes(b.uid) && !JSON.stringify(stale).includes("schedule_change_conflict"));
      check(immutableSnapshot() === before);
      const withdrawn = await app(changePath+"/withdraw",b.uid,responseBody);
      check(withdrawn.status === "withdrawn" && withdrawn.deduplicated === false && withdrawn.newLocation === null);
      const retried = await app(changePath+"/withdraw",b.uid,responseBody);
      check(retried.status === "withdrawn" && retried.deduplicated === true && retried.conditionVersion === proposal.conditionVersion);
      const state = await app(changePath,a.uid), change = data(state.change);
      check(state.status === "confirmed" && change.status === "withdrawn" && change.changeId === changeId && change.newLocation === null);
      check(state.startsAt === original.startsAt && state.endsAt === original.endsAt && state.updatedAt === original.updatedAt);
      check(sql(`select status='withdrawn' and new_location_input is null and resolved_at is not null from private.appointment_schedule_changes where change_id=${literal(changeId)}::uuid and appointment_id=${literal(appointmentId)}::uuid;`) === "t");
      check(immutableSnapshot() === before);
      check(sql(`select count(*) from private.match_lifecycle_events where kind='appointment_schedule_change_ended' and event_key=${literal(proposal.conditionVersion as string)};`) === "1");
      check(sql(`select count(*) from public.notifications where kind='appointment_schedule_change_ended' and event_data->>'changeId'=${literal(changeId)};`) === "2");
      report.withdrawalVerification = {actualMemberHttpRest:true,counterpartyDenied:true,staleVersionDenied:true,deduplicatedRetry:true,originalAppointmentPostLocationReservationPreserved:true,pendingLocationCleared:true,hostedEdge:false,twoSessionRace:"NOT_RUN",trustedReceiptDeadline:"NOT_RUN"};
      proof("change_withdraw_actual_member_http_rest_author_only_stale_retry_originals_preserved_location_cleared");
    }
    let acceptedSafetyStart: string | null = null;
    if (native65) {
      const appointmentId=uuidValue(old[1].appointmentId), path=`/appointments/${appointmentId}/schedule-change`;
      stage="appointment_safety_latest_agreement_http_propose";
      const original=await app(path,b.uid);check(typeof original.startsAt==="string" && typeof original.endsAt==="string" && typeof original.updatedAt==="string");
      const changeId=randomUUID(), startsAt=new Date(Date.parse(original.startsAt as string)+1800000).toISOString(), endsAt=new Date(Date.parse(original.endsAt as string)+1800000).toISOString();
      const originalLedger=sql(`select jsonb_agg(to_jsonb(h) order by identity_id) from private.safety_appointment_results h where appointment_id=${literal(appointmentId)}::uuid;`);
      const proposal=await app(path+"/propose",b.uid,{changeId,startsAt,endsAt,expectedUpdatedAt:original.updatedAt});check(proposal.status==="awaiting_response" && typeof proposal.conditionVersion==="string");
      check(sql(`select jsonb_agg(to_jsonb(h) order by identity_id) from private.safety_appointment_results h where appointment_id=${literal(appointmentId)}::uuid;`)===originalLedger);
      stage="appointment_safety_latest_agreement_http_accept";
      const accepted=await app(path+"/accept",a.uid,{changeId,conditionVersion:proposal.conditionVersion});check(accepted.status==="accepted");
      const current=await app(path,a.uid);check(typeof current.startsAt==="string" && typeof current.endsAt==="string" && Date.parse(current.startsAt)===Date.parse(startsAt) && Date.parse(current.endsAt)===Date.parse(endsAt));
      acceptedSafetyStart=startsAt;
    }
    for (const [index, qualification] of ["missing","ineligible"].entries()) {
      stage = "native60_"+qualification; report.qualificationCase = qualification;
      const relogin = await login(a.subject,qualification as "missing"|"ineligible"); check(relogin.uid === a.uid && relogin.result.status === (qualification === "missing" ? "information_required" : "ineligible"));
      check(sql(`select id from private.member_episodes where profile_id=${literal(a.uid)}::uuid and ended_at is null;`) === episode);
      await app("/me",a.uid);
      await deny("/posts",a.uid,postInput(8+index));
      await deny(`/posts/${openPost}/requests`,a.uid,{ messageId:randomUUID(), message:"합성 신규 신청입니다" });
      await deny(`/requests/${authorPending.requestId}/propose`,a.uid,{});
      await deny(`/requests/${requesterPending.requestId}/accept`,a.uid,{ conditionVersion:requesterPending.version });
      await deny(`/requests/${authorPending.requestId}/accept`,b.uid,{ conditionVersion:authorPending.version });
      await app(`/requests/${requesterPending.requestId}/consent`,a.uid);
      const appointmentId = old[index].appointmentId!;
      stage = "existing_appointment_get";
      const appointmentRows = (await parse(await service(request("service-api", `/appointments/${appointmentId}`, tokens.get(a.uid))))).data;
      check(Array.isArray(appointmentRows) && appointmentRows.length === 1);
      const appointment = data((appointmentRows as unknown[])[0]);
      check(appointment.appointment_id === appointmentId && appointment.status === "confirmed");
      const reported = await app("/reports",a.uid,{ clientRequestId:randomUUID(), targetType:"appointment", targetId:appointmentId, context:"offline", reasonCodes:["other"], description:"합성 안전지원 검증", assetIds:[], hideTarget:false }); check(typeof reported.reportId === "string");
      await app("/me/reports",a.uid);
      check((await app(`/appointments/${appointmentId}/cancel`,a.uid,{ cancellationId:randomUUID(), reason:"합성 취소 검증" })).status === "cancelled");
      proof(qualification+"_new_activity_denied_existing_appointment_support_cancel_preserved");
    }
    report.qualificationCase = "requalified"; stage = "native60_requalification"; const restored = await login(a.subject,"qualified"); check(restored.uid === a.uid && restored.result.status === "ready");
    check(sql(`select id from private.member_episodes where profile_id=${literal(a.uid)}::uuid and ended_at is null;`) === episode); await post(a.uid,10); proof("requalification_same_uid_episode_new_post_allowed");
    if (native64) {
      report.driverSha256=createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex");
      const emptySafety = (value: Record<string,unknown>) => {
        check(Object.keys(value).sort().join(",") === "hasWarning,permanent,restrictedUntil,sanctions");
        check(value.permanent === false && value.hasWarning === false && value.restrictedUntil === null && Array.isArray(value.sanctions) && value.sanctions.length === 0);
      };
      emptySafety(await app("/me/safety",a.uid));emptySafety(await app("/me/safety",b.uid));
      const ownKinds = ["cancel_warning","general_warning","cancel_restriction","general_7d","general_30d","permanent","general_7d","general_30d"];
      for (const [index,kind] of ownKinds.entries()) safetyRows.push({id:randomUUID(),incident:randomUUID(),decision:randomUUID(),owner:a.uid,kind,expired:index===6,revoked:index===7});
      safetyRows.push({id:randomUUID(),incident:randomUUID(),decision:randomUUID(),owner:b.uid,kind:"permanent",expired:false,revoked:false});
      persistRecovery(); // 원장 쓰기 전에 정확한 복구 식별 값만 기록한다.
      const actorReference = randomUUID();
      stage = "safety_owner_synthetic_ledger_setup";
      for (const row of safetyRows) {
        const duration = row.kind === "general_30d" ? 720 : 168;
        const applied = row.expired ? `statement_timestamp()-interval '${duration+24} hours'` : row.revoked ? "statement_timestamp()-interval '24 hours'" : "statement_timestamp()";
        sql(`begin;insert into private.safety_incidents(id,current_revision) values(${literal(row.incident)}::uuid,1);insert into private.safety_incident_revisions(incident_id,revision,decision_id,state,reason_code,actor_reference,subject_payload_hash) values(${literal(row.incident)}::uuid,1,${literal(row.decision)}::uuid,'confirmed','synthetic_private_reason',${literal(actorReference)}::uuid,repeat('a',64));insert into private.safety_incident_subjects(incident_id,revision,identity_id,source_episode_id,confirmed_kinds) select ${literal(row.incident)}::uuid,1,identity_id,id,'{}'::text[] from private.member_episodes where profile_id=${literal(row.owner)}::uuid and ended_at is null;with t as(select ${applied} as at) insert into private.safety_sanction_applications(id,identity_id,incident_id,decision_revision,source_episode_id,kind,applied_at,expires_at,revoked_at,correction_reason_code) select ${literal(row.id)}::uuid,identity_id,${literal(row.incident)}::uuid,1,e.id,${literal(row.kind)},t.at,${["cancel_restriction","general_7d","general_30d"].includes(row.kind) ? `t.at+interval '${duration} hours'` : "null"},${row.revoked ? "statement_timestamp()" : "null"},${row.revoked ? "'synthetic_corrected'" : "null"} from private.member_episodes e cross join t where e.profile_id=${literal(row.owner)}::uuid and e.ended_at is null;commit;`);
      }
      const inspectSafety = (value: Record<string,unknown>, expectedRows: typeof safetyRows, permanent: boolean, hasWarning: boolean) => {
        check(Object.keys(value).sort().join(",") === "hasWarning,permanent,restrictedUntil,sanctions");
        check(value.permanent === permanent && value.hasWarning === hasWarning && Array.isArray(value.sanctions) && value.sanctions.length === expectedRows.length);
        check(typeof value.restrictedUntil === "string" && Number.isFinite(Date.parse(value.restrictedUntil)));
        const ownIds = expectedRows.map(row=>row.id).sort(); const returnedIds: string[] = [];
        for (const item of value.sanctions as unknown[]) {
          const sanction = data(item);check(Object.keys(sanction).sort().join(",") === "appliedAt,expiresAt,kind,notifiedAt,sanctionId");
          returnedIds.push(uuidValue(sanction.sanctionId));check(ownKinds.includes(sanction.kind as string) && expectedRows.find(row=>row.id===sanction.sanctionId)?.kind===sanction.kind);
          for (const field of ["appliedAt","expiresAt","notifiedAt"]) { const timestamp=sanction[field];check(timestamp===null && field!=="appliedAt" || typeof timestamp==="string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) && Number.isFinite(Date.parse(timestamp))); }
        }
        check(JSON.stringify(returnedIds.sort())===JSON.stringify(ownIds));
        const text=JSON.stringify(value);check(!text.includes("synthetic_private_reason") && !text.includes(safetyRows[8].id) && !text.includes("incidentId") && !text.includes("identityId") && !text.includes("appealDeadline"));
        check(sql(`select ${literal(value.restrictedUntil as string)}::timestamptz=max(expires_at) from private.safety_sanction_applications where id in(${expectedRows.map(row=>literal(row.id)+"::uuid").join(",")});`) === "t");
      };
      const active = safetyRows.filter(row=>row.owner===a.uid && !row.expired && !row.revoked);
      stage="safety_member_read_active_own_state";inspectSafety(await app("/me/safety",a.uid),active,true,true);
      const corrected = active.filter(row=>!["permanent","cancel_warning","general_warning"].includes(row.kind));
      stage="safety_owner_synthetic_correction";
      sql(`update private.safety_sanction_applications set revoked_at=clock_timestamp(),correction_reason_code='synthetic_corrected' where id in(${active.filter(row=>!corrected.includes(row)).map(row=>literal(row.id)+"::uuid").join(",")});`);
      inspectSafety(await app("/me/safety",a.uid),corrected,false,false);
      stage="safety_missing_qualification_login";const missing=await login(a.subject,"missing");check(missing.uid===a.uid && missing.result.status==="information_required");
      inspectSafety(await app("/me/safety",a.uid),corrected,false,false);
      const recovered=await login(a.subject,"qualified");check(recovered.uid===a.uid && recovered.result.status==="ready");
      report.safetyVerification={actualMemberHttpRest:true,ownerSyntheticLedger:true,activeOwnOnly:true,expiredRevokedExcluded:true,longestRestriction:true,warningCorrection:true,missingQualificationOwnRead:true,staffAdjudication:false,noticeDelivery:false,appealDeadline:"NOT_ASSERTED",realOAuth:false,hostedEdge:false};
      proof("safety_actual_member_http_rest_own_active_exact_dto_correction_missing_qualification_read");
    }
    if (native68) {
      const own=safetyRows.filter(row=>row.owner===a.uid).sort((left,right)=>left.id.localeCompare(right.id));
      const fields="appealDeadlineAt,appealPolicy,appealState,appliedAt,correctionReasonCode,expiresAt,kind,notifiedAt,reasonCode,revokedAt,sanctionId,status";
      const history = async (path: string) => {
        const value=await app(path,a.uid);check(Object.keys(value).sort().join(",")==="items,nextCursor" && Array.isArray(value.items));
        const items=(value.items as unknown[]).map(item=>data(item));
        for (const item of items) {
          const fixture=own.find(row=>row.id===item.sanctionId);check(fixture && Object.keys(item).sort().join(",")===fields && item.kind===fixture?.kind);
          check(["active","ended","corrected"].includes(item.status as string) && item.reasonCode==="other" && item.appealDeadlineAt===null && item.appealState===null && item.notifiedAt===null);
          check(item.appealPolicy===((item.kind as string).startsWith("cancel_")?"cancellation_24h":"general_7d"));
          check(item.correctionReasonCode===(item.status==="corrected"?"other":null));
        }
        const serialized=JSON.stringify(value);check(!serialized.includes(safetyRows[8].id) && !serialized.includes("synthetic_private_reason") && !serialized.includes("synthetic_corrected") && !serialized.includes(a.uid) && !serialized.includes(b.uid) && !serialized.includes("identityId") && !serialized.includes("incidentId") && !serialized.includes("actorReference"));
        return {value,items};
      };
      stage="sanction_history_actual_own_all_states";
      const all=await history("/me/sanctions?limit=100");check(all.value.nextCursor===null && JSON.stringify(all.items.map(item=>item.sanctionId))===JSON.stringify(own.map(row=>row.id)));
      check(all.items.filter(item=>item.status==="active").length===3 && all.items.filter(item=>item.status==="ended").length===1 && all.items.filter(item=>item.status==="corrected").length===4);
      const ids:string[]=[];let cursor:string|null=null;
      for (let page=0;page<3;page++) {
        const result=await history("/me/sanctions?limit=3"+(cursor?"&before="+cursor:""));check(result.items.length<4);ids.push(...result.items.map(item=>uuidValue(item.sanctionId)));
        if (result.value.nextCursor===null) {cursor=null;break;}
        cursor=uuidValue(result.value.nextCursor);check(cursor===ids.at(-1));
      }
      check(cursor===null && JSON.stringify(ids)===JSON.stringify(own.map(row=>row.id)) && new Set(ids).size===8);
      stage="sanction_history_foreign_cursor_expected_denial";
      const foreignResponse=await service(request("service-api","/me/sanctions?limit=3&before="+safetyRows[8].id,tokens.get(a.uid)));
      const foreign=data(await foreignResponse.json());check(foreignResponse.status===404 && data(foreign.error).code==="RESOURCE_NOT_FOUND" && !JSON.stringify(foreign).includes(safetyRows[8].id));
      const active=all.items.find(item=>item.status==="active");check(active);const correctedId=uuidValue(active!.sanctionId);
      stage="sanction_history_owner_synthetic_correction";
      sql(`update private.safety_sanction_applications set revoked_at=clock_timestamp(),correction_reason_code='synthetic_corrected' where id=${literal(correctedId)}::uuid;`);
      const corrected=await history("/me/sanctions?limit=100");check(corrected.items.find(item=>item.sanctionId===correctedId)?.status==="corrected");
      const missing=await login(a.subject,"missing");check(missing.uid===a.uid && missing.result.status==="information_required");
      check(JSON.stringify((await history("/me/sanctions?limit=100")).value)===JSON.stringify(corrected.value));
      const restored=await login(a.subject,"qualified");check(restored.uid===a.uid && restored.result.status==="ready");
      report.sanctionHistoryVerification={actualMemberHttpRest:true,ownerSyntheticLedger:true,ownOnly:true,activeEndedCorrected:true,paginationExactOnce:true,foreignCursorDenied:true,correctionReadback:true,missingQualificationOwnRead:true,unconnectedAppealDeadlineNull:true,staffWorkflow:"NOT_ASSERTED",noticeDelivery:"NOT_ASSERTED",appealSubmission:"NOT_ASSERTED",externalNaver:false,hostedEdge:false};
      proof("sanction_history_actual_member_http_own_privacy_states_pagination_correction_qualification_deadline_null");
    }
    if (native65) {
      stage="appointment_safety_actual_http_derived_results_read";
      const appointmentIds=old.map(item=>literal(uuidValue(item.appointmentId))+"::uuid").join(",");
      check(acceptedSafetyStart!==null);
      const facts=data(JSON.parse(sql(`select jsonb_build_object(
        'twoIdentities',(select count(*)=4 and count(distinct (h.identity_id,h.appointment_id))=4 from private.safety_appointment_results h where h.appointment_id in(${appointmentIds})),
        'fixedBindings',(select count(*)=4 and bool_and(h.source_episode_id in(m.author_episode_id,m.requester_episode_id) and h.identity_id=e.identity_id) from private.safety_appointment_results h join private.appointment_member_episodes m on m.appointment_id=h.appointment_id join private.member_episodes e on e.id=h.source_episode_id where h.appointment_id in(${appointmentIds})),
        'agreedOrdering',(select count(*)=4 and bool_and(h.agreed_starts_at=p.starts_at and (h.appointment_id<>${literal(uuidValue(old[1].appointmentId))}::uuid or h.agreed_starts_at=${literal(acceptedSafetyStart!)}::timestamptz) and h.confirmed_at=ap.confirmed_at and h.ordering_provenance='agreed_snapshot') from private.safety_appointment_results h join public.appointments ap on ap.id=h.appointment_id join public.posts p on p.id=ap.post_id where h.appointment_id in(${appointmentIds})),
        'ownPeerFacts',(select count(*)=4 and bool_and(r.origin='appointment' and r.appeal_state='none' and r.outcome=case when e.profile_id=c.cancelled_by then 'own_cancel' else 'peer_cancel' end and r.cancellation_at is not distinct from case when e.profile_id=c.cancelled_by then c.cancelled_at else null end) from private.safety_appointment_results h join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision join private.member_episodes e on e.id=h.source_episode_id join private.appointment_cancellations c on c.appointment_id=h.appointment_id where h.appointment_id in(${appointmentIds})),
        'revisionConsistency',(select count(*)=4 and bool_and(h.current_revision=2 and (select count(*)=2 and bool_and(r.origin='appointment') from private.safety_appointment_result_revisions r where r.identity_id=h.identity_id and r.appointment_id=h.appointment_id) and (select r.outcome='pending' and r.cancellation_at is null from private.safety_appointment_result_revisions r where r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=1)) from private.safety_appointment_results h where h.appointment_id in(${appointmentIds})),
        'noAutomaticSanctions',(select count(*)=${safetyRows.length} from private.safety_sanction_applications));`)));
      check(Object.keys(facts).length===6 && Object.values(facts).every(value=>value===true));
      report.appointmentSafetyVerification={...facts,actualMemberHttpDerived:true,ownerEvidenceReadOnly:true,latestAgreementActualHttpAccepted:true,ownerAdjudication:false,externalNaver:false,twoSessionConcurrency:"NOT_ASSERTED"};
      proof("appointment_safety_actual_member_http_fixed_identity_order_own_peer_revision_no_auto_sanctions");
    }
  } catch { failed = true; report.failureStage = stage; report.failureCode = "NATIVE60_QUALIFICATION_FAILED"; }
  finally {
    globalThis.fetch = transport;
    const errors: string[] = [];
    const attempt = async (name: string, operation: () => unknown|Promise<unknown>) => { try { await operation(); } catch { errors.push(name); failed = true; } };
    if (guarded && subjects.length) {
      await attempt("exact_fixture_database_cleanup", () => {
        const subjectsSql = subjects.map(literal).join(",");
        // 정확한 subject의 예약 이메일로 중간 실패한 Auth 생성도 정리한다. 비밀/본문을 저장하지 않는다.
        const ids = sql(`select coalesce(jsonb_agg(u.id),'[]') from auth.users u join private.naver_accounts a on a.auth_email=u.email where a.subject in(${subjectsSql});`);
        report.cleanupIds = JSON.parse(ids);if(native68) {for(const id of report.cleanupIds as string[])if(!fixtureUserIds.includes(id))fixtureUserIds.push(id);persistRecovery();} const idList = (JSON.parse(ids) as string[]).map(value => literal(uuidValue(value))+"::uuid").join(",");
        if (native64 && safetyRows.length) {
          const incidentIds=safetyRows.map(row=>literal(row.incident)+"::uuid").join(","), sanctionIds=safetyRows.map(row=>literal(row.id)+"::uuid").join(",");
          sql(`begin;delete from private.safety_appeals where sanction_id in(${sanctionIds});delete from private.safety_sanction_applications where id in(${sanctionIds});delete from private.safety_incident_report_links where incident_id in(${incidentIds});delete from private.safety_incident_subjects where incident_id in(${incidentIds});delete from private.safety_incident_revisions where incident_id in(${incidentIds});delete from private.safety_incidents where id in(${incidentIds});commit;`);
        }
        if (native65 && fixturePostIds.length) {
          const postIds=fixturePostIds.map(value=>literal(uuidValue(value))+"::uuid").join(",");
          // 응답 직후 장애도 정확히 먼저 기록한 본인 post ID에서 약속을 복구한다. 전체 회원/prefix 삭제가 아니다.
          const recovered=JSON.parse(sql(`select coalesce(jsonb_agg(id order by id),'[]') from public.appointments where post_id in(${postIds});`)) as unknown[];
          const exact=recovered.map(uuidValue);for(const id of exact) if(!fixtureAppointmentIds.includes(id))fixtureAppointmentIds.push(id);persistRecovery();
          if(exact.length) { const apIds=exact.map(value=>literal(value)+"::uuid").join(",");if(native67) sql(`begin;delete from private.appointment_review_normal_completions where appointment_id in(${apIds});delete from private.appointment_review_holds where appointment_id in(${apIds});delete from private.appointment_review_windows where appointment_id in(${apIds});commit;`);sql(`begin;delete from private.safety_appointment_result_revisions where appointment_id in(${apIds});delete from private.safety_appointment_results where appointment_id in(${apIds});commit;`); }
        }
        if (idList) sql(`begin;delete from private.member_reports where reporter_id in(${idList});delete from public.appointments where post_id in(select id from public.posts where author_id in(${idList}));delete from public.posts where author_id in(${idList});delete from public.profiles where id in(${idList});delete from private.member_episodes where profile_id in(${idList});commit;`);
        sql(`begin;delete from private.naver_identity_keys where subject in(${subjectsSql});delete from private.naver_accounts where subject in(${subjectsSql});commit;`);
        if (challenges.length) sql(`delete from private.naver_login_challenges where state_hash in(${challenges.map(literal).join(',')});`);
      });
      await attempt("exact_fixture_storage_delete", async () => {
        if (photos.length) {
          const response = await http("/storage/v1/object/profile-images",serviceKey,"DELETE",{ prefixes:photos });
          check(response.status === 200);
          // Storage DELETE는 배열 응답이다. 객체로 변환하지 않고 최종 DB·실제 파일 0개로 삭제를 확인한다.
          await response.body?.cancel();
        }
      });
      for (const uid of report.cleanupIds as string[] ?? []) await attempt("exact_fixture_auth_delete",async () => { await parse(await http("/auth/v1/admin/users/"+uuidValue(uid),serviceKey,"DELETE")); });
      if(native68 && auditBaselineCaptured) await attempt("exact_fixture_auth_audit_cleanup_after_last_auth_delete",()=>{
        const markers=[...new Set([...fixtureUserIds,...fixtureAliases])];
        if(markers.length) {
          const matched=JSON.parse(sql(`select coalesce(jsonb_agg(a.id::text order by a.id),'[]') from auth.audit_log_entries a where exists(select 1 from jsonb_path_query(a.payload::jsonb,'$.**') v(value) where v.value in(${markers.map(value=>`to_jsonb(${literal(value)}::text)`).join(",")}));`)) as string[];
          for(const id of matched)if(!auditBaselineIds.includes(id) && !fixtureAuditIds.includes(id)){check(/^[a-f0-9-]{36}$/.test(id));fixtureAuditIds.push(id);}
          persistRecovery();
          if(fixtureAuditIds.length)sql(`begin;delete from auth.audit_log_entries where id in(${fixtureAuditIds.map(id=>literal(id)+"::uuid").join(",")});commit;`);
        }
        check(JSON.stringify(JSON.parse(sql("select coalesce(jsonb_agg(id::text order by id),'[]') from auth.audit_log_entries;")))===JSON.stringify(auditBaselineIds));
        report.authAuditVerification={baselineCount:288,baselineExactIdsPreserved:true,onlyNewFixtureUidOrAliasMatchesDeleted:true,cleanupAfterLastAuthDelete:true,unknownAuditDeleted:false};
      });
      delete report.cleanupIds;
    }
    if (guarded) {
      if (native65) await attempt("appointment_safety_migration_audit_unchanged",()=>check(syncAudit()===baselineSyncAudit));
      await attempt("application_auth_storage_zero",empty);
      await attempt("storage_backend_files_zero", () => check(files() === 0));
      await attempt("guard_acl_global_roles_memberships_unchanged",() => check(configState() === baseline));
      if(native68) {
        await attempt("native68_full_relation_counts_baseline_restored",()=>{check(allCounts()===baselineAllCounts);report.allRelationCountsRestored=true;});
        await attempt("native68_full_catalog_baseline_restored",()=>{check(fullCatalog()===baselineFullCatalog);report.fullCatalogRestored=true;});
      }
      await attempt(`native${count}_9rpc_exact_acl_matrix_preserved`,assertExpectedAcl);
      if (native64) await attempt("native64_safety_auth_only_acl_preserved",assertSafetyAcl);
      if (native67) await attempt("native67_completion_and_closed_review_helpers_acl_preserved",assertCompletionAcl);
      if (native68) await attempt("native68_sanction_history_auth_only_acl_preserved",assertSanctionHistoryAcl);
      await attempt(`migration_history${count}_unchanged`,() => check(JSON.stringify(JSON.parse(sql("select coalesce(jsonb_agg(version order by version),'[]') from supabase_migrations.schema_migrations;"))) === JSON.stringify(versions)));
    }
    if (failed && subjects.length) { if (native64) persistRecovery(); else writeFileSync(join(artifact,"fixture-recovery.json"), JSON.stringify({ subjects, photos, challengeHashes:challenges }), {mode:0o600}); }
    report.cleanup = { verified:guarded && errors.length === 0, failures:errors };
    report.status = failed ? "FAIL" : "PASS";
    writeFileSync(join(artifact,"result.json"),JSON.stringify(report,null,2),{ mode:0o600 });
    if (native64 && !failed && existsSync(join(artifact,"fixture-recovery.json"))) unlinkSync(join(artifact,"fixture-recovery.json"));
    console.log(JSON.stringify({ status:report.status, groups:results.length, cleanup:report.cleanup, artifact:join(artifact,"result.json") }));
    if (failed) process.exitCode = 1;
  }
}
