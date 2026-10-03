-- 개인 확인·실제 완료·후기 작성/공개·완료 횟수를 서로 구분하는 실제 역할 검사.
-- 전용 로컬 합성 자료만 사용하며 BEGIN/ROLLBACK 안에서 실행한다.
begin;
create function pg_temp.review_uid(n integer) returns uuid language sql immutable as $$
  select ('91000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.review_ap(n integer) returns uuid language sql immutable as $$
  select ('94000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.review_actor(n integer) returns void language plpgsql as $$
declare u uuid:=pg_temp.review_uid(n);
begin
  perform set_config('request.jwt.claim.sub',u::text,true);
  -- 기존 회원의 실제 완료/후기 정리 권한은 네이버 신규 활동 gate와 별개다.
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',u,
    'session_id','92000000-0000-4000-8000-000000000099')::text,true);
end; $$;
create function pg_temp.review_expect(command text,expected text[]) returns void language plpgsql as $$
declare code text;
begin
  begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
  assert code=any(expected),'unexpected review permission/state result';
end; $$;
create temp table review_probe(name text primary key,review_id uuid,submitted_at timestamptz,completed_at timestamptz,count_before integer,deadline_at timestamptz);
grant all on review_probe to authenticated,service_role;

-- 이 단계는 기존 약속/회원의 후속 처리를 검증한다. 합성 기존 회원은 네이버 등록으로 승격하지 않는다.
insert into auth.users(id) values(pg_temp.review_uid(1)),(pg_temp.review_uid(2)),(pg_temp.review_uid(3));
insert into auth.sessions(id,user_id) values('92000000-0000-4000-8000-000000000099',pg_temp.review_uid(1));
insert into public.profiles(id,real_name,birth_date,gender) values
  (pg_temp.review_uid(1),'합성 완료작성자','1990-01-01','female'),
  (pg_temp.review_uid(2),'합성 완료신청자','1990-01-01','female'),
  (pg_temp.review_uid(3),'합성 외부회원','1990-01-01','female');
do $$ declare n integer;p uuid;r uuid;v_end timestamptz;v_complete timestamptz;v_status text;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  for n in 1..13 loop
    p:=('93000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
    r:=('95000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
    v_end:=case when n=1 then clock_timestamp()+interval '1 hour' when n in(10,11) then clock_timestamp()-interval '2 days' else clock_timestamp()-interval '1 hour' end;
    v_status:=case when n in(4,5,6,7,12) then 'completed' when n=8 then 'no_show' when n=9 then 'cancelled' else 'confirmed' end;
    v_complete:=case when n=6 then clock_timestamp()-interval '8 days' when n=12 then clock_timestamp()-interval '10 days' else clock_timestamp()-interval '1 hour' end;
    insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount,status)
      values(p,pg_temp.review_uid(1),'가상 완료후기 공고','실제 자료가 아닌 로컬 검증','산책',v_end-interval '2 hours',v_end,
        v_end-interval '3 hours','서울특별시 강남구 역삼동','free',0,'closed');
    insert into public.join_requests(id,post_id,requester_id,message,status) values(r,p,pg_temp.review_uid(2),'가상 완료후기 검증 신청','matched');
    if v_status in('completed','no_show') then
      insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
        values(pg_temp.review_ap(n),p,r,v_status,v_complete,'automatic',v_complete,v_complete+interval '24 hours',v_complete+interval '7 days');
    else
      insert into public.appointments(id,post_id,join_request_id,status) values(pg_temp.review_ap(n),p,r,v_status);
    end if;
  end loop;
  insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)
    values(pg_temp.review_ap(11),pg_temp.review_uid(1),'가상 자동 완료 제외 분쟁',interval '7 days');
end $$;
set local role authenticated;
select pg_temp.review_actor(1);
insert into review_probe(name,count_before) select 'baseline',(public.get_public_profile_reviews(pg_temp.review_uid(1),100)->>'completedCount')::integer;
reset role;
select 'ORDERED_STAGE:synthetic_fixtures';

