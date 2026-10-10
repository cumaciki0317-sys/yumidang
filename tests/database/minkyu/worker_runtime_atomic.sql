-- SQL102/103: 격리 TLS DB 전용. 모든 합성 변경 rollback.
begin;
-- 실제 이전 증빙 작업은 이 트랜잭션에서만 후보에서 제외하고 끝에 복원한다.
update private.worker_jobs set available_at=now()+interval'100 years'where status in('queued','retry_wait');
update private.worker_jobs set lease_expires_at=now()+interval'1 hour'where status='running';
create function pg_temp.reject(q text,expected text)returns void language plpgsql as $$declare code text;begin
 begin execute q;exception when others then get stacked diagnostics code=returned_sqlstate;end;assert code=expected,format('unexpected_state:%s',code);end;$$;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select pg_temp.reject($q$select public.execute_worker_runtime_operation('ab102000-0000-4000-8000-000000000001','ab102000-0000-4000-8000-000000000002','job_claim','{}')$q$,'55000');
update private.worker_runtime_atomic_control set enabled=true where singleton;
update private.global_worker_run set token='ab102000-0000-4000-8000-000000000002',expires_at=clock_timestamp()+interval'180 seconds'where singleton;
select pg_temp.reject($q$select public.execute_worker_runtime_operation('ab102000-0000-4000-8000-000000000001','ab102000-0000-4000-8000-000000000002','job_claim','{"workerId":"ab102000-0000-4000-8000-000000000003","supportedKinds":["review_summary"]}')$q$,'22023');
select pg_temp.reject($q$select public.execute_worker_runtime_operation('ab102000-0000-4000-8000-000000000001','ab102000-0000-4000-8000-000000000002','terminal_maintenance','{"limit":1,"rawText":"not_allowed"}')$q$,'22023');
-- 미준비 종류의 빈 claim은 슬롯을 소비하지 않는다.
do $$declare r jsonb;begin
 r:=public.execute_worker_runtime_operation('ab102000-0000-4000-8000-000000000010','ab102000-0000-4000-8000-000000000002','job_claim','{"workerId":"ab102000-0000-4000-8000-000000000003","leaseSeconds":180,"supportedKinds":["cancellation_safety"]}');
 assert r->'result'->'job'='null'::jsonb;
 assert public.read_worker_runtime_slots('ab102000-0000-4000-8000-000000000002')->>'used'='0';
end;$$;
insert into private.worker_jobs(id,kind,dedupe_key,payload,available_at)values('ab102000-0000-4000-8000-000000000020','review_summary','atomic102:test','{"profileId":"ab102000-0000-4000-8000-000000000099","sourceRevision":"0","modelVersion":"synthetic","promptVersion":"synthetic"}',clock_timestamp()-interval'100 years');
create temp table atomic_claim as select public.execute_worker_runtime_operation('ab102000-0000-4000-8000-000000000021','ab102000-0000-4000-8000-000000000002','job_claim','{"workerId":"ab102000-0000-4000-8000-000000000003","leaseSeconds":180,"supportedKinds":["review_summary"]}')r;
do $$declare r jsonb;begin
 select atomic_claim.r into r from atomic_claim;
 assert r->'result'->'job'->>'jobId'='ab102000-0000-4000-8000-000000000020';
 assert public.read_worker_runtime_slots('ab102000-0000-4000-8000-000000000002')->>'used'='1';
 assert public.execute_worker_runtime_operation('ab102000-0000-4000-8000-000000000021','ab102000-0000-4000-8000-000000000002','job_claim','{"workerId":"ab102000-0000-4000-8000-000000000003","leaseSeconds":180,"supportedKinds":["review_summary"]}')=jsonb_set(r,'{replayed}','true');
 perform pg_temp.reject($q$select public.execute_worker_runtime_operation('ab102000-0000-4000-8000-000000000021','ab102000-0000-4000-8000-000000000002','job_claim','{"workerId":"ab102000-0000-4000-8000-000000000004","leaseSeconds":180,"supportedKinds":["review_summary"]}')$q$,'40001');
 -- 결과 INSERT 실패 시 claim과 슬롯도 함께 rollback.
end;$$;
insert into private.worker_jobs(id,kind,dedupe_key,payload,available_at)values('ab102000-0000-4000-8000-000000000022','review_summary','atomic102:rollback','{"profileId":"ab102000-0000-4000-8000-000000000099","sourceRevision":"0","modelVersion":"synthetic","promptVersion":"synthetic"}',clock_timestamp()-interval'99 years');
create function pg_temp.fail_result_insert()returns trigger language plpgsql as $$begin raise exception 'synthetic_commit_failure'using errcode='P0001';end;$$;
create trigger test_atomic_result_failure before insert on private.worker_runtime_results for each row execute function pg_temp.fail_result_insert();
select pg_temp.reject($q$select public.execute_worker_runtime_operation('ab102000-0000-4000-8000-000000000030','ab102000-0000-4000-8000-000000000002','job_claim','{"workerId":"ab102000-0000-4000-8000-000000000003","leaseSeconds":180,"supportedKinds":["review_summary"]}')$q$,'P0001');
drop trigger test_atomic_result_failure on private.worker_runtime_results;
do $$begin assert public.read_worker_runtime_slots('ab102000-0000-4000-8000-000000000002')->>'used'='1';assert(select status='queued'from private.worker_jobs where id='ab102000-0000-4000-8000-000000000022');end;$$;
insert into private.worker_runtime_job_slots(global_token,job_id)select 'ab102000-0000-4000-8000-000000000002',gen_random_uuid()from generate_series(1,19);
do $$begin
 assert public.claim_job('ab102000-0000-4000-8000-000000000003',180,'ab102000-0000-4000-8000-000000000002')->'job'='null'::jsonb;
 assert public.read_worker_runtime_slots('ab102000-0000-4000-8000-000000000002')->>'used'='20';
