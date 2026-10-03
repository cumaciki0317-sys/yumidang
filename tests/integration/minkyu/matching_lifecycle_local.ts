/** 민규: 전용 임시 Auth·PostgREST·SQL과 실제 서비스 handler 연결을 검사한다.
 * 네이버 응답과 사진 객체 메타데이터는 합성 자료다. 브라우저·실제 업로드·Edge gateway는 별도다.
 * YUMIDANG_MATCHING_LOCAL_CONFIG=권한0600임시status.json node 이파일
 * 초기 Auth 계정 0개인 yumidang-minkyu-matching(:55821)만 허용한다.
 */
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createSignupRuntimeHandler } from "../../../backend/supabase/functions/signup/index.ts";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { sha256 } from "../../../backend/supabase/functions/_shared/services/signup-service.ts";

const API = "http://127.0.0.1:55821", ORIGIN = "http://127.0.0.1:5173";
const CONTEXT = "colima-yumidang-minkyu", PROJECT = "yumidang-minkyu-matching";
const CONTAINER = "supabase_db_" + PROJECT;
const nativeFetch = globalThis.fetch;
let checks = 0, stage = "configuration";
let diagnostic: { httpStatus: number; errorCode: string } | undefined;
const check = (value: unknown) => { if (!value) throw new Error("check_failed"); checks++; };
type Row = Record<string, any>;
const row = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_response");
  return value as Row;
};
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const docker = (...args: string[]) => execFileSync("docker", ["--context", CONTEXT, ...args],
  { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576 }).trim();
const sql = (input: string) => execFileSync("docker", ["--context", CONTEXT, "exec", "-i", CONTAINER,
  "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1"],
  { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576 }).trim();

