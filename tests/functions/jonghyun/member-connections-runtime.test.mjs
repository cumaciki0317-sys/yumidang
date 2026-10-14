/** 준비·pipe·원 JWT metadata의 모형 검사다. 실제 Root/DB/Auth/VM을 호출하지 않는다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateMemberInput,validateIssuedMembers,runMemberConnections,createMemberPipeBoundary,MEMBER_METHODS,COMPLETED_MEMBER_METHODS,MEMBER_ARG_KEYS,validateReadBoundaryFixture,validateReadBoundaryInspection,assertReadBoundaryUnchanged,assertReadBoundaryFirstReads,validateMemberBridgeRoute,validateMemberResultStateRpc,verifyMemberResultStateReads,validateCompletedRetirementFixture,validateCompletedRetirementInspection,validateCompletedBridgeRoute,validateCompletedLossResponse,performCompletedRetirement} from '../../integration/jonghyun/member-connections-rest.mjs';
const hash='a'.repeat(64),user=i=>`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`;
const source=['backend/supabase/functions/service-api/index.ts','backend/supabase/functions/ai-chat/index.ts','apps/mobile/src/member-service.ts','apps/mobile/src/service.ts','apps/mobile/src/member-session.ts','apps/mobile/src/web-member-session.ts','tests/integration/jonghyun/member-connections-rest.mjs'];
const input=()=>({version:1,scenario:'MEMBER_CONNECTIONS_J07_J08_J09',repositoryRoot:'/private/tmp/mock-repo',codeRoot:'/private/tmp/mock-capsule',head:'b'.repeat(40),sourceFiles:Object.fromEntries(source.map(p=>[p,hash])),migrationFiles:{'backend/supabase/migrations/20261009031628_event_detail_projection.sql':hash},target:null,bindingSha256:hash});
test('기본 CLI와 미지원 --run은 실제 실행 없이 NOT_RUN/BLOCKED로만 반환',()=>{
 const path=fileURLToPath(new URL('../../integration/jonghyun/member-connections-rest.mjs',import.meta.url));
 for(const args of [[],['--run']]){const p=spawnSync(process.execPath,[path,...args],{encoding:'utf8',timeout:5000});const v=JSON.parse(p.stdout.trim());assert.equal(v.ready,false);assert.equal(v.status,args.length?'BLOCKED':'NOT_RUN');assert.equal(p.status,args.length?2:0);}
});
test('검증된 실제 target/Root boundary가 없으면 callback과 credential 조회0',async()=>{
 const plan=input(),report=validateMemberInput(plan);assert.equal(report.execution,'NOT_RUN');assert.equal(report.ready,false);assert.equal(report.actualTargetVerified,false);
 let calls=0;const boundary=Object.fromEntries(MEMBER_METHODS.map(name=>[name,()=>{calls++;assert.fail();}]));await assert.rejects(runMemberConnections(plan,boundary),/MEMBER_CASE_EXACT_TARGET_REQUIRED/);assert.equal(calls,0);
 for(const bad of [{...plan,approved:true},{...plan,bindingSha256:'bad'},{...plan,target:{approved:true}},{...plan,sourceFiles:{...plan.sourceFiles,'../escape.ts':hash}}])assert.throws(()=>validateMemberInput(bad));
});
test('원 issued6의 sub/session/issuer/expiry를 검사해도 JWT 서명 증거로 보고하지 않음',()=>{
 const now=1900000000000,target={authIssuer:'http://127.0.0.1:65421/auth/v1',authAudience:'authenticated'};
 const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),token=c=>encode({alg:'HS256'})+'.'+encode(c)+'.synthetic';
 const accounts=Array.from({length:6},(_,i)=>({userId:user(i+1),sessionId:user(i+11),expiresAt:1900003600,authEmail:'synthetic'+i+'@example.test',accessToken:token({sub:user(i+1),session_id:user(i+11),exp:1900003600,iss:target.authIssuer,aud:'authenticated',role:'authenticated'})}));
 assert.deepEqual(validateIssuedMembers(accounts,target,now),{scope:'ISSUED_METADATA_ONLY',signatureVerified:false});
 for(const change of [{sub:user(6)},{session_id:user(16)},{iss:'https://outside.test/auth/v1'},{role:'anon'},{exp:1900000001}]){const c={sub:user(1),session_id:user(11),exp:1900003600,iss:target.authIssuer,aud:'authenticated',role:'authenticated',...change};assert.throws(()=>validateIssuedMembers([{...accounts[0],accessToken:token(c)},...accounts.slice(1)],target,now));}
 assert.throws(()=>validateIssuedMembers(accounts.slice(0,5),target,now));assert.throws(()=>validateIssuedMembers([accounts[0],accounts[0],...accounts.slice(2)],target,now));
});
test('고정 pipe method는 원 runId/sequence 응답만 받고 SQL method를 만들지 않음',async()=>{
 const id=user(1),sent=[];let reply;
 const boundary=createMemberPipeBoundary(id,v=>{sent.push(v);reply={requestId:id,sequence:v.sequence,ok:true,value:{metadata:true}};},async()=>reply);
 assert.equal(boundary.sql,undefined);assert.deepEqual(await boundary.verifyTarget({runId:id,bindingSha256:hash}),{metadata:true});assert.equal(sent[0].method,'verifyTarget');assert.equal(sent[0].sequence,1);
 const changed=createMemberPipeBoundary(id,()=>{},async()=>({requestId:user(2),sequence:1,ok:true,value:{}}));await assert.rejects(changed.readCredentials({runId:id,bindingSha256:hash}),/MEMBER_CASE_ROOT_PIPE_REPLY/);
 const repeated=createMemberPipeBoundary(id,()=>{},async()=>({requestId:id,sequence:0,ok:true,value:{}}));await assert.rejects(repeated.readIssuedAuth({runId:id,bindingSha256:hash}),/MEMBER_CASE_ROOT_PIPE_REPLY/);
});

const readFixture=()=>({requestId:user(31),messageIds:Array.from({length:100},(_,i)=>user(i+101)),foreignRequestId:user(32),foreignMessageId:user(501),hiddenMessageId:user(200)});
const readOriginal=()=>({requestId:user(31),messageIds:[user(101),user(102),user(103)]});
const readRow=(messageId=user(101))=>({userId:user(1),requestId:user(31),messageId,readAt:'2026-10-14T01:00:00.123456+00:00',rowSha256:hash});
const readState=()=>({requestId:user(31),scopeRowsSha256:hash,reads:[readRow()],hidden:[],visibility:[],sessionBindingRestored:true});

test('J08 준비100개는 원3개와 다른 실제방·별도 메시지·마지막 숨김ID를 정확히 묶는다',()=>{
 const valid=readFixture(),original=readOriginal();assert.deepEqual(validateReadBoundaryFixture(valid,original),valid);
 for(const bad of [{...valid,approved:true},{...valid,requestId:user(33)},{...valid,messageIds:valid.messageIds.slice(0,99)},{...valid,messageIds:[valid.messageIds[0],...valid.messageIds.slice(0,99)]},{...valid,messageIds:valid.messageIds.map(id=>id===user(101)?user(601):id)},{...valid,foreignRequestId:valid.requestId},{...valid,foreignMessageId:user(101)},{...valid,hiddenMessageId:user(101)}])assert.throws(()=>validateReadBoundaryFixture(bad,original),/MEMBER_CASE_READ_BOUNDARY_FIXTURE/);
});

test('J08 사적 상태는 exact native 해시와 owned 정렬·중복 없는 읽음/숨김/나감만 받는다',()=>{
 const fixture=readFixture(),users=[user(1),user(2)],valid=readState();const result=validateReadBoundaryInspection(valid,fixture,users);assert.deepEqual(result,valid);assert.ok(Object.isFrozen(result.reads[0]));
 const hidden={id:user(701),rowSha256:hash},visibility={userId:user(1),requestId:fixture.requestId,rowSha256:hash};
 const cases=[{...valid,token:'private-sentinel'},{...valid,scopeRowsSha256:'bad'},{...valid,sessionBindingRestored:'true'},{...valid,reads:[readRow(),readRow()]},{...valid,reads:[readRow(user(102)),readRow(user(101))]},{...valid,reads:[{...readRow(),userId:user(3)}]},{...valid,reads:[readRow(fixture.foreignMessageId)]},{...valid,reads:[{...readRow(),readAt:'not-time'}]},{...valid,hidden:[hidden,hidden]},{...valid,hidden:[{...hidden,raw:'private-sentinel'}]},{...valid,visibility:[visibility,visibility]},{...valid,visibility:[{...visibility,requestId:user(999)}]}];
 for(const value of cases)assert.throws(()=>validateReadBoundaryInspection(value,fixture,users));
 const foreign={...readRow(fixture.foreignMessageId),requestId:fixture.foreignRequestId};assert.doesNotThrow(()=>validateReadBoundaryInspection({...valid,reads:[readRow(),foreign]},fixture,users));
});

test('J08 거절 전후는 해시·개수만 같아도 최초시각/행/연결이 바뀌면 닫힌다',()=>{
 const before=readState();assert.doesNotThrow(()=>assertReadBoundaryUnchanged(before,structuredClone(before)));
 for(const after of [{...before,scopeRowsSha256:'b'.repeat(64)},{...before,reads:[{...readRow(),readAt:'2026-10-14T01:00:01Z'}]},{...before,reads:[{...readRow(),rowSha256:'b'.repeat(64)}]},{...before,sessionBindingRestored:false}])assert.throws(()=>assertReadBoundaryUnchanged(before,after),/MEMBER_CASE_READ_BOUNDARY_UNEXPECTED_WRITE/);
 assert.doesNotThrow(()=>assertReadBoundaryFirstReads(before,{...before,reads:[readRow(),readRow(user(102))]}));
 assert.throws(()=>assertReadBoundaryFirstReads(before,{...before,reads:[{...readRow(),readAt:'2026-10-14T01:00:01Z'}]}),/MEMBER_CASE_READ_BOUNDARY_FIRST_READ_CHANGED/);
 assert.throws(()=>assertReadBoundaryFirstReads(before,{...before,reads:[]}),/MEMBER_CASE_READ_BOUNDARY_FIRST_READ_CHANGED/);
});

test('J08 새 pipe 메소드는 원runId/binding과 고정stage만 보내며 SQL/flag/잘못된stage는 전송0',async()=>{
 const id=user(1),sent=[];let reply;const boundary=createMemberPipeBoundary(id,v=>{sent.push(v);reply={requestId:id,sequence:v.sequence,ok:true,value:readState()};},async()=>reply);
 for(const method of ['prepareReadBoundaryCases','inspectReadBoundaryCases','setReadBoundaryCase'])assert.deepEqual(MEMBER_ARG_KEYS[method],method==='setReadBoundaryCase'?['requestId','stage']:['requestId']);
 const base={runId:id,bindingSha256:hash,requestId:user(31)};
 await boundary.prepareReadBoundaryCases(base);await boundary.inspectReadBoundaryCases(base);
 for(const stage of ['hidden','revoked','restored'])await boundary.setReadBoundaryCase({...base,stage});
 assert.equal(sent.length,5);assert.deepEqual(sent.map(v=>v.sequence),[1,2,3,4,5]);
 for(const args of [{...base,stage:'approved'},{...base,stage:'HIDDEN'},{...base,stage:'hidden',sql:'select private'},{...base,stage:'hidden',approved:true},{...base,stage:'hidden',requestId:'bad'},{...base,stage:'hidden',runId:user(2)}])await assert.rejects(boundary.setReadBoundaryCase(args));
 assert.equal(sent.length,5);
});

test('J08 TLS 경로는20개 페이징·목록·나감만 정확히 열고 query/원watermark/외부origin을 거절한다',()=>{
 const origin='https://127.0.0.1:65499',room='/functions/v1/service-api/conversations/'+user(31);
 for(const [method,path]of [['GET',room+'/messages?limit=20'],['GET',room+'/messages?limit=20&before='+user(101)],['GET','/functions/v1/service-api/conversations'],['GET',room],['POST',room+'/leave'],['POST',room+'/read/messages']])assert.doesNotThrow(()=>validateMemberBridgeRoute(new URL(origin+path),method));
 for(const [method,path]of [['GET',room+'/messages?limit=21'],['GET',room+'/messages?limit=20&limit=20'],['GET',room+'/messages?limit=20&before=bad'],['GET',room+'/messages?limit=20&token=private'],['GET',room+'/leave'],['POST',room+'/read'],['POST',room+'/leave?approved=1'],['GET','/functions/v1/service-api/conversations?other=1'],['POST','/functions/v1/service-api/conversations/'+('-'.repeat(36))+'/read/messages']])assert.throws(()=>validateMemberBridgeRoute(new URL(origin+path),method));
 assert.throws(()=>validateMemberBridgeRoute(new URL('https://outside.example.invalid'+room+'/messages?limit=20'),'GET'));
});

test('J08 SDK101개·중복은 원 JWT 조회와 fetch 모두0이며 올바른100개는 exact 집합만 수용',async()=>{
 const {ServiceApiClient}=await import('../../../apps/mobile/src/api.ts'),{MemberService}=await import('../../../apps/mobile/src/member-service.ts');let tokens=0,calls=0;
 const fixture=readFixture(),api=new ServiceApiClient('https://service.example.invalid/functions/v1/service-api',async()=>{tokens++;return 'synthetic-bearer';},async(url,init)=>{calls++;const ids=JSON.parse(init.body).messageIds;assert.equal(String(url),'https://service.example.invalid/functions/v1/service-api/conversations/'+fixture.requestId+'/read/messages');return Response.json({data:{messageIds:[...ids].reverse(),unreadCount:0},error:null});});
 const service=new MemberService(api);for(const ids of [[...fixture.messageIds,fixture.foreignMessageId],[fixture.messageIds[0],fixture.messageIds[0]]])await assert.rejects(service.markMessagesRead(fixture.requestId,ids),e=>e.status===400&&e.code==='INVALID_MESSAGE_IDS');assert.equal(tokens,0);assert.equal(calls,0);
 const result=await service.markMessagesRead(fixture.requestId,fixture.messageIds);assert.equal(result.confirmedMessageIds.length,100);assert.equal(result.unreadCount,0);assert.equal(tokens,1);assert.equal(calls,1);
});

test('J07 결과 상태 bridge/RPC는 원 UUID GET·service-only 두인자만 허용하고 거절 시 다음포트0',()=>{
 const id=user(31),origin='https://127.0.0.1:65499',path='/functions/v1/ai-chat/results/'+id;
 assert.doesNotThrow(()=>validateMemberBridgeRoute(new URL(origin+path),'GET'));
 for(const [method,suffix]of [['POST',''],['PUT',''],['GET','?userId='+user(1)],['GET','?x=1&x=1'],['GET','/extra'],['GET','#fragment']])assert.throws(()=>validateMemberBridgeRoute(new URL(origin+path+suffix),method));
 assert.throws(()=>validateMemberBridgeRoute(new URL(origin+'/functions/v1/ai-chat/results/bad'),'GET'));
 const credentials={service:'synthetic-service'},url=new URL('http://127.0.0.1:65421/rest/v1/rpc/get_ai_result_state');
 const init={method:'POST',headers:{authorization:'Bearer '+credentials.service,apikey:credentials.service},body:JSON.stringify({p_user_id:user(1),p_request_id:id})};
 let dispatches=0;const dispatch=(u,i)=>{validateMemberResultStateRpc(u,i,credentials);dispatches++;};
 dispatch(url,init);
 for(const changed of [{...init,method:'GET'},{...init,body:undefined},{...init,body:'bad'},{...init,body:JSON.stringify({p_user_id:user(1),p_request_id:id,body:'PRIVATE_BODY'})},{...init,body:JSON.stringify({p_user_id:'bad',p_request_id:id})},{...init,headers:{authorization:'Bearer synthetic-member',apikey:'synthetic-anon'}}])assert.throws(()=>dispatch(url,changed));
 for(const changed of [url+'?p_request_id='+id,url+'#fragment','http://127.0.0.1:65421/rest/v1/rpc/submit_ai_feedback'])assert.throws(()=>dispatch(new URL(changed),init));
 assert.equal(dispatches,1);
});

test('J07 기존 receipt 이후 실제 SDK→runtime→합성 RPC 읽기4회, TTL404와 malformed bridge는 쓰기0',async()=>{
 const {YumidangService}=await import('../../../apps/mobile/src/service.ts'),{createAiChatRuntime}=await import('../../../backend/supabase/functions/ai-chat/index.ts');
 const id=user(31),missing=user(32),origin='https://127.0.0.1:65499',db='http://127.0.0.1:65421',credentials={service:'synthetic-service'},events=[];
 let created=false,expired=false,reads=0,auth=0,forbidden=0;
 const writes={providerSynthetic:1,rpc:{acquire_ai_chat_request:1,finish_ai_chat_request:1,record_ai_chat_result_available:1,submit_ai_feedback:0}};
 const env={SUPABASE_URL:db,SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:credentials.service,INTERNAL_WORKER_SECRET:'synthetic_worker_secret_longer_than_32_characters',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'8192',UPSTREAM_TIMEOUT_MS:'1000'};
 const state={requestId:id,status:'available',availableAt:'2026-10-14T00:00:00.123456+00:00',helpfulAllowed:true};
 const runtime=createAiChatRuntime(k=>env[k],async(input,init)=>{
  const url=new URL(String(input)),headers=new Headers(init.headers);
  if(url.pathname==='/auth/v1/user'){auth++;const owner=headers.get('authorization')==='Bearer synthetic.owner.jwt';return Response.json({id:owner?user(1):user(2),role:'authenticated',is_anonymous:false});}
  if(url.pathname!=='/rest/v1/rpc/get_ai_result_state'){forbidden++;assert.fail('model/acquire/finish/record/feedback RPC must not run');}
  validateMemberResultStateRpc(url,init,credentials);reads++;events.push('result-read');assert.equal(created,true,'읽기 준비본은 기존 성공 receipt 이후에만 수행한다');
  const args=JSON.parse(init.body);return args.p_user_id===user(1)&&args.p_request_id===id&&!expired?Response.json(state):Response.json({code:'PT404'},{status:400});
 });
 const fetcher=async(input,init={})=>{
  const url=new URL(String(input));try{validateMemberBridgeRoute(url,init.method??'GET');}catch{return Response.json({data:null,error:{code:'EXTERNAL_UNAVAILABLE'}},{status:503});}
  return runtime(new Request(url,init));
 };
 const sdk=n=>new YumidangService({serviceApiUrl:origin+'/functions/v1/service-api',aiChatUrl:origin+'/functions/v1/ai-chat',accessToken:async()=>n===0?'synthetic.owner.jwt':'synthetic.foreign.jwt',fetcher});
 const owner=sdk(0),foreign=sdk(1),observe=()=>({reads,auth,writes:structuredClone(writes)});
 const probe=async(requestId,{method='GET',query=''}={})=>{const response=await fetcher(origin+'/functions/v1/ai-chat/results/'+requestId+query,{method,headers:{authorization:'Bearer synthetic.owner.jwt'}});return{status:response.status,body:await response.json()};};
 // 저장된 상태는 합성 durable 모형이다. native receipt 생성/finish 성공으로 계산하지 않는다.
 events.push('existing-needs-clarification-receipt');created=true;
 const proof=await verifyMemberResultStateReads({requestId:id,missingId:missing,owner,foreign,probe,observe});
 assert.equal(proof.status,'ROOT_ATTESTATION_REQUIRED');assert.equal(proof.mutationRpcIncrease,0);assert.equal(proof.strictFourFields,true);
 assert.deepEqual(events,['existing-needs-clarification-receipt',...Array(4).fill('result-read')]);assert.equal(auth,4);assert.equal(reads,4);assert.equal(forbidden,0);
 expired=true;const before=observe();await assert.rejects(owner.getAiResultState(id),e=>e.status===404);assert.equal(reads,before.reads+1);assert.deepEqual(observe().writes,before.writes);assert.equal(forbidden,0);
});

test('J07 원 상태와 새 HTTP envelope 혼동·여분원문·조회중 쓰기 증가는 성공 proof를 만들지 않음',async()=>{
 const id=user(31),missing=user(32),state={requestId:id,status:'available',availableAt:'2026-10-14T00:00:00Z',helpfulAllowed:true};
 for(const defect of ['same-envelope','extra-state','mutation']){
  let reads=0,mutations=0;const owner={async getAiResultState(requestId){reads++;if(requestId===missing)throw{status:404};return defect==='extra-state'?{...state,body:'PRIVATE_BODY'}:state;}};
  const foreign={async getAiResultState(){reads++;throw{status:404};}};
  const probe=async()=>{reads++;if(defect==='mutation')mutations++;return{status:200,body:{data:state,requestId:defect==='same-envelope'?id:user(33)}};};
  await assert.rejects(verifyMemberResultStateReads({requestId:id,missingId:missing,owner,foreign,probe,observe:()=>({reads,auth:0,writes:{mutations}})}),/MEMBER_CASE_RESULT_STATE_/);
 }
});

const completedFixture=()=>({status:'prepared',userId:user(6),withdrawalId:user(710),objectId:user(711),objectSha256:hash,objectBytes:128,invocationRequestId:user(712),recoveryRequestId:user(713)});
const taskRow=(f,kind,n)=>({taskId:user(n),withdrawalId:f.withdrawalId,profileId:f.userId,kind,state:'pending',objectId:kind==='storage_object'?f.objectId:null,leaseToken:null,workerRunToken:null,leaseExpiresAt:null,evidenceSha256:null,completedAt:null,rowSha256:hash,dispatch:null,ack:null});
const initialCompleted=()=>{const f=completedFixture();return{withdrawalId:f.withdrawalId,userId:f.userId,state:'pending_cleanup',rowSha256:hash,ackSha256:null,tasks:[taskRow(f,'storage_object',720),taskRow(f,'auth_user',721)],invocations:[],reconciliations:[],scopeRowsSha256:hash,authUserPresent:true,storageObjectPresent:true,storageBytesPresent:true,otherFivePreserved:true};};

test('v2는 원4target/9fields+mode만 받고 v1의16callbacks와 비실행기본을 유지',async()=>{
 const plan={...input(),version:2,scenario:'MEMBER_CONNECTIONS_COMPLETED',completionMode:'ack_loss'};
 assert.equal(validateMemberInput(plan).execution,'NOT_RUN');assert.equal(MEMBER_METHODS.length,16);assert.equal(COMPLETED_MEMBER_METHODS.length,19);
 for(const patch of [{completionMode:'fake_completed'},{scenario:'MEMBER_CONNECTIONS_J07_J08_J09'},{storageReceiptPath:'/private/key'},{storageReceiptSha256:hash},{ownedContainersSha256:hash},{version:3}])assert.throws(()=>validateMemberInput({...plan,...patch}));
 let calls=0;const boundary=Object.fromEntries(COMPLETED_MEMBER_METHODS.map(m=>[m,()=>{calls++;assert.fail();}]));await assert.rejects(runMemberConnections(plan,boundary),/MEMBER_CASE_EXACT_TARGET_REQUIRED/);assert.equal(calls,0);
 assert.equal(createMemberPipeBoundary(user(1),()=>{},async()=>({})).prepareCompletedRetirement,undefined);
});

test('v2 고정3methods는 원run/user/withdrawal만 보내고 임의SQL·토큰·flag 전송0',async()=>{
 const id=user(1),sent=[];let reply;const boundary=createMemberPipeBoundary(id,packet=>{sent.push(packet);reply={requestId:id,sequence:packet.sequence,ok:true,value:{privateModel:true}};},async()=>reply,2),base={runId:id,bindingSha256:hash,userId:user(6)};
 await boundary.prepareCompletedRetirement(base);await boundary.inspectCompletedRetirement({...base,withdrawalId:user(710)});await boundary.cleanupCompletedRetirement({...base,withdrawalId:user(710)});
 assert.deepEqual(sent.map(p=>[p.method,p.sequence]),[['prepareCompletedRetirement',1],['inspectCompletedRetirement',2],['cleanupCompletedRetirement',3]]);
 for(const patch of [{sql:'select private'},{approved:true},{token:user(88)},{userId:'bad'},{runId:user(2)},{withdrawalId:'bad'}])await assert.rejects(boundary.inspectCompletedRetirement({...base,withdrawalId:user(710),...patch}));assert.equal(sent.length,3);
});

test('completed metadata는 exact owned2tasks/lease/ACK/권한/physical 사실을 강제하고 원문추가를 거절',()=>{
 const fixture=completedFixture(),valid=initialCompleted();assert.deepEqual(validateCompletedRetirementFixture(fixture,user(6)),fixture);assert.deepEqual(validateCompletedRetirementInspection(valid,fixture),valid);
 for(const changed of [{...fixture,userId:user(5)},{...fixture,objectBytes:2097153},{...fixture,objectSha256:'bad'},{...fixture,key:'private'}])assert.throws(()=>validateCompletedRetirementFixture(changed,user(6)));
 for(const changed of [{...valid,userId:user(5)},{...valid,tasks:[valid.tasks[0],valid.tasks[0]]},{...valid,tasks:[...valid.tasks].reverse()},{...valid,otherFivePreserved:false},{...valid,otherFivePreserved:'true'},{...valid,storageBytesPresent:'false'},{...valid,state:'completed'},{...valid,raw:'PRIVATE_BODY'},{...valid,tasks:[{...valid.tasks[0],objectId:user(999)},valid.tasks[1]]},{...valid,tasks:[{...valid.tasks[0],state:'running'},valid.tasks[1]]},{...valid,tasks:[{...valid.tasks[0],ack:{receiptId:user(888),ackSha256:hash,rowSha256:hash}},valid.tasks[1]]}])assert.throws(()=>validateCompletedRetirementInspection(changed,fixture));
 const path='https://127.0.0.1:65499/functions/v1/service-api';
 for(const suffix of ['/internal/member-cleanup','/internal/member-cleanup/reconcile','/internal/member-cleanup/reconcile/finalize'])assert.doesNotThrow(()=>validateCompletedBridgeRoute(new URL(path+suffix),'POST',fixture));
 assert.doesNotThrow(()=>validateCompletedBridgeRoute(new URL(path+'/me/retirement?withdrawalId='+fixture.withdrawalId),'GET',fixture));
 for(const [method,suffix]of [['POST','/internal/member-cleanup?approved=1'],['GET','/internal/member-cleanup'],['GET','/me/retirement?withdrawalId='+user(2)],['GET','/me/retirement?withdrawalId='+fixture.withdrawalId+'&withdrawalId='+fixture.withdrawalId],['POST','/conversations/'+user(31)+'/read/messages']])assert.throws(()=>validateCompletedBridgeRoute(new URL(path+suffix),method,fixture));
});

/** 원 ACK/UNKNOWN 순서만 흉내 내는 stateful 모형. actual Auth/SQL/Storage 증거가 아니다. */
function completionModel(mode,{corruptDuringWait=false,neverExpires=false}={}){
 const f=completedFixture(),native=initialCompleted(),events=[],clock={ms:Date.parse('2026-10-14T01:00:00Z')};let opens=0,first=0,cleanup=0,ackWrites=0,deletes=0;
 const iso=delta=>new Date(clock.ms+delta).toISOString(),auth=native.tasks[1],storage=native.tasks[0];
 const complete=t=>{t.state='completed';t.leaseToken=null;t.workerRunToken=null;t.leaseExpiresAt=null;t.evidenceSha256=hash;t.completedAt=iso(0);};
 const ports={
  async retireFirst(){events.push('post');assert.equal(++first,1);throw Error('MODELED_POST_RESPONSE_LOSS');},
  async receipt(){events.push('get-'+(native.state==='completed'?'completed':'processing'));return{withdrawalId:f.withdrawalId,status:native.state==='completed'?'completed':'processing',memberAccessRevoked:true};},
  async inspect(){events.push('inspect');return structuredClone(native);},
  async open(){events.push('open');assert.ok(++opens<=2);return{token:user(730+opens),expiresAt:iso(180000)};},
  async budget(){events.push('budget');return{remainingMs:179000};},
  async prepare(i){events.push('prepare');assert.equal(native.invocations.length,0);assert.equal(i.requestId,f.invocationRequestId);assert.equal(i.kind,'member_cleanup');assert.equal(i.limit,2);native.invocations=[{...i,state:'prepared',result:null,closedAt:null,rowSha256:hash}];return{requestId:i.requestId,state:'prepared',fresh:true};},
  async cleanup(i){events.push('cleanup');assert.equal(++cleanup,1);assert.equal(i.globalToken,native.invocations[0].globalToken);deletes+=2;
   for(const t of native.tasks){t.dispatch={dispatchId:user(t.kind==='storage_object'?740:741),rowSha256:hash};t.leaseToken=user(t.kind==='storage_object'?742:743);t.workerRunToken=i.globalToken;t.leaseExpiresAt=iso(neverExpires?240000:2000);}
   storage.ack={receiptId:user(744),ackSha256:hash,rowSha256:hash};ackWrites++;complete(storage);
   auth.state='running';if(mode==='ack_loss'){auth.ack={receiptId:user(745),ackSha256:hash,rowSha256:hash};ackWrites++;native.ackSha256=hash;}
   native.authUserPresent=false;native.storageObjectPresent=false;native.storageBytesPresent=false;return{status:503};},
  async unknown(id){events.push('unknown');assert.equal(id,f.invocationRequestId);native.invocations[0].state='unknown';return structuredClone(native.invocations[0]);},
  async close(lease){events.push('release');assert.equal(lease.token,native.invocations[0].globalToken);return{status:'applied'};},
  async reconcile(args,token){events.push('reconcile');assert.equal(mode,'ack_loss');assert.equal(args.taskId,auth.taskId);assert.ok(Date.parse(auth.leaseExpiresAt)<=clock.ms);assert.equal(token,user(732));complete(auth);native.state='completed';native.reconciliations=[{...args,state:'completed',evidenceSha256:hash,rowSha256:hash}];return{status:200,data:{status:'applied',evidenceSha256:hash}};},
  async reconciliation(binding){events.push('recovery-get');assert.equal(binding.taskId,auth.taskId);return{state:'completed',original:{ackReceiptId:auth.ack.receiptId,ackSha256:auth.ack.ackSha256,globalToken:native.invocations[0].globalToken,jobLeaseToken:user(743)},evidenceSha256:hash};},
  async discover(){events.push('discover');assert.equal(native.invocations[0].state,'unknown');return{items:[{invocationRequestId:f.invocationRequestId}],nextAfterRequestId:f.invocationRequestId};},
  async finalize(id){events.push('finalize');assert.equal(id,f.invocationRequestId);assert.equal(native.reconciliations[0]?.state,'completed');Object.assign(native.invocations[0],{state:'completed',closedAt:iso(0),result:{status:'ran',counts:{claimed:2,succeeded:2,retried:0,failed:0,superseded:0,yielded:0}}});return{status:200,data:{status:'completed'}};},
  async invocation(id){events.push('parent-get');assert.equal(id,f.invocationRequestId);return structuredClone(native.invocations[0]);},
 };
 const timing={now:()=>clock.ms,monotonic:()=>clock.ms,sleep:async ms=>{assert.ok(ms>0&&ms<=5000);events.push('natural-wait');clock.ms+=neverExpires?120000:ms;if(corruptDuringWait)native.scopeRowsSha256='b'.repeat(64);}};
 return{f,native,ports,timing,events,counts:()=>({opens,first,cleanup,ackWrites,deletes})};
}

