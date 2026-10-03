-- 전용 로컬 DB 합성 자료만 사용하며 전부 rollback한다.
begin;
set local storage.allow_delete_query='true';
create function pg_temp.naver_jwt(p_uid uuid,p_session uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub',p_uid::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',p_uid,'session_id',p_session)::text,true);
end; $$;

do $$ begin
  assert has_function_privilege('service_role','public.begin_naver_login(text,text,text,integer,text)','EXECUTE');
  assert not has_function_privilege('authenticated','public.resolve_naver_account(text,text,text,date)','EXECUTE');
  assert not has_function_privilege('anon','public.record_naver_session(text,uuid,uuid)','EXECUTE');
  assert has_function_privilege('authenticated','public.complete_naver_signup(text,text[],text[],text)','EXECUTE');
  assert not has_function_privilege('service_role','public.complete_naver_signup(text,text[],text[],text)','EXECUTE');
  assert not has_function_privilege('authenticated','public.complete_signup_with_avatar(text,date,text,text,text,text)','EXECUTE');
  assert not has_table_privilege('service_role','private.naver_accounts','SELECT');
  assert not has_table_privilege('authenticated','private.naver_sessions','INSERT');
  assert not has_function_privilege('authenticated','private.assert_naver_activity_allowed()','EXECUTE');
end $$;
select 'NAVER_CHECK:acl';

set local role service_role;
do $$ declare h text:=repeat('a',64); v text:=repeat('b',64); r jsonb;
begin
  r:=public.begin_naver_login(h,v,'/posts',600,'http://localhost:3000'); assert r?'expiresAt';
  begin perform public.consume_naver_login(h,repeat('c',64),'http://localhost:3000'); raise exception 'wrong verifier accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.consume_naver_login(h,v,'https://other.invalid'); raise exception 'wrong origin accepted';
  exception when sqlstate '22023' then null; end;
  assert public.consume_naver_login(h,v,'http://localhost:3000')='{"returnTo":"/posts"}'::jsonb;
  begin perform public.consume_naver_login(h,v,'http://localhost:3000'); raise exception 'state replay accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.begin_naver_login(repeat('e',64),v,'//outside.invalid',600,'http://localhost:3000'); raise exception 'external return accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.begin_naver_login(repeat('e',64),v,'/',null,'http://localhost:3000'); raise exception 'null TTL accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.begin_naver_login(repeat('e',64),v,'/',3601,'http://localhost:3000'); raise exception 'large TTL accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.begin_naver_login('raw-state',v,'/',600,'http://localhost:3000'); raise exception 'raw state accepted';
  exception when sqlstate '22023' then null; end;
  perform public.begin_naver_login(repeat('d',64),v,'/',1,'http://localhost:3000');
end $$;
reset role;
update private.naver_login_challenges set expires_at=clock_timestamp()-interval '1 second' where state_hash=repeat('d',64);
set local role service_role;
do $$ begin
  begin perform public.consume_naver_login(repeat('d',64),repeat('b',64),'http://localhost:3000'); raise exception 'expired state accepted';
  exception when sqlstate '22023' then null; end;
end $$;
reset role;
select 'NAVER_CHECK:state_one_use_wrong_verifier_expiry';

set local role service_role;
do $$ declare r jsonb; e text; v_today date:=(clock_timestamp() at time zone 'Asia/Seoul')::date;
begin
  r:=public.resolve_naver_account('naver-missing',null,'F','1990-01-01');
  assert r='{"status":"information_required","authEmail":null,"userId":null}'::jsonb;
  r:=public.resolve_naver_account('naver-male','검증남성','M','1990-01-01');
  assert r='{"status":"ineligible","authEmail":null,"userId":null}'::jsonb;
  r:=public.resolve_naver_account('naver-young','검증미성년','F',(v_today-interval '19 years')::date+1);
  assert r->>'status'='ineligible' and r->>'authEmail' is null;
  r:=public.resolve_naver_account('naver-age-boundary','경계검사','F',(v_today-interval '19 years')::date);
  assert r->>'status'='photo_required';
  r:=public.resolve_naver_account('naver-a','김','F','1990-01-01');
  e:=r->>'authEmail'; assert e like '%@naver.yumidang.invalid' and r->>'userId' is null;
  assert public.resolve_naver_account('naver-a','김','F','1990-01-01')->>'authEmail'=e;
  r:=public.resolve_naver_account('naver-b','다른회원','F','1990-01-01'); assert r->>'authEmail'<>e;
end $$;
reset role;
do $$ begin
  assert not exists(select 1 from private.naver_accounts where subject in ('naver-missing','naver-male','naver-young'));
  assert not exists(select 1 from public.profiles where id in(select user_id from private.naver_accounts));
end $$;

