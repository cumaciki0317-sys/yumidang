-- 민규: 최신 요약 계약의 실제 역할·전역 점유·동의·300자 검증. 합성 자료만 사용하고 전체 rollback.
begin;
set local plpgsql.check_asserts=on;
-- SQL109 효과 포트는 service_role 직접 호출을 닫는다. 격리 시험 역할만
-- 정확한 함수에 연결하며 역할·멤버십·ACL·guard·fixture는 전부 rollback한다.
create role ym_summary_fence_synthetic login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant ym_summary_fence_synthetic to postgres with admin false, inherit false, set true;
grant usage on schema public to ym_summary_fence_synthetic;
grant execute on function public.acquire_worker_run(integer,uuid),
 public.enqueue_job(text,text,jsonb,timestamptz),public.claim_job(uuid,integer,uuid),
 public.prepare_queue_invocation(uuid,uuid,text,integer,integer),
 public.claim_queue_invocation_dispatch(uuid,uuid,text,integer,integer),
 public.load_review_summary_source(uuid,uuid,uuid,text),
 public.load_review_summary_checkpoint(uuid,uuid,text,uuid,text),
 public.save_review_summary_checkpoint(uuid,uuid,text,jsonb,uuid,text),
 public.discard_review_summary_checkpoint(uuid,uuid,text,uuid,text),
 public.mark_review_summary_insufficient(uuid,uuid,text,uuid,text),
 public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)
 to ym_summary_fence_synthetic;
update private.worker_runtime_atomic_control set enabled=true where singleton;
update private.worker_invocation_control set enabled=true where singleton;
create function pg_temp.summary_uid(n integer) returns uuid language sql immutable as $$
 select ('73000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.summary_actor(n integer) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',pg_temp.summary_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.summary_uid(n))::text,true);
end; $$;
create function pg_temp.summary_expect(command text,expected text[]) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=any(expected),'unexpected common connection state';
end; $$;
-- 기존 완료된 합성 약속: 한마디3개+한마디없는평가1개. 비네이버 후속 조회/후기 이력을 유지한다.
do $$ declare i integer;p uuid;r uuid;ap uuid;begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into auth.users(id) values(pg_temp.summary_uid(1)),(pg_temp.summary_uid(2)),(pg_temp.summary_uid(3));
 insert into public.profiles(id,real_name,birth_date,gender,bio) values
  (pg_temp.summary_uid(1),'합성 후기작성자','1990-01-01','female','합성 소개'),
  (pg_temp.summary_uid(2),'합성 요약대상자','1990-01-01','female','합성 소개'),
  (pg_temp.summary_uid(3),'합성 공개조회자','1990-01-01','female',null);
 for i in 1..4 loop
  p:=gen_random_uuid();r:=gen_random_uuid();ap:=gen_random_uuid();
  insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
   values(p,pg_temp.summary_uid(1),'합성 공통 연결','로컬 검증 자료','산책',now()-interval '12 days',now()-interval '11 days',now()-interval '13 days','서울특별시 강남구 역삼동','closed');
  insert into public.join_requests(id,post_id,requester_id,message,status) values(r,p,pg_temp.summary_uid(2),'합성 공통 연결 후기 자료입니다','matched');
  insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
   values(ap,p,r,'completed',now()-interval '10 days','automatic',now()-interval '10 days',now()-interval '9 days',now()-interval '3 days');
  insert into public.appointment_reviews(appointment_id,reviewer_id,rating,comment,experience)
   values(ap,pg_temp.summary_uid(1),5,case when i<4 then 'COMMON_SYNTHETIC_REVIEW_'||i else null end,'positive');
 end loop;
end $$;

-- 선택한 synthetic 계정만 처리 허용한다. 전역 외부 전송 guard는 실제 외부 호출 없이 rollback된다.
insert into private.ai_member_processing(user_id,summary_allowed)
  values(pg_temp.summary_uid(1),true),(pg_temp.summary_uid(2),true),(pg_temp.summary_uid(3),true);
update private.ai_processing_guard set external_processing_allowed=true where singleton;
create temp table summary_fence_probe(job_id uuid,lease uuid,run_token uuid,revision text,ids uuid[],checkpoint jsonb,published jsonb,invocation_id uuid);
grant all on summary_fence_probe to ym_summary_fence_synthetic;

do $$ declare fn text;begin
  foreach fn in array array['public.load_review_summary_source(uuid,uuid)',
    'public.load_review_summary_checkpoint(uuid,uuid,text)','public.save_review_summary_checkpoint(uuid,uuid,text,jsonb)',
    'public.discard_review_summary_checkpoint(uuid,uuid,text)','public.mark_review_summary_insufficient(uuid,uuid,text)',
    'public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text)',
    'public.load_public_review_snapshot(uuid)','public.publish_review_summary(uuid,text,uuid[],text,text,text)'] loop
    assert not has_function_privilege('service_role',fn,'EXECUTE'),fn;
  end loop;
  assert not has_function_privilege('anon','public.load_review_summary_source(uuid,uuid,uuid,text)','EXECUTE');
  assert not has_function_privilege('authenticated','public.load_review_summary_source(uuid,uuid,uuid,text)','EXECUTE');
  assert not has_function_privilege('service_role','public.mark_review_summary_insufficient(uuid,uuid,text,uuid,text)','EXECUTE');
  assert not has_function_privilege('service_role','public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)','EXECUTE');
  assert not has_schema_privilege('ym_summary_fence_synthetic','private','USAGE');
  assert not has_table_privilege('ym_summary_fence_synthetic','private.worker_invocations','SELECT');
