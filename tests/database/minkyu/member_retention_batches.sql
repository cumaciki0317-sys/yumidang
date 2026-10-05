-- 독립 source55 +20136 +30100 검증 계획. 합성 자료만 사용하고 전체 rollback한다.
begin;
insert into private.global_worker_run(singleton)values(true)on conflict do nothing;
create function pg_temp.ret_id(n integer) returns uuid language sql immutable as $$
 select ('d3010000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.ret_reject(command text,expected text) returns void language plpgsql as $$
declare code text;detail text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate,detail=message_text;end;
 assert code=expected,format('unexpected SQLSTATE %s: %s',code,detail);
end; $$;
create function pg_temp.ret_delay_purge() returns trigger language plpgsql as $$begin
 if current_setting('yumidang.ret_delay',true)='true' then perform pg_sleep(1.1);end if;return old;
end; $$;
create trigger ret_delay_purge before delete on private.retired_post_bodies for each row execute function pg_temp.ret_delay_purge();
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into auth.users(id,email)select pg_temp.ret_id(n),pg_temp.ret_id(n)::text||'@naver.yumidang.invalid'from generate_series(1,3)n;
insert into public.profiles(id,real_name,birth_date,gender)select pg_temp.ret_id(n),'합성 회원','1990-01-01','female'from generate_series(1,3)n;
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status,created_at,updated_at)
 select pg_temp.ret_id(n),pg_temp.ret_id(1),'합성 보관 공고','합성 보관 본문','산책',now()-interval'3 years',now()-interval'3 years'+interval'2 hours',
 now()-interval'3 years 1 day','서울특별시 강남구 역삼동','closed',now()-interval'3 years',now()-interval'3 years'from generate_series(5,29)n;
insert into private.retired_post_retention(post_id,withdrawn_profile_id,retained_until)
 select pg_temp.ret_id(n),pg_temp.ret_id(1),now()-interval'2 years'from generate_series(5,29)n;
insert into private.retired_post_bodies(post_id,body,retained_until)
 select pg_temp.ret_id(n),'{"description":"RETENTION_SYNTHETIC_BODY"}',now()-interval'2 years'from generate_series(5,29)n;
insert into public.join_requests(id,post_id,requester_id,message,status,created_at,updated_at)values
 (pg_temp.ret_id(100),pg_temp.ret_id(5),pg_temp.ret_id(2),'RETENTION_FIRST_APPLICATION_BODY','withdrawn',now()-interval'2 years',now()-interval'2 years'),
 (pg_temp.ret_id(101),pg_temp.ret_id(6),pg_temp.ret_id(3),'RETENTION_OTHER_BODY','withdrawn',now()-interval'6 months',now()-interval'6 months');
insert into public.chat_messages(id,join_request_id,sender_id,content,created_at)values
 (pg_temp.ret_id(110),pg_temp.ret_id(100),pg_temp.ret_id(2),'RETENTION_FIRST_APPLICATION_BODY',now()-interval'2 years'),
 (pg_temp.ret_id(111),pg_temp.ret_id(101),pg_temp.ret_id(3),'RETENTION_OTHER_BODY',now()-interval'6 months');
insert into private.conversation_retention(request_id)values(pg_temp.ret_id(100)),(pg_temp.ret_id(101));
insert into private.match_consents(request_id,condition_version,conditions,requested_by)values(pg_temp.ret_id(100),'synthetic-retention-receipt','{"title":"합성 본문"}',pg_temp.ret_id(1));
insert into private.retired_consent_bodies(request_id,conditions,retained_until)values(pg_temp.ret_id(100),'{"title":"RETENTION_CONSENT_BODY"}',now()-interval'2 years');

select pg_temp.ret_reject('select private.purge_expired_member_retention()','55000');
select pg_temp.ret_reject('select private.record_member_retention_closure(pg_temp.ret_id(100),now())','55000');
do $$declare f regprocedure;r text;begin
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'
 and p.proname in('retention_related_reports','link_retention_report_context','lock_member_retention_metadata','member_retention_state',
 'record_member_retention_closure','member_retention_receipt_current','purge_expired_member_retention',
 'member_retention_request_terminal','track_conversation_retention_generation','conversation_generation_state','conversation_generation_visible','conversation_header_public')loop
  foreach r in array array['anon','authenticated','service_role']loop assert not has_function_privilege(r,f,'EXECUTE');end loop;
 end loop;
