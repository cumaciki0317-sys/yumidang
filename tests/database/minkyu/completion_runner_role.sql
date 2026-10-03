-- 진짜 로컬 superuser(supabase_admin) 연결에서 실행한다. SET SESSION AUTHORIZATION이 필요하다.
-- 운영 회원이나 실제 네이버 인증 증거가 아닌 합성 자료 검사다.
begin;
do $$ declare r oid:='yumidang_completion_runner'::regrole; begin
  assert exists(select 1 from pg_roles where oid=r and not(rolcanlogin or rolinherit or rolsuper or rolcreatedb
    or rolcreaterole or rolreplication or rolbypassrls) and rolconnlimit=-1 and rolvaliduntil is null);
  assert not exists(select 1 from pg_auth_members m where m.member=r or (m.roleid=r and not (
    m.member='postgres'::regrole and m.grantor='supabase_admin'::regrole
    and m.admin_option and not m.inherit_option and not m.set_option
    and exists(select 1 from pg_roles where oid=m.member and rolcreaterole and not rolsuper)
    and exists(select 1 from pg_roles where oid=m.grantor and rolsuper))));
  -- 관리 membership은 상속/SET 권한을 주지 않는다. postgres 자체의 기존 owner 권한과 구분한다.
  assert not pg_has_role('postgres',r,'USAGE');
  assert not pg_has_role('postgres',r,'SET');
  assert not has_schema_privilege(r,'public','CREATE');
  assert has_schema_privilege(r,'public','USAGE') and not has_schema_privilege(r,'private','USAGE');
  -- cron 테이블의 잠재 PUBLIC SELECT와 실제 접근을 구분한다. 스키마 USAGE가 필수다.
  assert not has_schema_privilege(r,'cron','USAGE');
  assert (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and has_function_privilege(r,p.oid,'EXECUTE'))=2;
  assert has_function_privilege(r,'public.list_completion_reservations()','EXECUTE');
  assert has_function_privilege(r,'public.execute_completion_reservation(uuid,uuid)','EXECUTE');
  assert not has_function_privilege('anon','public.list_completion_reservations()','EXECUTE');
  assert not has_function_privilege('authenticated','public.execute_completion_reservation(uuid,uuid)','EXECUTE');
  assert not pg_has_role('authenticator',r,'MEMBER');
  assert not pg_has_role('authenticated',r,'MEMBER');
  assert not pg_has_role('anon',r,'MEMBER');
  assert has_function_privilege('service_role','public.list_completion_reservations()','EXECUTE');
  raise notice 'PASS completion_role_catalog';
end; $$;

-- LOGIN은 테스트에서만 생성한다. 운영 비밀 provisioning과 제품 runner는 이 파일 밖이다.
create role ym_completion_role_fixture_login login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant yumidang_completion_runner to ym_completion_role_fixture_login;
set session authorization ym_completion_role_fixture_login;
listen yumidang_completion_reservations;
do $$ begin
  assert jsonb_typeof(public.list_completion_reservations()->'reservations')='array';
  begin execute 'set role authenticated'; raise exception '역할 상승 허용'; exception when insufficient_privilege then null; end;
  begin execute 'set role service_role'; raise exception '관리 역할 상승 허용'; exception when insufficient_privilege then null; end;
  begin execute 'set role authenticator'; raise exception '인증 역할 상승 허용'; exception when insufficient_privilege then null; end;
  begin perform public.process_due_completions(1); raise exception '다른 내부 RPC 허용'; exception when insufficient_privilege then null; end;
  begin perform public.get_my_profile(); raise exception '회원 RPC 허용'; exception when insufficient_privilege then null; end;
  begin perform 1 from public.profiles; raise exception '회원 자료 읽기 허용'; exception when insufficient_privilege then null; end;
  begin perform 1 from private.completion_reservations; raise exception '예약 직접 읽기 허용'; exception when insufficient_privilege then null; end;
  begin perform 1 from auth.users; raise exception 'Auth 직접 읽기 허용'; exception when insufficient_privilege then null; end;
  begin perform 1 from cron.job; raise exception 'cron 직접 읽기 허용'; exception when insufficient_privilege then null; end;
  begin execute 'create table public.ym_completion_escape(id integer)'; raise exception 'DDL 허용'; exception when insufficient_privilege then null; end;
  raise notice 'PASS completion_role_permissions';
