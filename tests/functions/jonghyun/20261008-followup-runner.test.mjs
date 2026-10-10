import test from "node:test";
import assert from "node:assert/strict";
import {createDueMaintenanceGroup,createSharedBackgroundQueueScheduler} from "../../../backend/supabase/functions/_shared/jobs/background.mjs";
const now="2026-10-08T00:00:00Z",future="2026-10-08T00:05:00Z",token="00000000-0000-4000-8000-000000000001";
test("completion and helpful keep earliest DB due and separate persisted provider allocations",async()=>{
 const calls=[];const group=createDueMaintenanceGroup([
 {readSchedule:async()=>({serverNow:now,nextDueAt:now}),run:async(t,o)=>{calls.push(o.limit);return{purged:2,processedItems:3};}},
 {readSchedule:async()=>({serverNow:now,nextDueAt:now}),run:async(t,o)=>{calls.push(o.limit);return{purged:1,processedItems:1};}}
 ],()=>0);assert.deepEqual(await group.readSchedule(token),{serverNow:now,nextDueAt:now});assert.deepEqual(await group.run(token,{limit:4,remainingMs:1000,signal:new AbortController().signal}),{purged:3,processedItems:4});assert.deepEqual(calls,[4,4]);
});
function scheduler(maintenance,invoke=async()=>{throw new Error("unexpected")},repositoryOverrides={}){
 const timers=[],errors=[];let released=0,used=0;const s=createSharedBackgroundQueueScheduler({supportedKinds:["report_retention"],queryTimeoutMs:1000,
 repository:{schedule:async()=>({serverNow:now,nextDueAt:null,nextKind:null}),acquire:async()=>({token,expiresAt:future}),release:async()=>{released++;return"applied";},...repositoryOverrides},
 contracts:{decisionId:"approved-item-unit-fixture",readBudget:async()=>({remainingMs:10000}),readSlots:async()=>({used,remaining:20-used}),unitsFor:(k,r)=>k===null?r.processedItems:r.counts.processedItems,journal:{hasPending:async()=>false,begin:async()=>token,confirm:async()=>true,unknown:async()=>{}},maintenance},invoke:async(...args)=>{const result=await invoke(...args);used+=result.counts?.claimed??0;return result;},
 setTimer:(fn,ms)=>{const h={fn,ms};timers.push(h);return h;},clearTimer:h=>h.cleared=true,elapsed:()=>0,onError:e=>errors.push(e)});
 return{s,timers,errors,released:()=>released};
}
test("restart wake reads helpful DB due and arms exact timer, stop clears it",async()=>{let reads=0;const f=scheduler({readSchedule:async()=>{reads++;return{serverNow:now,nextDueAt:future};},run:async()=>{throw new Error();}});await f.s.wake();assert.equal(reads,1);assert.deepEqual(f.timers.filter(t=>!t.cleared).map(t=>t.ms),[300000]);await f.s.stop();assert.ok(f.timers.every(t=>t.cleared));});
test("stop aborts ongoing due maintenance and preserves UNKNOWN with no lease release",async()=>{let entered;const started=new Promise(r=>entered=r);const f=scheduler({readSchedule:async()=>({serverNow:now,nextDueAt:now}),run:async(_t,o)=>{entered();return new Promise(()=>{});}});const waking=f.s.wake();await started;await f.s.stop();await waking;assert.equal(f.released(),0);assert.deepEqual(f.errors,["WORKER_QUEUE_RECONCILIATION_REQUIRED"]);});

import {createSharedQueueRuntime} from "../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs";
test("runtime composition counts unique queued jobs while maintenance has separate allocations",()=>{
 const runtime=createSharedQueueRuntime({schedule:async()=>{},invokeSafety:async()=>{},invokeExisting:async()=>{},supportedKinds:["report_retention"],
 contracts:{decisionId:"confirmed-item-policy",readBudget:async()=>{},readSlots:async()=>({used:0,remaining:20}),journal:{hasPending:async()=>false,begin:async()=>{},confirm:async()=>{},unknown:async()=>{}}},
 maintenanceProviders:[{readSchedule:async()=>({serverNow:now,nextDueAt:null}),run:async()=>({purged:0,processedItems:0})}]});
 assert.equal(runtime.contracts.unitsFor("report_retention",{counts:{claimed:1,processedItems:3}}),1);
 assert.equal(runtime.contracts.unitsFor(null,{purged:2,processedItems:3}),3);
 assert.equal(runtime.contracts.unitsFor("review_summary",{counts:{claimed:4}}),4);
 assert.throws(()=>createSharedQueueRuntime({}),/SHARED_QUEUE_CONTRACT_NOT_READY/);
});
test("due helpful with zero item reservation cannot create a hot loop",async()=>{
 let runs=0;const f=scheduler({readSchedule:async()=>({serverNow:now,nextDueAt:now}),run:async()=>{runs++;return{purged:0,processedItems:0};}});
 await f.s.wake();assert.equal(runs,1);assert.equal(f.released(),1);assert.equal(f.timers.filter(t=>!t.cleared).length,0);assert.deepEqual(f.errors,[]);await f.s.stop();
});
test("claimed report without processing item is a valid held response, not unknown mutation",async()=>{
 let due=true,released=0,used=0;const errors=[];
 const s=createSharedBackgroundQueueScheduler({supportedKinds:["report_retention"],queryTimeoutMs:1000,
 repository:{schedule:async({excludeKinds})=>({serverNow:now,nextDueAt:due&&!excludeKinds.includes("report_retention")?now:null,nextKind:due&&!excludeKinds.includes("report_retention")?"report_retention":null}),acquire:async()=>({token,expiresAt:future}),release:async()=>{released++;return"applied";}},
 contracts:{decisionId:"approved-item-unit-fixture",readBudget:async()=>({remainingMs:10000}),readSlots:async()=>({used,remaining:20-used}),unitsFor:(_k,r)=>r.counts.processedItems,journal:{hasPending:async()=>false,begin:async()=>token,confirm:async()=>true,unknown:async()=>assert.fail()},maintenance:{readSchedule:async()=>({serverNow:now,nextDueAt:null}),run:async()=>assert.fail()}},
 invoke:async()=>{used=1;return{status:"ran",counts:{claimed:1,held:1,processedItems:0}};},onError:e=>errors.push(e)});
 await s.wake();await s.stop();assert.equal(released,1);assert.deepEqual(errors,[]);
});

