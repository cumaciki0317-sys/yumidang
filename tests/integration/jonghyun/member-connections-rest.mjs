/** J07/J08/J09 root 전용 연결 검사. 기본 실행은 NOT_RUN이며 승인·SQL·Auth 생성 기능이 없다.
 * GoTrue 원 JWT·DB·정리 custody는 부모의 고정 method가 담당한다. AI provider는 합성 응답만 사용한다.
 * 실제 네이버·공급사·운영·화면 검증으로 계산하지 않는다. */
import {createHash,X509Certificate,randomUUID} from 'node:crypto';
import {readFileSync,realpathSync,lstatSync,readdirSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import https from 'node:https';
import {createInterface} from 'node:readline';

const HERE=fileURLToPath(import.meta.url),DRIVER='tests/integration/jonghyun/member-connections-rest.mjs';
const ENTRIES=['backend/supabase/functions/service-api/index.ts','backend/supabase/functions/ai-chat/index.ts','apps/mobile/src/member-service.ts','apps/mobile/src/service.ts','apps/mobile/src/member-session.ts','apps/mobile/src/web-member-session.ts'];
export const MEMBER_ARG_KEYS=Object.freeze({verifyTarget:[],readCredentials:[],readIssuedAuth:[],readTls:[],prepareConversation:['memberUserIds'],inspectConversation:['requestId'],prepareReadBoundaryCases:['requestId'],inspectReadBoundaryCases:['requestId'],setReadBoundaryCase:['requestId','stage'],inspectAiFeedback:['userId','requestId'],prepareFeedbackRetention:['userId','requestId','feedbackId'],inspectMaintenance:['requestId'],cleanupConnections:['memberUserIds'],prepareRetirement:['userId'],inspectRetirement:['userId','withdrawalId'],cleanupRetirement:['userId','withdrawalId'],prepareCompletedRetirement:['userId'],inspectCompletedRetirement:['userId','withdrawalId'],cleanupCompletedRetirement:['userId','withdrawalId']});
const sha=v=>createHash('sha256').update(v).digest('hex');
const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const stable=v=>JSON.stringify(object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):v);
const exact=(v,keys)=>object(v)&&stable(Object.keys(v).sort())===stable([...keys].sort());
const requireCase=(v,code)=>{if(!v)throw Error('MEMBER_CASE_'+code);};
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const safePath=p=>typeof p==='string'&&!isAbsolute(p)&&!p.split('/').some(x=>['','..','.'].includes(x))&&/^[A-Za-z0-9_./-]+$/.test(p);
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const clone=v=>freeze(structuredClone(v));
const bytes=(root,path)=>{const full=resolve(root,path);requireCase(safePath(path)&&realpathSync(root)===root&&relative(root,full)===path&&realpathSync(full)===full&&lstatSync(full).isFile(),'PIN_PATH');return readFileSync(full);};
const parsed=new Map();
export function collectMemberSources(root){
 const pending=[...ENTRIES,DRIVER],files={};
 while(pending.length){const path=pending.pop();if(Object.hasOwn(files,path))continue;const raw=bytes(root,path),hash=sha(raw);files[path]=hash;
  const key=path+hash;let specs=parsed.get(key);
  if(!specs){const script="import{stripTypeScriptTypes}from'node:module';import{SourceTextModule}from'node:vm';let s='';for await(const x of process.stdin)s+=x;const m=new SourceTextModule(process.argv[1]==='ts'?stripTypeScriptTypes(s,{mode:'strip'}):s);process.stdout.write(JSON.stringify(m.dependencySpecifiers));";
   try{specs=JSON.parse(execFileSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',script,path.endsWith('.ts')?'ts':'js'],{input:raw,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:5000,maxBuffer:4*1024*1024}));}catch{requireCase(false,'IMPORT_PARSE');}
   for(const m of raw.toString().matchAll(/\b(?:import|export)\s+type\s+(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s*from\s*['"]([^'"]+)['"]/g))specs.push(m[1]);
   for(const m of raw.toString().matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g))specs.push(m[1]);
   specs=[...new Set(specs)];parsed.set(key,specs);
  }
  for(const spec of specs){if(spec.startsWith('node:'))continue;requireCase(spec.startsWith('.'),'REMOTE_IMPORT');let next=relative(root,resolve(root,dirname(path),spec));if(!/\.(ts|mjs|js)$/.test(next))next+='.ts';requireCase(safePath(next)&&(next.startsWith('backend/supabase/functions/')||next.startsWith('apps/mobile/src/')),'IMPORT_ESCAPE');pending.push(next);}
 }
 return files;
}
export function validateMemberInput(input){
 const v2=input?.version===2;
 requireCase(exact(input,['version','scenario','repositoryRoot','codeRoot','head','sourceFiles','migrationFiles','target','bindingSha256',...(v2?['completionMode']:[])]),'INPUT_SHAPE');
 requireCase((input.version===1&&input.scenario==='MEMBER_CONNECTIONS_J07_J08_J09'||v2&&input.scenario==='MEMBER_CONNECTIONS_COMPLETED'&&['ack_loss','delete_loss'].includes(input.completionMode))&&typeof input.head==='string'&&/^[a-f0-9]{40}$/.test(input.head)&&digest(input.bindingSha256),'INPUT_IDENTITY');
 requireCase([input.repositoryRoot,input.codeRoot].every(x=>typeof x==='string'&&isAbsolute(x)),'ROOT');
 for(const [kind,files] of [['source',input.sourceFiles],['migration',input.migrationFiles]])requireCase(object(files)&&Object.keys(files).length>0&&Object.entries(files).every(([p,h])=>safePath(p)&&digest(h)&&(kind==='source'?p===DRIVER||p.startsWith('backend/supabase/functions/')||p.startsWith('apps/mobile/src/'): /^backend\/supabase\/migrations\/[0-9]+_[A-Za-z0-9_-]+\.sql$/.test(p))),'PINS');
 requireCase([...ENTRIES,DRIVER].every(p=>Object.hasOwn(input.sourceFiles,p)),'REQUIRED_PINS');
 if(input.target!==null){const t=input.target;requireCase(exact(t,['dockerSocket','project','runId','containers','origin','authIssuer','authAudience']),'TARGET_SHAPE');
  requireCase(isAbsolute(t.dockerSocket)&&t.dockerSocket.endsWith('/docker.sock')&&/^jonghyun-backend100-[a-f0-9]{8}$/.test(t.project)&&uuid(t.runId),'TARGET_IDENTITY');
  requireCase(exact(t.containers,['db','auth','rest','gateway'])&&new Set(Object.values(t.containers).map(c=>c.id)).size===4&&Object.values(t.containers).every(c=>exact(c,['id','name','image','configSha256','hostConfigSha256','mountsSha256'])&&digest(c.id)&&typeof c.name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(c.name)&&/^sha256:[a-f0-9]{64}$/.test(c.image)&&[c.configSha256,c.hostConfigSha256,c.mountsSha256].every(digest)),'TARGET_CONTAINERS');
  let u;try{u=new URL(t.origin);}catch{requireCase(false,'ORIGIN');}requireCase(u.hostname==='127.0.0.1'&&u.protocol==='http:'&&u.port&&u.origin===t.origin&&!u.username&&!u.password&&t.authIssuer===t.origin+'/auth/v1'&&t.authAudience==='authenticated','ORIGIN');
 }
 return {status:'INPUT_VALID_ONLY',execution:'NOT_RUN',ready:false,actualTargetVerified:false,rootBoundary:'REQUIRED'};
}
export function checkMemberSources(input){
 const report=validateMemberInput(input);requireCase(realpathSync(input.repositoryRoot)===input.repositoryRoot&&realpathSync(input.codeRoot)===input.codeRoot,'ROOT_CANONICAL');
 requireCase(execFileSync('git',['rev-parse','HEAD'],{cwd:input.repositoryRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()===input.head,'HEAD_CHANGED');
 requireCase(stable(collectMemberSources(input.codeRoot))===stable(input.sourceFiles),'SOURCE_CLOSURE');
 const migrations=readdirSync(resolve(input.repositoryRoot,'backend/supabase/migrations')).filter(x=>x.endsWith('.sql')).map(x=>'backend/supabase/migrations/'+x).sort();requireCase(stable(migrations)===stable(Object.keys(input.migrationFiles).sort()),'MIGRATION_SET');
 for(const [path,hash]of Object.entries({...input.sourceFiles,...input.migrationFiles})){requireCase(sha(bytes(input.repositoryRoot,path))===hash,'WORKTREE_CHANGED');requireCase(sha(execFileSync('git',['show',input.head+':'+path],{cwd:input.repositoryRoot,stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:4*1024*1024}))===hash,'HEAD_BYTES_CHANGED');}
 return {...report,sourceVerified:true,credentialReads:0,networkCalls:0};
}
export function validateIssuedMembers(accounts,target,now=Date.now()){
 requireCase(Array.isArray(accounts)&&accounts.length===6,'AUTH_SIX');
 for(const field of ['userId','sessionId','accessToken','authEmail'])requireCase(new Set(accounts.map(a=>a[field])).size===6,'AUTH_DISTINCT');
 for(const a of accounts){requireCase(exact(a,['userId','sessionId','accessToken','expiresAt','authEmail'])&&uuid(a.userId)&&uuid(a.sessionId)&&typeof a.authEmail==='string'&&/^[^\s@]+@[^\s@]+$/.test(a.authEmail)&&typeof a.accessToken==='string'&&a.accessToken.length<=16384&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(a.accessToken),'AUTH_ACCOUNT');
  let h,c;try{h=JSON.parse(Buffer.from(a.accessToken.split('.')[0],'base64url'));c=JSON.parse(Buffer.from(a.accessToken.split('.')[1],'base64url'));}catch{requireCase(false,'AUTH_PAYLOAD');}
  requireCase(typeof h.alg==='string'&&h.alg.toLowerCase()!=='none'&&c.sub===a.userId&&c.session_id===a.sessionId&&c.iss===target.authIssuer&&(c.aud===target.authAudience||Array.isArray(c.aud)&&c.aud.includes(target.authAudience))&&c.role==='authenticated'&&c.is_anonymous!==true&&Number.isSafeInteger(c.exp)&&c.exp===a.expiresAt&&c.exp*1000>now+60000&&(c.nbf===undefined||Number.isSafeInteger(c.nbf)&&c.nbf*1000<=now),'AUTH_BINDING');
 }
 return {scope:'ISSUED_METADATA_ONLY',signatureVerified:false};
}
export const MEMBER_METHODS=Object.freeze(['verifyTarget','readCredentials','readIssuedAuth','readTls','prepareConversation','inspectConversation','prepareReadBoundaryCases','inspectReadBoundaryCases','setReadBoundaryCase','inspectAiFeedback','prepareFeedbackRetention','inspectMaintenance','cleanupConnections','prepareRetirement','inspectRetirement','cleanupRetirement']);
export const COMPLETED_MEMBER_METHODS=Object.freeze([...MEMBER_METHODS,'prepareCompletedRetirement','inspectCompletedRetirement','cleanupCompletedRetirement']);
function validateReadMethod(method,args){
 if(['prepareReadBoundaryCases','inspectReadBoundaryCases','setReadBoundaryCase'].includes(method))requireCase(uuid(args.requestId),'READ_BOUNDARY_REQUEST');
 if(method==='setReadBoundaryCase')requireCase(['hidden','revoked','restored'].includes(args.stage),'READ_BOUNDARY_STAGE');
 if(['prepareCompletedRetirement','inspectCompletedRetirement','cleanupCompletedRetirement'].includes(method))requireCase(uuid(args.userId),'COMPLETION_USER');
 if(['inspectCompletedRetirement','cleanupCompletedRetirement'].includes(method))requireCase(uuid(args.withdrawalId),'COMPLETION_WITHDRAWAL');
}

const instant=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v));
export function validateCompletedRetirementFixture(value,userId){
 requireCase(exact(value,['status','userId','withdrawalId','objectId','objectSha256','objectBytes','invocationRequestId','recoveryRequestId'])&&value.status==='prepared'&&value.userId===userId&&uuid(userId)&&[value.withdrawalId,value.objectId,value.invocationRequestId,value.recoveryRequestId].every(uuid)&&new Set([value.withdrawalId,value.objectId,value.invocationRequestId,value.recoveryRequestId]).size===4&&digest(value.objectSha256)&&Number.isSafeInteger(value.objectBytes)&&value.objectBytes>0&&value.objectBytes<=2097152,'COMPLETION_FIXTURE');
 return clone(value);
}
export function validateCompletedRetirementInspection(value,fixture){
 requireCase(exact(value,['withdrawalId','userId','state','rowSha256','ackSha256','tasks','invocations','reconciliations','scopeRowsSha256','authUserPresent','storageObjectPresent','storageBytesPresent','otherFivePreserved'])&&value.withdrawalId===fixture.withdrawalId&&value.userId===fixture.userId&&['pending_cleanup','completed'].includes(value.state)&&digest(value.rowSha256)&&digest(value.scopeRowsSha256)&&(value.ackSha256===null||digest(value.ackSha256))&&['authUserPresent','storageObjectPresent','storageBytesPresent','otherFivePreserved'].every(k=>typeof value[k]==='boolean')&&value.otherFivePreserved===true,'COMPLETION_INSPECTION');
 requireCase(Array.isArray(value.tasks)&&value.tasks.length===2&&value.tasks[0].taskId<value.tasks[1].taskId&&new Set(value.tasks.map(t=>t.kind)).size===2,'COMPLETION_TASKS');
 for(const t of value.tasks){
  requireCase(exact(t,['taskId','withdrawalId','profileId','kind','state','objectId','leaseToken','workerRunToken','leaseExpiresAt','evidenceSha256','completedAt','rowSha256','dispatch','ack'])&&uuid(t.taskId)&&t.withdrawalId===fixture.withdrawalId&&t.profileId===fixture.userId&&['pending','running','completed'].includes(t.state)&&digest(t.rowSha256)&&(t.kind==='storage_object'&&t.objectId===fixture.objectId||t.kind==='auth_user'&&t.objectId===null),'COMPLETION_TASK');
  requireCase(t.state==='running'?[t.leaseToken,t.workerRunToken].every(uuid)&&instant(t.leaseExpiresAt):t.leaseToken===null&&t.workerRunToken===null&&t.leaseExpiresAt===null,'COMPLETION_LEASE');
  requireCase(t.state==='completed'?digest(t.evidenceSha256)&&instant(t.completedAt):t.evidenceSha256===null&&t.completedAt===null,'COMPLETION_TASK_RESULT');
  requireCase(t.dispatch===null||exact(t.dispatch,['dispatchId','rowSha256'])&&uuid(t.dispatch.dispatchId)&&digest(t.dispatch.rowSha256),'COMPLETION_DISPATCH');
  requireCase(t.ack===null||exact(t.ack,['receiptId','ackSha256','rowSha256'])&&uuid(t.ack.receiptId)&&digest(t.ack.ackSha256)&&digest(t.ack.rowSha256),'COMPLETION_ACK');
  requireCase(t.ack===null||t.dispatch!==null,'COMPLETION_ACK_ORIGIN');
  if(t.state==='completed')requireCase(t.ack!==null&&t.dispatch!==null,'COMPLETION_TASK_EVIDENCE');
 }
 requireCase(Array.isArray(value.invocations)&&value.invocations.length<=1,'COMPLETION_INVOCATIONS');
 for(const v of value.invocations){
  requireCase(exact(v,['requestId','globalToken','kind','limit','remainingMs','state','result','closedAt','rowSha256'])&&v.requestId===fixture.invocationRequestId&&uuid(v.globalToken)&&v.kind==='member_cleanup'&&v.limit===2&&Number.isSafeInteger(v.remainingMs)&&v.remainingMs>0&&v.remainingMs<=180000&&['prepared','unknown','completed'].includes(v.state)&&digest(v.rowSha256),'COMPLETION_INVOCATION');
  if(v.state!=='completed')requireCase(v.result===null&&v.closedAt===null,'COMPLETION_INVOCATION_OPEN');
  else{const r=v.result,c=r?.counts;requireCase(instant(v.closedAt)&&exact(r,['status','counts'])&&r.status==='ran'&&exact(c,['claimed','succeeded','retried','failed','superseded','yielded'])&&Object.values(c).every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2)&&c.claimed===c.succeeded+c.retried+c.failed+c.superseded+c.yielded,'COMPLETION_INVOCATION_RESULT');}
 }
 requireCase(Array.isArray(value.reconciliations)&&value.reconciliations.length<=1,'COMPLETION_RECONCILIATIONS');
 const authTask=value.tasks.find(t=>t.kind==='auth_user');
 for(const r of value.reconciliations)requireCase(exact(r,['recoveryRequestId','invocationRequestId','taskId','state','evidenceSha256','rowSha256'])&&r.recoveryRequestId===fixture.recoveryRequestId&&r.invocationRequestId===fixture.invocationRequestId&&r.taskId===authTask.taskId&&['prepared','completed','superseded'].includes(r.state)&&digest(r.rowSha256)&&(r.state==='completed'?digest(r.evidenceSha256):r.evidenceSha256===null),'COMPLETION_RECONCILIATION');
 if(value.state==='completed')requireCase(value.tasks.every(t=>t.state==='completed')&&!value.authUserPresent&&!value.storageObjectPresent&&!value.storageBytesPresent,'COMPLETION_PHYSICAL_ABSENCE');
 return clone(value);
}
export function validateReadBoundaryFixture(value,original){
 requireCase(exact(value,['requestId','messageIds','foreignRequestId','foreignMessageId','hiddenMessageId'])&&value.requestId===original.requestId&&uuid(value.foreignRequestId)&&value.foreignRequestId!==value.requestId&&uuid(value.foreignMessageId)&&Array.isArray(value.messageIds)&&value.messageIds.length===100&&value.messageIds.every(uuid)&&new Set(value.messageIds).size===100&&original.messageIds.every(id=>value.messageIds.includes(id))&&!value.messageIds.includes(value.foreignMessageId)&&value.hiddenMessageId===value.messageIds[99],'READ_BOUNDARY_FIXTURE');
 return clone(value);
}
export function validateReadBoundaryInspection(value,fixture,users){
 requireCase(exact(value,['requestId','scopeRowsSha256','reads','hidden','visibility','sessionBindingRestored'])&&value.requestId===fixture.requestId&&digest(value.scopeRowsSha256)&&typeof value.sessionBindingRestored==='boolean','READ_BOUNDARY_INSPECTION');
 const sorted=(rows,keys,check)=>{requireCase(Array.isArray(rows),'READ_BOUNDARY_ROWS');let previous='';for(const row of rows){requireCase(check(row),'READ_BOUNDARY_ROW');const key=keys.map(k=>row[k]).join(':');requireCase(previous===''||previous<key,'READ_BOUNDARY_SORT_DUPLICATE');previous=key;}};
 const owns=(request,message)=>request===fixture.requestId?fixture.messageIds.includes(message):request===fixture.foreignRequestId&&message===fixture.foreignMessageId;
 sorted(value.reads,['userId','requestId','messageId'],r=>exact(r,['userId','requestId','messageId','readAt','rowSha256'])&&users.includes(r.userId)&&owns(r.requestId,r.messageId)&&typeof r.readAt==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(r.readAt)&&Number.isFinite(Date.parse(r.readAt))&&digest(r.rowSha256));
 sorted(value.hidden,['id'],r=>exact(r,['id','rowSha256'])&&uuid(r.id)&&digest(r.rowSha256));
 sorted(value.visibility,['userId','requestId'],r=>exact(r,['userId','requestId','rowSha256'])&&users.includes(r.userId)&&[fixture.requestId,fixture.foreignRequestId].includes(r.requestId)&&digest(r.rowSha256));
 requireCase(value.hidden.length<=1,'READ_BOUNDARY_HIDDEN_SCOPE');return clone(value);
}
export function assertReadBoundaryUnchanged(before,after){requireCase(stable(before)===stable(after),'READ_BOUNDARY_UNEXPECTED_WRITE');}
export function assertReadBoundaryFirstReads(before,after){
 for(const row of before.reads)requireCase(after.reads.some(next=>stable(next)===stable(row)),'READ_BOUNDARY_FIRST_READ_CHANGED');
}
/** 신규 service-only RPC도 임의 scope/원문/query/회원 bearer 전송을 허용하지 않는다. */
export function validateMemberResultStateRpc(url,init,credentials){
 const headers=new Headers(init.headers);let args;try{args=JSON.parse(init.body);}catch{requireCase(false,'RESULT_STATE_RPC');}
 requireCase(url.pathname==='/rest/v1/rpc/get_ai_result_state'&&!url.search&&!url.hash&&init.method==='POST'&&headers.get('authorization')==='Bearer '+credentials.service&&headers.get('apikey')===credentials.service&&exact(args,['p_user_id','p_request_id'])&&uuid(args.p_user_id)&&uuid(args.p_request_id),'RESULT_STATE_RPC');
}
/** 실제 driver와 같은 SDK/HTTP 포트 순서를 모형 시험에서도 사용한다. native 증거는 부모 책임이다. */
export async function verifyMemberResultStateReads({requestId,missingId,owner,foreign,probe,observe}){
 requireCase(uuid(requestId)&&uuid(missingId)&&missingId!==requestId,'RESULT_STATE_SCOPE');
 const before=clone(observe()),state=await owner.getAiResultState(requestId);
 requireCase(exact(state,['requestId','status','availableAt','helpfulAllowed'])&&state.requestId===requestId&&state.status==='available'&&state.helpfulAllowed===true&&typeof state.availableAt==='string'&&Number.isFinite(Date.parse(state.availableAt)),'RESULT_STATE_AVAILABLE');
 const envelope=await probe(requestId);
 requireCase(envelope.status===200&&exact(envelope.body,['data','requestId'])&&uuid(envelope.body.requestId)&&envelope.body.requestId!==requestId&&stable(envelope.body.data)===stable(state),'RESULT_STATE_ENVELOPE');
 for(const [client,id]of [[foreign,requestId],[owner,missingId]]){let denied=false;try{await client.getAiResultState(id);}catch(e){denied=e.status===404;}requireCase(denied,'RESULT_STATE_NOT_FOUND');}
 const accepted=clone(observe());requireCase(accepted.reads===before.reads+4&&stable(accepted.writes)===stable(before.writes),'RESULT_STATE_READ_ONLY');
 for(const options of [{query:'?userId='+missingId},{method:'POST'}]){
  const rejected=await probe(requestId,options);requireCase(rejected.status===503&&stable(observe())===stable(accepted),'RESULT_STATE_BRIDGE_REJECTION');
 }
 return {status:'ROOT_ATTESTATION_REQUIRED',ownerAvailable:true,foreignAndMissing404:true,strictFourFields:true,originalResultAndNewEnvelopeIds:true,mutationRpcIncrease:0,providerIncrease:0,bridgeQueryAndMethodRejected:true};
}
export function validateMemberBridgeRoute(url,method){
 const path=url.pathname,prefix='/functions/v1/service-api/conversations',match=/^\/functions\/v1\/service-api\/conversations\/[a-f0-9-]{36}(?:\/(messages|read\/messages|leave))?$/.exec(path);
 requireCase(url.protocol==='https:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&!url.hash,'BRIDGE_ORIGIN');
 if(path===prefix)requireCase(method==='GET'&&!url.search,'BRIDGE_QUERY');
 else if(match){
  requireCase(uuid(path.slice(prefix.length+1).split('/')[0]),'BRIDGE_ROUTE');
  if(match[1]==='messages'&&method==='GET')requireCase(url.searchParams.getAll('limit').length===1&&url.searchParams.get('limit')==='20'&&url.searchParams.getAll('before').length<=1&&(!url.searchParams.has('before')||uuid(url.searchParams.get('before')))&&[...url.searchParams.keys()].every(k=>['limit','before'].includes(k)),'BRIDGE_QUERY');
  else requireCase(method===(match[1]?'POST':'GET')&&!url.search,'BRIDGE_QUERY');
 }else if(/^\/functions\/v1\/ai-chat\/results\/[^/]+$/.test(path))requireCase(uuid(path.split('/').at(-1))&&method==='GET'&&!url.search,'BRIDGE_RESULT_STATE');
 else if(path==='/functions/v1/service-api/me/retirement')requireCase(method==='POST'&&!url.search||method==='GET'&&[...url.searchParams.keys()].length===1&&url.searchParams.getAll('withdrawalId').length===1&&uuid(url.searchParams.get('withdrawalId')),'BRIDGE_QUERY');
 else requireCase(['/functions/v1/ai-chat','/functions/v1/ai-chat/feedback','/functions/v1/service-api/internal/ai-feedback-maintenance'].includes(path)&&method==='POST'&&!url.search,'BRIDGE_ROUTE');
}
/** 부모는 모든 method를 exact runId/원 Auth6와 결합하고 고정 SQL만 실행한다. 임의 SQL argument는 없다. */
export async function runMemberConnections(input,boundary){
 input=clone(input);validateMemberInput(input);requireCase(input.target!==null,'EXACT_TARGET_REQUIRED');
 if(input.version===2)return runCompletedMemberConnections(input,boundary);
 for(const name of MEMBER_METHODS)requireCase(typeof boundary?.[name]==='function','ROOT_BOUNDARY_REQUIRED');
 checkMemberSources(input);
 const call=(name,args={})=>{requireCase(exact(args,MEMBER_ARG_KEYS[name]),'FIXED_METHOD_ARGUMENTS');validateReadMethod(name,args);return boundary[name]({runId:input.target.runId,bindingSha256:input.bindingSha256,...args});};
 const verify=async()=>{const v=await call('verifyTarget');requireCase(exact(v,['target','bindingSha256','sourceFiles','migrationFiles'])&&stable(v.target)===stable(input.target)&&v.bindingSha256===input.bindingSha256&&stable(v.sourceFiles)===stable(input.sourceFiles)&&stable(v.migrationFiles)===stable(input.migrationFiles),'ROOT_BINDING_MISMATCH');};
 await verify();const credentials=clone(await call('readCredentials'));requireCase(exact(credentials,['anon','service','internalSecret','ledgerId'])&&Object.values(credentials).every(x=>typeof x==='string'&&x.length>0&&!/[\r\n]/.test(x))&&credentials.anon!==credentials.service,'CREDENTIALS');
 const auth=clone(await call('readIssuedAuth'));validateIssuedMembers(auth,input.target);const tokens=new Set(auth.map(a=>a.accessToken));
 const tls=clone(await call('readTls'));requireCase(exact(tls,['key','cert'])&&[tls.key,tls.cert].every(x=>typeof x==='string'&&x.length>0),'TLS_SHAPE');const cert=new X509Certificate(tls.cert);requireCase(cert.checkIP('127.0.0.1')==='127.0.0.1'&&Date.parse(cert.validFrom)<=Date.now()&&Date.parse(cert.validTo)>Date.now(),'TLS');
 const rpcAllowed=new Set(['get_conversation_with_read_state','list_conversation_messages','list_conversations_with_read_state','leave_conversation','mark_conversation_messages_read','send_conversation_message','get_my_profile_traits','acquire_ai_chat_request','finish_ai_chat_request','record_ai_chat_result_available','get_ai_feedback_readiness','get_ai_result_state','submit_ai_feedback','purge_ai_feedback_scoped','get_worker_runtime_operation','retire_my_account','get_my_retirement_receipt']);
 const originalFetch=globalThis.fetch,counts={auth:0,rpc:0,bridge:0,providerSynthetic:0,external:0,maintenanceRpcCalls:0,auth500Faults:0},rpcCounts={};let server,fixture,retirement,opened=false,dropPurge=false,auth500Fault=false;
 const localFetch=async(url,init={})=>{
  const u=new URL(url instanceof Request?url.url:String(url));requireCase(u.origin===input.target.origin&&!u.hash&&!u.username&&!u.password,'BACKEND_ORIGIN');const headers=new Headers(init.headers),token=headers.get('authorization')?.replace(/^Bearer /,'');
  requireCase([...headers.keys()].every(k=>['apikey','authorization','content-type','accept'].includes(k)),'BACKEND_HEADERS');
  if(u.pathname==='/auth/v1/user'){requireCase(!u.search&&init.method==='GET'&&headers.get('apikey')===credentials.anon&&(tokens.has(token)||token==='invalid.invalid.invalid'),'AUTH_FETCH');counts.auth++;if(auth500Fault){requireCase(token===auth[0].accessToken,'AUTH_FAULT_MEMBER');auth500Fault=false;counts.auth500Faults++;return Response.json({message:'합성 인증 장애 모형'},{status:500});}}
  else{const name=u.pathname.split('/').at(-1);requireCase(u.pathname==='/rest/v1/rpc/'+name&&rpcAllowed.has(name)&&(tokens.has(token)||token===credentials.anon||token===credentials.service),'RPC_FETCH');
   if(name==='get_my_retirement_receipt')requireCase(init.method==='GET'&&init.body===undefined&&tokens.has(token)&&headers.get('apikey')===credentials.anon&&stable([...u.searchParams.keys()].sort())===stable(['p_request_fingerprint','p_withdrawal_id'])&&uuid(u.searchParams.get('p_withdrawal_id'))&&digest(u.searchParams.get('p_request_fingerprint')),'RECEIPT_READ_ONLY');
   else if(name==='get_ai_result_state')validateMemberResultStateRpc(u,init,credentials);
   else requireCase(!u.search&&init.method==='POST'&&headers.get('apikey')===(token===credentials.service?credentials.service:credentials.anon),'RPC_ROLE');counts.rpc++;rpcCounts[name]=(rpcCounts[name]??0)+1;if(name==='purge_ai_feedback_scoped')counts.maintenanceRpcCalls++;}
  const response=await originalFetch(u,{...init,redirect:'error',credentials:'omit'});
  if(u.pathname==='/auth/v1/user'&&response.ok&&tokens.has(token)){const v=await response.clone().json();requireCase(v.id===auth.find(a=>a.accessToken===token).userId&&v.role==='authenticated'&&v.is_anonymous!==true,'GOTRUE_SUBJECT');}
  if(dropPurge&&u.pathname.endsWith('/purge_ai_feedback_scoped')){dropPurge=false;await response.arrayBuffer();throw Error('MEMBER_CASE_SYNTHETIC_RESPONSE_LOSS');}
  return response;
 };
 const aiFetch=async(url,init)=>{const u=new URL(String(url));if(u.origin==='https://ai.potens.ai'){requireCase(u.pathname==='/api/chat'&&init.method==='POST','SYNTHETIC_PROVIDER');counts.providerSynthetic++;return Response.json({message:JSON.stringify({status:'search',filters:{target:'posts',region:'서울특별시'}}),token_usage:{inputTokens:30,outputTokens:20}});}return localFetch(url,init);};
 globalThis.fetch=localFetch;
 try{
  await verify();opened=true;fixture=clone(await call('prepareConversation',{memberUserIds:[auth[0].userId,auth[1].userId]}));requireCase(exact(fixture,['requestId','messageIds'])&&uuid(fixture.requestId)&&Array.isArray(fixture.messageIds)&&fixture.messageIds.length===3&&fixture.messageIds.every(uuid)&&new Set(fixture.messageIds).size===3,'CONVERSATION_FIXTURE');
  const {createRuntimeHandler}=await import(pathToFileURL(resolve(input.codeRoot,ENTRIES[0])).href),{createAiChatRuntime}=await import(pathToFileURL(resolve(input.codeRoot,ENTRIES[1])).href);
  const {MemberService}=await import(pathToFileURL(resolve(input.codeRoot,ENTRIES[2])).href),{ServiceApiClient}=await import(pathToFileURL(resolve(input.codeRoot,'apps/mobile/src/api.ts')).href),{YumidangService}=await import(pathToFileURL(resolve(input.codeRoot,ENTRIES[3])).href);
  const env={SUPABASE_URL:input.target.origin,SUPABASE_ANON_KEY:credentials.anon,SUPABASE_SERVICE_ROLE_KEY:credentials.service,INTERNAL_WORKER_SECRET:credentials.internalSecret,ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000',AI_RETENTION_DECISION_ID:'synthetic-fixture-only',AI_COST_EVIDENCE_ID:'synthetic-fixture-only',AI_PROCESSING_LEGAL_DECISION_ID:'synthetic-fixture-only',AI_MEMBER_TRANSMISSION_APPROVAL_ID:'synthetic-fixture-only',AI_BUDGET_LEDGER_ID:credentials.ledgerId,POTENS_API_KEY:'synthetic-never-sent',POTENS_MODEL:'claude-5-sonnet',POTENS_API_BASE_URL:'https://ai.potens.ai',POTENS_USAGE_INPUT_FIELD:'inputTokens',POTENS_USAGE_OUTPUT_FIELD:'outputTokens',AI_CHAT_MAX_MESSAGES:'20',AI_CHAT_MAX_MESSAGE_CHARS:'500',AI_CHAT_MAX_TOTAL_CHARS:'4000',AI_CHAT_MAX_OUTPUT_TOKENS:'800',AI_CHAT_SEARCH_PAGE_SIZE:'10',AI_CHAT_MAX_SEARCH_PAGES:'3',AI_CHAT_RECHECK_MAX_PAGES:'3',AI_CHAT_MAX_RESULT_CARDS:'5',AI_CHAT_MATCH_BATCH_SIZE:'5',AI_CHAT_MAX_MATCH_CALLS:'3',AI_CHAT_MATCH_MAX_OUTPUT_TOKENS:'600'};
  let activeApi=createRuntimeHandler(k=>env[k]);const chat=createAiChatRuntime(k=>env[k],aiFetch,{privacy:{decisionId:'synthetic-fixture-only',check:async()=>true},outputLimit:{decisionId:'synthetic-fixture-only',apply:b=>b}});
  server=https.createServer({key:tls.key,cert:tls.cert},async(req,res)=>{try{requireCase(['GET','POST'].includes(req.method),'BRIDGE_METHOD');requireCase(req.socket.remoteAddress==='127.0.0.1'||req.socket.remoteAddress==='::ffff:127.0.0.1','BRIDGE_REMOTE');let body='';for await(const chunk of req){body+=chunk;requireCase(Buffer.byteLength(body)<=65536,'BRIDGE_BODY');}const origin='https://127.0.0.1:'+server.address().port,url=new URL(req.url,origin);requireCase(url.origin===origin&&!url.username&&!url.password&&!url.hash,'BRIDGE_ORIGIN');validateMemberBridgeRoute(url,req.method);const request=new Request(url,{method:req.method,headers:req.headers,...(body?{body}: {})});const response=await(url.pathname.startsWith('/functions/v1/ai-chat')?chat(request):activeApi(request));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(503,{'content-type':'application/json'});res.end('{"data":null,"error":{"code":"EXTERNAL_UNAVAILABLE"}}');}});
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});const bridge='https://127.0.0.1:'+server.address().port;
  const fetcher=(url,init={})=>new Promise((ok,no)=>{const u=new URL(url);requireCase(u.origin===bridge&&!u.username&&!u.password,'CLIENT_ORIGIN');counts.bridge++;const request=https.request(u,{method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers)),ca:tls.cert,rejectUnauthorized:true,signal:init.signal},res=>{const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024)request.destroy();else chunks.push(chunk);});res.on('end',()=>ok(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));res.on('error',()=>no(Error('MEMBER_CASE_CLIENT_RESPONSE')));});request.setTimeout(10000,()=>request.destroy());request.on('error',()=>no(Error('MEMBER_CASE_CLIENT_TRANSPORT')));request.end(init.body);});
  const client=n=>new ServiceApiClient(bridge+'/functions/v1/service-api',async()=>auth[n].accessToken,fetcher),member=n=>new MemberService(client(n)),viewer=member(0);
  const messages=fixture.messageIds;
  const second=await viewer.markMessagesRead(fixture.requestId,[messages[1]]);requireCase(stable(second.confirmedMessageIds)===stable([messages[1]])&&second.unreadCount===1,'MESSAGE_SET_SECOND');
  const beforeWrong=clone(await call('inspectConversation',{requestId:fixture.requestId}));let wrong=false;try{await viewer.markMessagesRead(fixture.requestId,[messages[0],randomUUID()]);}catch(e){wrong=e.status===404;}requireCase(wrong&&stable(beforeWrong)===stable(await call('inspectConversation',{requestId:fixture.requestId})),'MESSAGE_WRONG_BATCH_ATOMIC');
  const repeated=await Promise.all(Array.from({length:6},()=>viewer.markMessagesRead(fixture.requestId,[messages[1]])));requireCase(repeated.every(x=>x.unreadCount===1),'MESSAGE_REPEAT');
  const afterRepeated=await call('inspectConversation',{requestId:fixture.requestId});requireCase(stable(beforeWrong)===stable(afterRepeated),'MESSAGE_FIRST_READ_STABLE');
  // 새 메시지는 기존 실제 send HTTP 계약을 사용하며 읽음 위치를 되돌리지 않는다.
  await Promise.all([viewer.markMessagesRead(fixture.requestId,[messages[0]]),client(1).request('/conversations/'+fixture.requestId+'/messages',{method:'POST',body:{messageId:messages[2],content:'합성 신규 메시지'}})]);
  const latest=await viewer.conversation(fixture.requestId);requireCase(latest.unread_message_count===1,'MESSAGE_RACE_NEW_UNREAD');
  const outsider=new MemberService(client(2));let denied=false;try{await outsider.markMessagesRead(fixture.requestId,[messages[0]]);}catch(e){denied=[403,404].includes(e.status);}requireCase(denied,'MESSAGE_FOREIGN_MEMBER');
  const aiClient=n=>new YumidangService({serviceApiUrl:bridge+'/functions/v1/service-api',aiChatUrl:bridge+'/functions/v1/ai-chat',accessToken:async()=>auth[n].accessToken,fetcher});
  const direct=async(path,body,token=auth[0].accessToken,headers={})=>{const response=await fetcher(bridge+path,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:response.status,data:(await response.json()).data};};
  // J08 추가 범위: Root의 고정 scope만 조작하고 기존3행 PASS를 다시 정의하지 않는다.
  const readFixture=validateReadBoundaryFixture(await call('prepareReadBoundaryCases',{requestId:fixture.requestId}),fixture);
  const inspectRead=async()=>validateReadBoundaryInspection(await call('inspectReadBoundaryCases',{requestId:fixture.requestId}),readFixture,[auth[0].userId,auth[1].userId]);
  const setRead=async stage=>{await verify();const result=validateReadBoundaryInspection(await call('setReadBoundaryCase',{requestId:fixture.requestId,stage}),readFixture,[auth[0].userId,auth[1].userId]);const observed=await inspectRead();assertReadBoundaryUnchanged(result,observed);return observed;};
  const pageMessages=async excluded=>{let before;const seenCursors=new Set(),actual=[];let pages=0;do{const page=await viewer.messages(fixture.requestId,before);requireCase(page.items.length<=20&&++pages<=5,'MESSAGE_PAGE_BOUNDARY');actual.push(...page.items.map(m=>m.messageId));if(page.nextCursor!==null){requireCase(!seenCursors.has(page.nextCursor),'MESSAGE_CURSOR_REPEAT');seenCursors.add(page.nextCursor);before=page.nextCursor;}else before=undefined;}while(before);const expected=readFixture.messageIds.filter(id=>id!==excluded);requireCase(pages===5&&new Set(actual).size===actual.length&&stable([...actual].sort())===stable([...expected].sort()),'MESSAGE_API_ID_EVIDENCE');return actual;};
  const initialRead=await inspectRead();requireCase(initialRead.sessionBindingRestored&&initialRead.hidden.length===0&&initialRead.visibility.length===0,'MESSAGE_INITIAL_SCOPE');
  const actualIds=await pageMessages(null),mixedBefore=await inspectRead();
  requireCase(!mixedBefore.reads.some(r=>r.userId===auth[0].userId&&r.messageId===readFixture.hiddenMessageId),'MESSAGE_UNREAD_BOUNDARY_INPUT');
  let foreignRejected=false;try{await viewer.markMessagesRead(fixture.requestId,[readFixture.hiddenMessageId,readFixture.foreignMessageId]);}catch(e){foreignRejected=e.status===404;}requireCase(foreignRejected,'MESSAGE_REAL_FOREIGN_BATCH');assertReadBoundaryUnchanged(mixedBefore,await inspectRead());
  const allRead=await viewer.markMessagesRead(fixture.requestId,actualIds);requireCase(allRead.unreadCount===0&&stable([...allRead.confirmedMessageIds].sort())===stable([...actualIds].sort()),'MESSAGE_HUNDRED_RECEIPT');
  const allState=await inspectRead();assertReadBoundaryFirstReads(initialRead,allState);requireCase(allState.reads.filter(r=>r.userId===auth[0].userId&&r.requestId===fixture.requestId).length===100,'MESSAGE_HUNDRED_NATIVE_READS');
  for(const ids of [[...actualIds,readFixture.foreignMessageId],[actualIds[0],actualIds[0]]]){
   const before=await inspectRead(),bridgeBefore=counts.bridge;let denied=false;try{await viewer.markMessagesRead(fixture.requestId,ids);}catch(e){denied=e.status===400&&e.code==='INVALID_MESSAGE_IDS';}requireCase(denied&&counts.bridge===bridgeBefore,'MESSAGE_SDK_BATCH_REJECTION');assertReadBoundaryUnchanged(before,await inspectRead());
   const rpcBefore=counts.rpc,response=await direct('/functions/v1/service-api/conversations/'+fixture.requestId+'/read/messages',{messageIds:ids});requireCase(response.status===400&&counts.rpc===rpcBefore,'MESSAGE_HTTP_BATCH_REJECTION');assertReadBoundaryUnchanged(before,await inspectRead());
  }
  const hiddenState=await setRead('hidden');requireCase(hiddenState.hidden.length===1&&hiddenState.sessionBindingRestored,'MESSAGE_HIDDEN_STAGE');assertReadBoundaryFirstReads(allState,hiddenState);await pageMessages(readFixture.hiddenMessageId);
  let hiddenRejected=false;try{await viewer.markMessagesRead(fixture.requestId,[actualIds.find(id=>id!==readFixture.hiddenMessageId),readFixture.hiddenMessageId]);}catch(e){hiddenRejected=e.status===404;}requireCase(hiddenRejected,'MESSAGE_HIDDEN_BATCH');assertReadBoundaryUnchanged(hiddenState,await inspectRead());
  const beforeLeave=await inspectRead();await viewer.leave(fixture.requestId);
  requireCase(!(await viewer.conversations()).some(r=>r.request_id===fixture.requestId)&&(await member(1).conversations()).some(r=>r.request_id===fixture.requestId),'MESSAGE_LEAVE_LIST_ONLY');
  const visibleId=actualIds.find(id=>id!==readFixture.hiddenMessageId);requireCase((await viewer.markMessagesRead(fixture.requestId,[visibleId])).unreadCount===0,'MESSAGE_LEAVE_DIRECT_READ');
  const leftState=await inspectRead();requireCase(leftState.visibility.length===1&&leftState.visibility[0].userId===auth[0].userId&&leftState.visibility[0].requestId===fixture.requestId,'MESSAGE_LEAVE_NATIVE_SCOPE');assertReadBoundaryFirstReads(beforeLeave,leftState);
  const revoked=await setRead('revoked');requireCase(!revoked.sessionBindingRestored,'MESSAGE_REVOKED_STAGE');let revokedRejected=false;try{await viewer.markMessagesRead(fixture.requestId,[visibleId]);}catch(e){revokedRejected=[401,403].includes(e.status);}requireCase(revokedRejected,'MESSAGE_REVOKED_AUTHORIZATION');assertReadBoundaryUnchanged(revoked,await inspectRead());
  const restored=await setRead('restored');requireCase(restored.sessionBindingRestored&&restored.hidden.length===0,'MESSAGE_RESTORED_STAGE');assertReadBoundaryFirstReads(allState,restored);
  requireCase((await viewer.markMessagesRead(fixture.requestId,[readFixture.hiddenMessageId])).unreadCount===0,'MESSAGE_RESTORED_SAME_JWT');assertReadBoundaryUnchanged(restored,await inspectRead());
  const beforeAuthFault=await inspectRead(),rpcBeforeInvalid=counts.rpc,authBeforeInvalid=counts.auth;
  const invalid=await direct('/functions/v1/service-api/conversations/'+fixture.requestId+'/read/messages',{messageIds:[visibleId]},'invalid.invalid.invalid');requireCase(invalid.status===401&&counts.rpc===rpcBeforeInvalid&&counts.auth===authBeforeInvalid+1,'MESSAGE_INVALID_JWT_NO_FALLBACK');assertReadBoundaryUnchanged(beforeAuthFault,await inspectRead());
  const rpcBeforeFault=counts.rpc,authBeforeFault=counts.auth;auth500Fault=true;
  const unavailable=await direct('/functions/v1/service-api/conversations/'+fixture.requestId+'/read/messages',{messageIds:[visibleId]});requireCase(unavailable.status===503&&!auth500Fault&&counts.auth500Faults===1&&counts.rpc===rpcBeforeFault&&counts.auth===authBeforeFault+1,'MESSAGE_AUTH500_FAULT_NO_FALLBACK');assertReadBoundaryUnchanged(beforeAuthFault,await inspectRead());
  const result=await direct('/functions/v1/ai-chat',{clientRequestId:'member-'+input.target.runId,messages:[{role:'user',content:'동행 찾기'}],currentFilters:{target:'posts'}});requireCase(result.status===200&&result.data.status==='needs_clarification'&&uuid(result.data.requestId),'AI_SUCCESS_RECEIPT');
  const receipt=clone(await call('inspectAiFeedback',{userId:auth[0].userId,requestId:result.data.requestId}));requireCase(receipt.resultReceiptCount===1,'AI_RECEIPT_ONCE');
  const observeResultReads=()=>({reads:rpcCounts.get_ai_result_state??0,auth:counts.auth,writes:{providerSynthetic:counts.providerSynthetic,rpc:Object.fromEntries(Object.entries(rpcCounts).filter(([name])=>name!=='get_ai_result_state'))}});
  const probeResult=async(id,{method='GET',query=''}={})=>{const response=await fetcher(bridge+'/functions/v1/ai-chat/results/'+id+query,{method,headers:{authorization:'Bearer '+auth[0].accessToken}});return {status:response.status,body:await response.json()};};
  const resultStateProof=await verifyMemberResultStateReads({requestId:result.data.requestId,missingId:randomUUID(),owner:aiClient(0),foreign:aiClient(1),probe:probeResult,observe:observeResultReads});
  const feedback={clientRequestId:'helpful-'+input.target.runId,requestId:result.data.requestId,action:'helpful'};
  const feedbacks=await Promise.all(Array.from({length:6},()=>aiClient(0).sendAiFeedback(feedback)));requireCase(new Set(feedbacks.map(x=>x.feedbackId)).size===1,'HELPFUL_IDEMPOTENT');
  let otherDenied=false;try{await aiClient(1).sendAiFeedback(feedback);}catch(e){otherDenied=e.status===403;}requireCase(otherDenied,'HELPFUL_OWNER');
  const feedbackId=feedbacks[0].feedbackId;await verify();const maintenance=clone(await call('prepareFeedbackRetention',{userId:auth[0].userId,requestId:result.data.requestId,feedbackId}));requireCase(exact(maintenance,['globalToken','maintenanceRequest'])&&uuid(maintenance.globalToken)&&uuid(maintenance.maintenanceRequest),'RETENTION_OWN_SCOPE');
  const headers={'x-worker-run-token':maintenance.globalToken,'x-worker-request-id':maintenance.maintenanceRequest};dropPurge=true;const lost=await direct('/functions/v1/service-api/internal/ai-feedback-maintenance',{limit:1},credentials.internalSecret,headers);requireCase(lost.status>=500&&counts.maintenanceRpcCalls===1,'RETENTION_RESPONSE_LOSS');
  const {loadRuntimeConfig}=await import(pathToFileURL(resolve(input.codeRoot,'backend/supabase/functions/_shared/config/env.ts')).href);
  const {createInternalClient}=await import(pathToFileURL(resolve(input.codeRoot,'backend/supabase/functions/_shared/db/internal-client.ts')).href);
  const {createWorkerConnectionPorts}=await import(pathToFileURL(resolve(input.codeRoot,'backend/supabase/functions/_shared/db/worker-runtime-client.ts')).href);
  const ports=createWorkerConnectionPorts(createInternalClient(loadRuntimeConfig(k=>env[k]),localFetch));
  const recovered=await ports.atomic.get(maintenance.maintenanceRequest);requireCase(recovered.state==='completed'&&recovered.result.deletedCount===1&&counts.maintenanceRpcCalls===1,'RETENTION_STORED_READ_RECOVERY');
  const stored=clone(await call('inspectMaintenance',{requestId:maintenance.maintenanceRequest}));requireCase(stored.state==='completed'&&stored.deletedCount===1,'RETENTION_ROOT_METADATA');
  const changed=await direct('/functions/v1/service-api/internal/ai-feedback-maintenance',{limit:2},credentials.internalSecret,headers);requireCase(changed.status===409,'RETENTION_DIFFERENT_INPUT');
  const afterExpired=await direct('/functions/v1/ai-chat/feedback',{...feedback,clientRequestId:'expired-'+input.target.runId});requireCase(afterExpired.status===404,'RETENTION_EXPIRED_REJECTED');
  const beforeExpiredRead=clone(observeResultReads());let expiredRead=false;try{await aiClient(0).getAiResultState(result.data.requestId);}catch(e){expiredRead=e.status===404;}const expiredReadAfter=observeResultReads();requireCase(expiredRead&&expiredReadAfter.reads===beforeExpiredRead.reads+1&&stable(expiredReadAfter.writes)===stable(beforeExpiredRead.writes),'RESULT_STATE_EXPIRED_READ_ONLY');
  // 탈퇴는 원 Auth6 보존을 위한 별도 마지막 scope다. 승인된 현재 DB guard가 없으면 실행하지 않는다.
  await verify();retirement=clone(await call('prepareRetirement',{userId:auth[5].userId}));
  requireCase(['not_enabled','prepared'].includes(retirement.status),'RETIREMENT_PREPARATION');
  let retirementProof={status:'NOT_RUN',reason:'ROOT_RETIREMENT_GUARD_REQUIRED',httpGetOnly:'NOT_RUN'};
  if(retirement.status==='prepared'){
   requireCase(uuid(retirement.withdrawalId)&&retirement.userId===auth[5].userId,'RETIREMENT_SCOPE');
   // 런타임 factory의 기존 명시 검증 옵션만 켜며 DB guard/외부 정리 실행을 변경하지 않는다.
   activeApi=createRuntimeHandler(k=>env[k],{memberRetirement:true,memberCleanup:true});
   const {createWebMemberSessionPort}=await import(pathToFileURL(resolve(input.codeRoot,'apps/mobile/src/web-member-session.ts')).href);
   const signupState='b'.repeat(64),storage=new Map(),originalToken=auth[5].accessToken;let postAttempts=0,getAttempts=0;
   const webFetcher=async(url,init={})=>{
    const u=new URL(url);
    // 합성 로그인 조립만 사용한다. 실제 OAuth/네이버 callback 전송은 0이다.
    if(u.pathname==='/functions/v1/signup/naver/start')return Response.json({data:{authorizationUrl:'https://nid.naver.com/oauth2.0/authorize?state='+signupState+'&redirect_uri='+encodeURIComponent(bridge+'/auth-callback'),expiresAt:new Date(Date.now()+300000).toISOString()}});
    if(u.pathname==='/functions/v1/signup/naver/callback')return Response.json({data:{status:'ready',returnTo:'/account',userId:auth[5].userId,session:{accessToken:originalToken,refreshToken:'synthetic-never-refreshed',expiresIn:Math.floor(auth[5].expiresAt-Date.now()/1000),tokenType:'bearer'}}});
    requireCase(u.pathname==='/functions/v1/service-api/me/retirement'&&new Headers(init.headers).get('authorization')==='Bearer '+originalToken,'RETIREMENT_ORIGINAL_JWT');
    if(init.method==='POST'){postAttempts++;requireCase(postAttempts===1&&u.search===''&&stable(JSON.parse(init.body))===stable({withdrawalId:retirement.withdrawalId}),'RETIREMENT_ONE_POST');const response=await fetcher(url,init);requireCase(response.status===200,'RETIREMENT_FIRST_POST');await response.arrayBuffer();throw Error('MEMBER_CASE_SYNTHETIC_RESPONSE_LOSS');}
    getAttempts++;requireCase(init.method==='GET'&&init.body===undefined&&stable([...u.searchParams.keys()])===stable(['withdrawalId'])&&u.searchParams.get('withdrawalId')===retirement.withdrawalId,'RETIREMENT_GET_ONLY');return fetcher(url,init);
   };
   const browser={crypto:globalThis.crypto,location:{origin:bridge,assign(){}},history:{replaceState(){}},sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}};
   const port=createWebMemberSessionPort({signupUrl:bridge+'/functions/v1/signup',supabaseUrl:bridge,publicApiKey:credentials.anon,callbackUrl:bridge+'/auth-callback',browser,fetcher:webFetcher,retirementContract:'2026-10-09-retirement-receipt'});
   const signal=new AbortController().signal;await port.login('/account',signal);await port.callback(bridge+'/auth-callback?code=synthetic&state='+signupState,signal);
   let lost=false;try{await port.retire(retirement.withdrawalId,signal);}catch{lost=true;}requireCase(lost&&postAttempts===1,'RETIREMENT_POST_LOSS');
   const state=clone(await call('inspectRetirement',{userId:auth[5].userId,withdrawalId:retirement.withdrawalId}));
   const beforeRetry=rpcCounts.retire_my_account??0,retryBody=await port.retire(retirement.withdrawalId,signal);requireCase(['processing','completed'].includes(retryBody.status)&&postAttempts===1&&getAttempts===1&&(rpcCounts.retire_my_account??0)===beforeRetry,'RETIREMENT_GET_NO_WRITE');
   const after=clone(await call('inspectRetirement',{userId:auth[5].userId,withdrawalId:retirement.withdrawalId}));requireCase(state.withdrawalId===after.withdrawalId&&state.originalUserId===auth[5].userId&&after.originalUserId===auth[5].userId&&state.ackSha256===after.ackSha256,'RETIREMENT_ACK_ORIGINAL');
   retirementProof={status:'ROOT_BOUNDARY_CHECKS_ONLY',publicStatus:retryBody.status,originalWithdrawalPreserved:true,originalJwtPreserved:true,httpGetOnly:true,actualAckCompleted:retryBody.status==='completed',retireRpcRepeated:(rpcCounts.retire_my_account??0)>beforeRetry};
  }
  await verify();checkMemberSources(input);
  return {status:'ROOT_ATTESTATION_REQUIRED',scope:'LOCAL_PRODUCT_RUNTIME_TLS_CLIENT_SIGNED_AUTH_DB_WITH_SYNTHETIC_PROVIDER',sourceHead:input.head,bindingSha256:input.bindingSha256,actualNaver:false,actualProvider:false,production:false,ui:false,J07:{successReceipt:true,resultState:{...resultStateProof,expired404:true},concurrentHelpful:6,retentionResponseLossRecovery:true,reportEvidence:'NOT_RUN',otherSuccessKinds:'NOT_RUN'},J08:{actualMessageSetService:true,concurrentReads:6,wrongBatchAtomic:true,newMessageRace:true,hundredMessages:true,realForeignRoomBatch:true,hiddenLeftRevoked:'ROOT_BOUNDARY_CHECKS_ONLY',originalReadAtPreserved:true,invalidJwtNoFallback:true,auth500:'SYNTHETIC_FAULT_ONLY'},J09:retirementProof,counts,actualAuth:'ROOT_ATTESTATION_REQUIRED',actualDb:'ROOT_ATTESTATION_REQUIRED'};
 }finally{
  if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}globalThis.fetch=originalFetch;
  await verify();if(retirement?.status==='prepared')await call('cleanupRetirement',{userId:auth[5].userId,withdrawalId:retirement.withdrawalId});if(opened)await call('cleanupConnections',{memberUserIds:[auth[0].userId,auth[1].userId]});
 }
}