end; $$;
do $$declare g uuid;n integer;r jsonb;expiry timestamptz;anchor timestamptz;begin
 g:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 perform pg_temp.ret_reject(format('select private.purge_expired_member_retention(%L,21)',g),'22023');
 perform pg_temp.ret_reject(format('select private.purge_expired_member_retention(%L,0)',g),'22023');
 assert private.purge_expired_member_retention(g,20)->>'processed'='0';
 assert public.purge_expired_member_retention(g,20)->>'processed'='0';
 -- 외부 workflow가 발급할 receipt 포트는 합성 UUID/hash로만 검증한다.
 for n in 5..29 loop
  perform private.record_member_retention_closure(pg_temp.ret_id(n),null,pg_temp.ret_id(200+n),now()-interval'2 years',repeat('a',64),g);
 end loop;
 perform private.record_member_retention_closure(pg_temp.ret_id(5),pg_temp.ret_id(100),pg_temp.ret_id(300),now()-interval'2 years',repeat('b',64),g);
 perform private.record_member_retention_closure(pg_temp.ret_id(6),pg_temp.ret_id(101),pg_temp.ret_id(301),now()-interval'2 years',repeat('b',64),g);
 assert private.record_member_retention_closure(pg_temp.ret_id(5),pg_temp.ret_id(100),pg_temp.ret_id(300),now()-interval'2 years',repeat('b',64),g)->>'recorded'='true';
 perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,%L,%L,now(),%L,%L)',pg_temp.ret_id(5),pg_temp.ret_id(100),pg_temp.ret_id(300),repeat('c',64),g),'40001');
 perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,null,%L,now()+interval''1 day'',%L,%L)',pg_temp.ret_id(5),pg_temp.ret_id(400),repeat('a',64),g),'22023');
 -- 새 UUID로 같은 metadata/source의 종료시각을 연장할 수 없다.
 perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,%L,%L,now(),%L,%L)',pg_temp.ret_id(5),pg_temp.ret_id(100),pg_temp.ret_id(600),repeat('b',64),g),'40001');
 perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,%L,%L,now(),%L,%L)',pg_temp.ret_id(5),pg_temp.ret_id(100),pg_temp.ret_id(601),repeat('f',64),g),'40001');
 assert (select procedure_closed_at=now()-interval'2 years'from private.conversation_retention where request_id=pg_temp.ret_id(100));
 -- 무관한 공고 수정은 대화 영수증/앵커를 바꾸지 않는다.
 update public.posts set description='합성 공고 수정'where id=pg_temp.ret_id(6);
 assert private.member_retention_receipt_current(pg_temp.ret_id(301),pg_temp.ret_id(6),pg_temp.ret_id(101),1);
 assert private.closed_conversation_retention_open(pg_temp.ret_id(101));
 -- 유효한 종료 thread 재활성화는 같은 세대다. 실제 새 메시지 활동을 앵커에 반영한다.
 update public.join_requests set status='pending'where id=pg_temp.ret_id(101);
 insert into public.chat_messages(id,join_request_id,sender_id,content)values(pg_temp.ret_id(112),pg_temp.ret_id(101),pg_temp.ret_id(3),'RETENTION_VALID_NEW_ACTIVITY');
 assert (select count(*)from private.conversation_retention_generations where request_id=pg_temp.ret_id(101))=1;
 assert private.conversation_message_readable(pg_temp.ret_id(111));
 assert private.conversation_message_readable(pg_temp.ret_id(112));
 update public.join_requests set status='withdrawn'where id=pg_temp.ret_id(101);
 assert not private.member_retention_receipt_current(pg_temp.ret_id(301),pg_temp.ret_id(6),pg_temp.ret_id(101),1);
 perform private.record_member_retention_closure(pg_temp.ret_id(6),pg_temp.ret_id(101),pg_temp.ret_id(302),now(),repeat('c',64),g);
 assert (select purge_after>now()+interval'364 days'from private.conversation_retention where request_id=pg_temp.ret_id(101));
 assert private.closed_conversation_retention_open(pg_temp.ret_id(101));
 -- 공고 metadata도 바뀌었으므로 해당 post receipt만 새로 검증한다.
 perform private.record_member_retention_closure(pg_temp.ret_id(6),null,pg_temp.ret_id(303),now(),repeat('c',64),g);
 select last_activity_at into anchor from private.conversation_retention where request_id=pg_temp.ret_id(100);
 select expires_at into expiry from private.global_worker_run where singleton;
 update private.global_worker_run set expires_at=clock_timestamp()+interval'1 second'where singleton;
 perform set_config('yumidang.ret_delay','true',true);
 perform pg_temp.ret_reject(format('select private.purge_expired_member_retention(%L,2)',g),'40001');
 assert (select count(*)from private.retired_post_bodies)=25;
 assert exists(select 1 from private.retired_consent_bodies where request_id=pg_temp.ret_id(100));
 assert not exists(select 1 from private.conversation_retention where purged_at is not null);
 perform set_config('yumidang.ret_delay','false',true);
 update private.global_worker_run set expires_at=expiry where singleton;
 r:=private.purge_expired_member_retention(g,20);
 assert (r->>'processed')::integer=20;
 r:=private.purge_expired_member_retention(g,20);
 assert (r->>'processed')::integer=7;
 assert (r->>'conversationRecordsProcessed')::integer=1;
 assert private.purge_expired_member_retention(g,20)->>'processed'='0';
 assert not exists(select 1 from public.chat_messages where join_request_id=pg_temp.ret_id(100));
 assert (select message from public.join_requests where id=pg_temp.ret_id(100))='보관 기간이 종료된 대화입니다.';
 assert (select last_activity_at from private.conversation_retention where request_id=pg_temp.ret_id(100))=anchor;
 assert not private.closed_conversation_retention_open(pg_temp.ret_id(100));
 assert exists(select 1 from public.chat_messages where join_request_id=pg_temp.ret_id(101));
 assert not exists(select 1 from private.retired_consent_bodies where request_id=pg_temp.ret_id(100));
 select expires_at into expiry from private.global_worker_run where singleton;
 update private.global_worker_run set expires_at=clock_timestamp()-interval'1 second'where singleton;
 perform pg_temp.ret_reject(format('select private.purge_expired_member_retention(%L,20)',g),'40001');
 update private.global_worker_run set expires_at=expiry where singleton;
 perform public.release_worker_run(g);
