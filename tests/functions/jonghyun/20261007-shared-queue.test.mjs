import test from "node:test";
import assert from "node:assert/strict";
import { QUEUE_KINDS, createSharedBackgroundQueueScheduler } from "../../../backend/supabase/functions/_shared/jobs/background.mjs";
const token="00000000-0000-4000-8000-000000000001", ticket="00000000-0000-4000-8000-000000000002";
const now="2026-10-07T00:00:00Z", future="2026-10-07T00:30:00Z";
// 고유 job 슬롯 조회 모형. 유지관리는 별도 배정이며 실제 DB 슬롯 검증과 구분한다.
function fixture(overrides={}) {
  const calls=[],timers=[],errors=[]; let acquired=0,released=0,begun=0,unknown=0,confirmed=0,used=0;
  const left=Object.fromEntries(QUEUE_KINDS.map(k=>[k,0]));
  const repository={
    async schedule({excludeKinds,afterKind,globalToken}) {
      calls.push({type:"schedule",excludeKinds,afterKind,globalToken});
      const start=QUEUE_KINDS.indexOf(afterKind)+1;
      const order=[...QUEUE_KINDS.slice(start),...QUEUE_KINDS.slice(0,start)];
      const nextKind=order.find(k=>left[k]>0&&!excludeKinds.includes(k))??null;
      return {serverNow:now,nextDueAt:nextKind?now:null,nextKind};
    },
    async acquire(){acquired++;used=0;return {token,expiresAt:"2026-10-07T00:03:00Z"};},
    async release(t){assert.equal(t,token);released++;return "applied";},
  };
  const contracts={decisionId:"synthetic-port-contract",
    async readSlots(t){assert.equal(t,token);return {used,remaining:20-used};},
    async readBudget(t){assert.equal(t,token);return {remainingMs:180000};},
    unitsFor(kind,result){return kind===null?result.purged:result.counts?.claimed??0;},
    journal:{async hasPending(){return false;},async begin(ref){assert.equal(ref.globalToken,token);begun++;return ticket;},
      async confirm(t){assert.equal(t,ticket);confirmed++;return true;},async unknown(){unknown++;}},
    maintenance:{async readSchedule(){return {serverNow:now,nextDueAt:null};},async run(){throw new Error("not due");}},
  };
  const options={repository,contracts,queryTimeoutMs:1000,
    async invoke(t,kind,options){assert.equal(t,token);assert.ok(options.limit<=20);assert.ok(options.signal instanceof AbortSignal);calls.push({type:"invoke",kind,limit:options.limit});left[kind]--;used++;return {status:"ran",counts:{claimed:1}};},
    setTimer(fn,ms){const timer={fn,ms};timers.push(timer);return timer;},clearTimer(t){t.cleared=true;},elapsed:()=>0,onError:c=>errors.push(c),
  };
  overrides({options,contracts,repository,left,calls,timers,errors});
  const scheduler=createSharedBackgroundQueueScheduler(options);
  return {scheduler,left,calls,timers,errors,stats:()=>({acquired,released,begun,unknown,confirmed})};
}
test("5종 교대는 한 global 토큰/공유20 모형 예산으로 실행",async()=>{
 const f=fixture(({left})=>QUEUE_KINDS.forEach(k=>left[k]=5));await f.scheduler.wake();
 const invoked=f.calls.filter(c=>c.type==="invoke");assert.deepEqual(invoked.map(c=>c.kind),Array(4).fill(QUEUE_KINDS).flat());
 assert.deepEqual(invoked.map(c=>c.limit),Array.from({length:20},(_,i)=>20-i));
 assert.deepEqual(f.stats(),{acquired:1,released:1,begun:20,unknown:0,confirmed:20});await f.scheduler.stop();
});
test("미지원 종류는 조회에서 제외하고 점유/dispatch하지 않음",async()=>{
 const f=fixture(({options,left})=>{options.supportedKinds=["review_summary"];left.report_retention=2;});
 await f.scheduler.wake();assert.equal(f.stats().acquired,0);assert.ok(f.calls[0].excludeKinds.includes("report_retention"));await f.scheduler.stop();
});
test("빈 큐는 타이머 없이 멈추고 DB 미래 terminal만 별도 timer",async()=>{
 const f=fixture(({contracts})=>contracts.maintenance.readSchedule=async()=>({serverNow:now,nextDueAt:future}));
 await f.scheduler.wake();assert.equal(f.stats().acquired,0);assert.deepEqual(f.timers.filter(t=>!t.cleared).map(t=>t.ms),[1800000]);await f.scheduler.stop();assert.ok(f.timers.every(t=>t.cleared));
});
test("terminal 유지관리는 별도20 배정, 큐 고유20 슬롯을 차감하지 않음",async()=>{
 const f=fixture(({contracts,left,calls})=>{
  left.cancellation_safety=20;contracts.maintenance.readSchedule=async()=>({serverNow:now,nextDueAt:now});
  contracts.maintenance.run=async(t,o)=>{assert.equal(t,token);assert.equal(o.limit,20);calls.push({type:"maintenance"});return {purged:3,processedItems:20};};
 });await f.scheduler.wake();assert.equal(f.calls.filter(c=>c.type==="invoke").length,20);assert.equal(f.calls.filter(c=>c.type==="maintenance").length,1);assert.equal(f.stats().released,1);await f.scheduler.stop();
});
for(const phase of ["invoke","confirm","begin","bad-dto"]) test(`응답 미확인 ${phase}: 해제/재전송0·journal 보존`,async()=>{
 const f=fixture(({left,options,contracts})=>{
  left.report_retention=1;
  if(phase==="invoke")options.invoke=async()=>{throw new Error("response lost");};
  if(phase==="confirm")contracts.journal.confirm=async()=>{throw new Error("ack lost");};
  if(phase==="begin")contracts.journal.begin=async()=>{throw new Error("intent lost");};
  if(phase==="bad-dto")options.invoke=async()=>({status:"ran",counts:{claimed:-1}});
 });await f.scheduler.wake();const before=f.stats();await f.scheduler.wake();assert.deepEqual(f.stats(),before);assert.equal(before.released,0);assert.equal(before.unknown,1);assert.deepEqual(f.errors,["WORKER_QUEUE_RECONCILIATION_REQUIRED"]);await f.scheduler.stop();
});
test("재시작 후 pending journal이 있으면 자연 lease 만료와 무관하게 실행0",async()=>{
 const f=fixture(({left,contracts})=>{left.report_retention=1;contracts.journal.hasPending=async()=>true;});
 await f.scheduler.wake();assert.equal(f.stats().acquired,0);assert.deepEqual(f.errors,["WORKER_QUEUE_RECONCILIATION_REQUIRED"]);await f.scheduler.stop();
});
test("DB budget 0이면 token 연장/재취득 없이 안전 종료",async()=>{
 const f=fixture(({left,contracts})=>{left.cancellation_safety=1;contracts.readBudget=async()=>({remainingMs:0});});
 await f.scheduler.wake();assert.deepEqual(f.stats(),{acquired:1,released:1,begun:0,unknown:0,confirmed:0});await f.scheduler.stop();
});
test("abort 무시하는 요청도 budget deadline에서 UNKNOWN, late 응답 성공 집계0",async()=>{
 let resolve,entered;const pending=new Promise(r=>resolve=r),started=new Promise(r=>entered=r);
 const f=fixture(({left,options})=>{left.report_retention=1;options.invoke=async()=>{entered();return pending;};});
 const waking=f.scheduler.wake();await started;f.timers.find(t=>t.ms===180000).fn();await waking;
 assert.equal(f.stats().released,0);assert.equal(f.stats().confirmed,0);resolve({status:"ran",counts:{claimed:1}});await new Promise(r=>setImmediate(r));await f.scheduler.wake();assert.equal(f.stats().acquired,1);await f.scheduler.stop();
});
test("없는 공통 contract를 기본값/메모리 journal로 대체하지 않음",()=>{
 assert.throws(()=>createSharedBackgroundQueueScheduler({}),/SHARED_QUEUE_CONTRACT_NOT_READY/);
});