/** task/lease/ACK를 고쳐 만들지 않는다. 모형 책임 시험도 이 동일 순서를 사용한다. */
export async function performCompletedRetirement(fixture,mode,ports,{now=Date.now,monotonic=()=>performance.now(),sleep=ms=>new Promise(ok=>setTimeout(ok,ms))}={}){
 requireCase(['ack_loss','delete_loss'].includes(mode),'COMPLETION_MODE');
 const inspect=async()=>validateCompletedRetirementInspection(await ports.inspect(),fixture);
 const receipt=async status=>{const r=await ports.receipt();requireCase(exact(r,['withdrawalId','status','memberAccessRevoked'])&&r.withdrawalId===fixture.withdrawalId&&r.status===status&&r.memberAccessRevoked===true,'COMPLETION_ORIGINAL_RECEIPT');};
 let postLost=false;try{await ports.retireFirst();}catch{postLost=true;}requireCase(postLost,'COMPLETION_FIRST_POST_LOSS');await receipt('processing');
 const initial=await inspect();requireCase(initial.state==='pending_cleanup'&&initial.tasks.every(t=>t.state==='pending')&&initial.authUserPresent&&initial.storageObjectPresent&&initial.storageBytesPresent&&initial.invocations.length===0&&initial.reconciliations.length===0,'COMPLETION_INITIAL');
 const lease=await ports.open();requireCase(lease&&uuid(lease.token)&&instant(lease.expiresAt),'COMPLETION_WORKER_LEASE');
 const budget=await ports.budget(lease.token);requireCase(exact(budget,['remainingMs'])&&Number.isSafeInteger(budget.remainingMs)&&budget.remainingMs>60000&&budget.remainingMs<=180000,'COMPLETION_WORKER_BUDGET');
 const allocation={requestId:fixture.invocationRequestId,globalToken:lease.token,kind:'member_cleanup',limit:2,remainingMs:budget.remainingMs};
 const prepared=await ports.prepare(allocation);requireCase(exact(prepared,['requestId','state','fresh'])&&prepared.requestId===fixture.invocationRequestId&&prepared.state==='prepared'&&prepared.fresh===true,'COMPLETION_INVOCATION_PREPARED');
 const failed=await ports.cleanup(allocation);requireCase(failed.status>=500,'COMPLETION_INJECTED_FAILURE');
 const unknown=await ports.unknown(fixture.invocationRequestId);requireCase(unknown.requestId===fixture.invocationRequestId&&unknown.state==='unknown','COMPLETION_UNKNOWN');
 const lost=await inspect(),storage=lost.tasks.find(t=>t.kind==='storage_object'),authTask=lost.tasks.find(t=>t.kind==='auth_user');
 requireCase(lost.state==='pending_cleanup'&&storage.state==='completed'&&authTask.state==='running'&&authTask.dispatch!==null&&lost.invocations.length===1&&lost.invocations[0].state==='unknown'&&lost.invocations[0].globalToken===lease.token&&lost.invocations[0].remainingMs===allocation.remainingMs&&lost.reconciliations.length===0&&!lost.authUserPresent&&!lost.storageObjectPresent&&!lost.storageBytesPresent,'COMPLETION_LOSS_NATIVE');
 if(mode==='delete_loss'){
  requireCase(authTask.ack===null&&lost.ackSha256===null,'COMPLETION_NO_ACK');await receipt('processing');
  const again=await inspect();requireCase(stable(again)===stable(lost),'COMPLETION_UNKNOWN_PRESERVED');
  return {status:'ROOT_ATTESTATION_REQUIRED',completionMode:mode,completion:'UNKNOWN_ACK_ABSENT',completed:false,originalJwtPreserved:true,originalWithdrawalPreserved:true,firstPostAttempts:1,repeatedDelete:0,ackRecreated:0};
 }
 requireCase(authTask.ack!==null&&lost.ackSha256===authTask.ack.ackSha256,'COMPLETION_ACK_STORED');
 const started=monotonic();let current=lost;
 while(Date.parse(current.tasks.find(t=>t.kind==='auth_user').leaseExpiresAt)>now()){
  requireCase(monotonic()-started<120000,'COMPLETION_LEASE_WAIT_TIMEOUT');await sleep(1000);current=await inspect();
  requireCase(stable(current)===stable(lost),'COMPLETION_NATURAL_LEASE_MUTATION');
 }
 const released=await ports.close(lease);requireCase(exact(released,['status'])&&['applied','lease_lost'].includes(released.status),'COMPLETION_ORIGINAL_RELEASE');const recovery=await ports.open();requireCase(recovery&&uuid(recovery.token)&&recovery.token!==lease.token&&instant(recovery.expiresAt),'COMPLETION_RECOVERY_LEASE');
 const result=await ports.reconcile({recoveryRequestId:fixture.recoveryRequestId,invocationRequestId:fixture.invocationRequestId,taskId:authTask.taskId},recovery.token);requireCase(result.status===200&&result.data?.status==='applied'&&digest(result.data.evidenceSha256),'COMPLETION_RECONCILE_HTTP');
 const proof=await ports.reconciliation({recoveryRequestId:fixture.recoveryRequestId,invocationRequestId:fixture.invocationRequestId,taskId:authTask.taskId,recoveryGlobalToken:recovery.token});
 requireCase(proof.state==='completed'&&proof.original.ackReceiptId===authTask.ack.receiptId&&proof.original.ackSha256===authTask.ack.ackSha256&&proof.original.globalToken===lease.token&&proof.original.jobLeaseToken===authTask.leaseToken&&proof.evidenceSha256===result.data.evidenceSha256,'COMPLETION_STORED_ORIGIN');
 const discovery=await ports.discover();requireCase(exact(discovery,['items','nextAfterRequestId'])&&stable(discovery.items)===stable([{invocationRequestId:fixture.invocationRequestId}])&&discovery.nextAfterRequestId===fixture.invocationRequestId,'COMPLETION_DISCOVERY_ONLY');
 const finalized=await ports.finalize(fixture.invocationRequestId);requireCase(finalized.status===200&&finalized.data?.status==='completed','COMPLETION_FINALIZE_HTTP');
 const parent=await ports.invocation(fixture.invocationRequestId);requireCase(parent.state==='completed'&&parent.globalToken===lease.token&&parent.kind==='member_cleanup'&&parent.limit===2&&parent.remainingMs===allocation.remainingMs&&parent.result?.counts?.claimed===2&&parent.result?.counts?.succeeded===2,'COMPLETION_PARENT_STORED');
 await receipt('completed');const final=await inspect();requireCase(final.state==='completed'&&final.ackSha256===lost.ackSha256&&final.invocations[0]?.state==='completed'&&final.reconciliations[0]?.state==='completed','COMPLETION_FINAL_NATIVE');
 return {status:'ROOT_ATTESTATION_REQUIRED',completionMode:mode,completion:'COMPLETED_STORED_ACK_GET_ONLY',completed:true,originalJwtPreserved:true,originalWithdrawalPreserved:true,firstPostAttempts:1,repeatedDelete:0,ackRecreated:0,originalAckPreserved:true,discoveryIsExecutionPermission:false};
}

