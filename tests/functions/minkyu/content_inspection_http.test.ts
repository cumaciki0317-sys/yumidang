import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createContentInspectionExecutor} from '../../../backend/supabase/functions/service-api/content-inspection-http.ts';
import {loadRuntimeConfig} from '../../../backend/supabase/functions/_shared/config/env.ts';
const user='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222',operationId='33333333-3333-4333-8333-333333333333',ticketId='44444444-4444-4444-8444-444444444444';
const vals={SUPABASE_URL:'https://local.example.invalid',SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',INTERNAL_WORKER_SECRET:'fixture_secret_longer_than_32_characters',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'1000'};
const config=loadRuntimeConfig(k=>(vals as Record<string,string>)[k]),ready={approved:true as const,decisionId:'test',policyVersion:'test',scannerVersion:'test'};
const body={rpc:'send_conversation_message',operationId,input:{p_request_id:target,p_message_id:operationId,p_content:'합성 대화 원문'}};
function req(value:unknown=body,token='synthetic.token.signature'){return new Request(config.supabaseUrl+'/functions/v1/service-api/content-inspections',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(value)});}
function fixture(decision:'allow'|'confirm_required'|'block'='allow',approval:any=ready,authStatus=200){const calls:any[]=[],inspected:any[]=[];const execute=createContentInspectionExecutor(config,approval,{inspect:async input=>{inspected.push(input);return {decision,reasons:decision==='allow'?[]:decision==='block'?['HIGH_RISK']:['AMBIGUOUS_RISK']};}},async(url,init)=>{
 const path=new URL(String(url)).pathname;if(path==='/auth/v1/user'){calls.push({path});return Response.json({id:user,role:'authenticated'},{status:authStatus});}
 const input=JSON.parse(String(init?.body));calls.push({path,input,headers:new Headers(init?.headers)});return Response.json({ticketId,userId:user,operationId,action:'chat_message',targetId:target});
 });return {execute,calls,inspected};}
test('인증 뒤 허용/확인/차단은 typed ticket으로 반환하고 실제 저장은 호출하지 않는다',async()=>{
 for(const decision of ['allow','confirm_required','block'] as const){const f=fixture(decision),response=await f.execute(req(),'inspect'),r=await response.json();assert.equal(response.status,200);assert.equal(r.data.decision,decision);assert.equal(r.data.ticketId,ticketId);assert.equal(JSON.stringify(r).includes(body.input.p_content),false);assert.deepEqual(f.calls.map(c=>c.path),['/auth/v1/user','/rest/v1/rpc/issue_content_inspection_ticket']);assert.deepEqual(f.calls[1].input.p_input,body.input);assert.equal(f.calls[1].headers.get('authorization'),'Bearer fixture-service');}
});
test('미인증·Auth거절·장애는 분류와 발급을 시작하지 않는다',async()=>{
 for(const [token,status,expected] of [['',200,401],['synthetic.token.signature',403,401],['synthetic.token.signature',503,503]] as const){const f=fixture('allow',ready,status);assert.equal((await f.execute(req(body,token),'inspect')).status,expected);assert.equal(f.inspected.length,0);assert.equal(f.calls.filter(c=>c.path.includes('/rpc/')).length,0);}
});
test('승인되지 않은 검사기·요청의 사용자/승인값·미지원 RPC는 새 ticket을 발급하지 않는다',async()=>{
 const closed=fixture('allow',null);assert.equal((await closed.execute(req(),'inspect')).status,503);assert.equal(closed.inspected.length,0);
 for(const value of [{...body,userId:user},{...body,approved:true},{...body,rpc:'retire_my_account'},{...body,input:{...body.input,confirmed:true}}]){const f=fixture();assert.equal((await f.execute(req(value),'inspect')).status,400);assert.equal(f.inspected.length,0);assert.equal(f.calls.length,1);}
});
test('확인은 원 사용자 JWT와 정확한 원 메시지 입력을 전용 DB RPC에만 전달한다',async()=>{
 const f=fixture(),r=await f.execute(req({...body,ticketId}),'confirm');assert.equal(r.status,200);assert.equal(f.inspected.length,0);assert.deepEqual(f.calls.map(c=>c.path),['/auth/v1/user','/rest/v1/rpc/confirm_my_content_inspection_ticket']);assert.equal(f.calls[1].headers.get('authorization'),'Bearer synthetic.token.signature');assert.deepEqual(f.calls[1].input.p_input,body.input);
});
test('고위험 차단을 확인값으로 바꾸거나 공개 내용의 확인을 전송할 수 없다',async()=>{
 const f=fixture();assert.equal((await f.execute(req({...body,ticketId,confirmed:true}),'confirm')).status,400);assert.equal(f.calls.length,1);
 const publicBody={rpc:'set_my_profile_traits',operationId,input:{p_interests:[],p_conversation_styles:[],p_mbti:null},ticketId};assert.equal((await f.execute(req(publicBody),'confirm')).status,400);assert.equal(f.calls.filter(c=>c.path.includes('/rpc/')).length,0);
});

test('검사기가 취소를 무시해도 서버 시간 상한에 종료하며 늦은 allow는 ticket을 발급하지 않는다',async()=>{
 let resolve!:(v:any)=>void;const pending=new Promise<any>(r=>resolve=r);const calls:string[]=[];
 const execute=createContentInspectionExecutor({...config,upstreamTimeoutMs:10},ready,{inspect:async()=>pending},async(url)=>{calls.push(new URL(String(url)).pathname);return Response.json({id:user,role:'authenticated'});});
 const response=await execute(req(),'inspect');assert.equal(response.status,503);assert.deepEqual(calls,['/auth/v1/user']);
 resolve({decision:'allow',reasons:[]});await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['/auth/v1/user']);
});
