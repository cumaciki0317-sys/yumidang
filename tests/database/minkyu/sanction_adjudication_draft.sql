-- 선행 lifecycle identity와 신규 제재 초안 적용 후 owner로 실행한다. 실제 실행 결과는 협업 문서/비공개 receipt에 기록한다.
-- 운영 액터/회원 서비스 권한을 흉내내어 부여하지 않는 rollback 합성 회귀다.
begin;
-- lifecycle는 검증된 네이버 subject FK를 요구한다. 합성 계정을 먼저 만들며 실제 인증을 주장하지 않는다.
insert into private.naver_accounts(subject,real_name,birth_date,gender,verification_status)values
 ('sanction-draft-synthetic-1','합성 안전 계정1','1990-01-01','female','qualified'),
 ('sanction-draft-synthetic-2','합성 안전 계정2','1990-01-01','female','qualified');
update private.naver_identity_keys set id=case subject when 'sanction-draft-synthetic-1'then'd1000000-0000-4000-8000-000000000001'::uuid else'd1000000-0000-4000-8000-000000000002'::uuid end
 where subject in('sanction-draft-synthetic-1','sanction-draft-synthetic-2');
-- 실제 cancellation_sanction_plan 호출용 합성 관계. 결과 hooks와 제재 적용 API는 이 테스트 범위 밖이다.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create function pg_temp.safety_id(prefix text,n int)returns uuid language sql immutable as $$
 select(prefix||'-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
insert into auth.users(id,email)select pg_temp.safety_id('d5000000',n),'sanction-local-'||n||'@test.invalid'from generate_series(1,2)n;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)values('profile-images','profile-images',false,5242880,array['image/jpeg'])on conflict(id)do nothing;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select'profile-images',pg_temp.safety_id('d5000000',n)::text||'/d5100000-0000-4000-8000-000000000001.jpg',pg_temp.safety_id('d5000000',n)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,2)n;
insert into public.profiles(id,real_name,birth_date,gender,avatar_url)
 select pg_temp.safety_id('d5000000',n),'합성 제재 회원'||n,'1990-01-01','female',pg_temp.safety_id('d5000000',n)::text||'/d5100000-0000-4000-8000-000000000001.jpg'from generate_series(1,2)n;
update private.naver_accounts set user_id=case subject when'sanction-draft-synthetic-1'then pg_temp.safety_id('d5000000',1)else pg_temp.safety_id('d5000000',2)end,completed_at=clock_timestamp() where subject in('sanction-draft-synthetic-1','sanction-draft-synthetic-2');
update private.member_episodes set identity_id=pg_temp.safety_id('d1000000',case profile_id when pg_temp.safety_id('d5000000',1)then 1 else 2 end)
 where profile_id in(pg_temp.safety_id('d5000000',1),pg_temp.safety_id('d5000000',2));
create function pg_temp.safety_subject(n int,kinds text[],v_class text default null,v_type text default null,v_victim uuid default null,cancel_action text default null)returns jsonb language sql stable as $$
 select jsonb_build_object('identityId',pg_temp.safety_id('d1000000',n),'sourceEpisodeId',private.active_member_episode(pg_temp.safety_id('d5000000',n)),'confirmedKinds',to_jsonb(kinds))
 ||case when v_class is null then'{}'::jsonb else jsonb_build_object('violationClass',v_class,'violationType',v_type,'victimIdentityId',v_victim,'cancellationAction',cancel_action)end;
