-- 로컬 합성 자료만 사용한다. 전체 트랜잭션은 rollback한다. 별도 lifecycle scratch에서 실제 PASS했다.
begin;
-- 56 readiness: 합성 owner 준비만 이 트랜잭션에서 열고 종료 시 원상복구한다.
insert into private.member_cleanup_guard(singleton) values(true) on conflict do nothing;
create function pg_temp.life_pipeline_ready(ready boolean) returns void language plpgsql as $$
declare f text;begin
 update private.member_cleanup_guard set external_deletion_approved=ready;
 foreach f in array array['public.claim_member_cleanup_task(uuid)',
 'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)','public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)',
 'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)'] loop
  if ready then execute 'grant execute on function '||f||' to service_role';
  else execute 'revoke all on function '||f||' from service_role';end if;
 end loop;
end; $$;
insert into private.global_worker_run(singleton) values(true) on conflict do nothing;
insert into storage.buckets(id,name,public) values('profile-images','profile-images',false) on conflict do nothing;
create function pg_temp.life_id(n integer) returns uuid language sql immutable as $$
  select ('c7000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.life_actor(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',pg_temp.life_id(n)::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.life_id(n),'is_anonymous',false)::text,true);
end; $$;
create function pg_temp.life_reject(command text,expected text[]) returns void language plpgsql as $$
declare code text;begin
  begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
  assert code=any(expected),format('unexpected SQLSTATE %s',code);
end; $$;
insert into auth.users(id,email) select pg_temp.life_id(n),pg_temp.life_id(n)::text||'@naver.yumidang.invalid' from generate_series(1,3)n;
insert into public.profiles(id,real_name,birth_date,gender,bio)
  select pg_temp.life_id(n),'합성회원'||n,'1990-01-01','female','합성 소개' from generate_series(1,3)n;
insert into private.naver_accounts(subject,user_id,auth_email,real_name,birth_date,gender,verification_status)
  select 'member-lifecycle-sql-'||n,pg_temp.life_id(n),pg_temp.life_id(n)::text||'@naver.yumidang.invalid','합성회원'||n,'1990-01-01','female','qualified' from generate_series(1,3)n;
insert into storage.objects(id,bucket_id,name,owner_id)
  values(pg_temp.life_id(90),'profile-images',pg_temp.life_id(1)::text||'/'||pg_temp.life_id(90)::text||'.jpg',pg_temp.life_id(1)::text);
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
  values(pg_temp.life_id(10),pg_temp.life_id(1),'합성 보관 본문','합성 원문 보관 확인','산책',now()+interval '3 days',now()+interval '3 days 2 hours',now()+interval '2 days','서울특별시 강남구 역삼동');
insert into public.join_requests(id,post_id,requester_id,message,status)
  values(pg_temp.life_id(20),pg_temp.life_id(10),pg_temp.life_id(2),'합성 첫 대화','pending');
insert into public.appointments(id,post_id,join_request_id,status) values(pg_temp.life_id(30),pg_temp.life_id(10),pg_temp.life_id(20),'confirmed');
update public.join_requests set status='matched' where id=pg_temp.life_id(20);
-- 실제 생성 동의는 공개 key만 가진다. legacy 구조화 장소 key를 섞어 보관 allowlist도 검증한다.
insert into public.post_private_details(post_id,exact_location) values(pg_temp.life_id(10),'RETIRE_EXACT_DETAIL_SENTINEL');
insert into private.post_search_locations(post_id,registered_place_name,registered_address)
  values(pg_temp.life_id(10),'RETIRE_EXACT_PLACE_SENTINEL','RETIRE_EXACT_ADDRESS_SENTINEL');
do $$begin
  assert not private.match_conditions(pg_temp.life_id(10)) ?| array['registeredAddress','meetingDetail','address','detail','newLocation'];
