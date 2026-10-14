-- NOT_RUN 준비본. 새 owned SQL 대상에서만 실행한다. 실제 회원/모델/Auth API/Storage 없음.
-- 합성 원행은 전부 rollback하며 새 결과/finish/feedback를 조회로 만들지 않는다.
begin;
set local plpgsql.check_asserts='on';
create temp table ai_result_state_members as
select n,('ad710000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid uid from generate_series(1,3)n;
insert into auth.users(id,email,raw_user_meta_data)
select uid,'ai-result-state-'||n||'@synthetic.invalid','{"name":"합성 상태 검사"}'::jsonb from ai_result_state_members;
insert into public.profiles(id,real_name,birth_date,gender)
select uid,'합성 상태 검사','1990-01-01','female'from ai_result_state_members;
do $$begin
 assert(select count(*)=3 from private.member_episodes where profile_id in(select uid from ai_result_state_members)and ended_at is null),
  'synthetic_profile_episode_contract_missing';
 assert has_function_privilege('service_role','public.get_ai_result_state(uuid,uuid)','execute');
 assert not has_function_privilege('anon','public.get_ai_result_state(uuid,uuid)','execute');
 assert not has_function_privilege('authenticated','public.get_ai_result_state(uuid,uuid)','execute');
 assert(select provolatile='s'from pg_proc where oid='public.get_ai_result_state(uuid,uuid)'::regprocedure);
end;$$;
create function pg_temp.ai_result_state_id(n integer)returns uuid language sql immutable as $$
 select ('ad720000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.ai_result_state_error(statement text,expected text)returns void language plpgsql as $$
begin
 begin execute statement;exception when others then
  if sqlstate=expected then return;end if;raise;
 end;
 raise exception 'expected_sqlstate_not_observed';
end;$$;
insert into private.ai_chat_requests(request_id,user_id,client_request_hash,lease_token,expires_at,outcome,finished_at)
select pg_temp.ai_result_state_id(n),(select uid from ai_result_state_members where n=1),
 encode(sha256(convert_to('state-'||n::text,'UTF8')),'hex'),pg_temp.ai_result_state_id(100+n),
 clock_timestamp()+case when n in(1,3)then interval'-1 minute'else interval'2 minutes'end,
 case when n in(1,4)then 'finished'when n=5 then 'output_privacy'else null end,
 case when n in(1,4,5)then clock_timestamp()else null end from generate_series(1,6)n;
insert into private.ai_result_receipts(request_id,user_id,available_at)
select pg_temp.ai_result_state_id(n),(select uid from ai_result_state_members where n=1),clock_timestamp()from unnest(array[1,6])n;
-- 종료된 회차 검사도 원 결과의 본인 요청이어야 다른 소유자 검사와 구분된다.
insert into private.ai_chat_requests(request_id,user_id,client_request_hash,lease_token,expires_at,outcome,finished_at)
select pg_temp.ai_result_state_id(7),uid,repeat('7',64),pg_temp.ai_result_state_id(107),clock_timestamp()+interval'2 minutes','finished',clock_timestamp()
from ai_result_state_members where n=3;
insert into private.ai_result_receipts(request_id,user_id,available_at)
select pg_temp.ai_result_state_id(7),uid,clock_timestamp()from ai_result_state_members where n=3;
-- 본문이나 보관 상태를 만드는 fixture가 아니다. 원 메타데이터의 읽기 효과만 비교한다.
create temp table ai_result_state_before as
select (select jsonb_agg(to_jsonb(r)order by request_id)from private.ai_chat_requests r)requests,
 (select jsonb_agg(to_jsonb(r)order by request_id)from private.ai_result_receipts r)receipts,
 (select jsonb_agg(to_jsonb(r)order by feedback_id)from private.ai_feedback_receipts r)feedback;
set local role service_role;
do $$declare uid uuid:='ad710000-0000-4000-8000-000000000001';v jsonb;i integer;begin
 v:=public.get_ai_result_state(uid,pg_temp.ai_result_state_id(1));
 assert v->>'status'='available'and v->>'helpfulAllowed'='true'and v->>'availableAt'is not null;
 assert(select count(*)=4 from jsonb_object_keys(v));
 for i in 2..6 loop
  v:=public.get_ai_result_state(uid,pg_temp.ai_result_state_id(i));
  assert v=jsonb_build_object('requestId',pg_temp.ai_result_state_id(i),'status',case when i in(2,6)then 'pending'else 'unavailable'end,
   'availableAt',null,'helpfulAllowed',false);
 end loop;
 perform pg_temp.ai_result_state_error(format('select public.get_ai_result_state(%L,%L)','ad710000-0000-4000-8000-000000000002',pg_temp.ai_result_state_id(1)),'PT404');
 perform pg_temp.ai_result_state_error(format('select public.get_ai_result_state(%L,%L)',uid,pg_temp.ai_result_state_id(99)),'PT404');
 perform pg_temp.ai_result_state_error(format('select public.get_ai_result_state(%L,%L)','ad710000-0000-4000-8000-000000000099',pg_temp.ai_result_state_id(1)),'PT404');
 perform pg_temp.ai_result_state_error(format('select public.get_ai_result_state(null,%L)',pg_temp.ai_result_state_id(1)),'22023');
end;$$;
reset role;
do $$begin
 assert (select requests from ai_result_state_before)is not distinct from(select jsonb_agg(to_jsonb(r)order by request_id)from private.ai_chat_requests r);
 assert (select receipts from ai_result_state_before)is not distinct from(select jsonb_agg(to_jsonb(r)order by request_id)from private.ai_result_receipts r);
 assert (select feedback from ai_result_state_before)is not distinct from(select jsonb_agg(to_jsonb(r)order by feedback_id)from private.ai_feedback_receipts r);
end;$$;
update private.ai_result_receipts set available_at=statement_timestamp()-interval'2160 hours'where request_id=pg_temp.ai_result_state_id(1);
update private.member_episodes set ended_at=clock_timestamp()where profile_id='ad710000-0000-4000-8000-000000000003'and ended_at is null;
set local role service_role;
do $$begin
 perform pg_temp.ai_result_state_error(format('select public.get_ai_result_state(%L,%L)','ad710000-0000-4000-8000-000000000001',pg_temp.ai_result_state_id(1)),'PT404');
 perform pg_temp.ai_result_state_error(format('select public.get_ai_result_state(%L,%L)','ad710000-0000-4000-8000-000000000003',pg_temp.ai_result_state_id(7)),'PT404');
end;$$;
reset role;
select 'NOT_RUN: prepared native SQL cases; no runtime, concurrency, real-user or screen verification claim';
rollback;
