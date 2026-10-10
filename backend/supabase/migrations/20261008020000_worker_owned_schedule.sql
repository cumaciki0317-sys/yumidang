-- SQL100: 자기 점유 중 조회. 기존 두 인자 ABI와 제어 상태를 보존한다.
begin;
do $patch$
declare body text;owner_name text;old_text constant text:=
 'where singleton and token is not null and expires_at>n;';
begin
 select prosrc,pg_get_userbyid(proowner)into strict body,owner_name
 from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 if md5(body)<>'268cbbff265653111726746abad277a9'
 or not exists(select 1 from pg_roles where rolname=owner_name and(rolsuper or rolbypassrls))
 then raise exception 'owned_schedule_baseline_mismatch'using errcode='55000';end if;
 body:=replace(body,'begin'||chr(10),'begin'||chr(10)||
 ' perform private.assert_current_worker_run(p_global_token);'||chr(10));
 body:=replace(body,old_text,
 'where singleton and token is not null and expires_at>n and token is distinct from p_global_token;');
 execute format('create function public.read_worker_owned_queue_schedule(p_global_token uuid,p_exclude_kinds text[] default ''{}'',p_after_kind text default null)returns jsonb language plpgsql volatile security definer set search_path='''' as %L',body);
 execute format('alter function public.read_worker_owned_queue_schedule(uuid,text[],text) owner to %I',owner_name);
end;$patch$;
revoke all on function public.read_worker_owned_queue_schedule(uuid,text[],text)from public,anon,authenticated,service_role,authenticator;
grant execute on function public.read_worker_owned_queue_schedule(uuid,text[],text)to yumidang_worker_queue;
-- 읽기 전용 만료 조회. 파기 권한·제어가 준비된 경우에만 예약 시각을 제공한다.
create function public.read_report_terminal_maintenance_schedule()returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare ready boolean;due timestamptz;n timestamptz:=clock_timestamp();
begin
 if auth.role()in('anon','authenticated')then raise exception 'worker_required'using errcode='42501';end if;
 ready:=coalesce((select enabled from private.report_purge_control where singleton),false)
  and has_function_privilege('service_role','public.purge_report_retention_terminal_receipts(uuid,integer)','EXECUTE');
 if ready then select min(expires_at)into due from private.report_purge_terminal_receipts;end if;
 return jsonb_build_object('serverNow',n,'nextDueAt',due,'ready',ready);
end;$$;
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 execute format('alter function public.read_report_terminal_maintenance_schedule() owner to %I',own);
end;$$;
revoke all on function public.read_report_terminal_maintenance_schedule()from public,anon,authenticated,service_role,authenticator;
grant execute on function public.read_report_terminal_maintenance_schedule()to yumidang_worker_queue;
-- SQL83의 worker_queue_retention_terminal 알림을 재사용한다.
commit;