end; $$;
insert into private.match_consents(request_id,condition_version,condition_fingerprint,conditions,requested_by,accepted_at)
  select pg_temp.life_id(20),'retention-fixture-version',private.match_condition_version(pg_temp.life_id(10)),
    private.match_conditions(pg_temp.life_id(10))||jsonb_build_object('registeredAddress','RETIRE_EXACT_ADDRESS_SENTINEL',
      'meetingDetail','RETIRE_EXACT_DETAIL_SENTINEL','address','RETIRE_EXACT_ADDRESS_SENTINEL','detail','RETIRE_EXACT_DETAIL_SENTINEL',
      'newLocation',jsonb_build_object('registeredAddress','RETIRE_EXACT_ADDRESS_SENTINEL')),
    pg_temp.life_id(1),now();
insert into private.appointment_schedule_changes(change_id,appointment_id,requested_by,old_starts_at,old_ends_at,old_updated_at,
  new_starts_at,new_ends_at,requested_at,expires_at,status,resolved_at,new_location_input,new_location_fingerprint,old_location_fingerprint,location_changed)
  select pg_temp.life_id(40),pg_temp.life_id(30),pg_temp.life_id(1),p.starts_at,p.ends_at,p.updated_at,p.starts_at+interval '1 day',p.ends_at+interval '1 day',
    now(),now()+interval '6 hours','awaiting_response',null,jsonb_build_object('publicArea',p.public_area,'registeredPlaceName','RETIRE_EXACT_PLACE_SENTINEL',
      'registeredAddress','RETIRE_EXACT_ADDRESS_SENTINEL','meetingDetail','RETIRE_EXACT_DETAIL_SENTINEL'),repeat('1',64),private.appointment_location_fingerprint(p.id),true
    from public.posts p where id=pg_temp.life_id(10);
insert into private.appointment_schedule_changes(change_id,appointment_id,requested_by,old_starts_at,old_ends_at,old_updated_at,
  new_starts_at,new_ends_at,requested_at,expires_at,status,resolved_at,new_location_input,new_location_fingerprint,old_location_fingerprint,location_changed)
  select pg_temp.life_id(41),pg_temp.life_id(30),pg_temp.life_id(1),p.starts_at,p.ends_at,p.updated_at,p.starts_at+interval '1 day',p.ends_at+interval '1 day',
    now()-interval '1 second',now()+interval '6 hours -1 second','accepted',now(),null,repeat('2',64),private.appointment_location_fingerprint(p.id),true
    from public.posts p where id=pg_temp.life_id(10);

set local role authenticated;
select pg_temp.life_actor(1);
select pg_temp.life_reject('select public.retire_my_account(pg_temp.life_id(99))',array['55000']);
reset role;
select pg_temp.life_pipeline_ready(true);
set local role authenticated;
select pg_temp.life_actor(1);
select pg_temp.life_reject('select public.retire_my_account(pg_temp.life_id(99))',array['40001']);
reset role;
update public.posts set starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour',recruitment_ends_at=now()-interval '3 hours' where id=pg_temp.life_id(10);
update public.appointments set status='completed',completed_at=now()-interval '30 minutes',completion_method='automatic',completion_notified_at=now()-interval '30 minutes',dispute_deadline_at=now()+interval '23 hours 30 minutes',review_deadline_at=now()+interval '6 days' where id=pg_temp.life_id(30);
set local role authenticated;
select pg_temp.life_actor(1);
select public.submit_appointment_review(pg_temp.life_id(30),4,'합성 유지 후기','neutral','{}');
do $$declare result jsonb;begin
  result:=public.retire_my_account(pg_temp.life_id(99));
  assert result->>'status'='processing';
  assert (result->>'memberAccessRevoked')::boolean;
  assert public.retire_my_account(pg_temp.life_id(99))=result;
  perform pg_temp.life_reject('select public.get_my_profile()',array['42501']);
  perform pg_temp.life_reject('select * from public.get_conversation(pg_temp.life_id(20))',array['42501']);
