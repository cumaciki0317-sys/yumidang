-- 민규: source83 큐 예약 후속 단일 TX 회귀 후보. SQL 합성 자료이며 J/Provider/실제 LISTEN 증거가 아니다.
begin;
set local plpgsql.check_asserts='on';
set local storage.allow_delete_query='true';
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create temp table schedule83_old_functions as select oid,proowner,proacl::text acl,proconfig::text config,prosrc from pg_proc
 where oid in('public.get_my_report(uuid)'::regprocedure,'private.assert_current_worker_job(uuid,uuid,uuid)'::regprocedure,
 'private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure);
create function pg_temp.purge_id(p_number integer)returns uuid language sql immutable as $$select('cf830000-0000-4000-8000-'||lpad(p_number::text,12,'0'))::uuid$$;
create function pg_temp.purge_error(p_command text,p_expected text)returns void language plpgsql as $$declare actual text;begin
 begin execute p_command;exception when others then get stacked diagnostics actual=returned_sqlstate;end;
 assert actual=p_expected,'report_purge_expected_error';
end;$$;
insert into auth.users(id,email)select pg_temp.purge_id(x),'purge-fixture-'||x||'@test.invalid'from generate_series(1,2)x;
insert into public.profiles(id,real_name,birth_date,gender)select pg_temp.purge_id(x),'합성회원','1990-01-01','female'from generate_series(1,2)x;
-- 정확 최소 no_show hold의 report SET NULL/종결시각 보존을 위한 owner 약속 fixture.
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
values(pg_temp.purge_id(60),pg_temp.purge_id(1),'합성 약속','보관 검증','산책',now()+interval '3 days',now()+interval '3 days 2 hours',now()+interval '2 days','서울특별시 강남구 역삼동','recruiting');
insert into public.join_requests(id,post_id,requester_id,message,status)values(pg_temp.purge_id(61),pg_temp.purge_id(60),pg_temp.purge_id(2),'합성 신청','pending');
insert into public.appointments(id,post_id,join_request_id,status,confirmed_at)values(pg_temp.purge_id(62),pg_temp.purge_id(60),pg_temp.purge_id(61),'confirmed',now());
insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,status,hide_target,fingerprint,final_closed_at,retention_due_at)
select pg_temp.purge_id(10+x),pg_temp.purge_id(1),e.id,pg_temp.purge_id(20+x),case x when 1 then 'appointment'else 'member'end,case x when 1 then pg_temp.purge_id(62)else pg_temp.purge_id(2)end,'online',array['other'],'resolved',x=2,repeat('a',64),
 statement_timestamp()-interval '2161 hours',statement_timestamp()-interval '2161 hours'+interval '2160 hours'
from generate_series(1,3)x join private.member_episodes e on e.profile_id=pg_temp.purge_id(1)and e.ended_at is null;
-- 먼저 도래한 숨김 보류 20건이 LIMIT을 소비해 뒤의 eligible 신고를 굶기지 않아야 한다.
insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,status,hide_target,fingerprint,final_closed_at,retention_due_at)
select pg_temp.purge_id(100+x),pg_temp.purge_id(1),e.id,pg_temp.purge_id(200+x),'member',pg_temp.purge_id(2),'online',array['other'],'resolved',true,repeat('a',64),
 statement_timestamp()-interval '2170 hours',statement_timestamp()-interval '2170 hours'+interval '2160 hours'
from generate_series(1,20)x join private.member_episodes e on e.profile_id=pg_temp.purge_id(1)and e.ended_at is null;
insert into private.appointment_review_holds(report_id,appointment_id,state,resolved_at,decision_id)
values(pg_temp.purge_id(11),pg_temp.purge_id(62),'no_show',now(),pg_temp.purge_id(63));
insert into private.member_report_details(report_id,description)select pg_temp.purge_id(10+x),'파기할 합성 설명'from generate_series(1,3)x;
insert into private.report_capture_assets(id,owner_id,owner_episode_id,object_name,state,report_id,uploaded_at)
select pg_temp.purge_id(30+x),pg_temp.purge_id(1),e.id,pg_temp.purge_id(1)::text||'/'||pg_temp.purge_id(30+x)::text||case x when 1 then '.png'else '.webp'end,
 'attached',pg_temp.purge_id(11),clock_timestamp()from generate_series(1,2)x join private.member_episodes e on e.profile_id=pg_temp.purge_id(1)and e.ended_at is null;
