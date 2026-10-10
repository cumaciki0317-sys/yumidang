-- SQL109: 원문 없는 DB 실행 감사. HTTP 응답이나 SQL101 observe는 완료 증거가 아니다.
begin;
create table private.worker_invocation_control(singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into private.worker_invocation_control values(true,false);
create table private.worker_invocations(
 request_id uuid primary key,global_token uuid not null,kind text not null check(kind in('review_summary','cancellation_safety','report_retention','helpful_maintenance','terminal_maintenance','runtime_maintenance')),
 item_limit integer not null check(item_limit between 1 and 20),fingerprint text not null check(fingerprint~'^[a-f0-9]{64}$'),
 state text not null default 'prepared' check(state in('prepared','unknown','completed')),dispatch_started boolean not null default false,claim_calls integer not null default 0,idle_seen boolean not null default false,
 remaining_ms integer not null check(remaining_ms between 1 and 180000),deadline timestamptz not null,created_at timestamptz not null default clock_timestamp(),closed_at timestamptz,result jsonb,
 check((state='completed')=(closed_at is not null and result is not null)));
create unique index worker_invocation_one_active on private.worker_invocations(global_token)where state in('prepared','unknown');
create table private.worker_invocation_jobs(
 request_id uuid not null references private.worker_invocations(request_id),job_id uuid not null,job_lease_token uuid not null,claim_seq integer not null check(claim_seq>0),
 settled_status text check(settled_status in('succeeded','retry_wait','failed','superseded','queued')),
 effect text check(effect in('published','insufficient','cancellation_processed')),primary key(request_id,job_id,job_lease_token),unique(request_id,claim_seq));
create function private.assert_worker_invocation()returns void language plpgsql volatile security definer set search_path=''as $$begin
 if auth.role()is distinct from 'service_role'then raise exception 'worker_access_denied'using errcode='42501';end if;
 if(select enabled from private.worker_invocation_control where singleton)is distinct from true then raise exception 'worker_invocation_not_enabled'using errcode='55000';end if;
end;$$;
create function private.worker_invocation_json(r private.worker_invocations)returns jsonb language sql stable set search_path=''as $$
 select jsonb_build_object('requestId',r.request_id,'globalToken',r.global_token,'kind',r.kind,'limit',r.item_limit,'remainingMs',r.remaining_ms,'state',r.state,'result',r.result,'closedAt',r.closed_at)
$$;
create function public.prepare_queue_invocation(p_request_id uuid,p_global_token uuid,p_kind text,p_limit integer,p_remaining_ms integer)returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare r private.worker_invocations;fp text;expiry timestamptz;
begin
 perform private.assert_worker_invocation();perform private.assert_worker_runtime_atomic();
 if p_request_id is null or p_global_token is null or p_kind is null or p_kind not in('review_summary','cancellation_safety','report_retention','helpful_maintenance','terminal_maintenance','runtime_maintenance')or p_limit is null or p_limit not between 1 and 20 or p_remaining_ms is null or p_remaining_ms not between 1 and 180000 then raise exception 'invalid_invocation'using errcode='22023';end if;
 fp:=encode(extensions.digest(jsonb_build_array(p_global_token,p_kind,p_limit,p_remaining_ms)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,109));
 select *into r from private.worker_invocations where request_id=p_request_id;
 if found then
  if r.fingerprint<>fp then raise exception 'state_conflict'using errcode='40001';end if;
  return jsonb_build_object('requestId',r.request_id,'state',r.state,'fresh',false);
 end if;
 perform private.assert_current_worker_run(p_global_token);
 if exists(select 1 from private.worker_runtime_results where request_id=p_request_id)then raise exception 'request_conflict'using errcode='40001';end if;
 if exists(select 1 from private.worker_runtime_results where state='external_pending')or exists(select 1 from private.worker_runtime_intents where state in('prepared','unknown','observed_response'))or exists(select 1 from private.member_cleanup_dispatches d join private.member_cleanup_tasks t on t.id=d.task_id where t.state<>'completed')or exists(select 1 from private.worker_invocations where state in('prepared','unknown'))then raise exception 'legacy_or_external_pending'using errcode='55000';end if;
 if p_kind in('helpful_maintenance','terminal_maintenance','runtime_maintenance')and coalesce((select sum(item_limit)from private.worker_invocations where global_token=p_global_token and kind=p_kind),0)+p_limit>20 then raise exception 'maintenance_allocation_exceeded'using errcode='55000';end if;
 select expires_at into strict expiry from private.global_worker_run where singleton;
 insert into private.worker_invocations(request_id,global_token,kind,item_limit,fingerprint,remaining_ms,deadline)
 values(p_request_id,p_global_token,p_kind,p_limit,fp,p_remaining_ms,least(expiry,clock_timestamp()+p_remaining_ms*interval '1 millisecond'));
 return jsonb_build_object('requestId',p_request_id,'state','prepared','fresh',true);
end;$$;
-- GET는 허가가 아니다. 최초 실행 진입은 정확한 배정에 대한 한 번의 CAS다.
create function public.claim_queue_invocation_dispatch(p_request_id uuid,p_global_token uuid,p_kind text,p_limit integer,p_remaining_ms integer)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare r private.worker_invocations;begin
 perform private.assert_worker_invocation();select *into r from private.worker_invocations where request_id=p_request_id for update;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 if r.global_token is distinct from p_global_token or r.kind is distinct from p_kind or r.item_limit is distinct from p_limit or r.remaining_ms is distinct from p_remaining_ms then raise exception 'state_conflict'using errcode='40001';end if;
 if r.state<>'prepared'or r.dispatch_started then return jsonb_build_object('claimed',false);end if;
 perform private.assert_current_worker_run(p_global_token);
 if r.deadline<=clock_timestamp()then raise exception 'invocation_expired'using errcode='55000';end if;
 update private.worker_invocations set dispatch_started=true where request_id=p_request_id;
 return jsonb_build_object('claimed',true);
end;$$;
create function public.get_queue_invocation(p_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare r private.worker_invocations;begin
 perform private.assert_worker_invocation();select *into r from private.worker_invocations where request_id=p_request_id;
 if not found then raise exception 'not_found'using errcode='PT404';end if;return private.worker_invocation_json(r);
end;$$;
create function public.mark_queue_invocation_unknown(p_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare r private.worker_invocations;begin
 perform private.assert_worker_invocation();update private.worker_invocations set state='unknown'where request_id=p_request_id and state='prepared';
 select *into r from private.worker_invocations where request_id=p_request_id;if not found then raise exception 'not_found'using errcode='PT404';end if;
 return private.worker_invocation_json(r);
end;$$;

-- 같은 트랜잭션의 실제 claim 결과만 기록한다. job:null도 실행 증거다.
alter function private.claim_supported_worker_job(uuid,integer,uuid,text[])rename to claim_supported_worker_job_sql108;
create function private.claim_supported_worker_job(p_worker_id uuid,p_lease_seconds integer,p_worker_run_token uuid,p_supported_kinds text[])returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare r private.worker_invocations;outcome jsonb;j jsonb;
begin
 if(select enabled from private.worker_invocation_control where singleton)is distinct from true then return private.claim_supported_worker_job_sql108(p_worker_id,p_lease_seconds,p_worker_run_token,p_supported_kinds);end if;
 perform private.assert_worker_runtime_atomic();
 select *into r from private.worker_invocations where global_token=p_worker_run_token and state in('prepared','unknown')for update;
 if not found or r.state<>'prepared'or not r.dispatch_started or r.deadline<=clock_timestamp()or p_supported_kinds is distinct from array[r.kind]then raise exception 'invocation_not_dispatchable'using errcode='55000';end if;
 if r.claim_calls>=r.item_limit then raise exception 'invocation_limit'using errcode='55000';end if;
 outcome:=private.claim_supported_worker_job_sql108(p_worker_id,p_lease_seconds,p_worker_run_token,p_supported_kinds);j:=outcome->'job';
 perform private.assert_current_worker_run(p_worker_run_token);if r.deadline<=clock_timestamp()then raise exception 'invocation_expired'using errcode='55000';end if;
 update private.worker_invocations set claim_calls=claim_calls+1,idle_seen=idle_seen or j='null'::jsonb where request_id=r.request_id;
 if j<>'null'::jsonb then insert into private.worker_invocation_jobs(request_id,job_id,job_lease_token,claim_seq)values(r.request_id,(j->>'jobId')::uuid,(j->>'leaseToken')::uuid,r.claim_calls+1);
  if(select count(distinct job_id)from private.worker_invocation_jobs where request_id=r.request_id)>r.item_limit then raise exception 'invocation_limit'using errcode='55000';end if;end if;
 return outcome;
end;$$;
create function private.audit_worker_invocation_settlement()returns trigger language plpgsql security definer set search_path=''as $$begin
 if old.status='running'and new.status in('succeeded','retry_wait','failed','superseded','queued')then
  update private.worker_invocation_jobs a set settled_status=new.status from private.worker_invocations r,private.worker_job_run_fences f
  where a.request_id=r.request_id and a.job_id=old.id and a.job_lease_token=old.lease_token and a.settled_status is null
   and f.job_id=old.id and f.job_lease_token=old.lease_token and f.worker_run_token=r.global_token;
 end if;return new;
end;$$;
create trigger audit_worker_invocation_settlement after update on private.worker_jobs for each row execute function private.audit_worker_invocation_settlement();

-- 전송 중단 뒤에는 새 효과·settlement를 실행하지 않는다. 이미 저장된 증거 조회는 별개다.
create function private.assert_invocation_job_dispatch(p_job_id uuid,p_job_lease_token uuid,p_global_token uuid)returns void language plpgsql volatile security definer set search_path=''as $$declare r private.worker_invocations;begin
 select i.*into r from private.worker_invocations i join private.worker_invocation_jobs a on a.request_id=i.request_id where a.job_id=p_job_id and a.job_lease_token=p_job_lease_token and i.global_token=p_global_token for update of i;
 if not found then if(select enabled from private.worker_invocation_control where singleton)is distinct from true then return;else raise exception 'invocation_not_dispatchable'using errcode='55000';end if;end if;
 perform private.assert_worker_invocation();
 if r.state<>'prepared'or not r.dispatch_started or r.deadline<=clock_timestamp()then raise exception 'invocation_not_dispatchable'using errcode='55000';end if;
 perform private.assert_current_worker_run(p_global_token);
end;$$;
-- 효과가 성공한 실제 scoped RPC의 최소 표식만 기록한다. 원문/처리 결과 본문은 저장하지 않는다.
alter function public.mark_review_summary_insufficient(uuid,uuid,text,uuid,text)rename to mark_review_summary_insufficient_sql108;
create function public.mark_review_summary_insufficient(p_job_id uuid,p_lease_token uuid,p_source_revision text,p_worker_run_token uuid,p_contract_version text)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare out jsonb;begin
 perform private.assert_invocation_job_dispatch(p_job_id,p_lease_token,p_worker_run_token);
 out:=public.mark_review_summary_insufficient_sql108(p_job_id,p_lease_token,p_source_revision,p_worker_run_token,p_contract_version);
 perform private.assert_invocation_job_dispatch(p_job_id,p_lease_token,p_worker_run_token);
 if out->>'status'='applied'then update private.worker_invocation_jobs a set effect='insufficient'from private.worker_invocations r where a.request_id=r.request_id and a.job_id=p_job_id and a.job_lease_token=p_lease_token and r.global_token=p_worker_run_token and r.kind='review_summary';end if;return out;
end;$$;
alter function public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text,uuid,text)rename to publish_review_summary_for_job_sql108;
create function public.publish_review_summary_for_job(p_job_id uuid,p_lease_token uuid,p_source_revision text,p_evidence_review_ids uuid[],p_summary text,p_model_version text,p_prompt_version text,p_worker_run_token uuid,p_contract_version text)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare out jsonb;begin
 perform private.assert_invocation_job_dispatch(p_job_id,p_lease_token,p_worker_run_token);
 out:=public.publish_review_summary_for_job_sql108(p_job_id,p_lease_token,p_source_revision,p_evidence_review_ids,p_summary,p_model_version,p_prompt_version,p_worker_run_token,p_contract_version);
 perform private.assert_invocation_job_dispatch(p_job_id,p_lease_token,p_worker_run_token);
 if out->>'status'='applied'then update private.worker_invocation_jobs a set effect='published'from private.worker_invocations r where a.request_id=r.request_id and a.job_id=p_job_id and a.job_lease_token=p_lease_token and r.global_token=p_worker_run_token and r.kind='review_summary';end if;return out;
end;$$;
alter function public.process_cancellation_safety_due(uuid,bigint,uuid,uuid,uuid)rename to process_cancellation_safety_due_sql108;
create function public.process_cancellation_safety_due(p_identity_id uuid,p_expected_generation bigint,p_job_id uuid,p_job_lease_token uuid,p_worker_run_token uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare out jsonb;begin
 perform private.assert_invocation_job_dispatch(p_job_id,p_job_lease_token,p_worker_run_token);
 out:=public.process_cancellation_safety_due_sql108(p_identity_id,p_expected_generation,p_job_id,p_job_lease_token,p_worker_run_token);
 perform private.assert_invocation_job_dispatch(p_job_id,p_job_lease_token,p_worker_run_token);
 if out->>'status'in('not_due','policy_pending','held','applied')then update private.worker_invocation_jobs a set effect='cancellation_processed'from private.worker_invocations r where a.request_id=r.request_id and a.job_id=p_job_id and a.job_lease_token=p_job_lease_token and r.global_token=p_worker_run_token and r.kind='cancellation_safety';end if;return out;
end;$$;

-- report terminal maintenance의 실제 SQL102 실행도 같은109 배정에 묶는다.
alter function public.execute_worker_runtime_operation(uuid,uuid,text,jsonb)rename to execute_worker_runtime_operation_sql108;
create function public.execute_worker_runtime_operation(p_request_id uuid,p_global_token uuid,p_operation text,p_input jsonb)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare r private.worker_invocations;outcome jsonb;bound boolean:=false;begin
 if p_operation='terminal_maintenance'then
  select *into r from private.worker_invocations where request_id=p_request_id for update;
  if found then
   if r.global_token is distinct from p_global_token or r.kind<>'terminal_maintenance'or p_input is distinct from jsonb_build_object('limit',r.item_limit)then raise exception 'state_conflict'using errcode='40001';end if;
   if not exists(select 1 from private.worker_runtime_results where request_id=p_request_id)then
    perform private.assert_worker_invocation();perform private.assert_current_worker_run(p_global_token);
    if r.state<>'prepared'or not r.dispatch_started or r.deadline<=clock_timestamp()then raise exception 'invocation_not_dispatchable'using errcode='55000';end if;bound:=true;
   end if;
  end if;
 end if;
 outcome:=public.execute_worker_runtime_operation_sql108(p_request_id,p_global_token,p_operation,p_input);
 if bound then perform private.assert_worker_invocation();perform private.assert_current_worker_run(p_global_token);if r.deadline<=clock_timestamp()then raise exception 'invocation_expired'using errcode='55000';end if;end if;
 return outcome;
end;$$;
-- SQL105의 한도·멱등성은 그대로 사용한다. 109 배정이 있으면 DB 경계에서도 binding/CAS/deadline을 검사한다.
alter function public.purge_ai_feedback_scoped(uuid,uuid,integer)rename to purge_ai_feedback_scoped_sql108;
create function public.purge_ai_feedback_scoped(p_request_id uuid,p_global_token uuid,p_limit integer)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare r private.worker_invocations;outcome jsonb;bound boolean:=false;begin
 select *into r from private.worker_invocations where request_id=p_request_id for update;
 if found then
  if r.global_token is distinct from p_global_token or r.kind<>'helpful_maintenance'or r.item_limit is distinct from p_limit then raise exception 'state_conflict'using errcode='40001';end if;
  -- 저장된 원자 결과는 기존 SQL105가 fingerprint를 검증하여 읽기만 한다.
  if not exists(select 1 from private.worker_runtime_results where request_id=p_request_id)then
   perform private.assert_worker_invocation();perform private.assert_current_worker_run(p_global_token);
   if r.state<>'prepared'or not r.dispatch_started or r.deadline<=clock_timestamp()then raise exception 'invocation_not_dispatchable'using errcode='55000';end if;bound:=true;
  end if;
 end if;
 outcome:=public.purge_ai_feedback_scoped_sql108(p_request_id,p_global_token,p_limit);
 if bound then perform private.assert_worker_invocation();perform private.assert_current_worker_run(p_global_token);if r.deadline<=clock_timestamp()then raise exception 'invocation_expired'using errcode='55000';end if;end if;
 return outcome;
end;$$;
-- runtime details는 report terminal receipts와 별도 provider/배정이다.
create function public.purge_worker_runtime_details_scoped(p_request_id uuid,p_global_token uuid,p_limit integer)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare r private.worker_invocations;old private.worker_runtime_results;outcome jsonb;fp text;begin
 perform private.assert_worker_invocation();perform private.assert_worker_runtime_atomic();
 if p_request_id is null or p_global_token is null or p_limit is null or p_limit not between 1 and 20 then raise exception 'invalid_invocation'using errcode='22023';end if;
 fp:=encode(extensions.digest(jsonb_build_array(p_global_token,'runtime_maintenance',jsonb_build_object('limit',p_limit))::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,102));
 select *into old from private.worker_runtime_results where request_id=p_request_id;
 if found then if old.fingerprint<>fp or old.state<>'completed'then raise exception 'request_conflict'using errcode='40001';end if;return old.result;end if;
 select *into r from private.worker_invocations where request_id=p_request_id for update;
 if not found or r.global_token is distinct from p_global_token or r.kind<>'runtime_maintenance'or r.item_limit is distinct from p_limit or r.state<>'prepared'or not r.dispatch_started or r.deadline<=clock_timestamp()then raise exception 'invocation_not_dispatchable'using errcode='55000';end if;
 outcome:=public.purge_worker_runtime_details(p_global_token,p_limit);
 perform private.assert_worker_invocation();perform private.assert_current_worker_run(p_global_token);if r.deadline<=clock_timestamp()then raise exception 'invocation_expired'using errcode='55000';end if;
 insert into private.worker_runtime_results(request_id,global_token,operation,fingerprint,input,result,state,closed_at)values(p_request_id,p_global_token,'runtime_maintenance',fp,jsonb_build_object('limit',p_limit),outcome,'completed',clock_timestamp());
 return outcome;
end;$$;
create function public.complete_queue_invocation(p_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare r private.worker_invocations;op private.worker_runtime_results;claimed integer;counts jsonb;purged integer;
begin
 perform private.assert_worker_invocation();select *into r from private.worker_invocations where request_id=p_request_id for update;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 if r.state='completed'then return private.worker_invocation_json(r);end if;
 if not r.dispatch_started then raise exception 'invocation_unproven'using errcode='55000';end if;
 if r.kind in('helpful_maintenance','terminal_maintenance','runtime_maintenance')then
  select *into op from private.worker_runtime_results where request_id=r.request_id;
  if not found or op.global_token<>r.global_token or op.state<>'completed'or op.operation<>r.kind or op.input is distinct from jsonb_build_object('limit',r.item_limit)then raise exception 'invocation_unproven'using errcode='55000';end if;
  purged:=case when r.kind='helpful_maintenance'then(op.result->>'deletedCount')::integer else(op.result->>'purged')::integer end;
  if purged is null or purged<0 or purged>r.item_limit then raise exception 'invocation_unproven'using errcode='55000';end if;
  counts:=jsonb_build_object('purged',purged,'processedItems',r.item_limit);
 else
  select count(distinct job_id)into claimed from private.worker_invocation_jobs where request_id=r.request_id;
  if r.claim_calls=0 or(r.claim_calls<r.item_limit and not r.idle_seen)or exists(select 1 from private.worker_invocation_jobs where request_id=r.request_id and settled_status is null)then raise exception 'invocation_unproven'using errcode='55000';end if;
  if exists(select 1 from private.worker_invocation_jobs a where a.request_id=r.request_id and a.settled_status='succeeded'and not coalesce((
   (r.kind='review_summary'and(a.effect in('published','insufficient')))or
   (r.kind='cancellation_safety'and a.effect='cancellation_processed')or
   (r.kind='report_retention'and exists(select 1 from private.report_purge_terminal_receipts p where p.job_id=a.job_id and p.job_lease_token=a.job_lease_token))),false))then raise exception 'invocation_effect_unproven'using errcode='55000';end if;
  select jsonb_build_object('claimed',count(*),'succeeded',count(*)filter(where settled_status='succeeded'),'retried',count(*)filter(where settled_status='retry_wait'),'failed',count(*)filter(where settled_status='failed'),'superseded',count(*)filter(where settled_status='superseded'),'yielded',count(*)filter(where settled_status='queued'))into counts from(select distinct on(job_id)job_id,settled_status from private.worker_invocation_jobs where request_id=r.request_id order by job_id,claim_seq desc)latest;
  counts:=jsonb_build_object('status','ran','counts',counts);
 end if;
 update private.worker_invocations set state='completed',closed_at=clock_timestamp(),result=counts where request_id=r.request_id returning *into r;
 return private.worker_invocation_json(r);
end;$$;
-- 큐 역할의 report terminal 읽기만. 경쟁 점유 만료 후에는 다음 타이머가 깨어난다.
create function public.read_report_terminal_maintenance_schedule_v2(p_global_token uuid default null)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare ready boolean;due timestamptz;expiry timestamptz;n timestamptz:=clock_timestamp();begin
 if auth.role()in('anon','authenticated')then raise exception 'worker_required'using errcode='42501';end if;
 if p_global_token is not null then perform private.assert_current_worker_run(p_global_token);end if;
 ready:=coalesce((select enabled from private.report_purge_control where singleton),false)and has_function_privilege('service_role','public.purge_report_retention_terminal_receipts(uuid,integer)','EXECUTE');
 if ready then select min(expires_at)into due from private.report_purge_terminal_receipts;end if;
 select expires_at into expiry from private.global_worker_run where singleton and token is not null and expires_at>n and token is distinct from p_global_token;
 if due is not null and expiry is not null then due:=greatest(due,expiry);end if;
 return jsonb_build_object('serverNow',n,'nextDueAt',due,'ready',ready);
end;$$;
create or replace function public.read_worker_runtime_pending_v2()returns jsonb language plpgsql volatile security definer set search_path=''as $$begin
 perform private.assert_worker_runtime_atomic();
 return jsonb_build_object('hasPending',exists(select 1 from private.worker_runtime_results where state='external_pending')
  or exists(select 1 from private.worker_runtime_intents where state in('prepared','unknown','observed_response'))
  or exists(select 1 from private.member_cleanup_dispatches d join private.member_cleanup_tasks t on t.id=d.task_id where t.state<>'completed')
  or exists(select 1 from private.worker_invocations where state in('prepared','unknown')));
end;$$;
do $$declare own text;t text;f record;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 foreach t in array array['worker_invocation_control','worker_invocations','worker_invocation_jobs']loop
  execute format('alter table private.%I owner to %I',t,own);execute format('alter table private.%I enable row level security',t);execute format('revoke all on private.%I from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',t);end loop;
 for f in select oid::regprocedure sig from pg_proc where proname in('assert_worker_invocation','assert_invocation_job_dispatch','worker_invocation_json','prepare_queue_invocation','claim_queue_invocation_dispatch','get_queue_invocation','mark_queue_invocation_unknown','complete_queue_invocation','execute_worker_runtime_operation','execute_worker_runtime_operation_sql108','purge_ai_feedback_scoped','purge_ai_feedback_scoped_sql108','purge_worker_runtime_details_scoped','read_report_terminal_maintenance_schedule_v2','claim_supported_worker_job','claim_supported_worker_job_sql108','audit_worker_invocation_settlement','mark_review_summary_insufficient','mark_review_summary_insufficient_sql108','process_cancellation_safety_due','process_cancellation_safety_due_sql108','publish_review_summary_for_job','publish_review_summary_for_job_sql108')and pronamespace in('public'::regnamespace,'private'::regnamespace)and(proname<>'mark_review_summary_insufficient'or pronargs=5)and(proname<>'publish_review_summary_for_job'or pronargs=9)loop
  execute format('alter function %s owner to %I',f.sig,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.sig);end loop;
end;$$;
commit;
