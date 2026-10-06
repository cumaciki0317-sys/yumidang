-- 민규: 유효한 최종종결 신고의 상세·증거 파기 후보. 실제 SQL/Provider 검증 NOT_RUN.
-- 최종종결 권한·일반 이의 기한·숨김 파기 후 정책·제재 상세 파기는 생성하지 않는다.
begin;
create temp table report_purge_function_baseline on commit drop as
 select oid,proowner,proacl::text acl,proconfig::text config,prosrc from pg_proc
 where oid in('public.get_my_report(uuid)'::regprocedure,'private.assert_current_worker_job(uuid,uuid,uuid)'::regprocedure,
 'private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure);
do $$declare own text;g text;t text;f record;begin
 select pg_get_userbyid(proowner)into strict own from report_purge_function_baseline where oid='public.get_my_report(uuid)'::regprocedure;
 if not exists(select 1 from pg_roles where rolname=own and(rolsuper or rolbypassrls))then raise exception 'report_purge_owner_incompatible'using errcode='55000';end if;
 foreach g in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  if pg_has_role(g,own,'USAGE')or pg_has_role(g,own,'SET')then raise exception 'report_purge_owner_incompatible'using errcode='55000';end if;
 end loop;
 foreach g in array array['private','public','auth','storage']loop
  if not has_schema_privilege(own,g,'USAGE')then raise exception 'report_purge_owner_permissions_invalid'using errcode='55000';end if;
 end loop;
 foreach t in array array['private.member_reports','private.report_capture_assets','private.safety_incident_report_links','private.safety_incident_revisions',
 'private.safety_sanction_applications','private.safety_incidents','private.safety_appeals','private.appointment_review_holds','private.worker_jobs','storage.objects']loop
 if not has_table_privilege(own,t,'SELECT')then raise exception 'report_purge_owner_permissions_invalid'using errcode='55000';end if;
 if t in('private.safety_incident_report_links','private.safety_incidents','private.safety_incident_revisions',
 'private.safety_sanction_applications','private.safety_appeals','private.appointment_review_holds')
 and not(has_table_privilege(own,t,'UPDATE')or has_table_privilege(own,t,'DELETE')or has_table_privilege(own,t,'TRUNCATE'))then
  raise exception 'report_purge_owner_permissions_invalid'using errcode='55000';end if;
 end loop;
 if not has_table_privilege(own,'private.member_reports','DELETE')or not has_table_privilege(own,'private.report_capture_assets','DELETE')
 or not has_table_privilege(own,'private.member_reports','UPDATE')or not has_table_privilege(own,'private.report_capture_assets','UPDATE')
 or not has_table_privilege(own,'storage.objects','UPDATE')or not has_table_privilege(own,'private.worker_jobs','UPDATE')
 or not has_table_privilege(own,'private.worker_jobs','INSERT')or not has_function_privilege(own,'private.assert_current_worker_job(uuid,uuid,uuid)','EXECUTE')
 or not has_function_privilege(own,'private.assert_current_worker_run(uuid)','EXECUTE')
 or not has_function_privilege(own,'public.complete_job(uuid,uuid,uuid)','EXECUTE')or not has_function_privilege(own,'auth.role()','EXECUTE')then
  raise exception 'report_purge_owner_permissions_invalid'using errcode='55000';end if;
end;$$;

create table private.report_purge_control(singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into private.report_purge_control values(true,false);
create table private.report_purge_closures(
 id uuid primary key default gen_random_uuid(),report_id uuid not null unique references private.member_reports(id)on delete cascade,
 closure_revision bigint not null check(closure_revision between 1 and 9007199254740991),
 final_closed_at timestamptz not null,retention_due_at timestamptz not null,
 metadata_sha256 text not null check(metadata_sha256~'^[a-f0-9]{64}$'),created_at timestamptz not null default clock_timestamp(),
 check(isfinite(final_closed_at)and retention_due_at=final_closed_at+interval '2160 hours'));
create table private.report_purge_tasks(
 id uuid primary key default gen_random_uuid(),closure_id uuid not null references private.report_purge_closures(id)on delete cascade,
 kind text not null check(kind in('storage_object','report_metadata')),
 asset_id uuid,object_id uuid,bucket_id text,object_name text,
 state text not null default 'pending'check(state in('pending','running','completed')),
 lease_token uuid,lease_expires_at timestamptz,job_id uuid,job_lease_token uuid,worker_run_token uuid,
 completed_at timestamptz,evidence_sha256 text check(evidence_sha256~'^[a-f0-9]{64}$'),
 constraint report_purge_task_target check(
  (kind='storage_object'and asset_id is not null and object_id is not null and bucket_id='report-evidence'and object_name is not null
   and octet_length(object_name)between 1 and 1024 and object_name!~'[[:cntrl:]]'and position(chr(92)in object_name)=0
   and object_name!~'(^|/)([.]{1,2})?(/|$)')or
  (kind='report_metadata'and asset_id is null and object_id is null and bucket_id is null and object_name is null)),
 check((state in('running','completed'))=(lease_token is not null and lease_expires_at is not null and job_id is not null and job_lease_token is not null and worker_run_token is not null)),
 check((state='completed')=(completed_at is not null and evidence_sha256 is not null)));
create unique index report_purge_one_metadata on private.report_purge_tasks(closure_id)where kind='report_metadata';
create unique index report_purge_one_asset on private.report_purge_tasks(closure_id,asset_id)where kind='storage_object';
create unique index report_purge_reserved_name on private.report_purge_tasks(bucket_id,object_name)where kind='storage_object';
create table private.report_purge_delete_acks(
 id uuid primary key default gen_random_uuid(),task_id uuid not null unique references private.report_purge_tasks(id)on delete cascade,
 asset_id uuid not null,object_id uuid not null,ack_sha256 text not null check(ack_sha256~'^[a-f0-9]{64}$'),
 recorded_at timestamptz not null default clock_timestamp());
-- 기존 작업 상세 30일 정책에 따른 완료 증거. 보고서 경로·원문·제재 내용은 포함하지 않는다.
create table private.report_purge_terminal_receipts(
 task_id uuid primary key,job_id uuid not null unique,report_id uuid not null,closure_id uuid not null,
 task_lease_token uuid not null,job_lease_token uuid not null,evidence_sha256 text not null check(evidence_sha256~'^[a-f0-9]{64}$'),
 completed_at timestamptz not null,expires_at timestamptz not null,
 check(isfinite(completed_at)and expires_at=completed_at+interval '720 hours'));
create function private.report_purge_terminal_replay(p_task_id uuid,p_task_lease_token uuid,p_job_id uuid,p_job_lease_token uuid,p_global_token uuid,p_object_id uuid,p_evidence_sha256 text)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare receipt private.report_purge_terminal_receipts;j private.worker_jobs;begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_access_denied'using errcode='42501';end if;
 if (select enabled from private.report_purge_control where singleton)is distinct from true then raise exception 'report_purge_not_enabled'using errcode='55000';end if;
 perform private.assert_current_worker_run(p_global_token);
 select *into receipt from private.report_purge_terminal_receipts where task_id=p_task_id for share nowait;
 if not found then return null;end if;
 if receipt.expires_at<=clock_timestamp()then raise exception 'not_found'using errcode='PT404';end if;
 if p_object_id is not null or receipt.task_lease_token is distinct from p_task_lease_token or receipt.job_id is distinct from p_job_id
 or receipt.job_lease_token is distinct from p_job_lease_token or receipt.evidence_sha256 is distinct from p_evidence_sha256 then
  raise exception 'state_conflict'using errcode='40001';end if;
 select *into j from private.worker_jobs where id=receipt.job_id for share nowait;
 if not found or j.status<>'succeeded'or j.completed_at is distinct from receipt.completed_at or j.kind<>'report_retention'
 or j.payload is distinct from jsonb_build_object('reportId',receipt.report_id,'closureProofId',receipt.closure_id)then
  raise exception 'state_conflict'using errcode='40001';end if;
 perform private.assert_current_worker_run(p_global_token);
 if receipt.expires_at<=clock_timestamp()then raise exception 'not_found'using errcode='PT404';end if;
 return jsonb_build_object('taskId',receipt.task_id,'status','completed','alreadyApplied',true);
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
create function public.purge_report_retention_terminal_receipts(p_global_token uuid,p_limit integer default 20)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare removed integer;begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_access_denied'using errcode='42501';end if;
 if (select enabled from private.report_purge_control where singleton)is distinct from true then raise exception 'report_purge_not_enabled'using errcode='55000';end if;
 if p_limit is null or p_limit not between 1 and 20 then raise exception 'invalid_report_purge_limit'using errcode='22023';end if;
 perform private.assert_current_worker_run(p_global_token);
 with expired as(select task_id from private.report_purge_terminal_receipts where expires_at<=clock_timestamp()order by expires_at,task_id limit p_limit for update nowait)
 delete from private.report_purge_terminal_receipts r using expired e where r.task_id=e.task_id;
 get diagnostics removed=row_count;
 perform private.assert_current_worker_run(p_global_token);return jsonb_build_object('purged',removed);
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;

create function private.report_purge_eligible(p_report_id uuid)returns boolean
 language sql volatile security definer set search_path=''as $$
 select exists(select 1 from private.member_reports r where r.id=p_report_id and r.status='resolved'and r.final_closed_at is not null
  and isfinite(r.final_closed_at)and r.retention_due_at=r.final_closed_at+interval '2160 hours'and r.retention_due_at<=clock_timestamp()
  and r.review_version between 1 and 9007199254740991 and not r.hide_target
  and not exists(select 1 from private.appointment_review_holds h where h.report_id=r.id and h.state='reviewing')
  and not exists(select 1 from private.safety_appeals a where a.report_id=r.id and a.state='reviewing')
  and not exists(select 1 from private.safety_incident_report_links l join private.safety_sanction_applications s on s.incident_id=l.incident_id where l.report_id=r.id)
  and not exists(select 1 from private.safety_incident_report_links l join private.safety_incidents i on i.id=l.incident_id
   join private.safety_incident_revisions v on v.incident_id=i.id and v.revision=i.current_revision where l.report_id=r.id and v.state='reviewing'));
$$;
create function private.report_purge_snapshot(p_report_id uuid)returns text
 language sql stable security definer set search_path=''as $$
 select encode(sha256(convert_to(jsonb_build_array(r.id,r.review_version,r.status,r.final_closed_at,r.retention_due_at,r.hide_target,
  coalesce((select jsonb_agg(jsonb_build_array(a.id,a.owner_id,a.owner_episode_id,a.object_name,a.state)order by a.id)
   from private.report_capture_assets a where a.report_id=r.id),'[]'::jsonb))::text,'UTF8')),'hex')from private.member_reports r where r.id=p_report_id;
$$;
create function private.report_purge_assert_closure(p_closure_id uuid)returns private.report_purge_closures
 language plpgsql volatile security definer set search_path=''as $$
declare c private.report_purge_closures;r private.member_reports;begin
 select *into c from private.report_purge_closures where id=p_closure_id;
 if not found then raise exception 'state_conflict'using errcode='40001';end if;
 select *into r from private.member_reports where id=c.report_id for update nowait;
 -- 목적이 살아있는 제재·이의/hold가 검사 직후 추가되지 않도록 쓰기와 직렬화한다.
 -- 충돌은 대기하거나 권한을 넓히지 않고 현재 파기 TX 전체를 되돌린다.
 lock table private.safety_incident_report_links,private.safety_incidents,private.safety_incident_revisions,
  private.safety_sanction_applications,private.safety_appeals,private.appointment_review_holds in share mode nowait;
 if not found or not private.report_purge_eligible(c.report_id)or r.review_version<>c.closure_revision
 or r.final_closed_at is distinct from c.final_closed_at or r.retention_due_at is distinct from c.retention_due_at
 or private.report_purge_snapshot(c.report_id)is distinct from c.metadata_sha256 then raise exception 'report_purge_held'using errcode='55000';end if;
 -- 보고서 잠금 후 정확 캡처 행을 UUID 순서로 잠근다. 새 첨부의 FK도 보고서 UPDATE와 직렬화된다.
 perform 1 from private.report_capture_assets where report_id=c.report_id order by id for update nowait;
 if private.report_purge_snapshot(c.report_id)is distinct from c.metadata_sha256 then raise exception 'state_conflict'using errcode='40001';end if;
 return c;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
create function private.report_purge_worker(p_job_id uuid,p_job_lease_token uuid,p_global_token uuid,p_closure_id uuid)returns void
 language plpgsql volatile security definer set search_path=''as $$declare j private.worker_jobs;c private.report_purge_closures;begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_access_denied'using errcode='42501';end if;
 if (select enabled from private.report_purge_control where singleton)is distinct from true then raise exception 'report_purge_not_enabled'using errcode='55000';end if;
 perform private.assert_current_worker_job(p_job_id,p_job_lease_token,p_global_token);
 select *into j from private.worker_jobs where id=p_job_id for update nowait;
 select *into c from private.report_purge_closures where id=p_closure_id;
 if c.id is null or j.id is null or j.kind<>'report_retention'or j.payload is distinct from jsonb_build_object('reportId',c.report_id,'closureProofId',c.id)then
  raise exception 'state_conflict'using errcode='40001';end if;
 perform private.report_purge_assert_closure(c.id);
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
create function private.report_purge_task_dto(p_task private.report_purge_tasks)returns jsonb
 language sql stable security definer set search_path=''as $$
 select jsonb_build_object('taskId',p_task.id,'taskLeaseToken',p_task.lease_token,'taskExpiresAt',p_task.lease_expires_at,
 'reportId',c.report_id,'closureRevision',c.closure_revision,'kind',p_task.kind,'assetId',p_task.asset_id,'bucketId',p_task.bucket_id,
 'objectName',p_task.object_name,'objectId',p_task.object_id,'retentionDueAt',c.retention_due_at,'closureProofId',c.id)
 from private.report_purge_closures c where c.id=p_task.closure_id;
$$;
create function private.report_purge_assert_task(p_task_id uuid,p_task_lease_token uuid,p_job_id uuid,p_job_lease_token uuid,p_global_token uuid,p_object_id uuid)
 returns private.report_purge_tasks language plpgsql volatile security definer set search_path=''as $$declare t private.report_purge_tasks;begin
 select *into t from private.report_purge_tasks where id=p_task_id;
 if not found then raise exception 'state_conflict'using errcode='40001';end if;
 perform private.report_purge_worker(p_job_id,p_job_lease_token,p_global_token,t.closure_id);
 select *into t from private.report_purge_tasks where id=p_task_id for update nowait;
 if not found or t.state not in('running','completed')or t.lease_token is distinct from p_task_lease_token or t.job_id is distinct from p_job_id
 or t.job_lease_token is distinct from p_job_lease_token or t.worker_run_token is distinct from p_global_token or t.object_id is distinct from p_object_id
 or t.lease_expires_at is null or t.lease_expires_at<=clock_timestamp()then raise exception 'state_conflict'using errcode='40001';end if;
 if t.kind='storage_object'and exists(select 1 from storage.objects where bucket_id=t.bucket_id and name=t.object_name and id<>t.object_id)then
  raise exception 'state_conflict'using errcode='40001';end if;
 return t;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;

-- 물리 DELETE가 아닌 이름 재사용 방어다. SQL metadata DELETE를 외부 삭제 성공으로 가장하지 않는다.
create function private.protect_report_purge_object_name()returns trigger language plpgsql security definer set search_path=''as $$begin
 if new.bucket_id='report-evidence'and exists(select 1 from private.report_purge_tasks t where t.kind='storage_object'and t.bucket_id=new.bucket_id and t.object_name=new.name)then
  raise exception 'report_purge_name_reserved'using errcode='40001';end if;
 if tg_op='UPDATE'and old.bucket_id='report-evidence'and exists(select 1 from private.report_purge_tasks t where t.kind='storage_object'and t.bucket_id=old.bucket_id and t.object_name=old.name)then
  raise exception 'report_purge_name_reserved'using errcode='40001';end if;
 if new.bucket_id='report-evidence'or(tg_op='UPDATE'and old.bucket_id='report-evidence')then
  if not pg_try_advisory_xact_lock(hashtextextended('report_purge_name:'||new.bucket_id||':'||new.name,225107))then raise exception 'state_conflict'using errcode='40001';end if;
  if exists(select 1 from private.report_purge_tasks t where t.kind='storage_object'and t.bucket_id=new.bucket_id and t.object_name=new.name)then
   raise exception 'report_purge_name_reserved'using errcode='40001';end if;
 end if;
 return new;
end;$$;
create trigger report_purge_object_name before insert or update on storage.objects for each row execute function private.protect_report_purge_object_name();
create function private.protect_report_purge_parent_delete()returns trigger language plpgsql security definer set search_path=''as $$declare c uuid;begin
 select id into c from private.report_purge_closures where report_id=old.id;
 if c is not null and current_setting('yumidang.report_purge_finalizing',true)is distinct from c::text then
  raise exception 'report_purge_files_pending'using errcode='55000';end if;
 return old;
end;$$;
create trigger report_purge_parent_delete before delete on private.member_reports for each row execute function private.protect_report_purge_parent_delete();
create function private.protect_report_purge_reservation_delete()returns trigger language plpgsql security definer set search_path=''as $$begin
 if current_setting('yumidang.report_purge_finalizing',true)is distinct from old.closure_id::text then
  raise exception 'report_purge_reservation_pending'using errcode='55000';end if;
 return old;
end;$$;
create trigger report_purge_reservation_delete before delete on private.report_purge_tasks for each row execute function private.protect_report_purge_reservation_delete();

do $$declare old_kind text;old_payload text;begin
 select pg_get_expr(conbin,conrelid)into strict old_kind from pg_constraint where conrelid='private.worker_jobs'::regclass and conname='worker_jobs_kind_check';
 select pg_get_expr(conbin,conrelid)into strict old_payload from pg_constraint where conrelid='private.worker_jobs'::regclass and conname='worker_jobs_payload_check';
 if old_kind not like '%cancellation_safety%'or old_payload not like '%generation%'then raise exception 'report_purge_worker_source_changed'using errcode='55000';end if;
 alter table private.worker_jobs drop constraint worker_jobs_kind_check;
 execute format('alter table private.worker_jobs add constraint worker_jobs_kind_check check((%s)or kind=''report_retention'')',old_kind);
 alter table private.worker_jobs drop constraint worker_jobs_payload_check;
 execute format('alter table private.worker_jobs add constraint worker_jobs_payload_check check(case when kind=''report_retention''then coalesce(jsonb_typeof(payload)=''object''and payload ?& array[''reportId'',''closureProofId'']and payload-array[''reportId'',''closureProofId'']=''{}''::jsonb and jsonb_typeof(payload->''reportId'')=''string''and(payload->>''reportId'')~''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''and jsonb_typeof(payload->''closureProofId'')=''string''and(payload->>''closureProofId'')~''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'',false)else(%s)end)',old_payload);
end;$$;

create function public.enqueue_report_retention_purges(p_global_token uuid,p_limit integer default 20)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare r private.member_reports;a private.report_capture_assets;o storage.objects;c uuid;n integer:=0;begin
 if auth.role()is distinct from'service_role'then raise exception 'worker_access_denied'using errcode='42501';end if;
 if (select enabled from private.report_purge_control where singleton)is distinct from true then raise exception 'report_purge_not_enabled'using errcode='55000';end if;
 if p_limit is null or p_limit not between 1 and 20 then raise exception 'invalid_report_purge_limit'using errcode='22023';end if;
 perform private.assert_current_worker_run(p_global_token);
 for r in select *from private.member_reports where status='resolved'and retention_due_at<=clock_timestamp()
  and not exists(select 1 from private.report_purge_closures where report_id=private.member_reports.id)
  and private.report_purge_eligible(private.member_reports.id)order by retention_due_at,id limit p_limit for update nowait loop
  if not private.report_purge_eligible(r.id)then continue;end if;
  insert into private.report_purge_closures(report_id,closure_revision,final_closed_at,retention_due_at,metadata_sha256)
   values(r.id,r.review_version,r.final_closed_at,r.retention_due_at,private.report_purge_snapshot(r.id))returning id into c;
  for a in select *from private.report_capture_assets where report_id=r.id order by id for update nowait loop
   if a.state<>'attached'or not pg_try_advisory_xact_lock(hashtextextended('report_purge_name:report-evidence:'||a.object_name,225107))then
    raise exception 'state_conflict'using errcode='40001';end if;
   select *into o from storage.objects where bucket_id='report-evidence'and name=a.object_name for update nowait;
   if not found or o.owner_id is distinct from a.owner_id::text then raise exception 'report_purge_object_unproven'using errcode='55000';end if;
   insert into private.report_purge_tasks(closure_id,kind,asset_id,object_id,bucket_id,object_name)values(c,'storage_object',a.id,o.id,o.bucket_id,o.name);
  end loop;
  insert into private.report_purge_tasks(closure_id,kind)values(c,'report_metadata');
  insert into private.worker_jobs(kind,dedupe_key,payload,available_at)values('report_retention','report_retention:'||c::text,jsonb_build_object('reportId',r.id,'closureProofId',c),clock_timestamp());
  perform private.report_purge_assert_closure(c);
  n:=n+1;
 end loop;
 perform private.assert_current_worker_run(p_global_token);return jsonb_build_object('enqueued',n);
exception when lock_not_available or unique_violation then raise exception 'state_conflict'using errcode='40001';end;$$;
create function public.claim_report_retention_task(p_job_id uuid,p_job_lease_token uuid,p_global_token uuid)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare c uuid;t private.report_purge_tasks;deadline timestamptz;begin
 select(payload->>'closureProofId')::uuid into c from private.worker_jobs where id=p_job_id;
 perform private.report_purge_worker(p_job_id,p_job_lease_token,p_global_token,c);
 select *into t from private.report_purge_tasks candidate where closure_id=c and(state='pending'or(state='running'and lease_expires_at<=clock_timestamp()))
  and(kind='storage_object'or not exists(select 1 from private.report_purge_tasks child where child.closure_id=c and child.kind='storage_object'and child.state<>'completed'))
  order by case kind when 'storage_object'then 0 else 1 end,id limit 1 for update nowait;
 if not found then return null;end if;
 select least(clock_timestamp()+interval '60 seconds',j.lease_expires_at,g.expires_at)into deadline from private.worker_jobs j cross join private.global_worker_run g where j.id=p_job_id and g.singleton;
 if deadline<=clock_timestamp()then raise exception 'state_conflict'using errcode='40001';end if;
 update private.report_purge_tasks set state='running',lease_token=gen_random_uuid(),lease_expires_at=deadline,job_id=p_job_id,job_lease_token=p_job_lease_token,worker_run_token=p_global_token where id=t.id returning *into t;
 perform private.report_purge_assert_task(t.id,t.lease_token,p_job_id,p_job_lease_token,p_global_token,t.object_id);
 return private.report_purge_task_dto(t);
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
create function public.check_report_retention_task(p_task_id uuid,p_task_lease_token uuid,p_job_id uuid,p_job_lease_token uuid,p_global_token uuid,p_object_id uuid)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare t private.report_purge_tasks;begin
 t:=private.report_purge_assert_task(p_task_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token,p_object_id);return private.report_purge_task_dto(t);end;$$;
create function private.report_purge_ack_dto(p_ack private.report_purge_delete_acks)returns jsonb language sql immutable set search_path=''as $$
 select jsonb_build_object('receiptId',p_ack.id,'taskId',p_ack.task_id,'assetId',p_ack.asset_id,'objectId',p_ack.object_id,'ackSha256',p_ack.ack_sha256);$$;
create function public.get_report_retention_delete_ack(p_task_id uuid,p_task_lease_token uuid,p_job_id uuid,p_job_lease_token uuid,p_global_token uuid,p_object_id uuid)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare t private.report_purge_tasks;a private.report_purge_delete_acks;begin
 t:=private.report_purge_assert_task(p_task_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token,p_object_id);
 if t.kind<>'storage_object'then raise exception 'invalid_report_purge_task'using errcode='22023';end if;
 select *into a from private.report_purge_delete_acks where task_id=t.id;
 if not found then return null;end if;
 if a.object_id<>t.object_id or a.asset_id<>t.asset_id then raise exception 'state_conflict'using errcode='40001';end if;
 perform private.report_purge_assert_task(p_task_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token,p_object_id);return private.report_purge_ack_dto(a);end;$$;
create function public.record_report_retention_delete_ack(p_task_id uuid,p_task_lease_token uuid,p_job_id uuid,p_job_lease_token uuid,p_global_token uuid,p_object_id uuid,p_ack_sha256 text)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare t private.report_purge_tasks;a private.report_purge_delete_acks;begin
 t:=private.report_purge_assert_task(p_task_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token,p_object_id);
 if t.kind<>'storage_object'or p_ack_sha256 is null or p_ack_sha256!~'^[a-f0-9]{64}$'then raise exception 'invalid_report_purge_ack'using errcode='22023';end if;
 insert into private.report_purge_delete_acks(task_id,asset_id,object_id,ack_sha256)values(t.id,t.asset_id,t.object_id,p_ack_sha256)on conflict(task_id)do nothing;
 select *into a from private.report_purge_delete_acks where task_id=t.id;
 if a.object_id<>t.object_id or a.asset_id<>t.asset_id or a.ack_sha256 is distinct from p_ack_sha256 then raise exception 'state_conflict'using errcode='40001';end if;
 perform private.report_purge_assert_task(p_task_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token,p_object_id);return private.report_purge_ack_dto(a);end;$$;
create function public.complete_report_retention_task(p_task_id uuid,p_task_lease_token uuid,p_job_id uuid,p_job_lease_token uuid,p_global_token uuid,p_object_id uuid,p_evidence_sha256 text)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare t private.report_purge_tasks;c private.report_purge_closures;again boolean;replay jsonb;finished timestamptz;begin
 replay:=private.report_purge_terminal_replay(p_task_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token,p_object_id,p_evidence_sha256);
 if replay is not null then return replay;end if;
 t:=private.report_purge_assert_task(p_task_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token,p_object_id);again:=t.state='completed';
 if p_evidence_sha256 is null or p_evidence_sha256!~'^[a-f0-9]{64}$'then raise exception 'invalid_report_purge_evidence'using errcode='22023';end if;
 if t.kind='storage_object'then
  if t.state='completed'and t.evidence_sha256 is distinct from p_evidence_sha256 then raise exception 'state_conflict'using errcode='40001';end if;
  if not exists(select 1 from private.report_purge_delete_acks where task_id=t.id and asset_id=t.asset_id and object_id=t.object_id)
  or exists(select 1 from storage.objects where id=t.object_id or(bucket_id=t.bucket_id and name=t.object_name))then raise exception 'report_purge_absence_unproven'using errcode='55000';end if;
  -- 첫 유효 ACK+재조회 증거를 보존한다. 완료 행은 동일 현재 fence 안에서만 멱등 반환한다.
  update private.report_purge_tasks set state='completed',completed_at=coalesce(completed_at,clock_timestamp()),evidence_sha256=coalesce(evidence_sha256,p_evidence_sha256)where id=t.id;
  perform private.report_purge_assert_task(p_task_id,p_task_lease_token,p_job_id,p_job_lease_token,p_global_token,p_object_id);
 else
  c:=private.report_purge_assert_closure(t.closure_id);
  if exists(select 1 from private.report_purge_tasks child where child.closure_id=c.id and child.kind='storage_object'and(child.state<>'completed'
   or not exists(select 1 from private.report_purge_delete_acks a where a.task_id=child.id and a.asset_id=child.asset_id and a.object_id=child.object_id)
   or exists(select 1 from storage.objects o where o.id=child.object_id or(o.bucket_id=child.bucket_id and o.name=child.object_name))))then
   raise exception 'report_purge_children_pending'using errcode='55000';end if;
  if exists(select 1 from private.report_capture_assets a where a.report_id=c.report_id and not exists(select 1 from private.report_purge_tasks child where child.closure_id=c.id and child.asset_id=a.id))then
   raise exception 'state_conflict'using errcode='40001';end if;
  perform private.assert_current_worker_job(p_job_id,p_job_lease_token,p_global_token);
  perform set_config('yumidang.report_purge_finalizing',c.id::text,true);
  delete from private.report_capture_assets where report_id=c.report_id;
  delete from private.member_reports where id=c.report_id;
  -- 기존 hold closure/SET NULL과 report 목적 CASCADE를 그대로 실행한다. 최소 결과/제재 원장은 삭제하지 않는다.
  perform private.assert_current_worker_job(p_job_id,p_job_lease_token,p_global_token);
  if t.lease_expires_at<=clock_timestamp()then raise exception 'state_conflict'using errcode='40001';end if;
  perform public.complete_job(p_job_id,p_job_lease_token,p_global_token);
  select completed_at into strict finished from private.worker_jobs where id=p_job_id and status='succeeded';
  insert into private.report_purge_terminal_receipts(task_id,job_id,report_id,closure_id,task_lease_token,job_lease_token,evidence_sha256,completed_at,expires_at)
   values(t.id,p_job_id,c.report_id,c.id,t.lease_token,p_job_lease_token,p_evidence_sha256,finished,finished+interval '720 hours');
  perform private.assert_current_worker_run(p_global_token);
  if t.lease_expires_at<=clock_timestamp()then raise exception 'state_conflict'using errcode='40001';end if;
  if (select enabled from private.report_purge_control where singleton)is distinct from true then raise exception 'report_purge_not_enabled'using errcode='55000';end if;
  perform set_config('yumidang.report_purge_finalizing','',true);
 end if;
 return jsonb_build_object('taskId',p_task_id,'status','completed','alreadyApplied',again);
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;

do $$declare own text;t text;f record;begin
 select pg_get_userbyid(proowner)into strict own from report_purge_function_baseline where oid='public.get_my_report(uuid)'::regprocedure;
 foreach t in array array['report_purge_control','report_purge_closures','report_purge_tasks','report_purge_delete_acks','report_purge_terminal_receipts']loop
  execute format('alter table private.%I owner to %I',t,own);execute format('alter table private.%I enable row level security',t);
  execute format('revoke all on table private.%I from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',t);
 end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where(n.nspname='private'and p.proname in('report_purge_terminal_replay','report_purge_eligible','report_purge_snapshot','report_purge_assert_closure','report_purge_worker','report_purge_task_dto','report_purge_assert_task','report_purge_ack_dto','protect_report_purge_object_name','protect_report_purge_parent_delete','protect_report_purge_reservation_delete'))
  or(n.nspname='public'and p.proname in('purge_report_retention_terminal_receipts','enqueue_report_retention_purges','claim_report_retention_task','check_report_retention_task','get_report_retention_delete_ack','record_report_retention_delete_ack','complete_report_retention_task'))loop
  execute format('alter function %s owner to %I',f.signature,own);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.signature);
 end loop;
 if exists(select 1 from report_purge_function_baseline b join pg_proc p on p.oid=b.oid where p.proowner<>b.proowner or p.proacl::text is distinct from b.acl or p.proconfig::text is distinct from b.config or p.prosrc<>b.prosrc)then
  raise exception 'report_purge_existing_function_changed'using errcode='55000';end if;
end;$$;
comment on table private.report_purge_closures is '기존 최종종결·90일·revision·객체 집합의 기술 snapshot. 최종종결 업무 권한이나 새 보관기간을 생성하지 않는다. 신고 파기와 함께 삭제한다.';
comment on table private.report_purge_delete_acks is '정확한 외부 DELETE 성공을 기록하는 닫힌 worker 영수증. metadata 부재만으로 생성하지 않는다. 상세 파기 후 영구 tombstone을 남기지 않는다.';
commit;