end; $$;

-- 미종결 신고는 상태 문자열만 resolved로 바뀌어도 final_closed_at 없이는 증거가 아니다.
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
 values(pg_temp.ret_id(40),pg_temp.ret_id(1),'합성 절차 공고','합성 절차 본문','산책',now()-interval'3 years',now()-interval'3 years'+interval'2 hours',now()-interval'3 years 1 day','서울특별시 강남구 역삼동','closed');
insert into private.retired_post_retention(post_id,withdrawn_profile_id,retained_until)values(pg_temp.ret_id(40),pg_temp.ret_id(1),now()-interval'2 years');
insert into private.retired_post_bodies(post_id,body,retained_until)values(pg_temp.ret_id(40),'{"description":"RETENTION_BLOCKED_BODY"}',now()-interval'2 years');
insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,hide_target,fingerprint)
 values(pg_temp.ret_id(500),pg_temp.ret_id(2),private.active_member_episode(pg_temp.ret_id(2)),pg_temp.ret_id(501),'post',pg_temp.ret_id(40),'online',array['other'],false,repeat('d',64));
do $$declare g uuid;begin
 g:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,null,%L,now(),%L,%L)',pg_temp.ret_id(40),pg_temp.ret_id(510),repeat('a',64),g),'40001');
 update private.member_reports set status='resolved'where id=pg_temp.ret_id(500);
 perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,null,%L,now(),%L,%L)',pg_temp.ret_id(40),pg_temp.ret_id(510),repeat('a',64),g),'40001');
 assert private.purge_expired_member_retention(g,20)->>'processed'='0';
 assert exists(select 1 from private.retired_post_bodies where post_id=pg_temp.ret_id(40));
 perform public.release_worker_run(g);
end; $$;

