-- 민규: 합성 격리 DB 전용. 원문·회원 데이터 조회 없이 전역/개별 점유 및 권한을 검증한다.
-- psql -X -v ON_ERROR_STOP=1 -f tests/database/minkyu/worker_job_fences.sql <scratch DB>
begin;
-- 기존 큐가 있는 DB에서 실수로 테스트하지 않는다. 운영에서는 실행하지 않는다.
do $$ begin
  if exists(select 1 from private.worker_jobs) then raise exception 'scratch_queue_must_be_empty'; end if;
end; $$;

create function pg_temp.expect_conflict(p_sql text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    raise exception 'expected_worker_fence_conflict';
  exception when sqlstate '40001' then
    if sqlerrm<>'state_conflict' then raise; end if;
  end;
end; $$;

do $$ declare v_role text; v_sig text; v_name text; begin
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if has_table_privilege(v_role,'private.worker_job_run_fences','SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'direct_fence_table_permission';
    end if;
    if has_function_privilege(v_role,'private.assert_current_worker_run(uuid)','EXECUTE')
      or has_function_privilege(v_role,'private.assert_current_worker_job(uuid,uuid,uuid)','EXECUTE') then
      raise exception 'private_fence_helper_permission';
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid='private.worker_job_run_fences'::regclass) then
    raise exception 'fence_rls_required';
  end if;
  foreach v_sig in array array['claim_job(uuid,integer)','complete_job(uuid,uuid)',
    'retry_job(uuid,uuid,timestamptz,text)','yield_job(uuid,uuid,timestamptz)',
    'fail_job(uuid,uuid,text)','supersede_job(uuid,uuid)'] loop
    foreach v_role in array array['anon','authenticated','service_role'] loop
      if has_function_privilege(v_role,'public.'||v_sig,'EXECUTE') then raise exception 'unfenced_rpc_bypass'; end if;
    end loop;
  end loop;
  foreach v_sig in array array['claim_job(uuid,integer,uuid)','complete_job(uuid,uuid,uuid)',
    'retry_job(uuid,uuid,timestamptz,text,uuid)','yield_job(uuid,uuid,timestamptz,uuid)',
    'fail_job(uuid,uuid,text,uuid)','supersede_job(uuid,uuid,uuid)'] loop
    if not has_function_privilege('service_role','public.'||v_sig,'EXECUTE') then raise exception 'fenced_rpc_missing_grant'; end if;
    foreach v_role in array array['anon','authenticated'] loop
      if has_function_privilege(v_role,'public.'||v_sig,'EXECUTE') then raise exception 'public_fenced_rpc_grant'; end if;
    end loop;
    if not (select prosecdef and proconfig=array['search_path=""']::text[] from pg_proc where oid=('public.'||v_sig)::regprocedure) then
      raise exception 'fenced_rpc_definer_path';
    end if;
  end loop;
end; $$;

-- 모든 테스트 자료는 synthetic UUID와 표식만 사용한다.
do $$
declare
 v_worker uuid:='11111111-1111-4111-8111-111111111111';
 v_target uuid:='22222222-2222-4222-8222-222222222222';
 v_wrong uuid:='33333333-3333-4333-8333-333333333333';
 v_global uuid; v_next uuid; v_job uuid; v_lease uuid; v_old uuid;
 v_result jsonb; v_expiry timestamptz; v_job_expiry timestamptz; v_failures bigint; v_action text;
 v_payload jsonb:=jsonb_build_object('profileId','22222222-2222-4222-8222-222222222222',
   'sourceRevision','0','modelVersion','synthetic','promptVersion','synthetic');
begin
 execute 'set local role service_role';
 -- old direct overloads must be denied even without a job.
 begin perform public.claim_job(v_worker,180); raise exception 'old_claim_callable'; exception when insufficient_privilege then null; end;
 begin perform public.complete_job(v_target,v_wrong); raise exception 'old_complete_callable'; exception when insufficient_privilege then null; end;
 perform pg_temp.expect_conflict(format('select public.claim_job(%L::uuid,180,null::uuid)',v_worker));
 v_result:=public.acquire_worker_run(180,null); v_global:=(v_result->>'token')::uuid; v_expiry:=(v_result->>'expiresAt')::timestamptz;
 if public.claim_job(v_worker,180,v_global)<>'{"job":null}'::jsonb then raise exception 'empty_fenced_claim'; end if;
 perform pg_temp.expect_conflict(format('select public.claim_job(%L::uuid,180,%L::uuid)',v_worker,v_wrong));
 v_result:=public.enqueue_job('review_summary','synthetic-fence-first',v_payload,clock_timestamp()); v_job:=(v_result->>'jobId')::uuid;
 v_result:=public.claim_job(v_worker,180,v_global)->'job'; v_lease:=(v_result->>'leaseToken')::uuid;
 if (v_result->>'jobId')::uuid<>v_job or (v_result->>'attempt')::integer<>1 or (v_result->>'failedAttempts')::integer<>0 then raise exception 'claim_wire_shape'; end if;
 v_job_expiry:=(v_result->>'leaseExpiresAt')::timestamptz;
 execute 'reset role';
 if not exists(select 1 from private.worker_job_run_fences where job_id=v_job and job_lease_token=v_lease and worker_run_token=v_global) then raise exception 'claim_fence_missing'; end if;
 execute 'set local role service_role';
 -- Wrong current global, wrong individual lease and global NULL reject every transition.
 foreach v_action in array array['complete','retry','yield','fail','supersede'] loop
   v_result:=null;
   perform pg_temp.expect_conflict(case v_action
    when 'complete' then format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_lease,v_wrong)
    when 'retry' then format('select public.retry_job(%L::uuid,%L::uuid,clock_timestamp()+interval ''1 hour'',''TIMEOUT'',%L::uuid)',v_job,v_lease,v_wrong)
    when 'yield' then format('select public.yield_job(%L::uuid,%L::uuid,null,%L::uuid)',v_job,v_lease,v_wrong)
    when 'fail' then format('select public.fail_job(%L::uuid,%L::uuid,''TIMEOUT'',%L::uuid)',v_job,v_lease,v_wrong)
    else format('select public.supersede_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_lease,v_wrong) end);
 end loop;
 perform pg_temp.expect_conflict(format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_wrong,v_global));
 -- Calling acquire with the existing token does not renew either lease.
 if (public.acquire_worker_run(180,v_global)->>'expiresAt')::timestamptz<>v_expiry then raise exception 'global_lease_extended'; end if;
 execute 'reset role';
 if (select lease_expires_at from private.worker_jobs where id=v_job)<>v_job_expiry then raise exception 'job_lease_extended'; end if;
 -- Replacement global token must not inherit an earlier claim mapping.
 execute 'set local role service_role';
 if public.release_worker_run(v_global)<>'{"status":"applied"}'::jsonb then raise exception 'release_current_run'; end if;
 v_next:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 perform pg_temp.expect_conflict(format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_lease,v_global));
 perform pg_temp.expect_conflict(format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_lease,v_next));
 -- Expired individual lease can be reclaimed with a new global; previous job lease is invalid.
 execute 'reset role';
 update private.worker_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=v_job;
 execute 'set local role service_role';
 perform pg_temp.expect_conflict(format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_lease,v_next));
 v_old:=v_lease; v_result:=public.claim_job(v_worker,180,v_next)->'job'; v_lease:=(v_result->>'leaseToken')::uuid;
 if (v_result->>'jobId')::uuid<>v_job or v_lease=v_old or (v_result->>'attempt')::integer<>2 then raise exception 'expired_job_reclaim'; end if;
 perform pg_temp.expect_conflict(format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_old,v_next));
 -- Expired global rejects claim and settlement while an individual job remains unexpired.
 execute 'reset role';
 update private.global_worker_run set expires_at=clock_timestamp()-interval '1 second' where singleton;
 execute 'set local role service_role';
 perform pg_temp.expect_conflict(format('select public.claim_job(%L::uuid,180,%L::uuid)',v_worker,v_next));
 perform pg_temp.expect_conflict(format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_lease,v_next));
 execute 'reset role';
 update private.global_worker_run set expires_at=clock_timestamp()+interval '180 seconds' where singleton;
 execute 'set local role service_role';
 if public.yield_job(v_job,v_lease,null,v_next)<>jsonb_build_object('jobId',v_job,'status','queued') then raise exception 'yield_wire'; end if;
 execute 'reset role';
 if exists(select 1 from private.worker_job_run_fences where job_id=v_job) then raise exception 'yield_fence_kept'; end if;
 if (select failed_attempts from private.worker_jobs where id=v_job)<>0 then raise exception 'yield_counted_as_failure'; end if;
 execute 'set local role service_role';
 -- Retry preserves failed count policy, removes old claim fence, and old lease cannot complete.
 v_lease:=(public.claim_job(v_worker,180,v_next)->'job'->>'leaseToken')::uuid;
 if public.retry_job(v_job,v_lease,clock_timestamp()+interval '1 hour','TIMEOUT',v_next)<>jsonb_build_object('jobId',v_job,'status','retry_wait') then raise exception 'retry_wire'; end if;
 perform pg_temp.expect_conflict(format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_lease,v_next));
 execute 'reset role';
 if exists(select 1 from private.worker_job_run_fences where job_id=v_job) or (select failed_attempts from private.worker_jobs where id=v_job)<>1 then raise exception 'retry_count_or_fence'; end if;
 update private.worker_jobs set available_at=clock_timestamp()-interval '1 second' where id=v_job;
 execute 'set local role service_role';
 v_lease:=(public.claim_job(v_worker,180,v_next)->'job'->>'leaseToken')::uuid;
 if public.complete_job(v_job,v_lease,v_next)<>jsonb_build_object('jobId',v_job,'status','succeeded') then raise exception 'complete_wire'; end if;
 perform pg_temp.expect_conflict(format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_lease,v_next));
 -- Distinct synthetic jobs exercise failed and superseded terminal transitions.
 foreach v_action in array array['fail','supersede'] loop
   v_job:=(public.enqueue_job('review_summary','synthetic-fence-'||v_action,v_payload,clock_timestamp())->>'jobId')::uuid;
   v_lease:=(public.claim_job(v_worker,180,v_next)->'job'->>'leaseToken')::uuid;
   if v_action='fail' then v_result:=public.fail_job(v_job,v_lease,'TIMEOUT',v_next);
   else v_result:=public.supersede_job(v_job,v_lease,v_next); end if;
   if v_result<>jsonb_build_object('jobId',v_job,'status',case v_action when 'fail' then 'failed' else 'superseded' end) then raise exception 'terminal_wire'; end if;
   execute 'reset role';
   if exists(select 1 from private.worker_job_run_fences where job_id=v_job) then raise exception 'terminal_fence_kept'; end if;
   if (select failed_attempts from private.worker_jobs where id=v_job)<>(case v_action when 'fail' then 1 else 0 end) then raise exception 'terminal_failure_count'; end if;
   execute 'set local role service_role';
 end loop;
 if public.claim_job(v_worker,180,v_next)<>'{"job":null}'::jsonb then raise exception 'terminal_reclaimed'; end if;
 if public.release_worker_run(v_next)<>'{"status":"applied"}'::jsonb then raise exception 'release_final'; end if;
 execute 'reset role';
 if exists(select 1 from private.worker_job_run_fences) then raise exception 'completed_fences_not_deleted'; end if;
