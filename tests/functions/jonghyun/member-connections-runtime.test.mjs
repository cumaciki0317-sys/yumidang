/** 준비·pipe·원 JWT metadata의 모형 검사다. 실제 Root/DB/Auth/VM을 호출하지 않는다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validateMemberInput,validateIssuedMembers,runMemberConnections,createMemberPipeBoundary,MEMBER_METHODS} from '../../integration/jonghyun/member-connections-rest.mjs';
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
