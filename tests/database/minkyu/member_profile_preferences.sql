-- 민규: 새 성향·소개 원자 저장 RPC의 실제 로컬 SQL 회귀. 합성 자료는 모두 rollback한다.
begin;
set local storage.allow_delete_query='true';
create function pg_temp.pref_uid(n integer) returns uuid language sql immutable as $$
 select ('fa110000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.pref_session(n integer) returns uuid language sql immutable as $$
 select ('fa120000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.pref_actor(n integer) returns void language plpgsql as $$ begin
 perform set_config('request.jwt.claim.sub',pg_temp.pref_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.pref_uid(n),'session_id',pg_temp.pref_session(n))::text,true);
end; $$;
create function pg_temp.pref_failure(command text, expected text) returns void language plpgsql as $$
declare code text; begin
 begin execute command; exception when others then get stacked diagnostics code=returned_sqlstate; end;
 assert code=expected, format('unexpected SQLSTATE %s',code);
end; $$;
set local role service_role;
do $$ declare i integer; begin
 for i in 1..3 loop perform public.resolve_naver_account('preferences-sql-'||i,'합성회원'||i,'F','1990-01-01'); end loop;
end; $$;
reset role;
insert into auth.users(id,email) select pg_temp.pref_uid(i),a.auth_email from generate_series(1,3)i
 join private.naver_accounts a on a.subject='preferences-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.pref_session(i),pg_temp.pref_uid(i) from generate_series(1,3)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.pref_uid(i)::text||'/fa130000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.pref_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,3)i;
set local role service_role;
do $$ declare i integer; begin
 for i in 1..3 loop perform public.record_naver_session('preferences-sql-'||i,pg_temp.pref_uid(i),pg_temp.pref_session(i)); end loop;
end; $$;
reset role;
-- owner의 단일 검증 TX에만 존재하는 실패 주입으로 저장 후 rollback을 확인한다.
create function pg_temp.pref_reject_bio() returns trigger language plpgsql as $$ begin
 if new.id=pg_temp.pref_uid(1) and new.bio='원자성 실패 주입' then
 raise exception 'synthetic_bio_write_failure' using errcode='23514'; end if;
 return new;
end; $$;
create trigger pref_bio_failure before update of bio on public.profiles
 for each row execute function pg_temp.pref_reject_bio();
set local role authenticated;
do $$ declare i integer; begin
 for i in 1..3 loop
 perform pg_temp.pref_actor(i);
 assert public.complete_naver_signup(pg_temp.pref_uid(i)::text||'/fa130000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
 end loop;
end; $$;
select pg_temp.pref_actor(1);
do $$ declare result jsonb; before_traits jsonb; before_bio text; begin
 result:=public.set_my_profile_preferences(array['산책'],array['차분한 대화'],'INFP',repeat('🙂',300));
 assert result=jsonb_build_object('interests',jsonb_build_array('산책'),'conversationStyles',jsonb_build_array('차분한 대화'),'mbti','INFP','bio',repeat('🙂',300));
 assert public.get_my_profile()->>'bio'=repeat('🙂',300);
 before_traits:=public.get_my_profile_traits(); before_bio:=public.get_my_profile()->>'bio';
 perform pg_temp.pref_failure($q$select public.set_my_profile_preferences(array['전시'],array['대화'],'INFP',repeat('🙂',301))$q$,'22023');
 assert public.get_my_profile_traits()=before_traits and public.get_my_profile()->>'bio'=before_bio;
 perform pg_temp.pref_failure($q$select public.set_my_profile_preferences(array['전시'],array['대화'],'XXXX','변경되어서는 안 되는 소개')$q$,'22023');
 assert public.get_my_profile_traits()=before_traits and public.get_my_profile()->>'bio'=before_bio;
 perform pg_temp.pref_failure($q$select public.set_my_profile_preferences(null,array['대화'],'INFP','잘못된 성향')$q$,'22023');
 assert public.get_my_profile_traits()=before_traits and public.get_my_profile()->>'bio'=before_bio;
 perform pg_temp.pref_failure($q$select public.set_my_profile_preferences(array['전시'],array['새 대화'],'ENFP','원자성 실패 주입')$q$,'23514');
 assert public.get_my_profile_traits()=before_traits and public.get_my_profile()->>'bio'=before_bio;
 perform pg_temp.pref_failure($q$update public.profiles set bio='직접 우회' where id=pg_temp.pref_uid(1)$q$,'42501');
 result:=public.set_my_profile_preferences('{}','{}',null,null);
 assert result='{"interests":[],"conversationStyles":[],"mbti":null,"bio":null}'::jsonb;
 result:=public.set_my_profile_preferences('{}','{}',null,''); assert result->>'bio'='';
 -- 타인 프로필의 값은 호출자별 저장으로 변경되지 않는다.
 perform pg_temp.pref_actor(2); assert public.get_my_profile()->>'bio' is null;
end; $$;
reset role;
-- 자격 누락 회원도 기존 본인 관리가 가능하다. 신규 활동 guard를 임의 추가하지 않는다.
set local role service_role;
select public.resolve_naver_account('preferences-sql-1',null,'F','1990-01-01');
reset role;
set local role authenticated;
select pg_temp.pref_actor(1);
select public.set_my_profile_preferences(array['독서'],'{}',null,'기존 회원 관리');
reset role;
-- 실제 Provider를 호출하지 않는 단일 TX의 탈퇴 SQL 준비이며 전체 rollback한다.
update private.member_cleanup_guard set external_deletion_approved=true where singleton;
grant execute on function public.claim_member_cleanup_task(uuid),
 public.check_member_cleanup_task(uuid,uuid,uuid,uuid),
 public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),
 public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),
 public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text) to service_role;
set local role authenticated;
select pg_temp.pref_actor(3);
select public.retire_my_account('fa140000-0000-4000-8000-000000000003');
select pg_temp.pref_failure($q$select public.set_my_profile_preferences('{}','{}',null,'탈퇴 후 쓰기')$q$,'42501');
reset role;
do $$ declare role_name text; begin
 assert not has_column_privilege('authenticated','public.profiles','bio','UPDATE');
 assert has_function_privilege('authenticated','public.set_my_profile_preferences(text[],text[],text,text)','EXECUTE');
 foreach role_name in array array['anon','service_role'] loop
 assert not has_function_privilege(role_name,'public.set_my_profile_preferences(text[],text[],text,text)','EXECUTE');
 end loop;
 assert (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='public.set_my_profile_preferences(text[],text[],text,text)'::regprocedure);
 assert (select proowner from pg_proc where oid='public.set_my_profile_preferences(text[],text[],text,text)'::regprocedure)=
 (select proowner from pg_proc where oid='public.set_my_profile_traits(text[],text[],text)'::regprocedure);
end; $$;
set local role anon;
select pg_temp.pref_failure($q$select public.set_my_profile_preferences('{}','{}',null,'익명')$q$,'42501');
reset role;
set local role service_role;
select pg_temp.pref_failure($q$select public.set_my_profile_preferences('{}','{}',null,'내부 역할 우회')$q$,'42501');
reset role;
rollback;
