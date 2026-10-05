-- 민규: 검토된 source62+40600에서만 실행하는 합성 SQL 회귀 후보. 현재 NOT_RUN.
-- 실제 Storage blob/HTTP/두 세션 경쟁 증거가 아니다. 회원·설정·자료는 전체 rollback한다.
begin;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.withdraw_uid(n integer) returns uuid language sql immutable as $$
 select ('fa410000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.withdraw_session(n integer) returns uuid language sql immutable as $$
 select ('fa420000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.withdraw_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.withdraw_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.withdraw_uid(n),'session_id',pg_temp.withdraw_session(n))::text,true);
end;$$;
create function pg_temp.withdraw_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
end;$$;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.resolve_naver_account('change-withdraw-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email) select pg_temp.withdraw_uid(i),a.auth_email from generate_series(1,4)i
 join private.naver_accounts a on a.subject='change-withdraw-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.withdraw_session(i),pg_temp.withdraw_uid(i) from generate_series(1,4)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.withdraw_uid(i)::text||'/fa430000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.withdraw_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,4)i;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.record_naver_session('change-withdraw-sql-'||i,pg_temp.withdraw_uid(i),pg_temp.withdraw_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..4 loop
 perform pg_temp.withdraw_actor(i);
 assert public.complete_naver_signup(pg_temp.withdraw_uid(i)::text||'/fa430000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
end loop;end;$$;
reset role;
create temp table withdrawal_cases(n integer primary key,p uuid,ap uuid,cid uuid,version text,snapshot jsonb);
grant all on withdrawal_cases to authenticated;
create function pg_temp.withdraw_snapshot(p_id uuid,a_id uuid) returns jsonb language sql as $$
 select jsonb_build_object('post',(select to_jsonb(p) from public.posts p where id=p_id),
  'appointment',(select to_jsonb(a) from public.appointments a where id=a_id),
  'reservation',(select to_jsonb(r) from private.completion_reservations r where appointment_id=a_id),
  'location',(select to_jsonb(l) from private.post_search_locations l where post_id=p_id),
  'details',(select to_jsonb(d) from public.post_private_details d where post_id=p_id));$$;
set local role authenticated;
do $$declare i integer;p uuid;r uuid;a uuid;c jsonb;input jsonb;cid uuid;state jsonb;begin
 for i in 1..8 loop
 p:=gen_random_uuid();cid:=gen_random_uuid();
 input:=jsonb_build_object('title','합성 변경 철회','description','로컬 합성 자료','category','산책',
 'startsAt',clock_timestamp()+make_interval(days=>i*3),'endsAt',clock_timestamp()+make_interval(days=>i*3,hours=>2),
 'recruitmentEndsAt',clock_timestamp()+make_interval(days=>i*3,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','가상 장소','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 원래 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
 perform pg_temp.withdraw_actor(1);perform public.create_service_post(p,input);
 perform pg_temp.withdraw_actor(2);r:=(public.request_service_post(p,gen_random_uuid(),'합성 신청')->>'id')::uuid;
 perform pg_temp.withdraw_actor(1);c:=public.propose_match(r);
 perform pg_temp.withdraw_actor(2);a:=(public.accept_match(r,c->>'conditionVersion')->>'appointmentId')::uuid;
 perform pg_temp.withdraw_actor(case when i=6 then 2 else 1 end);state:=public.get_appointment_change_state(a);
 if i=8 then
 c:=public.propose_appointment_schedule_change(a,cid,(input->>'startsAt')::timestamptz+interval '1 hour',
 (input->>'endsAt')::timestamptz+interval '1 hour',(state->>'updatedAt')::timestamptz);
 else
 c:=public.propose_appointment_schedule_change(a,cid,(input->>'startsAt')::timestamptz+interval '1 hour',
 (input->>'endsAt')::timestamptz+interval '1 hour',(state->>'updatedAt')::timestamptz,
 jsonb_build_object('publicArea','부산광역시 중구 중앙동','registeredPlaceName','새 가상 장소',
 'registeredAddress','부산광역시 중구 새 가상주소','meetingDetail','새 가상 입구'));
 end if;
 insert into withdrawal_cases values(i,p,a,cid,c->>'conditionVersion',null);
 end loop;
end;$$;
reset role;
update withdrawal_cases set snapshot=pg_temp.withdraw_snapshot(p,ap);
set local role authenticated;
do $$declare c withdrawal_cases;result jsonb;begin
 select * into c from withdrawal_cases where n=1;
 perform pg_temp.withdraw_actor(2);
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,%L)',c.ap,c.cid,c.version),'42501');
 perform pg_temp.withdraw_actor(3);
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,%L)',c.ap,c.cid,c.version),'PT404');
 perform pg_temp.withdraw_actor(1);
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,''stale'')',c.ap,c.cid),'40001');
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,null)',c.ap,c.cid),'40001');
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,%L)',c.ap,gen_random_uuid(),c.version),'40001');
 result:=public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version);
 assert result->>'status'='withdrawn' and result->>'deduplicated'='false' and result->'newLocation'='null'::jsonb;
 assert public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version)->>'deduplicated'='true';
 select * into c from withdrawal_cases where n=6;perform pg_temp.withdraw_actor(1);
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,%L)',c.ap,c.cid,c.version),'42501');
 perform pg_temp.withdraw_actor(2);assert public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version)->>'status'='withdrawn';