test('ACK 응답 유실 모형은 자연만료→원tokenrelease→새token→원ACK GET복구→발견→부모종결 순서이며 ACK/DELETE 추가0',async()=>{
 const model=completionModel('ack_loss'),proof=await performCompletedRetirement(model.f,'ack_loss',model.ports,model.timing);
 assert.equal(proof.status,'ROOT_ATTESTATION_REQUIRED');assert.equal(proof.completed,true);assert.equal(proof.originalAckPreserved,true);assert.equal(proof.ackRecreated,0);assert.equal(proof.repeatedDelete,0);
 assert.deepEqual(model.counts(),{opens:2,first:1,cleanup:1,ackWrites:2,deletes:2});assert.equal(model.events.filter(x=>x==='prepare').length,1);
 const filtered=model.events.filter(x=>!['inspect','natural-wait'].includes(x));assert.deepEqual(filtered,['post','get-processing','open','budget','prepare','cleanup','unknown','release','open','reconcile','recovery-get','discover','finalize','parent-get','get-completed']);
 assert.ok(model.events.includes('natural-wait'));assert.equal(model.native.tasks[1].ack.receiptId,user(745));
});

test('DELETE 응답 유실 모형은 ACK없는 UNKNOWN·processing을 유지하고 recovery/finalize/재DELETE0',async()=>{
 const model=completionModel('delete_loss'),before=structuredClone(model.native),proof=await performCompletedRetirement(model.f,'delete_loss',model.ports,model.timing);
 assert.equal(proof.completed,false);assert.equal(proof.completion,'UNKNOWN_ACK_ABSENT');assert.equal(model.native.state,'pending_cleanup');assert.equal(model.native.tasks[1].ack,null);assert.equal(model.native.invocations[0].state,'unknown');assert.equal(model.native.tasks[1].state,'running');assert.equal(model.native.ackSha256,null);
 assert.deepEqual(model.counts(),{opens:1,first:1,cleanup:1,ackWrites:1,deletes:2});assert.ok(!model.events.some(e=>['release','reconcile','finalize','discover','parent-get','natural-wait'].includes(e)));assert.equal(model.native.otherFivePreserved,before.otherFivePreserved);
});

