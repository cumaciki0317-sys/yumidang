-- 앞선 notice fixture의 두 네이버 회원·원 Auth session만 사용한다. 전체 outer TX rollback.
set local plpgsql.check_asserts=on;
create temp table hidden_fixture(report_id uuid,target_id uuid,identity_id uuid);
insert into hidden_fixture values('fe960000-0000-4000-8000-000000000001','fe910000-0000-4000-8000-000000000002',
 (select identity_id from private.member_episodes where profile_id=pg_temp.safety_uid(1)and ended_at is null));
-- 실제 새로운 신고 INSERT trigger, 동일 target 중복 최소키, 신고 연쇄삭제와 독립 유지.
select pg_temp.safety_actor(1);
insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,hide_target,fingerprint)
select report_id,pg_temp.safety_uid(1),(select id from private.member_episodes where profile_id=pg_temp.safety_uid(1)and ended_at is null),
 'fe960000-0000-4000-8000-000000000003','member',target_id,'offline',array['other'],true,'synthetic_hidden_only'from hidden_fixture;
do $$begin
 assert(select count(*)=1 from private.member_hidden_targets);
 assert(select not exists(select 1 from information_schema.columns where table_schema='private'and table_name='member_hidden_targets'and column_name in('report_id','description','reason_codes','asset_id','created_at')));
end;$$;
set local role authenticated;
select pg_temp.safety_actor(1);
do $$declare result jsonb;begin
 result:=public.list_my_hidden_targets();assert jsonb_array_length(result->'items')=1;
 assert result->'items'->0->>'targetType'='member';assert result->>'nextCursor'is null;
end;$$;
select pg_temp.safety_actor(2);
do $$begin assert public.list_my_hidden_targets()->'items'='[]'::jsonb;end;$$;
reset role;
do $$declare cursor_key uuid;begin
 select id into cursor_key from private.member_hidden_targets;
 perform pg_temp.safety_actor(2);
 perform pg_temp.safety_failure(format('select public.list_my_hidden_targets(20,%L)',cursor_key),'PT404');
end;$$;
delete from private.member_reports where id=(select report_id from hidden_fixture);
do $$begin assert(select count(*)=1 from private.member_hidden_targets);end;$$;
set local role authenticated;
select pg_temp.safety_actor(2);
do $$begin
 assert public.unhide_my_report_target('member','fe910000-0000-4000-8000-000000000002')->>'hidden'='false';
end;$$;
reset role;
do $$begin assert(select count(*)=1 from private.member_hidden_targets);end;$$;
set local role authenticated;
select pg_temp.safety_actor(1);
do $$begin
 assert public.unhide_my_report_target('member','fe910000-0000-4000-8000-000000000002')->>'hidden'='false';
 assert public.list_my_hidden_targets()->'items'='[]'::jsonb;
 assert public.unhide_my_report_target('member','fe910000-0000-4000-8000-000000000002')->>'hidden'='false';
end;$$;
reset role;
do $$declare r text;sig text;begin
 foreach r in array array['anon','authenticated','service_role','authenticator']loop
  assert not has_table_privilege(r,'private.member_hidden_targets','SELECT');
  assert not has_table_privilege(r,'private.member_hidden_targets','DELETE');
  assert not has_function_privilege(r,'private.capture_member_report_hidden_target()','EXECUTE');
  foreach sig in array array['public.list_my_hidden_targets(integer,uuid)','public.unhide_my_report_target(text,uuid)']loop
   assert has_function_privilege(r,sig,'EXECUTE')=(r='authenticated');
  end loop;
 end loop;
 assert not(select enabled from private.report_purge_control where singleton);
 assert not has_function_privilege('service_role','public.purge_report_retention_terminal_receipts(uuid,integer)','EXECUTE');
end;$$;
