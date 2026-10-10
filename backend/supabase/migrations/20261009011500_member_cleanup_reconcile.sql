-- SQL115: tracked UNKNOWN의 GET-only 복구. 원 dispatch/ACK와 독립 복구 출처를 보존한다.
-- DELETE/dispatch/ACK를 전송·생성하지 않는다. 원 invocation token/lease effect를 바꾸지 않는다.
begin;
create table private.member_cleanup_reconciliations(
 recovery_request_id uuid primary key,invocation_request_id uuid not null references private.worker_invocations(request_id),
 task_id uuid not null references private.member_cleanup_tasks(id),job_id uuid not null references private.worker_jobs(id),
 withdrawal_id uuid not null,profile_id uuid not null,kind text not null check(kind in('storage_object','auth_user')),object_id uuid,
 original_global_token uuid not null,original_job_lease_token uuid not null,dispatch_id uuid not null,ack_receipt_id uuid not null,
 ack_sha256 text not null check(ack_sha256~'^[a-f0-9]{64}$'),target_sha256 text not null check(target_sha256~'^[a-f0-9]{64}$'),
 input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),recovery_global_token uuid not null,recovery_lease_token uuid not null,
 recovery_expires_at timestamptz not null,state text not null default 'prepared'check(state in('prepared','completed','superseded')),
 evidence_sha256 text check(evidence_sha256~'^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp(),closed_at timestamptz,
 check(task_id=job_id),check((kind='auth_user'and object_id is null)or(kind='storage_object'and object_id is not null)),
 check((state='completed')=(evidence_sha256 is not null)),check((state='prepared')=(closed_at is null)));
create unique index member_cleanup_one_reconciliation on private.member_cleanup_reconciliations(invocation_request_id,task_id)where state='prepared';

create function private.assert_member_cleanup_reconcile()returns void language plpgsql volatile security definer set search_path=''as $$begin
 perform private.assert_worker_invocation();perform private.assert_worker_runtime_atomic();
 if(select external_deletion_approved from private.member_cleanup_guard where singleton)is distinct from true then raise exception 'member_cleanup_not_approved'using errcode='55000';end if;
end;$$;
create function private.member_cleanup_target_hash(t private.member_cleanup_tasks)returns text language sql stable set search_path=''as $$
 select encode(extensions.digest(jsonb_build_array(t.id,t.withdrawal_id,t.profile_id,t.kind,t.object_id,t.bucket_id,t.object_name)::text,'sha256'),'hex')
$$;
create function private.member_cleanup_reconcile_json(r private.member_cleanup_reconciliations)returns jsonb language sql stable set search_path=''as $$
 select jsonb_build_object('recoveryRequestId',r.recovery_request_id,'invocationRequestId',r.invocation_request_id,'taskId',r.task_id,'state',r.state,
  'original',jsonb_build_object('withdrawalId',r.withdrawal_id,'objectId',r.object_id,'dispatchId',r.dispatch_id,'globalToken',r.original_global_token,'jobLeaseToken',r.original_job_lease_token,'ackReceiptId',r.ack_receipt_id,'ackSha256',r.ack_sha256),
  'recovery',jsonb_build_object('globalToken',r.recovery_global_token,'leaseToken',r.recovery_lease_token,'expiresAt',r.recovery_expires_at),
  'evidenceSha256',r.evidence_sha256,'closedAt',r.closed_at)