insert into storage.objects(id,bucket_id,name,owner_id,metadata)
select pg_temp.purge_id(40+x),'report-evidence',a.object_name,a.owner_id::text,
 jsonb_build_object('mimetype',case x when 1 then 'image/png'else 'image/webp'end,'size',5242880)
from generate_series(1,2)x join private.report_capture_assets a on a.id=pg_temp.purge_id(30+x);

-- 기존 cleanup Storage→Auth 의존과 회전은 합성 metadata로만 검사한다.
insert into private.member_retirements(profile_id,withdrawal_id,episode_id)
 values(pg_temp.purge_id(1),pg_temp.purge_id(910),private.active_member_episode(pg_temp.purge_id(1)));
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,bucket_id,object_name,object_id)
 values(pg_temp.purge_id(911),pg_temp.purge_id(910),'storage_object',pg_temp.purge_id(1),'profile-images',pg_temp.purge_id(1)::text||'/synthetic.jpg',pg_temp.purge_id(912)),
 (pg_temp.purge_id(913),pg_temp.purge_id(910),'auth_user',pg_temp.purge_id(1),null,null,null);
create temp table schedule83_cleanup_signatures(signature text);
insert into schedule83_cleanup_signatures values('public.claim_member_cleanup_task(uuid)'),('public.check_member_cleanup_task(uuid,uuid,uuid,uuid)'),
 ('public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)'),('public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)'),('public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)');
create temp table schedule83_function_acl as select oid,proowner,proacl::text acl,proconfig::text config from pg_proc where pronamespace in('public'::regnamespace,'private'::regnamespace);
create temp table schedule83_role_state as select md5(jsonb_agg(to_jsonb(r)order by oid)::text)hash from pg_roles r;
create temp table schedule83_member_state as select md5(coalesce(jsonb_agg(to_jsonb(m)order by roleid,member,grantor),'[]'::jsonb)::text)hash from pg_auth_members m;
create temp table schedule83_signatures(kind text,signature text);
insert into schedule83_signatures values
 ('cancellation_safety','public.enqueue_cancellation_safety_due(integer,uuid)'),
 ('cancellation_safety','public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid)'),
 ('report_retention','public.enqueue_report_retention_purges(uuid,integer)'),
 ('report_retention','public.claim_report_retention_task(uuid,uuid,uuid)'),
 ('report_retention','public.check_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid)'),
 ('report_retention','public.get_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid)'),
 ('report_retention','public.record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text)'),
 ('report_retention','public.complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)'),
 ('report_retention','public.purge_report_retention_terminal_receipts(uuid,integer)'),
 ('report_retention','public.begin_report_retention_delete(uuid,uuid,uuid,uuid,uuid,uuid)');
insert into private.naver_accounts(subject,real_name,birth_date,gender,verification_status)
 values('schedule83-due-synthetic','합성회원','1990-01-01','female','qualified');
-- naver_accounts INSERT의 실제 identity 생성 trigger가 만든 식별값을 사용한다.
create function pg_temp.schedule83_identity()returns uuid language sql as $$select id from private.naver_identity_keys where subject='schedule83-due-synthetic'$$;
insert into private.cancellation_safety_due(identity_id,generation,next_due_at)values(pg_temp.schedule83_identity(),1,clock_timestamp()-interval '2 hours');
create temp table schedule83_context(global_token uuid,review_job uuid,cancel_job uuid,report_job uuid);
create function pg_temp.schedule83_snapshot()returns jsonb language sql as $$select jsonb_build_object(
 'jobs',(select coalesce(jsonb_agg(to_jsonb(j)order by id),'[]')from private.worker_jobs j),
 'tasks',(select coalesce(jsonb_agg(to_jsonb(t)order by id),'[]')from private.report_purge_tasks t),
 'dispatch',(select coalesce(jsonb_agg(to_jsonb(d)order by task_id),'[]')from private.report_purge_dispatches d),
 'acks',(select coalesce(jsonb_agg(to_jsonb(a)order by id),'[]')from private.report_purge_delete_acks a),
 'global',(select to_jsonb(g)from private.global_worker_run g where singleton));$$;
