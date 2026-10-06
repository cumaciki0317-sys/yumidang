-- 민규: guard false·행 부재 때는 입력/점유 검사 전에 닫히는지 검증한다. 실제 작업 효과 검증은78 증거와 별도다.
begin;
set local plpgsql.check_asserts='on';
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create function pg_temp.cancel_guard_error(command text,expected text)returns void language plpgsql as $$declare actual text;begin
 begin execute command;exception when others then get stacked diagnostics actual=returned_sqlstate;end;
 assert actual=expected,'cancel_guard_expected_error';
end;$$;
do $$declare command text;begin
 assert current_setting('plpgsql.check_asserts')='on';
 assert (select count(*)=1 and bool_and(singleton and not enabled)from private.cancellation_due_control);
 foreach command in array array['select public.enqueue_cancellation_safety_due(null,null)','select public.process_cancellation_safety_due(null,null,null,null,null)']loop
 perform pg_temp.cancel_guard_error(command,'55000');end loop;
 delete from private.cancellation_due_control;
 foreach command in array array['select public.enqueue_cancellation_safety_due(null,null)','select public.process_cancellation_safety_due(null,null,null,null,null)']loop
 perform pg_temp.cancel_guard_error(command,'55000');end loop;
 insert into private.cancellation_due_control values(true,true);
 foreach command in array array['select public.enqueue_cancellation_safety_due(null,null)','select public.process_cancellation_safety_due(null,null,null,null,null)']loop
 perform pg_temp.cancel_guard_error(command,'22023');end loop;
 update private.cancellation_due_control set enabled=false where singleton;
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 foreach command in array array['select public.enqueue_cancellation_safety_due(null,null)','select public.process_cancellation_safety_due(null,null,null,null,null)']loop
 perform pg_temp.cancel_guard_error(command,'42501');end loop;
 assert (select count(*)=1 and bool_and(singleton and not enabled)from private.cancellation_due_control);
 assert not exists(select 1 from private.worker_jobs);
 assert not exists(select 1 from private.worker_job_run_fences);
 assert not exists(select 1 from private.global_worker_run where token is not null);
end;$$;
rollback;
