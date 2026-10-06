-- 민규: appointment_cancel_resolution_and_due.sql의 fixture 본문 다음 같은 TX에서 실행한다.
-- 기한 fixture를 조정하며 실제 24시간 경과·직원 HTTP·운영 검증은 아니다.
begin;
set local plpgsql.check_asserts=on;
do $$declare identity_value uuid;appointment_value uuid;generation_value bigint;due_value timestamptz;
 token_value uuid:=gen_random_uuid();plan jsonb;response jsonb;overflow boolean:=false;begin
 select h.identity_id,h.appointment_id into strict identity_value,appointment_value
 from private.safety_appointment_results h join private.safety_appointment_result_revisions r
 on r.identity_id=h.identity_id and r.appointment_id=h.appointment_id and r.revision=h.current_revision
 where h.source_episode_id=(select id from private.member_episodes where profile_id=pg_temp.resolution_case_uid(4))
 and r.outcome='own_cancel' order by h.appointment_id limit 1;
 update private.safety_appointment_result_revisions set cancellation_at=clock_timestamp()-interval'1 hour',appeal_state='none'
 where identity_id=identity_value and appointment_id=appointment_value and outcome='own_cancel';
 select generation into strict generation_value from private.cancellation_safety_due where identity_id=identity_value;
 update private.cancellation_safety_due set next_due_at=clock_timestamp()-interval'2 hours'where identity_id=identity_value;
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 update private.cancellation_due_control set enabled=true where singleton;
 update private.global_worker_run set token=token_value,expires_at=clock_timestamp()+interval'180 seconds'where singleton;
 insert into private.worker_jobs(kind,dedupe_key,payload,available_at,status,completed_at)
 values('cancellation_safety','cancellation_safety:'||identity_value||':'||generation_value,
 jsonb_build_object('identityId',identity_value,'generation',generation_value),clock_timestamp(),'succeeded',clock_timestamp())
 on conflict(kind,dedupe_key)do update set status='succeeded',completed_at=clock_timestamp();
 plan:=jsonb_build_object('status','held','heldAppointmentId',appointment_value);
 perform private.finish_cancellation_due(identity_value,plan);
 assert(select generation=generation_value+1 and next_due_at>clock_timestamp()from private.cancellation_safety_due where identity_id=identity_value),'new_deadline_new_generation';
 select next_due_at into due_value from private.cancellation_safety_due where identity_id=identity_value;
 perform private.finish_cancellation_due(identity_value,plan);
 assert(select generation=generation_value+1 and next_due_at=due_value from private.cancellation_safety_due where identity_id=identity_value),'same_deadline_idempotent';
 -- 서버 시계 대신 fixture의 새 기한만 지난 시각으로 옮긴다.
 update private.cancellation_safety_due set next_due_at=clock_timestamp()-interval'1 second'where identity_id=identity_value;
 response:=public.enqueue_cancellation_safety_due(20,token_value);
 assert exists(select 1 from private.worker_jobs where kind='cancellation_safety'and payload=jsonb_build_object('identityId',identity_value,'generation',generation_value+1)and status='queued'),'new_due_not_blocked_by_terminal';
 response:=public.enqueue_cancellation_safety_due(20,token_value);
 assert(select count(*)=1 from private.worker_jobs where kind='cancellation_safety'and payload=jsonb_build_object('identityId',identity_value,'generation',generation_value+1));
 assert exists(select 1 from private.worker_jobs where kind='cancellation_safety'and payload=jsonb_build_object('identityId',identity_value,'generation',generation_value)and status='succeeded');
 perform private.finish_cancellation_due(identity_value,'{"status":"applied"}');
 assert(select generation=generation_value+1 and next_due_at is null from private.cancellation_safety_due where identity_id=identity_value),'clearing_due_preserves_generation';
 update private.cancellation_safety_due set generation=9007199254740991 where identity_id=identity_value;
 begin perform private.finish_cancellation_due(identity_value,plan);exception when check_violation then overflow:=true;end;
 assert overflow and(select generation=9007199254740991 and next_due_at is null from private.cancellation_safety_due where identity_id=identity_value),'overflow_atomic_fail_closed';
 raise notice 'NEXT_DUE_GENERATION_AND_TERMINAL_DEDUPE_PASS';
end;$$;
rollback;
