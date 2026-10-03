/** 민규: 전용 41 SQL의 실제 Auth·배포 HTTP·원형 factory·RPC로 대화방 나가기를 검증한다.
 * 합성 기존 회원/사진 metadata만 사용한다. 원격·실제 네이버·실제 사진·외부 AI 호출은 없다.
 * YUMIDANG_CONVERSATION_LEAVE_LOCAL_CONFIG=권한0600config.json node 이파일 --run
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { deepStrictEqual } from "node:assert";
import { createNaverSessionBridge } from "../../../backend/supabase/functions/_shared/auth/session-bridge.ts";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const API = "http://127.0.0.1:56521", ORIGIN = "http://127.0.0.1:5173", CONTEXT = "colima-yumidang-minkyu", PROJECT = "yumidang-minkyu-gateway";
const DB = `supabase_db_${PROJECT}`, nativeFetch = globalThis.fetch;
type Row = Record<string, any>;
type Member = { uid: string; token: string; email: string; subject?:string };
let checks=0, groups=0, stage="configuration", guarded=false, cleaned=false, cfg:Row, emptyTables=0;
let failure:string|undefined, diagnostic:{httpStatus:number;errorCode:string}|undefined;
let nativeAuth=false, guestNativeAuth=false, gatewayCalls=0, factoryCalls=0, rpcCalls=0;
const users:string[]=[], emails:string[]=[], posts:string[]=[], requests:string[]=[],subjects:string[]=[],messages:string[]=[];
const uuid=(x:unknown):x is string=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x);
function check(x:unknown,label="check_failed"):asserts x {checks++;if(!x){failure=label;throw new Error("CONVERSATION_LEAVE_CHECK_FAILED");}}
const row=(x:unknown):Row=>{check(x!==null&&typeof x==="object"&&!Array.isArray(x));return x as Row;};
const quote=(x:string)=>{check(uuid(x)||/^[0-9a-f-]+@naver\.yumidang\.invalid$/.test(x)||/^conversation-http-[0-9a-f-]+$/.test(x));return `'${x}'`;};
const sql=(input:string)=>execFileSync("docker",["--context",CONTEXT,"exec","-i",DB,"psql","-U","postgres","-d","postgres","-X","-qAt","-v","ON_ERROR_STOP=1"],
 {input,encoding:"utf8",stdio:["pipe","pipe","pipe"],timeout:30000,maxBuffer:1048576}).trim();
function zero(){
 const tables=JSON.parse(sql("select coalesce(jsonb_agg(jsonb_build_array(schemaname,tablename) order by schemaname,tablename),'[]') from pg_tables where schemaname in('public','private') and not(schemaname='private' and tablename='review_praise_catalog');"));
 check(Array.isArray(tables)&&tables.length>=38,"application_inventory");
 for(const t of tables){check(Array.isArray(t)&&t.length===2&&t.every((x:string)=>/^[a-z_][a-z0-9_]*$/.test(x)));check(sql(`select count(*) from "${t[0]}"."${t[1]}";`)==="0","application_empty");}
 check(sql("select (select count(*) from auth.users)+(select count(*) from auth.sessions)+(select count(*) from storage.objects);")==="0","auth_storage_empty");emptyTables=tables.length;
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
d=json.loads(read(root/'docs/collaboration/minkyu-conversation-visibility-harness.json',root))
policy,_=o.load_policy(root);f=h.validate_manifest(d,policy);saved=h.validate_preserved(d,f,root,policy)
check(len(saved)==164 and f.get('tests/integration/minkyu/conversation_leave_local.ts')=='C')
check(o.git(root,'rev-parse','HEAD').decode().strip()==d['baseline'])
check(o.git(root,'branch','--show-current').decode().strip()==d['branch'])
m=json.loads(read(edge/'edge-manifest.json',edge))
check(m['status']=='READY' and m['mode']=='gateway_probe' and m['source_head']==d['baseline'])
check(m['source_mode']=='working_tree_snapshot' and m['functions']==['service-api'])
check(m['output_root']==str(edge) and m['database_manifest']=='database-manifest.json')
check(m['migration_count']==41 and m['canonical_count']==28 and m['pending_count']==13)
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
check(len(expected)==13 and '20261002174755_conversation_visibility.sql' in expected)
db=json.loads(read(edge/'database-manifest.json',edge));canonical=inspect_migrations(root)['migrations']
check(db['mode']=='gateway_probe' and db['count']==28 and db['total_count']==41 and db['migrations']==canonical)
check([Path(x['path']).name for x in db['pending']]==expected)
for e in canonical+db['pending']:
 source=Path(e['path']);check(source.parent==Path('backend/supabase/migrations'))
 check(re.fullmatch(r'[0-9]{14}_[a-z0-9_]+\.sql',source.name))
 b=read(edge/'supabase/migrations'/source.name,edge);check(b==read(root/source,root) and sha(b)==e['sha256'] and len(b)==e['bytes'])
check({x.name for x in (edge/'supabase/migrations').iterdir()}=={Path(e['path']).name for e in canonical+db['pending']})
`;
  execFileSync("python3", ["-B", "-c", script, ROOT, cfg.EDGE_ROOT], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 30000, maxBuffer: 65536 });
}
const rpcNames=new Set(["leave_conversation","list_conversations","get_conversation","list_conversation_messages","send_conversation_message","resolve_naver_account","record_naver_session","complete_naver_signup"]);
const guardedFetch:typeof fetch=async(input,init)=>{
 const u=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);
 check(u.origin===API&&!u.search&&!u.hash&&!u.username&&!u.password,"local_fetch_only");
 const method=init?.method??(input instanceof Request?input.method:"GET"),rpc=/^\/rest\/v1\/rpc\/([a-z][a-z0-9_]*)$/.exec(u.pathname);
 check((u.pathname==="/auth/v1/user"&&method==="GET")||(["/auth/v1/admin/generate_link","/auth/v1/verify"].includes(u.pathname)&&method==="POST")||(rpc&&rpcNames.has(rpc[1])&&method==="POST"));
 if(rpc)rpcCalls++;
 const response=await nativeFetch(input,{...init,redirect:"error",signal:AbortSignal.timeout(15000)});
 if(!response.ok){let errorCode="UNEXPECTED_RESPONSE";try{const v=await response.clone().json();if(typeof v.code==="string"&&/^[A-Z0-9_]{1,32}$/.test(v.code))errorCode=v.code;}catch{}diagnostic={httpStatus:response.status,errorCode};}
 return response;
};
const auth=async(path:string,token:string,body?:Row)=>{
 check(["/auth/v1/user","/auth/v1/admin/generate_link","/auth/v1/verify"].includes(path));
 const r=await guardedFetch(API+path,{method:body?"POST":"GET",headers:{apikey:cfg.ANON_KEY,authorization:`Bearer ${token}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
 check(r.ok,"native_auth_http");diagnostic=undefined;return row(await r.json());
};
async function rpc(name:string,args:Row,token:string){check(rpcNames.has(name));const response=await guardedFetch(`${API}/rest/v1/rpc/${name}`,{method:"POST",headers:{apikey:cfg.ANON_KEY,authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(args)});check(response.ok,"fixture_rpc");diagnostic=undefined;return row(await response.json());}
async function member(naver=false):Promise<Member>{
 let email=crypto.randomUUID()+"@naver.yumidang.invalid",subject:string|undefined;
 if(naver){subject="conversation-http-"+crypto.randomUUID();subjects.push(subject);const a=await rpc("resolve_naver_account",{p_subject:subject,p_name:"합성대화회원",p_gender:"F",p_birth_date:"2000-01-01"},cfg.SERVICE_ROLE_KEY);check(a.status==="photo_required");email=a.authEmail;}
 emails.push(email);
 const s=await createNaverSessionBridge({supabaseUrl:API,supabaseAnonKey:cfg.ANON_KEY,supabaseServiceRoleKey:cfg.SERVICE_ROLE_KEY,allowedOrigins:[ORIGIN],maxRequestBytes:8192,upstreamTimeoutMs:10000},guardedFetch).issue(email,null);
 check(uuid(s.userId)&&uuid(s.sessionId));users.push(s.userId);
 if(subject)await rpc("record_naver_session",{p_subject:subject,p_user_id:s.userId,p_session_id:s.sessionId},cfg.SERVICE_ROLE_KEY);
 const u=await auth("/auth/v1/user",s.accessToken);check(u.id===s.userId&&u.role==="authenticated"&&u.is_anonymous===false);nativeAuth=true;
 return {uid:s.userId,token:s.accessToken,email,...(subject?{subject}:{})};
}
async function profile(m:Member){
 const path=`${m.uid}/${crypto.randomUUID()}.jpg`;
 sql(`insert into storage.objects(bucket_id,name,owner_id,metadata) values('profile-images','${path}',${quote(m.uid)},'{"mimetype":"image/jpeg","size":512}');`);
 if(m.subject)check((await rpc("complete_naver_signup",{p_avatar_path:path,p_interests:[],p_conversation_styles:[],p_mbti:null},m.token)).status==="ready");
 else sql(`insert into public.profiles(id,real_name,birth_date,gender,avatar_url) values(${quote(m.uid)},'합성기존회원','2000-01-01','female','${path}');`);
}
const unchanged=()=>sql(`select md5(jsonb_build_array(
 (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.posts p),
 (select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from public.join_requests r),
 (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') from public.appointments a),
 (select coalesce(jsonb_agg(to_jsonb(n) order by n.id),'[]') from public.notifications n),
 (select coalesce(jsonb_agg(to_jsonb(m) order by m.id),'[]') from public.chat_messages m where m.id in(${messages.length?messages.map(quote).join(","):"null"})),
 (select coalesce(jsonb_agg(to_jsonb(r) order by r.appointment_id),'[]') from private.completion_reservations r))::text);`);
async function cleanup(){
 if(!guarded)return;
 if(emails.length)for(const id of sql(`select id from auth.users where email in(${emails.map(quote).join(",")});`).split("\n").filter(Boolean)){check(uuid(id));if(!users.includes(id))users.push(id);}
 const ids=users.length?users.map(quote).join(","):"null",pids=posts.length?posts.map(quote).join(","):"null";
 const ss=subjects.length?subjects.map(quote).join(","):"null";
 sql(`begin;set local storage.allow_delete_query='true';delete from public.posts where id in(${pids});delete from private.naver_accounts where user_id in(${ids}) or subject in(${ss});delete from public.profiles where id in(${ids});delete from storage.objects where bucket_id='profile-images' and owner_id in(${ids});delete from auth.users where id in(${ids});commit;`);
 zero();cleaned=true;
}
async function run(){
 check(process.argv.length===3&&process.argv[2]==="--run");const filename=process.env.YUMIDANG_CONVERSATION_LEAVE_LOCAL_CONFIG;check(typeof filename==="string");
 configuration(filename);sourceGuard();targetGuard();zero();guarded=true;groups++;
 globalThis.fetch=guardedFetch;
 const env:Record<string,string>={SUPABASE_URL:API,SUPABASE_ANON_KEY:cfg.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:cfg.SERVICE_ROLE_KEY,INTERNAL_WORKER_SECRET:cfg.INTERNAL_WORKER_SECRET,ALLOWED_ORIGINS:JSON.stringify([ORIGIN]),MAX_REQUEST_BYTES:"8192",UPSTREAM_TIMEOUT_MS:"10000"};
 const factory=createRuntimeHandler(k=>env[k]);
 const request=(path:string,token?:string,body?:unknown,method?:string)=>new Request(`${API}/functions/v1/service-api/${path}`,{method:method??(body===undefined?"GET":"POST"),headers:{origin:ORIGIN,...(token?{authorization:`Bearer ${token}`}:{}) ,...(body===undefined?{}:{"content-type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const send=async(path:string,token?:string,body?:unknown,method?:string,inProcess=false)=>{
  const req=request(path,token,body,method);let response:Response;
  if(inProcess){factoryCalls++;response=await factory(req);}else{gatewayCalls++;response=await nativeFetch(req,{redirect:"error",signal:AbortSignal.timeout(15000)});}
  const value=row(await response.json());check(response.headers.get("cache-control")==="no-store"&&response.headers.get("access-control-allow-origin")===ORIGIN,"http_headers");
  check(response.headers.get("x-request-id")===value.requestId);
  if(!response.ok){const c=value.error?.code;diagnostic={httpStatus:response.status,errorCode:typeof c==="string"&&/^[A-Z_]{1,40}$/.test(c)?c:"UNEXPECTED_RESPONSE"};}
  return {response,value};
 };
 const ok=async(p:string,t?:string,b?:unknown,method?:string,ip=false)=>{const r=await send(p,t,b,method,ip);check(r.response.status===200&&!r.value.error,"http_success");diagnostic=undefined;return r.value.data;};
 const denied=async(p:string,t:string|undefined,status:number,code:string,b:unknown={})=>{const r=await send(p,t,b);check(r.response.status===status&&r.value.error?.code===code&&r.value.data===undefined,"expected_http_denial");diagnostic=undefined;};
 const list=async(m:Member)=>{const data=await ok("conversations",m.token);check(Array.isArray(data));return data as Row[];};
 const listed=(data:Row[],id:string)=>data.some(v=>v.request_id===id);
 const leave=async(m:Member,id:string,ip=false)=>{const data=await ok(`conversations/${id}/leave`,m.token,{},undefined,ip);deepStrictEqual(data,{requestId:id,hidden:true});check(true);};
 stage="native_qualified_and_legacy_auth";const author=await member(true),peer=await member(true),outsider=await member();for(const m of [author,peer,outsider])await profile(m);
 check(sql(`select count(*) from private.naver_accounts where user_id=${quote(outsider.uid)};`)==="0","legacy_no_naver");groups++;
 stage="synthetic_conversation_fixture";
 for(let i=0;i<3;i++){
  const pid=crypto.randomUUID(),rid=crypto.randomUUID(),mid=crypto.randomUUID();posts.push(pid);requests.push(rid);messages.push(mid);
  const starts=new Date(Date.now()+(7+i)*86400000).toISOString(),ends=new Date(Date.parse(starts)+3600000).toISOString();
  sql(`insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status,cost_type,amount)
   values(${quote(pid)},${quote(i===2?outsider.uid:author.uid)},'합성대화공고','실제 회원 자료가 아닌 대화 목록 검사','산책','${starts}','${ends}','${starts}','서울특별시 성동구 성수동','${i===0?"recruiting":"closed"}','free',0);
   insert into public.post_private_details(post_id,exact_location) values(${quote(pid)},'합성비공개만남지점');
   insert into public.join_requests(id,post_id,requester_id,message,status) values(${quote(rid)},${quote(pid)},${quote(peer.uid)},'합성 대화방 나가기 검증 신청입니다.','${i===0?"pending":"matched"}');
   insert into public.chat_messages(id,join_request_id,sender_id,content) values(${quote(mid)},${quote(rid)},${quote(i===2?outsider.uid:author.uid)},'합성 기존 대화 메시지');
   ${i===0?"":`insert into public.appointments(id,post_id,join_request_id,status) values(${quote(crypto.randomUUID())},${quote(pid)},${quote(rid)},'${i===1?"confirmed":"cancelled"}');`}
   insert into public.notifications(recipient_id,kind,join_request_id) values(${quote(i===2?outsider.uid:author.uid)},'join_request',${quote(rid)}) on conflict(recipient_id,kind,join_request_id) do nothing;`);
 }
 const initial=unchanged(),authorList=await list(author),peerList=await list(peer);check(requests.slice(0,2).every(id=>listed(authorList,id)&&listed(peerList,id)));check(listed(peerList,requests[2])&&listed(await list(outsider),requests[2]));groups++;
 stage="leave_idempotent_self_only";
 await Promise.all([leave(author,requests[0]),leave(author,requests[0])]);check(!listed(await list(author),requests[0])&&listed(await list(peer),requests[0]));
 const timestamp=()=>sql(`select hidden_at::text from private.conversation_visibility where user_id=${quote(author.uid)} and request_id=${quote(requests[0])};`);
 const first=timestamp();check(first.length>0);await leave(author,requests[0],true);check(timestamp()===first);await leave(author,requests[0]);check(timestamp()===first);
 check(sql("select count(*) from private.conversation_visibility;")==="1"&&unchanged()===initial,"leave_changes_visibility_only");groups++;
 stage="leave_preserves_reads_and_open_send";
 const header=await ok(`conversations/${requests[0]}`,author.token);check(Array.isArray(header)&&header[0].request_id===requests[0]&&header[0].can_send===true);
 const beforeMessages=await ok(`conversations/${requests[0]}/messages`,author.token);check(beforeMessages.items.length===1);
 const messageId=crypto.randomUUID();await ok(`conversations/${requests[0]}/messages`,author.token,{messageId,content:"합성 나가기 이후 기존 전송 규칙 확인"});
 const afterMessages=await ok(`conversations/${requests[0]}/messages`,peer.token);check(afterMessages.items.length===2&&afterMessages.items.some((v:Row)=>v.messageId===messageId));
 check(!listed(await list(author),requests[0])&&listed(await list(peer),requests[0]));check(unchanged()===initial,"send_status_and_notifications_unchanged");groups++;
 stage="matched_and_cancelled_leave_preserve_rules";
 await leave(author,requests[1]);await leave(outsider,requests[2]);
 check(!listed(await list(author),requests[1])&&listed(await list(peer),requests[1]));check(!listed(await list(outsider),requests[2])&&listed(await list(peer),requests[2]));
 for(const id of [requests[1],requests[2]]){const h=await ok(`conversations/${id}`,peer.token);check(Array.isArray(h)&&h[0].request_id===id&&h[0].can_send===(id===requests[1]));check((await ok(`conversations/${id}/messages`,peer.token)).items.length===1);}
 await denied(`conversations/${requests[2]}/messages`,peer.token,403,"ACCESS_DENIED",{messageId:crypto.randomUUID(),content:"합성 취소된 대화 전송 거절"});
 check(unchanged()===initial,"matched_cancelled_state_unchanged");groups++;
 stage="foreign_and_unauthenticated_denials";
 const hides=sql("select count(*) from private.conversation_visibility;");
 await denied(`conversations/${requests[0]}/leave`,outsider.token,404,"RESOURCE_NOT_FOUND");await denied(`conversations/${crypto.randomUUID()}/leave`,author.token,404,"RESOURCE_NOT_FOUND");
 for(const token of [undefined,cfg.ANON_KEY,cfg.SERVICE_ROLE_KEY,"synthetic-invalid-token"])await denied(`conversations/${requests[0]}/leave`,token,401,"AUTH_REQUIRED");
 const guest=await member();sql(`update auth.users set is_anonymous=true where id=${quote(guest.uid)};`);
 const link=await auth("/auth/v1/admin/generate_link",cfg.SERVICE_ROLE_KEY,{type:"magiclink",email:guest.email});
 check(link.id===guest.uid&&["magiclink","signup"].includes(link.verification_type));
 const session=await auth("/auth/v1/verify",cfg.ANON_KEY,{type:link.verification_type,token_hash:link.hashed_token});
 check(session.user.id===guest.uid&&session.user.is_anonymous===true&&typeof session.access_token==="string");
 const claims=JSON.parse(Buffer.from(session.access_token.split(".")[1],"base64url").toString());check(claims.sub===guest.uid&&claims.is_anonymous===true);check((await auth("/auth/v1/user",session.access_token)).is_anonymous===true);guestNativeAuth=true;
 await denied(`conversations/${requests[0]}/leave`,session.access_token,401,"AUTH_REQUIRED");check(sql("select count(*) from private.conversation_visibility;")===hides&&unchanged()===initial);groups++;
 stage="cleanup";await cleanup();groups++;
 console.log(JSON.stringify({status:"PASS",groups,checks,preserved:164,syntheticCleanup:cleaned,emptyApplicationTables:emptyTables,nativeAuth,guestNativeAuth,nativeRpc:rpcCalls>0,inProcessHttp:factoryCalls>0,deployedGateway:gatewayCalls>0,gatewayCalls,factoryCalls,rpcCalls,actualPhotoUpload:false,externalNaver:false,remote:false}));
}
try{await run();}catch{try{await cleanup();}catch{cleaned=false;}console.log(JSON.stringify({status:"FAIL",stage,checks,groups,failure,diagnostic,syntheticCleanup:cleaned,nativeAuth,guestNativeAuth}));process.exitCode=1;}finally{globalThis.fetch=nativeFetch;}
