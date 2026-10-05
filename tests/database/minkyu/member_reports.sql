-- 민규: 새 scratch 전용 합성자료. native/운영 DB에서 실행하지 않는다. 모든 fixture rollback.
begin;
set local storage.allow_delete_query='true';
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create function pg_temp.report_uid(n int)returns uuid language sql immutable as $$select('b1000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid$$;
create function pg_temp.report_actor(n int)returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.report_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.report_uid(n),'is_anonymous',false)::text,true);
end;$$;
create function pg_temp.expect_error(command text,expected text)returns void language plpgsql as $$declare actual text;begin
 begin execute command;exception when others then get stacked diagnostics actual=returned_sqlstate;end;
 assert actual=expected,format('expected %s got %s',expected,actual);
end;$$;
insert into auth.users(id,email)select pg_temp.report_uid(i),'synthetic-report-'||i||'@test.invalid'from generate_series(1,3)i;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)values('profile-images','profile-images',false,5242880,array['image/jpeg'])on conflict(id)do nothing;
insert into storage.objects(bucket_id,name,owner_id,metadata)select'profile-images',pg_temp.report_uid(i)::text||'/b3000000-0000-4000-8000-000000000001.jpg',pg_temp.report_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,3)i;
insert into public.profiles(id,real_name,birth_date,gender,avatar_url)select pg_temp.report_uid(i),'합성회원'||i,'1990-01-01','female',pg_temp.report_uid(i)::text||'/b3000000-0000-4000-8000-000000000001.jpg'from generate_series(1,3)i;
insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)values
 ('b4000000-0000-4000-8000-000000000001',pg_temp.report_uid(1),'합성 신고 공고','단독 scratch 검증','산책',now()+interval'3 days',now()+interval'3 days 2 hours',now()+interval'2 days','서울특별시 강남구 역삼동','recruiting');
insert into public.join_requests(id,post_id,requester_id,message,status)values
 ('b5000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001',pg_temp.report_uid(2),'합성 신청','pending');
insert into public.chat_messages(id,join_request_id,sender_id,content)values
 ('b6000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001',pg_temp.report_uid(1),'서버가 신고에 자동 복제하면 안 되는 합성 원문');
insert into public.appointments(id,post_id,join_request_id,status,confirmed_at)values
 ('b7000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000001','confirmed',now());
with event_record as(select jsonb_build_object('provider','synthetic-report','sourceId','local-event','sourceStatus','active','title','합성 신고 행사',
 'category',null,'region',null,'placeName',null,'publicAddress',null,'admission',jsonb_build_object('kind','free'),'sourceUrl',null,
 'collectedAt','2026-10-05T00:00:00Z','precision','date','startsOn','2026-10-07','endsOn','2026-10-08')record)
