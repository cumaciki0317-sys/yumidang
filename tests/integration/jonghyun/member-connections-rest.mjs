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
export const MEMBER_ARG_KEYS=Object.freeze({verifyTarget:[],readCredentials:[],readIssuedAuth:[],readTls:[],prepareConversation:['memberUserIds'],inspectConversation:['requestId'],inspectAiFeedback:['userId','requestId'],prepareFeedbackRetention:['userId','requestId','feedbackId'],inspectMaintenance:['requestId'],cleanupConnections:['memberUserIds'],prepareRetirement:['userId'],inspectRetirement:['userId','withdrawalId'],cleanupRetirement:['userId','withdrawalId']});
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
 requireCase(exact(input,['version','scenario','repositoryRoot','codeRoot','head','sourceFiles','migrationFiles','target','bindingSha256']),'INPUT_SHAPE');
 requireCase(input.version===1&&input.scenario==='MEMBER_CONNECTIONS_J07_J08_J09'&&typeof input.head==='string'&&/^[a-f0-9]{40}$/.test(input.head)&&digest(input.bindingSha256),'INPUT_IDENTITY');
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
export const MEMBER_METHODS=Object.freeze(['verifyTarget','readCredentials','readIssuedAuth','readTls','prepareConversation','inspectConversation','inspectAiFeedback','prepareFeedbackRetention','inspectMaintenance','cleanupConnections','prepareRetirement','inspectRetirement','cleanupRetirement']);
/** 부모는 모든 method를 exact runId/원 Auth6와 결합하고 고정 SQL만 실행한다. 임의 SQL argument는 없다. */
export async function runMemberConnections(input,boundary){
 input=clone(input);validateMemberInput(input);requireCase(input.target!==null,'EXACT_TARGET_REQUIRED');
 for(const name of MEMBER_METHODS)requireCase(typeof boundary?.[name]==='function','ROOT_BOUNDARY_REQUIRED');
 checkMemberSources(input);
 const call=(name,args={})=>{requireCase(exact(args,MEMBER_ARG_KEYS[name]),'FIXED_METHOD_ARGUMENTS');return boundary[name]({runId:input.target.runId,bindingSha256:input.bindingSha256,...args});};
 const verify=async()=>{const v=await call('verifyTarget');requireCase(exact(v,['target','bindingSha256','sourceFiles','migrationFiles'])&&stable(v.target)===stable(input.target)&&v.bindingSha256===input.bindingSha256&&stable(v.sourceFiles)===stable(input.sourceFiles)&&stable(v.migrationFiles)===stable(input.migrationFiles),'ROOT_BINDING_MISMATCH');};
 await verify();const credentials=clone(await call('readCredentials'));requireCase(exact(credentials,['anon','service','internalSecret','ledgerId'])&&Object.values(credentials).every(x=>typeof x==='string'&&x.length>0&&!/[\r\n]/.test(x))&&credentials.anon!==credentials.service,'CREDENTIALS');
 const auth=clone(await call('readIssuedAuth'));validateIssuedMembers(auth,input.target);const tokens=new Set(auth.map(a=>a.accessToken));
 const tls=clone(await call('readTls'));requireCase(exact(tls,['key','cert'])&&[tls.key,tls.cert].every(x=>typeof x==='string'&&x.length>0),'TLS_SHAPE');const cert=new X509Certificate(tls.cert);requireCase(cert.checkIP('127.0.0.1')==='127.0.0.1'&&Date.parse(cert.validFrom)<=Date.now()&&Date.parse(cert.validTo)>Date.now(),'TLS');
 const rpcAllowed=new Set(['get_conversation_with_read_state','mark_conversation_messages_read','send_conversation_message','get_my_profile_traits','acquire_ai_chat_request','finish_ai_chat_request','record_ai_chat_result_available','get_ai_feedback_readiness','submit_ai_feedback','purge_ai_feedback_scoped','get_worker_runtime_operation','retire_my_account','get_my_retirement_receipt']);
 const originalFetch=globalThis.fetch,counts={auth:0,rpc:0,providerSynthetic:0,external:0,maintenanceRpcCalls:0},rpcCounts={};let server,fixture,retirement,opened=false,dropPurge=false;
 const localFetch=async(url,init={})=>{
  const u=new URL(url instanceof Request?url.url:String(url));requireCase(u.origin===input.target.origin&&!u.hash&&!u.username&&!u.password,'BACKEND_ORIGIN');const headers=new Headers(init.headers),token=headers.get('authorization')?.replace(/^Bearer /,'');
  requireCase([...headers.keys()].every(k=>['apikey','authorization','content-type','accept'].includes(k)),'BACKEND_HEADERS');
  if(u.pathname==='/auth/v1/user'){requireCase(!u.search&&init.method==='GET'&&headers.get('apikey')===credentials.anon&&(tokens.has(token)||token==='invalid.invalid.invalid'),'AUTH_FETCH');counts.auth++;}
  else{const name=u.pathname.split('/').at(-1);requireCase(u.pathname==='/rest/v1/rpc/'+name&&rpcAllowed.has(name)&&(tokens.has(token)||token===credentials.anon||token===credentials.service),'RPC_FETCH');
   if(name==='get_my_retirement_receipt')requireCase(init.method==='GET'&&init.body===undefined&&tokens.has(token)&&headers.get('apikey')===credentials.anon&&stable([...u.searchParams.keys()].sort())===stable(['p_request_fingerprint','p_withdrawal_id'])&&uuid(u.searchParams.get('p_withdrawal_id'))&&digest(u.searchParams.get('p_request_fingerprint')),'RECEIPT_READ_ONLY');
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
  server=https.createServer({key:tls.key,cert:tls.cert},async(req,res)=>{try{requireCase(['GET','POST'].includes(req.method),'BRIDGE_METHOD');requireCase(req.socket.remoteAddress==='127.0.0.1'||req.socket.remoteAddress==='::ffff:127.0.0.1','BRIDGE_REMOTE');let body='';for await(const chunk of req){body+=chunk;requireCase(Buffer.byteLength(body)<=65536,'BRIDGE_BODY');}const origin='https://127.0.0.1:'+server.address().port,url=new URL(req.url,origin);requireCase(url.origin===origin&&!url.username&&!url.password&&!url.hash,'BRIDGE_ORIGIN');requireCase(url.pathname==='/functions/v1/ai-chat'||url.pathname==='/functions/v1/ai-chat/feedback'||url.pathname==='/functions/v1/service-api/internal/ai-feedback-maintenance'||url.pathname==='/functions/v1/service-api/me/retirement'||/^\/functions\/v1\/service-api\/conversations\/[a-f0-9-]{36}(?:\/messages|\/read\/messages)?$/.test(url.pathname),'BRIDGE_ROUTE');const request=new Request(url,{method:req.method,headers:req.headers,...(body?{body}: {})});const response=await(url.pathname.startsWith('/functions/v1/ai-chat')?chat(request):activeApi(request));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(503,{'content-type':'application/json'});res.end('{"data":null,"error":{"code":"EXTERNAL_UNAVAILABLE"}}');}});
  await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});const bridge='https://127.0.0.1:'+server.address().port;
  const fetcher=(url,init={})=>new Promise((ok,no)=>{const u=new URL(url);requireCase(u.origin===bridge&&!u.username&&!u.password,'CLIENT_ORIGIN');const request=https.request(u,{method:init.method??'GET',headers:Object.fromEntries(new Headers(init.headers)),ca:tls.cert,rejectUnauthorized:true,signal:init.signal},res=>{const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>2*1024*1024)request.destroy();else chunks.push(chunk);});res.on('end',()=>ok(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));res.on('error',()=>no(Error('MEMBER_CASE_CLIENT_RESPONSE')));});request.setTimeout(10000,()=>request.destroy());request.on('error',()=>no(Error('MEMBER_CASE_CLIENT_TRANSPORT')));request.end(init.body);});
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
  const result=await direct('/functions/v1/ai-chat',{clientRequestId:'member-'+input.target.runId,messages:[{role:'user',content:'동행 찾기'}],currentFilters:{target:'posts'}});requireCase(result.status===200&&result.data.status==='needs_clarification'&&uuid(result.data.requestId),'AI_SUCCESS_RECEIPT');
  const receipt=clone(await call('inspectAiFeedback',{userId:auth[0].userId,requestId:result.data.requestId}));requireCase(receipt.resultReceiptCount===1,'AI_RECEIPT_ONCE');
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
  return {status:'ROOT_ATTESTATION_REQUIRED',scope:'LOCAL_PRODUCT_RUNTIME_TLS_CLIENT_SIGNED_AUTH_DB_WITH_SYNTHETIC_PROVIDER',sourceHead:input.head,bindingSha256:input.bindingSha256,actualNaver:false,actualProvider:false,production:false,ui:false,J07:{successReceipt:true,concurrentHelpful:6,retentionResponseLossRecovery:true,reportEvidence:'NOT_RUN',otherSuccessKinds:'NOT_RUN'},J08:{actualMessageSetService:true,concurrentReads:6,wrongBatchAtomic:true,newMessageRace:true,hiddenLeftRevoked:'NOT_RUN'},J09:retirementProof,counts,actualAuth:'ROOT_ATTESTATION_REQUIRED',actualDb:'ROOT_ATTESTATION_REQUIRED'};
 }finally{
  if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}globalThis.fetch=originalFetch;
  await verify();if(retirement?.status==='prepared')await call('cleanupRetirement',{userId:auth[5].userId,withdrawalId:retirement.withdrawalId});if(opened)await call('cleanupConnections',{memberUserIds:[auth[0].userId,auth[1].userId]});
 }
}

