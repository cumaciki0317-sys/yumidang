/** 기본 Auth는 합성 bridge. 서명 모드는 실제 로컬 Auth/REST와 합성 모델을 쓴다. AI24는 실행 전 NOT_RUN. */
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const file=process.argv[2],mode=process.argv[3],info=lstatSync(file),directory=lstatSync(dirname(file));
assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.uid===process.getuid!()&&(info.mode&0o777)===0o600);
assert.ok(directory.isDirectory()&&!directory.isSymbolicLink()&&directory.uid===process.getuid!()&&(directory.mode&0o777)===0o700);
const fixtureFd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);let fixtureBytes:Buffer;
try{
 const opened=fstatSync(fixtureFd);
 assert.ok(opened.isFile()&&opened.nlink===1&&opened.uid===process.getuid!()&&(opened.mode&0o777)===0o600&&opened.size<=2*1024*1024);
 assert.equal(opened.dev,info.dev);assert.equal(opened.ino,info.ino);
 fixtureBytes=readFileSync(fixtureFd);const after=fstatSync(fixtureFd),current=lstatSync(file);
 assert.equal(fixtureBytes.length,opened.size);assert.equal(after.size,opened.size);
 assert.equal(after.mtimeMs,opened.mtimeMs);assert.equal(after.ctimeMs,opened.ctimeMs);
 assert.equal(current.dev,opened.dev);assert.equal(current.ino,opened.ino);
}finally{closeSync(fixtureFd);}
const fixture=JSON.parse(fixtureBytes!.toString('utf8')),origin=new URL(fixture.origin);
assert.equal(origin.hostname,'127.0.0.1');assert.equal(origin.protocol,'http:');assert.equal(origin.origin,fixture.origin);
assert.ok(['--ai-limits','--ai-caps','--signed-auth-negative','--signed-auth-lifecycle-case','--ai-midnight'].includes(mode));
if(mode==='--ai-midnight')assert.equal(fixture.signedLocalAuth,true);
assert.ok(fixture.productManifest&&Object.keys(fixture.productManifest).length>0);
for(const [relative,expected]of Object.entries(fixture.productManifest)){
 assert.ok(relative.startsWith('backend/supabase/functions/')&&!relative.includes('..'));
 assert.equal(createHash('sha256').update(readFileSync(fixture.codeRoot+'/'+relative)).digest('hex'),expected,'product graph changed');
}
const signedNative=globalThis.fetch;
if(fixture.signedLocalAuth===true)globalThis.fetch=async(input:any,init:RequestInit={})=>{
 const url=new URL(input instanceof Request?input.url:String(input));
 assert.equal(url.origin,fixture.origin);assert.ok(!url.username&&!url.password&&!url.search&&!url.hash);
 assert.ok(url.pathname==='/auth/v1/user'||url.pathname.startsWith('/rest/v1/rpc/'));
 assert.ok(init.method!=='DELETE');return signedNative(input,{...init,redirect:'error'});
};
try { process.stdout.write(JSON.stringify(await (mode==='--signed-auth-lifecycle-case'?signedAuthLifecycleCase(fixture):mode==='--signed-auth-negative'?signedAuthNegative(fixture):mode==='--ai-midnight'?aiMidnightHttpCase(fixture):mode==='--ai-limits'?aiLimitsHttpCase(fixture):aiCapsHttpCase(fixture)))); }
catch(error){const code=error instanceof Error&&/^AI_CHECK_[A-Z_]+$/.test(error.message)?error.message:'AI_ISOLATED_FACTORY_FAILED';process.stderr.write(code+'\n');process.exitCode=1;}
finally{if(fixture.signedLocalAuth===true)globalThis.fetch=signedNative;}

async function signedAuthNegative(f:any){
 assert.equal(f.signedLocalAuth,true);
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const native=globalThis.fetch;let authReads=0,rpcCalls=0,nativeExternalAttempts=0;
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000'};
 const transport=async(input:any,init:RequestInit={})=>{
  const url=new URL(String(input));
  if(url.origin!==f.origin){nativeExternalAttempts++;throw new Error('AI_CHECK_NEGATIVE_EXTERNAL');}
  if(url.pathname!=='/auth/v1/user'){rpcCalls++;throw new Error('AI_CHECK_NEGATIVE_RPC');}
  assert.equal(init.method,'GET');authReads++;return native(input,init);
 };
 const token=f.accounts[0].token,parts=token.split('.');assert.equal(parts.length,3);
 parts[2]=(parts[2][0]==='a'?'b':'a')+parts[2].slice(1);
 const cases:any[]=[];
 for(const [name,bearer,expectedReads]of [['missing',null,0],['malformed','invalid-token',0],['invalid_signature',parts.join('.'),1],['service_principal',f.service,0]]as const){
  const before=authReads,headers:Record<string,string>={'content-type':'application/json'};
  if(bearer!==null)headers.authorization='Bearer '+bearer;
  const handler=createAiChatRuntime((key:string)=>env[key],transport);
  const response=await handler(new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers,
   body:JSON.stringify({clientRequestId:randomUUID(),messages:[{role:'user',content:'합성 인증 거절 검사'}]})}));
  const body=await response.json();assert.equal(response.status,401);assert.equal(body.error.code,'AUTH_REQUIRED');
  assert.equal(authReads-before,expectedReads);assert.equal(rpcCalls,0);
  cases.push({case:name,status:'PASS',httpStatus:401,actualAuthReads:expectedReads,rpcCalls:0,providerCalls:0});
 }
 return {status:'PASS',cases,nativeExternalAttempts,expiredBearer:'NOT_RUN',revokedSession:'NOT_RUN',anonymousBearer:'NOT_RUN',memberChanged:'NOT_RUN',differentOriginalContext:'NOT_RUN'};
}