test("late provider due read after abort starts no maintenance mutation",async()=>{
 let resolve,entered,runs=0;
 const waiting=new Promise(r=>resolve=r),started=new Promise(r=>entered=r),abort=new AbortController();
 const group=createDueMaintenanceGroup([{readSchedule:async()=>{entered();return waiting;},run:async()=>{runs++;return{purged:1,processedItems:1};}}],()=>0);
 const run=group.run(token,{limit:20,remainingMs:1000,signal:abort.signal});
 await started;abort.abort();resolve({serverNow:now,nextDueAt:now});
 assert.deepEqual(await run,{purged:0,processedItems:0});assert.equal(runs,0);
});
test("elapsed deadline during provider due read starts no maintenance mutation",async()=>{
 let elapsed=0,runs=0;
 const group=createDueMaintenanceGroup([{readSchedule:async()=>{elapsed=1001;return{serverNow:now,nextDueAt:now};},run:async()=>{runs++;return{purged:1,processedItems:1};}}],()=>elapsed);
 assert.deepEqual(await group.run(token,{limit:20,remainingMs:1000,signal:new AbortController().signal}),{purged:0,processedItems:0});assert.equal(runs,0);
});

test("maintenance-only contention resumes from DB foreign lease expiry without notification",async()=>{
 let contended=false,expired=false,finished=false,runs=0,attempts=0;
 const f=scheduler({
  readSchedule:async()=>({serverNow:now,nextDueAt:finished?null:contended&&!expired?future:now}),
  run:async()=>{runs++;finished=true;return{purged:1,processedItems:1};},
 },undefined,{acquire:async()=>{attempts++;if(!contended){contended=true;return null;}return{token,expiresAt:future};}});
 await f.s.wake();assert.equal(attempts,1);assert.equal(runs,0);
 const retry=f.timers.find(t=>!t.cleared&&t.ms===300000);assert.ok(retry);
 expired=true;retry.fn();await new Promise(r=>setImmediate(r));
 assert.equal(attempts,2);assert.equal(runs,1);assert.equal(f.released(),1);await f.s.stop();
});
test("unadjusted past maintenance schedule supplies no retry and cannot be declared ready",async()=>{
 let runs=0;const f=scheduler({readSchedule:async()=>({serverNow:now,nextDueAt:now}),run:async()=>{runs++;return{purged:1,processedItems:1};}},undefined,{acquire:async()=>null});
 await f.s.wake();assert.equal(runs,0);assert.equal(f.timers.filter(t=>!t.cleared).length,0);await f.s.stop();
});

function mixedDueWithFutureMaintenance(){
 let due=true,reads=0;const f=scheduler({readSchedule:async()=>{reads++;return{serverNow:now,nextDueAt:future};},run:async()=>assert.fail()},async()=>{due=false;return{status:"ran",counts:{claimed:1,processedItems:1}};},{schedule:async()=>({serverNow:now,nextDueAt:due?now:null,nextKind:due?"report_retention":null})});
 return{...f,reads:()=>reads};
}
test("mixed due queue and future maintenance retain one reservation and stop cancels all handles",async()=>{
 const f=mixedDueWithFutureMaintenance();await f.s.wake();
 const futures=f.timers.filter(t=>t.ms===300000);assert.equal(futures.length,2);assert.equal(futures.filter(t=>!t.cleared).length,1);
 await f.s.stop();assert.ok(f.timers.every(t=>t.cleared));
});
test("cancelled old timer callback cannot erase or wake the replacement reservation",async()=>{
 const f=mixedDueWithFutureMaintenance();await f.s.wake();
 const [old,current]=f.timers.filter(t=>t.ms===300000);assert.ok(old.cleared);assert.ok(!current.cleared);
 const reads=f.reads();old.fn();await new Promise(r=>setImmediate(r));
 assert.equal(f.reads(),reads);assert.ok(!current.cleared);
 await f.s.stop();assert.ok(current.cleared);assert.ok(f.timers.every(t=>t.cleared));
});