-- 종료 전 제출/확인, 종료 후 개인 확인 없이 제출을 모두 막는다.
set local role authenticated;
do $$ declare s record;begin
  perform pg_temp.review_actor(1);
  select * into s from public.get_appointment_review_state(pg_temp.review_ap(1));assert not s.can_write and not s.appointment_completed;
  perform pg_temp.review_expect(format('select public.confirm_appointment_completion(%L)',pg_temp.review_ap(1)),array['22023']);
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,5,''아직 종료 전'',''positive'',''{}'')',pg_temp.review_ap(1)),array['22023']);
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,5,''개인 완료 확인 전'',''positive'',''{}'')',pg_temp.review_ap(2)),array['22023']);
  perform public.confirm_appointment_completion(pg_temp.review_ap(2));
  select * into s from public.get_appointment_review_state(pg_temp.review_ap(2));
  assert s.can_write and not s.appointment_completed and s.deadline_at is null and not s.released;
  insert into review_probe(name,review_id,submitted_at)
    select 'early',(r->>'reviewId')::uuid,(r->>'submittedAt')::timestamptz
      from (select public.submit_appointment_review(pg_temp.review_ap(2),5,'상대 확인보다 먼저 남기는 합성 후기','positive',array['punctual']) r) x;
  perform pg_temp.review_actor(2);
  select * into s from public.get_appointment_review_state(pg_temp.review_ap(2));
  assert s.peer_submitted and s.peer_review is null and not s.released and not s.can_write;
  assert jsonb_array_length(public.get_public_profile_reviews(pg_temp.review_uid(2),100)->'reviews')=0;
  assert jsonb_array_length(public.get_public_profile_reviews(pg_temp.review_uid(2),100)->'praisesTop5')=0;
end $$;
reset role;
do $$ begin
  assert (select status='confirmed' and completed_at is null from public.appointments where id=pg_temp.review_ap(2));
  assert not private.is_review_public_eligible((select review_id from review_probe where name='early'));
  assert jsonb_array_length(private.review_summary_sources(pg_temp.review_uid(2)))=0;
end $$;
select 'ORDERED_CHECK:personal_confirmation_submission_before_completion';

-- 비정상 과거 자료에 양쪽 후기가 있어도 미완료이면 공개하지 않는다.
insert into public.appointment_reviews(appointment_id,reviewer_id,rating,comment,experience,praises)
  values(pg_temp.review_ap(3),pg_temp.review_uid(1),5,'미완료 합성 양쪽 후기 하나','positive','{}'),
        (pg_temp.review_ap(3),pg_temp.review_uid(2),4,'미완료 합성 양쪽 후기 둘','neutral','{}');
set local role authenticated;
do $$ declare s record;begin
  perform pg_temp.review_actor(1);select * into s from public.get_appointment_review_state(pg_temp.review_ap(3));
  assert s.peer_submitted and s.peer_review is null and not s.released;
end $$;
reset role;
do $$ begin
  assert not private.review_release_ready(pg_temp.review_ap(3));
  assert not exists(select 1 from public.appointment_reviews where appointment_id=pg_temp.review_ap(3) and private.is_review_public_eligible(id));
end $$;
select 'ORDERED_CHECK:both_early_reviews_wait_for_actual_completion';

-- 두 번째 개인 확인으로 실제 완료. 후기 없는 완료도 지표에 즉시 반영한다.
set local role authenticated;
do $$ declare s record;t timestamptz;n integer;begin
  perform pg_temp.review_actor(2);
  select * into s from public.confirm_appointment_completion(pg_temp.review_ap(2));
  assert s.status='completed' and s.completion_method='manual';t:=s.completed_at;
  assert (public.get_public_profile_reviews(pg_temp.review_uid(1),100)->>'completedCount')::integer=(select count_before+1 from review_probe where name='baseline');
  select * into s from public.confirm_appointment_completion(pg_temp.review_ap(2));assert s.completed_at=t;
  insert into review_probe(name,completed_at) values('actual',t);
  perform pg_temp.review_actor(1);perform public.confirm_appointment_completion(pg_temp.review_ap(13));
  perform pg_temp.review_actor(2);perform public.confirm_appointment_completion(pg_temp.review_ap(13));
  n:=(public.get_public_profile_reviews(pg_temp.review_uid(1),100)->>'completedCount')::integer;
  assert n=(select count_before+2 from review_probe where name='baseline');
end $$;
reset role;
do $$ begin
  assert (select review_deadline_at=completed_at+interval '7 days' from public.appointments where id=pg_temp.review_ap(2));
  assert (select status='completed' from public.appointments where id=pg_temp.review_ap(13));
  assert not exists(select 1 from public.appointment_reviews where appointment_id=pg_temp.review_ap(13));
  assert (select count(*) from public.appointment_completion_confirmations where appointment_id=pg_temp.review_ap(2))=2;
end $$;
select 'ORDERED_CHECK:actual_completion_metrics_deadline_immutability';

