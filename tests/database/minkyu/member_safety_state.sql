-- 민규: source63+40700 본인 조회 SQL 회귀 후보. 실제 실행은 NOT_RUN.
-- 판정/운영자 계정을 생성하지 않고 owner 합성 원장만 준비한다. Auth/Storage 자료와 설정은 전체 rollback한다.
begin;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.safety_uid(n integer) returns uuid language sql immutable as $$
 select ('fa510000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.safety_session(n integer) returns uuid language sql immutable as $$
 select ('fa520000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.safety_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.safety_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(n),'session_id',pg_temp.safety_session(n))::text,true);
end;$$;
create function pg_temp.safety_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
end;$$;
create temp table safety_catalog as select
 (select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls)order by rolname)from pg_roles)roles,
 (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)memberships,
 (select external_deletion_approved from private.member_cleanup_guard where singleton)guard,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop
 perform public.resolve_naver_account('safety-state-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email)select pg_temp.safety_uid(i),a.auth_email from generate_series(1,2)i
 join private.naver_accounts a on a.subject='safety-state-sql-'||i;
insert into auth.sessions(id,user_id)select pg_temp.safety_session(i),pg_temp.safety_uid(i)from generate_series(1,2)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.safety_uid(i)::text||'/fa530000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.safety_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,2)i;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop
 perform public.record_naver_session('safety-state-sql-'||i,pg_temp.safety_uid(i),pg_temp.safety_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..2 loop
 perform pg_temp.safety_actor(i);
 assert public.complete_naver_signup(pg_temp.safety_uid(i)::text||'/fa530000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
 assert public.get_my_safety_state()='{"permanent":false,"restrictedUntil":null,"hasWarning":false,"sanctions":[]}'::jsonb;
end loop;end;$$;
reset role;
create temp table safety_rows(n integer,member_n integer,kind text,applied_at timestamptz,expires_at timestamptz,notified_at timestamptz,revoked_at timestamptz,id uuid,incident uuid);
insert into safety_rows
 select n,case when n=9 then 2 else 1 end,kind,
 case when n=7 then statement_timestamp()-interval '192 hours' when n=8 then statement_timestamp()-interval '1 day' else statement_timestamp() end,
 case when n=7 then statement_timestamp()-interval '24 hours' when kind in('cancel_restriction','general_7d')then statement_timestamp()+interval '168 hours'
 when kind='general_30d'then statement_timestamp()+interval '720 hours'-case when n=8 then interval '1 day' else interval '0' end end,
 case when n=4 then statement_timestamp()end,case when n=8 then statement_timestamp()end,
 gen_random_uuid(),gen_random_uuid()
 from (values(1,'cancel_warning'),(2,'general_warning'),(3,'cancel_restriction'),(4,'general_7d'),
 (5,'general_30d'),(6,'permanent'),(7,'general_7d'),(8,'general_30d'),(9,'permanent'))x(n,kind);
-- 필요한 FK만 owner 합성 metadata로 준비한다. actor_reference는 계정/직원 역할이 아니다.
insert into private.safety_incidents(id,current_revision)select incident,1 from safety_rows;
insert into private.safety_incident_revisions(incident_id,revision,decision_id,state,reason_code,actor_reference,subject_payload_hash)
 select incident,1,gen_random_uuid(),'confirmed','synthetic_private_reason','fa540000-0000-4000-8000-000000000001',repeat('a',64)from safety_rows;
insert into private.safety_incident_subjects(incident_id,revision,identity_id,source_episode_id,confirmed_kinds)
 select r.incident,1,e.identity_id,e.id,'{}'::text[]from safety_rows r join private.member_episodes e
 on e.profile_id=pg_temp.safety_uid(r.member_n)and e.ended_at is null;
insert into private.safety_sanction_applications(id,identity_id,incident_id,decision_revision,source_episode_id,kind,applied_at,expires_at,notified_at,revoked_at,correction_reason_code)
 select r.id,e.identity_id,r.incident,1,e.id,r.kind,r.applied_at,r.expires_at,r.notified_at,r.revoked_at,
 case when r.revoked_at is not null then 'synthetic_corrected'end from safety_rows r join private.member_episodes e
 on e.profile_id=pg_temp.safety_uid(r.member_n)and e.ended_at is null;
create temp table safety_expected(member_n integer primary key,result jsonb);
insert into safety_expected
 select members.member_n,private.safety_restriction_state(e.identity_id)||jsonb_build_object('sanctions',
 (select coalesce(jsonb_agg(jsonb_build_object('sanctionId',r.id,'kind',r.kind,'appliedAt',r.applied_at,
 'expiresAt',r.expires_at,'notifiedAt',r.notified_at)order by r.applied_at desc,r.id),'[]')from safety_rows r
 where r.member_n=members.member_n and r.revoked_at is null and(r.expires_at is null or r.expires_at>statement_timestamp())))
 from generate_series(1,2)as members(member_n) join private.member_episodes e
 on e.profile_id=pg_temp.safety_uid(members.member_n)and e.ended_at is null;
create temp table safety_ledger_before as select
 jsonb_agg(to_jsonb(a)order by a.id)ledger from private.safety_sanction_applications a
 where a.id in(select id from safety_rows);
grant select on safety_expected,safety_rows to authenticated;
set local role authenticated;
do $$declare i integer;x jsonb;v jsonb;begin for i in 1..2 loop
 perform pg_temp.safety_actor(i);x:=public.get_my_safety_state();
 assert x=(select result from safety_expected where member_n=i), 'member exact safety projection';
 assert(select count(*)from jsonb_object_keys(x))=4;
 assert jsonb_array_length(x->'sanctions')=case i when 1 then 6 else 1 end, 'initial own active array count';
 assert x->>'permanent'='true';
 if i=1 then
 assert x->>'hasWarning'='true';
 assert (x->>'restrictedUntil')::timestamptz=(select max(expires_at)from safety_rows where n in(3,4,5)), 'active fixture maximum expiry';
 else assert x->>'hasWarning'='false' and x->'restrictedUntil'='null'::jsonb;end if;
 for v in select value from jsonb_array_elements(x->'sanctions')loop
 assert(select count(*)from jsonb_object_keys(v))=5;
 assert v?&array['sanctionId','kind','appliedAt','expiresAt','notifiedAt'];
 assert v->>'kind'=any(array['cancel_warning','cancel_restriction','general_warning','general_7d','general_30d','permanent']);
 end loop;
 assert not(x::text~'synthetic_private_reason|identityId|incidentId|reportId|actor|victim|deadline|description');
 assert not exists(select 1 from safety_rows where member_n<>i and x::text like '%'||id::text||'%');
 end loop;
end;$$;
reset role;
do $$begin
 assert(select ledger from safety_ledger_before)=(select jsonb_agg(to_jsonb(a)order by a.id)
 from private.safety_sanction_applications a where a.id in(select id from safety_rows));
end;$$;
-- n7은 삽입보다 24시간 전 만료, 적용은 그보다168시간 전인 고정 fixture다.
-- 안정적인 만료 필터만 검사하며 실제 경합 중 equality 시점 검증으로 주장하지 않는다.
-- 앞선 즉시 만료 fixture의 FAIL/PASS 관측 원인은 미확정이며 기존 실패 증거를 유지한다.
-- 명백한 무효 정정 이후 조회는 즉시 현재 원장을 반영한다. 새 판정/기간 연장은 하지 않는다.
update private.safety_sanction_applications set revoked_at=clock_timestamp(),correction_reason_code='synthetic_corrected'
 where id=(select id from safety_rows where n=6);
set local role authenticated;
select pg_temp.safety_actor(1);
do $$declare x jsonb;begin x:=public.get_my_safety_state();assert x->>'permanent'='false';
 assert jsonb_array_length(x->'sanctions')=5, 'permanent revoked array count';end;$$;
reset role;
-- 경고는 기존 schema에서 expires_at=NULL이다. 만료 경고라는 불가능한 fixture를 만들지 않는다.
-- 유효 경고 둘을 무효화하면 이미 만료된 기간제 원장이 남아도 경고 표시가 없어야 한다.
update private.safety_sanction_applications set revoked_at=clock_timestamp(),correction_reason_code='synthetic_warning_corrected'
 where id in(select id from safety_rows where n in(1,2));
set local role authenticated;
select pg_temp.safety_actor(1);
do $$declare x jsonb;begin x:=public.get_my_safety_state();
 assert x->>'hasWarning'='false', 'warning revoked hasWarning';
 assert x->>'permanent'='false', 'warning revoked permanent';
 assert jsonb_array_length(x->'sanctions')=3, 'warning revoked array count';
 assert (x->>'restrictedUntil')::timestamptz=(select max(expires_at)from safety_rows where n in(3,4,5)), 'active fixture maximum expiry';
end;$$;
reset role;
-- 이후 동일 identity 승계 fixture는 원래 유효 경고를 그대로 복원하여 분리 검증한다.
update private.safety_sanction_applications set revoked_at=null,correction_reason_code=null
 where id in(select id from safety_rows where n in(1,2));
-- 최신 네이버 자격 누락도 기존 본인 자료 조회를 막지 않는다.
set local role service_role;
select public.resolve_naver_account('safety-state-sql-1',null,'F','1990-01-01');
reset role;
set local role authenticated;
select pg_temp.safety_actor(1);
select public.get_my_safety_state();
reset role;
-- 검증된 동일 subject의 새 profile 바인딩은 owner 합성 fixture다. 실제 재가입 OAuth 증거가 아니다.
update private.member_episodes set ended_at=clock_timestamp()where profile_id=pg_temp.safety_uid(1)and ended_at is null;
insert into auth.users(id,email)values(pg_temp.safety_uid(3),'safety-state-rejoin@test.invalid');
insert into auth.sessions(id,user_id)values(pg_temp.safety_session(3),pg_temp.safety_uid(3));
update private.naver_accounts set user_id=pg_temp.safety_uid(3)where subject='safety-state-sql-1';
insert into private.naver_sessions(session_id,user_id,subject)values(pg_temp.safety_session(3),pg_temp.safety_uid(3),'safety-state-sql-1');
insert into public.profiles(id,real_name,birth_date,gender)values(pg_temp.safety_uid(3),'합성 재가입','1990-01-01','female');
set local role authenticated;
select pg_temp.safety_actor(3);
do $$declare x jsonb;begin x:=public.get_my_safety_state();
 assert x->>'permanent'='false', 'rejoin permanent revoked';
 assert x->>'hasWarning'='true', 'rejoin existing warnings';
 assert jsonb_array_length(x->'sanctions')=5, 'rejoin own active array count';
 assert x->'restrictedUntil'=(select result->'restrictedUntil'from safety_expected where member_n=1);
end;$$;
select pg_temp.safety_actor(1);
select pg_temp.safety_failure('select public.get_my_safety_state()','42501');
select pg_temp.safety_actor(3);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(3),'is_anonymous',true)::text,true);
select pg_temp.safety_failure('select public.get_my_safety_state()','28000');
reset role;
-- 실제 탈퇴 RPC SQL 준비는 이 TX 안에서만 허용하며 Provider를 호출하지 않는다.
update private.member_cleanup_guard set external_deletion_approved=true where singleton;
grant execute on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),
 public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),
 public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)to service_role;
