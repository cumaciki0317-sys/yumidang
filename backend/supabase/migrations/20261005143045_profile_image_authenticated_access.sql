-- 민규담당. Storage v1.70.3 operation 계약. 기존 사진 관계/탈퇴 가드는 유지한다.
-- 이미 발급한 signed URL은 이 정책으로 회수되지 않는다. 기존 객체 삭제/CDN 전환은 별도다.
begin;
do $$begin
  if to_regprocedure('storage.operation()') is null
    or to_regprocedure('storage.allow_any_operation(text[])') is null then
    raise exception 'profile_image_storage_operation_contract_missing' using errcode='55000';
  end if;
  if not exists(select 1 from storage.buckets where id='profile-images' and not public) then
    raise exception 'profile_image_private_bucket_required' using errcode='55000';
  end if;
  if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects'
      and policyname='profile_images_authenticated_read' and cmd='SELECT' and roles=array['authenticated']::name[]) then
    raise exception 'profile_image_existing_read_policy_required' using errcode='55000';
  end if;
end $$;
-- RESTRICTIVE 정책은 다른 permissive SELECT 정책의 OR로 서명 발급이 허용되는 것을 막는다.
-- SELECT가 필요한 정규 업로드/삭제를 보존하되 upsert/변환/S3/서명/미설정 작업은 허용하지 않는다.
create policy profile_images_authenticated_operations_only on storage.objects
as restrictive for select to authenticated
using(bucket_id is distinct from 'profile-images' or storage.allow_any_operation(array[
  'storage.object.get_authenticated',
  'object.get_authenticated_info',
  'object.head_authenticated_info',
  'storage.object.upload',
  'storage.object.delete',
  'storage.object.delete_many'
]::text[]));
comment on policy profile_images_authenticated_operations_only on storage.objects is
  'Profile images: authenticated Storage v1.70.3 GET/HEAD/info/upload/delete only. No signed URL issuance; legacy issued URLs require object deletion and CDN cutover verification.';
-- Signed upload 발급은 INSERT 권한을 검사하므로 SELECT 제한만으로는 충분하지 않다.
create policy profile_images_authenticated_upload_operation_only on storage.objects
as restrictive for insert to authenticated
with check(bucket_id is distinct from 'profile-images' or storage.allow_only_operation('storage.object.upload'));
comment on policy profile_images_authenticated_upload_operation_only on storage.objects is
  'Profile images: canonical authenticated upload only; disallow signed upload issuance and S3/TUS/copy uploads.';
commit;
