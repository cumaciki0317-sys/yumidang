-- 제안 01_ai_budget.sql 검사. run_proposals.py가 BEGIN/ROLLBACK으로 감싼다. 가상 원장만 사용한다.
do $$
declare x jsonb; r1 uuid; r2 uuid; r3 uuid; led jsonb; denied boolean;
begin
  -- 권한: 회원·익명은 예산 RPC를 실행할 수 없다.
  assert not has_function_privilege('authenticated', 'public.reserve_ai_budget(text,text,text,bigint)', 'execute');
  assert not has_function_privilege('anon', 'public.settle_ai_budget(uuid,text,bigint,bigint)', 'execute');
  assert has_function_privilege('service_role', 'public.reserve_ai_budget(text,text,text,bigint)', 'execute');
  -- 원장 미설정은 성공으로 숨기지 않는다.
  begin perform public.reserve_ai_budget('synthetic-ledger','potens','intent',10); denied := false;
  exception when sqlstate 'P0002' then denied := true; end;
  assert denied, 'ledger missing must fail';
  perform public.configure_ai_budget_ledger('synthetic-ledger', 100, 3);
  x := public.reserve_ai_budget('synthetic-ledger','potens','intent',60); r1 := (x->>'reservationId')::uuid; assert r1 is not null;
  -- 남은 40 < 50: 한도 초과 예약은 null.
  x := public.reserve_ai_budget('synthetic-ledger','potens','preference_match',50); assert x->'reservationId' = 'null'::jsonb;
  x := public.reserve_ai_budget('synthetic-ledger','potens','review_chunk',40); r2 := (x->>'reservationId')::uuid; assert r2 is not null;
  -- 보고된 사용량 정산: 예약 60 → 실제 25 소비.
  x := public.settle_ai_budget(r1,'usage_reported',20,5); assert (x->>'settled')::boolean;
  led := public.get_ai_budget_ledger('synthetic-ledger');
  assert (led->>'reservedUnits')::bigint = 40 and (led->>'chargedUnits')::bigint = 25 and (led->>'openCalls')::int = 1, led::text;
  -- 사용량 불명: 예약 40 전체를 소비로 유지(환불 없음).
  perform public.settle_ai_budget(r2,'usage_unknown',null,null);
  led := public.get_ai_budget_ledger('synthetic-ledger');
  assert (led->>'reservedUnits')::bigint = 0 and (led->>'chargedUnits')::bigint = 65 and (led->>'unknownUsageCalls')::int = 1, led::text;
  -- 이중 정산 거절.
  begin perform public.settle_ai_budget(r2,'usage_unknown',null,null); denied := false;
  exception when sqlstate 'P0001' then denied := true; end;
  assert denied, 'double settle must fail';
  -- 호출 수 한도: 3번째 호출까지 허용, 4번째 거절.
  x := public.reserve_ai_budget('synthetic-ledger','potens','intent',10); r3 := (x->>'reservationId')::uuid; assert r3 is not null;
  x := public.reserve_ai_budget('synthetic-ledger','potens','intent',1); assert x->'reservationId' = 'null'::jsonb, 'call limit';
  -- 잘못된 입력.
  begin perform public.settle_ai_budget(r3,'usage_reported',null,1); denied := false;
  exception when sqlstate '22023' then denied := true; end;
  assert denied;
  begin perform public.reserve_ai_budget('synthetic-ledger','potens','free_text',1); denied := false;
  exception when sqlstate '22023' then denied := true; end;
  assert denied;
  -- 원장/예약 테이블에는 원문 컬럼이 없다.
  assert not exists(select 1 from information_schema.columns where table_schema='private'
    and table_name in ('ai_budget_ledgers','ai_budget_reservations') and column_name ~ '(prompt|message|text|user)');
end $$;
