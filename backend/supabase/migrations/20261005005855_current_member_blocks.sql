-- 민규: 정책6-1. 차단은 관계의 신규 활동만 막으며 약속 취소·기록·후기·당도를 변경하지 않는다.
begin;
create table private.member_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key(blocker_id,blocked_id),check(blocker_id<>blocked_id)
);
create index member_blocks_reverse on private.member_blocks(blocked_id,blocker_id);
alter table private.member_blocks enable row level security;
revoke all on private.member_blocks from public,anon,authenticated,service_role;

create function private.members_blocked(p_user_a uuid,p_user_b uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from private.member_blocks
    where (blocker_id=p_user_a and blocked_id=p_user_b) or (blocker_id=p_user_b and blocked_id=p_user_a));
$$;
create function private.lock_member_pair(p_user_a uuid,p_user_b uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  if p_user_a is null or p_user_b is null then raise exception 'member_unavailable' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(least(p_user_a,p_user_b)::text||':'||greatest(p_user_a,p_user_b)::text,324));
end; $$;
create function private.require_unblocked_pair(p_user_a uuid,p_user_b uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  perform private.lock_member_pair(p_user_a,p_user_b);
  if private.members_blocked(p_user_a,p_user_b) then raise exception 'member_blocked' using errcode='42501'; end if;
end; $$;
create function private.member_is_blocked(p_other_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(auth.role()='authenticated' and auth.uid() is not null
    and (not(auth.jwt()?'is_anonymous') or auth.jwt()->'is_anonymous'='false'::jsonb)
    and private.members_blocked(auth.uid(),p_other_id),false);
$$;
revoke all on function private.members_blocked(uuid,uuid),private.lock_member_pair(uuid,uuid),
  private.require_unblocked_pair(uuid,uuid),private.member_is_blocked(uuid) from public,anon,authenticated,service_role;
grant execute on function private.member_is_blocked(uuid) to authenticated;

create function public.block_member(p_target_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_member_uid(); added boolean;
begin
  if p_target_id is null or p_target_id=me then raise exception 'invalid_block_target' using errcode='22023'; end if;
  if not exists(select 1 from public.profiles where id=me) then raise exception 'profile_required' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles where id=p_target_id) then raise exception 'member_unavailable' using errcode='PT404'; end if;
  perform private.lock_member_pair(me,p_target_id);
  insert into private.member_blocks(blocker_id,blocked_id) values(me,p_target_id) on conflict do nothing;
  added:=found;
  return jsonb_build_object('targetId',p_target_id,'blocked',true,'alreadyApplied',not added);
end; $$;
create function public.unblock_member(p_target_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_member_uid(); removed boolean;
begin
  if p_target_id is null or p_target_id=me then raise exception 'invalid_block_target' using errcode='22023'; end if;
  if not exists(select 1 from public.profiles where id=me) then raise exception 'profile_required' using errcode='42501'; end if;
  if not exists(select 1 from public.profiles where id=p_target_id) then raise exception 'member_unavailable' using errcode='PT404'; end if;
  perform private.lock_member_pair(me,p_target_id);
  delete from private.member_blocks where blocker_id=me and blocked_id=p_target_id;
  removed:=found;
  return jsonb_build_object('targetId',p_target_id,'blocked',false,'alreadyApplied',not removed);
end; $$;
create function public.list_my_blocks(p_limit integer default 20,p_before uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare me uuid:=private.require_member_uid(); result jsonb;
begin
  if not exists(select 1 from public.profiles where id=me) then raise exception 'profile_required' using errcode='42501'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_block_limit' using errcode='22023'; end if;
  with candidates as materialized(select blocked_id,created_at from private.member_blocks where blocker_id=me
    and(p_before is null or blocked_id>p_before) order by blocked_id limit p_limit+1),
    page as(select * from candidates order by blocked_id limit p_limit)
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('targetId',blocked_id,'blockedAt',created_at)
    order by blocked_id) from page),'[]'::jsonb),
    'nextCursor',case when(select count(*) from candidates)>p_limit then(select blocked_id from page order by blocked_id desc limit 1)else null end)
    into result;
  return result;
