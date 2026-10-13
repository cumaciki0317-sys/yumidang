/** 종현 J01 검증 준비. 기본/--check-j01은 실행0이며, 실제 실행은 검토된 root의 typed boundary만 받는다.
 * --legacy-rest는 이전 55421/55422 REST 시험의 명시적 실행 신호다. 새 J01 증거로 계산하지 않는다.
 * 공급사·모델·운영 활성화는 없다. CLI --run-j01은 지원하지 않으며 VM/대상 승인으로 해석하지 않는다.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import https from "node:https";
import { createRpcTransport } from "../../../backend/supabase/functions/_shared/db/transport.ts";
import { createRpcEventRepository } from "../../../backend/supabase/functions/_shared/db/repositories/events.ts";


const HERE = fileURLToPath(import.meta.url);
const ENTRYPOINTS = ['backend/supabase/functions/service-api/index.ts', 'apps/mobile/src/service.ts'];
const DRIVER = 'tests/integration/jonghyun/events-rest.mjs';
const SQL119 = 'backend/supabase/migrations/20261009031628_event_detail_projection.sql';
const sha = value => createHash('sha256').update(value).digest('hex');
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const stable = value => JSON.stringify(plainObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stable(value[key]))])) : Array.isArray(value) ? value.map(item => JSON.parse(stable(item))) : value);
const requireJ01 = (value, code) => { if (!value) throw Error('J01_' + code); };
const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function validateLegacyEventRestEndpoints(apiValue, databaseValue) {
  let api, database;try{api=new URL(apiValue);database=new URL(databaseValue);}catch{throw Error('J01_LEGACY_DEDICATED_LOCAL_ONLY');}
  requireJ01(api.hostname==='127.0.0.1'&&api.port==='55421'&&api.protocol==='http:'&&!api.username&&!api.password&&!api.search&&!api.hash&&api.pathname==='/'&&database.hostname==='127.0.0.1'&&database.port==='55422'&&['postgresql:','postgres:'].includes(database.protocol)&&!database.search&&!database.hash,'LEGACY_DEDICATED_LOCAL_ONLY');
  return {apiOrigin:api.origin};
}
const isSha = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const safeRelative = value => typeof value === 'string' && !isAbsolute(value) && !value.split('/').some(part => part === '..' || part === '' || part === '.') && /^[A-Za-z0-9_./-]+$/.test(value);
const deepFreeze = value => { if(value && typeof value==='object'){for(const v of Object.values(value))deepFreeze(v);Object.freeze(value);}return value; };
const exact = (value, keys) => plainObject(value) && stable(Object.keys(value).sort()) === stable([...keys].sort());

/** 결정/자격 증명이 없는 입력 계약 검사다. 실제 컨테이너·DB·Auth를 확인하지 않는다. */
export function validateJ01Input(input) {
  requireJ01(exact(input, ['version', 'scenario', 'repositoryRoot', 'codeRoot', 'head', 'sourceFiles', 'migrationFiles', 'target']), 'INPUT_SHAPE');
  requireJ01(input.version === 1 && input.scenario === 'J01_EVENTS_ROUNDTRIP', 'SCENARIO');
  requireJ01([input.repositoryRoot, input.codeRoot].every(path => typeof path === 'string' && isAbsolute(path)), 'ROOT');
  requireJ01(typeof input.head === 'string' && /^[0-9a-f]{40}$/.test(input.head), 'HEAD');
  for (const [kind, files] of [['source', input.sourceFiles], ['migration', input.migrationFiles]]) {
    requireJ01(plainObject(files) && Object.keys(files).length > 0, 'MANIFEST');
    for (const [path, digest] of Object.entries(files)) requireJ01(safeRelative(path) && isSha(digest) && (kind === 'source' ? path === DRIVER || path.startsWith('backend/supabase/functions/') || path.startsWith('apps/mobile/src/') : /^backend\/supabase\/migrations\/[0-9]+_[A-Za-z0-9_-]+\.sql$/.test(path)), 'MANIFEST_ENTRY');
  }
  requireJ01(ENTRYPOINTS.every(path => Object.hasOwn(input.sourceFiles, path)) && Object.hasOwn(input.sourceFiles, DRIVER) && Object.hasOwn(input.migrationFiles, SQL119), 'REQUIRED_PINS');
  if (input.target !== null) {
    const t = input.target;
    requireJ01(exact(t, ['dockerSocket', 'project', 'runId', 'containers', 'origin', 'authIssuer', 'authAudience']), 'TARGET_SHAPE');
    requireJ01(typeof t.dockerSocket === 'string' && isAbsolute(t.dockerSocket) && t.dockerSocket.endsWith('/docker.sock') && typeof t.project === 'string' && /^jonghyun-backend100-[0-9a-f]{8}$/.test(t.project) && isUuid(t.runId), 'TARGET_IDENTITY');
    requireJ01(exact(t.containers, ['db', 'auth', 'rest']), 'TARGET_CONTAINERS');
    requireJ01(new Set(Object.values(t.containers).map(c=>c?.id)).size===3,'TARGET_ROLE_ID_DUPLICATE');
    for (const c of Object.values(t.containers)) requireJ01(exact(c, ['id', 'image']) && isSha(c.id) && typeof c.image === 'string' && /^[a-z0-9./:_-]+@sha256:[0-9a-f]{64}$/.test(c.image), 'TARGET_CONTAINER_ID_IMAGE');
    let origin; try { origin = new URL(t.origin); } catch { requireJ01(false, 'TARGET_ORIGIN'); }
    requireJ01(origin.hostname === '127.0.0.1' && origin.protocol === 'http:' && !!origin.port && origin.origin === t.origin && !origin.username && !origin.password && t.authIssuer === t.origin + '/auth/v1' && t.authAudience === 'authenticated', 'TARGET_ORIGIN');
  }
  return { status: 'INPUT_VALID_ONLY', actualTargetVerified: false, execution: 'NOT_RUN', ready: false, missing: input.target === null ? ['EXACT_APPROVED_TARGET', 'ROOT_TYPED_EXECUTION_BOUNDARY'] : ['LIVE_TARGET_MIGRATION_VERIFICATION', 'ROOT_TYPED_EXECUTION_BOUNDARY'] };
}

