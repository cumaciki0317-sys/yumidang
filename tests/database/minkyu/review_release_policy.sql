-- 실제 로컬 PostgreSQL에서 실행. 모든 가상 자료는 마지막에 rollback한다.
begin;
do $$
declare a uuid:=md5('release-policy-author')::uuid; b uuid:=md5('release-policy-peer')::uuid;
 p uuid; r uuid; ap uuid; rv uuid; x jsonb; state record; gen uuid; oldgen uuid;
 at_before timestamptz; completed timestamptz; revision_before bigint;
begin
 insert into auth.users(id) values(a),(b);
 insert into public.profiles(id,real_name,birth_date) values(a,'공개작성자','1990-01-01'),(b,'공개대상자','1990-01-01');
 insert into private.review_praise_catalog(code,label) values('policy_kind','정책 친절');
 for i in 1..10 loop
  p:=md5('release-policy-p'||i)::uuid; r:=md5('release-policy-r'||i)::uuid; ap:=md5('release-policy-ap'||i)::uuid;
  insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
   values(p,a,'공개 정책 검증','실제 로컬 회귀 검사','산책',now()-interval '3 days',
    case when i=9 then now()-interval '23 hours' else now()-interval '25 hours' end,
    now()-interval '4 days','서울특별시 강남구 역삼동');
  insert into public.join_requests(id,post_id,requester_id,message,status) values(r,p,b,'공개 정책 검사 신청입니다','matched');
  if i>=9 then
   insert into public.appointments(id,post_id,join_request_id,status) values(ap,p,r,'confirmed');
  else
   insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
    values(ap,p,r,'completed',now()-interval '1 hour','automatic',now()-interval '1 hour',now()+interval '23 hours',now()+interval '167 hours');
  end if;
  if i<>3 and i<9 then
   rv:=md5('release-policy-rv'||i)::uuid;
   insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience,praises)
    values(rv,ap,a,5,'정책 공개 근거 '||i,'positive',array['policy_kind']);
  end if;
  if i in(1,4,5,6,7,8) then
   insert into public.appointment_reviews(appointment_id,reviewer_id,rating,comment,experience)
    values(ap,b,4,'반대쪽 제출 검증','neutral');
  end if;
 end loop;
 perform set_config('request.jwt.claim.sub',b::text,true);
 -- 양측 제출은 시간 보류 안에 즉시 공개된다. 배치 실행 전 실제 세 조회 경로가 일치한다.
 ap:=md5('release-policy-ap1')::uuid;
 select * into state from public.get_appointment_review_state(ap);
 assert state.released and state.release_reason='mutual' and state.peer_review is not null;
 assert state.hold_until>clock_timestamp(),'24시간 보류 중 양측 제출';
 assert not(select is_public from private.review_publication where review_id=md5('release-policy-rv1')::uuid),'물질화 배치는 아직 실행하지 않음';
 x:=public.get_public_profile_reviews(b,100,null);
 assert exists(select 1 from jsonb_array_elements(x->'reviews') e where e->>'reviewId'=md5('release-policy-rv1')::uuid::text);
 x:=public.load_public_review_snapshot(b);
 assert exists(select 1 from jsonb_array_elements(x->'reviews') e where e->>'reviewId'=md5('release-policy-rv1')::uuid::text);
 -- 한쪽 후기: 24시간 직전 미공개 / 직후 공개, 7일 작성기한과는 독립이다.
 ap:=md5('release-policy-ap2')::uuid;
 update public.appointments set completion_notified_at=now()-interval '24 hours'+interval '10 seconds',
  dispute_deadline_at=now()+interval '10 seconds' where id=ap;
 select * into state from public.get_appointment_review_state(ap);
 assert not state.released and state.release_reason is null;
 update public.appointments set completion_notified_at=now()-interval '24 hours',dispute_deadline_at=now() where id=ap;
 select * into state from public.get_appointment_review_state(ap);
 assert state.released and state.release_reason='hold_elapsed' and state.can_write and state.deadline_at>now();
 -- 0건은 보류/작성기한이 모두 지나도 released=false다.
 ap:=md5('release-policy-ap3')::uuid;
 update public.appointments set completed_at=now()-interval '8 days',completion_notified_at=now()-interval '8 days',
  dispute_deadline_at=now()-interval '7 days',review_deadline_at=now()-interval '1 day' where id=ap;
 select * into state from public.get_appointment_review_state(ap);
 assert not state.released and state.release_reason is null and not state.can_write;
 -- 과거 한명 수동완료는 양측 후기가 있어도 미공개다. 양측 완료 확인 후 공개된다.
 ap:=md5('release-policy-ap4')::uuid;
 update public.appointments set completion_method='manual',completed_by_user_id=a where id=ap;
 insert into public.appointment_completion_confirmations(appointment_id,user_id) values(ap,a);
 assert not private.review_release_ready(ap);
 insert into public.appointment_completion_confirmations(appointment_id,user_id) values(ap,b);
 assert private.review_release_ready(ap);
 -- 실제 분쟁과 불발은 mutual보다 우선한다.
 insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)
  values(md5('release-policy-ap5')::uuid,b,'실제 분쟁 제외 검증',interval '1 day');
 insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining,status,resolution,resolved_at)
  values(md5('release-policy-ap6')::uuid,b,'실제 불발 제외 검증',interval '1 day','resolved','no_show',now());
 assert not private.review_release_ready(md5('release-policy-ap5')::uuid);
 assert not private.review_release_ready(md5('release-policy-ap6')::uuid);
 -- 공개 근거 없는 역사 후기는 보존하고 override 비공개도 배치가 되돌리지 않는다.
 delete from private.review_publication where review_id=md5('release-policy-rv7')::uuid;
 perform public.set_review_publication(md5('release-policy-rv8')::uuid,false);
 x:=public.get_public_profile_reviews(b,100,null);
 assert jsonb_array_length(x->'reviews')=3,'mutual 1/4와 hold_elapsed 2만 공개';
 assert (x->'praisesTop5'->0->>'count')::integer=3,'칭찬과 공개 후기 gate 일치';
 x:=public.load_public_review_snapshot(b);
 assert (x->>'eligibleCount')::integer=3,'요약 입력 gate 일치';
 select revision into revision_before from private.review_summary_state where profile_id=b;
 x:=public.process_due_review_publications(1000);
 assert (x->>'publishedCount')::integer>=3;
 assert exists(select 1 from private.review_refresh_outbox where profile_id=b),'모델 없이 공개 후 outbox 보존';
 assert not(select is_public from private.review_publication where review_id=md5('release-policy-rv8')::uuid);
 assert not exists(select 1 from private.review_publication where review_id=md5('release-policy-rv7')::uuid);
 x:=public.process_due_review_publications(1000); assert (x->>'publishedCount')::integer=0,'공개 물질화 재호출 멱등';
 begin perform public.process_review_summary_refresh(1000,'','test_prompt'); raise exception '잘못된 모델 설정 허용';
 exception when invalid_parameter_value then null; end;
 assert exists(select 1 from private.review_refresh_outbox where profile_id=b),'실패 시 outbox 보존';
 x:=public.process_review_summary_refresh(1000,'test_model','test_prompt');
 assert (x->>'enqueuedCount')::integer>=1;
 assert not exists(select 1 from private.review_refresh_outbox where profile_id=b);
 -- 미완료 약속은 양측 후기 행이 있어도 공개하지 않는다.
 insert into public.appointment_reviews(appointment_id,reviewer_id,rating,comment)
   values(md5('release-policy-ap9')::uuid,a,5,'미완료 검증'),(md5('release-policy-ap9')::uuid,b,5,'미완료 상대 검증');
 assert not private.review_release_ready(md5('release-policy-ap9')::uuid);
 -- 예약 생성, 이른 호출, 기한 변경 세대, 이전 타이머, 취소, 분쟁 및 복구.
 ap:=md5('release-policy-ap9')::uuid;
 select generation into gen from private.completion_reservations where appointment_id=ap;
 assert gen is not null;
 x:=public.execute_completion_reservation(ap,gen); assert x->>'status'='not_due';
 update public.posts set ends_at=ends_at+interval '1 hour' where id=md5('release-policy-p9')::uuid;
 select generation into oldgen from private.completion_reservations where appointment_id=ap;
 assert gen<>oldgen;
 x:=public.execute_completion_reservation(ap,gen); assert x->>'status'='stale';
 insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)
  values(ap,b,'예약 분쟁 차단 검사',interval '1 day');
 assert not exists(select 1 from private.completion_reservations where appointment_id=ap);
 delete from public.appointment_disputes where appointment_id=ap;
 select generation into gen from private.completion_reservations where appointment_id=ap;
 assert gen is not null and gen<>oldgen;
 update public.appointments set status='cancelled' where id=ap;
 assert not exists(select 1 from private.completion_reservations where appointment_id=ap);
 x:=public.execute_completion_reservation(ap,gen); assert x->>'status'='stale';
 -- 지연된 예약 완료는 DB 실제 실행 시각과 7일, 알림2개를 원자적으로 기록한다.
 ap:=md5('release-policy-ap10')::uuid;
 select generation into gen from private.completion_reservations where appointment_id=ap;
 at_before:=clock_timestamp(); x:=public.execute_completion_reservation(ap,gen);
 assert x->>'status'='completed'; completed:=(x->>'completedAt')::timestamptz;
 assert completed>=at_before;
 assert (select completed_at=completed and review_deadline_at=completed_at+interval '7 days'
  and completion_notified_at=completed_at and completion_method='automatic' from public.appointments where id=ap);
 assert not exists(select 1 from private.completion_reservations where appointment_id=ap);
 assert not exists(select 1 from public.appointment_completion_confirmations where appointment_id=ap);
 assert (select count(*) from public.notifications where kind='appointment_completed' and join_request_id=md5('release-policy-r10')::uuid)=2;
 x:=public.execute_completion_reservation(ap,gen); assert x->>'status'='stale';
 assert (select completed_at=completed from public.appointments where id=ap);
 assert (select count(*) from public.notifications where kind='appointment_completed' and join_request_id=md5('release-policy-r10')::uuid)=2;
 x:=public.list_completion_reservations(); assert x ? 'serverNow' and jsonb_typeof(x->'reservations')='array';
 assert not exists(select 1 from cron.job where jobname='yumidang-auto-complete-appointments');
 assert not has_table_privilege('service_role','private.completion_reservations','select');
 assert not has_function_privilege('authenticated','public.execute_completion_reservation(uuid,uuid)','execute');
 assert not has_function_privilege('anon','public.list_completion_reservations()','execute');
 assert not has_function_privilege('authenticated','public.process_due_review_publications(integer)','execute');
 assert not has_function_privilege('authenticated','public.process_review_summary_refresh(integer,text,text)','execute');
 raise notice 'PASS dynamic review gate, mutual/hold, zero, disputes, historical/override, outbox, reservations, idempotency, ACL';
end; $$;
set local role authenticated;
do $$ begin
 begin perform public.list_completion_reservations(); raise exception 'member reservation access'; exception when insufficient_privilege then null; end;
 begin perform public.process_due_review_publications(1); raise exception 'member publication access'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
set local role service_role;
select public.list_completion_reservations() ? 'serverNow' as service_reservation_access;
select public.process_due_review_publications(1);
select public.execute_completion_reservation(md5('release-policy-ap10')::uuid,gen_random_uuid())->>'status' as service_stale_reservation;
reset role;
rollback;