end;$$;
-- 준비된 다른 종류로 번갈아 호출해도 같은 전역 슬롯20을 우회하지 못한다.
update private.cancellation_due_control set enabled=true;
update private.report_purge_control set enabled=true;
grant execute on function public.enqueue_cancellation_safety_due(integer,uuid),public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid),public.enqueue_report_retention_purges(uuid,integer),public.claim_report_retention_task(uuid,uuid,uuid),public.check_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid),public.get_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid),public.record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text),public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text),public.purge_report_retention_terminal_receipts(uuid,integer),public.begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid) to service_role;
insert into private.worker_jobs(id,kind,dedupe_key,payload,available_at)values
('ab102000-0000-4000-8000-000000000070','cancellation_safety','atomic102:alternatecancel','{"identityId":"ab102000-0000-4000-8000-000000000099","generation":1}',clock_timestamp()-interval'100 years'),
('ab102000-0000-4000-8000-000000000071','report_retention','atomic102:alternatereport','{"reportId":"ab102000-0000-4000-8000-000000000099","closureProofId":"ab102000-0000-4000-8000-000000000098"}',clock_timestamp()-interval'100 years');
do $$declare k text;begin
 foreach k in array array['cancellation_safety','report_retention','review_summary','cancellation_safety']loop
  assert private.supported_worker_kind_ready(k);
  assert private.claim_supported_worker_job('ab102000-0000-4000-8000-000000000003',180,'ab102000-0000-4000-8000-000000000002',array[k])->'job'='null'::jsonb;
  assert public.read_worker_runtime_slots('ab102000-0000-4000-8000-000000000002')->>'used'='20';
 end loop;
end;$$;
-- queued null의 기존 정상 양보 유지.
do $$declare r jsonb;lease uuid;begin
 select(a.r->'result'->'job'->>'leaseToken')::uuid into lease from atomic_claim a;
 r:=public.execute_worker_runtime_operation('ab102000-0000-4000-8000-000000000040','ab102000-0000-4000-8000-000000000002','job_settlement',jsonb_build_object('jobId','ab102000-0000-4000-8000-000000000020','jobLeaseToken',lease,'status','queued','availableAt',null));
 assert r->'result'->>'status'='queued';
 -- 이미 예약된 동일job 재claim은20에서도 중복차감 없이 허용.
 assert public.claim_job('ab102000-0000-4000-8000-000000000003',180,'ab102000-0000-4000-8000-000000000002')->'job'->>'jobId'='ab102000-0000-4000-8000-000000000020';
 assert public.read_worker_runtime_slots('ab102000-0000-4000-8000-000000000002')->>'used'='20';
end;$$;
update private.worker_runtime_results set closed_at=clock_timestamp()-interval'720 hours'where request_id='ab102000-0000-4000-8000-000000000040';
insert into private.worker_runtime_results(request_id,global_token,operation,fingerprint,input,result,state,created_at)
 values('ab102000-0000-4000-8000-000000000050','ab102000-0000-4000-8000-000000000002','report_delete_begin',repeat('0',64),'{}','{}','external_pending',clock_timestamp()-interval'1 year');
do $$declare r jsonb;begin
 assert public.purge_worker_runtime_details('ab102000-0000-4000-8000-000000000002',20)->>'purged'='1';
 r:=public.get_worker_runtime_operation('ab102000-0000-4000-8000-000000000040');assert r->>'state'='purged'and r->'result'='null'::jsonb;
 assert public.get_worker_runtime_operation('ab102000-0000-4000-8000-000000000050')->>'state'='external_pending';
 assert(select input is null and length(fingerprint)=64 from private.worker_runtime_results where request_id='ab102000-0000-4000-8000-000000000040');
 assert not has_function_privilege('anon','public.execute_worker_runtime_operation(uuid,uuid,text,jsonb)','EXECUTE');
 assert not has_function_privilege('authenticated','public.execute_worker_runtime_operation(uuid,uuid,text,jsonb)','EXECUTE');
end;$$;
update private.global_worker_run set expires_at=clock_timestamp()-interval'1 second'where singleton;
do $$begin
 assert public.get_worker_runtime_operation('ab102000-0000-4000-8000-000000000021')->'result'=(select r->'result'from atomic_claim);
 perform pg_temp.reject($q$select public.execute_worker_runtime_operation('ab102000-0000-4000-8000-000000000060','ab102000-0000-4000-8000-000000000002','job_claim','{"workerId":"ab102000-0000-4000-8000-000000000003","leaseSeconds":180,"supportedKinds":["review_summary"]}')$q$,'40001');
end;$$;
select set_config('request.jwt.claims','{"role":"authenticated"}',true);
select pg_temp.reject($q$select public.get_worker_runtime_operation('ab102000-0000-4000-8000-000000000021')$q$,'42501');
rollback;
