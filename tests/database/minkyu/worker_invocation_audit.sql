-- SQL109 synthetic scratch DB 전용. root가 별도 clone에서 실행하며 모두 rollback한다.
begin;
do $$declare sig text;role_name text;begin
 if exists(select 1 from private.worker_jobs)or exists(select 1 from private.worker_runtime_intents)or exists(select 1 from private.worker_runtime_results)or exists(select 1 from private.worker_invocations)or exists(select 1 from private.member_cleanup_dispatches)then raise exception 'empty_synthetic_scratch_required';end if;
 if(select enabled from private.worker_invocation_control where singleton)then raise exception 'invocation_default_open';end if;
 foreach sig in array array['prepare_queue_invocation(uuid,uuid,text,integer,integer)','claim_queue_invocation_dispatch(uuid,uuid,text,integer,integer)','get_queue_invocation(uuid)','complete_queue_invocation(uuid)','mark_queue_invocation_unknown(uuid)','purge_worker_runtime_details_scoped(uuid,uuid,integer)']loop
  foreach role_name in array array['anon','authenticated','service_role','yumidang_worker_queue']loop
   if has_function_privilege(role_name,'public.'||sig,'EXECUTE')then raise exception 'invocation_default_execute_open';end if;
  end loop;
 end loop;
 if not(select relrowsecurity from pg_class where oid='private.worker_invocations'::regclass)then raise exception 'invocation_rls_missing';end if;
end;$$;
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update private.worker_invocation_control set enabled=true where singleton;
update private.worker_runtime_atomic_control set enabled=true where singleton;
-- 테스트용 UUID·가상 payload만 사용한다. 실회원/공급사/Storage 호출은 없다.
insert into private.global_worker_run(singleton,token,expires_at)values(true,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',clock_timestamp()+interval'180 seconds')on conflict(singleton)do update set token=excluded.token,expires_at=excluded.expires_at;
do $$declare req uuid:='11111111-1111-1111-1111-111111111111';tok uuid:='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';v jsonb;expiry timestamptz;begin
 select expires_at into expiry from private.global_worker_run where singleton;
 v:=public.prepare_queue_invocation(req,tok,'review_summary',2,10000);assert v->>'state'='prepared'and(v->>'fresh')::boolean;
 v:=public.prepare_queue_invocation(req,tok,'review_summary',2,10000);assert not(v->>'fresh')::boolean;
 begin perform public.prepare_queue_invocation(req,tok,'review_summary',1,10000);raise exception 'allocation_conflict_missing';exception when sqlstate'40001'then null;end;
 begin perform public.complete_queue_invocation(req);raise exception 'unproven_completion_allowed';exception when sqlstate'55000'then null;end;
 assert(public.claim_queue_invocation_dispatch(req,tok,'review_summary',2,10000)->>'claimed')::boolean;
 assert not(public.claim_queue_invocation_dispatch(req,tok,'review_summary',2,10000)->>'claimed')::boolean;
 v:=public.claim_supported_job('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',180,tok,array['review_summary']);assert v='{"job":null}'::jsonb;
 v:=public.complete_queue_invocation(req);assert v->>'state'='completed';assert(v->'result'->'counts'->>'claimed')::integer=0;
 assert public.get_queue_invocation(req)=v;assert public.complete_queue_invocation(req)=v;
 assert(select expires_at=expiry from private.global_worker_run where singleton);
 assert(select count(*)=0 from private.worker_runtime_job_slots);
end;$$;
-- 실제 settlement 없이 counts를 꾸며 완료할 입력은 존재하지 않는다.
insert into private.worker_jobs(id,kind,dedupe_key,payload,available_at)values('cccccccc-cccc-cccc-cccc-cccccccccccc','review_summary','synthetic-invocation',jsonb_build_object('profileId','dddddddd-dddd-dddd-dddd-dddddddddddd','sourceRevision','0','modelVersion','synthetic','promptVersion','synthetic'),clock_timestamp());
-- 같은 작업을 두 번 처리해도 unique queue slot은 하나다. lease별 효과를 복사하지 않는다.
do $$declare req uuid:='44444444-4444-4444-4444-444444444444';tok uuid:='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';j jsonb;first_lease uuid;v jsonb;begin
 perform public.prepare_queue_invocation(req,tok,'review_summary',2,10000);
 perform public.claim_queue_invocation_dispatch(req,tok,'review_summary',2,10000);
 j:=public.claim_supported_job('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',180,tok,array['review_summary'])->'job';first_lease:=(j->>'leaseToken')::uuid;
 perform public.yield_job((j->>'jobId')::uuid,first_lease,null,tok);
 insert into private.worker_runtime_job_slots(global_token,job_id)select tok,md5('synthetic109slot'||n)::uuid from generate_series(1,19)n;
 assert(public.read_worker_runtime_slots(tok)->>'remaining')::integer=0;
 j:=public.claim_supported_job('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',180,tok,array['review_summary'])->'job';assert(j->>'leaseToken')::uuid<>first_lease;
 assert(select count(*)=2 and count(distinct job_id)=1 from private.worker_invocation_jobs where request_id=req);
 assert(select count(*)=20 from private.worker_runtime_job_slots where global_token=tok);
 assert(select effect is null from private.worker_invocation_jobs where request_id=req and job_lease_token=(j->>'leaseToken')::uuid);
 perform public.yield_job((j->>'jobId')::uuid,(j->>'leaseToken')::uuid,null,tok);
 delete from private.worker_runtime_job_slots where global_token=tok and job_id in(select md5('synthetic109slot'||n)::uuid from generate_series(1,19)n);
 v:=public.complete_queue_invocation(req);assert v->'result'->'counts'='{"claimed":1,"succeeded":0,"retried":0,"failed":0,"superseded":0,"yielded":1}'::jsonb;
end;$$;
do $$declare req uuid:='22222222-2222-2222-2222-222222222222';tok uuid:='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';j jsonb;v jsonb;begin
 perform public.prepare_queue_invocation(req,tok,'review_summary',1,10000);
 perform public.claim_queue_invocation_dispatch(req,tok,'review_summary',1,10000);
 j:=public.claim_supported_job('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',180,tok,array['review_summary'])->'job';
 begin perform public.complete_queue_invocation(req);raise exception 'unsettled_completion_allowed';exception when sqlstate'55000'then null;end;
 perform public.complete_job((j->>'jobId')::uuid,(j->>'leaseToken')::uuid,tok);
 begin perform public.complete_queue_invocation(req);raise exception 'effect_free_success_allowed';exception when sqlstate'55000'then null;end;
 v:=public.mark_queue_invocation_unknown(req);assert v->>'state'='unknown'and v->'result'='null'::jsonb;
 assert not(public.claim_queue_invocation_dispatch(req,tok,'review_summary',1,10000)->>'claimed')::boolean;
 assert(public.read_worker_runtime_pending_v2()->>'hasPending')::boolean;
 begin perform public.prepare_queue_invocation('33333333-3333-3333-3333-333333333333',tok,'helpful_maintenance',1,10000);raise exception 'unknown_did_not_block';exception when sqlstate'55000'then null;end;
 assert(select count(*)=1 from private.worker_runtime_job_slots);
end;$$;
rollback;
