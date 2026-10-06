-- 일반 안내 성공 제공: 준비/읽기는 시계를 시작하지 않고 확인 재시도는 연장하지 않는다.
-- 기존 assigned_report_notice_receipts fixture의 초기 판정 직전까지를 전용 실행기가 준비한다.
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(1,501,'initial',2,1,0,'normal','confirmed','companion','spam','minor','spam');
reset role;
create temp table delivery_test_refs(notice_id uuid,delivery_id uuid,provided timestamptz,deadline timestamptz);
grant all on delivery_test_refs to authenticated;
insert into delivery_test_refs(notice_id)select id from private.member_decision_notices where violation_outcome='confirmed';
set local role authenticated;
select pg_temp.safety_actor(2);
select pg_temp.safety_failure(format('select public.prepare_my_general_notice_delivery(%L)',(select notice_id from delivery_test_refs)),'55000');
reset role;
update private.general_notice_delivery_control set enabled=true;
set local role authenticated;
do $$declare item jsonb;again jsonb;begin
 item:=public.prepare_my_general_notice_delivery((select notice_id from delivery_test_refs));
 assert item->>'providedAt'is null and item->>'deadlineAt'is null;
 assert(select count(*)=5 from jsonb_object_keys(item));
 update delivery_test_refs set delivery_id=(item->>'deliveryId')::uuid;
 again:=public.prepare_my_general_notice_delivery((select notice_id from delivery_test_refs));assert again=item;
 perform public.read_my_decision_notice((select notice_id from delivery_test_refs));
 assert public.prepare_my_general_notice_delivery((select notice_id from delivery_test_refs))->>'providedAt'is null;
 perform pg_temp.safety_failure(format('select public.acknowledge_my_general_notice_provided(%L,%L)',(select notice_id from delivery_test_refs),gen_random_uuid()),'PT404');
end;$$;
select pg_temp.safety_actor(1);
select pg_temp.safety_failure(format('select public.prepare_my_general_notice_delivery(%L)',(select notice_id from delivery_test_refs)),'PT404');
select pg_temp.safety_actor(2);
-- 독립 SQL statement에서 서버 수신 시각을 기록한다.
update delivery_test_refs set provided=(public.acknowledge_my_general_notice_provided(notice_id,delivery_id)->>'providedAt')::timestamptz;
update delivery_test_refs set deadline=(public.acknowledge_my_general_notice_provided(notice_id,delivery_id)->>'deadlineAt')::timestamptz;
do $$declare item jsonb;begin
 item:=public.acknowledge_my_general_notice_provided((select notice_id from delivery_test_refs),(select delivery_id from delivery_test_refs));
 assert(item->>'providedAt')::timestamptz=(select provided from delivery_test_refs);
 assert(item->>'deadlineAt')::timestamptz=(select provided+interval '168 hours'from delivery_test_refs);
end;$$;
reset role;
do $$begin
 assert not exists(select 1 from private.safety_sanction_applications where notified_at is not null);
 assert not has_table_privilege('authenticated','private.general_notice_deliveries','SELECT');
 assert not has_function_privilege('service_role','public.prepare_my_general_notice_delivery(uuid)','EXECUTE');
 assert not has_function_privilege('authenticated','private.general_notice_delivery_context(uuid)','EXECUTE');
 perform pg_temp.safety_failure('update private.general_notice_deliveries set deadline_at=null','23514');
end;$$;
set local role authenticated;
select pg_temp.safety_actor(3);
select pg_temp.adjudicate(1,502,'correction',3,2,1,'normal','invalidated','none','decision_corrected','none',null);
select pg_temp.safety_actor(2);
select pg_temp.safety_failure(format('select public.acknowledge_my_general_notice_provided(%L,%L)',(select notice_id from delivery_test_refs),(select delivery_id from delivery_test_refs)),'PT404');
reset role;