end; $$;
-- 현재 시각을 조작하는 합성 검증과 별도로, 실제 SQL 작업 중 전역 만료 경계를 지난 경우를 검사한다.
create temporary sequence fence_transition_probe;
create function pg_temp.delay_fence_transition() returns trigger language plpgsql security definer as $$
begin
  if new.dedupe_key='synthetic-fence-midstatement' and new.status='succeeded'
    and nextval('pg_temp.fence_transition_probe')=1 then perform pg_sleep(0.1); end if;
  return new;
end; $$;
create trigger synthetic_fence_delay before update on private.worker_jobs
 for each row execute function pg_temp.delay_fence_transition();
do $$
declare v_global uuid; v_job uuid; v_lease uuid;
 v_payload jsonb:='{"profileId":"22222222-2222-4222-8222-222222222222","sourceRevision":"0","modelVersion":"synthetic","promptVersion":"synthetic"}';
begin
 execute 'set local role service_role';
 v_global:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 v_job:=(public.enqueue_job('review_summary','synthetic-fence-midstatement',v_payload,clock_timestamp())->>'jobId')::uuid;
 v_lease:=(public.claim_job('11111111-1111-4111-8111-111111111111',180,v_global)->'job'->>'leaseToken')::uuid;
 execute 'reset role';
 update private.global_worker_run set expires_at=clock_timestamp()+interval '50 milliseconds' where singleton;
 execute 'set local role service_role';
 perform pg_temp.expect_conflict(format('select public.complete_job(%L::uuid,%L::uuid,%L::uuid)',v_job,v_lease,v_global));
 execute 'reset role';
 if currval('pg_temp.fence_transition_probe')<>1 then raise exception 'expiry_probe_did_not_reach_transition'; end if;
 if (select status from private.worker_jobs where id=v_job)<>'running'
    or not exists(select 1 from private.worker_job_run_fences where job_id=v_job and job_lease_token=v_lease and worker_run_token=v_global) then
   raise exception 'expired_midstatement_transition_not_rolled_back';
 end if;
 update private.global_worker_run set expires_at=clock_timestamp()+interval '180 seconds' where singleton;
 execute 'set local role service_role';
 perform public.complete_job(v_job,v_lease,v_global);
 perform public.release_worker_run(v_global);
 execute 'reset role';
end; $$;
rollback;
