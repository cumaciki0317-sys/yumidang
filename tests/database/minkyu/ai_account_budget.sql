-- 합성 원장 값이며 운영 호출 한도가 아니다. 실제 DB 단일TX에서 새 helper/정산을 검증한다.
select public.configure_ai_budget_accounts(array['yumi','jonghyun']);
select public.configure_ai_budget_ledger('account-pool-synthetic',100000000,100);
create temp table pool_refs(name text primary key,value jsonb);
create function pg_temp.pool_failure(command text,expected text)returns void language plpgsql as $$declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,'unexpected budget failure';end;$$;
insert into pool_refs values('first',private.reserve_ai_account_budget('account-pool-synthetic','potens','intent',3200000,'yumi'));
do $$declare denied jsonb;begin
 assert(select value->>'status'='reserved'from pool_refs where name='first');
 denied:=private.reserve_ai_account_budget('account-pool-synthetic','potens','intent',1,'yumi');assert denied->>'status'='account_budget_denied';
 assert(select open_calls=1 from private.ai_budget_ledgers where ledger_id='account-pool-synthetic');
end;$$;
insert into pool_refs values('second',private.reserve_ai_account_budget('account-pool-synthetic','potens','intent',3200000,'jonghyun'));
do $$declare denied jsonb;begin
 denied:=private.reserve_ai_account_budget('account-pool-synthetic','potens','intent',1,'jonghyun');assert denied->>'status'='global_budget_denied';
 assert(select open_calls=2 from private.ai_budget_ledgers where ledger_id='account-pool-synthetic');
end;$$;
select pg_temp.pool_failure(format('select public.settle_ai_budget(%L,%L,1,1)',(select value->>'reservationId'from pool_refs where name='first'),'usage_reported'),'42501');
-- 미확인 사용은 예약과 원래 일자를 보존한다.
select public.settle_ai_account_budget((value->>'reservationId')::uuid,value->>'accountId',(value->>'accountDay')::date,'usage_unknown',null,null)from pool_refs where name='second';
select public.settle_ai_account_budget((value->>'reservationId')::uuid,value->>'accountId',(value->>'accountDay')::date,'usage_unknown',null,null)from pool_refs where name='second';
do $$begin
 assert(select count(*)=2 from private.ai_budget_reservations where ledger_id='account-pool-synthetic');
 assert(select reserved_units=6400000 and open_calls=2 from private.ai_budget_ledgers where ledger_id='account-pool-synthetic');
end;$$;
select public.settle_ai_account_budget((value->>'reservationId')::uuid,value->>'accountId',(value->>'accountDay')::date,'usage_reported',8,2)from pool_refs where name='first';
select public.settle_ai_account_budget((value->>'reservationId')::uuid,value->>'accountId',(value->>'accountDay')::date,'usage_reported',8,2)from pool_refs where name='first';
select pg_temp.pool_failure(format('select public.settle_ai_account_budget(%L,%L,%L,%L,9,2)',(select value->>'reservationId'from pool_refs where name='first'),'yumi',(select value->>'accountDay'from pool_refs where name='first'),'usage_reported'),'40001');
do $$begin
 assert(select open_calls=1 and settled_calls=1 and reserved_units=3200000 and charged_units=10 from private.ai_budget_ledgers where ledger_id='account-pool-synthetic');
 assert(select count(*)=2 from private.ai_account_budget_reservations);
 assert(select sum(reserved_units)=3200000 and sum(charged_units)=10 from private.ai_global_daily_budget);
 assert not has_table_privilege('service_role','private.ai_account_budget_reservations','SELECT');
 assert not has_function_privilege('authenticated','public.reserve_ai_chat_account_model(text,text,text,bigint,uuid,uuid,uuid,text,text)','EXECUTE');
 assert not has_function_privilege('service_role','private.settle_legacy_ai_budget_core(uuid,text,bigint,bigint)','EXECUTE');
end;$$;
select public.configure_ai_budget_ledger('account-pool-call-gate',100000000,1);
insert into pool_refs values('call_gate',private.reserve_ai_account_budget('account-pool-call-gate','potens','intent',1,'yumi'));
do $$begin
 assert private.reserve_ai_account_budget('account-pool-call-gate','potens','intent',1,'jonghyun')->>'status'='global_budget_denied';
end;$$;
