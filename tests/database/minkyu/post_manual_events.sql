-- 민규 전용 합성 SQL 역할·삽입 세션·RPC 검사. 실제 Auth 발급은 포함하지 않으며 모든 자료를 rollback한다.
begin;
-- 적용 actor가 archive owner와 달라도 신규 definer와 private RLS 테이블은 기존 호출 체인 소유자다.
do $$declare own oid; sig text; tbl regclass;
begin
 select proowner into strict own from pg_proc where oid='private.execute_inspected_content(text,jsonb)'::regprocedure;
 foreach sig in array array['private.normalize_post_manual_event(jsonb)','private.post_event_source_hidden(uuid)',
  'private.create_service_post_before_content_inspection(uuid,jsonb)','private.match_conditions(uuid)',
  'private.appointment_schedule_change_json(uuid)','private.end_appointment_schedule_change(uuid,text)',
  'private.clear_finished_event_change()','private.post_event_change_result(uuid,jsonb,timestamptz)',
  'private.update_service_post_before_content_inspection(uuid,jsonb,timestamptz)',
  'public.accept_appointment_schedule_change(uuid,uuid,text)','public.accept_appointment_event_change(uuid,uuid,text,text)',
  'public.get_service_post_event_link(uuid)','private.project_post_linked_event(uuid)','private.assert_post_event_selectable(uuid)'] loop
  assert (select proowner=own from pg_proc where oid=sig::regprocedure),'post event definer owner mismatch';
 end loop;
 foreach tbl in array array['private.post_manual_events'::regclass,'private.event_source_display'::regclass] loop
  assert (select relowner=own and relrowsecurity from pg_class where oid=tbl),'post event private table owner/RLS mismatch';
  assert not has_table_privilege('authenticated',tbl,'SELECT') and not has_table_privilege('service_role',tbl,'SELECT');
 end loop;
end;$$;
-- PostgREST POST도 STABLE이면 READ ONLY다. 회원 상태 공유 잠금을 유지하는 조회의 실행 속성을 검사한다.
do $$ begin
 assert (select provolatile='v' from pg_proc where oid='public.get_my_content_inspection_ticket(uuid,uuid)'::regprocedure), 'ticket reader must retain retirement lock in POST writable transaction';
end; $$;
-- schema-only 격리 DB의 필수 Storage metadata만 준비한다. 객체 파일·운영 자료는 만들지 않는다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('profile-images','profile-images',false,5242880,array['image/jpeg','image/png','image/webp'])
  on conflict(id) do nothing;