end; $$;
reset role;
select pg_temp.life_pipeline_ready(false);
do $$begin
  assert exists(select 1 from public.profiles where id=pg_temp.life_id(1) and real_name is null and birth_date is null and gender is null and avatar_url is null and bio is null);
  assert exists(select 1 from private.member_episodes where profile_id=pg_temp.life_id(1) and ended_at is not null and identity_id is not null);
  assert exists(select 1 from private.naver_accounts where subject='member-lifecycle-sql-1' and user_id is null and real_name is null and birth_date is null and gender is null);
  assert exists(select 1 from private.retired_post_bodies where post_id=pg_temp.life_id(10) and body->>'description'='합성 원문 보관 확인');
  assert exists(select 1 from public.posts where id=pg_temp.life_id(10) and description='개인정보 가림 검토 중' and status='closed');
  assert exists(select 1 from public.join_requests where id=pg_temp.life_id(20) and status='matched');
  assert not exists(select 1 from public.post_private_details where post_id=pg_temp.life_id(10));
  assert not exists(select 1 from private.post_search_locations where post_id=pg_temp.life_id(10));
  assert exists(select 1 from private.match_consents where request_id=pg_temp.life_id(20) and condition_version='retention-fixture-version' and condition_fingerprint is null
    and conditions::text not like '%RETIRE_EXACT_%' and not conditions ?| array['registeredAddress','meetingDetail','address','detail','newLocation']);
  assert exists(select 1 from private.retired_consent_bodies where request_id=pg_temp.life_id(20) and conditions::text not like '%RETIRE_EXACT_%'
    and conditions->>'title'='합성 보관 본문');
  assert not exists(select 1 from private.appointment_schedule_changes where appointment_id=pg_temp.life_id(30)
    and (new_location_input is not null or new_location_fingerprint is not null or old_location_fingerprint is not null));
  assert exists(select 1 from private.appointment_schedule_changes where change_id=pg_temp.life_id(40) and status='cancelled');
  assert exists(select 1 from private.appointment_schedule_changes where change_id=pg_temp.life_id(41) and status='accepted');

  assert (select count(*)=2 from private.member_cleanup_tasks where withdrawal_id=pg_temp.life_id(99));
  assert not has_function_privilege('authenticated','public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)','EXECUTE');
  assert not has_function_privilege('service_role','public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)','EXECUTE');
  assert not has_function_privilege('authenticated','public.check_member_cleanup_task(uuid,uuid,uuid,uuid)','EXECUTE');
  assert not has_function_privilege('service_role','public.check_member_cleanup_task(uuid,uuid,uuid,uuid)','EXECUTE');
  assert not has_function_privilege('authenticated','public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)','EXECUTE');
  assert not has_function_privilege('service_role','public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)','EXECUTE');
end; $$;
set local role authenticated;
select pg_temp.life_actor(2);
do $$declare x record;begin
  select * into x from public.get_conversation(pg_temp.life_id(20));
  assert x.counterpart_masked_name='탈퇴한 사용자입니다.' and x.counterpart_avatar_url is null and not x.can_send;
  assert not exists(select 1 from storage.objects where id=pg_temp.life_id(90));
  assert public.get_service_post(pg_temp.life_id(10))->>'description'='개인정보 가림 검토 중';
  assert public.get_appointment_change_state(pg_temp.life_id(30))::text not like '%RETIRE_EXACT_%';
  assert public.get_appointment_change_state(pg_temp.life_id(30))->'change'->'newLocation'='null'::jsonb;
  assert public.get_match_consent(pg_temp.life_id(20))::text not like '%RETIRE_EXACT_%';
  select * into x from public.get_appointment_review_state(pg_temp.life_id(30));
  assert x.can_write;
  perform public.submit_appointment_review(pg_temp.life_id(30),5,'합성 상대 남은 후기','positive','{}');
  perform pg_temp.life_reject('select public.get_public_profile(pg_temp.life_id(1))',array['P0002']);
