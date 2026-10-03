-- 민규 행사 RPC 회귀 검사. runner가 BEGIN/ROLLBACK을 소유하므로 여기서는 시작/종료하지 않는다.
create function pg_temp.event_fixture(p_id text,p_provider text default 'kopis') returns jsonb
language sql as $$ select jsonb_build_object(
  'provider',p_provider,'sourceId',p_id,'sourceStatus','active','title','가상 전시',
  'category','전시','region','서울','placeName',null,'publicAddress',null,
  'admission',jsonb_build_object('kind','unknown'),'sourceUrl','https://example.invalid/event',
  'collectedAt','2026-09-29T00:00:00Z','precision','date','startsOn','2026-09-29','endsOn','2026-09-29'); $$;

do $$ begin
  assert has_function_privilege('service_role','public.upsert_source_events_v1(jsonb)','EXECUTE');
  assert not has_function_privilege('anon','public.upsert_source_events_v1(jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','public.upsert_source_events_v1(jsonb)','EXECUTE');
  assert has_function_privilege('anon','public.list_event_candidates_v1(text,text)','EXECUTE');
  assert has_function_privilege('authenticated','public.list_event_candidates_v1(text,text)','EXECUTE');
  assert has_function_privilege('service_role','public.list_event_candidates_v1(text,text)','EXECUTE');
  assert not has_table_privilege('anon','private.source_events','SELECT,INSERT,UPDATE,DELETE');
  assert not has_table_privilege('authenticated','private.source_events','SELECT,INSERT,UPDATE,DELETE');
  assert not has_table_privilege('service_role','private.source_events','SELECT,INSERT,UPDATE,DELETE');
  assert not has_function_privilege('anon','private.event_calendar_date_v1(text)','EXECUTE');
  assert not has_function_privilege('authenticated','private.event_instant_v1(text)','EXECUTE');
  assert not has_function_privilege('service_role','private.valid_source_event_v1(jsonb)','EXECUTE');
end $$;
select 'EVENT_CHECK:acl';

set local role service_role;
do $$ declare v jsonb; r jsonb; a jsonb; first_id text; other_id text;
begin
  v:=pg_temp.event_fixture('stable');
  assert public.upsert_source_events_v1('[]')='{"savedCount":0}'::jsonb;
  assert public.upsert_source_events_v1(jsonb_build_array(v))='{"savedCount":1}'::jsonb;
  r:=public.list_event_candidates_v1('서울','전시');
  assert jsonb_array_length(r)=1;
  a:=r->0; first_id:=a->>'id';
  assert first_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  assert a-'id'=v, 'camelCase record or null/admission/date precision altered';
  assert not (a ? 'startsAt') and not (a ? 'endsAt');
  assert public.upsert_source_events_v1(jsonb_build_array(v))='{"savedCount":0}'::jsonb;
  assert public.upsert_source_events_v1(jsonb_build_array(v||'{"title":"동시각 다른 제목"}'))='{"savedCount":0}'::jsonb;
  v:=v||'{"title":"최신 제목","collectedAt":"2026-09-29T02:00:00Z"}';
  assert public.upsert_source_events_v1(jsonb_build_array(v))='{"savedCount":1}'::jsonb;
  assert public.upsert_source_events_v1(jsonb_build_array(pg_temp.event_fixture('stable')) )='{"savedCount":0}'::jsonb;
  r:=public.list_event_candidates_v1('서울','전시');
  assert jsonb_array_length(r)=1 and r#>>'{0,id}'=first_id and r#>>'{0,title}'='최신 제목';
  assert public.upsert_source_events_v1(jsonb_build_array(pg_temp.event_fixture('stable','tour-api')))='{"savedCount":1}'::jsonb;
  select item->>'id' into other_id from jsonb_array_elements(public.list_event_candidates_v1()) item where item->>'provider'='tour-api';
  assert other_id<>first_id, 'provider omitted from identity';
  v:=v||'{"sourceStatus":"cancelled","collectedAt":"2026-09-29T03:00:00Z"}';
  assert public.upsert_source_events_v1(jsonb_build_array(v))='{"savedCount":1}'::jsonb;
  assert jsonb_array_length(public.list_event_candidates_v1())=1, 'cancelled candidate returned';
  v:=v||'{"sourceStatus":"active","collectedAt":"2026-09-29T04:00:00Z"}';
  assert public.upsert_source_events_v1(jsonb_build_array(v))='{"savedCount":1}'::jsonb;
  select item->>'id' into other_id from jsonb_array_elements(public.list_event_candidates_v1()) item where item->>'provider'='kopis';
  assert other_id=first_id, 'reactivation changed stable id';
