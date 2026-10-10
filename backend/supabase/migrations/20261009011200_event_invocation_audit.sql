-- SQL112: SQL110 회원 위임을 보존한 행사 invocation/lease별 실제 DB 효과 감사.
begin;
do $$declare old_kind text;old_effect text;body text;definition text;
 anchor text:=$anchor$p_kind not in('review_summary','cancellation_safety','report_retention','helpful_maintenance','terminal_maintenance','runtime_maintenance','member_cleanup')$anchor$;
begin
 if to_regprocedure('public.complete_queue_invocation_sql109(uuid)')is null then raise exception 'event_invocation_requires_sql110'using errcode='55000';end if;
 select pg_get_expr(conbin,conrelid)into strict old_kind from pg_constraint where conrelid='private.worker_invocations'::regclass and conname='worker_invocations_kind_check';
 alter table private.worker_invocations drop constraint worker_invocations_kind_check;
 execute format('alter table private.worker_invocations add constraint worker_invocations_kind_check check((%s)or kind=''event_sync'')',old_kind);
 select pg_get_expr(conbin,conrelid)into strict old_effect from pg_constraint where conrelid='private.worker_invocation_jobs'::regclass and conname='worker_invocation_jobs_effect_check';
 alter table private.worker_invocation_jobs drop constraint worker_invocation_jobs_effect_check;
 execute format('alter table private.worker_invocation_jobs add constraint worker_invocation_jobs_effect_check check((%s)or effect in(''event_page_progress'',''event_page_complete'',''event_detail_applied'',''event_detail_stale'',''event_detail_superseded'',''event_settled'',''event_reclaimed''))',old_effect);
 select prosrc,pg_get_functiondef(oid)into strict body,definition from pg_proc where oid='public.prepare_queue_invocation(uuid,uuid,text,integer,integer)'::regprocedure;
 if(length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 or
  (length(body)-length(replace(body,' fp:=encode(','')))/length(' fp:=encode(')<>1 then raise exception 'event_invocation_prepare_anchor_changed'using errcode='55000';end if;
 body:=replace(body,anchor,$anchor$p_kind not in('review_summary','cancellation_safety','report_retention','helpful_maintenance','terminal_maintenance','runtime_maintenance','member_cleanup','event_sync')$anchor$);
 body:=replace(body,' fp:=encode(',$patch$ if p_kind='event_sync'then
  if p_limit>10 or p_remaining_ms>60000 then raise exception 'event_batch_limit'using errcode='22023';end if;
  perform private.assert_event_collection();perform private.assert_event_run(p_global_token);
 end if;
 fp:=encode($patch$);
 select prosrc into strict anchor from pg_proc where oid='public.prepare_queue_invocation(uuid,uuid,text,integer,integer)'::regprocedure;
 execute replace(definition,anchor,body);
end;$$;
alter table private.worker_invocations add constraint worker_invocations_event_bounds
 check(kind<>'event_sync'or(item_limit<=10 and remaining_ms<=60000 and deadline<=created_at+remaining_ms*interval'1 millisecond'));
-- 원천/본문 대신 현재 terminal attempt의 두 UUID만 추가한다. 재점유에서 반드시 지운다.
alter table private.event_collection_progress add column terminal_lease_token uuid,add column terminal_global_token uuid;
alter table private.event_collection_progress add constraint event_terminal_binding_pair
 check((terminal_lease_token is null)=(terminal_global_token is null));
create table private.event_invocation_references(
 request_id uuid not null references private.worker_invocations(request_id),job_id uuid not null,
 claim_attempted boolean not null default false,primary key(request_id,job_id)
);

alter function private.event_collection_ready()rename to event_collection_ready_sql111;
create function private.event_collection_ready()returns boolean language plpgsql volatile security definer set search_path=''as $$
declare v_sig text;v_fn regprocedure;begin
 if not private.event_collection_ready_sql111()or(select enabled from private.worker_invocation_control where singleton)is distinct from true then return false;end if;
 foreach v_sig in array array['public.prepare_queue_invocation(uuid,uuid,text,integer,integer)',
  'public.claim_queue_invocation_dispatch(uuid,uuid,text,integer,integer)','public.get_queue_invocation(uuid)',
  'public.mark_queue_invocation_unknown(uuid)','public.complete_queue_invocation(uuid)']loop
  v_fn:=to_regprocedure(v_sig);if v_fn is null or not has_function_privilege('service_role',v_fn,'EXECUTE')then return false;end if;
 end loop;return true;
end;$$;
create function private.active_event_invocation(p_global_token uuid)returns private.worker_invocations
language plpgsql volatile security definer set search_path=''as $$
declare v_inv private.worker_invocations;begin
 perform private.assert_event_run(p_global_token);perform private.assert_worker_invocation();perform private.assert_event_collection();
 select i.*into v_inv from private.worker_invocations i where i.global_token=p_global_token and i.state in('prepared','unknown')for update;
 if not found or v_inv.kind<>'event_sync'or v_inv.state<>'prepared'or not v_inv.dispatch_started
  or v_inv.item_limit>10 or v_inv.remaining_ms>60000 or v_inv.deadline<=clock_timestamp()then
  raise exception 'event_invocation_not_dispatchable'using errcode='55000';end if;
 return v_inv;
end;$$;
create function private.event_invocation_job(p_job_id uuid,p_job_lease_token uuid,p_global_token uuid)
returns private.worker_invocations language plpgsql volatile security definer set search_path=''as $$
declare v_inv private.worker_invocations;begin
 v_inv:=private.active_event_invocation(p_global_token);
 if not exists(select 1 from private.worker_invocation_jobs a join private.worker_jobs w on w.id=a.job_id
  join private.event_collection_progress ep on ep.job_id=w.id where a.request_id=v_inv.request_id
  and a.job_id=p_job_id and a.job_lease_token=p_job_lease_token and w.kind='event_sync'and not ep.held)then
  raise exception 'event_invocation_lease_binding'using errcode='55000';end if;
 return v_inv;
end;$$;

alter function public.next_event_collection_reference(uuid,jsonb)rename to next_event_collection_reference_sql111;
create function public.next_event_collection_reference(p_worker_run_token uuid,p_excluded_references jsonb default '[]'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare v_inv private.worker_invocations;v_out jsonb;v_check private.worker_invocations;begin
 v_inv:=private.active_event_invocation(p_worker_run_token);
 if p_excluded_references is null or jsonb_typeof(p_excluded_references)<>'array' or jsonb_array_length(p_excluded_references)>100
  or exists(select 1 from jsonb_array_elements(p_excluded_references)excluded_ref where not private.valid_event_collection_reference(excluded_ref)
   or not exists(select 1 from private.event_invocation_references observed join private.event_collection_progress ep on ep.job_id=observed.job_id
    where observed.request_id=v_inv.request_id and ep.reference=excluded_ref))then raise exception 'unobserved_event_exclusion'using errcode='22023';end if;
 if v_inv.claim_calls>=v_inv.item_limit then return null;end if;
 v_out:=public.next_event_collection_reference_sql111(p_worker_run_token,p_excluded_references);
 v_check:=private.active_event_invocation(p_worker_run_token);
 if v_check.request_id<>v_inv.request_id then raise exception 'state_conflict'using errcode='40001';end if;
 -- 실제 후보 조회의 null이다. 선언된 HTTP counts나 임의 idle 표식이 아니다.
 if v_out is null then update private.worker_invocations set idle_seen=true where request_id=v_inv.request_id;
 else
  insert into private.event_invocation_references(request_id,job_id)
   select v_inv.request_id,ep.job_id from private.event_collection_progress ep where ep.reference=v_out on conflict do nothing;
 end if;
 return v_out;
end;$$;
alter function public.claim_event_collection(text,text,jsonb,uuid,integer,text,text)rename to claim_event_collection_sql111;
create function public.claim_event_collection(p_provider text,p_lane text,p_period jsonb,p_worker_run_token uuid,p_lease_seconds integer,
 p_source_id text default null,p_source_collected_at text default null)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare v_inv private.worker_invocations;v_check private.worker_invocations;v_out jsonb;v_ref jsonb;
 v_old private.worker_jobs;v_old_fence private.worker_job_run_fences;v_previous private.worker_invocation_jobs;v_expiry timestamptz;begin
 v_inv:=private.active_event_invocation(p_worker_run_token);
 if v_inv.claim_calls>=v_inv.item_limit then raise exception 'event_invocation_limit'using errcode='55000';end if;
 v_ref:=jsonb_build_object('provider',p_provider,'lane',p_lane,'period',p_period);
 if p_lane='detail'then v_ref:=v_ref||jsonb_build_object('sourceId',p_source_id,'sourceCollectedAt',p_source_collected_at);end if;
 if not private.valid_event_collection_reference(v_ref)or(p_lane<>'detail'and(p_source_id is not null or p_source_collected_at is not null))or p_lease_seconds is distinct from 180 then
  raise exception 'invalid_event_claim'using errcode='22023';end if;
 select w.*into v_old from private.worker_jobs w join private.event_collection_progress ep on ep.job_id=w.id
  where w.kind='event_sync'and ep.reference=v_ref for update of w skip locked;
 if v_old.status='running'and v_old.lease_expires_at<=clock_timestamp()then
  select *into v_previous from private.worker_invocation_jobs where job_id=v_old.id and job_lease_token=v_old.lease_token and settled_status is null;
  if found then
   select *into v_old_fence from private.worker_job_run_fences where job_id=v_old.id;
   if v_previous.request_id<>v_inv.request_id or v_old_fence.job_lease_token is distinct from v_old.lease_token
    or v_old_fence.worker_run_token is distinct from p_worker_run_token then raise exception 'event_previous_attempt_pending'using errcode='55000';end if;
  end if;
 end if;
 v_out:=public.claim_event_collection_sql111(p_provider,p_lane,p_period,p_worker_run_token,p_lease_seconds,p_source_id,p_source_collected_at);
 v_check:=private.active_event_invocation(p_worker_run_token);
 if v_check.request_id<>v_inv.request_id then raise exception 'state_conflict'using errcode='40001';end if;
 if v_out is not null then
  if v_previous.request_id is not null then
   update private.worker_invocation_jobs set settled_status='superseded',effect='event_reclaimed'
    where request_id=v_inv.request_id and job_id=v_old.id and job_lease_token=v_old.lease_token and settled_status is null;
  end if;
  select least(lease_expires_at,v_inv.deadline)into strict v_expiry from private.worker_jobs where id=(v_out->>'jobId')::uuid;
  if v_expiry<=clock_timestamp()then raise exception 'invocation_expired'using errcode='55000';end if;
  update private.worker_jobs set lease_expires_at=v_expiry where id=(v_out->>'jobId')::uuid;
  update private.event_collection_progress set terminal_lease_token=null,terminal_global_token=null where job_id=(v_out->>'jobId')::uuid;
  insert into private.worker_invocation_jobs(request_id,job_id,job_lease_token,claim_seq)
   values(v_inv.request_id,(v_out->>'jobId')::uuid,(v_out->>'leaseToken')::uuid,v_inv.claim_calls+1);
 end if;
 insert into private.event_invocation_references(request_id,job_id,claim_attempted)
  select v_inv.request_id,ep.job_id,true from private.event_collection_progress ep where ep.reference=v_ref
  on conflict(request_id,job_id)do update set claim_attempted=true;
 update private.worker_invocations set claim_calls=claim_calls+1 where request_id=v_inv.request_id;
 perform private.assert_event_run(p_worker_run_token);
 if v_inv.deadline<=clock_timestamp()then raise exception 'invocation_expired'using errcode='55000';end if;
 return v_out;
end;$$;

alter function public.commit_event_collection_page(uuid,uuid,uuid,integer,jsonb,boolean,jsonb,jsonb)rename to commit_event_collection_page_sql111;
create function public.commit_event_collection_page(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_expected_next_page integer,
 p_events jsonb,p_preserve_missing boolean,p_detail_references jsonb,p_next jsonb)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare v_inv private.worker_invocations;v_check private.worker_invocations;v_out jsonb;v_settlement text;begin
 v_inv:=private.event_invocation_job(p_job_id,p_lease_token,p_worker_run_token);
 v_out:=public.commit_event_collection_page_sql111(p_job_id,p_lease_token,p_worker_run_token,p_expected_next_page,p_events,p_preserve_missing,p_detail_references,p_next);
 v_check:=private.event_invocation_job(p_job_id,p_lease_token,p_worker_run_token);
 if v_check.request_id<>v_inv.request_id then raise exception 'state_conflict'using errcode='40001';end if;
 if v_out->>'status'='applied'then
  select a.settled_status into strict v_settlement from private.worker_invocation_jobs a where a.request_id=v_inv.request_id and a.job_id=p_job_id and a.job_lease_token=p_lease_token;
  if v_settlement='succeeded'then
   if not exists(select 1 from private.event_collection_progress where job_id=p_job_id and last_lease=p_lease_token and last_global=p_worker_run_token)then raise exception 'event_effect_binding'using errcode='40001';end if;
   update private.worker_invocation_jobs set effect='event_page_complete'where request_id=v_inv.request_id and job_id=p_job_id and job_lease_token=p_lease_token;
   update private.event_collection_progress set terminal_lease_token=p_lease_token,terminal_global_token=p_worker_run_token where job_id=p_job_id;
  elsif v_settlement is null then
   update private.worker_invocation_jobs set effect='event_page_progress'where request_id=v_inv.request_id and job_id=p_job_id and job_lease_token=p_lease_token;
  end if;
 end if;return v_out;
end;$$;
alter function public.store_event_source_detail(jsonb,uuid,uuid,uuid,text,boolean)rename to store_event_source_detail_sql111;
create function public.store_event_source_detail(p_detail jsonb,p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid,
 p_source_collected_at text,p_preserve_missing boolean)returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare v_inv private.worker_invocations;v_check private.worker_invocations;v_out jsonb;begin
 v_inv:=private.event_invocation_job(p_job_id,p_lease_token,p_worker_run_token);
 v_out:=public.store_event_source_detail_sql111(p_detail,p_job_id,p_lease_token,p_worker_run_token,p_source_collected_at,p_preserve_missing);
 v_check:=private.event_invocation_job(p_job_id,p_lease_token,p_worker_run_token);
 if v_check.request_id<>v_inv.request_id then raise exception 'state_conflict'using errcode='40001';end if;
 if v_out->>'status' in('applied','stale','superseded')then
  update private.worker_invocation_jobs set effect='event_detail_'||(v_out->>'status')
   where request_id=v_inv.request_id and job_id=p_job_id and job_lease_token=p_lease_token;
  update private.event_collection_progress set terminal_lease_token=p_lease_token,terminal_global_token=p_worker_run_token where job_id=p_job_id;
 end if;return v_out;
end;$$;
alter function public.settle_event_collection(uuid,uuid,uuid,text,text,boolean,integer,integer)rename to settle_event_collection_sql111;
create function public.settle_event_collection(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_outcome text,
 p_error_code text,p_retryable boolean,p_retry_floor_seconds integer,p_retry_cap_seconds integer)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare v_inv private.worker_invocations;v_check private.worker_invocations;v_out jsonb;begin
 v_inv:=private.event_invocation_job(p_job_id,p_lease_token,p_worker_run_token);
 v_out:=public.settle_event_collection_sql111(p_job_id,p_lease_token,p_worker_run_token,p_outcome,p_error_code,p_retryable,p_retry_floor_seconds,p_retry_cap_seconds);
 v_check:=private.event_invocation_job(p_job_id,p_lease_token,p_worker_run_token);
 if v_check.request_id<>v_inv.request_id then raise exception 'state_conflict'using errcode='40001';end if;
 if v_out->>'status'in('queued','retry_wait','failed','superseded')then
  update private.worker_invocation_jobs set effect='event_settled'where request_id=v_inv.request_id and job_id=p_job_id and job_lease_token=p_lease_token;
  if v_out->>'status'in('failed','superseded')then
   update private.event_collection_progress set terminal_lease_token=p_lease_token,terminal_global_token=p_worker_run_token where job_id=p_job_id;
  end if;
 end if;return v_out;
end;$$;

-- 110 회원 처리와 기존109의 여섯 종류를 위임 체인 그대로 유지한다.
alter function public.complete_queue_invocation(uuid)rename to complete_queue_invocation_sql110;
create function public.complete_queue_invocation(p_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare v_inv private.worker_invocations;v_counts jsonb;begin
 perform private.assert_worker_invocation();select i.*into v_inv from private.worker_invocations i where i.request_id=p_request_id for update;
 if not found then raise exception 'not_found'using errcode='PT404';end if;
 if v_inv.kind<>'event_sync'then return public.complete_queue_invocation_sql110(p_request_id);end if;
 if v_inv.state='completed'then return private.worker_invocation_json(v_inv);end if;
 if not v_inv.dispatch_started or(not v_inv.idle_seen and v_inv.claim_calls<v_inv.item_limit)
  or exists(select 1 from private.worker_invocation_jobs where request_id=v_inv.request_id and settled_status is null)
  or exists(select 1 from private.event_invocation_references where request_id=v_inv.request_id and not claim_attempted)then
  raise exception 'invocation_unproven'using errcode='55000';end if;
 -- 같은 lease에 실제 scoped SQL이 기록한 효과만 인정한다. 일반 complete_job은 증거가 아니다.
 if exists(select 1 from private.worker_invocation_jobs a join private.worker_jobs w on w.id=a.job_id
  join private.event_collection_progress ep on ep.job_id=w.id where a.request_id=v_inv.request_id and not coalesce(
   w.kind='event_sync'and not ep.held and case
    when a.settled_status='succeeded'then
     w.status='succeeded'and ep.terminal_lease_token=a.job_lease_token and ep.terminal_global_token=v_inv.global_token and
     ((a.effect='event_page_complete'and ep.reference->>'lane'in('initial_history','future','ongoing')and ep.last_lease=a.job_lease_token and ep.last_global=v_inv.global_token)
      or(a.effect in('event_detail_applied','event_detail_stale')and ep.reference->>'lane'='detail'))
    when a.effect='event_reclaimed'then a.settled_status='superseded'and exists(select 1 from private.worker_invocation_jobs newer
      where newer.request_id=a.request_id and newer.job_id=a.job_id and newer.claim_seq>a.claim_seq and newer.job_lease_token<>a.job_lease_token)
    when a.effect='event_detail_superseded'then a.settled_status='superseded'and w.status='superseded'and ep.reference->>'lane'='detail'
      and ep.terminal_lease_token=a.job_lease_token and ep.terminal_global_token=v_inv.global_token
    else a.effect='event_settled'and a.settled_status in('queued','retry_wait','failed','superseded')end,false))then
  raise exception 'invocation_effect_unproven'using errcode='55000';end if;
 if exists(select 1 from private.worker_invocation_jobs a where a.request_id=v_inv.request_id and
  (not exists(select 1 from private.worker_jobs where id=a.job_id and kind='event_sync')or not exists(select 1 from private.event_collection_progress where job_id=a.job_id)))then
  raise exception 'invocation_effect_unproven'using errcode='55000';end if;
 if exists(select 1 from(select distinct on(job_id)job_id,settled_status from private.worker_invocation_jobs where request_id=v_inv.request_id order by job_id,claim_seq desc)latest
  join private.worker_jobs w on w.id=latest.job_id where w.status is distinct from latest.settled_status)then raise exception 'event_latest_attempt_unproven'using errcode='55000';end if;
 select jsonb_build_object('claimed',count(*),'succeeded',count(*)filter(where settled_status='succeeded'),
  'retried',count(*)filter(where settled_status='retry_wait'),'failed',count(*)filter(where settled_status='failed'),
  'superseded',count(*)filter(where settled_status='superseded'),'yielded',count(*)filter(where settled_status='queued'))into v_counts
  from(select distinct on(job_id)job_id,settled_status from private.worker_invocation_jobs where request_id=v_inv.request_id order by job_id,claim_seq desc)latest;
 update private.worker_invocations set state='completed',closed_at=clock_timestamp(),result=jsonb_build_object('status','ran','counts',v_counts)
  where request_id=v_inv.request_id returning *into v_inv;
 return private.worker_invocation_json(v_inv);
end;$$;

do $$declare v_owner text;v_fn record;begin
 select pg_get_userbyid(proowner)into strict v_owner from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 execute format('alter table private.event_invocation_references owner to %I',v_owner);
 alter table private.event_invocation_references enable row level security;
 alter table private.event_invocation_references force row level security;
 revoke all on private.event_invocation_references from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
 for v_fn in select oid::regprocedure sig from pg_proc where pronamespace in('public'::regnamespace,'private'::regnamespace)
  and proname in('event_collection_ready','event_collection_ready_sql111','active_event_invocation','event_invocation_job',
   'next_event_collection_reference','next_event_collection_reference_sql111','claim_event_collection','claim_event_collection_sql111',
   'commit_event_collection_page','commit_event_collection_page_sql111','store_event_source_detail','store_event_source_detail_sql111',
   'settle_event_collection','settle_event_collection_sql111','complete_queue_invocation','complete_queue_invocation_sql110')loop
  execute format('alter function %s owner to %I',v_fn.sig,v_owner);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',v_fn.sig);
 end loop;
end;$$;
-- 운영 권한/제어는 열지 않는다. rank/Seoul 보류와 원천 validator를 변경하지 않는다.
commit;
