-- 민규: source77 위 취소 해소/due private 후보 회귀. 실제 SQL 실행 NOT_RUN.
-- 본인 업로드 blob·HTTP·운영 판정·실제 두 세션 경합 증거가 아니다. 전체 owner TX rollback.
-- 완료 시각 fixture는 owner가 과거 일정으로 조정하며 실제 DB 시계·서버 수신 시각은 변경하지 않는다.
begin;
set local plpgsql.check_asserts=on;
-- 최신 지원 종류 점유는 취소의 두 실행 권한을 모두 요구한다. outer ROLLBACK으로 원복한다.
grant execute on function public.enqueue_cancellation_safety_due(integer,uuid),public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid) to service_role;
create temp table resolution_case_baseline as select
 (select jsonb_agg(jsonb_build_array(oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil)order by oid)from pg_roles)roles,
 (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)memberships,
 (select external_deletion_approved from private.member_cleanup_guard where singleton)guard,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.resolution_case_uid(n integer) returns uuid language sql immutable as $$
 select ('fc810000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.resolution_case_session(n integer) returns uuid language sql immutable as $$
 select ('fc820000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid; $$;
create function pg_temp.resolution_case_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.resolution_case_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.resolution_case_uid(n),'session_id',pg_temp.resolution_case_session(n))::text,true);
end;$$;
create function pg_temp.resolution_case_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
end;$$;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.resolve_naver_account('change-resolution_case-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email) select pg_temp.resolution_case_uid(i),a.auth_email from generate_series(1,4)i
 join private.naver_accounts a on a.subject='change-resolution_case-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.resolution_case_session(i),pg_temp.resolution_case_uid(i) from generate_series(1,4)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.resolution_case_uid(i)::text||'/fc830000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.resolution_case_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,4)i;
set local role service_role;
do $$declare i integer;begin for i in 1..4 loop
 perform public.record_naver_session('change-resolution_case-sql-'||i,pg_temp.resolution_case_uid(i),pg_temp.resolution_case_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..4 loop
 perform pg_temp.resolution_case_actor(i);
 assert public.complete_naver_signup(pg_temp.resolution_case_uid(i)::text||'/fc830000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
end loop;end;$$;
reset role;

create temp table resolution_case_general_baseline as select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]'::jsonb)fingerprint from private.safety_appeals a where kind='general';
create temp table resolution_case_cases(n integer primary key,post_id uuid,appointment_id uuid,report_id uuid,request_id uuid,initial_revision bigint,result jsonb);
grant all on resolution_case_cases to authenticated;
set local role authenticated;
do $$declare i integer;p uuid;j uuid;a uuid;conditions jsonb;rid uuid;begin
 for i in 1..8 loop
 p:=gen_random_uuid();perform pg_temp.resolution_case_actor(1);
 perform public.create_service_post(p,jsonb_build_object('title','합성 취소 이의','description','로컬 합성 검증','category','산책',
 'startsAt',clock_timestamp()+make_interval(days=>i*3),'endsAt',clock_timestamp()+make_interval(days=>i*3,hours=>2),
 'recruitmentEndsAt',clock_timestamp()+make_interval(days=>i*3,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','합성 장소','registeredAddress','서울특별시 강남구 합성주소','meetingDetail','합성 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));
 perform pg_temp.resolution_case_actor(2);j:=(public.request_service_post(p,gen_random_uuid(),'합성 신청')->>'id')::uuid;
 perform pg_temp.resolution_case_actor(1);conditions:=public.propose_match(j);
 perform pg_temp.resolution_case_actor(2);a:=(public.accept_match(j,conditions->>'conditionVersion')->>'appointmentId')::uuid;
 perform pg_temp.resolution_case_actor(1);perform public.cancel_appointment(a,gen_random_uuid(),'합성 이의 사유');
 rid:=(public.submit_member_report(gen_random_uuid(),'appointment',a,'offline',array['other'],'합성 취소 사유','{}',false)->>'reportId')::uuid;
 insert into resolution_case_cases(n,post_id,appointment_id,report_id,request_id)values(i,p,a,rid,gen_random_uuid());
 end loop;
end;$$;
reset role;
update resolution_case_cases case_row set initial_revision=head.current_revision from private.safety_appointment_results head join private.member_episodes ep on ep.id=head.source_episode_id
 where case_row.appointment_id=head.appointment_id and ep.profile_id=pg_temp.resolution_case_uid(1);
do $$begin
 assert (select count(*)=8 and bool_and(initial_revision=2) from resolution_case_cases), 'fixture_original_cancel_revision';
end;$$;
create temp table resolution_case_original as select head.identity_id,head.appointment_id,head.source_episode_id,head.agreed_starts_at,head.confirmed_at,cancel_row.cancelled_at
 from private.safety_appointment_results head join private.member_episodes ep on ep.id=head.source_episode_id join private.appointment_cancellations cancel_row on cancel_row.appointment_id=head.appointment_id
 where ep.profile_id=pg_temp.resolution_case_uid(1)and head.appointment_id in(select appointment_id from resolution_case_cases);
-- 앞선 원신고는 독립 포트 충돌 검사 자료다. 원자 제출은 별도 request key를 쓴다.
create function pg_temp.resolution_case_call(p_case_number integer,p_expected bigint default null,p_description text default '합성 원자 접수',p_assets uuid[]default '{}',p_hide boolean default false,p_request uuid default null)
returns jsonb language sql as $$select public.submit_appointment_cancel_appeal_with_report(case_row.appointment_id,coalesce(p_request,case_row.request_id),coalesce(p_expected,case_row.initial_revision),array['other'],p_description,p_assets,p_hide)
 from resolution_case_cases case_row where case_row.n=p_case_number;$$;
create function pg_temp.resolution_case_snapshot()returns jsonb language sql as $$select jsonb_build_object(
 'reports',(select coalesce(jsonb_agg(to_jsonb(r)order by id),'[]')from private.member_reports r),
 'details',(select coalesce(jsonb_agg(to_jsonb(d)order by report_id),'[]')from private.member_report_details d),
 'assets',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.report_capture_assets a),
 'audit',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.report_access_audit a),
 'appeals',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.safety_appeals a),
 'receipts',(select coalesce(jsonb_agg(to_jsonb(r)order by client_request_id),'[]')from private.appointment_cancel_appeal_receipts r),
 'bindings',(select coalesce(jsonb_agg(to_jsonb(b)order by client_request_id),'[]')from private.appointment_cancel_appeal_report_bindings b),
 'heads',(select coalesce(jsonb_agg(to_jsonb(h)order by identity_id,appointment_id),'[]')from private.safety_appointment_results h),
 'revisions',(select coalesce(jsonb_agg(to_jsonb(r)order by identity_id,appointment_id,revision),'[]')from private.safety_appointment_result_revisions r),
 'storage',(select coalesce(jsonb_agg(to_jsonb(o)order by id),'[]')from storage.objects o),
 'sanctions',(select coalesce(jsonb_agg(to_jsonb(s)order by id),'[]')from private.safety_sanction_applications s),
 'suspensions',(select coalesce(jsonb_agg(to_jsonb(s)order by application_id),'[]')from private.cancellation_effect_suspensions s),
 'sweetness',(select coalesce(jsonb_agg(to_jsonb(d)order by decision_id),'[]')from private.sweetness_incident_decisions d));$$;
