/** Actual product handlers, signed synthetic JWT→HTTPS→PostgREST→TLS DB. OAuth/native excluded. */
import assert from 'node:assert/strict';
import {createServiceApi}from'../../../backend/supabase/functions/service-api/handler.ts';
import {loadRuntimeConfig,type RuntimeConfig}from'../../../backend/supabase/functions/_shared/config/env.ts';
import {createRpcTransport}from'../../../backend/supabase/functions/_shared/db/transport.ts';
import {createInternalClient}from'../../../backend/supabase/functions/_shared/db/internal-client.ts';
import {requireInternalCaller}from'../../../backend/supabase/functions/_shared/auth/internal-caller.ts';
import {HttpError}from'../../../backend/supabase/functions/_shared/http/errors.ts';
import {createAiChatHandler}from'../../../backend/supabase/functions/ai-chat/handler.ts';
import {createRpcAiChatRequestGate}from'../../../backend/supabase/functions/_shared/ai/providers/member-request.ts';
import {recordAiResultAvailable}from'../../../backend/supabase/functions/_shared/db/ai-feedback-client.ts';
import {createRpcAiFeedback}from'../../../backend/supabase/functions/_shared/ai/Agents/chatbot/feedback.ts';
import {createWorkerConnectionPorts}from'../../../backend/supabase/functions/_shared/db/worker-runtime-client.ts';
const root='/private/tmp/yumidang-queue-tls99';const f=JSON.parse(await Deno.readTextFile(root+'/product-connection-private.json'));
let config:RuntimeConfig;let external=0,dropMaintenance=false,maintenanceCalls=0;
const nativeFetch=globalThis.fetch;
const safeFetch:typeof fetch=(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));if(url.hostname!=='127.0.0.1'){external++;throw Error('EXTERNAL_DISABLED');}return nativeFetch(input,init);};
const names=new Set(['get_my_profile','get_my_profile_traits','mark_conversation_read','mark_conversation_messages_read','get_conversation_with_read_state','list_conversations_with_read_state','send_conversation_message','search_public_posts_v2']);
const memberDb=(r:Request)=>{const token=r.headers.get('authorization')?.replace(/^Bearer /,'');if(!token)throw new HttpError('AUTH_REQUIRED');return createRpcTransport(config,f.anonKey,token,names,safeFetch);};
const api=createServiceApi({allowedOrigins:[],maxBodyBytes:65536,authenticateUser:async r=>memberDb(r),authenticateInternal:async r=>{await requireInternalCaller(r,config);return createInternalClient(config,safeFetch);}});
const server=Deno.serve({hostname:'127.0.0.1',port:0,cert:await Deno.readTextFile(root+'/server.crt'),key:await Deno.readTextFile(root+'/server.key'),onListen:()=>{}},async r=>{
 const url=new URL(r.url);
 if(url.pathname.startsWith('/rest/v1/rpc/')){
  const name=url.pathname.split('/').at(-1);if(name==='purge_ai_feedback_scoped')maintenanceCalls++;
  const response=await safeFetch('http://127.0.0.1:61621/rpc/'+name,{method:'POST',headers:r.headers,body:await r.text()});
  if(dropMaintenance&&name==='purge_ai_feedback_scoped'){dropMaintenance=false;await response.arrayBuffer();return new Response(new ReadableStream({start(c){c.error(Error('SYNTHETIC_RESPONSE_LOSS'));}}));}
  return response;
 }
 return url.pathname.startsWith('/ai-chat')?chat(r):api(r);
});
const origin=`https://127.0.0.1:${server.addr.port}`;
const values:Record<string,string>={SUPABASE_URL:origin,SUPABASE_ANON_KEY:f.anonKey,SUPABASE_SERVICE_ROLE_KEY:f.serviceKey,INTERNAL_WORKER_SECRET:f.internalSecret,ALLOWED_ORIGINS:'[]',UPSTREAM_TIMEOUT_MS:'15000',MAX_REQUEST_BYTES:'65536'};config=loadRuntimeConfig(k=>values[k]);
const internal=createInternalClient(config,safeFetch);const connections=createWorkerConnectionPorts(internal);
let recordCalls=0,modelCalls=0;const gate=createRpcAiChatRequestGate(internal);
const chat=createAiChatHandler({allowedOrigins:[],maxBodyBytes:65536,authenticate:async r=>{await memberDb(r).rpc('get_my_profile',{});const token=r.headers.get('authorization')!.slice(7);return{userId:JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).sub};},
 engine:{status:'ready',now:()=>new Date(),limits:{maxMessages:6,maxMessageChars:500,maxTotalChars:1000,maxOutputTokens:100},privacy:{decisionId:'isolated-synthetic-only',check:async()=>true},model:{generate:async()=>{modelCalls++;throw Error('MODEL_DISABLED');}}},
 requestGate:gate,recordResultAvailable:async scope=>{recordCalls++;await recordAiResultAvailable(internal,scope);},feedback:createRpcAiFeedback(internal),
 openSession:()=>({loadPreferences:async()=>({}),discovery:{search:async()=>{throw Error('NOT_REACHED_NO_REGION');},recheck:async()=>{throw Error('NOT_REACHED_NO_REGION');}}})});