-- 한쪽 공개 24시간의 기준은 실제 completed_at. 알림/읽음 시각을 기준으로 삼지 않는다.
update public.appointments set completion_notified_at=completed_at-interval '3 days',
  dispute_deadline_at=completed_at-interval '3 days'+interval '24 hours' where id=pg_temp.review_ap(2);
update public.notifications set read_at=clock_timestamp()-interval '2 days'
  where join_request_id='95000000-0000-4000-8000-000000000002';
set local role authenticated;
do $$ declare s record;begin
  perform pg_temp.review_actor(2);select * into s from public.get_appointment_review_state(pg_temp.review_ap(2));
  assert not s.released and s.peer_review is null;
end $$;
reset role;
do $$ begin
  assert not private.is_review_public_eligible((select review_id from review_probe where name='early'));
end $$;
update public.appointments set completed_at=now()-interval '25 hours',
  completion_notified_at=now(),dispute_deadline_at=now()+interval '24 hours',review_deadline_at=now()+interval '6 days'
  where id=pg_temp.review_ap(2);
set local role authenticated;
do $$ declare s record;r jsonb;begin
  perform pg_temp.review_actor(2);select * into s from public.get_appointment_review_state(pg_temp.review_ap(2));
  assert s.released and s.peer_review is not null and s.release_reason='hold_elapsed';
  r:=public.get_public_profile_reviews(pg_temp.review_uid(2),100);
  assert jsonb_array_length(r->'reviews')=1 and jsonb_array_length(r->'praisesTop5')=1;
  assert r#>>'{praisesTop5,0,code}'='punctual' and r#>>'{praisesTop5,0,count}'='1';
end $$;
reset role;
do $$ begin
  assert private.is_review_public_eligible((select review_id from review_probe where name='early'));
  assert jsonb_array_length(private.review_summary_sources(pg_temp.review_uid(2)))=1;
end $$;
select 'ORDERED_CHECK:single_review_completed24h_same_gate';

-- 실제 완료의 양쪽 제출은 즉시 공개. 명시 hide override는 모든 경로에서 동일 적용.
set local role authenticated;
do $$ declare r jsonb;s record;begin
  perform pg_temp.review_actor(1);r:=public.submit_appointment_review(pg_temp.review_ap(4),5,'양쪽 제출 즉시 공개 합성 후기','positive',array['considerate']);
  insert into review_probe(name,review_id) values('mutual-author',(r->>'reviewId')::uuid);
  perform pg_temp.review_actor(2);perform public.submit_appointment_review(pg_temp.review_ap(4),4,'양쪽 제출 두 번째 합성 후기','neutral','{}');
  select * into s from public.get_appointment_review_state(pg_temp.review_ap(4));assert s.released and s.peer_review is not null and s.release_reason='mutual';
end $$;
reset role;
set local role service_role;
select public.set_review_publication((select review_id from review_probe where name='mutual-author'),false);
reset role;
set local role authenticated;
do $$ declare s record;r jsonb;begin
  perform pg_temp.review_actor(2);select * into s from public.get_appointment_review_state(pg_temp.review_ap(4));
  assert s.peer_review is null;
  r:=public.get_public_profile_reviews(pg_temp.review_uid(2),100);
  assert not exists(select 1 from jsonb_array_elements(r->'reviews') x where x->>'reviewId'=(select review_id::text from review_probe where name='mutual-author'));
  assert not exists(select 1 from jsonb_array_elements(r->'praisesTop5') x where x->>'code'='considerate');
end $$;
reset role;
do $$ begin
  assert not private.is_review_public_eligible((select review_id from review_probe where name='mutual-author'));
  assert not exists(select 1 from jsonb_array_elements(private.review_summary_sources(pg_temp.review_uid(2))) x where x->>'reviewId'=(select review_id::text from review_probe where name='mutual-author'));
end $$;
select 'ORDERED_CHECK:mutual_release_override_consistent';

-- 마감 정확 경계와 제출된 후기의 동일 재시도/변경 금지.
do $$ declare at timestamptz:=clock_timestamp();begin
  assert public.review_submission_open(at-interval '7 days',at,'completed',at-interval '1 microsecond');
  assert not public.review_submission_open(at-interval '7 days',at,'completed',at);
  assert not public.review_submission_open(at-interval '7 days',at,'completed',at+interval '1 microsecond');