/** 실제 원 토큰 거절 1회. 토큰 발급·logout·ban·수명주기 증명은 고정 Python 포트가 담당한다. */
async function signedAuthLifecycleCase(f:any){
 assert.equal(f.signedLocalAuth,true);assert.equal(f.authLifecycleScenario,true);
 assert.ok(['expiredBearer','revokedSession','anonymousBearer','memberChanged','differentOriginalContext'].includes(f.lifecycleCase));
 assert.equal(typeof f.originalToken,'string');assert.match(f.originalUserId,/^[a-f0-9-]{36}$/);
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const native=globalThis.fetch;let authReads=0,rpcCalls=0,providerCalls=0,nativeExternalAttempts=0,authStatus:number|undefined;
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000',
  AI_RETENTION_DECISION_ID:'synthetic-fixture-only',AI_COST_EVIDENCE_ID:'synthetic-fixture-only',AI_PROCESSING_LEGAL_DECISION_ID:'synthetic-fixture-only',AI_MEMBER_TRANSMISSION_APPROVAL_ID:'synthetic-fixture-only',AI_BUDGET_LEDGER_ID:f.aiLedgerId,
  POTENS_ACCOUNT_ORDER:'yumi,jonghyun,minkyu,sungho',POTENS_API_KEY_YUMI:'synthetic-ai-yumi',POTENS_API_KEY_JONGHYUN:'synthetic-ai-jonghyun',POTENS_API_KEY_MINKYU:'synthetic-ai-minkyu',POTENS_API_KEY_SUNGHO:'synthetic-ai-sungho',
  POTENS_ACCOUNT_TOKEN_BUDGET:'3200000',POTENS_RESET_TIMEZONE:'Asia/Seoul',POTENS_MODEL:'claude-5-sonnet',POTENS_API_BASE_URL:'https://ai.potens.ai',POTENS_USAGE_INPUT_FIELD:'fixture_input',POTENS_USAGE_OUTPUT_FIELD:'fixture_output',
  AI_CHAT_MAX_MESSAGES:'20',AI_CHAT_MAX_MESSAGE_CHARS:'500',AI_CHAT_MAX_TOTAL_CHARS:'4000',AI_CHAT_MAX_OUTPUT_TOKENS:'800',AI_CHAT_SEARCH_PAGE_SIZE:'10',AI_CHAT_MAX_SEARCH_PAGES:'3',AI_CHAT_RECHECK_MAX_PAGES:'3',AI_CHAT_MAX_RESULT_CARDS:'5',AI_CHAT_MATCH_BATCH_SIZE:'5',AI_CHAT_MAX_MATCH_CALLS:'3',AI_CHAT_MAX_MATCH_MAX_OUTPUT_TOKENS:'600',AI_CHAT_MATCH_MAX_OUTPUT_TOKENS:'600'};
 const transport=async(input:any,init:RequestInit={})=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.origin!==f.origin){providerCalls++;nativeExternalAttempts++;throw new Error('AI_CHECK_LIFECYCLE_EXTERNAL');}
  if(url.pathname!=='/auth/v1/user'){rpcCalls++;throw new Error('AI_CHECK_LIFECYCLE_RPC');}
  assert.equal(init.method,'GET');assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+f.originalToken);
  assert.equal(new Headers(init.headers).get('apikey'),f.anon);authReads++;
  const response=await native(input,{...init,redirect:'error'});authStatus=response.status;
  if(f.lifecycleCase==='anonymousBearer'){
   const user=await response.clone().json();assert.equal(response.status,200);assert.equal(user.id,f.originalUserId);assert.equal(user.is_anonymous,true);
  }else assert.ok([401,403].includes(response.status));
  return response;
 };
 const handler=createAiChatRuntime((key:string)=>env[key],transport,{privacy:{decisionId:'synthetic-local-only',check:async()=>true},outputLimit:{decisionId:'synthetic-wire-only',apply:(body:any,limit:number)=>({...body,synthetic_max_output_tokens:limit})}});
 const response=await handler(new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+f.originalToken},
  body:JSON.stringify({clientRequestId:randomUUID(),messages:[{role:'user',content:'합성 인증 수명주기 검사'}],currentFilters:{target:'posts'}})}));
 const result=await response.json();assert.equal(response.status,401);assert.equal(result.error.code,'AUTH_REQUIRED');
 assert.equal(authReads,1);assert.equal(rpcCalls,0);assert.equal(providerCalls,0);assert.equal(nativeExternalAttempts,0);
 return {status:'PASS',case:f.lifecycleCase,httpStatus:401,authHttpStatus:authStatus,actualAuthReads:1,rpcCalls:0,providerCalls:0,nativeExternalAttempts:0,
  originalTokenSha256:createHash('sha256').update(f.originalToken).digest('hex'),actualNaver:'NOT_RUN',externalProvider:'NOT_RUN'};
}

