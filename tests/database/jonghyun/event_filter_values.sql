-- 제안 05_event_filter_values.sql 검사(04 필요). run_proposals.py가 BEGIN/ROLLBACK으로 감싼다. 가상 행사만 사용.
do $$
declare x jsonb;
begin
  perform public.upsert_events(jsonb_build_array(
    jsonb_build_object('provider','kopis','sourceId','fv-1','sourceStatus','active','title','가상 공연','category','연극','region','서울특별시',
      'placeName',null,'publicAddress',null,'admission',jsonb_build_object('kind','unknown'),'sourceUrl',null,'collectedAt','2026-09-30T00:00:00Z',
      'precision','date','startsOn','2099-01-01','endsOn','2099-01-02'),
    jsonb_build_object('provider','kopis','sourceId','fv-2','sourceStatus','active','title','가상 공연2','category','연극','region','부산광역시',
      'placeName',null,'publicAddress',null,'admission',jsonb_build_object('kind','unknown'),'sourceUrl',null,'collectedAt','2026-09-30T00:00:00Z',
      'precision','date','startsOn','2099-01-01','endsOn','2099-01-02'),
    jsonb_build_object('provider','tour-api','sourceId','fv-3','sourceStatus','active','title','가상 축제','category','행사/공연/축제','region','서울특별시',
      'placeName',null,'publicAddress',null,'admission',jsonb_build_object('kind','unknown'),'sourceUrl',null,'collectedAt','2026-09-30T00:00:00Z',
      'precision','date','startsOn','2099-01-01','endsOn','2099-01-02'),
    jsonb_build_object('provider','kopis','sourceId','fv-4','sourceStatus','cancelled','title','취소 공연','category','뮤지컬','region','대구광역시',
      'placeName',null,'publicAddress',null,'admission',jsonb_build_object('kind','unknown'),'sourceUrl',null,'collectedAt','2026-09-30T00:00:00Z',
      'precision','date','startsOn','2099-01-01','endsOn','2099-01-02')));
  set local role anon;
  x := public.list_event_filter_values();
  reset role;
  -- 제공처별로 구분되고, 같은 값(서울특별시)도 제공처가 다르면 따로 나온다.
  assert x->'regions' @> '[{"provider":"kopis","value":"서울특별시","count":1},{"provider":"tour-api","value":"서울특별시","count":1},{"provider":"kopis","value":"부산광역시","count":1}]'::jsonb, x::text;
  assert x->'categories' @> '[{"provider":"kopis","value":"연극","count":2},{"provider":"tour-api","value":"행사/공연/축제","count":1}]'::jsonb, x::text;
  -- 취소된 행사만 가진 값은 빠진다.
  assert not (x::text like '%대구광역시%') and not (x::text like '%뮤지컬%'), x::text;
  assert has_function_privilege('anon', 'public.list_event_filter_values()', 'execute');
end $$;