end $$;
set local role authenticated;
do $$ declare r jsonb;begin
  perform pg_temp.review_actor(1);
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,4,''기한 지난 새 후기'',''neutral'',''{}'')',pg_temp.review_ap(6)),array['22023']);
  r:=public.submit_appointment_review(pg_temp.review_ap(2),5,'상대 확인보다 먼저 남기는 합성 후기','positive',array['punctual']);
  assert r->>'deduplicated'='true' and r->>'reviewId'=(select review_id::text from review_probe where name='early');
  assert (r->>'submittedAt')::timestamptz=(select submitted_at from review_probe where name='early');
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,1,''제출 후 변경 시도'',''negative'',''{}'')',pg_temp.review_ap(2)),array['23505']);
end $$;
reset role;
select 'ORDERED_CHECK:deadline_boundary_immutable_retry';

-- 실제 분쟁은 작성/공개를 보류하고 실제 만남 인정 시 잔여기간/최소24시간 재개.
set local role authenticated;
do $$ declare s record;before_count integer;begin
  perform pg_temp.review_actor(1);
  perform public.submit_appointment_review(pg_temp.review_ap(7),5,'분쟁 동안 숨겨질 합성 후기','positive','{}');
  before_count:=(public.get_public_profile_reviews(pg_temp.review_uid(1),100)->>'completedCount')::integer;
  perform public.raise_appointment_dispute(pg_temp.review_ap(7),'합성 실제 이의 검토');
  assert (public.get_public_profile_reviews(pg_temp.review_uid(1),100)->>'completedCount')::integer=before_count;
  perform pg_temp.review_actor(2);select * into s from public.get_appointment_review_state(pg_temp.review_ap(7));
  assert s.disputed and not s.can_write and not s.released and s.peer_review is null;
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,4,''분쟁 중 작성 시도'',''neutral'',''{}'')',pg_temp.review_ap(7)),array['22023']);
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,4,''불발 작성 시도'',''neutral'',''{}'')',pg_temp.review_ap(8)),array['22023']);
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,4,''취소 작성 시도'',''neutral'',''{}'')',pg_temp.review_ap(9)),array['22023']);
end $$;
reset role;
do $$ declare at timestamptz;remaining interval;begin
  assert not private.review_release_ready(pg_temp.review_ap(7));
  assert not private.review_release_ready(pg_temp.review_ap(8));assert not private.review_release_ready(pg_temp.review_ap(9));
  select review_time_remaining into remaining from public.appointment_disputes where appointment_id=pg_temp.review_ap(7);
  at:=clock_timestamp();perform private.resolve_appointment_dispute(pg_temp.review_ap(7),'actual_meetup',at);
  assert (select review_deadline_at=at+greatest(remaining,interval '24 hours') from public.appointments where id=pg_temp.review_ap(7));
  -- 별도 합성 분쟁은 남은 기간이 짧아도 최소24시간 보장.
  insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)
    values(pg_temp.review_ap(5),pg_temp.review_uid(1),'합성 짧은 잔여 기간',interval '1 hour');
  update public.appointments set status='disputed' where id=pg_temp.review_ap(5);
  at:=clock_timestamp();perform private.resolve_appointment_dispute(pg_temp.review_ap(5),'actual_meetup',at);
  assert (select status='completed' and review_deadline_at=at+interval '24 hours' from public.appointments where id=pg_temp.review_ap(5));
end $$;
select 'ORDERED_CHECK:blocked_states_resume_remaining';

-- 실제 정책 칭찬 여섯 항목. 모르는/중복/중립 칭찬/3개초과 거절, 성공 후 불변.
set local role authenticated;
do $$ declare c jsonb;r jsonb;begin
  perform pg_temp.review_actor(1);c:=public.get_review_praise_catalog();assert jsonb_array_length(c->'items')=6;
  assert (select array_agg(x->>'label' order by x->>'code') from jsonb_array_elements(c->'items') x)=
    array['함께하니 편안해요','소통이 원활해요','배려심이 있어요','대화가 즐거워요','약속한 내용을 지켜요','시간을 잘 지켜요'];
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,5,null,''positive'',array[''unknown''])',pg_temp.review_ap(5)),array['22023']);
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,5,null,''positive'',array[''punctual'',''punctual''])',pg_temp.review_ap(5)),array['22023']);
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,5,null,''neutral'',array[''punctual''])',pg_temp.review_ap(5)),array['22023']);
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,5,null,''positive'',array[''punctual'',''considerate'',''keeps_promises'',''communicates_well''])',pg_temp.review_ap(5)),array['22023']);
  r:=public.submit_appointment_review(pg_temp.review_ap(5),5,null,'positive',array['punctual','considerate','keeps_promises']);
  assert r->>'deduplicated'='false';
  assert public.submit_appointment_review(pg_temp.review_ap(5),5,null,'positive',array['keeps_promises','punctual','considerate'])->>'deduplicated'='true';
