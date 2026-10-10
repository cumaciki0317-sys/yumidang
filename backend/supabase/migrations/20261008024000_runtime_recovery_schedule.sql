-- SQL104: 양쪽 영속 기록의 미확정 차단과 자기/경쟁 유지관리 일정.
begin;
create function public.read_worker_runtime_pending_v2()returns jsonb language plpgsql volatile security definer set search_path=''as $$begin
 perform private.assert_worker_runtime_atomic();
 return jsonb_build_object('hasPending',exists(select 1 from private.worker_runtime_results where state='external_pending')or exists(select 1 from private.worker_runtime_intents where state in('prepared','unknown','observed_response')));
end;$$;
create function public.read_worker_runtime_maintenance_schedule(p_global_token uuid default null)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare n timestamptz:=clock_timestamp();due timestamptz;expiry timestamptz;begin
 perform private.assert_worker_runtime_atomic();
 if p_global_token is not null then perform private.assert_current_worker_run(p_global_token);end if;
 select min(closed_at+interval'720 hours')into due from private.worker_runtime_results where state='completed';
 select expires_at into expiry from private.global_worker_run where singleton and token is not null and expires_at>n and token is distinct from p_global_token;
 if due is not null and expiry is not null then due:=greatest(due,expiry);end if;
 return jsonb_build_object('serverNow',n,'nextDueAt',due);
end;$$;
do $$declare own text;f record;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 for f in select oid::regprocedure sig from pg_proc where pronamespace='public'::regnamespace and proname in('read_worker_runtime_pending_v2','read_worker_runtime_maintenance_schedule')loop
 execute format('alter function %s owner to %I',f.sig,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.sig);end loop;
end;$$;
-- observed_response 단독으로 종결을 보증하지 않으므로 legacy intent도 제품 복구 확인 전 차단한다.
commit;
