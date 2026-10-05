-- 원문/외부호출 없는 합성 DB 검증. 승인은 transaction fixture이며 운영 활성화가 아니다.
begin;
create function pg_temp.ai_uid(n integer) returns uuid language sql immutable as $$
 select ('b1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.ai_expect(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,'unexpected AI RPC result';
end;$$;
insert into auth.users(id) values(pg_temp.ai_uid(1)),(pg_temp.ai_uid(2)),(pg_temp.ai_uid(3));
insert into public.profiles(id,real_name,birth_date,gender)
 values(pg_temp.ai_uid(1),'합성하나','1990-01-01','female'),(pg_temp.ai_uid(2),'합성둘','1990-01-01','female'),(pg_temp.ai_uid(3),'합성셋','1990-01-01','female');
insert into private.ai_member_processing(user_id,exploration_allowed,summary_allowed)
 select pg_temp.ai_uid(i),true,true from generate_series(1,3)i;
create temp table ai_probes(name text primary key,request_id uuid,token uuid);
grant all on ai_probes to service_role;
set local role service_role;
do $$ declare id uuid:=gen_random_uuid();a jsonb;b jsonb;begin
 perform public.configure_ai_budget_ledger('synthetic-ai-atomic',100000,1000);
 a:=public.acquire_ai_chat_request(pg_temp.ai_uid(1),id,'synthetic-first',null,'2026-10-05');
 assert a->>'status'='acquired';
 insert into ai_probes values('first',id,(a->>'leaseToken')::uuid);
 b:=public.acquire_ai_chat_request(pg_temp.ai_uid(1),id,'synthetic-first',null,'2026-10-05');assert b=a;
 assert public.acquire_ai_chat_request(pg_temp.ai_uid(1),gen_random_uuid(),'synthetic-other',null,'2026-10-05')->>'status'='concurrent';
 perform pg_temp.ai_expect(format('select public.reserve_ai_chat_model(''synthetic-ai-atomic'',''fixture'',''intent'',10,%L,%L,%L,''2026-10-05'')',pg_temp.ai_uid(1),id,a->>'leaseToken'),'55000');
end;$$;
reset role;
do $$begin assert not exists(select 1 from private.ai_member_daily_usage);assert not exists(select 1 from information_schema.columns where table_schema='private' and table_name='ai_chat_requests' and column_name='client_request_id');assert not exists(select 1 from private.ai_budget_reservations where ledger_id='synthetic-ai-atomic');end;$$;
select 'AI_ATOMIC_CHECK:lease_retry_concurrency_external_hold';
-- 이 행은 합성 승인으로만 설정하고 rollback한다. 외부 네트워크 호출은 없다.
update private.ai_processing_guard set external_processing_allowed=true where singleton;
set local role service_role;
do $$declare r record;a jsonb;b jsonb;begin
 select * into r from ai_probes where name='first';
 a:=public.reserve_ai_chat_model('synthetic-ai-atomic','fixture','intent',1000000,pg_temp.ai_uid(1),r.request_id,r.token,'2026-10-05');
 assert a='{"reservationId":null}'::jsonb;
 b:=public.reserve_ai_chat_model('synthetic-ai-atomic','fixture','intent',10,pg_temp.ai_uid(1),r.request_id,r.token,'2026-10-05');
 assert b->>'reservationId' is not null;
 perform public.settle_ai_budget((b->>'reservationId')::uuid,'usage_unknown',null,null);
 b:=public.reserve_ai_chat_model('synthetic-ai-atomic','fixture','explanation',10,pg_temp.ai_uid(1),r.request_id,r.token,'2026-10-05');
 assert b->>'reservationId' is not null;
 perform public.finish_ai_chat_request(pg_temp.ai_uid(1),r.request_id,r.token,'output_privacy');
 assert public.finish_ai_chat_request(pg_temp.ai_uid(1),r.request_id,r.token,'output_privacy')='{"finished":true}'::jsonb;
end;$$;
reset role;
do $$begin
 assert (select started_requests=1 from private.ai_member_daily_usage where user_id=pg_temp.ai_uid(1) and kst_day=(clock_timestamp() at time zone 'Asia/Seoul')::date);
 assert (select charged_units=10 and unknown_usage_calls=1 and reserved_units=10 from private.ai_budget_ledgers where ledger_id='synthetic-ai-atomic');
end;$$;
select 'AI_ATOMIC_CHECK:budget_denial_no_debit_first_start_once_unknown_charge';

set local role service_role;
do $$declare first record;id uuid:=gen_random_uuid();a jsonb;begin
 select * into first from ai_probes where name='first';
 assert public.acquire_ai_chat_request(pg_temp.ai_uid(2),gen_random_uuid(),'wrong-owner',first.request_id,'2026-10-05')->>'status'='retry_exhausted';
 a:=public.acquire_ai_chat_request(pg_temp.ai_uid(1),id,'synthetic-output-retry',first.request_id,'2026-10-05');assert a->>'status'='acquired';
 assert public.reserve_ai_chat_model('synthetic-ai-atomic','fixture','intent',10,pg_temp.ai_uid(1),id,(a->>'leaseToken')::uuid,'2026-10-05')->>'reservationId' is not null;
 perform public.finish_ai_chat_request(pg_temp.ai_uid(1),id,(a->>'leaseToken')::uuid,'output_privacy');
 assert public.acquire_ai_chat_request(pg_temp.ai_uid(1),gen_random_uuid(),'synthetic-output-retry-again',first.request_id,'2026-10-05')->>'status'='retry_exhausted';
 assert public.acquire_ai_chat_request(pg_temp.ai_uid(1),gen_random_uuid(),'synthetic-output-retry-chain',id,'2026-10-05')->>'status'='retry_exhausted';
end;$$;
reset role;
select 'AI_ATOMIC_CHECK:output_retry_owner_once_no_chain';

insert into private.ai_member_daily_usage(user_id,kst_day,started_requests)
 values(pg_temp.ai_uid(2),(clock_timestamp() at time zone 'Asia/Seoul')::date,19),
 (pg_temp.ai_uid(3),(clock_timestamp() at time zone 'Asia/Seoul')::date-1,20);
set local role service_role;
do $$declare id uuid:=gen_random_uuid();a jsonb;b jsonb;begin
 a:=public.acquire_ai_chat_request(pg_temp.ai_uid(2),id,'synthetic-twentieth',null,'2026-10-05');
 b:=public.reserve_ai_chat_model('synthetic-ai-atomic','fixture','intent',10,pg_temp.ai_uid(2),id,(a->>'leaseToken')::uuid,'2026-10-05');assert b->>'reservationId' is not null;
 perform public.finish_ai_chat_request(pg_temp.ai_uid(2),id,(a->>'leaseToken')::uuid,'finished');
 assert public.acquire_ai_chat_request(pg_temp.ai_uid(2),gen_random_uuid(),'synthetic-twenty-first',null,'2026-10-05')->>'status'='daily_limit';
 a:=public.acquire_ai_chat_request(pg_temp.ai_uid(3),gen_random_uuid(),'synthetic-new-kst-day',null,'2026-10-05');assert a->>'status'='acquired';
end;$$;
reset role;
select 'AI_ATOMIC_CHECK:twenty_limit_kst_previous_day_excluded';

-- 과거 점유 만료 후 새 점유를 얻어도 과거 finish/reserve는 새 점유를 건드리지 않는다.
update private.ai_chat_requests set expires_at=clock_timestamp()-interval '1 second' where user_id=pg_temp.ai_uid(3);
set local role service_role;
do $$declare old_id uuid;old_token uuid;id uuid:=gen_random_uuid();a jsonb;begin
 select request_id,token into old_id,old_token from ai_probes where name='expired';
 a:=public.acquire_ai_chat_request(pg_temp.ai_uid(3),id,'synthetic-after-expiry',null,'2026-10-05');assert a->>'status'='acquired';
 insert into ai_probes values('new-active',id,(a->>'leaseToken')::uuid);
end;$$;
reset role;
do $$declare old private.ai_chat_requests;n record;begin
 select * into old from private.ai_chat_requests where user_id=pg_temp.ai_uid(3) and client_request_hash=encode(sha256(convert_to('synthetic-new-kst-day','UTF8')),'hex');
 select * into n from ai_probes where name='new-active';
 perform pg_temp.ai_expect(format('select public.finish_ai_chat_request(%L,%L,%L,''finished'')',old.user_id,old.request_id,old.lease_token),'40001');
 assert public.reserve_ai_chat_model('synthetic-ai-atomic','fixture','intent',10,old.user_id,old.request_id,old.lease_token,'2026-10-05')->>'status'='lease_lost';
 assert (select active_request_id=n.request_id from private.ai_member_processing where user_id=old.user_id);
end;$$;
select 'AI_ATOMIC_CHECK:expired_scope_cannot_release_replacement';

set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.ai_uid(3)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.ai_uid(3))::text,true);
do $$begin assert public.withdraw_my_ai_processing('exploration')='{"withdrawn":true}'::jsonb;end;$$;
reset role;
do $$declare n record;begin
 select * into n from ai_probes where name='new-active';
 assert public.reserve_ai_chat_model('synthetic-ai-atomic','fixture','intent',10,pg_temp.ai_uid(3),n.request_id,n.token,'2026-10-05')->>'status'='consent_revoked';
 assert public.acquire_ai_chat_request(pg_temp.ai_uid(3),gen_random_uuid(),'synthetic-withdrawn',null,'2026-10-05')->>'status'='consent_revoked';
 assert exists(select 1 from public.profiles where id=pg_temp.ai_uid(3));
 assert not has_function_privilege('authenticated','public.acquire_ai_chat_request(uuid,uuid,text,uuid,text)','EXECUTE');
 assert not has_table_privilege('service_role','private.ai_member_daily_usage','UPDATE');
 assert has_function_privilege('service_role','public.reserve_review_summary_model(text,text,text,bigint,uuid,uuid,uuid,text,uuid,text,text,uuid[],text)','EXECUTE');
