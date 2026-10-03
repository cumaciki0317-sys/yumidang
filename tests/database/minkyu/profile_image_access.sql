-- 전용 로컬 DB의 합성 Auth/profile/Storage metadata만 사용한다. 실제 사진 업로드 증거가 아니다.
-- 실제 역할로 SELECT RLS를 실행하며 기존 가입·교체·제거 동작은 끝에서 전부 rollback한다.
begin;
set local storage.allow_delete_query='true';

create function pg_temp.photo_uid(p_n integer) returns uuid language sql immutable as $$
  select ('c6100300-0000-4000-8000-'||lpad(p_n::text,12,'0'))::uuid;
$$;
create function pg_temp.photo_path(p_user integer,p_image integer) returns text language sql immutable as $$
  select pg_temp.photo_uid(p_user)::text||'/d6100300-0000-4000-8000-'||lpad(p_image::text,12,'0')||'.jpg';
$$;
create function pg_temp.photo_claim(p_uid text,p_guest jsonb default 'false'::jsonb,p_role text default 'authenticated')
returns void language plpgsql as $$
declare c jsonb:=jsonb_build_object('sub',p_uid,'role',p_role);
begin
  if p_guest is not null then c:=c||jsonb_build_object('is_anonymous',p_guest); end if;
  perform set_config('request.jwt.claim.sub',coalesce(p_uid,''),true);
  perform set_config('request.jwt.claims',c::text,true);
end; $$;
-- SECURITY INVOKER: 이 helper로 실행하는 SELECT도 호출 역할의 RLS를 그대로 적용한다.
create function pg_temp.photo_visible(p_user integer,p_image integer) returns boolean language sql stable as $$
  select exists(select 1 from storage.objects where bucket_id='profile-images' and name=pg_temp.photo_path(p_user,p_image));
$$;

do $$ begin
  assert (select relrowsecurity from pg_class where oid='storage.objects'::regclass);
  assert not (select public from storage.buckets where id='profile-images');
  assert has_function_privilege('authenticated','private.can_read_profile_image(text,text,text)','EXECUTE');
  assert not has_function_privilege('anon','private.can_read_profile_image(text,text,text)','EXECUTE');
  assert not has_function_privilege('service_role','private.can_read_profile_image(text,text,text)','EXECUTE');
  assert (select prosecdef and provolatile='s' and proconfig=array['search_path=""']::text[]
    from pg_proc where oid='private.can_read_profile_image(text,text,text)'::regprocedure);
  assert exists(select 1 from pg_policies where schemaname='storage' and tablename='objects'
    and policyname='profile_images_authenticated_read' and cmd='SELECT' and roles=array['authenticated']::name[]);
end; $$;
select 'PHOTO_ACCESS_CHECK:acl';

insert into auth.users(id) select pg_temp.photo_uid(n) from generate_series(1,7) n;
insert into public.profiles(id,real_name,birth_date,gender,avatar_url) values
  (pg_temp.photo_uid(1),'사진본인','1990-01-01','female',pg_temp.photo_path(1,1)),
  (pg_temp.photo_uid(2),'사진상대','1990-01-01','female',pg_temp.photo_path(2,4)),
  (pg_temp.photo_uid(4),'제한회원','1990-01-01','female',pg_temp.photo_path(4,8)),
  (pg_temp.photo_uid(5),'잘못된소유자','1990-01-01','female',pg_temp.photo_path(5,9)),
  (pg_temp.photo_uid(6),'잘못된경로','1990-01-01','female',pg_temp.photo_uid(6)::text||'/bad.jpg');