end; $$;
revoke all on function public.block_member(uuid),public.unblock_member(uuid),public.list_my_blocks(integer,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.block_member(uuid),public.unblock_member(uuid),public.list_my_blocks(integer,uuid) to authenticated;

-- 기존 함수는 owner만 사용한다. 신규 활동은 pair → 기존 메시지/공고/신청 잠금 순서를 따른다.
alter function public.request_service_post(uuid,uuid,text) set schema private;
alter function private.request_service_post(uuid,uuid,text) rename to request_service_post_without_blocks;
alter function public.send_conversation_message(uuid,uuid,text) set schema private;
alter function private.send_conversation_message(uuid,uuid,text) rename to send_conversation_message_without_blocks;
alter function public.propose_match(uuid) set schema private;
alter function private.propose_match(uuid) rename to propose_match_without_blocks;
alter function public.accept_match(uuid,text) set schema private;
alter function private.accept_match(uuid,text) rename to accept_match_without_blocks;
revoke all on function private.request_service_post_without_blocks(uuid,uuid,text),private.send_conversation_message_without_blocks(uuid,uuid,text),
  private.propose_match_without_blocks(uuid),private.accept_match_without_blocks(uuid,text) from public,anon,authenticated,service_role;

create function public.request_service_post(p_post_id uuid,p_message_id uuid,p_message text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_member_uid(); author uuid;
begin
  select author_id into author from public.posts where id=p_post_id;
  if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
  perform private.lock_member_pair(me,author);
  -- 기존 성공 재시도는 기록 조회다. 차단 뒤 신규 신청·메시지를 만들거나 상태를 복원하지 않는다.
  if not exists(select 1 from private.first_chat_applications where message_id=p_message_id)
    and private.members_blocked(me,author) then raise exception 'member_blocked' using errcode='42501'; end if;
  return private.request_service_post_without_blocks(p_post_id,p_message_id,p_message);
end; $$;
create function private.require_unblocked_request(p_request_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_member_uid(); author uuid; requester uuid;
begin
  select p.author_id,r.requester_id into author,requester from public.join_requests r join public.posts p on p.id=r.post_id where r.id=p_request_id;
  if not found or me not in(author,requester) then raise exception 'request_unavailable' using errcode='P0002'; end if;
  perform private.require_unblocked_pair(author,requester);
end; $$;
revoke all on function private.require_unblocked_request(uuid) from public,anon,authenticated,service_role;
create function public.send_conversation_message(p_request_id uuid,p_message_id uuid,p_content text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if exists(select 1 from public.chat_messages where id=p_message_id and join_request_id=p_request_id
    and sender_id=auth.uid() and content=btrim(p_content)) then
    -- 같은 메시지 UUID의 성공 응답만 재현한다. 권한·내용 충돌은 기존 owner 함수가 검증한다.
    return private.send_conversation_message_without_blocks(p_request_id,p_message_id,p_content);
  end if;
  perform private.require_unblocked_request(p_request_id);
  return private.send_conversation_message_without_blocks(p_request_id,p_message_id,p_content);
end; $$;
create function public.propose_match(p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform private.require_unblocked_request(p_request_id);
  return private.propose_match_without_blocks(p_request_id);
end; $$;
create function public.accept_match(p_request_id uuid,p_condition_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  perform private.require_unblocked_request(p_request_id);
  return private.accept_match_without_blocks(p_request_id,p_condition_version);
end; $$;
revoke all on function public.request_service_post(uuid,uuid,text),public.send_conversation_message(uuid,uuid,text),public.propose_match(uuid),public.accept_match(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.request_service_post(uuid,uuid,text),public.send_conversation_message(uuid,uuid,text),public.propose_match(uuid),public.accept_match(uuid,text) to authenticated;

-- 직접 SELECT도 로그인 차단 쌍을 숨긴다. anon 공개 접근과 SECDEF 약속/대화 기록은 유지한다.
create policy member_blocks_post_visibility on public.posts as restrictive for select to authenticated
  using(not private.member_is_blocked(author_id));
revoke insert,update,delete on public.join_requests,public.chat_messages from public,anon,authenticated;
revoke insert(id,join_request_id,sender_id,content) on public.chat_messages from public,anon,authenticated;

alter function public.get_public_profile(uuid) set schema private;
alter function private.get_public_profile(uuid) rename to get_public_profile_without_blocks;
alter function public.get_public_profile_reviews(uuid,integer,uuid) set schema private;
alter function private.get_public_profile_reviews(uuid,integer,uuid) rename to get_public_profile_reviews_without_blocks;
alter function public.get_visible_review_summary(uuid) set schema private;
alter function private.get_visible_review_summary(uuid) rename to get_visible_review_summary_without_blocks;
alter function public.get_service_post(uuid) set schema private;
alter function private.get_service_post(uuid) rename to get_service_post_without_blocks;
revoke all on function private.get_public_profile_without_blocks(uuid),private.get_public_profile_reviews_without_blocks(uuid,integer,uuid),
  private.get_visible_review_summary_without_blocks(uuid),private.get_service_post_without_blocks(uuid) from public,anon,authenticated,service_role;

create function public.get_public_profile(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if private.member_is_blocked(p_profile_id) then raise exception 'profile_unavailable' using errcode='P0002'; end if;
  return private.get_public_profile_without_blocks(p_profile_id);
end; $$;
create function public.get_public_profile_reviews(p_profile_id uuid,p_limit integer,p_before uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if private.member_is_blocked(p_profile_id) then raise exception 'profile_unavailable' using errcode='P0002'; end if;
  return private.get_public_profile_reviews_without_blocks(p_profile_id,p_limit,p_before);
end; $$;
create function public.get_visible_review_summary(p_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if private.member_is_blocked(p_profile_id) then raise exception 'profile_unavailable' using errcode='P0002'; end if;
  return private.get_visible_review_summary_without_blocks(p_profile_id);
end; $$;
-- 진행 중 약속 관리에만 공고/사진의 문맥 예외를 둔다. 완료·취소 기록은 약속 문맥 RPC에서 읽는다.
create function public.get_service_post(p_post_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare author uuid;
begin
  select author_id into author from public.posts where id=p_post_id;
  if private.member_is_blocked(author) and not exists(select 1 from public.appointments ap join public.join_requests r on r.id=ap.join_request_id
    where ap.post_id=p_post_id and ap.status in('confirmed','disputed') and auth.uid() in(author,r.requester_id)) then
    raise exception 'post_unavailable' using errcode='P0002';
  end if;
  return private.get_service_post_without_blocks(p_post_id);
end; $$;
revoke all on function public.get_public_profile(uuid),public.get_public_profile_reviews(uuid,integer,uuid),public.get_visible_review_summary(uuid),public.get_service_post(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_public_profile(uuid),public.get_public_profile_reviews(uuid,integer,uuid),public.get_visible_review_summary(uuid) to authenticated;
grant execute on function public.get_service_post(uuid) to anon,authenticated;

-- 검색은 페이지 계산 전에 제외해 DB keyset 계약과 결과 수를 보존한다.
create or replace function public.search_public_posts_v2(p_contract_version text,p_region text,p_filters jsonb,p_cursor jsonb,p_limit integer default 10)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_uid uuid:=auth.uid();
  -- 누락은 기존 회원과 호환한다. 게스트와 boolean이 아닌 claim은 회원 필터를 사용하지 못한다.
  v_member boolean:=auth.role()='authenticated' and auth.uid() is not null
    and (not (auth.jwt()?'is_anonymous') or auth.jwt()->'is_anonymous'='false'::jsonb);
  v_query text; v_category text; v_cost text; v_availability text; v_age text; v_sort text;
  v_start timestamptz; v_end timestamptz; v_cursor_at timestamptz; v_cursor_id uuid;
  v_key text; v_result jsonb;
  v_age_min integer; v_age_max integer; v_min_numeric numeric; v_max_numeric numeric;
  v_can_start_activity boolean;
begin
  if p_contract_version is distinct from '2026-10-05' then
    raise exception 'unsupported_search_contract' using errcode='22023';
  end if;
  if p_region is not null and p_region not in ('서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도') then
    raise exception 'invalid_search_region' using errcode='22023';
  end if;
  if p_filters is null or jsonb_typeof(p_filters)<>'object' or p_limit is null or p_limit not between 1 and 50
    or p_filters-array['query','category','cost','availability','periodStart','periodEnd','authorAge','sort']<>'{}'::jsonb then
    raise exception 'invalid_search_input' using errcode='22023';
  end if;
  for v_key in select jsonb_object_keys(p_filters) loop
    if jsonb_typeof(p_filters->v_key)<>'string'
      and not (v_key='authorAge' and jsonb_typeof(p_filters->v_key)='object')
      and not (v_key in ('category','periodStart','periodEnd') and p_filters->v_key='null'::jsonb) then
      raise exception 'invalid_search_input' using errcode='22023';
    end if;
  end loop;
  if char_length(coalesce(p_filters->>'query',''))>300 then
    raise exception 'invalid_search_query' using errcode='22023';
  end if;
  v_query:=private.search_v2_text(p_filters->>'query');
  v_category:=p_filters->>'category'; v_cost:=coalesce(p_filters->>'cost','all');
  v_availability:=coalesce(p_filters->>'availability','all');
  if jsonb_typeof(p_filters->'authorAge')='object' then
    if not ((p_filters->'authorAge')?&array['min','max'])
      or (p_filters->'authorAge')-array['min','max']<>'{}'::jsonb
      or jsonb_typeof(p_filters->'authorAge'->'min')<>'number'
      or jsonb_typeof(p_filters->'authorAge'->'max')<>'number' then
      raise exception 'invalid_search_age_range' using errcode='22023';
    end if;
    -- JSONB의 정확한 숫자 비교로 범위를 먼저 검사한다. 거대한 숫자를 integer로 변환하지 않는다.
    if p_filters->'authorAge'->'min'<'19'::jsonb or p_filters->'authorAge'->'min'>'99'::jsonb
      or p_filters->'authorAge'->'max'<'19'::jsonb or p_filters->'authorAge'->'max'>'99'::jsonb then
      raise exception 'invalid_search_age_range' using errcode='22023';
    end if;
    v_min_numeric:=(p_filters->'authorAge'->>'min')::numeric;
    v_max_numeric:=(p_filters->'authorAge'->>'max')::numeric;
    if v_min_numeric<>trunc(v_min_numeric) or v_max_numeric<>trunc(v_max_numeric)
      or v_min_numeric>v_max_numeric then
      raise exception 'invalid_search_age_range' using errcode='22023';
    end if;
    v_age_min:=v_min_numeric::integer; v_age_max:=v_max_numeric::integer; v_age:='range';
  else
    v_age:=coalesce(p_filters->>'authorAge','all');
    if v_age<>'all' then
      raise exception 'invalid_search_filter' using errcode='22023';
    end if;
  end if;
  v_sort:=coalesce(p_filters->>'sort','created_desc');
  if (v_category is not null and v_category not in ('지금이당','전시','축제','팝업','공연','영화','맛집','카페','쇼핑','여행','운동','산책','게임','반려동물','스터디','기타'))
    or v_cost not in ('all','free','paid') or v_availability not in ('all','recruiting')
    or v_age not in ('all','range') or v_sort not in ('created_desc','starts_asc') then
    raise exception 'invalid_search_filter' using errcode='22023';
  end if;
  if not coalesce(v_member,false) and v_age<>'all' then
    raise exception 'login_required' using errcode='28000';
  end if;
  if ((p_filters->>'periodStart') is null)<>((p_filters->>'periodEnd') is null) then
    raise exception 'invalid_search_period' using errcode='22023';
  end if;
  if p_filters->>'periodStart' is not null then
    if not coalesce(v_member,false) then raise exception 'login_required' using errcode='28000'; end if;
    v_start:=private.search_v2_timestamp(p_filters->>'periodStart');
    v_end:=private.search_v2_timestamp(p_filters->>'periodEnd');
    if v_start>=v_end then raise exception 'invalid_search_period' using errcode='22023'; end if;
  end if;
  if p_cursor is not null and p_cursor<>'null'::jsonb then
    if jsonb_typeof(p_cursor)<>'object' or not (p_cursor?&array['sortAt','id'])
      or p_cursor-array['sortAt','id']<>'{}'::jsonb
      or jsonb_typeof(p_cursor->'sortAt')<>'string' or jsonb_typeof(p_cursor->'id')<>'string'
      or (p_cursor->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_search_cursor' using errcode='22023';
    end if;
    v_cursor_at:=private.search_v2_timestamp(p_cursor->>'sortAt');
    v_cursor_id:=(p_cursor->>'id')::uuid;
  end if;
  v_can_start_activity:=private.can_start_naver_activity();

  with source as materialized (
    select p.id,p.title,p.public_area,p.starts_at,p.ends_at,p.created_at,p.author_id,p.cost_type,p.amount,
      p.partner_gender,pr.real_name,pr.birth_date,
      case when ap.status='confirmed' then 'confirmed'
        when ap.status in ('completed','cancelled','disputed','no_show') then 'closed'
        when p.status='closed' then 'closed'
        when p.status='expired' or p.recruitment_ends_at<=now() or p.starts_at<=now() then 'expired'
        else 'recruiting' end as display_state,
      case when v_sort='created_desc' then p.created_at else p.starts_at end as sort_at
    from public.posts p join public.profiles pr on pr.id=p.author_id
    left join public.appointments ap on ap.post_id=p.id
    left join private.post_search_locations l on l.post_id=p.id
    left join private.events linked_event on linked_event.id=p.source_event_id
    where p.status<>'deleted'
      and (not coalesce(v_member,false) or not private.members_blocked(v_uid,p.author_id))
      and (v_category is null or p.category=v_category)
      and (p_region is null or private.post_search_region(p.public_area)=p_region)
      and (v_cost='all' or (v_cost='free' and p.cost_type='free') or (v_cost='paid' and p.cost_type in ('paid_request','paid_offer')))
      and (v_start is null or (p.starts_at<v_end and p.ends_at>v_start))
      and (v_age='all' or (v_age='range' and public.korean_age(pr.birth_date) between v_age_min and v_age_max))
      and (v_query='' or strpos(private.search_v2_text(p.title),v_query)>0
        or strpos(private.search_v2_text(l.registered_place_name),v_query)>0
        or strpos(private.search_v2_text(l.registered_address),v_query)>0
        or strpos(private.search_v2_text(linked_event.title),v_query)>0)
  ), candidates as materialized (
    select s.* from source s
    where (v_availability='all' or s.display_state='recruiting')
      and (v_cursor_at is null or
        (v_sort='created_desc' and (s.sort_at<v_cursor_at or (s.sort_at=v_cursor_at and s.id>v_cursor_id))) or
        (v_sort='starts_asc' and (s.sort_at>v_cursor_at or (s.sort_at=v_cursor_at and s.id>v_cursor_id))))
    order by case when v_sort='created_desc' then s.sort_at end desc,
      case when v_sort='starts_asc' then s.sort_at end asc,s.id asc limit p_limit+1
  ), page as materialized (
    select c.*,row_number() over(order by case when v_sort='created_desc' then c.sort_at end desc,
      case when v_sort='starts_asc' then c.sort_at end asc,c.id asc) as page_position
    from candidates c order by case when v_sort='created_desc' then c.sort_at end desc,
      case when v_sort='starts_asc' then c.sort_at end asc,c.id asc limit p_limit
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
    'id',s.id,'title',s.title,
    'authorDisplayName',case when coalesce(v_member,false) then public.mask_real_name(s.real_name)
      else null end,
    'publicArea',s.public_area,
    'startsAt',to_char(s.starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'endsAt',to_char(s.ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'cost',private.search_v2_cost(s.cost_type,s.amount),'state',s.display_state,
    'canApply',coalesce(coalesce(v_member,false) and v_can_start_activity and s.display_state='recruiting' and s.cost_type='free'
      and s.author_id<>v_uid and exists(select 1 from public.profiles me where me.id=v_uid
        and (s.partner_gender='any' or me.gender=s.partner_gender))
      and not exists(select 1 from public.join_requests r where r.post_id=s.id and r.requester_id=v_uid
        and r.status in ('pending','declined')),false)
    ) order by s.page_position) from page s),'[]'::jsonb),
    'nextCursor',case when (select count(*) from candidates)>p_limit then
      (select jsonb_build_object('sortAt',to_char(s.sort_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'id',s.id)
       from page s order by s.page_position desc limit 1) else null end) into v_result;
  return v_result;
end; $$;

create or replace function public.get_post_author_traits(p_post_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_member_uid();
begin
  if p_post_ids is null or coalesce(array_ndims(p_post_ids), 1) <> 1 or cardinality(p_post_ids) > 50
    or array_position(p_post_ids, null) is not null
    or (select count(distinct x) from unnest(p_post_ids) as u(x)) <> cardinality(p_post_ids) then
    raise exception 'invalid_post_ids' using errcode = '22023';
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'postId', p.id,
      'interests', coalesce(to_jsonb(t.interests), '[]'::jsonb),
      'conversationStyles', coalesce(to_jsonb(t.conversation_styles), '[]'::jsonb),
      'mbti', t.mbti,
      'traitsVersion', private.profile_traits_version(coalesce(t.interests, '{}'), coalesce(t.conversation_styles, '{}'), t.mbti)
    ) order by u.ord)
    from unnest(p_post_ids) with ordinality as u(id, ord)
    join public.posts p on p.id = u.id and p.status <> 'deleted' and not private.members_blocked(v_uid,p.author_id)
    left join private.profile_traits t on t.profile_id = p.author_id
  ), '[]'::jsonb));
end; $$;

create or replace function private.can_send_message(p_request_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.join_requests r join public.posts p on p.id=r.post_id
    where r.id=p_request_id and (r.requester_id=auth.uid() or p.author_id=auth.uid()) and p.status<>'deleted' and not private.members_blocked(p.author_id,r.requester_id)
      and ((r.status='pending' and clock_timestamp()<p.starts_at) or (r.status='matched'
        and exists(select 1 from public.appointments ap where ap.join_request_id=r.id and ap.status<>'cancelled'))));
$$;

create or replace function private.can_read_profile_image(p_bucket_id text,p_name text,p_owner_id text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid; v_claims jsonb;
begin
  v_uid:=auth.uid(); v_claims:=coalesce(auth.jwt(),'{}'::jsonb);
  if v_uid is null or auth.role() is distinct from 'authenticated'
    or jsonb_typeof(v_claims) is distinct from 'object'
    or (v_claims?'is_anonymous' and v_claims->'is_anonymous' is distinct from 'false'::jsonb)
    or p_bucket_id is distinct from 'profile-images' or p_name is null or p_owner_id is null
  then return false; end if;
  -- Storage 행의 owner_id와 경로를 함께 확인한다. 임의 prefix나 다른 회원의 경로를 허용하지 않는다.
  if p_owner_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or p_name !~ ('^'||p_owner_id||'/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.]jpg$')
  then return false; end if;
  -- 본인 신규 업로드/교체 전 사진은 가입 완료나 profiles 생성 전에 읽을 수 있어야 한다.
  if p_owner_id=v_uid::text then return true; end if;
  -- 기존 제한 회원도 profiles가 있으면 일반 읽기를 유지한다. 새 활동의 네이버 자격을 요구하지 않는다.
  if private.members_blocked(v_uid,p_owner_id::uuid) and not exists(
    select 1 from public.appointments ap join public.join_requests r on r.id=ap.join_request_id
      join public.posts p on p.id=ap.post_id where ap.status in('confirmed','disputed')
        and ((p.author_id=v_uid and r.requester_id=p_owner_id::uuid)
          or(p.author_id=p_owner_id::uuid and r.requester_id=v_uid))
  ) then return false; end if;
  return exists(select 1 from public.profiles viewer where viewer.id=v_uid)
    and exists(select 1 from public.profiles target where target.id::text=p_owner_id and target.avatar_url=p_name);
exception when invalid_text_representation then
  -- 잘못된 JWT UID/JSON은 접근을 거절한다. 그 외 DB 오류도 성공으로 대체하지 않는다.
  return false;
end; $$;

-- 이전 공개 작성자 RPC도 같은 차단 가시성을 적용한다.
create or replace function public.get_post_author_profile(p_post_id uuid)
returns table (masked_name text, gender text, age integer, avatar_url text, bio text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid:=private.require_member_uid();
begin
  if not exists(select 1 from public.profiles where id=v_uid) then
    raise exception 'profile_required' using errcode='P0002';
  end if;
  return query
    select public.mask_real_name(pr.real_name), pr.gender, public.korean_age(pr.birth_date), pr.avatar_url, pr.bio
    from public.posts p join public.profiles pr on pr.id = p.author_id
    where p.id = p_post_id and p.status <> 'deleted' and not private.member_is_blocked(p.author_id);
  if not found then raise exception 'profile_unavailable' using errcode = 'P0002'; end if;
end;
$$;

-- 이전 공개 작성자 RPC도 같은 차단 가시성을 적용한다.
create or replace function public.get_post_author_cards(p_post_ids uuid[])
returns table (post_id uuid, author_id uuid, masked_name text, avatar_url text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid:=private.require_member_uid();
begin
  if not exists(select 1 from public.profiles where id=v_uid) then
    raise exception 'profile_required' using errcode='P0002';
  end if;
  return query
    select p.id, p.author_id, public.mask_real_name(pr.real_name), pr.avatar_url
    from public.posts p
    join public.profiles pr on pr.id = p.author_id
    where p.id = any (coalesce(p_post_ids, '{}')) and p.status <> 'deleted' and not private.member_is_blocked(p.author_id)
    limit 200;
end;
$$;

-- 이전 공개 작성자 RPC도 같은 차단 가시성을 적용한다.
create or replace function public.get_post_author_discovery_cards(p_post_ids uuid[])
returns table (post_id uuid, author_id uuid, masked_name text, avatar_url text, gender text, age integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid:=private.require_member_uid();
begin
  if not exists(select 1 from public.profiles where id=v_uid) then
    raise exception 'profile_required' using errcode='P0002';
  end if;
  return query
    select p.id, p.author_id, public.mask_real_name(pr.real_name), pr.avatar_url, pr.gender, public.korean_age(pr.birth_date)
    from public.posts p
    join public.profiles pr on pr.id = p.author_id
    where p.id = any (coalesce(p_post_ids, '{}')) and p.status <> 'deleted' and not private.member_is_blocked(p.author_id)
    limit 200;
end;
$$;
commit;
