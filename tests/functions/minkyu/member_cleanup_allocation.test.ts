import {test} from 'node:test';import assert from 'node:assert/strict';
import {processMemberCleanupBatch,type MemberCleanupPorts,createMemberCleanupAdapter} from '../../../backend/supabase/functions/_shared/auth/member-cleanup.ts';
const token='ab103000-0000-4000-8000-000000000001';
test('배정0·사전 중단·마감 시 claim과 외부 전송0',async()=>{
 let calls=0;const ports={claim:async()=>{calls++;return null;}}as unknown as MemberCleanupPorts;
 const adapter={}as ReturnType<typeof createMemberCleanupAdapter>;
 const normal=new AbortController(),aborted=new AbortController();aborted.abort();
 for(const a of [{limit:0,deadlineAt:Date.now()+60000,signal:normal.signal},{limit:10,deadlineAt:Date.now()+60000,signal:aborted.signal},{limit:10,deadlineAt:Date.now()-1,signal:normal.signal}]){
  assert.equal((await processMemberCleanupBatch(token,ports,adapter,a)).processed,0);
 }
 assert.equal(calls,0);
 await assert.rejects(processMemberCleanupBatch(token,ports,adapter,{limit:11,deadlineAt:Date.now()+60000,signal:normal.signal}));assert.equal(calls,0);
});

test('양수 배정은 완료 수까지만 처리하고 다음 claim을 시작하지 않는다',async()=>{
 const id=token;let claims=0,completed=0;
 const task={taskId:id,leaseToken:id,profileId:id,kind:'storage_object' as const,bucketId:'profile-images' as const,objectId:id,objectName:`${id}/${id}.jpg`,expiresAt:new Date(Date.now()+60000).toISOString()};
 const ports:MemberCleanupPorts={claim:async()=>{claims++;return task;},assertCurrent:async()=>task,
 getDeleteAck:async()=>({receiptId:id,taskId:id,kind:task.kind,objectId:id,evidenceSha256:'a'.repeat(64)}),
 recordDeleteAck:async()=>{throw new Error('새 삭제 ACK 금지');},complete:async()=>{completed++;return{status:'applied'};}};
 const adapter={verifyAbsent:async()=>{},deleteAndVerify:async()=>{throw new Error('DELETE 금지');}} as ReturnType<typeof createMemberCleanupAdapter>;
 const result=await processMemberCleanupBatch(id,ports,adapter,{limit:2,deadlineAt:Date.now()+60000,signal:new AbortController().signal});
 assert.deepEqual(result,{processed:2,stopReason:'limit'});assert.equal(claims,2);assert.equal(completed,2);
});
