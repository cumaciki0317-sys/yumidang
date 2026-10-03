/** 민규: 실제 공공 공급사 → 기존 HTTP runtime → 로컬 저장 → 공개 조회 검증.
 * YUMIDANG_PLACES_EVENTS_LOCAL_CONFIG=권한0600임시파일 node 이파일 --check|--run
 * 기본 --check는 설정만 읽는다. --run은 총괄이 다른 DB 검증 종료 후 실행한다.
 * 프로세스 안 실제 HTTP factory이며 gateway 함수 배포 검증과 구분한다.
 * 합성 Auth 회원은 장소 권한 검사만 한다. 실제 네이버 회원·AI·운영 설정은 사용하지 않는다.
 * Tour decoded는 확인된 literal 입력의 한 번 URL 직렬화 재현용이며 발급 형식 판정이 아니다.
 */
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createPlacesRuntime } from "../../../backend/supabase/functions/places/index.ts";
import { createEventSyncRuntime } from "../../../backend/supabase/functions/event-sync/index.ts";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";

const API = "http://127.0.0.1:56521", ORIGIN = "http://127.0.0.1:5173";
const CONTEXT = "colima-yumidang-minkyu", PROJECT = "yumidang-minkyu-gateway", DB = "supabase_db_" + PROJECT;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const nativeFetch = globalThis.fetch;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const configKeys = ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY", "INTERNAL_WORKER_SECRET", "EDGE_ROOT", "KAKAO_REST_API_KEY", "KOPIS_API_KEY", "TOUR_API_SERVICE_KEY"];
type ObjectValue = Record<string, any>;
type Identity = { provider: "kopis" | "tour-api"; sourceId: string; collectedAt: string };
let checks = 0, stage = "configuration", guarded = false, cleanupPassed = false;
let userId: string | undefined;
let generatedEmail: string | undefined;
const collected: Identity[] = [];
const counts = { kakaoRequests: 0, kopisRequests: 0, tourRequests: 0, stored: 0, publicEvents: 0 };
let diagnostic: { httpStatus: number; errorCode: string } | undefined;
function check(value: unknown): asserts value { if (!value) throw new Error("LOCAL_CHECK_FAILED"); checks++; }
function object(value: unknown): ObjectValue { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as ObjectValue; }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function docker(...args: string[]) { return execFileSync("docker", ["--context", CONTEXT, ...args], {
  encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576,
}).trim(); }
function sql(input: string) { return execFileSync("docker", ["--context", CONTEXT, "exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
  input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576,
}).trim(); }
// 칭찬 catalog를 제외한 public/private 실제 테이블을 한꺼번에 확인한다.
const zeroSql = `do $$ declare t record; n bigint; begin
  if exists(select 1 from auth.users) or exists(select 1 from storage.objects) then raise exception 'local_not_empty'; end if;
  for t in select schemaname,tablename from pg_tables where schemaname in ('public','private')
    and not(schemaname='private' and tablename='review_praise_catalog') loop
    execute format('select count(*) from %I.%I',t.schemaname,t.tablename) into n;
    if n<>0 then raise exception 'local_not_empty'; end if;
  end loop; end $$; select 'EMPTY';`;
