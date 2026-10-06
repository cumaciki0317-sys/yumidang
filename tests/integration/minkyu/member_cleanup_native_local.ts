/** 민규: native55/56/60 회귀, native67 signed photo 실패 관측과 native69 authenticated photo 후보를 구분한다. */
import assert from "node:assert/strict";
import { readFileSync, lstatSync, mkdtempSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { MemberCleanupPorts, MemberCleanupTask } from "../../../backend/supabase/functions/_shared/auth/member-cleanup.ts";

const source = "/Users/minkyu/Documents/GitHub/yumidang/.worktrees/minkyu-foundation";
// DB ports와 같은 모듈 그래프를 사용한다. 다른 worktree의 HttpError 클래스 혼합을 피한다.
const { createMemberCleanupAdapter, processMemberCleanupTask }: typeof import("../../../backend/supabase/functions/_shared/auth/member-cleanup.ts") =
  await import(pathToFileURL(join(source, "backend/supabase/functions/_shared/auth/member-cleanup.ts")).href);
const { toPublicError }: typeof import("../../../backend/supabase/functions/_shared/http/errors.ts") =
  await import(pathToFileURL(join(source, "backend/supabase/functions/_shared/http/errors.ts")).href);
const statusFile = process.argv[2];
assert.equal(statusFile, "/private/tmp/yumidang-drift-catalog-44g9wt_e/current52-local-status.json");
assert.ok(["--native55-approved", "--native56-approved", "--native60-approved", "--native67-approved", "--native69-approved"].includes(process.argv[3]), "root의 native 적용 완료 후에만 실행한다");
const native67 = process.argv[3] === "--native67-approved";
const native69 = process.argv[3] === "--native69-approved";
const photoVerification = native67 || native69;
// root의 공식69 READY 산출물과 실제 적용 postflight를 고정한다.
type Photo69Pins = { manifestPath: string; manifestSha256: string; edgeSha256: string; postflightPath: string; edgeCount: number };
function reviewedPhoto69Pins(): Photo69Pins | null {
  return { manifestPath: "/private/tmp/yumidang-policy69-reviewed/prepared/migration-manifest.json",
    manifestSha256: "4e4a7e1c8111628e87c4fc4120cb80dd4163f1f7fc568f98ec8201e1d52812ea",
    edgeSha256: "f722925e555b1457450b2fb22336322ae6e4b48b672a9b482a6c4e77011b592c",
    postflightPath: "/private/tmp/yumidang-native69-rollout-reviewed/postflight.json", edgeCount: 50 };
}
const native69Pins = reviewedPhoto69Pins();
if (native69) { assert.equal(process.argv[4], "--verify-authenticated-photo-access"); assert.ok(native69Pins, "NATIVE69_REVIEWED_PINS_NOT_READY"); }
if (native67) assert.equal(process.argv[4], "--verify-signed-photo-access");
const nodeRuntimeBatch = process.argv[3] === "--native60-approved" && process.argv[4] === "--runtime-batch";
const hostedRuntimeBatch = process.argv[3] === "--native60-approved" && process.argv[4] === "--hosted-runtime-batch";
const runtimeBatch = nodeRuntimeBatch || hostedRuntimeBatch;
const versionCount = native69 ? 69 : native67 ? 67 : runtimeBatch ? 60 : process.argv[3] === "--native56-approved" ? 56 : 55;
const latestVersion = native69 ? "20261005143045" : native67 ? "20261005041000" : versionCount === 60 ? "20261005040100" : versionCount === 56 ? "20261005020136" : "20261005020135";
const observeOwnedAuth = process.argv[4] === "--observe-owned-auth-delete";
const verifyRejoin = process.argv[4] === "--verify-rejoin";
assert.ok(process.argv[4] === undefined || observeOwnedAuth || verifyRejoin || runtimeBatch || photoVerification);
assert.equal(process.argv[3] === "--native60-approved", runtimeBatch);
const reviewedManifest = native69 ? native69Pins!.manifestPath : native67 ? "/private/tmp/yumidang-policy67-final-reviewed/prepared/migration-manifest.json" : "/private/tmp/yumidang-policy60-reviewed-xze3cqci/prepared/migration-manifest.json";
assert.equal(process.argv[5], runtimeBatch || photoVerification ? reviewedManifest : undefined);
if (photoVerification) assert.equal(process.argv[6], undefined);
let expectedVersions: string[] = [], manifestHash: string | null = null;
let roleBaseline: string | null = null, aclBaseline: string | null = null;
if (runtimeBatch || photoVerification) {
  const st = lstatSync(reviewedManifest); assert.ok(st.isFile() && !st.isSymbolicLink() && st.uid === process.getuid!());
  const directory = lstatSync(dirname(reviewedManifest)); assert.ok(directory.isDirectory() && !directory.isSymbolicLink()); assert.equal(directory.uid, process.getuid!()); assert.equal(directory.mode & 0o777, 0o700);
  const bytes = readFileSync(reviewedManifest); manifestHash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(manifestHash, native69 ? native69Pins!.manifestSha256 : native67 ? "1c56f6353a229bdae16fbb3c4d1106e8d45aec5a9cc9981311ec38b470cb7431" : "129cb1f10baf7ca4a225d3e7c7f7de34928de25d1ced9d1a282b7af9ad0e685a");
  const manifest = JSON.parse(bytes.toString());
  assert.equal(manifest.status, "READY"); assert.equal(manifest.mode, "current_policy_gateway");
  assert.equal(manifest.sql_execution, "NOT_RUN"); assert.equal(manifest.count, versionCount);
  assert.ok(Array.isArray(manifest.migrations) && manifest.migrations.length === versionCount);
  for (const entry of manifest.migrations) {
    assert.match(entry.version, /^\d{14}$/); assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.match(entry.path, /^backend\/supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/);
    assert.ok(entry.path.split("/").at(-1).startsWith(entry.version + "_"));
    const file = join(source, entry.path); assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
    assert.equal(createHash("sha256").update(readFileSync(file)).digest("hex"), entry.sha256);
    if (photoVerification) {
      const prepared = join(dirname(reviewedManifest), "supabase/migrations", entry.path.split("/").at(-1));
      assert.ok(lstatSync(prepared).isFile() && !lstatSync(prepared).isSymbolicLink());
      assert.equal(createHash("sha256").update(readFileSync(prepared)).digest("hex"), entry.sha256);
    }
    expectedVersions.push(entry.version);
  }
  assert.equal(new Set(expectedVersions).size, versionCount); expectedVersions.sort();
  assert.equal(expectedVersions.at(-1), latestVersion);
  if (photoVerification) {
    assert.equal(manifest.edge_execution, "NOT_RUN");
    assert.deepEqual(expectedVersions.filter(version => version >= "20261005040300" && version <= "20261005041000"), ["20261005040300","20261005040500","20261005040600","20261005040700","20261005040800","20261005040900","20261005041000"]);
    const edgePath = join(dirname(reviewedManifest), "edge-manifest.json");
    assert.ok(lstatSync(edgePath).isFile() && !lstatSync(edgePath).isSymbolicLink());
    const edgeBytes = readFileSync(edgePath);
    assert.equal(createHash("sha256").update(edgeBytes).digest("hex"), native69 ? native69Pins!.edgeSha256 : "9576fa79c91f8645e9064359c8c5c27958dee500c497df081b371e4a043acf9e");
    const edge = JSON.parse(edgeBytes.toString());
    assert.equal(edge.status, "READY"); assert.equal(edge.migration_count, versionCount);
    assert.ok(Array.isArray(edge.source_files) && edge.source_files.length === (native69 ? native69Pins!.edgeCount : 49));
    const seen = new Set<string>();
    for (const file of edge.source_files) {
      assert.ok(typeof file.path === "string" && (/^backend\/supabase\/functions\/[A-Za-z0-9_./-]+\.ts$/.test(file.path) || file.path === "backend/supabase/functions/deno.json"));
      assert.ok(!file.path.split("/").some((part: string) => part === ".." || part === ".") && !seen.has(file.path)); seen.add(file.path);
      assert.equal(file.target, file.path.slice("backend/".length)); assert.match(file.sha256, /^[a-f0-9]{64}$/);
      for (const candidate of [join(source, file.path), join(dirname(reviewedManifest), file.target)]) {
        assert.ok(lstatSync(candidate).isFile() && !lstatSync(candidate).isSymbolicLink());
        assert.equal(createHash("sha256").update(readFileSync(candidate)).digest("hex"), file.sha256);
      }
    }
  }
}
const hostedRoot = "/private/tmp/yumidang-hosted60-9tkezn03";
const hostedManifestPath = join(hostedRoot, "hosted-manifest.json"), hostedEnvPath = join(hostedRoot, "hosted-local.env");
let hostedWorkerSecret = "", hostedManifestHash: string | null = null;
let hostedSourceHashes: Record<string, string> = {};
if (hostedRuntimeBatch) {
  const directory = lstatSync(hostedRoot); assert.ok(directory.isDirectory() && !directory.isSymbolicLink());
  assert.equal(directory.uid, process.getuid!()); assert.equal(directory.mode & 0o777, 0o700);
  for (const path of [hostedManifestPath, hostedEnvPath]) {
    const st = lstatSync(path); assert.ok(st.isFile() && !st.isSymbolicLink());
    assert.equal(st.uid, process.getuid!()); assert.equal(st.mode & 0o777, 0o600);
  }
  const bytes = readFileSync(hostedManifestPath); hostedManifestHash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hostedManifestHash, "bd95c0cd46f232a6f0396b9c641382da7d3984aefe0836922fc4c6ac26a80042");
  const m = JSON.parse(bytes.toString()); assert.equal(m.status, "READY");
  assert.equal(m.scope, "isolated_native60_hosted_preparation"); assert.equal(m.project, "yumidang-minkyu-drift");
  assert.equal(m.api_port, 56531); assert.equal(m.db_port, 56532); assert.equal(m.env_path, hostedEnvPath);
  assert.equal(m.local_max_execution_ms, 120000);
  assert.equal(m.bootstrap_sha256, "cb051c2739132606c7da07f788cd3fd60e8e74248fc44be27aa0f938ef080c0c");
  hostedSourceHashes = Object.fromEntries(["supabase/functions/service-api/index.ts", "supabase/functions/_shared/services/member-lifecycle-service.ts", "supabase/functions/_shared/auth/member-cleanup.ts", "supabase/functions/_shared/db/repositories/member-cleanup.ts", "supabase/functions/service-api/hosted-local.ts"].map(path => [path, m.source_files[path]]));
  assert.equal(createHash("sha256").update(readFileSync(join(hostedRoot, "supabase/config.toml"))).digest("hex"), m.config_sha256);
  assert.equal(Object.keys(m.source_files).length, 50);
  for (const [path, sha] of Object.entries(m.source_files)) {
    assert.match(path, /^supabase\/functions\/[A-Za-z0-9_./-]+$/); assert.ok(!path.split("/").some(part => part === "." || part === ".."));
    const candidate = join(hostedRoot, path); assert.ok(lstatSync(candidate).isFile() && !lstatSync(candidate).isSymbolicLink());
    assert.equal(createHash("sha256").update(readFileSync(candidate)).digest("hex"), sha);
    if (!path.endsWith("/hosted-local.ts")) assert.equal(createHash("sha256").update(readFileSync(join(source, "backend", path))).digest("hex"), sha);
  }
  const envNames = ["INTERNAL_WORKER_SECRET", "ALLOWED_ORIGINS", "MAX_REQUEST_BYTES", "UPSTREAM_TIMEOUT_MS"];
  assert.deepEqual(m.env_names, envNames);
  const values = new Map<string, string>();
  for (const line of readFileSync(hostedEnvPath, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const match = line.match(/^([A-Z_]+)=(.*)$/); assert.ok(match); assert.ok(envNames.includes(match[1]) && !values.has(match[1]));
    try { values.set(match[1], match[2].startsWith('"') ? JSON.parse(match[2]) : match[2]); }
    catch { throw new Error("HOSTED_ENV_FORMAT"); }
  }
  assert.deepEqual([...values.keys()], envNames); hostedWorkerSecret = values.get("INTERNAL_WORKER_SECRET")!;
  assert.ok(/^[A-Za-z0-9_-]{32,512}$/.test(hostedWorkerSecret));
}
if (verifyRejoin) assert.equal(versionCount, 56);
for (const [path, mode] of [[statusFile, 0o600], [dirname(statusFile), 0o700]] as const) {
  const st = lstatSync(path); assert.equal(st.isSymbolicLink(), false); assert.equal(st.uid, process.getuid!()); assert.equal(st.mode & 0o777, mode);
}
const settings = JSON.parse(readFileSync(statusFile, "utf8"));
assert.equal(settings.API_URL, "http://127.0.0.1:56531");
const origin = settings.API_URL as string, service = settings.SERVICE_ROLE_KEY as string, anon = settings.ANON_KEY as string;
assert.ok(service && anon && service !== anon);
if (hostedRuntimeBatch) assert.ok(hostedWorkerSecret !== service && hostedWorkerSecret !== anon);
const host = "unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock";
const dbContainer = "supabase_db_yumidang-minkyu-drift", storageContainer = "supabase_storage_yumidang-minkyu-drift";
const artifact = mkdtempSync(join(tmpdir(), hostedRuntimeBatch ? "yumidang-cleanup-hosted-native60-" : `yumidang-cleanup-native${versionCount}-`));
const checks: string[] = [], report: Record<string, unknown> = { scope: hostedRuntimeBatch ? "isolated_native60_hosted_actual_http_db_auth_storage" : `isolated_native${versionCount}_actual_db_auth_storage`, checks };
let native67CatalogBaseline: string | null = null, native67CountsBaseline: string | null = null, protectedBaseline: string | null = null;
let native67GateOpened = false, native67GateCommitAcknowledged = false, native67GateRestored = false;
let native67AuditBaselineIds: string[] = [];
let native67AuditBaselineCaptured = false, native67BaselineCaptured = false;
const fixtureAuditIds: string[] = [];
let stage = "preflight", subject: string | null = null, userId: string | null = null, withdrawalId: string | null = null;
let runToken: string | null = null, opened = false, failed = false, hostedRemoteUncertain = false;
const names: string[] = [], externalDeletes = new Map<string, number>();
const extraUsers: Array<{ id: string; subject: string }> = [];
const extraSubjects: string[] = [];
let historicalPost: string | null = null, historicalAppointment: string | null = null;
const recoveryPath = join(artifact, "fixture-recovery.json");
const fixtureAliases: string[] = [];
const recoveryEvents: Array<Record<string, unknown>> = [];
function persistRecovery() {
  if (!photoVerification) return;
  const temp = recoveryPath + ".pending";
  writeFileSync(temp, JSON.stringify({ scope: native69 ? "isolated_native69_authenticated_photo" : "isolated_native67_signed_photo", stage, userId, subject, withdrawalId,
    names, extraUsers, extraSubjects, fixtureAliases, fixtureAuditIds, gateMayBeOpen: opened, gateCommitAcknowledged: native67GateCommitAcknowledged, gateRestored: native67GateRestored,
    workerMayBeHeld: runToken !== null, events: recoveryEvents, secretsRecorded: false, signedUrlRecorded: false }), { mode: 0o600 });
  const fd = openSync(temp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, recoveryPath);
  const directory = openSync(artifact, "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
}
const signatures = ["claim_member_cleanup_task(uuid)", "check_member_cleanup_task(uuid,uuid,uuid,uuid)",
  "get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)", "record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)",
  "complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)"];
const temporarySignatures = runtimeBatch ? [...signatures, "read_worker_run_budget(uuid)"] : signatures;
const functionList = temporarySignatures.map((s) => `public.${s}`).join(",");
const native60ClosedOnly = ["public.read_worker_queue_schedule(text[],text)", "private.notify_worker_queue_changed()"];
function assertClosedOnly() {
  for (const signature of native60ClosedOnly) {
    for (const role of ["service_role", "anon", "authenticated"]) assert.equal(sql(`select has_function_privilege(${literal(role)},${literal(signature)},'EXECUTE');`), "f");
  }
}
const nativeFetch = globalThis.fetch;
const deleteOrder: string[] = [];
const historicalRelations = ["public.posts", "public.join_requests", "public.appointments", "public.appointment_reviews", "private.appointment_member_episodes", "private.sweetness_review_contributions", "private.retired_post_bodies", "private.retired_consent_bodies", "private.conversation_retention"];
const native60Relations = [...historicalRelations, "private.member_reports", "private.member_report_details", "private.report_capture_assets", "private.report_access_audit", "private.safety_incidents", "private.safety_incident_report_links", "private.safety_incident_revisions", "private.safety_incident_subjects", "private.safety_sanction_applications", "private.safety_appointment_results", "private.safety_appointment_result_revisions", "private.safety_appeals", "private.member_retention_closures", "private.member_retention_report_links", "private.conversation_retention_generations", "private.conversation_message_generations", "private.conversation_generation_appointments"];
const relationCount = (relations: string[]) => relations.map((relation) => `(select count(*) from ${relation})`).join("+");
const roleCatalogQuery = "select jsonb_build_object('roles',(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit) order by rolname) from pg_roles),'memberships',(select coalesce(jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option) order by roleid,member,grantor),'[]') from pg_auth_members));";
function functionAclCatalog() {
  const oids = temporarySignatures.map(signature => `${literal('public.' + signature)}::regprocedure`).join(",");
  return sql(`select jsonb_agg(jsonb_build_object('function',p.oid::regprocedure::text,'owner',p.proowner,'acl',p.proacl::text) order by p.oid::regprocedure::text) from pg_proc p where p.oid in(${oids});`);
}
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
function native67Catalog() { return sql(`select jsonb_build_object(
          'roles',(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,md5(coalesce(rolconfig::text,''))) order by rolname) from pg_roles),
          'memberships',(select coalesce(jsonb_agg(jsonb_build_array(r.rolname,m.rolname,g.rolname,a.admin_option,a.inherit_option,a.set_option) order by r.rolname,m.rolname,g.rolname),'[]') from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor),
          'acls',(select jsonb_agg(jsonb_build_array(p.oid,p.oid::regprocedure::text,pg_get_userbyid(p.proowner),p.proacl::text,p.proconfig::text,case when p.prokind in('f','p')then md5(pg_get_functiondef(p.oid))else null end) order by p.oid::regprocedure::text) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth','storage')),
          'constraints',(select jsonb_agg(jsonb_build_array(c.oid,c.conrelid::regclass::text,c.conname,pg_get_constraintdef(c.oid),c.convalidated)order by c.oid)from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in('public','private','auth','storage')),
          'tableAcl',(select jsonb_agg(jsonb_build_array(c.oid,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
          'triggers',(select coalesce(jsonb_agg(jsonb_build_array(t.oid,t.tgrelid,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid))order by t.oid),'[]')from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')and not t.tgisinternal),
          'policies',(select coalesce(jsonb_agg(jsonb_build_array(p.oid,p.polrelid,p.polname,p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid))order by p.oid),'[]')from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
          'syncAudit',(select coalesce(jsonb_agg(to_jsonb(a)order by migration_version),'[]')from private.appointment_safety_sync_audit a),
          'columnAcls',(select jsonb_agg(jsonb_build_array(a.attrelid,a.attnum,a.attacl::text)order by a.attrelid,a.attnum)from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')and a.attnum>0 and not a.attisdropped),
          'bioAcl',(select attacl::text from pg_attribute where attrelid='public.profiles'::regclass and attname='bio'),
          'guard',(select external_deletion_approved from private.member_cleanup_guard where singleton),
          'history',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
          'idle',(select token is null and expires_at is null from private.global_worker_run where singleton));`); }
function native67Counts() {
  const relations: string[] = JSON.parse(sql("select coalesce(jsonb_agg(format('%I.%I',n.nspname,c.relname) order by n.nspname,c.relname),'[]') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage') and c.relkind='r';"));
  assert.ok(relations.length > 0 && relations.every(name => /^(public|private|auth|storage)\.[a-z_][a-z0-9_]*$/.test(name)));
  return sql(`select jsonb_object_agg(name,n) from(${relations.map(name => `select ${literal(name)} name,count(*)::text n from ${name}`).join(" union all ")}) all_counts;`);
}
function protectedContainers() {
  const ids = execFileSync("docker", ["--host", host, "ps", "-aq"], { encoding: "utf8", stdio: ["pipe","pipe","pipe"], timeout: 10000 }).trim().split(/\s+/);
  assert.ok(ids.length && ids.every(id => /^[a-f0-9]{12,64}$/.test(id)));
  const format = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"running":{{json .State.Running}},"startedAt":{{json .State.StartedAt}},"restartCount":{{json .RestartCount}}}';
  const rows = execFileSync("docker", ["--host", host, "inspect", "--format", format, ...ids], { encoding: "utf8", stdio: ["pipe","pipe","pipe"], timeout: 10000 }).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(rows.length, ids.length);
  assert.ok(rows.some(row => row.name === "/supabase_db_yumidang-minkyu-naver-live" && row.running));
  return JSON.stringify(rows.sort((a,b) => a.name.localeCompare(b.name)));
}
function assertNative67ClosedHelpers() {
  for (const signature of ["appointment_review_held(uuid)","enter_appointment_review(uuid,uuid)","resolve_appointment_review(uuid,uuid,bigint,uuid,text)","resume_appointment_review_if_clear(uuid)","sync_appointment_review_terminal_state(uuid)"]) {
    for (const role of ["anon","authenticated","service_role","yumidang_worker_queue"]) assert.equal(sql(`select has_function_privilege(${literal(role)},${literal("private."+signature)},'EXECUTE');`), "f");
    assert.equal(sql(`select exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=${literal("private."+signature)}::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');`), "f");
  }
  for (const relation of ["private.appointment_review_holds","private.appointment_review_windows","private.appointment_review_normal_completions"]) for (const role of ["anon","authenticated","service_role","yumidang_worker_queue"]) {
    assert.equal(sql(`select has_table_privilege(${literal(role)},${literal(relation)},'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');`), "f");
  }
}
function failureClass(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return { publicCode: toPublicError(error).error.code,
    transportCode: typeof code === "string" && /^[A-Z_0-9]{1,64}$/.test(code) ? code : null,
    timedOut: code === "ETIMEDOUT" || (error as { name?: unknown })?.name === "TimeoutError" };
}
function sql(query: string): string {
  if (photoVerification && /\b(insert|update|delete|grant|revoke|notify)\b/i.test(query)) {
    recoveryEvents.push({ kind: "owner_sql_intent", stage, sha256: createHash("sha256").update(query).digest("hex") }); persistRecovery();
  }
  return execFileSync("docker", ["--host", host, "exec", "-i", dbContainer, "psql", "-XqAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: photoVerification ? "set statement_timeout='8s';set lock_timeout='5s';" + query : query, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }).toString().trim();
}
function files(id?: string): number {
  if (id) assert.match(id, /^[0-9a-f-]{36}$/);
  const args = ["--host", host, "exec", storageContainer, "find", "/var/lib/storage", "-type", "f", ...(id ? ["-path", `*${id}*`] : [])];
  const text = execFileSync("docker", args, { stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }).toString().trim();
  return text ? text.split("\n").length : 0;
}
async function request(path: string, method = "GET", body?: unknown, token = service, binary = false): Promise<Response> {
  assert.equal(new URL(origin + path).origin, origin);
  if (photoVerification && ["POST","DELETE"].includes(method)) {
    if (path === "/auth/v1/admin/users" && method === "POST") {
      const email = (body as { email?: unknown })?.email;
      assert.ok(typeof email === "string" && /^[a-f0-9-]+@naver\.yumidang\.invalid$/.test(email));
      if (!fixtureAliases.includes(email)) fixtureAliases.push(email);
    }
    recoveryEvents.push({ kind: "local_http_intent", stage, method, path }); persistRecovery();
  }
  return await fetch(origin + path, { method, redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { apikey: token === service ? service : anon, Authorization: `Bearer ${token}`, "Content-Type": binary ? "image/jpeg" : "application/json" },
    ...(body === undefined ? {} : { body: binary ? new Uint8Array(body as Buffer).buffer : JSON.stringify(body) }) });
}
async function json(response: Response): Promise<any> {
  if (response.status !== 200) {
    let body: any = null; try { body = await response.json(); } catch { await response.body?.cancel().catch(() => {}); }
    report.providerFailure = { httpStatus: response.status, code: typeof body?.code === "string" && /^[A-Za-z_0-9]{1,64}$/.test(body.code) ? body.code : null,
      shapeKeys: body && typeof body === "object" ? Object.keys(body).sort() : [] };
    throw new Error("LOCAL_PROVIDER_STATUS");
  }
  return await response.json();
}
async function rpc(name: string, args: Record<string, unknown>, token = service) { return await json(await request(`/rest/v1/rpc/${name}`, "POST", args, token)); }
const encoded = (name: string) => name.split("/").map(encodeURIComponent).join("/");
async function registerAdditionalMember(verifiedSubject: string, image: Buffer) {
  extraSubjects.push(verifiedSubject);
  const account = await rpc("resolve_naver_account", { p_subject: verifiedSubject, p_name: "합성 재가입검증", p_gender: "F", p_birth_date: "1990-01-01" });
  const password = randomBytes(32).toString("base64url");
  const created = await json(await request("/auth/v1/admin/users", "POST", { email: account.authEmail, password, email_confirm: true }));
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  extraUsers.push({ id: created.id, subject: verifiedSubject });
  report.additionalFixtureIds = extraUsers.map(({ id }) => id);
  const session = await json(await request("/auth/v1/token?grant_type=password", "POST", { email: account.authEmail, password }, anon));
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString()); assert.equal(claims.sub, created.id);
  await rpc("record_naver_session", { p_subject: verifiedSubject, p_user_id: created.id, p_session_id: claims.session_id });
  const name = `${created.id}/${randomUUID()}.jpg`; names.push(name);
  report.additionalFixtureNames = names.filter((path) => extraUsers.some((member) => path.startsWith(member.id + "/")));
  await json(await request(`/storage/v1/object/profile-images/${encoded(name)}`, "POST", image, session.access_token, true));
  assert.equal(sql(`select owner_id=${literal(created.id)} from storage.objects where bucket_id='profile-images' and name=${literal(name)};`), "t");
  assert.equal((await rpc("complete_naver_signup", { p_avatar_path: name, p_interests: [], p_conversation_styles: [], p_mbti: null }, session.access_token)).status, "ready");
  return { id: created.id as string, token: session.access_token as string, name };
}
const tracedFetch: typeof fetch = async (url, init) => {
  const target = new URL(String(url)); assert.equal(target.origin, origin);
  const allowed = names.flatMap((name) => [`/storage/v1/object/info/authenticated/profile-images/${encoded(name)}`, `/storage/v1/object/authenticated/profile-images/${encoded(name)}`]);
  assert.ok(allowed.includes(target.pathname) || target.pathname === "/storage/v1/object/profile-images" || target.pathname === `/auth/v1/admin/users/${userId}`);
  if (init?.method === "DELETE") {
    if (target.pathname.startsWith("/storage")) {
      const body = JSON.parse(String(init.body)); assert.deepEqual(Object.keys(body), ["prefixes"]); assert.equal(body.prefixes.length, 1); assert.ok(names.includes(body.prefixes[0]));
      externalDeletes.set(body.prefixes[0], (externalDeletes.get(body.prefixes[0]) ?? 0) + 1); if (runtimeBatch) deleteOrder.push("storage");
    } else {
      assert.deepEqual(JSON.parse(String(init.body)), { should_soft_delete: false });
      if (runtimeBatch) {
        assert.equal(sql(`select count(*) from private.member_cleanup_tasks where withdrawal_id=${literal(withdrawalId!)}::uuid and kind='storage_object' and state='completed';`), "2");
        assert.equal(files(userId!), 0); deleteOrder.push("auth");
      }
      externalDeletes.set("auth", (externalDeletes.get("auth") ?? 0) + 1);
    }
  }
  return await nativeFetch(url, init);
};

try {
  assert.equal(execFileSync("docker", ["--host", host, "inspect", dbContainer, "--format", "{{.Name}}"], { stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }).toString().trim(), "/" + dbContainer);
  const bindings = JSON.parse(execFileSync("docker", ["--host", host, "inspect", "supabase_kong_yumidang-minkyu-drift", "--format", '{{json (index .NetworkSettings.Ports "8000/tcp")}}'], { stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }).toString());
  assert.ok(Array.isArray(bindings) && bindings.length > 0 && bindings.every((b) => b.HostPort === "56531"));
  const baseline = JSON.parse(sql(`begin read only; select jsonb_build_object('database',current_database(),'versions',(select count(*) from supabase_migrations.schema_migrations),'latest',(select max(version) from supabase_migrations.schema_migrations),'rows',(select count(*) from auth.users)+(select count(*) from public.profiles)+(select count(*) from private.naver_accounts)+(select count(*) from private.member_episodes)+(select count(*) from storage.objects)+(select count(*) from private.member_retirements)+(select count(*) from private.member_cleanup_tasks)+(select count(*) from private.member_cleanup_delete_acks),'guard',(select external_deletion_approved from private.member_cleanup_guard where singleton),'worker',(select token is null from private.global_worker_run where singleton)); rollback;`));
  assert.deepEqual(baseline, { database: "postgres", versions: versionCount, latest: latestVersion, rows: 0, guard: false, worker: true }); assert.equal(files(), 0);
  if (verifyRejoin) {
    stage = "rejoin_historical_baseline";
    assert.equal(sql("begin read only; select (select count(*) from public.posts)+(select count(*) from public.join_requests)+(select count(*) from public.appointments)+(select count(*) from public.appointment_reviews)+(select count(*) from private.appointment_member_episodes)+(select count(*) from private.sweetness_review_contributions)+(select count(*) from private.retired_post_bodies)+(select count(*) from private.retired_consent_bodies)+(select count(*) from private.conversation_retention); rollback;"), "0");
  }
  if (runtimeBatch) {
    assert.deepEqual(JSON.parse(sql("begin read only; select jsonb_agg(version order by version) from supabase_migrations.schema_migrations; rollback;")), expectedVersions);
    assert.equal(sql(`begin read only; select ${relationCount(native60Relations)}; rollback;`), "0");
    report.reviewedSqlManifestSha256 = manifestHash;
    roleBaseline = sql(roleCatalogQuery); aclBaseline = functionAclCatalog();
    assertClosedOnly();
  }
  for (const signature of temporarySignatures) assert.equal(sql(`select has_function_privilege('service_role','public.${signature}','EXECUTE') or has_function_privilege('anon','public.${signature}','EXECUTE') or has_function_privilege('authenticated','public.${signature}','EXECUTE');`), "f");
  const adapterPath = "backend/supabase/functions/_shared/auth/member-cleanup.ts";
  assert.equal(createHash("sha256").update(readFileSync(join(source, adapterPath))).digest("hex"), createHash("sha256").update(readFileSync(new URL("../../../" + adapterPath, import.meta.url))).digest("hex"));
  const { createMemberCleanupPorts } = await import(pathToFileURL(join(source, "backend/supabase/functions/_shared/db/repositories/member-cleanup.ts")).href);
  report.codeHashes = { adapter: createHash("sha256").update(readFileSync(join(source, adapterPath))).digest("hex"), ports: createHash("sha256").update(readFileSync(join(source, "backend/supabase/functions/_shared/db/repositories/member-cleanup.ts"))).digest("hex") };
  checks.push(`exact_native${versionCount}_empty_guard_false_acl_closed`);
  if (photoVerification) {
    stage = "native67_preflight_audit_ids";
    native67AuditBaselineIds = JSON.parse(sql("select coalesce(jsonb_agg(id::text order by id),'[]') from auth.audit_log_entries;"));
    assert.ok(native67AuditBaselineIds.every(id => /^[a-f0-9-]{36}$/.test(id)));
    native67AuditBaselineCaptured = true;
    stage = "native67_preflight_full_catalog";
    native67CatalogBaseline = native67Catalog();
    stage = "native67_preflight_all_relation_counts";
    native67CountsBaseline = native67Counts();
    stage = "native67_preflight_protected_containers";
    protectedBaseline = protectedContainers();
    stage = "native67_preflight_role_cleanup_acl";
    roleBaseline = sql(roleCatalogQuery); aclBaseline = functionAclCatalog();
    stage = "native67_preflight_history_guard_idle";
    const catalog = JSON.parse(native67CatalogBaseline);
    assert.deepEqual(catalog.history, expectedVersions); assert.equal(catalog.guard, false); assert.equal(catalog.idle, true);
    stage = "native67_preflight_postflight_file";
    const postflightPath = native69 ? native69Pins!.postflightPath : "/private/tmp/yumidang-native67-rollout/postflight.json";
    const postflightStat = lstatSync(postflightPath); assert.ok(postflightStat.isFile() && !postflightStat.isSymbolicLink() && postflightStat.uid === process.getuid!());
    const postflight = JSON.parse(readFileSync(postflightPath, "utf8"));
    stage = "native67_preflight_postflight_roles_memberships";
    assert.deepEqual(catalog.roles, postflight.roles); assert.deepEqual(catalog.memberships, postflight.memberships);
    stage = "native67_preflight_postflight_history_guard_idle";
    assert.deepEqual(catalog.history, postflight.history); assert.equal(postflight.guard, false); assert.equal(postflight.idle, true);
    stage = "native67_preflight_postflight_count_subset";
    const counts = JSON.parse(native67CountsBaseline);
    for (const [relation, count] of Object.entries(postflight.counts)) assert.equal(counts[relation], String(count));
    stage = "native67_preflight_private_helpers_tables_closed";
    assertNative67ClosedHelpers(); assertClosedOnly();
    native67BaselineCaptured = true;
    report.reviewedSqlManifestSha256 = manifestHash;
    report.reviewedEdgeManifestSha256 = native69 ? "f722925e555b1457450b2fb22336322ae6e4b48b672a9b482a6c4e77011b592c" : "9576fa79c91f8645e9064359c8c5c27958dee500c497df081b371e4a043acf9e";
    report.mode = native69 ? "AUTHENTICATED_PHOTO_ACTUAL_LOCAL_AUTH_STORAGE_SQL_NOT_NAVER_OAUTH_NOT_HOSTED_EDGE" : "SIGNED_PHOTO_ACTUAL_LOCAL_AUTH_STORAGE_SQL_NOT_NAVER_OAUTH_NOT_HOSTED_EDGE";
    persistRecovery();
  }
  stage = "synthetic_signup";
  subject = "cleanup-native55-" + randomUUID();
  stage = "resolve_synthetic_naver";
  const account = await rpc("resolve_naver_account", { p_subject: subject, p_name: "합성 삭제검증", p_gender: "F", p_birth_date: "1990-01-01" });
  const password = randomBytes(32).toString("base64url");
  stage = "auth_admin_create";
  const authUser = await json(await request("/auth/v1/admin/users", "POST", { email: account.authEmail, password, email_confirm: true }));
  assert.match(authUser.id, /^[0-9a-f-]{36}$/); userId = authUser.id; persistRecovery();
  report.fixtureIds = { userId };
  stage = "auth_password_session";
  const session = await json(await request("/auth/v1/token?grant_type=password", "POST", { email: account.authEmail, password }, anon));
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString()); assert.equal(claims.sub, userId);
  stage = "record_naver_session";
  await rpc("record_naver_session", { p_subject: subject, p_user_id: userId, p_session_id: claims.session_id });
  // 테스트 provider 파일의 고정 합성 1px JPEG만 재사용한다. 실행하거나 회원 사진을 읽지 않는다.
  const fixtureSource = readFileSync(new URL("./member_cleanup_provider_local.ts", import.meta.url), "utf8");
  const base64 = fixtureSource.match(/const image = Buffer\.from\("([A-Za-z0-9+/=]+)"/); assert.ok(base64);
  const image = Buffer.from(base64[1], "base64");
  for (const [index, filename] of [randomUUID() + ".jpg", "legacy photo?.jpeg"].entries()) {
    stage = index === 0 ? "actual_member_canonical_storage_upload" : "actual_legacy_service_storage_upload";
    const name = `${userId}/${filename}`; names.push(name);
    report.fixtureIds = { userId, names: [...names] };
    // 현재 INSERT RLS는 UUID.jpg만 허용한다. legacy fixture는 실제 service API/본인 첫 folder로 준비한다.
    await json(await request(`/storage/v1/object/profile-images/${encoded(name)}`, "POST", image, index === 0 ? session.access_token : service, true));
    assert.equal(sql(`select ${index === 0 ? `owner_id=${literal(userId!)}` : `owner_id is null and split_part(name,'/',1)=${literal(userId!)}`} from storage.objects where bucket_id='profile-images' and name=${literal(name)};`), "t");
  }
  report.photoOwnership = { canonical: "MEMBER_JWT_OWNER_ID", legacy: "SERVICE_API_OWN_FIRST_FOLDER_OWNER_NULL" };
  stage = "complete_native_signup";
  const signup = await rpc("complete_naver_signup", { p_avatar_path: names[0], p_interests: [], p_conversation_styles: [], p_mbti: null }, session.access_token);
  assert.equal(signup.status, "ready"); assert.equal(files(userId!), 2);
  assert.equal(sql(`select count(*) from private.member_episodes where profile_id=${literal(userId!)}::uuid and ended_at is null;`), "1");
  checks.push("actual_auth_signup_episode_two_owned_binary_photos");
  let peer: Awaited<ReturnType<typeof registerAdditionalMember>> | null = null;
  const authenticatedPhotoObservations: Array<Record<string, unknown>> = [];
  let imageHttp: ((request: Request) => Promise<Response>) | null = null;
  async function observeAuthenticatedPhoto(phase: "before_retirement" | "processing_before_storage_delete" | "after_actual_storage_delete_ack") {
    if (!native69) return;
    assert.ok(peer && imageHttp);
    const shouldAllow = phase === "before_retirement";
    for (const [caller, token] of [["owner", session.access_token], ["active_peer", peer.token]] as const) {
      for (const method of ["GET", "HEAD", "INFO", "WRAPPER"] as const) {
        const target = `/storage/v1/object/${method === "INFO" ? "info/authenticated" : "authenticated"}/profile-images/${encoded(names[0])}`;
        const response: Response = method === "WRAPPER" ? await imageHttp(new Request(origin + `/service-api/profile-images/${names[0]}`, { headers: { Authorization: "Bearer " + token } }))
          : await request(target, method === "HEAD" ? "HEAD" : "GET", undefined, token);
        const bytes = Buffer.from(await response.arrayBuffer());
        const exactPhoto = bytes.equals(image), isJpeg = response.headers.get("content-type")?.startsWith("image/jpeg") === true;
        if (shouldAllow) {
          assert.equal(response.status, 200);
          if (method === "GET" || method === "WRAPPER") assert.ok(exactPhoto && isJpeg);
          if (method === "HEAD") assert.equal(bytes.length, 0);
          if (method === "INFO") { const metadata = JSON.parse(bytes.toString()); assert.ok(metadata && typeof metadata === "object"); }
          if (method === "WRAPPER") {
            assert.equal(response.headers.get("cache-control"), "private, no-store");
            assert.ok(response.headers.get("vary")?.includes("Authorization"));
            assert.equal(response.headers.get("etag"), null); assert.equal(response.headers.get("set-cookie"), null);
          }
        } else {
          assert.ok([400,401,403,404].includes(response.status)); assert.ok(!exactPhoto && !isJpeg);
          if (method === "WRAPPER") assert.equal(response.headers.get("cache-control"), "no-store");
        }
        authenticatedPhotoObservations.push({ phase, caller, method, httpStatus: response.status, exactPhotoBytes: exactPhoto });
      }
    }
    // 실제 남은 peer 자신의 사진은 탈퇴 대상과 독립적으로 계속 접근할 수 있어야 한다.
    const ownPeer = await request(`/storage/v1/object/authenticated/profile-images/${encoded(peer.name)}`, "GET", undefined, peer.token);
    assert.equal(ownPeer.status, 200); assert.ok(Buffer.from(await ownPeer.arrayBuffer()).equals(image));
    report.authenticatedPhotoAccess = { observations: authenticatedPhotoObservations, legacySignedUrlRevocation: "NOT_PROVEN", hostedEdge: "NOT_RUN", mobileCache: "NOT_RUN", productionCdn: "NOT_RUN" };
  }
  if (native69) {
    stage = "native69_storage_compatibility_and_token_issuance_denied";
    assert.equal(execFileSync("docker", ["--host", host, "inspect", storageContainer, "--format", "{{.Config.Image}}"], { stdio: ["pipe","pipe","pipe"], timeout:10000 }).toString().trim(), "public.ecr.aws/supabase/storage-api:v1.70.3");
    peer = await registerAdditionalMember("cleanup-photo-peer-" + randomUUID(), image);
    const { createProfileImageExecutor } = await import(pathToFileURL(join(source, "backend/supabase/functions/service-api/profile-image-http.ts")).href);
    const { createServiceApi } = await import(pathToFileURL(join(source, "backend/supabase/functions/service-api/handler.ts")).href);
    const imageConfig = { supabaseUrl: origin, supabaseAnonKey: anon, supabaseServiceRoleKey: service, internalWorkerSecret: randomBytes(32).toString("base64url"), upstreamTimeoutMs:10000, maxRequestBytes:8192, allowedOrigins:[] };
    imageHttp = createServiceApi({ allowedOrigins: [], maxBodyBytes:8192, profileImages:{ execute:createProfileImageExecutor(imageConfig, nativeFetch) },
      authenticateUser: async () => { throw new Error("UNEXPECTED_JSON_AUTHENTICATOR"); }, authenticateInternal: async () => { throw new Error("UNEXPECTED_INTERNAL_AUTHENTICATOR"); } });
    const unusedPath = `${userId}/${randomUUID()}.jpg`;
    const deniedIssuance: Array<Record<string, unknown>> = [];
    for (const [kind, path, body] of [
      ["single", `/storage/v1/object/sign/profile-images/${encoded(names[0])}`, {expiresIn:300}],
      ["many", "/storage/v1/object/sign/profile-images", {paths:[names[0]],expiresIn:300}],
      ["signed_upload", `/storage/v1/object/upload/sign/profile-images/${encoded(unusedPath)}`, {}],
      ["transformed_signed", `/storage/v1/object/sign/profile-images/${encoded(names[0])}`, {expiresIn:300, transform:{width:16}}],
    ] as const) {
      const response = kind === "signed_upload"
        ? await request(path, "POST", image, session.access_token, true)
        : await request(path, "POST", body, session.access_token);
      const payload = await response.json();
      // many 응답은 200과 항목별 오류일 수 있다. 200만으로 성공/실패를 판단하지 않는다.
      if (kind === "many") {
        assert.equal(response.status, 200); assert.ok(Array.isArray(payload) && payload.length === 1);
        assert.ok(payload[0].error && payload[0].signedURL === null);
      } else assert.ok([400,401,403,404].includes(response.status));
      if (kind === "signed_upload") assert.match(String(payload.message ?? ""), /row.level security/i, "SIGNED_UPLOAD_DENIAL_MUST_PROVE_RLS_NOT_MIME_OR_PARSER_FAILURE");
      assert.ok(!JSON.stringify(payload).includes("?token=") && !JSON.stringify(payload).includes('"token":'));
      deniedIssuance.push({kind,httpStatus:response.status,bearerIssued:false});
    }
    assert.equal(sql(`select count(*) from storage.objects where bucket_id='profile-images' and name=${literal(unusedPath)};`), "0");
    assert.equal(files(userId!), 2);
    report.native69Issuance = deniedIssuance;
    checks.push("native69_actual_single_many_signed_upload_transformed_sign_no_bearer");
    // 원본 대표사진 삭제는 거절되고, 실제 회원 RPC로 교체한 뒤 이전 원본 삭제만 허용된다.
    const previous = names[0];
    const refusedDelete = await request("/storage/v1/object/profile-images", "DELETE", {prefixes:[previous]}, session.access_token);
    assert.ok([400,401,403,404].includes(refusedDelete.status)); await refusedDelete.body?.cancel();
    assert.equal(sql(`select count(*) from storage.objects where bucket_id='profile-images' and name=${literal(previous)};`), "1");
    assert.equal(files(userId!), 2);
    const replacement = `${userId}/${randomUUID()}.jpg`; names.push(replacement); persistRecovery();
    await json(await request(`/storage/v1/object/profile-images/${encoded(replacement)}`, "POST", image, session.access_token, true));
    await rpc("set_my_profile_avatar", {p_avatar_path:replacement}, session.access_token);
    await json(await request("/storage/v1/object/profile-images", "DELETE", {prefixes:[previous]}, session.access_token));
    assert.equal(sql(`select count(*) from storage.objects where bucket_id='profile-images' and name=${literal(previous)};`), "0");
    assert.equal(files(userId!), 2);
    names.splice(names.indexOf(previous), 1); names.splice(names.indexOf(replacement), 1); names.unshift(replacement); persistRecovery();
    checks.push("native69_actual_canonical_upload_current_delete_guard_avatar_replace_old_delete");
    await observeAuthenticatedPhoto("before_retirement");
    checks.push("native69_actual_owner_peer_get_head_info_and_http_wrapper_before_retirement");
  }
  const retirementPhotoNames = names.filter(name => name.startsWith(userId + "/"));
  // 후보: signed URL은 Authorization/apikey 없이 실제 bytes를 읽는다.
  // URL/token은 메모리에만 두며 결과·로그·복구 파일에 기록하지 않는다.
  let signedPhotoUrl: URL | null = null, signedPhotoIssuedAt = 0;
  const signedPhotoObservations: Array<Record<string, unknown>> = [];
  const observeSignedPhoto = async (phase: "before_retirement" | "processing_before_storage_delete" | "after_actual_storage_delete_ack") => {
    if (!native67) return;
    assert.ok(signedPhotoUrl);
    assert.ok(Date.now() - signedPhotoIssuedAt < 250000, "SIGNED_PHOTO_EXPIRY_NOT_REVOCATION_EVIDENCE");
    let response: Response;
    try {
      response = await nativeFetch(signedPhotoUrl!, { method: "GET", redirect: "error", credentials: "omit",
        headers: {}, signal: AbortSignal.timeout(10000) });
    } catch { throw new Error("SIGNED_PHOTO_LOCAL_TRANSPORT_FAILED"); }
    const bytes = Buffer.from(await response.arrayBuffer());
    const exactFixtureBytes = bytes.equals(image);
    const jpegResponse = response.headers.get("content-type")?.startsWith("image/jpeg") === true;
    assert.ok(response.ok || [400, 401, 403, 404].includes(response.status), "SIGNED_PHOTO_UNEXPECTED_STATUS");
    if (response.ok) assert.ok(exactFixtureBytes && jpegResponse, "SIGNED_PHOTO_UNEXPECTED_SUCCESS_BYTES");
    else assert.ok(!exactFixtureBytes && !jpegResponse, "SIGNED_PHOTO_DENIAL_RETURNED_IMAGE");
    signedPhotoObservations.push({ phase, httpStatus: response.status, exactFixtureBytes,
      jpegResponse, responseBytes: bytes.length, elapsedSinceIssueMs: Date.now() - signedPhotoIssuedAt });
    if (phase === "before_retirement") assert.ok(response.ok && exactFixtureBytes);
    if (phase === "processing_before_storage_delete") {
      // 실제 처리 단계 관측만 기록하며 삭제 후 차단을 즉시 회수의 증거로 확대하지 않는다.
      const policyImmediateRevocation = response.ok ? "FAIL" : "PASS";
      report.signedPhotoAccess = { observations: signedPhotoObservations, policyImmediateRevocation,
        processingStage: response.ok ? "EXACT_PHOTO_BYTES_STILL_ACCESSIBLE" : "ACCESS_DENIED_BEFORE_STORAGE_DELETE",
        deleteStage: "NOT_RUN", urlOrTokenRecorded: false, authHeadersSent: false };
      // 정책 실패를 유지하면서 실제 삭제·ACK와 finally 복원을 계속한다.
      if (response.ok) failed = true;
    }
    if (phase === "after_actual_storage_delete_ack") {
      assert.ok(!response.ok && !exactFixtureBytes);
      const previous = report.signedPhotoAccess as Record<string, unknown>;
      report.signedPhotoAccess = { ...previous, observations: signedPhotoObservations,
        deleteStage: "ACCESS_DENIED_AFTER_ACTUAL_STORAGE_DELETE_ACK" };
    }
  };
  if (native67 && !observeOwnedAuth) {
    stage = "signed_photo_issue_before_retirement";
    signedPhotoIssuedAt = Date.now();
    const signed = await json(await request(`/storage/v1/object/sign/profile-images/${encoded(names[0])}`,
      "POST", { expiresIn: 300 }, session.access_token));
    assert.ok(typeof signed.signedURL === "string");
    signedPhotoUrl = new URL("/storage/v1" + signed.signedURL, origin);
    assert.equal(signedPhotoUrl.origin, origin);
    assert.equal(signedPhotoUrl.pathname, `/storage/v1/object/sign/profile-images/${encoded(names[0])}`);
    assert.ok(!signedPhotoUrl.username && !signedPhotoUrl.password && !signedPhotoUrl.hash);
    assert.ok(signedPhotoUrl.searchParams.size === 1 && signedPhotoUrl.searchParams.has("token"));
    assert.ok(signedPhotoUrl.searchParams.get("token"));
    await observeSignedPhoto("before_retirement");
    checks.push("signed_photo_before_retirement_exact_bytes_without_auth_headers");
  }
  let originalEpisode: string | null = null, originalIdentity: string | null = null;
  let historicalReviews: unknown = null;
  if (verifyRejoin) {
    stage = "rejoin_history_prepare";
    peer = await registerAdditionalMember("cleanup-rejoin-peer-" + randomUUID(), image);
    const episode = JSON.parse(sql(`select jsonb_build_object('id',id,'identityId',identity_id) from private.member_episodes where profile_id=${literal(userId!)}::uuid and ended_at is null;`));
    originalEpisode = episode.id; originalIdentity = episode.identityId;
    assert.match(originalEpisode!, /^[0-9a-f-]{36}$/); assert.match(originalIdentity!, /^[0-9a-f-]{36}$/);
    historicalPost = randomUUID(); historicalAppointment = randomUUID(); const joinId = randomUUID();
    // 과거 완료 약속만 owner 합성 fixture다. DB 시계·완료 정책을 바꾸지 않으며 후기는 실제 회원 RPC로 작성한다.
    sql(`begin; select set_config('request.jwt.claims','{"role":"service_role"}',true);
      insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status) values(${literal(historicalPost)}::uuid,${literal(userId!)}::uuid,'합성 재가입 이력','합성 후기 보존 검증','산책',now()-interval '4 days',now()-interval '3 days',now()-interval '5 days','서울특별시 강남구 역삼동','closed');
      insert into public.join_requests(id,post_id,requester_id,message,status) values(${literal(joinId)}::uuid,${literal(historicalPost)}::uuid,${literal(peer.id)}::uuid,'합성 과거 신청','matched');
      insert into public.appointments(id,post_id,join_request_id,status,confirmed_at,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at) values(${literal(historicalAppointment)}::uuid,${literal(historicalPost)}::uuid,${literal(joinId)}::uuid,'completed',now()-interval '4 days',now()-interval '2 days','automatic',now()-interval '2 days',now()-interval '1 day',now()+interval '5 days'); commit;`);
    await rpc("submit_appointment_review", { p_appointment_id: historicalAppointment, p_rating: 5, p_comment: "합성 보존 후기", p_experience: "positive", p_praises: [] }, session.access_token);
    await rpc("submit_appointment_review", { p_appointment_id: historicalAppointment, p_rating: 5, p_comment: "합성 받은 후기", p_experience: "positive", p_praises: [] }, peer.token);
    assert.equal((await rpc("get_my_profile", {}, session.access_token)).sweetness, 17);
    const received = await rpc("get_public_profile_reviews", { p_profile_id: userId, p_limit: 10, p_before: null }, peer.token); assert.equal(received.reviews.length, 1);
    historicalReviews = await rpc("get_public_profile_reviews", { p_profile_id: peer.id, p_limit: 10, p_before: null }, session.access_token);
    assert.equal((historicalReviews as { reviews: unknown[] }).reviews.length, 1);
    checks.push("historical_fixture_actual_member_reviews_public_old_episode_score17");
  }
  if (observeOwnedAuth) {
    stage = "owned_auth_provider_observation";
    const response = await request(`/auth/v1/admin/users/${userId}`, "DELETE", { should_soft_delete: false });
    const body = await response.json();
    const authRows = Number(sql(`select count(*) from auth.users where id=${literal(userId!)}::uuid;`));
    const objectRows = Number(sql(`select count(*) from storage.objects where bucket_id='profile-images' and owner_id=${literal(userId!)};`));
    report.ownedAuthDelete = { httpStatus: response.status, code: typeof body.error_code === "string" && /^[A-Za-z_]{1,64}$/.test(body.error_code) ? body.error_code : null,
      authRows, ownedObjectRows: objectRows, allFixtureObjectRows: Number(sql(`select count(*) from storage.objects where bucket_id='profile-images' and split_part(name,'/',1)=${literal(userId!)};`)), backendFiles: files(userId!) };
    report.authForeignKeys = JSON.parse(sql("select coalesce(jsonb_agg(jsonb_build_object('relation',conrelid::regclass::text,'definition',pg_get_constraintdef(oid))),'[]') from pg_constraint where contype='f' and confrelid='auth.users'::regclass and connamespace in('private'::regnamespace,'storage'::regnamespace,'public'::regnamespace);"));
    assert.ok((response.status === 200 && authRows === 0) || (response.status >= 400 && response.status <= 599 && authRows === 1));
    if (authRows === 1) { assert.equal(objectRows, 1); assert.equal(files(userId!), 2); }
    report.mode = "OWNED_AUTH_PROVIDER_OBSERVATION_NO_RETIREMENT_OR_WORKER_GATE";
    checks.push("actual_owned_auth_delete_status_and_separate_residuals");
  } else {
  assert.ok(versionCount === 56 || runtimeBatch || photoVerification, "전체 탈퇴 실행은 명시 native56/native60에서만 허용한다");
  stage = "closed_pipeline_retirement_denied"; withdrawalId = randomUUID();
  const closedResponse = await request("/rest/v1/rpc/retire_my_account", "POST", { p_withdrawal_id: withdrawalId }, session.access_token);
  assert.equal(closedResponse.ok, false);
  const closedBody = await closedResponse.json(); assert.equal(closedBody.code, "55000");
  assert.equal(sql(`select (select count(*) from private.member_retirements where profile_id=${literal(userId!)}::uuid)+(select count(*) from private.member_cleanup_tasks where profile_id=${literal(userId!)}::uuid);`), "0");
  const available = await request("/rest/v1/rpc/get_my_profile", "POST", {}, session.access_token); assert.equal(available.status, 200); await available.body?.cancel();
  const visible = await request(`/storage/v1/object/authenticated/profile-images/${encoded(names[0])}`, "GET", undefined, session.access_token); assert.equal(visible.status, 200); await visible.body?.cancel();
  assert.equal(sql(`select count(*) from private.member_episodes where profile_id=${literal(userId!)}::uuid and ended_at is null;`), "1");
  checks.push("closed_pipeline_retirement_55000_no_tasks_member_and_photo_access_preserved");
  stage = "temporary_local_worker_gate";
  if (runtimeBatch || photoVerification) opened = true; // COMMIT 응답이 소실돼도 finally 복원을 시도한다.
  if (photoVerification) { native67GateOpened = true; persistRecovery(); }
  sql(`begin; update private.member_cleanup_guard set external_deletion_approved=true where singleton; grant execute on function ${functionList} to service_role; notify pgrst,'reload schema'; commit;`); opened = true;
  if (photoVerification) { native67GateCommitAcknowledged = true; persistRecovery(); }
  stage = "retirement";
  assert.deepEqual(await rpc("retire_my_account", { p_withdrawal_id: withdrawalId }, session.access_token), { withdrawalId, status: "processing", memberAccessRevoked: true });
  assert.equal(sql(`select count(*) from private.member_cleanup_tasks where withdrawal_id=${literal(withdrawalId)}::uuid and state='pending';`), "3");
  assert.equal(sql(`select count(*) from auth.sessions where user_id=${literal(userId!)}::uuid;`), "0");
  const denied = await request("/rest/v1/rpc/get_my_profile", "POST", {}, session.access_token); assert.equal(denied.status, 403); await denied.body?.cancel();
  const hidden = await request(`/storage/v1/object/authenticated/profile-images/${encoded(names[0])}`, "GET", undefined, session.access_token);
  assert.ok([400, 401, 403, 404].includes(hidden.status)); await hidden.body?.cancel();
  checks.push("member_jwt_retirement_three_tasks_access_revoked");
  if (native67) {
  stage = "signed_photo_processing_before_any_storage_delete";
  assert.equal(files(userId!), 2);
  assert.equal(sql(`select count(*) from private.member_cleanup_delete_acks a join private.member_cleanup_tasks t on t.id=a.task_id where t.withdrawal_id=${literal(withdrawalId!)}::uuid;`), "0");
  await observeSignedPhoto("processing_before_storage_delete");
  checks.push("signed_photo_processing_stage_observed_before_any_delete_ack");
  }
  if (native69) {
    stage = "native69_authenticated_photo_processing_before_any_storage_delete";
    assert.equal(files(userId!), 2);
    assert.equal(sql(`select count(*) from private.member_cleanup_delete_acks a join private.member_cleanup_tasks t on t.id=a.task_id where t.withdrawal_id=${literal(withdrawalId!)}::uuid;`), "0");
    await observeAuthenticatedPhoto("processing_before_storage_delete");
    checks.push("native69_actual_owner_peer_and_http_denied_processing_delete_ack_zero_photo_files_present");
  }
  stage = "global_worker_acquisition";
  const acquireStartedAt = Date.now();
  const worker = await rpc("acquire_worker_run", { p_lease_seconds: 180, p_existing_token: null }); assert.ok(worker); runToken = worker.token; persistRecovery();
  assert.match(runToken!, /^[0-9a-f-]{36}$/);
  stage = "global_expiry_parse";
  assert.equal(typeof worker.expiresAt, "string");
  const providerExpiryEpoch = Date.parse(worker.expiresAt);
  report.globalExpiryValidation = { parsedSafeEpoch: Number.isSafeInteger(providerExpiryEpoch) };
  assert.ok(Number.isSafeInteger(providerExpiryEpoch));
  const leaseReadStartedAt = Date.now();
  stage = "global_lease_database_read";
  const lease = JSON.parse(sql(`begin read only; select jsonb_build_object('tokenMatches',token=${literal(runToken!)}::uuid,'expiresAt',expires_at,'remainingMs',floor(extract(epoch from(expires_at-clock_timestamp()))*1000)) from private.global_worker_run where singleton; rollback;`));
  const tokenMatches = lease.tokenMatches === true;
  const expiryMatches = typeof lease.expiresAt === "string" && Date.parse(lease.expiresAt) === providerExpiryEpoch;
  const remainingValid = Number.isSafeInteger(lease.remainingMs) && lease.remainingMs > 0 && lease.remainingMs <= 180000;
  report.globalExpiryValidation = { parsedSafeEpoch: true, tokenMatches, expiryMatches, remainingValid };
  stage = "global_lease_token_match"; assert.equal(tokenMatches, true);
  stage = "global_lease_expiry_match"; assert.equal(expiryMatches, true);
  stage = "global_lease_remaining_valid"; assert.equal(remainingValid, true);
  const globalDeadlineAt = Math.min(leaseReadStartedAt + lease.remainingMs, acquireStartedAt + 180000);
  const budgetAvailable = Number.isSafeInteger(globalDeadlineAt) && globalDeadlineAt > Date.now();
  report.globalExpiryValidation = { parsedSafeEpoch: true, tokenMatches, expiryMatches, remainingValid, budgetAvailable };
  stage = "global_host_budget_available"; assert.equal(budgetAvailable, true);
  const budget = { deadlineAt: globalDeadlineAt };
  const config = { supabaseUrl: origin, supabaseAnonKey: anon, supabaseServiceRoleKey: service, internalWorkerSecret: randomBytes(32).toString("base64url"), upstreamTimeoutMs: 10000, maxRequestBytes: 8192, allowedOrigins: [] };
  if (hostedRuntimeBatch) {
    stage = "native60_hosted_runtime_batch";
    report.hostedManifestSha256 = hostedManifestHash;
    report.hostedSourceHashes = hostedSourceHashes;
    report.hostedSourceBoundary = "PINNED_49_MAIN_SOURCES_AND_LOCAL_BOOTSTRAP_NOT_NODE_FETCH_PROXY";
    const endpoint = origin + "/functions/v1/service-api/internal/member-cleanup";
    const hostedRequest = async (secret: string, body: Record<string, unknown>, timeoutMs = 10000) => nativeFetch(endpoint, {
      method: "POST", redirect: "error", credentials: "omit", signal: AbortSignal.timeout(timeoutMs),
      headers: { apikey: anon, authorization: `Bearer ${secret}`, "content-type": "application/json", "x-worker-run-token": runToken! }, body: JSON.stringify(body),
    });
    const state = () => ({ metadata: JSON.parse(sql(`select jsonb_build_object('tasks',(select jsonb_agg(jsonb_build_array(kind,state,n) order by kind,state) from (select kind,state,count(*) n from private.member_cleanup_tasks where withdrawal_id=${literal(withdrawalId!)}::uuid group by kind,state) x),'acks',(select count(*) from private.member_cleanup_delete_acks where withdrawal_id=${literal(withdrawalId!)}::uuid),'authRows',(select count(*) from auth.users where id=${literal(userId!)}::uuid));`)), files: files(userId!) });
    const before = state();
    for (const [secret, body, status] of [["fixture_wrong_internal_secret", {}, 403], [session.access_token, {}, 403],
      [hostedWorkerSecret, { workerRunToken: runToken }, 400]] as const) {
      hostedRemoteUncertain = true;
      const rejected = await hostedRequest(secret, body); assert.equal(rejected.status, status);
      assert.equal((await rejected.json()).error?.code, status === 403 ? "ACCESS_DENIED" : "INVALID_REQUEST");
      assert.deepEqual(state(), before);
      hostedRemoteUncertain = false;
    }
    checks.push("hosted_wrong_internal_secret_member_jwt_body_token_denied_fixture_unchanged");
    const timeoutMs = Math.floor(Math.min(130000, globalDeadlineAt - Date.now() - 5000));
    assert.ok(timeoutMs > 0); report.hostedHttpTimeoutMs = timeoutMs;
    hostedRemoteUncertain = true;
    try {
      const response = await hostedRequest(hostedWorkerSecret, {}, timeoutMs);
      report.hostedHttpStatus = response.status; assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, { status: "ran", claimed: 3, succeeded: 3 });
      const evidence = JSON.parse(sql(`select jsonb_build_object('completedTasks',(select count(*) from private.member_cleanup_tasks where withdrawal_id=${literal(withdrawalId!)}::uuid and state='completed'),'acks',(select count(*) from private.member_cleanup_delete_acks where withdrawal_id=${literal(withdrawalId!)}::uuid),'storageAckBeforeCompletion',not exists(select 1 from private.member_cleanup_tasks t join private.member_cleanup_delete_acks a on a.task_id=t.id where t.withdrawal_id=${literal(withdrawalId!)}::uuid and t.kind='storage_object' and a.recorded_at>t.completed_at),'storageCompletionBeforeAuthAck',(select max(t.completed_at) from private.member_cleanup_tasks t where t.withdrawal_id=${literal(withdrawalId!)}::uuid and t.kind='storage_object') <= (select a.recorded_at from private.member_cleanup_delete_acks a where a.withdrawal_id=${literal(withdrawalId!)}::uuid and a.kind='auth_user'),'authAckBeforeCompletion',(select a.recorded_at<=t.completed_at from private.member_cleanup_tasks t join private.member_cleanup_delete_acks a on a.task_id=t.id where t.withdrawal_id=${literal(withdrawalId!)}::uuid and t.kind='auth_user'),'withdrawalCompleted',(select state='completed' from private.member_retirements where withdrawal_id=${literal(withdrawalId!)}::uuid));`));
      assert.deepEqual(evidence, { completedTasks: 3, acks: 3, storageAckBeforeCompletion: true, storageCompletionBeforeAuthAck: true, authAckBeforeCompletion: true, withdrawalCompleted: true });
      assert.equal(files(userId!), 0);
      for (const name of retirementPhotoNames) {
        const absent = await request(`/storage/v1/object/authenticated/profile-images/${encoded(name)}`, "GET");
        let semanticAbsent = absent.status === 404;
        if (absent.status === 400) { const error = await absent.json(); semanticAbsent = error.code === "NoSuchKey" && error.statusCode === "404"; }
        else await absent.body?.cancel();
        assert.equal(semanticAbsent, true);
      }
      const absentAuth = await request(`/auth/v1/admin/users/${userId!}`, "GET"); assert.equal(absentAuth.status, 404); await absentAuth.body?.cancel();
      assert.equal(sql(`select count(*) from auth.users where id=${literal(userId!)}::uuid;`), "0");
      assert.equal(sql(`select count(*) from storage.objects where bucket_id='profile-images' and name in(${retirementPhotoNames.map(literal).join(",")});`), "0");
      report.hostedEvidence = { ...evidence, authAbsent: true, files: 0, providerDeleteCount: "NOT_OBSERVED_BY_NODE", providerDispatchOrder: "NOT_OBSERVED_BY_NODE" };
      hostedRemoteUncertain = false;
      checks.push("hosted_actual_http_budget_cleanup_three_tasks_ack_chronology_auth_photo_absent");
    } catch (error) {
      report.hostedFailure = { ...failureClass(error), remoteCompletionUncertain: true };
      try { report.hostedFailureState = state(); } catch (readError) { report.hostedFailureStateRead = failureClass(readError); }
      throw error;
    }
  } else if (runtimeBatch) {
    stage = "native60_internal_runtime_batch";
    const runtimePath = "backend/supabase/functions/service-api/index.ts";
    const servicePath = "backend/supabase/functions/_shared/services/member-lifecycle-service.ts";
    report.runtimeSourceHashes = Object.fromEntries([runtimePath, servicePath].map(path => [path, createHash("sha256").update(readFileSync(join(source, path))).digest("hex")]));
    const { createRuntimeHandler } = await import(pathToFileURL(join(source, runtimePath)).href);
    const values: Record<string, string> = { SUPABASE_URL: origin, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service,
      INTERNAL_WORKER_SECRET: config.internalWorkerSecret, ALLOWED_ORIGINS: "[]", MAX_REQUEST_BYTES: "8192", UPSTREAM_TIMEOUT_MS: "10000" };
    const internalRequest = (secret = config.internalWorkerSecret) => new Request(origin + "/functions/v1/service-api/internal/member-cleanup", {
      method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "x-worker-run-token": runToken! }, body: "{}",
    });
    const rpcCalls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const target = new URL(String(input)); assert.equal(target.origin, origin);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${service}`);
      assert.equal(new Headers(init?.headers).get("apikey"), service);
      if (target.pathname.startsWith("/rest/v1/rpc/")) {
        const name = target.pathname.split("/").at(-1)!;
        assert.ok(temporarySignatures.some(signature => signature.split("(")[0] === name));
        assert.equal(init?.method, "POST"); rpcCalls.push(name);
        return await nativeFetch(input, init);
      }
      return await tracedFetch(input, init);
    };
    try {
      assert.equal((await createRuntimeHandler((k: string) => values[k])(internalRequest())).status, 404);
      const handler = createRuntimeHandler((k: string) => values[k], { memberCleanup: true, memberCleanupExecution: { maxExecutionMs: 120000 } });
      assert.equal((await handler(internalRequest("fixture_invalid_internal_secret"))).status, 403);
      assert.equal(rpcCalls.length, 0); assert.equal(deleteOrder.length, 0);
      const response = await handler(internalRequest()); assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, { status: "ran", claimed: 3, succeeded: 3 });
      assert.equal(rpcCalls[0], "read_worker_run_budget");
      for (const signature of temporarySignatures) assert.ok(rpcCalls.includes(signature.split("(")[0]));
      assert.deepEqual(deleteOrder, ["storage", "storage", "auth"]);
      for (const name of retirementPhotoNames) assert.equal(externalDeletes.get(name), 1);
      assert.equal(externalDeletes.get("auth"), 1); assert.equal(files(userId!), 0);
      assert.equal(sql(`select count(*) from private.member_cleanup_tasks where withdrawal_id=${literal(withdrawalId!)}::uuid and state='completed';`), "3");
      assert.equal(sql(`select state from private.member_retirements where withdrawal_id=${literal(withdrawalId!)}::uuid;`), "completed");
      assert.equal(sql(`select count(*) from auth.users where id=${literal(userId!)}::uuid;`), "0");
      report.runtimeBatch = { localMaxExecutionMs: 120000, rpcCalls, deleteOrder, storageDeletes: 2, authDeletes: 1,
        scope: "IN_PROCESS_RUNTIME_REQUEST_ACTUAL_NATIVE_REST_AUTH_STORAGE_NOT_HOSTED_EDGE_OR_J_RUNNER" };
      checks.push("native60_runtime_default_404_wrong_internal_secret_403_no_upstream");
      checks.push("native60_internal_request_budget_rest_six_rpc_provider_storage_before_auth_three_completed");
    } finally { globalThis.fetch = nativeFetch; }
  } else if (photoVerification) {
    stage = "native67_actual_storage_cleanup";
    const db: MemberCleanupPorts = createMemberCleanupPorts(config, nativeFetch);
    const adapter = createMemberCleanupAdapter(config, tracedFetch);
    for (let index=0; index<2; index++) assert.deepEqual(await processMemberCleanupTask(runToken!, db, adapter, budget), { status: "applied" });
    assert.equal(sql(`select count(*) from private.member_cleanup_delete_acks a join private.member_cleanup_tasks t on t.id=a.task_id where t.withdrawal_id=${literal(withdrawalId!)}::uuid and t.kind='storage_object';`), "2");
    assert.equal(files(userId!), 0);
    assert.equal(externalDeletes.has("auth"), false);
    stage = "signed_photo_after_storage_ack_before_auth_delete";
    await observeSignedPhoto("after_actual_storage_delete_ack");
    if (native69) { await observeAuthenticatedPhoto("after_actual_storage_delete_ack"); checks.push("native69_actual_photo_denied_after_storage_ack_peer_own_still_accessible"); }
    stage = "native67_actual_auth_cleanup";
    assert.deepEqual(await processMemberCleanupTask(runToken!, db, adapter, budget), { status: "applied" });
    assert.deepEqual(await processMemberCleanupTask(runToken!, db, adapter, budget), { status: "idle" });
    assert.equal(externalDeletes.get("auth"), 1);
    for (const name of retirementPhotoNames) assert.equal(externalDeletes.get(name), 1);
    assert.equal(sql(`select count(*) from private.member_cleanup_tasks where withdrawal_id=${literal(withdrawalId!)}::uuid and state='completed';`), "3");
    assert.equal(sql(`select state from private.member_retirements where withdrawal_id=${literal(withdrawalId!)}::uuid;`), "completed");
    assert.equal(sql(`select count(*) from auth.users where id=${literal(userId!)}::uuid;`), "0");
    checks.push("native67_actual_storage_two_acks_then_auth_three_completed");
  } else {
  const rpcFetch: typeof fetch = async (input, init) => {
    const target = new URL(String(input)); assert.equal(target.origin, origin);
    assert.ok(signatures.some((signature) => target.pathname === `/rest/v1/rpc/${signature.split("(")[0]}`));
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        let body: any = null; try { body = await response.clone().json(); } catch { /* 본문을 저장하지 않는다. */ }
        report.lastCleanupRpcFailure = { stage, httpStatus: response.status,
          sqlState: typeof body?.code === "string" && /^[A-Z0-9]{5}$/.test(body.code) ? body.code : null };
      }
      return response;
    } catch (error) { report.lastCleanupRpcFailure = { stage, ...failureClass(error) }; throw error; }
  };
  const db: MemberCleanupPorts = createMemberCleanupPorts(config, rpcFetch);
  const adapter = createMemberCleanupAdapter(config, tracedFetch);
  let claimed: MemberCleanupTask | null = null, failedTask: MemberCleanupTask | null = null;
  let failedOnce = false;
  const ports: MemberCleanupPorts = { ...db,
    async claim(token, signal) { const value = await db.claim(token, signal); claimed = value as MemberCleanupTask | null; return value; },
    async complete(fence, signal) {
      if (!failedOnce && claimed?.kind === "storage_object") {
        failedOnce = true; failedTask = claimed;
        // 실제 DB가 잘못된 lease의 complete를 거절한다. provider 삭제·durable ack는 이미 성공했다.
        return await db.complete({ ...fence, leaseToken: randomUUID() }, signal);
      }
      return await db.complete(fence, signal);
    },
  };
  stage = "actual_cleanup_and_one_database_failure";
  let initiallyIdle = false;
  for (let i = 0; i < 5; i++) {
    try { if ((await processMemberCleanupTask(runToken!, ports, adapter, budget)).status === "idle") { initiallyIdle = true; break; } }
    catch (error) {
      const detail: Record<string, unknown> = { ...failureClass(error), capturedTask: failedTask !== null };
      try { detail.globalLeaseValid = sql(`select token=${literal(runToken!)}::uuid and expires_at>clock_timestamp() from private.global_worker_run where singleton;`) === "t"; }
      catch (diagnosticError) { detail.leaseReadFailure = failureClass(diagnosticError); }
      report.cleanupAttemptFailure = detail;
      assert.ok(failedTask); assert.equal(toPublicError(error).error.code, "STATE_CONFLICT");
    }
  }
  assert.ok(failedTask); const pending = failedTask as MemberCleanupTask;
  assert.equal(sql(`select state from private.member_cleanup_tasks where id=${literal(pending.taskId)}::uuid;`), "running");
  const ackBefore = sql(`select receipt_id::text||':'||ack_sha256 from private.member_cleanup_delete_acks where task_id=${literal(pending.taskId)}::uuid;`); assert.match(ackBefore, /^[0-9a-f-]{36}:[0-9a-f]{64}$/);
  assert.equal(externalDeletes.get(pending.objectName!), 1); assert.equal(files(userId!), 0);
  checks.push("actual_delete_ack_database_complete_rejected_no_false_completion");
  if (versionCount === 56) {
    assert.equal(initiallyIdle, true); assert.equal(externalDeletes.has("auth"), false);
    assert.equal(sql(`select count(*) from private.member_cleanup_tasks where withdrawal_id=${literal(withdrawalId)}::uuid and kind='auth_user' and state='pending';`), "1");
    assert.equal(sql(`select count(*) from auth.users where id=${literal(userId!)}::uuid;`), "1");
    checks.push("actual_auth_task_unclaimable_until_storage_completed");
  }
  stage = "actual_60_second_task_expiry";
  const deadline = Date.now() + 65000;
  while (sql(`select lease_expires_at<=clock_timestamp() from private.member_cleanup_tasks where id=${literal(pending.taskId)}::uuid;`) !== "t") {
    assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  stage = "actual_reclaim_receipt_recovery";
  const recovering: MemberCleanupPorts = { ...db, async claim(token, signal) {
    const recovered = await db.claim(token, signal) as MemberCleanupTask;
    assert.equal(recovered.taskId, pending.taskId); assert.notEqual(recovered.leaseToken, pending.leaseToken);
    assert.equal(sql(`select receipt_id::text||':'||ack_sha256 from private.member_cleanup_delete_acks where task_id=${literal(pending.taskId)}::uuid;`), ackBefore);
    return recovered;
  } };
  assert.deepEqual(await processMemberCleanupTask(runToken!, recovering, adapter, budget), { status: "applied" });
  if (versionCount === 56) assert.deepEqual(await processMemberCleanupTask(runToken!, db, adapter, budget), { status: "applied" });
  assert.equal(externalDeletes.get(pending.objectName!), 1); assert.equal(externalDeletes.get("auth"), 1);
  for (const name of retirementPhotoNames) assert.equal(externalDeletes.get(name), 1);
  assert.equal(sql(`select count(*) from private.member_cleanup_tasks where withdrawal_id=${literal(withdrawalId)}::uuid and state='completed';`), "3");
  const receipt = JSON.parse(sql(`select jsonb_build_object('withdrawalId',withdrawal_id,'status',state,'memberAccessRevoked',true) from private.member_retirements where withdrawal_id=${literal(withdrawalId)}::uuid;`));
  assert.deepEqual(receipt, { withdrawalId, status: "completed", memberAccessRevoked: true });
  report.receiptRetry = "OWNER_READ_ONLY_SAME_WITHDRAWAL_NOT_STALE_JWT_RPC";
  assert.deepEqual(await processMemberCleanupTask(runToken!, db, adapter, budget), { status: "idle" });
  assert.equal(files(userId!), 0);
  checks.push("actual_expired_reclaim_durable_receipt_no_second_delete");
  checks.push("actual_three_tasks_completed_same_withdrawal_owner_receipt");
  } // 기존 native56 개별 task/60초 복구 증거 경로는 그대로 유지한다.
  if (native67) {
  stage = "signed_photo_after_actual_storage_delete_ack";
  assert.equal(files(userId!), 0);
  assert.equal(sql(`select count(*) from private.member_cleanup_delete_acks a join private.member_cleanup_tasks t on t.id=a.task_id where t.withdrawal_id=${literal(withdrawalId!)}::uuid and t.kind='storage_object';`), "2");
  assert.equal(sql(`select count(*) from storage.objects where bucket_id='profile-images' and split_part(name,'/',1)=${literal(userId!)};`), "0");
  checks.push("signed_photo_delete_stage_denied_after_exact_two_storage_acks_and_backend_absence");
  }
  if (verifyRejoin) {
    stage = "same_identity_actual_rejoin";
    assert.ok(peer && originalEpisode && originalIdentity && historicalAppointment);
    assert.equal(sql(`select ended_at is not null and identity_id=${literal(originalIdentity)}::uuid from private.member_episodes where id=${literal(originalEpisode)}::uuid;`), "t");
    const joined = await registerAdditionalMember(subject!, image); assert.notEqual(joined.id, userId);
    const freshEpisode = JSON.parse(sql(`select jsonb_build_object('id',id,'identityId',identity_id) from private.member_episodes where profile_id=${literal(joined.id)}::uuid and ended_at is null;`));
    assert.notEqual(freshEpisode.id, originalEpisode); assert.equal(freshEpisode.identityId, originalIdentity);
    assert.equal((await rpc("get_my_profile", {}, joined.token)).sweetness, 15);
    const freshReviews = await rpc("get_public_profile_reviews", { p_profile_id: joined.id, p_limit: 10, p_before: null }, peer.token);
    assert.deepEqual(freshReviews.reviews, []); assert.equal(freshReviews.completedCount, 0);
    const preserved = await rpc("get_public_profile_reviews", { p_profile_id: peer.id, p_limit: 10, p_before: null }, joined.token);
    assert.deepEqual(preserved, historicalReviews);
    assert.equal(sql(`select ap.status='completed' and ae.author_episode_id=${literal(originalEpisode)}::uuid and p.author_id=${literal(userId!)}::uuid from public.appointments ap join public.posts p on p.id=ap.post_id join private.appointment_member_episodes ae on ae.appointment_id=ap.id where ap.id=${literal(historicalAppointment)}::uuid;`), "t");
    const stale = await request("/rest/v1/rpc/get_my_profile", "POST", {}, session.access_token); assert.equal(stale.status, 403); await stale.body?.cancel();
    const stalePhoto = await request(`/storage/v1/object/authenticated/profile-images/${encoded(joined.name)}`, "GET", undefined, session.access_token);
    assert.ok([400,401,403,404].includes(stalePhoto.status)); await stalePhoto.body?.cancel();
    checks.push("same_verified_identity_new_auth_episode_photo_score15_reviews0_old_jwt_denied");
    checks.push("historical_appointment_episode_and_peer_public_review_preserved");
    report.rejoinBoundary = "SYNTHETIC_VERIFIED_NAVER_BINDING_ACTUAL_AUTH_STORAGE_MEMBER_REVIEW_RPCS_NOT_NAVER_OAUTH";
  }
  }
} catch (error) {
  failed = true;
  report.failure = { stage, ...failureClass(error) };
}
finally {
  stage = "finally_cleanup";
  const cleanupErrors: string[] = [];
  const attempt = async (label: string, action: () => unknown | Promise<unknown>) => {
    try { await action(); } catch (error) {
      cleanupErrors.push(label);
      const failures = (report.cleanupStepFailures ??= []) as unknown[];
      failures.push({ step: label, ...failureClass(error) });
    }
  };
  await attempt("restore_guard_acl", () => { if (opened) {
    assert.ok(!photoVerification || !native67GateRestored, "NATIVE67_GATE_RESTORE_REPEATED");
    sql(`begin; update private.member_cleanup_guard set external_deletion_approved=false where singleton; revoke all on function ${functionList} from service_role; notify pgrst,'reload schema'; commit;`);
    if (photoVerification) { native67GateRestored = true; opened = false; persistRecovery(); }
  } });
  const verified: Record<string, unknown> = photoVerification ? { fullBaselineCaptured: native67BaselineCaptured, auditBaselineCaptured: native67AuditBaselineCaptured } : {};
  const preserveHostedFixture = hostedRuntimeBatch && hostedRemoteUncertain;
  if (!preserveHostedFixture) {
  await attempt("release_global_worker", async () => { if (runToken) { const released = await rpc("release_worker_run", { p_token: runToken }); assert.equal(released.status, "applied"); } });
  await attempt("delete_fixture_rows", () => {
    if (photoVerification && fixtureAliases.length) {
      // Auth create 응답 유실도 먼저 저장한 내부 별칭으로 해당 fixture ID만 회수한다.
      const found: string[] = JSON.parse(sql(`select coalesce(jsonb_agg(id),'[]') from auth.users where email in(${fixtureAliases.map(literal).join(",")});`));
      for (const id of found) if (id !== userId && !extraUsers.some(member => member.id === id)) { assert.match(id, /^[a-f0-9-]{36}$/); assert.ok(subject); extraUsers.push({ id, subject }); }
      persistRecovery();
    }
    const ids = [userId, ...extraUsers.map((member) => member.id)].filter((id): id is string => id !== null);
    const idList = ids.map((id) => `${literal(id)}::uuid`).join(",");
    const subjects = [...new Set([subject, ...extraSubjects].filter((item): item is string => item !== null))];
    const subjectList = subjects.map(literal).join(",");
    sql(`begin; ${photoVerification && historicalAppointment ? `delete from private.appointment_review_normal_completions where appointment_id=${literal(historicalAppointment)}::uuid;delete from private.appointment_review_holds where appointment_id=${literal(historicalAppointment)}::uuid;delete from private.appointment_review_windows where appointment_id=${literal(historicalAppointment)}::uuid;delete from private.safety_appointment_result_revisions where appointment_id=${literal(historicalAppointment)}::uuid;delete from private.safety_appointment_results where appointment_id=${literal(historicalAppointment)}::uuid;` : ""} ${historicalAppointment ? `delete from public.appointments where id=${literal(historicalAppointment)}::uuid;` : ""}
      ${historicalPost ? `delete from public.join_requests where post_id=${literal(historicalPost)}::uuid; delete from public.posts where id=${literal(historicalPost)}::uuid;` : ""}
      ${ids.length ? `delete from private.member_cleanup_tasks where profile_id in(${idList}); delete from private.member_retirements where profile_id in(${idList}); delete from public.profiles where id in(${idList}); delete from private.member_episodes where profile_id in(${idList});` : ""}
      ${subjects.length ? `delete from private.naver_identity_keys where subject in(${subjectList}); delete from private.naver_accounts where subject in(${subjectList});` : ""} commit;`);
  });
  // 활성 fixture의 avatar FK와 Naver Auth FK를 먼저 없애고 실제 파일은 반드시 provider API로 정리한다.
  for (const name of names) await attempt("delete_fixture_storage", async () => { const r = await request("/storage/v1/object/profile-images", "DELETE", { prefixes: [name] }); assert.equal(r.status, 200); await r.body?.cancel(); });
  for (const id of [userId, ...extraUsers.map((member) => member.id)].filter((id): id is string => id !== null)) {
    await attempt("delete_fixture_auth", async () => { const r = await request(`/auth/v1/admin/users/${id}`, "DELETE", { should_soft_delete: false }); assert.ok([200, 404].includes(r.status)); await r.body?.cancel(); });
  }
  if (photoVerification && native67AuditBaselineCaptured) await attempt("delete_exact_fixture_auth_audit_only", () => {
    const markers = [...new Set([userId,...extraUsers.map(member=>member.id),...fixtureAliases].filter((value): value is string => value !== null))];
    if (markers.length) {
      const rows: string[] = JSON.parse(sql(`select coalesce(jsonb_agg(a.id::text order by a.id),'[]') from auth.audit_log_entries a where exists(select 1 from jsonb_path_query(a.payload::jsonb,'$.**') v(value) where v.value in(${markers.map(value=>`to_jsonb(${literal(value)}::text)`).join(",")}));`));
      for (const id of rows) if (!native67AuditBaselineIds.includes(id)) { assert.match(id,/^[a-f0-9-]{36}$/); fixtureAuditIds.push(id); }
      persistRecovery();
      if (fixtureAuditIds.length) sql(`begin;delete from auth.audit_log_entries where id in(${fixtureAuditIds.map(id=>literal(id)+"::uuid").join(",")});commit;`);
    }
    assert.deepEqual(JSON.parse(sql("select coalesce(jsonb_agg(id::text order by id),'[]') from auth.audit_log_entries;")),native67AuditBaselineIds);
    verified.exactFixtureAuthAuditRestored = true;
  });
  await attempt("verify_files_zero", () => { assert.equal(files(), 0); verified.files = 0; });
  await attempt("verify_rows_zero", () => {
    assert.equal(sql(`select (select count(*) from public.profiles)+(select count(*) from auth.users)+(select count(*) from storage.objects)+(select count(*) from private.member_episodes)+(select count(*) from private.naver_identity_keys)+(select count(*) from private.naver_accounts)+(select count(*) from private.member_retirements)+(select count(*) from private.member_cleanup_tasks)+(select count(*) from private.member_cleanup_delete_acks);`), "0"); verified.rows = 0;
  });
  if (verifyRejoin) await attempt("verify_historical_fixture_rows_zero", () => {
    assert.equal(sql("select (select count(*) from public.posts)+(select count(*) from public.join_requests)+(select count(*) from public.appointments)+(select count(*) from public.appointment_reviews)+(select count(*) from private.appointment_member_episodes)+(select count(*) from private.sweetness_review_contributions)+(select count(*) from private.retired_post_bodies)+(select count(*) from private.retired_consent_bodies)+(select count(*) from private.conversation_retention);"), "0"); verified.historicalRows = 0;
  });
  if (runtimeBatch) await attempt("verify_native60_relations_zero", () => {
    assert.equal(sql(`select ${relationCount(native60Relations)};`), "0"); verified.native60Relations = 0;
    assert.deepEqual(JSON.parse(sql("select jsonb_agg(version order by version) from supabase_migrations.schema_migrations;")), expectedVersions);
    verified.migrationHistoryUnchanged = true;
    assert.equal(sql(roleCatalogQuery), roleBaseline); verified.globalRolesUnchanged = true;
    assert.equal(functionAclCatalog(), aclBaseline); verified.rpcAclBaselineRestored = true;
    assertClosedOnly();
  });
  await attempt("verify_guard_false", () => { assert.equal(sql("select external_deletion_approved from private.member_cleanup_guard where singleton;"), "f"); verified.guard = false; });
  await attempt("verify_cleanup_acl_zero", () => {
    const expressions = temporarySignatures.map((signature) => ["service_role", "anon", "authenticated"].map((role) => `has_function_privilege('${role}','public.${signature}','EXECUTE')`).join(" or "));
    assert.equal(sql(`select ${expressions.join(" or ")};`), "f"); verified.cleanupRpcExecution = false;
  });
  await attempt("verify_global_worker_null", () => { assert.equal(sql("select token is null from private.global_worker_run where singleton;"), "t"); verified.globalWorker = runToken ? "released" : "unchanged"; });
  if (photoVerification && native67BaselineCaptured) await attempt("verify_native67_all_catalog_counts_protected", () => {
    assert.ok(native67CatalogBaseline && native67CountsBaseline && protectedBaseline);
    assert.equal(native67Counts(), native67CountsBaseline); assert.equal(native67Catalog(), native67CatalogBaseline);
    assert.equal(protectedContainers(), protectedBaseline); assert.equal(functionAclCatalog(), aclBaseline);
    assert.equal(sql(roleCatalogQuery), roleBaseline); assertNative67ClosedHelpers(); assertClosedOnly();
    verified.fullCatalogRestored = true; verified.allRelationCountsRestored = true; verified.protectedContainersUnchanged = true;
    verified.exactCleanupOwnerAclRestored = true; verified.gateOpenAttemptedOnce = native67GateOpened; verified.gateCommitAcknowledged = native67GateCommitAcknowledged; verified.gateRestoredOnce = native67GateRestored;
  });
  } else {
    failed = true;
    await attempt("verify_uncertain_guard_acl_closed", () => {
      assert.equal(sql("select external_deletion_approved from private.member_cleanup_guard where singleton;"), "f"); verified.guard = false;
      const expressions = temporarySignatures.flatMap(signature => ["service_role", "anon", "authenticated"].map(role => `has_function_privilege('${role}','public.${signature}','EXECUTE')`));
      assert.equal(sql(`select ${expressions.join(" or ")};`), "f"); verified.cleanupRpcExecution = false;
      assert.equal(functionAclCatalog(), aclBaseline); verified.rpcAclBaselineRestored = true;
      assert.equal(sql(roleCatalogQuery), roleBaseline); verified.globalRolesUnchanged = true;
      assertClosedOnly();
    });
    const recovery = join(artifact, "fixture-recovery.json");
    await attempt("preserve_fixture_recovery", () => writeFileSync(recovery, JSON.stringify({ scope: "isolated_native60_hosted_remote_uncertain", userId, subject, withdrawalId, names, extraUsers, extraSubjects, globalTokenNotRecorded: true }), { mode: 0o600 }));
    report.fixtureRecovery = recovery;
    verified.fixtureCleanup = "NOT_ATTEMPTED_REMOTE_UNCERTAIN"; verified.globalWorker = "NOT_RELEASED_REMOTE_UNCERTAIN";
  }
  report.cleanup = preserveHostedFixture ? { status: "INCOMPLETE_REMOTE_UNCERTAIN", verified, steps: cleanupErrors } : cleanupErrors.length ? { status: "FAILED", verified, steps: cleanupErrors } : verified;
  if (cleanupErrors.length) failed = true;
  else if (!preserveHostedFixture) checks.push(runToken ? "finally_original_false_guard_acl_zero_worker_released_rows_files_zero" : "finally_false_guard_acl_zero_worker_unchanged_rows_files_zero");
  if (runtimeBatch || photoVerification) {
    // 기존55/56 복구용 private fixture 추적은 유지하되 신규 결과에는 회원 UUID/경로를 넣지 않는다.
    delete report.fixtureIds; delete report.additionalFixtureIds; delete report.additionalFixtureNames;
  }
  if (photoVerification) {
    if (cleanupErrors.length === 0 && verified.fullCatalogRestored === true) {
      await attempt("remove_durable_recovery_after_verified_cleanup", () => {
        unlinkSync(recoveryPath); const directory=openSync(artifact,"r");try { fsyncSync(directory); } finally { closeSync(directory); }
      });
    }
    if (cleanupErrors.length) { failed=true; report.cleanup={ status:"FAILED",verified,steps:cleanupErrors }; report.fixtureRecovery=recoveryPath; }
    report[native69 ? "native69AuthenticatedPhotoScope" : "native67SignedPhotoScope"] = { fullBaselineCaptured: native67BaselineCaptured, syntheticNaverBinding: true, actualLocalAuthStorage: true, realNaverOAuth: false,
      hostedEdge: false, remoteCalls: false, guardAndFiveRpcTemporaryLocalOnly: true, tokenOrSignedUrlRecorded: false };
  }
  report.result = failed ? "FAIL" : "PASS";
  writeFileSync(join(artifact, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ result: report.result, checks: checks.length, cleanup: report.cleanup, artifact: join(artifact, "result.json") }));
}
if (failed) process.exitCode = 1;