do $$declare result jsonb;sig text;token uuid;report_job uuid;review_job uuid;before_state jsonb;
 excluded text[]:=array['review_summary','event_sync','member_cleanup'];begin
 assert current_setting('plpgsql.check_asserts')='on';
 assert (select enabled from private.report_purge_control where singleton)is false;
 assert (select enabled from private.cancellation_due_control where singleton)is false;
 result:=public.read_worker_queue_schedule(excluded,null);assert result->'nextKind'='null'::jsonb;
 perform pg_temp.purge_error('select public.read_worker_queue_schedule(null,null)','22023');
 perform pg_temp.purge_error('select public.read_worker_queue_schedule(array[''report_retention'',null],null)','22023');
 perform pg_temp.purge_error('select public.read_worker_queue_schedule(array[''future''],null)','22023');
 perform pg_temp.purge_error('select public.read_worker_queue_schedule(array[[''report_retention'']],null)','22023');
 perform pg_temp.purge_error('select public.read_worker_queue_schedule(array[''review_summary'',''event_sync'',''member_cleanup'',''cancellation_safety'',''report_retention'',''review_summary''],null)','22023');
 perform pg_temp.purge_error('select public.read_worker_queue_schedule(''{}'',''future'')','22023');
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 perform pg_temp.purge_error('select public.read_worker_queue_schedule()','42501');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 -- control true만으로는 후보가 노출되지 않는다. 모든 exact EXEC가 필요하다.
 update private.report_purge_control set enabled=true where singleton;
 update private.cancellation_due_control set enabled=true where singleton;
 assert public.read_worker_queue_schedule(excluded,null)->'nextKind'='null'::jsonb;
 for sig in select signature from schedule83_signatures loop execute format('grant execute on function %s to service_role',sig);end loop;
 assert public.read_worker_queue_schedule(excluded,null)->>'nextKind'='cancellation_safety';
 assert public.read_worker_queue_schedule(excluded,'cancellation_safety')->>'nextKind'='report_retention';
 -- 준비 안 된 종류는 제외되고 원 자료/점유는 바뀌지 않는다.
 for sig in select signature from schedule83_signatures where kind='cancellation_safety'loop
  execute format('revoke execute on function %s from service_role',sig);
  before_state:=pg_temp.schedule83_snapshot();result:=public.read_worker_queue_schedule(array['review_summary','event_sync','member_cleanup','report_retention'],null);
  assert result->'nextKind'='null'::jsonb and pg_temp.schedule83_snapshot()=before_state;
  execute format('grant execute on function %s to service_role',sig);
 end loop;
 for sig in select signature from schedule83_signatures where kind='report_retention'loop
  execute format('revoke execute on function %s from service_role',sig);
  before_state:=pg_temp.schedule83_snapshot();result:=public.read_worker_queue_schedule(array['review_summary','event_sync','member_cleanup','cancellation_safety'],null);
  assert result->'nextKind'='null'::jsonb and pg_temp.schedule83_snapshot()=before_state;
  execute format('grant execute on function %s to service_role',sig);
 end loop;
 delete from private.report_purge_control;
 assert public.read_worker_queue_schedule(array['review_summary','event_sync','member_cleanup','cancellation_safety'],null)->'nextKind'='null'::jsonb;
 insert into private.report_purge_control values(true,false);
 assert public.read_worker_queue_schedule(array['review_summary','event_sync','member_cleanup','cancellation_safety'],null)->'nextKind'='null'::jsonb;
 update private.report_purge_control set enabled=true;
 delete from private.cancellation_due_control;
 assert public.read_worker_queue_schedule(array['review_summary','event_sync','member_cleanup','report_retention'],null)->'nextKind'='null'::jsonb;
 insert into private.cancellation_due_control values(true,false);
 assert public.read_worker_queue_schedule(array['review_summary','event_sync','member_cleanup','report_retention'],null)->'nextKind'='null'::jsonb;
 update private.cancellation_due_control set enabled=true;
 -- 신고 미래 보관기한도 예약된다. 도래한 것만 읽으면 이 timer를 놓친다.
 begin
  update private.member_reports set final_closed_at=statement_timestamp()-interval '2159 hours',retention_due_at=statement_timestamp()-interval '2159 hours'+interval '2160 hours'where id=pg_temp.purge_id(11);
  update private.member_reports set hide_target=true where id=pg_temp.purge_id(13);
  result:=public.read_worker_queue_schedule(array['review_summary','event_sync','member_cleanup','cancellation_safety'],null);
  assert result->>'nextKind'='report_retention'and(result->>'nextDueAt')::timestamptz>(result->>'serverNow')::timestamptz;
  assert(result->>'nextDueAt')::timestamptz=(select retention_due_at from private.member_reports where id=pg_temp.purge_id(11));
  raise exception 'fixture_restore'using errcode='P0001';
 exception when raise_exception then null;end;
 token:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 assert token is not null;
 perform public.enqueue_report_retention_purges(token,20);
 select id into strict report_job from private.worker_jobs where kind='report_retention'and payload->>'reportId'=pg_temp.purge_id(11)::text;
 insert into private.worker_jobs(kind,dedupe_key,payload,available_at)values('review_summary','schedule83-review',
 jsonb_build_object('profileId',pg_temp.purge_id(2),'sourceRevision','0','modelVersion','synthetic','promptVersion','synthetic'),clock_timestamp()-interval '3 hours')returning id into review_job;
 insert into schedule83_context(global_token,review_job,report_job)values(token,review_job,report_job);
 -- 조회가 global expiry를 연장하거나 점유하지 않는다.
 before_state:=pg_temp.schedule83_snapshot();result:=public.read_worker_queue_schedule();
 assert result->>'nextKind'='review_summary';
 assert(result->>'nextDueAt')::timestamptz=(select expires_at from private.global_worker_run where singleton);
 assert pg_temp.schedule83_snapshot()=before_state;
 perform public.release_worker_run(token);