async function aiMidnightHttpCase(f:any){
 const check=(value:unknown,code:string)=>{if(!value)throw new Error('AI_CHECK_'+code);};
 check(f.scenario==='ai-chat'&&f.aiMidnightScenario===true&&f.accounts.length===3,'MIDNIGHT_SCOPE');
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const native=globalThis.fetch,hash=(v:string)=>createHash('sha256').update(v).digest('hex');
 const observations:any[]=[];let nativeExternalAttempts=0;
 const localOnly=async(url:any,init:RequestInit={})=>{
  const u=new URL(String(url));if(u.origin!==f.origin){nativeExternalAttempts++;throw new Error('AI_EXTERNAL_NATIVE_FORBIDDEN');}
  check(u.pathname==='/auth/v1/user'||u.pathname.startsWith('/rest/v1/rpc/'),'MIDNIGHT_LOCAL_PATH');
  check(init.method!=='DELETE','MIDNIGHT_DELETE_ZERO');return native(url,init);
 };
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000',
  AI_RETENTION_DECISION_ID:'synthetic-fixture-only',AI_COST_EVIDENCE_ID:'synthetic-fixture-only',AI_PROCESSING_LEGAL_DECISION_ID:'synthetic-fixture-only',AI_MEMBER_TRANSMISSION_APPROVAL_ID:'synthetic-fixture-only',AI_BUDGET_LEDGER_ID:f.aiLedgerId,
  POTENS_ACCOUNT_ORDER:'yumi,jonghyun,minkyu,sungho',POTENS_API_KEY_YUMI:'synthetic-ai-yumi',POTENS_API_KEY_JONGHYUN:'synthetic-ai-jonghyun',POTENS_API_KEY_MINKYU:'synthetic-ai-minkyu',POTENS_API_KEY_SUNGHO:'synthetic-ai-sungho',
  POTENS_ACCOUNT_TOKEN_BUDGET:'3200000',POTENS_RESET_TIMEZONE:'Asia/Seoul',POTENS_MODEL:'claude-5-sonnet',POTENS_API_BASE_URL:'https://ai.potens.ai',POTENS_USAGE_INPUT_FIELD:'fixture_input',POTENS_USAGE_OUTPUT_FIELD:'fixture_output',
  AI_CHAT_MAX_MESSAGES:'20',AI_CHAT_MAX_MESSAGE_CHARS:'500',AI_CHAT_MAX_TOTAL_CHARS:'4000',AI_CHAT_MAX_OUTPUT_TOKENS:'800',AI_CHAT_SEARCH_PAGE_SIZE:'10',AI_CHAT_MAX_SEARCH_PAGES:'3',AI_CHAT_RECHECK_MAX_PAGES:'3',AI_CHAT_MAX_RESULT_CARDS:'5',AI_CHAT_MATCH_BATCH_SIZE:'5',AI_CHAT_MAX_MATCH_CALLS:'3',AI_CHAT_MAX_MATCH_MAX_OUTPUT_TOKENS:'600',AI_CHAT_MATCH_MAX_OUTPUT_TOKENS:'600'};

 const invoke=async(account:number,label:string,hold=false)=>{
  let holdFailed=false;
  const token=f.accounts[account].token,uid=f.accounts[account].userId;
  const o:any={case:label,account,requests:[],reservations:[],counts:{},providerInterceptions:0};observations.push(o);
  const transport=async(url:any,init:RequestInit={})=>{
   if(String(url)==='https://ai.potens.ai/api/chat'){
    check(init.method==='POST'&&o.reservations.length===1,'MIDNIGHT_PROVIDER_AFTER_RESERVE');
    const reservation=o.reservations[0],wire=JSON.parse(String(init.body));
    check(!reservation.dispatched&&new Headers(init.headers).get('authorization')==='Bearer synthetic-ai-'+reservation.accountId,'MIDNIGHT_PROVIDER_IDENTITY');
    check(wire.model==='claude-5-sonnet'&&wire.synthetic_max_output_tokens===800&&typeof wire.prompt==='string','MIDNIGHT_PROVIDER_WIRE');
    check(!wire.prompt.includes('AI_PRIVATE_MEETING_CANARY'),'MIDNIGHT_PROVIDER_PRIVACY');
    reservation.dispatched=true;o.providerInterceptions++;
    if(hold){
     try{
     const {openSync,writeFileSync,fsyncSync,closeSync,existsSync}=await import('node:fs');
     const emit=(name:string,value:unknown)=>{const fd=openSync(f.midnightDir+'/'+name,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}};
     emit('midnight-provider-marker.json',{requestId:o.requests[0].requestId,reservationId:reservation.reservationId,accountId:reservation.accountId,accountDay:reservation.accountDay,units:reservation.units,leaseSha256:o.requests[0].leaseSha256});
     emit('midnight-provider-ready.json',{ready:true});
     const deadline=performance.now()+2800;
     while(!existsSync(f.midnightDir+'/midnight-provider-release.json')){
      check(!init.signal?.aborted&&performance.now()<deadline,'MIDNIGHT_HOLD_ABORT_OR_TIMEOUT');
      await new Promise(r=>setTimeout(r,20));
     }
     const path=f.midnightDir+'/midnight-provider-release.json',entry=lstatSync(path);
     check(entry.isFile()&&!entry.isSymbolicLink()&&entry.nlink===1&&entry.uid===process.getuid!()&&(entry.mode&0o777)===0o600&&!init.signal?.aborted&&performance.now()<deadline,'MIDNIGHT_RELEASE_PRIVATE_AND_ON_TIME');
     const release=JSON.parse(readFileSync(path,'utf8'));
     check(release.requestId===o.requests[0].requestId&&release.reservationId===reservation.reservationId&&release.beforeDay===f.originalDay&&release.afterDay===f.nextDay&&release.beforeEpoch<f.midnightEpoch&&release.afterEpoch>=f.midnightEpoch&&release.afterEpoch<f.midnightEpoch+2,'MIDNIGHT_RELEASE_SQL_CHECKPOINT');
     }catch(error){holdFailed=true;throw error;}
    }
    return new Response(JSON.stringify({message:JSON.stringify({status:'search',filters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}}),token_usage:{fixture_input:1,fixture_output:1}}),{status:200,headers:{'content-type':'application/json'}});
   }
   const u=new URL(String(url)),headers=new Headers(init.headers);check(u.origin===f.origin,'MIDNIGHT_RPC_ORIGIN');
   const name=u.pathname==='/auth/v1/user'?'auth':u.pathname.split('/').at(-1)!;
   const internal=['acquire_ai_chat_request','reserve_ai_chat_account_model','settle_ai_account_budget','record_ai_chat_result_available','finish_ai_chat_request'];
   check(name==='auth'||internal.includes(name)||['get_my_profile_traits','search_public_posts_v2','get_post_author_traits'].includes(name),'MIDNIGHT_RPC_ALLOWLIST');
   check(init.method===(name==='auth'?'GET':'POST'),'MIDNIGHT_RPC_METHOD');
   check(headers.get('authorization')==='Bearer '+(internal.includes(name)?f.service:token),'MIDNIGHT_RPC_JWT');
   const args=name==='auth'?{}:JSON.parse(String(init.body));
   if(internal.includes(name)&&name!=='settle_ai_account_budget')check(args.p_user_id===uid,'MIDNIGHT_MEMBER_SCOPE');
   const request=o.requests[0];
   if(name==='reserve_ai_chat_account_model')check(request?.acquireStatus==='acquired'&&request.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token)&&args.p_ledger_id===f.aiLedgerId&&args.p_task==='intent'&&args.p_provider_id==='potens'&&args.p_contract_version==='2026-10-05'&&Number.isSafeInteger(args.p_units)&&args.p_units>0,'MIDNIGHT_RESERVE_SCOPE');
   if(name==='settle_ai_account_budget'){
    const r=o.reservations[0];check(r?.dispatched&&!r.settled&&r.reservationId===args.p_reservation_id&&r.accountId===args.p_account_id&&r.accountDay===args.p_account_day,'MIDNIGHT_SETTLE_SCOPE');
    check(args.p_outcome===(holdFailed?'usage_unknown':'usage_reported')&&(holdFailed?args.p_input_tokens===null&&args.p_output_tokens===null:args.p_input_tokens===1&&args.p_output_tokens===1),'MIDNIGHT_SETTLE_USAGE');
   }
   if(['record_ai_chat_result_available','finish_ai_chat_request'].includes(name))check(request?.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token),'MIDNIGHT_FINISH_SCOPE');
   o.counts[name]=(o.counts[name]??0)+1;const response=await localOnly(url,init);
   if(name!=='auth'){
    check(response.status===200,'MIDNIGHT_ACTUAL_RPC_HTTP');const value=await response.clone().json();
    if(name==='acquire_ai_chat_request')o.requests.push({requestId:args.p_request_id,acquireStatus:value.status,...(value.status==='acquired'?{leaseSha256:hash(value.leaseToken)}:{})});
    if(name==='reserve_ai_chat_account_model'){check(value.status==='reserved'&&value.accountDay===(f.midnightPhase==='held'?f.originalDay:f.nextDay),'MIDNIGHT_RESERVE_SUCCEEDED');o.reservations.push({reservationId:value.reservationId,accountId:value.accountId,accountDay:value.accountDay,requestId:args.p_request_id,units:args.p_units,dispatched:false,settled:false});}
    if(name==='settle_ai_account_budget')o.reservations[0].settled=true;
    if(name==='search_public_posts_v2')check(value.items.length===0&&value.nextCursor===null,'MIDNIGHT_REAL_EMPTY_SEARCH');
   }
   return response;
  };
  const handler=createAiChatRuntime((key:string)=>env[key],transport,{privacy:{decisionId:'synthetic-local-only',check:async()=>true},outputLimit:{decisionId:'synthetic-wire-only',apply:(body:any,limit:number)=>({...body,synthetic_max_output_tokens:limit})}});
  const response=await handler(new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({clientRequestId:randomUUID().replace(/[0-9]/g,d=>String.fromCharCode(103+Number(d))),messages:[{role:'user',content:'AI_DIALOGUE_CANARY 합성 한도 탐색'}],currentFilters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}})}));
  const data=(await response.json()).data;check(response.status===200&&data.requestId===response.headers.get('x-request-id')&&data.cards.length===0&&data.explanations.length===0,'MIDNIGHT_HTTP_RECEIPT');
  o.result={httpStatus:response.status,status:data.status,requestId:data.requestId,...(data.recovery?{recoveryReason:data.recovery.reason}:{}),outputSha256:hash(JSON.stringify(data))};
  check(data.status==='no_results'&&o.requests[0]?.acquireStatus==='acquired'&&o.providerInterceptions===1&&o.reservations.length===1&&o.reservations[0].settled&&o.counts.finish_ai_chat_request===1&&o.counts.record_ai_chat_result_available===1,'MIDNIGHT_ACTUAL_LIFECYCLE');
  return o;
 };
 globalThis.fetch=localOnly;
 try{
  check(['held','new-day'].includes(f.midnightPhase)&&f.midnightDir===dirname(file),'MIDNIGHT_FIXED_PRIVATE_ROOT');
  check(/^\d{4}-\d{2}-\d{2}$/.test(f.originalDay)&&/^\d{4}-\d{2}-\d{2}$/.test(f.nextDay)&&f.originalDay!==f.nextDay&&Number.isFinite(f.midnightEpoch),'MIDNIGHT_TARGET');
  if(f.midnightPhase==='held')await invoke(0,'held-across-midnight',true);
  else{await invoke(1,'new-day-after-twenty');await invoke(2,'new-day-after-unknown');}
  check(nativeExternalAttempts===0&&observations.length===(f.midnightPhase==='held'?1:2),'MIDNIGHT_EXTERNAL_ZERO_AND_COUNT');
  return {status:'PASS',case:'ai-midnight-'+f.midnightPhase,observations,nativeExternalAttempts,modelScope:'EXPLICIT_SYNTHETIC_IN_MEMORY_ADAPTER',syntheticUsageOnly:true,realProviderQualityAccountCostResetSharedUseLegalMemberLogin:'NOT_RUN',rawPromptModelResponseLogged:false};
 }finally{globalThis.fetch=native;}
}


