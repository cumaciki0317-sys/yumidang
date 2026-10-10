/** AI22/23 기존 unit 함수 본문 그대로. Auth는 합성 bridge, RPC는 실제 격리 SQL. */
import assert from 'node:assert/strict';
import {readFileSync,lstatSync} from 'node:fs';
import {dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
const file=process.argv[2],mode=process.argv[3],info=lstatSync(file),directory=lstatSync(dirname(file));
assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.uid===process.getuid!()&&(info.mode&0o777)===0o600);
assert.ok(directory.isDirectory()&&!directory.isSymbolicLink()&&directory.uid===process.getuid!()&&(directory.mode&0o777)===0o700);
const fixture=JSON.parse(readFileSync(file,'utf8')),origin=new URL(fixture.origin);
assert.equal(origin.hostname,'127.0.0.1');assert.equal(origin.protocol,'http:');assert.equal(origin.origin,fixture.origin);
assert.ok(['--ai-limits','--ai-caps'].includes(mode));
assert.ok(fixture.productManifest&&Object.keys(fixture.productManifest).length>0);
for(const [relative,expected]of Object.entries(fixture.productManifest)){
 assert.ok(relative.startsWith('backend/supabase/functions/')&&!relative.includes('..'));
 assert.equal(createHash('sha256').update(readFileSync(fixture.codeRoot+'/'+relative)).digest('hex'),expected,'product graph changed');
}
try { process.stdout.write(JSON.stringify(await (mode==='--ai-limits'?aiLimitsHttpCase(fixture):aiCapsHttpCase(fixture)))); }
catch(error){const code=error instanceof Error&&/^AI_CHECK_[A-Z_]+$/.test(error.message)?error.message:'AI_ISOLATED_FACTORY_FAILED';process.stderr.write(code+'\n');process.exitCode=1;}
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

