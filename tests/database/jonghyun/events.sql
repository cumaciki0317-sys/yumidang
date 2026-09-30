-- 제안 04_events.sql 검사. run_proposals.py가 BEGIN/ROLLBACK으로 감싼다. 가상 행사만 사용한다.
-- 한 트랜잭션 안의 now()는 고정이므로 모든 날짜를 now()의 한국 날짜 기준 상대값으로 만든다.

create function pg_temp.seoul_today() returns date language sql stable as $$
  select (now() at time zone 'Asia/Seoul')::date;
$$;
-- 날짜 정밀도 가상 행사.
create function pg_temp.dev(p_provider text, p_source text, p_title text, p_from integer, p_to integer,
  p_status text default 'active', p_collected text default '2026-09-29T00:00:00.000Z',
  p_place text default null, p_address text default null, p_region text default '가상시', p_category text default '연극',
  p_admission jsonb default '{"kind":"unknown"}')
returns jsonb language sql stable as $$
  select jsonb_build_object('provider', p_provider, 'sourceId', p_source, 'sourceStatus', p_status, 'title', p_title,
    'category', p_category, 'region', p_region, 'placeName', p_place, 'publicAddress', p_address,
    'admission', p_admission, 'sourceUrl', null, 'collectedAt', p_collected, 'precision', 'date',
    'startsOn', to_char(pg_temp.seoul_today() + p_from, 'YYYY-MM-DD'), 'endsOn', to_char(pg_temp.seoul_today() + p_to, 'YYYY-MM-DD'));
$$;
create function pg_temp.titles(p_page jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(i->>'title' order by o), '{}') from jsonb_array_elements(p_page->'items') with ordinality as t(i, o);
$$;

do $$
declare
  r jsonb; p jsonb; t text[]; all_titles text[]; cursor jsonb; pages integer := 0; denied boolean; bad jsonb;
  instant_event jsonb;