end;$$;
reset role;
-- 실제 clock을 바꾸지 않고 만료 fixture만 과거로 옮긴다.
update private.appointment_schedule_changes set requested_at=statement_timestamp()-interval '7 hours',expires_at=statement_timestamp()-interval '1 hour'
 where change_id=(select cid from withdrawal_cases where n=2);
set local role authenticated;
do $$declare c withdrawal_cases;result jsonb;begin
 select * into c from withdrawal_cases where n=2;perform pg_temp.withdraw_actor(1);
 result:=public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version);
 assert result->>'status'='expired' and result->>'deduplicated'='true';
 assert public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version)->>'status'='expired';
 select * into c from withdrawal_cases where n=3;
 perform public.cancel_appointment(c.ap,gen_random_uuid(),'합성 약속 취소');
 assert public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version)->>'status'='cancelled';
 assert public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version)->>'deduplicated'='true';
 select * into c from withdrawal_cases where n=4;perform pg_temp.withdraw_actor(2);
 perform public.accept_appointment_schedule_change(c.ap,c.cid,c.version);perform pg_temp.withdraw_actor(1);
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,%L)',c.ap,c.cid,c.version),'40001');
 select * into c from withdrawal_cases where n=5;perform pg_temp.withdraw_actor(2);
 perform public.decline_appointment_schedule_change(c.ap,c.cid,c.version);perform pg_temp.withdraw_actor(1);
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,%L)',c.ap,c.cid,c.version),'40001');
end;$$;
reset role;
do $$declare c withdrawal_cases;begin
 for c in select * from withdrawal_cases where n in(1,2,6) loop
 assert pg_temp.withdraw_snapshot(c.p,c.ap)=c.snapshot;
 assert(select new_location_input is null and resolved_at is not null from private.appointment_schedule_changes where change_id=c.cid);
 assert(select count(*) from private.match_lifecycle_events where kind='appointment_schedule_change_ended' and event_key=c.version)=1;
 assert(select count(*) from public.notifications where kind='appointment_schedule_change_ended' and event_data->>'changeId'=c.cid::text)=2;
 assert not exists(select 1 from public.notifications where event_data->>'changeId'=c.cid::text and event_data::text like '%새 가상%');
 end loop;
end;$$;
-- 종료 상태 재조회도 현재 원본을 덮어쓰지 않는다.
update withdrawal_cases set snapshot=pg_temp.withdraw_snapshot(p,ap) where n in(3,4,5);
set local role authenticated;
do $$declare c withdrawal_cases;begin
 perform pg_temp.withdraw_actor(1);
 select * into c from withdrawal_cases where n=3;
 assert public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version)->>'status'='cancelled';
 for c in select * from withdrawal_cases where n in(4,5) loop
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,%L)',c.ap,c.cid,c.version),'40001');end loop;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.withdraw_uid(1),'is_anonymous',true)::text,true);
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,%L)',c.ap,c.cid,c.version),'28000');
end;$$;
reset role;
do $$declare c withdrawal_cases;begin
 for c in select * from withdrawal_cases where n in(3,4,5) loop
 assert pg_temp.withdraw_snapshot(c.p,c.ap)=c.snapshot;end loop;
