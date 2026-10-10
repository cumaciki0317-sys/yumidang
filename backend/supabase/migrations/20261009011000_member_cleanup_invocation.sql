-- SQL110: 회원 삭제 task를 실제 worker job/fence/unique slot20 및 SQL109 감사와 연결한다.
-- 기존 dispatch/ACK 원본 binding과 미확정 재전송 금지는 보존한다. Storage DELETE는 수행하지 않는다.
begin;
do $$declare old_kind text;old_payload text;old_effect text;begin
 select pg_get_expr(conbin,conrelid)into strict old_kind from pg_constraint where conrelid='private.worker_jobs'::regclass and conname='worker_jobs_kind_check';
 select pg_get_expr(conbin,conrelid)into strict old_payload from pg_constraint where conrelid='private.worker_jobs'::regclass and conname='worker_jobs_payload_check';
 alter table private.worker_jobs drop constraint worker_jobs_kind_check;
 execute format('alter table private.worker_jobs add constraint worker_jobs_kind_check check((%s)or kind=''member_cleanup'')',old_kind);
 alter table private.worker_jobs drop constraint worker_jobs_payload_check;
 execute format('alter table private.worker_jobs add constraint worker_jobs_payload_check check(case when kind=''member_cleanup''then coalesce(jsonb_typeof(payload)=''object''and payload ? ''taskId''and payload-array[''taskId'']=''{}''::jsonb and jsonb_typeof(payload->''taskId'')=''string''and(payload->>''taskId'')~''^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$''and id::text=(payload->>''taskId''),false)else(%s)end)',old_payload);
 select pg_get_expr(conbin,conrelid)into strict old_kind from pg_constraint where conrelid='private.worker_invocations'::regclass and conname='worker_invocations_kind_check';
 alter table private.worker_invocations drop constraint worker_invocations_kind_check;
 execute format('alter table private.worker_invocations add constraint worker_invocations_kind_check check((%s)or kind=''member_cleanup'')',old_kind);
 select pg_get_expr(conbin,conrelid)into strict old_effect from pg_constraint where conrelid='private.worker_invocation_jobs'::regclass and conname='worker_invocation_jobs_effect_check';
 alter table private.worker_invocation_jobs drop constraint worker_invocation_jobs_effect_check;
 execute format('alter table private.worker_invocation_jobs add constraint worker_invocation_jobs_effect_check check((%s)or effect=''member_cleanup_completed'')',old_effect);
end;$$;
-- 기존 준비/legacy pending 처리 본문을 보존한다. 회원 배정은 기존 제품 최대10을 올리지 않는다.
do $$declare old text;definition text;anchor text:=$anchor$p_kind not in('review_summary','cancellation_safety','report_retention','helpful_maintenance','terminal_maintenance','runtime_maintenance')$anchor$;begin
 select prosrc,pg_get_functiondef(oid)into strict old,definition from pg_proc where oid='public.prepare_queue_invocation(uuid,uuid,text,integer,integer)'::regprocedure;
 if(length(old)-length(replace(old,anchor,'')))/length(anchor)<>1 or(length(old)-length(replace(old,' fp:=encode(','')))/length(' fp:=encode(')<>1 then raise exception 'member_invocation_prepare_baseline_changed'using errcode='55000';end if;
 definition:=replace(definition,old,replace(old,anchor,$anchor$p_kind not in('review_summary','cancellation_safety','report_retention','helpful_maintenance','terminal_maintenance','runtime_maintenance','member_cleanup')$anchor$));
 execute replace(definition,' fp:=encode(',$patch$ if p_kind='member_cleanup'and p_limit>10 then raise exception 'member_batch_limit'using errcode='22023';end if;$patch$||chr(10)||' fp:=encode(');
end;$$;