/** Root 부모의 고정 bridge만 호출한다. args에 SQL·credential·승인 boolean을 추가하지 않는다. */
export function createMemberPipeBoundary(requestId,send,read){let sequence=0;const ports=Object.fromEntries(MEMBER_METHODS.map(method=>[method,async args=>{requireCase(exact(args,['runId','bindingSha256',...MEMBER_ARG_KEYS[method]])&&args.runId===requestId&&digest(args.bindingSha256),'FIXED_METHOD_ARGUMENTS');const seq=++sequence;await send({type:'call',requestId,sequence:seq,method,args});const reply=await read();requireCase(exact(reply,['requestId','sequence','ok','value'])&&reply.requestId===requestId&&reply.sequence===seq&&reply.ok===true,'ROOT_PIPE_REPLY');return reply.value;} ]));Object.defineProperty(ports,'sequence',{get:()=>sequence});return Object.freeze(ports);}
if(process.argv[1]&&resolve(process.argv[1])===HERE){
 if(process.argv.length===2)process.stdout.write(JSON.stringify({status:'NOT_RUN',ready:false,networkCalls:0,credentialReads:0,reason:'ROOT_TYPED_BOUNDARY_REQUIRED'})+'\n');
 else if(process.argv.length===3&&process.argv[2]==='--root-stdio'){
  const lines=createInterface({input:process.stdin,crlfDelay:Infinity})[Symbol.asyncIterator]();const read=async()=>{const next=await lines.next();requireCase(!next.done&&Buffer.byteLength(next.value)<=2*1024*1024,'PIPE_FRAME');return JSON.parse(next.value);};
  let requestId;try{const initial=await read();requireCase(exact(initial,['requestId','input'])&&uuid(initial.requestId)&&initial.input?.target?.runId===initial.requestId,'PIPE_INITIAL');requestId=initial.requestId;const boundary=createMemberPipeBoundary(requestId,v=>process.stdout.write(JSON.stringify(v)+'\n'),read);const proof=await runMemberConnections(initial.input,boundary);process.stdout.write(JSON.stringify({type:'result',requestId,sequence:boundary.sequence,proof})+'\n');}catch{process.stdout.write(JSON.stringify({type:'result',requestId:requestId??null,proof:{status:'BLOCKED',ready:false,reason:'MEMBER_CASE_ROOT_EXECUTION_NOT_VERIFIED'}})+'\n');process.exitCode=2;}
 }else{process.stdout.write(JSON.stringify({status:'BLOCKED',execution:'NOT_RUN',ready:false,reason:'ROOT_TYPED_BOUNDARY_REQUIRED'})+'\n');process.exitCode=2;}
}
