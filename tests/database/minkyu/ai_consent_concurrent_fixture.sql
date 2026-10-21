-- 민규: 새 scratch 전용 상호 후기/동시 전체 철회 fixture. 실제 Auth/네이버/회원/모델 검증 아님.
-- root executor가 최종 HEAD/파일SHA/신규target/원baseline/UNKNOWN/sequence를 먼저 고정한다.
-- 고정 phase: setup(한 번 COMMIT), withdraw_a/withdraw_b(서로 다른 backend에서 각1회), verify, cleanup.
-- 두 actor의 원출력/PID/query_start/pg_blocking_pids를 판정 전에 개인 파일로 보존한다.
-- 40P01/55P03/57014/응답유실은 FAIL/UNKNOWN, 자동 재전송0. 동시 관측 없으면 동시성PASS 아님.
-- cleanup은 두 child와 backend 종료 확인 후에만 실행한다. 기존 baseline에 이 UUID/DDL이 있으면 실행 거절.
\set ON_ERROR_STOP on
\if :{?phase}
\else
\echo PHASE_REQUIRED
\quit 3
\endif
select :'phase' in ('setup','withdraw_a','withdraw_b','verify','cleanup') as valid_phase,
 :'phase'='setup' as do_setup, :'phase'='withdraw_a' as do_a, :'phase'='withdraw_b' as do_b,
 :'phase'='verify' as do_verify, :'phase'='cleanup' as do_cleanup \gset
\if :valid_phase
\else
\echo INVALID_PHASE
\quit 3
\endif