-- 정확한 원회원/원취소로 두 개 reviewing 이의를 만든다. 직원 판정만 owner 합성 승인이다.
set local role authenticated;select pg_temp.resolution_case_actor(1);
update resolution_case_cases set result=pg_temp.resolution_case_call(n)where n in(1,3);
reset role;
do $$begin
 assert (select count(*)=2 and bool_and(case_row.initial_revision=2 and head.current_revision=3
  and (case_row.result->>'resultRevision')::bigint=head.current_revision
  and report_row.review_version=1 and report_row.status='received')
  from resolution_case_cases case_row join private.safety_appointment_results head
   on head.appointment_id=case_row.appointment_id and head.source_episode_id=(select id from private.member_episodes where profile_id=pg_temp.resolution_case_uid(1) and ended_at is null)
  join private.member_reports report_row on report_row.id=(case_row.result->>'reportId')::uuid
  where case_row.n in(1,3)), 'fixture_reviewing_revision';
end;$$;
-- 무이의 취소의 지난 24h는 fixture 시각만 조정한다. 실제 DB clock/수신 시각은 변경하지 않는다.
update private.appointment_cancellations cancellation_row set cancelled_at=clock_timestamp()-interval'25 hours'
 from resolution_case_cases case_row where cancellation_row.appointment_id=case_row.appointment_id and case_row.n not in(1,3);
update private.safety_appointment_result_revisions result_row set cancellation_at=cancellation_row.cancelled_at
 from private.appointment_cancellations cancellation_row join resolution_case_cases case_row on case_row.appointment_id=cancellation_row.appointment_id
 where result_row.appointment_id=case_row.appointment_id and result_row.outcome='own_cancel'and case_row.n not in(1,3);
select private.set_report_operator_approval(pg_temp.resolution_case_uid(3),true);
select private.set_report_operator_assignment(pg_temp.resolution_case_uid(3),(result->>'reportId')::uuid,true)from resolution_case_cases where n in(1,3);
create function pg_temp.resolution_identity()returns uuid language sql as $$select identity_id from private.member_episodes where profile_id=pg_temp.resolution_case_uid(1);$$;
create function pg_temp.resolution_call(p_case_number integer,p_key uuid,p_mode text,p_report_version bigint,p_result_revision bigint,p_incident_revision bigint,p_outcome text)
returns jsonb language sql as $$select public.resolve_assigned_appointment_cancel_appeal((case_row.result->>'reportId')::uuid,(case_row.result->>'appealId')::uuid,
 p_key,p_mode,p_report_version,p_result_revision,p_incident_revision,p_outcome)from resolution_case_cases case_row where case_row.n=p_case_number;$$;
create temp table resolution_receipts(n integer primary key,request_id uuid,result jsonb);
grant all on resolution_receipts to authenticated;
-- 기존 실제 claim_job이 반환한 job lease/global 매핑을 그대로 process에 전달한다.
create function pg_temp.process_resolution_due(p_identity uuid,p_generation bigint,p_global uuid)
returns jsonb language plpgsql security definer set search_path=''as $$
declare job_row private.worker_jobs;claim jsonb;begin
 select *into job_row from private.worker_jobs where kind='cancellation_safety'and dedupe_key='cancellation_safety:'||p_identity::text||':'||p_generation::text;
 if not found then
  insert into private.worker_jobs(kind,dedupe_key,payload,available_at)values('cancellation_safety','cancellation_safety:'||p_identity::text||':'||p_generation::text,
   jsonb_build_object('identityId',p_identity,'generation',p_generation),clock_timestamp())returning *into job_row;
 end if;
 if job_row.status<>'running'then
  claim:=public.claim_supported_job(gen_random_uuid(),180,p_global,array['cancellation_safety']);
  if(claim->'job'->>'jobId')::uuid is distinct from job_row.id then raise exception 'fixture_claim_mismatch'using errcode='PT998';end if;
  select *into job_row from private.worker_jobs where id=job_row.id;
 end if;
 return public.process_cancellation_safety_due(p_identity,p_generation,job_row.id,job_row.lease_token,p_global);
