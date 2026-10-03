/** 민규: 순차 백엔드 구현의 실제 로컬 Auth·DB·HTTP handler 통합 검사.
 * 초기 계정 0개인 임시 yumidang-minkyu-ordered(:56021)만 허용한다.
 * 계정 자격 입력과 사진 객체 메타데이터는 합성. 외부 네이버·AI·실제 업로드·gateway 검사는 아니다.
 * YUMIDANG_ORDERED_LOCAL_CONFIG=권한0600임시status.json node 이파일 --phase 1
 */
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { createNaverSessionBridge } from "../../../backend/supabase/functions/_shared/auth/session-bridge.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
const API = "http://127.0.0.1:56021", ORIGIN = "http://127.0.0.1:5173";
const CONTEXT = "colima-yumidang-minkyu", PROJECT = "yumidang-minkyu-ordered", CONTAINER = "supabase_db_" + PROJECT;
const nativeFetch = globalThis.fetch;
let checks = 0, stage = "configuration";
let diagnostic: { httpStatus: number; errorCode: string } | undefined;
type Row = Record<string, any>;
const row = (value: unknown): Row => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_response");
  return value as Row;
};
const firstRow = (value: unknown) => row(Array.isArray(value) ? value[0] : value);
const check = (value: unknown) => { if (!value) throw new Error("check_failed"); checks++; };
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const docker = (...args: string[]) => execFileSync("docker", ["--context", CONTEXT, ...args],
  { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576 }).trim();
