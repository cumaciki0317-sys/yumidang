-- 종현 제안 SQL 05(민규 채택 필요). 정식 마이그레이션이 아니며 채택 시 BEGIN/COMMIT으로 감싼다. 전제: 04_events.sql.
-- 2026-09-30 사용자 결정(U9-A): 행사 필터는 제공처 원문 지역·분류 값을 그대로 쓰고, 화면이 고를 값 목록을 제공한다.
-- 값이 섞이지 않도록 제공처를 함께 돌려준다(화면 표시 예: “연극 · KOPIS”). 공급사가 늘어 값이 많아지면
-- 원문은 그대로 두고 앱 분류 대응표를 한 겹 추가한다(이 SQL 범위 밖).
-- 취소된 행사만 가진 값은 목록에서 뺀다. 반환은 공개 행사 조회와 같은 공개 정보뿐이다.
create function public.list_event_filter_values()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'regions', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'value', region, 'count', n) order by provider, region)
      from (select provider, region, count(*) n from private.events where source_status = 'active' and region is not null
        group by provider, region) r), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'value', category, 'count', n) order by provider, category)
      from (select provider, category, count(*) n from private.events where source_status = 'active' and category is not null
        group by provider, category) c), '[]'::jsonb));
$$;
revoke all on function public.list_event_filter_values() from public, anon, authenticated, service_role;
grant execute on function public.list_event_filter_values() to anon, authenticated, service_role;
