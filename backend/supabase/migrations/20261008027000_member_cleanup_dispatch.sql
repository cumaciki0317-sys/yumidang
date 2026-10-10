-- SQL107: 회원 삭제의 영속 최초 dispatch. 만료된 미확정 작업 재점유 금지.
begin;
create table private.member_cleanup_dispatches(task_id uuid primary key references private.member_cleanup_tasks(id),dispatch_id uuid not null unique default gen_random_uuid(),global_token uuid not null,lease_token uuid not null,object_id uuid,created_at timestamptz not null default clock_timestamp());
alter table private.member_cleanup_dispatches enable row level security;
revoke all on private.member_cleanup_dispatches from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
create function public.begin_member_cleanup_delete(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare d private.member_cleanup_dispatches;begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_required'using errcode='42501';end if;
 perform public.check_member_cleanup_task(p_task_id,p_lease_token,p_worker_run_token,p_object_id);
 perform 1 from private.member_cleanup_tasks where id=p_task_id for update;
 perform public.check_member_cleanup_task(p_task_id,p_lease_token,p_worker_run_token,p_object_id);
 select *into d from private.member_cleanup_dispatches where task_id=p_task_id;
 if found then
  if d.object_id is distinct from p_object_id then raise exception 'state_conflict'using errcode='40001';end if;
  return jsonb_build_object('dispatchId',d.dispatch_id,'alreadyDispatched',true);
 end if;
 insert into private.member_cleanup_dispatches(task_id,global_token,lease_token,object_id)values(p_task_id,p_worker_run_token,p_lease_token,p_object_id)returning *into d;
 perform public.check_member_cleanup_task(p_task_id,p_lease_token,p_worker_run_token,p_object_id);
 return jsonb_build_object('dispatchId',d.dispatch_id,'alreadyDispatched',false);
end;$$;
do $$declare old text;definition text;anchor text:='and (kind<>''auth_user'' or not exists';own text;begin
 select prosrc,pg_get_functiondef(oid),pg_get_userbyid(proowner)into strict old,definition,own from pg_proc where oid='public.claim_member_cleanup_task(uuid)'::regprocedure;
 if(length(old)-length(replace(old,anchor,'')))/length(anchor)<>1 then raise exception 'member_dispatch_claim_anchor_changed'using errcode='55000';end if;
 execute replace(definition,old,replace(old,anchor,'and not exists(select 1 from private.member_cleanup_dispatches d where d.task_id=member_cleanup_tasks.id) '||anchor));
 execute format('alter table private.member_cleanup_dispatches owner to %I',own);
 execute format('alter function public.begin_member_cleanup_delete(uuid,uuid,uuid,uuid)owner to %I',own);
end;$$;
revoke all on function public.begin_member_cleanup_delete(uuid,uuid,uuid,uuid)from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
-- 상세/minimum TTL을 임의로 만들지 않는다. ACK/외부 부재를 확인하는 복구 연결 전 운영 EXEC 닫힘.
commit;
