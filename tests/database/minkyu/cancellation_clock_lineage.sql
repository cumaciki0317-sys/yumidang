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

-- 원 시작 시각이 새 적용 시각과 다름을 확인하는 합성 fixture.
update private.safety_sanction_applications set applied_at=applied_at-interval'3 hours',expires_at=expires_at-interval'3 hours'where id in(select id from resolution_original_effects);
update resolution_original_effects set applied_at=applied_at-interval'3 hours',expires_at=expires_at-interval'3 hours';
set local role authenticated;select pg_temp.resolution_case_actor(3);
select pg_temp.resolution_call(3,gen_random_uuid(),'correction',2,4,1,'accepted');
reset role;
create temp table clock_inputs as select jsonb_agg(jsonb_build_object('anchorAppointmentId',x->>'anchorAppointmentId','predecessorApplicationId',o.id)order by x->>'anchorAppointmentId')mappings
 from jsonb_array_elements(private.current_cancellation_sanction_plan(pg_temp.resolution_identity())->'actions')x join resolution_original_effects o on o.kind=x->>'kind';
grant select on clock_inputs to authenticated;
set local role authenticated;select pg_temp.resolution_case_actor(3);
do $$declare rid uuid;state jsonb;response jsonb;k uuid:=gen_random_uuid();m jsonb;begin
 select(result->>'reportId')::uuid into strict rid from resolution_case_cases where n=3;
 state:=public.get_assigned_cancellation_clock_state(rid);assert state->>'reportVersion'='3'and jsonb_array_length(state->'actions')=2;
 select mappings into strict m from clock_inputs;
 perform pg_temp.resolution_case_failure(format('select public.repair_assigned_cancellation_clocks(%L,gen_random_uuid(),3,%L,%L)',rid,repeat('0',64),m),'40001');
 perform pg_temp.resolution_case_failure(format('select public.repair_assigned_cancellation_clocks(%L,gen_random_uuid(),3,%L,%L)',rid,state->>'planFingerprint','[]'),'22023');
 -- 신규 명시에는 기존 시각을 사용하지 않는다. 합성 하위 TX만 되돌린다.
 begin
  response:=public.repair_assigned_cancellation_clocks(rid,gen_random_uuid(),3,state->>'planFingerprint',(select jsonb_agg(jsonb_build_object('anchorAppointmentId',x->>'anchorAppointmentId','predecessorApplicationId',null))from jsonb_array_elements(m)x));
  perform set_config('role','none',true);
  assert not exists(select 1 from private.cancellation_clock_lineage where identity_id=pg_temp.resolution_identity()and(predecessor_application_id is not null or applied_at<(select max(applied_at)+interval'2 hours'from resolution_original_effects)));
  raise exception 'fixture_new_branch_rollback'using errcode='PT999';
 exception when sqlstate'PT999'then null;end;
 response:=public.repair_assigned_cancellation_clocks(rid,k,3,state->>'planFingerprint',m);
 assert response->>'reportVersion'='4'and response->>'repairedCount'='2';
 assert public.repair_assigned_cancellation_clocks(rid,k,3,state->>'planFingerprint',m)=response||jsonb_build_object('alreadyApplied',true);
end;$$;
reset role;
do $$declare plan jsonb;before_state jsonb;begin
 assert(select count(*)=2 from private.cancellation_clock_lineage where identity_id=pg_temp.resolution_identity());
 assert not exists(select 1 from private.cancellation_clock_lineage l join private.safety_sanction_applications a on a.id=l.destination_application_id join resolution_original_effects o on o.id=l.predecessor_application_id
 where a.applied_at is distinct from o.applied_at or a.expires_at is distinct from o.expires_at or a.source_episode_id is distinct from o.source_episode_id);
 perform pg_temp.resolution_case_failure(format('delete from private.safety_sanction_applications where id=%L',(select id from resolution_original_effects where kind='cancel_restriction')),'55000');
 assert not has_function_privilege('service_role','public.repair_assigned_cancellation_clocks(uuid,uuid,bigint,text,jsonb)','EXECUTE');
 assert not has_table_privilege('authenticated','private.cancellation_clock_lineage','SELECT,INSERT,UPDATE,DELETE');
 assert(select policy_pending_code is null from private.cancellation_safety_due where identity_id=pg_temp.resolution_identity());
 select jsonb_agg(to_jsonb(a)order by id)into before_state from private.safety_sanction_applications a;
 perform private.lock_cancellation_identity(pg_temp.resolution_identity());plan:=private.reconcile_cancellation_chain(pg_temp.resolution_identity(),pg_temp.resolution_case_uid(3));
 assert plan->>'policyPending'is null;
 assert(select jsonb_agg(to_jsonb(a)order by id)from private.safety_sanction_applications a)=before_state;
end;$$;
rollback;
