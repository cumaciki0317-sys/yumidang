import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountPoolModel, type AccountReservationPort } from '../../../backend/supabase/functions/_shared/ai/providers/account-pool.ts';
import { ModelError } from '../../../backend/supabase/functions/_shared/ai/providers/provider-errors.ts';
import type { ModelRequest, ModelResponse } from '../../../backend/supabase/functions/_shared/ai/providers/model-port.ts';
const request: ModelRequest = {task:'intent',system:'synthetic',input:{query:'전시'},maxOutputTokens:800,memberRequest:{userId:'synthetic-user',requestId:'synthetic-request',leaseToken:'synthetic-lease'}};
const response: ModelResponse = {value:{status:'search'},modelVersion:'potens.test',usage:{inputTokens:20,outputTokens:3}};
function harness() {
 const reserved: string[]=[]; const settled: Parameters<AccountReservationPort['settle']>[0][]=[]; const dispatched: string[]=[];
 const port: AccountReservationPort={async reserve({accountId}){reserved.push(accountId);return {status:'reserved',reservation:{accountId,reservationId:'reservation-1',accountDay:'2026-10-06'}};},async settle(v){settled.push(v);}};
 const model=createAccountPoolModel({orderedAccountIds:['a','b'],reservations:port,modelForAccount(accountId){dispatched.push(accountId);return {async generate(){return response;}};}});
 return {model,port,reserved,settled,dispatched};
}
test('order selects next only after pre-dispatch account denial; usage settles selected identity',async()=>{
 const visited:string[]=[];const settlements:any[]=[];
 const model=createAccountPoolModel({orderedAccountIds:['a','b'],reservations:{async reserve({accountId}){visited.push(accountId);return accountId==='a'?{status:'account_budget_denied'}:{status:'reserved',reservation:{accountId,reservationId:'r',accountDay:'2026-10-06'}};},async settle(v){settlements.push(v);}},modelForAccount:()=>({async generate(){return response;}})});
 await model.generate(request);assert.deepEqual(visited,['a','b']);assert.equal(settlements[0].reservation.accountId,'b');assert.equal(settlements[0].outcome,'usage_reported');assert.deepEqual(settlements[0].usage,response.usage);
});
test('global budget denial and unknown reservation errors never advance',async()=>{
 for(const kind of ['global','throw'] as const){let reserves=0,factories=0;const model=createAccountPoolModel({orderedAccountIds:['a','b'],reservations:{async reserve(){reserves++;if(kind==='throw')throw new Error('secret');return {status:'global_budget_denied'};},async settle(){throw new Error();}},modelForAccount(){factories++;throw new Error();}});await assert.rejects(model.generate(request),(e:any)=>e.code===(kind==='global'?'BUDGET_EXHAUSTED':'MODEL_UNAVAILABLE')&&!e.message.includes('secret'));assert.equal(reserves,1);assert.equal(factories,0);}
});
test('403/401/429/timeout/unknown after dispatch retain reservation and never rotate',async()=>{
 for(const code of ['PROVIDER_REJECTED','RATE_LIMITED','TIMEOUT','MODEL_UNAVAILABLE'] as const){const h=harness();const model=createAccountPoolModel({orderedAccountIds:['a','b'],reservations:h.port,modelForAccount(id){h.dispatched.push(id);return {async generate(){throw new ModelError(code);}};}});await assert.rejects(model.generate(request),(e:any)=>e.code===code);assert.deepEqual(h.reserved,['a']);assert.deepEqual(h.dispatched,['a']);assert.equal(h.settled[0].outcome,'usage_unknown');assert.equal(h.settled[0].confirmedDepletion,undefined);}
});
test('approved machine-code depletion records evidence without rotating or refunding',async()=>{
 const h=harness();const model=createAccountPoolModel({orderedAccountIds:['a','b'],reservations:h.port,confirmedDepletion:{decisionId:'approved-contract',classify:()=> 'DAILY_QUOTA_CODE'},modelForAccount:()=>({async generate(){throw new ModelError('PROVIDER_REJECTED');}})});await assert.rejects(model.generate(request));assert.deepEqual(h.reserved,['a']);assert.equal(h.settled[0].outcome,'usage_unknown');assert.deepEqual(h.settled[0].confirmedDepletion,{decisionId:'approved-contract',code:'DAILY_QUOTA_CODE'});
});
test('cancel before reserve consumes nothing; cancel after reserve retains unknown',async()=>{
 const controller=new AbortController();controller.abort();const h=harness();await assert.rejects(h.model.generate({...request,signal:controller.signal}));assert.equal(h.reserved.length,0);
 const c=new AbortController(),settlements:any[]=[];let dispatches=0;const model=createAccountPoolModel({orderedAccountIds:['a'],reservations:{async reserve({accountId}){c.abort();return {status:'reserved',reservation:{accountId,reservationId:'r',accountDay:'2026-10-06'}};},async settle(v){settlements.push(v);}},modelForAccount(){dispatches++;throw new Error();}});await assert.rejects(model.generate({...request,signal:c.signal}),(e:any)=>e.code==='CANCELLED');assert.equal(dispatches,0);assert.equal(settlements[0].outcome,'usage_unknown');
});
test('late cancellation settles verified usage; day reset cannot move original identity',async()=>{
 const c=new AbortController(),identity={accountId:'a',reservationId:'r',accountDay:'2026-10-06'},settlements:any[]=[];
 const model=createAccountPoolModel({orderedAccountIds:['a'],reservations:{async reserve(){return {status:'reserved',reservation:identity};},async settle(v){settlements.push(v);}},modelForAccount:()=>({async generate(){identity.accountDay='2026-10-07';identity.accountId='b';c.abort();return response;}})});await assert.rejects(model.generate({...request,signal:c.signal}),(e:any)=>e.code==='CANCELLED');assert.deepEqual(settlements[0].reservation,{accountId:'a',reservationId:'r',accountDay:'2026-10-06'});assert.equal(settlements[0].outcome,'usage_reported');
});
test('bad usage retains unknown; over-limit verified usage settles before response rejection',async()=>{
 for(const usage of [null,{inputTokens:-1,outputTokens:2},{inputTokens:10,outputTokens:801}]){const h=harness();const model=createAccountPoolModel({orderedAccountIds:['a'],reservations:h.port,modelForAccount:()=>({async generate(){return {...response,usage:usage as any};}})});if(usage===null)await model.generate(request);else await assert.rejects(model.generate(request),(e:any)=>e.code==='INVALID_MODEL_RESPONSE');assert.equal(h.settled[0].outcome,usage&&usage.inputTokens>=0?'usage_reported':'usage_unknown');}
});
test('malformed account identity is not dispatched or treated as denial',async()=>{
 let calls=0;const model=createAccountPoolModel({orderedAccountIds:['a','b'],reservations:{async reserve(){calls++;return {status:'reserved',reservation:{accountId:'b',reservationId:'r',accountDay:'2026-10-06'}};},async settle(){throw new Error();}},modelForAccount(){throw new Error('should not dispatch');}});await assert.rejects(model.generate(request),(e:any)=>e.code==='MODEL_UNAVAILABLE');assert.equal(calls,1);
});
test('settlement loss never retries dispatch or changes account',async()=>{
 let calls=0,settles=0;const model=createAccountPoolModel({orderedAccountIds:['a','b'],reservations:{async reserve({accountId}){return {status:'reserved',reservation:{accountId,reservationId:'r',accountDay:'2026-10-06'}};},async settle(){settles++;throw new Error('private');}},modelForAccount:()=>({async generate(){calls++;return response;}})});await assert.rejects(model.generate(request),(e:any)=>e.code==='MODEL_UNAVAILABLE');assert.equal(calls,1);assert.equal(settles,1);
});
test('accounts and order require explicit unique server configuration',()=>{
 for(const ids of [[],['a','a'],['bad key']])assert.throws(()=>createAccountPoolModel({orderedAccountIds:ids,reservations:harness().port,modelForAccount:()=>({async generate(){return response;}})}));
});

