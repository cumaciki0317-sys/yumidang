-- SQL102: 원자 DB 결과와 작업20 원장. 기존 ABI 보존, 활성화 기본 닫힘.
begin;
create table private.worker_runtime_atomic_control(singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into private.worker_runtime_atomic_control values(true,false);
create table private.worker_runtime_job_slots(global_token uuid not null,job_id uuid not null,created_at timestamptz not null default clock_timestamp(),primary key(global_token,job_id));
create table private.worker_runtime_results(
 request_id uuid primary key,global_token uuid not null,operation text not null,fingerprint text not null,
 input jsonb,result jsonb,state text not null check(state in('completed','external_pending','purged')),
 created_at timestamptz not null default clock_timestamp(),closed_at timestamptz,purged_at timestamptz,
 check(fingerprint~'^[a-f0-9]{64}$'),check((state='external_pending'and closed_at is null)or(state<>'external_pending'and closed_at is not null)));
create function private.assert_worker_runtime_atomic()returns void language plpgsql security definer set search_path=''as $$begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_required'using errcode='42501';end if;
 if(select enabled from private.worker_runtime_atomic_control where singleton)is distinct from true then raise exception 'runtime_not_ready'using errcode='55000';end if;
end;$$;
create function private.worker_runtime_exact_keys(p_input jsonb,p_keys text[])returns void language plpgsql set search_path=''as $$begin
 if p_input is null or jsonb_typeof(p_input)<>'object'or octet_length(p_input::text)>4096 or
 (select array_agg(k order by k)from jsonb_object_keys(p_input)k)is distinct from(select array_agg(k order by k)from unnest(p_keys)k)then raise exception 'invalid_runtime_input'using errcode='22023';end if;
end;$$;
-- 지원 claim의 공통 지점에서 예약하므로 기존 review claim 호출도 활성화 시 우회하지 못한다.
do $$declare body text;definition text;a text;b text;begin
 select prosrc,pg_get_functiondef(oid)into strict body,definition from pg_proc where oid='private.claim_supported_worker_job(uuid,integer,uuid,text[])'::regprocedure;
 a:='where kind=any(ready)and';
 b:=$patch$where kind=any(ready)and
 (not coalesce((select enabled from private.worker_runtime_atomic_control where singleton),false)
 or(select count(*)from private.worker_runtime_job_slots where global_token=p_worker_run_token)<20
 or exists(select 1 from private.worker_runtime_job_slots s where s.global_token=p_worker_run_token and s.job_id=worker_jobs.id))and$patch$;
 if(length(body)-length(replace(body,a,'')))/length(a)<>1 then raise exception 'runtime_claim_anchor_changed'using errcode='55000';end if;
 body:=replace(body,a,b);
 a:=$anchor$ return jsonb_build_object('job',jsonb_build_object('jobId',j.id$anchor$;
 b:=$patch$
 if(select enabled from private.worker_runtime_atomic_control where singleton)then
  insert into private.worker_runtime_job_slots(global_token,job_id)values(p_worker_run_token,j.id)on conflict do nothing;
  if(select count(*)from private.worker_runtime_job_slots where global_token=p_worker_run_token)>20 then raise exception 'runtime_job_limit'using errcode='40001';end if;
 end if;
$patch$||a;
 if(length(body)-length(replace(body,a,'')))/length(a)<>1 then raise exception 'runtime_claim_anchor_changed'using errcode='55000';end if;
 select prosrc into a from pg_proc where oid='private.claim_supported_worker_job(uuid,integer,uuid,text[])'::regprocedure;
 execute replace(definition,a,replace(body,$anchor$ return jsonb_build_object('job',jsonb_build_object('jobId',j.id$anchor$,b));
end;$$;
create function public.execute_worker_runtime_operation(p_request_id uuid,p_global_token uuid,p_operation text,p_input jsonb)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$
declare old private.worker_runtime_results;hash text;keys text[];k text;v jsonb;outcome jsonb;kinds text[];status text;rowstate text:='completed';closed timestamptz;begin
 perform private.assert_worker_runtime_atomic();
 if p_request_id is null or p_global_token is null or p_operation is null then raise exception 'invalid_runtime_input'using errcode='22023';end if;
 case p_operation
 when'due_enqueue'then keys:=array['kind','limit'];
 when'job_claim'then keys:=array['workerId','leaseSeconds','supportedKinds'];
 when'cancellation_process'then keys:=array['identityId','generation','jobId','jobLeaseToken'];
 when'report_task_claim'then keys:=array['jobId','jobLeaseToken'];
 when'report_delete_begin'then keys:=array['taskId','taskLeaseToken','jobId','jobLeaseToken','objectId'];
 when'report_delete_ack'then keys:=array['taskId','taskLeaseToken','jobId','jobLeaseToken','objectId','ackSha256'];
 when'report_task_complete'then keys:=array['taskId','taskLeaseToken','jobId','jobLeaseToken','objectId','evidenceSha256'];
 when'job_settlement'then
  status:=p_input->>'status';
  if status in('queued','retry_wait')then keys:=array['jobId','jobLeaseToken','status','availableAt'];else keys:=array['jobId','jobLeaseToken','status'];end if;
  if status in('retry_wait','failed')then keys:=array_append(keys,'errorCode');end if;
 when'terminal_maintenance'then keys:=array['limit'];
 else raise exception 'invalid_runtime_operation'using errcode='22023';end case;
 perform private.worker_runtime_exact_keys(p_input,keys);
 for k,v in select *from jsonb_each(p_input)loop
  if k in('workerId','identityId','jobId','jobLeaseToken','taskId','taskLeaseToken','objectId')then
   if k='objectId'and v='null'::jsonb and p_operation='report_task_complete'then continue;end if;
   if jsonb_typeof(v)<>'string'or(v#>>'{}')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'then raise exception 'invalid_runtime_uuid'using errcode='22023';end if;
  elsif k in('ackSha256','evidenceSha256')then
   if jsonb_typeof(v)<>'string'or(v#>>'{}')!~'^[a-f0-9]{64}$'then raise exception 'invalid_runtime_hash'using errcode='22023';end if;
  elsif k='limit'then
   if jsonb_typeof(v)<>'number'or(v#>>'{}')!~'^([1-9]|1[0-9]|20)$'then raise exception 'invalid_runtime_limit'using errcode='22023';end if;
  elsif k='leaseSeconds'then
   if v is distinct from'180'::jsonb then raise exception 'invalid_runtime_lease'using errcode='22023';end if;
  elsif k='generation'then
   if jsonb_typeof(v)<>'number'or(v#>>'{}')!~'^[1-9][0-9]{0,15}$'or(v#>>'{}')::numeric>9007199254740991 then raise exception 'invalid_runtime_generation'using errcode='22023';end if;
  elsif k='supportedKinds'then
   if jsonb_typeof(v)<>'array'or jsonb_array_length(v)not between 1 and 3 or exists(select 1 from jsonb_array_elements(v)x where jsonb_typeof(x)<>'string'or x#>>'{}'not in('review_summary','cancellation_safety','report_retention'))or(select count(distinct x)from jsonb_array_elements(v)x)<>jsonb_array_length(v)then raise exception 'invalid_runtime_kinds'using errcode='22023';end if;
  elsif k='kind'then
   if jsonb_typeof(v)<>'string'or v#>>'{}'not in('cancellation_safety','report_retention')then raise exception 'invalid_runtime_kind'using errcode='22023';end if;
  elsif k='status'then
   if jsonb_typeof(v)<>'string'or v#>>'{}'not in('succeeded','queued','retry_wait','failed','superseded')then raise exception 'invalid_runtime_status'using errcode='22023';end if;
  elsif k='availableAt'then
   if status='queued'and v='null'::jsonb then continue;end if;
   if jsonb_typeof(v)<>'string'or(v#>>'{}')!~'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?(Z|[+-]\d\d:\d\d)$'or not isfinite((v#>>'{}')::timestamptz)then raise exception 'invalid_runtime_date'using errcode='22023';end if;
  elsif k='errorCode'then
   if jsonb_typeof(v)<>'string'or v#>>'{}'not in('UPSTREAM_UNAVAILABLE','RATE_LIMITED','TIMEOUT','STATE_CHANGED','INTERNAL_ERROR')then raise exception 'invalid_runtime_error'using errcode='22023';end if;
  end if;
 end loop;
 hash:=encode(extensions.digest(jsonb_build_array(p_global_token,p_operation,p_input)::text,'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,102));
 select *into old from private.worker_runtime_results where request_id=p_request_id for update;
 if found then
  if old.fingerprint<>hash then raise exception 'request_conflict'using errcode='40001';end if;
  return jsonb_build_object('requestId',old.request_id,'state',old.state,'result',old.result,'closedAt',old.closed_at,'replayed',true);
 end if;
 perform private.assert_current_worker_run(p_global_token);
 case p_operation
 when'due_enqueue'then
  if p_input->>'kind'='cancellation_safety'then outcome:=public.enqueue_cancellation_safety_due((p_input->>'limit')::integer,p_global_token);
  else outcome:=public.enqueue_report_retention_purges(p_global_token,(p_input->>'limit')::integer);end if;
 when'job_claim'then
  select array_agg(x)into kinds from jsonb_array_elements_text(p_input->'supportedKinds')x;
  outcome:=public.claim_supported_job((p_input->>'workerId')::uuid,180,p_global_token,kinds);
 when'cancellation_process'then outcome:=public.process_cancellation_safety_due((p_input->>'identityId')::uuid,(p_input->>'generation')::bigint,(p_input->>'jobId')::uuid,(p_input->>'jobLeaseToken')::uuid,p_global_token);
 when'report_task_claim'then
  outcome:=public.claim_report_retention_task((p_input->>'jobId')::uuid,(p_input->>'jobLeaseToken')::uuid,p_global_token);
  if outcome is not null then outcome:=outcome-'bucketId'-'objectName';end if;
 when'report_delete_begin'then
  outcome:=public.begin_report_retention_delete((p_input->>'taskId')::uuid,(p_input->>'taskLeaseToken')::uuid,(p_input->>'jobId')::uuid,(p_input->>'jobLeaseToken')::uuid,p_global_token,(p_input->>'objectId')::uuid);
  rowstate:='external_pending';
 when'report_delete_ack'then outcome:=public.record_report_retention_delete_ack((p_input->>'taskId')::uuid,(p_input->>'taskLeaseToken')::uuid,(p_input->>'jobId')::uuid,(p_input->>'jobLeaseToken')::uuid,p_global_token,(p_input->>'objectId')::uuid,p_input->>'ackSha256');
 when'report_task_complete'then
  outcome:=public.complete_report_retention_task((p_input->>'taskId')::uuid,(p_input->>'taskLeaseToken')::uuid,(p_input->>'jobId')::uuid,(p_input->>'jobLeaseToken')::uuid,p_global_token,(p_input->>'objectId')::uuid,p_input->>'evidenceSha256');
  update private.worker_runtime_results set state='completed',closed_at=clock_timestamp()where operation='report_delete_begin'and state='external_pending'and input->>'taskId'=p_input->>'taskId'and input->>'objectId'=p_input->>'objectId';
 when'job_settlement'then
  case status
  when'succeeded'then outcome:=public.complete_job((p_input->>'jobId')::uuid,(p_input->>'jobLeaseToken')::uuid,p_global_token);
  when'queued'then outcome:=public.yield_job((p_input->>'jobId')::uuid,(p_input->>'jobLeaseToken')::uuid,(p_input->>'availableAt')::timestamptz,p_global_token);
  when'retry_wait'then outcome:=public.retry_job((p_input->>'jobId')::uuid,(p_input->>'jobLeaseToken')::uuid,(p_input->>'availableAt')::timestamptz,p_input->>'errorCode',p_global_token);
  when'failed'then outcome:=public.fail_job((p_input->>'jobId')::uuid,(p_input->>'jobLeaseToken')::uuid,p_input->>'errorCode',p_global_token);
  when'superseded'then outcome:=public.supersede_job((p_input->>'jobId')::uuid,(p_input->>'jobLeaseToken')::uuid,p_global_token);end case;
 when'terminal_maintenance'then outcome:=public.purge_report_retention_terminal_receipts(p_global_token,(p_input->>'limit')::integer);
 end case;
 perform private.assert_current_worker_run(p_global_token);
 closed:=case when rowstate='completed'then clock_timestamp()else null end;
 insert into private.worker_runtime_results(request_id,global_token,operation,fingerprint,input,result,state,closed_at)values(p_request_id,p_global_token,p_operation,hash,p_input,outcome,rowstate,closed)returning *into old;
 return jsonb_build_object('requestId',old.request_id,'state',old.state,'result',old.result,'closedAt',old.closed_at,'replayed',false);
end;$$;
create function public.get_worker_runtime_operation(p_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare r private.worker_runtime_results;begin
 perform private.assert_worker_runtime_atomic();
 if p_request_id is null then raise exception 'invalid_runtime_request'using errcode='22023';end if;
 select *into r from private.worker_runtime_results where request_id=p_request_id;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 return jsonb_build_object('requestId',r.request_id,'state',r.state,'result',r.result,'closedAt',r.closed_at,'replayed',true);
end;$$;
create function public.read_worker_runtime_slots(p_global_token uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare used integer;begin
 perform private.assert_worker_runtime_atomic();perform private.assert_current_worker_run(p_global_token);
 select count(*)into used from private.worker_runtime_job_slots where global_token=p_global_token;
 return jsonb_build_object('used',used,'remaining',20-used);
end;$$;
do $$declare own text;t text;f record;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 foreach t in array array['worker_runtime_atomic_control','worker_runtime_job_slots','worker_runtime_results']loop
 execute format('alter table private.%I owner to %I',t,own);execute format('alter table private.%I enable row level security',t);execute format('revoke all on private.%I from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',t);end loop;
 for f in select oid::regprocedure sig from pg_proc where proname in('assert_worker_runtime_atomic','worker_runtime_exact_keys','execute_worker_runtime_operation','get_worker_runtime_operation','read_worker_runtime_slots')and pronamespace in('public'::regnamespace,'private'::regnamespace)loop
 execute format('alter function %s owner to %I',f.sig,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.sig);end loop;
end;$$;
commit;