test("큐 조회 지연까지 같은 DB 예산에서 차감, 만료 뒤 dispatch0",async()=>{
 let elapsed=0;
 const f=fixture(({options,left,repository,contracts})=>{
  left.cancellation_safety=1;options.elapsed=()=>elapsed;
  contracts.readBudget=async()=>({remainingMs:50});
  const original=repository.schedule;repository.schedule=async scope=>{const result=await original(scope);if(scope.globalToken)elapsed+=60;return result;};
 });await f.scheduler.wake();assert.equal(f.stats().begun,0);assert.equal(f.stats().released,1);await f.scheduler.stop();
});
test("20 이후 due backlog는 후속 cycle timer로 이어가고 빈 큐는 반복0",async()=>{
 const f=fixture(({left})=>left.cancellation_safety=21);await f.scheduler.wake();
 assert.equal(f.calls.filter(c=>c.type==="invoke").length,20);
 const continuation=f.timers.find(t=>!t.cleared&&t.ms===1);assert.ok(continuation);continuation.fn();
 await new Promise(r=>setImmediate(r));assert.equal(f.calls.filter(c=>c.type==="invoke").length,21);assert.equal(f.stats().acquired,2);await f.scheduler.stop();
});
test("끊긴 journal 조회 중 stop은 대기를 중단하고 새 dispatch0",async()=>{
 let entered;const started=new Promise(r=>entered=r);
 const f=fixture(({left,contracts})=>{left.report_retention=1;contracts.journal.hasPending=async()=>{entered();return new Promise(()=>{});};});
 const waking=f.scheduler.wake();await started;await f.scheduler.stop();await waking;assert.equal(f.stats().acquired,0);
});