end; $$;
reset session authorization;

do $$ declare
  a uuid:=md5('completion-role-author')::uuid; b uuid:=md5('completion-role-peer')::uuid;
  p uuid:=md5('completion-role-post')::uuid; r uuid:=md5('completion-role-request')::uuid;
begin
  insert into auth.users(id) values(a),(b);
  insert into public.profiles(id,real_name,birth_date) values(a,'완료작성자','1990-01-01'),(b,'완료신청자','1990-01-01');
  insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
    values(p,a,'완료 역할 합성 검증','관리자 없이 원형 완료 RPC를 검사합니다','산책',now()-interval '3 days',
      now()-interval '25 hours',now()-interval '4 days','서울특별시 강남구 역삼동');
  insert into public.join_requests(id,post_id,requester_id,message,status) values(r,p,b,'완료 역할 합성 신청입니다','matched');
  insert into public.appointments(id,post_id,join_request_id,status)
    values(md5('completion-role-appointment')::uuid,p,r,'confirmed');
  assert exists(select 1 from private.completion_reservations where appointment_id=md5('completion-role-appointment')::uuid);
end; $$;
set session authorization ym_completion_role_fixture_login;
do $$ declare x jsonb; g uuid; ap uuid:=md5('completion-role-appointment')::uuid; begin
  select (e->>'generation')::uuid into g from jsonb_array_elements(public.list_completion_reservations()->'reservations') e
    where e->>'appointmentId'=ap::text;
  assert g is not null;
  x:=public.execute_completion_reservation(ap,md5('completion-role-stale-generation')::uuid);
  assert x->>'status'='stale';
  x:=public.execute_completion_reservation(ap,g);
  assert x->>'status'='completed' and (x->>'completedAt')::timestamptz>=transaction_timestamp();
  perform set_config('test.completion_role_generation',g::text,true);
  perform set_config('test.completion_role_completed_at',x->>'completedAt',true);
  raise notice 'PASS completion_role_actual_completion';
end; $$;
do $$ declare x jsonb; begin
  x:=public.execute_completion_reservation(md5('completion-role-appointment')::uuid,
    current_setting('test.completion_role_generation')::uuid);
  assert x->>'status'='stale';
  assert not exists(select 1 from jsonb_array_elements(public.list_completion_reservations()->'reservations') e
    where e->>'appointmentId'=md5('completion-role-appointment')::uuid::text);
  begin perform public.execute_completion_reservation(null,null); raise exception '잘못된 입력 허용';
    exception when invalid_parameter_value then null; end;
  raise notice 'PASS completion_role_retry';
end; $$;
reset session authorization;
do $$ declare t timestamptz:=current_setting('test.completion_role_completed_at')::timestamptz; begin
  assert (select status='completed' and completed_at=t and completion_method='automatic'
    and completed_by_user_id is null and review_deadline_at=t+interval '7 days'
    from public.appointments where id=md5('completion-role-appointment')::uuid);
  assert not exists(select 1 from public.appointment_completion_confirmations where appointment_id=md5('completion-role-appointment')::uuid);
  assert (select count(*) from public.notifications where kind='appointment_completed'
    and join_request_id=md5('completion-role-request')::uuid)=2;
  assert not exists(select 1 from pg_auth_members where member='yumidang_completion_runner'::regrole);
  assert not pg_has_role('authenticator','yumidang_completion_runner','MEMBER');
  raise notice 'PASS completion_role_atomic_record';
end; $$;
rollback;