export function validateCompletedBridgeRoute(url,method,fixture){
 requireCase(url.protocol==='https:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&!url.hash,'COMPLETION_BRIDGE_ORIGIN');
 if(url.pathname==='/functions/v1/service-api/me/retirement')requireCase(method==='POST'&&!url.search||method==='GET'&&stable([...url.searchParams.keys()])===stable(['withdrawalId'])&&url.searchParams.get('withdrawalId')===fixture.withdrawalId,'COMPLETION_BRIDGE_RECEIPT');
 else requireCase(method==='POST'&&!url.search&&['/functions/v1/service-api/internal/member-cleanup','/functions/v1/service-api/internal/member-cleanup/reconcile','/functions/v1/service-api/internal/member-cleanup/reconcile/finalize'].includes(url.pathname),'COMPLETION_BRIDGE_ROUTE');
}

export function validateCompletedLossResponse(mode,observed,args){
 requireCase(['ack_loss','delete_loss'].includes(mode),'COMPLETION_MODE');
 if(mode==='delete_loss')requireCase(exact(observed,[]),'COMPLETION_DELETE_RESPONSE');
 else requireCase(exact(observed,['receiptId','taskId','kind','objectId','evidenceSha256'])&&uuid(observed.receiptId)&&observed.taskId===args.p_task_id&&observed.kind==='auth_user'&&observed.objectId===null&&observed.evidenceSha256===args.p_ack_sha256&&digest(observed.evidenceSha256),'COMPLETION_ACK_RESPONSE');
}

async function runCompletedMemberConnections(input,boundary){
 for(const name of ['verifyTarget','readCredentials','readIssuedAuth','readTls','prepareCompletedRetirement','inspectCompletedRetirement','cleanupCompletedRetirement'])requireCase(typeof boundary?.[name]==='function','ROOT_BOUNDARY_REQUIRED');checkMemberSources(input);
 const call=(name,args={})=>{requireCase(exact(args,MEMBER_ARG_KEYS[name]),'FIXED_METHOD_ARGUMENTS');validateReadMethod(name,args);return boundary[name]({runId:input.target.runId,bindingSha256:input.bindingSha256,...args});};
 const verify=async()=>{const v=await call('verifyTarget');requireCase(exact(v,['target','bindingSha256','sourceFiles','migrationFiles'])&&stable(v.target)===stable(input.target)&&v.bindingSha256===input.bindingSha256&&stable(v.sourceFiles)===stable(input.sourceFiles)&&stable(v.migrationFiles)===stable(input.migrationFiles),'ROOT_BINDING_MISMATCH');};
 await verify();const credentials=clone(await call('readCredentials'));requireCase(exact(credentials,['anon','service','internalSecret','ledgerId'])&&Object.values(credentials).every(v=>typeof v==='string'&&v.length>0&&!/[\r\n]/.test(v))&&credentials.anon!==credentials.service,'CREDENTIALS');
 const accounts=clone(await call('readIssuedAuth'));validateIssuedMembers(accounts,input.target);const account=accounts[5],tls=clone(await call('readTls'));requireCase(exact(tls,['key','cert'])&&[tls.key,tls.cert].every(v=>typeof v==='string'&&v.length>0),'TLS_SHAPE');const cert=new X509Certificate(tls.cert);requireCase(cert.checkIP('127.0.0.1')==='127.0.0.1'&&Date.parse(cert.validFrom)<=Date.now()&&Date.parse(cert.validTo)>Date.now(),'TLS');
 let fixture,server,firstPost=0,initialToken=null,recoveryToken=null,lossInjected=false,firstPostLossInjected=false;const originalFetch=globalThis.fetch,leases=new Map(),fences=new Map(),counts={rpc:{},storageDelete:0,authDelete:0,authAck:0,cleanupHttp:0,provider:0};
 const body=init=>{try{return JSON.parse(init.body);}catch{requireCase(false,'COMPLETION_JSON');}};
 const localFetch=async(inputUrl,init={})=>{
  const u=new URL(inputUrl instanceof Request?inputUrl.url:String(inputUrl)),headers=new Headers(init.headers),token=headers.get('authorization')?.replace(/^Bearer /,'');requireCase(u.origin===input.target.origin&&!u.search&&!u.hash&&!u.username&&!u.password,'COMPLETION_ORIGIN');requireCase([...headers.keys()].every(k=>['apikey','authorization','content-type','accept'].includes(k)),'COMPLETION_HEADERS');
  const key=fixture.userId+'/'+fixture.withdrawalId+'.jpg';let name;
  if(u.pathname==='/auth/v1/user')requireCase(init.method==='GET'&&token===account.accessToken&&headers.get('apikey')===credentials.anon,'COMPLETION_AUTH_USER');
  else if(u.pathname.startsWith('/auth/v1/admin/users/')){
   requireCase(u.pathname==='/auth/v1/admin/users/'+fixture.userId&&['GET','DELETE'].includes(init.method)&&token===credentials.service&&headers.get('apikey')===credentials.service,'COMPLETION_AUTH_TARGET');
   if(init.method==='DELETE'){requireCase(exact(body(init),['should_soft_delete'])&&body(init).should_soft_delete===false&&counts.authDelete===0,'COMPLETION_AUTH_DELETE_ONCE');counts.authDelete++;}
  }else if(u.pathname.startsWith('/storage/v1/')){
   requireCase(token===credentials.service&&headers.get('apikey')===credentials.service,'COMPLETION_STORAGE_ROLE');
   if(init.method==='DELETE'){requireCase(u.pathname==='/storage/v1/object/profile-images'&&exact(body(init),['prefixes'])&&stable(body(init).prefixes)===stable([key])&&counts.storageDelete===0,'COMPLETION_STORAGE_DELETE_ONCE');counts.storageDelete++;}
   else requireCase(init.method==='GET'&&['/storage/v1/object/info/authenticated/profile-images/'+key,'/storage/v1/object/authenticated/profile-images/'+key].includes(u.pathname)&&init.body===undefined,'COMPLETION_STORAGE_GET');
  }else{
   name=u.pathname.split('/').at(-1);requireCase(u.pathname==='/rest/v1/rpc/'+name,'COMPLETION_RPC_PATH');
   if(name==='get_my_retirement_receipt'){
    // user RPC는 아래 별도 exact query branch로만 허용한다.
    requireCase(false,'COMPLETION_RECEIPT_QUERY_REQUIRED');
   }
   const args=body(init);requireCase(init.method==='POST','COMPLETION_RPC_METHOD');
   if(name==='retire_my_account')requireCase(token===account.accessToken&&headers.get('apikey')===credentials.anon&&exact(args,['p_withdrawal_id'])&&args.p_withdrawal_id===fixture.withdrawalId&&(counts.rpc[name]??0)===0,'COMPLETION_RETIRE_ONCE');
   else{
    requireCase(token===credentials.service&&headers.get('apikey')===credentials.service,'COMPLETION_RPC_ROLE');
    const original=fixture.invocationRequestId,recovery=fixture.recoveryRequestId;
    if(name==='acquire_worker_run')requireCase(exact(args,['p_lease_seconds','p_existing_token'])&&args.p_lease_seconds===180&&args.p_existing_token===null&&(counts.rpc[name]??0)<(input.completionMode==='ack_loss'?2:1),'COMPLETION_ACQUIRE');
    else if(name==='release_worker_run')requireCase(exact(args,['p_token'])&&leases.has(args.p_token),'COMPLETION_RELEASE');
    else if(name==='read_worker_run_budget')requireCase(exact(args,['p_worker_run_token'])&&leases.has(args.p_worker_run_token),'COMPLETION_BUDGET');
    else if(['prepare_queue_invocation','claim_queue_invocation_dispatch'].includes(name))requireCase(exact(args,['p_request_id','p_global_token','p_kind','p_limit','p_remaining_ms'])&&args.p_request_id===original&&args.p_global_token===initialToken&&args.p_kind==='member_cleanup'&&args.p_limit===2&&Number.isSafeInteger(args.p_remaining_ms)&&args.p_remaining_ms>60000&&args.p_remaining_ms<=180000&&(counts.rpc[name]??0)===0,'COMPLETION_INVOCATION_ONCE');
    else if(['get_queue_invocation','mark_queue_invocation_unknown','complete_queue_invocation'].includes(name))requireCase(exact(args,['p_request_id'])&&args.p_request_id===original&&(name==='get_queue_invocation'||(counts.rpc[name]??0)===0)&&(name!=='complete_queue_invocation'||input.completionMode==='ack_loss'),'COMPLETION_PARENT_SCOPE');
    else if(name==='claim_member_cleanup_task')requireCase(exact(args,['p_worker_run_token'])&&args.p_worker_run_token===initialToken&&(counts.rpc[name]??0)<2,'COMPLETION_TASK_CLAIM');
    else if(['begin_member_cleanup_delete','check_member_cleanup_task','get_member_cleanup_delete_ack','record_member_cleanup_delete_ack','complete_member_cleanup_task'].includes(name)){
     const extras=name==='record_member_cleanup_delete_ack'?['p_ack_sha256']:name==='complete_member_cleanup_task'?['p_evidence_sha256']:[],f=fences.get(args.p_task_id);
     requireCase(exact(args,['p_task_id','p_lease_token','p_worker_run_token','p_object_id',...extras])&&f&&args.p_lease_token===f.leaseToken&&args.p_worker_run_token===f.workerRunToken&&args.p_object_id===f.objectId&&extras.every(k=>digest(args[k])),'COMPLETION_FENCE');
     if(name==='record_member_cleanup_delete_ack'&&f.kind==='auth_user'){requireCase(input.completionMode==='ack_loss'&&counts.authAck===0,'COMPLETION_AUTH_ACK_ONCE');counts.authAck++;}
     if(name==='complete_member_cleanup_task')requireCase(f.kind==='storage_object','COMPLETION_AUTH_DIRECT_COMPLETE_FORBIDDEN');
    }else if(name==='begin_member_cleanup_reconcile')requireCase(input.completionMode==='ack_loss'&&exact(args,['p_recovery_request_id','p_invocation_request_id','p_task_id','p_recovery_global_token'])&&args.p_recovery_request_id===recovery&&args.p_invocation_request_id===original&&fences.get(args.p_task_id)?.kind==='auth_user'&&args.p_recovery_global_token===recoveryToken&&(counts.rpc[name]??0)===0,'COMPLETION_RECOVERY_SCOPE');
    else if(name==='get_member_cleanup_reconcile')requireCase(input.completionMode==='ack_loss'&&exact(args,['p_recovery_request_id'])&&args.p_recovery_request_id===recovery,'COMPLETION_RECOVERY_GET');
    else if(name==='finish_member_cleanup_reconcile')requireCase(input.completionMode==='ack_loss'&&exact(args,['p_recovery_request_id','p_evidence_sha256'])&&args.p_recovery_request_id===recovery&&digest(args.p_evidence_sha256)&&(counts.rpc[name]??0)===0,'COMPLETION_RECOVERY_FINISH');
    else if(name==='read_member_cleanup_unknown_invocations')requireCase(input.completionMode==='ack_loss'&&exact(args,['p_after_request_id','p_limit'])&&args.p_after_request_id===null&&args.p_limit===20&&(counts.rpc[name]??0)===0,'COMPLETION_DISCOVERY');
    else requireCase(false,'COMPLETION_RPC_DENIED');
   }
   counts.rpc[name]=(counts.rpc[name]??0)+1;
  }
  const response=await originalFetch(u,{...init,redirect:'error',credentials:'omit'});
  if(u.pathname==='/auth/v1/user'&&response.ok){const v=await response.clone().json();requireCase(v.id===account.userId&&v.role==='authenticated'&&v.is_anonymous!==true,'COMPLETION_GOTRUE_SUBJECT');}
  if(name==='acquire_worker_run'&&response.ok){const v=await response.clone().json();requireCase(exact(v,['token','expiresAt'])&&uuid(v.token)&&instant(v.expiresAt)&&!leases.has(v.token),'COMPLETION_ISSUED_LEASE');leases.set(v.token,{token:v.token,expiresAt:v.expiresAt});if(initialToken===null)initialToken=v.token;else recoveryToken=v.token;}
  if(name==='release_worker_run'&&response.ok){const v=await response.clone().json();requireCase(exact(v,['status'])&&['applied','lease_lost'].includes(v.status),'COMPLETION_RELEASE_RESULT');leases.delete(body(init).p_token);}
  if(['claim_member_cleanup_task','begin_member_cleanup_reconcile'].includes(name)&&response.ok){const v=await response.clone().json(),t=name==='claim_member_cleanup_task'?v:v?.task;if(t){requireCase(uuid(t.taskId)&&uuid(t.leaseToken)&&instant(t.expiresAt)&&t.profileId===fixture.userId&&(t.kind==='auth_user'&&t.objectId===null&&t.objectName===null&&t.bucketId===null||t.kind==='storage_object'&&t.objectId===fixture.objectId&&t.objectName===key&&t.bucketId==='profile-images'),'COMPLETION_CLAIM_TARGET');fences.set(t.taskId,{...t,workerRunToken:name==='claim_member_cleanup_task'?initialToken:recoveryToken});}}
  if(!lossInjected&&response.status===200&&(input.completionMode==='delete_loss'&&u.pathname==='/auth/v1/admin/users/'+fixture.userId&&init.method==='DELETE'||input.completionMode==='ack_loss'&&name==='record_member_cleanup_delete_ack'&&fences.get(body(init).p_task_id)?.kind==='auth_user')){
   const observed=await response.clone().json();
   validateCompletedLossResponse(input.completionMode,observed,input.completionMode==='ack_loss'?body(init):null);
   await response.arrayBuffer();lossInjected=true;throw Error('MEMBER_CASE_SYNTHETIC_RESPONSE_LOSS');
  }
  return response;
 };
 const routedFetch=async(url,init={})=>{
  const u=new URL(url instanceof Request?url.url:String(url));
  if(u.origin===input.target.origin&&u.pathname==='/rest/v1/rpc/get_my_retirement_receipt'){
   const h=new Headers(init.headers);requireCase(init.method==='GET'&&init.body===undefined&&!u.hash&&!u.username&&!u.password&&[...h.keys()].every(k=>['apikey','authorization','content-type','accept'].includes(k))&&h.get('authorization')==='Bearer '+account.accessToken&&h.get('apikey')===credentials.anon&&stable([...u.searchParams.keys()].sort())===stable(['p_request_fingerprint','p_withdrawal_id'])&&u.searchParams.get('p_withdrawal_id')===fixture.withdrawalId&&digest(u.searchParams.get('p_request_fingerprint')),'COMPLETION_RECEIPT_READ');counts.rpc.get_my_retirement_receipt=(counts.rpc.get_my_retirement_receipt??0)+1;return originalFetch(u,{...init,redirect:'error',credentials:'omit'});
  }return localFetch(url,init);
 };
 try{
  await verify();fixture=validateCompletedRetirementFixture(await call('prepareCompletedRetirement',{userId:account.userId}),account.userId);globalThis.fetch=routedFetch;
  const {createRuntimeHandler}=await import(pathToFileURL(resolve(input.codeRoot,ENTRIES[0])).href),{ServiceApiClient}=await import(pathToFileURL(resolve(input.codeRoot,'apps/mobile/src/api.ts')).href),{loadRuntimeConfig}=await import(pathToFileURL(resolve(input.codeRoot,'backend/supabase/functions/_shared/config/env.ts')).href),{createInternalClient}=await import(pathToFileURL(resolve(input.codeRoot,'backend/supabase/functions/_shared/db/internal-client.ts')).href),{createWorkerInvocationRuntime}=await import(pathToFileURL(resolve(input.codeRoot,'backend/supabase/functions/_shared/db/worker-runtime-client.ts')).href),{createMemberCleanupReconcilePorts}=await import(pathToFileURL(resolve(input.codeRoot,'backend/supabase/functions/_shared/db/repositories/member-cleanup.ts')).href);
  const env={SUPABASE_URL:input.target.origin,SUPABASE_ANON_KEY:credentials.anon,SUPABASE_SERVICE_ROLE_KEY:credentials.service,INTERNAL_WORKER_SECRET:credentials.internalSecret,ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000'},config=loadRuntimeConfig(k=>env[k]),db=createInternalClient(config,routedFetch),runtime=createWorkerInvocationRuntime(db),handler=createRuntimeHandler(k=>env[k],{memberRetirement:true,memberCleanup:true,memberCleanupReconcile:{approved:true,decisionId:'synthetic-owned-completion-only',maxExecutionMs:30000}});
  server=https.createServer({key:tls.key,cert:tls.cert},async(req,res)=>{try{requireCase(req.socket.remoteAddress==='127.0.0.1'||req.socket.remoteAddress==='::ffff:127.0.0.1','BRIDGE_REMOTE');let data='';for await(const chunk of req){data+=chunk;requireCase(Buffer.byteLength(data)<=65536,'BRIDGE_BODY');}const origin='https://127.0.0.1:'+server.address().port,url=new URL(req.url,origin);requireCase(url.origin===origin,'COMPLETION_BRIDGE_ORIGIN');validateCompletedBridgeRoute(url,req.method,fixture);const request=new Request(url,{method:req.method,headers:req.headers,...(data?{body:data}:{})}),response=await handler(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(503,{'content-type':'application/json'});res.end('{"error":{"code":"EXTERNAL_UNAVAILABLE"}}');}});
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});const bridge='https://127.0.0.1:'+server.address().port;
  const fetcher=(url,init={})=>new Promise((ok,no)=>{const u=new URL(url);requireCase(u.origin===bridge&&!u.username&&!u.password&&!u.hash,'CLIENT_ORIGIN');const r=https.request(u,{method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers)),ca:tls.cert,rejectUnauthorized:true,signal:init.signal},res=>{const chunks=[];let size=0;res.on('data',c=>{size+=c.length;if(size>2*1024*1024)r.destroy();else chunks.push(c);});res.on('end',()=>ok(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));res.on('error',()=>no(Error('MEMBER_CASE_CLIENT_RESPONSE')));});r.setTimeout(10000,()=>r.destroy());r.on('error',()=>no(Error('MEMBER_CASE_CLIENT_TRANSPORT')));r.end(init.body);});
  const sdk=new ServiceApiClient(bridge+'/functions/v1/service-api',async()=>account.accessToken,fetcher),post=async(path,args,headers={})=>{const response=await fetcher(bridge+'/functions/v1/service-api/internal/member-cleanup'+path,{method:'POST',headers:{authorization:'Bearer '+credentials.internalSecret,'content-type':'application/json',...headers},body:JSON.stringify(args)});return{status:response.status,data:(await response.json()).data};};
  const ports={inspect:async()=>{await verify();return call('inspectCompletedRetirement',{userId:account.userId,withdrawalId:fixture.withdrawalId});},
   retireFirst:async()=>{requireCase(++firstPost===1,'COMPLETION_FIRST_POST_ONCE');const response=await fetcher(bridge+'/functions/v1/service-api/me/retirement',{method:'POST',headers:{authorization:'Bearer '+account.accessToken,'content-type':'application/json'},body:JSON.stringify({withdrawalId:fixture.withdrawalId})});requireCase(response.status===200,'COMPLETION_FIRST_POST_STATUS');await response.arrayBuffer();firstPostLossInjected=true;throw Error('MEMBER_CASE_SYNTHETIC_RESPONSE_LOSS');},
   receipt:()=>sdk.request('/me/retirement?withdrawalId='+fixture.withdrawalId),open:()=>db.rpc('acquire_worker_run',{p_lease_seconds:180,p_existing_token:null}),close:lease=>db.rpc('release_worker_run',{p_token:lease.token}),budget:token=>db.rpc('read_worker_run_budget',{p_worker_run_token:token}),prepare:i=>runtime.prepareQueueInvocation(i),
   cleanup:allocation=>{requireCase(++counts.cleanupHttp===1,'COMPLETION_CLEANUP_HTTP_ONCE');return post('',{}, {'x-worker-run-token':allocation.globalToken,'x-worker-request-id':allocation.requestId,'x-worker-max-jobs':'2','x-worker-time-budget-ms':String(allocation.remainingMs)});},unknown:id=>runtime.markQueueInvocationUnknown(id),
   reconcile:(args,token)=>post('/reconcile',args,{'x-worker-run-token':token}),reconciliation:binding=>createMemberCleanupReconcilePorts(config,binding,routedFetch).get(),discover:()=>db.rpc('read_member_cleanup_unknown_invocations',{p_after_request_id:null,p_limit:20}),finalize:id=>post('/reconcile/finalize',{invocationRequestId:id}),invocation:id=>runtime.getQueueInvocation(id)};
  const proof=await performCompletedRetirement(fixture,input.completionMode,ports);requireCase(lossInjected&&firstPostLossInjected&&firstPost===1&&(counts.rpc.retire_my_account??0)===1&&counts.authDelete===1&&counts.storageDelete===1&&counts.authAck===(input.completionMode==='ack_loss'?1:0)&&(counts.rpc.prepare_queue_invocation??0)===1&&(counts.rpc.claim_queue_invocation_dispatch??0)===1&&(counts.rpc.claim_member_cleanup_task??0)===2&&(counts.rpc.begin_member_cleanup_delete??0)===2&&(counts.rpc.complete_member_cleanup_task??0)===1&&(counts.rpc.record_member_cleanup_delete_ack??0)===(input.completionMode==='ack_loss'?2:1),'COMPLETION_TRANSPORT_ONCE');await verify();checkMemberSources(input);
  return{status:'ROOT_ATTESTATION_REQUIRED',scope:'LOCAL_COMPLETED_RETIREMENT_WITH_ORIGINAL_AUTH_AND_SYNTHETIC_RESPONSE_LOSS',sourceHead:input.head,bindingSha256:input.bindingSha256,J09:proof,counts,actualNaver:false,actualProvider:false,production:false,ui:false,actualAuth:'ROOT_ATTESTATION_REQUIRED',actualDb:'ROOT_ATTESTATION_REQUIRED',actualStorage:'ROOT_ATTESTATION_REQUIRED'};
 }finally{
  if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}globalThis.fetch=originalFetch;
  // 정확히 이 실행이 발급받은 token만 release한다. UNKNOWN task/ACK/lease를 SQL로 지우지 않는다.
  const failures=[];for(const lease of [...leases.values()])try{const r=await localFetch(input.target.origin+'/rest/v1/rpc/release_worker_run',{method:'POST',headers:{authorization:'Bearer '+credentials.service,apikey:credentials.service,'content-type':'application/json'},body:JSON.stringify({p_token:lease.token})});requireCase(r.ok,'COMPLETION_RELEASE');}catch{failures.push('MEMBER_CASE_COMPLETION_RELEASE_UNVERIFIED');}
  await verify();if(fixture)await call('cleanupCompletedRetirement',{userId:account.userId,withdrawalId:fixture.withdrawalId});if(failures.length)throw Error(failures[0]);
 }
}