end; $$;
reset role;
do $$begin
  assert exists(select 1 from public.appointment_reviews where reviewer_id=pg_temp.life_id(1) and comment='합성 유지 후기');
  assert exists(select 1 from public.appointment_reviews where reviewer_id=pg_temp.life_id(2) and comment='합성 상대 남은 후기');
end; $$;
-- 같은 Naver 안전 identity의 새 UID는 새 episode와 초기 당도를 가지며 과거 기록을 옮기지 않는다.
insert into auth.users(id,email) select pg_temp.life_id(4),auth_email from private.naver_accounts where subject='member-lifecycle-sql-1';
update private.naver_accounts set user_id=pg_temp.life_id(4),real_name='합성 재가입',birth_date='1990-01-01',gender='F',verification_status='qualified' where subject='member-lifecycle-sql-1';
insert into public.profiles(id,real_name,birth_date,gender) values(pg_temp.life_id(4),'합성 재가입','1990-01-01','female');
do $$begin
  assert private.member_safety_identity(pg_temp.life_id(1))=private.member_safety_identity(pg_temp.life_id(4));
  assert private.current_member_sweetness(pg_temp.life_id(4))=15;
  assert not exists(select 1 from public.appointments ap join public.join_requests j on j.id=ap.join_request_id where j.requester_id=pg_temp.life_id(4));
end; $$;
-- 직접 회원 table/Storage 쓰기 및 owner-only 삭제/완료 우회는 stale JWT로 불가능하다.
set local role authenticated;
select pg_temp.life_actor(1);
do $$begin
  assert not exists(select 1 from public.profiles);
  perform pg_temp.life_reject('select public.claim_member_cleanup_task(pg_temp.life_id(80))',array['42501']);
  update public.profiles set bio='우회 소개' where id=pg_temp.life_id(1);
  assert not found;