function secureConfig(): ObjectValue {
  const filename = process.env.YUMIDANG_PLACES_EVENTS_LOCAL_CONFIG;
  check(typeof filename === "string" && isAbsolute(filename));
  const info = lstatSync(filename), parent = lstatSync(dirname(filename));
  check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 24576 && (info.mode & 0o777) === 0o600 && info.uid === process.getuid!());
  check(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o777) === 0o700 && parent.uid === process.getuid!());
  const canonical = realpathSync(filename);
  check(canonical === filename && (canonical.startsWith(realpathSync(tmpdir()) + "/") || canonical.startsWith("/private/tmp/")));
  const cfg = object(JSON.parse(readFileSync(canonical, "utf8")));
  check(Object.keys(cfg).sort().join(",") === configKeys.sort().join(","));
  check(configKeys.every(key => typeof cfg[key] === "string" && cfg[key].length > 0 && cfg[key].length <= 16384 && !/[\u0000-\u0020\u007f]/.test(cfg[key])));
  check(cfg.API_URL === API && cfg.ANON_KEY !== cfg.SERVICE_ROLE_KEY && cfg.INTERNAL_WORKER_SECRET !== cfg.ANON_KEY && cfg.INTERNAL_WORKER_SECRET !== cfg.SERVICE_ROLE_KEY);
  check(/^[A-Za-z0-9_-]{32,4096}$/.test(cfg.INTERNAL_WORKER_SECRET));
  check(cfg.EDGE_ROOT.startsWith("/private/tmp/") && realpathSync(cfg.EDGE_ROOT) === cfg.EDGE_ROOT);
  const manifest = object(JSON.parse(readFileSync(resolve(cfg.EDGE_ROOT, "edge-manifest.json"), "utf8")));
  check(manifest.mode === "gateway_probe" && manifest.config_overlay?.project_id === PROJECT);
  check(manifest.config_sha256 === hash(readFileSync(resolve(cfg.EDGE_ROOT, "supabase/config.toml"))));
  check(Array.isArray(manifest.source_files) && manifest.source_files.length > 0);
  for (const entry of manifest.source_files) {
    check(typeof entry.path === "string" && /^backend\/supabase\/functions\/[A-Za-z0-9_./-]+$/.test(entry.path) && !entry.path.split("/").includes(".."));
    check(typeof entry.target === "string" && !isAbsolute(entry.target) && !entry.target.split("/").includes(".."));
    check(hash(readFileSync(resolve(ROOT, entry.path))) === entry.sha256 && hash(readFileSync(resolve(cfg.EDGE_ROOT, entry.target))) === entry.sha256);
  }
  return cfg;
}
function targetGuard() {
  check(docker("context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}") === "unix://" + homedir() + "/.colima/yumidang-minkyu/docker.sock");
  const targets = JSON.parse(docker("inspect", DB)); check(Array.isArray(targets) && targets.length === 1);
  const t = object(targets[0]);
  check(t.Name === "/" + DB && t.Config.Labels["com.supabase.cli.project"] === PROJECT && t.State.Running === true);
  check(t.HostConfig.PortBindings["5432/tcp"].some((p: ObjectValue) => p.HostPort === "56522" && ["", "127.0.0.1", "0.0.0.0"].includes(p.HostIp)));
  check(sql(zeroSql) === "EMPTY"); guarded = true;
}
const textSql = (text: string) => `convert_from(decode('${Buffer.from(text, "utf8").toString("hex")}','hex'),'UTF8')`;
async function body(response: Response) { const value = object(await response.json()); check(response.ok); return value; }
async function envelope(response: Response) {
  const value = object(await response.json());
  if (!response.ok) diagnostic = { httpStatus: response.status, errorCode: ["AUTH_REQUIRED", "ACCESS_DENIED", "INVALID_REQUEST", "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR"].includes(value.error?.code) ? value.error.code : "UNKNOWN" };
  check(response.ok && value.data !== undefined && response.headers.get("cache-control") === "no-store");
  return object(value.data);
}
async function run() {
  check(process.argv.length <= 3 && (process.argv[2] === undefined || ["--check", "--run"].includes(process.argv[2])));
  const cfg = secureConfig();
  if (process.argv[2] !== "--run") return { status: "READY", execution: "NOT_RUN" };
  targetGuard();
  const publicEndpoints = new Map([
    ["https://dapi.kakao.com/v2/local/search/keyword.json", "kakaoRequests"],
    ["https://kopis.or.kr/openApi/restful/pblprfr", "kopisRequests"],
    ["https://apis.data.go.kr/B551011/KorService2/searchFestival2", "tourRequests"],
  ] as const);
  const guardedFetch: typeof fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    check(!u.username && !u.password && !u.hash);
    const countKey = publicEndpoints.get(u.origin + u.pathname as any);
    if (countKey) {
      check(method === "GET" && counts[countKey] === 0); counts[countKey]++;
      check((countKey === "kakaoRequests" && u.searchParams.get("query") === "서울역" && u.searchParams.get("page") === "1" && u.searchParams.get("size") === "1") ||
        (countKey === "kopisRequests" && u.searchParams.get("cpage") === "1" && u.searchParams.get("rows") === "1") ||
        (countKey === "tourRequests" && u.searchParams.get("pageNo") === "1" && u.searchParams.get("numOfRows") === "1"));
    } else {
      check(u.origin === API);
      const allowed = (u.pathname === "/auth/v1/user" && method === "GET" && !u.search) ||
        (u.pathname === "/auth/v1/admin/users" && method === "POST" && !u.search) ||
        (u.pathname === "/auth/v1/token" && method === "POST" && u.search === "?grant_type=password") ||
        (/^\/rest\/v1\/rpc\/(upsert_events|list_public_events|list_event_filter_values)$/.test(u.pathname) && method === "POST" && !u.search);
      check(allowed);
      if (u.pathname === "/rest/v1/rpc/upsert_events") {
        const items = object(JSON.parse(String(init?.body))).p_events;
        check(Array.isArray(items) && items.length === 1);
        for (const e of items) {
          check(["kopis", "tour-api"].includes(e.provider) && typeof e.sourceId === "string" && e.sourceId.length <= 256 && typeof e.collectedAt === "string" && Number.isFinite(Date.parse(e.collectedAt)));
          collected.push({ provider: e.provider, sourceId: e.sourceId, collectedAt: e.collectedAt });
        }
      }
    }
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    const cancel = () => controller.abort();
    init?.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (init?.signal?.aborted) controller.abort();
      const response = await nativeFetch(input, { ...init, signal: controller.signal, redirect: "error", credentials: "omit" });
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      if (reader) try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          size += chunk.value.byteLength; check(size <= 1048576); chunks.push(chunk.value);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new Response(bytes, { status: response.status, headers: response.headers });
    } finally { clearTimeout(timeout); init?.signal?.removeEventListener("abort", cancel); }
  };
  globalThis.fetch = guardedFetch;
  const env: Record<string, string> = { SUPABASE_URL: API, SUPABASE_ANON_KEY: cfg.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY,
    INTERNAL_WORKER_SECRET: cfg.INTERNAL_WORKER_SECRET, ALLOWED_ORIGINS: JSON.stringify([ORIGIN]), MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "15000",
    KAKAO_REST_API_KEY: cfg.KAKAO_REST_API_KEY, KOPIS_API_KEY: cfg.KOPIS_API_KEY, TOUR_API_SERVICE_KEY: cfg.TOUR_API_SERVICE_KEY,
    TOUR_API_KEY_FORMAT: "decoded", PLACES_PAGE_SIZE: "1", EVENT_SYNC_PROVIDERS: "kopis,tour-api", EVENT_SYNC_MAX_PERIOD_DAYS: "1", EVENT_SYNC_MAX_PAGE: "1", EVENT_SYNC_PAGE_ROWS: "1" };
  const places = createPlacesRuntime(key => env[key], guardedFetch), sync = createEventSyncRuntime(key => env[key], guardedFetch), service = createRuntimeHandler(key => env[key]);
  const authHeaders = { apikey: cfg.SERVICE_ROLE_KEY, Authorization: "Bearer " + cfg.SERVICE_ROLE_KEY, "Content-Type": "application/json" };
  stage = "synthetic_auth";
  const email = crypto.randomUUID() + "@places-test.yumidang.invalid", password = crypto.randomUUID() + crypto.randomUUID();
  generatedEmail = email;
  const created = await body(await guardedFetch(API + "/auth/v1/admin/users", { method: "POST", headers: authHeaders, body: JSON.stringify({ email, password, email_confirm: true }) }));
  check(typeof created.id === "string" && uuid.test(created.id)); userId = created.id;
  const session = await body(await guardedFetch(API + "/auth/v1/token?grant_type=password", { method: "POST", headers: { apikey: cfg.ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }));
  check(session.user?.id === userId && typeof session.access_token === "string");
  stage = "places_http";
  const placeUrl = API + "/functions/v1/places?query=" + encodeURIComponent("서울역") + "&page=1";
  check((await places(new Request(placeUrl, { headers: { Origin: ORIGIN } }))).status === 401);
  const found = await envelope(await places(new Request(placeUrl, { headers: { Origin: ORIGIN, Authorization: "Bearer " + session.access_token } })));
  check(found.status === "results" && Array.isArray(found.places) && found.places.length === 1);
  check(Object.keys(found.places[0]).sort().join(",") === "address,placeName,roadAddress,source,sourceId");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  check(/^\d{4}-\d{2}-\d{2}$/.test(today));
  for (const provider of ["kopis", "tour-api"]) {
    stage = provider === "kopis" ? "kopis_sync" : "tour_sync";
    const result = await envelope(await sync(new Request(API + "/functions/v1/event-sync", { method: "POST", headers: { Authorization: "Bearer " + cfg.INTERNAL_WORKER_SECRET, "Content-Type": "application/json" }, body: JSON.stringify({ provider, period: { start: today, end: today }, page: 1 }) })));
    check(result.provider === provider && result.fetchedCount === 1 && result.savedCount === 1); counts.stored += result.savedCount;
  }
  stage = "public_http";
  check(collected.length === 2 && new Set(collected.map(e => e.provider)).size === 2);
  check(sql("select count(*) from private.source_events;") === "2");
  const page = await envelope(await service(new Request(API + "/functions/v1/service-api/events?mode=overlapping&periodStart=" + today + "&periodEnd=" + today + "&limit=50")));
  check(Array.isArray(page.events) && page.events.length === 2 && page.nextCursor === null);
  for (const e of collected) check(page.events.some((r: ObjectValue) => r.provider === e.provider && r.sourceId === e.sourceId));
  counts.publicEvents = page.events.length;
  const filters = await envelope(await service(new Request(API + "/functions/v1/service-api/events/filters")));
  check(Array.isArray(filters.regions) && Array.isArray(filters.categories));
  return { status: "PASS", execution: "RUN", syntheticAuth: true, actualPublicProviders: true, inProcessHttp: true, gatewayHttp: false, tourSerialization: "LITERAL_URLENCODE_ONCE_FIXTURE", top10: "NOT_RUN", postalUi: "NOT_RUN", dailyScheduler: "NOT_RUN" };
}
function cleanup() {
  if (!guarded) return;
  for (const e of collected) sql(`delete from private.source_events where provider=${textSql(e.provider)} and source_id=${textSql(e.sourceId)} and collected_at=(${textSql(e.collectedAt)})::timestamptz;`);
  if (userId) { check(uuid.test(userId)); sql(`delete from auth.users where id='${userId}'::uuid;`); }
  else if (generatedEmail) {
    check(/^[0-9a-f-]{36}@places-test\.yumidang\.invalid$/.test(generatedEmail));
    // 생성 응답이 손상되어 UID를 읽지 못해도 본 실행의 정확한 합성 주소만 정리한다.
    sql(`delete from auth.users where email=${textSql(generatedEmail)};`);
  }
  check(sql(zeroSql) === "EMPTY"); cleanupPassed = true;
}
let report: ObjectValue;
try { report = await run(); }
catch { report = { status: "FAIL", failedStage: stage, ...(diagnostic ? { diagnostic } : {}) }; }
finally {
  globalThis.fetch = nativeFetch;
  try { cleanup(); } catch { report = { status: "FAIL", failedStage: "cleanup", cleanupPassed: false }; }
}
console.log(JSON.stringify({ ...report!, checks, counts, cleanupPassed }));
if (report!.status === "FAIL") process.exitCode = 1;