begin
  -- 권한: 조회는 anon/authenticated, 저장은 service_role만. 테이블 직접 접근 없음.
  assert has_function_privilege('anon', 'public.list_public_events(jsonb,jsonb,integer)', 'execute');
  assert has_function_privilege('authenticated', 'public.list_public_events(jsonb,jsonb,integer)', 'execute');
  assert not has_function_privilege('anon', 'public.upsert_events(jsonb)', 'execute');
  assert not has_function_privilege('authenticated', 'public.upsert_events(jsonb)', 'execute');
  assert has_function_privilege('service_role', 'public.upsert_events(jsonb)', 'execute');
  assert not has_table_privilege('anon', 'private.events', 'select');
  assert not has_table_privilege('service_role', 'private.events', 'select');
  assert (select relrowsecurity from pg_class where oid = 'private.events'::regclass);

  instant_event := jsonb_build_object('provider', 'synthetic-a', 'sourceId', 'E-instant', 'sourceStatus', 'active',
    'title', '가상 시각 행사', 'category', '연극', 'region', '가상시', 'placeName', null, 'publicAddress', null,
    'admission', '{"kind":"described","text":"현장 문의"}'::jsonb, 'sourceUrl', 'https://example.invalid/e',
    'collectedAt', '2026-09-29T00:00:00.000Z', 'precision', 'instant',
    'startsAt', to_char((now() - interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'endsAt', to_char((now() + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

  -- 첫 페이지 저장.
  p := jsonb_build_array(
    pg_temp.dev('synthetic-a', 'A', '가상 진행 연극', -5, 5, p_place => 'Art  Hall'),
    pg_temp.dev('synthetic-a', 'B', '가상 예정 공연', 3, 4, p_address => '가상시 예시구 1', p_admission => '{"kind":"free"}'),
    pg_temp.dev('synthetic-a', 'C', '가상 종료 공연', -10, -8),
    pg_temp.dev('synthetic-a', 'D', '가상 취소 공연', -1, 1, p_status => 'cancelled'),
    pg_temp.dev('synthetic-a', 'H', '가상 오늘 시작', 0, 1, p_category => '전시'),
    -- 다른 제공처의 같은 제목·같은 원천 ID: 병합하지 않는다.
    pg_temp.dev('synthetic-b', 'A', '가상 진행 연극', -5, 5, p_region => '다른시'),
    instant_event);
  r := public.upsert_events(p);
  assert r = '{"receivedCount":7,"insertedCount":7,"updatedCount":0,"staleCount":0}'::jsonb, r::text;
  assert (select count(*) from private.events) = 7;
  assert (select count(*) from private.events where source_id = 'A') = 2, 'different providers are not merged';
  assert (select admission from private.events where provider='synthetic-a' and source_id='B') = '{"kind":"free"}'::jsonb;

  -- 같은 페이지 재처리: 중복 없음(갱신만).
  r := public.upsert_events(p);
  assert r = '{"receivedCount":7,"insertedCount":0,"updatedCount":7,"staleCount":0}'::jsonb, r::text;
  assert (select count(*) from private.events) = 7;

  -- 더 오래된 수집본은 최신 저장본을 덮어쓰지 않는다.
  r := public.upsert_events(jsonb_build_array(pg_temp.dev('synthetic-a', 'A', '오래된 제목', -5, 5,
    p_collected => '2026-09-28T00:00:00.000Z', p_place => 'Art  Hall')));
  assert r->>'staleCount' = '1' and r->>'updatedCount' = '0', r::text;
  assert (select title from private.events where provider = 'synthetic-a' and source_id = 'A') = '가상 진행 연극';

  -- 한 페이지에 없는 기존 행사는 삭제하지 않는다.
  r := public.upsert_events(jsonb_build_array(pg_temp.dev('synthetic-a', 'B', '가상 예정 공연', 3, 4,
    p_collected => '2026-09-30T00:00:00.000Z', p_address => '가상시 예시구 1')));
  assert r->>'updatedCount' = '1', r::text;
  assert (select count(*) from private.events) = 7, 'missing-from-page events are kept';

  -- 취소는 저장하되 조회에서 숨긴다. 비용 미상은 unknown 그대로 유지.
  assert (select source_status from private.events where source_id = 'D') = 'cancelled';
  r := public.list_public_events('{"mode":"overlapping"}', null, 50);
  t := pg_temp.titles(r);
  assert not ('가상 취소 공연' = any(t)), t::text;
  -- 정렬: 진행 중(최근 시작순: 시각 행사(1시간 전) → 오늘 시작 → 5일 전 시작 두 건은 id순) → 예정 → 종료.
  assert t[1] = '가상 시각 행사' and t[2] = '가상 오늘 시작' and t[3] = '가상 진행 연극' and t[4] = '가상 진행 연극'
    and t[5] = '가상 예정 공연' and t[6] = '가상 종료 공연' and array_length(t, 1) = 6, t::text;
  assert (select (i->>'id')::uuid < (r->'items'->3->>'id')::uuid from (select r->'items'->2 as i) x), 'tie broken by id';
  assert r->'items'->2->'admission' = '{"kind":"unknown"}'::jsonb;
  assert r->'items'->0->'admission' = '{"kind":"described","text":"현장 문의"}'::jsonb;
  assert r->'items'->0->>'precision' = 'instant' and r->'items'->0 ? 'startsAt' and not (r->'items'->0 ? 'startsOn');
  assert r->'items'->1->>'precision' = 'date' and r->'items'->1->>'startsOn' = to_char(pg_temp.seoul_today(), 'YYYY-MM-DD');
  assert r->'items'->5->>'state' = 'ended' and r->'items'->4->>'state' = 'upcoming' and r->'items'->0->>'state' = 'ongoing';
  assert r->'nextCursor' = 'null'::jsonb;

  -- 공고 선택: 종료 제외. 진행 중만: 진행 중 그룹만.
  t := pg_temp.titles(public.list_public_events('{"mode":"post_selection"}', null, 50));
  assert not ('가상 종료 공연' = any(t)) and '가상 예정 공연' = any(t) and array_length(t, 1) = 5, t::text;
  t := pg_temp.titles(public.list_public_events('{"mode":"overlapping","ongoingOnly":true}', null, 50));
  assert array_length(t, 1) = 4 and not ('가상 예정 공연' = any(t)), t::text;
  -- 이번 주 신규: 오늘 시작 행사는 항상 포함, 종료·5일 전 시작(지난 주일 수 있음)의 포함 여부는 주간 계산을 따른다.
  r := public.list_public_events('{"mode":"new_this_week"}', null, 50);
  t := pg_temp.titles(r);
  assert '가상 오늘 시작' = any(t) and not ('가상 종료 공연' = any(t)), t::text;
  assert not exists (select 1 from jsonb_array_elements(r->'items') i where i->>'state' = 'ended');

  -- 기간 겹침: 종료 날짜 포함. 과거 기간 + 진행 중만 = 0건(조건을 초기화하지 않음).
  t := pg_temp.titles(public.list_public_events(jsonb_build_object('mode', 'overlapping', 'period',
    jsonb_build_object('start', to_char(pg_temp.seoul_today() + 4, 'YYYY-MM-DD'), 'end', to_char(pg_temp.seoul_today() + 4, 'YYYY-MM-DD'))), null, 50));
  assert t = array['가상 진행 연극', '가상 진행 연극', '가상 예정 공연'], t::text;
  r := public.list_public_events(jsonb_build_object('mode', 'overlapping', 'ongoingOnly', true, 'period',
    jsonb_build_object('start', to_char(pg_temp.seoul_today() - 9, 'YYYY-MM-DD'), 'end', to_char(pg_temp.seoul_today() - 9, 'YYYY-MM-DD'))), null, 50);
  assert r = '{"items":[],"nextCursor":null}'::jsonb, r::text;

  -- 키워드: 행사명/장소명/공개 주소 중 한 필드. 대소문자·연속 공백 무시. 필드를 이어 붙이지 않음.
  t := pg_temp.titles(public.list_public_events('{"mode":"overlapping","query":"  ART   hall "}', null, 50));
  assert t = array['가상 진행 연극'], t::text;
  t := pg_temp.titles(public.list_public_events('{"mode":"overlapping","query":"예시구"}', null, 50));
  assert t = array['가상 예정 공연'], t::text;
  t := pg_temp.titles(public.list_public_events('{"mode":"overlapping","query":"연극 art"}', null, 50));
  assert t = '{}', t::text;
  t := pg_temp.titles(public.list_public_events('{"mode":"overlapping","query":"   "}', null, 50));
  assert array_length(t, 1) = 6, t::text;
  -- 지역·종류 정확 일치.
  t := pg_temp.titles(public.list_public_events('{"mode":"overlapping","region":"다른시"}', null, 50));
  assert t = array['가상 진행 연극'], t::text;
  t := pg_temp.titles(public.list_public_events('{"mode":"overlapping","category":"전시"}', null, 50));
  assert t = array['가상 오늘 시작'], t::text;
  t := pg_temp.titles(public.list_public_events('{"mode":"overlapping","category":"전"}', null, 50));
  assert t = '{}', t::text;

  -- keyset 페이지: 필터·정렬 후 분할. 두 건씩 읽은 결과가 전체 한 번 조회와 같고 중복이 없다.
  all_titles := pg_temp.titles(public.list_public_events('{"mode":"overlapping"}', null, 50));
  t := '{}'; cursor := null;
  loop
    r := public.list_public_events('{"mode":"overlapping"}', cursor, 2);
    pages := pages + 1;
    t := t || pg_temp.titles(r);
    assert jsonb_array_length(r->'items') <= 2;
    exit when r->'nextCursor' = 'null'::jsonb;
    assert r->'nextCursor'->>'id' = r->'items'->1->>'id', 'cursor id = last item';
    assert (r->'nextCursor'->>'rank')::int between 0 and 2;
    cursor := r->'nextCursor';
    assert pages < 10;
  end loop;
  assert pages = 3 and t = all_titles, t::text;
  assert (select count(distinct x) from jsonb_array_elements(
    public.list_public_events('{"mode":"overlapping"}', null, 50)->'items') x) = 6;

  -- 잘못된 조회 입력은 22023.
  foreach bad in array array['{"mode":"unknown"}'::jsonb, '{"mode":"overlapping","extra":1}', '{"mode":"overlapping","ongoingOnly":"yes"}',
    '{"mode":"overlapping","period":{"start":"2026-10-05"}}', '{"mode":"overlapping","period":{"start":"2026-10-05","end":"2026-10-01"}}',
    '{"mode":"overlapping","period":{"start":"2026-02-30","end":"2026-03-01"}}', '{"mode":"overlapping","region":" "}', '{}'] loop
    begin perform public.list_public_events(bad, null, 10); denied := false;
    exception when sqlstate '22023' then denied := true; end;
    assert denied, bad::text;
  end loop;
  foreach bad in array array['{"rank":3,"key":"1","id":"00000000-0000-4000-8000-000000000000"}'::jsonb,
    '{"rank":0,"key":"1"}', '{"rank":0,"key":"abc","id":"00000000-0000-4000-8000-000000000000"}',
    '{"rank":0,"key":"1","id":"00000000-0000-4000-8000-000000000000","x":1}', '"cursor"'] loop
    begin perform public.list_public_events('{"mode":"overlapping"}', bad, 10); denied := false;
    exception when sqlstate '22023' then denied := true; end;
    assert denied, bad::text;
  end loop;
  begin perform public.list_public_events('{"mode":"overlapping"}', null, 0); denied := false;
  exception when sqlstate '22023' then denied := true; end;
  assert denied;
  begin perform public.list_public_events('{"mode":"overlapping"}', null, 51); denied := false;
  exception when sqlstate '22023' then denied := true; end;
  assert denied;

  -- 누락 필드의 SQL NULL 때문에 RPC IF와 테이블 CHECK가 모두 우회되던 입력을 거절한다.
  foreach bad in array array['{}'::jsonb, '{"kind":"described"}', '{"text":"현장 문의"}',
    '{"kind":null}', '{"kind":"described","text":null}', 'null', '0', 'true', '"입장료"', '[]'] loop
    begin
      perform public.upsert_events(jsonb_build_array(
        pg_temp.dev('synthetic-a', 'ADMISSION-BEFORE', '부분 저장 금지', 0, 1),
        pg_temp.dev('synthetic-a', 'ADMISSION-BAD', '잘못된 입장료', 0, 1, p_admission => bad)));
      denied := false;
    exception when sqlstate '22023' then denied := true; end;
    assert denied, 'RPC admission rejection: ' || bad::text;
    assert not exists(select 1 from private.events where source_id in ('ADMISSION-BEFORE','ADMISSION-BAD')),
      'invalid admission rolls back the complete batch';
    begin
      update private.events set admission=bad where provider='synthetic-a' and source_id='A';
      denied := false;
    exception when check_violation then denied := true; end;
    assert denied, 'table admission rejection: ' || bad::text;
    assert (select admission from private.events where provider='synthetic-a' and source_id='A') = '{"kind":"unknown"}'::jsonb;
  end loop;

  -- 잘못된 저장 입력은 전체 거절(부분 저장 없음).
  foreach bad in array array[
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X1', '새 행사', 0, 1), pg_temp.dev('synthetic-a', 'X1', '새 행사', 0, 1)),
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X2', '새 행사', 0, 1, p_status => 'unknown')),
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X3', '새 행사', 0, 1) - 'region'),
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X4', '새 행사', 0, 1) || '{"extra":1}'),
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X5', '새 행사', 0, 1) || '{"startsOn":"2026-02-30"}'),
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X6', '새 행사', 1, 0)),
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X7', '<b>새</b> 행사', 0, 1)),
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X8', '새 행사', 0, 1, p_admission => '{"kind":"free","text":"x"}')),
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X9', '새 행사', 0, 1, p_collected => '2026-09-29T00:00:00')),
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X10', '새 행사', 0, 1) || '{"sourceUrl":"https://user:pw@example.invalid/"}'),
    jsonb_build_array(pg_temp.dev('Bad Provider', 'X11', '새 행사', 0, 1)),
    jsonb_build_array(instant_event || '{"sourceId":"X12","endsAt":"2026-01-01T00:00:00-00:00"}'),
    jsonb_build_array(pg_temp.dev('synthetic-a', 'X13', '새 행사', 0, 1), '"not-object"'::jsonb),
    '{"not":"array"}'::jsonb] loop
    begin perform public.upsert_events(bad); denied := false;
    exception when sqlstate '22023' then denied := true; end;
    assert denied, bad::text;
  end loop;
  assert (select count(*) from private.events) = 7, 'rejected batches store nothing';
end $$;

-- 실제 역할 전환: anon은 조회 가능, 저장·테이블 직접 조회 불가.
set local role anon;
do $$
declare r jsonb; denied boolean;
begin
  r := public.list_public_events('{"mode":"overlapping"}', null, 50);
  assert jsonb_array_length(r->'items') = 6, r::text;
  begin perform public.upsert_events('[]'); denied := false;
  exception when insufficient_privilege then denied := true; end;
  assert denied, 'anon cannot upsert';
  begin perform count(*) from private.events; denied := false;
  exception when insufficient_privilege then denied := true; end;
  assert denied, 'anon cannot read table';
end $$;
reset role;
set local role authenticated;
do $$
declare denied boolean;
begin
  assert jsonb_array_length(public.list_public_events('{"mode":"post_selection"}', null, 50)->'items') = 5;
  begin perform public.upsert_events('[]'); denied := false;
  exception when insufficient_privilege then denied := true; end;
  assert denied, 'authenticated cannot upsert';
end $$;
reset role;
set local role service_role;
do $$
begin
  assert public.upsert_events('[]') = '{"receivedCount":0,"insertedCount":0,"updatedCount":0,"staleCount":0}'::jsonb;
end $$;
reset role;
