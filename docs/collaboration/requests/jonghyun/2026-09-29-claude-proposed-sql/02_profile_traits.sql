-- 종현 제안 SQL(민규 채택 필요). 정식 마이그레이션이 아니며 채택 시 BEGIN/COMMIT으로 감싼다.
-- 목적: 회원의 선택 성향(관심사·대화 방식·MBTI) 저장·조회와, AI 탐색(C 방식)의 후보 작성자 성향 제공.
-- 공개 범위: IA 4장 "로그인한 일반 회원 — 공개 프로필·성향". 비로그인에게 제공하지 않는다.
-- 작성자 ID·실명·생년월일·연락처를 반환하지 않는다. 이름·대화·후기에서 성향을 추정하지 않는다.
-- 등록 성향 상한: 종류별 최대 20개, 값 1~40자(2026-09-30 사용자 결정 Q9-A로 제품 기준 채택)(앞뒤 공백·연속 공백·제어문자 금지), 대소문자 무시 중복 금지,
--   한 번의 작성자 성향 조회 최대 50개 ID는 기술 상한(검색 v2 페이지 최대와 동일)이다.

create function private.profile_trait_values_valid(p_values text[])
returns boolean language sql immutable set search_path = '' as $$
  select p_values is not null
    and coalesce(array_ndims(p_values), 1) = 1
    and cardinality(p_values) <= 20
    and array_position(p_values, null) is null
    and not exists (
      select 1 from unnest(p_values) as v(value)
      where v.value <> btrim(v.value) or char_length(v.value) not between 1 and 40
        or v.value ~ '[[:cntrl:]]' or v.value ~ '\s\s')
    and (select count(distinct lower(v.value)) from unnest(p_values) as v(value)) = cardinality(p_values);
$$;
revoke all on function private.profile_trait_values_valid(text[]) from public, anon, authenticated, service_role;

create table private.profile_traits (
  profile_id uuid primary key references public.profiles (id) on delete cascade,
  interests text[] not null default '{}',
  conversation_styles text[] not null default '{}',
  mbti text null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint profile_traits_interests_valid check (private.profile_trait_values_valid(interests)),
  constraint profile_traits_conversation_styles_valid check (private.profile_trait_values_valid(conversation_styles)),
  constraint profile_traits_mbti_format check (mbti is null or mbti ~ '^[EI][NS][TF][JP]$')
);
comment on table private.profile_traits is
  'Optional member traits (S06/S15-2). Exposed only through RPCs; members see traits of visible post authors; anonymous never.';
alter table private.profile_traits enable row level security;
revoke all on private.profile_traits from public, anon, authenticated, service_role;

-- 판정에 쓴 성향의 변경 감지용 버전. 저장값(순서 포함)의 md5이며 작성자 식별 정보를 포함하지 않는다.
create function private.profile_traits_version(p_interests text[], p_conversation_styles text[], p_mbti text)
returns text language sql immutable set search_path = '' as $$
  select md5(jsonb_build_array(coalesce(to_jsonb(p_interests), '[]'::jsonb),
    coalesce(to_jsonb(p_conversation_styles), '[]'::jsonb), to_jsonb(p_mbti))::text);
$$;
revoke all on function private.profile_traits_version(text[], text[], text) from public, anon, authenticated, service_role;

create function private.require_member_uid()
returns uuid language plpgsql stable set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  -- 익명 로그인 JWT(is_anonymous)도 회원으로 보지 않는다.
  if v_uid is null or coalesce(auth.role(), '') <> 'authenticated'
    or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'login_required' using errcode = '28000';
  end if;
  return v_uid;
end; $$;
revoke all on function private.require_member_uid() from public, anon, authenticated, service_role;

create function public.get_my_profile_traits()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := private.require_member_uid(); v_row private.profile_traits;
begin
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'profile_required' using errcode = 'P0002';
  end if;
  select * into v_row from private.profile_traits where profile_id = v_uid;
  return jsonb_build_object('interests', coalesce(to_jsonb(v_row.interests), '[]'::jsonb),
    'conversationStyles', coalesce(to_jsonb(v_row.conversation_styles), '[]'::jsonb), 'mbti', v_row.mbti);
end; $$;

-- S15-2 저장(전체 교체). 빈 배열은 해당 성향 삭제, p_mbti null/빈 문자열은 MBTI 삭제. null 배열은 입력 오류.
create function public.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := private.require_member_uid(); v_mbti text := nullif(upper(btrim(p_mbti)), '');
begin
  if not exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'profile_required' using errcode = 'P0002';
  end if;
  if not private.profile_trait_values_valid(p_interests) or not private.profile_trait_values_valid(p_conversation_styles)
    or (v_mbti is not null and v_mbti !~ '^[EI][NS][TF][JP]$') then
    raise exception 'invalid_profile_traits' using errcode = '22023';
  end if;
  insert into private.profile_traits (profile_id, interests, conversation_styles, mbti, updated_at)
    values (v_uid, p_interests, p_conversation_styles, v_mbti, clock_timestamp())
    on conflict (profile_id) do update set interests = excluded.interests, conversation_styles = excluded.conversation_styles,
      mbti = excluded.mbti, updated_at = excluded.updated_at;
  return public.get_my_profile_traits();
end; $$;

-- AI 탐색 후보의 작성자 성향. 검색 v2의 회원 가시 범위(status <> 'deleted')와 같은 공고만, 입력 순서대로 반환한다.
-- 보이지 않는 공고 ID는 결과에서 빠진다(존재 여부를 오류로 알리지 않음).
create function public.get_post_author_traits(p_post_ids uuid[])
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
    join public.posts p on p.id = u.id and p.status <> 'deleted'
    left join private.profile_traits t on t.profile_id = p.author_id
  ), '[]'::jsonb));
end; $$;

revoke all on function public.get_my_profile_traits(), public.set_my_profile_traits(text[], text[], text),
  public.get_post_author_traits(uuid[]) from public, anon, authenticated, service_role;
-- anon도 실행 권한을 받지만 함수 안에서 28000(AUTH_REQUIRED)으로 거절한다(검색 v2 나이 조건과 같은 오류 경로).
grant execute on function public.get_my_profile_traits(), public.set_my_profile_traits(text[], text[], text),
  public.get_post_author_traits(uuid[]) to anon, authenticated;
