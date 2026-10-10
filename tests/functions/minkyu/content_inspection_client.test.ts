import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createContentTicketIssuer,createContentTicketReader,createContentWriteClient} from '../../../backend/supabase/functions/_shared/db/content-inspection-client.ts';
import {loadRuntimeConfig} from '../../../backend/supabase/functions/_shared/config/env.ts';
import {requirePrincipal,type Principal} from '../../../backend/supabase/functions/_shared/auth/principal.ts';
import type {ContentScope} from '../../../backend/supabase/functions/_shared/services/content-inspection.ts';
const user='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222',operation='33333333-3333-4333-8333-333333333333',ticket='44444444-4444-4444-8444-444444444444';
const values={SUPABASE_URL:'https://local.example.invalid',SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',INTERNAL_WORKER_SECRET:'fixture_secret_longer_than_32_characters',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'1000'};
const config=loadRuntimeConfig(k=>(values as Record<string,string>)[k]);
const scope:ContentScope={userId:user,operationId:operation,action:'chat_message',targetId:target,input:{p_request_id:target,p_message_id:operation,p_content:'합성 메시지'}};
const bound={ticketId:ticket,userId:user,operationId:operation,action:'chat_message',targetId:target};
const receipt={...bound,decision:'allow',confirmed:false,consumed:false,expiresAt:'2099-01-01T00:00:00Z'};
function req(headers:Record<string,string>={}){return new Request(config.supabaseUrl+'/functions/v1/service-api/conversations/'+target+'/messages',{method:'POST',headers:{authorization:'Bearer synthetic.token.signature',...headers}});}
async function principal(){return requirePrincipal(req(),config,async()=>Response.json({id:user,role:'authenticated',is_anonymous:false}));}
function transport(reply:unknown=receipt){const calls:any[]=[];return{calls,fetch:async(url:any,init:any)=>{const name=String(url).split('/').at(-1);calls.push({name,body:JSON.parse(init.body),headers:new Headers(init.headers),signal:init.signal});return Response.json(name==='get_my_content_inspection_ticket'?reply:{messageId:operation,createdAt:'2026-10-09T00:00:00Z',alreadySent:false});}};}
test('issuer는 고정 내부 RPC와 전체 입력·버전을 결합하고 원문을 오류로 내보내지 않는다',async()=>{
 const calls:any[]=[];const issuer=createContentTicketIssuer(config,async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)});return Response.json(bound);});
 assert.deepEqual(await issuer.issue({...scope,decision:'allow',policyVersion:'test',scannerVersion:'test'},new AbortController().signal),bound);
 assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/issue_content_inspection_ticket'));assert.equal(calls[0].headers.get('authorization'),'Bearer fixture-service');assert.deepEqual(calls[0].body.p_input,scope.input);
});
test('원 검증 JWT로 ticket을 조회한 뒤 정확한 두 키와 같은 입력으로 한 번 저장한다',async()=>{
 const f=transport();const db=createContentWriteClient(config,await principal(),req({'x-content-operation-id':operation,'x-content-inspection-ticket':ticket}),f.fetch);
 await db.rpc('send_conversation_message',scope.input as any);assert.deepEqual(f.calls.map(c=>c.name),['get_my_content_inspection_ticket','send_conversation_message']);
 assert.equal(f.calls[1].headers.get('authorization'),'Bearer synthetic.token.signature');assert.equal(f.calls[1].headers.get('apikey'),'fixture-anon');assert.equal(f.calls[1].headers.get('x-content-operation-id'),operation);assert.equal(f.calls[1].headers.get('x-content-inspection-ticket'),ticket);assert.deepEqual(f.calls[1].body,scope.input);
});
test('읽기 호출은 검사하지 않으며 검증되지 않은 Principal로 전송 권한을 얻을 수 없다',async()=>{
 const f=transport();const db=createContentWriteClient(config,await principal(),req(),f.fetch);await db.rpc('get_my_profile',{});assert.deepEqual(f.calls.map(c=>c.name),['get_my_profile']);
 assert.throws(()=>createContentWriteClient(config,{userId:user} as Principal,req(),f.fetch));assert.equal(f.calls.length,1);
});
test('키 누락·partial·다른 원 메시지 ID는 ticket조회와 쓰기 전에 거절한다',async()=>{
 const p=await principal();for(const h of [{},{'x-content-operation-id':operation},{'x-content-operation-id':'bad','x-content-inspection-ticket':ticket}]){const f=transport();await assert.rejects(createContentWriteClient(config,p,req(h),f.fetch).rpc('send_conversation_message',scope.input as any));assert.equal(f.calls.length,0);}
 const f=transport();await assert.rejects(createContentWriteClient(config,p,req({'x-content-operation-id':operation,'x-content-inspection-ticket':ticket}),f.fetch).rpc('send_conversation_message',{...scope.input,p_message_id:target}));assert.equal(f.calls.length,0);
});
test('다른 binding·차단·미확인·만료·추가 원문 receipt는 조회 뒤 쓰기를 시작하지 않는다',async()=>{
 const p=await principal();for(const change of [{userId:target},{targetId:user},{action:'review'},{decision:'block'},{decision:'confirm_required',confirmed:false},{expiresAt:'2020-01-01T00:00:00Z'},{rawText:'원문'}]){
  const f=transport({...receipt,...change});await assert.rejects(createContentWriteClient(config,p,req({'x-content-operation-id':operation,'x-content-inspection-ticket':ticket}),f.fetch).rpc('send_conversation_message',scope.input as any));assert.deepEqual(f.calls.map(c=>c.name),['get_my_content_inspection_ticket']);
 }
});
test('소비한 원 ticket은 만료 이후에도 같은 SQL 저장 RPC의 get-only 성공 복구로만 전달한다',async()=>{
 const f=transport({...receipt,consumed:true,expiresAt:'2020-01-01T00:00:00Z'});await createContentWriteClient(config,await principal(),req({'x-content-operation-id':operation,'x-content-inspection-ticket':ticket}),f.fetch).rpc('send_conversation_message',scope.input as any);assert.equal(f.calls.length,2);
});
test('확인은 애매한 원 채팅의 사용자·대상·입력 결합만 전송하며 고위험 해제를 생성하지 않는다',async()=>{
 const calls:any[]=[];const reader=createContentTicketReader(config,await principal(),new AbortController().signal,async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)});return Response.json(bound);});
 assert.deepEqual(await reader.confirm(ticket,scope),{ticketId:ticket,operationId:operation});assert.equal(calls.length,1);assert.deepEqual(calls[0].body.p_input,scope.input);assert.equal(calls[0].headers.get('authorization'),'Bearer synthetic.token.signature');
 await assert.rejects(reader.confirm(ticket,{...scope,userId:target}));await assert.rejects(reader.confirm(ticket,{...scope,action:'review'}));assert.equal(calls.length,1);
});
test('ticket조회 응답 유실·쓰기 응답 유실·이미 중단된 요청은 자동 재조회나 재전송하지 않는다',async()=>{
 const p=await principal();let calls=0;const f=async()=>{calls++;throw new Error('private text');};
 await assert.rejects(createContentWriteClient(config,p,req({'x-content-operation-id':operation,'x-content-inspection-ticket':ticket}),f).rpc('send_conversation_message',scope.input as any));assert.equal(calls,1);
 calls=0;const writeLoss=async(url:any)=>{calls++;if(String(url).endsWith('/get_my_content_inspection_ticket'))return Response.json(receipt);throw new Error('private write response');};
 await assert.rejects(createContentWriteClient(config,p,req({'x-content-operation-id':operation,'x-content-inspection-ticket':ticket}),writeLoss).rpc('send_conversation_message',scope.input as any));assert.equal(calls,2);
 const abort=new AbortController();abort.abort();const request=new Request(req({'x-content-operation-id':operation,'x-content-inspection-ticket':ticket}),{signal:abort.signal});calls=0;await assert.rejects(createContentWriteClient(config,p,request,f).rpc('send_conversation_message',scope.input as any));assert.equal(calls,0);
});