const sql = (input: string) => execFileSync("docker", ["--context", CONTEXT, "exec", "-i", CONTAINER,
  "psql", "-U", "postgres", "-d", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
  { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576 }).trim();

async function run() {
  const phase = process.argv[process.argv.indexOf("--phase") + 1]; check(["1", "2", "3"].includes(phase));
  const filename = process.env.YUMIDANG_ORDERED_LOCAL_CONFIG; check(typeof filename === "string" && filename.startsWith("/"));
  const info = lstatSync(filename!);
  check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600 && info.uid === process.getuid!());
  const path = realpathSync(filename!); check(path.startsWith(realpathSync(tmpdir()) + "/") || path.startsWith("/private/tmp/") || path.startsWith("/tmp/"));
  const cfg = row(JSON.parse(readFileSync(path, "utf8")));
  check(cfg.API_URL === API && typeof cfg.ANON_KEY === "string" && typeof cfg.SERVICE_ROLE_KEY === "string" && cfg.ANON_KEY !== cfg.SERVICE_ROLE_KEY);
  check(docker("context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}") === "unix://" + homedir() + "/.colima/yumidang-minkyu/docker.sock");
  const target = row(JSON.parse(docker("inspect", CONTAINER))[0]);
  check(target.Name === "/" + CONTAINER && target.Config.Labels["com.supabase.cli.project"] === PROJECT && target.State.Running === true);
  check(sql("select count(*) from auth.users;") === "0");
  const guardedFetch: typeof fetch = async (input, init) => {
    const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(address); check(parsed.origin === API && !parsed.username && !parsed.password);
    return nativeFetch(input, { ...init, redirect: "error" });
  };
  globalThis.fetch = guardedFetch;
  const config = { supabaseUrl: API, supabaseAnonKey: cfg.ANON_KEY as string, supabaseServiceRoleKey: cfg.SERVICE_ROLE_KEY as string,
    allowedOrigins: [ORIGIN], maxRequestBytes: 8192, upstreamTimeoutMs: 10000 };
  const internalSecret = "synthetic-" + crypto.randomUUID() + crypto.randomUUID();
  const env: Record<string, string> = { SUPABASE_URL: API, SUPABASE_ANON_KEY: cfg.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY,
    INTERNAL_WORKER_SECRET: internalSecret,
    ALLOWED_ORIGINS: JSON.stringify([ORIGIN]), MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "10000" };
  const service = createRuntimeHandler(key => env[key]);
  const request = (endpoint: string, token: string, body?: unknown) => new Request(`${API}/functions/v1/service-api/${endpoint}`, {
    method: body === undefined ? "GET" : "POST", headers: { origin: ORIGIN, ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const inspect = async (response: Response) => {
    const result = row(await response.json()); const code = result.error && typeof result.error === "object" ? result.error.code : undefined;
    diagnostic = { httpStatus: response.status, errorCode: ["AUTH_REQUIRED", "ACCESS_DENIED", "RESOURCE_NOT_FOUND", "INVALID_REQUEST", "STATE_CONFLICT", "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR"].includes(code) ? code : result.error ? "UNEXPECTED_RESPONSE" : "NONE" }; return result;
  };
  const success = async (response: Response) => { const value = await inspect(response); check(response.status === 200 && !value.error); diagnostic = undefined; return value.data; };
  const fail = async (response: Response, status: number, code: string) => { const value = await inspect(response); check(response.status === status && row(value.error).code === code); diagnostic = undefined; };
  const get = async (endpoint: string, token: string) => success(await service(request(endpoint, token)));
  const post = async (endpoint: string, token: string, body: unknown) => success(await service(request(endpoint, token, body)));
  const rpc = async (name: string, args: Row, token: string) => {
    const response = await guardedFetch(`${API}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: cfg.ANON_KEY,
      authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
    check(response.ok); return response.json();
  };
  const member = async (index: number) => {
    const subject = "ordered-synthetic-" + crypto.randomUUID();
    const account = row(await rpc("resolve_naver_account", { p_subject: subject, p_name: "가상회원" + index, p_gender: "F", p_birth_date: "2000-01-01" }, cfg.SERVICE_ROLE_KEY));
    check(account.status === "photo_required");
    const session = await createNaverSessionBridge(config, guardedFetch).issue(account.authEmail, null);
    check(uuid(session.userId) && uuid(session.sessionId));
    await rpc("record_naver_session", { p_subject: subject, p_user_id: session.userId, p_session_id: session.sessionId }, cfg.SERVICE_ROLE_KEY);
    const image = crypto.randomUUID(), uid = session.userId, avatarPath = `${uid}/${image}.jpg`; check(uuid(image));
    sql(`insert into storage.objects(bucket_id,name,owner_id,metadata) values ('profile-images','${avatarPath}','${uid}','{"mimetype":"image/jpeg","size":128}');`);
    check(row(await rpc("complete_naver_signup", { p_avatar_path: avatarPath, p_interests: [], p_conversation_styles: [], p_mbti: null }, session.accessToken)).status === "ready");
    return { uid, token: session.accessToken };
  };
  stage = "actual_auth_accounts"; const author = await member(1), peer = await member(2);
  const match = async (day: number) => {
    const pid = crypto.randomUUID(); check(uuid(pid));
    await post("posts", author.token, { postId: pid, title: "순차 구현 합성 공고", description: "로컬 검증용 산책", category: "산책",
      startsAt: new Date(Date.now() + day * 86400000).toISOString(), endsAt: new Date(Date.now() + day * 86400000 + 3600000).toISOString(),
      publicArea: "서울특별시 강남구 역삼동", registeredAddress: "서울특별시 강남구 가상주소", meetingDetail: "가상 입구", costType: "free", amount: 0 });
    const requested = row(await post(`posts/${pid}/requests`, peer.token, { message: "실제 서비스 자료가 아닌 합성 신청입니다." })); check(uuid(requested.id));
    const consent = row(await post(`requests/${requested.id}/propose`, author.token, {}));
    const matched = row(await post(`requests/${requested.id}/accept`, peer.token, { conditionVersion: consent.conditionVersion })); check(uuid(matched.appointmentId));
    return { pid, rid: requested.id, aid: matched.appointmentId };
  };
  const finishWindow = (pid: string) => {
    check(uuid(pid)); sql(`update public.posts set starts_at=clock_timestamp()-interval '2 hours',ends_at=clock_timestamp()-interval '1 hour',recruitment_ends_at=clock_timestamp()-interval '3 hours' where id='${pid}';`);
  };
  stage = "praise_catalog"; const catalog = row(await get("reviews/praises", author.token)); check(catalog.items.length === 6);
  const praise = row(catalog.items[0]).code; check(typeof praise === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(praise));
  stage = "individual_confirmation_early_review"; const first = await match(2);
  await fail(await service(request(`appointments/${first.aid}/confirm-completion`, author.token, {})), 400, "INVALID_REQUEST");
  finishWindow(first.pid);
  check(firstRow(await get(`appointments/${first.aid}/reviews`, author.token)).can_write === false);
  const confirmed = firstRow(await post(`appointments/${first.aid}/confirm-completion`, author.token, {}));
  check(confirmed.status === "confirmed" && confirmed.completed_at === null);
  check(firstRow(await get(`appointments/${first.aid}/reviews`, author.token)).can_write === true);
  const review = { rating: 5, experience: "positive", comment: "합성 회원과 즐겁게 산책했어요", praises: [praise] };
  await post(`appointments/${first.aid}/reviews`, author.token, review);
  const waiting = firstRow(await get(`appointments/${first.aid}/reviews`, peer.token)); check(waiting.released === false && waiting.peer_review === null);
  const beforeComplete = row(await get(`profiles/${peer.uid}/reviews`, author.token));
  check(beforeComplete.completedCount === 0 && beforeComplete.reviews.length === 0 && beforeComplete.praisesTop5.length === 0);
  stage = "actual_completion_deadline_count";
  const completed = firstRow(await post(`appointments/${first.aid}/confirm-completion`, peer.token, {}));
  check(completed.status === "completed" && Number.isFinite(Date.parse(completed.completed_at)));
  const state = firstRow(await get(`appointments/${first.aid}/reviews`, peer.token));
  check(Date.parse(state.deadline_at) - Date.parse(completed.completed_at) === 7 * 86400000 && state.released === false);
  check(row(await get(`profiles/${peer.uid}/reviews`, author.token)).completedCount === 1);
  stage = "both_reviews_release_immutable";
  await post(`appointments/${first.aid}/reviews`, peer.token, { rating: 4, experience: "neutral", comment: null, praises: [] });
  const released = firstRow(await get(`appointments/${first.aid}/reviews`, peer.token)); check(released.released === true && released.peer_review.comment === review.comment);
  const publicReviews = row(await get(`profiles/${peer.uid}/reviews`, author.token));
  check(publicReviews.reviews.length === 1 && publicReviews.praisesTop5[0].count === 1 && publicReviews.completedCount === 1);
  check(row(await post(`appointments/${first.aid}/reviews`, author.token, review)).deduplicated === true);
  await fail(await service(request(`appointments/${first.aid}/reviews`, author.token, { ...review, rating: 3 })), 409, "STATE_CONFLICT");
  const unchanged = firstRow(await post(`appointments/${first.aid}/confirm-completion`, author.token, {})); check(unchanged.completed_at === completed.completed_at);
  stage = "one_review_uses_completed_time"; const second = await match(4); finishWindow(second.pid);
  await post(`appointments/${second.aid}/confirm-completion`, author.token, {});
  await post(`appointments/${second.aid}/reviews`, author.token, { ...review, comment: null });
  await post(`appointments/${second.aid}/confirm-completion`, peer.token, {});
  check(firstRow(await get(`appointments/${second.aid}/reviews`, peer.token)).released === false);
  // 완료 시각과 알림 시각을 다르게 한 전용 fixture로 공개 기준을 구분한다.
  check(uuid(second.aid)); sql(`with fixture as (select clock_timestamp() at) update public.appointments set completed_at=fixture.at-interval '25 hours',review_deadline_at=fixture.at-interval '25 hours'+interval '7 days',completion_notified_at=fixture.at,dispute_deadline_at=fixture.at+interval '24 hours' from fixture where id='${second.aid}';`);
  check(firstRow(await get(`appointments/${second.aid}/reviews`, peer.token)).released === true);
  const current = row(await get(`profiles/${peer.uid}/reviews`, author.token)); check(current.completedCount === 2 && current.reviews.length === 2 && current.praisesTop5[0].count === 2);
  if (Number(phase) >= 2) {
    stage = "schedule_proposal_conflict";
    const changing = await match(6), conflicting = await match(8);
    const changePath = `appointments/${changing.aid}/schedule-change`;
    const original = row(await get(changePath, author.token));
    const booked = row(await get(`appointments/${conflicting.aid}/schedule-change`, peer.token));
    const proposal = { changeId: crypto.randomUUID(), startsAt: booked.startsAt, endsAt: booked.endsAt, expectedUpdatedAt: original.updatedAt };
    const pending = row(await post(`${changePath}/propose`, author.token, proposal));
    check(pending.status === "awaiting_response" && Date.parse(pending.expiresAt) === Date.parse(original.startsAt));
    check(row(await post(`${changePath}/propose`, author.token, proposal)).deduplicated === true);
    check(row(await get(changePath, peer.token)).startsAt === original.startsAt);
    const response = { changeId: proposal.changeId, conditionVersion: pending.conditionVersion };
    await fail(await service(request(`${changePath}/accept`, author.token, response)), 403, "ACCESS_DENIED");
    await fail(await service(request(`${changePath}/accept`, peer.token, { ...response, conditionVersion: "old-version" })), 409, "STATE_CONFLICT");
    await fail(await service(request(`${changePath}/accept`, peer.token, response)), 409, "STATE_CONFLICT");
    check(row(await get(changePath, peer.token)).startsAt === original.startsAt);
    check(row(await post(`${changePath}/decline`, peer.token, response)).status === "declined");
    check(row(await post(`${changePath}/decline`, peer.token, response)).deduplicated === true);
    stage = "schedule_accept_reservation";
    check(uuid(changing.aid));
    const reservation = row(JSON.parse(sql(`select json_build_object('dueAt',due_at,'generation',generation) from private.completion_reservations where appointment_id='${changing.aid}';`)));
    const next = { changeId: crypto.randomUUID(), startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      endsAt: new Date(Date.now() + 7 * 86400000 + 3600000).toISOString(), expectedUpdatedAt: original.updatedAt };
    const proposed = row(await post(`${changePath}/propose`, peer.token, next));
    const acceptedInput = { changeId: next.changeId, conditionVersion: proposed.conditionVersion };
    check(row(await post(`${changePath}/accept`, author.token, acceptedInput)).status === "accepted");
    check(row(await post(`${changePath}/accept`, author.token, acceptedInput)).deduplicated === true);
    await fail(await service(request(`${changePath}/accept`, peer.token, response)), 409, "STATE_CONFLICT");
    const updated = row(await get(changePath, peer.token));
    check(Date.parse(updated.startsAt) === Date.parse(next.startsAt) && updated.updatedAt !== original.updatedAt);
    const renewed = row(JSON.parse(sql(`select json_build_object('dueAt',due_at,'generation',generation) from private.completion_reservations where appointment_id='${changing.aid}';`)));
    check(Date.parse(renewed.dueAt) === Date.parse(next.endsAt) + 86400000 && renewed.generation !== reservation.generation);
    stage = "cancellation_privacy_conversation";
    const beforeCancel = row(await get(`posts/${changing.pid}`, peer.token));
    check(row(beforeCancel.privateDetails).registeredAddress === "서울특별시 강남구 가상주소");
    const cancellation = { cancellationId: crypto.randomUUID(), reason: "합성 일정 사정으로 시작 전 취소" };
    check(row(await post(`appointments/${changing.aid}/cancel`, author.token, cancellation)).status === "cancelled");
    check(row(await post(`appointments/${changing.aid}/cancel`, author.token, cancellation)).deduplicated === true);
    await fail(await service(request(`appointments/${changing.aid}/cancel`, author.token, { ...cancellation, reason: "변경된 합성 사유" })), 409, "STATE_CONFLICT");
    const afterCancel = row(await get(`posts/${changing.pid}`, peer.token));
    check(afterCancel.privateDetails === undefined && afterCancel.participantNames === undefined && afterCancel.authorDisplayName !== beforeCancel.authorDisplayName);
    check(sql(`select count(*) from private.completion_reservations where appointment_id='${changing.aid}';`) === "0");
    check(firstRow(await get(`conversations/${changing.rid}`, peer.token)).can_send === false);
    await fail(await service(request(`conversations/${changing.rid}/messages`, peer.token, { messageId: crypto.randomUUID(), content: "취소 후 합성 메시지" })), 403, "ACCESS_DENIED");
    check(firstRow(await get(`appointments/${changing.aid}/reviews`, peer.token)).can_write === false);
    stage = "restricted_member_cancellation";
    check(uuid(peer.uid)); sql(`update private.naver_accounts set verification_status='information_required' where user_id='${peer.uid}';`);
    const restricted = row(await get(`appointments/${conflicting.aid}/schedule-change`, peer.token));
    await fail(await service(request(`appointments/${conflicting.aid}/schedule-change/propose`, peer.token,
      { ...next, changeId: crypto.randomUUID(), expectedUpdatedAt: restricted.updatedAt })), 403, "ACCESS_DENIED");
    check(row(await post(`appointments/${conflicting.aid}/cancel`, peer.token,
      { cancellationId: crypto.randomUUID(), reason: "합성 기존 약속 취소" })).status === "cancelled");
    sql(`update private.naver_accounts set verification_status='qualified' where user_id='${peer.uid}';`);
    stage = "schedule_expiry_preserves_original";
    const expiring = await match(10), expiryPath = `appointments/${expiring.aid}/schedule-change`;
    const expiryOriginal = row(await get(expiryPath, author.token)), changeId = crypto.randomUUID(); check(uuid(changeId));
    await post(`${expiryPath}/propose`, author.token, { ...next, changeId, expectedUpdatedAt: expiryOriginal.updatedAt });
    sql(`with fixture as (select clock_timestamp() at) update private.appointment_schedule_changes set requested_at=fixture.at-interval '2 minutes',new_starts_at=fixture.at-interval '1 second',new_ends_at=fixture.at+interval '1 hour',expires_at=fixture.at-interval '1 second' from fixture where change_id='${changeId}';`);
    check(row(await rpc("expire_appointment_changes", { p_limit: 10 }, cfg.SERVICE_ROLE_KEY)).expiredCount === 1);
    const expired = row(await get(expiryPath, peer.token)); check(expired.change.status === "expired" && expired.startsAt === expiryOriginal.startsAt);
    stage = "after_start_cancel_refused";
    check(uuid(expiring.pid)); sql(`with fixture as (select clock_timestamp() at) update public.posts set starts_at=fixture.at-interval '1 minute',ends_at=fixture.at+interval '1 hour',recruitment_ends_at=fixture.at-interval '2 minutes' from fixture where id='${expiring.pid}';`);
    await fail(await service(request(`appointments/${expiring.aid}/cancel`, peer.token,
      { cancellationId: crypto.randomUUID(), reason: "시작 이후 합성 취소 시도" })), 409, "STATE_CONFLICT");
  }
  if (Number(phase) >= 3) {
    stage = "public_profile_traits";
    const ownBefore = row(await get("me", author.token));
    const traits = { interests: ["산책"], conversationStyles: ["차분한 대화"], mbti: "INTJ" };
    await post("me/traits", author.token, traits);
    const profile = row(await get(`profiles/${author.uid}`, peer.token));
    check(profile.profileId === author.uid && profile.displayName === ownBefore.realName && profile.completedCount === 2);
    const outsider = await member(3);
    check(row(await get(`profiles/${author.uid}`, outsider.token)).displayName !== ownBefore.realName);
    check(profile.interests[0] === traits.interests[0] && profile.conversationStyles[0] === traits.conversationStyles[0] && profile.mbti === traits.mbti);
    const ownAfter = row(await get("me", author.token));
    check(JSON.stringify(ownBefore) === JSON.stringify(ownAfter) && !Object.hasOwn(ownAfter, "interests"));
    await fail(await service(request(`profiles/${author.uid}`, "")), 401, "AUTH_REQUIRED");
    stage = "actual_internal_budget_client";
    const internalDb = createInternalClient({ ...config, internalWorkerSecret: internalSecret }, guardedFetch);
    const ledgerId = "ordered-synthetic-" + crypto.randomUUID();
    check(row(await rpc("configure_ai_budget_ledger", { p_ledger_id: ledgerId, p_unit_limit: 20, p_call_limit: 3 }, cfg.SERVICE_ROLE_KEY)).configured === true);
    const reserved = row(await internalDb.rpc("reserve_ai_budget", { p_ledger_id: ledgerId, p_provider_id: "synthetic", p_task: "intent", p_units: 5 }));
    check(uuid(reserved.reservationId));
    check(row(await internalDb.rpc("settle_ai_budget", { p_reservation_id: reserved.reservationId, p_outcome: "usage_unknown", p_input_tokens: null, p_output_tokens: null })).settled === true);
    check(row(await internalDb.rpc("reserve_ai_budget", { p_ledger_id: ledgerId, p_provider_id: "synthetic", p_task: "intent", p_units: 16 })).reservationId === null);
    const ledger = row(await rpc("get_ai_budget_ledger", { p_ledger_id: ledgerId }, cfg.SERVICE_ROLE_KEY));
    check(ledger.chargedUnits === 5 && ledger.reservedUnits === 0 && ledger.unknownUsageCalls === 1);
    stage = "actual_internal_summary_job";
    const snapshot = row(await internalDb.rpc("load_public_review_snapshot", { p_profile_id: peer.uid }));
    check(snapshot.eligibleCount === 1 && typeof snapshot.sourceRevision === "string");
    const enqueued = row(await internalDb.rpc("enqueue_job", { p_kind: "review_summary", p_dedupe_key: "ordered-summary-" + crypto.randomUUID(),
      p_payload: { profileId: peer.uid, sourceRevision: snapshot.sourceRevision, modelVersion: "synthetic-model", promptVersion: "synthetic-prompt" }, p_available_at: new Date().toISOString() }));
    check(uuid(enqueued.jobId));
    const claimed = row(row(await internalDb.rpc("claim_job", { p_worker_id: crypto.randomUUID(), p_lease_seconds: 60 })).job);
    check(claimed.jobId === enqueued.jobId && claimed.kind === "review_summary" && claimed.failedAttempts === 0 && uuid(claimed.leaseToken));
    const lease = { p_job_id: claimed.jobId, p_lease_token: claimed.leaseToken };
    check(row(await internalDb.rpc("load_review_summary_source", lease)).status === "applied");
    check(row(await internalDb.rpc("mark_review_summary_insufficient", { ...lease, p_source_revision: snapshot.sourceRevision })).status === "applied");
    check(row(await internalDb.rpc("complete_job", lease)).status === "succeeded");
    check(row(await internalDb.rpc("load_review_summary_source", lease)).status === "lease_lost");
    stage = "actual_events_public_member_and_filters";
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
    const nextDay = (offset: number) => new Date(Date.parse(today + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
    const sourceId = "ordered-event-" + crypto.randomUUID(), collectedAt = new Date().toISOString();
    const event = { provider: "kopis", sourceId, sourceStatus: "active", title: "합성 연결 공연", category: "공연", region: "서울",
      placeName: "가상 공연장", publicAddress: "서울특별시 가상주소", admission: { kind: "unknown" }, sourceUrl: null,
      collectedAt, precision: "date", startsOn: today, endsOn: nextDay(2) };
    const futureEvent = { ...event, sourceId: sourceId + "-future", title: "합성 예정 공연", startsOn: nextDay(7), endsOn: nextDay(8) };
    const saved = row(await internalDb.rpc("upsert_events", { p_events: [event, futureEvent] }));
    check(saved.insertedCount === 2 && saved.receivedCount === 2);
    // 과거 v1 provider 범위는 보존하고 새 reader에 맞지 않는 기록이 공개 목록을 실패시키지 않아야 한다.
    const legacyProviders = ["demo_provider", "x".repeat(33)];
    const legacyEvents = legacyProviders.map(provider => ({ ...event, provider, sourceId: sourceId + "-legacy-" + provider,
      region: "legacy-only", sourceUrl: "https://example.test/events/legacy" }));
    check(row(await rpc("upsert_source_events_v1", { p_events: legacyEvents }, cfg.SERVICE_ROLE_KEY)).savedCount === 2);
    const legacyCandidates = await rpc("list_event_candidates_v1", { p_region: "legacy-only", p_category: null }, cfg.SERVICE_ROLE_KEY);
    check(Array.isArray(legacyCandidates) && legacyCandidates.length === 2 && legacyCandidates.every((x: Row) => legacyProviders.includes(x.provider) && uuid(x.id)));
    const url = "events?mode=overlapping&limit=1";
    const anonymous = row(await get(url, "")); check(anonymous.events.length === 1 && anonymous.events[0].sourceId === sourceId && anonymous.events[0].sourceUrl === null);
    check(typeof anonymous.nextCursor === "string");
    const memberEvents = row(await get(url, peer.token)); check(JSON.stringify(memberEvents) === JSON.stringify(anonymous));
    const nextPage = row(await get(url + "&cursor=" + encodeURIComponent(anonymous.nextCursor), ""));
    check(nextPage.events.length === 1 && nextPage.events[0].sourceId === futureEvent.sourceId && nextPage.nextCursor === null);
    await fail(await service(request("events?mode=overlapping&limit=1&region=" + encodeURIComponent("서울") + "&cursor=" + encodeURIComponent(anonymous.nextCursor), "")), 400, "INVALID_REQUEST");
    const filterValues = row(await get("events/filters", ""));
    check(filterValues.regions.some((x: Row) => x.provider === "kopis" && x.value === "서울" && x.count === 2));
    check(!filterValues.regions.some((x: Row) => legacyProviders.includes(x.provider)) && !filterValues.categories.some((x: Row) => legacyProviders.includes(x.provider)));
    check(row(await internalDb.rpc("upsert_events", { p_events: [{ ...event, sourceStatus: "cancelled", collectedAt: new Date(Date.parse(collectedAt) + 1000).toISOString() }] })).updatedCount === 1);
    check(row(await get("events?mode=overlapping&limit=10", "")).events.length === 1);
    check(sql("select count(*) from private.source_events;") === "4");
    check(sql("select relkind from pg_class where oid='private.events'::regclass;") === "v");
    stage = "model_unconfigured_does_not_block_publication";
    const maintenance = row(await post("internal/maintenance", internalSecret, { limit: 10 }));
    check(maintenance.completion.status === "managed_by_reservation" && maintenance.summary.status === "pending_configuration");
    check(firstRow(await get(`appointments/${first.aid}/reviews`, peer.token)).released === true);
  }
  stage = "complete"; process.stdout.write(JSON.stringify({ status: "PASS", phase: Number(phase), checks, realAuth: true, realDatabase: true, identityInput: "synthetic", imageUpload: "NOT_RUN", gateway: "NOT_RUN", ...(Number(phase) >= 3 ? { externalAI: "NOT_RUN", actualDailySchedule: "NOT_RUN" } : {}) }) + "\n");
}
try { await run(); }
catch { process.stderr.write(JSON.stringify({ status: "FAIL", stage, checks, ...(diagnostic ?? {}) }) + "\n"); process.exitCode = 1; }
finally { globalThis.fetch = nativeFetch; }