async function run() {
  const filename = process.env.YUMIDANG_MATCHING_LOCAL_CONFIG;
  check(typeof filename === "string" && filename.startsWith("/"));
  const info = lstatSync(filename!);
  check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600 && info.uid === process.getuid!());
  const path = realpathSync(filename!);
  check(path.startsWith(realpathSync(tmpdir()) + "/") || path.startsWith("/private/tmp/") || path.startsWith("/tmp/"));
  const cfg = row(JSON.parse(readFileSync(path, "utf8")));
  check(cfg.API_URL === API && typeof cfg.ANON_KEY === "string" && typeof cfg.SERVICE_ROLE_KEY === "string" && cfg.ANON_KEY !== cfg.SERVICE_ROLE_KEY);
  check(docker("context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}") === "unix://" + homedir() + "/.colima/yumidang-minkyu/docker.sock");
  const target = row(JSON.parse(docker("inspect", CONTAINER))[0]);
  check(target.Name === "/" + CONTAINER && target.Config.Labels["com.supabase.cli.project"] === PROJECT && target.State.Running === true);
  check(sql("select count(*) from auth.users;") === "0");
  check(sql("select to_regclass('private.match_consent_lifecycle') is not null;") === "t");
  const env: Record<string, string> = {
    SUPABASE_URL: API, SUPABASE_ANON_KEY: cfg.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY,
    ALLOWED_ORIGINS: JSON.stringify([ORIGIN]), MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "10000",
    NAVER_CLIENT_ID: "synthetic-client", NAVER_CLIENT_SECRET: "synthetic-secret",
    NAVER_REDIRECT_URI: ORIGIN + "/auth/naver/callback", NAVER_STATE_TTL_SECONDS: "600",
  };
  let subject = "", name = "";
  const guardedFetch: typeof fetch = async (input, init) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (address === "https://nid.naver.com/oauth2.0/token") return new Response(JSON.stringify({ access_token: "synthetic-naver-access", token_type: "bearer" }));
    if (address === "https://openapi.naver.com/v1/nid/me") return new Response(JSON.stringify({ resultcode: "00", response: { id: subject, name, gender: "F", birthyear: "2000", birthday: "01-01" } }));
    const parsed = new URL(address);
    check(parsed.origin === API && !parsed.username && !parsed.password);
    return nativeFetch(input, { ...init, redirect: "error" });
  };
  globalThis.fetch = guardedFetch;
  const signup = createSignupRuntimeHandler((key) => env[key], guardedFetch);
  const service = createRuntimeHandler((key) => env[key]);
  const request = (namespace: string, endpoint: string, token?: string, body?: unknown) => new Request(`${API}/functions/v1/${namespace}/${endpoint}`, {
    method: body === undefined ? "GET" : "POST", headers: { origin: ORIGIN,
      ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const inspect = async (response: Response) => {
    const result = row(await response.json());
    const code = result.error && typeof result.error === "object" ? result.error.code : undefined;
    const known = ["AUTH_REQUIRED", "ACCESS_DENIED", "RESOURCE_NOT_FOUND", "INVALID_REQUEST", "STATE_CONFLICT", "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR"];
    diagnostic = { httpStatus: response.status, errorCode: known.includes(code) ? code : result.error ? "UNEXPECTED_RESPONSE" : "NONE" };
    return result;
  };
  const success = async (response: Response) => {
    const result = await inspect(response); check(response.status === 200 && !result.error);
    diagnostic = undefined; return result.data;
  };
  const failure = async (response: Response, status: number, code: string) => {
    const result = await inspect(response); check(response.status === status && row(result.error).code === code); diagnostic = undefined;
  };
  const get = async (endpoint: string, token: string) => row(await success(await service(request("service-api", endpoint, token))));
  const post = async (endpoint: string, token: string, body: unknown) => row(await success(await service(request("service-api", endpoint, token, body))));
  const member = async (index: number) => {
    subject = "synthetic-matching-" + crypto.randomUUID(); name = "가상회원" + index;
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const start = row(await success(await signup(request("signup", "naver/start", undefined, { codeChallenge: await sha256(verifier), returnTo: "/" }))));
    const state = new URL(start.authorizationUrl).searchParams.get("state");
    const login = row(await success(await signup(request("signup", "naver/callback", undefined, { code: "synthetic-code", state, codeVerifier: verifier }))));
    check(login.status === "photo_required" && uuid(login.userId));
    const uid = login.userId, token = row(login.session).accessToken;
    const image = crypto.randomUUID(); check(uuid(image));
    const avatarPath = `${uid}/${image}.jpg`;
    sql(`insert into storage.objects(bucket_id,name,owner_id,metadata) values ('profile-images','${avatarPath}','${uid}','{"mimetype":"image/jpeg","size":128}');`);
    const complete = row(await success(await signup(request("signup", "complete", token, { avatarPath }))));
    check(complete.status === "ready"); return { uid, token };
  };
  stage = "actual_auth_members";
  const author = await member(1), first = await member(2), second = await member(3), outsider = await member(4);
  const input = () => ({ title: "합성 매칭 공고", description: "합성 로컬 검증용 산책", category: "산책",
    startsAt: new Date(Date.now() + 172800000).toISOString(), endsAt: new Date(Date.now() + 176400000).toISOString(),
    publicArea: "서울특별시 강남구 역삼동", registeredPlaceName: "가상 장소", registeredAddress: "서울특별시 강남구 가상주소",
    meetingDetail: "가상 만남 지점", preferenceNote: null, tags: [], costType: "free", amount: 0 });
  stage = "create_optional_recruitment_deadline";
  const postId = crypto.randomUUID(), initial = input();
  await post("posts", author.token, { postId, ...initial });
  const detail = await get(`posts/${postId}`, author.token);
  check(Date.parse(detail.recruitmentEndsAt) === Date.parse(initial.startsAt));
  const r1 = await post(`posts/${postId}/requests`, first.token, { message: "함께 산책하고 싶은 합성 신청입니다." });
  const r2 = await post(`posts/${postId}/requests`, second.token, { message: "함께 이야기할 합성 신청입니다." });
  check(uuid(r1.id) && uuid(r2.id));
  stage = "one_active_consent_withdraw_decline";
  const c1 = await post(`requests/${r1.id}/propose`, author.token, {});
  check(c1.status === "awaiting_consent" && Date.parse(c1.expiresAt) <= Date.parse(initial.startsAt));
  await failure(await service(request("service-api", `requests/${r2.id}/propose`, author.token, {})), 409, "STATE_CONFLICT");
  await post(`requests/${r1.id}/consent/withdraw`, author.token, { conditionVersion: c1.conditionVersion });
  check((await get(`requests/${r1.id}/consent`, first.token)).status === "withdrawn");
  const c2 = await post(`requests/${r2.id}/propose`, author.token, {});
  await post(`requests/${r2.id}/consent/decline`, second.token, { conditionVersion: c2.conditionVersion });
  check((await get(`requests/${r2.id}/consent`, second.token)).status === "declined");
  stage = "closed_post_preserves_existing_requests";
  await post(`posts/${postId}/close`, author.token, {});
  await failure(await service(request("service-api", `posts/${postId}/requests`, outsider.token, { message: "수동 마감 이후의 새로운 신청입니다." })), 409, "STATE_CONFLICT");
  const renewed = await post(`requests/${r2.id}/propose`, author.token, {});
  check(renewed.conditionVersion !== c2.conditionVersion);
  stage = "edit_invalidates_and_optimistic_conflict";
  const beforeEdit = await get(`posts/${postId}`, author.token);
  const changed = { ...initial, description: "수정된 합성 로컬 산책 활동" };
  await post(`posts/${postId}/update`, author.token, { ...changed, expectedUpdatedAt: beforeEdit.updatedAt });
  check((await get(`requests/${r2.id}/consent`, second.token)).status === "invalidated");
  await failure(await service(request("service-api", `posts/${postId}/update`, author.token, { ...initial, expectedUpdatedAt: beforeEdit.updatedAt })), 409, "STATE_CONFLICT");
  await failure(await service(request("service-api", `requests/${r2.id}/accept`, second.token, { conditionVersion: renewed.conditionVersion })), 409, "STATE_CONFLICT");
  stage = "final_match_closes_unselected_conversation";
  const finalConsent = await post(`requests/${r2.id}/propose`, author.token, {});
  const matched = await post(`requests/${r2.id}/accept`, second.token, { conditionVersion: finalConsent.conditionVersion });
  check(uuid(matched.appointmentId) && matched.alreadyConfirmed === false);
  check((await post(`requests/${r2.id}/accept`, second.token, { conditionVersion: finalConsent.conditionVersion })).alreadyConfirmed === true);
  const conversation = await success(await service(request("service-api", `conversations/${r1.id}`, first.token)));
  const conversationRow = row(Array.isArray(conversation) ? conversation[0] : conversation);
  check(conversationRow.request_status === "not_selected" && conversationRow.can_send === false);
  await failure(await service(request("service-api", `conversations/${r1.id}/messages`, first.token, { messageId: crypto.randomUUID(), content: "종료된 대화에 쓰기를 시도합니다." })), 403, "ACCESS_DENIED");
  check((await get(`posts/${postId}`, second.token)).privateDetails.registeredAddress === initial.registeredAddress);
  const hidden = await get(`posts/${postId}`, first.token); check(!hidden.privateDetails && !hidden.participantNames);
  const outsiderDetail = await get(`posts/${postId}`, outsider.token); check(!outsiderDetail.privateDetails && !outsiderDetail.participantNames);
  await failure(await service(request("service-api", `posts/${postId}/delete`, author.token, {})), 409, "STATE_CONFLICT");
  stage = "withdraw_reapply_soft_delete";
  const otherId = crypto.randomUUID(); await post("posts", author.token, { postId: otherId, ...input() });
  const initialRequest = await post(`posts/${otherId}/requests`, first.token, { message: "철회 후 다시 신청하는 합성 신청입니다." });
  await success(await service(request("service-api", `requests/${initialRequest.id}/withdraw`, first.token, {})));
  const again = await post(`posts/${otherId}/requests`, first.token, { message: "다시 신청하는 합성 메시지입니다." });
  check(again.id !== initialRequest.id && again.status === "pending");
  const previousConversation = await success(await service(request("service-api", `conversations/${initialRequest.id}`, first.token)));
  check(row(Array.isArray(previousConversation) ? previousConversation[0] : previousConversation).can_send === false);
  await post(`requests/${again.id}/propose`, author.token, {});
  await post(`posts/${otherId}/delete`, author.token, {});
  await post(`posts/${otherId}/delete`, author.token, {});
  await failure(await service(request("service-api", `posts/${otherId}`, first.token)), 404, "RESOURCE_NOT_FOUND");
  const archived = await success(await service(request("service-api", `conversations/${again.id}`, first.token)));
  check(row(Array.isArray(archived) ? archived[0] : archived).can_send === false);
  stage = "complete";
  process.stdout.write(JSON.stringify({ status: "PASS", checks, realAuth: true, realDatabase: true, naver: "synthetic", imageUpload: "NOT_RUN", gateway: "NOT_RUN" }) + "\n");
}
try { await run(); }
catch { process.stderr.write(JSON.stringify({ status: "FAIL", stage, checks, ...(diagnostic ?? {}) }) + "\n"); process.exitCode = 1; }
finally { globalThis.fetch = nativeFetch; }