-- 확정 진행/분쟁/미종결 분쟁을 폐쇄 시각으로 꾸며 receipt를 발급하지 않는다.
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
 select pg_temp.ret_id(n),pg_temp.ret_id(1),'합성 약속 공고','합성 약속 본문','산책',now()-interval'3 years',now()-interval'3 years'+interval'2 hours',
 now()-interval'3 years 1 day','서울특별시 강남구 역삼동','closed'from generate_series(41,43)n;
insert into public.join_requests(id,post_id,requester_id,message,status)
 select pg_temp.ret_id(n+1000),pg_temp.ret_id(n),pg_temp.ret_id(2),'합성 약속 대화','matched'from generate_series(41,43)n;
insert into private.retired_post_retention(post_id,withdrawn_profile_id,retained_until)
 select pg_temp.ret_id(n),pg_temp.ret_id(1),now()-interval'2 years'from generate_series(41,43)n;
insert into public.appointments(id,post_id,join_request_id,status)
 values(pg_temp.ret_id(2041),pg_temp.ret_id(41),pg_temp.ret_id(1041),'confirmed');
insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
 select pg_temp.ret_id(n+2000),pg_temp.ret_id(n),pg_temp.ret_id(n+1000),case when n=42 then 'disputed'else 'completed'end,
 now()-interval'2 years','automatic',now()-interval'2 years',now()-interval'2 years'+interval'1 day',now()-interval'2 years'+interval'7 days'from generate_series(42,43)n;
insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)
 values(pg_temp.ret_id(2043),pg_temp.ret_id(2),'합성 미종결 분쟁',interval'1 day');
do $$declare g uuid;n integer;f regprocedure;r text;begin
 g:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 for n in 41..43 loop
  perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,null,%L,now(),%L,%L)',pg_temp.ret_id(n),pg_temp.ret_id(n+3000),repeat('a',64),g),'40001');
 end loop;
 foreach r in array array['anon','authenticated','service_role']loop
  assert not has_function_privilege(r,'public.purge_expired_member_retention(uuid,integer)','EXECUTE');
 end loop;
 perform set_config('request.jwt.claims','{"role":"authenticated"}',true);
 perform pg_temp.ret_reject(format('select public.purge_expired_member_retention(%L,20)',g),'42501');
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 perform public.release_worker_run(g);
end; $$;

-- 회원이 탈퇴하지 않은 일반 종료 thread도 실제 종료/종결 receipt로 등록한다.
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status,created_at,updated_at)
 select pg_temp.ret_id(n),pg_temp.ret_id(1),'합성 일반 대화','합성 일반 공고','산책',now()-interval'3 years',now()-interval'3 years'+interval'2 hours',
 now()-interval'3 years 1 day','서울특별시 강남구 역삼동','closed',now()-interval'3 years',now()-interval'3 years'from generate_series(60,62)n;
insert into public.join_requests(id,post_id,requester_id,message,status,created_at,updated_at)
 select pg_temp.ret_id(n+1000),pg_temp.ret_id(n),pg_temp.ret_id(2),'GENERAL_RETENTION_HEADER',case n when 60 then 'withdrawn'when 61 then 'matched'else 'pending'end,
 now()-interval'2 years',now()-interval'2 years'from generate_series(60,62)n;
insert into public.chat_messages(id,join_request_id,sender_id,content,created_at)
 select pg_temp.ret_id(n+2000),pg_temp.ret_id(n+1000),pg_temp.ret_id(2),'GENERAL_RETENTION_BODY',now()-interval'2 years'from generate_series(60,61)n;
