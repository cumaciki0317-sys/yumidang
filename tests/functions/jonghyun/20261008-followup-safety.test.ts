import test from "node:test";
import assert from "node:assert/strict";
import { createSafetyConsumerRegistry, createSafetyWorkerInvocation, type SafetyConsumerPorts } from "../../../backend/supabase/functions/_shared/jobs/safety-consumers.ts";
import { loadRuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import { JobExecutionUnknown } from "../../../backend/supabase/functions/_shared/jobs/retry.ts";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const job={jobId:id(1),leaseToken:id(2),leaseUntil:"2099-01-01T00:00:00Z",failedAttempts:0,reference:{kind:"report_retention" as const,reportId:id(3),closureProofId:id(4)}};
const meta={taskId:id(5),taskLeaseToken:id(6),taskExpiresAt:"2098-01-01T00:00:00Z",reportId:id(3),closureRevision:1,kind:"report_metadata",assetId:null,bucketId:null,objectName:null,objectId:null,retentionDueAt:"2026-01-01T00:00:00Z",closureProofId:id(4)};
function fixture(limit:number){
 let count=0,claims=0;const rpc:string[]=[],items:unknown[]=[];
 const tasks=[{...meta,kind:"storage_object",taskId:id(10),assetId:id(11),objectId:id(12),bucketId:"report-evidence",objectName:`${id(3)}/${id(11)}.jpg`},meta];
 const p:SafetyConsumerPorts={readiness:{scopedClaim:true,sharedBudgetContract:true,durableJournalContract:true,cancellationGuardAndAcl:true,reportGuardAndAcl:true,reportTerminalScheduleContract:true,storageProviderApproved:true},
 budget:{globalToken:id(8),signal:new AbortController().signal,elapsed:()=>0,readRemaining:async()=>({remainingMs:10000}),reserve:async op=>{rpc.push(op);return true;},hasItemCapacity:()=>count<limit,reserveItem:async item=>{items.push(item);if(count>=limit)return false;count++;return true;}},
 journal:{prepare:async()=>{},confirmed:async()=>{},unknown:async()=>{}},cancellationProcess:async()=>({status:"applied",generation:1,changed:true}),
 reportClaim:async()=>{claims++;return tasks.shift()??null;},reportStorage:async()=>({evidenceSha256:"a".repeat(64)}),metadataEvidence:async()=>"a".repeat(64),reportComplete:async({task})=>({taskId:task.taskId,status:"completed",alreadyApplied:false})};
 return{p,rpc,items,claims:()=>claims};
}
test("attachment DELETE and completion consume one item, metadata consumes a second",async()=>{
 const f=fixture(2);assert.equal((await createSafetyConsumerRegistry(f.p).report_retention!(job)).status,"completed_by_handler");
 assert.equal(f.items.length,2);assert.equal(f.claims(),2);assert.deepEqual(f.rpc,["report_task_claim","report_storage","report_task_claim","report_task_complete"]);
 assert.deepEqual(f.items,[{kind:"report_retention",jobId:id(1),taskId:id(10)},{kind:"report_retention",jobId:id(1),taskId:id(5)}]);
});
test("one remaining item finishes its DELETE/ACK and starts no next task claim",async()=>{
 const f=fixture(1);assert.equal((await createSafetyConsumerRegistry(f.p).report_retention!(job)).status,"held");assert.equal(f.claims(),1);assert.equal(f.items.length,1);
});
test("atomic item reservation refusal starts no destructive processing",async()=>{
 const f=fixture(2);let deletes=0,complete=0;f.p.budget.reserveItem=async()=>false;f.p.reportStorage=async()=>{deletes++;return{evidenceSha256:"a".repeat(64)}};f.p.reportComplete=async()=>{complete++;throw new Error();};
 assert.equal((await createSafetyConsumerRegistry(f.p).report_retention!(job)).status,"held");assert.equal(deletes+complete,0);
});
test("lost item reservation response is UNKNOWN, not retry or destructive call",async()=>{
 const f=fixture(2);f.p.budget.reserveItem=async()=>{throw new Error("lost");};await assert.rejects(createSafetyConsumerRegistry(f.p).report_retention!(job),JobExecutionUnknown);
});
test("missing atomic item port leaves consumers unregistered",()=>{const f=fixture(2);delete (f.p.budget as Partial<typeof f.p.budget>).reserveItem;assert.deepEqual(createSafetyConsumerRegistry(f.p),{});});
const config=loadRuntimeConfig(key=>({SUPABASE_URL:"https://example.supabase.co",SUPABASE_ANON_KEY:"a",SUPABASE_SERVICE_ROLE_KEY:"s",INTERNAL_WORKER_SECRET:"x".repeat(32),UPSTREAM_TIMEOUT_MS:"1000",MAX_REQUEST_BYTES:"10000",ALLOWED_ORIGINS:"[]"} as Record<string,string>)[key]);
for(const allocation of [{maxJobsPerRun:2,enqueueLimit:1},{maxJobsPerRun:1,enqueueLimit:2}])test("allocation cannot exceed invocation remainder "+JSON.stringify(allocation),async()=>{
 const f=fixture(2);let calls=0;const journal={prepare:async()=>{},confirmed:async()=>{},unknown:async()=>{}};
 const invoke=createSafetyWorkerInvocation(config,{readiness:f.p.readiness,journal:f.p.journal,claimJournal:journal,settlementJournal:journal,enqueueJournal:journal,allocate:()=>allocation,reserve:async()=>true,reserveItem:async()=>true,elapsed:()=>0,workerId:id(9),jobLeaseDurationMs:60000,retry:{maxAttempts:3,baseDelayMs:1000,maxDelayMs:5000},now:()=>new Date()},async()=>{calls++;throw new Error();});
 await assert.rejects(invoke(id(8),"report_retention",{limit:1,remainingMs:1000,signal:new AbortController().signal}),/INVALID_SAFETY_WORKER_ALLOCATION/);assert.equal(calls,0);
});
