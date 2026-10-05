-- 민규: source64+40800 후보의 실제 회원 RPC/자동 결과원장 회귀. 실제 SQL 실행 NOT_RUN.
-- 본인 업로드 blob·HTTP·운영 판정·실제 두 세션 경합 증거가 아니다. 전체 owner TX rollback.
-- 완료 시각 fixture는 owner가 과거 일정으로 조정하며 실제 DB 시계·서버 수신 시각은 변경하지 않는다.
begin;
create temp table safety_sync_baseline as select
 (select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles)roles,
 (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)memberships,
 (select external_deletion_approved from private.member_cleanup_guard where singleton)guard,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.safety_sync_uid(n integer) returns uuid language sql immutable as $$
 select ('fb810000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.safety_sync_session(n integer) returns uuid language sql immutable as $$
 select ('fb820000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.safety_sync_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.safety_sync_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_sync_uid(n),'session_id',pg_temp.safety_sync_session(n))::text,true);
end;$$;
create function pg_temp.safety_sync_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
end;$$;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.resolve_naver_account('change-safety_sync-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email) select pg_temp.safety_sync_uid(i),a.auth_email from generate_series(1,4)i
 join private.naver_accounts a on a.subject='change-safety_sync-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.safety_sync_session(i),pg_temp.safety_sync_uid(i) from generate_series(1,4)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.safety_sync_uid(i)::text||'/fb830000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.safety_sync_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,4)i;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.record_naver_session('change-safety_sync-sql-'||i,pg_temp.safety_sync_uid(i),pg_temp.safety_sync_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..4 loop
 perform pg_temp.safety_sync_actor(i);
 assert public.complete_naver_signup(pg_temp.safety_sync_uid(i)::text||'/fb830000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
end loop;end;$$;
reset role;

-- PRE_MIGRATION_BEGIN
-- 실행 조립: BEGIN+위 setup+이 구역 → 40800의 외곽 BEGIN/COMMIT 제거 본문 → POST_MIGRATION_BEGIN 이후.
-- 이미 40800 적용된 DB에서 이 파일을 그대로 실행하는 방식은 이관 증거가 아니다.
create temp table safety_sync_legacy(n integer primary key,p uuid,ap uuid);
grant all on safety_sync_legacy to authenticated;
set local role authenticated;
do $$declare i integer;a_member integer;b_member integer;p_id uuid;r_id uuid;ap_id uuid;c jsonb;input jsonb;begin
 for i in 100..103 loop
 a_member:=case when i=100 then 1 else 3 end;b_member:=case when i=100 then 2 else 4 end;
 p_id:=gen_random_uuid();
 input:=jsonb_build_object('title','합성 과거 원장 이관','description','로컬 과거 합성 자료','category','산책',
 'startsAt',clock_timestamp()+make_interval(days=>i*3),'endsAt',clock_timestamp()+make_interval(days=>i*3,hours=>2),
 'recruitmentEndsAt',clock_timestamp()+make_interval(days=>i*3,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','가상 과거 장소','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 과거 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
 perform pg_temp.safety_sync_actor(a_member);perform public.create_service_post(p_id,input);
 perform pg_temp.safety_sync_actor(b_member);r_id:=(public.request_service_post(p_id,gen_random_uuid(),'합성 과거 신청')->>'id')::uuid;
 perform pg_temp.safety_sync_actor(a_member);c:=public.propose_match(r_id);
 perform pg_temp.safety_sync_actor(b_member);ap_id:=(public.accept_match(r_id,c->>'conditionVersion')->>'appointmentId')::uuid;
 insert into safety_sync_legacy values(i,p_id,ap_id);
 end loop;
end;$$;
reset role;
-- 과거 운영 기록은 origin 컬럼 추가 전부터 존재한다. 새 컬럼이 주체를 추정하면 안 된다.
insert into private.safety_appointment_results(identity_id,appointment_id,source_episode_id,
 agreed_starts_at,confirmed_at,ordering_provenance,current_revision)
 select e.identity_id,a.id,e.id,p.starts_at,a.confirmed_at,'agreed_snapshot',1
 from safety_sync_legacy l join public.appointments a on a.id=l.ap join public.posts p on p.id=l.p
 join private.member_episodes e on e.profile_id=pg_temp.safety_sync_uid(3)and e.ended_at is null where l.n=101;
insert into private.safety_appointment_result_revisions(identity_id,appointment_id,revision,decision_id,
 outcome,cancellation_at,appeal_state,reason_code)
 select identity_id,appointment_id,1,gen_random_uuid(),'exempt',null,'none','legacy_record_kept'
 from private.safety_appointment_results where appointment_id=(select ap from safety_sync_legacy where n=101);
-- owner가 과거의 누락 metadata만 구성한다. 동일인/새 회차를 추측하여 채우지 않는다.
delete from private.appointment_member_episodes where appointment_id=(select ap from safety_sync_legacy where n=102);
update private.member_episodes set identity_id=null where profile_id=pg_temp.safety_sync_uid(4)and ended_at is null;
create temp table safety_sync_old_preserved as select to_jsonb(h)head,to_jsonb(r)revision
 from private.safety_appointment_results h join private.safety_appointment_result_revisions r
 on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 where h.appointment_id=(select ap from safety_sync_legacy where n=101);
-- PRE_MIGRATION_END
-- POST_MIGRATION_BEGIN
-- root가 이 두 마커 사이에 제품 40800 본문을 삽입한 단일 TX만 이관+본 회귀를 증명한다.
do $$declare audit private.appointment_safety_sync_audit;begin
 select *into audit from private.appointment_safety_sync_audit where migration_version='20261005040800';
 assert audit.legacy_appointments=4 and audit.missing_episode_maps=1
 and audit.missing_identity_members=2 and audit.seeded_unknown_results=3,'exact nonempty legacy migration audit';
 assert(select count(*)=3 and bool_and(ordering_provenance='unknown' and agreed_starts_at is null and current_revision=1)
 from private.safety_appointment_results where appointment_id in(select ap from safety_sync_legacy where n in(100,103))),'known mapped legacy order unknown seeded';
 assert not exists(select 1 from private.safety_appointment_results where appointment_id=(select ap from safety_sync_legacy where n=102)),'missing map not guessed';
 assert(select to_jsonb(h)=old.head and(to_jsonb(r)-'origin')=old.revision and r.origin='legacy_unknown'
 from private.safety_appointment_results h join private.safety_appointment_result_revisions r
 on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 cross join safety_sync_old_preserved old where h.appointment_id=(select ap from safety_sync_legacy where n=101)),'preexisting record bytes preserved except explicit unknown metadata';
end;$$;
-- 별도 합성 연결 정정 뒤에도 이관된 unknown은 자동 갱신되지 않고 owner 검증 대상으로 남는다.
update private.member_episodes e set identity_id=k.id from private.naver_accounts a
 join private.naver_identity_keys k on k.subject=a.subject where a.user_id=pg_temp.safety_sync_uid(4)
 and e.profile_id=a.user_id and e.ended_at is null;
-- 이후 실제 새 흐름 검증에서 이전 unknown이 순서를 가리지 않도록, 이관 구역 합성 원장만 명시 정리한다.
-- 삭제 순서는 revision → result이며 과거 약속은 원래 상태 그대로 유지하고 마지막 전체 TX rollback한다.
delete from private.safety_appointment_result_revisions where appointment_id in(select ap from safety_sync_legacy);
delete from private.safety_appointment_results where appointment_id in(select ap from safety_sync_legacy);

-- 실제 새 확정의 결함 주입: 양쪽 identity 또는 확정 뒤 고정 맵 누락은 성공하지 않는다.
create temp table safety_sync_fault(p uuid,r uuid,version text,snapshot jsonb);
grant all on safety_sync_fault to authenticated;
create function pg_temp.safety_sync_fault_snapshot(p_id uuid)returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('post',(select to_jsonb(p)from public.posts p where id=p_id),
 'requests',(select jsonb_agg(to_jsonb(r)order by id)from public.join_requests r where post_id=p_id),
 'consents',(select jsonb_agg(to_jsonb(c)order by c.request_id)from private.match_consents c join public.join_requests r on r.id=c.request_id where r.post_id=p_id),
 'lifecycle',(select jsonb_agg(to_jsonb(l)order by l.request_id)from private.match_consent_lifecycle l where l.post_id=p_id),
 'appointments',(select jsonb_agg(to_jsonb(a)order by id)from public.appointments a where post_id=p_id),
 'reservations',(select jsonb_agg(to_jsonb(c)order by c.appointment_id)from private.completion_reservations c join public.appointments a on a.id=c.appointment_id where a.post_id=p_id),
 'notifications',(select jsonb_agg(to_jsonb(n)order by n.id)from public.notifications n join public.join_requests r on r.id=n.join_request_id where r.post_id=p_id),
 'results',(select jsonb_agg(to_jsonb(h)order by h.identity_id,h.appointment_id)from private.safety_appointment_results h join public.appointments a on a.id=h.appointment_id where a.post_id=p_id));$$;
create function pg_temp.safety_sync_expect_identity_failure(r_id uuid,version text,expected_code text default '40001',expected_message text default 'verified_appointment_identity_required')returns void language plpgsql as $$
declare code text;message text;begin
 begin perform public.accept_match(r_id,version);exception when others then get stacked diagnostics code=returned_sqlstate,message=message_text;end;
 assert code=expected_code and message=expected_message,format('identity rejection expected %s/%s; actual %s/%s',expected_code,expected_message,coalesce(code,'<no exception>'),coalesce(message,'<no exception>'));
end;$$;
set local role authenticated;
do $$declare p_id uuid:=gen_random_uuid();r_id uuid;c jsonb;input jsonb;begin
 input:=jsonb_build_object('title','합성 누락 확정 실패','description','로컬 결함 주입','category','산책',
 'startsAt',clock_timestamp()+interval'90 days','endsAt',clock_timestamp()+interval'90 days 2 hours',
 'recruitmentEndsAt',clock_timestamp()+interval'89 days','publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','가상 결함 장소','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
 perform pg_temp.safety_sync_actor(1);perform public.create_service_post(p_id,input);
 perform pg_temp.safety_sync_actor(2);r_id:=(public.request_service_post(p_id,gen_random_uuid(),'합성 실패 신청')->>'id')::uuid;
 perform pg_temp.safety_sync_actor(1);c:=public.propose_match(r_id);
 insert into safety_sync_fault values(p_id,r_id,c->>'conditionVersion',pg_temp.safety_sync_fault_snapshot(p_id));
end;$$;
reset role;
update private.member_episodes set identity_id=null where profile_id=pg_temp.safety_sync_uid(2)and ended_at is null;
set local role authenticated;
do $$begin perform pg_temp.safety_sync_actor(2);
 perform pg_temp.safety_sync_expect_identity_failure((select r from safety_sync_fault),(select version from safety_sync_fault),'42501','verified_member_identity_required');
 assert pg_temp.safety_sync_fault_snapshot((select p from safety_sync_fault))=(select snapshot from safety_sync_fault),'identity failure rolls back all match mutations';
end;$$;
reset role;
update private.member_episodes e set identity_id=k.id from private.naver_accounts n
 join private.naver_identity_keys k on k.subject=n.subject where n.user_id=pg_temp.safety_sync_uid(2)
 and e.profile_id=n.user_id and e.ended_at is null;
-- 위 실패는 기존 21811 신규 활동 가드의 올바른 거절이다. 원래 가드는 우회하지 않는다.
-- 새 원장 검증을 별도로 시험하려면 기존 가드 통과 후 sweetness 맵 등록 뒤에만 identity 결함을 주입한다.
create function pg_temp.safety_sync_missing_identity()returns trigger language plpgsql security definer set search_path='' as $$begin
 update private.member_episodes e set identity_id=null from public.join_requests r
 where r.id=new.join_request_id and e.profile_id=r.requester_id and e.ended_at is null;
 return new;end;$$;
create trigger y_safety_test_missing_identity after insert on public.appointments for each row execute function pg_temp.safety_sync_missing_identity();
set local role authenticated;
do $$begin perform pg_temp.safety_sync_actor(2);
 perform pg_temp.safety_sync_expect_identity_failure((select r from safety_sync_fault),(select version from safety_sync_fault));
 assert pg_temp.safety_sync_fault_snapshot((select p from safety_sync_fault))=(select snapshot from safety_sync_fault),'late identity corruption rolls back appointment consent reservation notifications';
end;$$;
reset role;
drop trigger y_safety_test_missing_identity on public.appointments;
do $$begin
 assert(select e.identity_id=k.id from private.member_episodes e join private.naver_accounts n on n.user_id=e.profile_id
 join private.naver_identity_keys k on k.subject=n.subject where e.profile_id=pg_temp.safety_sync_uid(2)and e.ended_at is null),'late identity fixture rolled back';
end;$$;
-- 기존 sweetness 뒤, 새 sync 앞에서 고정 맵을 지우는 owner TX 내부 결함 fixture다.
create function pg_temp.safety_sync_missing_map()returns trigger language plpgsql security definer set search_path='' as $$begin
 delete from private.appointment_member_episodes where appointment_id=new.id;return new;end;$$;
create trigger y_safety_test_missing_map after insert on public.appointments for each row execute function pg_temp.safety_sync_missing_map();
set local role authenticated;
do $$begin perform pg_temp.safety_sync_actor(2);
 perform pg_temp.safety_sync_expect_identity_failure((select r from safety_sync_fault),(select version from safety_sync_fault));
 assert pg_temp.safety_sync_fault_snapshot((select p from safety_sync_fault))=(select snapshot from safety_sync_fault),'missing map rolls back appointment consent reservation notifications';
end;$$;
reset role;
drop trigger y_safety_test_missing_map on public.appointments;
-- 정상 수락 자체를 실행한 뒤 명시적 합성 예외로 되돌려 모든 부수 효과의 원자 rollback을 확인한다.
set local role authenticated;
do $$declare result jsonb;begin perform pg_temp.safety_sync_actor(2);
 begin
  result:=public.accept_match((select r from safety_sync_fault),(select version from safety_sync_fault));
  assert jsonb_array_length(pg_temp.safety_sync_fault_snapshot((select p from safety_sync_fault))->'results')=2,'successful accept registers two heads before rollback';
  raise exception 'synthetic_accept_rollback'using errcode='PZ001';
 exception when sqlstate 'PZ001'then null;end;
 assert pg_temp.safety_sync_fault_snapshot((select p from safety_sync_fault))=(select snapshot from safety_sync_fault),'successful accept subtransaction rollback all match effects';
end;$$;
reset role;
\echo PASS missing identity/map exact40001 and all match side effects rolled back

create temp table safety_sync_cases(n integer primary key,p uuid,ap uuid,snapshot jsonb);
grant all on safety_sync_cases to authenticated;
create function pg_temp.safety_sync_snapshot(a_id uuid)returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('heads',coalesce((select jsonb_agg(to_jsonb(h)order by h.identity_id)
  from private.safety_appointment_results h where appointment_id=a_id),'[]'::jsonb),
  'revisions',coalesce((select jsonb_agg(to_jsonb(r)order by r.identity_id,r.revision)
  from private.safety_appointment_result_revisions r where appointment_id=a_id),'[]'::jsonb));$$;
set local role authenticated;
do $$declare i integer;p_id uuid;r_id uuid;a_id uuid;c jsonb;input jsonb;begin
 for i in 1..8 loop
 p_id:=gen_random_uuid();
 input:=jsonb_build_object('title','합성 연속취소 원장','description','로컬 합성 자료','category','산책',
 'startsAt',clock_timestamp()+make_interval(days=>i*3),'endsAt',clock_timestamp()+make_interval(days=>i*3,hours=>2),
 'recruitmentEndsAt',clock_timestamp()+make_interval(days=>i*3,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','가상 장소','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 원래 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
 perform pg_temp.safety_sync_actor(1);perform public.create_service_post(p_id,input);
 perform pg_temp.safety_sync_actor(2);r_id:=(public.request_service_post(p_id,gen_random_uuid(),'합성 신청')->>'id')::uuid;
 perform pg_temp.safety_sync_actor(1);c:=public.propose_match(r_id);
 perform pg_temp.safety_sync_actor(2);a_id:=(public.accept_match(r_id,c->>'conditionVersion')->>'appointmentId')::uuid;
 insert into safety_sync_cases values(i,p_id,a_id,pg_temp.safety_sync_snapshot(a_id));
 -- 같은 수락 재시도는 약속/원장의 추가 revision을 만들지 않는다.
 assert(public.accept_match(r_id,c->>'conditionVersion')->>'appointmentId')::uuid=a_id,'match retry appointment';
 assert pg_temp.safety_sync_snapshot(a_id)=(select snapshot from safety_sync_cases where n=i),'match retry ledger unchanged';
 end loop;
end;$$;
reset role;
do $$declare c safety_sync_cases;begin
 for c in select *from safety_sync_cases loop
  assert(select count(*)=2 from private.safety_appointment_results where appointment_id=c.ap),'two immutable episode identities';
  assert(select bool_and(h.current_revision=1 and h.ordering_provenance='agreed_snapshot'
   and h.agreed_starts_at=p.starts_at and h.confirmed_at=a.confirmed_at
   and h.source_episode_id in(m.author_episode_id,m.requester_episode_id) and e.identity_id=h.identity_id)
   from private.safety_appointment_results h join public.posts p on p.id=c.p
   join public.appointments a on a.id=c.ap join private.appointment_member_episodes m on m.appointment_id=a.id
   join private.member_episodes e on e.id=h.source_episode_id where h.appointment_id=c.ap),'fixed episode/order provenance';
  assert(select count(*)=2 and bool_and(origin='appointment' and outcome='pending' and cancellation_at is null and appeal_state='none')
   from private.safety_appointment_result_revisions where appointment_id=c.ap),'new pending revision one';
 end loop;
end;$$;
\echo PASS actual confirm and immutable two-member episode mapping

-- 보류·거절·철회는 합의 원장을 변경하지 않으며 실제 수락만 최신 시작을 반영한다.
set local role authenticated;
do $$declare c safety_sync_cases;proposal jsonb;state jsonb;cid uuid;target timestamptz;finish timestamptz;begin
 select *into c from safety_sync_cases where n=6;perform pg_temp.safety_sync_actor(1);
 state:=public.get_appointment_change_state(c.ap);
 target:=(state->>'startsAt')::timestamptz+interval'1 hour';finish:=(state->>'endsAt')::timestamptz+interval'1 hour';
 cid:=gen_random_uuid();proposal:=public.propose_appointment_schedule_change(c.ap,cid,target,finish,(state->>'updatedAt')::timestamptz);
 assert pg_temp.safety_sync_snapshot(c.ap)=c.snapshot,'proposal preserves ledger';
 perform pg_temp.safety_sync_actor(2);perform public.decline_appointment_schedule_change(c.ap,cid,proposal->>'conditionVersion');
 assert pg_temp.safety_sync_snapshot(c.ap)=c.snapshot,'decline preserves ledger';
 perform pg_temp.safety_sync_actor(1);state:=public.get_appointment_change_state(c.ap);cid:=gen_random_uuid();
 proposal:=public.propose_appointment_schedule_change(c.ap,cid,target,finish,(state->>'updatedAt')::timestamptz);
 perform public.withdraw_appointment_schedule_change(c.ap,cid,proposal->>'conditionVersion');
 assert pg_temp.safety_sync_snapshot(c.ap)=c.snapshot,'withdrawal preserves ledger';
 state:=public.get_appointment_change_state(c.ap);cid:=gen_random_uuid();
 proposal:=public.propose_appointment_schedule_change(c.ap,cid,target,finish,(state->>'updatedAt')::timestamptz);
 perform pg_temp.safety_sync_actor(2);perform public.accept_appointment_schedule_change(c.ap,cid,proposal->>'conditionVersion');
 -- 실제 수락 RPC 이후 원장의 최신 순서와 결과 revision 보존을 검증한다.
end;$$;
reset role;
do $$declare c safety_sync_cases;begin
 select *into c from safety_sync_cases where n=6;
 assert(select bool_and(agreed_starts_at=p.starts_at and current_revision=1)
  from private.safety_appointment_results h join public.posts p on p.id=c.p where h.appointment_id=c.ap),'accepted latest start without result revision';
end;$$;
\echo PASS accepted schedule only; decline and withdrawal preserve ledger

set local role authenticated;
do $$declare c safety_sync_cases;cid uuid:=gen_random_uuid();snapshot jsonb;begin
 select *into c from safety_sync_cases where n=1;perform pg_temp.safety_sync_actor(1);
 perform public.cancel_appointment(c.ap,cid,'합성 취소 사유는 원장에 복제하지 않는다');
 snapshot:=pg_temp.safety_sync_snapshot(c.ap);
 assert public.cancel_appointment(c.ap,cid,'합성 취소 사유는 원장에 복제하지 않는다')->>'deduplicated'='true','cancel retry deduplicated';
 assert pg_temp.safety_sync_snapshot(c.ap)=snapshot,'cancel retry stable decision ID and revision';
end;$$;
reset role;
do $$declare c safety_sync_cases;identity_key uuid;plan jsonb;begin
 select *into c from safety_sync_cases where n=1;
 assert(select count(*)=2 and bool_and(h.current_revision=2 and r.origin='appointment')
 from private.safety_appointment_results h join private.safety_appointment_result_revisions r
 on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision where h.appointment_id=c.ap),'cancel revision pointer atomic';
 assert(select r.outcome='own_cancel' and r.cancellation_at=l.cancelled_at and r.reason_code='appointment_state_sync'
 from private.safety_appointment_results h join private.safety_appointment_result_revisions r
 on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 join private.member_episodes e on e.id=h.source_episode_id
 join private.appointment_cancellations l on l.appointment_id=h.appointment_id
 where h.appointment_id=c.ap and e.profile_id=pg_temp.safety_sync_uid(1)),'own cancellation trusted stored timestamp';
 assert(select r.outcome='peer_cancel' and r.cancellation_at is null from private.safety_appointment_results h
 join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 join private.member_episodes e on e.id=h.source_episode_id where h.appointment_id=c.ap and e.profile_id=pg_temp.safety_sync_uid(2)),'peer cancellation no own timestamp';
 select identity_id into identity_key from private.member_episodes where profile_id=pg_temp.safety_sync_uid(1)and ended_at is null;
 plan:=private.cancellation_sanction_plan(identity_key);
 assert plan->>'status'='held' and(plan->>'heldAppointmentId')::uuid=c.ap,'24h cancellation waiting linked to actual result';
 assert jsonb_array_length(plan->'actions')=0,'no early sanction actions';
 -- 실제 만료 경계 증거는 아니다. 합성 결과 시각만 48시간 과거로 옮겨 기존 계산기 연결을 확인한다.
 update private.safety_appointment_result_revisions set cancellation_at=statement_timestamp()-interval'48 hours'
 where appointment_id=c.ap and outcome='own_cancel';
 plan:=private.cancellation_sanction_plan(identity_key);
 assert plan->>'status'='held' and(plan->>'heldAppointmentId')::uuid=(select ap from safety_sync_cases where n=2)
 and(plan->>'eligibleCount')::integer=1,'elapsed cancellation counts and next pending holds';
end;$$;
\echo PASS actual own/peer cancellation retry and 24h plan hold

-- 과거 일정은 owner 합성 fixture로 조정한다. DB 시계·실제 접수 시각·양쪽 확인을 위조하지 않는다.
update public.posts set starts_at=statement_timestamp()-interval'3 hours',ends_at=statement_timestamp()-interval'1 hour',
 recruitment_ends_at=statement_timestamp()-interval'4 hours' where id=(select p from safety_sync_cases where n=2);
set local role authenticated;
do $$declare c safety_sync_cases;begin
 select *into c from safety_sync_cases where n=2;perform pg_temp.safety_sync_actor(1);
 perform public.confirm_appointment_completion(c.ap);
end;$$;
reset role;
do $$begin
 assert(select a.status='confirmed' and a.completed_at is null from public.appointments a where a.id=(select ap from safety_sync_cases where n=2)),'one member is not completed';
 assert(select bool_and(h.current_revision=1 and r.outcome='pending')from private.safety_appointment_results h
 join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 where h.appointment_id=(select ap from safety_sync_cases where n=2)),'single confirmation pending';
end;$$;
set local role authenticated;
do $$declare c safety_sync_cases;snapshot jsonb;begin
 select *into c from safety_sync_cases where n=2;perform pg_temp.safety_sync_actor(2);
 perform public.confirm_appointment_completion(c.ap);snapshot:=pg_temp.safety_sync_snapshot(c.ap);
 perform public.confirm_appointment_completion(c.ap);
 assert pg_temp.safety_sync_snapshot(c.ap)=snapshot,'manual completion retry unchanged';
end;$$;
reset role;
do $$begin
 assert(select count(*)=2 and bool_and(h.current_revision=2 and r.outcome='completed')from private.safety_appointment_results h
 join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 where h.appointment_id=(select ap from safety_sync_cases where n=2)),'bilateral complete two ledger results';
end;$$;
set local role authenticated;
do $$begin perform pg_temp.safety_sync_actor(1);perform public.raise_appointment_dispute((select ap from safety_sync_cases where n=2),'합성 실제 분쟁 보류');end;$$;
reset role;
do $$begin
 assert(select count(*)=2 and bool_and(h.current_revision=3 and r.outcome='pending' and r.cancellation_at is null)
 from private.safety_appointment_results h join private.safety_appointment_result_revisions r
 on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 where h.appointment_id=(select ap from safety_sync_cases where n=2)),'open dispute resets automatic complete to pending without blame';
end;$$;
-- owner 기존 actual_meetup 종결 경로가 자동 완료 원장을 실제 복원한다. 운영 배정 권한 증거는 아니다.
select private.resolve_appointment_dispute((select ap from safety_sync_cases where n=2),'actual_meetup',clock_timestamp());
do $$begin
 assert(select count(*)=2 and bool_and(h.current_revision=4 and r.outcome='completed')from private.safety_appointment_results h
 join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 where h.appointment_id=(select ap from safety_sync_cases where n=2)),'actual meetup restores completed automatic result';
end;$$;
-- 별도 no_show 보류 경계를 위해 owner가 같은 합성 분쟁을 다시 open으로 구성한다. 회원 재접수 API 성공을 주장하지 않는다.
update public.appointment_disputes set status='open',resolved_at=null,resolution=null
 where appointment_id=(select ap from safety_sync_cases where n=2);
update public.appointments set status='disputed'where id=(select ap from safety_sync_cases where n=2);
-- 소유자 합성 종결 fixture이며 실제 운영 권한 배정이나 노쇼 귀책 판정 증거가 아니다.
select private.resolve_appointment_dispute((select ap from safety_sync_cases where n=2),'no_show',clock_timestamp());
do $$begin
 assert(select count(*)=2 and bool_and(h.current_revision=5 and r.outcome='pending')from private.safety_appointment_results h
 join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 where h.appointment_id=(select ap from safety_sync_cases where n=2)),'no show stays pending without automatic exempt or violation';
end;$$;
\echo PASS bilateral completion and subsequent dispute/no-show hold

-- 실제 예약 실행 RPC의 자동 완료. owner가 일정만 과거로 옮기며 guard/역할/실행기를 만들지 않는다.
update public.posts set starts_at=statement_timestamp()-interval'3 days',ends_at=statement_timestamp()-interval'2 days',
 recruitment_ends_at=statement_timestamp()-interval'4 days' where id=(select p from safety_sync_cases where n=8);
select public.execute_completion_reservation(r.appointment_id,r.generation)
 from private.completion_reservations r where r.appointment_id=(select ap from safety_sync_cases where n=8);
do $$begin
 assert(select status='completed' and completion_method='automatic' from public.appointments where id=(select ap from safety_sync_cases where n=8)),'actual reservation automatically completed';
 assert(select count(*)=2 and bool_and(h.current_revision=2 and r.outcome='completed')from private.safety_appointment_results h
 join private.safety_appointment_result_revisions r on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 where h.appointment_id=(select ap from safety_sync_cases where n=8)),'automatic completion linked to two results';
 assert not exists(select 1 from public.appointment_completion_confirmations where appointment_id=(select ap from safety_sync_cases where n=8)),'automatic completion fabricates no manual confirmations';
end;$$;
\echo PASS actual reservation automatic completion without manual confirmations

-- owner 판정/이의/면제는 별도 명시 메타데이터로 보존한다. reason_code의 문자열로 판단하지 않는다.
update private.safety_appointment_result_revisions set origin='operator',reason_code='appointment_state_sync'
 where appointment_id=(select ap from safety_sync_cases where n=3);
update private.safety_appointment_result_revisions set appeal_state='reviewing',outcome='own_cancel',cancellation_at=clock_timestamp()
 where appointment_id=(select ap from safety_sync_cases where n=4);
update private.safety_appointment_result_revisions set outcome='exempt'
 where appointment_id=(select ap from safety_sync_cases where n=5);
-- 과거 backfill의 보호 경계만 모사한다. 이 테스트는 실제 마이그레이션 시 과거 행 backfill 실행 증거가 아니다.
update private.safety_appointment_result_revisions set origin='legacy_unknown'
 where appointment_id=(select ap from safety_sync_cases where n=7);
update private.safety_appointment_results set ordering_provenance='unknown',agreed_starts_at=null
 where appointment_id=(select ap from safety_sync_cases where n=7);
update safety_sync_cases set snapshot=pg_temp.safety_sync_snapshot(ap)where n in(3,4,5,7);
-- 자동 원장이 아닌 면제 결과는 실제 일정 수락에도 덮어쓰지 않는다.
set local role authenticated;
do $$declare c safety_sync_cases;state jsonb;proposal jsonb;cid uuid:=gen_random_uuid();begin
 select *into c from safety_sync_cases where n=5;perform pg_temp.safety_sync_actor(1);
 state:=public.get_appointment_change_state(c.ap);
 proposal:=public.propose_appointment_schedule_change(c.ap,cid,(state->>'startsAt')::timestamptz+interval'1 hour',
 (state->>'endsAt')::timestamptz+interval'1 hour',(state->>'updatedAt')::timestamptz);
 perform pg_temp.safety_sync_actor(2);perform public.accept_appointment_schedule_change(c.ap,cid,proposal->>'conditionVersion');
 assert pg_temp.safety_sync_snapshot(c.ap)=c.snapshot,'exempt accepted schedule preserves original result ordering';
end;$$;
reset role;

set local role authenticated;
do $$declare c safety_sync_cases;begin
 perform pg_temp.safety_sync_actor(1);
 for c in select *from safety_sync_cases where n in(3,4,5,7)loop
 perform public.cancel_appointment(c.ap,gen_random_uuid(),'합성 보호 원장 취소');
 assert pg_temp.safety_sync_snapshot(c.ap)=c.snapshot,'operator/reviewing/exempt/legacy preservation';
 end loop;
end;$$;
reset role;
do $$declare i uuid;begin
 select identity_id into i from private.member_episodes where profile_id=pg_temp.safety_sync_uid(1)and ended_at is null;
 assert private.cancellation_sanction_plan(i)->>'status'='ordering_unknown','unknown past order always holds';
 assert not exists(select 1 from private.safety_sanction_applications s where s.identity_id=i),'sync never applies sanctions';
end;$$;
\echo PASS explicit provenance, review and exemption protected; historical unknown holds

do $$declare role_name text;begin
 foreach role_name in array array['anon','authenticated','service_role','yumidang_worker_queue']loop
 assert not has_function_privilege(role_name,'private.sync_appointment_safety_results(uuid,boolean,boolean)','EXECUTE'),'private sync ACL closed';
 assert not has_function_privilege(role_name,'private.sync_appointment_safety_trigger()','EXECUTE'),'private trigger direct ACL closed';
 assert not has_table_privilege(role_name,'private.safety_appointment_results','INSERT,UPDATE,DELETE'),'result ledger mutation ACL closed';
 assert not has_table_privilege(role_name,'private.safety_appointment_result_revisions','INSERT,UPDATE,DELETE'),'revision append/update/delete ACL closed';
 assert not has_table_privilege(role_name,'private.appointment_safety_sync_audit','SELECT,INSERT,UPDATE,DELETE'),'migration audit ACL closed';
 end loop;
 assert(select proowner=(select relowner from pg_class where oid='private.safety_appointment_results'::regclass)
 and prosecdef and proconfig=array['search_path=""']::text[] from pg_proc where oid='private.sync_appointment_safety_results(uuid,boolean,boolean)'::regprocedure),'owner and empty search path';
 assert(select count(*)=4 from pg_trigger where tgname in('z_safety_appointment_insert','z_safety_appointment_update','z_safety_post_schedule','z_safety_dispute_state')and not tgisinternal),'four actual source triggers';
 assert not exists(select 1 from private.safety_appointment_result_revisions r join safety_sync_cases c on c.ap=r.appointment_id
 where r.reason_code like '%합성%'),'no cancellation/dispute original copied';
end;$$;
-- 원장 FK의 삭제 경계를 확인한다. 전체 rollback하며 일반 보관 작업에 cascade를 추가하지 않는다.
do $$begin
 perform pg_temp.safety_sync_failure(format('delete from public.appointments where id=%L',(select ap from safety_sync_cases where n=7)),'23503');
end;$$;
delete from private.safety_appointment_result_revisions where appointment_id in(select ap from safety_sync_cases);
delete from private.safety_appointment_results where appointment_id in(select ap from safety_sync_cases);
delete from public.appointments where id in(select ap from safety_sync_cases);
do $$begin
 assert not exists(select 1 from private.safety_appointment_result_revisions where appointment_id in(select ap from safety_sync_cases)),'scoped revisions cleaned before appointments';
 assert not exists(select 1 from private.safety_appointment_results where appointment_id in(select ap from safety_sync_cases)),'scoped result cleanup';
 assert(select roles from safety_sync_baseline)=(select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles),'global role flags unchanged';
 assert(select memberships from safety_sync_baseline)=(select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members),'global memberships unchanged';
 assert(select guard from safety_sync_baseline)is not distinct from(select external_deletion_approved from private.member_cleanup_guard where singleton),'cleanup guard unchanged';
 assert(select worker from safety_sync_baseline)is not distinct from(select to_jsonb(g)from private.global_worker_run g where singleton),'global worker unchanged';
end;$$;
select 'NOT_RUN actual two-session lifecycle-owner races / HTTP / sanction notice and appeal workflow';
rollback;
