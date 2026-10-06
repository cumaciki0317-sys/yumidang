-- 민규: 신고 증거 DELETE 전송 의도 fence 후보. SQL/Provider 실제 검증 NOT_RUN.
-- 전송 의도는 물리 삭제 완료 증거가 아니다. 79/80 원본은 변경하지 않는다.
begin;
create temp table report_dispatch_baseline on commit drop as
select oid,oid::regprocedure signature,proowner,proacl::text acl,proconfig::text config,prosrc
from pg_proc where oid in('public.claim_report_retention_task(uuid,uuid,uuid)'::regprocedure,
 'public.record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
 'public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)'::regprocedure,
 'private.supported_worker_kind_ready(text)'::regprocedure);
do $$declare own oid;role_name text;enabled boolean;begin
 select proowner into strict own from report_dispatch_baseline where signature='public.claim_report_retention_task(uuid,uuid,uuid)'::regprocedure;
 if exists(select 1 from report_dispatch_baseline where proowner<>own)or
 not exists(select 1 from pg_roles where oid=own and(rolsuper or rolbypassrls))then
  raise exception 'report_dispatch_owner_incompatible'using errcode='55000';end if;
 select c.enabled into enabled from private.report_purge_control c where c.singleton for share;
 if enabled is distinct from false then raise exception 'report_dispatch_guard_must_be_closed'using errcode='55000';end if;
 if exists(select 1 from private.report_purge_delete_acks)then
  -- 옛 외부 삭제를 새 전송 의도로 추정해서 백필하지 않는다.
  raise exception 'report_dispatch_legacy_ack_requires_review'using errcode='55000';end if;
 if exists(select 1 from private.report_purge_tasks where kind='storage_object'and state<>'pending')then
  raise exception 'report_dispatch_legacy_task_requires_review'using errcode='55000';end if;
 foreach role_name in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  if pg_has_role(role_name,own,'USAGE')or pg_has_role(role_name,own,'SET')then raise exception 'report_dispatch_owner_incompatible'using errcode='55000';end if;
 end loop;
 if not has_function_privilege(own,'private.report_purge_assert_task(uuid,uuid,uuid,uuid,uuid,uuid)','EXECUTE')
 or not has_table_privilege(own,'private.report_purge_tasks','SELECT')
 or not has_table_privilege(own,'private.report_purge_delete_acks','SELECT')then
  raise exception 'report_dispatch_owner_incompatible'using errcode='55000';end if;
end;$$;
create table private.report_purge_dispatches(
 task_id uuid primary key references private.report_purge_tasks(id)on delete cascade,
 dispatch_id uuid not null unique default gen_random_uuid(),closure_id uuid not null,asset_id uuid not null,object_id uuid not null,
 task_lease_token uuid not null,job_id uuid not null,job_lease_token uuid not null,worker_run_token uuid not null,
 dispatched_at timestamptz not null default clock_timestamp(),check(isfinite(dispatched_at)));
create function private.protect_report_purge_dispatch()returns trigger language plpgsql security definer set search_path=''as $$begin
 if tg_op='UPDATE'then raise exception 'report_dispatch_immutable'using errcode='40001';end if;
 if current_setting('yumidang.report_purge_finalizing',true)is distinct from old.closure_id::text then
  raise exception 'report_delete_dispatch_unknown'using errcode='55000';end if;
 return old;
end;$$;
create trigger report_purge_dispatch_immutable before update or delete on private.report_purge_dispatches
 for each row execute function private.protect_report_purge_dispatch();