$$;
do $$declare subjects jsonb:=jsonb_build_array(pg_temp.safety_subject(1,array['cancel_sanction','no_show','major_violation']),pg_temp.safety_subject(2,array['no_show']));begin
 assert private.record_incident_revision('d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001',0,'confirmed','confirmed_violation','d4000000-0000-4000-8000-000000000001',subjects)=1;
 assert private.record_incident_revision('d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001',0,'confirmed','confirmed_violation','d4000000-0000-4000-8000-000000000001',subjects)=1;
 assert (select count(*)=1 from private.safety_incident_revisions);
 assert private.incident_subject_penalty('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001')=-10;
 assert private.incident_subject_penalty('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002')=-3;
 assert private.current_member_sweetness(pg_temp.safety_id('d5000000',1))=5;
 assert private.current_member_sweetness(pg_temp.safety_id('d5000000',2))=12;
 assert(private.safety_restriction_state(pg_temp.safety_id('d1000000',1))->>'permanent')::boolean;
 begin
  perform private.record_incident_revision('d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000001',0,'confirmed','confirmed_violation','d4000000-0000-4000-8000-000000000001',jsonb_build_array(pg_temp.safety_subject(1,array['no_show'])));
  raise exception 'expected conflict';exception when serialization_failure then null;end;
 begin
  perform private.record_incident_revision('d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000002',0,'invalidated','operator_error','d4000000-0000-4000-8000-000000000001','[]');
  raise exception 'expected stale';exception when serialization_failure then null;end;
 assert private.record_incident_revision('d2000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000002',1,'invalidated','operator_error','d4000000-0000-4000-8000-000000000001','[]')=2;
 assert private.incident_subject_penalty('d2000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000001')=0;
end; $$;
\echo PASS 원자 revision/대상별 최대 감점/동일 재시도/오래된 revision/정정
-- 액터 참조값은 권한 증명이 아니다. 실제 담당 ACL 검증은 미연결이다.
do $$declare role_name text;begin
 foreach role_name in array array['anon','authenticated','service_role'] loop
  assert not has_function_privilege(role_name,'private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)','EXECUTE');
  assert not has_table_privilege(role_name,'private.safety_incident_revisions','SELECT');
  assert not has_table_privilege(role_name,'private.safety_sanction_applications','INSERT');
 end loop;
end; $$;
\echo PASS 공개/서비스 역할의 판정 우회 차단
create function pg_temp.clear_plan()returns void language plpgsql as $$begin
 delete from private.safety_appointment_result_revisions where identity_id=pg_temp.safety_id('d1000000',1);
 delete from private.safety_appointment_results where identity_id=pg_temp.safety_id('d1000000',1);
end;$$;
create function pg_temp.add_plan_result(n int,starts timestamptz,confirmed timestamptz,outcome text,cancelled timestamptz default null,appeal text default 'none')returns void language plpgsql as $$begin
 insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
 values(pg_temp.safety_id('d6000000',n),pg_temp.safety_id('d5000000',2),'합성 순서 공고','제재 계산 검증용','산책',starts,starts+interval'2 hours',starts-interval'1 hour','서울특별시 강남구 역삼동','recruiting');
 insert into public.join_requests(id,post_id,requester_id,message,status)
 values(pg_temp.safety_id('d7000000',n),pg_temp.safety_id('d6000000',n),pg_temp.safety_id('d5000000',1),'합성 신청','matched');
 insert into public.appointments(id,post_id,join_request_id,confirmed_at)
 values(pg_temp.safety_id('d8000000',n),pg_temp.safety_id('d6000000',n),pg_temp.safety_id('d7000000',n),confirmed);
 -- 이 계산 회귀는 owner가 지정한 합성 판정/순서만 검증한다.
 -- 확정 자동 등록은 별도 실제RPC 회귀에서 검증하며 여기서는 이 약속의 자동 fixture만 교체한다.
 delete from private.safety_appointment_result_revisions where appointment_id=pg_temp.safety_id('d8000000',n);
 delete from private.safety_appointment_results where appointment_id=pg_temp.safety_id('d8000000',n);
 insert into private.safety_appointment_results(identity_id,appointment_id,source_episode_id,agreed_starts_at,confirmed_at,ordering_provenance,current_revision)
 values(pg_temp.safety_id('d1000000',1),pg_temp.safety_id('d8000000',n),private.active_member_episode(pg_temp.safety_id('d5000000',1)),starts,confirmed,'agreed_snapshot',1);
 insert into private.safety_appointment_result_revisions(identity_id,appointment_id,revision,decision_id,outcome,cancellation_at,appeal_state,reason_code)
 values(pg_temp.safety_id('d1000000',1),pg_temp.safety_id('d8000000',n),1,gen_random_uuid(),outcome,cancelled,appeal,'synthetic_review');
