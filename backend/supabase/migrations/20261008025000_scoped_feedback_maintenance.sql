-- SQL105: helpful은 큐20과 별개인 기존 유지관리 한도를 사용한다.
begin;
create table private.ai_feedback_maintenance_control(singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into private.ai_feedback_maintenance_control values(true,false);
alter table private.ai_feedback_maintenance_control enable row level security;
revoke all on private.ai_feedback_maintenance_control from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
create function private.assert_ai_feedback_maintenance()returns void language plpgsql security definer set search_path=''as $$begin
 perform private.assert_worker_runtime_atomic();
 if(select enabled from private.ai_feedback_maintenance_control where singleton)is distinct from true then raise exception 'feedback_maintenance_not_ready'using errcode='55000';end if;
end;$$;
create function public.read_ai_feedback_maintenance_schedule(p_global_token uuid default null)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare n timestamptz:=clock_timestamp();due timestamptz;expiry timestamptz;begin
 perform private.assert_ai_feedback_maintenance();
 if p_global_token is not null then perform private.assert_current_worker_run(p_global_token);end if;
 select min(accepted_at+interval'2160 hours')into due from private.ai_feedback_receipts where action='helpful';
 select expires_at into expiry from private.global_worker_run where singleton and token is not null and expires_at>n and token is distinct from p_global_token;
 if due is not null and expiry is not null then due:=greatest(due,expiry);end if;
 return jsonb_build_object('serverNow',n,'nextDueAt',due);
end;$$;
create function public.purge_ai_feedback_scoped(p_request_id uuid,p_global_token uuid,p_limit integer)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare old private.worker_runtime_results;hash text;value jsonb;begin
 perform private.assert_ai_feedback_maintenance();
 if p_request_id is null or p_global_token is null or p_limit is null or p_limit not between 1 and 20 then raise exception 'invalid_feedback_maintenance_input'using errcode='22023';end if;
 hash:=encode(extensions.digest(jsonb_build_array('helpful_maintenance',p_global_token,p_limit)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,102));
 select *into old from private.worker_runtime_results where request_id=p_request_id for update;
 if found then
  if old.fingerprint<>hash then raise exception 'request_conflict'using errcode='40001';end if;
  if old.state='purged'then raise exception 'maintenance_result_expired'using errcode='PT404';end if;
  return old.result;
 end if;
 perform private.assert_current_worker_run(p_global_token);
 if coalesce((select sum((input->>'limit')::integer)from private.worker_runtime_results where global_token=p_global_token and operation='helpful_maintenance'),0)+p_limit>20 then raise exception 'maintenance_allocation_exhausted'using errcode='40001';end if;
 value:=public.purge_expired_ai_feedback(p_limit);
 perform private.assert_current_worker_run(p_global_token);
 insert into private.worker_runtime_results(request_id,global_token,operation,fingerprint,input,result,state,closed_at)values(p_request_id,p_global_token,'helpful_maintenance',hash,jsonb_build_object('limit',p_limit),value,'completed',clock_timestamp());
 return value;
end;$$;
create function private.notify_ai_feedback_maintenance()returns trigger language plpgsql security definer set search_path=''as $$begin perform pg_notify('yumidang_worker_jobs','');return null;end;$$;
create trigger ai_feedback_maintenance_changed after insert or update or delete on private.ai_feedback_receipts for each statement execute function private.notify_ai_feedback_maintenance();
do $$declare own text;f record;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 execute format('alter table private.ai_feedback_maintenance_control owner to %I',own);
 for f in select oid::regprocedure sig from pg_proc where pronamespace in('public'::regnamespace,'private'::regnamespace)and proname in('assert_ai_feedback_maintenance','read_ai_feedback_maintenance_schedule','purge_ai_feedback_scoped','notify_ai_feedback_maintenance')loop
 execute format('alter function %s owner to %I',f.sig,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.sig);end loop;
end;$$;
revoke execute on function public.purge_expired_ai_feedback(integer)from service_role;
commit;
