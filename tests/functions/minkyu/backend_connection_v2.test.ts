import {test}from'node:test';import assert from'node:assert/strict';
import {createServiceApi}from'../../../backend/supabase/functions/service-api/handler.ts';
import {createWorkerConnectionPorts}from'../../../backend/supabase/functions/_shared/db/worker-runtime-client.ts';
import type{JsonValue}from'../../../backend/supabase/functions/_shared/contracts/common.ts';
const id='ab106000-0000-4000-8000-000000000001';
function setup(){let calls:Array<{name:string,args:Record<string,JsonValue>}>=[];let internal=0;const db={rpc:async(name:string,args:Record<string,JsonValue>)=>{calls.push({name,args});return{deletedCount:0};}};
 const api=createServiceApi({allowedOrigins:[],maxBodyBytes:65536,authenticateUser:async()=>db,authenticateInternal:async()=>{internal++;return db;}});
 return{calls,api,internal:()=>internal,send:(path:string,body:unknown,headers:Record<string,string>={})=>api(new Request('https://api.test.invalid/service-api'+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)}))};}
test('메시지 집합만 회원 경로로 전달하고 중복·빈 목록·추가 입력 거절',async()=>{
 const f=setup();assert.equal((await f.send(`/conversations/${id}/read/messages`,{messageIds:[id]})).status,200);
 assert.deepEqual(f.calls[0],{name:'mark_conversation_messages_read',args:{p_request_id:id,p_message_ids:[id]}});
 for(const body of [{messageIds:[]},{messageIds:[id,id]},{messageIds:[id],userId:id},{messageIds:Array(101).fill(id)},{messageIds:['bad']}])assert.equal((await f.send(`/conversations/${id}/read/messages`,body)).status,400);
 assert.equal(f.calls.length,1);assert.equal(f.internal(),0);
});
test('helpful 내부 endpoint는 token·원 요청키를 요구하고 DB 원자 포트만 호출',async()=>{
 const f=setup();assert.equal((await f.send('/internal/ai-feedback-maintenance',{limit:1})).status,400);assert.equal(f.calls.length,0);
 assert.equal((await f.send('/internal/ai-feedback-maintenance',{limit:1},{'x-worker-run-token':id,'x-worker-request-id':id})).status,200);
 assert.deepEqual(f.calls[0],{name:'purge_ai_feedback_scoped',args:{p_request_id:id,p_global_token:id,p_limit:1}});
});
test('복구 포트는 양쪽 원장의 통합 검사이며 유지관리는 queue 슬롯을 차감하지 않는다',async()=>{
 const names:string[]=[];const ports=createWorkerConnectionPorts({rpc:async(name):Promise<JsonValue>=>{names.push(name);return name==='read_worker_runtime_pending_v2'?{hasPending:true}:name==='purge_ai_feedback_scoped'?{deletedCount:0}:{serverNow:'2026-10-08T00:00:00Z',nextDueAt:null};}});
 assert.equal(await ports.hasPending(),true);assert.deepEqual(await ports.purgeFeedback(id,id,1),{purged:0,processedItems:1});await ports.feedbackSchedule(id);assert.deepEqual(names,['read_worker_runtime_pending_v2','purge_ai_feedback_scoped','read_ai_feedback_maintenance_schedule']);
});