end;$$;
-- 첫 미결 head에서 due는 제재를 만들지 않고 보류한다. false 준비 guard 및 잘못된 token은 원자 거절한다.
do $$declare v_token uuid:=gen_random_uuid();before_effects bigint;due_generation bigint;response jsonb;begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 select generation into due_generation from private.cancellation_safety_due where identity_id=pg_temp.resolution_identity();
 perform pg_temp.resolution_case_failure(format('select public.process_cancellation_safety_due(%L,%s,%L,%L,%L)',pg_temp.resolution_identity(),due_generation,gen_random_uuid(),gen_random_uuid(),v_token),'55000');
 update private.cancellation_due_control set enabled=true where singleton;
 update private.global_worker_run set token=v_token,expires_at=clock_timestamp()+interval'180 seconds'where singleton;
 select count(*)into before_effects from private.safety_sanction_applications;
 perform pg_temp.resolution_case_failure(format('select pg_temp.process_resolution_due(%L,%s,%L)',pg_temp.resolution_identity(),due_generation,gen_random_uuid()),'40001');
 response:=pg_temp.process_resolution_due(pg_temp.resolution_identity(),due_generation,v_token);
 assert response->>'status'='held'and response->'changed'='false'::jsonb;
 assert(select count(*)from private.safety_sanction_applications)=before_effects;
 update private.cancellation_due_control set enabled=false where singleton;
 update private.global_worker_run set token=null,expires_at=null where singleton;
end;$$;
set local role authenticated;select pg_temp.resolution_case_actor(3);
do $$declare key uuid:=gen_random_uuid();response jsonb;current_state jsonb;case_row resolution_case_cases;begin
 select * into strict case_row from resolution_case_cases where n=1;
 current_state:=public.get_assigned_appointment_cancel_appeal_resolution_state((case_row.result->>'reportId')::uuid,(case_row.result->>'appealId')::uuid);
 assert current_state->>'reportVersion'='1' and current_state->>'resultRevision'='3'
  and current_state->>'incidentRevision'='0' and current_state->>'appealState'='reviewing', 'fixture_public_resolution_state';
 response:=pg_temp.resolution_call(1,key,'initial',1,3,0,'rejected');
 assert(select count(*)from jsonb_object_keys(response))=7;
 assert response->>'appealState'='rejected'and response->>'reportVersion'='2'and response->>'resultRevision'='4';
 insert into resolution_receipts values(1,key,response);
 assert pg_temp.resolution_call(1,key,'initial',1,3,0,'rejected')=response||jsonb_build_object('alreadyApplied',true);
 perform pg_temp.resolution_case_failure(format('select pg_temp.resolution_call(1,%L,''initial'',1,3,0,''accepted'')',key),'40001');
 perform pg_temp.resolution_case_failure('select pg_temp.resolution_call(1,gen_random_uuid(),''initial'',1,2,0,''rejected'')','40001');
end;$$;
reset role;
do $$begin
 assert not exists(select 1 from private.safety_sanction_applications);
 assert private.current_cancellation_sanction_plan(pg_temp.resolution_identity())->>'status'='held';
 assert(select policy_pending_code is null and next_due_at is null from private.cancellation_safety_due where identity_id=pg_temp.resolution_identity());
end;$$;
set local role authenticated;select pg_temp.resolution_case_actor(3);
insert into resolution_receipts select 3,gen_random_uuid(),null;
update resolution_receipts set result=pg_temp.resolution_call(3,request_id,'initial',1,3,0,'rejected')where n=3;
reset role;
create temp table resolution_original_effects as select *from private.safety_sanction_applications where identity_id=pg_temp.resolution_identity();
do $$declare plan jsonb;before_effects jsonb;begin
 assert(select count(*)from resolution_original_effects where kind='cancel_warning'and revoked_at is null)=1;
 assert(select count(*)from resolution_original_effects where kind='cancel_restriction'and revoked_at is null)=1;
 assert(select bool_and(expires_at=applied_at+interval'168 hours')from resolution_original_effects where kind='cancel_restriction');
 assert exists(select 1 from private.sweetness_incident_decisions d join private.cancellation_chain_effects m on m.incident_id=d.incident_id
  where m.identity_id=pg_temp.resolution_identity()and d.kind='cancel_sanction'and d.is_valid);
 select jsonb_agg(to_jsonb(a)order by id)into before_effects from private.safety_sanction_applications a;
 perform private.lock_cancellation_identity(pg_temp.resolution_identity());
 plan:=private.reconcile_cancellation_chain(pg_temp.resolution_identity(),pg_temp.resolution_case_uid(3));
 assert plan->'changed'='false'::jsonb;
 assert(select jsonb_agg(to_jsonb(a)order by id)from private.safety_sanction_applications a)=before_effects;
end;$$;
-- 본인 notice 최초 읽음은 명시 ACK만 기록한다. 타인 조회와 구분한다.
set local role authenticated;select pg_temp.resolution_case_actor(1);
do $$declare notices jsonb;notice uuid;first_read jsonb;begin
 notices:=public.list_my_cancellation_notices();assert jsonb_array_length(notices->'items')=2;
 notice:=(notices->'items'->0->>'noticeId')::uuid;
 assert notices->'items'->0->'firstReadAt'='null'::jsonb;
 first_read:=public.read_my_cancellation_notice(notice);assert(select count(*)from jsonb_object_keys(first_read))=10;
 assert first_read->'firstReadAt'<>'null'::jsonb;assert public.read_my_cancellation_notice(notice)=first_read;
end;$$;
reset role;
create temp table resolution_foreign_notice as select id from private.member_cancellation_notices limit 1;
grant select on resolution_foreign_notice to authenticated;
set local role authenticated;select pg_temp.resolution_case_actor(2);
select pg_temp.resolution_case_failure(format('select public.read_my_cancellation_notice(%L)',(select id from resolution_foreign_notice)),'PT404');
do $$begin
 assert public.list_my_cancellation_notices()->'items'='[]'::jsonb;