insert into private.source_events(id,provider,source_id,collected_at,record)
select'b4100000-0000-4000-8000-000000000001','synthetic-report','local-event','2026-10-05T00:00:00Z',record from event_record;
create temp table report_cases(report_id uuid,offline_report_id uuid);
grant all on report_cases to authenticated;
set local role authenticated;
select pg_temp.report_actor(2);
do $$declare uploaded_object uuid;a uuid:='b8000000-0000-4000-8000-000000000001';v jsonb;begin
 v:=public.reserve_report_capture(a,'png');assert v->>'bucket'='report-evidence';
 assert v->>'path'=pg_temp.report_uid(2)::text||'/'||a::text||'.png';
 assert public.reserve_report_capture(a,'png')=v;
 perform pg_temp.expect_error(format('select public.reserve_report_capture(%L,''jpg'')',a),'40001');
 perform pg_temp.expect_error(format('select public.confirm_report_capture(%L)',a),'42501');
 insert into storage.objects(bucket_id,name,owner_id,metadata)values('report-evidence',v->>'path',pg_temp.report_uid(2)::text,'{"mimetype":"image/png","size":128}')returning id into uploaded_object;
 assert uploaded_object is not null;
 assert public.confirm_report_capture(a)->>'state'='uploaded';
 v:=public.submit_member_report('b9000000-0000-4000-8000-000000000001','chat','b6000000-0000-4000-8000-000000000001','online',array['threat','other'],'본인이 제출한 합성 설명',array[a],true);
 assert v->>'status'='received'and(v->>'hideTarget')::boolean and not(v->>'alreadySubmitted')::boolean;
 insert into report_cases(report_id)values((v->>'reportId')::uuid);
 assert public.submit_member_report('b9000000-0000-4000-8000-000000000001','chat','b6000000-0000-4000-8000-000000000001','online',array['other','threat'],'본인이 제출한 합성 설명',array[a],true)->>'reportId'=v->>'reportId';
 assert(public.submit_member_report('b9000000-0000-4000-8000-000000000001','chat','b6000000-0000-4000-8000-000000000001','online',array['threat','other'],'본인이 제출한 합성 설명',array[a],true)->>'alreadySubmitted')::boolean;
 perform pg_temp.expect_error(format('select public.submit_member_report(''b9000000-0000-4000-8000-000000000001'',''chat'',''b6000000-0000-4000-8000-000000000001'',''online'',array[''threat''],''다른 설명'',array[%L]::uuid[],true)',a),'40001');
 assert public.get_my_report((v->>'reportId')::uuid)->>'description'='본인이 제출한 합성 설명';
 assert jsonb_array_length(public.list_my_reports(20,null)->'items')=1;
 assert exists(select 1 from storage.objects where bucket_id='report-evidence'and name=pg_temp.report_uid(2)::text||'/'||a::text||'.png');
 update storage.objects set metadata='{"mimetype":"image/png","size":129}'where bucket_id='report-evidence'and name=pg_temp.report_uid(2)::text||'/'||a::text||'.png';
 assert(select metadata->>'size'='128'from storage.objects where bucket_id='report-evidence'and name=pg_temp.report_uid(2)::text||'/'||a::text||'.png');
 -- 기존 profile-images 정책과 OR 합성해도 신고 객체의 소유자/경로/버킷을 바꿀 UPDATE 권한은 없다.
 update storage.objects set owner_id=pg_temp.report_uid(3)::text,name=pg_temp.report_uid(3)::text||'/'||a::text||'.png',bucket_id='profile-images'
 where id=uploaded_object;
 assert exists(select 1 from storage.objects where id=uploaded_object and bucket_id='report-evidence'and owner_id=pg_temp.report_uid(2)::text);
 perform pg_temp.expect_error(format('update private.report_capture_assets set owner_id=%L where id=%L',pg_temp.report_uid(3),a),'42501');
 perform pg_temp.expect_error(format('update private.member_reports set target_type=''member'',target_id=%L where id=%L',pg_temp.report_uid(3),(v->>'reportId')::uuid),'42501');

 delete from storage.objects where bucket_id='report-evidence'and name=pg_temp.report_uid(2)::text||'/'||a::text||'.png';
 assert exists(select 1 from storage.objects where bucket_id='report-evidence'and name=pg_temp.report_uid(2)::text||'/'||a::text||'.png');
 perform pg_temp.expect_error(format('select public.cancel_report_capture(%L)',a),'40001');
 -- 본인 업로드여도 같은 캡처를 다른 사건으로 다시 배정할 수 없다.
 perform pg_temp.expect_error(format('select public.submit_member_report(''b9000000-0000-4000-8000-000000000002'',''post'',''b4000000-0000-4000-8000-000000000001'',''online'',array[''spam''],''다른 접수'',array[%L]::uuid[],false)',a),'40001');
 perform pg_temp.expect_error('select public.submit_member_report(gen_random_uuid(),''post'',''b4000000-0000-4000-8000-000000000001'',''online'',array[''spam''],''캡처 없음'',''{}'',false)','22023');
 perform pg_temp.expect_error('select public.submit_member_report(gen_random_uuid(),''post'',''b4000000-0000-4000-8000-000000000001'',''offline'',array[''spam''],''온라인 우회'',''{}'',false)','22023');
 v:=public.submit_member_report('b9000000-0000-4000-8000-000000000003','appointment','b7000000-0000-4000-8000-000000000001','offline',array['no_show','other'],'대면 상황 설명만으로 접수','{}',false);
 update report_cases set offline_report_id=(v->>'reportId')::uuid;
 assert v->>'status'='received'and not(v->>'hideTarget')::boolean;