end; $$;
reset role;
select pg_temp.life_reject('select public.claim_member_cleanup_task(pg_temp.life_id(80))',array['55000']);
select pg_temp.life_reject('select public.check_member_cleanup_task(pg_temp.life_id(80),pg_temp.life_id(81),pg_temp.life_id(82),pg_temp.life_id(90))',array['55000']);
select pg_temp.life_reject('select public.record_member_cleanup_delete_ack(pg_temp.life_id(80),pg_temp.life_id(81),pg_temp.life_id(82),pg_temp.life_id(90),repeat(''a'',64))',array['55000']);
select pg_temp.life_reject('select public.get_member_cleanup_delete_ack(pg_temp.life_id(80),pg_temp.life_id(81),pg_temp.life_id(82),pg_temp.life_id(90))',array['55000']);
select pg_temp.life_reject('select public.complete_member_cleanup_task(pg_temp.life_id(80),pg_temp.life_id(81),pg_temp.life_id(82),pg_temp.life_id(90),repeat(''a'',64))',array['55000']);
-- 승인 true는 rollback 합성 fixture에만 한정한다. 외부 삭제를 실행하지 않는다.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update private.member_cleanup_guard set external_deletion_approved=true;
do $$declare g uuid;t jsonb;a jsonb;before_row jsonb;next_t jsonb;global_expiry timestamptz;obj uuid;receipt jsonb;begin
  g:=(public.acquire_worker_run(180,null)->>'token')::uuid;
  a:=public.claim_member_cleanup_task(g);
  if a->>'kind'='storage_object' then t:=a;else
    assert public.check_member_cleanup_task((a->>'taskId')::uuid,(a->>'leaseToken')::uuid,g,null)=a;
    t:=public.claim_member_cleanup_task(g);
  end if;
  obj:=(t->>'objectId')::uuid;
  select to_jsonb(x) into before_row from private.member_cleanup_tasks x where x.id=(t->>'taskId')::uuid;
  assert public.check_member_cleanup_task((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,obj)=t;
  assert before_row=(select to_jsonb(x) from private.member_cleanup_tasks x where x.id=(t->>'taskId')::uuid);
  assert public.get_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,obj) is null;
  perform pg_temp.life_reject(format('select public.complete_member_cleanup_task(%L,%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,obj,repeat('a',64)),array['40001']);
  perform pg_temp.life_reject(format('select public.record_member_cleanup_delete_ack(%L,%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,obj,'forged-format'),array['22023']);
  perform pg_temp.life_reject(format('select public.record_member_cleanup_delete_ack(%L,%L,%L,%L,%L)',pg_temp.life_id(80),t->>'leaseToken',g,obj,repeat('a',64)),array['40001']);
  perform pg_temp.life_reject(format('select public.record_member_cleanup_delete_ack(%L,%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,pg_temp.life_id(91),repeat('a',64)),array['40001']);
  receipt:=public.record_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,obj,repeat('a',64));
  assert (select count(*) from jsonb_object_keys(receipt))=5;
  assert receipt=public.get_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,obj);
  assert receipt=public.record_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,obj,repeat('b',64));
  update private.member_cleanup_delete_acks set profile_id=pg_temp.life_id(2) where task_id=(t->>'taskId')::uuid;
  perform pg_temp.life_reject(format('select public.get_member_cleanup_delete_ack(%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,obj),array['40001']);
  update private.member_cleanup_delete_acks set profile_id=pg_temp.life_id(1) where task_id=(t->>'taskId')::uuid;

  perform pg_temp.life_reject(format('select public.check_member_cleanup_task(%L,%L,%L,%L)',pg_temp.life_id(80),t->>'leaseToken',g,obj),array['40001']);
  perform pg_temp.life_reject(format('select public.check_member_cleanup_task(%L,%L,%L,%L)',t->>'taskId',pg_temp.life_id(81),g,obj),array['40001']);
  perform pg_temp.life_reject(format('select public.check_member_cleanup_task(%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',pg_temp.life_id(82),obj),array['40001']);
  perform pg_temp.life_reject(format('select public.check_member_cleanup_task(%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,pg_temp.life_id(91)),array['40001']);
  update private.member_cleanup_tasks set profile_id=pg_temp.life_id(2) where id=(t->>'taskId')::uuid;
  perform pg_temp.life_reject(format('select public.check_member_cleanup_task(%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,obj),array['40001']);
  update private.member_cleanup_tasks set profile_id=pg_temp.life_id(1),lease_expires_at=clock_timestamp()-interval '1 second' where id=(t->>'taskId')::uuid;
  perform pg_temp.life_reject(format('select public.check_member_cleanup_task(%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,obj),array['40001']);
  perform pg_temp.life_reject(format('select public.record_member_cleanup_delete_ack(%L,%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,obj,repeat('c',64)),array['40001']);
  next_t:=public.claim_member_cleanup_task(g);
  assert next_t->>'taskId'=t->>'taskId' and next_t->>'leaseToken'<>t->>'leaseToken';
  perform pg_temp.life_reject(format('select public.check_member_cleanup_task(%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,obj),array['40001']);
  t:=next_t;
  assert receipt=public.get_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,obj);
  -- metadata 삭제는 물리 파일 삭제 증명이 아니다. 동일 name 재생성은 별도 차단한다.
  perform set_config('storage.allow_delete_query','true',true);
  delete from storage.objects where id=obj;
  insert into storage.objects(id,bucket_id,name,owner_id) values(pg_temp.life_id(91),'profile-images',t->>'objectName',pg_temp.life_id(1)::text);
  perform pg_temp.life_reject(format('select public.check_member_cleanup_task(%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,obj),array['40001']);
  delete from storage.objects where id=pg_temp.life_id(91);
  assert public.check_member_cleanup_task((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,obj)=t;
  select expires_at into global_expiry from private.global_worker_run where singleton;
  update private.global_worker_run set expires_at=clock_timestamp()-interval '1 second' where singleton;
  perform pg_temp.life_reject(format('select public.check_member_cleanup_task(%L,%L,%L,%L)',t->>'taskId',t->>'leaseToken',g,obj),array['40001']);
  update private.global_worker_run set expires_at=global_expiry where singleton;
  perform public.release_worker_run(g);
  update private.member_cleanup_tasks set lease_expires_at=clock_timestamp()-interval '1 second' where id=(t->>'taskId')::uuid;
  g:=(public.acquire_worker_run(180,null)->>'token')::uuid;
  t:=public.claim_member_cleanup_task(g);
  assert receipt=public.get_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,obj);
  assert receipt=public.record_member_cleanup_delete_ack((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,obj,repeat('d',64));
  assert public.complete_member_cleanup_task((t->>'taskId')::uuid,(t->>'leaseToken')::uuid,g,obj,repeat('e',64))->>'status'='applied';
  assert exists(select 1 from private.member_cleanup_tasks where id=(t->>'taskId')::uuid and state='completed' and evidence_sha256=repeat('e',64));
  perform public.release_worker_run(g);
end; $$;
update private.member_cleanup_guard set external_deletion_approved=false;

-- 분쟁만 남은 회원은 탈퇴할 수 있고 약속 상태를 자동 취소하지 않는다.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
  values(pg_temp.life_id(11),pg_temp.life_id(3),'합성 분쟁 보관','합성 분쟁 자료','산책',now()-interval '2 hours',now()-interval '1 hour',now()-interval '3 hours','서울특별시 강남구 역삼동');
insert into public.join_requests(id,post_id,requester_id,message,status) values(pg_temp.life_id(21),pg_temp.life_id(11),pg_temp.life_id(2),'합성 분쟁 대화','matched');
insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
  values(pg_temp.life_id(31),pg_temp.life_id(11),pg_temp.life_id(21),'disputed',now()-interval '30 minutes','automatic',now()-interval '30 minutes',now()+interval '23 hours 30 minutes',now()+interval '6 days');
insert into private.appointment_schedule_changes(change_id,appointment_id,requested_by,old_starts_at,old_ends_at,old_updated_at,
  new_starts_at,new_ends_at,requested_at,expires_at,new_location_input,new_location_fingerprint,old_location_fingerprint,location_changed)
  select pg_temp.life_id(42),pg_temp.life_id(31),pg_temp.life_id(3),now()+interval '1 day',now()+interval '1 day 2 hours',p.updated_at,
    now()+interval '2 days',now()+interval '2 days 2 hours',now(),now()+interval '6 hours',
    jsonb_build_object('registeredAddress','DISPUTED_EXACT_ADDRESS_SENTINEL','meetingDetail','DISPUTED_EXACT_DETAIL_SENTINEL'),
    repeat('3',64),repeat('4',64),true from public.posts p where id=pg_temp.life_id(11);
-- 이전 worker 회귀가 guardfalse로 돌아갔으므로 새 최초 탈퇴만 명시적으로 재준비한다.
select pg_temp.life_pipeline_ready(true);
set local role authenticated;
select pg_temp.life_actor(3);
select public.retire_my_account(pg_temp.life_id(98));
reset role;
select pg_temp.life_pipeline_ready(false);
do $$begin
  assert exists(select 1 from public.appointments where id=pg_temp.life_id(31) and status='disputed');
  assert exists(select 1 from private.member_retirements where profile_id=pg_temp.life_id(3));
  assert exists(select 1 from private.appointment_schedule_changes where change_id=pg_temp.life_id(42) and status='cancelled' and new_location_input is null and old_location_fingerprint is null and new_location_fingerprint is null);
end; $$;
-- Auth 삭제는 역사 party·공고·신청을 연쇄 삭제하지 않는다.
delete from auth.users where id=pg_temp.life_id(1);
do $$begin
  assert exists(select 1 from public.profiles where id=pg_temp.life_id(1));
  assert exists(select 1 from public.posts where id=pg_temp.life_id(10));
  assert exists(select 1 from public.join_requests where id=pg_temp.life_id(20));
end; $$;
select 'member_lifecycle initial synthetic regression';
rollback;