end;$$;
reset role;
-- 통지 INSERT 뒤 staff 세션이 만료되면 해소/원장/효과/점수/receipt 전체가 rollback된다.
create function pg_temp.resolution_expire_session()returns trigger language plpgsql as $$begin
 update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.resolution_case_session(3);return new;
end;$$;
create function pg_temp.resolution_snapshot()returns jsonb language sql security definer set search_path=''as $$
 select pg_temp.resolution_case_snapshot()||jsonb_build_object(
 'incidents',(select coalesce(jsonb_agg(to_jsonb(x)order by id),'[]')from private.safety_incidents x),
 'incidentRevisions',(select coalesce(jsonb_agg(to_jsonb(x)order by incident_id,revision),'[]')from private.safety_incident_revisions x),
 'subjects',(select coalesce(jsonb_agg(to_jsonb(x)order by incident_id,revision,identity_id),'[]')from private.safety_incident_subjects x),
 'jobs',(select coalesce(jsonb_agg(to_jsonb(x)order by id),'[]')from private.worker_jobs x),
 'jobFences',(select coalesce(jsonb_agg(to_jsonb(x)order by job_id),'[]')from private.worker_job_run_fences x),
 'decisions',(select coalesce(jsonb_agg(to_jsonb(x)order by decision_id),'[]')from private.appointment_cancel_resolutions x),
 'notices',(select coalesce(jsonb_agg(to_jsonb(x)order by id),'[]')from private.member_cancellation_notices x),
 'effects',(select coalesce(jsonb_agg(to_jsonb(x)order by identity_id,anchor_appointment_id),'[]')from private.cancellation_chain_effects x),
 'due',(select coalesce(jsonb_agg(to_jsonb(x)order by identity_id),'[]')from private.cancellation_safety_due x),
 'sweetness',(select coalesce(jsonb_agg(to_jsonb(x)order by incident_id,recipient_episode_id,kind,revision),'[]')from private.sweetness_incident_decisions x));
$$;
create temp table resolution_before_failure as select pg_temp.resolution_snapshot()fingerprint;
grant select on resolution_before_failure to authenticated;
create trigger resolution_expire_staff after insert on private.member_cancellation_notices for each row execute function pg_temp.resolution_expire_session();
set local role authenticated;select pg_temp.resolution_case_actor(3);
select pg_temp.resolution_case_failure('select pg_temp.resolution_call(3,gen_random_uuid(),''correction'',2,4,1,''accepted'')','28000');
do $$begin assert pg_temp.resolution_snapshot()=(select fingerprint from resolution_before_failure);end;$$;
reset role;
drop trigger resolution_expire_staff on private.member_cancellation_notices;

-- 종료 회차 fixture도 기존 잘못된 효과 철회/원회차 점수 복구는 허용한다. 실제 탈퇴 API 증거는 아니다.
update private.member_episodes set ended_at=clock_timestamp()where profile_id=pg_temp.resolution_case_uid(1);
-- 후속 accepted로 잘못된 효과를 즉시 철회한다. anchor 이동의 새 시계는 pending이며 원회차 점수만 복구한다.
set local role authenticated;select pg_temp.resolution_case_actor(3);
select pg_temp.resolution_call(3,gen_random_uuid(),'correction',2,4,1,'accepted');
reset role;
do $$declare plan jsonb;before_effects jsonb;begin
 assert not exists(select 1 from private.safety_sanction_applications where identity_id=pg_temp.resolution_identity()and revoked_at is null);
 assert exists(select 1 from private.sweetness_incident_decisions d join private.cancellation_chain_effects m on m.incident_id=d.incident_id
  where m.identity_id=pg_temp.resolution_identity()and d.kind='cancel_sanction'and not d.is_valid);
 assert(select policy_pending_code='anchor_clock_transfer_unresolved'from private.cancellation_safety_due where identity_id=pg_temp.resolution_identity());
 select jsonb_agg(to_jsonb(a)order by id)into before_effects from private.safety_sanction_applications a;
 perform private.lock_cancellation_identity(pg_temp.resolution_identity());
 plan:=private.reconcile_cancellation_chain(pg_temp.resolution_identity(),pg_temp.resolution_case_uid(3));
 assert plan->>'policyPending'='anchor_clock_transfer_unresolved'and plan->'changed'='false'::jsonb;
 assert(select jsonb_agg(to_jsonb(a)order by id)from private.safety_sanction_applications a)=before_effects;
end;$$;
update private.member_episodes set ended_at=null where profile_id=pg_temp.resolution_case_uid(1);
-- 상세 TTL이 지난 미삭제 report도 list/cursor/ACK에서 폐쇄한다. 최종 90일 삭제 worker 실행은 아니다.
create temp table resolution_ttl_notice as select id from private.member_cancellation_notices where report_id=(select(result->>'reportId')::uuid from resolution_case_cases where n=1);
grant select on resolution_ttl_notice to authenticated;
-- 실제 canonical CHECK를 만족하는 최종종결fixture. 업무상종결/이의기한 결정 증거가 아니다.
update private.member_reports set status='resolved',final_closed_at=statement_timestamp()-interval'2161 hours',retention_due_at=statement_timestamp()-interval'1 hour'
 where id=(select(result->>'reportId')::uuid from resolution_case_cases where n=1);
