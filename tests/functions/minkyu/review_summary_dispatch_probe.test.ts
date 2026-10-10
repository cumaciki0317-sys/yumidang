import test from 'node:test';
import assert from 'node:assert/strict';
import { probeSummaryWorkerRpcs } from '../../../backend/supabase/functions/review-summary-worker/handler.ts';
import { HttpError } from '../../../backend/supabase/functions/_shared/http/errors.ts';
import type { RpcClient } from '../../../backend/supabase/functions/_shared/db/transport.ts';
import type { JsonValue } from '../../../backend/supabase/functions/_shared/contracts/common.ts';

const nil='00000000-0000-0000-0000-000000000000';
const effects=['mark_review_summary_insufficient','publish_review_summary_for_job'];
const settlements=['yield_job','fail_job','supersede_job'];
function fixture(override?: (name:string)=>JsonValue|undefined) {
  const calls:string[]=[];
  const db:RpcClient={async rpc(name,args){
    calls.push(name);assert.equal(args.p_job_id,nil);assert.equal(args.p_lease_token,nil);assert.equal(args.p_worker_run_token,nil);
    const changed=override?.(name);if(changed!==undefined)return changed;
    if(name==='reserve_review_summary_model'){assert.equal(args.p_target_user_id,nil);assert.deepEqual(args.p_source_review_ids,[]);return{status:'consent_revoked'};}
    if(effects.includes(name)||settlements.includes(name))throw new HttpError('STATE_CONFLICT');
    return{status:'lease_lost'};
  }};
  return{db,calls};
}

test('modern SQL109 mark and publish dispatch conflicts permit the complete NIL probe only',async()=>{
  const f=fixture();assert.equal(await probeSummaryWorkerRpcs(f.db),'ready');assert.equal(f.calls.length,10);
  assert.ok(effects.every(name=>f.calls.includes(name)));assert.ok(settlements.every(name=>f.calls.includes(name)));
  assert.ok(f.calls.every(name=>!['claim_job','claim_supported_job','prepare_queue_invocation','complete_queue_invocation'].includes(name)));
});

test('both legacy effects still accept only the exact lease_lost body',async()=>{
  const f=fixture(name=>effects.includes(name)?{status:'lease_lost'}:undefined);
  assert.equal(await probeSummaryWorkerRpcs(f.db),'ready');assert.equal(f.calls.length,10);
});

test('generic unavailable and denied effects stop before later probe or any claim',async()=>{
  for(const name of effects)for(const code of ['EXTERNAL_UNAVAILABLE','ACCESS_DENIED']as const){
    const f=fixture(current=>{if(current===name)throw new HttpError(code);return undefined;});
    assert.equal(await probeSummaryWorkerRpcs(f.db),code==='ACCESS_DENIED'?'DB_RPC_NOT_ALLOWED':'DB_RPC_UNAVAILABLE');
    assert.equal(f.calls.at(-1),name);assert.ok(!f.calls.includes('yield_job'));assert.ok(!f.calls.some(x=>x.startsWith('claim_')));
  }
});

test('STATE_CONFLICT is still rejected for model reservation, source and checkpoint RPCs',async()=>{
  for(const name of ['reserve_review_summary_model','load_review_summary_source','load_review_summary_checkpoint','save_review_summary_checkpoint','discard_review_summary_checkpoint']){
    const f=fixture(current=>{if(current===name)throw new HttpError('STATE_CONFLICT');return undefined;});
    assert.equal(await probeSummaryWorkerRpcs(f.db),'DB_RPC_UNAVAILABLE');assert.equal(f.calls.at(-1),name);
    assert.ok(!f.calls.some(x=>x.startsWith('claim_')));
  }
});

test('effect success, consent denial and embellished lease proof cannot claim readiness',async()=>{
  const bodies:JsonValue[]=[{status:'applied'},{status:'consent_revoked'},{status:'lease_lost',extra:true},null,[]];
  for(const name of effects)for(const body of bodies){
    const f=fixture(current=>current===name?body:undefined);
    assert.equal(await probeSummaryWorkerRpcs(f.db),'DB_RPC_UNAVAILABLE');assert.equal(f.calls.at(-1),name);
  }
});