insert into auth.users(id,email) select '71000000-0000-4000-8000-000000000001',auth_email from private.naver_accounts where subject='naver-a';
insert into auth.users(id,email) select '71000000-0000-4000-8000-000000000002',auth_email from private.naver_accounts where subject='naver-b';
insert into auth.users(id,email) values('71000000-0000-4000-8000-000000000003','legacy-fixture@example.invalid');
insert into auth.sessions(id,user_id) values
  ('72000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001'),
  ('72000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002'),
  ('72000000-0000-4000-8000-000000000003','71000000-0000-4000-8000-000000000003'),
  ('72000000-0000-4000-8000-000000000004','71000000-0000-4000-8000-000000000001');
insert into public.profiles(id,real_name,birth_date,gender) values('71000000-0000-4000-8000-000000000003','미검증회원','1990-01-01','female');
set local role service_role;
do $$ declare u uuid:='71000000-0000-4000-8000-000000000001'; s uuid:='72000000-0000-4000-8000-000000000001';
begin
  begin perform public.record_naver_session('naver-a',u,'72000000-0000-4000-8000-000000000099'); raise exception 'fake Auth session accepted';
  exception when sqlstate '28000' then null; end;
  begin perform public.record_naver_session('naver-a',u,'72000000-0000-4000-8000-000000000002'); raise exception 'other user session accepted';
  exception when sqlstate '28000' then null; end;
  begin perform public.record_naver_session('naver-a','71000000-0000-4000-8000-000000000003','72000000-0000-4000-8000-000000000003'); raise exception 'real email link accepted';
  exception when unique_violation then null; end;
  assert public.record_naver_session('naver-a',u,s)->>'status'='photo_required';
  assert public.record_naver_session('naver-a',u,s)->>'userId'=u::text;
  begin perform public.record_naver_session('naver-b',u,s); raise exception 'UID subject collision accepted';
  exception when unique_violation then null; end;
  perform public.record_naver_session('naver-b','71000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000002');
end $$;
reset role;
select 'NAVER_CHECK:eligibility_reservation_uid_session';

insert into storage.objects(bucket_id,name,owner_id,metadata) values
  ('profile-images','71000000-0000-4000-8000-000000000001/73000000-0000-4000-8000-000000000001.jpg','71000000-0000-4000-8000-000000000001','{"mimetype":"image/jpeg","size":1000}'),
  ('profile-images','71000000-0000-4000-8000-000000000002/73000000-0000-4000-8000-000000000002.jpg','71000000-0000-4000-8000-000000000002','{"mimetype":"image/jpeg","size":1000}');
select pg_temp.naver_jwt('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000004');
set local role authenticated;
do $$ begin
  begin perform public.get_naver_signup_state(); raise exception 'unregistered password session accepted';
  exception when sqlstate '28000' then null; end;
end $$;
reset role;
select pg_temp.naver_jwt('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ declare r jsonb; path text:='71000000-0000-4000-8000-000000000001/73000000-0000-4000-8000-000000000001.jpg';
begin
  assert public.get_naver_signup_state()='{ "status":"photo_required", "avatarPath":null,"interests":[],"conversationStyles":[],"mbti":null}'::jsonb;
  begin perform public.complete_naver_signup(null,'{}','{}',null); raise exception 'no photo completion accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.complete_naver_signup(path,array['산책','산책'],'{}',null); raise exception 'duplicate traits accepted';
  exception when sqlstate '22023' then null; end;
  assert public.get_naver_signup_state()->>'status'='photo_required','invalid traits persisted profile';
  begin perform public.complete_naver_signup(path,'{}','{}','XXXX'); raise exception 'invalid MBTI accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.complete_naver_signup(path,array[repeat('가',41)],'{}',null); raise exception '41 character trait accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.complete_naver_signup(path,(select array_agg('성향'||n) from generate_series(1,21) n),'{}',null); raise exception '21 traits accepted';
  exception when sqlstate '22023' then null; end;
  begin perform public.complete_naver_signup('71000000-0000-4000-8000-000000000002/73000000-0000-4000-8000-000000000002.jpg','{}','{}',null); raise exception 'other member photo accepted';
  exception when sqlstate '22023' then null; end;
  r:=public.complete_naver_signup(path,array['산책'],array['편안한 대화'],'infj');
  assert r->>'status'='ready' and r->>'mbti'='INFJ' and r->'interests'='["산책"]'::jsonb;
  assert not (r ?| array['authEmail','userId','subject','birthDate','realName']);
end $$;
reset role;
do $$ begin
  assert (select completed_at is not null from private.naver_accounts where subject='naver-a');
  assert (select real_name='김' from public.profiles where id='71000000-0000-4000-8000-000000000001');
  begin delete from storage.objects where bucket_id='profile-images' and name='71000000-0000-4000-8000-000000000001/73000000-0000-4000-8000-000000000001.jpg'; raise exception 'last photo deleted';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.naver_jwt('71000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000002');
set local role authenticated;
select public.complete_naver_signup('71000000-0000-4000-8000-000000000002/73000000-0000-4000-8000-000000000002.jpg','{}','{}',null)->>'status';
reset role;
select 'NAVER_CHECK:explicit_completion_photo_atomic_traits_safe_output';

-- 기존 조회는 유지하고 신규 등록·신청·확정의 trigger 경계를 직접 검사한다.
select pg_temp.naver_jwt('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001');
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount)
values('74000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','가상 동행','가상 동행 설명','산책',now()+interval '2 days',now()+interval '3 days',now()+interval '1 day','서울특별시 강남구 역삼동','free',0);
select pg_temp.naver_jwt('71000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000002');
insert into public.join_requests(id,post_id,requester_id,message) values('75000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000002','가상 신청 메시지입니다');
select pg_temp.naver_jwt('71000000-0000-4000-8000-000000000003','72000000-0000-4000-8000-000000000003');
set local role authenticated;
do $$ begin
  perform public.get_my_profile();
  assert (select count(*) from public.posts where id='74000000-0000-4000-8000-000000000001')=1;
  begin perform public.get_naver_signup_state(); raise exception 'legacy session accepted';
  exception when sqlstate '28000' then null; end;
