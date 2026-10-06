-- 민규: S21 신고+본인 취소 이의 한 statement 접수 후보. 실제 SQL/HTTP NOT_RUN.
-- 원76 바이트/기한/최초 receipt는 보존하며 실제 Edge 도착 시각·운영 판정과 구분한다.
begin;
create table private.appointment_cancel_appeal_report_bindings(
 source_episode_id uuid not null,client_request_id uuid not null,
 payload_sha256 text not null check(payload_sha256~'^[a-f0-9]{64}$'),
 primary key(source_episode_id,client_request_id),
 foreign key(source_episode_id,client_request_id)references private.appointment_cancel_appeal_receipts(source_episode_id,client_request_id)on delete cascade);
alter table private.appointment_cancel_appeal_report_bindings enable row level security;
revoke all on private.appointment_cancel_appeal_report_bindings from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
comment on table private.appointment_cancel_appeal_report_bindings is
 '동일 statement 신고+이의 접수의 최소 hash. 원문/첨부 경로 없음. 기존 receipt/report 상세 파기와 CASCADE하며 accepted 최소 결과는 변경하지 않는다.';
create function public.submit_appointment_cancel_appeal_with_report(p_appointment_id uuid,p_client_request_id uuid,p_expected_result_revision bigint,
 p_reason_codes text[],p_description text,p_asset_ids uuid[],p_hide_target boolean)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();h private.safety_appointment_results;
 binding private.appointment_cancel_appeal_report_bindings;receipt private.appointment_cancel_appeal_receipts;
 reasons text[];assets uuid[];fingerprint text;report_result jsonb;appeal_result jsonb;report_id uuid;
begin
 if p_appointment_id is null or p_client_request_id is null or p_expected_result_revision is null or p_expected_result_revision not between 1 and 9007199254740990
  or not private.valid_report_reasons(p_reason_codes)or p_description is null or p_description<>btrim(p_description)or char_length(p_description)not between 1 and 4000
  or p_description~'[\x00-\x08\x0b\x0c\x0e-\x1f]'or p_hide_target is null or p_asset_ids is null or coalesce(array_ndims(p_asset_ids),1)<>1
  or cardinality(p_asset_ids)>5 or array_position(p_asset_ids,null)is not null or cardinality(p_asset_ids)<>(select count(distinct x)from unnest(p_asset_ids)x)then
  raise exception 'invalid_atomic_cancel_appeal'using errcode='22023';end if;
 select array_agg(x order by x)into reasons from unnest(p_reason_codes)x;
 select coalesce(array_agg(x order by x),'{}'::uuid[])into assets from unnest(p_asset_ids)x;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_appointment_id,p_expected_result_revision,reasons,p_description,assets,p_hide_target)::text,'UTF8')),'hex');
 -- 기존 신고와 동일 회차/요청 seed다. AP/result는 대기하지 않는다.
 perform pg_advisory_xact_lock(hashtextextended(episode::text||':'||p_client_request_id::text,551));
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'state_conflict'using errcode='40001';end if;
 h:=private.require_own_cancel_appeal_context(p_appointment_id,episode);
 select *into binding from private.appointment_cancel_appeal_report_bindings where source_episode_id=episode and client_request_id=p_client_request_id;
 if found then
  if binding.payload_sha256<>fingerprint then raise exception 'atomic_cancel_appeal_request_conflict'using errcode='40001';end if;
  select *into receipt from private.appointment_cancel_appeal_receipts where source_episode_id=episode and client_request_id=p_client_request_id;
  if not found or receipt.appointment_id<>p_appointment_id or receipt.expected_result_revision<>p_expected_result_revision then raise exception 'state_conflict'using errcode='40001';end if;
  appeal_result:=public.submit_appointment_cancel_appeal(p_appointment_id,p_client_request_id,p_expected_result_revision,receipt.report_id);
  report_id:=receipt.report_id;
 else
  if exists(select 1 from private.member_reports where reporter_episode_id=episode and client_request_id=p_client_request_id)
   or exists(select 1 from private.appointment_cancel_appeal_receipts where source_episode_id=episode and client_request_id=p_client_request_id)then
   raise exception 'atomic_cancel_appeal_port_conflict'using errcode='40001';end if;
  report_result:=public.submit_member_report(p_client_request_id,'appointment',p_appointment_id,'offline',reasons,p_description,assets,p_hide_target);
  report_id:=(report_result->>'reportId')::uuid;
  appeal_result:=public.submit_appointment_cancel_appeal(p_appointment_id,p_client_request_id,p_expected_result_revision,report_id);
  insert into private.appointment_cancel_appeal_report_bindings values(episode,p_client_request_id,fingerprint);
 end if;
 -- 중첩76의 statement_timestamp()는 같은 DB command다. 원접수 마감을 새 clock으로 바꾸지 않는다.
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'state_conflict'using errcode='40001';end if;
 if not exists(select 1 from private.member_reports where id=report_id and reporter_episode_id=episode and target_type='appointment'and target_id=p_appointment_id
  and(retention_due_at is null or retention_due_at>clock_timestamp()))then raise exception 'report_unavailable'using errcode='PT404';end if;
 return appeal_result||jsonb_build_object('reportId',report_id);