$$;
-- 원 dispatch/ACK와 target 결합을 매번 DB에서 다시 확인한다.
create function private.assert_member_cleanup_reconcile_origin(r private.member_cleanup_reconciliations)returns void language plpgsql volatile security definer set search_path=''as $$begin
 if not exists(select 1 from private.worker_invocations v join private.worker_invocation_jobs a on a.request_id=v.request_id
  join private.worker_jobs j on j.id=a.job_id join private.member_cleanup_tasks t on t.id=j.id
  join private.member_cleanup_dispatches d on d.task_id=t.id join private.member_cleanup_delete_acks ack on ack.task_id=t.id
  where v.request_id=r.invocation_request_id and v.kind='member_cleanup'and v.global_token=r.original_global_token
   and a.job_id=r.job_id and a.job_lease_token=r.original_job_lease_token and j.kind='member_cleanup'and j.payload=jsonb_build_object('taskId',t.id)
   and t.id=r.task_id and t.withdrawal_id=r.withdrawal_id and t.profile_id=r.profile_id and t.kind=r.kind and t.object_id is not distinct from r.object_id
   and private.member_cleanup_target_hash(t)=r.target_sha256 and d.dispatch_id=r.dispatch_id and d.global_token=r.original_global_token
   and d.lease_token=r.original_job_lease_token and d.object_id is not distinct from r.object_id
   and ack.receipt_id=r.ack_receipt_id and ack.ack_sha256=r.ack_sha256 and ack.recorded_worker_run_token=d.global_token
   and ack.recorded_lease_token=d.lease_token and ack.object_id is not distinct from d.object_id
   and ack.withdrawal_id=t.withdrawal_id and ack.profile_id=t.profile_id and ack.kind=t.kind)then raise exception 'member_recovery_origin_unproven'using errcode='40001';end if;