set local role authenticated;
select pg_temp.safety_actor(2);
select public.retire_my_account('fa550000-0000-4000-8000-000000000002');
select pg_temp.safety_failure('select public.get_my_safety_state()','42501');
reset role;
-- active episode와 account/subject 연결이 없거나 바뀌면 다른 identity를 반환하지 않는다.
update private.naver_accounts set user_id=null where subject='safety-state-sql-1';
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure('select public.get_my_safety_state()','42501');
reset role;
update private.naver_accounts set user_id=pg_temp.safety_uid(3)where subject='safety-state-sql-1';
update private.member_episodes set identity_id=(select id from private.naver_identity_keys where subject='safety-state-sql-2')
 where profile_id=pg_temp.safety_uid(3)and ended_at is null;
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.safety_failure('select public.get_my_safety_state()','42501');
reset role;
update private.member_episodes set identity_id=(select id from private.naver_identity_keys where subject='safety-state-sql-1')
 where profile_id=pg_temp.safety_uid(3)and ended_at is null;
set local role anon;
select pg_temp.safety_failure('select public.get_my_safety_state()','42501');
reset role;
set local role service_role;
select pg_temp.safety_failure('select public.get_my_safety_state()','42501');
reset role;
update private.member_cleanup_guard set external_deletion_approved=false where singleton;
revoke all on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),
 public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),
 public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)from service_role;
do $$declare r text;begin
 assert has_function_privilege('authenticated','public.get_my_safety_state()','EXECUTE');
 foreach r in array array['anon','service_role','yumidang_worker_queue']loop
 assert not has_function_privilege(r,'public.get_my_safety_state()','EXECUTE');end loop;
 assert not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
 where p.oid='public.get_my_safety_state()'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');
 assert(select proowner from pg_proc where oid='public.get_my_safety_state()'::regprocedure)=
 (select proowner from pg_proc where oid='public.get_my_profile()'::regprocedure);
 assert(select prosecdef and proconfig=array['search_path=""']::text[]from pg_proc where oid='public.get_my_safety_state()'::regprocedure);
 assert(select roles from safety_catalog)=(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls)order by rolname)from pg_roles);
 assert(select memberships from safety_catalog)=(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members);
 assert(select guard from safety_catalog)=false and(select external_deletion_approved from private.member_cleanup_guard where singleton)=false;
 assert(select worker from safety_catalog)is not distinct from(select to_jsonb(g)from private.global_worker_run g where singleton);
end;$$;
select 'NOT_RUN actual HTTP/hosted, real rejoin OAuth and staff adjudication';
rollback;
