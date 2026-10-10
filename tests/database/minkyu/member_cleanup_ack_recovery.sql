-- 민규 A: typed 판정/본인 통지/읽기/보관 연결 후보. 실제 실행 NOT_RUN.
-- 판정/운영자 계정을 생성하지 않고 owner 합성 원장만 준비한다. Auth/Storage 자료와 설정은 전체 rollback한다.
begin;
set local plpgsql.check_asserts=on;
set local storage.allow_delete_query='true';
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[]) on conflict(id) do nothing;
create function pg_temp.safety_uid(n integer) returns uuid language sql immutable as $$
 select ('ac710000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.safety_session(n integer) returns uuid language sql immutable as $$
 select ('ac720000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.safety_actor(n integer) returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.safety_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.safety_uid(n),'session_id',pg_temp.safety_session(n))::text,true);
end;$$;
create function pg_temp.safety_failure(command text,expected text) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('expected %s, actual %s',expected,code);
end;$$;
create temp table safety_catalog as select
 (select jsonb_agg(jsonb_build_array(rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls)order by rolname)from pg_roles)roles,
 (select jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor)from pg_auth_members)memberships,
 (select external_deletion_approved from private.member_cleanup_guard where singleton)guard,
 (select to_jsonb(g)from private.global_worker_run g where singleton)worker;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop
 perform public.resolve_naver_account('connection107-native-'||i,'합성회원'||i,'F','1990-01-01');end loop;end;$$;
reset role;
insert into auth.users(id,email)select pg_temp.safety_uid(i),a.auth_email from generate_series(1,2)i
 join private.naver_accounts a on a.subject='connection107-native-'||i;
insert into auth.sessions(id,user_id)select pg_temp.safety_session(i),pg_temp.safety_uid(i)from generate_series(1,2)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)
 select 'profile-images',pg_temp.safety_uid(i)::text||'/ac730000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',
 pg_temp.safety_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,2)i;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop
 perform public.record_naver_session('connection107-native-'||i,pg_temp.safety_uid(i),pg_temp.safety_session(i));end loop;end;$$;
