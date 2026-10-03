-- 네이버 서버 확인 → Auth 세션 등록 → 사진·선택 성향·명시 가입 완료.
-- 기존 계정·인증 이력은 보존하고 이메일/이름으로 계정을 자동 연결하지 않는다.
begin;

create table private.naver_login_challenges (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  verifier_hash text not null check (verifier_hash ~ '^[0-9a-f]{64}$'),
  return_to text not null,
  request_origin text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create table private.naver_accounts (
  subject text primary key,
  auth_email text not null unique default (gen_random_uuid()::text || '@naver.yumidang.invalid'),
  user_id uuid unique references auth.users(id) on delete restrict,
  real_name text not null,
  birth_date date not null,
  gender text not null,
  verification_status text not null check (verification_status in ('qualified','information_required','ineligible')),
  verified_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  constraint naver_subject_valid check (subject = btrim(subject) and char_length(subject) between 1 and 512 and subject !~ '[[:cntrl:]]'),
  constraint naver_alias_valid check (auth_email ~ '^[0-9a-f-]{36}@naver[.]yumidang[.]invalid$')
);
create table private.naver_sessions (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null references private.naver_accounts(subject) on delete cascade,
  registered_at timestamptz not null default clock_timestamp()
);
alter table private.naver_login_challenges enable row level security;
alter table private.naver_accounts enable row level security;
alter table private.naver_sessions enable row level security;
revoke all on private.naver_login_challenges, private.naver_accounts, private.naver_sessions from public, anon, authenticated, service_role;

alter table public.profiles drop constraint profiles_real_name_length;
alter table public.profiles add constraint profiles_real_name_length check (char_length(real_name) between 1 and 200);
comment on column public.profiles.real_name is '네이버 서버에서 확인한 이름. 기존 입력 이력은 네이버 확인 근거로 승격하지 않는다.';

create function public.begin_naver_login(p_state_hash text,p_verifier_hash text,p_return_to text,p_expires_seconds integer,p_origin text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_expires timestamptz;
begin
  if p_state_hash is null or p_state_hash !~ '^[0-9a-f]{64}$'
    or p_verifier_hash is null or p_verifier_hash !~ '^[0-9a-f]{64}$'
    or p_expires_seconds is null or p_expires_seconds not between 1 and 3600
    or p_return_to is null or char_length(p_return_to) not between 1 and 2048
    or (p_return_to<>'/' and p_return_to !~ '^/[^/]') or p_return_to ~ '[[:cntrl:]\\]'
    or p_origin is null or char_length(p_origin)>2048
    or p_origin !~ '^https?://[a-zA-Z0-9.-]+(:[0-9]{1,5})?$' then
    raise exception 'invalid_naver_login' using errcode='22023';
  end if;
  v_expires:=clock_timestamp()+make_interval(secs=>p_expires_seconds);
  insert into private.naver_login_challenges(state_hash,verifier_hash,return_to,expires_at,request_origin)
    values(p_state_hash,p_verifier_hash,p_return_to,v_expires,p_origin);
  return jsonb_build_object('expiresAt',v_expires);
end; $$;

create function public.consume_naver_login(p_state_hash text,p_verifier_hash text,p_origin text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_return text;
begin
  update private.naver_login_challenges set consumed_at=clock_timestamp()
    where state_hash=p_state_hash and verifier_hash=p_verifier_hash and request_origin=p_origin
      and consumed_at is null and expires_at>clock_timestamp() returning return_to into v_return;
  if not found then raise exception 'invalid_naver_login_state' using errcode='22023'; end if;
  return jsonb_build_object('returnTo',v_return);
end; $$;

create function private.naver_account_state(p_subject text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a private.naver_accounts; v_avatar text; v_status text;
begin
  select * into a from private.naver_accounts where subject=p_subject;
  if not found then raise exception 'naver_account_missing' using errcode='28000'; end if;
  select avatar_url into v_avatar from public.profiles where id=a.user_id;
  v_status:=case when a.verification_status<>'qualified' then a.verification_status
    when v_avatar is null then 'photo_required'
    when a.completed_at is null then 'completion_required' else 'ready' end;
  return jsonb_build_object('status',v_status,'authEmail',a.auth_email,'userId',a.user_id);
end; $$;

create function public.resolve_naver_account(p_subject text,p_name text,p_gender text,p_birth_date date)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare a private.naver_accounts; v_status text; v_today date:=(clock_timestamp() at time zone 'Asia/Seoul')::date;
begin
  if p_subject is null or p_subject<>btrim(p_subject) or char_length(p_subject) not between 1 and 512 or p_subject ~ '[[:cntrl:]]' then
    raise exception 'invalid_naver_subject' using errcode='22023';
  end if;
  v_status:=case when p_name is null or p_name<>btrim(p_name) or char_length(p_name) not between 1 and 200 or p_name ~ '[[:cntrl:]]'
    or p_gender is null or p_gender not in ('F','M') or p_birth_date is null
    or p_birth_date<date '1900-01-01' or p_birth_date>v_today then 'information_required'
    when p_gender<>'F' or public.korean_age(p_birth_date,v_today)<19 then 'ineligible' else 'qualified' end;
  -- 주제별 직렬화: 최초 콜백 동시 도착에도 예약 별칭은 하나다.
  perform pg_advisory_xact_lock(hashtextextended(p_subject,98214));
  select * into a from private.naver_accounts where subject=p_subject for update;
  if not found then
    if v_status<>'qualified' then
      return jsonb_build_object('status',v_status,'authEmail',null,'userId',null);
    end if;
    insert into private.naver_accounts(subject,real_name,birth_date,gender,verification_status)
      values(p_subject,p_name,p_birth_date,'female',v_status);
  else
    update private.naver_accounts set verification_status=v_status,verified_at=clock_timestamp(),
      real_name=case when v_status='qualified' then p_name else real_name end,
      birth_date=case when v_status='qualified' then p_birth_date else birth_date end,
      gender=case when v_status='qualified' then 'female' else gender end where subject=p_subject;
    if v_status='qualified' then
      update public.profiles set real_name=p_name,birth_date=p_birth_date,gender='female' where id=a.user_id;
    end if;
  end if;
  return private.naver_account_state(p_subject);
end; $$;

create function public.record_naver_session(p_subject text,p_user_id uuid,p_session_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare a private.naver_accounts;
begin
  select * into a from private.naver_accounts where subject=p_subject for update;
  if not found or p_user_id is null or p_session_id is null then raise exception 'invalid_naver_session' using errcode='28000'; end if;
  -- 기존 자격 상실 회원의 제한 세션은 허용한다. 최초 연결 도중 자격이 바뀌면 새 연결은 차단한다.
  if a.user_id is null and a.verification_status<>'qualified' then raise exception 'naver_qualification_required' using errcode='42501'; end if;
  if a.user_id is not null and a.user_id<>p_user_id then raise exception 'naver_account_conflict' using errcode='23505'; end if;
  perform 1 from auth.users where id=p_user_id and email=a.auth_email for share;
  if not found then raise exception 'naver_account_conflict' using errcode='23505'; end if;
  perform 1 from auth.sessions where id=p_session_id and user_id=p_user_id for share;
  if not found then raise exception 'invalid_naver_session' using errcode='28000'; end if;
  update private.naver_accounts set user_id=p_user_id where subject=p_subject;
  insert into private.naver_sessions(session_id,user_id,subject) values(p_session_id,p_user_id,p_subject)
    on conflict(session_id) do nothing;
  if not exists(select 1 from private.naver_sessions where session_id=p_session_id and user_id=p_user_id and subject=p_subject) then
    raise exception 'naver_account_conflict' using errcode='23505';
  end if;
  return private.naver_account_state(p_subject);
end; $$;

create function private.require_naver_session()
returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_session uuid;
begin
  if v_uid is null or auth.role() is distinct from 'authenticated' or coalesce(auth.jwt()->>'is_anonymous','false')<>'false' then
    raise exception 'login_required' using errcode='28000';
  end if;
  begin v_session:=(auth.jwt()->>'session_id')::uuid;
  exception when invalid_text_representation then raise exception 'naver_session_required' using errcode='28000'; end;
  if not exists(select 1 from private.naver_sessions ns join private.naver_accounts a on a.subject=ns.subject and a.user_id=ns.user_id
    join auth.sessions s on s.id=ns.session_id and s.user_id=ns.user_id
    where ns.session_id=v_session and ns.user_id=v_uid) then
    raise exception 'naver_session_required' using errcode='28000';
  end if;
  return v_uid;
end; $$;

-- 성향 저장소와 조회 RPC는 종현 제안 02_profile_traits.sql에서 아래에 통합한다.
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
grant execute on function public.get_my_profile_traits(), public.set_my_profile_traits(text[], text[], text),
  public.get_post_author_traits(uuid[]) to authenticated;

create function public.get_naver_signup_state()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.require_naver_session(); a private.naver_accounts; t private.profile_traits; v_avatar text;
begin
  select * into a from private.naver_accounts where user_id=v_uid;
  select avatar_url into v_avatar from public.profiles where id=v_uid;
  select * into t from private.profile_traits where profile_id=v_uid;
  return jsonb_build_object('status',private.naver_account_state(a.subject)->>'status','avatarPath',v_avatar,
    'interests',coalesce(to_jsonb(t.interests),'[]'::jsonb),
    'conversationStyles',coalesce(to_jsonb(t.conversation_styles),'[]'::jsonb),'mbti',t.mbti);
end; $$;

create function public.complete_naver_signup(p_avatar_path text,p_interests text[],p_conversation_styles text[],p_mbti text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_naver_session(); a private.naver_accounts;
begin
  select * into a from private.naver_accounts where user_id=v_uid for update;
  if a.verification_status is distinct from 'qualified' or a.gender<>'female'
    or public.korean_age(a.birth_date,(clock_timestamp() at time zone 'Asia/Seoul')::date)<19 then
    raise exception 'naver_qualification_required' using errcode='42501';
  end if;
  -- 객체를 공유 잠금하여 완료 중 이미지 삭제와 경쟁하지 않는다.
  perform 1 from storage.objects where bucket_id='profile-images' and name=p_avatar_path for share;
  perform private.assert_owned_profile_image(v_uid,p_avatar_path);
  insert into public.profiles(id,real_name,birth_date,gender,avatar_url)
    values(v_uid,a.real_name,a.birth_date,a.gender,p_avatar_path)
    on conflict(id) do update set real_name=excluded.real_name,birth_date=excluded.birth_date,
      gender=excluded.gender,avatar_url=excluded.avatar_url;
  -- 모든 성향 검증·저장과 프로필 생성·완료 표시는 한 트랜잭션이다.
  perform public.set_my_profile_traits(p_interests,p_conversation_styles,p_mbti);
  update private.naver_accounts set completed_at=coalesce(completed_at,clock_timestamp()) where user_id=v_uid;
  return public.get_naver_signup_state();
end; $$;

create function private.assert_naver_member_qualified(p_uid uuid)
returns void language plpgsql stable security definer set search_path='' as $$
declare a private.naver_accounts; v_avatar text;
begin
  select * into a from private.naver_accounts where user_id=p_uid;
  select avatar_url into v_avatar from public.profiles where id=p_uid;
  if a.user_id is null or a.verification_status<>'qualified' or a.gender<>'female' or a.completed_at is null
    or public.korean_age(a.birth_date,(clock_timestamp() at time zone 'Asia/Seoul')::date)<19 or v_avatar is null then
    raise exception 'naver_signup_required' using errcode='42501';
  end if;
  perform private.assert_owned_profile_image(p_uid,v_avatar);
end; $$;

create function private.assert_naver_activity_allowed()
returns void language plpgsql stable security definer set search_path='' as $$
begin
  perform private.assert_naver_member_qualified(private.require_naver_session());
end; $$;

create function private.enforce_naver_new_activity()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_author uuid; v_requester uuid;
begin
  -- SECURITY DEFINER RPC 안에서도 실제 JWT 역할을 확인한다. 서비스 유지보수는 그대로 허용한다.
  if auth.role()='authenticated' then
    perform private.assert_naver_activity_allowed();
    if tg_table_name='appointments' then
      select p.author_id,r.requester_id into v_author,v_requester from public.posts p
        join public.join_requests r on r.post_id=p.id where p.id=new.post_id and r.id=new.join_request_id;
      perform private.assert_naver_member_qualified(v_author);
      perform private.assert_naver_member_qualified(v_requester);
    end if;
  end if;
  return new;
end; $$;
create trigger posts_naver_signup_required before insert on public.posts
  for each row execute function private.enforce_naver_new_activity();
create trigger join_requests_naver_signup_required before insert on public.join_requests
  for each row execute function private.enforce_naver_new_activity();
create trigger appointments_naver_signup_required before insert on public.appointments
  for each row execute function private.enforce_naver_new_activity();
create trigger match_consents_naver_signup_required before insert or update on private.match_consents
  for each row execute function private.enforce_naver_new_activity();

revoke all on function private.naver_account_state(text),private.require_naver_session(),
  private.assert_naver_member_qualified(uuid),private.assert_naver_activity_allowed(),private.enforce_naver_new_activity()
  from public,anon,authenticated,service_role;
revoke all on function public.begin_naver_login(text,text,text,integer,text),public.consume_naver_login(text,text,text),
  public.resolve_naver_account(text,text,text,date),public.record_naver_session(text,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.begin_naver_login(text,text,text,integer,text),public.consume_naver_login(text,text,text),
  public.resolve_naver_account(text,text,text,date),public.record_naver_session(text,uuid,uuid) to service_role;
revoke all on function public.get_naver_signup_state(),public.complete_naver_signup(text,text[],text[],text)
  from public,anon,authenticated,service_role;
grant execute on function public.get_naver_signup_state(),public.complete_naver_signup(text,text[],text[],text) to authenticated;
-- 과거 수기·추천·학교 인증 경로는 복원하지 않는다.
revoke all on function public.complete_signup(text,date,text,text,text),
  public.complete_signup_with_avatar(text,date,text,text,text,text),public.check_signup_eligibility(text,text)
  from public,anon,authenticated,service_role;
comment on table private.naver_accounts is '서버 검증 전용 네이버 주제별 예약·자격·명시 가입 완료. 이메일/이름 기반 자동 연결 금지.';
comment on table private.naver_sessions is '서버가 실제 Auth 세션 귀속을 확인해 등록한 네이버 세션. 사용자 메타데이터는 인증 근거가 아니다.';
commit;