end;$$;
-- 기존 5인자 시간 전용 DTO는 새 위치 필드 없이 철회한다.
set local role authenticated;
do $$declare c withdrawal_cases;result jsonb;begin
 select * into c from withdrawal_cases where n=8;perform pg_temp.withdraw_actor(1);
 result:=public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version);
 assert result->>'status'='withdrawn' and result->>'deduplicated'='false';
 assert not(result?'locationChanged') and not(result?'newLocation');
 assert public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version)->>'deduplicated'='true';
end;$$;
reset role;
do $$declare c withdrawal_cases;begin select * into c from withdrawal_cases where n=8;
 assert pg_temp.withdraw_snapshot(c.p,c.ap)=c.snapshot;
 assert(select not location_changed and new_location_input is null and status='withdrawn'
  from private.appointment_schedule_changes where change_id=c.cid);
 assert(select count(*) from private.match_lifecycle_events
  where kind='appointment_schedule_change_ended' and event_key=c.version)=1;
 assert(select count(*) from public.notifications
  where kind='appointment_schedule_change_ended' and event_data->>'changeId'=c.cid::text)=2;
end;$$;
-- 네이버 최신 정보가 불충족이어도 기존 제안의 정리는 허용한다.
set local role service_role;
select public.resolve_naver_account('change-withdraw-sql-1',null,'F','1990-01-01');
reset role;
set local role authenticated;
select pg_temp.withdraw_actor(1);
do $$declare c withdrawal_cases;result jsonb;begin select * into c from withdrawal_cases where n=7;
 result:=public.withdraw_appointment_schedule_change(c.ap,c.cid,c.version);
 assert result->>'status'='withdrawn' and result->>'deduplicated'='false';
 assert result->'newLocation'='null'::jsonb;
end;$$;
reset role;
do $$declare c withdrawal_cases;begin select * into c from withdrawal_cases where n=7;
 assert pg_temp.withdraw_snapshot(c.p,c.ap)=c.snapshot;
 assert(select status='withdrawn' and new_location_input is null and resolved_at is not null
  from private.appointment_schedule_changes where change_id=c.cid);
 assert(select count(*) from private.match_lifecycle_events
  where kind='appointment_schedule_change_ended' and event_key=c.version)=1;
 assert(select count(*) from public.notifications
  where kind='appointment_schedule_change_ended' and event_data->>'changeId'=c.cid::text)=2;
end;$$;
-- 실제 탈퇴 RPC의 SQL 준비만 단일 TX 안에서 개방한다. Provider 호출과 COMMIT은 없다.
update private.member_cleanup_guard set external_deletion_approved=true where singleton;
grant execute on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),
 public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),
 public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text) to service_role;
set local role authenticated;
select pg_temp.withdraw_actor(4);
select public.retire_my_account('fa440000-0000-4000-8000-000000000004');
do $$declare c withdrawal_cases;begin select * into c from withdrawal_cases where n=1;
 perform pg_temp.withdraw_failure(format('select public.withdraw_appointment_schedule_change(%L,%L,%L)',c.ap,c.cid,c.version),'42501');end;$$;
reset role;
set local role anon;
select pg_temp.withdraw_failure('select public.withdraw_appointment_schedule_change(null,null,null)','42501');
reset role;
set local role service_role;
select pg_temp.withdraw_failure('select public.withdraw_appointment_schedule_change(null,null,null)','42501');
reset role;
do $$begin
 assert has_function_privilege('authenticated','public.withdraw_appointment_schedule_change(uuid,uuid,text)','EXECUTE');
 assert not has_function_privilege('yumidang_worker_queue','public.withdraw_appointment_schedule_change(uuid,uuid,text)','EXECUTE');
 assert not has_table_privilege('authenticated','private.appointment_schedule_changes','UPDATE');
 assert(select proowner from pg_proc where oid='public.withdraw_appointment_schedule_change(uuid,uuid,text)'::regprocedure)=
 (select proowner from pg_proc where oid='public.decline_appointment_schedule_change(uuid,uuid,text)'::regprocedure);
 assert(select prosecdef and proconfig=array['search_path=""']::text[] from pg_proc where oid='public.withdraw_appointment_schedule_change(uuid,uuid,text)'::regprocedure);
end;$$;
select 'NOT_RUN actual two-session withdrawal/accept race and trusted receipt deadline policy';
rollback;
