-- 기존 합성 판정과 성공 안내 fixture 이후, 전체 rollback 실행 전용.
create temp table general_appeal_ref(value jsonb);grant all on general_appeal_ref to authenticated;
set local role authenticated;
select pg_temp.safety_actor(2);
insert into general_appeal_ref select public.submit_my_general_sanction_appeal((select notice_id from delivery_test_refs),pg_temp.review_request(900),'합성 이의 사유');
do $$declare first jsonb;again jsonb;begin
 select value into first from general_appeal_ref;
 assert first->>'state'='reviewing'and(first->>'alreadyApplied')::boolean=false;
 again:=public.submit_my_general_sanction_appeal((select notice_id from delivery_test_refs),pg_temp.review_request(900),'합성 이의 사유');
 assert again=first||jsonb_build_object('alreadyApplied',true);
 assert public.get_my_general_sanction_appeal((first->>'appealId')::uuid)=again;
 perform pg_temp.safety_failure(format('select public.submit_my_general_sanction_appeal(%L,%L,%L)',(select notice_id from delivery_test_refs),pg_temp.review_request(900),'다른 사유'),'40001');
 perform pg_temp.safety_failure(format('select public.submit_my_general_sanction_appeal(%L,%L,%L)',(select notice_id from delivery_test_refs),pg_temp.review_request(901),'새 신청'),'40001');
end;$$;
select pg_temp.safety_actor(1);
select pg_temp.safety_failure(format('select public.get_my_general_sanction_appeal(%L)',(select value->>'appealId'from general_appeal_ref)),'PT404');
reset role;
do $$begin
 assert(select count(*)=1 from private.safety_appeals where kind='general');
 assert not has_table_privilege('authenticated','private.general_sanction_appeal_receipts','SELECT');
 perform pg_temp.safety_failure(format('update private.member_reports set final_closed_at=clock_timestamp(),retention_due_at=clock_timestamp()+interval %L where id=%L','90 days',(select report_id from private.general_sanction_appeal_receipts)),'55000');
end;$$;
-- 이미 접수된 요청은 마감 뒤에도 동일 접수 사실로 재확인된다. 신규 요청만 막는다.
update private.general_notice_deliveries set prepared_at=clock_timestamp()-interval '10 days',provided_at=clock_timestamp()-interval '9 days',deadline_at=clock_timestamp()-interval '9 days'+interval '168 hours';
set local role authenticated;
select pg_temp.safety_actor(2);
select public.submit_my_general_sanction_appeal((select notice_id from delivery_test_refs),pg_temp.review_request(900),'합성 이의 사유');
reset role;
delete from private.general_sanction_appeal_receipts;
delete from private.safety_appeals where kind='general';
set local role authenticated;
select pg_temp.safety_actor(2);
select pg_temp.safety_failure(format('select public.submit_my_general_sanction_appeal(%L,%L,%L)',(select notice_id from delivery_test_refs),pg_temp.review_request(902),'기한 이후'),'PT409');
reset role;