end;$$;
select 'AI_ATOMIC_CHECK:withdrawal_blocks_start_keeps_account_acl';

-- 점유 후 20회에 도달했다면 예약과 개인 차감을 함께 거절한다.
update private.ai_member_daily_usage set started_requests=19 where user_id=pg_temp.ai_uid(1) and kst_day=(clock_timestamp() at time zone 'Asia/Seoul')::date;
set local role service_role;
do $$declare id uuid:=gen_random_uuid();a jsonb;begin
 a:=public.acquire_ai_chat_request(pg_temp.ai_uid(1),id,'synthetic-raced-daily-limit',null,'2026-10-05');assert a->>'status'='acquired';
 insert into ai_probes values('daily-race',id,(a->>'leaseToken')::uuid);
end;$$;
reset role;
update private.ai_member_daily_usage set started_requests=20 where user_id=pg_temp.ai_uid(1) and kst_day=(clock_timestamp() at time zone 'Asia/Seoul')::date;
create temp table ledger_probe as select reserved_units,open_calls from private.ai_budget_ledgers where ledger_id='synthetic-ai-atomic';
set local role service_role;
do $$declare r record;begin
 select * into r from ai_probes where name='daily-race';
 assert public.reserve_ai_chat_model('synthetic-ai-atomic','fixture','intent',10,pg_temp.ai_uid(1),r.request_id,r.token,'2026-10-05')->>'status'='daily_limit';
 perform public.finish_ai_chat_request(pg_temp.ai_uid(1),r.request_id,r.token,'finished');