end;$$;
reset role;
-- 접수는 공고/채팅/확정/자동완료/공개후기/당도/제재를 변경하지 않으며 원문 자동 복제도 없다.
do $$declare r report_cases;begin select *into r from report_cases;
 assert(select status='recruiting'from public.posts where id='b4000000-0000-4000-8000-000000000001');
 assert(select status='confirmed'from public.appointments where id='b7000000-0000-4000-8000-000000000001');
 assert(select count(*)=2 from private.member_reports);
 assert not exists(select 1 from private.member_report_details where description like'%서버가 신고에 자동 복제%');
 assert exists(select 1 from private.report_access_audit where report_id=r.report_id and action='report_read');
 assert exists(select 1 from private.report_access_audit where report_id=r.report_id and action='storage_read');
 assert not has_table_privilege('authenticated','private.member_reports','SELECT');
 assert not has_table_privilege('service_role','private.member_report_details','SELECT');
 assert not has_function_privilege('anon','public.submit_member_report(uuid,text,uuid,text,text[],text,uuid[],boolean)','EXECUTE');
 assert not has_function_privilege('service_role','public.get_my_report(uuid)','EXECUTE');
end;$$;
set local role authenticated;
select pg_temp.report_actor(3);
do $$declare a uuid:='b8000000-0000-4000-8000-000000000001';begin
 assert public.list_my_reports()->'items'='[]'::jsonb;
 perform pg_temp.expect_error(format('insert into storage.objects(bucket_id,name,owner_id,metadata)values(''report-evidence'',%L,%L,''{"mimetype":"image/png","size":128}'')',pg_temp.report_uid(2)::text||'/'||a::text||'.png',pg_temp.report_uid(3)::text),'42501');
 perform pg_temp.expect_error(format('insert into storage.objects(bucket_id,name,owner_id,metadata)values(''report-evidence'',%L,%L,''{"mimetype":"image/png","size":128}'')',pg_temp.report_uid(3)::text||'/'||a::text||'.png',pg_temp.report_uid(3)::text),'42501');
 perform pg_temp.expect_error(format('select public.get_my_report(%L)',(select report_id from report_cases)),'PT404');
 perform pg_temp.expect_error(format('select public.confirm_report_capture(%L)',a),'42501');
 perform pg_temp.expect_error(format('select public.reserve_report_capture(%L,''png'')',a),'42501');
 assert not exists(select 1 from storage.objects where bucket_id='report-evidence'and name=pg_temp.report_uid(2)::text||'/'||a::text||'.png');
 update storage.objects set metadata='{"mimetype":"image/png","size":129}'where bucket_id='report-evidence'and name=pg_temp.report_uid(2)::text||'/'||a::text||'.png';
 assert not found;
 delete from storage.objects where bucket_id='report-evidence'and name=pg_temp.report_uid(2)::text||'/'||a::text||'.png';
 assert not found;

 perform pg_temp.expect_error('select public.submit_member_report(gen_random_uuid(),''appointment'',''b7000000-0000-4000-8000-000000000001'',''offline'',array[''other''],''권한없는 약속'',''{}'',false)','PT404');
 perform pg_temp.expect_error('select public.submit_member_report(gen_random_uuid(),''chat'',''b6000000-0000-4000-8000-000000000001'',''online'',array[''other''],''권한없는 채팅'',array[''b8000000-0000-4000-8000-000000000001'']::uuid[],false)','PT404');
end;$$;
select pg_temp.report_actor(2);
do $$declare a uuid:='b8000000-0000-4000-8000-000000000002';v jsonb;begin
 v:=public.reserve_report_capture(a,'jpg');
 insert into storage.objects(bucket_id,name,owner_id,metadata)values('report-evidence',v->>'path',pg_temp.report_uid(2)::text,'{"mimetype":"image/jpeg","size":5242881}');
 perform pg_temp.expect_error(format('select public.confirm_report_capture(%L)',a),'22023');
 assert public.cancel_report_capture(a)->>'storageDeletionRequired'='true';
 delete from storage.objects where bucket_id='report-evidence'and name=v->>'path';
 assert not exists(select 1 from storage.objects where bucket_id='report-evidence'and name=v->>'path');
 perform pg_temp.expect_error(format('select public.reserve_report_capture(%L,''jpg'')',a),'40001');
 -- 확장자와 MIME 불일치/문자 size/0/소수도 실제 metadata에서 거절한다.
