-- SQL108: 회원 삭제 ACK의 읽기 기반 복구. 미확인 전송 재삭제·ACK 재전송 금지.
begin;
create function public.read_member_cleanup_recovery(p_after_id uuid default null,p_limit integer default 20)
returns jsonb language plpgsql volatile security definer set search_path=''as $$begin
 perform private.assert_worker_runtime_atomic();
 if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'invalid_recovery_limit'using errcode='22023';end if;
 return coalesce((select jsonb_agg(x.body order by x.id)from(
  select t.id,jsonb_build_object('taskId',t.id,'dispatchId',d.dispatch_id,'kind',t.kind,'state',t.state,
   'hasVerifiedAck',exists(select 1 from private.member_cleanup_delete_acks a where a.task_id=t.id
    and a.withdrawal_id=t.withdrawal_id and a.profile_id=t.profile_id and a.kind=t.kind
    and a.object_id is not distinct from t.object_id and d.object_id is not distinct from t.object_id and a.recorded_lease_token=d.lease_token and a.recorded_worker_run_token=d.global_token))body
  from private.member_cleanup_dispatches d join private.member_cleanup_tasks t on t.id=d.task_id
  where t.state<>'completed'and(p_after_id is null or t.id>p_after_id)order by t.id limit p_limit
 )x),'[]'::jsonb);
end;$$;
create function public.claim_member_cleanup_ack_recovery(p_task_id uuid,p_worker_run_token uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare t private.member_cleanup_tasks;d private.member_cleanup_dispatches;a private.member_cleanup_delete_acks;tok uuid:=gen_random_uuid();n timestamptz;begin
 perform private.assert_worker_runtime_atomic();
 if p_task_id is null then raise exception 'invalid_task'using errcode='22023';end if;
 if not coalesce((select external_deletion_approved from private.member_cleanup_guard where singleton),false)then raise exception 'member_cleanup_not_approved'using errcode='55000';end if;
 perform private.assert_current_worker_run(p_worker_run_token);n:=clock_timestamp();
 select *into t from private.member_cleanup_tasks where id=p_task_id for update skip locked;
 if not found then return null;end if;
 if t.state='completed'then return null;end if;
 if t.state='running'and t.lease_expires_at>n then raise exception 'state_conflict'using errcode='40001';end if;
 select *into d from private.member_cleanup_dispatches where task_id=t.id;
 if not found then raise exception 'dispatch_required'using errcode='40001';end if;
 select *into a from private.member_cleanup_delete_acks where task_id=t.id;
 if not found or a.withdrawal_id is distinct from t.withdrawal_id or a.profile_id is distinct from t.profile_id
  or a.kind is distinct from t.kind or a.object_id is distinct from t.object_id or d.object_id is distinct from t.object_id
  or a.recorded_lease_token is distinct from d.lease_token or a.recorded_worker_run_token is distinct from d.global_token then
  raise exception 'verified_ack_required'using errcode='40001';end if;
 -- 기존 ACK를 변경하지 않고 새 점유로 GET-only 확인한다.
 update private.member_cleanup_tasks set state='running',lease_token=tok,worker_run_token=p_worker_run_token,
  lease_expires_at=n+interval'60 seconds'where id=t.id;
 return public.check_member_cleanup_task(t.id,tok,p_worker_run_token,t.object_id);
end;$$;
create or replace function public.read_worker_runtime_pending_v2()returns jsonb language plpgsql volatile security definer set search_path=''as $$begin
 perform private.assert_worker_runtime_atomic();
 return jsonb_build_object('hasPending',exists(select 1 from private.worker_runtime_results where state='external_pending')
  or exists(select 1 from private.worker_runtime_intents where state in('prepared','unknown','observed_response'))
  or exists(select 1 from private.member_cleanup_dispatches d join private.member_cleanup_tasks t on t.id=d.task_id where t.state<>'completed'));
end;$$;
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.begin_member_cleanup_delete(uuid,uuid,uuid,uuid)'::regprocedure;
 execute format('alter function public.read_member_cleanup_recovery(uuid,integer)owner to %I',own);
 execute format('alter function public.claim_member_cleanup_ack_recovery(uuid,uuid)owner to %I',own);
end;$$;
revoke all on function public.read_member_cleanup_recovery(uuid,integer),public.claim_member_cleanup_ack_recovery(uuid,uuid)from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
-- 신규 EXEC는 기본 닫힘. 검증된 ACK없는 UNKNOWN은 계속 차단한다.
commit;