function pinnedFile(root, path) {
  const base = realpathSync(root), full = resolve(root, path);
  requireJ01(base === root && safeRelative(path) && relative(root, full) === path && realpathSync(full) === full && lstatSync(full).isFile(), 'PIN_PATH');
  return readFileSync(full);
}
const parsedSpecifiers = new Map();
function moduleSpecifiers(source,path) {
  const key=path+':'+sha(source);if(parsedSpecifiers.has(key))return parsedSpecifiers.get(key);
  const script="import{stripTypeScriptTypes}from'node:module';import{SourceTextModule}from'node:vm';let raw='';for await(const part of process.stdin)raw+=part;const code=process.argv[1]==='ts'?stripTypeScriptTypes(raw,{mode:'strip'}):raw;const mod=new SourceTextModule(code);process.stdout.write(JSON.stringify(mod.dependencySpecifiers));";
  let value;try{value=JSON.parse(execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',script,path.endsWith('.ts')?'ts':'js'],{input:source,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:5000,maxBuffer:4*1024*1024}));}catch{requireJ01(false,'IMPORT_PARSE_FAILED');}
  // native parser는 type-only를 지운다. 해당 선언만 별도로 포함하며 SQL/문자열의 from을 import로 읽지 않는다.
  for(const match of source.matchAll(/\b(?:import|export)\s+type\s+(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s*from\s*["']([^"']+)["']/g))value.push(match[1]);
  for(const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g))value.push(match[1]);
  const specifiers=Object.freeze([...new Set(value)]);parsedSpecifiers.set(key,specifiers);return specifiers;
}
/** type-only import도 포함한다. 추출된 전체 경로 집합과 SHA가 일치해야 하며 remote import는 거절한다. */
export function collectJ01SourceFiles(root) {
  const pending = [...ENTRYPOINTS, DRIVER], files = {};
  while (pending.length) {
    const path = pending.pop(); if (Object.hasOwn(files, path)) continue;
    const bytes = pinnedFile(root, path); files[path] = sha(bytes);
    for (const specifier of moduleSpecifiers(bytes.toString('utf8'),path)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) { requireJ01(false, 'REMOTE_IMPORT'); }
      let dependency = relative(root, resolve(root, dirname(path), specifier));
      if (!/\.(?:ts|tsx|mjs|js)$/.test(dependency)) dependency += '.ts';
      requireJ01(safeRelative(dependency) && (dependency.startsWith('backend/supabase/functions/') || dependency.startsWith('apps/mobile/src/')), 'IMPORT_ESCAPE');
      pending.push(dependency);
    }
  }
  return files;
}
export function checkJ01Source(input) {
  const report = validateJ01Input(input);
  requireJ01(realpathSync(input.repositoryRoot) === input.repositoryRoot && realpathSync(input.codeRoot) === input.codeRoot, 'CANONICAL_ROOT');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: input.repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim();
  requireJ01(head === input.head, 'HEAD_CHANGED');
  requireJ01(stable(collectJ01SourceFiles(input.codeRoot)) === stable(input.sourceFiles), 'SOURCE_CLOSURE_CHANGED');
  for (const [path, digest] of Object.entries(input.sourceFiles)) {
    requireJ01(sha(pinnedFile(input.repositoryRoot, path)) === digest, 'REPOSITORY_SOURCE_CHANGED');
    const committed = execFileSync('git',['show',input.head+':'+path],{cwd:input.repositoryRoot,stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:4*1024*1024});
    requireJ01(sha(committed)===digest,'HEAD_SOURCE_BYTES_CHANGED');
  }
  const names = readdirSync(resolve(input.repositoryRoot, 'backend/supabase/migrations')).filter(name => name.endsWith('.sql')).map(name => 'backend/supabase/migrations/' + name).sort();
  requireJ01(stable(names) === stable(Object.keys(input.migrationFiles).sort()), 'MIGRATION_SET_CHANGED');
  for (const [path, digest] of Object.entries(input.migrationFiles)) {
    requireJ01(sha(pinnedFile(input.repositoryRoot, path)) === digest, 'MIGRATION_CHANGED');
    const committed=execFileSync('git',['show',input.head+':'+path],{cwd:input.repositoryRoot,stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:4*1024*1024});
    requireJ01(sha(committed)===digest,'HEAD_MIGRATION_BYTES_CHANGED');
  }
  return { ...report, sourceVerified: true, sourceFileCount: Object.keys(input.sourceFiles).length, migrationFileCount: names.length, targetInspection: 'NOT_RUN', credentialReads: 0, networkCalls: 0 };
}

/** JWT payload 자체는 서명 증거가 아니다. 실제 executor의 GoTrue GET이 같은 subject를 확인한다. */
export function validateJ01Auth(accounts,target,now=Date.now()) {
  requireJ01(Array.isArray(accounts)&&accounts.length===2&&new Set(accounts.map(a=>a.userId)).size===2&&new Set(accounts.map(a=>a.identityId)).size===2,'AUTH_SCOPE');
  for(const a of accounts){
    requireJ01(isUuid(a.userId)&&isUuid(a.identityId)&&typeof a.token==='string'&&a.token.length<=16384&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(a.token),'AUTH_TOKEN');
    let claims;try{claims=JSON.parse(Buffer.from(a.token.split('.')[1],'base64url').toString('utf8'));}catch{requireJ01(false,'AUTH_TOKEN_PAYLOAD');}
    requireJ01(plainObject(claims)&&claims.sub===a.userId&&claims.iss===target.authIssuer&&(claims.aud===target.authAudience||Array.isArray(claims.aud)&&claims.aud.includes(target.authAudience))&&claims.role==='authenticated'&&Number.isSafeInteger(claims.exp)&&claims.exp*1000>now&&(claims.nbf===undefined||Number.isSafeInteger(claims.nbf)&&claims.nbf*1000<=now),'AUTH_TOKEN_SCOPE_EXPIRY');
  }
  return {scope:'JWT_METADATA_ONLY',signatureVerified:false};
}

/** SQL119 경계의17행만 만든다. 입력은 root가 새로 만든 두 합성 Auth identity여야 한다. */
export function j01FixtureSql(runId, accounts) {
  requireJ01(isUuid(runId) && Array.isArray(accounts) && accounts.length === 2 && accounts.every(a => isUuid(a.userId) && isUuid(a.identityId)) && accounts[0].userId !== accounts[1].userId && accounts[0].identityId !== accounts[1].identityId, 'FIXTURE_IDENTITY');
  const q = value => "'" + value.replaceAll("'", "''") + "'";
  const tag = 'J01-' + runId, source = 'PFJ01' + runId.replaceAll('-', '');
  const sql = `begin;
select pg_advisory_xact_lock(hashtextextended(${q(tag)},0));
do $$declare base jsonb;s private.source_events;stamp timestamptz:=clock_timestamp();day date:=(clock_timestamp()at time zone'Asia/Seoul')::date;i integer;ids jsonb:='{}';begin
 if exists(select 1 from private.source_events where provider='kopis'and source_id like ${q(source + '%')})then raise exception 'j01_scope_existing';end if;
 if (select count(*)from auth.users where id=any(array['${accounts[0].userId}','${accounts[1].userId}']::uuid[]))<>2 then raise exception 'j01_auth_missing';end if;
 if (select count(*)from private.member_episodes where ended_at is null and ((profile_id='${accounts[0].userId}'and identity_id='${accounts[0].identityId}')or(profile_id='${accounts[1].userId}'and identity_id='${accounts[1].identityId}')))<>2 then raise exception 'j01_identity_missing';end if;
 for i in 1..17 loop
  base:=jsonb_build_object('provider','kopis','sourceId',${q(source)}||'X'||i,'sourceStatus',case when i=17 then 'cancelled'else'active'end,
   'title',${q(tag)}||' 합성 행사 '||i,'category',case when i<=12 or i=17 then '뮤지컬'when i in(13,14)then '대중음악'else'연극'end,
   'region','서울특별시','placeName','합성 공연장','publicAddress','서울 합성 주소','sourceUrl',null,
   'collectedAt',to_char(stamp at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'precision','date',
   'startsOn',case when i=15 then (day-40)::text when i=16 then (day-3)::text else (day+1)::text end,
   'endsOn',case when i=16 then(day-1)::text else(day+8)::text end,
   'admission',jsonb_build_object('kind',case when i=14 then'unknown'else'free'end));
  perform private.upsert_canonical_events(jsonb_build_array(base));select *into strict s from private.source_events where provider='kopis'and source_id=base->>'sourceId';
  if i=13 then
   if not private.merge_event_detail(s,jsonb_build_object('provider','kopis','sourceId',s.source_id,'collectedAt',to_char((stamp+interval'1 minute')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'admission',jsonb_build_object('kind','described','text',repeat('가격안내',2500)),'operatingInfo','합성 최신 운영 안내','description','합성 최신 상세 설명','posterUrl','https://www.kopis.or.kr/upload/fixture119.jpg'))then raise exception 'j01_detail_failed';end if;
  end if;
  ids:=ids||jsonb_build_object(i::text,s.id);
 end loop;
 if(select count(*)from private.source_events where provider='kopis'and source_id like ${q(source + '%')})<>17 then raise exception 'j01_fixture_count';end if;
 insert into pg_temp.j01_result select jsonb_build_object('tag',${q(tag)},'sourcePrefix',${q(source)},'ids',ids,'today',day::text,'periodEnd',(day+8)::text);
end;$$;
select value from pg_temp.j01_result;
commit;`;
  return { sql: 'create temp table j01_result(value jsonb);\n' + sql, tag, sourcePrefix: source, count: 17 };
}

/** 전체 범위라는 callback 주장만으로 완료로 계산하지 않는다. table 집합은 별도 SQL catalog와 대조한다. */
export function validateJ01Snapshot(snapshot,observedTables) {
  requireJ01(exact(snapshot,['scope','schemas','tables','catalogSha256','rolesSha256','existingUnknownSha256'])&&snapshot.scope==='FULL_TARGET_LOGICAL_BASELINE'&&stable(snapshot.schemas)===stable(['auth','private','public','storage']),'SNAPSHOT_COVERAGE');
  requireJ01(Array.isArray(observedTables)&&observedTables.length>0&&new Set(observedTables).size===observedTables.length&&observedTables.every(name=>/^(auth|private|public|storage)\.[a-z0-9_]+$/.test(name))&&plainObject(snapshot.tables)&&stable(Object.keys(snapshot.tables).sort())===stable([...observedTables].sort()),'SNAPSHOT_TABLE_INVENTORY');
  for(const row of Object.values(snapshot.tables))requireJ01(exact(row,['rowCount','sha256'])&&Number.isSafeInteger(row.rowCount)&&row.rowCount>=0&&isSha(row.sha256),'SNAPSHOT_TABLE_PROOF');
  requireJ01([snapshot.catalogSha256,snapshot.rolesSha256,snapshot.existingUnknownSha256].every(isSha),'SNAPSHOT_CATALOG_ROLES_UNKNOWN');
  return {scope:'BOUNDARY_INVENTORY_CHECK_ONLY',wholeBaselineRestored:false,sha256:sha(stable(snapshot))};
}

/** root는 VM 승인·대상 관측·자격증명·Auth 생성·전체 fingerprint·정리의 custody를 갖는다.
 * JSON config는 아래 callback을 만들지 못한다. 실제 실행 CLI와 자동 VM 시작은 제공하지 않는다.
 * @param {object} input
 * @param {{verifyTarget:Function,readCredentials:Function,createSyntheticAuth:Function,sql:Function,snapshot:Function,cleanupScope:Function,readTls:Function}} boundary
 */
export async function runJ01EventRoundtrip(input, boundary) {
  input=deepFreeze(structuredClone(input));
  validateJ01Input(input);
  requireJ01(input.target !== null, 'EXACT_TARGET_REQUIRED');
  for (const name of ['verifyTarget','readCredentials','createSyntheticAuth','sql','snapshot','cleanupScope','readTls']) requireJ01(typeof boundary?.[name] === 'function', 'ROOT_TYPED_BOUNDARY_REQUIRED');
  checkJ01Source(input);
  const verifyIdentity = async () => {
    const observed = await boundary.verifyTarget(input.target);
    requireJ01(exact(observed, ['target','migrationFiles']) && stable(observed.target) === stable(input.target) && stable(observed.migrationFiles) === stable(input.migrationFiles), 'LIVE_TARGET_MIGRATION_MISMATCH');
  };
  const verify = async () => {await verifyIdentity();checkJ01Source(input);};
  await verify();
  const snapshot=async()=>{
    const data=deepFreeze(structuredClone(await boundary.snapshot(input.target)));
    const inventory=await boundary.sql(input.target,"begin read only;select coalesce(jsonb_agg(n.nspname||'.'||c.relname order by n.nspname,c.relname),'[]'::jsonb)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('auth','private','public','storage')and c.relkind in('r','p','m');rollback;");
    validateJ01Snapshot(data,Array.isArray(inventory)?inventory:JSON.parse(inventory));return stable(data);
  };
  const before = await snapshot();
  let scopeOpened = false, server, restoreFetch, proof, failure, auth;
  try {
    // Auth의 부분 성공 전부터 같은 runId로 정리를 보장한다.
    scopeOpened = true;
    await verify();
    const credentials = await boundary.readCredentials(input.target);
    requireJ01(exact(credentials, ['anon','service']) && Object.values(credentials).every(v => typeof v === 'string' && v.length >= 20 && !/[\s\u0000-\u001f]/.test(v)) && credentials.anon !== credentials.service, 'CREDENTIALS');
    await verify();
    auth = deepFreeze(structuredClone(await boundary.createSyntheticAuth(input.target, 2)));
    await verify();
    requireJ01(Array.isArray(auth) && auth.length === 2 && auth.every(a => isUuid(a.userId) && isUuid(a.identityId) && typeof a.token === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(a.token)), 'SYNTHETIC_AUTH_REQUIRED');
    await verify();
    validateJ01Auth(auth,input.target);
    const seed = j01FixtureSql(input.target.runId, auth), seeded = await boundary.sql(input.target, seed.sql);
    await verify();
    const data = plainObject(seeded) ? seeded : JSON.parse(seeded);
    requireJ01(data.tag === seed.tag && data.sourcePrefix === seed.sourcePrefix && exact(data.ids, Array.from({length:17},(_,i)=>String(i+1))) && Object.values(data.ids).every(isUuid) && new Set(Object.values(data.ids)).size === 17 && /^\d{4}-\d{2}-\d{2}$/.test(data.today) && /^\d{4}-\d{2}-\d{2}$/.test(data.periodEnd), 'SEED_RESULT');
    const fixtureBaseline = await snapshot();
    const tls = await boundary.readTls(input.target);
    requireJ01(exact(tls, ['key','cert']) && [tls.key,tls.cert].every(v => typeof v === 'string' && v.length > 0), 'TLS_CUSTODY_REQUIRED');
    const cert = new X509Certificate(tls.cert);requireJ01(cert.checkIP('127.0.0.1') === '127.0.0.1' && Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now(), 'TLS_CERTIFICATE');
    const nativeFetch = globalThis.fetch, counts = {auth:0,rpc:0,bridge:0}, tokens = new Set(auth.map(a=>a.token));
    const backendFetch = async (request, init={}) => {
      const u = new URL(typeof request === 'string' ? request : request instanceof URL ? request.href : request.url);
      const headers = new Headers(init.headers), token = headers.get('authorization')?.replace(/^Bearer /,'');
      requireJ01([...headers.keys()].every(key=>['apikey','authorization','accept','content-type'].includes(key)),'BACKEND_HEADER_ALLOWLIST');
      requireJ01(u.origin === input.target.origin && !u.search && !u.hash && !u.username && !u.password, 'LOCAL_BACKEND_ONLY');
      if (u.pathname === '/auth/v1/user') { requireJ01(init.method === 'GET' && headers.get('apikey') === credentials.anon && (tokens.has(token)||token==='invalid.header.signature'), 'AUTH_BOUNDARY'); counts.auth++; }
      else { requireJ01(init.method === 'POST' && ['/rest/v1/rpc/list_public_events','/rest/v1/rpc/get_public_event'].includes(u.pathname) && headers.get('apikey') === credentials.anon && (tokens.has(token) || token === credentials.anon), 'RPC_BOUNDARY'); counts.rpc++; }
      const response=await nativeFetch(u.href, {...init,redirect:'error',credentials:'omit'});
      if(u.pathname==='/auth/v1/user'&&tokens.has(token)&&response.ok){const value=await response.clone().json();requireJ01(value.id===auth.find(a=>a.token===token).userId&&value.role==='authenticated'&&value.is_anonymous!==true,'AUTH_SUBJECT_BINDING');}
      return response;
    };
    globalThis.fetch = backendFetch;restoreFetch = () => { globalThis.fetch = nativeFetch; };
    const {createRuntimeHandler} = await import(pathToFileURL(resolve(input.codeRoot,ENTRYPOINTS[0])).href);
    const {YumidangService} = await import(pathToFileURL(resolve(input.codeRoot,ENTRYPOINTS[1])).href);
    const env = {SUPABASE_URL:input.target.origin,SUPABASE_ANON_KEY:credentials.anon,SUPABASE_SERVICE_ROLE_KEY:credentials.service,ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000'};
    const handler = createRuntimeHandler(key => env[key]);
    server = https.createServer({key:tls.key,cert:tls.cert}, async (req,res) => {
      try {
        requireJ01(req.method === 'GET' && !req.headers['content-length'] && !req.headers['transfer-encoding'] && req.url.length < 8192 && (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::ffff:127.0.0.1'), 'BRIDGE_REQUEST');
        const bridgeOrigin='https://127.0.0.1:'+server.address().port,url = new URL(req.url,bridgeOrigin);
        requireJ01(url.origin===bridgeOrigin&&!url.username&&!url.password&&!url.hash,'BRIDGE_PIN');
        requireJ01(url.pathname === '/functions/v1/service-api/events' || /^\/functions\/v1\/service-api\/events\/[0-9a-f-]{36}$/.test(url.pathname), 'BRIDGE_ROUTE');
        counts.bridge++;const response = await handler(new Request(url,{headers:req.headers}));
        res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({data:null,error:{code:'EXTERNAL_UNAVAILABLE'}})); }
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const bridge = 'https://127.0.0.1:' + server.address().port;
    const fetcher = (url,init={}) => new Promise((resolve,reject)=>{
      const u = new URL(url); requireJ01(u.origin === bridge, 'BRIDGE_ORIGIN');
      const request = https.request(u,{method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers)),ca:tls.cert,rejectUnauthorized:true,signal:init.signal},res=>{
        const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024)request.destroy(Error('J01_RESPONSE_LIMIT'));else chunks.push(chunk);});
        res.on('error',()=>reject(Error('J01_BRIDGE_RESPONSE')));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
      });request.setTimeout(10000,()=>request.destroy(Error('J01_BRIDGE_TIMEOUT')));request.once('error',()=>reject(Error('J01_BRIDGE_TRANSPORT')));request.end();
    });
    const service = token => new YumidangService({serviceApiUrl:bridge+'/functions/v1/service-api',accessToken:async()=>token,fetcher});
    const anon = service(null), viewer = service(auth[0].token), other = service(auth[1].token);
    const query = {mode:'overlapping',query:data.tag,period:{start:data.today,end:data.periodEnd}};
    for (const client of [anon,viewer,other]) {
      const f={...query,freeOnly:true,performanceGenre:'musical'},first=await client.listEvents(f),second=await client.listEvents(f,first.nextCursor);
      requireJ01(first.events.length===10 && first.nextCursor && second.events.length===2 && second.nextCursor===null && new Set([...first.events,...second.events].map(x=>x.id)).size===12 && [...first.events,...second.events].every(x=>x.admission.kind==='free' && x.performanceGenre==='musical'), 'FREE_MUSICAL_PAGINATION');
      for (const changed of [{...f,freeOnly:false},{...f,performanceGenre:'concert'},{mode:'new_this_week',includeOngoing:true,query:data.tag}]) {
        const rpcBefore=counts.rpc;let rejected=false;try{await client.listEvents(changed,first.nextCursor);}catch(error){rejected=error.status===400 && error.code==='INVALID_REQUEST';}requireJ01(rejected && counts.rpc===rpcBefore, 'CHANGED_CURSOR_REJECTION');
      }
      const concerts=await client.listEvents({...query,performanceGenre:'concert'});
      requireJ01(concerts.events.length===2 && concerts.events.some(x=>x.id===data.ids['14'] && x.admission.kind==='unknown'), 'CONCERT_UNKNOWN');
      const paid=concerts.events.find(x=>x.id===data.ids['13']),detail=await client.getEvent(data.ids['13']);
      requireJ01(paid?.admission.kind==='described' && paid.admission.text==='가격안내'.repeat(2500) && detail.admission.text===paid.admission.text && detail.operatingInfo===paid.operatingInfo && detail.description===paid.description && detail.operatingInfo==='합성 최신 운영 안내', 'FULL_PRICE_DETAIL');
      const omitted=await client.listEvents({mode:'new_this_week',query:data.tag,performanceGenre:'play'}),included=await client.listEvents({mode:'new_this_week',query:data.tag,performanceGenre:'play',includeOngoing:true,freeOnly:true});
      requireJ01(omitted.events.length===0 && included.events.length===1 && included.events[0].id===data.ids['15'] && included.events[0].state==='ongoing', 'ONGOING_INCLUSION');
    }
    const direct = async (suffix, token=null) => fetcher(bridge+'/functions/v1/service-api'+suffix,{headers:token?{authorization:'Bearer '+token}:{}});
    for (const bad of ['includeOngoing=','includeOngoing=1','includeOngoing=true&includeOngoing=false','freeOnly=FALSE','freeOnly=','freeOnly=true&freeOnly=true','performanceGenre=opera','performanceGenre=','performanceGenre=play&performanceGenre=musical','mode=overlapping&includeOngoing=true','includeOngoing=true&ongoingOnly=true']) {
      const n=counts.rpc;requireJ01((await direct('/events?limit=10&'+bad)).status===400 && counts.rpc===n,'INVALID_FILTER_HTTP');
    }
    const n=counts.rpc, rejectedAuth=await direct('/events?limit=10','invalid.header.signature');requireJ01(rejectedAuth.status===401 && counts.rpc===n,'INVALID_JWT_NO_ANON_RETRY');
    requireJ01(await snapshot()===fixtureBaseline,'READ_CASE_MUTATED_DB');
    await verify();
    await boundary.sql(input.target, `begin;insert into private.member_hidden_targets(identity_id,target_type,target_id)values('${auth[0].identityId}','event','${data.ids['15']}');commit;`);
    await verify();
    const hiddenBaseline=await snapshot(),ongoingQuery={mode:'new_this_week',query:data.tag,performanceGenre:'play',includeOngoing:true};
    requireJ01((await viewer.listEvents(ongoingQuery)).events.length===0 && (await other.listEvents(ongoingQuery)).events.length===1 && (await anon.listEvents(ongoingQuery)).events.length===1,'PER_MEMBER_HIDING');
    let hidden=false;try{await viewer.getEvent(data.ids['15']);}catch(error){hidden=error.status===404;}requireJ01(hidden && (await other.getEvent(data.ids['15'])).id===data.ids['15'],'HIDDEN_DETAIL_PERMISSION');
    requireJ01(await snapshot()===hiddenBaseline,'HIDDEN_READ_MUTATED_DB');
    proof={status:'BOUNDARY_CHECKS_PASSED_NOT_LIVE_EVIDENCE',scope:'ROOT_TYPED_BOUNDARY_CHECKS_ONLY',actualAuth:'NOT_VERIFIED_BY_HARNESS',actualDb:'NOT_VERIFIED_BY_HARNESS',executionEvidence:'ROOT_ATTESTATION_REQUIRED',fixtureRows:17,sourceHead:input.head,sourceManifestSha256:sha(stable(input.sourceFiles)),migrationManifestSha256:sha(stable(input.migrationFiles)),counts,actualProviders:false,actualNaverMember:false,productionGateway:false,screenRendering:false};
  } catch (error) { failure = error; }
  finally {
    if(server) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
    restoreFetch?.();
    // 성공 표시 전에는 같은 runId 정리와 기존 전체 fingerprint 복원을 확인한다.
    if(scopeOpened) { try { await verifyIdentity();await boundary.cleanupScope(input.target); } catch { failure=Error('J01_CLEANUP_FAILED'); } }
    try { await verify();requireJ01(await snapshot()===before,'WHOLE_BASELINE_NOT_RESTORED'); } catch { failure=Error('J01_FINALIZATION_FAILED'); }
  }
  if(failure) throw Error(/^J01_[A-Z_]+$/.test(failure.message??'')?failure.message:'J01_ROUNDTRIP_FAILED');
  return {...proof,cleanupPassed:true,targetAndSourceReverified:true,wholeBaselineRestored:false,baselineInventoryChecksPassed:true};
}

