-- 일반 이의 인용 fixture 이후 최종 종결: 상태/보관 시계/receipt 모두 원자적.
set local role authenticated;
select pg_temp.safety_actor(4);
select pg_temp.safety_failure(format('select public.final_close_assigned_member_report(%L,%L,4,2,%L)',(select report_id from review_cases where n=1),pg_temp.review_request(950),'검토 종결'),'42501');
select pg_temp.safety_actor(3);
select pg_temp.safety_failure(format('select public.final_close_assigned_member_report(%L,%L,3,2,%L)',(select report_id from review_cases where n=1),pg_temp.review_request(950),'검토 종결'),'40001');
create temp table closure_ref(value jsonb);grant all on closure_ref to authenticated;
insert into closure_ref select public.final_close_assigned_member_report((select report_id from review_cases where n=1),pg_temp.review_request(950),4,2,'검토 종결');
do $$declare first jsonb;again jsonb;begin
 select value into first from closure_ref;
 assert first->>'status'='resolved'and first->>'version'='5';
 assert(first->>'retentionDueAt')::timestamptz=(first->>'finalClosedAt')::timestamptz+interval '2160 hours';
 again:=public.final_close_assigned_member_report((select report_id from review_cases where n=1),pg_temp.review_request(950),4,2,'검토 종결');
 assert again=first||jsonb_build_object('alreadyApplied',true);
end;$$;
select pg_temp.safety_failure(format('select public.final_close_assigned_member_report(%L,%L,4,2,%L)',(select report_id from review_cases where n=1),pg_temp.review_request(950),'다른 내용'),'40001');
reset role;
do $$begin
 assert(select count(*)=1 from private.assigned_report_final_closures);
 assert not has_table_privilege('authenticated','private.assigned_report_final_closures','SELECT');
 assert not has_function_privilege('service_role','public.final_close_assigned_member_report(uuid,uuid,bigint,bigint,text)','EXECUTE');
end;$$;