test('summary requests cannot bypass scope with generic account reservation',async()=>{
 const h=harness();await assert.rejects(h.model.generate({...request,task:'review_chunk'}),(e:any)=>e.code==='INVALID_MODEL_RESPONSE');assert.equal(h.reserved.length,0);
});

test('chat tasks require nonblank member capability before any reserve',async()=>{
 for(const task of ['intent','preference_match','explanation'] as const){
  for(const memberRequest of [undefined,{userId:' ',requestId:'r',leaseToken:'l'},{userId:'u',requestId:'',leaseToken:'l'},{userId:'u',requestId:'r',leaseToken:'\t'}]){
   const h=harness();await assert.rejects(h.model.generate({...request,task,memberRequest}),(e:any)=>e.code==='INVALID_MODEL_RESPONSE');assert.equal(h.reserved.length,0);
  }
 }
});
test('member scope is copied and frozen across reserve/model despite original mutation',async()=>{
 const original={userId:'u',requestId:'r',leaseToken:'l'};let reservedScope:any,modelScope:any;
 const model=createAccountPoolModel({orderedAccountIds:['a'],reservations:{async reserve(v){reservedScope=v.memberRequest;assert.ok(Object.isFrozen(reservedScope));original.userId='changed';original.requestId='changed';return {status:'reserved',reservation:{accountId:'a',reservationId:'r',accountDay:'2026-10-06'}};},async settle(){}},modelForAccount:()=>({async generate(v){modelScope=v.memberRequest;return response;}})});
 await model.generate({...request,memberRequest:original});assert.deepEqual(modelScope,{userId:'u',requestId:'r',leaseToken:'l'});assert.equal(reservedScope,modelScope);
});
test('summary capability and evidence array are copied and frozen, blank fields rejected',async()=>{
 const scope={jobId:'j',leaseToken:'l',targetUserId:'u',sourceRevision:'revision',workerRunToken:'w',modelVersion:'model',promptVersion:'prompt',sourceReviewIds:['s1','s2','s3']};let seen:any;
 const model=createAccountPoolModel({orderedAccountIds:['a'],reservations:{async reserve(v){seen=v.summaryRequest;assert.ok(Object.isFrozen(seen));assert.ok(Object.isFrozen(seen.sourceReviewIds));scope.sourceReviewIds.push('new');scope.targetUserId='changed';return {status:'reserved',reservation:{accountId:'a',reservationId:'r',accountDay:'2026-10-06'}};},async settle(){}},modelForAccount:()=>({async generate(v){assert.equal(v.summaryRequest,seen);return response;}})});
 await model.generate({...request,task:'review_chunk',memberRequest:undefined,summaryRequest:scope});assert.deepEqual(seen.sourceReviewIds,['s1','s2','s3']);assert.equal(seen.targetUserId,'u');
 for(const field of ['jobId','leaseToken','targetUserId','sourceRevision','workerRunToken','modelVersion','promptVersion']){const h=harness();await assert.rejects(h.model.generate({...request,task:'review_merge',memberRequest:undefined,summaryRequest:{...scope,[field]:' '}}));assert.equal(h.reserved.length,0);}
 const h=harness();await assert.rejects(h.model.generate({...request,summaryRequest:scope}));assert.equal(h.reserved.length,0);
});
