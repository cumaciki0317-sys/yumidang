-- 민규: 본인의 기존 안전 제한 원장을 읽는다. 판정·통지·이의 마감을 새로 만들지 않는다.
begin;
create function public.get_my_safety_state()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_service_profile();identity uuid;result jsonb;
begin
 -- 회원 account→profile→활성 episode 잠금/비익명/탈퇴 guard를 재사용한다.
 -- 이름·성별·생일·신규 동행 자격은 본인 자료 조회의 추가 조건이 아니다.
 select e.identity_id into identity from private.member_episodes e
 join private.naver_identity_keys k on k.id=e.identity_id
 join private.naver_accounts a on a.subject=k.subject and a.user_id=u
 where e.profile_id=u and e.ended_at is null;
 if not found or identity is null then
  raise exception 'verified_member_identity_required' using errcode='42501';end if;
 -- STABLE helper와 배열을 같은 SQL statement snapshot에서 읽는다.
 select private.safety_restriction_state(identity)||jsonb_build_object('sanctions',
 coalesce(jsonb_agg(jsonb_build_object('sanctionId',a.id,'kind',a.kind,
  'appliedAt',a.applied_at,'expiresAt',a.expires_at,'notifiedAt',a.notified_at)
  order by a.applied_at desc,a.id),'[]'::jsonb)) into result
 from private.safety_sanction_applications a where a.identity_id=identity and a.revoked_at is null
 and(a.expires_at is null or a.expires_at>statement_timestamp());
 -- helper의 permanent/restrictedUntil/hasWarning 세 키를 그대로 유지한다.
 return result;
end; $$;
do $$declare owner_name text;begin
 select pg_get_userbyid(proowner) into strict owner_name from pg_proc where oid='public.get_my_profile()'::regprocedure;
 execute format('alter function public.get_my_safety_state() owner to %I',owner_name);
end; $$;
revoke all on function public.get_my_safety_state() from public,anon,authenticated,service_role;
grant execute on function public.get_my_safety_state() to authenticated;
comment on function public.get_my_safety_state() is
 '현재 본인 identity의 유효 제재 읽기. 다른 사건/신고자/피해자/원문과 추정 이의 마감은 반환하지 않는다.';
commit;
