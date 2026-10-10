-- SQL111: 행사 수집 영속 진행. 기존 원천 validator/공개 API와 운영 보류를 보존한다.
begin;

create table private.event_collection_control (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false
);
insert into private.event_collection_control values(true,false);
create function private.valid_event_collection_reference(p_reference jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare r jsonb:=p_reference;d date;e date;k text;keys text[];
begin
 if r is null or jsonb_typeof(r)<>'object' or octet_length(r::text)>2048 then return false;end if;
 keys:=array['provider','lane','period'];
 if r->>'lane'='detail' then keys:=keys||array['sourceId','sourceCollectedAt'];end if;
 if not r ?& keys or r-keys<>'{}'::jsonb or jsonb_typeof(r->'provider')<>'string'
  or r->>'provider' not in('kopis','tour-api') or jsonb_typeof(r->'lane')<>'string'
  or r->>'lane' not in('initial_history','future','ongoing','detail','ranking_all','ranking_musical') then return false;end if;
 if r->>'lane' in('ranking_all','ranking_musical') and r->>'provider'<>'kopis' then return false;end if;
 if jsonb_typeof(r->'period')<>'object' or not(r->'period') ?& array['start','end']
  or (r->'period')-array['start','end']<>'{}'::jsonb
  or jsonb_typeof(r#>'{period,start}')<>'string' or jsonb_typeof(r#>'{period,end}')<>'string' then return false;end if;
 d:=private.event_calendar_date_v1(r#>>'{period,start}');e:=private.event_calendar_date_v1(r#>>'{period,end}');
 if e<d or e-d>30 or r->>'lane'='ongoing' and d<>e then return false;end if;
 if r->>'lane'='detail' then
  if jsonb_typeof(r->'sourceId')<>'string' or jsonb_typeof(r->'sourceCollectedAt')<>'string'
   or not private.event_public_text_v1(r->>'sourceId',200)
   or (r->>'provider'='kopis' and r->>'sourceId'!~'^PF[0-9A-Za-z]+$')
   or (r->>'provider'='tour-api' and r->>'sourceId'!~'^[0-9]{1,20}$') then return false;end if;
  if d<>e or d<>(private.event_instant_v1(r->>'sourceCollectedAt') at time zone 'Asia/Seoul')::date then return false;end if;
 end if;
 return true;
exception when invalid_parameter_value or invalid_datetime_format or datetime_field_overflow then return false;
end;$$;

-- 기존 세 종류의 제약식은 그대로 유지하며 행사 identity 전용 분기만 추가한다.
do $$declare old_kind text;old_payload text;begin
 select pg_get_expr(conbin,conrelid) into strict old_kind from pg_constraint
  where conrelid='private.worker_jobs'::regclass and conname='worker_jobs_kind_check';
 select pg_get_expr(conbin,conrelid) into strict old_payload from pg_constraint
  where conrelid='private.worker_jobs'::regclass and conname='worker_jobs_payload_check';
 alter table private.worker_jobs drop constraint worker_jobs_kind_check;
 execute format('alter table private.worker_jobs add constraint worker_jobs_kind_check check((%s) or kind=''event_sync'')',old_kind);
 alter table private.worker_jobs drop constraint worker_jobs_payload_check;
 execute format('alter table private.worker_jobs add constraint worker_jobs_payload_check check(case when kind=''event_sync'' then private.valid_event_collection_reference(payload) else (%s) end)',old_payload);
end;$$;

create table private.event_collection_providers (
 provider text primary key check(provider in('kopis','tour-api')),
 initial_registered_on date not null
);
create table private.event_collection_progress (
 job_id uuid primary key references private.worker_jobs(id) on delete cascade,
 reference jsonb not null check(private.valid_event_collection_reference(reference)),
 held boolean not null,
 next_page integer not null default 1 check(next_page>=1),
 collected_pages integer not null default 0 check(collected_pages>=0),
 lease_pages integer not null default 0 check(lease_pages between 0 and 5),
 cursor text check(cursor is null or length(cursor) between 1 and 2048),
 last_page integer,
 last_hash text check(last_hash is null or last_hash~'^[a-f0-9]{64}$'),
 last_lease uuid,last_global uuid,
 check(held=(reference->>'lane' in('ranking_all','ranking_musical')))
);
-- 공개 공급사 원천의 선택 상세만 보관한다. 회원 원문/응답/오류 로그는 저장하지 않는다.
create table private.event_source_details (
 source_event_id uuid primary key references private.source_events(id) on delete cascade,
 source_collected_at timestamptz not null,
 collected_at timestamptz not null,
 detail jsonb not null
);
create function private.valid_event_source_detail(p_detail jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare d jsonb:=p_detail;k text;u text;begin
 if d is null or jsonb_typeof(d)<>'object' or octet_length(d::text)>65536
  or not d ?& array['provider','sourceId','collectedAt']
  or d-array['provider','sourceId','collectedAt','admission','operatingInfo','description','posterUrl']<>'{}'::jsonb
  or jsonb_typeof(d->'provider')<>'string' or d->>'provider' not in('kopis','tour-api')
  or jsonb_typeof(d->'sourceId')<>'string' or jsonb_typeof(d->'collectedAt')<>'string'
  or (d->>'provider'='kopis' and d->>'sourceId'!~'^PF[0-9A-Za-z]+$')
  or (d->>'provider'='tour-api' and d->>'sourceId'!~'^[0-9]{1,20}$') then return false;end if;
 perform private.event_instant_v1(d->>'collectedAt');
 if d ? 'admission' then
  if jsonb_typeof(d->'admission')<>'object' then return false;end if;
  if d#>>'{admission,kind}'='free' then
   if d->'admission'<>'{"kind":"free"}'::jsonb then return false;end if;
  elsif d#>>'{admission,kind}'='described' then
   if not(d->'admission') ?& array['kind','text'] or (d->'admission')-array['kind','text']<>'{}'::jsonb
    or jsonb_typeof(d#>'{admission,text}')<>'string' or not private.event_public_text_v1(d#>>'{admission,text}',10000) then return false;end if;
  else return false;end if;
 end if;
 foreach k in array array['operatingInfo','description','posterUrl'] loop
  if d ? k and (jsonb_typeof(d->k)<>'string' or not private.event_public_text_v1(d->>k,10000)) then return false;end if;
 end loop;
 if d ? 'posterUrl' then
  u:=d->>'posterUrl';
  if length(u)>2048 or u !~ '^https://(www\.)?kopis\.or\.kr/upload/[^?#[:space:][:cntrl:]<>"\\]+$' then return false;end if;
 end if;
 return true;
exception when invalid_parameter_value or invalid_datetime_format or datetime_field_overflow then return false;
end;$$;
alter table private.event_source_details add constraint event_source_detail_valid check(private.valid_event_source_detail(detail));
create function private.event_detail_fields(p_event jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select coalesce(jsonb_object_agg(k,v),'{}'::jsonb)from jsonb_each(p_event)x(k,v)
 where k=any(array['operatingInfo','description','posterUrl']);
$$;

-- 제어와 실제 서비스 EXECUTE가 모두 준비돼야 기존 일정에 행사 후보가 나타난다.
create function private.event_collection_ready() returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare sig text;f regprocedure;enabled boolean;begin
 select c.enabled into enabled from private.event_collection_control c where singleton for share;
 if enabled is distinct from true or (select c.enabled from private.worker_runtime_atomic_control c where singleton) is distinct from true then return false;end if;
 foreach sig in array array[
  'public.read_event_collection_contract()',
  'public.register_event_collection_jobs(text,date,jsonb,boolean,jsonb)',
  'public.claim_event_collection(text,text,jsonb,uuid,integer,text,text)',
  'public.commit_event_collection_page(uuid,uuid,uuid,integer,jsonb,boolean,jsonb,jsonb)',
  'public.store_event_source_detail(jsonb,uuid,uuid,uuid,text,boolean)',
  'public.next_event_collection_reference(uuid,jsonb)',
  'public.list_ongoing_event_source_ids(text,text,integer)',
  'public.settle_event_collection(uuid,uuid,uuid,text,text,boolean,integer,integer)'] loop
  f:=to_regprocedure(sig);
  if f is null or not has_function_privilege('service_role',f,'EXECUTE') then return false;end if;
 end loop;
 return true;
end;$$;
create function private.assert_event_collection() returns void
language plpgsql volatile security definer set search_path='' as $$begin
 if auth.role() is distinct from 'service_role' then raise exception 'worker_required' using errcode='42501';end if;
 if not private.event_collection_ready() then raise exception 'event_collection_not_ready' using errcode='55000';end if;
end;$$;
create function private.assert_event_run(p_token uuid) returns void
language plpgsql volatile security definer set search_path='' as $$begin
 perform private.assert_current_worker_run(p_token);
 if exists(select 1 from private.global_worker_run where singleton and expires_at>clock_timestamp()+interval '180 seconds')then
  raise exception 'event_run_limit'using errcode='40001';end if;
end;$$;
create function public.read_event_collection_contract() returns jsonb
language plpgsql volatile security definer set search_path='' as $$begin
 if auth.role() is distinct from 'service_role' then raise exception 'worker_required' using errcode='42501';end if;
 return jsonb_build_object('version','2026-10-05','capabilities',case when private.event_collection_ready()
  then '["collection","collection_details","detail_jobs"]'::jsonb else '[]'::jsonb end);
end;$$;
create function private.add_event_collection_job(p_reference jsonb) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare j private.worker_jobs;inserted boolean;dedupe text;begin
 if not private.valid_event_collection_reference(p_reference) then raise exception 'invalid_event_reference' using errcode='22023';end if;
 dedupe:='event.'||encode(extensions.digest(p_reference::text,'sha256'),'hex');
 insert into private.worker_jobs(kind,dedupe_key,payload,available_at)
  values('event_sync',dedupe,p_reference,clock_timestamp()) on conflict(kind,dedupe_key) do nothing returning * into j;
 inserted:=found;
 if not inserted then
  select * into strict j from private.worker_jobs where kind='event_sync' and dedupe_key=dedupe for update;
  if j.payload is distinct from p_reference then raise exception 'event_reference_conflict' using errcode='40001';end if;
 end if;
 insert into private.event_collection_progress(job_id,reference,held)
  values(j.id,p_reference,p_reference->>'lane' in('ranking_all','ranking_musical')) on conflict(job_id) do nothing;
 if not exists(select 1 from private.event_collection_progress where job_id=j.id and reference=p_reference) then
  raise exception 'event_reference_conflict' using errcode='40001';end if;
 return inserted;
end;$$;

create function public.register_event_collection_jobs(p_provider text,p_registered_on date,p_references jsonb,
 p_detail_provider boolean,p_detail_source_ids jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare r jsonb;s private.source_events;sid jsonb;d date;created integer:=0;existing integer:=0;initial boolean;
 lane text;lo date;hi date;prev date;counted integer;begin
 perform private.assert_event_collection();
 if p_provider is null or p_provider not in('kopis','tour-api') then raise exception 'event_provider_not_ready' using errcode='55000';end if;
 if p_registered_on is null or p_registered_on<>(clock_timestamp() at time zone 'Asia/Seoul')::date
  or p_detail_provider is null or p_references is null or jsonb_typeof(p_references)<>'array'
  or jsonb_array_length(p_references)>100 or octet_length(p_references::text)>131072 then
  raise exception 'invalid_event_registration' using errcode='22023';end if;
 if (select count(distinct x) from jsonb_array_elements(p_references)x)<>jsonb_array_length(p_references) then
  raise exception 'invalid_event_registration' using errcode='22023';end if;
 for r in select value from jsonb_array_elements(p_references) loop
  if not private.valid_event_collection_reference(r) or r->>'provider'<>p_provider or r->>'lane'='detail' then
   raise exception 'invalid_event_registration' using errcode='22023';end if;
  if r->>'lane'='ongoing' and r->'period'<>jsonb_build_object('start',p_registered_on::text,'end',p_registered_on::text)
   or r->>'lane' in('ranking_all','ranking_musical') and r->'period'<>jsonb_build_object('start',(p_registered_on-7)::text,'end',(p_registered_on-1)::text) then
   raise exception 'invalid_event_registration' using errcode='22023';end if;
 end loop;
 if p_detail_source_ids is not null then
  if p_detail_provider is distinct from true or jsonb_typeof(p_detail_source_ids)<>'array' or jsonb_array_length(p_detail_source_ids)not between 1 and 100
   or jsonb_array_length(p_references)<>0 or (select count(distinct x)from jsonb_array_elements(p_detail_source_ids)x)<>jsonb_array_length(p_detail_source_ids) then
   raise exception 'invalid_event_registration' using errcode='22023';end if;
 else
  -- 조각 하나만 등록하고 초기 범위를 완료한 것처럼 표시하지 않는다.
  foreach lane in array array['initial_history','future'] loop
   lo:=case lane when 'initial_history' then (p_registered_on-interval '1 month')::date else p_registered_on end;
   hi:=case lane when 'initial_history' then p_registered_on-1 else p_registered_on+30 end;
   prev:=lo-1;counted:=0;
   for r in select value from jsonb_array_elements(p_references)where value->>'lane'=lane order by value#>>'{period,start}' loop
    if private.event_calendar_date_v1(r#>>'{period,start}')<>prev+1 then raise exception 'invalid_event_registration' using errcode='22023';end if;
    prev:=private.event_calendar_date_v1(r#>>'{period,end}');counted:=counted+1;
   end loop;
   if counted=0 or prev<>hi then raise exception 'invalid_event_registration' using errcode='22023';end if;
  end loop;
  if not exists(select 1 from jsonb_array_elements(p_references)x where x->>'lane'='ongoing') then raise exception 'invalid_event_registration' using errcode='22023';end if;
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_provider,111));
 initial:=exists(select 1 from private.event_collection_providers where provider=p_provider);
 if p_detail_source_ids is null then
  insert into private.event_collection_providers(provider,initial_registered_on)values(p_provider,p_registered_on)on conflict do nothing;
  for r in select value from jsonb_array_elements(p_references) order by value::text loop
   if initial and r->>'lane'='initial_history' then existing:=existing+1;
   elsif private.add_event_collection_job(r) then created:=created+1;else existing:=existing+1;end if;
  end loop;
 else
  for sid in select value from jsonb_array_elements(p_detail_source_ids)order by value::text loop
   if jsonb_typeof(sid)<>'string' then raise exception 'invalid_event_registration' using errcode='22023';end if;
   select * into s from private.source_events where provider=p_provider and source_id=sid#>>'{}';
   if not found then raise exception 'event_source_unavailable' using errcode='22023';end if;
   d:=(s.collected_at at time zone 'Asia/Seoul')::date;
   r:=jsonb_build_object('provider',p_provider,'lane','detail','sourceId',s.source_id,'sourceCollectedAt',s.record->>'collectedAt',
    'period',jsonb_build_object('start',d::text,'end',d::text));
   if private.add_event_collection_job(r)then created:=created+1;else existing:=existing+1;end if;
  end loop;
 end if;
 perform private.assert_event_collection();
 return jsonb_build_object('status','registered','createdCount',created,'existingCount',existing,
  'initialHistory',case when initial then 'already_registered' else 'registered' end);
end;$$;

create function public.next_event_collection_reference(p_worker_run_token uuid,p_excluded_references jsonb default '[]'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;n timestamptz;begin
 perform private.assert_event_run(p_worker_run_token);perform private.assert_event_collection();
 if p_excluded_references is null or jsonb_typeof(p_excluded_references)<>'array' or jsonb_array_length(p_excluded_references)>100
  or exists(select 1 from jsonb_array_elements(p_excluded_references)x where not private.valid_event_collection_reference(x))then
  raise exception 'invalid_event_exclusions' using errcode='22023';end if;
 n:=clock_timestamp();
 select p.reference into result from private.worker_jobs j join private.event_collection_progress p on p.job_id=j.id
  where j.kind='event_sync' and not p.held and
   ((j.status in('queued','retry_wait')and j.available_at<=n)or(j.status='running'and j.lease_expires_at<=n))
  and not exists(select 1 from jsonb_array_elements(p_excluded_references)x where x=p.reference)
  and ((select count(*)from private.worker_runtime_job_slots where global_token=p_worker_run_token)<20
   or exists(select 1 from private.worker_runtime_job_slots where global_token=p_worker_run_token and job_id=j.id))
  order by case when j.status='running'then j.lease_expires_at else j.available_at end,j.id limit 1;
 perform private.assert_event_run(p_worker_run_token);return result;
end;$$;
create function public.claim_event_collection(p_provider text,p_lane text,p_period jsonb,p_worker_run_token uuid,p_lease_seconds integer,
 p_source_id text default null,p_source_collected_at text default null) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare ref jsonb;j private.worker_jobs;p private.event_collection_progress;n timestamptz;expiry timestamptz;begin
 perform private.assert_event_run(p_worker_run_token);perform private.assert_event_collection();
 ref:=jsonb_build_object('provider',p_provider,'lane',p_lane,'period',p_period);
 if p_lane='detail'then ref:=ref||jsonb_build_object('sourceId',p_source_id,'sourceCollectedAt',p_source_collected_at);
 elsif p_source_id is not null or p_source_collected_at is not null then raise exception 'invalid_event_claim' using errcode='22023';end if;
 if p_lease_seconds is distinct from 180 or not private.valid_event_collection_reference(ref) then raise exception 'invalid_event_claim' using errcode='22023';end if;
 if p_lane in('ranking_all','ranking_musical') then return null;end if;
 n:=clock_timestamp();
 select w.* into j from private.worker_jobs w join private.event_collection_progress c on c.job_id=w.id
  where w.kind='event_sync'and c.reference=ref and not c.held
  and ((w.status in('queued','retry_wait')and w.available_at<=n)or(w.status='running'and w.lease_expires_at<=n))
  and ((select count(*)from private.worker_runtime_job_slots where global_token=p_worker_run_token)<20
   or exists(select 1 from private.worker_runtime_job_slots where global_token=p_worker_run_token and job_id=w.id))
  for update of w skip locked limit 1;
 if not found then return null;end if;
 select * into strict p from private.event_collection_progress where job_id=j.id for update;
 perform private.assert_event_run(p_worker_run_token);n:=clock_timestamp();
 select least(n+interval '180 seconds',expires_at) into expiry from private.global_worker_run where singleton;
 update private.worker_jobs set status='running',worker_id=p_worker_run_token,lease_token=gen_random_uuid(),lease_expires_at=expiry,
  attempt=attempt+1,updated_at=n where id=j.id returning *into j;
 insert into private.worker_job_run_fences(job_id,job_lease_token,worker_run_token)values(j.id,j.lease_token,p_worker_run_token)
  on conflict(job_id)do update set job_lease_token=excluded.job_lease_token,worker_run_token=excluded.worker_run_token;
 insert into private.worker_runtime_job_slots(global_token,job_id)values(p_worker_run_token,j.id)on conflict do nothing;
 if(select count(*)from private.worker_runtime_job_slots where global_token=p_worker_run_token)>20 then raise exception 'runtime_job_limit' using errcode='40001';end if;
 perform private.assert_current_worker_job(j.id,j.lease_token,p_worker_run_token);
 update private.event_collection_progress set lease_pages=0 where job_id=j.id;
 return p.reference||jsonb_build_object('jobId',j.id,'leaseToken',j.lease_token,'nextPage',p.next_page,'collectedPages',p.collected_pages,'cursor',p.cursor);
end;$$;

-- 호출자는 전역→job 잠금을 먼저 잡는다. source identity 정렬로 기존 저장 helper와 맞춘다.
create function private.merge_event_detail(p_source private.source_events,p_detail jsonb) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare old private.event_source_details;stamp timestamptz;merged jsonb;begin
 if not private.valid_event_source_detail(p_detail) or p_detail->>'provider'<>p_source.provider or p_detail->>'sourceId'<>p_source.source_id then
  raise exception 'invalid_event_detail' using errcode='22023';end if;
 -- 긴 가격 설명을 상세에만 적용하고 canonical의 과거 free 값을 성공으로 남기지 않는다.
 if p_detail#>>'{admission,kind}'='described'and length(p_detail#>>'{admission,text}')>2000 then
  raise exception 'event_detail_price_projection_not_ready' using errcode='55000';end if;
 stamp:=private.event_instant_v1(p_detail->>'collectedAt');
 select *into old from private.event_source_details where source_event_id=p_source.id for update;
 if found and old.collected_at>=stamp then return false;end if;
 merged:=coalesce(old.detail,'{}'::jsonb)||p_detail;
 insert into private.event_source_details(source_event_id,source_collected_at,collected_at,detail)
  values(p_source.id,p_source.collected_at,stamp,merged)on conflict(source_event_id)do update
  set source_collected_at=excluded.source_collected_at,collected_at=excluded.collected_at,detail=excluded.detail;
 -- 기존 canonical 가격 검증은 완화하지 않으며 새 가격과 상세를 한 트랜잭션에서 적용한다.
 if p_detail ? 'admission'then
  update private.source_events set record=jsonb_set(record,'{admission}',p_detail->'admission')where id=p_source.id;
 end if;
 return true;
end;$$;
create function public.commit_event_collection_page(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_expected_next_page integer,
 p_events jsonb,p_preserve_missing boolean,p_detail_references jsonb,p_next jsonb) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare j private.worker_jobs;p private.event_collection_progress;e jsonb;base jsonb;batch jsonb:='[]';detail jsonb;r jsonb;
 s private.source_events;old private.source_events;hash text;n timestamptz;begin
 perform private.assert_event_run(p_worker_run_token);perform private.assert_event_collection();
 select *into j from private.worker_jobs where id=p_job_id for update;
 select *into p from private.event_collection_progress where job_id=p_job_id for update;
 if j.id is null or p.job_id is null or j.kind<>'event_sync' or p.reference->>'lane' not in('initial_history','future','ongoing') then
  raise exception 'invalid_event_page' using errcode='22023';end if;
 if p_preserve_missing is distinct from true or p_expected_next_page is null or p_expected_next_page<1
  or p_events is null or jsonb_typeof(p_events)<>'array' or jsonb_array_length(p_events)>100 or octet_length(p_events::text)>8388608
  or p_detail_references is null or jsonb_typeof(p_detail_references)<>'array' or jsonb_array_length(p_detail_references)>100
  or (select count(distinct x)from jsonb_array_elements(p_detail_references)x)<>jsonb_array_length(p_detail_references)then
  raise exception 'invalid_event_page' using errcode='22023';end if;
 if p_next is not null and p_next<>'null'::jsonb and
  (jsonb_typeof(p_next)<>'object' or not p_next ?& array['page','cursor'] or p_next-array['page','cursor']<>'{}'::jsonb
  or jsonb_typeof(p_next->'page')<>'number' or p_next->>'page'<>(p_expected_next_page::bigint+1)::text
  or jsonb_typeof(p_next->'cursor')<>'string' or length(p_next->>'cursor')not between 1 and 2048)then
  raise exception 'invalid_event_page' using errcode='22023';end if;
 hash:=encode(extensions.digest(jsonb_build_array(p_events,p_detail_references,p_next)::text,'sha256'),'hex');
 if p.last_page=p_expected_next_page and p.last_lease=p_lease_token and p.last_global=p_worker_run_token and p.last_hash is distinct from hash then
  raise exception 'event_page_conflict' using errcode='40001';end if;
 if p.last_page=p_expected_next_page and p.last_hash=hash and p.last_lease=p_lease_token and p.last_global=p_worker_run_token then
  perform private.assert_event_run(p_worker_run_token);return jsonb_build_object('status','applied');end if;
 if j.status<>'running' or j.lease_token is distinct from p_lease_token or j.lease_expires_at<=clock_timestamp()
  or not exists(select 1 from private.worker_job_run_fences where job_id=j.id and job_lease_token=p_lease_token and worker_run_token=p_worker_run_token)then
  return jsonb_build_object('status','lease_lost');end if;
 if p.next_page<>p_expected_next_page then raise exception 'event_page_conflict' using errcode='40001';end if;
 if p_next is not null and p_next<>'null'::jsonb and p_next->>'cursor'=p.cursor then
  raise exception 'invalid_event_page'using errcode='22023';end if;
 if p.lease_pages>=5 then raise exception 'event_page_limit'using errcode='40001';end if;
 for e in select value from jsonb_array_elements(p_events)order by value->>'provider',value->>'sourceId' loop
  if e->>'provider' is distinct from p.reference->>'provider'
   or(p.reference->>'provider'='kopis'and e->>'sourceId'!~'^PF[0-9A-Za-z]+$')
   or(p.reference->>'provider'='tour-api'and e->>'sourceId'!~'^[0-9]{1,20}$')then raise exception 'invalid_event_page' using errcode='22023';end if;
  base:=e-array['operatingInfo','description','posterUrl'];
  if not private.valid_source_event_v2(base) then raise exception 'invalid_event_page' using errcode='22023';end if;
  detail:=jsonb_build_object('provider',e->>'provider','sourceId',e->>'sourceId','collectedAt',e->>'collectedAt');
  if e ?| array['operatingInfo','description','posterUrl']then
   detail:=detail||private.event_detail_fields(e);if not private.valid_event_source_detail(detail)then raise exception 'invalid_event_detail' using errcode='22023';end if;
  end if;
  -- 누락 identity INSERT 경합도 실제 승자 행을 잠근 뒤 unknown 가격 보존을 판정한다.
  insert into private.source_events(provider,source_id,collected_at,record)
   values(base->>'provider',base->>'sourceId',private.event_instant_v1(base->>'collectedAt'),base)on conflict(provider,source_id)do nothing;
  select *into old from private.source_events where provider=e->>'provider'and source_id=e->>'sourceId'for update;
  if found and base#>>'{admission,kind}'='unknown'and old.record#>>'{admission,kind}'<>'unknown'then
   base:=jsonb_set(base,'{admission}',old.record->'admission');end if;
  batch:=batch||jsonb_build_array(base);
 end loop;
 -- 전체 배치 검증/중복 identity와 insert/update는 기존 helper의 계약을 보존한다.
 perform private.upsert_canonical_events(batch);
 for e in select value from jsonb_array_elements(p_events)order by value->>'provider',value->>'sourceId' loop
  select *into strict s from private.source_events where provider=e->>'provider'and source_id=e->>'sourceId'for update;
  if s.collected_at=private.event_instant_v1(e->>'collectedAt') and e ?| array['operatingInfo','description','posterUrl']then
   detail:=jsonb_build_object('provider',e->>'provider','sourceId',e->>'sourceId','collectedAt',e->>'collectedAt')
    ||private.event_detail_fields(e);
   perform private.merge_event_detail(s,detail);
  end if;
 end loop;
 for r in select value from jsonb_array_elements(p_detail_references)order by value::text loop
  if not private.valid_event_collection_reference(r)or r->>'lane'<>'detail' or r->>'provider'<>p.reference->>'provider'
   or not exists(select 1 from jsonb_array_elements(p_events)event_value where event_value->>'provider'=r->>'provider'
    and event_value->>'sourceId'=r->>'sourceId'and event_value->>'collectedAt'=r->>'sourceCollectedAt')then
   raise exception 'invalid_event_detail_reference' using errcode='22023';end if;
  if exists(select 1 from private.source_events where provider=r->>'provider'and source_id=r->>'sourceId'
   and record->>'collectedAt'=r->>'sourceCollectedAt')then perform private.add_event_collection_job(r);end if;
 end loop;
 perform private.assert_current_worker_job(j.id,p_lease_token,p_worker_run_token);n:=clock_timestamp();
 update private.event_collection_progress set collected_pages=collected_pages+1,lease_pages=lease_pages+1,next_page=p_expected_next_page+1,
  cursor=case when p_next is null or p_next='null'::jsonb then null else p_next->>'cursor'end,
  last_page=p_expected_next_page,last_hash=hash,last_lease=p_lease_token,last_global=p_worker_run_token where job_id=j.id;
 if p_next is null or p_next='null'::jsonb then
  update private.worker_jobs set status='succeeded',worker_id=null,lease_token=null,lease_expires_at=null,completed_at=n,updated_at=n where id=j.id;
  delete from private.worker_job_run_fences where job_id=j.id;
 end if;
 perform private.assert_event_run(p_worker_run_token);return jsonb_build_object('status','applied');
end;$$;

create function public.store_event_source_detail(p_detail jsonb,p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid,
 p_source_collected_at text,p_preserve_missing boolean) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare j private.worker_jobs;p private.event_collection_progress;s private.source_events;result text;stamp timestamptz;n timestamptz;begin
 perform private.assert_event_run(p_worker_run_token);perform private.assert_event_collection();
 if p_preserve_missing is distinct from true or not private.valid_event_source_detail(p_detail)then raise exception 'invalid_event_detail' using errcode='22023';end if;
 select *into j from private.worker_jobs where id=p_job_id for update;
 select *into p from private.event_collection_progress where job_id=p_job_id for update;
 if j.id is null or p.job_id is null or j.kind<>'event_sync'or p.reference->>'lane'<>'detail'
  or p.reference->>'sourceCollectedAt' is distinct from p_source_collected_at
  or p.reference->>'provider' is distinct from p_detail->>'provider'or p.reference->>'sourceId' is distinct from p_detail->>'sourceId'then
  raise exception 'invalid_event_detail_reference' using errcode='22023';end if;
 if j.status<>'running'or j.lease_token is distinct from p_lease_token or j.lease_expires_at<=clock_timestamp()
  or not exists(select 1 from private.worker_job_run_fences where job_id=j.id and job_lease_token=p_lease_token and worker_run_token=p_worker_run_token)then
  return jsonb_build_object('status','lease_lost');end if;
 select *into s from private.source_events where provider=p_detail->>'provider'and source_id=p_detail->>'sourceId'for update;
 stamp:=private.event_instant_v1(p_source_collected_at);
 if s.id is null or s.collected_at<>stamp then result:='superseded';
 elsif private.event_instant_v1(p_detail->>'collectedAt')<stamp then raise exception 'invalid_event_detail' using errcode='22023';
 elsif private.merge_event_detail(s,p_detail)then result:='applied';else result:='stale';end if;
 perform private.assert_current_worker_job(j.id,p_lease_token,p_worker_run_token);n:=clock_timestamp();
 update private.worker_jobs set status=case when result='superseded'then 'superseded'else 'succeeded'end,
  worker_id=null,lease_token=null,lease_expires_at=null,completed_at=n,updated_at=n where id=j.id;
 delete from private.worker_job_run_fences where job_id=j.id;
 perform private.assert_event_run(p_worker_run_token);return jsonb_build_object('status',result);
end;$$;
create function public.list_ongoing_event_source_ids(p_provider text,p_cursor text default null,p_limit integer default 10)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare ids jsonb;next text;n timestamptz:=clock_timestamp();today date;begin
 perform private.assert_event_collection();
 if p_provider is null or p_provider not in('kopis','tour-api')or p_limit is null or p_limit not between 1 and 10
  or p_cursor is not null and ((p_provider='kopis'and p_cursor!~'^PF[0-9A-Za-z]+$')or(p_provider='tour-api'and p_cursor!~'^[0-9]{1,20}$'))then
  raise exception 'invalid_ongoing_cursor' using errcode='22023';end if;
 today:=(n at time zone 'Asia/Seoul')::date;
 with candidates as(
  select source_id from private.source_events where provider=p_provider and record->>'sourceStatus'='active'
   and ((record->>'precision'='date'and private.event_calendar_date_v1(record->>'startsOn')<=today and private.event_calendar_date_v1(record->>'endsOn')>=today)
    or(record->>'precision'='instant'and private.event_instant_v1(record->>'startsAt')<=n and private.event_instant_v1(record->>'endsAt')>n))
   and ((p_provider='kopis'and source_id~'^PF[0-9A-Za-z]+$')or(p_provider='tour-api'and source_id~'^[0-9]{1,20}$'))
   and(p_cursor is null or source_id collate "C">p_cursor collate "C")order by source_id collate "C"limit p_limit+1
 ), numbered as(select source_id,row_number()over(order by source_id collate "C")pos from candidates)
 select coalesce(jsonb_agg(source_id order by source_id collate "C")filter(where pos<=p_limit),'[]'::jsonb),
  case when count(*)>p_limit then max(source_id)filter(where pos=p_limit)end into ids,next from numbered;
 return jsonb_build_object('sourceIds',ids,'nextCursor',next);
end;$$;
create function public.settle_event_collection(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_outcome text,
 p_error_code text,p_retryable boolean,p_retry_floor_seconds integer,p_retry_cap_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare j private.worker_jobs;p private.event_collection_progress;n timestamptz;v_status text;delay integer;begin
 perform private.assert_event_run(p_worker_run_token);perform private.assert_event_collection();
 if p_outcome is null or p_outcome not in('yielded','provider_failed','superseded')or p_retryable is null
  or p_retry_floor_seconds is distinct from 600 or p_retry_cap_seconds is distinct from 21600
  or(p_outcome<>'provider_failed'and(p_error_code is not null or p_retryable))
  or(p_outcome='provider_failed'and(p_error_code is null or p_error_code not in('INVALID_EVENT_REQUEST','EVENT_PROVIDER_UNCONFIGURED',
   'SOURCE_AUTH_REJECTED','SOURCE_RATE_LIMITED','SOURCE_REJECTED','SOURCE_UNAVAILABLE','SOURCE_INVALID_RESPONSE','SOURCE_TIMEOUT','CANCELLED',
   'PROVIDER_PAGE_LIMIT','EVENT_COLLECTION_UNAVAILABLE','EVENT_DETAIL_UNAVAILABLE','EVENT_RANKING_UNAVAILABLE')))
  or(p_outcome='provider_failed'and p_retryable is distinct from(p_error_code in('SOURCE_RATE_LIMITED','SOURCE_UNAVAILABLE','SOURCE_TIMEOUT')))then
  raise exception 'invalid_event_settlement' using errcode='22023';end if;
 select *into j from private.worker_jobs where id=p_job_id for update;
 select *into p from private.event_collection_progress where job_id=p_job_id for update;
 if j.id is null or p.job_id is null or j.kind<>'event_sync'then raise exception 'invalid_event_settlement' using errcode='22023';end if;
 if j.status<>'running'or j.lease_token is distinct from p_lease_token or j.lease_expires_at<=clock_timestamp()
  or not exists(select 1 from private.worker_job_run_fences where job_id=j.id and job_lease_token=p_lease_token and worker_run_token=p_worker_run_token)then
  return jsonb_build_object('status','lease_lost');end if;
 if p_outcome='superseded'and p.reference->>'lane'not in('ranking_all','ranking_musical')then raise exception 'invalid_event_settlement' using errcode='22023';end if;
 n:=clock_timestamp();v_status:=case when p_outcome='yielded'then 'queued'when p_outcome='superseded'then 'superseded'
  when p_retryable then 'retry_wait'else 'failed'end;
 delay:=least(21600,600*(2^least(j.failed_attempts,6))::integer);
 update private.worker_jobs set status=v_status,worker_id=null,lease_token=null,lease_expires_at=null,
  available_at=case when v_status='retry_wait'then n+make_interval(secs=>delay)else n end,
  failed_attempts=failed_attempts+case when p_outcome='provider_failed'then 1 else 0 end,
  last_error_code=case when p_outcome='provider_failed'then case p_error_code when 'SOURCE_RATE_LIMITED'then 'RATE_LIMITED'
   when 'SOURCE_TIMEOUT'then 'TIMEOUT'else 'UPSTREAM_UNAVAILABLE'end else null end,
  completed_at=case when v_status in('failed','superseded')then n else null end,updated_at=n where id=j.id;
 delete from private.worker_job_run_fences where job_id=j.id;
 if v_status in('failed','superseded')then update private.event_collection_progress set cursor=null where job_id=j.id;end if;
 perform private.assert_event_run(p_worker_run_token);return jsonb_build_object('status',v_status);
end;$$;
create function public.complete_event_ranking_collection(p_job_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_period jsonb,p_snapshot jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_required' using errcode='42501';end if;
 -- 기존 requested-only 순위 저장소와 공개 보류를 우회하지 않는다.
 raise exception 'KOPIS_RANKING_PROVIDER_VERIFICATION_PENDING' using errcode='55000';
end;$$;

-- 기존 event_sync 일정의 job ID를 그대로 사용한다. 보류/권한 닫힘은 읽기에서 숨긴다.
do $$declare sig text;definition text;body text;anchor text:='j.kind in(''review_summary'',''event_sync'')';replacement text;begin
 replacement:=anchor||' and (j.kind<>''event_sync'' or (private.event_collection_ready() and exists(select 1 from private.event_collection_progress ep where ep.job_id=j.id and not ep.held)))';
 foreach sig in array array['public.read_worker_queue_schedule(text[],text)','public.read_worker_owned_queue_schedule(uuid,text[],text)']loop
  select prosrc,pg_get_functiondef(oid)into strict body,definition from pg_proc where oid=sig::regprocedure;
  if(length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then raise exception 'event_schedule_anchor_changed'using errcode='55000';end if;
  execute replace(definition,body,replace(body,anchor,replacement));
 end loop;
end;$$;

-- 같은 신뢰 owner와 FORCE RLS 안전성/최소 ACL을 사용한다. 운영 GRANT/제어 변경은 하지 않는다.
do $$declare own text;t regclass;f record;r text;sig text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 if not exists(select 1 from pg_roles where rolname=own and(rolsuper or rolbypassrls))then raise exception 'event_lane_owner_incompatible'using errcode='55000';end if;
 foreach r in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  if pg_has_role(r,own,'USAGE')or pg_has_role(r,own,'SET')then raise exception 'event_lane_owner_incompatible'using errcode='55000';end if;
 end loop;
 foreach sig in array array['auth.role()','private.assert_current_worker_run(uuid)',
  'private.assert_current_worker_job(uuid,uuid,uuid)','private.valid_source_event_v2(jsonb)',
  'private.event_calendar_date_v1(text)','private.event_instant_v1(text)','private.event_public_text_v1(text,integer)',
  'private.upsert_canonical_events(jsonb)','private.notify_worker_queue_changed()']loop
  if not has_function_privilege(own,sig,'EXECUTE')then raise exception 'event_lane_owner_incompatible'using errcode='55000';end if;
 end loop;
 foreach t in array array['private.worker_jobs'::regclass,'private.source_events'::regclass,
  'private.worker_job_run_fences'::regclass,'private.worker_runtime_job_slots'::regclass]loop
  if not has_table_privilege(own,t,'SELECT')or not has_table_privilege(own,t,'INSERT')or not has_table_privilege(own,t,'UPDATE')then
   raise exception 'event_lane_owner_incompatible'using errcode='55000';end if;
 end loop;
 if not has_table_privilege(own,'private.worker_job_run_fences','DELETE')or not has_table_privilege(own,'private.global_worker_run','SELECT')
  or not has_table_privilege(own,'private.global_worker_run','UPDATE')then raise exception 'event_lane_owner_incompatible'using errcode='55000';end if;
 foreach t in array array['private.event_collection_control'::regclass,'private.event_collection_providers'::regclass,
  'private.event_collection_progress'::regclass,'private.event_source_details'::regclass]loop
  execute format('alter table %s owner to %I',t,own);execute format('alter table %s enable row level security',t);
  execute format('alter table %s force row level security',t);
  execute format('revoke all on %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',t);
 end loop;
 for f in select oid::regprocedure sig from pg_proc where pronamespace in('private'::regnamespace,'public'::regnamespace)
  and proname in('valid_event_collection_reference','valid_event_source_detail','event_detail_fields','event_collection_ready','assert_event_collection','assert_event_run',
  'add_event_collection_job','merge_event_detail','read_event_collection_contract','register_event_collection_jobs',
  'next_event_collection_reference','claim_event_collection','commit_event_collection_page','store_event_source_detail',
  'list_ongoing_event_source_ids','settle_event_collection','complete_event_ranking_collection')loop
  execute format('alter function %s owner to %I',f.sig,own);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.sig);
 end loop;
end;$$;
create trigger event_lane_control_changed after update of enabled on private.event_collection_control
 for each statement execute function private.notify_worker_queue_changed();
commit;