if (process.argv[1] && resolve(process.argv[1]) === HERE && !process.argv.includes('--legacy-rest')) {
  try {
    if(process.argv.length===2) console.log(JSON.stringify({status:'NOT_RUN',reason:'EXPLICIT_CHECK_MANIFEST_OR_ROOT_TYPED_CALLER_REQUIRED',ready:false,credentialReads:0,networkCalls:0}));
    else {
      requireJ01(process.argv.length===4 && process.argv[2]==='--check-j01','EXPLICIT_CHECK_ONLY');
      const path=process.argv[3],stat=lstatSync(path),parent=lstatSync(dirname(path));
      requireJ01(isAbsolute(path)&&realpathSync(path)===path&&stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=1024*1024&&(stat.mode&0o777)===0o600&&stat.uid===process.getuid()&&parent.isDirectory()&&!parent.isSymbolicLink()&&(parent.mode&0o777)===0o700&&parent.uid===process.getuid(),'PRIVATE_MANIFEST');
      console.log(JSON.stringify(checkJ01Source(JSON.parse(readFileSync(path,'utf8')))));
    }
  } catch { console.log(JSON.stringify({status:'BLOCKED',reason:'J01_CHECK_INPUT_SOURCE_NOT_VERIFIED',ready:false,execution:'NOT_RUN',credentialReads:0,networkCalls:0}));process.exitCode=2; }
}

