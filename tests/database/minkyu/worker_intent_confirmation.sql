-- Fresh disposable SQL109+114 scratch only. All fixture effects roll back.
begin;
do $$declare sig text;role_name text;begin
 if exists(select 1 from private.worker_runtime_intents)or exists(select 1 from private.worker_runtime_results)or exists(select 1 from private.worker_invocations)or exists(select 1 from private.worker_jobs)or exists(select 1 from private.report_purge_terminal_receipts)then raise exception 'empty_disposable_scratch_required';end if;
 if(select enabled from private.worker_intent_confirmation_control)or(select enabled from private.worker_runtime_journal_control)or(select enabled from private.worker_runtime_atomic_control)or(select enabled from private.worker_invocation_control)then raise exception 'default_controls_open';end if;
 foreach sig in array array['prepare_worker_invocation_intent(uuid,uuid,text,jsonb,uuid)','execute_worker_invocation_operation(uuid,uuid,uuid,text,jsonb)','confirm_worker_runtime_intent(uuid)']loop
  foreach role_name in array array['anon','authenticated','service_role','yumidang_worker_queue']loop
   if has_function_privilege(role_name,'public.'||sig,'EXECUTE')then raise exception 'confirmation_default_execute_open';end if;
  end loop;
 end loop;
 assert(select relrowsecurity from pg_class where oid='private.worker_runtime_intent_confirmations'::regclass);
 assert(select relrowsecurity from pg_class where oid='private.worker_runtime_intent_invocations'::regclass);
end;$$;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
update private.worker_runtime_atomic_control set enabled=true;
update private.worker_runtime_journal_control set enabled=true;
update private.worker_invocation_control set enabled=true;
-- New confirmation guard still closes both entry points.
do $$begin
 begin perform public.confirm_worker_runtime_intent('11111111-1111-4111-8111-111111111111');raise exception 'default_guard_bypass';exception when sqlstate'55000'then null;end;
end;$$;
update private.worker_intent_confirmation_control set enabled=true;
update private.global_worker_run set token='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',expires_at=clock_timestamp()+interval'180 seconds';
-- A rollback-only delay proves a deadline crossed after the real claim/result
-- is still rejected atomically by the new executor, not by an AbortSignal.
create function private.minkyu_sql114_result_delay()returns trigger language plpgsql set search_path=''as $$begin
 if current_setting('minkyu.sql114.delay',true)='true'then perform pg_sleep(0.08);end if;return new;