test("경쟁 점유 실패 뒤 DB 만료 타이머로 새 알림 없이 재개, 조기 dispatch0",async()=>{
 let contended=false,expired=false,attempts=0;
 const f=fixture(({left,repository})=>{
  left.cancellation_safety=1;
  const acquire=repository.acquire,snapshot=repository.schedule;
  repository.acquire=async()=>{attempts++;if(!contended){contended=true;return null;}return acquire();};
  repository.schedule=async scope=>{
   if(contended&&!expired)return {serverNow:now,nextDueAt:"2026-10-07T00:03:00Z",nextKind:"cancellation_safety"};
   return snapshot(scope);
  };
 });
 await f.scheduler.wake();assert.equal(attempts,1);assert.equal(f.stats().begun,0);assert.equal(f.stats().released,0);
 const timer=f.timers.find(t=>!t.cleared&&t.ms===180000);assert.ok(timer);
 expired=true;timer.fn();await new Promise(r=>setImmediate(r));
 assert.equal(attempts,2);assert.equal(f.calls.filter(c=>c.type==="invoke").length,1);assert.equal(f.stats().released,1);
 await f.scheduler.stop();
});
test("경쟁 뒤 DB가 같은 due를 반환해도 재점유 hot loop0",async()=>{
 let attempts=0;
 const f=fixture(({left,repository})=>{left.report_retention=1;repository.acquire=async()=>{attempts++;return null;};});
 await f.scheduler.wake();assert.equal(attempts,1);assert.equal(f.stats().begun,0);assert.equal(f.timers.filter(t=>!t.cleared).length,0);await f.scheduler.stop();
});
test("wake 직후 stop은 이미 중단한 포트의 예약된 호출도 실행하지 않음",async()=>{
 let calls=0;
 const f=fixture(({contracts})=>contracts.journal.hasPending=async()=>{calls++;return false;});
 const waking=f.scheduler.wake();await f.scheduler.stop();await waking;assert.equal(calls,0);assert.equal(f.stats().acquired,0);
});
