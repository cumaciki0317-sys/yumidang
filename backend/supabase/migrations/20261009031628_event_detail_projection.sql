-- SQL119: 수집 상세의 공개·공고 연결 투영과 기존 10000자 가격 계약을 함께 연결한다.
-- 과거 SQL111/112·원천 ID·정렬·무료 필터·숨김·owner/ACL은 보존한다.
begin;

create function private.project_event_source_detail(p_event_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select coalesce((select jsonb_object_agg(x.key,x.value)
  from private.event_source_details d join private.source_events s on s.id=d.source_event_id
   and s.collected_at=d.source_collected_at
  cross join lateral jsonb_each(d.detail)x
  where s.id=p_event_id and x.key=any(array['operatingInfo','description','posterUrl'])),'{}'::jsonb);
$$;
revoke all on function private.project_event_source_detail(uuid)
 from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc
  where oid='private.project_post_linked_event(uuid)'::regprocedure;
 execute format('alter function private.project_event_source_detail(uuid)owner to %I',own);
end;$$;

-- pg_get_functiondef의 정확한 기존 경계만 바꾼다. CREATE OR REPLACE로 OID·owner·ACL을 유지한다.
do $upgrade$declare definition text;old_guard text;replacement text;begin
 select pg_get_functiondef('private.valid_source_event_v2(jsonb)'::regprocedure)into definition;
 old_guard:='not private.event_public_text_v1(v_admission->>''text'',2000)';
 if length(definition)-length(replace(definition,old_guard,''))<>length(old_guard) then
  raise exception 'event_price_validator_source_mismatch';
 end if;
 -- 상세 validator와 TypeScript 소비자가 이미 쓰는 10000 한도다. 다른 필드·문자·총 바이트 검사는 유지한다.
 execute replace(definition,old_guard,'not private.event_public_text_v1(v_admission->>''text'',10000)');

 select pg_get_functiondef('private.merge_event_detail(private.source_events,jsonb)'::regprocedure)into definition;
 old_guard:=$old$ if p_detail#>>'{admission,kind}'='described'and length(p_detail#>>'{admission,text}')>2000 then
  raise exception 'event_detail_price_projection_not_ready' using errcode='55000';end if;
$old$;
 if length(definition)-length(replace(definition,old_guard,''))<>length(old_guard) then
  raise exception 'event_detail_merge_source_mismatch';
 end if;
 definition:=replace(definition,old_guard,'');
 definition:=replace(definition,'-- 기존 canonical 가격 검증은 완화하지 않으며 새 가격과 상세를 한 트랜잭션에서 적용한다.',
  '-- 전체 가격과 상세를 같은 트랜잭션에 저장한다. 공개/AI 무료 필터는 이 canonical 사실 값을 읽는다.');
 execute definition;

 select pg_get_functiondef('private.project_post_linked_event(uuid)'::regprocedure)into definition;
 old_guard:=E'end\n  from private.events e';
 if length(definition)-length(replace(definition,old_guard,''))<>length(old_guard)
  or strpos(definition,'private.member_content_hidden(''event'',e.id)')=0 then
  raise exception 'event_link_projection_source_mismatch';
 end if;
 execute replace(definition,old_guard,E'end || private.project_event_source_detail(e.id)\n  from private.events e');

 select pg_get_functiondef('public.list_public_events(jsonb,jsonb,integer)'::regprocedure)into definition;
 -- 소비자가 이미 전달하는 확정 조건을 DB 페이지 분할 전에 적용한다.
 old_guard:='  v_result jsonb;';
 if length(definition)-length(replace(definition,old_guard,''))<>length(old_guard) then
  raise exception 'event_filter_declaration_source_mismatch';
 end if;
 definition:=replace(definition,old_guard,E'  v_result jsonb;\n  v_free_only boolean:=false; v_include_ongoing boolean:=false; v_performance_genre text;');
 old_guard:='(''mode'',''period'',''ongoingOnly'',''query'',''region'',''category'')';
 if length(definition)-length(replace(definition,old_guard,''))<>length(old_guard) then
  raise exception 'event_filter_keys_source_mismatch';
 end if;
 definition:=replace(definition,old_guard,'(''mode'',''period'',''ongoingOnly'',''query'',''region'',''category'',''includeOngoing'',''performanceGenre'',''freeOnly'')');
 old_guard:='  if p_filters ? ''query'' then';
 if length(definition)-length(replace(definition,old_guard,''))<>length(old_guard) then
  raise exception 'event_filter_validation_source_mismatch';
 end if;
 replacement:=$filters$  if p_filters ? 'freeOnly' then
    if jsonb_typeof(p_filters->'freeOnly')is distinct from 'boolean' then raise exception 'invalid_event_filter'using errcode='22023';end if;
    v_free_only:=(p_filters->>'freeOnly')::boolean;
  end if;
  if p_filters ? 'includeOngoing' then
    if jsonb_typeof(p_filters->'includeOngoing')is distinct from 'boolean' then raise exception 'invalid_event_filter'using errcode='22023';end if;
    v_include_ongoing:=(p_filters->>'includeOngoing')::boolean;
    if v_include_ongoing and(v_mode<>'new_this_week'or v_ongoing_only)then raise exception 'invalid_event_filter'using errcode='22023';end if;
  end if;
  if p_filters ? 'performanceGenre' then
    if jsonb_typeof(p_filters->'performanceGenre')is distinct from 'string'
      or p_filters->>'performanceGenre'not in('concert','musical','play')then raise exception 'invalid_event_filter'using errcode='22023';end if;
    v_performance_genre:=p_filters->>'performanceGenre';
  end if;
  if p_filters ? 'query' then$filters$;
 definition:=replace(definition,old_guard,replacement);
 old_guard:='and (v_mode <> ''new_this_week'' or (s.iv_start >= v_week_start and s.iv_start < v_week_end and s.grp <> 2))';
 if length(definition)-length(replace(definition,old_guard,''))<>length(old_guard) then
  raise exception 'event_ongoing_filter_source_mismatch';
 end if;
 replacement:=$filter$and (v_mode <> 'new_this_week' or ((s.iv_start >= v_week_start and s.iv_start < v_week_end and s.grp <> 2)or(v_include_ongoing and s.grp=0)))
      and (not v_free_only or s.admission->>'kind'='free')
      and (v_performance_genre is null or v_performance_genre=case when s.provider='kopis'then
        case when s.category in('대중음악','서양음악(클래식)','한국음악(국악)')then 'concert'
          when s.category='뮤지컬'then 'musical'when s.category='연극'then 'play'end end)$filter$;
 definition:=replace(definition,old_guard,replacement);
 old_guard:='  return v_result;';
 if length(definition)-length(replace(definition,old_guard,''))<>length(old_guard)
  or strpos(definition,'private.member_content_hidden(''event'',')=0 then
  raise exception 'event_list_projection_source_mismatch';
 end if;
 -- 이미 필터·keyset·숨김을 통과한 항목만 조합한다. 순서와 cursor·가격/무료 여부는 바꾸지 않는다.
 replacement:=$project$  select jsonb_set(v_result,'{items}',coalesce(jsonb_agg(
   item.value || private.project_event_source_detail((item.value->>'id')::uuid)
   order by item.ordinality),'[]'::jsonb))into v_result
   from jsonb_array_elements(v_result->'items')with ordinality item(value,ordinality);
  return v_result;$project$;
 execute replace(definition,old_guard,replacement);
end;$upgrade$;
commit;