insert into public.appointments(id,post_id,join_request_id,status,confirmed_at,updated_at,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
 values(pg_temp.ret_id(3061),pg_temp.ret_id(61),pg_temp.ret_id(1061),'completed',now()-interval'3 years',now()-interval'2 years',now()-interval'2 years',
 'automatic',now()-interval'2 years',now()-interval'2 years'+interval'1 day',now()-interval'2 years'+interval'7 days');
do $$declare g uuid;r jsonb;purged timestamptz;begin
 g:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 assert not exists(select 1 from private.member_retirements where profile_id in(pg_temp.ret_id(1),pg_temp.ret_id(2)));
 assert not exists(select 1 from private.conversation_retention where request_id in(pg_temp.ret_id(1060),pg_temp.ret_id(1061)));
 perform private.record_member_retention_closure(pg_temp.ret_id(60),pg_temp.ret_id(1060),pg_temp.ret_id(4060),now()-interval'2 years',repeat('a',64),g);
 perform private.record_member_retention_closure(pg_temp.ret_id(61),pg_temp.ret_id(1061),pg_temp.ret_id(4061),now()-interval'18 months',repeat('a',64),g);
 perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,%L,%L,now(),%L,%L)',pg_temp.ret_id(62),pg_temp.ret_id(1062),pg_temp.ret_id(4062),repeat('a',64),g),'40001');
 r:=private.purge_expired_member_retention(g,20);
 assert r->>'processed'='2'and r->>'conversationRecordsProcessed'='2';
 assert not exists(select 1 from public.chat_messages where join_request_id in(pg_temp.ret_id(1060),pg_temp.ret_id(1061)));
 assert (select message from public.join_requests where id=pg_temp.ret_id(1060))='보관 기간이 종료된 대화입니다.';
 -- 실제 ended→pending 재활성화만 새 활동을 열고 삭제한 원문은 복원하지 않는다.
 select purged_at into purged from private.conversation_retention where request_id=pg_temp.ret_id(1060);
 update public.join_requests set status='pending'where id=pg_temp.ret_id(1060);
 assert private.closed_conversation_retention_open(pg_temp.ret_id(1060));
 assert (select purge_after is null and closure_receipt_id is null and purged_at is null and last_purged_at=purged from private.conversation_retention where request_id=pg_temp.ret_id(1060));
 assert not exists(select 1 from public.chat_messages where join_request_id=pg_temp.ret_id(1060));
 insert into public.chat_messages(id,join_request_id,sender_id,content)values(pg_temp.ret_id(5060),pg_temp.ret_id(1060),pg_temp.ret_id(2),'GENERAL_NEW_ACTIVITY_ONLY');
 assert (select count(*)from public.chat_messages where join_request_id=pg_temp.ret_id(1060))=1;
 perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,%L,%L,now(),%L,%L)',pg_temp.ret_id(60),pg_temp.ret_id(1060),pg_temp.ret_id(6060),repeat('e',64),g),'40001');
 update public.join_requests set status='withdrawn'where id=pg_temp.ret_id(1060);
 -- 과거 종결 증거 재사용으로 새 회차를 닫지 않는다.
 perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,%L,%L,now(),%L,%L)',pg_temp.ret_id(60),pg_temp.ret_id(1060),pg_temp.ret_id(6060),repeat('a',64),g),'40001');
 perform private.record_member_retention_closure(pg_temp.ret_id(60),pg_temp.ret_id(1060),pg_temp.ret_id(6060),now(),repeat('e',64),g);
 assert (select purge_after>now()+interval'364 days'from private.conversation_retention where request_id=pg_temp.ret_id(1060));
 assert private.purge_expired_member_retention(g,20)->>'processed'='0';
 perform public.release_worker_run(g);
end; $$;
-- 만료됐으나 아직 batch 정리되지 않은 원문은 새 활성 세대에 복원되지 않는다.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status,created_at,updated_at)
 values(pg_temp.ret_id(63),pg_temp.ret_id(1),'합성 경계 대화','합성 공고','산책',now()+interval'2 years',now()+interval'2 years 2 hours',now()+interval'1 year','서울특별시 강남구 역삼동','recruiting',now()-interval'3 years',now()-interval'3 years');
insert into public.join_requests(id,post_id,requester_id,message,status,created_at,updated_at)
 values(pg_temp.ret_id(1063),pg_temp.ret_id(63),pg_temp.ret_id(2),'EXPIRED_UNPURGED_HEADER','withdrawn',now()-interval'2 years',now()-interval'2 years');
insert into public.chat_messages(id,join_request_id,sender_id,content,created_at)
 values(pg_temp.ret_id(2063),pg_temp.ret_id(1063),pg_temp.ret_id(2),'EXPIRED_UNPURGED_CHAT',now()-interval'2 years');