if (process.argv.includes('--legacy-rest')) {
const { Client } = createRequire(new URL("../../../backend/package.json", import.meta.url))("pg");
const env = process.env;
for (const key of ["EVENTS_REST_DATABASE_URL", "EVENTS_REST_SUPABASE_URL", "EVENTS_REST_ANON_KEY", "EVENTS_REST_SERVICE_ROLE_KEY"]) {
  if (!env[key]) throw new Error("EXPLICIT_LOCAL_SETTING_REQUIRED");
}
const api = new URL(validateLegacyEventRestEndpoints(env.EVENTS_REST_SUPABASE_URL, env.EVENTS_REST_DATABASE_URL).apiOrigin);
const config = { supabaseUrl: api.origin, supabaseAnonKey: env.EVENTS_REST_ANON_KEY, upstreamTimeoutMs: 5000 };

test("legacy 실제 REST: service 저장 두 번 중복 없음·취소 숨김·비용 미상 보존, anon 조회 페이지 커서", { timeout: 30_000 }, async () => {
  const admin = new Client({ connectionString: env.EVENTS_REST_DATABASE_URL, ssl: false });
  await admin.connect();
  const provider = "synthetic-" + randomUUID().slice(0, 8);
  try {
    const service = createRpcEventRepository(createRpcTransport(config, env.EVENTS_REST_SERVICE_ROLE_KEY, env.EVENTS_REST_SERVICE_ROLE_KEY, new Set(["upsert_events"])));
    const anon = createRpcEventRepository(createRpcTransport(config, env.EVENTS_REST_ANON_KEY, env.EVENTS_REST_ANON_KEY, new Set(["list_public_events"])));
    const collectedAt = new Date().toISOString();
    const event = (i, extra = {}) => ({ provider, sourceId: "s" + i, sourceStatus: "active", title: "가상 행사 " + i, category: "연극",
      region: "서울특별시", placeName: "가상 극장", publicAddress: null, admission: { kind: "unknown" }, sourceUrl: null, collectedAt,
      precision: "date", startsOn: "2099-01-0" + i, endsOn: "2099-01-0" + (i + 1), ...extra });
    const page = [event(1), event(2), event(3, { sourceStatus: "cancelled" })];
    const first = await service.upsertBySourceIdentity(page);
    const second = await service.upsertBySourceIdentity(page);
    assert.equal(first.savedCount, 3);
    assert.equal(second.savedCount + (second.staleCount ?? 0), 3);
    assert.equal(Number((await admin.query("select count(*) n from private.events where provider=$1", [provider])).rows[0].n), 3, "재저장 중복 없음");
    const query = { mode: "overlapping", query: "가상 행사" };
    const p1 = await anon.listPage(query, undefined, 1);
    assert.equal(p1.events.length, 1);
    assert.ok(p1.nextCursor);
    const p2 = await anon.listPage(query, p1.nextCursor, 1);
    assert.equal(p2.events.length, 1);
    assert.notEqual(p1.events[0].sourceId, p2.events[0].sourceId);
    const all = [...p1.events, ...p2.events];
    assert.ok(all.every((e) => e.sourceStatus === "active" && e.admission.kind === "unknown"), "취소 숨김·비용 미상 보존");
    await assert.rejects(createRpcTransport(config, env.EVENTS_REST_ANON_KEY, env.EVENTS_REST_ANON_KEY, new Set(["upsert_events"]))
      .rpc("upsert_events", { p_events: [] }), "anon은 저장 불가");
  } finally {
    await admin.query("delete from private.events where provider=$1", [provider]).catch(() => {});
    const left = await admin.query("select count(*) n from private.events where provider=$1", [provider]);
    await admin.end();
    assert.equal(Number(left.rows[0].n), 0, "synthetic cleanup");
  }
});

}