reset role;
set local role authenticated;
do $$declare i integer;begin for i in 1..2 loop
 perform pg_temp.safety_actor(i);
 assert public.complete_naver_signup(pg_temp.safety_uid(i)::text||'/ac730000-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null)->>'status'='ready';
 assert public.get_my_safety_state()='{"permanent":false,"restrictedUntil":null,"hasWarning":false,"sanctions":[]}'::jsonb;
end loop;end;$$;
reset role;



-- native DB 메시지 집합: legacy watermark를 새 집합으로 추론하지 않는다.
set local role authenticated;select pg_temp.safety_actor(1);
select public.create_service_post('ac740000-0000-4000-8000-000000000001',jsonb_build_object('title','메시지 읽음 검증','description','합성 공고','category','산책','startsAt',now()+interval'3 days','endsAt',now()+interval'3 days 2 hours','recruitmentEndsAt',now()+interval'2 days','publicArea','서울특별시 강남구 역삼동','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 입구','registeredPlaceName',null,'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));
select pg_temp.safety_actor(2);
create temp table connection_conversation as select(public.request_service_post('ac740000-0000-4000-8000-000000000001','ac750000-0000-4000-8000-000000000001','첫 합성 메시지')->>'id')::uuid id;
grant select on connection_conversation to authenticated;
do $$begin perform public.send_conversation_message((select id from connection_conversation),'ac750000-0000-4000-8000-000000000002','두 번째 합성 메시지');end;$$;
select pg_temp.safety_actor(1);
do $$declare rid uuid:=(select id from connection_conversation);first_stamp timestamptz;v jsonb;begin
 perform public.mark_conversation_read(rid,'ac750000-0000-4000-8000-000000000002');
 v:=public.get_conversation_with_read_state(rid)->0;assert v->>'unread_count'='0'and v->>'unread_message_count'='2';
 v:=public.mark_conversation_messages_read(rid,array['ac750000-0000-4000-8000-000000000002'::uuid]);assert v->>'unreadCount'='1';
 perform pg_temp.safety_failure(format('select public.mark_conversation_messages_read(%L,array[%L::uuid,%L::uuid])',rid,'ac750000-0000-4000-8000-000000000001',gen_random_uuid()),'PT404');
 assert public.get_conversation_with_read_state(rid)->0->>'unread_message_count'='1';
end;$$;
reset role;
do $$declare stamp timestamptz;after_stamp timestamptz;begin
 select read_at into stamp from private.conversation_message_reads where user_id=pg_temp.safety_uid(1);
 perform pg_temp.safety_actor(1);perform public.mark_conversation_messages_read((select id from connection_conversation),array['ac750000-0000-4000-8000-000000000002'::uuid]);
 select read_at into after_stamp from private.conversation_message_reads where user_id=pg_temp.safety_uid(1);assert stamp=after_stamp;
 assert not has_table_privilege('authenticated','private.conversation_message_reads','SELECT');
end;$$;
-- 엄격히 원문없는 최소 dispatch만 기록한다.
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update private.global_worker_run set token='ac760000-0000-4000-8000-000000000001',expires_at=now()+interval'180 seconds'where singleton;
update private.worker_runtime_atomic_control set enabled=true;
update private.ai_feedback_maintenance_control set enabled=true;
do $$begin
 assert not has_function_privilege('service_role','public.purge_expired_ai_feedback(integer)','EXECUTE');
 assert public.read_worker_runtime_pending_v2()->>'hasPending'='true';
end;$$;
-- 실제 탈퇴 RPC와 task의 영속 dispatch는 트랜잭션 끝에 모두 복원한다.
grant execute on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text),public.begin_member_cleanup_delete(uuid,uuid,uuid,uuid)to service_role;
update private.member_cleanup_guard set external_deletion_approved=true;
set local role authenticated;select pg_temp.safety_actor(2);
select public.retire_my_account('ac770000-0000-4000-8000-000000000001');
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$declare t private.member_cleanup_tasks;v jsonb;again jsonb;lease uuid:=gen_random_uuid();begin
 select *into strict t from private.member_cleanup_tasks where withdrawal_id='ac770000-0000-4000-8000-000000000001'and kind='storage_object';
 update private.member_cleanup_tasks set state='running',lease_token=lease,worker_run_token='ac760000-0000-4000-8000-000000000001',lease_expires_at=now()+interval'60 seconds'where id=t.id;
 v:=public.begin_member_cleanup_delete(t.id,lease,'ac760000-0000-4000-8000-000000000001',t.object_id);again:=public.begin_member_cleanup_delete(t.id,lease,'ac760000-0000-4000-8000-000000000001',t.object_id);
 assert v->>'alreadyDispatched'='false'and again->>'alreadyDispatched'='true'and v->>'dispatchId'=again->>'dispatchId';
 update private.member_cleanup_tasks set lease_expires_at=now()-interval'1 second'where id=t.id;
 perform public.claim_member_cleanup_task('ac760000-0000-4000-8000-000000000001');
 assert(select lease_token=lease from private.member_cleanup_tasks where id=t.id);
 assert not has_table_privilege('authenticated','private.member_cleanup_dispatches','SELECT');
end;$$;

-- SQL108: ACK없는 dispatch는 거절하고, 일치 ACK만 새 점유 GET-only 복구한다.
grant execute on function public.read_member_cleanup_recovery(uuid,integer),public.claim_member_cleanup_ack_recovery(uuid,uuid)to service_role;
do $$declare t private.member_cleanup_tasks;d private.member_cleanup_dispatches;r jsonb;old_receipt jsonb;recovered_receipt jsonb;begin
 select *into strict t from private.member_cleanup_tasks where withdrawal_id='ac770000-0000-4000-8000-000000000001'and kind='storage_object';
 select *into strict d from private.member_cleanup_dispatches where task_id=t.id;
 perform pg_temp.safety_failure(format('select public.claim_member_cleanup_ack_recovery(%L,%L)',t.id,d.global_token),'40001');
 assert exists(select 1 from jsonb_array_elements(public.read_member_cleanup_recovery(null,100))x where x->>'taskId'=t.id::text and x->>'hasVerifiedAck'='false');
 update private.member_cleanup_tasks set lease_expires_at=clock_timestamp()+interval'60 seconds'where id=t.id;
 old_receipt:=public.record_member_cleanup_delete_ack(t.id,t.lease_token,d.global_token,t.object_id,repeat('a',64));
 perform pg_temp.safety_failure(format('select public.claim_member_cleanup_ack_recovery(%L,%L)',t.id,d.global_token),'40001');
 update private.member_cleanup_tasks set lease_expires_at=clock_timestamp()-interval'1 second'where id=t.id;
 r:=public.claim_member_cleanup_ack_recovery(t.id,d.global_token);
 assert r->>'taskId'=t.id::text and(r->>'leaseToken')::uuid<>t.lease_token;
 recovered_receipt:=public.get_member_cleanup_delete_ack(t.id,(r->>'leaseToken')::uuid,d.global_token,t.object_id);
 assert recovered_receipt=old_receipt;
 perform pg_temp.safety_failure(format('select public.check_member_cleanup_task(%L,%L,%L,%L)',t.id,t.lease_token,d.global_token,t.object_id),'40001');
 delete from storage.objects where id=t.object_id;
 assert public.complete_member_cleanup_task(t.id,(r->>'leaseToken')::uuid,d.global_token,t.object_id,repeat('b',64))->>'status'='applied';
 assert public.claim_member_cleanup_ack_recovery(t.id,d.global_token)is null;
 assert not exists(select 1 from jsonb_array_elements(public.read_member_cleanup_recovery(null,100))x where x->>'taskId'=t.id::text);
 assert not has_function_privilege('authenticated','public.claim_member_cleanup_ack_recovery(uuid,uuid)','EXECUTE');
end;$$;
rollback;