async function control(action:string){const p=await new Deno.Command('python3',{args:['tests/integration/minkyu/product_connection_local.py',action],stdout:'piped',stderr:'piped'}).output();assert.equal(p.code,0,'ISOLATED_CONTROL_FAILED');}
async function send(path:string,body:unknown,n=0,headers:Record<string,string>={}){const response=await safeFetch(origin+path,{method:'POST',headers:{authorization:'Bearer '+f.tokens[n],'content-type':'application/json',...headers},body:JSON.stringify(body)});return{status:response.status,value:await response.json()};}
async function checked(path:string,body:unknown,n=0,headers:Record<string,string>={}){const r=await send(path,body,n,headers);assert.equal(r.status,200,JSON.stringify({status:r.status,code:r.value.error?.code}));return r.value.data;}
try{
 await control('--refresh');const base='/service-api/conversations/'+f.requestId;
 await checked(base+'/messages',{messageId:f.messages[1],content:'합성 두 번째 메시지'},1);
 await checked(base+'/read',{lastReadMessageId:f.messages[1]});
 const summary=async()=>{const r=await safeFetch(origin+base,{headers:{authorization:'Bearer '+f.tokens[0]}});assert.equal(r.status,200);return(await r.json()).data[0];};
 assert.equal((await summary()).unread_count,0);assert.equal((await summary()).unread_message_count,2);
 const second=await checked(base+'/read/messages',{messageIds:[f.messages[1]]});assert.equal(second.unreadCount,1);
 const bad=await send(base+'/read/messages',{messageIds:[f.messages[0],crypto.randomUUID()]});assert.equal(bad.status,404);assert.equal((await summary()).unread_message_count,1);
 const repeats=await Promise.all(Array.from({length:6},()=>checked(base+'/read/messages',{messageIds:[f.messages[1]]})));assert.ok(repeats.every(x=>x.unreadCount===1));
 await Promise.all([checked(base+'/read/messages',{messageIds:[f.messages[0]]}),checked(base+'/messages',{messageId:f.messages[2],content:'합성 신규 메시지'},1)]);assert.equal((await summary()).unread_message_count,1);
 assert.equal((await send(base+'/read/messages',{messageIds:[f.messages[0]]},0,{authorization:'Bearer invalid.invalid.invalid'})).status,401);
 const result=await checked('/ai-chat',{clientRequestId:'product107-no-region',messages:[{role:'user',content:'동행 찾기'}],currentFilters:{target:'posts'}});assert.equal(result.status,'needs_clarification');assert.equal(recordCalls,1);assert.equal(modelCalls,0);
 const feedback={clientRequestId:'product107-helpful',requestId:result.requestId,action:'helpful'};
 const feedbacks=await Promise.all(Array.from({length:6},()=>checked('/ai-chat/feedback',feedback)));assert.equal(new Set(feedbacks.map(x=>x.feedbackId)).size,1);
 assert.equal((await send('/ai-chat/feedback',feedback,1)).status,403);
 const headers={authorization:'Bearer '+f.internalSecret,'x-worker-run-token':f.globalToken,'x-worker-request-id':f.maintenanceRequest};
 assert.equal((await send('/service-api/internal/ai-feedback-maintenance',{limit:1},0,{authorization:'Bearer '+f.internalSecret})).status,400);
 const schedule=await connections.feedbackSchedule(f.globalToken);assert.ok(schedule.nextDueAt!==null);
 await control('--age');const own=await connections.feedbackSchedule(f.globalToken);const foreign=await connections.feedbackSchedule(null);assert.ok(Date.parse(own.nextDueAt!)<=Date.parse(own.serverNow));assert.ok(Date.parse(foreign.nextDueAt!)>Date.parse(foreign.serverNow));
 dropMaintenance=true;const lost=await send('/service-api/internal/ai-feedback-maintenance',{limit:1},0,headers);assert.ok(lost.status>=500);assert.equal(maintenanceCalls,1);
 const recovered=await connections.atomic.get(f.maintenanceRequest);assert.equal(recovered.state,'completed');assert.deepEqual(recovered.result,{deletedCount:1});assert.equal(maintenanceCalls,1);
 const same=await checked('/service-api/internal/ai-feedback-maintenance',{limit:1},0,headers);assert.equal(same.deletedCount,1);
 assert.equal((await send('/service-api/internal/ai-feedback-maintenance',{limit:2},0,headers)).status,409);
 assert.equal((await send('/ai-chat/feedback',{...feedback,clientRequestId:'expired-new'})).status,404);
 assert.equal(external,0);
 const receipt={productServiceHandlerHttps:'PASS',signedSyntheticJwtDbValidation:true,realNaverLogin:false,messageSetNoWatermarkBackfill:true,concurrentReadRequests:6,invalidBatchAllOrNothing:true,productAiClarificationReceipt:'PASS',helpfulConcurrentRequests:6,expiredHelpfulDeleted:1,maintenanceResponseLossReadRecovery:true,wrongTokenContextAndDifferentInputDenied:true,competitorMaintenanceFutureSchedule:true,externalRequests:0,operatingChanged:false};await Deno.writeTextFile(root+'/product-http-receipt.json',JSON.stringify(receipt),{mode:0o600});console.log(JSON.stringify(receipt));
}finally{await control('--close');await server.shutdown();}
