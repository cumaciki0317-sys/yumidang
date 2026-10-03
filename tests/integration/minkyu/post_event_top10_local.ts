/** 민규: 원형 HTTP factory와 로컬 Auth/PostgREST의 행사 연결·내부 Top10 통합 검사.
 * 합성 네이버 자격·사진 metadata만 사용한다. 실제 네이버/사진 업로드/외부 행사는 호출하지 않는다.
 * 총괄이 준비한 38 SQL의 빈 전용 gateway 환경만 허용하고 생성한 식별자로만 정리한다.
 * YUMIDANG_POST_EVENT_TOP10_LOCAL_CONFIG=권한0600config.json node 이파일 --run
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { createNaverSessionBridge } from "../../../backend/supabase/functions/_shared/auth/session-bridge.ts";

const API = "http://127.0.0.1:56521", ORIGIN = "http://127.0.0.1:5173";
const CONTEXT = "colima-yumidang-minkyu", CONTAINER = "supabase_db_yumidang-minkyu-gateway";
const ADDRESS = "서울특별시 성동구 합성비공개로 123", PLACE = "합성비공개장소", MEETING = "합성비공개입구 3층";
const nativeFetch = globalThis.fetch;
type Row = Record<string, any>;
let checks = 0, groups = 0, stage = "configuration", guarded = false, cleaned = false, preserved = 0;
let diagnostic: { httpStatus: number; errorCode: string } | undefined;
let upstreamDiagnostic: { rpc: string; httpStatus: number; errorCode: string } | undefined;
const users: string[] = [], posts: string[] = [], subjects: string[] = [], sources: string[] = [], rankingSources: string[] = [], calls: string[] = [];
function check(value: unknown): asserts value { if (!value) throw new Error("check_failed"); checks++; }
const row = (value: unknown): Row => { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Row; };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const safeSource = (value: string) => /^[a-z0-9-]+$/.test(value);
const quoted = (values: string[]) => values.map(value => { check(uuid(value) || safeSource(value)); return `'${value}'`; }).join(",");
const sql = (input: string) => execFileSync("docker", ["--context", CONTEXT, "exec", "-i", CONTAINER,
  "psql", "-U", "postgres", "-d", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
  { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576 }).trim();
const tables = ["auth.users", "public.profiles", "public.posts", "private.naver_accounts", "private.naver_sessions",
  "private.source_events", "private.kopis_top10_snapshots", "private.worker_jobs", "private.service_post_inputs",
  "private.post_search_locations", "public.post_private_details", "public.join_requests", "public.appointments",
  "private.match_consents", "private.match_consent_lifecycle", "private.match_lifecycle_events", "public.chat_messages",
  "public.notifications", "private.completion_reservations", "private.appointment_cancellations",
  "private.appointment_schedule_changes", "public.appointment_completion_confirmations"];
const counts = () => sql(`select jsonb_build_array(${tables.map(table => `(select count(*) from ${table})`).join(",")},
  (select count(*) from storage.objects where bucket_id='profile-images'))::text;`);
const empty = () => { const values = JSON.parse(counts()); check(Array.isArray(values) && values.length === tables.length + 1 && values.every(value => value === 0)); };
function cleanup() {
  if (!guarded) return;
  // A bridge failure can occur after native Auth creation. Adopt only this runner's exact subjects.
  if (subjects.length) {
    const found = sql(`select u.id from auth.users u join private.naver_accounts n on n.auth_email=u.email where n.subject in (${quoted(subjects)});`);
    for (const id of found.split("\n").filter(Boolean)) { check(uuid(id)); if (!users.includes(id)) users.push(id); }
  }
  check(users.every(uuid) && posts.every(uuid) && sources.every(safeSource) && rankingSources.every(safeSource));
  const userList = users.length ? quoted(users) : "null", postList = posts.length ? quoted(posts) : "null";
  const subjectList = subjects.length ? quoted(subjects) : "null", sourceList = sources.length ? quoted(sources) : "null";
  const rankList = rankingSources.length ? quoted(rankingSources) : "null";
  sql(`begin; set local storage.allow_delete_query='true';
    delete from public.posts where id in (${postList});
    delete from private.naver_accounts where user_id in (${userList}) or subject in (${subjectList});
    delete from public.profiles where id in (${userList});
    delete from storage.objects where bucket_id='profile-images' and owner_id in (${userList});
    delete from auth.users where id in (${userList});
    delete from private.source_events where provider='kopis' and source_id in (${sourceList});
    delete from private.kopis_top10_snapshots s where s.mode in ('all','musical') and not exists
      (select 1 from jsonb_array_elements(s.snapshot->'items') i where i->>'sourceId' not in (${rankList}));
    commit;`);
  empty(); cleaned = true;
}
async function run() {
  check(process.argv.length === 3 && process.argv[2] === "--run");
  const filename = process.env.YUMIDANG_POST_EVENT_TOP10_LOCAL_CONFIG;
  check(typeof filename === "string" && filename.startsWith("/"));
  const probe = fileURLToPath(new URL("gateway_cors_local.py", import.meta.url));
  // Reuse the official preparation guard: private config, exact context/project, source copies and all 38 SQL.
  const guardScript = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('event_http_guard',sys.argv[1])
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
cfg=m.read_config(sys.argv[2]);p=m.source_guards(cfg['EDGE_ROOT']);m.target_guard()
print(json.dumps({'preserved':p,'empty':True}))`;
  const proof = row(JSON.parse(execFileSync("python3", ["-c", guardScript, probe, filename],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60000, maxBuffer: 1048576 })));
  check(proof.preserved === 135 && proof.empty === true); preserved = proof.preserved;
  empty(); guarded = true;
  const cfg = row(JSON.parse(readFileSync(filename, "utf8")));
  check(Object.keys(cfg).sort().join(",") === "ANON_KEY,API_URL,EDGE_ROOT,INTERNAL_WORKER_SECRET,SERVICE_ROLE_KEY" && cfg.API_URL === API);
  const names = new Set(["resolve_naver_account", "record_naver_session", "complete_naver_signup", "create_service_post", "get_service_post",
    "update_service_post", "request_service_post", "propose_match", "get_match_consent", "accept_match", "cancel_appointment",
    "search_public_posts_v2", "upsert_events", "store_kopis_top10_snapshot", "get_kopis_top10_snapshot"]);
  const guardedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    check(url.origin === API && !url.username && !url.password && !url.search && !url.hash);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const rpc = /^\/rest\/v1\/rpc\/([a-z][a-z0-9_]*)$/.exec(url.pathname);
    check((url.pathname === "/auth/v1/user" && method === "GET") ||
      (["/auth/v1/admin/generate_link", "/auth/v1/verify"].includes(url.pathname) && method === "POST") ||
      (rpc !== null && names.has(rpc[1]) && method === "POST"));
    calls.push(url.pathname);
    const result = await nativeFetch(input, { ...init, redirect: "error" });
    if (!result.ok && rpc) {
      let errorCode = "UNEXPECTED_RESPONSE";
      try { const payload = await result.clone().json(); if (typeof payload?.code === "string" && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3}|PT[0-9]{3})$/.test(payload.code)) errorCode = payload.code; } catch { /* 원문은 기록하지 않는다. */ }
      upstreamDiagnostic = { rpc: rpc[1], httpStatus: result.status, errorCode };
    }
    return result;
  };
  globalThis.fetch = guardedFetch;
  const config = { supabaseUrl: API, supabaseAnonKey: cfg.ANON_KEY as string, supabaseServiceRoleKey: cfg.SERVICE_ROLE_KEY as string,
    allowedOrigins: [ORIGIN], maxRequestBytes: 8192, upstreamTimeoutMs: 10000 };
  const env: Record<string, string> = { SUPABASE_URL: API, SUPABASE_ANON_KEY: cfg.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY,
    INTERNAL_WORKER_SECRET: cfg.INTERNAL_WORKER_SECRET, ALLOWED_ORIGINS: JSON.stringify([ORIGIN]), MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "10000" };
  const service = createRuntimeHandler(key => env[key]);
  let gatewayCalls = 0;
  const gateway = async (request: Request) => {
    const url = new URL(request.url);
    check(url.origin === API && url.pathname.startsWith("/functions/v1/service-api/") && !url.username && !url.password && !url.hash);
    gatewayCalls++; return nativeFetch(request, { redirect: "error", signal: AbortSignal.timeout(15000) });
  };
  const request = (path: string, token?: string, body?: unknown, method?: string) => new Request(`${API}/functions/v1/service-api/${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"), headers: { origin: ORIGIN,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const codes = new Set(["AUTH_REQUIRED", "ACCESS_DENIED", "RESOURCE_NOT_FOUND", "INVALID_REQUEST", "STATE_CONFLICT", "METHOD_NOT_ALLOWED", "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR"]);
  const inspect = async (response: Response) => {
    const value = row(await response.json()), code = value.error && row(value.error).code;
    diagnostic = { httpStatus: response.status, errorCode: codes.has(code) ? code : value.error ? "UNEXPECTED_RESPONSE" : "NONE" };
    check(response.headers.get("cache-control") === "no-store" && response.headers.get("access-control-allow-origin") === ORIGIN);
    check(value.requestId === response.headers.get("x-request-id")); return value;
  };
  const success = async (response: Response) => { const value = await inspect(response); check(response.status === 200 && !value.error); diagnostic = undefined; upstreamDiagnostic = undefined; return row(value.data); };
  const fail = async (response: Response, status: number, code: string) => { const value = await inspect(response); check(response.status === status && row(value.error).code === code && value.data === undefined); diagnostic = undefined; upstreamDiagnostic = undefined; };
  const get = async (path: string, token?: string) => success(await service(request(path, token)));
  const post = async (path: string, token: string, body: unknown) => success(await service(request(path, token, body)));
  const rpc = async (name: string, args: Row, token: string) => {
    const response = await guardedFetch(`${API}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: cfg.ANON_KEY,
      authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
    check(response.ok); return row(await response.json());
  };
  const member = async (name: string) => {
    const subject = "event-http-" + crypto.randomUUID(); subjects.push(subject);
    const account = await rpc("resolve_naver_account", { p_subject: subject, p_name: name, p_gender: "F", p_birth_date: "2000-01-01" }, cfg.SERVICE_ROLE_KEY);
    check(account.status === "photo_required");
    const session = await createNaverSessionBridge(config, guardedFetch).issue(account.authEmail, null);
    check(uuid(session.userId) && uuid(session.sessionId)); users.push(session.userId);
    await rpc("record_naver_session", { p_subject: subject, p_user_id: session.userId, p_session_id: session.sessionId }, cfg.SERVICE_ROLE_KEY);
    const image = crypto.randomUUID(), avatar = `${session.userId}/${image}.jpg`; check(uuid(image));
    sql(`insert into storage.objects(bucket_id,name,owner_id,metadata) values ('profile-images','${avatar}','${session.userId}','{"mimetype":"image/jpeg","size":128}');`);
    check((await rpc("complete_naver_signup", { p_avatar_path: avatar, p_interests: [], p_conversation_styles: [], p_mbti: null }, session.accessToken)).status === "ready");
    return { uid: session.userId, token: session.accessToken, name };
  };
  stage = "native_auth_qualified";
  const author = await member("가상작성자"), peer = await member("가상신청자"), outsider = await member("가상외부인"); groups++;
  const baseTime = Date.now(), iso = (days: number) => new Date(baseTime + days * 86400000).toISOString();
  const day = (days: number) => new Date(baseTime + days * 86400000 + 9 * 3600000).toISOString().slice(0, 10);
  const sourceA = "event-http-" + crypto.randomUUID(), sourceB = "event-http-" + crypto.randomUUID(); sources.push(sourceA, sourceB);
  const eventA: Row = { provider: "kopis", sourceId: sourceA, sourceStatus: "active", title: "합성행사첫제목", category: "뮤지컬", region: "서울",
    placeName: "합성공개공연장", publicAddress: "서울 합성공개주소", admission: { kind: "unknown" }, sourceUrl: null,
    collectedAt: new Date(baseTime).toISOString(), precision: "date", startsOn: day(-1), endsOn: day(30) };
  const eventB: Row = { ...eventA, sourceId: sourceB, title: "합성두번째행사", precision: "instant", startsAt: iso(1), endsAt: iso(2) };
  delete eventB.startsOn; delete eventB.endsOn;
  stage = "canonical_event_fixtures";
  const stored = await rpc("upsert_events", { p_events: [eventA, eventB] }, cfg.SERVICE_ROLE_KEY); check(stored.insertedCount === 2);
  const eventId = (source: string) => { check(safeSource(source)); const id = sql(`select id from private.source_events where provider='kopis' and source_id='${source}';`); check(uuid(id)); return id; };
  const a = eventId(sourceA), b = eventId(sourceB); groups++;
  const input: Row = { title: "행사 연결 합성 공고", description: "실제 사용자 자료가 아닌 로컬 통합 검사", category: "공연", startsAt: iso(7), endsAt: iso(7.05),
    publicArea: "서울특별시 성동구 성수동", registeredPlaceName: PLACE, registeredAddress: ADDRESS, meetingDetail: MEETING, costType: "free", amount: 0 };
  const newId = () => { const id = crypto.randomUUID(); check(uuid(id)); posts.push(id); return id; };
  const id = newId(), endpoint = `posts/${id}`, original = { postId: id, ...input, eventId: a };
  stage = "event_create_retry_and_privacy";
  check((await success(await gateway(request("posts", author.token, original)))).postId === id);
  check((await post("posts", author.token, original)).postId === id);
  await fail(await service(request("posts", author.token, { ...original, eventId: b })), 409, "STATE_CONFLICT");
  const owner = await get(endpoint, author.token); check(owner.eventId === a && owner.linkedEvent.title === eventA.title && owner.linkedEvent.state === "ongoing");
  const restricted = (value: Row) => {
    check(!Object.hasOwn(value, "privateDetails") && !Object.hasOwn(value, "participantNames"));
    check(![ADDRESS, PLACE, MEETING, author.uid, peer.uid, author.name, peer.name].some(secret => JSON.stringify(value).includes(secret)));
    check(value.linkedEvent.publicAddress === eventA.publicAddress);
  };
  restricted(await get(endpoint)); restricted(await get(endpoint, peer.token));
  check(owner.privateDetails.registeredAddress === ADDRESS && owner.privateDetails.meetingDetail === MEETING);
  const plain = newId(); check((await post("posts", author.token, { postId: plain, ...input })).postId === plain);
  const unlinked = await get(`posts/${plain}`); check(unlinked.eventId === null && unlinked.linkedEvent === null);
  for (const invalid of ["", true, {}, crypto.randomUUID()]) await fail(await service(request("posts", author.token, { postId: newId(), ...input, eventId: invalid })), 400, "INVALID_REQUEST");
  await fail(await service(request("posts", undefined, { postId: newId(), ...input, eventId: a })), 401, "AUTH_REQUIRED"); groups++;
  stage = "omission_and_manual_consent_versions";
  const pending = await post(`${endpoint}/requests`, peer.token, { message: "합성 행사 연결 조건을 확인하는 신청입니다." }); check(uuid(pending.id));
  const consent = () => get(`requests/${pending.id}/consent`, peer.token);
  const propose = () => post(`requests/${pending.id}/propose`, author.token, {});
  let version = (await propose()).conditionVersion; check(typeof version === "string");
  const update = async (fields: Row, deployed = false) => {
    const current = await get(endpoint, author.token), next = request(`${endpoint}/update`, author.token, { ...input, ...fields, expectedUpdatedAt: current.updatedAt });
    return success(await (deployed ? gateway(next) : service(next)));
  };
  const fingerprint = () => sql(`select private.match_condition_version('${id}');`);
  const history = () => sql(`select md5(input::text) from private.service_post_inputs where post_id='${id}';`);
  const oldHash = fingerprint(), oldHistory = history();
  await update({}, true); check((await get(endpoint)).eventId === a && fingerprint() === oldHash && (await consent()).conditionVersion === version);
  await update({ eventId: b }, true); check((await consent()).status === "invalidated" && fingerprint() !== oldHash);
  await fail(await service(request(`requests/${pending.id}/accept`, peer.token, { conditionVersion: version })), 409, "STATE_CONFLICT");
  const swapVersion = (await propose()).conditionVersion; check(swapVersion !== version); version = swapVersion;
  await update({ eventId: null }, true); check((await consent()).status === "invalidated" && (await get(endpoint)).linkedEvent === null);
  const clearedVersion = (await propose()).conditionVersion; check(clearedVersion !== version); version = clearedVersion;
  await update({ eventId: a }); check((await consent()).status === "invalidated");
  const selectedVersion = (await propose()).conditionVersion; check(selectedVersion !== version); version = selectedVersion;
  check(history() === oldHistory); groups++;
  stage = "provider_latest_without_post_mutation";
  const before = await get(endpoint, author.token), beforeHash = fingerprint();
  const latest = { ...eventA, title: "최신행사검색검사제목", placeName: "합성최신공개공연장", sourceStatus: "cancelled", startsOn: day(20), endsOn: day(31), collectedAt: new Date(baseTime + 1000).toISOString() };
  stage = "provider_update_native_rpc";
  check((await rpc("upsert_events", { p_events: [latest] }, cfg.SERVICE_ROLE_KEY)).updatedCount === 1);
  stage = "provider_latest_gateway_detail";
  const after = await success(await gateway(request(endpoint, author.token)));
  check(after.linkedEvent.title === latest.title && after.linkedEvent.placeName === latest.placeName && after.linkedEvent.sourceStatus === "cancelled");
  check(after.startsAt === before.startsAt && after.endsAt === before.endsAt && after.updatedAt === before.updatedAt && fingerprint() === beforeHash && history() === oldHistory);
  stage = "provider_update_preserves_consent";
  check((await consent()).status === "awaiting_consent" && (await consent()).conditionVersion === version);
  stage = "provider_cancelled_same_selection_update";
  await update({ eventId: a }); check((await consent()).conditionVersion === version && (await consent()).status === "awaiting_consent");
  stage = "provider_cancelled_original_create_retry";
  check((await post("posts", author.token, original)).postId === id);
  stage = "provider_cancelled_new_selection_denied";
  await fail(await service(request("posts", author.token, { postId: newId(), ...input, eventId: a })), 400, "INVALID_REQUEST");
  stage = "provider_latest_title_public_search";
  const search = await get(`posts?query=${encodeURIComponent(latest.title)}`, peer.token);
  check(search.status === "results" && Array.isArray(search.posts));
  const card = row(search.posts.find((p: Row) => p.id === id));
  check(Object.keys(card).sort().join(",") === "authorDisplayName,canApply,cost,endsAt,id,publicArea,startsAt,state,title");
  check(!JSON.stringify(card).includes(ADDRESS) && !Object.hasOwn(card, "linkedEvent")); groups++;
  stage = "confirmed_and_cancelled_event_permissions";
  const accepted = await post(`requests/${pending.id}/accept`, peer.token, { conditionVersion: version }); check(uuid(accepted.appointmentId));
  const pair = await get(endpoint, peer.token); check(pair.privateDetails.registeredAddress === ADDRESS && pair.authorDisplayName === author.name && pair.linkedEvent.title === latest.title);
  restricted(await get(endpoint, outsider.token));
  check((await post(`appointments/${accepted.appointmentId}/cancel`, author.token, { cancellationId: crypto.randomUUID(), reason: "합성 일정 취소 검사" })).status === "cancelled");
  restricted(await get(endpoint, peer.token)); groups++;
  stage = "internal_top10_auth_and_routes";
  const rankPath = "internal/events/kopis-top10", secret = cfg.INTERNAL_WORKER_SECRET;
  const beforeCalls = calls.length;
  await fail(await service(request(`${rankPath}/all`)), 401, "AUTH_REQUIRED");
  for (const token of [peer.token, cfg.SERVICE_ROLE_KEY, cfg.ANON_KEY, "synthetic-wrong-worker-secret"]) await fail(await service(request(`${rankPath}/all`, token)), 403, "ACCESS_DENIED");
  check(calls.length === beforeCalls);
  await fail(await service(request(`${rankPath}/invalid`, secret)), 400, "INVALID_REQUEST");
  await fail(await service(request(`${rankPath}/all/extra`, secret)), 404, "RESOURCE_NOT_FOUND");
  await fail(await service(request(`${rankPath}/all?mode=all`, secret)), 400, "INVALID_REQUEST");
  await fail(await service(request(`${rankPath}/all`, secret, {}, "POST")), 405, "METHOD_NOT_ALLOWED");
  await fail(await service(request(rankPath, secret)), 405, "METHOD_NOT_ALLOWED");
  for (const body of [{}, { snapshot: [] }, { snapshot: {}, extra: true }]) await fail(await service(request(rankPath, secret, body)), 400, "INVALID_REQUEST");
  const unavailable = await get(`${rankPath}/all`, secret); check(unavailable.status === "unavailable" && unavailable.items.length === 0 && unavailable.collectedAt === null);
  check(unavailable.responsePeriod === null && unavailable.periodVerification === "requested_only"); groups++;
  const snapshot = (mode: string, size: number, offset: number): Row => ({ mode, requestedPeriod: { start: day(-7), end: day(-1) }, collectedAt: new Date(baseTime + offset).toISOString(),
    items: Array.from({ length: size }, (_, i) => { const sourceId = `event-http-rank-${mode}-${i + 1}-${subjects[0]}`; if (!rankingSources.includes(sourceId)) rankingSources.push(sourceId);
      return { rank: i + 1, sourceId, title: `합성공식형식순위 ${i + 1}`, genre: mode === "musical" ? "뮤지컬" : "연극", performancePeriodText: "2026.09.01 ~ 2026.11.01", placeName: "합성공개공연장", region: "서울" }; }) });
  stage = "top10_retry_stale_atomic_modes";
  const initial = snapshot("all", 2, 0), saved = await success(await gateway(request(rankPath, secret, { snapshot: initial })));
  check(saved.status === "saved" && saved.itemCount === 2 && saved.deduplicated === false);
  check((await post(rankPath, secret, { snapshot: initial })).deduplicated === true);
  const conflicting = structuredClone(initial); conflicting.items[0].title = "같은시각다른순위";
  await fail(await service(request(rankPath, secret, { snapshot: conflicting })), 409, "STATE_CONFLICT");
  const stale = await post(rankPath, secret, { snapshot: snapshot("all", 1, -1000) }); check(stale.status === "stale" && stale.itemCount === 2);
  const newest = snapshot("all", 3, 1000); check((await post(rankPath, secret, { snapshot: newest })).itemCount === 3);
  const malformed = snapshot("all", 4, 2000); malformed.items[3].region = null;
  await fail(await service(request(rankPath, secret, { snapshot: malformed })), 400, "INVALID_REQUEST");
  const available = await success(await gateway(request(`${rankPath}/all`, secret)));
  stage = "top10_current_structural_projection";
  check(available.status === "available" && available.source === "kopis" && available.mode === "all" && available.collectedAt === newest.collectedAt);
  // JSONB의 객체 키 순서는 무관하다. 배열 순위와 모든 필드 값은 구조적으로 동일해야 한다.
  deepStrictEqual(available.items, newest.items); checks++;
  deepStrictEqual(available.requestedPeriod, newest.requestedPeriod); checks++;
  check(available.responsePeriod === null && available.periodVerification === "requested_only");
  stage = "top10_musical_mode_isolation";
  check((await get(`${rankPath}/musical`, secret)).status === "unavailable");
  const musical = snapshot("musical", 10, 3000); check((await post(rankPath, secret, { snapshot: musical })).itemCount === 10);
  check((await get(`${rankPath}/musical`, secret)).items.length === 10 && (await get(`${rankPath}/all`, secret)).items.length === 3);
  stage = "top10_direct_rpc_role_denial";
  for (const [token, expectedStatus] of [[peer.token, 403], [cfg.ANON_KEY, 401]] as const) {
    const denied = await guardedFetch(`${API}/rest/v1/rpc/get_kopis_top10_snapshot`, { method: "POST", headers: { apikey: cfg.ANON_KEY, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ p_mode: "all" }) });
    const error = row(await denied.json()); check(denied.status === expectedStatus && error.code === "42501");
  }
  check(calls.filter(path => path === "/auth/v1/admin/generate_link").length === 3 && calls.filter(path => path === "/auth/v1/verify").length === 3);
  check(gatewayCalls >= 7); groups++;
}
try {
  await run(); stage = "synthetic_cleanup"; cleanup();
  console.log(JSON.stringify({ status: "PASS", groups, checks, preserved, cleanupTables: tables.length + 1, syntheticCleanup: cleaned, nativeAuth: true, nativeRpc: true, inProcessHttp: true, deployedGateway: true, actualPhotoUpload: false, externalNaver: false, externalAI: false, remote: false }));
} catch {
  const failedStage = stage; try { cleanup(); } catch { cleaned = false; }
  console.log(JSON.stringify({ status: "FAIL", stage: failedStage, groups, checks, diagnostic, upstreamDiagnostic, syntheticCleanup: cleaned })); process.exitCode = 1;
} finally { globalThis.fetch = nativeFetch; }