/** Root 부모의 고정 bridge만 호출한다. args에 SQL·credential·승인 boolean을 추가하지 않는다. */
export function createMemberPipeBoundary(requestId,send,read,version=1){requireCase([1,2].includes(version),'PIPE_VERSION');let sequence=0;const ports=Object.fromEntries((version===2?COMPLETED_MEMBER_METHODS:MEMBER_METHODS).map(method=>[method,async args=>{requireCase(exact(args,['runId','bindingSha256',...MEMBER_ARG_KEYS[method]])&&args.runId===requestId&&digest(args.bindingSha256),'FIXED_METHOD_ARGUMENTS');validateReadMethod(method,args);const seq=++sequence;await send({type:'call',requestId,sequence:seq,method,args});const reply=await read();requireCase(exact(reply,['requestId','sequence','ok','value'])&&reply.requestId===requestId&&reply.sequence===seq&&reply.ok===true,'ROOT_PIPE_REPLY');return reply.value;} ]));Object.defineProperty(ports,'sequence',{get:()=>sequence});return Object.freeze(ports);}
if(process.argv[1]&&resolve(process.argv[1])===HERE){
 if(process.argv.length===2)process.stdout.write(JSON.stringify({status:'NOT_RUN',ready:false,networkCalls:0,credentialReads:0,reason:'ROOT_TYPED_BOUNDARY_REQUIRED'})+'\n');
 else if(process.argv.length===3&&process.argv[2]==='--root-stdio'){
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();const read=async()=>{const next=await lines.next();requireCase(!next.done&&Buffer.byteLength(next.value)<=2*1024*1024,'PIPE_FRAME');return JSON.parse(next.value);};
  let requestId;try{const initial=await read();requireCase(exact(initial,['requestId','input'])&&uuid(initial.requestId)&&initial.input?.target?.runId===initial.requestId,'PIPE_INITIAL');requestId=initial.requestId;const boundary=createMemberPipeBoundary(requestId,v=>process.stdout.write(JSON.stringify(v)+'\n'),read,initial.input.version);const proof=await runMemberConnections(initial.input,boundary);process.stdout.write(JSON.stringify({type:'result',requestId,sequence:boundary.sequence,proof})+'\n');}catch{process.stdout.write(JSON.stringify({type:'result',requestId:requestId??null,proof:{status:'BLOCKED',ready:false,reason:'MEMBER_CASE_ROOT_EXECUTION_NOT_VERIFIED'}})+'\n');process.exitCode=2;}
 }else{process.stdout.write(JSON.stringify({status:'BLOCKED',execution:'NOT_RUN',ready:false,reason:'ROOT_TYPED_BOUNDARY_REQUIRED'})+'\n');process.exitCode=2;}
}
