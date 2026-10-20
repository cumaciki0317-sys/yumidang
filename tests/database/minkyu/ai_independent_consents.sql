-- 민규 전용 로컬 합성 자료. 실제 역할·세션·RPC를 검사하고 모든 자료를 rollback한다.
begin;
-- schema-only 복사본에서도 재현되도록 합성 회원이 참조하는 최소 사전을 transaction 안에 준비한다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[])
  on conflict(id) do nothing;
insert into private.review_praise_catalog(code,label,is_active,display_order)
  values('punctual','시간을 잘 지켜요',true,1)
  on conflict(code) do nothing;
set local storage.allow_delete_query='true';
create function pg_temp.match_uid(n integer) returns uuid language sql immutable as $$
  select ('81000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.match_session(n integer) returns uuid language sql immutable as $$
  select ('82000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.match_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
declare u uuid:=pg_temp.match_uid(n);s uuid:=case when unregistered then '82000000-0000-4000-8000-000000000099'::uuid else pg_temp.match_session(n) end;
begin
  perform set_config('request.jwt.claim.sub',u::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',u,'session_id',s)::text,true);
end; $$;
create function pg_temp.match_input(n integer) returns jsonb language sql volatile as $$
  select jsonb_build_object('title','합성 생명주기 공고','description','전용 로컬 검증 자료','category','산책',
    'startsAt',clock_timestamp()+make_interval(days=>n*3),'endsAt',clock_timestamp()+make_interval(days=>n*3,hours=>2),
    'recruitmentEndsAt',clock_timestamp()+make_interval(days=>n*3,hours=>-1),
    'publicArea','서울특별시 강남구 역삼동','registeredPlaceName','가상 장소','registeredAddress','비공개 가상주소 123',
    'meetingDetail','비공개 가상 입구','preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
$$;
create function pg_temp.expect_failure(command text,expected text[]) returns void language plpgsql as $$
declare code text;
begin
  begin execute command;
  exception when others then get stacked diagnostics code=returned_sqlstate; end;
  assert code=any(expected), 'unexpected permission/state result';
end; $$;
create temp table matching_cases(name text primary key,post_id uuid,input jsonb,r1 uuid,r2 uuid,version text,old_updated timestamptz);
grant all on matching_cases to authenticated,service_role;

-- 실제 자격 예약·세션 등록·사진·명시 완료를 거친 합성 회원 다섯 명.
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.resolve_naver_account('matching-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;
end $$;
reset role;
insert into auth.users(id,email) select pg_temp.match_uid(i),a.auth_email from generate_series(1,5) i
  join private.naver_accounts a on a.subject='matching-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.match_session(i),pg_temp.match_uid(i) from generate_series(1,5) i;
insert into auth.sessions(id,user_id) values('82000000-0000-4000-8000-000000000099',pg_temp.match_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.match_uid(i)::text||'/83000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
    pg_temp.match_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,5) i;
set local role service_role;
do $$ declare i integer;begin
  for i in 1..5 loop perform public.record_naver_session('matching-sql-'||i,pg_temp.match_uid(i),pg_temp.match_session(i));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare i integer;begin
  for i in 1..5 loop
    perform pg_temp.match_actor(i);
    assert public.complete_naver_signup(pg_temp.match_uid(i)::text||'/83000000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;


-- 기존 단일 true는 신규 동의를 부여하지 않는다.
insert into private.ai_member_processing(user_id,summary_allowed) values(pg_temp.match_uid(1),true);
set local role authenticated;
select pg_temp.match_actor(1);
do $$ declare v jsonb; before_profile jsonb; begin
 v:=public.get_my_ai_consents();
 assert v='{"exploration":false,"summary_view":false,"summary_generate":false,"summary_source":false}'::jsonb;
 before_profile:=public.get_my_profile();
 perform public.set_my_ai_consent('summary_view',true);
 assert public.get_my_ai_consents()->>'summary_view'='true';
 assert public.get_my_ai_consents()->>'summary_generate'='false';
 perform public.set_my_ai_consent('summary_generate',true);
 perform public.set_my_ai_consent('summary_source',true);
 perform public.set_my_ai_consent('summary_view',false);
 v:=public.get_my_ai_consents();
 assert v->>'summary_view'='false' and v->>'summary_generate'='true' and v->>'summary_source'='true';
 perform public.set_my_ai_consent('summary_source',false);
 assert public.get_my_ai_consents()->>'summary_generate'='true';
 assert public.get_my_profile()=before_profile;
 assert public.get_visible_review_summary(pg_temp.match_uid(2))='{"summary":null}'::jsonb;
 perform public.withdraw_my_ai_processing('review_summary');
 assert public.get_my_ai_consents()='{"exploration":false,"summary_view":false,"summary_generate":false,"summary_source":false}'::jsonb;
end; $$;
-- 사전 상태 읽기는 점유/한도/예산을 변경하지 않는다.
reset role;
update private.ai_processing_guard set external_processing_allowed=false where singleton;
set local role authenticated;
do $$ declare v jsonb;begin
 v:=public.get_my_ai_availability();
 assert v->>'estimatedEligible'='false' and v->>'reason'='processing_disabled';
 assert v->>'remaining'='20' and v->>'requestAuthoritative'='true';
 assert (v->>'resetsAt')::timestamptz>=(v->>'checkedAt')::timestamptz;
end; $$;
reset role;
update private.ai_processing_guard set external_processing_allowed=true where singleton;
set local role authenticated;
do $$ begin
 assert public.get_my_ai_availability()->>'reason'='consent_required';
 perform public.set_my_ai_consent('exploration',true);
 assert public.get_my_ai_availability()->>'estimatedEligible'='true';
end; $$;
reset role;
insert into private.ai_member_daily_usage(user_id,kst_day,started_requests)
 values(pg_temp.match_uid(1),(clock_timestamp() at time zone 'Asia/Seoul')::date,20);
set local role authenticated;
do $$ begin
 assert public.get_my_ai_availability()->>'reason'='daily_limit';
 assert public.get_my_ai_availability()->>'remaining'='0';
end; $$;
reset role;
do $$ begin
 assert not exists(select 1 from private.ai_chat_requests where user_id=pg_temp.match_uid(1));
 assert (select started_requests from private.ai_member_daily_usage where user_id=pg_temp.match_uid(1))=20;
end; $$;
rollback;