do $$declare g uuid;old_due timestamptz;r jsonb;begin
 g:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 perform private.record_member_retention_closure(pg_temp.ret_id(63),pg_temp.ret_id(1063),pg_temp.ret_id(4063),now()-interval'2 years',repeat('a',64),g);
 select purge_after into old_due from private.conversation_retention_generations where request_id=pg_temp.ret_id(1063)and generation=1;
 assert not private.conversation_message_readable(pg_temp.ret_id(2063));
 assert not private.conversation_header_readable(pg_temp.ret_id(1063));
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.ret_id(2),'is_anonymous',false)::text,true);
 execute 'set local role authenticated';
 assert not exists(select 1 from public.chat_messages where id=pg_temp.ret_id(2063));
 assert not exists(select 1 from public.join_requests where id=pg_temp.ret_id(1063));
 execute 'reset role';
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 update public.join_requests set status='pending'where id=pg_temp.ret_id(1063);
 insert into public.chat_messages(id,join_request_id,sender_id,content)values(pg_temp.ret_id(5063),pg_temp.ret_id(1063),pg_temp.ret_id(2),'NEW_GENERATION_ONLY');
 assert (select count(*)from private.conversation_retention_generations where request_id=pg_temp.ret_id(1063))=2;
 assert (select purge_after from private.conversation_retention_generations where request_id=pg_temp.ret_id(1063)and generation=1)=old_due;
 assert (select archived_header from private.conversation_retention_generations where request_id=pg_temp.ret_id(1063)and generation=1)='EXPIRED_UNPURGED_HEADER';
 assert private.closed_conversation_retention_open(pg_temp.ret_id(1063));
 assert not private.conversation_message_readable(pg_temp.ret_id(2063));
 assert private.conversation_message_readable(pg_temp.ret_id(5063));
 assert private.conversation_header_readable(pg_temp.ret_id(1063));
 -- helper/RPC/native는 동일한 cutoff를 적용한다. owner는 보류 중 원문 존재만 확인한다.
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.ret_id(2),'is_anonymous',false)::text,true);
 r:=public.list_conversation_messages(pg_temp.ret_id(1063),20,null);
 assert jsonb_array_length(r->'items')=1 and r->'items'->0->>'content'='NEW_GENERATION_ONLY';
 perform pg_temp.ret_reject(format('select public.list_conversation_messages(%L,20,%L)',pg_temp.ret_id(1063),pg_temp.ret_id(2063)),'P0002');
 assert (select request_message from public.get_conversation(pg_temp.ret_id(1063)))='보관 기간이 종료된 대화입니다.';
 assert (select last_message from public.list_conversations()where request_id=pg_temp.ret_id(1063))='NEW_GENERATION_ONLY';
 assert (select message from public.list_sent_join_requests()where id=pg_temp.ret_id(1063))='보관 기간이 종료된 대화입니다.';
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.ret_id(1),'is_anonymous',false)::text,true);
 assert (select message from public.list_received_join_requests()where id=pg_temp.ret_id(1063))='보관 기간이 종료된 대화입니다.';
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 -- 실제 DELETE 이전에도 authenticated native SELECT는 old 원문을 읽지 못한다.
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.ret_id(2),'is_anonymous',false)::text,true);
 execute 'set local role authenticated';
 assert (select count(*)from public.chat_messages where join_request_id=pg_temp.ret_id(1063))=1;
 assert not exists(select 1 from public.chat_messages where id=pg_temp.ret_id(2063));
 assert (select message from public.join_requests where id=pg_temp.ret_id(1063))='보관 기간이 종료된 대화입니다.';
 execute 'reset role';
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 -- 과거 만료 세대의 receipt는 새 활동과 무관하게 여전히 유효하며 과거만 삭제한다.
 assert private.member_retention_receipt_current(pg_temp.ret_id(4063),pg_temp.ret_id(63),pg_temp.ret_id(1063),1);
 r:=private.purge_expired_member_retention(g,20);
 assert r->>'conversationRecordsProcessed'='1';
 assert not exists(select 1 from public.chat_messages where id=pg_temp.ret_id(2063));
 assert exists(select 1 from public.chat_messages where id=pg_temp.ret_id(5063));
 assert (select purged_at is null from private.conversation_retention where request_id=pg_temp.ret_id(1063));
 assert private.purge_expired_member_retention(g,20)->>'processed'='0';
 perform public.release_worker_run(g);
