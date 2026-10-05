-- 민규: S15-2 성향과 한줄 소개를 같은 트랜잭션에서 저장한다.
-- bio의 NULL/300자 제약은 기존 DB 기준이며 기존 /me/traits 계약은 유지한다.
begin;
create function public.set_my_profile_preferences(
  p_interests text[], p_conversation_styles text[], p_mbti text, p_bio text
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid; traits jsonb;
begin
  -- 기존 회원 관리와 동일한 account→profile→episode 잠금 및 탈퇴 검사를 적용한다.
  -- 신규 공고용 자격 gate를 추가해 기존 회원 관리를 차단하지 않는다.
  u := auth.uid();
  if u is null or coalesce(auth.role(),'')<>'authenticated'
    or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then
    raise exception 'login_required' using errcode='28000';
  end if;
  -- profile UPDATE를 episode SHARE보다 먼저 확보해 두 저장/탈퇴의 잠금 승격 경합을 줄인다.
  perform 1 from private.naver_accounts where user_id=u order by subject for share;
  perform 1 from public.profiles where id=u for update;
  perform private.require_service_profile();
  if p_bio is not null and char_length(p_bio)>300 then
    raise exception 'invalid_profile_bio' using errcode='22023';
  end if;
  -- 기존 성향 validator·정규화·전체 교체를 재사용한다. 이후 실패 시 함께 rollback한다.
  traits := public.set_my_profile_traits(p_interests,p_conversation_styles,p_mbti);
  update public.profiles set bio=p_bio where id=u;
  return traits || jsonb_build_object('bio',p_bio);
end; $$;
-- 기존 회원 성향 함수와 같은 소유자로 유지하고 불필요한 새 역할을 만들지 않는다.
do $$ declare owner_name text; begin
  select pg_get_userbyid(proowner) into strict owner_name
    from pg_proc where oid='public.set_my_profile_traits(text[],text[],text)'::regprocedure;
  execute format('alter function public.set_my_profile_preferences(text[],text[],text,text) owner to %I',owner_name);
end; $$;
revoke all on function public.set_my_profile_preferences(text[],text[],text,text) from public,anon,authenticated,service_role;
grant execute on function public.set_my_profile_preferences(text[],text[],text,text) to authenticated;
-- 직접 소개글 UPDATE로 공통 회원 관리·탈퇴 잠금 경계를 우회하지 못하게 한다.
-- 다른 프로필 열과 기존 성향/사진 RPC 권한은 변경하지 않는다.
revoke update(bio) on public.profiles from public,anon,authenticated;
comment on function public.set_my_profile_preferences(text[],text[],text,text) is
  '본인 성향과 소개글의 원자 저장. 기존 NULL/300자 소개글 제약, 회원 관리 guard, 전체 성향 교체를 재사용한다.';
commit;