end;$$;
create function pg_temp.correct_plan_result(n int,outcome text,cancelled timestamptz default null,appeal text default 'none')returns void language plpgsql as $$declare rev bigint;begin
 select current_revision+1 into rev from private.safety_appointment_results where identity_id=pg_temp.safety_id('d1000000',1)and appointment_id=pg_temp.safety_id('d8000000',n)for update;
 insert into private.safety_appointment_result_revisions(identity_id,appointment_id,revision,decision_id,outcome,cancellation_at,appeal_state,reason_code)
 values(pg_temp.safety_id('d1000000',1),pg_temp.safety_id('d8000000',n),rev,gen_random_uuid(),outcome,cancelled,appeal,'synthetic_correction');
 update private.safety_appointment_results set current_revision=rev where identity_id=pg_temp.safety_id('d1000000',1)and appointment_id=pg_temp.safety_id('d8000000',n);
end;$$;
do $$declare i int;p jsonb;t timestamptz:=statement_timestamp()-interval'30 days';begin
 for i in 101..109 loop perform pg_temp.add_plan_result(i,t+(i-100)*interval'1 day',t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');end loop;
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));
 assert p->>'status'='ready';assert jsonb_array_length(p->'actions')=3;
 assert p->'actions'->0=jsonb_build_object('anchorAppointmentId',pg_temp.safety_id('d8000000',103),'kind','cancel_warning');
 assert p->'actions'->1=jsonb_build_object('anchorAppointmentId',pg_temp.safety_id('d8000000',106),'kind','cancel_restriction');
 assert p->'actions'->2=jsonb_build_object('anchorAppointmentId',pg_temp.safety_id('d8000000',109),'kind','cancel_restriction');
 assert(p->>'eligibleCount')::int=0 and(p->>'hasCancellationWarning')::boolean;
 -- 정상 완료는 횟수만0, 첫 경고 이력은 유지한다.
 perform pg_temp.clear_plan();
 for i in 201..203 loop perform pg_temp.add_plan_result(i,t+(i-200)*interval'1 day',t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');end loop;
 perform pg_temp.add_plan_result(204,t+interval'4 days',t-interval'1 day','completed');
 for i in 205..206 loop perform pg_temp.add_plan_result(i,t+(i-200)*interval'1 day',t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');end loop;
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));
 assert jsonb_array_length(p->'actions')=1 and(p->>'eligibleCount')::int=2 and(p->>'hasCancellationWarning')::boolean;
 perform pg_temp.add_plan_result(207,t+interval'7 days',t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert p->'actions'->1->>'kind'='cancel_restriction';
 -- 취소 버튼 순서/confirmedAt보다 최종 합의 시작 시각이 우선이다.
 perform pg_temp.clear_plan();
 perform pg_temp.add_plan_result(301,t+interval'2 days',t-interval'5 days','own_cancel',statement_timestamp()-interval'48 hours');
 perform pg_temp.add_plan_result(302,t+interval'1 day',t-interval'4 days','completed');
 perform pg_temp.add_plan_result(303,t+interval'3 days',t-interval'3 days','own_cancel',statement_timestamp()-interval'72 hours');
 perform pg_temp.add_plan_result(304,t+interval'4 days',t-interval'2 days','own_cancel',statement_timestamp()-interval'96 hours');
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert jsonb_array_length(p->'actions')=1 and p->'actions'->0->>'anchorAppointmentId'=pg_temp.safety_id('d8000000',304)::text;
 -- 시작 동률은 confirmedAt 순: ID순으로 잘못 집계하면3취소 경고가 나온다.
 perform pg_temp.clear_plan();
 perform pg_temp.add_plan_result(401,t,t-interval'3 days','completed');
 perform pg_temp.add_plan_result(402,t,t-interval'4 days','own_cancel',statement_timestamp()-interval'48 hours');
 perform pg_temp.add_plan_result(403,t,t-interval'2 days','own_cancel',statement_timestamp()-interval'48 hours');
 perform pg_temp.add_plan_result(404,t,t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert p->'actions'='[]'::jsonb and(p->>'eligibleCount')::int=2;
 -- 시작/confirmedAt 모두 동률은 고유 ID순이며 insertion 순서가 아니다.
 perform pg_temp.clear_plan();
 perform pg_temp.add_plan_result(504,t,t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 perform pg_temp.add_plan_result(503,t,t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 perform pg_temp.add_plan_result(502,t,t-interval'1 day','completed');
 perform pg_temp.add_plan_result(501,t,t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert p->'actions'='[]'::jsonb and(p->>'eligibleCount')::int=2;
 -- 중간 결과 미정 뒤의 확정 취소를 넘겨 세지 않는다.
 perform pg_temp.clear_plan();
 perform pg_temp.add_plan_result(601,t,t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 perform pg_temp.add_plan_result(602,t+interval'1 day',t-interval'1 day','pending');
 perform pg_temp.add_plan_result(603,t+interval'2 days',t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 perform pg_temp.add_plan_result(604,t+interval'3 days',t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert p->>'status'='held'and p->>'heldAppointmentId'=pg_temp.safety_id('d8000000',602)::text and(p->>'eligibleCount')::int=1 and p->'actions'='[]'::jsonb;
 update private.safety_appointment_results set current_revision=0 where appointment_id=pg_temp.safety_id('d8000000',602);
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert p->>'status'='held'and p->>'heldAppointmentId'=pg_temp.safety_id('d8000000',602)::text;
 update private.safety_appointment_results set current_revision=1 where appointment_id=pg_temp.safety_id('d8000000',602);
 perform pg_temp.correct_plan_result(602,'exempt');p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert p->'actions'->0->>'anchorAppointmentId'=pg_temp.safety_id('d8000000',604)::text;
 -- 24시간 1µs 전은 보류, 정확히24시간이 지나면 후보 계산 가능; reviewing은 계속 보류.
 perform pg_temp.clear_plan();
 perform pg_temp.add_plan_result(701,t,t-interval'1 day','own_cancel',statement_timestamp()-interval'24 hours'+interval'1 microsecond');
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert p->>'status'='held';
 perform pg_temp.correct_plan_result(701,'own_cancel',statement_timestamp()-interval'24 hours');
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert p->>'status'='ready'and(p->>'eligibleCount')::int=1;
 perform pg_temp.correct_plan_result(701,'own_cancel',statement_timestamp()-interval'48 hours','reviewing');
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert p->>'status'='held';
 perform pg_temp.correct_plan_result(701,'exempt');p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert p->>'status'='ready'and(p->>'eligibleCount')::int=0;
 update private.safety_appointment_results set agreed_starts_at=null,ordering_provenance='unknown'where appointment_id=pg_temp.safety_id('d8000000',701);
 assert private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1))->>'status'='ordering_unknown';
 -- 상대 취소·인정 예외는 본인의 횟수를 늘리거나 정상 완료처럼 초기화하지 않는다.
 perform pg_temp.clear_plan();
 perform pg_temp.add_plan_result(801,t,t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 perform pg_temp.add_plan_result(802,t+interval'1 day',t-interval'1 day','peer_cancel');
 perform pg_temp.add_plan_result(803,t+interval'2 days',t-interval'1 day','exempt');
 perform pg_temp.add_plan_result(804,t+interval'3 days',t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 perform pg_temp.add_plan_result(805,t+interval'4 days',t-interval'1 day','own_cancel',statement_timestamp()-interval'48 hours');
 p:=private.cancellation_sanction_plan(pg_temp.safety_id('d1000000',1));assert jsonb_array_length(p->'actions')=1 and p->'actions'->0->>'anchorAppointmentId'=pg_temp.safety_id('d8000000',805)::text;

end;$$;
\echo PASS 실제 후보함수/첫3경고/추가3반복/완료리셋/최신합의순/동률/미정/24시간/예외
-- verified owner 판정이 실제 두7일 원장·sameepisode 당도를 같은 transaction에 반영한다.
do $$declare t timestamptz:=statement_timestamp();p jsonb;i int;begin
 for i in 9..10 loop
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',i),pg_temp.safety_id('d3000000',i),0,'confirmed','synthetic_confirmed','d4000000-0000-4000-8000-000000000001',jsonb_build_array(pg_temp.safety_subject(1,array['cancel_sanction'])));
 end loop;
 assert(select count(*)=2 from private.safety_sanction_applications where revoked_at is null and kind='cancel_restriction');
 assert(select bool_and(expires_at=applied_at+interval'168 hours')from private.safety_sanction_applications where kind='cancel_restriction'and revoked_at is null);
 assert private.current_member_sweetness(pg_temp.safety_id('d5000000',1))=11;
 p:=private.safety_restriction_state(pg_temp.safety_id('d1000000',1));assert(p->>'restrictedUntil')::timestamptz=(select max(expires_at)from private.safety_sanction_applications where revoked_at is null);
 -- 임시 fixture 시계만 바꾸어 단순 합산이 아닌 최대 종료를 실제 helper에서 확인한다.
 update private.safety_sanction_applications set applied_at=t-interval'2 days',expires_at=t+interval'5 days'where incident_id=pg_temp.safety_id('d2000000',9)and revoked_at is null;
 update private.safety_sanction_applications set applied_at=t-interval'1 day',expires_at=t+interval'6 days'where incident_id=pg_temp.safety_id('d2000000',10)and revoked_at is null;
 p:=private.safety_restriction_state(pg_temp.safety_id('d1000000',1));assert(p->>'restrictedUntil')::timestamptz=t+interval'6 days';
 begin
  update private.safety_sanction_applications set expires_at=applied_at+interval'167 hours'where incident_id=pg_temp.safety_id('d2000000',9)and revoked_at is null;
  raise exception 'expected 7day constraint';exception when check_violation then null;end;
 -- 종료 상태의 NULL시각은 CHECK UNKNOWN으로 통과하면 안 된다.
 for i in 1..2 loop
  begin
   insert into private.safety_appeals(id,identity_id,kind,appointment_id,received_at,deadline_at,state,resolved_at)
   values(gen_random_uuid(),pg_temp.safety_id('d1000000',1),'cancellation',pg_temp.safety_id('d8000000',701),t,t+interval'24 hours',case i when 1 then'accepted'else'rejected'end,null);
   raise exception 'expected closed timestamp';exception when check_violation then null;end;
 end loop;
 begin
  insert into private.safety_appeals(id,identity_id,kind,appointment_id,received_at,deadline_at)
  values(gen_random_uuid(),pg_temp.safety_id('d1000000',1),'cancellation',pg_temp.safety_id('d8000000',701),t,t);
  raise exception 'expected strict deadline';exception when check_violation then null;end;
 insert into private.safety_appeals(id,identity_id,kind,appointment_id,received_at,deadline_at)
 values(gen_random_uuid(),pg_temp.safety_id('d1000000',1),'cancellation',pg_temp.safety_id('d8000000',701),t,t+interval'1 microsecond');
end;$$;
\echo PASS 7일정확기간/중첩최대종료/종결NULL차단/접수마감엄격비교
-- 미완료 네이버 계정/잘못된 회차는 적용하지 않으며 복수 대상 중 실패도 모두 rollback한다.
-- SQL owner 합성 metadata이며 실제 네이버 로그인 증명과 구분한다.
do $$declare prior_at timestamptz;subjects jsonb;begin
 begin
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',70),gen_random_uuid(),0,'confirmed','synthetic','d4000000-0000-4000-8000-000000000001',
  '[{"identityId":"d1000000-0000-4000-8000-000000000001","sourceEpisodeId":null,"confirmedKinds":["major_violation"]}]');
  raise exception 'expected verified episode';exception when insufficient_privilege then null;end;
 begin
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',71),gen_random_uuid(),0,'confirmed','synthetic','d4000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.safety_subject(1,array['major_violation'])||jsonb_build_object('sourceEpisodeId',private.active_member_episode(pg_temp.safety_id('d5000000',2)))));
  raise exception 'expected identity mismatch';exception when serialization_failure then null;end;
 select completed_at into prior_at from private.naver_accounts where subject='sanction-draft-synthetic-2';
 update private.naver_accounts set completed_at=null where subject='sanction-draft-synthetic-2';
 subjects:=jsonb_build_array(pg_temp.safety_subject(1,array['major_violation']),pg_temp.safety_subject(2,array['no_show']));
 begin
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',72),gen_random_uuid(),0,'confirmed','synthetic','d4000000-0000-4000-8000-000000000001',subjects);
  raise exception 'expected incomplete member';exception when insufficient_privilege then null;end;
 assert not exists(select 1 from private.safety_incidents where id in(pg_temp.safety_id('d2000000',70),pg_temp.safety_id('d2000000',71),pg_temp.safety_id('d2000000',72)));
 assert not exists(select 1 from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',72));
 assert not exists(select 1 from private.sweetness_incident_decisions where incident_id=pg_temp.safety_id('d2000000',72));
 assert private.current_member_sweetness(pg_temp.safety_id('d5000000',1))=11;
 update private.naver_accounts set completed_at=prior_at where subject='sanction-draft-synthetic-2';
end;$$;
\echo PASS 필수verified회차/identity교차거절/가입미완료/복수대상부분실패전체롤백
-- 동행 자격과 서버가 이미 검증한 본인 identity 연결은 별개다.
do $$declare status text;old_verified timestamptz;begin
 foreach status in array array['information_required','ineligible']loop
  update private.naver_accounts set verification_status=status,gender='male',real_name='',birth_date='2010-01-01'where subject='sanction-draft-synthetic-2';
  assert private.require_verified_safety_episode(pg_temp.safety_id('d1000000',2),private.active_member_episode(pg_temp.safety_id('d5000000',2)))=pg_temp.safety_id('d5000000',2);
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',73),gen_random_uuid(),case status when'information_required'then 0 else 2 end,'confirmed','identity_not_eligibility','d4000000-0000-4000-8000-000000000001',jsonb_build_array(pg_temp.safety_subject(2,array['no_show'])));
  assert private.current_member_sweetness(pg_temp.safety_id('d5000000',2))=12;
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',73),gen_random_uuid(),case status when'information_required'then 1 else 3 end,'invalidated','synthetic_cleanup','d4000000-0000-4000-8000-000000000001','[]');
  assert private.current_member_sweetness(pg_temp.safety_id('d5000000',2))=15;
 end loop;
 update private.naver_accounts set verification_status='qualified',gender='female',real_name='합성 안전 계정2',birth_date='1990-01-01'where subject='sanction-draft-synthetic-2';
 select verified_at into old_verified from private.naver_accounts where subject='sanction-draft-synthetic-2';
 update private.naver_accounts set verified_at=clock_timestamp()+interval'1 day'where subject='sanction-draft-synthetic-2';
 begin
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',74),gen_random_uuid(),0,'confirmed','unverified','d4000000-0000-4000-8000-000000000001',jsonb_build_array(pg_temp.safety_subject(2,array['no_show'])));
  raise exception 'expected absent current verification';exception when insufficient_privilege then null;end;
 assert not exists(select 1 from private.safety_incidents where id=pg_temp.safety_id('d2000000',74));
 update private.naver_accounts set verified_at=old_verified,user_id=null where subject='sanction-draft-synthetic-2';
 begin
  perform private.require_verified_safety_episode(pg_temp.safety_id('d1000000',2),private.active_member_episode(pg_temp.safety_id('d5000000',2)));
  raise exception 'expected broken subject account member binding';exception when insufficient_privilege then null;end;
 update private.naver_accounts set user_id=pg_temp.safety_id('d5000000',2)where subject='sanction-draft-synthetic-2';
end;$$;
\echo PASS 자격정보누락불충족도본인판정가능/성별나이변경제재우회금지/미검증시각과account바인딩단절거절
-- 일반 경미 동일유형 singlechain: warning→7일→30일, 뒤의 추가 재발도30일.
do $$declare i int;p jsonb;app private.safety_sanction_applications;begin
 for i in 20..23 loop
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',i),gen_random_uuid(),0,'confirmed','minor_spam','d4000000-0000-4000-8000-000000000001',jsonb_build_array(pg_temp.safety_subject(1,'{}','minor','spam')));
 end loop;
 assert(select kind='general_warning'from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',20)and revoked_at is null);
 assert(select kind='general_7d'and expires_at=applied_at+interval'168 hours'from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',21)and revoked_at is null);
 assert(select count(*)=2 and bool_and(expires_at=applied_at+interval'720 hours')from private.safety_sanction_applications where incident_id in(pg_temp.safety_id('d2000000',22),pg_temp.safety_id('d2000000',23))and kind='general_30d'and revoked_at is null);
 assert private.current_member_sweetness(pg_temp.safety_id('d5000000',1))=11; -- 일반 경미 자체의 새 당도 감점은 만들지 않는다.
 select *into app from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',21)and revoked_at is null;
 perform private.record_incident_revision(pg_temp.safety_id('d2000000',21),gen_random_uuid(),1,'reviewing','appeal_review','d4000000-0000-4000-8000-000000000001','[]');
 assert exists(select 1 from private.safety_sanction_applications where id=app.id and revoked_at is null and applied_at=app.applied_at and expires_at=app.expires_at);
 perform private.record_incident_revision(pg_temp.safety_id('d2000000',21),gen_random_uuid(),2,'confirmed','same_decision','d4000000-0000-4000-8000-000000000001',jsonb_build_array(pg_temp.safety_subject(1,'{}','minor','spam')));
 assert exists(select 1 from private.safety_sanction_applications where id=app.id and revoked_at is null and applied_at=app.applied_at and expires_at=app.expires_at);
 -- 명백 오판을 무효화하면 잘못된 제한 즉시 취소, 이후 사건도 원순서 재계산하며 기존 제한 시계는 재시작하지 않는다.
 select *into app from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',22)and revoked_at is null;
 perform private.record_incident_revision(pg_temp.safety_id('d2000000',21),gen_random_uuid(),3,'invalidated','clear_error','d4000000-0000-4000-8000-000000000001','[]');
 assert not exists(select 1 from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',21)and revoked_at is null);
 assert exists(select 1 from private.safety_sanction_applications where id=app.id and revoked_at is not null and correction_reason_code='decision_corrected');
 assert exists(select 1 from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',22)and revoked_at is null and kind='general_7d'and applied_at=app.applied_at and expires_at=app.applied_at+interval'168 hours');
 -- 다른 유형/피해자 새 사슬은 사용자 결정 전 명시 거절하고 사건/원장도 남기지 않는다.
 begin
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',29),gen_random_uuid(),0,'confirmed','minor_other','d4000000-0000-4000-8000-000000000001',jsonb_build_array(pg_temp.safety_subject(1,'{}','minor','other_type')));
  raise exception 'expected multiple chain hold';exception when sqlstate '55000'then null;end;
 assert not exists(select 1 from private.safety_incidents where id=pg_temp.safety_id('d2000000',29));
end;$$;
\echo PASS 일반동일유형singlechain/경고7일30일/이의기존기간유지/무효즉시정정/복수사슬거절
-- 동일 피해자 singlechain은 유형이 바뀌어도 재발이다. 이후12 calendar months는 서울 달력으로 계산한다.
do $$declare i int;t timestamptz:='2024-02-28T16:00:00Z';p jsonb;begin
 for i in 30..32 loop
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',i),gen_random_uuid(),0,'confirmed','same_victim','d4000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.safety_subject(2,'{}','minor','type_'||(i-29),pg_temp.safety_id('d1000000',1))));
 end loop;
 assert(select kind='general_warning'from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',30)and revoked_at is null);
 assert(select kind='general_7d'from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',31)and revoked_at is null);
 assert(select kind='general_30d'from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',32)and revoked_at is null);
 assert private.general_sanction_epoch_end(t)='2025-02-27T16:00:00Z'::timestamptz; -- 서울2024윤년2/29→2025년2/28
 -- owner 합성 confirmed 시각으로 경계만 재현하며 실제 판정 접수 시각을 조작한 운영 증명이 아니다.
 update private.safety_incident_revisions set decided_at=t where incident_id=pg_temp.safety_id('d2000000',30)and state='confirmed';
 update private.safety_incident_revisions set decided_at=private.general_sanction_epoch_end(t)-interval'1 microsecond'where incident_id=pg_temp.safety_id('d2000000',31)and state='confirmed';
 update private.safety_incident_revisions set decided_at=private.general_sanction_epoch_end(private.general_sanction_epoch_end(t)-interval'1 microsecond')where incident_id=pg_temp.safety_id('d2000000',32)and state='confirmed';
 perform private.recompute_safety_applications(pg_temp.safety_id('d1000000',2));
 assert(select kind='general_7d'from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',31)and revoked_at is null);
 assert(select kind='general_warning'from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',32)and revoked_at is null);
end;$$;
\echo PASS 동일피해자재발/12calendar-month서울윤년/1us전유지/정각리셋
-- 중대 위반 즉시 영구제한+사건별최대감점 하나, 이의 reviewing은 유지/명백오판만 원자 취소.
do $$declare app private.safety_sanction_applications;begin
 perform private.record_incident_revision(pg_temp.safety_id('d2000000',41),gen_random_uuid(),0,'confirmed','major_confirmed','d4000000-0000-4000-8000-000000000001',jsonb_build_array(pg_temp.safety_subject(2,array['major_violation','no_show'])));
 assert(private.safety_restriction_state(pg_temp.safety_id('d1000000',2))->>'permanent')::boolean;
 assert private.current_member_sweetness(pg_temp.safety_id('d5000000',2))=5;
 select *into app from private.safety_sanction_applications where incident_id=pg_temp.safety_id('d2000000',41)and revoked_at is null;
 perform private.record_incident_revision(pg_temp.safety_id('d2000000',41),gen_random_uuid(),1,'reviewing','appeal','d4000000-0000-4000-8000-000000000001','[]');
 assert exists(select 1 from private.safety_sanction_applications where id=app.id and revoked_at is null and applied_at=app.applied_at);
 assert private.current_member_sweetness(pg_temp.safety_id('d5000000',2))=5;
 perform private.record_incident_revision(pg_temp.safety_id('d2000000',41),gen_random_uuid(),2,'invalidated','clear_error','d4000000-0000-4000-8000-000000000001','[]');
 assert not(private.safety_restriction_state(pg_temp.safety_id('d1000000',2))->>'permanent')::boolean;
 assert private.current_member_sweetness(pg_temp.safety_id('d5000000',2))=15;
 assert exists(select 1 from private.safety_sanction_applications where id=app.id and revoked_at is not null);
end;$$;
\echo PASS 영구제한원자반영/최대감점하나/검토중유지/오판제한과당도원자복원
-- 같은 UUID라도 종료 회차 사건을 새 회차로 옮겨 최초 감점하지 않는다. 최소 안전 제한은 identity에 남는다.
do $$declare old_episode uuid;new_episode uuid;before_until text;begin
 old_episode:=private.active_member_episode(pg_temp.safety_id('d5000000',1));
 before_until:=private.safety_restriction_state(pg_temp.safety_id('d1000000',1))->>'restrictedUntil';
 update private.member_episodes set ended_at=clock_timestamp()where id=old_episode;
 insert into private.member_episodes(profile_id,identity_id)values(pg_temp.safety_id('d5000000',1),pg_temp.safety_id('d1000000',1))returning id into new_episode;
 assert private.current_member_sweetness(pg_temp.safety_id('d5000000',1))=15;
 assert private.safety_restriction_state(pg_temp.safety_id('d1000000',1))->>'restrictedUntil'=before_until;
 begin
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',90),gen_random_uuid(),0,'confirmed','old_first','d4000000-0000-4000-8000-000000000001',
  jsonb_build_array(pg_temp.safety_subject(1,array['no_show'])||jsonb_build_object('sourceEpisodeId',old_episode)));
  raise exception 'expected old episode hold';exception when sqlstate '55000'then null;end;
 begin
  perform private.record_incident_revision(pg_temp.safety_id('d2000000',9),gen_random_uuid(),1,'confirmed','move_incident','d4000000-0000-4000-8000-000000000001',jsonb_build_array(pg_temp.safety_subject(1,array['cancel_sanction'])));
  raise exception 'expected no episode move';exception when sqlstate '55000'then null;end;
 assert not exists(select 1 from private.safety_incidents where id=pg_temp.safety_id('d2000000',90));
 assert not exists(select 1 from private.sweetness_incident_decisions where recipient_episode_id=new_episode);
 assert private.current_member_sweetness(pg_temp.safety_id('d5000000',1))=15;
end;$$;
\echo PASS 종료회차최초감점거절/사건회차이동거절/새당도15/identity기존제한유지
-- 새 helper도 공개/서비스/회원에 열지 않는다.
do $$declare ro text;sig text;begin
 foreach ro in array array['anon','authenticated','service_role']loop
  foreach sig in array array['private.require_verified_safety_episode(uuid,uuid)','private.recompute_safety_applications(uuid)','private.sync_safety_incident_sweetness(uuid)','private.effective_safety_subjects(uuid)']loop
   assert not has_function_privilege(ro,sig,'EXECUTE');
  end loop;
 end loop;
end;$$;
rollback;
