import assert from 'node:assert/strict';
import test from 'node:test';
import { configureMemberDeviceCleanup, requestMemberDeviceCleanup, retryMemberDeviceCleanup, memberDeviceCleanupSnapshot, subscribeMemberDeviceCleanup } from '../../apps/mobile/src/member-device-cleanup.ts';
test('cleanup failure keeps an identity-free receipt and retries only on explicit request',async()=>{
 let failed=true;const calls=[],invalidations=[],events=[];
 configureMemberDeviceCleanup({invalidate:id=>invalidations.push(id),async clear(id){calls.push(id);if(failed)throw Error('disk');}});
 const unsubscribe=subscribeMemberDeviceCleanup(()=>events.push(memberDeviceCleanupSnapshot()));
 await assert.rejects(requestMemberDeviceCleanup('synthetic-owner'));
 assert.deepEqual(invalidations,['synthetic-owner']);assert.deepEqual(memberDeviceCleanupSnapshot(),{busy:false,failed:true});
 assert.ok(!JSON.stringify(events).includes('synthetic-owner'));assert.equal(calls.length,1);
 failed=false;await retryMemberDeviceCleanup();assert.deepEqual(memberDeviceCleanupSnapshot(),{busy:false,failed:false});assert.equal(calls.length,2);unsubscribe();
});
test('a later owner cleanup waits for an in-flight deletion and does not lose either owner',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});const calls=[];
 configureMemberDeviceCleanup({invalidate(){},async clear(id){calls.push(id);if(id==='first')await pending;}});
 const a=requestMemberDeviceCleanup('first'),b=requestMemberDeviceCleanup('second');
 assert.deepEqual(calls,['first']);release();await Promise.all([a,b]);assert.deepEqual(calls,['first','second']);assert.deepEqual(memberDeviceCleanupSnapshot(),{busy:false,failed:false});
});