end $$;
reset role;
-- 이전 선택값은 이력 보존. 현재 inactive 항목 새 제출은 차단하되 정확 동일 재시도는 허용한다.
insert into private.review_praise_catalog(code,label,is_active,display_order) values('legacy_praise','합성 과거 칭찬',false,99);
insert into public.appointment_reviews(appointment_id,reviewer_id,rating,comment,experience,praises)
  values(pg_temp.review_ap(12),pg_temp.review_uid(1),5,'보존할 합성 과거 후기','positive',array['legacy_praise']);
set local role authenticated;
do $$ begin
  perform pg_temp.review_actor(1);assert public.submit_appointment_review(pg_temp.review_ap(12),5,'보존할 합성 과거 후기','positive',array['legacy_praise'])->>'deduplicated'='true';
  perform pg_temp.review_actor(2);perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,5,null,''positive'',array[''legacy_praise''])',pg_temp.review_ap(5)),array['22023']);
end $$;
reset role;
select 'ORDERED_CHECK:praise_catalog_validation';

-- 권한/RLS: 타인·익명·옛간편입력·직접테이블 차단, 기존 회원/세션의 약속 정리는 유지.
do $$ begin
  assert has_function_privilege('authenticated','public.submit_appointment_review(uuid,integer,text,text,text[])','EXECUTE');
  assert not has_function_privilege('anon','public.get_review_praise_catalog()','EXECUTE');
  assert not has_function_privilege('authenticated','public.submit_appointment_review(uuid,integer,text)','EXECUTE');
  assert not has_function_privilege('authenticated','private.is_review_public_eligible(uuid)','EXECUTE');
  assert not has_table_privilege('authenticated','private.review_praise_catalog','UPDATE');
  assert not has_table_privilege('authenticated','public.appointment_reviews','INSERT');
end $$;
set local role authenticated;
do $$ begin
  perform pg_temp.review_actor(3);perform pg_temp.review_expect(format('select public.get_appointment_review_state(%L)',pg_temp.review_ap(2)),array['PT404']);
  perform pg_temp.review_expect(format('select public.submit_appointment_review(%L,5,null,''positive'',''{}'')',pg_temp.review_ap(2)),array['PT404']);
  perform pg_temp.review_expect('select 1 from private.review_praise_catalog',array['42501']);
  perform pg_temp.review_actor(1);
  perform pg_temp.review_expect('select public.submit_appointment_review(''94000000-0000-4000-8000-000000000012'',5,null)',array['42501']);
  perform pg_temp.review_expect('select public.process_due_completions(10)',array['42501']);
end $$;
reset role;
set local role anon;
do $$ begin perform pg_temp.review_expect('select public.get_review_praise_catalog()',array['42501']);end $$;
reset role;
select 'ORDERED_CHECK:roles_rls_existing_session_permissions';

-- 자동 완료 지연은 실제 처리 시각, 완료 횟수·deadline 재실행불변. 분쟁/불발/취소 제외.
set local role authenticated;
select pg_temp.review_actor(1);
insert into review_probe(name,count_before) select 'before-auto',(public.get_public_profile_reviews(pg_temp.review_uid(1),100)->>'completedCount')::integer;
reset role;
set local role service_role;
do $$ declare r jsonb;at timestamptz:=clock_timestamp();begin
  r:=public.process_due_completions(1000);assert r->>'completedCount'='1';
  assert public.process_due_completions(1000)->>'completedCount'='0';
end $$;
reset role;
do $$ begin
  assert (select status='completed' and completion_method='automatic' and completed_at>clock_timestamp()-interval '1 minute'
    and review_deadline_at=completed_at+interval '7 days' from public.appointments where id=pg_temp.review_ap(10));
  assert (select status='confirmed' from public.appointments where id=pg_temp.review_ap(11));
  assert (select status='no_show' from public.appointments where id=pg_temp.review_ap(8));
  assert (select status='cancelled' from public.appointments where id=pg_temp.review_ap(9));
  assert (select completed_at<clock_timestamp()-interval '9 days' from public.appointments where id=pg_temp.review_ap(12));
  assert exists(select 1 from public.appointment_reviews where appointment_id=pg_temp.review_ap(12) and comment='보존할 합성 과거 후기');
end $$;
set local role authenticated;
do $$ begin
  perform pg_temp.review_actor(1);assert (public.get_public_profile_reviews(pg_temp.review_uid(1),100)->>'completedCount')::integer=(select count_before+1 from review_probe where name='before-auto');
end $$;
reset role;
select 'ORDERED_CHECK:automatic_completion_actual_time_exclusions';
rollback;
