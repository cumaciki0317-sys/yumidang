-- 민규담당. SQL69 operation/RLS 회귀. 합성 metadata이며 실제 사진/Storage API 증거가 아니다.
begin;
set local storage.allow_delete_query='true';
create function pg_temp.photo69_uid(n integer)returns uuid language sql immutable as $$select ('d6900000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.photo69_session(n integer)returns uuid language sql immutable as $$select ('d6910000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.photo69_path(n integer,image integer)returns text language sql immutable as $$select pg_temp.photo69_uid(n)::text||'/d6920000-0000-4000-8000-'||lpad(image::text,12,'0')||'.jpg';$$;
create function pg_temp.photo69_claim(n integer,operation text)returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.photo69_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.photo69_uid(n),'session_id',pg_temp.photo69_session(n),'is_anonymous',false)::text,true);
 perform set_config('storage.operation',operation,true);
end;$$;
create function pg_temp.photo69_visible(n integer,image integer)returns boolean language sql stable as $$select exists(select 1 from storage.objects where bucket_id='profile-images' and name=pg_temp.photo69_path(n,image));$$;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$declare a jsonb;i integer;begin
 for i in 1..2 loop
  a:=public.resolve_naver_account('photo69-sql-'||i,'합성 사진회원','F','1990-01-01');
  insert into auth.users(id,email)values(pg_temp.photo69_uid(i),a->>'authEmail');
  insert into auth.sessions(id,user_id)values(pg_temp.photo69_session(i),pg_temp.photo69_uid(i));
  perform public.record_naver_session('photo69-sql-'||i,pg_temp.photo69_uid(i),pg_temp.photo69_session(i));
 end loop;
end $$;
insert into storage.objects(bucket_id,name,owner_id,metadata)values
 ('profile-images',pg_temp.photo69_path(1,1),pg_temp.photo69_uid(1)::text,'{"mimetype":"image/jpeg","size":634}'),
 ('profile-images',pg_temp.photo69_path(1,2),pg_temp.photo69_uid(1)::text,'{"mimetype":"image/jpeg","size":634}'),
 ('profile-images',pg_temp.photo69_path(2,1),pg_temp.photo69_uid(2)::text,'{"mimetype":"image/jpeg","size":634}');
set local role authenticated;
select pg_temp.photo69_claim(1,'storage.object.get_authenticated');
do $$begin assert pg_temp.photo69_visible(1,1),'own pre-signup photo unreadable';assert not pg_temp.photo69_visible(2,1),'nonmember peer photo exposed';end $$;
select public.complete_naver_signup(pg_temp.photo69_path(1,1),'{}','{}',null);
select pg_temp.photo69_claim(2,'storage.object.get_authenticated');
select public.complete_naver_signup(pg_temp.photo69_path(2,1),'{}','{}',null);
select pg_temp.photo69_claim(1,'storage.object.get_authenticated');
do $$begin assert pg_temp.photo69_visible(2,1),'current peer avatar unreadable';end $$;
do $$declare op text;begin
 foreach op in array array['storage.object.get_authenticated','object.get_authenticated','object.get_authenticated_info','storage.object.get_authenticated_info','object.head_authenticated_info','storage.object.upload','storage.object.delete','storage.object.delete_many']loop
  perform set_config('storage.operation',op,true);assert pg_temp.photo69_visible(1,1),'allowed operation blocked';
 end loop;
 foreach op in array array['','storage.object.sign','object.sign','storage.object.sign_many','storage.object.sign_upload_url','storage.object.upload_signed','storage.render.image_authenticated','storage.render.image_public','storage.render.image_sign','storage.s3.object.get','storage.s3.object.info','storage.s3.upload','storage.tus.upload.create','storage.object.list','storage.object.list_v2','storage.object.copy','storage.object.move','storage.object.upload_update','unknown.operation']loop
  perform set_config('storage.operation',op,true);assert not pg_temp.photo69_visible(1,1),'forbidden operation selected photo';
 end loop;
end $$;
select pg_temp.photo69_claim(1,'storage.object.sign_upload_url');
do $$begin
 begin insert into storage.objects(bucket_id,name,owner_id,metadata)values('profile-images',pg_temp.photo69_path(1,3),pg_temp.photo69_uid(1)::text,'{"mimetype":"image/jpeg","size":634}');raise exception 'signed upload INSERT allowed';
 exception when insufficient_privilege then null;end;
