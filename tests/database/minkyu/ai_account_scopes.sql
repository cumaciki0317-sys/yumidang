-- 기존 회원 guard/20회가 신규 계정 예약에서도 유지됨을 실제 scope RPC로 확인한다.
insert into auth.users(id)values('bd000000-0000-4000-8000-000000000001');
insert into public.profiles(id,real_name,birth_date,gender)values('bd000000-0000-4000-8000-000000000001','합성예산회원','1990-01-01','female');
insert into private.ai_member_processing(user_id,exploration_allowed,summary_allowed)values('bd000000-0000-4000-8000-000000000001',true,true);
select public.configure_ai_budget_accounts(array['yumi','jonghyun']);
select public.configure_ai_budget_ledger('account-scope-synthetic',100000,100);
create temp table account_scope(value jsonb);grant all on account_scope to service_role;
set local role service_role;
insert into account_scope select public.acquire_ai_chat_request('bd000000-0000-4000-8000-000000000001','bd010000-0000-4000-8000-000000000001','synthetic-account-scope',null,'2026-10-05')||jsonb_build_object('requestId','bd010000-0000-4000-8000-000000000001');
reset role;
update private.ai_processing_guard set external_processing_allowed=false where singleton;
select pg_temp.pool_failure(format('select public.reserve_ai_chat_account_model(%L,%L,%L,10,%L,%L,%L,%L,%L)','account-scope-synthetic','potens','intent','bd000000-0000-4000-8000-000000000001',(select value->>'requestId'from account_scope),(select value->>'leaseToken'from account_scope),'2026-10-05','yumi'),'55000');
update private.ai_processing_guard set external_processing_allowed=true where singleton;
set local role service_role;
do $$declare a jsonb;request uuid;lease uuid;begin
 select(value->>'requestId')::uuid,(value->>'leaseToken')::uuid into request,lease from account_scope;
 a:=public.reserve_ai_chat_account_model('account-scope-synthetic','potens','intent',10,'bd000000-0000-4000-8000-000000000001',request,lease,'2026-10-05','yumi');assert a->>'status'='reserved';
 a:=public.reserve_ai_chat_account_model('account-scope-synthetic','potens','explanation',10,'bd000000-0000-4000-8000-000000000001',request,lease,'2026-10-05','jonghyun');assert a->>'status'='reserved';
end;$$;
reset role;
do $$begin
 assert(select started_requests=1 from private.ai_member_daily_usage where user_id='bd000000-0000-4000-8000-000000000001');
 assert(select open_calls=2 from private.ai_budget_ledgers where ledger_id='account-scope-synthetic');
end;$$;

-- 새 요청의 회원 마지막 슬롯은 예산 예약과 함께 롤백한다.
set local role service_role;
select public.finish_ai_chat_request('bd000000-0000-4000-8000-000000000001',(value->>'requestId')::uuid,(value->>'leaseToken')::uuid,'output_privacy')from account_scope;
insert into account_scope select public.acquire_ai_chat_request('bd000000-0000-4000-8000-000000000001','bd010000-0000-4000-8000-000000000002','synthetic-account-last-slot',null,'2026-10-05')||jsonb_build_object('requestId','bd010000-0000-4000-8000-000000000002');
reset role;
update private.ai_member_daily_usage set started_requests=20 where user_id='bd000000-0000-4000-8000-000000000001';
set local role service_role;
do $$declare a jsonb;request uuid;lease uuid;begin
 select(value->>'requestId')::uuid,(value->>'leaseToken')::uuid into request,lease from account_scope where value->>'requestId'='bd010000-0000-4000-8000-000000000002';
 a:=public.reserve_ai_chat_account_model('account-scope-synthetic','potens','intent',10,'bd000000-0000-4000-8000-000000000001',request,lease,'2026-10-05','yumi');assert a->>'status'='daily_limit';
end;$$;
reset role;
do $$begin
 assert(select open_calls=2 and reserved_units=20 from private.ai_budget_ledgers where ledger_id='account-scope-synthetic');
 assert(select sum(reserved_units)=20 from private.ai_account_daily_budget);
end;$$;