async function aiLimitsHttpCase(f:any){
 const check=(value:unknown,code:string)=>{if(!value)throw new Error('AI_CHECK_'+code);};
 check(f.scenario==='ai-chat'&&f.aiLimitsScenario===true&&f.accounts.length===3,'LIMITS_SCOPE');
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const native=globalThis.fetch,hash=(v:string)=>createHash('sha256').update(v).digest('hex');
 const observations:any[]=[],units:any[]=[];let nativeExternalAttempts=0;
 const localOnly=async(url:any,init:RequestInit={})=>{
  const u=new URL(String(url));if(u.origin!==f.origin){nativeExternalAttempts++;throw new Error('AI_EXTERNAL_NATIVE_FORBIDDEN');}
  check(u.pathname==='/auth/v1/user'||u.pathname.startsWith('/rest/v1/rpc/'),'LIMITS_LOCAL_PATH');
  check(init.method!=='DELETE','LIMITS_DELETE_ZERO');return native(url,init);
 };
 const barrier=()=>{
  let arrived!:()=>void,release!:()=>void;let held=true;
  const ready=new Promise<void>(r=>{arrived=r;}),released=new Promise<void>(r=>{release=()=>{held=false;r();};});
  return {ready,released,arrived,release,isHeld:()=>held};
 };
 const ready=async(b:ReturnType<typeof barrier>)=>{
  let timer:any;try{await Promise.race([b.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('AI_CHECK_LIMITS_BARRIER_TIMEOUT')),1500);})]);}finally{clearTimeout(timer);}
 };
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000',
  AI_RETENTION_DECISION_ID:'synthetic-fixture-only',AI_COST_EVIDENCE_ID:'synthetic-fixture-only',AI_PROCESSING_LEGAL_DECISION_ID:'synthetic-fixture-only',AI_MEMBER_TRANSMISSION_APPROVAL_ID:'synthetic-fixture-only',AI_BUDGET_LEDGER_ID:f.aiLedgerId,
  POTENS_ACCOUNT_ORDER:'yumi,jonghyun,minkyu,sungho',POTENS_API_KEY_YUMI:'synthetic-ai-yumi',POTENS_API_KEY_JONGHYUN:'synthetic-ai-jonghyun',POTENS_API_KEY_MINKYU:'synthetic-ai-minkyu',POTENS_API_KEY_SUNGHO:'synthetic-ai-sungho',
  POTENS_ACCOUNT_TOKEN_BUDGET:'3200000',POTENS_RESET_TIMEZONE:'Asia/Seoul',POTENS_MODEL:'claude-5-sonnet',POTENS_API_BASE_URL:'https://ai.potens.ai',POTENS_USAGE_INPUT_FIELD:'fixture_input',POTENS_USAGE_OUTPUT_FIELD:'fixture_output',
  AI_CHAT_MAX_MESSAGES:'20',AI_CHAT_MAX_MESSAGE_CHARS:'500',AI_CHAT_MAX_TOTAL_CHARS:'4000',AI_CHAT_MAX_OUTPUT_TOKENS:'800',AI_CHAT_SEARCH_PAGE_SIZE:'10',AI_CHAT_MAX_SEARCH_PAGES:'3',AI_CHAT_RECHECK_MAX_PAGES:'3',AI_CHAT_MAX_RESULT_CARDS:'5',AI_CHAT_MATCH_BATCH_SIZE:'5',AI_CHAT_MAX_MATCH_CALLS:'3',AI_CHAT_MAX_MATCH_MAX_OUTPUT_TOKENS:'600',AI_CHAT_MATCH_MAX_OUTPUT_TOKENS:'600'};

 const invoke=async(account:number,label:string,expectedReason?:string,hold?:ReturnType<typeof barrier>,loss=false)=>{
  const token=f.accounts[account].token,uid=f.accounts[account].userId;
  const o:any={case:label,account,requests:[],reservations:[],counts:{},providerInterceptions:0};observations.push(o);
  const transport=async(url:any,init:RequestInit={})=>{
   if(String(url)==='https://ai.potens.ai/api/chat'){
    check(init.method==='POST'&&o.reservations.length===1,'LIMITS_PROVIDER_AFTER_RESERVE');
    const reservation=o.reservations[0],wire=JSON.parse(String(init.body));
    check(!reservation.dispatched&&new Headers(init.headers).get('authorization')==='Bearer synthetic-ai-'+reservation.accountId,'LIMITS_PROVIDER_IDENTITY');
    check(wire.model==='claude-5-sonnet'&&wire.synthetic_max_output_tokens===800&&typeof wire.prompt==='string','LIMITS_PROVIDER_WIRE');
    check(!wire.prompt.includes('AI_PRIVATE_MEETING_CANARY'),'LIMITS_PROVIDER_PRIVACY');
    reservation.dispatched=true;o.providerInterceptions++;
    if(hold){hold.arrived();await hold.released;}
    if(loss)throw new Error('AI_SYNTHETIC_RESPONSE_LOSS');
    return new Response(JSON.stringify({message:JSON.stringify({status:'search',filters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}}),token_usage:{fixture_input:1,fixture_output:1}}),{status:200,headers:{'content-type':'application/json'}});
   }
   const u=new URL(String(url)),headers=new Headers(init.headers);check(u.origin===f.origin,'LIMITS_RPC_ORIGIN');
   const name=u.pathname==='/auth/v1/user'?'auth':u.pathname.split('/').at(-1)!;
   const internal=['acquire_ai_chat_request','reserve_ai_chat_account_model','settle_ai_account_budget','record_ai_chat_result_available','finish_ai_chat_request'];
   check(name==='auth'||internal.includes(name)||['get_my_profile_traits','search_public_posts_v2','get_post_author_traits'].includes(name),'LIMITS_RPC_ALLOWLIST');
   check(init.method===(name==='auth'?'GET':'POST'),'LIMITS_RPC_METHOD');
   check(headers.get('authorization')==='Bearer '+(internal.includes(name)?f.service:token),'LIMITS_RPC_JWT');
   const args=name==='auth'?{}:JSON.parse(String(init.body));
   if(internal.includes(name)&&name!=='settle_ai_account_budget')check(args.p_user_id===uid,'LIMITS_MEMBER_SCOPE');
   const request=o.requests[0];
   if(name==='reserve_ai_chat_account_model')check(request?.acquireStatus==='acquired'&&request.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token)&&args.p_ledger_id===f.aiLedgerId&&args.p_task==='intent'&&args.p_provider_id==='potens'&&args.p_contract_version==='2026-10-05'&&Number.isSafeInteger(args.p_units)&&args.p_units>0,'LIMITS_RESERVE_SCOPE');
   if(name==='settle_ai_account_budget'){
    const r=o.reservations[0];check(r?.dispatched&&!r.settled&&r.reservationId===args.p_reservation_id&&r.accountId===args.p_account_id&&r.accountDay===args.p_account_day,'LIMITS_SETTLE_SCOPE');
    check(args.p_outcome===(loss?'usage_unknown':'usage_reported')&&(loss?args.p_input_tokens===null&&args.p_output_tokens===null:args.p_input_tokens===1&&args.p_output_tokens===1),'LIMITS_SETTLE_USAGE');
   }
   if(['record_ai_chat_result_available','finish_ai_chat_request'].includes(name))check(request?.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token),'LIMITS_FINISH_SCOPE');
   o.counts[name]=(o.counts[name]??0)+1;const response=await localOnly(url,init);
   if(name!=='auth'){
    check(response.status===200,'LIMITS_ACTUAL_RPC_HTTP');const value=await response.clone().json();
    if(name==='acquire_ai_chat_request')o.requests.push({requestId:args.p_request_id,acquireStatus:value.status,...(value.status==='acquired'?{leaseSha256:hash(value.leaseToken)}:{})});
    if(name==='reserve_ai_chat_account_model'){check(value.status==='reserved','LIMITS_RESERVE_SUCCEEDED');o.reservations.push({reservationId:value.reservationId,accountId:value.accountId,accountDay:value.accountDay,requestId:args.p_request_id,units:args.p_units,dispatched:false,settled:false});}
    if(name==='settle_ai_account_budget')o.reservations[0].settled=true;
    if(name==='search_public_posts_v2')check(value.items.length===0&&value.nextCursor===null,'LIMITS_REAL_EMPTY_SEARCH');
   }
   return response;
  };
  const handler=createAiChatRuntime((key:string)=>env[key],transport,{privacy:{decisionId:'synthetic-local-only',check:async()=>true},outputLimit:{decisionId:'synthetic-wire-only',apply:(body:any,limit:number)=>({...body,synthetic_max_output_tokens:limit})}});
  const response=await handler(new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({clientRequestId:randomUUID().replace(/[0-9]/g,d=>String.fromCharCode(103+Number(d))),messages:[{role:'user',content:'AI_DIALOGUE_CANARY 합성 한도 탐색'}],currentFilters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}})}));
  const data=(await response.json()).data;check(response.status===200&&data.requestId===response.headers.get('x-request-id')&&data.cards.length===0&&data.explanations.length===0,'LIMITS_HTTP_RECEIPT');
  o.result={httpStatus:response.status,status:data.status,requestId:data.requestId,...(data.recovery?{recoveryReason:data.recovery.reason}:{}),outputSha256:hash(JSON.stringify(data))};
  if(expectedReason){check(data.status==='unavailable'&&data.recovery?.reason===expectedReason&&o.requests[0]?.acquireStatus===expectedReason&&!o.reservations.length&&!o.providerInterceptions&&!o.counts.finish_ai_chat_request&&!o.counts.record_ai_chat_result_available,'LIMITS_DENIAL_NO_EFFECT');}
  else{check(data.status===(loss?'unavailable':'no_results')&&o.requests[0]?.acquireStatus==='acquired'&&o.providerInterceptions===1&&o.reservations.length===1&&o.reservations[0].settled&&o.counts.finish_ai_chat_request===1&&(o.counts.record_ai_chat_result_available??0)===(loss?0:1),'LIMITS_ACTUAL_LIFECYCLE');}
  return o;
 };
 globalThis.fetch=localOnly;const holds:ReturnType<typeof barrier>[]=[];
 try{
  if(f.aiLimitsRecovery===true){
   await invoke(2,'after-unknown');check(nativeExternalAttempts===0,'LIMITS_RECOVERY_EXTERNAL_ZERO');
   return {status:'PASS',case:'ai-limits-recovery',observations,nativeExternalAttempts};
  }
  for(let i=0;i<20;i++)await invoke(1,'accepted-'+String(i+1));
  await invoke(1,'denied-21','daily_limit');units.push({case:'twenty_then_twenty_one',accepted:20,denied:1});
  const same=barrier();holds.push(same);const first=invoke(0,'overlap-first',undefined,same);
  try{await ready(same);await invoke(0,'overlap-denied','concurrent');check(same.isHeld(),'LIMITS_OVERLAP_STILL_RESERVED');}finally{same.release();await first;}
  await invoke(0,'after-overlap');units.push({case:'same_member_overlap',accepted:2,denied:1,barrierAfterRealReservation:true});
  const left=barrier(),right=barrier();holds.push(left,right);
  const a=invoke(0,'cross-left',undefined,left),b=invoke(2,'cross-right',undefined,right);
  try{await Promise.all([ready(left),ready(right)]);check(left.isHeld()&&right.isHeld(),'LIMITS_CROSS_MEMBER_OVERLAP');}finally{left.release();right.release();await Promise.all([a,b]);}
  units.push({case:'cross_member_reservations',accepted:2,simultaneousReserved:true});
  await invoke(2,'unknown-provider-loss',undefined,undefined,true);
  units.push({case:'unknown_preservation',accepted:1,unknown:1,subsequentDbHashCheckRequired:true});
  check(nativeExternalAttempts===0&&observations.length===27,'LIMITS_EXTERNAL_ZERO_AND_COUNT');
  return {status:'PASS',case:'ai-limits',observations,units,nativeExternalAttempts,modelScope:'EXPLICIT_SYNTHETIC_IN_MEMORY_ADAPTER',syntheticUsageOnly:true,actualWallClockMidnight:'NOT_RUN',accountAndGlobalCapExhaustion:'NOT_IMPLEMENTED',realProviderQualityAccountCostResetSharedUseLegalMemberLogin:'NOT_RUN',rawPromptModelResponseLogged:false};
 }finally{for(const held of holds)held.release();globalThis.fetch=native;}
}