exception when lock_not_available or unique_violation then raise exception 'state_conflict'using errcode='40001';end;$$;
do $$declare owner_name text;g text;signature regprocedure;required record;begin
 select pg_get_userbyid(proowner)into strict owner_name from pg_proc where oid='private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure;
 if owner_name in('anon','authenticated','service_role','authenticator','yumidang_worker_queue')or not exists(select 1 from pg_roles where rolname=owner_name and(rolsuper or rolbypassrls))then
  raise exception 'atomic_cancel_appeal_owner_invalid'using errcode='55000';end if;
 foreach g in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  if pg_has_role(g,owner_name,'USAGE')or pg_has_role(g,owner_name,'SET')then raise exception 'atomic_cancel_appeal_owner_invalid'using errcode='55000';end if;
 end loop;
 foreach g in array array['private','public','auth']loop
  if not has_schema_privilege(owner_name,g,'USAGE')then raise exception 'atomic_cancel_appeal_permissions_invalid'using errcode='55000';end if;
 end loop;
 foreach signature in array array['private.require_member_decision_notice_episode()'::regprocedure,'private.require_own_cancel_appeal_context(uuid,uuid)'::regprocedure,
  'private.valid_report_reasons(text[])'::regprocedure,'public.submit_member_report(uuid,text,uuid,text,text[],text,uuid[],boolean)'::regprocedure,
  'public.submit_appointment_cancel_appeal(uuid,uuid,bigint,uuid)'::regprocedure]loop
  if not has_function_privilege(owner_name,signature,'EXECUTE')then raise exception 'atomic_cancel_appeal_permissions_invalid'using errcode='55000';end if;
 end loop;
 for required in select unnest(array['private.member_reports','private.appointment_cancel_appeal_receipts'])table_name loop
  if not has_table_privilege(owner_name,required.table_name,'SELECT')then raise exception 'atomic_cancel_appeal_permissions_invalid'using errcode='55000';end if;
 end loop;
 execute format('alter table private.appointment_cancel_appeal_report_bindings owner to %I',owner_name);
 execute format('alter function public.submit_appointment_cancel_appeal_with_report(uuid,uuid,bigint,text[],text,uuid[],boolean)owner to %I',owner_name);
end;$$;
revoke all on function public.submit_appointment_cancel_appeal_with_report(uuid,uuid,bigint,text[],text,uuid[],boolean)from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
grant execute on function public.submit_appointment_cancel_appeal_with_report(uuid,uuid,bigint,text[],text,uuid[],boolean)to authenticated;
commit;
