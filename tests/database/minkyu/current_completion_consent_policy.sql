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
  select ('81000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.match_session(n integer) returns uuid language sql immutable as $$
  select ('82000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.match_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
declare u uuid:=pg_temp.match_uid(n);s uuid:=case when unregistered then '82000000-0000-4000-8000-000000000099'::uuid else pg_temp.match_session(n) end;
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
  for i in 1..5 loop perform public.resolve_naver_account('matching-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;
end $$;
reset role;
insert into auth.users(id,email) select pg_temp.match_uid(i),a.auth_email from generate_series(1,5) i
  join private.naver_accounts a on a.subject='matching-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.match_session(i),pg_temp.match_uid(i) from generate_series(1,5) i;
insert into auth.sessions(id,user_id) values('82000000-0000-4000-8000-000000000099',pg_temp.match_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.match_uid(i)::text||'/83000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
    pg_temp.match_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,5) i;
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.record_naver_session('matching-sql-'||i,pg_temp.match_uid(i),pg_temp.match_session(i));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare i integer;begin
  for i in 1..5 loop
    perform pg_temp.match_actor(i);
    assert public.complete_naver_signup(pg_temp.match_uid(i)::text||'/83000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;


-- AI 근거 검사는 일반 후기 공개와 구분한다. 합성 동의 자료만 transaction 안에 둔다.
insert into private.ai_member_processing(user_id,summary_allowed)
  select pg_temp.match_uid(i),true from generate_series(1,5)i
  on conflict(user_id) do update set summary_allowed=true;

-- 두 정상 회원으로 실제 제안 RPC의 6시간과 시작 시각 상한을 검사한다.
set local role authenticated;
do $$ declare p uuid; r uuid; c jsonb; input jsonb; n integer;begin
  for n in 1..2 loop
    perform pg_temp.match_actor(1);
    p:=gen_random_uuid();input:=pg_temp.match_input(n);
    if n=2 then input:=input||jsonb_build_object('startsAt',clock_timestamp()+interval '2 hours',
      'endsAt',clock_timestamp()+interval '4 hours','recruitmentEndsAt',clock_timestamp()+interval '1 hour');end if;
    perform public.create_service_post(p,input);
    perform pg_temp.match_actor(2);
    r:=(public.request_service_post(p,gen_random_uuid(),'합성 최신 정책 확인 신청')->>'id')::uuid;
    perform pg_temp.match_actor(1);c:=public.propose_match(r);
    if n=1 then assert (c->>'expiresAt')::timestamptz=(c->>'requestedAt')::timestamptz+interval '6 hours';
    else assert (c->>'expiresAt')::timestamptz=(input->>'startsAt')::timestamptz;end if;
    assert public.propose_match(r)->>'conditionVersion'=c->>'conditionVersion';
  end loop;
end $$;
reset role;
select 'CURRENT_POLICY_CHECK:consent_six_hours_start_cap_retry';


-- 일정 변경은 요청+6시간/기존 시작/새 시작의 세 상한을 실제 RPC로 검사한다.
create temp table policy_schedules(n integer,ap uuid,old_start timestamptz,new_start timestamptz,new_end timestamptz);
grant all on policy_schedules to authenticated;
do $$ declare n integer;p uuid;r uuid;ap uuid;st timestamptz;nst timestamptz;begin
  for n in 1..3 loop
    p:=gen_random_uuid();r:=gen_random_uuid();ap:=gen_random_uuid();
    st:=clock_timestamp()+case when n=2 then interval '2 hours' else interval '40 days' end;
    nst:=clock_timestamp()+case when n=3 then interval '1 hour' else interval '41 days' end;
    insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount,status)
      values(p,pg_temp.match_uid(1),'가상 일정 제안 공고','개인정보 없는 합성 일정 검증','산책',st,st+interval '2 hours',
        st-interval '1 hour','서울특별시 강남구 역삼동','free',0,'closed');
    insert into public.post_private_details(post_id,exact_location) values(p,'가상 상세 지점');
    insert into public.join_requests(id,post_id,requester_id,message,status) values(r,p,pg_temp.match_uid(2),'합성 일정 제안 신청','matched');
    insert into public.appointments(id,post_id,join_request_id,status) values(ap,p,r,'confirmed');
    insert into policy_schedules values(n,ap,st,nst,nst+interval '2 hours');
  end loop;
end $$;
set local role authenticated;
select pg_temp.match_actor(1);
do $$ declare x record;c jsonb;state jsonb;cid uuid;before_at timestamptz;after_at timestamptz;begin
  for x in select * from policy_schedules order by n loop
    state:=public.get_appointment_change_state(x.ap);cid:=gen_random_uuid();before_at:=clock_timestamp();
    c:=public.propose_appointment_schedule_change(x.ap,cid,x.new_start,x.new_end,(state->>'updatedAt')::timestamptz);after_at:=clock_timestamp();
    if x.n=1 then assert (c->>'expiresAt')::timestamptz between before_at+interval '6 hours' and after_at+interval '6 hours';
    elsif x.n=2 then assert (c->>'expiresAt')::timestamptz=x.old_start;
    else assert (c->>'expiresAt')::timestamptz=x.new_start;end if;
    assert public.propose_appointment_schedule_change(x.ap,cid,x.new_start,x.new_end,(state->>'updatedAt')::timestamptz)->>'conditionVersion'=c->>'conditionVersion';
  end loop;
end $$;
reset role;
select 'CURRENT_POLICY_CHECK:schedule_six_hours_both_start_caps_retry';

create function pg_temp.policy_ap(n integer) returns uuid language sql immutable as $$
  select ('a4000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.policy_review(n integer) returns uuid language sql immutable as $$
  select ('a5000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
do $$ declare n integer; p uuid; r uuid; at timestamptz;begin
  for n in 1..6 loop
    p:=gen_random_uuid();r:=gen_random_uuid();at:=clock_timestamp()-interval '2 days';
    insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount,status)
      values(p,pg_temp.match_uid(1),'가상 최신 정책 공고','개인정보 없는 합성 검증','산책',at-interval '4 hours',at-interval '2 hours',
        at-interval '6 hours','서울특별시 강남구 역삼동','free',0,'closed');
    insert into public.join_requests(id,post_id,requester_id,message,status) values(r,p,pg_temp.match_uid(2),'가상 정책 검증 신청','matched');
    insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
      values(pg_temp.policy_ap(n),p,r,'completed',at,'automatic',at,at+interval '24 hours',at+interval '7 days');
    insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience,praises)
      values(pg_temp.policy_review(n),pg_temp.policy_ap(n),pg_temp.match_uid(1),5,'원문은 합성 검증 후기','positive',array['punctual']);
  end loop;
end $$;

-- 24시간이 지나도 한쪽 작성 마감 전에는 조회/정리/AI 입력 어디에도 새 공개하지 않는다.
do $$ declare v jsonb;begin
  assert not private.review_release_ready(pg_temp.policy_ap(1));
  assert not private.is_review_public_eligible(pg_temp.policy_review(1));
  v:=public.process_due_review_publications(100);
  assert (select not is_public from private.review_publication where review_id=pg_temp.policy_review(1));
end $$;
set local role authenticated;
select pg_temp.match_actor(2);
do $$ declare s record;begin
  select * into s from public.get_appointment_review_state(pg_temp.policy_ap(1));
  assert not s.released and s.peer_review is null and s.can_write;
  assert jsonb_array_length(public.get_public_profile_reviews(pg_temp.match_uid(2),100)->'reviews')=0;
end $$;
reset role;
select 'CURRENT_POLICY_CHECK:single_review_waits_submission_deadline';

-- 작성 기한 경계에서는 정리 작업 없이 즉시 읽히며, 기한 연장 전에는 공개하지 않는다.
update public.appointments set review_deadline_at=clock_timestamp()-interval '1 second' where id=pg_temp.policy_ap(2);
do $$ begin assert private.review_release_ready(pg_temp.policy_ap(2));
  assert private.is_review_public_eligible(pg_temp.policy_review(2));end $$;
-- 양쪽 후기는 실제 완료 후 작성 마감 전에도 즉시 공개한다.
insert into public.appointment_reviews(appointment_id,reviewer_id,rating,comment,experience,praises)
  values(pg_temp.policy_ap(3),pg_temp.match_uid(2),4,'상대방 합성 후기','neutral','{}');
do $$ begin assert private.review_release_ready(pg_temp.policy_ap(3));
  assert private.is_review_public_eligible(pg_temp.policy_review(3));end $$;
select 'CURRENT_POLICY_CHECK:deadline_and_mutual_immediate';

-- 정리 작업 전 동적으로 공개된 후기도 분쟁 INSERT 전에 물질화하여 유지한다.
insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)
  values(pg_temp.policy_ap(3),pg_temp.match_uid(2),'합성 공개 후 검토',interval '5 days');
update public.appointments set status='disputed' where id=pg_temp.policy_ap(3);
do $$ begin
  assert not private.review_release_ready(pg_temp.policy_ap(3));
  assert (select is_public from private.review_publication where review_id=pg_temp.policy_review(3));
  assert private.is_review_public_eligible(pg_temp.policy_review(3));
  assert exists(select 1 from jsonb_array_elements(private.review_summary_sources(pg_temp.match_uid(2))) x
    where x->>'reviewId'=pg_temp.policy_review(3)::text);
end $$;
set local role authenticated;
select pg_temp.match_actor(2);
do $$ declare s record;begin
  select * into s from public.get_appointment_review_state(pg_temp.policy_ap(3));
  assert s.disputed and s.released and s.peer_review is not null and not s.can_write;
  assert exists(select 1 from jsonb_array_elements(public.get_public_profile_reviews(pg_temp.match_uid(2),100)->'reviews') x
    where x->>'reviewId'=pg_temp.policy_review(3)::text);
end $$;
reset role;
do $$ begin
  perform public.set_review_publication(pg_temp.policy_review(3),false);
  assert not private.is_review_public_eligible(pg_temp.policy_review(3));
  assert not exists(select 1 from jsonb_array_elements(private.review_summary_sources(pg_temp.match_uid(2))) x
    where x->>'reviewId'=pg_temp.policy_review(3)::text);
end $$;
set local role authenticated;
select pg_temp.match_actor(2);
do $$ declare s record;begin
  select * into s from public.get_appointment_review_state(pg_temp.policy_ap(3));
  assert s.disputed and not s.released and s.peer_review is null and not s.can_write;
  assert not exists(select 1 from jsonb_array_elements(public.get_public_profile_reviews(pg_temp.match_uid(2),100)->'reviews') x
    where x->>'reviewId'=pg_temp.policy_review(3)::text);
end $$;
reset role;
-- 실제 완결된 공개 후기를 검토 상태로 바꾸는 경로 역시 보존한다.
update public.appointments set review_deadline_at=clock_timestamp()-interval '1 second' where id=pg_temp.policy_ap(4);
update public.appointments set status='disputed' where id=pg_temp.policy_ap(4);
do $$ begin assert private.is_review_public_eligible(pg_temp.policy_review(4));end $$;
select 'CURRENT_POLICY_CHECK:existing_public_preserved_operator_hide';

-- 공개 전 검토는 새 공개·작성을 보류, 인정 뒤 남은 기간/최소24시간 재개한다.
insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)
  values(pg_temp.policy_ap(5),pg_temp.match_uid(2),'합성 마감 전 검토',interval '2 hours');
update public.appointments set status='disputed' where id=pg_temp.policy_ap(5);
do $$ declare at timestamptz:=clock_timestamp();begin
  assert not private.is_review_public_eligible(pg_temp.policy_review(5));
  assert not private.can_submit_appointment_review(pg_temp.policy_ap(5),pg_temp.match_uid(2),at);
  perform private.resolve_appointment_dispute(pg_temp.policy_ap(5),'actual_meetup',at);
  assert (select review_deadline_at=at+interval '24 hours' from public.appointments where id=pg_temp.policy_ap(5));
  assert not private.is_review_public_eligible(pg_temp.policy_review(5));
  update public.appointments set review_deadline_at=clock_timestamp()-interval '1 second' where id=pg_temp.policy_ap(5);
  assert private.is_review_public_eligible(pg_temp.policy_review(5));
end $$;
-- 노쇼는 과거 공개 표시가 있어도 유효 공개 근거가 아니다.
update private.review_publication set is_public=true where review_id=pg_temp.policy_review(6);
insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)
  values(pg_temp.policy_ap(6),pg_temp.match_uid(2),'합성 노쇼 판정',interval '5 days');
update public.appointments set status='disputed' where id=pg_temp.policy_ap(6);
do $$ begin
  perform private.resolve_appointment_dispute(pg_temp.policy_ap(6),'no_show',clock_timestamp());
  assert not private.is_review_public_eligible(pg_temp.policy_review(6));
  assert not has_function_privilege('authenticated','private.preserve_released_reviews_before_hold()','EXECUTE');
  assert not has_function_privilege('anon','private.review_release_ready(uuid)','EXECUTE');
  assert not has_table_privilege('authenticated','private.review_publication','UPDATE');
end $$;
select 'CURRENT_POLICY_CHECK:hold_resume_deadline_no_show_acl';
rollback;
