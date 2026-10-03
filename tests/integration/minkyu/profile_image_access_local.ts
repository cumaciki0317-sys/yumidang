/** 민규: 빈 전용 40 SQL 환경의 실제 Auth·Storage HTTP 사진 접근 검사.
 * 합성 계정과 작은 JPEG만 사용하며 실제 네이버·원격·회원 자료는 호출하지 않는다.
 * 이미 발급된 signed URL의 즉시 회수는 주장하지 않는다. 새 발급과 인증 download만 검사한다.
 * YUMIDANG_PROFILE_IMAGE_ACCESS_LOCAL_CONFIG=권한0600config.json node 이파일 --run
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createNaverSessionBridge } from "../../../backend/supabase/functions/_shared/auth/session-bridge.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const API = "http://127.0.0.1:56521", CONTEXT = "colima-yumidang-minkyu", PROJECT = "yumidang-minkyu-gateway";
const DB = `supabase_db_${PROJECT}`, nativeFetch = globalThis.fetch;
type Row = Record<string, any>;
type Member = { uid: string; token: string; email: string };
let checks = 0, groups = 0, stage = "configuration", guarded = false, cleaned = false, emptyTables = 0;
let cfg: Row, failure: string | undefined, diagnostic: { httpStatus: number; errorCode: string } | undefined;
let nativeAuth = false, actualStorageUpload = false, guestNativeAuth = false;
const users: string[] = [], subjects: string[] = [], emails: string[] = [], images: string[] = [];
const uuid = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
function check(value: unknown, label = "check_failed"): asserts value { checks++; if (!value) { failure = label; throw new Error("PHOTO_ACCESS_CHECK_FAILED"); } }
const row = (x: unknown): Row => { check(x !== null && typeof x === "object" && !Array.isArray(x)); return x as Row; };
const quote = (x: string) => { check(uuid(x) || /^photo-http-[0-9a-f-]+$/.test(x) || /^[0-9a-f-]+@naver\.yumidang\.invalid$/.test(x)); return `'${x}'`; };
const sql = (input: string) => execFileSync("docker", ["--context", CONTEXT, "exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-X", "-qAt", "-v", "ON_ERROR_STOP=1"],
  { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 1048576 }).trim();
function zero() {
  const tables = JSON.parse(sql("select coalesce(jsonb_agg(jsonb_build_array(schemaname,tablename) order by schemaname,tablename),'[]') from pg_tables where schemaname in ('public','private') and not(schemaname='private' and tablename='review_praise_catalog');"));
  check(Array.isArray(tables) && tables.length >= 37, "application_table_inventory");
  for (const t of tables) { check(Array.isArray(t) && t.length === 2 && t.every((x: string) => /^[a-z_][a-z0-9_]*$/.test(x))); check(sql(`select count(*) from "${t[0]}"."${t[1]}";`) === "0", "application_tables_empty"); }
  check(sql("select (select count(*) from auth.users)+(select count(*) from storage.objects);") === "0", "auth_storage_empty"); emptyTables = tables.length;
}
function configuration(filename: string) {
  check(filename === resolve(filename) && filename.startsWith("/private/tmp/"));
  for (const [path, mode, directory] of [[dirname(filename), 0o700, true], [filename, 0o600, false]] as const) {
    const s = lstatSync(path); check(!s.isSymbolicLink() && s.uid === process.getuid?.() && (s.mode & 0o777) === mode && realpathSync(path) === path);
    check(directory ? s.isDirectory() : s.isFile() && s.nlink === 1 && s.size <= 24576);
  }
  cfg = row(JSON.parse(readFileSync(filename, "utf8")));
  check(Object.keys(cfg).sort().join(",") === "ANON_KEY,API_URL,EDGE_ROOT,INTERNAL_WORKER_SECRET,SERVICE_ROLE_KEY");
  check(Object.values(cfg).every(x => typeof x === "string" && x.length > 0 && !/[\r\n\0]/.test(x)) && cfg.API_URL === API);
  check(cfg.ANON_KEY !== cfg.SERVICE_ROLE_KEY && cfg.EDGE_ROOT.startsWith("/private/tmp/"));
  const s = lstatSync(cfg.EDGE_ROOT); check(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid?.() && (s.mode & 0o777) === 0o700 && realpathSync(cfg.EDGE_ROOT) === cfg.EDGE_ROOT);
}
function targetGuard() {
  const docker = (...args: string[]) => execFileSync("docker", ["--context", CONTEXT, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 20000 }).trim();
  check(docker("context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}") === `unix://${homedir()}/.colima/yumidang-minkyu/docker.sock`);
  const v = JSON.parse(docker("inspect", DB)); check(v.length === 1 && v[0].Name === `/${DB}` && v[0].State.Running === true && v[0].Config.Labels["com.supabase.cli.project"] === PROJECT);
  check(v[0].HostConfig.PortBindings["5432/tcp"].some((b: Row) => b.HostPort === "56522" && ["", "127.0.0.1", "0.0.0.0"].includes(b.HostIp)));
}
function sourceGuard() {
  const script = String.raw`
import hashlib,json,re,sys,tomllib
from pathlib import Path
root,edge=Path(sys.argv[1]),Path(sys.argv[2])
sys.path[:0]=[str(root/'tools/collaboration'),str(root/'tools/local')]
import check_harness as h,check_ownership as o,prepare_edge as p
from prepare_migrations import inspect_migrations
def check(x):
 if not x: raise ValueError('snapshot_guard_failed')
def read(path,base):
 check(path.resolve()==path and path.is_file() and path.is_relative_to(base))
 for item in [path,*path.parents]:
  if item==base: break
  check(not item.is_symlink())
 return path.read_bytes()
def sha(b): return hashlib.sha256(b).hexdigest()
d=json.loads(read(root/'docs/collaboration/minkyu-photo-access-harness.json',root))
policy,_=o.load_policy(root);f=h.validate_manifest(d,policy);saved=h.validate_preserved(d,f,root,policy)
check(len(saved)==158 and f.get('tests/integration/minkyu/profile_image_access_local.ts')=='C')
check(o.git(root,'rev-parse','HEAD').decode().strip()==d['baseline'])
check(o.git(root,'branch','--show-current').decode().strip()==d['branch'])
m=json.loads(read(edge/'edge-manifest.json',edge))
check(m['status']=='READY' and m['mode']=='gateway_probe' and m['source_head']==d['baseline'])
check(m['source_mode']=='working_tree_snapshot' and m['functions']==['service-api'])
check(m['output_root']==str(edge) and m['database_manifest']=='database-manifest.json')
check(m['migration_count']==40 and m['canonical_count']==28 and m['pending_count']==12)
check(m['source_config_sha256']==sha(read(root/'backend/supabase/config.toml',root)))
payloads=p.source_snapshot(root);entries=m['source_files'];seen=set();targets=set();check(len(entries)==len(payloads))
for e in entries:
 check(set(e)=={'path','target','sha256'})
 source=Path(e['path']);target=Path('supabase/functions')/source.relative_to(p.FUNCTIONS)
 check(source in payloads and source not in seen and e['target']==str(target))
 b=read(edge/target,edge);check(b==payloads[source] and sha(b)==e['sha256']);seen.add(source);targets.add(target)
check({x.relative_to(edge) for x in (edge/'supabase/functions').rglob('*') if x.is_file()}==targets)
b=read(edge/'supabase/config.toml',edge);check(sha(b)==m['config_sha256']);c=tomllib.loads(b.decode())
check(c['project_id']=='yumidang-minkyu-gateway' and c['api']['port']==56521 and c['db']['port']==56522 and c['db']['shadow_port']==56520)
check(c['edge_runtime']['enabled'] is True and set(c['functions'])=={'service-api'} and c['functions']['service-api']['verify_jwt'] is False)
expected=[x.name for x in p.GATEWAY_PENDING]
check(len(expected)==12 and '20261002170743_profile_image_access.sql' in expected)
db=json.loads(read(edge/'database-manifest.json',edge));canonical=inspect_migrations(root)['migrations']
check(db['mode']=='gateway_probe' and db['count']==28 and db['total_count']==40 and db['migrations']==canonical)
check([Path(x['path']).name for x in db['pending']]==expected)
for e in canonical+db['pending']:
 source=Path(e['path']);check(source.parent==Path('backend/supabase/migrations'))
 check(re.fullmatch(r'[0-9]{14}_[a-z0-9_]+\.sql',source.name))
 b=read(edge/'supabase/migrations'/source.name,edge);check(b==read(root/source,root) and sha(b)==e['sha256'] and len(b)==e['bytes'])
check({x.name for x in (edge/'supabase/migrations').iterdir()}=={Path(e['path']).name for e in canonical+db['pending']})
`;
  execFileSync("python3", ["-B", "-c", script, ROOT, cfg.EDGE_ROOT], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 65536 });
}
// 실제 JPEG 파일이다. 외부 이미지나 개인 사진은 사용하지 않는다.
const jpeg = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EF//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EF//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EF//2Q==", "base64");
const imagePath = (path: string) => { const v = path.split("/"); return v.length === 2 && uuid(v[0]) && uuid(v[1].replace(/\.jpg$/, "")) && path.endsWith(".jpg"); };
async function http(path: string, token: string | undefined, method = "GET", body?: unknown): Promise<Response> {
  check(path.startsWith("/") && !path.includes("?") && !path.includes("#"));
  const headers: Row = { apikey: cfg.ANON_KEY, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  if (body !== undefined) headers["content-type"] = body instanceof Buffer ? "image/jpeg" : "application/json";
  if (body instanceof Buffer) headers["x-upsert"] = "false";
  const response = await nativeFetch(API + path, { method, headers, body: body === undefined ? undefined : body instanceof Buffer ? body : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    let errorCode = "UNEXPECTED_RESPONSE";
    try { const v = await response.clone().json(); const code = v.code ?? v.statusCode ?? v.error; if (typeof code === "string" && /^[A-Za-z0-9_ -]{1,64}$/.test(code)) errorCode = code; } catch { /* 원문을 출력하지 않는다. */ }
    diagnostic = { httpStatus: response.status, errorCode };
  }
  return response;
}
async function jsonOK(response: Response) { check(response.ok, "http_success"); diagnostic = undefined; return row(await response.json()); }
async function rpc(name: string, args: Row, token: string) {
  check(["resolve_naver_account", "record_naver_session", "complete_naver_signup", "set_my_profile_avatar"].includes(name));
  const r = await http(`/rest/v1/rpc/${name}`, token, "POST", args); check(r.ok, "rpc_success"); diagnostic = undefined; return r.json();
}
const bridgeFetch: typeof fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  check(u.origin === API && !u.search && !u.hash && !u.username && !u.password && ["/auth/v1/admin/generate_link", "/auth/v1/verify"].includes(u.pathname) && init?.method === "POST");
  return nativeFetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) });
};
async function member(naver = false): Promise<Member> {
  let email = crypto.randomUUID() + "@naver.yumidang.invalid", subject: string | undefined;
  if (naver) { subject = "photo-http-" + crypto.randomUUID(); subjects.push(subject); const a = await rpc("resolve_naver_account", { p_subject: subject, p_name: "합성사진회원", p_gender: "F", p_birth_date: "2000-01-01" }, cfg.SERVICE_ROLE_KEY); check(a.status === "photo_required"); email = a.authEmail; }
  emails.push(email);
  const session = await createNaverSessionBridge({ supabaseUrl: API, supabaseAnonKey: cfg.ANON_KEY, supabaseServiceRoleKey: cfg.SERVICE_ROLE_KEY, allowedOrigins: [], maxRequestBytes: 8192, upstreamTimeoutMs: 10000 }, bridgeFetch).issue(email, null);
  check(uuid(session.userId) && uuid(session.sessionId)); users.push(session.userId);
  if (subject) await rpc("record_naver_session", { p_subject: subject, p_user_id: session.userId, p_session_id: session.sessionId }, cfg.SERVICE_ROLE_KEY);
  const current = await jsonOK(await http("/auth/v1/user", session.accessToken)); check(current.id === session.userId && current.is_anonymous === false && current.role === "authenticated"); nativeAuth = true;
  return { uid: session.userId, token: session.accessToken, email };
}
async function upload(m: Member) {
  const path = `${m.uid}/${crypto.randomUUID()}.jpg`; check(imagePath(path)); images.push(path);
  await jsonOK(await http(`/storage/v1/object/profile-images/${path}`, m.token, "POST", jpeg));
  check(sql(`select count(*) from storage.objects where bucket_id='profile-images' and name='${path}' and owner_id=${quote(m.uid)} and metadata->>'mimetype'='image/jpeg' and (metadata->>'size')::int=${jpeg.length};`) === "1", "real_storage_metadata"); actualStorageUpload = true; return path;
}
async function download(path: string, token?: string, allowed = true) {
  check(imagePath(path)); const response = await http(`/storage/v1/object/authenticated/profile-images/${path}`, token);
  if (allowed) { check(response.ok && response.headers.get("content-type")?.startsWith("image/jpeg"), "download_allowed"); check(Buffer.from(await response.arrayBuffer()).equals(jpeg), "download_exact_jpeg"); }
  else { check([400,401,403,404].includes(response.status), "download_denied"); check(!response.headers.get("content-type")?.startsWith("image/jpeg"), "denial_not_image"); }
  diagnostic = undefined;
}
async function sign(path: string, token?: string, allowed = true) {
  check(imagePath(path)); const response = await http(`/storage/v1/object/sign/profile-images/${path}`, token, "POST", { expiresIn: 60 });
  if (!allowed) { check([400,401,403,404].includes(response.status), "signed_url_denied"); const body = row(await response.json()); check(body.signedURL === undefined && body.signedUrl === undefined && body.url === undefined); diagnostic = undefined; return; }
  const result = await jsonOK(response); check(typeof result.signedURL === "string" && result.signedURL.startsWith(`/object/sign/profile-images/${path}?`), "signed_url_shape");
  const url = new URL(`/storage/v1${result.signedURL}`, API); check(url.origin === API && url.searchParams.size === 1 && url.searchParams.has("token") && !url.hash);
  const signed = await nativeFetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) }); check(signed.ok && signed.headers.get("content-type")?.startsWith("image/jpeg")); check(Buffer.from(await signed.arrayBuffer()).equals(jpeg), "signed_url_exact_jpeg");
}
async function access(path: string, token?: string, allowed = true) { await download(path, token, allowed); await sign(path, token, allowed); }
async function cleanup() {
  if (!guarded) return;
  // 브리지의 중간 실패까지 정확한 합성 별칭으로 회수한다. 전체 사용자 삭제는 하지 않는다.
  if (emails.length) for (const id of sql(`select id from auth.users where email in (${emails.map(quote).join(",")});`).split("\n").filter(Boolean)) { check(uuid(id)); if (!users.includes(id)) users.push(id); }
  const ids = users.length ? users.map(quote).join(",") : "null", ss = subjects.length ? subjects.map(quote).join(",") : "null";
  sql(`begin; delete from private.naver_accounts where user_id in (${ids}) or subject in (${ss}); delete from public.profiles where id in (${ids}); commit;`);
  // 현재 사진 삭제 보호를 위해 프로필 연결을 먼저 제거한다. Storage HTTP로 실제 객체도 삭제한다.
  if (images.length) { check(images.every(imagePath)); const deleted = await http("/storage/v1/object/profile-images", cfg.SERVICE_ROLE_KEY, "DELETE", { prefixes: images }); check(deleted.ok, "storage_object_cleanup"); await deleted.arrayBuffer(); diagnostic = undefined; }
  sql(`delete from auth.users where id in (${ids});`); zero(); cleaned = true;
}
async function run() {
  check(process.argv.length === 3 && process.argv[2] === "--run"); const filename = process.env.YUMIDANG_PROFILE_IMAGE_ACCESS_LOCAL_CONFIG; check(typeof filename === "string");
  configuration(filename); sourceGuard(); targetGuard(); zero(); guarded = true; groups++;
  stage = "native_auth_fixtures"; const before = await member(true), legacy = await member(), qualified = await member(true), orphan = await member(); groups++;
  stage = "real_storage_upload_and_own_pending";
  const pending = await upload(before), old = await upload(qualified), legacyCurrent = await upload(legacy), orphanImage = await upload(orphan);
  for (const [path, person] of [[pending,before],[old,qualified],[legacyCurrent,legacy],[orphanImage,orphan]] as const) await access(path, person.token); groups++;
  stage = "legacy_and_naver_profile_current";
  sql(`insert into public.profiles(id,real_name,birth_date,gender,avatar_url) values (${quote(legacy.uid)},'합성기존회원','2000-01-01','female','${legacyCurrent}');`);
  check((await rpc("complete_naver_signup", { p_avatar_path: old, p_interests: [], p_conversation_styles: [], p_mbti: null }, qualified.token)).status === "ready");
  check(sql(`select count(*) from private.naver_accounts where user_id=${quote(legacy.uid)};`) === "0", "legacy_without_naver");
  await access(legacyCurrent, qualified.token); await access(old, legacy.token);
  for (const path of [old, legacyCurrent, orphanImage]) await access(path, before.token, false);
  for (const path of [pending,orphanImage]) { await access(path, legacy.token, false); await access(path, qualified.token, false); }
  for (const path of [old,legacyCurrent,pending,orphanImage]) { await access(path, undefined, false); await access(path, cfg.ANON_KEY, false); } groups++;
  stage = "replacement_preserves_own_and_denies_old_new_requests";
  const current = await upload(qualified); await access(current, qualified.token); await access(current, legacy.token, false);
  const swap = await rpc("set_my_profile_avatar", { p_avatar_path: current }, qualified.token); check(Array.isArray(swap) && swap.length === 1 && swap[0].avatar_url === current && swap[0].previous_avatar_path === old);
  await access(current, legacy.token); await access(old, legacy.token, false); await access(old, qualified.token); await access(current, before.token, false); groups++;
  stage = "native_guest_denied";
  const guest = await member(); sql(`update auth.users set is_anonymous=true where id=${quote(guest.uid)};`);
  const link = await jsonOK(await http("/auth/v1/admin/generate_link", cfg.SERVICE_ROLE_KEY, "POST", { type: "magiclink", email: guest.email }));
  check(link.id === guest.uid && ["magiclink","signup"].includes(link.verification_type) && typeof link.hashed_token === "string");
  const session = await jsonOK(await http("/auth/v1/verify", cfg.ANON_KEY, "POST", { type: link.verification_type, token_hash: link.hashed_token }));
  check(session.user.id === guest.uid && session.user.is_anonymous === true && typeof session.access_token === "string");
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1], "base64url").toString()); check(claims.sub === guest.uid && claims.is_anonymous === true && claims.role === "authenticated");
  check((await jsonOK(await http("/auth/v1/user", session.access_token))).is_anonymous === true); guestNativeAuth = true;
  for (const path of [current,legacyCurrent,pending,old,orphanImage]) await access(path, session.access_token, false); groups++;
  stage = "fixture_cleanup"; await cleanup(); groups++;
  console.log(JSON.stringify({ status: "PASS", groups, checks, preserved: 158, emptyApplicationTables: emptyTables, syntheticCleanup: cleaned, nativeAuth, guestNativeAuth, actualStorageUpload, actualStorageHttp: true, externalNaver: false, remote: false, previouslyIssuedSignedUrlRevocation: "NOT_ASSERTED" }));
}
try { await run(); }
catch { try { await cleanup(); } catch { cleaned = false; } console.log(JSON.stringify({ status: "FAIL", stage, checks, groups, failure, diagnostic, syntheticCleanup: cleaned, nativeAuth, guestNativeAuth, actualStorageUpload })); process.exitCode = 1; }