end $$;
reset role;
do $$ begin
  begin
    insert into public.posts(author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
    values('71000000-0000-4000-8000-000000000003','신규 차단','신규 차단 설명','산책',now()+interval '2 days',now()+interval '3 days',now()+interval '1 day','서울특별시 강남구 역삼동');
    raise exception 'legacy new post accepted';
  exception when sqlstate '28000' then null; end;
  begin insert into public.join_requests(post_id,requester_id,message)
    values('74000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000003','가상 신청 메시지입니다'); raise exception 'legacy join accepted';
  exception when sqlstate '28000' then null; end;
  begin insert into private.match_consents(request_id,condition_version,condition_fingerprint,conditions,requested_by)
    values('75000000-0000-4000-8000-000000000001','v1','fixture','{}','71000000-0000-4000-8000-000000000003'); raise exception 'legacy consent accepted';
  exception when sqlstate '28000' then null; end;
  begin insert into public.appointments(post_id,join_request_id)
    values('74000000-0000-4000-8000-000000000001','75000000-0000-4000-8000-000000000001'); raise exception 'legacy appointment accepted';
  exception when sqlstate '28000' then null; end;
end $$;
set local role service_role;
select public.resolve_naver_account('naver-a',null,null,null)->>'status';
reset role;
select pg_temp.naver_jwt('71000000-0000-4000-8000-000000000001','72000000-0000-4000-8000-000000000001');
set local role authenticated;
do $$ begin
  assert public.get_naver_signup_state()->>'status'='information_required';
  perform public.get_my_profile();
  begin perform public.complete_naver_signup('71000000-0000-4000-8000-000000000001/73000000-0000-4000-8000-000000000001.jpg','{}','{}',null); raise exception 'unqualified completion accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  assert (select real_name='김' from public.profiles where id='71000000-0000-4000-8000-000000000001'),'missing information destroyed profile';
  begin insert into private.match_consents(request_id,condition_version,condition_fingerprint,conditions,requested_by)
    values('75000000-0000-4000-8000-000000000001','v1','fixture','{}','71000000-0000-4000-8000-000000000001'); raise exception 'revoked eligibility consent accepted';
  exception when insufficient_privilege then null; end;
end $$;
select pg_temp.naver_jwt('71000000-0000-4000-8000-000000000002','72000000-0000-4000-8000-000000000002');
do $$ begin
  begin insert into public.appointments(post_id,join_request_id)
    values('74000000-0000-4000-8000-000000000001','75000000-0000-4000-8000-000000000001'); raise exception 'invalid other participant appointment accepted';
  exception when insufficient_privilege then null; end;
end $$;
set local role service_role;
do $$ begin
  assert public.resolve_naver_account('naver-a','새검증이름','F','1991-02-03')->>'status'='ready';
end $$;
reset role;
do $$ begin assert (select real_name='새검증이름' and birth_date='1991-02-03' from public.profiles where id='71000000-0000-4000-8000-000000000001'); end $$;
select 'NAVER_CHECK:legacy_reads_activity_gates_relogin_requalification';

set local role authenticated;
do $$ declare n integer; begin
  begin select count(*) into n from private.naver_accounts; raise exception 'private mapping readable';
  exception when insufficient_privilege then null; end;
  begin insert into private.naver_sessions(session_id,user_id,subject) values(gen_random_uuid(),gen_random_uuid(),'forged'); raise exception 'private session writable';
  exception when insufficient_privilege then null; end;
  begin perform public.resolve_naver_account('forged','가상','F','1990-01-01'); raise exception 'client qualification writable';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin perform public.get_naver_signup_state(); raise exception 'anonymous signup state readable';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'NAVER_CHECK:actual_role_denial';
rollback;