create function public.begin_report_retention_delete(p_task_id uuid,p_task_lease_token uuid,p_job_id uuid,p_job_lease_token uuid,p_global_token uuid,p_object_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare task_row private.report_purge_tasks;dispatch_row private.report_purge_dispatches;again boolean:=false;begin
 task_row:=private.report_purge_assert_task(p_task_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token,p_object_id);
 if task_row.kind<>'storage_object'or task_row.state<>'running'then raise exception 'invalid_report_dispatch'using errcode='22023';end if;
 select *into dispatch_row from private.report_purge_dispatches where task_id=task_row.id for update nowait;
 if found then
  if dispatch_row.asset_id<>task_row.asset_id or dispatch_row.object_id<>task_row.object_id then raise exception 'state_conflict'using errcode='40001';end if;
  if dispatch_row.task_lease_token is distinct from p_task_lease_token or dispatch_row.job_id is distinct from p_job_id
   or dispatch_row.job_lease_token is distinct from p_job_lease_token or dispatch_row.worker_run_token is distinct from p_global_token then
   raise exception 'report_delete_already_dispatched'using errcode='55000';end if;
  again:=true;
 else
  if exists(select 1 from private.report_purge_delete_acks where task_id=task_row.id)then raise exception 'state_conflict'using errcode='40001';end if;
  insert into private.report_purge_dispatches(task_id,closure_id,asset_id,object_id,task_lease_token,job_id,job_lease_token,worker_run_token)
  values(task_row.id,task_row.closure_id,task_row.asset_id,task_row.object_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token)returning *into dispatch_row;
 end if;
 perform private.report_purge_assert_task(p_task_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token,p_object_id);
 return jsonb_build_object('taskId',task_row.id,'dispatchId',dispatch_row.dispatch_id,'alreadyApplied',again);
exception when lock_not_available or unique_violation then raise exception 'state_conflict'using errcode='40001';end;$$;

-- 기존 함수 정의를 읽어 정확 source79 anchor 한 번만 바꾸며 기존 OID/owner/ACL/config를 유지한다.
create function pg_temp.patch_report_dispatch(p_signature regprocedure,p_old text,p_new text)returns void language plpgsql as $$
declare body text;definition text;begin
 select prosrc,pg_get_functiondef(oid)into strict body,definition from pg_proc where oid=p_signature;
 if (length(body)-length(replace(body,p_old,'')))/length(p_old)<>1 then raise exception 'report_dispatch_source_anchor_changed'using errcode='55000';end if;
 execute replace(definition,body,replace(body,p_old,p_new));
end;$$;
select pg_temp.patch_report_dispatch('public.claim_report_retention_task(uuid,uuid,uuid)',
 $$  and(kind='storage_object'or not exists$$,
 $$  and not exists(select 1 from private.report_purge_dispatches d where d.task_id=candidate.id
   and not exists(select 1 from private.report_purge_delete_acks a where a.task_id=d.task_id and a.asset_id=d.asset_id and a.object_id=d.object_id))
  and(kind='storage_object'or not exists$$);
select pg_temp.patch_report_dispatch('public.claim_report_retention_task(uuid,uuid,uuid)',
 $$ if not found then return null;end if;$$,
 $$ if not found then
  if exists(select 1 from private.report_purge_tasks blocked join private.report_purge_dispatches d on d.task_id=blocked.id
   where blocked.closure_id=c and blocked.state<>'completed'and not exists(select 1 from private.report_purge_delete_acks a
    where a.task_id=d.task_id and a.asset_id=d.asset_id and a.object_id=d.object_id))then
   raise exception 'report_delete_dispatch_unknown'using errcode='55000';end if;
  return null;
 end if;$$);
select pg_temp.patch_report_dispatch('private.supported_worker_kind_ready(text)',
 $$ 'public.purge_report_retention_terminal_receipts(uuid,integer)'];$$,
 $$ 'public.purge_report_retention_terminal_receipts(uuid,integer)',
 'public.begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid)'];$$);
select pg_temp.patch_report_dispatch('public.record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text)',
 $$ insert into private.report_purge_delete_acks(task_id,asset_id,object_id,ack_sha256)$$,
 $$ if not exists(select 1 from private.report_purge_dispatches d where d.task_id=t.id and d.asset_id=t.asset_id and d.object_id=t.object_id
  and d.task_lease_token=p_task_lease_token and d.job_id=p_job_id and d.job_lease_token=p_job_lease_token and d.worker_run_token=p_global_token)then
  raise exception 'report_delete_dispatch_required'using errcode='55000';end if;
 insert into private.report_purge_delete_acks(task_id,asset_id,object_id,ack_sha256)$$);
select pg_temp.patch_report_dispatch('public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)',
 $$  if not exists(select 1 from private.report_purge_delete_acks where task_id=t.id and asset_id=t.asset_id and object_id=t.object_id)$$,
 $$  if not exists(select 1 from private.report_purge_dispatches where task_id=t.id and asset_id=t.asset_id and object_id=t.object_id)then
   raise exception 'report_delete_dispatch_required'using errcode='55000';end if;
  if not exists(select 1 from private.report_purge_delete_acks where task_id=t.id and asset_id=t.asset_id and object_id=t.object_id)$$);
select pg_temp.patch_report_dispatch('public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)',
 $$  perform private.assert_current_worker_job(p_job_id,p_job_lease_token,p_global_token);
  perform set_config('yumidang.report_purge_finalizing',c.id::text,true);$$,
 $$  if exists(select 1 from private.report_purge_tasks child where child.closure_id=c.id and child.kind='storage_object'
   and not exists(select 1 from private.report_purge_dispatches d join private.report_purge_delete_acks a on a.task_id=d.task_id
    where d.task_id=child.id and d.asset_id=child.asset_id and d.object_id=child.object_id
    and a.asset_id=d.asset_id and a.object_id=d.object_id))then
   raise exception 'report_delete_dispatch_unknown'using errcode='55000';end if;
  perform private.assert_current_worker_job(p_job_id,p_job_lease_token,p_global_token);
  perform set_config('yumidang.report_purge_finalizing',c.id::text,true);$$);
do $$declare own name;begin
 select pg_get_userbyid(proowner)into strict own from report_dispatch_baseline where signature='public.claim_report_retention_task(uuid,uuid,uuid)'::regprocedure;
 execute format('alter table private.report_purge_dispatches owner to %I',own);
 alter table private.report_purge_dispatches enable row level security;
 revoke all on private.report_purge_dispatches from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
 execute format('alter function public.begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid) owner to %I',own);
 execute format('alter function private.protect_report_purge_dispatch() owner to %I',own);
 revoke all on function private.protect_report_purge_dispatch()from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
 revoke all on function public.begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid)from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
 if exists(select 1 from report_dispatch_baseline b left join pg_proc p on p.oid=b.oid where p.oid is null or p.proowner<>b.proowner
  or p.proacl::text is distinct from b.acl or p.proconfig::text is distinct from b.config)then raise exception 'report_dispatch_metadata_changed'using errcode='55000';end if;
end;$$;
comment on table private.report_purge_dispatches is '원 lease의 DELETE 전송 의도. ACK 없는 unknown 자동 재전송을 막는다. Provider 완료·조건부 objectId 삭제 증거가 아니다. 신고 목적 task와 함께 파기하고 새 보관기간을 만들지 않는다.';
commit;