end $$;
select pg_temp.photo69_claim(1,'storage.object.upload');
insert into storage.objects(bucket_id,name,owner_id,metadata)values('profile-images',pg_temp.photo69_path(1,3),pg_temp.photo69_uid(1)::text,'{"mimetype":"image/jpeg","size":634}');
do $$begin assert pg_temp.photo69_visible(1,3),'canonical upload metadata invisible';end $$;
select pg_temp.photo69_claim(1,'storage.object.delete_many');
do $$begin
 begin delete from storage.objects where bucket_id='profile-images' and name=pg_temp.photo69_path(1,1);raise exception 'current avatar deleted';
 exception when insufficient_privilege then null;end;
 assert pg_temp.photo69_visible(1,1),'current avatar lost after denial';
end $$;
select pg_temp.photo69_claim(1,'storage.object.get_authenticated');
select public.set_my_profile_avatar(pg_temp.photo69_path(1,2));
select pg_temp.photo69_claim(1,'storage.object.delete_many');
delete from storage.objects where bucket_id='profile-images' and name=pg_temp.photo69_path(1,1);
do $$begin assert not pg_temp.photo69_visible(1,1),'old avatar retained';assert pg_temp.photo69_visible(1,2),'new current avatar lost';end $$;
reset role;
-- 실제 공개 탈퇴 RPC를 단일 rollback TX 안에서 실행한다. 외부 삭제 호출은 하지 않는다.
create temporary table photo69_acl_before as select p.oid,p.proowner,p.proacl::text acl from pg_proc p where p.oid in(
 'public.claim_member_cleanup_task(uuid)'::regprocedure,'public.check_member_cleanup_task(uuid,uuid,uuid,uuid)'::regprocedure,
 'public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid)'::regprocedure,'public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)'::regprocedure,
 'public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)'::regprocedure);
do $$begin assert (select not external_deletion_approved from private.member_cleanup_guard where singleton) is true;end $$;
update private.member_cleanup_guard set external_deletion_approved=true where singleton;
grant execute on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text) to service_role;
set local role authenticated;
select pg_temp.photo69_claim(1,'storage.object.get_authenticated');
do $$declare r jsonb;begin
 r:=public.retire_my_account('d6930000-0000-4000-8000-000000000001');assert(r->>'status'='processing' and(r->>'memberAccessRevoked')::boolean) is true;
 assert not pg_temp.photo69_visible(1,2),'retired caller current photo exposed';
 assert not pg_temp.photo69_visible(2,1),'retired caller peer photo exposed';
end $$;
select pg_temp.photo69_claim(2,'storage.object.get_authenticated');
do $$begin assert not pg_temp.photo69_visible(1,2),'active peer read retired target';assert pg_temp.photo69_visible(2,1),'active own photo unreadable';end $$;
reset role;
update private.member_cleanup_guard set external_deletion_approved=false where singleton;
revoke all on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text) from service_role;
do $$begin
 assert not exists(select 1 from photo69_acl_before b join pg_proc p on p.oid=b.oid where p.proowner<>b.proowner or p.proacl::text is distinct from b.acl),'cleanup owner/ACL changed';
 assert(select count(*)=2 from storage.objects where bucket_id='profile-images' and split_part(name,'/',1)=pg_temp.photo69_uid(1)::text) is true,'retirement denial was caused by deletion instead of access guard';
end $$;
do $$begin
 assert exists(select 1 from pg_policy where polrelid='storage.objects'::regclass and polname='profile_images_authenticated_operations_only' and not polpermissive and polcmd='r');
 assert exists(select 1 from pg_policy where polrelid='storage.objects'::regclass and polname='profile_images_authenticated_upload_operation_only' and not polpermissive and polcmd='a');
 assert (select not public and file_size_limit=2097152 and allowed_mime_types=array['image/jpeg']::text[] from storage.buckets where id='profile-images') is true;
end $$;
select 'PHOTO69_CHECK:pre_signup_current_peer_operation_allowlist_signed_upload_denied_current_delete_guard_swap_old_delete_retirement_access_before_provider_delete';
rollback;
