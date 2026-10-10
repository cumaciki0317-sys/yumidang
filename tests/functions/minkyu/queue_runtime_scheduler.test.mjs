import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedBackgroundQueueScheduler,createDueMaintenanceGroup} from '../../../backend/supabase/functions/_shared/jobs/background.mjs';
import {createSharedQueueRuntime} from '../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs';
const token='10000000-0000-4000-8000-000000000001', now='2026-10-09T00:00:00Z',future='2026-10-09T00:03:00Z';
function fixture({used=0,maintenanceDue=false,maintenanceRun,invoke,readSlots}={}) {
 let count=used,releases=0,begins=0,confirms=0,queueDone=false,done=false;
 const errors=[],timers=[];
 const scheduler=createSharedBackgroundQueueScheduler({queryTimeoutMs:1000,supportedKinds:['report_retention'],
  repository:{schedule:async({excludeKinds})=>({serverNow:now,nextDueAt:queueDone||excludeKinds.includes('report_retention')?null:now,nextKind:queueDone||excludeKinds.includes('report_retention')?null:'report_retention'}),acquire:async()=>({token,expiresAt:future}),release:async()=>{releases++;return'applied';}},
  contracts:{decisionId:'actual-slot-contract',readBudget:async()=>({remainingMs:180000}),readSlots:readSlots??(async()=>({used:count,remaining:20-count})),unitsFor:(kind,result)=>kind===null?result.processedItems:result.counts.claimed,
   journal:{hasPending:async()=>false,begin:async()=>{begins++;return token;},confirm:async()=>{confirms++;return true;},unknown:async()=>{}},
   maintenance:{readSchedule:async()=>({serverNow:now,nextDueAt:maintenanceDue&&!done?now:null}),run:async(t,o)=>{done=true;return maintenanceRun?maintenanceRun(t,o):{purged:1,processedItems:20};}}},
  invoke:async(t,k,o)=>{queueDone=true;if(invoke)return invoke(t,k,o,n=>count=n);count=Math.min(20,count+1);return{status:'ran',counts:{claimed:1,processedItems:8}};},
  setTimer:(fn,ms)=>{const h={fn,ms};timers.push(h);return h;},clearTimer:h=>h.cleared=true,elapsed:()=>0,onError:e=>errors.push(e)});
 return{scheduler,errors,timers,counts:()=>({releases,begins,confirms})};
}
test('queue slots20 still runs due maintenance with its independent allocation',async()=>{
 let calls=0;const f=fixture({used:20,maintenanceDue:true,maintenanceRun:async(_t,o)=>{calls++;assert.equal(o.limit,20);return{purged:20,processedItems:20};},invoke:async()=>assert.fail('queue exhausted')});
 await f.scheduler.wake();await f.scheduler.stop();assert.equal(calls,1);assert.equal(f.counts().releases,1);assert.deepEqual(f.errors,[]);
});
test('maintenance provider allocations are independent while wall time is shared',async()=>{
 const allocations=[];let clock=0;
 const group=createDueMaintenanceGroup([1,2].map(n=>({readSchedule:async()=>({serverNow:now,nextDueAt:now}),run:async(_t,o)=>{allocations.push([o.limit,o.remainingMs]);clock+=100;return{purged:20,processedItems:20};}})),()=>clock);
 assert.deepEqual(await group.run(token,{limit:20,remainingMs:1000,signal:new AbortController().signal}),{purged:40,processedItems:40});assert.deepEqual(allocations,[[20,1000],[20,900]]);
});
test('many attachment results do not consume additional queue jobs',async()=>{
 const f=fixture({used:19,invoke:async(_t,_k,o,set)=>{assert.equal(o.limit,1);set(20);return{status:'ran',counts:{claimed:1,processedItems:30}};}});
 await f.scheduler.wake();await f.scheduler.stop();assert.deepEqual(f.errors,[]);assert.equal(f.counts().confirms,1);
});
test('DB slot overflow is rejected and lease remains held for reconciliation',async()=>{
 let reads=0;const f=fixture({readSlots:async()=>++reads===1?{used:19,remaining:1}:{used:21,remaining:-1}});
 await f.scheduler.wake();await f.scheduler.stop();assert.equal(f.counts().releases,0);assert.deepEqual(f.errors,['WORKER_QUEUE_RECONCILIATION_REQUIRED']);
});
test('reclaiming same job without new slot does not create an immediate hot loop',async()=>{
 let calls=0;const f=fixture({used:1,invoke:async()=>{calls++;return{status:'ran',counts:{claimed:1,processedItems:1}};}});
 await f.scheduler.wake();await f.scheduler.stop();assert.equal(calls,1);assert.deepEqual(f.errors,[]);
});
test('runtime reports claimed queue jobs independently from attachment reservations',()=>{
 const runtime=createSharedQueueRuntime({schedule:async()=>{},contracts:{decisionId:'slot-contract',readBudget:async()=>{},readSlots:async()=>{},journal:{hasPending:async()=>false,begin:async()=>token,confirm:async()=>false,unknown:async()=>{}}},maintenanceProviders:[{readSchedule:async()=>({serverNow:now,nextDueAt:null}),run:async()=>({purged:0,processedItems:0})}],invokeSafety:async()=>{},invokeExisting:async()=>{}});
 assert.equal(runtime.contracts.unitsFor('report_retention',{counts:{claimed:1,processedItems:30}}),1);
});