end; $$;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.ret_id(2),'is_anonymous',false)::text,true);
set local role authenticated;
do $$begin
 assert (select count(*)from public.chat_messages where join_request_id=pg_temp.ret_id(1063))=1;
 assert not exists(select 1 from public.chat_messages where content='EXPIRED_UNPURGED_CHAT');
 assert not exists(select 1 from public.join_requests where message='EXPIRED_UNPURGED_HEADER');
end; $$;
reset role;
-- 실제 후속 절차는 삭제 보류 기한을 늘릴 수 있지만 이미 만료된 읽기는 다시 열지 않는다.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status,created_at,updated_at)
 values(pg_temp.ret_id(64),pg_temp.ret_id(1),'합성 후속 절차','합성 공고','산책',now()+interval'2 years',now()+interval'2 years 2 hours',now()+interval'1 year','서울특별시 강남구 역삼동','recruiting',now()-interval'3 years',now()-interval'3 years');
insert into public.join_requests(id,post_id,requester_id,message,status,created_at,updated_at)
 values(pg_temp.ret_id(1064),pg_temp.ret_id(64),pg_temp.ret_id(2),'EXPIRED_PROCEDURE_HEADER','withdrawn',now()-interval'2 years',now()-interval'2 years');
insert into public.chat_messages(id,join_request_id,sender_id,content,created_at)
 values(pg_temp.ret_id(2064),pg_temp.ret_id(1064),pg_temp.ret_id(2),'EXPIRED_PROCEDURE_CHAT',now()-interval'2 years');
do $$declare g uuid;cutoff timestamptz;begin
 g:=(public.acquire_worker_run(180,null)->>'token')::uuid;
 perform private.record_member_retention_closure(pg_temp.ret_id(64),pg_temp.ret_id(1064),pg_temp.ret_id(4064),now()-interval'2 years',repeat('a',64),g);
 select read_until into cutoff from private.conversation_retention_generations where request_id=pg_temp.ret_id(1064)and generation=1;
 insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,hide_target,fingerprint)
 values(pg_temp.ret_id(7064),pg_temp.ret_id(2),private.active_member_episode(pg_temp.ret_id(2)),pg_temp.ret_id(8064),'post',pg_temp.ret_id(64),'online',array['other'],false,repeat('d',64));
 assert private.purge_expired_member_retention(g,20)->>'processed'='0';
 assert exists(select 1 from public.chat_messages where id=pg_temp.ret_id(2064));
 update private.member_reports set status='resolved',final_closed_at=now(),retention_due_at=now()+interval'2160 hours'where id=pg_temp.ret_id(7064);
 perform private.record_member_retention_closure(pg_temp.ret_id(64),pg_temp.ret_id(1064),pg_temp.ret_id(5064),now(),repeat('b',64),g);
 assert (select read_until=cutoff and purge_after>now()+interval'364 days'from private.conversation_retention_generations where request_id=pg_temp.ret_id(1064)and generation=1);
 assert not private.closed_conversation_retention_open(pg_temp.ret_id(1064));
 assert not private.conversation_message_readable(pg_temp.ret_id(2064));
 update public.join_requests set status='pending'where id=pg_temp.ret_id(1064);
 assert (select active_generation from private.conversation_retention where request_id=pg_temp.ret_id(1064))=2;
 assert private.closed_conversation_retention_open(pg_temp.ret_id(1064));
 assert not private.conversation_message_readable(pg_temp.ret_id(2064));
 assert private.purge_expired_member_retention(g,20)->>'processed'='0';
 assert exists(select 1 from public.chat_messages where id=pg_temp.ret_id(2064));
 perform public.release_worker_run(g);
