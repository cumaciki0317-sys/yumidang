import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerRuntimeJournal } from '../../../backend/supabase/functions/_shared/db/worker-runtime-client.ts';
import { toPublicError } from '../../../backend/supabase/functions/_shared/http/errors.ts';
const id='11111111-1111-4111-8111-111111111111';
test('전송 응답이 유실되면 클라이언트가 prepare를 자동 재전송하지 않는다',async()=>{
 let calls=0;
 const journal=createWorkerRuntimeJournal({rpc:async()=>{calls++;throw new Error('lost');}});
 await assert.rejects(journal.prepare({requestId:id,globalToken:id,operation:'cycle',scope:{}}));
 assert.equal(calls,1);
});
test('unknown 결과를 원격 성공으로 바꾸지 않고 반환한다',async()=>{
 const journal=createWorkerRuntimeJournal({rpc:async(name,args)=>{
  assert.equal(name,'observe_worker_runtime_intent');assert.equal(args.p_observed,false);
  return {ticket:id,state:'unknown'};
 }});
 assert.deepEqual(await journal.observe(id,false),{ticket:id,state:'unknown'});
});
test('잘못된 UUID는 전송 전에 거절한다',async()=>{
 let calls=0;const journal=createWorkerRuntimeJournal({rpc:async()=>{calls++;return null;}});
 await assert.rejects(journal.prepare({requestId:'bad',globalToken:id,operation:'cycle',scope:{}}),e=>toPublicError(e).error.code==='INVALID_REQUEST');
 assert.equal(calls,0);
});
test('예상하지 않은 응답 필드는 공개 오류로 막는다',async()=>{
 const journal=createWorkerRuntimeJournal({rpc:async()=>({ticket:id,state:'prepared',raw:'sensitive'})});
 await assert.rejects(journal.prepare({requestId:id,globalToken:id,operation:'cycle',scope:{}}),e=>{
  const safe=toPublicError(e);assert.equal(safe.error.code,'EXTERNAL_UNAVAILABLE');assert.equal(JSON.stringify(safe).includes('sensitive'),false);return true;
 });
});
