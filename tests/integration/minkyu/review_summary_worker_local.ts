/** 민규: 원형 요약 worker factory → 실제 로컬 RPC → 중간 저장/게시/무효화 검증.
 * 모델과 안전 검사는 알려진 합성 자료에만 주입한다. 운영 검사기 승인·공개 활성화가 아니다.
 * 외부 AI/네이버/공급사 호출, 제품·종현 파일 수정, CLI 프로젝트 관리는 하지 않는다.
 * 총괄 실행: YUMIDANG_REVIEW_SUMMARY_LOCAL_CONFIG=임시0600파일 node 이파일 --run
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createReviewSummaryWorkerRuntime } from "../../../backend/supabase/functions/review-summary-worker/index.ts";
import { REVIEW_SUMMARY_PROMPT_VERSION } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/prompts.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import type { RpcClient } from "../../../backend/supabase/functions/_shared/db/transport.ts";
import type { ModelPort, ModelRequest } from "../../../backend/supabase/functions/_shared/ai/providers/model-port.ts";
import type { SummarySafetyPort } from "../../../backend/supabase/functions/_shared/ai/Agents/review-summary/output-check.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const API = "http://127.0.0.1:56521", ORIGIN = "http://127.0.0.1:5173";
const CONTEXT = "colima-yumidang-minkyu", PROJECT = "yumidang-minkyu-gateway", DB = "supabase_db_" + PROJECT;
const MODEL = "synthetic-summary-v1";
const nativeFetch = globalThis.fetch;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = (n: number) => "a6200000-0000-4000-8000-" + String(n).padStart(12, "0");
const people = [id(1), id(2)];
const posts = Array.from({ length: 5 }, (_, i) => id(101 + i));
const requests = Array.from({ length: 5 }, (_, i) => id(201 + i));
const appointments = Array.from({ length: 5 }, (_, i) => id(301 + i));
const reviews = Array.from({ length: 5 }, (_, i) => id(401 + i));
const jobs: string[] = [], leases: string[] = [], chunkInputs: string[][] = [];
const expectedRaw = new Set([...Array.from({ length: 5 }, (_, i) => "SYNTHETIC_REVIEW_TEXT_" + (i + 1)), "SYNTHETIC_REVIEW_TEXT_CHANGED_1"]);
const allowedClaims = new Set(["합성 검증 중간 요약", "합성 검증 최종 요약"]);
type Row = Record<string, any>;
let stage = "configuration", checks = 0, groups = 0, guarded = false, cleanupPassed = false;
let failedCheck: string | undefined;
let workerDiagnostic: { httpStatus: number; noStore: boolean; errorCode: string; status: string; reason: string } | undefined;
const counts = { rpc: 0, model: 0, safety: 0, yielded: 0, published: 0, superseded: 0, insufficient: 0 };
function check(value: unknown, label = "unlabelled_check"): asserts value {
  checks++; if (!value) { failedCheck = label; throw new Error("LOCAL_SUMMARY_CHECK_FAILED"); }
}
function row(value: unknown): Row { check(value !== null && typeof value === "object" && !Array.isArray(value)); return value as Row; }
function docker(...args: string[]) { return execFileSync("docker", ["--context", CONTEXT, ...args], {
  encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576,
}).trim(); }
function sql(input: string) { return execFileSync("docker", ["--context", CONTEXT, "exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], {
  input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576,
}).trim(); }
const zeroSql = `do $$ declare t record;n bigint;begin
  if exists(select 1 from auth.users) or exists(select 1 from storage.objects) then raise exception 'local_not_empty';end if;
  for t in select schemaname,tablename from pg_tables where schemaname in('public','private')
    and not(schemaname='private' and tablename='review_praise_catalog') loop
    execute format('select count(*) from %I.%I',t.schemaname,t.tablename) into n;
    if n<>0 then raise exception 'local_not_empty';end if;
  end loop;end $$;select 'EMPTY';`;
function secureConfig(): Row {
  const path = process.env.YUMIDANG_REVIEW_SUMMARY_LOCAL_CONFIG;
  check(typeof path === "string" && isAbsolute(path) && path.startsWith("/private/tmp/") && realpathSync(path) === path);
  const file = lstatSync(path), parent = lstatSync(dirname(path));
  check(file.isFile() && !file.isSymbolicLink() && file.nlink === 1 && file.uid === process.getuid!() &&
    (file.mode & 0o777) === 0o600 && file.size <= 24576);
  check(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid!() && (parent.mode & 0o777) === 0o700);
  const config = row(JSON.parse(readFileSync(path, "utf8")));
  check(Object.keys(config).sort().join(",") === "ANON_KEY,API_URL,EDGE_ROOT,INTERNAL_WORKER_SECRET,SERVICE_ROLE_KEY");
  check(Object.values(config).every(v => typeof v === "string" && v.length > 0 && !/[\u0000-\u0020\u007f]/.test(v)));
  check(config.API_URL === API && new Set([config.ANON_KEY, config.SERVICE_ROLE_KEY, config.INTERNAL_WORKER_SECRET]).size === 3);
  check(/^[A-Za-z0-9_-]{32,4096}$/.test(config.INTERNAL_WORKER_SECRET));
  check(config.EDGE_ROOT.startsWith("/private/tmp/") && realpathSync(config.EDGE_ROOT) === config.EDGE_ROOT);
  const code = "import sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import gateway_cors_local as p;p.source_guards(Path(sys.argv[2]))";
  execFileSync("python3", ["-B", "-c", code, ROOT + "/tests/integration/minkyu", config.EDGE_ROOT],
    { stdio: ["pipe", "pipe", "pipe"], timeout: 15000, maxBuffer: 65536 });
  check(row(JSON.parse(readFileSync(ROOT + "/docs/collaboration/minkyu-gateway-harness.json", "utf8"))).lanes.B.includes("tests/integration/minkyu/review_summary_worker_local.ts"));
  return config;
}
function targetGuard() {
  check(docker("context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}") ===
    "unix://" + homedir() + "/.colima/yumidang-minkyu/docker.sock");
  const targets = JSON.parse(docker("inspect", DB)); check(Array.isArray(targets) && targets.length === 1);
  const t = row(targets[0]);
  check(t.Name === "/" + DB && t.State.Running === true && t.Config.Labels["com.supabase.cli.project"] === PROJECT);
  check(t.HostConfig.PortBindings["5432/tcp"].some((p: Row) => p.HostPort === "56522" && ["", "127.0.0.1", "0.0.0.0"].includes(p.HostIp)));
  check(sql(zeroSql) === "EMPTY"); guarded = true;
}
function fixtures() {
  let command = `begin;do $$ begin perform set_config('request.jwt.claims','{"role":"service_role"}',true);end $$;
    insert into auth.users(id) values('${people[0]}'),('${people[1]}');
    insert into public.profiles(id,real_name,birth_date,gender) values
      ('${people[0]}','합성 후기작성자','1990-01-01','female'),('${people[1]}','합성 요약대상자','1990-01-01','female');`;
  for (let i = 0; i < 5; i++) command += `
    insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
      values('${posts[i]}','${people[0]}','합성 요약 공고','로컬 worker 연결 검증','산책',now()-interval '4 days',now()-interval '3 days',now()-interval '5 days','서울특별시 강남구 역삼동','closed');
    insert into public.join_requests(id,post_id,requester_id,message,status) values('${requests[i]}','${posts[i]}','${people[1]}','합성 요약 검증 신청','matched');
    insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
      values('${appointments[i]}','${posts[i]}','${requests[i]}','completed',now()-interval '2 days','automatic',now()-interval '2 days',now()-interval '1 day',now()+interval '5 days');
    insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience)
      values('${reviews[i]}','${appointments[i]}','${people[0]}',5,${i === 3 ? "null" : "'SYNTHETIC_REVIEW_TEXT_" + (i + 1) + "'"},'positive');`;
  sql(command + "commit;");
}
function jobState(jobId: string): Row {
  check(uuid.test(jobId));
  return row(JSON.parse(sql(`select json_build_object('status',status,'attempt',attempt,'failedAttempts',failed_attempts,
    'leased',lease_token is not null,'checkpoint',coalesce((select checkpoint from private.review_summary_checkpoints where job_id=j.id),'null'::jsonb))
    from private.worker_jobs j where id='${jobId}';`)));
}
function projection(): Row {
  return row(JSON.parse(sql(`select json_build_object('revision',revision::text,'visible',visible_summary_id,
    'summaries',(select count(*) from private.review_summaries where profile_id=s.profile_id),
    'markers',(select count(*) from private.review_summary_job_publications where profile_id=s.profile_id),
    'checkpoints',(select count(*) from private.review_summary_checkpoints where profile_id=s.profile_id))
    from private.review_summary_state s where profile_id='${people[1]}';`)));
}
const syntheticSafety: SummarySafetyPort = {
  async check(input) {
    counts.safety++;
    const validIds = new Set(input.publicTextReviews.map(r => r.evidenceId));
    return input.publicTextReviews.length > 0 && input.publicTextReviews.every(r => expectedRaw.has(r.comment ?? "")) &&
      input.claims.length > 0 && input.claims.every(c => allowedClaims.has(c.text) && c.evidenceIds.length > 0 &&
        c.evidenceIds.every(e => validIds.has(e)));
  },
};
const syntheticModel: ModelPort = {
  async generate(request: ModelRequest) {
    counts.model++;
    const input = row(request.input);
    const source = request.task === "review_chunk" ? input.reviews : request.task === "review_merge" ? input.summaries : null;
    check(Array.isArray(source) && source.length > 0);
    if (request.task === "review_chunk") {
      check(source.every((r: Row) => reviews.includes(r.evidenceId) && expectedRaw.has(r.comment)));
      chunkInputs.push(source.map((r: Row) => r.evidenceId));
    } else check(source.every((r: Row) => /^group-[0-9]+$/.test(r.evidenceId) && allowedClaims.has(r.text)));
    return { value: { claims: [{ text: request.task === "review_chunk" ? "합성 검증 중간 요약" : "합성 검증 최종 요약",
      evidenceIds: source.map((r: Row) => r.evidenceId) }] }, modelVersion: MODEL, usage: null };
  },
};
async function run() {
  check(process.argv.length === 3 && process.argv[2] === "--run");
  const cfg = secureConfig();
  stage = "dedicated_target"; targetGuard();
  const rpcs = new Set(["load_public_review_snapshot", "set_review_publication", "enqueue_job", "claim_job", "complete_job", "retry_job", "yield_job", "fail_job", "supersede_job",
    "load_review_summary_source", "load_review_summary_checkpoint", "save_review_summary_checkpoint", "discard_review_summary_checkpoint", "mark_review_summary_insufficient", "publish_review_summary_for_job"]);
  const guardedFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const match = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
    const headers = new Headers(init?.headers);
    check(url.origin === API && !url.username && !url.password && !url.search && !url.hash && match && rpcs.has(match[1]));
    check(init?.method === "POST" && headers.get("apikey") === cfg.SERVICE_ROLE_KEY && headers.get("authorization") === "Bearer " + cfg.SERVICE_ROLE_KEY);
    counts.rpc++;
    return nativeFetch(input, { ...init, redirect: "error", credentials: "omit" });
  };
  globalThis.fetch = guardedFetch;
  const env: Record<string, string> = {
    SUPABASE_URL: API, SUPABASE_ANON_KEY: cfg.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: cfg.SERVICE_ROLE_KEY,
    INTERNAL_WORKER_SECRET: cfg.INTERNAL_WORKER_SECRET, ALLOWED_ORIGINS: JSON.stringify([ORIGIN]), MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "10000",
    REVIEW_SUMMARY_MODEL_VERSION: MODEL, REVIEW_SUMMARY_PROMPT_VERSION,
    REVIEW_SUMMARY_WORKER_MAX_JOBS_PER_RUN: "1", REVIEW_SUMMARY_WORKER_TIME_BUDGET_MS: "5000", REVIEW_SUMMARY_LEASE_SECONDS: "60",
    REVIEW_SUMMARY_RETRY_MAX_ATTEMPTS: "3", REVIEW_SUMMARY_RETRY_BASE_DELAY_MS: "100", REVIEW_SUMMARY_RETRY_MAX_DELAY_MS: "500",
    REVIEW_SUMMARY_BUDGET_DEFER_MS: "100", REVIEW_SUMMARY_MAX_INPUT_CHARS: "20000", REVIEW_SUMMARY_MAX_REVIEWS_PER_CHUNK: "2",
    REVIEW_SUMMARY_MERGE_FAN_IN: "2", REVIEW_SUMMARY_MAX_OUTPUT_TOKENS: "200", REVIEW_SUMMARY_MAX_OUTPUT_CHARS: "2000", REVIEW_SUMMARY_MAX_CALLS_PER_STEP: "1",
  };
  const db = createInternalClient({ supabaseUrl: API, supabaseAnonKey: cfg.ANON_KEY, supabaseServiceRoleKey: cfg.SERVICE_ROLE_KEY,
    internalWorkerSecret: cfg.INTERNAL_WORKER_SECRET, allowedOrigins: [ORIGIN], maxRequestBytes: 8192, upstreamTimeoutMs: 10000 }, guardedFetch);
  const observedDb: RpcClient = { async rpc(name, args) {
    const result = await db.rpc(name, args);
    if (name === "claim_job" && row(result).job !== null) {
      const claim = row(row(result).job); check(uuid.test(claim.leaseToken)); leases.push(claim.leaseToken);
    }
    return result;
  } };
  const overrides = { fetch: guardedFetch, createDb: () => observedDb,
    createModel: () => ({ status: "ready" as const, model: syntheticModel, modelVersion: MODEL }) };
  const worker = createReviewSummaryWorkerRuntime(key => env[key], { ...overrides, safety: syntheticSafety });
  const disabled = createReviewSummaryWorkerRuntime(key => env[key], { ...overrides, safety: null });
  const invoke = async (handler = worker) => {
    const response = await handler(new Request(API + "/functions/v1/review-summary-worker", { method: "POST",
      headers: { Origin: ORIGIN, Authorization: "Bearer " + cfg.INTERNAL_WORKER_SECRET, "Content-Type": "application/json" }, body: "{}" }));
    const value = row(await response.json());
    const reasons = new Set(["WORKER_NOT_CONFIGURED", "WORKER_SETTINGS_INVALID", "SUMMARY_VERSIONS_NOT_CONFIGURED", "SUMMARY_VERSIONS_INVALID",
      "SUMMARY_PROMPT_UNSUPPORTED", "MODEL_RETENTION_REVIEW_PENDING", "MODEL_COST_EVIDENCE_MISSING", "MODEL_NOT_CONFIGURED", "MODEL_VERSION_MISMATCH",
      "SAFETY_CHECK_NOT_APPROVED", "DB_RPC_NOT_ALLOWED", "DB_RPC_UNAVAILABLE"]);
    const errors = new Set(["AUTH_REQUIRED", "ACCESS_DENIED", "INVALID_REQUEST", "EXTERNAL_UNAVAILABLE", "INTERNAL_ERROR"]);
    workerDiagnostic = { httpStatus: response.status, noStore: response.headers.get("cache-control") === "no-store",
      errorCode: value.error ? errors.has(value.error.code) ? value.error.code : "UNEXPECTED_CODE" : "NONE",
      status: ["not_enabled", "ran"].includes(value.data?.status) ? value.data.status : "UNEXPECTED_STATUS",
      reason: reasons.has(value.data?.reason) ? value.data.reason : "NONE" };
    check(response.status === 200 && workerDiagnostic.noStore && !value.error, "worker_http_response");
    return row(value.data);
  };
  const snapshot = async () => row(await db.rpc("load_public_review_snapshot", { p_profile_id: people[1] }));
  const enqueue = async (source: Row, label: string) => {
    check(typeof source.sourceRevision === "string" && /^[0-9]+$/.test(source.sourceRevision));
    const result = row(await db.rpc("enqueue_job", { p_kind: "review_summary", p_dedupe_key: "synthetic-summary-local:" + label,
      p_payload: { profileId: people[1], sourceRevision: source.sourceRevision, modelVersion: MODEL, promptVersion: REVIEW_SUMMARY_PROMPT_VERSION },
      p_available_at: new Date().toISOString() }));
    check(uuid.test(result.jobId), "enqueue_job_id"); jobs.push(result.jobId); return result.jobId as string;
  };

  stage = "eligible_sources_and_disabled_safety";
  fixtures(); await db.rpc("set_review_publication", { p_review_id: reviews[4], p_is_public: false });
  const source = await snapshot(); check(source.eligibleCount === 3 && source.reviews.length === 3);
  check(source.reviews.map((r: Row) => r.reviewId).sort().join(",") === reviews.slice(0, 3).join(","));
  const first = await enqueue(source, "publish");
  const noSafety = await invoke(disabled);
  check(noSafety.status === "not_enabled" && noSafety.reason === "SAFETY_CHECK_NOT_APPROVED", "disabled_safety_reason");
  check(jobState(first).attempt === 0 && Number(counts.model) === 0 && leases.length === 0); groups++;

  stage = "split_checkpoint_resume_publish";
  for (const next of [2, 3]) {
    const response = await invoke(); check(response.status === "ran" && response.counts.claimed === 1 && response.counts.yielded === 1 && response.counts.failed === 0);
    const state = jobState(first); check(state.status === "queued" && state.failedAttempts === 0 && state.leased === false);
    check(state.checkpoint.nextReviewIndex === next && state.checkpoint.sourceReviewIds.length === 3);
    check(!JSON.stringify(state.checkpoint).includes("SYNTHETIC_REVIEW_TEXT")); counts.yielded++;
  }
  const published = await invoke(); check(published.status === "ran" && published.counts.succeeded === 1 && published.counts.failed === 0);
  const state = jobState(first), current = projection();
  check(state.status === "succeeded" && state.attempt === 3 && state.failedAttempts === 0 && state.checkpoint === null);
  check(current.revision === source.sourceRevision && uuid.test(current.visible) && current.summaries === 1 && current.markers === 1 && current.checkpoints === 0);
  check(sql(`select source_revision::text||','||cardinality(evidence_review_ids) from private.review_summaries where id='${current.visible}';`) === source.sourceRevision + ",3");
  check(counts.model === 3 && chunkInputs.length === 2 && new Set(chunkInputs.flat()).size === 3 && chunkInputs.flat().length === 3 && new Set(leases).size === 3);
  check(counts.safety > 0); counts.published++; groups++;

  stage = "source_edit_private_invalidation";
  sql(`begin;update public.appointment_reviews set comment='SYNTHETIC_REVIEW_TEXT_CHANGED_1' where id='${reviews[0]}';commit;`);
  const edited = await snapshot(); check(BigInt(edited.sourceRevision) > BigInt(source.sourceRevision) && edited.eligibleCount === 3);
  check(projection().visible === null && projection().summaries === 1);
  const pending = await enqueue(edited, "invalidated");
  const partial = await invoke(); check(partial.counts.yielded === 1 && jobState(pending).checkpoint.nextReviewIndex === 2); counts.yielded++;
  const callsBeforeHide = counts.model;
  await db.rpc("set_review_publication", { p_review_id: reviews[1], p_is_public: false });
  check(projection().visible === null && projection().checkpoints === 0 && projection().summaries === 1);
  const reduced = await snapshot(); check(reduced.eligibleCount === 2 && BigInt(reduced.sourceRevision) > BigInt(edited.sourceRevision));
  const superseded = await invoke(); check(superseded.counts.superseded === 1 && jobState(pending).status === "superseded" && counts.model === callsBeforeHide); counts.superseded++;
  const insufficient = await enqueue(reduced, "insufficient");
  const finished = await invoke(); check(finished.counts.succeeded === 1 && jobState(insufficient).status === "succeeded" && counts.model === callsBeforeHide);
  check(projection().visible === null && projection().checkpoints === 0 && projection().summaries === 1); counts.insufficient++; groups++;
}
function cleanup() {
  if (!guarded) return;
  check(jobs.every(j => uuid.test(j)));
  const jobDelete = jobs.length ? "delete from private.worker_jobs where id in(" + jobs.map(j => "'" + j + "'").join(",") + ");" : "";
  sql("begin;" + jobDelete + `delete from private.worker_jobs where dedupe_key in('synthetic-summary-local:publish','synthetic-summary-local:invalidated','synthetic-summary-local:insufficient');
    delete from public.posts where id in(${posts.map(p => "'" + p + "'").join(",")});
    delete from public.profiles where id in('${people[0]}','${people[1]}');
    delete from auth.users where id in('${people[0]}','${people[1]}');commit;`);
  check(sql(zeroSql) === "EMPTY"); cleanupPassed = true;
}
let passed = false;
try { await run(); passed = true; }
catch { /* SQL/후기/토큰/lease/실제 오류 원문을 출력하지 않는다. */ }
finally {
  globalThis.fetch = nativeFetch;
  const failedStage = stage;
  try { stage = "synthetic_cleanup"; cleanup(); stage = failedStage; } catch { passed = false; }
}
console.log(JSON.stringify({ status: passed && cleanupPassed ? "PASS" : "FAIL", stage, groups, checks, counts,
  ...(!passed ? { failedCheck, workerDiagnostic } : {}),
  syntheticCleanup: cleanupPassed, nativeRpc: guarded, inProcessWorker: true, syntheticModel: true, syntheticSafety: true,
  externalAI: false, productionPublicEnabled: false, approvedProductionSafety: false, gatewayWorkerDeployment: "NOT_RUN" }));
if (!passed || !cleanupPassed) process.exitCode = 1;