set local storage.allow_delete_query='true';
create function pg_temp.first_uid(n integer) returns uuid language sql immutable as $$
  select ('a1161000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.first_session(n integer) returns uuid language sql immutable as $$
  select ('a1162000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.first_actor(n integer,unregistered boolean default false) returns void language plpgsql as $$
declare u uuid:=pg_temp.first_uid(n);s uuid:=case when unregistered then 'a1162000-0000-4000-8000-000000000099'::uuid else pg_temp.first_session(n) end;
begin
  perform set_config('request.jwt.claim.sub',u::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',u,'session_id',s)::text,true);
end; $$;
create function pg_temp.first_input(n integer) returns jsonb language sql volatile as $$
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
  assert code=any(expected), format('unexpected SQLSTATE %s, expected %s',code,expected);
end; $$;
create temp table matching_cases(name text primary key,post_id uuid,input jsonb,r1 uuid,r2 uuid,version text,old_updated timestamptz);
grant all on matching_cases to authenticated,service_role;

-- 여섯 번째 회원은 활성화 뒤 최초 가입을 검사하기 위해 profile 생성 전 상태로 둔다.
set local role service_role;
do $$ declare i integer;begin
  for i in 1..6 loop perform public.resolve_naver_account('post-manual-sql-'||i,'합성회원'||i,'F','1990-01-01');end loop;
end $$;
reset role;

insert into auth.users(id,email) select pg_temp.first_uid(i),a.auth_email from generate_series(1,6) i
  join private.naver_accounts a on a.subject='post-manual-sql-'||i;
insert into auth.sessions(id,user_id) select pg_temp.first_session(i),pg_temp.first_uid(i) from generate_series(1,6) i;
insert into auth.sessions(id,user_id) values('a1162000-0000-4000-8000-000000000099',pg_temp.first_uid(1));
insert into storage.objects(bucket_id,name,owner_id,metadata)
  select 'profile-images',pg_temp.first_uid(i)::text||'/a1163000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
    pg_temp.first_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,6) i;
set local role service_role;
do $$ declare i integer;begin
  for i in 1..6 loop perform public.record_naver_session('post-manual-sql-'||i,pg_temp.first_uid(i),pg_temp.first_session(i));end loop;
end $$;
reset role;
set local role authenticated;
do $$ declare i integer;begin
  for i in 1..5 loop
    perform pg_temp.first_actor(i);
    assert public.complete_naver_signup(pg_temp.first_uid(i)::text||'/a1163000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
  end loop;
end $$;
reset role;

-- 승인값과 분류 출력은 합성 SQL fixture이며 실제 검사 품질/정책 승인이 아니다.
do $$ begin
 assert not(select enabled from private.content_inspection_control where singleton);
 assert not has_function_privilege('service_role','public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text)','EXECUTE');
 assert not has_table_privilege('authenticated','private.content_inspection_tickets','SELECT');
 assert not has_function_privilege('authenticated','private.execute_inspected_content(text,jsonb)','EXECUTE');
end; $$;
update private.content_inspection_control set enabled=true,policy_version='synthetic-policy',scanner_version='synthetic-scanner',max_ticket_seconds=60 where singleton;
grant execute on function public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text) to service_role;
create function pg_temp.content_ticket(a text,target uuid,input jsonb,decision text default 'allow',operation uuid default extensions.gen_random_uuid()) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare claims text:=current_setting('request.jwt.claims',true); u uuid:=auth.uid(); result jsonb;
begin
 perform set_config('request.jwt.claims',jsonb_build_object('role','service_role')::text,true);
 result:=public.issue_content_inspection_ticket(u,operation,a,target,input,decision,'synthetic-policy','synthetic-scanner');
 perform set_config('request.jwt.claims',claims,true);
 perform set_config('request.headers',jsonb_build_object('x-content-inspection-ticket',result->>'ticketId','x-content-operation-id',operation)::text,true);
 return result;
exception when others then perform set_config('request.jwt.claims',claims,true);raise;
end; $$;

create temp table manual_cases(post_id uuid primary key,input jsonb,request_id uuid,appointment_id uuid,change_id uuid,version text,fingerprint text,proposal_input jsonb,proposal_expected timestamptz,proposal_headers text);
grant all on manual_cases to authenticated;
grant select on manual_cases to anon;
create temp table manual_source_baseline as select count(*) n from private.source_events;
set local role authenticated;
select pg_temp.first_actor(1);
do $$declare p uuid:=gen_random_uuid();v jsonb;manual jsonb;result jsonb;begin
 manual:='{"title":"고유직접행사검색어","placeName":"공개 공연장","publicAddress":"공개 행사장 주소","publicAddressConfirmed":true}';
 v:=pg_temp.first_input(1)||jsonb_build_object('manualEvent',manual);
 perform pg_temp.content_ticket('post_create',p,jsonb_build_object('p_post_id',p,'p_input',v));
 result:=public.create_service_post(p,v);assert result->>'alreadyCreated'='false';
 assert public.get_service_post_event_link(p)->'manualEvent'=manual;
 assert public.get_service_post_event_link(p)->>'eventLinkState'='manual';
 insert into manual_cases(post_id,input) values(p,v);
 -- ticket 전체 입력 결합을 통과하지 않은 행사 원문 변경은 저장0이다.
 perform pg_temp.expect_failure(format('select public.create_service_post(%L,%L::jsonb)',p,
  v||jsonb_build_object('manualEvent',manual||'{"title":"검사후변조"}')) ,array['40001']);
end;$$;
reset role;
do $$begin
 assert (select count(*) from private.source_events)=(select n from manual_source_baseline);
 assert not has_table_privilege('authenticated','private.post_manual_events','SELECT');
 assert not has_table_privilege('anon','private.event_source_display','SELECT');
 assert not has_function_privilege('authenticated','private.create_service_post_before_content_inspection(uuid,jsonb)','EXECUTE');
 assert not has_function_privilege('authenticated','private.accept_change_before_manual_event(uuid,uuid,text)','EXECUTE');
 assert has_function_privilege('authenticated','public.accept_appointment_event_change(uuid,uuid,text,text)','EXECUTE');
 assert not has_function_privilege('service_role','public.accept_appointment_event_change(uuid,uuid,text,text)','EXECUTE');
end;$$;
set local role anon;
select set_config('request.jwt.claims','{}',true);
select set_config('request.jwt.claim.sub','',true);
do $$declare c manual_cases;v jsonb;begin
 select * into c from manual_cases;v:=public.get_service_post_event_link(c.post_id);
 assert not(public.get_service_post(c.post_id)?'manualEvent') and not(public.get_service_post(c.post_id)?'eventLinkState');
 assert (select array_agg(k order by k) from jsonb_object_keys(public.get_service_post(c.post_id)) k)=
  (select array_agg(k order by k) from unnest(array['postId','title','description','category','startsAt','endsAt','recruitmentEndsAt','updatedAt','publicArea','status','costType','amount','preferenceNote','tags','eventId','linkedEvent','authorDisplayName']) k);
 assert v->'manualEvent'=c.input->'manualEvent';
 assert not(v?'privateDetails') and not(v?'participantNames');
 assert jsonb_array_length(public.search_public_posts_v2('2026-10-05',null,'{"query":"고유직접행사검색어"}',null)->'items')=1;
end;$$;
reset role;
set local role authenticated;
select pg_temp.first_actor(1);
do $$declare c manual_cases;v jsonb;t timestamptz;begin
 select * into c from manual_cases;t:=(public.get_service_post(c.post_id)->>'updatedAt')::timestamptz;
 v:=c.input||jsonb_build_object('manualEvent',c.input->'manualEvent'||'{"title":"실질변경행사"}');
 perform pg_temp.content_ticket('post_update',c.post_id,jsonb_build_object('p_post_id',c.post_id,'p_input',v,'p_expected_updated_at',t));
 perform public.update_service_post(c.post_id,v,t);
 assert public.get_service_post_event_link(c.post_id)#>>'{manualEvent,title}'='실질변경행사';
 update manual_cases set input=v;
end;$$;
-- 실제 신청/상호 확정 뒤 행사 수정은 제안만 남긴다.
select pg_temp.first_actor(2);
do $$declare c manual_cases;v jsonb;msg uuid:=gen_random_uuid();begin
 select * into c from manual_cases;
 perform pg_temp.content_ticket('application_message',c.post_id,jsonb_build_object('p_post_id',c.post_id,'p_message_id',msg,'p_message','합성 신청 메시지'),'allow',msg);
 v:=public.request_service_post(c.post_id,msg,'합성 신청 메시지');
 update manual_cases set request_id=(v->>'id')::uuid;
 perform pg_temp.first_actor(1);v:=public.propose_match((v->>'id')::uuid);
 update manual_cases set version=v->>'conditionVersion';
end;$$;
select pg_temp.first_actor(2);
do $$declare c manual_cases;begin
 select * into c from manual_cases;perform public.accept_match(c.request_id,c.version);
end;$$;
reset role;
update manual_cases c set appointment_id=a.id from public.appointments a where a.post_id=c.post_id;
set local role authenticated;
select pg_temp.first_actor(1);
do $$declare c manual_cases;v jsonb;t timestamptz;state jsonb;cid uuid:=gen_random_uuid();begin
 select * into c from manual_cases;t:=(public.get_service_post(c.post_id)->>'updatedAt')::timestamptz;
 v:=c.input||jsonb_build_object('eventChangeId',cid,'manualEvent',c.input->'manualEvent'||'{"title":"합의후행사"}');
 perform pg_temp.content_ticket('post_update',c.post_id,jsonb_build_object('p_post_id',c.post_id,'p_input',v,'p_expected_updated_at',t));
 assert public.update_service_post(c.post_id,v,t)->>'status'='event_change_pending';
 assert public.get_service_post_event_link(c.post_id)#>>'{manualEvent,title}'='실질변경행사';
 state:=public.get_appointment_change_state(c.appointment_id);
 -- 현재 GET envelope는 서버 원본으로부터 조회한다. 경로를 추정하지 않고 관리자 아래에서 채운다.
 update manual_cases set change_id=cid,proposal_input=v,proposal_expected=t,proposal_headers=current_setting('request.headers',true);
end;$$;
reset role;
update manual_cases x set version=c.condition_version,fingerprint=c.event_fingerprint
 from private.appointment_schedule_changes c where c.change_id=x.change_id;
set local role authenticated;
select pg_temp.first_actor(2);
do $$declare c manual_cases;r jsonb;retried jsonb;begin
 select * into c from manual_cases;
 perform pg_temp.expect_failure(format('select public.accept_appointment_schedule_change(%L,%L,%L)',c.appointment_id,c.change_id,c.version),array['40001']);
 perform pg_temp.expect_failure(format('select public.accept_appointment_event_change(%L,%L,%L,%L)',c.appointment_id,c.change_id,c.version,repeat('0',64)),array['40001']);
 r:=public.accept_appointment_event_change(c.appointment_id,c.change_id,c.version,c.fingerprint);
 assert public.get_service_post_event_link(c.post_id)#>>'{manualEvent,title}'='합의후행사';
 retried:=public.accept_appointment_event_change(c.appointment_id,c.change_id,c.version,c.fingerprint);
 assert r->'deduplicated'='false'::jsonb and retried->'deduplicated'='true'::jsonb;
 assert r-'deduplicated'=retried-'deduplicated';
end;$$;
reset role;
do $$begin
 assert not exists(select 1 from private.appointment_schedule_changes c join manual_cases x on x.change_id=c.change_id
  where c.status<>'accepted' or c.new_event_input is not null);
 assert (select count(*) from private.source_events)=(select n from manual_source_baseline);
end;$$;
-- 승인 후 응답 유실: 소비된 동일 검사 ticket와 새 ticket 모두 accepted 영수증을 반환한다.
set local role authenticated;
select pg_temp.first_actor(1);
do $$declare c manual_cases;r jsonb;first_result jsonb;begin
 select * into c from manual_cases;
 perform set_config('request.headers',c.proposal_headers,true);
 first_result:=public.update_service_post(c.post_id,c.proposal_input,c.proposal_expected);
 assert first_result->>'status'='event_change_accepted';
 assert public.update_service_post(c.post_id,c.proposal_input,c.proposal_expected)=first_result;
 perform pg_temp.content_ticket('post_update',c.post_id,jsonb_build_object('p_post_id',c.post_id,'p_input',c.proposal_input,'p_expected_updated_at',c.proposal_expected));
 assert public.update_service_post(c.post_id,c.proposal_input,c.proposal_expected)=first_result;
end;$$;
-- 거절/만료 제안은 동일 key 재시도로 pending 상태를 재생성하지 않는다.
do $$declare c manual_cases;v jsonb;t timestamptz;cid uuid;state jsonb;headers text;begin
 select * into c from manual_cases;
 t:=(public.get_service_post(c.post_id)->>'updatedAt')::timestamptz;cid:=gen_random_uuid();
 v:=c.input||jsonb_build_object('eventChangeId',cid,'manualEvent',c.input->'manualEvent'||'{"title":"거절할행사"}');
 perform pg_temp.content_ticket('post_update',c.post_id,jsonb_build_object('p_post_id',c.post_id,'p_input',v,'p_expected_updated_at',t));
 assert public.update_service_post(c.post_id,v,t)->>'status'='event_change_pending';headers:=current_setting('request.headers',true);
 update manual_cases set change_id=cid,proposal_input=v,proposal_expected=t,proposal_headers=headers;
end;$$;
reset role;
update manual_cases x set version=c.condition_version from private.appointment_schedule_changes c where c.change_id=x.change_id;
set local role authenticated;
select pg_temp.first_actor(2);
do $$declare c manual_cases;begin
 select * into c from manual_cases;
 perform public.decline_appointment_schedule_change(c.appointment_id,c.change_id,c.version);
end;$$;
select pg_temp.first_actor(1);
do $$declare c manual_cases;v jsonb;t timestamptz;cid uuid;begin
 select * into c from manual_cases;perform set_config('request.headers',c.proposal_headers,true);
 assert public.update_service_post(c.post_id,c.proposal_input,c.proposal_expected)->>'status'='event_change_declined';
 perform pg_temp.content_ticket('post_update',c.post_id,jsonb_build_object('p_post_id',c.post_id,'p_input',c.proposal_input,'p_expected_updated_at',c.proposal_expected));
 assert public.update_service_post(c.post_id,c.proposal_input,c.proposal_expected)->>'status'='event_change_declined';
 t:=(public.get_service_post(c.post_id)->>'updatedAt')::timestamptz;cid:=gen_random_uuid();
 v:=c.input||jsonb_build_object('eventChangeId',cid,'manualEvent',c.input->'manualEvent'||'{"title":"만료될행사"}');
 perform pg_temp.content_ticket('post_update',c.post_id,jsonb_build_object('p_post_id',c.post_id,'p_input',v,'p_expected_updated_at',t));
 assert public.update_service_post(c.post_id,v,t)->>'status'='event_change_pending';
 update manual_cases set change_id=cid,proposal_input=v,proposal_expected=t,proposal_headers=current_setting('request.headers',true);
end;$$;
reset role;
-- 합성 SQL 시간창만 조정한다. 실제 자연 만료/Auth 검증으로 집계하지 않는다.
with tick as (select clock_timestamp() observed_at)
update private.appointment_schedule_changes c set requested_at=tick.observed_at-interval '7 hours',expires_at=tick.observed_at-interval '1 hour'
 from manual_cases x,tick where c.change_id=x.change_id;
set local role authenticated;
select pg_temp.first_actor(1);
do $$declare c manual_cases;begin
 select * into c from manual_cases;perform set_config('request.headers',c.proposal_headers,true);
 assert public.update_service_post(c.post_id,c.proposal_input,c.proposal_expected)->>'status'='event_change_expired';
 perform pg_temp.content_ticket('post_update',c.post_id,jsonb_build_object('p_post_id',c.post_id,'p_input',c.proposal_input,'p_expected_updated_at',c.proposal_expected));
 assert public.update_service_post(c.post_id,c.proposal_input,c.proposal_expected)->>'status'='event_change_expired';
 assert public.get_service_post_event_link(c.post_id)#>>'{manualEvent,title}'='합의후행사';
end;$$;
reset role;
do $$begin
 assert exists(select 1 from private.appointment_schedule_changes c join manual_cases x on x.change_id=c.change_id where c.status='expired' and c.new_event_input is null);
end;$$;
select 'PASS post_manual_event_acl_storage_search_inspection_explicit_accept';
rollback;