end;$$;
create function public.get_member_cleanup_reconcile(p_recovery_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare r private.member_cleanup_reconciliations;begin
 perform private.assert_member_cleanup_reconcile();select *into r from private.member_cleanup_reconciliations where recovery_request_id=p_recovery_request_id;
 if not found then raise exception 'not_found'using errcode='PT404';end if;return private.member_cleanup_reconcile_json(r);
end;$$;
create function public.begin_member_cleanup_reconcile(p_recovery_request_id uuid,p_invocation_request_id uuid,p_task_id uuid,p_recovery_global_token uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare r private.member_cleanup_reconciliations;v private.worker_invocations;t private.member_cleanup_tasks;j private.worker_jobs;d private.member_cleanup_dispatches;ack private.member_cleanup_delete_acks;f private.worker_job_run_fences;fp text;outcome jsonb;expiry timestamptz;
begin
 perform private.assert_member_cleanup_reconcile();
 if p_recovery_request_id is null or p_invocation_request_id is null or p_task_id is null or p_recovery_global_token is null then raise exception 'invalid_member_recovery'using errcode='22023';end if;
 fp:=encode(extensions.digest(jsonb_build_array(p_invocation_request_id,p_task_id,p_recovery_global_token)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_recovery_request_id::text,115));
 select *into r from private.member_cleanup_reconciliations where recovery_request_id=p_recovery_request_id;
 if found then
  if r.input_sha256<>fp then raise exception 'request_conflict'using errcode='40001';end if;
  return jsonb_build_object('recoveryRequestId',r.recovery_request_id,'state',r.state,'fresh',false,'task',null);
 end if;
 -- 잠금 순서: global → original invocation → recovery/task → actual job.
 perform private.assert_current_worker_run(p_recovery_global_token);
 select *into v from private.worker_invocations where request_id=p_invocation_request_id for update;
 if not found or v.kind<>'member_cleanup'or v.state<>'unknown'or not v.dispatch_started then raise exception 'member_unknown_required'using errcode='55000';end if;
 select *into t from private.member_cleanup_tasks where id=p_task_id for update;
 if not found or t.state='completed'then raise exception 'state_conflict'using errcode='40001';end if;
 select *into j from private.worker_jobs where id=t.id for update;
 if not found or j.kind<>'member_cleanup'or j.payload is distinct from jsonb_build_object('taskId',t.id)or j.status<>'running'then raise exception 'state_conflict'using errcode='40001';end if;
 select *into d from private.member_cleanup_dispatches where task_id=t.id;
 if not found then raise exception 'dispatch_required'using errcode='40001';end if;
 select *into ack from private.member_cleanup_delete_acks where task_id=t.id;
 if not found or d.global_token is distinct from v.global_token or d.lease_token is distinct from j.lease_token or d.object_id is distinct from t.object_id
  or ack.recorded_worker_run_token is distinct from d.global_token or ack.recorded_lease_token is distinct from d.lease_token
  or ack.withdrawal_id is distinct from t.withdrawal_id or ack.profile_id is distinct from t.profile_id or ack.kind is distinct from t.kind or ack.object_id is distinct from t.object_id
  or not exists(select 1 from private.worker_invocation_jobs where request_id=v.request_id and job_id=j.id and job_lease_token=j.lease_token and settled_status is null and effect is null)then raise exception 'verified_ack_required'using errcode='40001';end if;
 select *into f from private.worker_job_run_fences where job_id=j.id;
 if not found or f.job_lease_token is distinct from j.lease_token or f.worker_run_token is distinct from v.global_token then raise exception 'state_conflict'using errcode='40001';end if;
 if exists(select 1 from private.member_cleanup_reconciliations where invocation_request_id=v.request_id and task_id=t.id and state='prepared'and recovery_expires_at>clock_timestamp())then raise exception 'state_conflict'using errcode='40001';end if;
 outcome:=public.claim_member_cleanup_ack_recovery(t.id,p_recovery_global_token);
 if outcome is null then raise exception 'state_conflict'using errcode='40001';end if;
 select expires_at into strict expiry from private.global_worker_run where singleton;
 expiry:=least((outcome->>'expiresAt')::timestamptz,expiry);
 if expiry<=clock_timestamp()then raise exception 'state_conflict'using errcode='40001';end if;
 update private.member_cleanup_tasks set lease_expires_at=expiry where id=t.id;
 if not exists(select 1 from private.worker_runtime_job_slots where global_token=p_recovery_global_token and job_id=j.id)and(select count(*)from private.worker_runtime_job_slots where global_token=p_recovery_global_token)>=20 then raise exception 'runtime_job_limit'using errcode='40001';end if;
 insert into private.worker_runtime_job_slots(global_token,job_id)values(p_recovery_global_token,j.id)on conflict do nothing;
 update private.member_cleanup_reconciliations set state='superseded',closed_at=clock_timestamp()where invocation_request_id=v.request_id and task_id=t.id and state='prepared';
 insert into private.member_cleanup_reconciliations(recovery_request_id,invocation_request_id,task_id,job_id,withdrawal_id,profile_id,kind,object_id,original_global_token,original_job_lease_token,dispatch_id,ack_receipt_id,ack_sha256,target_sha256,input_sha256,recovery_global_token,recovery_lease_token,recovery_expires_at)
 values(p_recovery_request_id,v.request_id,t.id,j.id,t.withdrawal_id,t.profile_id,t.kind,t.object_id,v.global_token,j.lease_token,d.dispatch_id,ack.receipt_id,ack.ack_sha256,private.member_cleanup_target_hash(t),fp,p_recovery_global_token,(outcome->>'leaseToken')::uuid,expiry)returning *into r;
 perform private.assert_member_cleanup_reconcile_origin(r);perform private.assert_member_cleanup_reconcile();perform private.assert_current_worker_run(p_recovery_global_token);
 if r.recovery_expires_at<=clock_timestamp()then raise exception 'member_recovery_not_current'using errcode='55000';end if;
 return jsonb_build_object('recoveryRequestId',r.recovery_request_id,'state',r.state,'fresh',true,'task',outcome||jsonb_build_object('expiresAt',expiry));
end;$$;
create function public.finish_member_cleanup_reconcile(p_recovery_request_id uuid,p_evidence_sha256 text)returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare r private.member_cleanup_reconciliations;v private.worker_invocations;t private.member_cleanup_tasks;j private.worker_jobs;outcome jsonb;
begin
 perform private.assert_member_cleanup_reconcile();
 if p_recovery_request_id is null or p_evidence_sha256 is null or p_evidence_sha256!~'^[a-f0-9]{64}$'then raise exception 'invalid_member_recovery'using errcode='22023';end if;
 select *into r from private.member_cleanup_reconciliations where recovery_request_id=p_recovery_request_id;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 if r.state='completed'then
  if r.evidence_sha256<>p_evidence_sha256 then raise exception 'state_conflict'using errcode='40001';end if;return private.member_cleanup_reconcile_json(r);
 end if;
 perform private.assert_current_worker_run(r.recovery_global_token);
 select *into v from private.worker_invocations where request_id=r.invocation_request_id for update;
 select *into r from private.member_cleanup_reconciliations where recovery_request_id=p_recovery_request_id for update;
 if v.kind<>'member_cleanup'or v.state<>'unknown'or r.state<>'prepared'or r.recovery_expires_at<=clock_timestamp()then raise exception 'member_recovery_not_current'using errcode='55000';end if;
 select *into t from private.member_cleanup_tasks where id=r.task_id for update;
 select *into j from private.worker_jobs where id=r.job_id for update;
 perform private.assert_member_cleanup_reconcile_origin(r);
 if t.state<>'running'or t.worker_run_token is distinct from r.recovery_global_token or t.lease_token is distinct from r.recovery_lease_token or t.lease_expires_at is distinct from r.recovery_expires_at
  or j.status<>'running'or j.lease_token is distinct from r.original_job_lease_token
  or not exists(select 1 from private.worker_job_run_fences where job_id=j.id and job_lease_token=r.original_job_lease_token and worker_run_token=r.original_global_token)then raise exception 'state_conflict'using errcode='40001';end if;
 -- 기존108 GET-only adapter가 실제 외부404를 확인한 뒤 호출한다. SQL은 기존ACK/metadata/Auth 부재 검사를 사용한다.
 outcome:=public.complete_member_cleanup_task_sql109(r.task_id,r.recovery_lease_token,r.recovery_global_token,r.object_id,p_evidence_sha256);
 if outcome is distinct from '{"status":"applied"}'::jsonb then raise exception 'member_recovery_unproven'using errcode='55000';end if;
 perform private.assert_member_cleanup_reconcile_origin(r);perform private.assert_current_worker_run(r.recovery_global_token);
 if r.recovery_expires_at<=clock_timestamp()then raise exception 'member_recovery_not_current'using errcode='55000';end if;
 -- 원 lease effect는 쓰지 않는다. 실제 job terminal 갱신을109trigger가 settlement로 기록한다.
 update private.worker_jobs set status='succeeded',worker_id=null,lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),updated_at=clock_timestamp()where id=r.job_id;
 delete from private.worker_job_run_fences where job_id=r.job_id and job_lease_token=r.original_job_lease_token and worker_run_token=r.original_global_token;
 update private.member_cleanup_reconciliations set state='completed',evidence_sha256=p_evidence_sha256,closed_at=clock_timestamp()where recovery_request_id=r.recovery_request_id returning *into r;
 perform private.assert_member_cleanup_reconcile();perform private.assert_current_worker_run(r.recovery_global_token);
 if r.recovery_expires_at<=clock_timestamp()then raise exception 'member_recovery_not_current'using errcode='55000';end if;
 return private.member_cleanup_reconcile_json(r);
end;$$;

alter function public.complete_queue_invocation(uuid)rename to complete_queue_invocation_before_member_reconcile;
create function public.complete_queue_invocation(p_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare v private.worker_invocations;counts jsonb;begin
 perform private.assert_worker_invocation();select *into v from private.worker_invocations where request_id=p_request_id for update;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 if v.kind<>'member_cleanup'or v.state<>'unknown'then return public.complete_queue_invocation_before_member_reconcile(p_request_id);end if;
 if not v.dispatch_started or v.claim_calls=0 or exists(select 1 from private.worker_invocation_jobs where request_id=v.request_id and settled_status is null)then raise exception 'invocation_unproven'using errcode='55000';end if;
 -- UNKNOWN은 새 claim을 허용하지 않는다. 중단된 실행에서 이미 claim한 모든 job의 terminal DB 증거로만 닫는다.
 if exists(select 1 from(select distinct on(job_id)*from private.worker_invocation_jobs where request_id=v.request_id order by job_id,claim_seq desc)a
  where a.settled_status is distinct from 'succeeded'or not exists(select 1 from private.worker_jobs j join private.member_cleanup_tasks t on t.id=j.id
   join private.member_cleanup_dispatches d on d.task_id=t.id join private.member_cleanup_delete_acks ack on ack.task_id=t.id
   where j.id=a.job_id and j.kind='member_cleanup'and j.payload=jsonb_build_object('taskId',t.id)and j.status='succeeded'and t.state='completed'
    and d.global_token=v.global_token and d.lease_token=a.job_lease_token and d.object_id is not distinct from t.object_id
    and ack.recorded_worker_run_token=d.global_token and ack.recorded_lease_token=d.lease_token and ack.object_id is not distinct from d.object_id
    and ack.withdrawal_id=t.withdrawal_id and ack.profile_id=t.profile_id and ack.kind=t.kind
    and(a.effect='member_cleanup_completed'or exists(select 1 from private.member_cleanup_reconciliations r
     where r.invocation_request_id=v.request_id and r.task_id=t.id and r.job_id=j.id and r.state='completed'
      and r.original_global_token=v.global_token and r.original_job_lease_token=a.job_lease_token and r.dispatch_id=d.dispatch_id
      and r.ack_receipt_id=ack.receipt_id and r.ack_sha256=ack.ack_sha256 and r.withdrawal_id=t.withdrawal_id and r.profile_id=t.profile_id
      and r.kind=t.kind and r.object_id is not distinct from t.object_id and r.target_sha256=private.member_cleanup_target_hash(t)
      and r.evidence_sha256=t.evidence_sha256))))then raise exception 'member_recovery_unproven'using errcode='55000';end if;
 select jsonb_build_object('claimed',count(*),'succeeded',count(*)filter(where settled_status='succeeded'),'retried',count(*)filter(where settled_status='retry_wait'),'failed',count(*)filter(where settled_status='failed'),'superseded',count(*)filter(where settled_status='superseded'),'yielded',count(*)filter(where settled_status='queued'))into counts from(select distinct on(job_id)job_id,settled_status from private.worker_invocation_jobs where request_id=v.request_id order by job_id,claim_seq desc)latest;
 update private.worker_invocations set state='completed',closed_at=clock_timestamp(),result=jsonb_build_object('status','ran','counts',counts)where request_id=v.request_id returning *into v;
 return private.worker_invocation_json(v);
end;$$;
do $$declare own text;f record;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 execute format('alter table private.member_cleanup_reconciliations owner to %I',own);
 alter table private.member_cleanup_reconciliations enable row level security;
 revoke all on private.member_cleanup_reconciliations from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
 for f in select oid::regprocedure sig from pg_proc where proname in('assert_member_cleanup_reconcile','member_cleanup_target_hash','member_cleanup_reconcile_json','assert_member_cleanup_reconcile_origin','get_member_cleanup_reconcile','begin_member_cleanup_reconcile','finish_member_cleanup_reconcile','complete_queue_invocation','complete_queue_invocation_before_member_reconcile')and pronamespace in('public'::regnamespace,'private'::regnamespace)loop
  execute format('alter function %s owner to %I',f.sig,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.sig);end loop;
end;$$;
-- 신규EXEC와 기존guard는 기본 닫힘을 유지한다. 상세/minimum TTL을 만들지 않는다.
commit;
