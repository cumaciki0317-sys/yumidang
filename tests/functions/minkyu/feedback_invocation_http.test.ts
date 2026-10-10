import assert from "node:assert/strict";
import test from "node:test";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const id="11111111-1111-4111-8111-111111111111", token="22222222-2222-4222-8222-222222222222";
const prepared={requestId:id,globalToken:token,kind:"helpful_maintenance",limit:2,remainingMs:1234,state:"prepared",result:null,closedAt:null};
function request(extra:Record<string,string>={},body="{\"limit\":2}",signal?:AbortSignal){
 return new Request("https://test.invalid/service-api/internal/ai-feedback-maintenance",{method:"POST",headers:{"content-type":"application/json","x-worker-run-token":token,"x-worker-request-id":id,"x-worker-time-budget-ms":"1234",...extra},body,signal});
}
function factory(state:JsonValue=prepared,claimed=true){
 const calls:Array<{name:string;args:Record<string,JsonValue>}>=[];
 const db={async rpc(name:string,args:Record<string,JsonValue>):Promise<JsonValue>{calls.push({name,args});return name==="get_queue_invocation"?state:name==="claim_queue_invocation_dispatch"?{claimed}:{deletedCount:1};}};
 return{calls,run:createServiceApi({allowedOrigins:[],maxBodyBytes:65536,authenticateUser:async()=>{throw Error("NO_MEMBER_AUTH");},authenticateInternal:async()=>db})};
}
test("scoped helpful binds the exact allocation and performs one CAS before purge",async()=>{
 const f=factory();assert.equal((await f.run(request())).status,200);
 assert.deepEqual(f.calls.map(c=>c.name),["get_queue_invocation","claim_queue_invocation_dispatch","purge_ai_feedback_scoped"]);
 assert.deepEqual(f.calls[1].args,{p_request_id:id,p_global_token:token,p_kind:"helpful_maintenance",p_limit:2,p_remaining_ms:1234});
 assert.deepEqual(f.calls[2].args,{p_request_id:id,p_global_token:token,p_limit:2});
});
test("completed, mismatched and already-dispatched invocations never purge again",async()=>{
 for(const state of [{...prepared,globalToken:id},{...prepared,limit:1},{...prepared,remainingMs:1233},{...prepared,kind:"terminal_maintenance"},
  {...prepared,state:"unknown"},{...prepared,state:"completed",closedAt:"2026-10-09T00:00:00Z",result:{purged:1,processedItems:2}}]){
  const f=factory(state);assert.equal((await f.run(request())).status,409);assert.equal(f.calls.length,1);
 }
 const f=factory(prepared,false);assert.equal((await f.run(request())).status,409);
 assert.equal(f.calls.some(c=>c.name==="purge_ai_feedback_scoped"),false);
});
test("invalid body or time allocation and cancelled requests do not consume the CAS",async()=>{
 for(const [header,body]of [["01234","{\"limit\":2}"],["180001","{\"limit\":2}"],["1234","{\"limit\":0}"],["1234","{\"limit\":21}"],["1234","{\"limit\":2,\"approved\":true}"]]){
  const f=factory();assert.equal((await f.run(request({"x-worker-time-budget-ms":header},body))).status,400);assert.equal(f.calls.length,0);
 }
 const controller=new AbortController();controller.abort();const f=factory();
 assert.equal((await f.run(request({},"{\"limit\":2}",controller.signal))).status,409);assert.equal(f.calls.length,0);
});
