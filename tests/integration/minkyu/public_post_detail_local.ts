/** 민규: 분리된 로컬 Auth/PostgREST와 실제 HTTP factory의 공개 상세 검증.
 * 네이버 자격과 JPEG 객체 metadata는 합성 fixture이며 실제 네이버·사진 업로드 검사가 아니다.
 * 총괄이 준비한 yumidang-minkyu-public-detail(:56421), 초기 회원/공고 0개만 허용한다.
 * YUMIDANG_PUBLIC_DETAIL_LOCAL_CONFIG=권한0600임시config.json node 이파일 --run
 * 외부 네트워크/키 출력/CLI 시작·중지/원격 적용 없음. 성공 후 합성 fixture를 정리한다.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { createNaverSessionBridge } from "../../../backend/supabase/functions/_shared/auth/session-bridge.ts";

const API = "http://127.0.0.1:56421", ORIGIN = "http://127.0.0.1:5173";
const CONTEXT = "colima-yumidang-minkyu", PROJECT = "yumidang-minkyu-public-detail", CONTAINER = "supabase_db_" + PROJECT;
const nativeFetch = globalThis.fetch;
const uidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PRIVATE_ADDRESS = "서울특별시 성동구 합성비공개로 123", PRIVATE_PLACE = "합성비공개장소", PRIVATE_MEETING = "합성비공개입구 3층";
type Row = Record<string, any>;
let checks = 0, stage = "configuration", guardedTarget = false, cleanupPassed = false;
let diagnostic: { httpStatus: number; errorCode: string } | undefined;
const userIds: string[] = [], postIds: string[] = [], calls: string[] = [];
function check(value: unknown): asserts value { if (!value) throw new Error("check_failed"); checks++; }
const row = (value: unknown): Row => { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Row; };
const uuid = (value: unknown): value is string => typeof value === "string" && uidPattern.test(value);
const docker = (...args: string[]) => execFileSync("docker", ["--context", CONTEXT, ...args],
  { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576 }).trim();
const sql = (input: string) => execFileSync("docker", ["--context", CONTEXT, "exec", "-i", CONTAINER,
  "psql", "-U", "postgres", "-d", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
  { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576 }).trim();
const publicCodes = new Set(["AUTH_REQUIRED", "ACCESS_DENIED", "RESOURCE_NOT_FOUND", "INVALID_REQUEST", "STATE_CONFLICT", "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR"]);
const rpcNames = new Set(["resolve_naver_account", "record_naver_session", "complete_naver_signup", "create_service_post", "get_service_post",
  "request_service_post", "propose_match", "accept_match", "cancel_appointment", "delete_service_post", "get_my_profile"]);

function cleanup() {
  if (!guardedTarget) return;
  check(userIds.every(uuid) && postIds.every(uuid));
  // Only generated, validated fixture identifiers enter SQL. Initial-zero guard prevents other fixtures being adopted.
  const postCleanup = postIds.length ? `delete from public.posts where id in (${postIds.map(id => `'${id}'`).join(",")});` : "";
  if (userIds.length) {
    const ids = userIds.map(id => `'${id}'`).join(",");
    // Clear the profile reference before its image; retain the product's current-photo protection.
    sql(`begin; set local storage.allow_delete_query='true';
      ${postCleanup}
      delete from private.naver_accounts where user_id in (${ids});
      delete from public.profiles where id in (${ids});
      delete from storage.objects where bucket_id='profile-images' and owner_id in (${ids});
      delete from auth.users where id in (${ids}); commit;`);
  } else if (postCleanup) sql(`begin; ${postCleanup} commit;`);
  check(sql("select (select count(*) from auth.users)||','||(select count(*) from public.posts)||','||(select count(*) from public.profiles)||','||(select count(*) from private.naver_accounts)||','||(select count(*) from private.naver_sessions)||','||(select count(*) from storage.objects where bucket_id='profile-images');") === "0,0,0,0,0,0");
  cleanupPassed = true;
}

async function run() {
  check(process.argv.length === 3 && process.argv[2] === "--run");
  const filename = process.env.YUMIDANG_PUBLIC_DETAIL_LOCAL_CONFIG;
  check(typeof filename === "string" && isAbsolute(filename));
  const info = lstatSync(filename), parent = lstatSync(dirname(filename));
  check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 24576 && (info.mode & 0o777) === 0o600 && info.uid === process.getuid!());
  check(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o777) === 0o700 && parent.uid === process.getuid!());
  const path = realpathSync(filename), tempRoot = realpathSync(tmpdir());
  check(path.startsWith(tempRoot + "/") || path.startsWith("/private/tmp/"));
  const cfg = row(JSON.parse(readFileSync(path, "utf8")));
  check(Object.keys(cfg).sort().join(",") === "ANON_KEY,API_URL,SERVICE_ROLE_KEY");
  check(cfg.API_URL === API && typeof cfg.ANON_KEY === "string" && cfg.ANON_KEY.length > 0 && typeof cfg.SERVICE_ROLE_KEY === "string" && cfg.SERVICE_ROLE_KEY.length > 0 && cfg.ANON_KEY !== cfg.SERVICE_ROLE_KEY);
  check(docker("context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}") === "unix://" + homedir() + "/.colima/yumidang-minkyu/docker.sock");
  const targets = JSON.parse(docker("inspect", CONTAINER)); check(Array.isArray(targets) && targets.length === 1);
  const target = row(targets[0]);
  check(target.Name === "/" + CONTAINER && target.Config.Labels["com.supabase.cli.project"] === PROJECT && target.State.Running === true);
  check(sql("select (select count(*) from auth.users)||','||(select count(*) from public.posts);") === "0,0");
  guardedTarget = true;
  const guardedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    check(url.origin === API && !url.username && !url.password && !url.search && !url.hash);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    check((url.pathname === "/auth/v1/user" && method === "GET") ||
      (["/auth/v1/admin/generate_link", "/auth/v1/verify"].includes(url.pathname) && method === "POST") ||
      (rpc !== null && rpcNames.has(rpc[1]) && method === "POST"));
    calls.push(url.pathname);
    return nativeFetch(input, { ...init, redirect: "error" });
  };
  globalThis.fetch = guardedFetch;
  const config = { supabaseUrl: API, supabaseAnonKey: cfg.ANON_KEY as string, supabaseServiceRoleKey: cfg.SERVICE_ROLE_KEY as string,
    allowedOrigins: [ORIGIN], maxRequestBytes: 8192, upstreamTimeoutMs: 10000 };
  const env: Record<string, string> = { SUPABASE_URL: API, SUPABASE_ANON_KEY: cfg.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY,
    ALLOWED_ORIGINS: JSON.stringify([ORIGIN]), MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "10000" };
  const service = createRuntimeHandler(key => env[key]);
  const request = (endpoint: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request(`${API}/functions/v1/service-api/${endpoint}`, { method: body === undefined ? "GET" : "POST",
      headers: { origin: ORIGIN, ...(token === undefined ? {} : { authorization: token === "" ? "" : `Bearer ${token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const inspect = async (result: Response) => {
    const value = row(await result.json()), code = value.error && row(value.error).code;
    diagnostic = { httpStatus: result.status, errorCode: publicCodes.has(code) ? code : value.error ? "UNEXPECTED_RESPONSE" : "NONE" };
    check(result.headers.get("cache-control") === "no-store" && result.headers.get("access-control-allow-origin") === ORIGIN);
    check(value.requestId === result.headers.get("x-request-id")); return value;
  };
  const success = async (result: Response) => { const value = await inspect(result); check(result.status === 200 && !value.error); diagnostic = undefined; return row(value.data); };
  const fail = async (result: Response, status: number, code: string) => { const value = await inspect(result); check(result.status === status && row(value.error).code === code && value.data === undefined); diagnostic = undefined; };
  const get = async (endpoint: string, token?: string) => success(await service(request(endpoint, token)));
  const post = async (endpoint: string, token: string, body: unknown) => success(await service(request(endpoint, token, body)));
  const rpc = async (name: string, args: Row, token: string) => {
    const result = await guardedFetch(`${API}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: cfg.ANON_KEY,
      authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
    check(result.ok); return row(await result.json());
  };
  const member = async (name: string) => {
    const subject = "public-detail-synthetic-" + crypto.randomUUID();
    const account = await rpc("resolve_naver_account", { p_subject: subject, p_name: name, p_gender: "F", p_birth_date: "2000-01-01" }, cfg.SERVICE_ROLE_KEY);
    check(account.status === "photo_required");
    const session = await createNaverSessionBridge(config, guardedFetch).issue(account.authEmail, null);
    check(uuid(session.userId) && uuid(session.sessionId)); userIds.push(session.userId);
    await rpc("record_naver_session", { p_subject: subject, p_user_id: session.userId, p_session_id: session.sessionId }, cfg.SERVICE_ROLE_KEY);
    const imageId = crypto.randomUUID(); check(uuid(imageId));
    const avatar = `${session.userId}/${imageId}.jpg`;
    // Metadata-only synthetic fixture: native Auth and DB gates are real, image bytes were not uploaded.
    sql(`insert into storage.objects(bucket_id,name,owner_id,metadata) values ('profile-images','${avatar}','${session.userId}','{"mimetype":"image/jpeg","size":128}');`);
    check((await rpc("complete_naver_signup", { p_avatar_path: avatar, p_interests: [], p_conversation_styles: [], p_mbti: null }, session.accessToken)).status === "ready");
    return { uid: session.userId, token: session.accessToken, name };
  };
  stage = "native_auth_qualified_accounts";
  const author = await member("가상작성자"), peer = await member("가상신청자");
  const createPost = async (day: number) => {
    const id = crypto.randomUUID(); check(uuid(id)); postIds.push(id);
    const value = await post("posts", author.token, { postId: id, title: "공개 상세 합성 공고", description: "로컬 합성 산책 설명", category: "산책",
      startsAt: new Date(Date.now() + day * 86400000).toISOString(), endsAt: new Date(Date.now() + day * 86400000 + 3600000).toISOString(),
      publicArea: "서울특별시 성동구 성수동", registeredPlaceName: PRIVATE_PLACE, registeredAddress: PRIVATE_ADDRESS,
      meetingDetail: PRIVATE_MEETING, costType: "free", amount: 0 });
    check(value.postId === id); return id;
  };
  const privateKeys = ["privateDetails", "participantNames", "authorId", "author_id", "userId", "realName", "birthDate", "birth_date", "registeredAddress", "meetingDetail"];
  const restricted = (value: Row, anonymous: boolean) => {
    check(privateKeys.every(key => !Object.hasOwn(value, key)));
    const text = JSON.stringify(value);
    check(![PRIVATE_ADDRESS, PRIVATE_PLACE, PRIVATE_MEETING, author.uid, peer.uid, author.name, peer.name].some(secret => text.includes(secret)));
    check(value.publicArea === "서울특별시 성동구 성수동");
    check(anonymous ? /^동행-/.test(value.authorDisplayName) : value.authorDisplayName === "가***자");
  };
  const full = (value: Row, pair: boolean) => {
    check(value.authorDisplayName === author.name);
    const details = row(value.privateDetails);
    check(details.registeredAddress === PRIVATE_ADDRESS && details.registeredPlaceName === PRIVATE_PLACE && details.meetingDetail === PRIVATE_MEETING);
    check(Array.isArray(value.participantNames) && value.participantNames.length === (pair ? 2 : 1));
    check(value.participantNames.some((item: Row) => item.userId === author.uid && item.realName === author.name));
    if (pair) check(value.participantNames.some((item: Row) => item.userId === peer.uid && item.realName === peer.name));
  };
  stage = "anonymous_member_owner_projection";
  const id = await createPost(3), endpoint = `posts/${id}`;
  restricted(await get(endpoint), true); restricted(await get(endpoint, peer.token), false); full(await get(endpoint, author.token), false);
  const spoofed = await success(await service(request(endpoint, undefined, undefined, { apikey: cfg.SERVICE_ROLE_KEY, "x-user-id": author.uid, "x-caller": "member" })));
  restricted(spoofed, true);
  stage = "invalid_token_no_fallback";
  const beforeInvalid = calls.filter(path => path === "/rest/v1/rpc/get_service_post").length;
  await fail(await service(request(endpoint, "synthetic.invalid.signature")), 401, "AUTH_REQUIRED");
  await fail(await service(request(endpoint, "")), 401, "AUTH_REQUIRED");
  check(calls.filter(path => path === "/rest/v1/rpc/get_service_post").length === beforeInvalid);
  await fail(await service(request("me")), 401, "AUTH_REQUIRED");
  await fail(await service(request(endpoint + "?caller=member")), 400, "INVALID_REQUEST");
  stage = "pending_request_still_masked";
  const requested = await post(`${endpoint}/requests`, peer.token, { message: "실제 이용 자료가 아닌 합성 상세 권한 검사입니다." }); check(uuid(requested.id));
  restricted(await get(endpoint, peer.token), false);
  const consent = await post(`requests/${requested.id}/propose`, author.token, {});
  restricted(await get(endpoint, peer.token), false);
  stage = "confirmed_pair_full_details";
  const matched = await post(`requests/${requested.id}/accept`, peer.token, { conditionVersion: consent.conditionVersion }); check(uuid(matched.appointmentId));
  full(await get(endpoint, peer.token), true); full(await get(endpoint, author.token), true); restricted(await get(endpoint), true);
  stage = "cancelled_peer_remasked";
  const cancelled = await post(`appointments/${matched.appointmentId}/cancel`, author.token, { cancellationId: crypto.randomUUID(), reason: "합성 시작 전 일정 취소" });
  check(cancelled.status === "cancelled");
  restricted(await get(endpoint, peer.token), false); restricted(await get(endpoint), true); full(await get(endpoint, author.token), false);
  stage = "deleted_post_not_found";
  const deleted = await createPost(5); check((await post(`posts/${deleted}/delete`, author.token, {})).status === "deleted");
  for (const token of [undefined, peer.token, author.token]) await fail(await service(request(`posts/${deleted}`, token)), 404, "RESOURCE_NOT_FOUND");
  const missing = crypto.randomUUID(); check(uuid(missing));
  await fail(await service(request(`posts/${missing}`)), 404, "RESOURCE_NOT_FOUND");
  check(sql("select (select count(*) from auth.users)||','||(select count(*) from public.posts);") === "2,2");
  check(calls.filter(path => path === "/auth/v1/admin/generate_link").length === 2 && calls.filter(path => path === "/auth/v1/verify").length === 2);
}

try {
  await run();
  stage = "synthetic_cleanup"; cleanup();
  console.log(JSON.stringify({ status: "PASS", checks, syntheticCleanup: cleanupPassed, nativeAuth: true, actualPhotoUpload: false, externalNaver: false }));
} catch {
  const failedStage = stage;
  try { cleanup(); } catch { cleanupPassed = false; }
  console.log(JSON.stringify({ status: "FAIL", stage: failedStage, checks, diagnostic, syntheticCleanup: cleanupPassed }));
  process.exitCode = 1;
} finally { globalThis.fetch = nativeFetch; }