test('자연lease 대기 중 원snapshot 변경·전체상한은 복구를 중단하고 원ACK/UNKNOWN을 보존',async()=>{
 for(const options of [{corruptDuringWait:true},{neverExpires:true}]){
  const model=completionModel('ack_loss',options);await assert.rejects(performCompletedRetirement(model.f,'ack_loss',model.ports,model.timing),/MEMBER_CASE_COMPLETION_(NATURAL_LEASE_MUTATION|LEASE_WAIT_TIMEOUT)/);
  assert.equal(model.native.invocations[0].state,'unknown');assert.equal(model.native.tasks[1].ack.receiptId,user(745));assert.equal(model.native.tasks[1].state,'running');assert.ok(!model.events.includes('reconcile'));assert.equal(model.counts().deletes,2);assert.equal(model.counts().ackWrites,2);
 }
 const backward=completionModel('ack_loss',{neverExpires:true}),wall=backward.timing.now();backward.timing.now=()=>wall-60000;
 await assert.rejects(performCompletedRetirement(backward.f,'ack_loss',backward.ports,backward.timing),/MEMBER_CASE_COMPLETION_LEASE_WAIT_TIMEOUT/);
 assert.equal(backward.native.invocations[0].state,'unknown');assert.ok(!backward.events.includes('reconcile'));
});

test('유실 주입은 정상 원Auth ACK/DELETE 응답에만 적용하고 다른task·Storage ACK·원문/오류는 먼저 거절',()=>{
 const args={p_task_id:user(721),p_ack_sha256:hash},ack={receiptId:user(745),taskId:args.p_task_id,kind:'auth_user',objectId:null,evidenceSha256:hash};let injected=0;
 const inject=(mode,response)=>{validateCompletedLossResponse(mode,response,args);injected++;};
 inject('ack_loss',ack);inject('delete_loss',{});
 for(const response of [null,{...ack,taskId:user(720)},{...ack,kind:'storage_object',objectId:user(711)},{...ack,evidenceSha256:'b'.repeat(64)},{...ack,body:'PRIVATE_BODY'},{code:'42501',message:'PRIVATE_BODY'}])assert.throws(()=>inject('ack_loss',response));
 for(const response of [null,[],{id:user(6)},{message:'PRIVATE_BODY'}])assert.throws(()=>inject('delete_loss',response));assert.equal(injected,2);
});