create function private.assert_member_cleanup_invocation(p_task_id uuid,p_lease_token uuid,p_global_token uuid)returns void language plpgsql volatile security definer set search_path=''as $$declare j private.worker_jobs;begin
 select *into j from private.worker_jobs where id=p_task_id;
 if not found then
  -- SQL108 수동 ACK 복구 등 기존 lane은 기본 닫힘 상태에서 기존 검증을 사용한다.
  if(select enabled from private.worker_invocation_control where singleton)is distinct from true then return;end if;
  raise exception 'member_invocation_required'using errcode='55000';
 end if;
 if j.kind<>'member_cleanup'or j.payload is distinct from jsonb_build_object('taskId',p_task_id)then raise exception 'state_conflict'using errcode='40001';end if;
 perform private.assert_invocation_job_dispatch(p_task_id,p_lease_token,p_global_token);
 perform private.assert_current_worker_job(p_task_id,p_lease_token,p_global_token);
end;$$;
alter function public.claim_member_cleanup_task(uuid)rename to claim_member_cleanup_task_sql109;
create function public.claim_member_cleanup_task(p_worker_run_token uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare r private.worker_invocations;outcome jsonb;t private.member_cleanup_tasks;j private.worker_jobs;expiry timestamptz;old_fence private.worker_job_run_fences;
begin
 if(select enabled from private.worker_invocation_control where singleton)is distinct from true then return public.claim_member_cleanup_task_sql109(p_worker_run_token);end if;
 perform private.assert_worker_invocation();perform private.assert_worker_runtime_atomic();perform private.assert_current_worker_run(p_worker_run_token);
 select *into r from private.worker_invocations where global_token=p_worker_run_token and state in('prepared','unknown')for update;
 if not found or r.kind<>'member_cleanup'or r.state<>'prepared'or not r.dispatch_started or r.item_limit>10 or r.claim_calls>=r.item_limit or r.deadline<=clock_timestamp()then raise exception 'invocation_not_dispatchable'using errcode='55000';end if;
 outcome:=public.claim_member_cleanup_task_sql109(p_worker_run_token);
 if outcome is null then
  perform private.assert_current_worker_run(p_worker_run_token);if r.deadline<=clock_timestamp()then raise exception 'invocation_expired'using errcode='55000';end if;
  update private.worker_invocations set claim_calls=claim_calls+1,idle_seen=true where request_id=r.request_id;return null;
 end if;
 select *into strict t from private.member_cleanup_tasks where id=(outcome->>'taskId')::uuid for update;
 if exists(select 1 from private.member_cleanup_dispatches where task_id=t.id)then raise exception 'member_dispatch_not_replayable'using errcode='55000';end if;
 select expires_at into strict expiry from private.global_worker_run where singleton;
 expiry:=least(t.lease_expires_at,expiry,r.deadline);
 if expiry<=clock_timestamp()then raise exception 'invocation_expired'using errcode='55000';end if;
 update private.member_cleanup_tasks set lease_expires_at=expiry where id=t.id;
 insert into private.worker_jobs(id,kind,dedupe_key,payload,available_at)values(t.id,'member_cleanup','member_cleanup:'||t.id::text,jsonb_build_object('taskId',t.id),clock_timestamp())on conflict(id)do nothing;
 select *into strict j from private.worker_jobs where id=t.id for update;
 if j.kind<>'member_cleanup'or j.payload is distinct from jsonb_build_object('taskId',t.id)or j.dedupe_key<>'member_cleanup:'||t.id::text or j.status in('succeeded','failed')then raise exception 'state_conflict'using errcode='40001';end if;
 if j.status='running'then
  -- 만료되었고 DELETE intent가 없는 이전 attempt만 DB에서 superseded 처리한다.
  select *into old_fence from private.worker_job_run_fences where job_id=j.id;
  if j.lease_expires_at>clock_timestamp()or old_fence.worker_run_token is distinct from p_worker_run_token or old_fence.job_lease_token is distinct from j.lease_token or not exists(select 1 from private.worker_invocation_jobs where request_id=r.request_id and job_id=j.id and job_lease_token=j.lease_token and settled_status is null)then raise exception 'state_conflict'using errcode='40001';end if;
  update private.worker_jobs set status='superseded',worker_id=null,lease_token=null,lease_expires_at=null,completed_at=clock_timestamp(),updated_at=clock_timestamp()where id=j.id;
  delete from private.worker_job_run_fences where job_id=j.id;
 end if;
 if not exists(select 1 from private.worker_runtime_job_slots where global_token=p_worker_run_token and job_id=j.id)and(select count(*)from private.worker_runtime_job_slots where global_token=p_worker_run_token)>=20 then raise exception 'runtime_job_limit'using errcode='40001';end if;
 update private.worker_jobs set status='running',worker_id=p_worker_run_token,lease_token=t.lease_token,lease_expires_at=expiry,completed_at=null,attempt=attempt+1,updated_at=clock_timestamp()where id=j.id;
 insert into private.worker_job_run_fences(job_id,job_lease_token,worker_run_token)values(j.id,t.lease_token,p_worker_run_token)on conflict(job_id)do update set job_lease_token=excluded.job_lease_token,worker_run_token=excluded.worker_run_token;
 insert into private.worker_runtime_job_slots(global_token,job_id)values(p_worker_run_token,j.id)on conflict do nothing;
 insert into private.worker_invocation_jobs(request_id,job_id,job_lease_token,claim_seq)values(r.request_id,j.id,t.lease_token,r.claim_calls+1);
 update private.worker_invocations set claim_calls=claim_calls+1 where request_id=r.request_id;
 perform private.assert_member_cleanup_invocation(t.id,t.lease_token,p_worker_run_token);
 return outcome||jsonb_build_object('expiresAt',expiry);
end;$$;

alter function public.begin_member_cleanup_delete(uuid,uuid,uuid,uuid)rename to begin_member_cleanup_delete_sql109;
create function public.begin_member_cleanup_delete(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare outcome jsonb;begin
 perform private.assert_member_cleanup_invocation(p_task_id,p_lease_token,p_worker_run_token);
 outcome:=public.begin_member_cleanup_delete_sql109(p_task_id,p_lease_token,p_worker_run_token,p_object_id);
 perform private.assert_member_cleanup_invocation(p_task_id,p_lease_token,p_worker_run_token);return outcome;
end;$$;
alter function public.record_member_cleanup_delete_ack(uuid,uuid,uuid,uuid,text)rename to record_member_cleanup_delete_ack_sql109;
create function public.record_member_cleanup_delete_ack(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid,p_ack_sha256 text)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare outcome jsonb;begin
 perform private.assert_member_cleanup_invocation(p_task_id,p_lease_token,p_worker_run_token);
 if exists(select 1 from private.worker_jobs where id=p_task_id and kind='member_cleanup')and not exists(select 1 from private.member_cleanup_dispatches where task_id=p_task_id and lease_token=p_lease_token and global_token=p_worker_run_token and object_id is not distinct from p_object_id)then raise exception 'member_ack_dispatch_binding'using errcode='40001';end if;
 outcome:=public.record_member_cleanup_delete_ack_sql109(p_task_id,p_lease_token,p_worker_run_token,p_object_id,p_ack_sha256);
 perform private.assert_member_cleanup_invocation(p_task_id,p_lease_token,p_worker_run_token);return outcome;
end;$$;
alter function public.complete_member_cleanup_task(uuid,uuid,uuid,uuid,text)rename to complete_member_cleanup_task_sql109;
create function public.complete_member_cleanup_task(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid,p_evidence_sha256 text)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare outcome jsonb;bound boolean;begin
 bound:=exists(select 1 from private.worker_jobs where id=p_task_id and kind='member_cleanup');
 perform private.assert_member_cleanup_invocation(p_task_id,p_lease_token,p_worker_run_token);
 if bound and not exists(select 1 from private.member_cleanup_dispatches d join private.member_cleanup_delete_acks a on a.task_id=d.task_id join private.member_cleanup_tasks t on t.id=d.task_id where t.id=p_task_id and d.lease_token=p_lease_token and d.global_token=p_worker_run_token and d.object_id is not distinct from p_object_id and a.recorded_lease_token=d.lease_token and a.recorded_worker_run_token=d.global_token and a.object_id is not distinct from d.object_id and a.kind=t.kind and a.profile_id=t.profile_id and a.withdrawal_id=t.withdrawal_id)then raise exception 'member_ack_dispatch_binding'using errcode='40001';end if;
 outcome:=public.complete_member_cleanup_task_sql109(p_task_id,p_lease_token,p_worker_run_token,p_object_id,p_evidence_sha256);
 if bound then
  perform private.assert_member_cleanup_invocation(p_task_id,p_lease_token,p_worker_run_token);
  update private.worker_invocation_jobs a set effect='member_cleanup_completed'from private.worker_invocations r where a.request_id=r.request_id and a.job_id=p_task_id and a.job_lease_token=p_lease_token and r.global_token=p_worker_run_token;
  perform public.complete_job(p_task_id,p_lease_token,p_worker_run_token);
  perform private.assert_current_worker_run(p_worker_run_token);
 end if;return outcome;
end;$$;

-- 기존6종의 완료 본문은 그대로 위임한다. 회원 성공은 실제 task+원본 dispatch/ACK+job settlement가 모두 필요하다.
alter function public.complete_queue_invocation(uuid)rename to complete_queue_invocation_sql109;
create function public.complete_queue_invocation(p_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare r private.worker_invocations;counts jsonb;begin
 perform private.assert_worker_invocation();select *into r from private.worker_invocations where request_id=p_request_id for update;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 if r.kind<>'member_cleanup'then return public.complete_queue_invocation_sql109(p_request_id);end if;
 if r.state='completed'then return private.worker_invocation_json(r);end if;
 if not r.dispatch_started or r.claim_calls=0 or(r.claim_calls<r.item_limit and not r.idle_seen)or exists(select 1 from private.worker_invocation_jobs where request_id=r.request_id and settled_status is null)then raise exception 'invocation_unproven'using errcode='55000';end if;
 if exists(select 1 from private.worker_invocation_jobs a where a.request_id=r.request_id and a.settled_status='succeeded'and not coalesce((a.effect='member_cleanup_completed'and exists(select 1 from private.worker_jobs j join private.member_cleanup_tasks t on t.id=j.id join private.member_cleanup_dispatches d on d.task_id=t.id join private.member_cleanup_delete_acks ack on ack.task_id=t.id where j.id=a.job_id and j.kind='member_cleanup'and j.payload=jsonb_build_object('taskId',t.id)and j.status='succeeded'and t.state='completed'and t.evidence_sha256 is not null and d.global_token=r.global_token and d.lease_token=a.job_lease_token and d.object_id is not distinct from t.object_id and ack.recorded_worker_run_token=d.global_token and ack.recorded_lease_token=d.lease_token and ack.object_id is not distinct from d.object_id and ack.kind=t.kind and ack.profile_id=t.profile_id and ack.withdrawal_id=t.withdrawal_id)),false))then raise exception 'invocation_effect_unproven'using errcode='55000';end if;
 if exists(select 1 from(select distinct on(job_id)settled_status from private.worker_invocation_jobs where request_id=r.request_id order by job_id,claim_seq desc)latest where settled_status is distinct from 'succeeded')then raise exception 'member_task_unfinished'using errcode='55000';end if;
 select jsonb_build_object('claimed',count(*),'succeeded',count(*)filter(where settled_status='succeeded'),'retried',count(*)filter(where settled_status='retry_wait'),'failed',count(*)filter(where settled_status='failed'),'superseded',count(*)filter(where settled_status='superseded'),'yielded',count(*)filter(where settled_status='queued'))into counts from(select distinct on(job_id)job_id,settled_status from private.worker_invocation_jobs where request_id=r.request_id order by job_id,claim_seq desc)latest;
 update private.worker_invocations set state='completed',closed_at=clock_timestamp(),result=jsonb_build_object('status','ran','counts',counts)where request_id=r.request_id returning *into r;
 return private.worker_invocation_json(r);
end;$$;
do $$declare own text;f record;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 for f in select oid::regprocedure sig from pg_proc where proname in('assert_member_cleanup_invocation','claim_member_cleanup_task','claim_member_cleanup_task_sql109','begin_member_cleanup_delete','begin_member_cleanup_delete_sql109','record_member_cleanup_delete_ack','record_member_cleanup_delete_ack_sql109','complete_member_cleanup_task','complete_member_cleanup_task_sql109','complete_queue_invocation','complete_queue_invocation_sql109')and pronamespace in('public'::regnamespace,'private'::regnamespace)loop
  execute format('alter function %s owner to %I',f.sig,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.sig);end loop;
end;$$;
-- 109/cleanup gates와 모든 새 EXEC는 기본 닫힘을 유지한다.
commit;