\if :do_setup
begin;
set local plpgsql.check_asserts=on;
set local statement_timeout='10s';
set local lock_timeout='8s';
do $$declare u uuid; n integer; p uuid; r uuid; a uuid; reviewer uuid;
begin
 assert current_user in('supabase_admin','postgres'), 'owner-only new scratch fixture';
 assert to_regprocedure('private.fixture_ai_withdraw_pause()') is null, 'fixture function already exists';
 assert not exists(select 1 from pg_trigger where tgname='fixture_ai_withdraw_pause'), 'fixture trigger already exists';
 assert not(select external_processing_allowed from private.ai_processing_guard where singleton), 'external processing must stay closed';
 for n in 1..2 loop
  u:=('a1cc0000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  assert not exists(select 1 from auth.users where id=u), 'preexisting auth id';
  assert not exists(select 1 from public.profiles where id=u), 'preexisting profile id';
  assert not exists(select 1 from private.member_episodes where profile_id=u), 'preexisting episode';
  assert not exists(select 1 from private.ai_member_processing where user_id=u), 'preexisting processing';
  assert not exists(select 1 from private.review_summary_state where profile_id=u), 'preexisting summary state';
  assert not exists(select 1 from private.review_refresh_outbox where profile_id=u), 'preexisting outbox';
  assert not exists(select 1 from private.review_summary_checkpoints where profile_id=u), 'preexisting checkpoint';
  p:=('a1cc1000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  r:=('a1cc2000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  a:=('a1cc3000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  assert not exists(select 1 from public.posts where id=p), 'preexisting post';
  assert not exists(select 1 from public.join_requests where id=r), 'preexisting request';
  assert not exists(select 1 from public.appointments where id=a), 'preexisting appointment';
  assert not exists(select 1 from public.appointment_reviews where id=('a1cc4000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid), 'preexisting review';
 end loop;
 -- 기존 current_summary_fences와 같은 비네이버 후속 조회 fixture. 실제 세션/JWT는 만들지 않는다.
 insert into auth.users(id) values('a1cc0000-0000-4000-8000-000000000001'),('a1cc0000-0000-4000-8000-000000000002');
 insert into public.profiles(id,real_name,birth_date,gender,bio) values
  ('a1cc0000-0000-4000-8000-000000000001','합성 동시철회 A','1990-01-01','female',null),
  ('a1cc0000-0000-4000-8000-000000000002','합성 동시철회 B','1990-01-01','female',null);
 for n in 1..2 loop
  u:=('a1cc0000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  reviewer:=('a1cc0000-0000-4000-8000-'||lpad((3-n)::text,12,'0'))::uuid;
  p:=('a1cc1000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  r:=('a1cc2000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  a:=('a1cc3000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
  insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
   values(p,u,'합성 동시철회 공고','새 격리 사본 전용','산책',now()-interval '12 days',now()-interval '11 days',now()-interval '13 days','서울특별시 강남구 역삼동','closed');
  insert into public.join_requests(id,post_id,requester_id,message,status) values(r,p,reviewer,'합성 동시철회 후기 관계','matched');
  insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
   values(a,p,r,'completed',now()-interval '10 days','automatic',now()-interval '10 days',now()-interval '9 days',now()-interval '3 days');
  insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience)
   values(('a1cc4000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,a,u,3,'합성 상호 후기','neutral');
 end loop;
 insert into private.ai_member_processing(user_id,exploration_allowed,summary_allowed,summary_view_allowed,summary_generate_allowed,summary_source_allowed) values
  ('a1cc0000-0000-4000-8000-000000000001',true,true,true,true,true),
  ('a1cc0000-0000-4000-8000-000000000002',true,true,true,true,true);
 insert into private.review_summary_state(profile_id) values
  ('a1cc0000-0000-4000-8000-000000000001'),('a1cc0000-0000-4000-8000-000000000002') on conflict do nothing;
 assert (select count(*) from private.review_summary_state where profile_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002'))=2;
end $$;
create function private.fixture_ai_withdraw_pause() returns trigger language plpgsql set search_path='' as $$
begin
 if new.profile_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002') then perform pg_sleep(1); end if;
 return new;
end $$;
-- 신규 fixture 함수만 원 summary 테이블 owner에 맞추며 기존 역할/ACL은 바꾸지 않는다.
do $$declare own text;begin
 select pg_get_userbyid(relowner) into strict own from pg_class where oid='private.review_summary_state'::regclass;
 execute format('alter function private.fixture_ai_withdraw_pause() owner to %I',own);
end $$;
revoke all on function private.fixture_ai_withdraw_pause() from public,anon,authenticated,service_role;
create trigger fixture_ai_withdraw_pause before update on private.review_summary_state
 for each row execute function private.fixture_ai_withdraw_pause();
commit;
select 'SETUP_COMMITTED_SYNTHETIC_SQL_ONLY' as fixture_status;
\endif

\if :do_a
begin;
set local plpgsql.check_asserts=on;
set local deadlock_timeout='200ms';
set local lock_timeout='8s';
set local statement_timeout='10s';
set local application_name='minkyu_ai_withdraw_a1cc_actor_a';
set local role authenticated;
select set_config('request.jwt.claim.sub','a1cc0000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1cc0000-0000-4000-8000-000000000001"}',true);
select pg_backend_pid() as actor_pid,clock_timestamp() as actor_started;
select public.withdraw_my_ai_processing('review_summary') as withdrawal;
commit;
\endif

\if :do_b
begin;
set local plpgsql.check_asserts=on;
set local deadlock_timeout='200ms';
set local lock_timeout='8s';
set local statement_timeout='10s';
set local application_name='minkyu_ai_withdraw_a1cc_actor_b';
set local role authenticated;
select set_config('request.jwt.claim.sub','a1cc0000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"role":"authenticated","sub":"a1cc0000-0000-4000-8000-000000000002"}',true);
select pg_backend_pid() as actor_pid,clock_timestamp() as actor_started;
select public.withdraw_my_ai_processing('review_summary') as withdrawal;
commit;
\endif

\if :do_verify
begin;
set local plpgsql.check_asserts=on;
do $$begin
 assert (select count(*) from private.ai_member_processing where user_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002')
  and exploration_allowed and not summary_allowed and not summary_view_allowed and not summary_generate_allowed and not summary_source_allowed and summary_withdrawn_at is not null)=2, 'both withdrawals must commit independently';
 assert not exists(select 1 from private.review_summary_state where profile_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002') and visible_summary_id is not null);
 assert not exists(select 1 from private.review_refresh_outbox where profile_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002'));
 assert not exists(select 1 from private.review_summary_checkpoints where profile_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002'));
 assert not(select external_processing_allowed from private.ai_processing_guard where singleton);
end $$;
rollback;
select 'PASS_SQL_OUTCOMES_ONLY_REQUIRES_INDEPENDENT_CONCURRENT_LOCK_PROOF' as fixture_status;
\endif

\if :do_cleanup
-- 원출력/child 종료/상호 Lock 증거 저장 후에만 root가 이 phase를 한 번 보낸다.
begin;
set local plpgsql.check_asserts=on;
set local lock_timeout='8s';
set local statement_timeout='10s';
drop trigger fixture_ai_withdraw_pause on private.review_summary_state;
drop function private.fixture_ai_withdraw_pause();
delete from public.appointment_reviews where id in('a1cc4000-0000-4000-8000-000000000001','a1cc4000-0000-4000-8000-000000000002');
delete from public.appointments where id in('a1cc3000-0000-4000-8000-000000000001','a1cc3000-0000-4000-8000-000000000002');
delete from public.join_requests where id in('a1cc2000-0000-4000-8000-000000000001','a1cc2000-0000-4000-8000-000000000002');
delete from public.posts where id in('a1cc1000-0000-4000-8000-000000000001','a1cc1000-0000-4000-8000-000000000002');
delete from private.review_refresh_outbox where profile_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002');
delete from private.review_summary_checkpoints where profile_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002');
delete from private.review_summary_state where profile_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002');
delete from private.ai_member_processing where user_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002');
delete from private.member_episodes where profile_id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002');
delete from public.profiles where id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002');
delete from auth.users where id in('a1cc0000-0000-4000-8000-000000000001','a1cc0000-0000-4000-8000-000000000002');
commit;
select 'CLEANED_EXACT_FIXTURE_IDS_REQUIRES_FULL_BASELINE_COMPARE' as fixture_status;
\endif
