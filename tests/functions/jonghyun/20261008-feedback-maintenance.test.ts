import test from "node:test";
import assert from "node:assert/strict";
import { createAiFeedbackMaintenance } from "../../../backend/supabase/functions/_shared/jobs/ai-feedback-maintenance.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { JobExecutionUnknown } from "../../../backend/supabase/functions/_shared/jobs/retry.ts";
const token="00000000-0000-4000-8000-000000000001";
const requestId="00000000-0000-4000-8000-000000000002";
const config=loadRuntimeConfig(key=>({SUPABASE_URL:"https://example.supabase.co",SUPABASE_ANON_KEY:"a",SUPABASE_SERVICE_ROLE_KEY:"s",INTERNAL_WORKER_SECRET:"x".repeat(32),UPSTREAM_TIMEOUT_MS:"10",MAX_REQUEST_BYTES:"10000",ALLOWED_ORIGINS:"[]"} as Record<string,string>)[key]);
const input=()=>({limit:3,remainingMs:1000,signal:new AbortController().signal,requestId});
// Current SQL105 contract persists the allocated limit/request before dispatch.
// A saved completed invocation is required; HTTP success alone is insufficient.
const ports={scopedEndpointReady:true,readSchedule:async()=>({serverNow:"2026-10-08T00:00:00Z",nextDueAt:null}),
 prepare:async()=>({fresh:true}),readResult:async()=>{throw new Error("SYNTHETIC_RESULT_NOT_CONFIRMED");},unknown:async()=>{}};
const completed=(deletedCount:number)=>({requestId,state:"completed",closedAt:"2026-10-08T00:00:00Z",replayed:false,result:{deletedCount}});
test("bounded fixed HTTPS endpoint reserves items first and exposes no original text",async()=>{
 const calls:string[]=[];let dispatched=false;
 const p=createAiFeedbackMaintenance(config,{...ports,prepare:async v=>{assert.equal(v.globalToken,token);assert.equal(v.limit,2);assert.equal(v.requestId,requestId);assert.equal(v.remainingMs,1000);calls.push("reserve");return {fresh:true};},readResult:async id=>{assert.equal(id,requestId);assert.equal(dispatched,true);return completed(1);}},async(url,init)=>{calls.push("fetch");assert.equal(String(url),"https://example.supabase.co/functions/v1/service-api/internal/ai-feedback-maintenance");assert.deepEqual(JSON.parse(String(init?.body)),{limit:2});assert.equal(new Headers(init?.headers).get("x-worker-run-token"),token);assert.equal(new Headers(init?.headers).get("x-worker-request-id"),requestId);dispatched=true;return Response.json({data:{deletedCount:1},requestId:"test"});});
 // Two items are already allocated by the caller; prepare cannot silently resize them.
 assert.deepEqual(await p.run(token,{...input(),limit:2}),{purged:1,processedItems:2});assert.deepEqual(calls,["reserve","fetch"]);
});
test("missing DB due/atomic reservation ports never enables maintenance",()=>{assert.throws(()=>createAiFeedbackMaintenance(config,{} as typeof ports),/NOT_READY/);});
test("zero reservation sends no HTTP request",async()=>{let calls=0;const p=createAiFeedbackMaintenance(config,{...ports,prepare:async()=>{assert.fail("zero allocation must not prepare");}},async()=>{calls++;throw new Error();});assert.deepEqual(await p.run(token,{...input(),limit:0}),{purged:0,processedItems:0});assert.equal(calls,0);});
test("response loss/malformed success remain UNKNOWN",async()=>{for(const result of [()=>Promise.reject(new Error()),()=>Promise.resolve(Response.json({data:{deletedCount:4}}))]){const p=createAiFeedbackMaintenance(config,ports,result);await assert.rejects(p.run(token,input()),JobExecutionUnknown);}});
test("abort ignoring fetch is bounded and never returns late success",async()=>{const p=createAiFeedbackMaintenance(config,ports,async()=>new Promise<Response>(()=>{}));await assert.rejects(p.run(token,input()),JobExecutionUnknown);});

test("unfenced current maintenance endpoint remains disabled even with due ports",()=>{assert.throws(()=>createAiFeedbackMaintenance(config,{...ports,scopedEndpointReady:false}),/NOT_READY/);});

test("persisted same-key completion recovers without a second dispatch",async()=>{
 let calls=0;const p=createAiFeedbackMaintenance(config,{...ports,prepare:async()=>({fresh:false}),readResult:async id=>{assert.equal(id,requestId);return completed(1);}},async()=>{calls++;assert.fail("persisted invocation must not resend");});
 assert.deepEqual(await p.run(token,input()),{purged:1,processedItems:3});assert.equal(calls,0);
});