insert into storage.buckets(id,name,public) values('photo-access-other','photo-access-other',false);
insert into storage.objects(bucket_id,name,owner_id,metadata) values
  ('profile-images',pg_temp.photo_path(1,1),pg_temp.photo_uid(1)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_path(1,2),pg_temp.photo_uid(1)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_path(1,3),pg_temp.photo_uid(1)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_path(2,4),pg_temp.photo_uid(2)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_path(2,5),pg_temp.photo_uid(2)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_path(2,6),pg_temp.photo_uid(2)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_path(3,7),pg_temp.photo_uid(3)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_path(4,8),pg_temp.photo_uid(4)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_path(5,9),pg_temp.photo_uid(2)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_uid(6)::text||'/bad.jpg',pg_temp.photo_uid(6)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_path(7,10),pg_temp.photo_uid(7)::text,'{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images',pg_temp.photo_path(1,11),null,'{"mimetype":"image/jpeg","size":1000}'),
  ('photo-access-other',pg_temp.photo_path(1,12),pg_temp.photo_uid(1)::text,'{"mimetype":"image/jpeg","size":1000}');
do $$ begin
  assert not exists(select 1 from private.naver_accounts where user_id in(select pg_temp.photo_uid(n) from generate_series(1,7) n));
end; $$;

set local role anon;
do $$ begin
  perform pg_temp.photo_claim(null,'false','anon');
  assert not pg_temp.photo_visible(1,1);
  assert not pg_temp.photo_visible(2,4);
end; $$;
reset role;
set local role authenticated;
do $$ declare flag jsonb; begin
  perform pg_temp.photo_claim(null);
  assert not pg_temp.photo_visible(1,1) and not pg_temp.photo_visible(2,4);
  foreach flag in array array['true'::jsonb,'null'::jsonb,'"false"'::jsonb,'0'::jsonb,'{}'::jsonb] loop
    perform pg_temp.photo_claim(pg_temp.photo_uid(1)::text,flag);
    assert not pg_temp.photo_visible(1,1) and not pg_temp.photo_visible(2,4);
  end loop;
  perform pg_temp.photo_claim(pg_temp.photo_uid(1)::text,'false','anon');
  assert not pg_temp.photo_visible(1,1);
  perform pg_temp.photo_claim('invalid-uid');
  assert not pg_temp.photo_visible(1,1);
  perform set_config('request.jwt.claim.sub','',true);
  perform set_config('request.jwt.claims','invalid-json',true);
  assert not pg_temp.photo_visible(1,1);
end; $$;
reset role;
select 'PHOTO_ACCESS_CHECK:anonymous_guest_missing_or_malformed_claims';

set local role authenticated;
do $$ begin
  -- 가입 전에도 본인의 업로드는 확인할 수 있지만 다른 회원의 현재 사진은 읽지 못한다.
  perform pg_temp.photo_claim(pg_temp.photo_uid(3)::text);
  assert pg_temp.photo_visible(3,7);
  assert not pg_temp.photo_visible(1,1) and not pg_temp.photo_visible(2,4) and not pg_temp.photo_visible(4,8);
end; $$;
reset role;
select 'PHOTO_ACCESS_CHECK:before_profile_self_only';

set local role authenticated;
do $$ begin
  perform pg_temp.photo_claim(pg_temp.photo_uid(1)::text);
  assert pg_temp.photo_visible(1,1) and pg_temp.photo_visible(1,2) and pg_temp.photo_visible(1,3);
  assert pg_temp.photo_visible(2,4) and pg_temp.photo_visible(4,8);
  assert not pg_temp.photo_visible(2,5) and not pg_temp.photo_visible(2,6);
  assert not pg_temp.photo_visible(3,7) and not pg_temp.photo_visible(7,10);
  assert not pg_temp.photo_visible(5,9) and not pg_temp.photo_visible(1,11);
  assert not exists(select 1 from storage.objects where bucket_id='profile-images' and name=pg_temp.photo_uid(6)::text||'/bad.jpg');
  assert not exists(select 1 from storage.objects where bucket_id='photo-access-other' and name=pg_temp.photo_path(1,12));
  -- 정상 회원 claim에서 is_anonymous 키 누락도 기존 호환을 유지한다.
  perform pg_temp.photo_claim(pg_temp.photo_uid(1)::text,null);
  assert pg_temp.photo_visible(1,1) and pg_temp.photo_visible(2,4);
