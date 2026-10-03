-- 가입 중 본인 사진 확인과 기존 회원 읽기는 유지한다. 타인 사진은 현재 공개 프로필 사진만 허용한다.
-- 기존 INSERT/DELETE 정책, private bucket 설정, 사진 교체/최종 삭제 보호는 변경하지 않는다.
begin;
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
  return exists(select 1 from public.profiles viewer where viewer.id=v_uid)
    and exists(select 1 from public.profiles target where target.id::text=p_owner_id and target.avatar_url=p_name);
exception when invalid_text_representation then
  -- 잘못된 JWT UID/JSON은 접근을 거절한다. 그 외 DB 오류도 성공으로 대체하지 않는다.
  return false;
end; $$;
revoke all on function private.can_read_profile_image(text,text,text) from public,anon,authenticated,service_role;
grant execute on function private.can_read_profile_image(text,text,text) to authenticated;

drop policy if exists profile_images_authenticated_read on storage.objects;
create policy profile_images_authenticated_read on storage.objects for select to authenticated
using (private.can_read_profile_image(bucket_id,name,owner_id));
-- 이 마이그레이션 자체는 helper/SELECT 정책만 재적용 가능하다. completion 역할/membership을 변경하지 않는다.
commit;
