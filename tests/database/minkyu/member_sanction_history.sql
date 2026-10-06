-- 민규: source67 이후 제재 이력 SQL 회귀 후보. 실제 실행은 NOT_RUN.
-- 판정/운영자 계정을 생성하지 않고 owner 합성 원장만 준비한다. Auth/Storage 자료와 설정은 전체 rollback한다.
begin;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.safety_uid(n integer) returns uuid language sql immutable as $$
 select ('fb610000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.safety_session(n integer) returns uuid language sql immutable as $$
 select ('fb620000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
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
 perform public.resolve_naver_account('sanction-history-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email)select pg_temp.safety_uid(i),a.auth_email from generate_series(1,2)i
 join private.naver_accounts a on a.subject='sanction-history-sql-'||i;
insert into auth.sessions(id,user_id)select pg_temp.safety_session(i),pg_temp.safety_uid(i)from generate_series(1,2)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.safety_uid(i)::text||'/fb630000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.safety_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,2)i;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop
 perform public.record_naver_session('sanction-history-sql-'||i,pg_temp.safety_uid(i),pg_temp.safety_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..2 loop
 perform pg_temp.safety_actor(i);
 assert public.complete_naver_signup(pg_temp.safety_uid(i)::text||'/fb630000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
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
 select incident,1,gen_random_uuid(),'confirmed','synthetic_private_reason','fb640000-0000-4000-8000-000000000001',repeat('a',64)from safety_rows;
insert into private.safety_incident_subjects(incident_id,revision,identity_id,source_episode_id,confirmed_kinds)
 select r.incident,1,e.identity_id,e.id,'{}'::text[]from safety_rows r join private.member_episodes e
 on e.profile_id=pg_temp.safety_uid(r.member_n)and e.ended_at is null;
insert into private.safety_sanction_applications(id,identity_id,incident_id,decision_revision,source_episode_id,kind,applied_at,expires_at,notified_at,revoked_at,correction_reason_code)
 select r.id,e.identity_id,r.incident,1,e.id,r.kind,r.applied_at,r.expires_at,r.notified_at,r.revoked_at,
 case when r.revoked_at is not null then 'synthetic_corrected'end from safety_rows r join private.member_episodes e
 on e.profile_id=pg_temp.safety_uid(r.member_n)and e.ended_at is null;

-- 공개 허용 사유 하나와 비공개 원장 사유의 중립 other 매핑을 함께 검사한다.
update private.safety_incident_revisions set reason_code='spam'where incident_id=(select incident from safety_rows where n=1);
insert into private.safety_appeals(id,identity_id,kind,sanction_id,received_at,deadline_at,state)
 select 'fb650000-0000-4000-8000-000000000001',a.identity_id,'general',a.id,
 statement_timestamp()-interval '1 hour',statement_timestamp()+interval '1 day','reviewing'
 from private.safety_sanction_applications a where a.id=(select id from safety_rows where n=4);
-- 원장상 general 이의가 취소 제재에 잘못 연결되어 있어도 취소 사건으로 추정하지 않는다.
insert into private.safety_appeals(id,identity_id,kind,sanction_id,received_at,deadline_at,state)
 select 'fb650000-0000-4000-8000-000000000002',a.identity_id,'general',a.id,
 statement_timestamp()-interval '1 hour',statement_timestamp()+interval '1 day','reviewing'
 from private.safety_sanction_applications a where a.id=(select id from safety_rows where n=3);
create temp table history_before as select
 (select jsonb_agg(to_jsonb(a)order by a.id)from private.safety_sanction_applications a where a.id in(select id from safety_rows))ledger,
 (select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relowner,c.relacl)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'and c.relname like 'safety_%')table_acl;
grant select on safety_rows to authenticated;
set local role authenticated;
do $$declare i integer;x jsonb;v jsonb;old_safety jsonb;cursor_id uuid;seen uuid[]:='{}';begin
 for i in 1..2 loop
  perform pg_temp.safety_actor(i);old_safety:=public.get_my_safety_state();x:=public.list_my_sanctions();
  assert old_safety=public.get_my_safety_state();
  assert(select count(*)from jsonb_object_keys(x))=2;
  assert jsonb_array_length(x->'items')=case i when 1 then 8 else 1 end;
  assert x->'nextCursor'='null'::jsonb;
  assert not exists(select 1 from safety_rows where member_n<>i and x::text like '%'||id::text||'%');
  assert not(x::text~'synthetic_private_reason|synthetic_corrected|identityId|incidentId|reportId|actor|description|payload');
  for v in select value from jsonb_array_elements(x->'items')loop
   assert(select count(*)from jsonb_object_keys(v))=12;
   assert v->'appealDeadlineAt'='null'::jsonb;
   if v->>'sanctionId'=(select id::text from safety_rows where n=1)then assert v->>'reasonCode'='spam';
   else assert v->>'reasonCode'='other';end if;
   if v->>'sanctionId'=(select id::text from safety_rows where n=7)then assert v->>'status'='ended';end if;
   if v->>'sanctionId'=(select id::text from safety_rows where n=8)then
    assert v->>'status'='corrected'and v->>'correctionReasonCode'='other';end if;
   if v->>'sanctionId'=(select id::text from safety_rows where n=4)then
    assert v->>'appealState'='reviewing'and v->'appealDeadlineAt'='null'::jsonb;end if;
   if v->>'kind'like 'cancel_%'then assert v->>'appealPolicy'='cancellation_24h'and v->'appealState'='null'::jsonb;end if;
  end loop;
 end loop;
 perform pg_temp.safety_actor(1);
 loop
  x:=public.list_my_sanctions(2,cursor_id);
  assert jsonb_array_length(x->'items')<=2;
  for v in select value from jsonb_array_elements(x->'items')loop
   assert not((v->>'sanctionId')::uuid=any(seen));seen:=array_append(seen,(v->>'sanctionId')::uuid);
  end loop;
  exit when x->'nextCursor'='null'::jsonb;
  cursor_id:=(x->>'nextCursor')::uuid;
  assert cursor_id=(x->'items'->-1->>'sanctionId')::uuid;
 end loop;
 assert cardinality(seen)=8;
 perform pg_temp.safety_failure(format('select public.list_my_sanctions(20,%L)',(select id from safety_rows where n=9)),'PT404');
 perform pg_temp.safety_failure('select public.list_my_sanctions(0,null)','22023');
 perform pg_temp.safety_failure('select public.list_my_sanctions(101,null)','22023');
 perform pg_temp.safety_failure('select public.list_my_sanctions(null,null)','22023');
end;$$;
reset role;
-- 네이버 신규 활동 자격 누락과 이미 영구 제한된 회원도 본인 지원 자료를 읽을 수 있다.
set local role service_role;
select public.resolve_naver_account('sanction-history-sql-1',null,'F','1990-01-01');
reset role;
set local role authenticated;
select pg_temp.safety_actor(1);
do $$begin assert jsonb_array_length(public.list_my_sanctions()->'items')=8;end;$$;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(1),'is_anonymous',true)::text,true);
select pg_temp.safety_failure('select public.list_my_sanctions()','28000');
select pg_temp.safety_actor(99);
select pg_temp.safety_failure('select public.list_my_sanctions()','42501');
reset role;
-- 계정 subject/회차 바인딩이 없으면 다른 identity의 원장을 대신 반환하지 않는다.
update private.naver_accounts set user_id=null where subject='sanction-history-sql-1';
set local role authenticated;
select pg_temp.safety_actor(1);
select pg_temp.safety_failure('select public.list_my_sanctions()','42501');
reset role;
set local role anon;
select pg_temp.safety_failure('select public.list_my_sanctions()','42501');
reset role;
set local role service_role;
select pg_temp.safety_failure('select public.list_my_sanctions()','42501');
reset role;
do $$declare r text;begin
 assert(select ledger from history_before)=(select jsonb_agg(to_jsonb(a)order by a.id)from private.safety_sanction_applications a where a.id in(select id from safety_rows));
 assert(select table_acl from history_before)=(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relowner,c.relacl)order by c.oid)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'and c.relname like 'safety_%');
 assert has_function_privilege('authenticated','public.list_my_sanctions(integer,uuid)','EXECUTE');
 foreach r in array array['anon','service_role','yumidang_worker_queue']loop
  assert not has_function_privilege(r,'public.list_my_sanctions(integer,uuid)','EXECUTE');end loop;
 assert not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
 where p.oid='public.list_my_sanctions(integer,uuid)'::regprocedure and a.grantee=0 and a.privilege_type='EXECUTE');
 assert(select proowner from pg_proc where oid='public.list_my_sanctions(integer,uuid)'::regprocedure)=
 (select proowner from pg_proc where oid='public.get_my_safety_state()'::regprocedure);
 assert(select roles from safety_catalog)=(select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls)order by rolname)from pg_roles);
 assert(select memberships from safety_catalog)=(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members);
 assert(select guard from safety_catalog)is not distinct from(select external_deletion_approved from private.member_cleanup_guard where singleton);
 assert(select worker from safety_catalog)is not distinct from(select to_jsonb(g)from private.global_worker_run g where singleton);
end;$$;
select 'NOT_RUN actual SQL, notice delivery, appeal submission, mobile UI, hosted HTTP';
rollback;