async function aiCapsHttpCase(f:any){
 const check=(value:unknown,code:string)=>{if(!value)throw new Error('AI_CHECK_'+code);};
 check(f.scenario==='ai-chat'&&f.aiCapsScenario===true&&f.accounts.length===3,'CAPS_SCOPE');
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const native=globalThis.fetch,hash=(v:string)=>createHash('sha256').update(v).digest('hex');
 const observations:any[]=[];const accountIds=['yumi','jonghyun','minkyu','sungho'];let nativeExternalAttempts=0;
 const localOnly=async(url:any,init:RequestInit={})=>{
  const u=new URL(String(url));if(u.origin!==f.origin){nativeExternalAttempts++;throw new Error('AI_EXTERNAL_NATIVE_FORBIDDEN');}
  check(u.pathname==='/auth/v1/user'||u.pathname.startsWith('/rest/v1/rpc/'),'CAPS_LOCAL_PATH');
  check(init.method!=='DELETE','CAPS_DELETE_ZERO');return native(url,init);
 };
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000',
  AI_RETENTION_DECISION_ID:'synthetic-fixture-only',AI_COST_EVIDENCE_ID:'synthetic-fixture-only',AI_PROCESSING_LEGAL_DECISION_ID:'synthetic-fixture-only',AI_MEMBER_TRANSMISSION_APPROVAL_ID:'synthetic-fixture-only',AI_BUDGET_LEDGER_ID:f.aiLedgerId,
  POTENS_ACCOUNT_ORDER:'yumi,jonghyun,minkyu,sungho',POTENS_API_KEY_YUMI:'synthetic-ai-yumi',POTENS_API_KEY_JONGHYUN:'synthetic-ai-jonghyun',POTENS_API_KEY_MINKYU:'synthetic-ai-minkyu',POTENS_API_KEY_SUNGHO:'synthetic-ai-sungho',
  POTENS_ACCOUNT_TOKEN_BUDGET:'3200000',POTENS_RESET_TIMEZONE:'Asia/Seoul',POTENS_MODEL:'claude-5-sonnet',POTENS_API_BASE_URL:'https://ai.potens.ai',POTENS_USAGE_INPUT_FIELD:'fixture_input',POTENS_USAGE_OUTPUT_FIELD:'fixture_output',
  AI_CHAT_MAX_MESSAGES:'20',AI_CHAT_MAX_MESSAGE_CHARS:'500',AI_CHAT_MAX_TOTAL_CHARS:'4000',AI_CHAT_MAX_OUTPUT_TOKENS:'800',AI_CHAT_SEARCH_PAGE_SIZE:'10',AI_CHAT_MAX_SEARCH_PAGES:'3',AI_CHAT_RECHECK_MAX_PAGES:'3',AI_CHAT_MAX_RESULT_CARDS:'5',AI_CHAT_MATCH_BATCH_SIZE:'5',AI_CHAT_MAX_MATCH_CALLS:'3',AI_CHAT_MAX_MATCH_MAX_OUTPUT_TOKENS:'600',AI_CHAT_MATCH_MAX_OUTPUT_TOKENS:'600'};

 const invoke=async(label:string,target:string|null,charge:number,loss=false,denied=false)=>{
  const account=0;check(Number.isSafeInteger(charge)&&charge>=0&&charge<=3200000,'CAPS_SYNTHETIC_USAGE_BOUND');
  const token=f.accounts[account].token,uid=f.accounts[account].userId;
  const o:any={case:label,account,requests:[],reservations:[],counts:{},providerInterceptions:0,reserveAttempts:[],reportedCharge:charge};observations.push(o);
  const transport=async(url:any,init:RequestInit={})=>{
   if(String(url)==='https://ai.potens.ai/api/chat'){
    check(init.method==='POST'&&o.reservations.length===1,'CAPS_PROVIDER_AFTER_RESERVE');
    const reservation=o.reservations[0],wire=JSON.parse(String(init.body));
    check(!reservation.dispatched&&new Headers(init.headers).get('authorization')==='Bearer synthetic-ai-'+reservation.accountId,'CAPS_PROVIDER_IDENTITY');
    check(wire.model==='claude-5-sonnet'&&wire.synthetic_max_output_tokens===800&&typeof wire.prompt==='string','CAPS_PROVIDER_WIRE');
    check(!wire.prompt.includes('AI_PRIVATE_MEETING_CANARY'),'CAPS_PROVIDER_PRIVACY');
    reservation.dispatched=true;o.providerInterceptions++;
    check(reservation.accountId===target,'CAPS_PROVIDER_EXPECTED_ACCOUNT');
    if(loss)throw new Error('AI_SYNTHETIC_RESPONSE_LOSS');
    return new Response(JSON.stringify({message:JSON.stringify({status:'search',filters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}}),token_usage:{fixture_input:charge-1,fixture_output:1}}),{status:200,headers:{'content-type':'application/json'}});
   }
   const u=new URL(String(url)),headers=new Headers(init.headers);check(u.origin===f.origin,'CAPS_RPC_ORIGIN');
   const name=u.pathname==='/auth/v1/user'?'auth':u.pathname.split('/').at(-1)!;
   const internal=['acquire_ai_chat_request','reserve_ai_chat_account_model','settle_ai_account_budget','record_ai_chat_result_available','finish_ai_chat_request'];
   check(name==='auth'||internal.includes(name)||['get_my_profile_traits','search_public_posts_v2','get_post_author_traits'].includes(name),'CAPS_RPC_ALLOWLIST');
   check(init.method===(name==='auth'?'GET':'POST'),'CAPS_RPC_METHOD');
   check(headers.get('authorization')==='Bearer '+(internal.includes(name)?f.service:token),'CAPS_RPC_JWT');
   const args=name==='auth'?{}:JSON.parse(String(init.body));
   if(internal.includes(name)&&name!=='settle_ai_account_budget')check(args.p_user_id===uid,'CAPS_MEMBER_SCOPE');
   const request=o.requests[0];
   if(name==='reserve_ai_chat_account_model')check(request?.acquireStatus==='acquired'&&request.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token)&&args.p_ledger_id===f.aiLedgerId&&args.p_task==='intent'&&args.p_provider_id==='potens'&&args.p_contract_version==='2026-10-05'&&Number.isSafeInteger(args.p_units)&&args.p_units>0,'CAPS_RESERVE_SCOPE');
   if(name==='settle_ai_account_budget'){
    const r=o.reservations[0];check(r?.dispatched&&!r.settled&&r.reservationId===args.p_reservation_id&&r.accountId===args.p_account_id&&r.accountDay===args.p_account_day,'CAPS_SETTLE_SCOPE');
    check(args.p_outcome===(loss?'usage_unknown':'usage_reported')&&(loss?args.p_input_tokens===null&&args.p_output_tokens===null:args.p_input_tokens===charge-1&&args.p_output_tokens===1),'CAPS_SETTLE_USAGE');
   }
   if(['record_ai_chat_result_available','finish_ai_chat_request'].includes(name))check(request?.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token),'CAPS_FINISH_SCOPE');
   o.counts[name]=(o.counts[name]??0)+1;const response=await localOnly(url,init);
   if(name!=='auth'){
    check(response.status===200,'CAPS_ACTUAL_RPC_HTTP');const value=await response.clone().json();
    if(name==='acquire_ai_chat_request')o.requests.push({requestId:args.p_request_id,acquireStatus:value.status,...(value.status==='acquired'?{leaseSha256:hash(value.leaseToken)}:{})});
    if(name==='reserve_ai_chat_account_model'){
     check(['reserved','account_budget_denied','global_budget_denied'].includes(value.status),'CAPS_RESERVE_STATUS');
     o.reserveAttempts.push({accountId:args.p_account_id,status:value.status,units:args.p_units});
     if(value.status==='reserved'){check(value.accountId===target&&value.accountDay===f.aiCapDay,'CAPS_STORED_RESERVE_DAY_ACCOUNT');o.reservations.push({reservationId:value.reservationId,accountId:value.accountId,accountDay:value.accountDay,requestId:args.p_request_id,units:args.p_units,dispatched:false,settled:false});}}
    if(name==='settle_ai_account_budget')o.reservations[0].settled=true;
    if(name==='search_public_posts_v2')check(value.items.length===0&&value.nextCursor===null,'CAPS_REAL_EMPTY_SEARCH');
   }
   return response;
  };
  const handler=createAiChatRuntime((key:string)=>env[key],transport,{privacy:{decisionId:'synthetic-local-only',check:async()=>true},outputLimit:{decisionId:'synthetic-wire-only',apply:(body:any,limit:number)=>({...body,synthetic_max_output_tokens:limit})}});
  const response=await handler(new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({clientRequestId:randomUUID().replace(/[0-9]/g,d=>String.fromCharCode(103+Number(d))),messages:[{role:'user',content:'AI_DIALOGUE_CANARY 합성 한도 탐색'}],currentFilters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}})}));
  const data=(await response.json()).data;check(response.status===200&&data.requestId===response.headers.get('x-request-id')&&data.cards.length===0&&data.explanations.length===0,'CAPS_HTTP_RECEIPT');
  o.result={httpStatus:response.status,status:data.status,requestId:data.requestId,...(data.recovery?{recoveryReason:data.recovery.reason}:{}),outputSha256:hash(JSON.stringify(data))};
  if(denied){check(data.status==='unavailable'&&data.recovery?.reason==='temporary'&&o.requests[0]?.acquireStatus==='acquired'&&o.reserveAttempts.length===1&&o.reserveAttempts[0].status==='global_budget_denied'&&!o.reservations.length&&!o.providerInterceptions&&o.counts.finish_ai_chat_request===1&&!o.counts.record_ai_chat_result_available,'CAPS_DENIAL_NO_MODEL_OR_COUNT');}
  else{check(data.status===(loss?'unavailable':'no_results')&&o.requests[0]?.acquireStatus==='acquired'&&o.providerInterceptions===1&&o.reservations.length===1&&o.reservations[0].settled&&o.counts.finish_ai_chat_request===1&&(o.counts.record_ai_chat_result_available??0)===(loss?0:1),'CAPS_ACTUAL_LIFECYCLE');}
  return o;
 };
 globalThis.fetch=localOnly;
 try{
  check(/^\d{4}-\d{2}-\d{2}$/.test(f.aiCapDay)&&accountIds.every(id=>Number.isSafeInteger(f.aiCapHeadroom?.[id])&&f.aiCapHeadroom[id]>0&&f.aiCapHeadroom[id]<=3200000),'CAPS_PREPARED_HEADROOM');
  check(['unknown','fill'].includes(f.aiCapPhase),'CAPS_EXPLICIT_PHASE');
  if(f.aiCapPhase==='unknown'){await invoke('unknown-preserved','yumi',0,true);check(nativeExternalAttempts===0,'CAPS_EXTERNAL_ZERO');return {status:'PASS',case:'ai-caps-unknown',observations,nativeExternalAttempts};}
  const unknownUnits=f.aiCapUnknownUnits;check(Number.isSafeInteger(unknownUnits)&&unknownUnits>0,'CAPS_ORIGINAL_UNKNOWN_UNITS');
  for(const [index,id]of accountIds.entries()){
   const charge=f.aiCapHeadroom[id]-(index===0?unknownUnits:0);
   check(charge>0,'CAPS_NATURAL_HEADROOM_AVAILABLE');
   const o=await invoke('fill-'+id,id,charge);
   check(o.reserveAttempts.length===index+1&&o.reserveAttempts.every((attempt:any,j:number)=>attempt.accountId===accountIds[j]&&attempt.status===(j===index?'reserved':'account_budget_denied')),'CAPS_ACCOUNT_DENIAL_THEN_FALLBACK');
   check(o.reservations[0].units<=charge,'CAPS_RESERVATION_FITS_HEADROOM');
  }
  await invoke('global-denied',null,0,false,true);
  check(nativeExternalAttempts===0&&observations.length===5,'CAPS_EXTERNAL_ZERO_AND_COUNT');
  return {status:'PASS',case:'ai-caps',observations,nativeExternalAttempts,modelScope:'EXPLICIT_SYNTHETIC_IN_MEMORY_ADAPTER',syntheticUsageOnly:true,actualWallClockMidnight:'NOT_RUN',realProviderQualityAccountCostResetSharedUseLegalMemberLogin:'NOT_RUN',rawPromptModelResponseLogged:false};
 }finally{globalThis.fetch=native;}
}