end $$;
select 'EVENT_CHECK:identity_stale_cancel';

do $$ declare v jsonb; r jsonb;
begin
  v:=(pg_temp.event_fixture('instant')-'startsOn'-'endsOn')||jsonb_build_object(
    'precision','instant','startsAt','2026-09-29T10:00:00.123+09:00','endsAt','2026-09-29T11:00:00.124+09:00',
    'region','부산','category',null,'sourceUrl','http://example.invalid/public-event',
    'admission',jsonb_build_object('kind','described','text','성인 입장료는 제공 페이지 확인'));
  assert public.upsert_source_events_v1(jsonb_build_array(v))='{"savedCount":1}'::jsonb;
  r:=public.list_event_candidates_v1('부산',null);
  assert jsonb_array_length(r)=1 and (r->0)-'id'=v, 'instant offset/milliseconds or optional fields lost';
  assert jsonb_array_length(public.list_event_candidates_v1('서',null))=0, 'region is not exact';
  assert jsonb_array_length(public.list_event_candidates_v1(null,'전'))=0, 'category is not exact';
  assert jsonb_array_length(public.list_event_candidates_v1('서울','전시'))=2;
  assert jsonb_array_length(public.list_event_candidates_v1('부산','전시'))=0, 'filters not intersected';
  v:=pg_temp.event_fixture('free')||'{"region":null,"category":null,"admission":{"kind":"free"}}';
  assert public.upsert_source_events_v1(jsonb_build_array(v))='{"savedCount":1}'::jsonb;
  assert jsonb_array_length(public.list_event_candidates_v1())=4;
end $$;
select 'EVENT_CHECK:timing_null_admission_exact_filters';

do $$ declare v jsonb; bad jsonb; candidate jsonb; before_count integer;
begin
  v:=pg_temp.event_fixture('invalid');
  before_count:=jsonb_array_length(public.list_event_candidates_v1());
  foreach bad in array array[
    'null'::jsonb,'{}'::jsonb,'[null]'::jsonb,jsonb_build_array(v,v),
    jsonb_build_array(v-'collectedAt'),
    jsonb_build_array(v||'{"sourceStatus":"unknown"}'),
    jsonb_build_array(v||'{"title":"<b>html</b>"}'),
    jsonb_build_array(v||'{"category":"<script>x</script>"}'),
    jsonb_build_array(v||'{"admission":{"kind":"paid"}}'),
    jsonb_build_array(v||'{"admission":{"kind":"described","text":""}}'),
    jsonb_build_array(v||'{"sourceUrl":"javascript:alert(1)"}'),
    jsonb_build_array(v||'{"sourceUrl":"https://name:password@example.invalid/event"}'),
    jsonb_build_array(v||'{"sourceUrl":"https://example.invalid/event?api_key=fixture"}'),
    jsonb_build_array(v||'{"sourceUrl":"https://example.invalid/event?token=fixture"}'),
    jsonb_build_array(v||'{"sourceUrl":"https://example.invalid/event?%61pi_key=fixture"}'),
    jsonb_build_array(v||'{"sourceUrl":"https://openapi.seoul.go.kr:8088/SYNTHETIC/json/culturalEventInfo/1/1/"}'),
    jsonb_build_array(v||'{"sourceUrl":"https://apis.data.go.kr/B551011/event"}'),
    jsonb_build_array(v||'{"sourceUrl":"https://www.kopis.or.kr/openApi/restful/pblprfr?service=fixture"}'),
    jsonb_build_array(v||'{"startsOn":"2026-02-30"}'),
    jsonb_build_array(v||'{"precision":"estimated"}'),
    jsonb_build_array(v||'{"sourceId":7}'),
    jsonb_build_array(v||'{"collectedAt":"2026-09-29T00:00:00"}'),
    jsonb_build_array(v||'{"collectedAt":"2026-09-29T00:00:00.123456Z"}'),
    jsonb_build_array((v-'startsOn'-'endsOn')||'{"precision":"instant","startsAt":"2026-09-29T10:00:00","endsAt":"2026-09-29T11:00:00Z"}'),
    jsonb_build_array((v-'startsOn'-'endsOn')||'{"precision":"instant","startsAt":"2026-09-29T10:00:00-00:00","endsAt":"2026-09-29T11:00:00Z"}')
  ] loop
    begin
      perform public.upsert_source_events_v1(bad);
      raise exception 'invalid event accepted';
    exception when sqlstate '22023' then null; end;
    assert jsonb_array_length(public.list_event_candidates_v1())=before_count, 'invalid batch changed rows';
  end loop;
  -- 앞 행이 정상이어도 뒤 행이 잘못되면 전체 입력을 되돌린다.
  begin
    perform public.upsert_source_events_v1(jsonb_build_array(pg_temp.event_fixture('atomic-new'),v||'{"sourceStatus":"unknown"}'));
    raise exception 'invalid trailing row accepted';
  exception when sqlstate '22023' then null; end;
  assert jsonb_array_length(public.list_event_candidates_v1())=before_count, 'partial batch persisted';
  select jsonb_agg(pg_temp.event_fixture('oversize-'||n)) into candidate from generate_series(1,1001) n;
  begin perform public.upsert_source_events_v1(candidate); raise exception 'oversize batch accepted';
  exception when sqlstate '22023' then null; end;