set local role authenticated;select pg_temp.resolution_case_actor(1);
select pg_temp.resolution_case_failure(format('select public.read_my_cancellation_notice(%L)',(select id from resolution_ttl_notice)),'PT404');
select pg_temp.resolution_case_failure(format('select public.list_my_cancellation_notices(20,%L)',(select id from resolution_ttl_notice)),'PT404');
reset role;
-- 별도 활성 원회원4의 무이의 취소 여섯 건: due가 첫 경고/그 다음7일을 실제 원helper로 적용한다.
create temp table resolution_due_cases(n integer primary key,appointment_id uuid);
grant all on resolution_due_cases to authenticated;
set local role authenticated;
do $$declare number integer;post_key uuid;request_key uuid;appointment_key uuid;conditions jsonb;begin
 for number in 1..6 loop
  post_key:=gen_random_uuid();perform pg_temp.resolution_case_actor(4);
  perform public.create_service_post(post_key,jsonb_build_object('title','합성 무이의 due','description','원자 due 회귀','category','산책',
   'startsAt',clock_timestamp()+make_interval(days=>number*4),'endsAt',clock_timestamp()+make_interval(days=>number*4,hours=>2),
   'recruitmentEndsAt',clock_timestamp()+make_interval(days=>number*4,hours=>-1),'publicArea','서울특별시 강남구 역삼동',
   'registeredPlaceName','합성 due 장소','registeredAddress','서울특별시 강남구 합성주소','meetingDetail','합성 입구',
   'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));
  perform pg_temp.resolution_case_actor(2);request_key:=(public.request_service_post(post_key,gen_random_uuid(),'합성 신청')->>'id')::uuid;
  perform pg_temp.resolution_case_actor(4);conditions:=public.propose_match(request_key);
  perform pg_temp.resolution_case_actor(2);appointment_key:=(public.accept_match(request_key,conditions->>'conditionVersion')->>'appointmentId')::uuid;
  perform pg_temp.resolution_case_actor(4);perform public.cancel_appointment(appointment_key,gen_random_uuid(),'합성 due 취소');
  insert into resolution_due_cases values(number,appointment_key);
 end loop;
end;$$;
reset role;
update private.appointment_cancellations cancellation_row set cancelled_at=clock_timestamp()-interval'25 hours'
 from resolution_due_cases case_row where cancellation_row.appointment_id=case_row.appointment_id;
update private.safety_appointment_result_revisions result_row set cancellation_at=cancellation_row.cancelled_at
 from private.appointment_cancellations cancellation_row join resolution_due_cases case_row on case_row.appointment_id=cancellation_row.appointment_id
 where result_row.appointment_id=case_row.appointment_id and result_row.outcome='own_cancel';
create function pg_temp.resolution_expire_global()returns trigger language plpgsql as $$begin
 update private.global_worker_run set expires_at=clock_timestamp()-interval'1 second'where singleton;return new;end;$$;
do $$declare identity_key uuid;episode_key uuid;v_token uuid:=gen_random_uuid();generation_value bigint;response jsonb;before_effects jsonb;before_all jsonb;begin
 select identity_id,id into identity_key,episode_key from private.member_episodes where profile_id=pg_temp.resolution_case_uid(4)and ended_at is null;
 select generation into generation_value from private.cancellation_safety_due where identity_id=identity_key;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 update private.cancellation_due_control set enabled=true where singleton;
 update private.global_worker_run set token=v_token,expires_at=clock_timestamp()+interval'180 seconds'where singleton;
 -- 종료 회차 최초 효과는 보류한다. 이 fixture 분기는 subtransaction rollback 후 활성 경로를 검사한다.
 begin
  update private.member_episodes set ended_at=clock_timestamp()where id=episode_key;
  response:=pg_temp.process_resolution_due(identity_key,generation_value,v_token);
  assert response->>'status'='policy_pending';
  assert not exists(select 1 from private.safety_sanction_applications where identity_id=identity_key);
  raise exception 'fixture_branch_rollback'using errcode='PT999';
 exception when sqlstate'PT999'then null;end;
 before_all:=pg_temp.resolution_snapshot();
 execute 'create trigger resolution_due_global_expiry after insert on private.safety_sanction_applications for each row execute function pg_temp.resolution_expire_global()';
 perform pg_temp.resolution_case_failure(format('select pg_temp.process_resolution_due(%L,%s,%L)',identity_key,generation_value,v_token),'40001');
 assert pg_temp.resolution_snapshot()=before_all;
 execute 'drop trigger resolution_due_global_expiry on private.safety_sanction_applications';
 response:=pg_temp.process_resolution_due(identity_key,generation_value,v_token);
 assert response->>'status'='applied'and response->'changed'='true'::jsonb;
 assert(select count(*)from private.safety_sanction_applications where identity_id=identity_key and revoked_at is null and kind='cancel_warning')=1;
 assert(select count(*)from private.safety_sanction_applications where identity_id=identity_key and revoked_at is null and kind='cancel_restriction'and expires_at=applied_at+interval'168 hours')=1;
 assert not exists(select 1 from private.member_cancellation_notices where recipient_identity_id=identity_key);
 select jsonb_agg(to_jsonb(a)order by id)into before_effects from private.safety_sanction_applications a where identity_id=identity_key;
 response:=pg_temp.process_resolution_due(identity_key,generation_value,v_token);
 assert response->>'status'='not_due'and response->'changed'='false'::jsonb;
 assert(select jsonb_agg(to_jsonb(a)order by id)from private.safety_sanction_applications a where identity_id=identity_key)=before_effects;
 perform pg_temp.resolution_case_failure(format('select pg_temp.process_resolution_due(%L,%s,%L)',identity_key,generation_value+1,v_token),'40001');
 -- 같은 global 점유의 enqueue는 중복을 막고 기존 queue claim 계약을 사용한다.
 response:=public.enqueue_cancellation_safety_due(20,v_token);assert(response->>'enqueued')::integer>=1;
 assert public.enqueue_cancellation_safety_due(20,v_token)->>'enqueued'='0';
 perform pg_temp.resolution_case_failure(format('select public.process_cancellation_safety_due(%L,%s,%L,%L,%L)',identity_key,generation_value,
  (select id from private.worker_jobs where kind='cancellation_safety'and payload=jsonb_build_object('identityId',identity_key,'generation',generation_value)),gen_random_uuid(),v_token),'40001');
 update private.global_worker_run set expires_at=clock_timestamp()-interval'1 second'where singleton;
 perform pg_temp.resolution_case_failure(format('select pg_temp.process_resolution_due(%L,%s,%L)',identity_key,generation_value,v_token),'40001');
 update private.cancellation_due_control set enabled=false where singleton;
 update private.global_worker_run set token=null,expires_at=null where singleton;
end;$$;

-- owner가 지난 원취소 시각만 24h 이내로 조정한다. due 먼저/유효 intake 나중의 상태 결합 회귀이며 실제 두 세션 수신 경합은 아니다.
-- 같은 identity의 별도 일반 중대 사건은 owner 합성 판정이다. 실제 직원 HTTP 증거가 아니다.
create temp table suspension_general_incident as select gen_random_uuid()incident_id;
do $$declare identity_key uuid;episode_key uuid;begin
 select identity_id,id into identity_key,episode_key from private.member_episodes where profile_id=pg_temp.resolution_case_uid(4)and ended_at is null;
 perform private.record_incident_revision((select incident_id from suspension_general_incident),gen_random_uuid(),0,'confirmed','threat',pg_temp.resolution_case_uid(3),
  jsonb_build_array(jsonb_build_object('identityId',identity_key,'sourceEpisodeId',episode_key,'confirmedKinds',jsonb_build_array('major_violation'),
   'violationClass','major','violationType','threat','victimIdentityId',null,'cancellationAction',null)));
end;$$;
create temp table suspension_general_before as select to_jsonb(application_row)fingerprint from private.safety_sanction_applications application_row
 where application_row.incident_id=(select incident_id from suspension_general_incident);
-- 지난 원기간을 owner fixture로 구성한다. 복원은 이 만료된 기간도 다시 시작하지 않아야 한다.
update private.safety_sanction_applications application_row set applied_at=statement_timestamp()-interval'200 hours',expires_at=statement_timestamp()-interval'32 hours'
 where application_row.source_episode_id=(select id from private.member_episodes where profile_id=pg_temp.resolution_case_uid(4)and ended_at is null)and application_row.kind='cancel_restriction';
create temp table suspension_original_applications as
 select a.*from private.safety_sanction_applications a join private.member_episodes e on e.id=a.source_episode_id where e.profile_id=pg_temp.resolution_case_uid(4);
create temp table suspension_other_applications as
 select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]'::jsonb)fingerprint from private.safety_sanction_applications a
 where a.identity_id<>(select identity_id from private.member_episodes where profile_id=pg_temp.resolution_case_uid(4)and ended_at is null);
update private.appointment_cancellations cancellation_row set cancelled_at=clock_timestamp()-interval'23 hours'
 from resolution_due_cases case_row where case_row.appointment_id=cancellation_row.appointment_id and case_row.n in(4,5);
update private.safety_appointment_result_revisions result_row set cancellation_at=cancellation_row.cancelled_at
 from private.appointment_cancellations cancellation_row join resolution_due_cases case_row on case_row.appointment_id=cancellation_row.appointment_id
 where result_row.appointment_id=case_row.appointment_id and result_row.outcome='own_cancel'and case_row.n in(4,5);
create temp table suspension_appeals(n integer primary key,request_id uuid,result jsonb);
insert into suspension_appeals(n,request_id)values(4,gen_random_uuid()),(5,gen_random_uuid());
grant all on suspension_appeals to authenticated;
create function pg_temp.suspension_call(p_case_number integer)
returns jsonb language sql as $$select public.submit_appointment_cancel_appeal_with_report(case_row.appointment_id,request_row.request_id,2,array['other'],'합성 보류 검토','{}',false)
 from resolution_due_cases case_row join suspension_appeals request_row on request_row.n=case_row.n where case_row.n=p_case_number;$$;
create function pg_temp.suspension_expire_member()returns trigger language plpgsql as $$begin
 update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=pg_temp.resolution_case_session(4);return new;end;$$;
create function pg_temp.suspension_snapshot()returns jsonb language sql as $$select jsonb_build_object(
 'base',pg_temp.resolution_snapshot(),'lineage',(select coalesce(jsonb_agg(to_jsonb(s)order by application_id),'[]')from private.cancellation_effect_suspensions s),
 'sweetness',(select coalesce(jsonb_agg(to_jsonb(d)order by decision_id),'[]')from private.sweetness_incident_decisions d));$$;
-- final member guard 실패가 신고·접수·보류·점수까지 같은 TX에서 원복해야 한다.
create trigger suspension_member_expiry after insert on private.cancellation_effect_suspensions for each row execute function pg_temp.suspension_expire_member();
create temp table suspension_failure_before as select pg_temp.suspension_snapshot()fingerprint;
grant select on suspension_failure_before to authenticated;
set local role authenticated;select pg_temp.resolution_case_actor(4);
select pg_temp.resolution_case_failure('select pg_temp.suspension_call(4)','28000');
reset role;
do $$begin assert pg_temp.suspension_snapshot()=(select fingerprint from suspension_failure_before);end;$$;
drop trigger suspension_member_expiry on private.cancellation_effect_suspensions;
-- unknown ordering을 임의 정렬하거나 유효 접수 권리를 줄이지 않는다. 확정 prefix 계산만 보류한다.
do $$declare identity_key uuid;response jsonb;plan jsonb;before_fingerprint jsonb;begin
 select identity_id into identity_key from private.member_episodes where profile_id=pg_temp.resolution_case_uid(4)and ended_at is null;
 before_fingerprint:=pg_temp.suspension_snapshot();
 begin
  update private.safety_appointment_results set ordering_provenance='unknown',agreed_starts_at=null
   where identity_id=identity_key and appointment_id=(select appointment_id from resolution_due_cases where n=6);
  perform pg_temp.resolution_case_actor(4);perform set_config('role','authenticated',true);
  response:=pg_temp.suspension_call(4);
  perform set_config('role','none',true);
  assert response->>'state'='reviewing'and response->>'resultRevision'='3';
  plan:=private.current_cancellation_sanction_plan(identity_key);
  assert plan->>'status'='ordering_unknown'and plan->'eligibleCount'='null'::jsonb and plan->'provisionalCount'='null'::jsonb;
  assert(select count(*)from private.cancellation_effect_suspensions where identity_id=identity_key and state='active')=2;
  assert not exists(select 1 from private.safety_sanction_applications where identity_id=identity_key and kind in('cancel_warning','cancel_restriction')and revoked_at is null);
  raise exception 'fixture_branch_rollback'using errcode='PT999';
 exception when sqlstate'PT999'then null;end;
 assert pg_temp.suspension_snapshot()=before_fingerprint;
end;$$;

set local role authenticated;select pg_temp.resolution_case_actor(4);
update suspension_appeals set result=pg_temp.suspension_call(n)where n=4;
reset role;
do $$declare identity_key uuid;restriction private.safety_sanction_applications;begin
 select identity_id into identity_key from private.member_episodes where profile_id=pg_temp.resolution_case_uid(4)and ended_at is null;
 select *into strict restriction from private.safety_sanction_applications where id=(select id from suspension_original_applications where kind='cancel_restriction');
 assert restriction.revoked_at is not null and restriction.correction_reason_code='cancellation_review_suspended';
 assert exists(select 1 from private.cancellation_effect_suspensions where application_id=restriction.id and state='active'and restore_sweetness
  and original_applied_at=restriction.applied_at and original_expires_at=restriction.expires_at);
 assert not exists(select 1 from private.effective_safety_subjects(identity_key)where incident_id=restriction.incident_id);
 assert exists(select 1 from private.raw_cancellation_subject(identity_key,restriction.incident_id));
 assert exists(select 1 from private.safety_sanction_applications where id=(select id from suspension_original_applications where kind='cancel_warning')and revoked_at is null);
 assert not exists(select 1 from private.sweetness_incident_decisions d where incident_id=restriction.incident_id and kind='cancel_sanction'and is_valid
  and revision=(select max(latest_decision.revision)from private.sweetness_incident_decisions latest_decision where latest_decision.incident_id=d.incident_id and latest_decision.recipient_episode_id=d.recipient_episode_id and latest_decision.kind=d.kind));
 perform private.recompute_safety_applications(identity_key);
 assert(select revoked_at is not null and correction_reason_code='cancellation_review_suspended'from private.safety_sanction_applications where id=restriction.id);
 perform pg_temp.resolution_case_failure(format('delete from private.safety_sanction_applications where id=%L',restriction.id),'55000');
end;$$;
create temp table suspension_before_replay as select pg_temp.suspension_snapshot()fingerprint;
grant select on suspension_before_replay to authenticated;
set local role authenticated;select pg_temp.resolution_case_actor(4);
do $$begin
 assert pg_temp.suspension_call(4)=(select result||jsonb_build_object('alreadyApplied',true)from suspension_appeals where n=4);
end;$$;
reset role;
do $$begin assert pg_temp.suspension_snapshot()=(select fingerprint from suspension_before_replay);end;$$;
set local role authenticated;select pg_temp.resolution_case_actor(4);
update suspension_appeals set result=pg_temp.suspension_call(n)where n=5;
reset role;
select private.set_report_operator_assignment(pg_temp.resolution_case_uid(3),(result->>'reportId')::uuid,true)from suspension_appeals;
create function pg_temp.suspension_resolve(p_case_number integer,p_mode text,p_report_version bigint,p_result_revision bigint,p_outcome text)
returns jsonb language sql as $$select public.resolve_assigned_appointment_cancel_appeal((result->>'reportId')::uuid,(result->>'appealId')::uuid,
 gen_random_uuid(),p_mode,p_report_version,p_result_revision,0,p_outcome)from suspension_appeals where n=p_case_number;$$;
-- accepted 정정은 filtered helper에 숨겨진 원 confirmed도 확정 철회한다. 별도 subtransaction 전체를 rollback하여 정상 복원 경로도 검사한다.
do $$declare restriction_key uuid;begin
 select id into strict restriction_key from suspension_original_applications where kind='cancel_restriction';
 begin
  perform pg_temp.resolution_case_actor(3);
  perform set_config('role','authenticated',true);
  perform pg_temp.suspension_resolve(4,'initial',1,3,'rejected');
  perform pg_temp.suspension_resolve(4,'correction',2,4,'accepted');
  perform pg_temp.suspension_resolve(5,'initial',1,3,'rejected');
  perform set_config('role','none',true);
  assert(select state='invalidated'from private.cancellation_effect_suspensions where application_id=restriction_key);
  assert(select revoked_at is not null and correction_reason_code='cancellation_exception_corrected'from private.safety_sanction_applications where id=restriction_key);
  assert not exists(select 1 from private.raw_cancellation_subject((select identity_id from suspension_original_applications where id=restriction_key),
   (select incident_id from suspension_original_applications where id=restriction_key)));
  raise exception 'fixture_branch_rollback'using errcode='PT999';
 exception when sqlstate'PT999'then null;end;
 assert(select state='active'from private.cancellation_effect_suspensions where application_id=restriction_key);
end;$$;
set local role authenticated;select pg_temp.resolution_case_actor(3);
select pg_temp.suspension_resolve(4,'initial',1,3,'rejected');
reset role;
do $$begin
 assert(select state='active'from private.cancellation_effect_suspensions where application_id=(select id from suspension_original_applications where kind='cancel_restriction'));
 assert(select revoked_at is not null from private.safety_sanction_applications where id=(select id from suspension_original_applications where kind='cancel_restriction'));
end;$$;
-- 종료된 원회차의 이미 적용됐던 같은 원사건 복원은 최초효과와 구분한다. 실제 탈퇴 Provider 증거는 아니다.
update private.member_episodes set ended_at=clock_timestamp()where profile_id=pg_temp.resolution_case_uid(4)and ended_at is null;
set local role authenticated;select pg_temp.resolution_case_actor(3);
select pg_temp.suspension_resolve(5,'initial',1,3,'rejected');
reset role;
do $$declare identity_key uuid;begin
 select identity_id into identity_key from private.member_episodes where profile_id=pg_temp.resolution_case_uid(4);
 assert not exists(select 1 from suspension_original_applications original_row left join private.safety_sanction_applications current_row on current_row.id=original_row.id
  where current_row.id is null or current_row.applied_at is distinct from original_row.applied_at or current_row.expires_at is distinct from original_row.expires_at
  or current_row.incident_id<>original_row.incident_id or current_row.source_episode_id<>original_row.source_episode_id or current_row.kind<>original_row.kind
  or current_row.revoked_at is not null or current_row.correction_reason_code is not null);
 assert(select expires_at<clock_timestamp()from private.safety_sanction_applications where id=(select id from suspension_original_applications where kind='cancel_restriction'));
 assert(select state='restored'from private.cancellation_effect_suspensions where application_id=(select id from suspension_original_applications where kind='cancel_restriction'));
 assert exists(select 1 from private.sweetness_incident_decisions d where d.incident_id=(select incident_id from suspension_original_applications where kind='cancel_restriction')
  and d.kind='cancel_sanction'and d.is_valid and d.recipient_episode_id=(select source_episode_id from suspension_original_applications where kind='cancel_restriction')
  and d.revision=(select max(latest_decision.revision)from private.sweetness_incident_decisions latest_decision where latest_decision.incident_id=d.incident_id and latest_decision.recipient_episode_id=d.recipient_episode_id and latest_decision.kind=d.kind));
 assert(select to_jsonb(application_row)from private.safety_sanction_applications application_row where application_row.incident_id=(select incident_id from suspension_general_incident))=(select fingerprint from suspension_general_before);
 assert exists(select 1 from private.effective_safety_subjects(identity_key)where incident_id=(select incident_id from suspension_general_incident)and violation_class='major');
 assert(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]'::jsonb)from private.safety_sanction_applications a where a.identity_id<>identity_key)=(select fingerprint from suspension_other_applications);
end;$$;
update private.member_episodes set ended_at=null where profile_id=pg_temp.resolution_case_uid(4);
do $$declare gateway text;begin
 foreach gateway in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  assert not has_table_privilege(gateway,'private.cancellation_effect_suspensions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  assert not has_function_privilege(gateway,'private.suspend_cancellation_suffix(uuid)','EXECUTE');
  assert not has_function_privilege(gateway,'private.restore_cancellation_suffix(uuid,jsonb)','EXECUTE');
 end loop;
end;$$;

revoke execute on function public.enqueue_cancellation_safety_due(integer,uuid),public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid) from service_role;
-- accepted report 상세 파기와 최소 exempt 결과/효과 관계 수명을 분리한다. 실제90d engine 호출은 아니다.
create temp table resolution_minimal_before_purge as select pg_temp.resolution_snapshot()->'heads'heads,pg_temp.resolution_snapshot()->'revisions'revisions,
 pg_temp.resolution_snapshot()->'effects'effects,pg_temp.resolution_snapshot()->'sanctions'sanctions;
delete from private.member_reports where id=(select(result->>'reportId')::uuid from resolution_case_cases where n=3);
do $$declare snapshot jsonb;gateway text;function_row record;begin
 snapshot:=pg_temp.resolution_snapshot();
 assert snapshot->'heads'=(select heads from resolution_minimal_before_purge);
 assert snapshot->'revisions'=(select revisions from resolution_minimal_before_purge);
 assert snapshot->'effects'=(select effects from resolution_minimal_before_purge);
 assert snapshot->'sanctions'=(select sanctions from resolution_minimal_before_purge);
 assert not exists(select 1 from private.member_cancellation_notices where report_id=(select(result->>'reportId')::uuid from resolution_case_cases where n=3));
 assert not exists(select 1 from private.appointment_cancel_resolutions where report_id=(select(result->>'reportId')::uuid from resolution_case_cases where n=3));
 foreach gateway in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  assert not has_function_privilege(gateway,'private.reconcile_cancellation_chain(uuid,uuid)','EXECUTE');
  assert not has_function_privilege(gateway,'public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid)','EXECUTE');
  assert not has_function_privilege(gateway,'public.enqueue_cancellation_safety_due(integer,uuid)','EXECUTE');
  assert not has_table_privilege(gateway,'private.member_cancellation_notices','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
 end loop;
 assert has_function_privilege('authenticated','public.resolve_assigned_appointment_cancel_appeal(uuid,uuid,uuid,text,bigint,bigint,bigint,text)','EXECUTE');
 assert has_function_privilege('authenticated','public.list_my_cancellation_notices(integer,uuid)','EXECUTE');
end;$$;

-- source 함수catalog/roles/worker/guard가변하지않았음을검사한다. 전체fixture는outerROLLBACK한다.
do $$begin
 assert(select external_deletion_approved from private.member_cleanup_guard where singleton)=(select guard from resolution_case_baseline);
 assert(select to_jsonb(g)from private.global_worker_run g where singleton)=(select worker from resolution_case_baseline);
 assert(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.safety_appeals a where kind='general')=(select fingerprint from resolution_case_general_baseline);
end;$$;
rollback;