end;$$;
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role authenticated;
select pg_temp.report_actor(2);
do $$declare i int;a uuid;v jsonb;begin
 for i in 3..6 loop
  a:=('b8000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid;v:=public.reserve_report_capture(a,'jpg');
  insert into storage.objects(bucket_id,name,owner_id,metadata)values('report-evidence',v->>'path',pg_temp.report_uid(2)::text,
    case i when 3 then'{"mimetype":"image/png","size":128}'::jsonb when 4 then'{"mimetype":"image/jpeg","size":"128"}'::jsonb when 5 then'{"mimetype":"image/jpeg","size":0}'::jsonb else'{"mimetype":"image/jpeg","size":1.5}'::jsonb end);
  perform pg_temp.expect_error(format('select public.confirm_report_capture(%L)',a),'22023');
 end loop;
 a:='b8000000-0000-4000-8000-000000000007';v:=public.reserve_report_capture(a,'webp');
 insert into storage.objects(bucket_id,name,owner_id,metadata)values('report-evidence',v->>'path',pg_temp.report_uid(2)::text,'{"mimetype":"image/webp","size":128}');
 perform public.confirm_report_capture(a);
 assert public.submit_member_report(gen_random_uuid(),'event','b4100000-0000-4000-8000-000000000001','online',array['other'],'행사에 연결한 합성 설명',array[a],false)->>'status'='received';
 assert public.submit_member_report(gen_random_uuid(),'member',pg_temp.report_uid(3),'offline',array['other'],'연결한 일반 대상 신고','{}',false)->>'status'='received';
 perform pg_temp.expect_error('select public.submit_member_report(gen_random_uuid(),''event'',''ffffffff-ffff-4fff-8fff-ffffffffffff'',''online'',array[''other''],''존재하지 않는 행사'',array[''b8000000-0000-4000-8000-000000000007'']::uuid[],false)','PT404');
end;$$;
reset role;
-- 실제 처리 담당자가 없어서 운영열람권한/상태전환 API는 없다. owner 합성상태로 보관 후보만 검증한다.
with closure as materialized(select clock_timestamp()-interval'91 days'closed_at)
update private.member_reports set status='resolved',final_closed_at=c.closed_at,retention_due_at=c.closed_at+interval'2160 hours'
from closure c where id=(select report_id from report_cases);
do $$begin assert(select count(*)=1 from private.report_retention_candidates);end;$$;
set local role authenticated;
select pg_temp.report_actor(2);
do $$begin
 perform pg_temp.expect_error(format('select public.get_my_report(%L)',(select report_id from report_cases)),'PT404');
 assert not exists(select 1 from storage.objects where bucket_id='report-evidence'and name=pg_temp.report_uid(2)::text||'/b8000000-0000-4000-8000-000000000001.png');
 assert jsonb_array_length(public.list_my_reports()->'items')=3;
end;$$;
reset role;
-- 같은 회원 UUID를 다시 쓰더라도 새 가입 회차에서는 이전 접수/캡처가 복구되지 않는다.
update private.member_episodes set ended_at=clock_timestamp()where profile_id=pg_temp.report_uid(2)and ended_at is null;
insert into private.member_episodes(profile_id)values(pg_temp.report_uid(2));
set local role authenticated;
select pg_temp.report_actor(2);
do $$begin
 assert public.list_my_reports()->'items'='[]'::jsonb;
 perform pg_temp.expect_error(format('select public.get_my_report(%L)',(select offline_report_id from report_cases)),'PT404');
 perform pg_temp.expect_error('select public.reserve_report_capture(''b8000000-0000-4000-8000-000000000007'',''webp'')','42501');
 perform pg_temp.expect_error('select public.confirm_report_capture(''b8000000-0000-4000-8000-000000000007'')','42501');
 perform pg_temp.expect_error('select public.cancel_report_capture(''b8000000-0000-4000-8000-000000000007'')','42501');
 assert not exists(select 1 from storage.objects where bucket_id='report-evidence'and name like pg_temp.report_uid(2)::text||'/%');
 -- 새 회차는 이전 회차와 같은 클라이언트 키로 새 접수를 할 수 있다.
 assert public.submit_member_report('b9000000-0000-4000-8000-000000000003','appointment','b7000000-0000-4000-8000-000000000001','offline',array['other'],'새 가입 회차의 별도 접수','{}',false)->>'alreadySubmitted'='false';
end;$$;
reset role;
select 'PASS 신고접수/첨부소유/온라인필수/오프라인선택/멱등/최소권한/감사';
rollback;
