-- 기본 합성 일반 이의 접수 뒤 심사 검증. 외부 판정/운영자가 아닌 owner fixture.
create temp table general_resolution_ref(value jsonb);grant all on general_resolution_ref to authenticated;
savepoint outcome_test;
set local role authenticated;
select pg_temp.safety_actor(4);
select pg_temp.safety_failure(format('select public.resolve_assigned_general_sanction_appeal(%L,%L,%L,3,2,1,%L,null,null,null,null,null,null)',(select report_id from review_cases where n=1),(select value->>'appealId'from general_appeal_ref),pg_temp.review_request(910),'rejected'),'42501');
select pg_temp.safety_actor(3);
insert into general_resolution_ref select public.resolve_assigned_general_sanction_appeal((select report_id from review_cases where n=1),(select(value->>'appealId')::uuid from general_appeal_ref),pg_temp.review_request(910),3,2,1,'rejected',null,null,null,null,null,null);
do $$declare first jsonb;again jsonb;begin
 select value into first from general_resolution_ref;
 assert first->>'appealState'='rejected'and first->>'reportVersion'='4'and first->>'decisionId'is null;
 again:=public.resolve_assigned_general_sanction_appeal((select report_id from review_cases where n=1),(select(value->>'appealId')::uuid from general_appeal_ref),pg_temp.review_request(910),3,2,1,'rejected',null,null,null,null,null,null);
 assert again=first||jsonb_build_object('alreadyApplied',true);
end;$$;
reset role;
do $$begin
 assert(select count(*)=1 from private.safety_incident_revisions);
 assert(select count(*)=1 from private.safety_sanction_applications where revoked_at is null);
 assert(select count(*)=1 from private.safety_appeals where state='rejected'and resolved_at is not null);
 assert not has_table_privilege('authenticated','private.general_sanction_appeal_resolutions','SELECT');
end;$$;

rollback to savepoint outcome_test;
set local role authenticated;
select pg_temp.safety_actor(3);
insert into general_resolution_ref select public.resolve_assigned_general_sanction_appeal((select report_id from review_cases where n=1),(select(value->>'appealId')::uuid from general_appeal_ref),pg_temp.review_request(911),3,2,1,'accepted','normal','invalidated','none','decision_corrected','none',null);
do $$declare first jsonb;again jsonb;begin
 select value into first from general_resolution_ref;
 assert first->>'appealState'='accepted'and first->>'reportVersion'='4'and first->>'decisionId'is not null;
 again:=public.resolve_assigned_general_sanction_appeal((select report_id from review_cases where n=1),(select(value->>'appealId')::uuid from general_appeal_ref),pg_temp.review_request(911),3,2,1,'accepted','normal','invalidated','none','decision_corrected','none',null);
 assert again=first||jsonb_build_object('alreadyApplied',true);
end;$$;
reset role;
do $$begin
 assert not exists(select 1 from private.safety_sanction_applications where revoked_at is null);
 assert(select count(*)=1 from private.safety_appeals where state='accepted'and resolved_at is not null);
 assert(select count(*)=2 from private.safety_incident_revisions);
end;$$;
