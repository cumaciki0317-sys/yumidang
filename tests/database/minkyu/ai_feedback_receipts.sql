-- 결과 증거 없이 과거 finished를 성공으로 취급하지 않는다. 합성 데이터·전체 outer rollback.
insert into private.ai_member_processing(user_id,active_request_id)values(pg_temp.safety_uid(1),'fda70000-0000-4000-8000-000000000001')on conflict(user_id)do update set active_request_id=excluded.active_request_id;
insert into private.ai_chat_requests(request_id,user_id,client_request_hash,lease_token,expires_at)
 values('fda70000-0000-4000-8000-000000000001',pg_temp.safety_uid(1),repeat('8',64),'fda70000-0000-4000-8000-000000000002',clock_timestamp()+interval'3 minutes');
set local role service_role;
do $$begin
 perform pg_temp.safety_failure(format('select public.record_ai_chat_result_available(%L,%L,null)',pg_temp.safety_uid(1),'fda70000-0000-4000-8000-000000000001'),'22023');
 perform public.record_ai_chat_result_available(pg_temp.safety_uid(1),'fda70000-0000-4000-8000-000000000001','fda70000-0000-4000-8000-000000000002');
 perform public.finish_ai_chat_request(pg_temp.safety_uid(1),'fda70000-0000-4000-8000-000000000001','fda70000-0000-4000-8000-000000000002','finished');
end;$$;
do $$declare first jsonb;again jsonb;begin
 first:=public.submit_ai_feedback(pg_temp.safety_uid(1),'fda70000-0000-4000-8000-000000000001','native-helpful','helpful',null,'2026-10-05');
 again:=public.submit_ai_feedback(pg_temp.safety_uid(1),'fda70000-0000-4000-8000-000000000001','native-helpful','helpful',null,'2026-10-05');
 assert first=again and first->>'hideAnswer'='false';
 assert public.submit_ai_feedback(pg_temp.safety_uid(2),'fda70000-0000-4000-8000-000000000001','foreign','helpful',null,'2026-10-05')->>'status'='request_not_owned';
 perform pg_temp.safety_failure(format('select public.submit_ai_feedback(%L,%L,%L,%L,%L::jsonb,%L)',pg_temp.safety_uid(1),'fda70000-0000-4000-8000-000000000001','native-report','report','{"kind":"answer","text":"회원 제출 증거"}','2026-10-05'),'PT503');
end;$$;
reset role;
-- 만료 파기 후 새 키로 재생성할 수 없고 bounded 정리 횟수가 실제 삭제와 일치한다.
savepoint helpful_expiry;
update private.ai_feedback_receipts set accepted_at=clock_timestamp()-interval'91 days'where user_id=pg_temp.safety_uid(1)and action='helpful';
update private.ai_result_receipts set available_at=clock_timestamp()-interval'91 days'where user_id=pg_temp.safety_uid(1);
set local role service_role;
do $$begin
 assert (public.purge_expired_ai_feedback(100)->>'deletedCount')::integer=1;
 perform pg_temp.safety_failure(format('select public.submit_ai_feedback(%L,%L,%L,%L,null,%L)',pg_temp.safety_uid(1),'fda70000-0000-4000-8000-000000000001','after-expiry','helpful','2026-10-05'),'PT404');
end;$$;
do $$begin perform pg_temp.safety_failure(format('select public.submit_ai_feedback(%L,%L,%L,%L,%L::jsonb,%L)',pg_temp.safety_uid(1),'fda70000-0000-4000-8000-000000000001','late-report','report','{"kind":"answer","text":"회원 제출 증거"}','2026-10-05'),'PT503');end;$$;
reset role;
do $$begin assert not exists(select 1 from private.ai_feedback_receipts where user_id=pg_temp.safety_uid(1));assert exists(select 1 from private.ai_result_receipts where user_id=pg_temp.safety_uid(1));end;$$;
rollback to savepoint helpful_expiry;
-- 격리 outer TX에서만 준비 권한을 열고 끝에 전체 rollback한다. 외부 삭제 호출 없음.
grant execute on function public.claim_member_cleanup_task(uuid),public.check_member_cleanup_task(uuid,uuid,uuid,uuid),public.get_member_cleanup_delete_ack(uuid,uuid,uuid,uuid),public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text),public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)to service_role;
update private.member_cleanup_guard set external_deletion_approved=true;
-- 탈퇴 처리의 실제 RPC가 helpful만 삭제하고 신고 보관과는 분리되는지 확인한다.
set local role authenticated;
select pg_temp.safety_actor(1);
select public.retire_my_account('fda80000-0000-4000-8000-000000000001');
reset role;
do $$begin
 assert not exists(select 1 from private.ai_feedback_receipts where user_id=pg_temp.safety_uid(1)and action='helpful');
 assert not exists(select 1 from private.ai_result_receipts where user_id=pg_temp.safety_uid(1));
 assert not has_function_privilege('authenticated','public.submit_ai_feedback(uuid,uuid,text,text,jsonb,text)','execute');
 assert not has_function_privilege('anon','public.record_ai_chat_result_available(uuid,uuid,uuid)','execute');
 assert not(select enabled from private.ai_report_handling_control where singleton);
end;$$;