test('five-kind runner consumes actual slot port and restores both LISTEN subscriptions',async()=>{
 const {EventEmitter}=await import('node:events');const {rootCertificates}=await import('node:tls');
 const {startQueueRunner,readQueueRunnerConfig}=await import('../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs');
 const sqls=[],calls=[],reports=[];let used=0;
 const kinds=['review_summary','event_sync','member_cleanup','cancellation_safety','report_retention'];
 class Client extends EventEmitter{async connect(){}async end(){}async query(sql){sqls.push(sql);if(sql.includes('current_user'))return{rows:[{currentRole:'yumidang_worker_queue',loginRole:'queue_login'}]};if(sql.includes('acquire_worker_run'))return{rows:[{result:{token,expiresAt:future}}]};if(sql.includes('release_worker_run'))return{rows:[{result:{status:'applied'}}]};return{rows:[]};}}
 const config=readQueueRunnerConfig({WORKER_QUEUE_DATABASE_URL:'postgresql://queue_login:synthetic@localhost/test',WORKER_QUEUE_FUNCTION_URL:'https://example.supabase.co/functions/v1/review-summary-worker',WORKER_QUEUE_DB_CA_PEM:rootCertificates[0],WORKER_QUEUE_DB_CONTRACT_ID:'test-durable-contract',WORKER_QUEUE_DB_LOGIN_ROLE:'queue_login',INTERNAL_WORKER_SECRET:'x'.repeat(32),WORKER_QUEUE_QUERY_TIMEOUT_MS:'1000',WORKER_QUEUE_RECONNECT_MS:'1000',WORKER_QUEUE_HTTP_TIMEOUT_MS:'1000'});
 const invoke=async(_token,kind,o)=>{assert.equal(o.limit,20-used);assert.ok(o.signal instanceof AbortSignal);assert.ok(o.remainingMs>0&&o.remainingMs<=180000);calls.push(kind);used++;return{status:'ran',counts:{claimed:1}};};
 const sharedRuntime=createSharedQueueRuntime({schedule:async()=>({serverNow:now,nextDueAt:used<5?now:null,nextKind:kinds[used]??null}),contracts:{decisionId:'test-durable-contract',readBudget:async()=>({remainingMs:180000}),readSlots:async()=>({used,remaining:20-used}),journal:{hasPending:async()=>false,begin:async()=>token,confirm:async()=>true,unknown:async()=>assert.fail('no unknown')}},maintenanceProviders:[{readSchedule:async()=>({serverNow:now,nextDueAt:null}),run:async()=>assert.fail('maintenance not due')}],invokeSafety:invoke,invokeExisting:invoke});
 const runner=startQueueRunner({Client,config,sharedRuntime,report:c=>reports.push(c),fetchImpl:async()=>assert.fail('no legacy HTTP')});
 await runner.ready;await runner.stop();assert.deepEqual(calls,kinds);assert.ok(sqls.includes('LISTEN yumidang_worker_jobs'));assert.ok(sqls.includes('LISTEN yumidang_cancellation_due'));assert.ok(reports.includes('WORKER_QUEUE_READY'));
});