end;$$;

do $$declare result jsonb;v_cancel_job uuid;v_report_job uuid;v_review_job uuid;sig text;before_state jsonb;task_row private.report_purge_tasks;
 except_cancel text[]:=array['review_summary','event_sync','member_cleanup','report_retention'];
 except_report text[]:=array['review_summary','event_sync','member_cleanup','cancellation_safety'];begin
 select c.review_job,c.report_job into v_review_job,v_report_job from schedule83_context c;
 -- 기존3 회전 순서를 유지한다. event_slot DBkind gap은 그대로다.
 update private.member_cleanup_guard set external_deletion_approved=true where singleton;
 for sig in select signature from schedule83_cleanup_signatures loop execute format('grant execute on function %s to service_role',sig);end loop;
 assert public.read_worker_queue_schedule('{}','report_retention')->>'nextKind'='review_summary';
 assert public.read_worker_queue_schedule('{}','review_summary')->>'nextKind'='member_cleanup';
 assert public.read_worker_queue_schedule('{}','member_cleanup')->>'nextKind'='cancellation_safety';
 assert public.read_worker_queue_schedule('{}','cancellation_safety')->>'nextKind'='report_retention';
 assert public.read_worker_queue_schedule(array['review_summary','event_sync','member_cleanup','cancellation_safety','report_retention'],null)->'nextDueAt'='null'::jsonb;
 -- 사진이 running이면 pending Auth가 먼저 즉시 선택되지 않는다.
 update private.member_cleanup_tasks set state='running',lease_token=pg_temp.purge_id(914),worker_run_token=pg_temp.purge_id(915),lease_expires_at=statement_timestamp()+interval '30 seconds'where id=pg_temp.purge_id(911);
 result:=public.read_worker_queue_schedule(array['review_summary','event_sync','cancellation_safety','report_retention'],null);
 assert(result->>'nextDueAt')::timestamptz=(select lease_expires_at from private.member_cleanup_tasks where id=pg_temp.purge_id(911));
 -- raw next_due_at의 past 값이 기존 retry/running 기한보다 앞서 hot loop를 만들지 않는다.
 insert into private.worker_jobs(kind,dedupe_key,payload,status,available_at)values('cancellation_safety','cancellation_safety:'||pg_temp.schedule83_identity()::text||':1',
 jsonb_build_object('identityId',pg_temp.schedule83_identity(),'generation',1),'retry_wait',clock_timestamp()+interval '30 seconds')returning id into v_cancel_job;
 update schedule83_context set cancel_job=v_cancel_job;
 result:=public.read_worker_queue_schedule(except_cancel,null);
 assert(result->>'nextDueAt')::timestamptz=(select available_at from private.worker_jobs where id=v_cancel_job);
 update private.worker_jobs set status='running',worker_id=pg_temp.purge_id(901),lease_token=pg_temp.purge_id(902),lease_expires_at=clock_timestamp()+interval '40 seconds'where id=v_cancel_job;
 result:=public.read_worker_queue_schedule(except_cancel,null);
 assert(result->>'nextDueAt')::timestamptz=(select lease_expires_at from private.worker_jobs where id=v_cancel_job);
 update private.worker_jobs set status='succeeded',completed_at=clock_timestamp(),worker_id=null,lease_token=null,lease_expires_at=null where id=v_cancel_job;
 assert public.read_worker_queue_schedule(except_cancel,null)->'nextKind'='null'::jsonb;
 -- ended same generation 재생성 계약은 후속이다. 원 job은 재생성/상태변경하지 않는다.
 -- UNKNOWN 원 intent는 expired running 부모도 후보에서 제외하고 예약을 유지한다.
 begin
  select t.*into strict task_row from private.report_purge_tasks t join private.report_purge_closures c on c.id=t.closure_id where c.report_id=pg_temp.purge_id(11)and t.kind='storage_object'order by t.id limit 1;
  insert into private.report_purge_dispatches(task_id,closure_id,asset_id,object_id,task_lease_token,job_id,job_lease_token,worker_run_token)
   values(task_row.id,task_row.closure_id,task_row.asset_id,task_row.object_id,pg_temp.purge_id(903),v_report_job,pg_temp.purge_id(904),pg_temp.purge_id(905));
  update private.worker_jobs set status='running',worker_id=pg_temp.purge_id(901),lease_token=pg_temp.purge_id(904),lease_expires_at=clock_timestamp()-interval '1 second'where id=v_report_job;
  -- 다른 적격 신고는 정확 합성 hide 전이로 제외한다.
  update private.member_reports set hide_target=true where id=pg_temp.purge_id(13);
  before_state:=pg_temp.schedule83_snapshot();result:=public.read_worker_queue_schedule(except_report,null);
  assert result->'nextKind'='null'::jsonb and pg_temp.schedule83_snapshot()=before_state;
  assert exists(select 1 from private.report_purge_dispatches where task_id=task_row.id);
  -- owner 합성 ACK metadata로 예약 재개 조건만 확인한다. Provider 성공 증거가 아니다.
  insert into private.report_purge_delete_acks(task_id,asset_id,object_id,ack_sha256)values(task_row.id,task_row.asset_id,task_row.object_id,repeat('a',64));
  result:=public.read_worker_queue_schedule(except_report,null);assert result->>'nextKind'='report_retention';
  assert(result->>'nextDueAt')::timestamptz=(select lease_expires_at from private.worker_jobs where id=v_report_job);
  raise exception 'fixture_restore'using errcode='P0001';
 exception when raise_exception then null;end;
 -- 통지에 식별자와 원문을 포함하지 않는다.
 assert(select prosrc not ilike '%new.%'and prosrc not ilike '%old.%'from pg_proc where oid='private.notify_worker_queue_changed()'::regprocedure);
 assert(select count(*)from pg_trigger where not tgisinternal and tgname like 'worker_queue_retention_%')=15;
 assert not exists(select 1 from pg_trigger where tgname like 'worker_queue_retention_%'and(tgtype&1)<>0),'statement_wake_only';
 assert not exists(select 1 from pg_trigger where tgname like 'worker_queue_retention_%'and tgfoid<>'private.notify_worker_queue_changed()'::regprocedure);
end;$$;
-- 임시 준비권한은 owner fixture 안에서만 열었고 최종 ROLLBACK으로 원복한다.
do $$declare sig text;begin
 for sig in select signature from schedule83_signatures loop execute format('revoke execute on function %s from service_role',sig);end loop;
 for sig in select signature from schedule83_cleanup_signatures loop execute format('revoke execute on function %s from service_role',sig);end loop;
 update private.member_cleanup_guard set external_deletion_approved=false where singleton;
 update private.report_purge_control set enabled=false;
 update private.cancellation_due_control set enabled=false;
 assert not exists(select 1 from schedule83_function_acl b join pg_proc p on p.oid=b.oid where p.proowner<>b.proowner or p.proacl::text is distinct from b.acl or p.proconfig::text is distinct from b.config);
 assert(select hash from schedule83_role_state)=(select md5(jsonb_agg(to_jsonb(r)order by oid)::text)from pg_roles r);
 assert(select hash from schedule83_member_state)=(select md5(coalesce(jsonb_agg(to_jsonb(m)order by roleid,member,grantor),'[]'::jsonb)::text)from pg_auth_members m);
end;$$;
rollback;
