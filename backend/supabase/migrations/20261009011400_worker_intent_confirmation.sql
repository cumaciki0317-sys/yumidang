-- SQL114: DB102 원자 결과와 실제 효과로만 SQL101 intent를 수동 확정한다.
-- 신규 준비/확정/EXEC는 기본 닫힘. 외부 재전송·과거 일괄 승격·점유 연장은 없다.
begin;
create table private.worker_intent_confirmation_control(singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into private.worker_intent_confirmation_control values(true,false);
alter table private.worker_runtime_intents drop constraint worker_runtime_intents_operation_check;
alter table private.worker_runtime_intents add constraint worker_runtime_intents_operation_check check(operation in('cycle','due_enqueue','job_claim','cancellation_process','report_task_claim','report_storage','report_storage_ack','report_task_complete','job_settlement','terminal_maintenance'));
alter table private.worker_runtime_intents drop constraint worker_runtime_intents_state_check;
alter table private.worker_runtime_intents add constraint worker_runtime_intents_state_check check(state in('prepared','unknown','observed_response','confirmed'));
create table private.worker_runtime_intent_invocations(
 request_id uuid primary key references private.worker_runtime_intents(request_id),
 invocation_request_id uuid not null references private.worker_invocations(request_id),
 claim_calls_before integer not null check(claim_calls_before>=0),
 predecessor_request_id uuid references private.worker_runtime_intents(request_id),
 dispatch_started boolean not null default false,dispatched_at timestamptz,
 check(dispatch_started=(dispatched_at is not null)));
create table private.worker_runtime_intent_confirmations(
 request_id uuid primary key references private.worker_runtime_intents(request_id),
 intent_fingerprint text not null check(intent_fingerprint~'^[a-f0-9]{64}$'),
 result_fingerprint text not null check(result_fingerprint~'^[a-f0-9]{64}$'),
 parent_invocation_request_id uuid references private.worker_invocations(request_id),
 predecessor_request_id uuid references private.worker_runtime_intents(request_id),
 predecessor_fingerprint text check(predecessor_fingerprint~'^[a-f0-9]{64}$'),
 parent_fingerprint text check(parent_fingerprint~'^[a-f0-9]{64}$'),
 proof_sha256 text not null check(proof_sha256~'^[a-f0-9]{64}$'),
 confirmed_at timestamptz not null default clock_timestamp(),
 check((parent_invocation_request_id is null)=(parent_fingerprint is null)),
 check((predecessor_request_id is null)=(predecessor_fingerprint is null)));

create function private.assert_worker_intent_confirmation()returns void language plpgsql security definer set search_path=''as $$begin
 perform private.assert_worker_runtime_journal();perform private.assert_worker_runtime_atomic();
 if(select enabled from private.worker_intent_confirmation_control where singleton)is distinct from true then raise exception 'intent_confirmation_not_enabled'using errcode='55000';end if;
end;$$;
-- One explicit mapping, independent of HTTP response interpretation. report_storage
-- binds the actual begin operation and remains unconfirmed while external_pending.
create function private.worker_intent_atomic_operation(p_operation text)returns text language plpgsql immutable set search_path=''as $$begin
 if p_operation='report_storage'then return 'report_delete_begin';end if;
 if p_operation='report_storage_ack'then return 'report_delete_ack';end if;
 if p_operation in('due_enqueue','job_claim','cancellation_process','report_task_claim','report_task_complete','job_settlement','terminal_maintenance')then return p_operation;end if;
 raise exception 'intent_operation_unprovable'using errcode='55000';
end;$$;
create function private.validate_worker_intent_atomic_scope(p_operation text,p_scope jsonb)returns void language plpgsql immutable set search_path=''as $$
declare op text:=private.worker_intent_atomic_operation(p_operation);keys text[];k text;v jsonb;status text;begin
 case op
 when'due_enqueue'then keys:=array['kind','limit'];
 when'job_claim'then keys:=array['workerId','leaseSeconds','supportedKinds'];
 when'cancellation_process'then keys:=array['identityId','generation','jobId','jobLeaseToken'];
 when'report_task_claim'then keys:=array['jobId','jobLeaseToken'];
 when'report_delete_begin'then keys:=array['taskId','taskLeaseToken','jobId','jobLeaseToken','objectId'];
 when'report_delete_ack'then keys:=array['taskId','taskLeaseToken','jobId','jobLeaseToken','objectId','ackSha256'];
 when'report_task_complete'then keys:=array['taskId','taskLeaseToken','jobId','jobLeaseToken','objectId','evidenceSha256'];
 when'job_settlement'then
  status:=p_scope->>'status';
  if status in('queued','retry_wait')then keys:=array['jobId','jobLeaseToken','status','availableAt'];else keys:=array['jobId','jobLeaseToken','status'];end if;
  if status in('retry_wait','failed')then keys:=array_append(keys,'errorCode');end if;
 when'terminal_maintenance'then keys:=array['limit'];
 end case;
 perform private.worker_runtime_exact_keys(p_scope,keys);
 for k,v in select *from jsonb_each(p_scope)loop
  if k in('workerId','identityId','jobId','jobLeaseToken','taskId','taskLeaseToken','objectId')then
   if k='objectId'and v='null'::jsonb and op='report_task_complete'then continue;end if;
   if jsonb_typeof(v)<>'string'or(v#>>'{}')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'then raise exception 'invalid_intent_scope'using errcode='22023';end if;
  elsif k in('evidenceSha256','ackSha256')then
   if jsonb_typeof(v)<>'string'or(v#>>'{}')!~'^[a-f0-9]{64}$'then raise exception 'invalid_intent_scope'using errcode='22023';end if;
  elsif k='limit'then
   if jsonb_typeof(v)<>'number'or(v#>>'{}')!~'^([1-9]|1[0-9]|20)$'then raise exception 'invalid_intent_scope'using errcode='22023';end if;
  elsif k='leaseSeconds'then
   if v is distinct from'180'::jsonb then raise exception 'invalid_intent_scope'using errcode='22023';end if;
  elsif k='generation'then
   if jsonb_typeof(v)<>'number'or(v#>>'{}')!~'^[1-9][0-9]{0,15}$'or(v#>>'{}')::numeric>9007199254740991 then raise exception 'invalid_intent_scope'using errcode='22023';end if;
  elsif k='supportedKinds'then
   if jsonb_typeof(v)<>'array'or jsonb_array_length(v)not between 1 and 3 or exists(select 1 from jsonb_array_elements(v)x where jsonb_typeof(x)<>'string'or x#>>'{}'not in('review_summary','cancellation_safety','report_retention'))or(select count(distinct x)from jsonb_array_elements(v)x)<>jsonb_array_length(v)then raise exception 'invalid_intent_scope'using errcode='22023';end if;
  elsif k='kind'then
   if jsonb_typeof(v)<>'string'or v#>>'{}'not in('cancellation_safety','report_retention')then raise exception 'invalid_intent_scope'using errcode='22023';end if;
  elsif k='status'then
   if jsonb_typeof(v)<>'string'or v#>>'{}'not in('succeeded','queued','retry_wait','failed','superseded')then raise exception 'invalid_intent_scope'using errcode='22023';end if;
  elsif k='availableAt'then
   if status='queued'and v='null'::jsonb then continue;end if;
   if jsonb_typeof(v)<>'string'or(v#>>'{}')!~'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?(Z|[+-]\d\d:\d\d)$'or not isfinite((v#>>'{}')::timestamptz)then raise exception 'invalid_intent_scope'using errcode='22023';end if;
  elsif k='errorCode'then
   if jsonb_typeof(v)<>'string'or v#>>'{}'not in('UPSTREAM_UNAVAILABLE','RATE_LIMITED','TIMEOUT','STATE_CHANGED','INTERNAL_ERROR')then raise exception 'invalid_intent_scope'using errcode='22023';end if;
  end if;
 end loop;
end;$$;

-- The source request key is stored, not inferred from a task or caller response.
create function private.assert_worker_intent_predecessor(p_operation text,p_input jsonb,p_parent uuid,p_global uuid,p_predecessor uuid,p_for_execution boolean)returns void
language plpgsql volatile security definer set search_path=''as $$
declare i private.worker_runtime_intents;b private.worker_runtime_intent_invocations;o private.worker_runtime_results;expected text;core jsonb;begin
 if p_operation='report_storage_ack'then expected:='report_storage';
 elsif p_operation='report_task_complete'and p_input->'objectId'<>'null'::jsonb then expected:='report_storage_ack';
 else if p_predecessor is not null then raise exception 'unexpected_intent_predecessor'using errcode='40001';end if;return;end if;
 if p_predecessor is null then raise exception 'intent_predecessor_required'using errcode='40001';end if;
 select *into i from private.worker_runtime_intents where request_id=p_predecessor for update;
 select *into b from private.worker_runtime_intent_invocations where request_id=p_predecessor;
 core:=p_input-'ackSha256'-'evidenceSha256';
 if i.request_id is null or i.operation<>expected or i.global_token<>p_global or b.invocation_request_id is distinct from p_parent or not b.dispatch_started or i.scope-'ackSha256' is distinct from core or i.fingerprint is distinct from encode(extensions.digest(jsonb_build_array(i.operation,i.global_token,i.scope,i.parent_ticket)::text,'sha256'),'hex')then raise exception 'intent_predecessor_conflict'using errcode='40001';end if;
 select *into o from private.worker_runtime_results where request_id=p_predecessor for update;
 if o.request_id is null or o.global_token<>p_global or o.operation<>private.worker_intent_atomic_operation(expected)or o.input is distinct from i.scope or o.fingerprint is distinct from encode(extensions.digest(jsonb_build_array(p_global,o.operation,i.scope)::text,'sha256'),'hex')then raise exception 'intent_predecessor_result_conflict'using errcode='40001';end if;
 if expected='report_storage'then
  if o.state not in('external_pending','completed')or(p_for_execution and o.state<>'external_pending')then raise exception 'intent_predecessor_unproven'using errcode='55000';end if;
  if p_for_execution and exists(select 1 from private.report_purge_delete_acks where task_id=(core->>'taskId')::uuid)then raise exception 'intent_get_only'using errcode='55000';end if;
 else
  if o.state<>'completed'or i.state<>'confirmed'or not exists(select 1 from private.worker_runtime_intent_confirmations c where c.request_id=i.request_id and c.intent_fingerprint=i.fingerprint and c.result_fingerprint=o.fingerprint)then raise exception 'intent_predecessor_unproven'using errcode='55000';end if;
  if not exists(select 1 from private.report_purge_delete_acks a join private.report_purge_dispatches d on d.task_id=a.task_id where a.task_id=(core->>'taskId')::uuid and a.ack_sha256=i.scope->>'ackSha256'and a.asset_id=d.asset_id and a.object_id=d.object_id and a.recorded_at>=d.dispatched_at)then raise exception 'intent_ack_unproven'using errcode='55000';end if;
 end if;
 if not exists(select 1 from private.report_purge_dispatches d where d.task_id=(core->>'taskId')::uuid and d.task_lease_token=(core->>'taskLeaseToken')::uuid and d.job_id=(core->>'jobId')::uuid and d.job_lease_token=(core->>'jobLeaseToken')::uuid and d.worker_run_token=p_global and d.object_id=(core->>'objectId')::uuid)then raise exception 'intent_dispatch_unproven'using errcode='55000';end if;
end;$$;

-- Existing prepare_worker_runtime_intent(uuid,text,uuid,jsonb,uuid) is unchanged.
-- New full atomic input is stored verbatim, never projected into a permissive scope.
create function public.prepare_worker_invocation_intent(p_request_id uuid,p_parent_invocation_id uuid,p_operation text,p_scope jsonb,p_predecessor_request_id uuid default null)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare r private.worker_invocations;i private.worker_runtime_intents;b private.worker_runtime_intent_invocations;fp text;begin
 perform private.assert_worker_intent_confirmation();perform private.assert_worker_invocation();
 if p_request_id is null or p_parent_invocation_id is null then raise exception 'invalid_intent'using errcode='22023';end if;
 perform private.validate_worker_intent_atomic_scope(p_operation,p_scope);
 -- Parent first matches execution/confirmation; the fresh global assertion follows.
 select *into r from private.worker_invocations where request_id=p_parent_invocation_id for update;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 perform private.assert_current_worker_run(r.global_token);
 if r.state<>'prepared'or not r.dispatch_started or r.deadline<=clock_timestamp()or r.remaining_ms not between 1 and 60000 or r.item_limit not between 1 and 20 or r.deadline>r.created_at+r.remaining_ms*interval'1 millisecond' then raise exception 'parent_invocation_not_dispatchable'using errcode='55000';end if;
 if not coalesce(case p_operation
  when'due_enqueue'then r.kind in('cancellation_safety','report_retention')and p_scope->>'kind'=r.kind and(p_scope->>'limit')::integer<=r.item_limit
  when'job_claim'then r.kind in('review_summary','cancellation_safety','report_retention')and p_scope->'supportedKinds'=jsonb_build_array(r.kind)and r.claim_calls<r.item_limit
  when'cancellation_process'then r.kind='cancellation_safety'
  when'report_task_claim'then r.kind='report_retention'
  when'report_storage'then r.kind='report_retention'
  when'report_storage_ack'then r.kind='report_retention'
  when'report_task_complete'then r.kind='report_retention'
  when'job_settlement'then r.kind in('review_summary','cancellation_safety','report_retention')
  else false end,false)then raise exception 'intent_parent_kind_conflict'using errcode='40001';end if;
 if p_scope ? 'jobId'and not exists(select 1 from private.worker_invocation_jobs where request_id=r.request_id and job_id=(p_scope->>'jobId')::uuid and job_lease_token=(p_scope->>'jobLeaseToken')::uuid)then raise exception 'intent_job_parent_conflict'using errcode='40001';end if;
 fp:=encode(extensions.digest(jsonb_build_array(p_operation,r.global_token,p_scope,null)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,101));
 select *into i from private.worker_runtime_intents where request_id=p_request_id for update;
 if found then
  select *into b from private.worker_runtime_intent_invocations where request_id=i.request_id;
  if i.fingerprint<>fp or i.scope is distinct from p_scope or i.operation<>p_operation or i.global_token<>r.global_token or i.parent_ticket is not null or b.invocation_request_id is distinct from r.request_id or b.predecessor_request_id is distinct from p_predecessor_request_id then raise exception 'intent_binding_conflict'using errcode='40001';end if;
  return jsonb_build_object('ticket',i.ticket,'state',i.state,'fresh',false);
 end if;
 if exists(select 1 from private.worker_runtime_results where request_id=p_request_id)then raise exception 'intent_result_already_exists'using errcode='40001';end if;
 perform private.assert_worker_intent_predecessor(p_operation,p_scope,r.request_id,r.global_token,p_predecessor_request_id,true);
 insert into private.worker_runtime_intents(request_id,operation,global_token,scope,fingerprint)values(p_request_id,p_operation,r.global_token,p_scope,fp)returning *into i;
 insert into private.worker_runtime_intent_invocations(request_id,invocation_request_id,claim_calls_before,predecessor_request_id)values(i.request_id,r.request_id,r.claim_calls,p_predecessor_request_id);
 return jsonb_build_object('ticket',i.ticket,'state',i.state,'fresh',true);
end;$$;

-- New effects have one scoped entry point. Existing SQL102 results are GET-only.
-- The parent, intent and result locks precede SQL102's atomic delegate. The child
-- CAS and DB effect/result share a transaction; any late check rolls them all back.
create function public.execute_worker_invocation_operation(p_request_id uuid,p_parent_request_id uuid,p_global_token uuid,p_operation text,p_input jsonb)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare r private.worker_invocations;i private.worker_runtime_intents;b private.worker_runtime_intent_invocations;o private.worker_runtime_results;op text;outcome jsonb;begin
 perform private.assert_worker_intent_confirmation();perform private.assert_worker_invocation();
 if p_request_id is null or p_parent_request_id is null or p_global_token is null then raise exception 'invalid_intent'using errcode='22023';end if;
 perform private.validate_worker_intent_atomic_scope(p_operation,p_input);op:=private.worker_intent_atomic_operation(p_operation);
 select *into r from private.worker_invocations where request_id=p_parent_request_id for update;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 select *into i from private.worker_runtime_intents where request_id=p_request_id for update;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 select *into b from private.worker_runtime_intent_invocations where request_id=p_request_id for update;
 if not found or b.invocation_request_id is distinct from r.request_id or i.global_token is distinct from p_global_token or r.global_token is distinct from p_global_token or i.operation is distinct from p_operation or i.scope is distinct from p_input or i.parent_ticket is not null or i.fingerprint is distinct from encode(extensions.digest(jsonb_build_array(p_operation,p_global_token,p_input,null)::text,'sha256'),'hex')or r.fingerprint is distinct from encode(extensions.digest(jsonb_build_array(r.global_token,r.kind,r.item_limit,r.remaining_ms)::text,'sha256'),'hex')then raise exception 'intent_binding_conflict'using errcode='40001';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,102));
 select *into o from private.worker_runtime_results where request_id=p_request_id for update;
 if found or b.dispatch_started or i.state<>'prepared'then raise exception 'intent_get_only'using errcode='55000';end if;
 if r.state<>'prepared'or not r.dispatch_started or r.deadline<=clock_timestamp()or i.created_at<r.created_at or i.created_at>r.deadline or r.remaining_ms not between 1 and 60000 or r.item_limit not between 1 and 20 or r.deadline>r.created_at+r.remaining_ms*interval'1 millisecond' then raise exception 'parent_invocation_not_dispatchable'using errcode='55000';end if;
 if not coalesce(case p_operation
  when'due_enqueue'then r.kind in('cancellation_safety','report_retention')and p_input->>'kind'=r.kind and(p_input->>'limit')::integer<=r.item_limit
  when'job_claim'then r.kind in('review_summary','cancellation_safety','report_retention')and p_input->'supportedKinds'=jsonb_build_array(r.kind)and r.claim_calls=b.claim_calls_before and r.claim_calls<r.item_limit
  when'cancellation_process'then r.kind='cancellation_safety'
  when'report_task_claim'then r.kind='report_retention'
  when'report_storage'then r.kind='report_retention'
  when'report_storage_ack'then r.kind='report_retention'
  when'report_task_complete'then r.kind='report_retention'
  when'job_settlement'then r.kind in('review_summary','cancellation_safety','report_retention')
  else false end,false)then raise exception 'intent_parent_kind_conflict'using errcode='40001';end if;
 if p_input ? 'jobId'and not exists(select 1 from private.worker_invocation_jobs where request_id=r.request_id and job_id=(p_input->>'jobId')::uuid and job_lease_token=(p_input->>'jobLeaseToken')::uuid)then raise exception 'intent_job_parent_conflict'using errcode='40001';end if;
 perform private.assert_worker_intent_predecessor(p_operation,p_input,r.request_id,p_global_token,b.predecessor_request_id,true);
 perform private.assert_current_worker_run(p_global_token);
 update private.worker_runtime_intent_invocations set dispatch_started=true,dispatched_at=clock_timestamp()where request_id=p_request_id and not dispatch_started;
 if not found then raise exception 'intent_get_only'using errcode='55000';end if;
 outcome:=public.execute_worker_runtime_operation(p_request_id,p_global_token,op,p_input);
 -- A signal is not the effect deadline. This post-check is inside the same TX.
 perform private.assert_current_worker_run(p_global_token);
 if r.deadline<=clock_timestamp()then raise exception 'invocation_expired'using errcode='55000';end if;
 return outcome;
end;$$;

create function public.confirm_worker_runtime_intent(p_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare i private.worker_runtime_intents;o private.worker_runtime_results;b private.worker_runtime_intent_invocations;
 r private.worker_invocations;c private.worker_runtime_intent_confirmations;predecessor_fp text;op text;s jsonb;job jsonb;proof boolean;begin
 perform private.assert_worker_intent_confirmation();
 if p_request_id is null then raise exception 'invalid_intent'using errcode='22023';end if;
 select *into b from private.worker_runtime_intent_invocations where request_id=p_request_id;
 if found then select *into r from private.worker_invocations where request_id=b.invocation_request_id for update;end if;
 select *into i from private.worker_runtime_intents where request_id=p_request_id for update;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 if i.fingerprint is distinct from encode(extensions.digest(jsonb_build_array(i.operation,i.global_token,i.scope,i.parent_ticket)::text,'sha256'),'hex')then raise exception 'intent_scope_fingerprint_conflict'using errcode='40001';end if;
 select fingerprint into predecessor_fp from private.worker_runtime_intents where request_id=b.predecessor_request_id;
 select *into c from private.worker_runtime_intent_confirmations where request_id=p_request_id;
 if i.state='confirmed'then
  if c.intent_fingerprint is distinct from i.fingerprint or c.parent_invocation_request_id is distinct from b.invocation_request_id or c.parent_fingerprint is distinct from r.fingerprint or c.predecessor_request_id is distinct from b.predecessor_request_id or c.predecessor_fingerprint is distinct from predecessor_fp then raise exception 'intent_confirmation_unproven'using errcode='55000';end if;
  return jsonb_build_object('ticket',i.ticket,'state','confirmed');
 end if;
 op:=private.worker_intent_atomic_operation(i.operation);s:=i.scope;
 perform private.validate_worker_intent_atomic_scope(i.operation,s);
 if i.fingerprint is distinct from encode(extensions.digest(jsonb_build_array(i.operation,i.global_token,s,i.parent_ticket)::text,'sha256'),'hex')then raise exception 'intent_scope_fingerprint_conflict'using errcode='40001';end if;
 select *into o from private.worker_runtime_results where request_id=i.request_id for update;
 if not found then raise exception 'intent_result_missing'using errcode='55000';end if;
 if o.state<>'completed'or o.closed_at is null or o.result is null then raise exception 'intent_result_unproven'using errcode='55000';end if;
 if o.created_at<i.created_at then raise exception 'intent_result_provenance_conflict'using errcode='40001';end if;
 if o.global_token<>i.global_token or o.operation<>op or o.input is distinct from s or o.fingerprint is distinct from encode(extensions.digest(jsonb_build_array(i.global_token,op,s)::text,'sha256'),'hex')then raise exception 'intent_result_scope_conflict'using errcode='40001';end if;
 if b.invocation_request_id is not null then
  -- Late GET-only reconciliation verifies original provenance, never lease expiry
  -- as evidence and never asserts/extends/replaces the current global lease.
  if r.request_id is null or r.fingerprint is distinct from encode(extensions.digest(jsonb_build_array(r.global_token,r.kind,r.item_limit,r.remaining_ms)::text,'sha256'),'hex')or r.remaining_ms not between 1 and 60000 or r.item_limit not between 1 and 20 or r.deadline>r.created_at+r.remaining_ms*interval'1 millisecond'or not b.dispatch_started or b.dispatched_at<i.created_at or b.dispatched_at>r.deadline or o.created_at<b.dispatched_at or r.global_token<>i.global_token or not r.dispatch_started or i.created_at<r.created_at or i.created_at>r.deadline or o.created_at<i.created_at or o.closed_at>r.deadline then raise exception 'intent_parent_provenance_conflict'using errcode='40001';end if;
  if not coalesce(case i.operation
   when'due_enqueue'then r.kind in('cancellation_safety','report_retention')and s->>'kind'=r.kind and(s->>'limit')::integer<=r.item_limit
   when'job_claim'then r.kind in('review_summary','cancellation_safety','report_retention')and s->'supportedKinds'=jsonb_build_array(r.kind)and b.claim_calls_before<r.item_limit and r.claim_calls>b.claim_calls_before
   when'cancellation_process'then r.kind='cancellation_safety'
   when'report_task_claim'then r.kind='report_retention'
   when'report_storage'then r.kind='report_retention'
  when'report_storage_ack'then r.kind='report_retention'
   when'report_task_complete'then r.kind='report_retention'
   when'job_settlement'then r.kind in('review_summary','cancellation_safety','report_retention')
   else false end,false)then raise exception 'intent_parent_kind_conflict'using errcode='40001';end if;
  if s ? 'jobId'and not exists(select 1 from private.worker_invocation_jobs where request_id=r.request_id and job_id=(s->>'jobId')::uuid and job_lease_token=(s->>'jobLeaseToken')::uuid)then raise exception 'intent_job_parent_conflict'using errcode='40001';end if;
 end if;
 if b.invocation_request_id is not null then perform private.assert_worker_intent_predecessor(i.operation,s,r.request_id,i.global_token,b.predecessor_request_id,false);end if;
 proof:=false;
 case op
 when'due_enqueue'then
  -- DB102 records the enqueue and result in the same transaction. No caller count.
  proof:=jsonb_typeof(o.result)='object'and o.result-'enqueued'='{}'::jsonb and jsonb_typeof(o.result->'enqueued')='number'and(o.result->>'enqueued')~'^(0|[1-9][0-9]?)$'and(o.result->>'enqueued')::integer<=(s->>'limit')::integer;
 when'terminal_maintenance'then proof:=jsonb_typeof(o.result)='object'and o.result-'purged'='{}'::jsonb and jsonb_typeof(o.result->'purged')='number'and(o.result->>'purged')~'^(0|[1-9][0-9]?)$'and(o.result->>'purged')::integer<=(s->>'limit')::integer;
 when'job_claim'then
  job:=o.result->'job';
  if job='null'::jsonb then proof:=b.invocation_request_id is null or r.idle_seen;
  else proof:=exists(select 1 from private.worker_runtime_job_slots slots join private.worker_jobs j on j.id=slots.job_id where slots.global_token=i.global_token and j.id=(job->>'jobId')::uuid and j.kind=any(array(select jsonb_array_elements_text(s->'supportedKinds')))and
   (exists(select 1 from private.worker_job_run_fences f where f.job_id=j.id and f.job_lease_token=(job->>'leaseToken')::uuid and f.worker_run_token=i.global_token)
    or exists(select 1 from private.worker_invocation_jobs a join private.worker_invocations parent on parent.request_id=a.request_id where a.job_id=j.id and a.job_lease_token=(job->>'leaseToken')::uuid and parent.global_token=i.global_token)));
   if b.invocation_request_id is not null then proof:=proof and exists(select 1 from private.worker_invocation_jobs where request_id=r.request_id and job_id=(job->>'jobId')::uuid and job_lease_token=(job->>'leaseToken')::uuid and claim_seq=b.claim_calls_before+1);end if;
  end if;
 when'cancellation_process'then proof:=(o.result->>'status')in('not_due','policy_pending','held','applied')and o.result->'generation'=s->'generation'and jsonb_typeof(o.result->'changed')='boolean'and exists(select 1 from private.worker_jobs j where j.id=(s->>'jobId')::uuid and j.kind='cancellation_safety'and j.payload->>'identityId'=s->>'identityId'and j.payload->'generation'=s->'generation');
  if b.invocation_request_id is not null then proof:=proof and exists(select 1 from private.worker_invocation_jobs where request_id=r.request_id and job_id=(s->>'jobId')::uuid and job_lease_token=(s->>'jobLeaseToken')::uuid and effect='cancellation_processed');end if;
 when'job_settlement'then proof:=o.result=jsonb_build_object('jobId',s->'jobId','status',s->'status')and exists(select 1 from private.worker_jobs j where j.id=(s->>'jobId')::uuid and j.status=s->>'status');
  if b.invocation_request_id is not null then proof:=proof and exists(select 1 from private.worker_invocation_jobs where request_id=r.request_id and job_id=(s->>'jobId')::uuid and job_lease_token=(s->>'jobLeaseToken')::uuid and settled_status=s->>'status');end if;
 when'report_task_claim'then
  if o.result='null'::jsonb then proof:=true;
  else proof:=exists(select 1 from private.report_purge_tasks t where t.id=(o.result->>'taskId')::uuid and t.lease_token=(o.result->>'taskLeaseToken')::uuid and t.job_id=(s->>'jobId')::uuid and t.job_lease_token=(s->>'jobLeaseToken')::uuid and t.worker_run_token=i.global_token and t.state in('running','completed'));end if;
 when'report_delete_begin'then
  proof:=exists(select 1 from private.report_purge_tasks t join private.report_purge_dispatches d on d.task_id=t.id join private.report_purge_delete_acks a on a.task_id=t.id where t.id=(s->>'taskId')::uuid and t.state='completed'and t.lease_token=(s->>'taskLeaseToken')::uuid and t.job_id=(s->>'jobId')::uuid and t.job_lease_token=(s->>'jobLeaseToken')::uuid and t.worker_run_token=i.global_token and t.object_id=(s->>'objectId')::uuid and d.task_lease_token=t.lease_token and d.job_id=t.job_id and d.job_lease_token=t.job_lease_token and d.worker_run_token=t.worker_run_token and d.object_id=t.object_id and d.asset_id=t.asset_id and a.object_id=d.object_id and a.asset_id=d.asset_id and a.recorded_at>=d.dispatched_at and not exists(select 1 from storage.objects obj where obj.id=t.object_id or(obj.bucket_id=t.bucket_id and obj.name=t.object_name)));
 when'report_delete_ack'then
  proof:=exists(select 1 from private.report_purge_delete_acks a join private.report_purge_dispatches d on d.task_id=a.task_id join private.report_purge_tasks t on t.id=a.task_id where a.task_id=(s->>'taskId')::uuid and a.ack_sha256=s->>'ackSha256'and a.asset_id=d.asset_id and a.object_id=(s->>'objectId')::uuid and a.object_id=d.object_id and a.recorded_at>=d.dispatched_at and d.task_lease_token=(s->>'taskLeaseToken')::uuid and d.job_id=(s->>'jobId')::uuid and d.job_lease_token=(s->>'jobLeaseToken')::uuid and d.worker_run_token=i.global_token and t.asset_id=a.asset_id and t.object_id=a.object_id and o.result=jsonb_build_object('receiptId',a.id,'taskId',a.task_id,'assetId',a.asset_id,'objectId',a.object_id,'ackSha256',a.ack_sha256)and not exists(select 1 from storage.objects obj where obj.id=t.object_id or(obj.bucket_id=t.bucket_id and obj.name=t.object_name)));
 when'report_task_complete'then
  proof:=o.result->>'taskId'=s->>'taskId'and o.result->>'status'='completed'and
   (exists(select 1 from private.report_purge_terminal_receipts t where t.task_id=(s->>'taskId')::uuid and t.job_id=(s->>'jobId')::uuid and t.task_lease_token=(s->>'taskLeaseToken')::uuid and t.job_lease_token=(s->>'jobLeaseToken')::uuid and t.evidence_sha256=s->>'evidenceSha256'and s->'objectId'='null'::jsonb)
    or exists(select 1 from private.report_purge_tasks t join private.report_purge_dispatches d on d.task_id=t.id join private.report_purge_delete_acks a on a.task_id=t.id where t.id=(s->>'taskId')::uuid and t.state='completed'and t.evidence_sha256=s->>'evidenceSha256'and t.lease_token=(s->>'taskLeaseToken')::uuid and t.job_id=(s->>'jobId')::uuid and t.job_lease_token=(s->>'jobLeaseToken')::uuid and t.worker_run_token=i.global_token and t.object_id=(s->>'objectId')::uuid and d.task_lease_token=t.lease_token and d.job_id=t.job_id and d.job_lease_token=t.job_lease_token and d.worker_run_token=t.worker_run_token and d.object_id=t.object_id and d.asset_id=t.asset_id and a.object_id=d.object_id and a.asset_id=d.asset_id and a.recorded_at>=d.dispatched_at and not exists(select 1 from storage.objects obj where obj.id=t.object_id or(obj.bucket_id=t.bucket_id and obj.name=t.object_name))));
 end case;
 if proof is distinct from true then raise exception 'intent_effect_unproven'using errcode='55000';end if;
 insert into private.worker_runtime_intent_confirmations(request_id,intent_fingerprint,result_fingerprint,parent_invocation_request_id,parent_fingerprint,predecessor_request_id,predecessor_fingerprint,proof_sha256)values(i.request_id,i.fingerprint,o.fingerprint,b.invocation_request_id,r.fingerprint,b.predecessor_request_id,predecessor_fp,encode(extensions.digest(jsonb_build_array(i.request_id,i.fingerprint,o.fingerprint,o.closed_at,o.result,b.invocation_request_id,r.fingerprint,b.predecessor_request_id,predecessor_fp)::text,'sha256'),'hex'));
 update private.worker_runtime_intents set state='confirmed',updated_at=clock_timestamp()where request_id=i.request_id;
 return jsonb_build_object('ticket',i.ticket,'state','confirmed');
end;$$;

create or replace function public.read_worker_runtime_pending_v2()returns jsonb language plpgsql volatile security definer set search_path=''as $$begin
 perform private.assert_worker_runtime_atomic();
 return jsonb_build_object('hasPending',exists(select 1 from private.worker_runtime_results where state='external_pending')
  or exists(select 1 from private.worker_runtime_intents i where i.state<>'confirmed'or not exists(select 1 from private.worker_runtime_intent_confirmations c where c.request_id=i.request_id and c.intent_fingerprint=i.fingerprint))
  or exists(select 1 from private.member_cleanup_dispatches d join private.member_cleanup_tasks t on t.id=d.task_id where t.state<>'completed')
  or exists(select 1 from private.worker_invocations where state in('prepared','unknown')));
end;$$;
do $$declare own text;f record;t text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 foreach t in array array['worker_intent_confirmation_control','worker_runtime_intent_invocations','worker_runtime_intent_confirmations']loop
  execute format('alter table private.%I owner to %I',t,own);execute format('alter table private.%I enable row level security',t);execute format('revoke all on private.%I from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',t);
 end loop;
 for f in select oid::regprocedure sig from pg_proc where pronamespace in('public'::regnamespace,'private'::regnamespace)and proname in('assert_worker_intent_confirmation','worker_intent_atomic_operation','validate_worker_intent_atomic_scope','assert_worker_intent_predecessor','prepare_worker_invocation_intent','execute_worker_invocation_operation','confirm_worker_runtime_intent')loop
  execute format('alter function %s owner to %I',f.sig,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.sig);
 end loop;
end;$$;
-- read_worker_runtime_pending_v2 keeps its existing OID/owner/ACL. No grant added.
commit;
