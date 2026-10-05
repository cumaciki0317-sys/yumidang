-- 민규 초안: source56 이후. 실제 적용/연결/실행 권한 개방은 아직 하지 않는다.
begin;
-- 기존 권한을 열지 않고 owner·실효 권한·RLS 호환이 부족한 구성은 적용 전체를 중단한다.
do $$declare own oid;name text;privileged boolean;t regclass;r text;meta record;begin
 select p.proowner,pg_get_userbyid(p.proowner),rr.rolsuper or rr.rolbypassrls into own,name,privileged
 from pg_proc p join pg_roles rr on rr.oid=p.proowner where p.oid='public.acquire_worker_run(integer,uuid)'::regprocedure;
 if own is null or name in('anon','authenticated','service_role','authenticator')or not privileged then
  raise exception 'worker_schedule_owner_incompatible'using errcode='55000';end if;
 foreach r in array array['anon','authenticated','service_role','authenticator']loop
  if pg_has_role(r,own,'USAGE')or pg_has_role(r,own,'SET')then raise exception 'worker_schedule_owner_incompatible'using errcode='55000';end if;
 end loop;
 if not has_schema_privilege(name,'private','USAGE')or not has_schema_privilege(name,'public','USAGE')
  or not has_schema_privilege(name,'auth','USAGE')or not has_function_privilege(name,'auth.role()','EXECUTE')
  or not has_function_privilege(name,'private.assert_current_worker_run(uuid)','EXECUTE')then
  raise exception 'worker_schedule_owner_incompatible'using errcode='55000';end if;
 foreach t in array array['private.worker_jobs'::regclass,'private.member_cleanup_tasks'::regclass,
 'private.member_cleanup_guard'::regclass,'private.member_retirements'::regclass,'private.global_worker_run'::regclass]loop
  select relkind,relrowsecurity,relforcerowsecurity,relowner into meta from pg_class where oid=t;
  if meta.relkind<>'r'or not has_table_privilege(name,t,'SELECT')then
   raise exception 'worker_schedule_owner_incompatible'using errcode='55000';end if;
  -- privileged는 FORCE RLS도 우회한다. 일반 역할의 policy에 따른 빈 큐를 허용하지 않는다.
 end loop;
 if not has_table_privilege(name,'private.global_worker_run','UPDATE')then
  raise exception 'worker_schedule_owner_incompatible'using errcode='55000';end if;
