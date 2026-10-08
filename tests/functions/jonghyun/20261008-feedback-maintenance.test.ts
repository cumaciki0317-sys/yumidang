import test from "node:test";
import assert from "node:assert/strict";
import { createAiFeedbackMaintenance } from "../../../backend/supabase/functions/_shared/jobs/ai-feedback-maintenance.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { JobExecutionUnknown } from "../../../backend/supabase/functions/_shared/jobs/retry.ts";
const token="00000000-0000-4000-8000-000000000001";
const config=loadRuntimeConfig(key=>({SUPABASE_URL:"https://example.supabase.co",SUPABASE_ANON_KEY:"a",SUPABASE_SERVICE_ROLE_KEY:"s",INTERNAL_WORKER_SECRET:"x".repeat(32),UPSTREAM_TIMEOUT_MS:"10",MAX_REQUEST_BYTES:"10000",ALLOWED_ORIGINS:"[]"} as Record<string,string>)[key]);
const input=()=>({limit:3,remainingMs:1000,signal:new AbortController().signal});
const ports={scopedEndpointReady:true,readSchedule:async()=>({serverNow:"2026-10-08T00:00:00Z",nextDueAt:null}),reserveItems:async()=>3};
test("bounded fixed HTTPS endpoint reserves items first and exposes no original text",async()=>{
 const calls:string[]=[];const p=createAiFeedbackMaintenance(config,{...ports,reserveItems:async(t,n)=>{assert.equal(t,token);assert.equal(n,3);calls.push("reserve");return 2;}},async(url,init)=>{calls.push("fetch");assert.equal(String(url),"https://example.supabase.co/functions/v1/service-api/internal/ai-feedback-maintenance");assert.deepEqual(JSON.parse(String(init?.body)),{limit:2});assert.equal(new Headers(init?.headers).get("x-worker-run-token"),token);return Response.json({data:{deletedCount:1},requestId:"test"});});
 assert.deepEqual(await p.run(token,input()),{purged:1,processedItems:2});assert.deepEqual(calls,["reserve","fetch"]);
});
test("missing DB due/atomic reservation ports never enables maintenance",()=>{assert.throws(()=>createAiFeedbackMaintenance(config,{} as typeof ports),/NOT_READY/);});
test("zero reservation sends no HTTP request",async()=>{let calls=0;const p=createAiFeedbackMaintenance(config,{...ports,reserveItems:async()=>0},async()=>{calls++;throw new Error();});assert.deepEqual(await p.run(token,input()),{purged:0,processedItems:0});assert.equal(calls,0);});
test("response loss/malformed success remain UNKNOWN",async()=>{for(const result of [()=>Promise.reject(new Error()),()=>Promise.resolve(Response.json({data:{deletedCount:4}}))]){const p=createAiFeedbackMaintenance(config,ports,result);await assert.rejects(p.run(token,input()),JobExecutionUnknown);}});
test("abort ignoring fetch is bounded and never returns late success",async()=>{const p=createAiFeedbackMaintenance(config,ports,async()=>new Promise<Response>(()=>{}));await assert.rejects(p.run(token,input()),JobExecutionUnknown);});

test("unfenced current maintenance endpoint remains disabled even with due ports",()=>{assert.throws(()=>createAiFeedbackMaintenance(config,{...ports,scopedEndpointReady:false}),/NOT_READY/);});