end;$$;
create trigger minkyu_sql114_result_delay before insert on private.worker_runtime_results for each row execute function private.minkyu_sql114_result_delay();
-- A real DB102 idle claim is committed in this transaction alongside SQL109 audit.
-- No fabricated caller result/count is accepted by confirm.
do $$declare parent uuid:='11111111-1111-4111-8111-111111111111';child uuid:='22222222-2222-4222-8222-222222222222';tok uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 scope_input jsonb:=jsonb_build_object('workerId','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','leaseSeconds',180,'supportedKinds',jsonb_build_array('review_summary'));v jsonb;original_result jsonb;expiry timestamptz;original_deadline timestamptz;started timestamptz;begin
 perform public.prepare_queue_invocation(parent,tok,'review_summary',1,10000);
 begin perform public.prepare_worker_invocation_intent(child,parent,'job_claim',scope_input);raise exception 'child_without_parent_cas';exception when sqlstate'55000'then null;end;
 assert not exists(select 1 from private.worker_runtime_intents where request_id=child);
 perform public.claim_queue_invocation_dispatch(parent,tok,'review_summary',1,10000);
 v:=public.prepare_worker_invocation_intent(child,parent,'job_claim',scope_input);assert(v->>'fresh')::boolean;
 assert(select scope=scope_input and parent_ticket is null from private.worker_runtime_intents where request_id=child);
 v:=public.prepare_worker_invocation_intent(child,parent,'job_claim',scope_input);assert not(v->>'fresh')::boolean;
 begin perform public.prepare_worker_invocation_intent(child,parent,'job_claim',scope_input||jsonb_build_object('workerId','cccccccc-cccc-4ccc-8ccc-cccccccccccc'));raise exception 'same_key_scope_conflict_missing';exception when sqlstate'40001'then null;end;
 begin perform public.prepare_worker_invocation_intent('33333333-3333-4333-8333-333333333333',parent,'due_enqueue',jsonb_build_object('kind','cancellation_safety','limit',1));raise exception 'parent_kind_conflict_missing';exception when sqlstate'40001'then null;end;
 begin perform public.confirm_worker_runtime_intent(child);raise exception 'missing_result_confirmed';exception when sqlstate'55000'then null;end;
 -- Wrong parent/input cannot consume the child dispatch CAS or execute an effect.
 begin perform public.execute_worker_invocation_operation(child,'99999999-9999-4999-8999-999999999999',tok,'job_claim',scope_input);raise exception 'wrong_parent_dispatch';exception when sqlstate'PT404'then null;end;
 begin perform public.execute_worker_invocation_operation(child,parent,tok,'job_claim',scope_input||jsonb_build_object('workerId','cccccccc-cccc-4ccc-8ccc-cccccccccccc'));raise exception 'different_input_dispatch';exception when sqlstate'40001'then null;end;
 select deadline into original_deadline from private.worker_invocations where request_id=parent;
 update private.worker_invocations set deadline=clock_timestamp()-interval'1 second'where request_id=parent;
 begin perform public.execute_worker_invocation_operation(child,parent,tok,'job_claim',scope_input);raise exception 'late_first_dispatch';exception when sqlstate'55000'then null;end;
 assert not exists(select 1 from private.worker_runtime_results where request_id=child);
 assert(select not dispatch_started and dispatched_at is null from private.worker_runtime_intent_invocations where request_id=child);
 assert(select claim_calls=0 and not idle_seen from private.worker_invocations where request_id=parent);
 -- Cross the deadline only after SQL102 has performed the actual idle claim.
 update private.worker_invocations set deadline=clock_timestamp()+interval'50 milliseconds'where request_id=parent;
 perform set_config('minkyu.sql114.delay','true',true);started:=clock_timestamp();
 begin perform public.execute_worker_invocation_operation(child,parent,tok,'job_claim',scope_input);raise exception 'late_effect_not_rolled_back';exception when sqlstate'55000'then assert sqlerrm='invocation_expired';end;
 assert clock_timestamp()-started>=interval'80 milliseconds';
 perform set_config('minkyu.sql114.delay','false',true);
 assert not exists(select 1 from private.worker_runtime_results where request_id=child);
 assert(select not dispatch_started and dispatched_at is null from private.worker_runtime_intent_invocations where request_id=child);
 assert(select claim_calls=0 and not idle_seen from private.worker_invocations where request_id=parent);
 assert not exists(select 1 from private.worker_invocation_jobs where request_id=parent);
 update private.worker_invocations set deadline=original_deadline where request_id=parent;
 v:=public.execute_worker_invocation_operation(child,parent,tok,'job_claim',scope_input);assert v->'result'='{"job":null}'::jsonb;
 original_result:=public.get_worker_runtime_operation(child);
 begin perform public.execute_worker_invocation_operation(child,parent,tok,'job_claim',scope_input);raise exception 'stored_result_dispatch_repeated';exception when sqlstate'55000'then assert sqlerrm='intent_get_only';end;
 assert public.get_worker_runtime_operation(child)=original_result;
 assert(select claim_calls=1 and idle_seen from private.worker_invocations where request_id=parent);
 assert(select dispatch_started and dispatched_at is not null from private.worker_runtime_intent_invocations where request_id=child);
 assert(select state='prepared'from private.worker_runtime_intents where request_id=child);
 perform public.observe_worker_runtime_intent(child,false);
 assert(select state='unknown'from private.worker_runtime_intents where request_id=child);
 update private.global_worker_run set expires_at=clock_timestamp()-interval'1 second';
 select expires_at into expiry from private.global_worker_run;
 v:=public.confirm_worker_runtime_intent(child);assert v->>'state'='confirmed';
 assert public.confirm_worker_runtime_intent(child)=v;
 assert(select expires_at=expiry and token=tok from private.global_worker_run);
 assert(select count(*)=1 from private.worker_runtime_intent_confirmations where request_id=child);
 assert(select state='completed'and result='{"job":null}'::jsonb from private.worker_runtime_results where request_id=child);
 assert(select scope=scope_input from private.worker_runtime_intents where request_id=child);
 assert(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean; -- parent remains pending
 perform public.complete_queue_invocation(parent);
 assert not(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean;
end;$$;
-- Actual DB BEGIN -> ACK -> storage complete -> metadata complete chain.
-- Synthetic metadata deletion is a DB fixture, never external byte/provider proof.
set local storage.allow_delete_query='true';
create function pg_temp.sql114_id(n integer)returns uuid language sql immutable as $$select('ef114000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
insert into auth.users(id,email)select pg_temp.sql114_id(x),'sql114-'||x||'@test.invalid'from generate_series(1,2)x;
insert into public.profiles(id,real_name,birth_date,gender)select pg_temp.sql114_id(x),'합성회원','1990-01-01','female'from generate_series(1,2)x;
insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,status,hide_target,fingerprint,final_closed_at,retention_due_at)
select pg_temp.sql114_id(10),pg_temp.sql114_id(1),e.id,pg_temp.sql114_id(11),'member',pg_temp.sql114_id(2),'online',array['other'],'resolved',false,repeat('a',64),statement_timestamp()-interval'2161 hours',statement_timestamp()-interval'1 hour'from private.member_episodes e where e.profile_id=pg_temp.sql114_id(1)and e.ended_at is null;
insert into private.member_report_details(report_id,description)values(pg_temp.sql114_id(10),'파기할 합성 설명');
insert into private.report_capture_assets(id,owner_id,owner_episode_id,object_name,state,report_id,uploaded_at)
select pg_temp.sql114_id(12),pg_temp.sql114_id(1),e.id,pg_temp.sql114_id(1)::text||'/'||pg_temp.sql114_id(12)::text||'.png','attached',pg_temp.sql114_id(10),clock_timestamp()from private.member_episodes e where e.profile_id=pg_temp.sql114_id(1)and e.ended_at is null;
insert into storage.objects(id,bucket_id,name,owner_id,metadata)values(pg_temp.sql114_id(13),'report-evidence',pg_temp.sql114_id(1)::text||'/'||pg_temp.sql114_id(12)::text||'.png',pg_temp.sql114_id(1)::text,'{"mimetype":"image/png","size":64}');
update private.global_worker_run set expires_at=clock_timestamp()+interval'180 seconds';
update private.report_purge_control set enabled=true;
do $$declare sig text;parent uuid:=pg_temp.sql114_id(20);tok uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';v jsonb;j jsonb;t jsonb;base jsonb;ack_input jsonb;complete_input jsonb;original_parent_deadline timestamptz;begin
 -- Exact clone-only readiness grants; rollback restores every original ACL.
 foreach sig in array array['public.enqueue_report_retention_purges(uuid,integer)','public.claim_report_retention_task(uuid,uuid,uuid)','public.check_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid)','public.get_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid)','public.record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text)','public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)','public.purge_report_retention_terminal_receipts(uuid,integer)','public.begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid)']loop execute format('grant execute on function %s to service_role',sig);end loop;
 assert private.supported_worker_kind_ready('report_retention');
 perform public.prepare_queue_invocation(parent,tok,'report_retention',1,60000);perform public.claim_queue_invocation_dispatch(parent,tok,'report_retention',1,60000);
 perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(21),parent,'due_enqueue','{"kind":"report_retention","limit":1}');
 v:=public.execute_worker_invocation_operation(pg_temp.sql114_id(21),parent,tok,'due_enqueue','{"kind":"report_retention","limit":1}');assert v->'result'='{"enqueued":1}'::jsonb;perform public.confirm_worker_runtime_intent(pg_temp.sql114_id(21));
 base:=jsonb_build_object('workerId',pg_temp.sql114_id(22),'leaseSeconds',180,'supportedKinds',jsonb_build_array('report_retention'));
 perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(23),parent,'job_claim',base);
 j:=public.execute_worker_invocation_operation(pg_temp.sql114_id(23),parent,tok,'job_claim',base)->'result'->'job';assert j->>'kind'='report_retention';perform public.confirm_worker_runtime_intent(pg_temp.sql114_id(23));
 base:=jsonb_build_object('jobId',j->'jobId','jobLeaseToken',j->'leaseToken');
 perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(24),parent,'report_task_claim',base);
 t:=public.execute_worker_invocation_operation(pg_temp.sql114_id(24),parent,tok,'report_task_claim',base)->'result';assert t->>'kind'='storage_object'and not(t?'bucketId')and not(t?'objectName');perform public.confirm_worker_runtime_intent(pg_temp.sql114_id(24));
 base:=base||jsonb_build_object('taskId',t->'taskId','taskLeaseToken',t->'taskLeaseToken','objectId',t->'objectId');
 perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(25),parent,'report_storage',base);
 v:=public.execute_worker_invocation_operation(pg_temp.sql114_id(25),parent,tok,'report_storage',base);assert v->>'state'='external_pending';
 begin perform public.confirm_worker_runtime_intent(pg_temp.sql114_id(25));raise exception 'pending_begin_confirmed';exception when sqlstate'55000'then null;end;
 ack_input:=base||jsonb_build_object('ackSha256',repeat('b',64));complete_input:=base||jsonb_build_object('evidenceSha256',repeat('c',64));
 begin perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(26),parent,'report_storage_ack',ack_input);raise exception 'missing_ack_predecessor';exception when sqlstate'40001'then null;end;
 begin perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(26),parent,'report_storage_ack',ack_input,pg_temp.sql114_id(24));raise exception 'wrong_ack_predecessor';exception when sqlstate'40001'then null;end;
 begin perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(28),parent,'report_task_complete',complete_input,pg_temp.sql114_id(25));raise exception 'begin_as_ack_predecessor';exception when sqlstate'40001'then null;end;
 assert not exists(select 1 from private.worker_runtime_intents where request_id=pg_temp.sql114_id(26));
 assert not exists(select 1 from private.report_purge_delete_acks where task_id=(t->>'taskId')::uuid);
 -- No ACK proof means BEGIN stays unresolved even after metadata absence.
 delete from storage.objects where id=(t->>'objectId')::uuid;
 begin perform public.confirm_worker_runtime_intent(pg_temp.sql114_id(25));raise exception 'absence_without_ack_confirmed';exception when sqlstate'55000'then null;end;
 perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(26),parent,'report_storage_ack',ack_input,pg_temp.sql114_id(25));
 select deadline into original_parent_deadline from private.worker_invocations where request_id=parent;
 update private.worker_invocations set deadline=clock_timestamp()-interval'1 second'where request_id=parent;
 begin perform public.execute_worker_invocation_operation(pg_temp.sql114_id(26),parent,tok,'report_storage_ack',ack_input);raise exception 'late_ack_dispatch';exception when sqlstate'55000'then null;end;
 assert not exists(select 1 from private.report_purge_delete_acks where task_id=(t->>'taskId')::uuid);
 update private.worker_invocations set deadline=original_parent_deadline where request_id=parent;
 v:=public.execute_worker_invocation_operation(pg_temp.sql114_id(26),parent,tok,'report_storage_ack',ack_input);assert v->>'state'='completed';
 assert public.get_worker_runtime_operation(pg_temp.sql114_id(26))->'result'=v->'result'; -- response-loss GET-only
 begin perform public.execute_worker_invocation_operation(pg_temp.sql114_id(26),parent,tok,'report_storage_ack',ack_input);raise exception 'ack_retransmitted';exception when sqlstate'55000'then assert sqlerrm='intent_get_only';end;
 perform public.confirm_worker_runtime_intent(pg_temp.sql114_id(26));
 begin perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(27),parent,'report_storage_ack',ack_input,pg_temp.sql114_id(25));raise exception 'new_key_original_ack_retransmit';exception when sqlstate'55000'then assert sqlerrm='intent_get_only';end;
 begin perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(28),parent,'report_task_complete',complete_input,pg_temp.sql114_id(24));raise exception 'wrong_complete_predecessor';exception when sqlstate'40001'then null;end;
 perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(28),parent,'report_task_complete',complete_input,pg_temp.sql114_id(26));
 v:=public.execute_worker_invocation_operation(pg_temp.sql114_id(28),parent,tok,'report_task_complete',complete_input);assert v->'result'->>'status'='completed';
 perform public.confirm_worker_runtime_intent(pg_temp.sql114_id(28));perform public.confirm_worker_runtime_intent(pg_temp.sql114_id(25));
 assert(select state='confirmed'from private.worker_runtime_intents where request_id=pg_temp.sql114_id(25));
 assert(select count(*)=1 from private.report_purge_delete_acks where task_id=(t->>'taskId')::uuid);
 -- The metadata completion has no Storage predecessor and leaves terminal proof.
 base:=jsonb_build_object('jobId',j->'jobId','jobLeaseToken',j->'leaseToken');
 perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(29),parent,'report_task_claim',base);
 t:=public.execute_worker_invocation_operation(pg_temp.sql114_id(29),parent,tok,'report_task_claim',base)->'result';assert t->>'kind'='report_metadata';perform public.confirm_worker_runtime_intent(pg_temp.sql114_id(29));
 complete_input:=base||jsonb_build_object('taskId',t->'taskId','taskLeaseToken',t->'taskLeaseToken','objectId',null,'evidenceSha256',repeat('d',64));
 perform public.prepare_worker_invocation_intent(pg_temp.sql114_id(30),parent,'report_task_complete',complete_input);
 v:=public.execute_worker_invocation_operation(pg_temp.sql114_id(30),parent,tok,'report_task_complete',complete_input);assert v->'result'->>'status'='completed';perform public.confirm_worker_runtime_intent(pg_temp.sql114_id(30));
 perform public.complete_queue_invocation(parent);
 assert not(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean;
 assert(select count(distinct job_id)=1 from private.worker_runtime_job_slots where global_token=tok);
 assert(select predecessor_request_id=pg_temp.sql114_id(25)from private.worker_runtime_intent_confirmations where request_id=pg_temp.sql114_id(26));
 assert(select predecessor_request_id=pg_temp.sql114_id(26)from private.worker_runtime_intent_confirmations where request_id=pg_temp.sql114_id(28));
end;$$;

-- Original SQL101 ABI still prepares legacy intents; observed is not proof.
update private.global_worker_run set expires_at=clock_timestamp()+interval'180 seconds';
update private.report_purge_control set enabled=true;
do $$declare tok uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';good uuid:='44444444-4444-4444-8444-444444444444';bad uuid:='55555555-5555-4555-8555-555555555555';v jsonb;begin
 perform public.prepare_worker_runtime_intent(good,'terminal_maintenance',tok,'{"limit":1}',null);
 v:=public.execute_worker_runtime_operation(good,tok,'terminal_maintenance','{"limit":1}');assert(v->'result'->>'purged')::integer=0;
 perform public.observe_worker_runtime_intent(good,true);
 assert(select state='observed_response'from private.worker_runtime_intents where request_id=good);
 assert(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean;
 assert(public.confirm_worker_runtime_intent(good)->>'state')='confirmed';
 assert not(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean;
 perform public.prepare_worker_runtime_intent(bad,'terminal_maintenance',tok,'{}',null);
 perform public.execute_worker_runtime_operation(bad,tok,'terminal_maintenance','{"limit":1}');
 perform public.observe_worker_runtime_intent(bad,true);
 begin perform public.confirm_worker_runtime_intent(bad);raise exception 'incomplete_legacy_scope_confirmed';exception when sqlstate'22023'then null;end;
 assert(select state='observed_response'from private.worker_runtime_intents where request_id=bad);
 assert not exists(select 1 from private.worker_runtime_intent_confirmations where request_id=bad);
 assert(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean;
end;$$;
-- Negative tampering fixtures test both directions of the matching predicate.
-- These private inserts are NOT successful execution evidence.
do $$declare tok uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';key uuid:='66666666-6666-4666-8666-666666666666';scope jsonb:='{"limit":2}';begin
 perform public.prepare_worker_runtime_intent(key,'terminal_maintenance',tok,scope,null);
 insert into private.worker_runtime_results(request_id,global_token,operation,fingerprint,input,result,state,closed_at)values(key,tok,'terminal_maintenance',encode(extensions.digest(jsonb_build_array(tok,'terminal_maintenance','{"limit":1}'::jsonb)::text,'sha256'),'hex'),'{"limit":1}','{"purged":0}','completed',clock_timestamp());
 begin perform public.confirm_worker_runtime_intent(key);raise exception 'different_scope_confirmed';exception when sqlstate'40001'then null;end;
 update private.worker_runtime_results set input=scope,fingerprint=encode(extensions.digest(jsonb_build_array(tok,'terminal_maintenance',scope)::text,'sha256'),'hex'),global_token='dddddddd-dddd-4ddd-8ddd-dddddddddddd'where request_id=key;
 begin perform public.confirm_worker_runtime_intent(key);raise exception 'different_token_confirmed';exception when sqlstate'40001'then null;end;
 update private.worker_runtime_results set global_token=tok,operation='due_enqueue'where request_id=key;
 begin perform public.confirm_worker_runtime_intent(key);raise exception 'different_operation_confirmed';exception when sqlstate'40001'then null;end;
 assert(select state='prepared'from private.worker_runtime_intents where request_id=key);
end;$$;
-- Unresolved report dispatch remains pending despite an observed HTTP response.
do $$declare key uuid:='77777777-7777-4777-8777-777777777777';tok uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';scope jsonb:=jsonb_build_object('taskId','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','taskLeaseToken','ffffffff-ffff-4fff-8fff-ffffffffffff','jobId','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','jobLeaseToken','cccccccc-cccc-4ccc-8ccc-cccccccccccc','objectId','dddddddd-dddd-4ddd-8ddd-dddddddddddd');begin
 insert into private.worker_runtime_intents(request_id,operation,global_token,scope,fingerprint,state)values(key,'report_storage',tok,scope,encode(extensions.digest(jsonb_build_array('report_storage',tok,scope,null)::text,'sha256'),'hex'),'observed_response');
 insert into private.worker_runtime_results(request_id,global_token,operation,fingerprint,input,result,state)values(key,tok,'report_delete_begin',encode(extensions.digest(jsonb_build_array(tok,'report_delete_begin',scope)::text,'sha256'),'hex'),scope,'{}','external_pending');
 begin perform public.confirm_worker_runtime_intent(key);raise exception 'external_pending_confirmed';exception when sqlstate'55000'then null;end;
 assert(select state='external_pending'from private.worker_runtime_results where request_id=key);
 assert(select state='observed_response'from private.worker_runtime_intents where request_id=key);
 assert not exists(select 1 from private.worker_runtime_intent_confirmations where request_id=key);
 assert(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean;
end;$$;
rollback;
