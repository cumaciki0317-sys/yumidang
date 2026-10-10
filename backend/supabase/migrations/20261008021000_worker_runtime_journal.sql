-- SQL101: 최소 영속 intent. observed_response는 caller 응답 검증 보고이며 원격 종결 보증이 아니다.
-- 종현 조립·복구 계약 검증 전 활성화하지 않는다. UNKNOWN 자동 재전송 포트 없음.
begin;
create table private.worker_runtime_journal_control(singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into private.worker_runtime_journal_control values(true,false);
create table private.worker_runtime_intents(
 request_id uuid primary key,ticket uuid not null unique default gen_random_uuid(),
 operation text not null check(operation in('cycle','due_enqueue','job_claim','cancellation_process','report_task_claim','report_storage','report_task_complete','job_settlement','terminal_maintenance')),
 global_token uuid not null,parent_ticket uuid references private.worker_runtime_intents(ticket),
 scope jsonb not null,fingerprint text not null check(fingerprint~'^[a-f0-9]{64}$'),
 state text not null default'prepared'check(state in('prepared','unknown','observed_response')),
 created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp());
alter table private.worker_runtime_journal_control enable row level security;
alter table private.worker_runtime_intents enable row level security;
revoke all on private.worker_runtime_journal_control,private.worker_runtime_intents from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
create function private.assert_worker_runtime_journal()returns void language plpgsql security definer set search_path=''as $$begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_required'using errcode='42501';end if;
 if(select enabled from private.worker_runtime_journal_control where singleton)is distinct from true then raise exception 'journal_not_ready'using errcode='55000';end if;
end;$$;
create function public.prepare_worker_runtime_intent(p_request_id uuid,p_operation text,p_global_token uuid,p_scope jsonb,p_parent_ticket uuid default null)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare old private.worker_runtime_intents;hash text;k text;value jsonb;
begin
 perform private.assert_worker_runtime_journal();
 if p_request_id is null or p_global_token is null or p_operation is null or p_operation not in('cycle','due_enqueue','job_claim','cancellation_process','report_task_claim','report_storage','report_task_complete','job_settlement','terminal_maintenance')
 or p_scope is null or jsonb_typeof(p_scope)<>'object' or octet_length(p_scope::text)>2048 then raise exception 'invalid_intent'using errcode='22023';end if;
 for k,value in select *from jsonb_each(p_scope)loop
  if k in('jobId','jobLeaseToken','taskId','taskLeaseToken','workerId','identityId')then
   if jsonb_typeof(value)<>'string'or(value#>>'{}')!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'then raise exception 'invalid_intent'using errcode='22023';end if;
  elsif k='kind'then
   if value#>>'{}' not in('review_summary','event_sync','member_cleanup','cancellation_safety','report_retention')or jsonb_typeof(value)<>'string'then raise exception 'invalid_intent'using errcode='22023';end if;
  elsif k='evidenceSha256'then
   if jsonb_typeof(value)<>'string'or(value#>>'{}')!~'^[a-f0-9]{64}$'then raise exception 'invalid_intent'using errcode='22023';end if;
  elsif k='limit'then
   if jsonb_typeof(value)<>'number'or(value#>>'{}')!~'^([1-9]|1[0-9]|20)$'then raise exception 'invalid_intent'using errcode='22023';end if;
  elsif k='generation'then
   if jsonb_typeof(value)<>'number'or(value#>>'{}')!~'^[1-9][0-9]{0,15}$'or(value#>>'{}')::numeric>9007199254740991 then raise exception 'invalid_intent'using errcode='22023';end if;
  else raise exception 'invalid_intent'using errcode='22023';end if;
 end loop;
 hash:=encode(extensions.digest(jsonb_build_array(p_operation,p_global_token,p_scope,p_parent_ticket)::text,'sha256'),'hex');
 -- 같은 요청의 경쟁은 원자 직렬화하며 원문·첨부 내용을 받지 않는다.
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,101));
 select *into old from private.worker_runtime_intents where request_id=p_request_id for update;
 if found then
  if old.fingerprint<>hash then raise exception 'request_conflict'using errcode='40001';end if;
  return jsonb_build_object('ticket',old.ticket,'state',old.state);
 end if;
 perform private.assert_current_worker_run(p_global_token);
 if p_parent_ticket is not null then
  perform 1 from private.worker_runtime_intents where ticket=p_parent_ticket and global_token=p_global_token and operation='cycle'and state='prepared' for update;
  if not found then raise exception 'state_conflict'using errcode='40001';end if;
 end if;
 insert into private.worker_runtime_intents(request_id,operation,global_token,scope,fingerprint,parent_ticket)
 values(p_request_id,p_operation,p_global_token,p_scope,hash,p_parent_ticket)returning *into old;
 return jsonb_build_object('ticket',old.ticket,'state',old.state);
end;$$;
create function public.observe_worker_runtime_intent(p_request_id uuid,p_observed boolean)returns jsonb
language plpgsql volatile security definer set search_path=''as $$declare row private.worker_runtime_intents;begin
 perform private.assert_worker_runtime_journal();
 if p_request_id is null or p_observed is null then raise exception 'invalid_intent'using errcode='22023';end if;
 select *into row from private.worker_runtime_intents where request_id=p_request_id for update;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 if p_observed and row.state='unknown'then raise exception 'unknown_requires_reconciliation'using errcode='40001';end if;
 if row.state='prepared'then
  update private.worker_runtime_intents set state=case when p_observed then'observed_response'else'unknown'end,updated_at=clock_timestamp()where request_id=p_request_id returning *into row;
 end if;
 return jsonb_build_object('ticket',row.ticket,'state',row.state);
end;$$;
create function public.get_worker_runtime_intent(p_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare row private.worker_runtime_intents;begin
 perform private.assert_worker_runtime_journal();
 if p_request_id is null then raise exception 'invalid_intent'using errcode='22023';end if;
 select *into row from private.worker_runtime_intents where request_id=p_request_id;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 return jsonb_build_object('ticket',row.ticket,'requestId',row.request_id,'operation',row.operation,'globalToken',row.global_token,'parentTicket',row.parent_ticket,'scope',row.scope,'state',row.state);
end;$$;
create function public.read_worker_runtime_pending()returns jsonb language plpgsql volatile security definer set search_path=''as $$begin
 perform private.assert_worker_runtime_journal();
 return jsonb_build_object('hasPending',exists(select 1 from private.worker_runtime_intents where state in('prepared','unknown')));
end;$$;
do $$declare own text;f record;t text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 foreach t in array array['worker_runtime_journal_control','worker_runtime_intents']loop execute format('alter table private.%I owner to %I',t,own);end loop;
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where(n.nspname='public'and p.proname in('prepare_worker_runtime_intent','observe_worker_runtime_intent','read_worker_runtime_pending','get_worker_runtime_intent'))or(n.nspname='private'and p.proname='assert_worker_runtime_journal')loop
  execute format('alter function %s owner to %I',f.sig,own);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.sig);
 end loop;
end;$$;
-- EXECUTE provisioning도 별도이며 기본은 닫힘. 새 internal HTTP route를 추가하지 않는다.
commit;