end; $$;
create function public.read_worker_queue_schedule(p_exclude_kinds text[] default '{}'::text[],p_after_kind text default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare n timestamptz:=clock_timestamp();v_due timestamptz;k text;held_until timestamptz;rotation integer;cleanup_ready boolean;
begin
 if auth.role() in('anon','authenticated')then raise exception 'worker_required'using errcode='42501';end if;
 if p_exclude_kinds is null or coalesce(array_ndims(p_exclude_kinds),1)<>1 or cardinality(p_exclude_kinds)>3
  or exists(select 1 from unnest(p_exclude_kinds)x where x is null or x not in('review_summary','event_sync','member_cleanup'))
  or(p_after_kind is not null and p_after_kind not in('review_summary','event_sync','member_cleanup'))then
  raise exception 'invalid_queue_schedule'using errcode='22023';end if;
 rotation:=case p_after_kind when 'review_summary'then 0 when 'event_sync'then 1 when 'member_cleanup'then 2 else -1 end;
 cleanup_ready:=coalesce((select external_deletion_approved from private.member_cleanup_guard where singleton),false)
  and has_function_privilege('service_role','public.claim_member_cleanup_task(uuid)','EXECUTE')
  and has_function_privilege('service_role','public.check_member_cleanup_task(uuid,uuid,uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','EXECUTE')
  and has_function_privilege('service_role','public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)','EXECUTE');
 -- 준비되지 않은 cleanup은 조회에서만 숨긴다. 기존 task/lease/state를 바꾸지 않는다.
 -- 실제 후보의 due만 읽는다. 조회가 claim/dispatch/성공한 것처럼 기록하지 않는다.
 with candidates as(
  select j.kind,case when j.status='running'then j.lease_expires_at else j.available_at end due
  from private.worker_jobs j where j.kind in('review_summary','event_sync')and j.status in('queued','retry_wait','running')
  union all
  select 'member_cleanup',case when t.state='pending'then n else t.lease_expires_at end
  from private.member_cleanup_tasks t join private.member_retirements r on r.withdrawal_id=t.withdrawal_id
   and r.profile_id=t.profile_id and r.state='pending_cleanup'
  where cleanup_ready and t.state in('pending','running')and(t.kind<>'auth_user'or not exists(select 1 from private.member_cleanup_tasks s
   where s.withdrawal_id=t.withdrawal_id and s.kind='storage_object'and s.state<>'completed'))
 ), kinds as(select kind,min(due)due from candidates where not(kind=any(p_exclude_kinds))group by kind),
 ordered as(select kind,due,case kind when 'review_summary'then 0 when 'event_sync'then 1 else 2 end ordinal from kinds)
 select kind,ordered.due into k,v_due from ordered
 order by case when ordered.due<=n then 0 else 1 end,
  case when ordered.due<=n and rotation>=0 then mod(ordinal-rotation+2,3)end,
  ordered.due,ordinal limit 1;
 select expires_at into held_until from private.global_worker_run where singleton and token is not null and expires_at>n;
 if v_due is not null and held_until is not null then v_due:=greatest(v_due,held_until);end if;
 return jsonb_build_object('serverNow',n,'nextDueAt',v_due,'nextKind',k);
end; $$;

-- acquire_worker_run의 exact {token,expiresAt}를 바꾸지 않는 별도 HTTP용 포트.
create function public.read_worker_run_budget(p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare expiry timestamptz;n timestamptz;remaining bigint;
begin
 if auth.role()is distinct from 'service_role'then raise exception 'worker_required'using errcode='42501';end if;
 perform private.assert_current_worker_run(p_worker_run_token);
 select expires_at into expiry from private.global_worker_run where singleton;
 n:=clock_timestamp();remaining:=floor(extract(epoch from(expiry-n))*1000)::bigint;
 if remaining is null or remaining<=0 or remaining>180000 then raise exception 'state_conflict'using errcode='40001';end if;
 return jsonb_build_object('remainingMs',remaining);
end; $$;

-- COMMIT 후 깨우기만 한다. payload에 종류·UUID·원문·token을 넣지 않는다.
create function private.notify_worker_queue_changed()
returns trigger language plpgsql volatile security definer set search_path='' as $$begin
 perform pg_notify('yumidang_worker_jobs','');return null;
end; $$;
create trigger worker_queue_schedule_jobs after insert or delete or update of status,available_at,lease_expires_at on private.worker_jobs
 for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_schedule_cleanup after insert or delete or update of state,lease_expires_at on private.member_cleanup_tasks
 for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_schedule_global after update of token,expires_at on private.global_worker_run
 for each statement execute function private.notify_worker_queue_changed();
create trigger worker_queue_schedule_approval after update of external_deletion_approved on private.member_cleanup_guard
 for each statement execute function private.notify_worker_queue_changed();
do $$declare own text;f regprocedure;begin
 select pg_get_userbyid(proowner)into own from pg_proc where oid='public.acquire_worker_run(integer,uuid)'::regprocedure;
 foreach f in array array['public.read_worker_queue_schedule(text[],text)'::regprocedure,
 'public.read_worker_run_budget(uuid)'::regprocedure,'private.notify_worker_queue_changed()'::regprocedure]loop
  execute format('alter function %s owner to %I',f,own);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end; $$;
-- 전용 LOGIN role, service grant, 기존 helper ACL/guard는 변경하지 않는다.
commit;