end;$$;
reset role;
do $$begin
 assert (select started_at is null and counted_day is null from private.ai_chat_requests where request_id=(select request_id from ai_probes where name='daily-race'));
 assert (select l.reserved_units=p.reserved_units and l.open_calls=p.open_calls from private.ai_budget_ledgers l cross join ledger_probe p where ledger_id='synthetic-ai-atomic');
end;$$;
select 'AI_ATOMIC_CHECK:daily_limit_after_acquire_rolls_back_budget';

select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
-- 세 공개 한마디, 현재 revision, 실제 작업 lease와 전역 lease를 모두 묶어 예약한다.
create temp table summary_probes(job uuid,lease uuid,run uuid,revision text,ids uuid[]);
grant all on summary_probes to service_role;
do $$declare n integer;p uuid;r uuid;ap uuid;rv uuid;at timestamptz:=clock_timestamp()-interval '8 days';
  snap jsonb;claimed jsonb;ids uuid[];job uuid:=gen_random_uuid();lease uuid:=gen_random_uuid();run uuid:=gen_random_uuid();begin
  for n in 1..3 loop
    p:=gen_random_uuid();r:=gen_random_uuid();ap:=gen_random_uuid();rv:=gen_random_uuid();
    insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount,status)
      values(p,pg_temp.ai_uid(1),'합성 AI 근거 공고','합성 요약 예약 검증','산책',at-interval '4 hours',at-interval '2 hours',at-interval '6 hours','서울특별시 강남구 역삼동','free',0,'closed');
    insert into public.join_requests(id,post_id,requester_id,message,status)
      values(r,p,pg_temp.ai_uid(case when n=3 then 3 else 2 end),'합성 AI 근거 신청','matched');
    insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
      values(ap,p,r,'completed',at,'automatic',at,at+interval '24 hours',at+interval '7 days');
    insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience,praises)
      values(rv,ap,pg_temp.ai_uid(case when n=3 then 3 else 2 end),5,'개인정보 없는 합성 공개 후기 '||n,'positive','{}');
  end loop;
  snap:=private.refresh_review_summary_state(pg_temp.ai_uid(1));assert (snap->>'eligibleCount')::integer=3;
  select array_agg((x->>'reviewId')::uuid order by x->>'reviewId') into ids from jsonb_array_elements(snap->'reviews')x;
  insert into private.worker_jobs(id,kind,dedupe_key,payload,status,available_at)
    values(job,'review_summary','synthetic:ai:atomic:summary',jsonb_build_object('profileId',pg_temp.ai_uid(1),'sourceRevision',snap->>'sourceRevision','modelVersion','fixture-model','promptVersion','fixture-prompt'),
      'queued',clock_timestamp()-interval '1 day');
  update private.global_worker_run set token=run,expires_at=clock_timestamp()+interval '180 seconds' where singleton;
  claimed:=public.claim_job(gen_random_uuid(),180,run);assert claimed->'job'->>'jobId'=job::text;
  lease:=(claimed->'job'->>'leaseToken')::uuid;
  insert into summary_probes values(job,lease,run,snap->>'sourceRevision',ids);