end; $$;
reset role;
select 'PHOTO_ACCESS_CHECK:member_current_and_unlinked_boundaries';

set local role authenticated;
do $$ begin
  perform pg_temp.photo_claim(pg_temp.photo_uid(4)::text);
  assert pg_temp.photo_visible(4,8) and pg_temp.photo_visible(1,1) and pg_temp.photo_visible(2,4);
  assert public.get_my_profile()->>'userId'=pg_temp.photo_uid(4)::text;
  assert public.get_my_profile()->>'avatarUrl'=pg_temp.photo_path(4,8);
  perform pg_temp.photo_claim(pg_temp.photo_uid(5)::text);
  assert not pg_temp.photo_visible(5,9);
  perform pg_temp.photo_claim(pg_temp.photo_uid(6)::text);
  assert not exists(select 1 from storage.objects where name=pg_temp.photo_uid(6)::text||'/bad.jpg');
end; $$;
reset role;
select 'PHOTO_ACCESS_CHECK:restricted_profile_read_and_corrupt_ownership';

set local role authenticated;
do $$ declare r record; begin
  perform pg_temp.photo_claim(pg_temp.photo_uid(2)::text);
  select * into r from public.set_my_profile_avatar(pg_temp.photo_path(2,5));
  assert r.avatar_url=pg_temp.photo_path(2,5) and r.previous_avatar_path=pg_temp.photo_path(2,4);
  assert pg_temp.photo_visible(2,4) and pg_temp.photo_visible(2,5) and pg_temp.photo_visible(2,6);
  perform pg_temp.photo_claim(pg_temp.photo_uid(1)::text);
  assert not pg_temp.photo_visible(2,4) and pg_temp.photo_visible(2,5) and not pg_temp.photo_visible(2,6);
end; $$;
reset role;
select 'PHOTO_ACCESS_CHECK:replacement_immediately_hides_previous';

set local role authenticated;
do $$ declare n integer; begin
  perform pg_temp.photo_claim(pg_temp.photo_uid(3)::text);
  insert into storage.objects(bucket_id,name,owner_id,metadata)
    values('profile-images',pg_temp.photo_path(3,13),pg_temp.photo_uid(3)::text,'{"mimetype":"image/jpeg","size":1000}');
  assert pg_temp.photo_visible(3,13);
  begin
    insert into storage.objects(bucket_id,name,owner_id,metadata)
      values('profile-images',pg_temp.photo_path(2,14),pg_temp.photo_uid(3)::text,'{"mimetype":"image/jpeg","size":1000}');
    raise exception 'other user upload allowed';
  exception when insufficient_privilege then null; end;
  perform pg_temp.photo_claim(pg_temp.photo_uid(1)::text);
  begin
    delete from storage.objects where bucket_id='profile-images' and name=pg_temp.photo_path(1,1);
    raise exception 'current photo deletion allowed';
  exception when insufficient_privilege then null; end;
  assert pg_temp.photo_visible(1,1);
  delete from storage.objects where bucket_id='profile-images' and name=pg_temp.photo_path(1,2);
  get diagnostics n=row_count; assert n=1 and not pg_temp.photo_visible(1,2);
  delete from storage.objects where bucket_id='profile-images' and name=pg_temp.photo_path(1,3);
  get diagnostics n=row_count; assert n=1 and not pg_temp.photo_visible(1,3);
  delete from storage.objects where bucket_id='profile-images' and name=pg_temp.photo_path(2,5);
  get diagnostics n=row_count; assert n=0 and pg_temp.photo_visible(2,5);
end; $$;
reset role;
select 'PHOTO_ACCESS_CHECK:existing_insert_delete_rules';

rollback;