end; $$;
-- 교정된 safety 소유권 경계: source56 단독에서는 관련 없음, 제재 조합에서는 실제 table owner가 판정한다.
do $$declare core_owner text;safety_owner text;f regprocedure;r text;t text;present integer;g uuid;begin
 select pg_get_userbyid(proowner)into core_owner from pg_proc where oid='private.closed_conversation_retention_open(uuid)'::regprocedure;
 foreach f in array array['private.lock_retention_safety_metadata()'::regprocedure,'private.retention_safety_pending(uuid[],uuid[])'::regprocedure]loop
  assert has_function_privilege(core_owner,f,'EXECUTE');
  foreach r in array array['anon','authenticated','service_role']loop assert not has_function_privilege(r,f,'EXECUTE');end loop;
 end loop;
 select count(*)into present from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
  and c.relname in('safety_incident_report_links','safety_incidents','safety_incident_revisions','safety_appeals');
 if present=0 then
  perform private.lock_retention_safety_metadata();
  assert not private.retention_safety_pending('{}','{}');
 else
  assert present=4;
  select pg_get_userbyid(relowner)into safety_owner from pg_class where oid='private.safety_incident_report_links'::regclass;
  assert(select pg_get_userbyid(proowner)=safety_owner from pg_proc where oid='private.lock_retention_safety_metadata()'::regprocedure);
  assert(select pg_get_userbyid(proowner)=safety_owner from pg_proc where oid='private.retention_safety_pending(uuid[],uuid[])'::regprocedure);
  if safety_owner<>core_owner then
   foreach t in array array['safety_incident_report_links','safety_incidents','safety_incident_revisions','safety_appeals']loop
    -- 기존 pg_read_all_data 상속 SELECT는 유지한다. 이번 변경의 직접 core GRANT는 없어야 한다.
    assert not exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner)))a
     where c.oid=('private.'||t)::regclass and a.grantee=(select oid from pg_roles where rolname=core_owner));
    assert not has_table_privilege(core_owner,('private.'||t)::regclass,'UPDATE');
    assert not has_table_privilege(core_owner,('private.'||t)::regclass,'DELETE');
    foreach r in array array['anon','authenticated','service_role']loop
     assert not has_table_privilege(r,('private.'||t)::regclass,'SELECT');
     assert not has_table_privilege(r,('private.'||t)::regclass,'UPDATE');
     assert not has_table_privilege(r,('private.'||t)::regclass,'DELETE');
    end loop;
   end loop;
  end if;
  -- 원문 없는 실제 incident/report UUID 연결은 상태가 resolved라도 현재 종결 workflow 없으므로 보류한다.
  insert into private.safety_incidents(id)values(pg_temp.ret_id(9064));
  insert into private.safety_incident_report_links(incident_id,report_id)values(pg_temp.ret_id(9064),pg_temp.ret_id(7064));
  assert private.retention_safety_pending(array[pg_temp.ret_id(7064)],'{}');
  assert not private.retention_safety_pending(array[pg_temp.ret_id(9996)],array[pg_temp.ret_id(9997)]);
  assert(private.member_retention_state(pg_temp.ret_id(64))->>'blocked')::boolean;
  assert(private.conversation_generation_state(pg_temp.ret_id(1064),1)->>'blocked')::boolean;
  g:=(public.acquire_worker_run(180,null)->>'token')::uuid;
  perform pg_temp.ret_reject(format('select private.record_member_retention_closure(%L,%L,%L,now(),%L,%L,1)',pg_temp.ret_id(64),pg_temp.ret_id(1064),pg_temp.ret_id(9065),repeat('c',64),g),'40001');
  perform public.release_worker_run(g);
  -- 부분 스키마/함수 owner 드리프트는 권한 오류를 false로 숨기지 않고55000이다. 전체 rollback fixture다.
  alter table private.safety_appeals rename to safety_appeals_retention_fixture;
  perform pg_temp.ret_reject('select private.lock_retention_safety_metadata()','55000');
  perform pg_temp.ret_reject('select private.retention_safety_pending(''{}'',''{}'')','55000');
  alter table private.safety_appeals_retention_fixture rename to safety_appeals;
  if safety_owner<>core_owner then
   execute format('alter function private.retention_safety_pending(uuid[],uuid[])owner to %I',core_owner);
   perform pg_temp.ret_reject('select private.retention_safety_pending(''{}'',''{}'')','55000');
   execute format('alter function private.retention_safety_pending(uuid[],uuid[])owner to %I',safety_owner);
  end if;
  assert private.retention_safety_pending(array[pg_temp.ret_id(7064)],'{}');
 end if;
end; $$;
rollback;