end $$;

-- owner는 합성 fixture 원문 집합/revision 준비만 수행한다. worker검증은 실제 service_role로 한다.
do $$ declare s jsonb; ids uuid[]; cp jsonb;begin
  s:=private.refresh_review_summary_state(pg_temp.summary_uid(2));
  assert s->>'eligibleCount'='3';
  select array_agg((v->>'reviewId')::uuid order by v->>'reviewId') into ids from jsonb_array_elements(s->'reviews') v;
  cp:=jsonb_build_object('schemaVersion',1,'sourceReviewIds',to_jsonb(ids),'nextReviewIndex',1,'nodes',jsonb_build_array(
    jsonb_build_object('sourceReviewIds',to_jsonb(ids[1:1]),'claims',jsonb_build_array(jsonb_build_object('text','합성 중간 주장','evidenceIds',to_jsonb(ids[1:1]))),
    'modelVersions',jsonb_build_array('synthetic.model'))));
  insert into summary_fence_probe(revision,ids,checkpoint) values(s->>'sourceRevision',ids,cp);
end $$;
set local role ym_summary_fence_synthetic;
do $$ declare f summary_fence_probe; s jsonb; j uuid; run uuid; t uuid; x jsonb; invocation uuid:=gen_random_uuid(); begin
  assert current_user='ym_summary_fence_synthetic';
  select * into f from summary_fence_probe;
  run:=(public.acquire_worker_run(180,null)->>'token')::uuid;
  j:=(public.enqueue_job('review_summary','current-summary-fences',jsonb_build_object('profileId',pg_temp.summary_uid(2),
    'sourceRevision',f.revision,'modelVersion','summary-model','promptVersion','summary-prompt'),clock_timestamp())->>'jobId')::uuid;
  x:=public.prepare_queue_invocation(invocation,run,'review_summary',1,180000);
  assert x->>'state'='prepared' and x->>'fresh'='true';
  assert public.claim_queue_invocation_dispatch(invocation,run,'review_summary',1,180000)->>'claimed'='true';
  assert public.claim_queue_invocation_dispatch(invocation,run,'review_summary',1,180000)->>'claimed'='false';
  s:=public.claim_job(gen_random_uuid(),180,run)->'job';
  assert (s->>'jobId')::uuid=j;
  t:=(s->>'leaseToken')::uuid;
  update summary_fence_probe set job_id=j,lease=t,run_token=run,invocation_id=invocation;
  assert public.load_review_summary_source(j,t,gen_random_uuid(),'2026-10-05')='{"status":"lease_lost"}'::jsonb;
  perform pg_temp.summary_expect(format('select public.load_review_summary_source(%L,%L,%L,%L)',j,t,run,'older'),array['22023']);
  s:=public.load_review_summary_source(j,t,run,'2026-10-05');
  assert s->>'status'='applied' and s->>'processingAllowed'='true';
  assert (select count(*) from jsonb_object_keys(s))=6,'current J source wire keys';
  assert public.load_review_summary_checkpoint(j,t,f.revision,run,'2026-10-05')='{"status":"applied","checkpoint":null}'::jsonb;
  assert public.save_review_summary_checkpoint(j,t,f.revision,f.checkpoint,run,'2026-10-05')->>'status'='applied';
  assert public.load_review_summary_checkpoint(j,t,f.revision,run,'2026-10-05')->'checkpoint' is not null;
  assert public.discard_review_summary_checkpoint(j,t,f.revision,run,'2026-10-05')->>'status'='applied';
  assert public.save_review_summary_checkpoint(j,t,f.revision,f.checkpoint,run,'2026-10-05')->>'status'='applied';
  assert public.mark_review_summary_insufficient(j,t,f.revision,run,'2026-10-05')->>'status'='invalid_evidence';
  perform pg_temp.summary_expect(format('select public.publish_review_summary_for_job(%L,%L,%L,%L::uuid[],%L,%L,%L,%L,%L)',
    j,t,f.revision,f.ids,repeat('가',301),'summary-model','summary-prompt',run,'2026-10-05'),array['22023']);
end $$;
reset role;

-- 외부 전송 보류에서는 source/checkpoint가 원문/중간 내용을 반환하지 않는다.
update private.ai_processing_guard set external_processing_allowed=false where singleton;
set local role ym_summary_fence_synthetic;
do $$ declare f summary_fence_probe; begin
  select * into f from summary_fence_probe;
  perform pg_temp.summary_expect(format('select public.load_review_summary_source(%L,%L,%L,%L)',
    f.job_id,f.lease,f.run_token,'2026-10-05'),array['55000']);
  perform pg_temp.summary_expect(format('select public.load_review_summary_checkpoint(%L,%L,%L,%L,%L)',
    f.job_id,f.lease,f.revision,f.run_token,'2026-10-05'),array['55000']);
