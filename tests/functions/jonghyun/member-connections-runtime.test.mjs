/** 준비·pipe·원 JWT metadata의 모형 검사다. 실제 Root/DB/Auth/VM을 호출하지 않는다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateMemberInput,validateIssuedMembers,runMemberConnections,createMemberPipeBoundary,MEMBER_METHODS,MEMBER_ARG_KEYS,validateReadBoundaryFixture,validateReadBoundaryInspection,assertReadBoundaryUnchanged,assertReadBoundaryFirstReads,validateMemberBridgeRoute} from '../../integration/jonghyun/member-connections-rest.mjs';
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