end;$$;
set local role service_role;
do $$declare x record;r jsonb;begin
 select * into x from summary_probes;
 r:=public.reserve_review_summary_model('synthetic-ai-atomic','fixture','review_chunk',10,x.job,x.lease,pg_temp.ai_uid(1),x.revision,x.run,'fixture-model','fixture-prompt',x.ids,'2026-10-05');assert r->>'reservationId' is not null;
 assert public.reserve_review_summary_model('synthetic-ai-atomic','fixture','review_merge',10,x.job,gen_random_uuid(),pg_temp.ai_uid(1),x.revision,x.run,'fixture-model','fixture-prompt',x.ids,'2026-10-05')->>'status'='lease_lost';
 assert public.reserve_review_summary_model('synthetic-ai-atomic','fixture','review_merge',10,x.job,x.lease,pg_temp.ai_uid(1),x.revision,gen_random_uuid(),'fixture-model','fixture-prompt',x.ids,'2026-10-05')->>'status'='lease_lost';
 assert public.reserve_review_summary_model('synthetic-ai-atomic','fixture','review_merge',10,x.job,x.lease,pg_temp.ai_uid(1),'999',x.run,'fixture-model','fixture-prompt',x.ids,'2026-10-05')->>'status'='stale_revision';
 assert public.reserve_review_summary_model('synthetic-ai-atomic','fixture','review_merge',10,x.job,x.lease,pg_temp.ai_uid(1),x.revision,x.run,'fixture-model','fixture-prompt',x.ids[1:2],'2026-10-05')->>'status'='invalid_evidence';
end;$$;
reset role;
do $$declare x record;newrun uuid:=gen_random_uuid();begin
 select * into x from summary_probes;
 update private.global_worker_run set token=newrun,expires_at=clock_timestamp()+interval '180 seconds' where singleton;
 assert public.reserve_review_summary_model('synthetic-ai-atomic','fixture','review_merge',10,x.job,x.lease,pg_temp.ai_uid(1),x.revision,newrun,'fixture-model','fixture-prompt',x.ids,'2026-10-05')->>'status'='lease_lost';
 update private.global_worker_run set token=x.run,expires_at=clock_timestamp()+interval '180 seconds' where singleton;
end;$$;
select 'AI_ATOMIC_CHECK:summary_exact_evidence_revision_global_and_job_fences';
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.ai_uid(2)::text,true);
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.ai_uid(2))::text,true);
do $$begin assert public.withdraw_my_ai_processing('review_summary')='{"withdrawn":true}'::jsonb;end;$$;
reset role;
do $$declare x record;before_units bigint;begin
 select * into x from summary_probes;
 select reserved_units into before_units from private.ai_budget_ledgers where ledger_id='synthetic-ai-atomic';
 assert jsonb_array_length(private.review_summary_sources(pg_temp.ai_uid(1)))=1;
 assert exists(select 1 from private.review_refresh_outbox where profile_id=pg_temp.ai_uid(1));
 assert not exists(select 1 from private.review_refresh_outbox where profile_id=pg_temp.ai_uid(2));
 assert public.reserve_review_summary_model('synthetic-ai-atomic','fixture','review_merge',10,x.job,x.lease,pg_temp.ai_uid(1),x.revision,x.run,'fixture-model','fixture-prompt',x.ids,'2026-10-05')->>'status'='consent_revoked';
 assert (select reserved_units=before_units from private.ai_budget_ledgers where ledger_id='synthetic-ai-atomic');
 assert exists(select 1 from public.profiles where id=pg_temp.ai_uid(2));
end;$$;
select 'AI_ATOMIC_CHECK:summary_withdrawal_sources_revision_outbox_no_budget';
rollback;