test('zero-result maintenance still preserves its next future DB deadline',async()=>{
 let ran=false;const timers=[];const scheduler=createSharedBackgroundQueueScheduler({queryTimeoutMs:1000,supportedKinds:['report_retention'],
 repository:{schedule:async()=>({serverNow:now,nextDueAt:null,nextKind:null}),acquire:async()=>({token,expiresAt:future}),release:async()=> 'applied'},
 contracts:{decisionId:'stored-result-contract',readBudget:async()=>({remainingMs:180000}),readSlots:async()=>({used:0,remaining:20}),unitsFor:(_kind,result)=>result.processedItems,journal:{hasPending:async()=>false,begin:async()=>token,confirm:async()=>true,unknown:async()=>assert.fail()},maintenance:{readSchedule:async()=>({serverNow:now,nextDueAt:ran?future:now}),run:async()=>{ran=true;return{purged:0,processedItems:20};}}},invoke:async()=>assert.fail(),setTimer:(fn,ms)=>{const t={fn,ms};timers.push(t);return t;},clearTimer:t=>t.cleared=true,elapsed:()=>0});
 await scheduler.wake();assert.equal(timers.filter(t=>!t.cleared&&t.ms===180000).length,1);await scheduler.stop();assert.ok(timers.every(t=>t.cleared));
});

test('stop during invocation preserves UNKNOWN and never releases the global lease',async()=>{
 let entered;const started=new Promise(r=>entered=r);const f=fixture({invoke:async()=>{entered();return new Promise(()=>{});}});
 const running=f.scheduler.wake();await started;await f.scheduler.stop();await running;assert.equal(f.counts().releases,0);assert.equal(f.counts().confirms,0);assert.deepEqual(f.errors,['WORKER_QUEUE_RECONCILIATION_REQUIRED']);
});

test('another process pending intent waits for DB deadline then resumes on notification without dispatch or reconnect',async()=>{
 let pending=true,done=false,used=0,acquired=0,dispatched=0,unknowns=0;const errors=[],timers=[];
 const scheduler=createSharedBackgroundQueueScheduler({queryTimeoutMs:1000,supportedKinds:['report_retention'],
 repository:{schedule:async()=>({serverNow:now,nextDueAt:done?null:pending?future:now,nextKind:done?null:'report_retention'}),acquire:async()=>{acquired++;return{token,expiresAt:future};},release:async()=> 'applied'},
 contracts:{decisionId:'competing-process-contract',readBudget:async()=>({remainingMs:180000}),readSlots:async()=>({used,remaining:20-used}),unitsFor:(_kind,result)=>result.counts.claimed,
 journal:{hasPending:async()=>pending,begin:async()=>token,confirm:async()=>true,unknown:async()=>{unknowns++;}},maintenance:{readSchedule:async()=>({serverNow:now,nextDueAt:null}),run:async()=>assert.fail()}},
 invoke:async()=>{dispatched++;used++;done=true;return{status:'ran',counts:{claimed:1}};},onError:code=>errors.push(code),
 setTimer:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},clearTimer:t=>t.cleared=true,elapsed:()=>0});
 await scheduler.wake();assert.equal(acquired,0);assert.equal(dispatched,0);assert.equal(unknowns,0);assert.deepEqual(errors,[]);
 assert.equal(timers.filter(t=>!t.cleared&&t.ms===180000).length,1);
 pending=false;await scheduler.wake();assert.equal(acquired,1);assert.equal(dispatched,1);assert.equal(unknowns,0);assert.deepEqual(errors,[]);
 await scheduler.stop();assert.ok(timers.every(t=>t.cleared));
});

test('unresolved pending record parks without sending and can recheck a later DB notification',async()=>{
 let pending=true,acquired=0,reads=0;const errors=[];
 const scheduler=createSharedBackgroundQueueScheduler({queryTimeoutMs:1000,supportedKinds:['report_retention'],
 repository:{schedule:async()=>{reads++;return{serverNow:now,nextDueAt:null,nextKind:null};},acquire:async()=>{acquired++;return null;},release:async()=>assert.fail()},
 contracts:{decisionId:'pending-reconciliation-contract',readBudget:async()=>assert.fail(),readSlots:async()=>assert.fail(),unitsFor:()=>0,journal:{hasPending:async()=>pending,begin:async()=>assert.fail(),confirm:async()=>assert.fail(),unknown:async()=>assert.fail()},maintenance:{readSchedule:async()=>({serverNow:now,nextDueAt:null}),run:async()=>assert.fail()}},
 invoke:async()=>assert.fail(),onError:code=>errors.push(code)});
 await scheduler.wake();await scheduler.wake();assert.equal(acquired,0);assert.deepEqual(errors,['WORKER_QUEUE_RECONCILIATION_REQUIRED']);
 pending=false;await scheduler.wake();assert.equal(reads,3);assert.equal(acquired,0);await scheduler.stop();
});
