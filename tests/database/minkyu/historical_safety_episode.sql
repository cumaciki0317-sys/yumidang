-- 실제 가입/탈퇴 회차를 원고정identity와 검증한다. 전체 rollback fixture.
create temp table historical_refs(identity_id uuid,episode_id uuid);insert into historical_refs select identity_id,id from private.member_episodes where profile_id=pg_temp.safety_uid(1)and ended_at is null;
-- 원래 pipeline 권한은 닫혀 있다. 합성 트랜잭션에서만 준비 권한을 부여하며 rollback으로 원상복원한다.
grant execute on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)to service_role;
update private.member_cleanup_guard set external_deletion_approved=true;
set local role authenticated;select pg_temp.safety_actor(1);select public.retire_my_account(gen_random_uuid());reset role;
do $$declare identity uuid;episode uuid;incident uuid:=gen_random_uuid();rev bigint;begin
 select identity_id,episode_id into identity,episode from historical_refs;
 assert private.require_historical_safety_episode(identity,episode)=pg_temp.safety_uid(1);
 perform pg_temp.safety_failure(format('select private.require_verified_safety_episode(%L,%L)',identity,episode),'55000');
 perform pg_temp.safety_failure(format('select private.require_historical_safety_episode(%L,%L)',gen_random_uuid(),episode),'42501');
 rev:=private.record_incident_revision(incident,gen_random_uuid(),0,'confirmed','threat',pg_temp.safety_uid(2),jsonb_build_array(jsonb_build_object('identityId',identity,'sourceEpisodeId',episode,'confirmedKinds',jsonb_build_array('major_violation'),'violationClass','major','violationType','threat','victimIdentityId',null,'cancellationAction',null)));
 assert rev=1;assert(select count(*)=1 from private.safety_sanction_applications where incident_id=incident and kind='permanent'and source_episode_id=episode and revoked_at is null);
 assert not exists(select 1 from private.sweetness_incident_decisions where incident_id=incident);
 assert not has_function_privilege('authenticated','private.require_historical_safety_episode(uuid,uuid)','EXECUTE');
end;$$;
-- 동일 네이버 identity의 새 가입은 새 회차 당도 15를 유지한다.
set local role service_role;
select public.resolve_naver_account('review-start-sql-1','합성 재가입','F','1990-01-01');
reset role;
insert into auth.users(id,email)select pg_temp.safety_uid(5),auth_email from private.naver_accounts where subject='review-start-sql-1';
insert into auth.sessions(id,user_id)values(pg_temp.safety_session(5),pg_temp.safety_uid(5));
select set_config('request.jwt.claim.sub','',true),set_config('request.jwt.claims','{}',true);
insert into storage.objects(bucket_id,name,owner_id,metadata)values('profile-images',pg_temp.safety_uid(5)::text||'/fe930000-0000-4000-8000-000000000005.jpg',pg_temp.safety_uid(5)::text,'{"mimetype":"image/jpeg","size":128}');
set local role service_role;
select public.record_naver_session('review-start-sql-1',pg_temp.safety_uid(5),pg_temp.safety_session(5));
reset role;
set local role authenticated;select pg_temp.safety_actor(5);
do $$begin
 assert public.complete_naver_signup(pg_temp.safety_uid(5)::text||'/fe930000-0000-4000-8000-000000000005.jpg','{}','{}',null)->>'status'='ready';
 assert public.get_my_safety_state()->>'permanent'='true';
end;$$;
reset role;
do $$declare e uuid;begin
 select id into strict e from private.member_episodes where profile_id=pg_temp.safety_uid(5)and ended_at is null;
 assert(select identity_id from private.member_episodes where id=e)=(select identity_id from historical_refs);
 assert private.current_member_sweetness(pg_temp.safety_uid(5))=15;
 assert not exists(select 1 from private.sweetness_incident_decisions where recipient_episode_id=e);
end;$$;
set local role authenticated;select pg_temp.safety_actor(5);
select pg_temp.safety_failure($q$select public.create_service_post(gen_random_uuid(),jsonb_build_object('title','합성 제한 승계','description','재가입 제한 검증','category','산책','startsAt',clock_timestamp()+interval'3 days','endsAt',clock_timestamp()+interval'3 days 2 hours','recruitmentEndsAt',clock_timestamp()+interval'2 days','publicArea','서울특별시 강남구 역삼동','registeredPlaceName','합성 장소','registeredAddress','서울특별시 강남구 합성주소','meetingDetail','합성 입구','preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0))$q$,'42501');
reset role;