end $$;
select 'EVENT_CHECK:invalid_and_atomic_batch';

reset role;
set local role anon;
do $$ declare n integer; begin
  assert jsonb_array_length(public.list_event_candidates_v1())=4;
  begin perform public.upsert_source_events_v1('[]'); raise exception 'anon upsert allowed';
  exception when insufficient_privilege then null; end;
  begin select count(*) into n from private.source_events; raise exception 'anon table read allowed';
  exception when insufficient_privilege then null; end;
  begin insert into private.source_events default values; raise exception 'anon table write allowed';
  exception when insufficient_privilege then null; end;
  begin perform private.event_calendar_date_v1('2026-09-29'); raise exception 'anon private helper allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ declare n integer; begin
  assert jsonb_array_length(public.list_event_candidates_v1())=4;
  begin perform public.upsert_source_events_v1('[]'); raise exception 'member upsert allowed';
  exception when insufficient_privilege then null; end;
  begin select count(*) into n from private.source_events; raise exception 'member table read allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role service_role;
do $$ declare n integer; begin
  begin select count(*) into n from private.source_events; raise exception 'service direct table read allowed';
  exception when insufficient_privilege then null; end;
  begin perform private.valid_source_event_v1('{}'); raise exception 'service private helper allowed';
  exception when insufficient_privilege then null; end;
end $$;
select 'EVENT_CHECK:actual_roles_and_direct_table_denial';

do $$ declare batch jsonb; begin
  select jsonb_agg(pg_temp.event_fixture('cap-'||n)||'{"region":"한도지역","category":"한도분류"}') into batch from generate_series(1,1000) n;
  assert public.upsert_source_events_v1(batch)='{"savedCount":1000}'::jsonb;
  assert jsonb_array_length(public.list_event_candidates_v1('한도지역','한도분류'))=1000;
  assert public.upsert_source_events_v1(jsonb_build_array(pg_temp.event_fixture('cap-1001')||'{"region":"한도지역","category":"한도분류"}'))='{"savedCount":1}'::jsonb;
  begin perform public.list_event_candidates_v1('한도지역','한도분류'); raise exception 'candidate cap silently truncated';
  exception when sqlstate '54000' then null; end;
  begin perform public.list_event_candidates_v1(); raise exception 'unfiltered cap silently truncated';
  exception when sqlstate '54000' then null; end;
  assert jsonb_array_length(public.list_event_candidates_v1('서울','전시'))=2, 'cap applied before exact filters';
end $$;
reset role;
select 'EVENT_CHECK:candidate_cap';
