-- 민규 전용 로컬 합성 자료. 실제 역할·세션·RPC를 검사하고 모든 자료를 rollback한다.
begin;
-- schema-only 복사본에서도 재현되도록 합성 회원이 참조하는 최소 사전을 transaction 안에 준비한다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[])
  on conflict(id) do nothing;
insert into private.review_praise_catalog(code,label,is_active,display_order)
  values('punctual','시간을 잘 지켜요',true,1)
  on conflict(code) do nothing;
set local storage.allow_delete_query='true';
create function pg_temp.match_uid(n integer) returns uuid language sql immutable as $$
  select ('c1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.match_session(n integer) returns uuid language sql immutable as $$
  select ('c2000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.match_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
declare u uuid:=pg_temp.match_uid(n);s uuid:=case when unregistered then 'c2000000-0000-4000-8000-000000000099'::uuid else pg_temp.match_session(n) end;
begin
  perform set_config('request.jwt.claim.sub',u::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',u,'session_id',s)::text,true);
end; $$;
create function pg_temp.match_input(n integer) returns jsonb language sql volatile as $$
  select jsonb_build_object('title','합성 생명주기 공고','description','전용 로컬 검증 자료','category','산책',
    'startsAt',clock_timestamp()+make_interval(days=>n*3),'endsAt',clock_timestamp()+make_interval(days=>n*3,hours=>2),
    'recruitmentEndsAt',clock_timestamp()+make_interval(days=>n*3,hours=>-1),
    'publicArea','서울특별시 강남구 역삼동','registeredPlaceName','가상 장소','registeredAddress','비공개 가상주소 123',
    'meetingDetail','비공개 가상 입구','preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
$$;
create function pg_temp.expect_failure(command text,expected text[]) returns void language plpgsql as $$
declare code text;
begin
  begin execute command;
  exception when others then get stacked diagnostics code=returned_sqlstate; end;
  assert code=any(expected), 'unexpected permission/state result';
end; $$;
create temp table matching_cases(name text primary key,post_id uuid,input jsonb,r1 uuid,r2 uuid,version text,old_updated timestamptz);
grant all on matching_cases to authenticated,service_role;

-- 실제 자격 예약·세션 등록·사진·명시 완료를 거친 합성 회원 다섯 명.
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.resolve_naver_account('place-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;
end $$;
reset role;
insert into auth.users(id,email) select pg_temp.match_uid(i),a.auth_email from generate_series(1,5) i
  join private.naver_accounts a on a.subject='place-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.match_session(i),pg_temp.match_uid(i) from generate_series(1,5) i;
insert into auth.sessions(id,user_id) values('c2000000-0000-4000-8000-000000000099',pg_temp.match_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.match_uid(i)::text||'/c3000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
    pg_temp.match_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,5) i;
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.record_naver_session('place-sql-'||i,pg_temp.match_uid(i),pg_temp.match_session(i));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare i integer;begin
  for i in 1..5 loop
    perform pg_temp.match_actor(i);
    assert public.complete_naver_signup(pg_temp.match_uid(i)::text||'/c3000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;


create function pg_temp.place_input(n int) returns jsonb language sql immutable as $$
 select jsonb_build_object('publicArea','부산광역시 중구 중앙동','registeredPlaceName','합성새장소'||n,
 'registeredAddress','부산광역시 중구 새등록주소'||n,'meetingDetail','비공개새만남입구'||n);
$$;
-- 실제 owner SQL로 NULL/미지원 지역·타입·길이를 검사한다. fallback 성공을 만들지 않는다.
do $$ declare location jsonb:=pg_temp.place_input(1);region text;begin
 assert private.post_search_region(null) is null;
 perform pg_temp.expect_failure(format('select private.validate_appointment_location(%L::jsonb)',(location||'{"publicArea":null}'::jsonb)::text),array['22023']);
 perform pg_temp.expect_failure(format('select private.validate_appointment_location(%L::jsonb)',(location||'{"publicArea":"미지원지역 합성동"}'::jsonb)::text),array['22023']);
 perform pg_temp.expect_failure('select private.validate_appointment_location(''null''::jsonb)',array['22023']);
 perform pg_temp.expect_failure(format('select private.validate_appointment_location(%L::jsonb)',(location||jsonb_build_object('meetingDetail',repeat('가',301)))::text),array['22023']);
 assert private.validate_appointment_location(location||jsonb_build_object('meetingDetail',repeat('가',300))) is not null;
 foreach region in array array['서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도'] loop
  assert private.validate_appointment_location(location||jsonb_build_object('publicArea',region||' 합성시 합성동')) is not null;
 end loop;
end $$;
select 'PASS 실제 SQL 지역 NULL/미지원·17지역·JSON 타입·300자 경계';

create temp table place_cases(n int,p uuid,ap uuid,change_id uuid,version text,starts timestamptz,ends timestamptz,updated timestamptz,reservation jsonb,location jsonb);
grant all on place_cases to authenticated;
set local role authenticated;
do $$ declare n integer;p uuid;r uuid;c jsonb;ap uuid;input jsonb;begin
 for n in 1..8 loop
  p:=gen_random_uuid();input:=pg_temp.match_input(n);
  if n=7 then input:=input||jsonb_build_object('startsAt',clock_timestamp()+interval '2 hours','endsAt',clock_timestamp()+interval '4 hours','recruitmentEndsAt',clock_timestamp()+interval '1 hour');end if;
  perform pg_temp.match_actor(1);perform public.create_service_post(p,input);
  perform pg_temp.match_actor(2);r:=(public.request_service_post(p,gen_random_uuid(),'합성 장소 변경 신청')->>'id')::uuid;
  perform pg_temp.match_actor(1);c:=public.propose_match(r);perform pg_temp.match_actor(2);ap:=(public.accept_match(r,c->>'conditionVersion')->>'appointmentId')::uuid;
  insert into place_cases(n,p,ap,starts,ends,location) values(n,p,ap,(input->>'startsAt')::timestamptz,(input->>'endsAt')::timestamptz,pg_temp.place_input(n));
 end loop;
end $$;
reset role;
update place_cases c set updated=p.updated_at,reservation=(select to_jsonb(r) from private.completion_reservations r where r.appointment_id=c.ap) from public.posts p where p.id=c.p;
set local role authenticated;
do $$ declare c place_cases;result jsonb;begin
 for c in select * from place_cases order by n loop
  perform pg_temp.match_actor(case when c.n=2 then 2 else 1 end);
  if c.n=6 then result:=public.propose_appointment_schedule_change(c.ap,gen_random_uuid(),c.starts+interval '1 hour',c.ends+interval '1 hour',c.updated);
  else result:=public.propose_appointment_schedule_change(c.ap,gen_random_uuid(),
    case when c.n=2 then c.starts when c.n=7 then c.starts-interval '1 hour' else c.starts+interval '1 hour' end,
    case when c.n=2 then c.ends when c.n=7 then c.ends-interval '1 hour' else c.ends+interval '1 hour' end,c.updated,c.location);end if;
  if c.n=7 then assert(result->>'expiresAt')::timestamptz=c.starts-interval '1 hour';
  else assert(result->>'expiresAt')::timestamptz=(result->>'requestedAt')::timestamptz+interval '6 hours';end if;
  assert result->>'status'='awaiting_response';
  if c.n=6 then assert not(result?'locationChanged') and not(result?'newLocation');
  else assert result->>'locationChanged'='true' and result->'newLocation'=c.location;end if;
  update place_cases set change_id=(result->>'changeId')::uuid,version=result->>'conditionVersion' where n=c.n;
 end loop;
end $$;
reset role;
do $$ declare c place_cases;begin
 for c in select * from place_cases loop
  assert(select starts_at=c.starts and ends_at=c.ends and updated_at=c.updated and public_area='서울특별시 강남구 역삼동' from public.posts where id=c.p);
  assert(select registered_address='비공개 가상주소 123' from private.post_search_locations where post_id=c.p);
  assert(select exact_location='비공개 가상 입구' from public.post_private_details where post_id=c.p);
 end loop;
end $$;
create temp table place_public_probe(p uuid);
insert into place_public_probe select p from place_cases where n=1;
grant select on place_public_probe to anon;
set local request.jwt.claims='{"role":"anon"}';
set local request.jwt.claim.sub='';
set local role anon;
do $$ declare v_post uuid;result jsonb;begin select probe.p into v_post from place_public_probe probe;
 result:=public.search_public_posts_v2('2026-10-05',null,jsonb_build_object('query','새등록주소1'),null,10);
 assert jsonb_array_length(result->'items')=0;
 assert not(public.get_service_post(v_post)?'privateDetails');
end $$;
reset role;
select 'PASS 시간+장소/장소만/기존 시간전용·6h/새시작 상한·수락 전 저장소/공개검색 불변';
-- 최신55의 회원 가드는 익명 JWT를 거절한다. 분쟁 당사자 관리 접근은 별도 검증한다.
set local role authenticated;
do $$ declare c place_cases;begin select * into c from place_cases where n=1;perform pg_temp.match_actor(1);
 perform set_config('request.jwt.claims',(current_setting('request.jwt.claims')::jsonb||'{"is_anonymous":true}'::jsonb)::text,true);
 perform pg_temp.expect_failure(format('select public.get_appointment_change_state(%L)',c.ap),array['28000']);
 perform pg_temp.match_actor(1);end $$;
reset role;
-- 합성 일정만 과거로 옮겨 실제 완료/이의 RPC 상태를 만든다. DB clock은 변경하지 않는다.
do $$ declare at timestamptz:=clock_timestamp();begin
 update public.posts set starts_at=at-interval '27 hours',ends_at=at-interval '25 hours',recruitment_ends_at=at-interval '28 hours' where id=(select p from place_cases where n=7);
 perform private.complete_due_appointments(at,1);end $$;
set local role authenticated;
do $$ declare c place_cases;begin select * into c from place_cases where n=7;perform pg_temp.match_actor(2);
 assert public.get_appointment_change_state(c.ap)->>'status'='completed';
 assert public.get_appointment_change_state(c.ap)->'change'->'newLocation'='null'::jsonb;
 perform pg_temp.expect_failure(format('select public.propose_appointment_schedule_change(%L,%L,%L,%L,%L,%L::jsonb)',c.ap,gen_random_uuid(),c.starts,c.ends,c.updated,c.location::text),array['40001']);
 perform public.raise_appointment_dispute(c.ap,'합성 확정 이의');end $$;
reset role;
set local role authenticated;
do $$ declare c place_cases;begin select * into c from place_cases where n=7;perform pg_temp.match_actor(2);
 assert public.get_appointment_change_state(c.ap)->>'status'='disputed';
 assert public.get_appointment_change_state(c.ap)->'change'->'newLocation'='null'::jsonb;
 assert not(public.get_service_post(c.p)?'privateDetails');
 perform pg_temp.expect_failure(format('select public.propose_appointment_schedule_change(%L,%L,%L,%L,%L,%L::jsonb)',c.ap,gen_random_uuid(),c.starts,c.ends,c.updated,c.location::text),array['40001']);
 perform pg_temp.match_actor(1);assert public.get_appointment_change_state(c.ap)->>'status'='disputed';end $$;
reset role;
select 'PASS 익명 JWT 새 위치 회수/분쟁 약속 관리 유지와 기존 정확위치 predicate 구분';


set local role authenticated;
do $$ declare c place_cases;result jsonb;begin select * into c from place_cases where n=1;perform pg_temp.match_actor(1);
 perform pg_temp.expect_failure(format('select public.accept_appointment_schedule_change(%L,%L,%L)',c.ap,c.change_id,c.version),array['42501']);
 perform pg_temp.expect_failure(format('select public.propose_appointment_schedule_change(%L,%L,%L,%L,%L,%L::jsonb)',c.ap,c.change_id,c.starts+interval '1 hour',c.ends+interval '1 hour',c.updated,(c.location||'{"meetingDetail":"다른 입력"}'::jsonb)::text),array['40001']);
 assert public.propose_appointment_schedule_change(c.ap,c.change_id,c.starts+interval '1 hour',c.ends+interval '1 hour',c.updated,c.location)->>'deduplicated'='true';
 perform pg_temp.match_actor(3);perform pg_temp.expect_failure(format('select public.get_appointment_change_state(%L)',c.ap),array['PT404']);
 perform pg_temp.expect_failure(format('select private.appointment_schedule_change_json(%L)',c.change_id),array['42501']);
 perform pg_temp.match_actor(2);result:=public.accept_appointment_schedule_change(c.ap,c.change_id,c.version);
 assert result->>'status'='accepted' and result->'newLocation'='null'::jsonb;
 assert public.accept_appointment_schedule_change(c.ap,c.change_id,c.version)->>'deduplicated'='true';
 assert public.get_service_post(c.p)->'privateDetails'->>'registeredAddress'=c.location->>'registeredAddress';
 assert public.get_service_post(c.p)->'privateDetails'->>'meetingDetail'=c.location->>'meetingDetail';
end $$;
reset role;
do $$ declare c place_cases;begin select * into c from place_cases where n=1;
 assert(select public_area=c.location->>'publicArea' and starts_at=c.starts+interval '1 hour' and ends_at=c.ends+interval '1 hour' from public.posts where id=c.p);
 assert(select registered_place_name=c.location->>'registeredPlaceName' and registered_address=c.location->>'registeredAddress' from private.post_search_locations where post_id=c.p);
 assert(select exact_location=c.location->>'meetingDetail' from public.post_private_details where post_id=c.p);
 assert(select new_location_input is null and new_location_fingerprint is not null from private.appointment_schedule_changes where change_id=c.change_id);
 assert(select count(*)=1 from private.match_lifecycle_events where event_key=c.version and kind='appointment_schedule_change_ended');
 assert not exists(select 1 from public.notifications where event_data::text like '%새등록주소%' or event_data::text like '%비공개새만남입구%');
end $$;
set local request.jwt.claims='{"role":"anon"}';
set local request.jwt.claim.sub='';
set local role anon;
do $$ declare result jsonb;begin
 result:=public.search_public_posts_v2('2026-10-05',null,jsonb_build_object('query','새등록주소1'),null,10);
 assert jsonb_array_length(result->'items')=1 and not(result::text like '%부산광역시 중구 새등록주소1%');
 result:=public.search_public_posts_v2('2026-10-05',null,jsonb_build_object('query','비공개새만남입구1'),null,10);
 assert jsonb_array_length(result->'items')=0;
end $$;
reset role;
select 'PASS 상대 수락 원자 반영·자기수락/타인 차단·멱등·등록주소 검색/상세지점 제외·알림 원문 없음';

set local role authenticated;
do $$ declare c place_cases;begin select * into c from place_cases where n=2;perform pg_temp.match_actor(1);
 assert public.accept_appointment_schedule_change(c.ap,c.change_id,c.version)->>'status'='accepted';end $$;
reset role;
do $$ declare c place_cases;begin select * into c from place_cases where n=2;
 assert(select starts_at=c.starts and ends_at=c.ends from public.posts where id=c.p);
 assert(select to_jsonb(r)=c.reservation from private.completion_reservations r where appointment_id=c.ap);end $$;
select 'PASS 신청자 제안→작성자 수락·장소만 변경시 예약 dueAt/generation 유지';

set local role authenticated;
do $$ declare c place_cases;begin select * into c from place_cases where n=3;perform pg_temp.match_actor(2);
 assert public.decline_appointment_schedule_change(c.ap,c.change_id,c.version)->>'status'='declined';end $$;
reset role;
do $$ declare at timestamptz:=clock_timestamp();begin update private.appointment_schedule_changes
 set requested_at=at-interval '7 hours',expires_at=at-interval '1 hour' where change_id=(select change_id from place_cases where n=4);end $$;
set local role service_role;
select public.expire_appointment_changes(100);
reset role;
do $$ declare c place_cases;begin for c in select * from place_cases where n in(3,4) loop
 assert(select starts_at=c.starts and ends_at=c.ends from public.posts where id=c.p);
 assert(select registered_address='비공개 가상주소 123' from private.post_search_locations where post_id=c.p);
 assert(select exact_location='비공개 가상 입구' from public.post_private_details where post_id=c.p);
 assert(select to_jsonb(r)=c.reservation from private.completion_reservations r where appointment_id=c.ap);
 assert(select new_location_input is null from private.appointment_schedule_changes where change_id=c.change_id);
 end loop;assert(select status='expired' from private.appointment_schedule_changes where change_id=(select change_id from place_cases where n=4));end $$;
select 'PASS 거절·만료시 원래 장소/일정/예약 유지·대기 위치 정리';

set local role authenticated;
do $$ declare c place_cases;begin select * into c from place_cases where n=5;perform pg_temp.match_actor(2);
 perform public.cancel_appointment(c.ap,gen_random_uuid(),'합성 장소 취소');
 assert public.get_appointment_change_state(c.ap)->'change'->>'status'='cancelled';
 assert public.get_appointment_change_state(c.ap)->'change'->'newLocation'='null'::jsonb;
 assert not(public.get_service_post(c.p)?'privateDetails');end $$;
reset role;
select 'PASS 약속 취소 후 새 위치와 상대 정확 위치 회수';

-- trusted 위치 수정으로 old post updatedAt이 같아도 제안 fingerprint는 충돌한다.
select public.set_post_search_location(p,'trusted합성수정','trusted합성다른등록주소') from place_cases where n=8;
set local role authenticated;
do $$ declare c place_cases;begin select * into c from place_cases where n=8;perform pg_temp.match_actor(2);
 perform pg_temp.expect_failure(format('select public.accept_appointment_schedule_change(%L,%L,%L)',c.ap,c.change_id,c.version),array['40001']);end $$;
reset role;
do $$ declare c place_cases;begin select * into c from place_cases where n=8;
 assert(select updated_at=c.updated and starts_at=c.starts from public.posts where id=c.p);
 assert(select status='awaiting_response' from private.appointment_schedule_changes where change_id=c.change_id);end $$;
select 'PASS 위치만 변경된 stale fingerprint 수락 차단';
select 'NOT_RUN 51 철회 및 receipt 마감 잠금 경합 정책 검증';
rollback;