end $$;
reset role;
do $$ declare f summary_fence_probe;begin
  select * into f from summary_fence_probe;
  assert (select checkpoint from private.review_summary_checkpoints where job_id=f.job_id)=f.checkpoint,'approval hold changed checkpoint';
  assert (select status from private.worker_jobs where id=f.job_id)='running','approval hold ended job';
  assert not exists(select 1 from private.review_summary_job_publications where job_id=f.job_id),'unapproved processing published';
end $$;
update private.ai_processing_guard set external_processing_allowed=true where singleton;
set local role ym_summary_fence_synthetic;
do $$ declare f summary_fence_probe; x jsonb;begin
  select * into f from summary_fence_probe;
  x:=public.publish_review_summary_for_job(f.job_id,f.lease,f.revision,f.ids,'합성 최신 공개 요약','summary-model','summary-prompt',f.run_token,'2026-10-05');
  assert x->>'status'='applied';
  assert (select count(*) from jsonb_object_keys(x))=5,'current J publish wire keys';
  assert public.publish_review_summary_for_job(f.job_id,f.lease,f.revision,f.ids,'재시도 중복 요약','summary-model','summary-prompt',f.run_token,'2026-10-05')=x;
  assert public.load_review_summary_source(f.job_id,f.lease,f.run_token,'2026-10-05')->>'status'='already_published';
  update summary_fence_probe set published=x;
end $$;
reset role;
do $$declare f summary_fence_probe;begin
 select * into f from summary_fence_probe;
 assert (select dispatch_started and claim_calls=1 and state='prepared' from private.worker_invocations where request_id=f.invocation_id);
 assert (select effect='published' and settled_status is null from private.worker_invocation_jobs where request_id=f.invocation_id and job_id=f.job_id and job_lease_token=f.lease);
 assert (select count(*)=1 from private.worker_runtime_job_slots where global_token=f.run_token);
end;$$;
set local role authenticated;
do $$ begin
  perform pg_temp.summary_actor(1);
  assert public.withdraw_my_ai_processing('review_summary')->>'withdrawn'='true';
end $$;
reset role;
do $$ declare f summary_fence_probe; s jsonb;begin
  select * into f from summary_fence_probe;
  s:=private.refresh_review_summary_state(pg_temp.summary_uid(2));
  assert s->>'eligibleCount'='0','withdrawn author remains in evidence';
  assert s->>'sourceRevision'<>f.revision,'author withdrawal did not change revision';
  assert not exists(select 1 from private.review_summary_state where profile_id=pg_temp.summary_uid(2) and visible_summary_id is not null);
end $$;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role ym_summary_fence_synthetic;
do $$ declare f summary_fence_probe;begin
  select * into f from summary_fence_probe;
  assert public.load_review_summary_source(f.job_id,f.lease,f.run_token,'2026-10-05')->>'status'='stale_revision';
  assert public.load_review_summary_checkpoint(f.job_id,f.lease,f.revision,f.run_token,'2026-10-05')->>'status'='stale_revision';
end $$;
reset role;
update private.ai_member_processing set summary_allowed=false where user_id=pg_temp.summary_uid(2);
set local role ym_summary_fence_synthetic;
do $$ declare f summary_fence_probe; begin
  select * into f from summary_fence_probe;
  assert public.load_review_summary_source(f.job_id,f.lease,f.run_token,'2026-10-05')='{"status":"stale_revision"}'::jsonb;
  assert public.publish_review_summary_for_job(f.job_id,f.lease,f.revision,f.ids,'금지된 합성 재게시','summary-model','summary-prompt',f.run_token,'2026-10-05')->>'status'='stale_revision';
  assert public.discard_review_summary_checkpoint(f.job_id,f.lease,f.revision,f.run_token,'2026-10-05')->>'status'='applied';
end $$;
reset role;
update private.ai_member_processing set summary_allowed=true where user_id=pg_temp.summary_uid(2);
update private.global_worker_run set expires_at=clock_timestamp()-interval '1 second' where singleton;
set local role ym_summary_fence_synthetic;
do $$ declare f summary_fence_probe; begin
  select * into f from summary_fence_probe;
  assert public.load_review_summary_source(f.job_id,f.lease,f.run_token,'2026-10-05')='{"status":"lease_lost"}'::jsonb;
  assert public.discard_review_summary_checkpoint(f.job_id,f.lease,f.revision,f.run_token,'2026-10-05')->>'status'='lease_lost';
end $$;
reset role;
rollback;
do $$begin
 assert not exists(select 1 from pg_roles where rolname='ym_summary_fence_synthetic');
 assert not has_function_privilege('service_role','public.mark_review_summary_insufficient(uuid,uuid,text,uuid,text)','EXECUTE');
 assert not has_function_privilege('service_role','public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)','EXECUTE');
 assert (select not enabled from private.worker_invocation_control where singleton);
 assert (select not enabled from private.worker_runtime_atomic_control where singleton);
end;$$;
