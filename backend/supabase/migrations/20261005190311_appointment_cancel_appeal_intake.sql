-- 민규: 본인 확정취소 24h 이의 접수 후보. DB/HTTP 실제 검증 NOT_RUN.
-- canonical DB statement 접수이며 edge 최초 도착/일반7d/재신청/종료회차 이전을 열지 않는다.
begin;
alter table private.safety_appeals add column report_id uuid references private.member_reports(id)on delete cascade;
alter table private.safety_appeals add column source_episode_id uuid references private.member_episodes(id);
alter table private.safety_appeals add constraint cancellation_appeal_report_episode_pair check(
 (report_id is null and source_episode_id is null)or(kind='cancellation'and report_id is not null and source_episode_id is not null));
create table private.appointment_cancel_appeal_receipts(
 source_episode_id uuid not null references private.member_episodes(id),client_request_id uuid not null,
 appeal_id uuid not null unique references private.safety_appeals(id)on delete cascade,
 report_id uuid not null references private.member_reports(id)on delete cascade,
 appointment_id uuid not null references public.appointments(id),
 expected_result_revision bigint not null check(expected_result_revision between 1 and 9007199254740990),
 payload_sha256 text not null check(payload_sha256~'^[a-f0-9]{64}$'),
 result jsonb not null check(jsonb_typeof(result)='object'),
 primary key(source_episode_id,client_request_id));
alter table private.appointment_cancel_appeal_receipts enable row level security;
revoke all on private.appointment_cancel_appeal_receipts from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
comment on table private.appointment_cancel_appeal_receipts is
 '신고 처리 상세의 멱등 접수 영수증. report 최종종결+90d 삭제와 CASCADE한다. 원문/회원시각 없음. accepted-exempt 최소 결과는 별도 결과원장이며 이 삭제가 변경하지 않는다.';
-- 미결인 이의에 연결된 신고만 조기 종결/삭제를 막는다. 일반 신고 전체를 보류하지 않는다.
create function private.guard_cancel_appeal_report_retention()returns trigger language plpgsql security definer set search_path=''as $$
declare closing boolean;begin
 if tg_op='DELETE'then closing:=true;else closing:=new.final_closed_at is not null;end if;
 if closing and exists(
  select 1 from private.safety_appeals where report_id=old.id and kind='cancellation'and state='reviewing')then
  raise exception 'cancellation_appeal_review_pending'using errcode='55000';end if;
 if tg_op='DELETE'then return old;end if;return new;
end;$$;
create trigger cancel_appeal_report_retention before delete or update of final_closed_at on private.member_reports
 for each row execute function private.guard_cancel_appeal_report_retention();
-- 원 cancellation fact와 fixed episode를 검증한다. account/profile/episode/session guard 다음 AP/result NOWAIT다.
create function private.require_own_cancel_appeal_context(p_appointment_id uuid,p_episode uuid)
returns private.safety_appointment_results language plpgsql volatile security definer set search_path=''as $$
declare u uuid:=auth.uid();identity uuid;a public.appointments;c private.appointment_cancellations;h private.safety_appointment_results;r private.safety_appointment_result_revisions;begin
 if p_appointment_id is null then raise exception 'invalid_cancel_appeal'using errcode='22023';end if;
 select identity_id into identity from private.member_episodes where id=p_episode and profile_id=u and ended_at is null;
 if identity is null then raise exception 'verified_member_identity_required'using errcode='42501';end if;
 select *into a from public.appointments where id=p_appointment_id for update nowait;
 if not found or not exists(select 1 from private.appointment_member_episodes m join private.member_episodes e
  on e.id in(m.author_episode_id,m.requester_episode_id)where m.appointment_id=a.id and e.profile_id=u)then
  raise exception 'appointment_unavailable'using errcode='PT404';end if;
 select *into c from private.appointment_cancellations where appointment_id=a.id;
 if a.status<>'cancelled'or c.appointment_id is null or c.cancelled_by<>u then raise exception 'appointment_unavailable'using errcode='PT404';end if;
 select *into h from private.safety_appointment_results where appointment_id=a.id and identity_id=identity for update nowait;
 if not found or h.source_episode_id<>p_episode then raise exception 'cross_episode_cancel_appeal_unresolved'using errcode='55000';end if;
 select *into r from private.safety_appointment_result_revisions where identity_id=h.identity_id and appointment_id=h.appointment_id and revision=h.current_revision;
 if h.ordering_provenance<>'agreed_snapshot'or h.current_revision not between 1 and 9007199254740991 or r.revision is null or r.outcome not in('own_cancel','exempt')then
  raise exception 'cancel_appeal_result_unresolved'using errcode='55000';end if;
 return h;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
create function public.submit_appointment_cancel_appeal(p_appointment_id uuid,p_client_request_id uuid,p_expected_result_revision bigint,p_report_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare received timestamptz:=statement_timestamp();episode uuid;h private.safety_appointment_results;previous private.safety_appointment_result_revisions;
 report_row private.member_reports;receipt private.appointment_cancel_appeal_receipts;fingerprint text;deadline timestamptz;appeal uuid;result jsonb;begin
 episode:=private.require_member_decision_notice_episode();
 if p_client_request_id is null or p_report_id is null or p_expected_result_revision is null or p_expected_result_revision not between 1 and 9007199254740990 then
  raise exception 'invalid_cancel_appeal'using errcode='22023';end if;
 h:=private.require_own_cancel_appeal_context(p_appointment_id,episode);
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_appointment_id,p_expected_result_revision,p_report_id)::text,'UTF8')),'hex');
 select *into receipt from private.appointment_cancel_appeal_receipts where source_episode_id=episode and client_request_id=p_client_request_id;
 if found and receipt.payload_sha256<>fingerprint then raise exception 'cancel_appeal_request_conflict'using errcode='40001';end if;
 select *into report_row from private.member_reports where id=p_report_id for update nowait;
 if not found or report_row.reporter_id<>auth.uid()or report_row.reporter_episode_id<>episode or report_row.target_type<>'appointment'or report_row.target_id<>p_appointment_id
  or report_row.retention_due_at<=clock_timestamp()then raise exception 'report_unavailable'using errcode='PT404';end if;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'state_conflict'using errcode='40001';end if;
 if receipt.appeal_id is not null then
  if exists(select 1 from private.member_reports where id=p_report_id and retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
  return receipt.result||jsonb_build_object('alreadyApplied',true);
 end if;
 if exists(select 1 from private.safety_appeals where kind='cancellation'and identity_id=h.identity_id and appointment_id=p_appointment_id)then
  raise exception 'cancel_appeal_reapplication_unresolved'using errcode='55000';end if;
 if h.current_revision<>p_expected_result_revision then raise exception 'state_conflict'using errcode='40001';end if;
 select *into previous from private.safety_appointment_result_revisions where identity_id=h.identity_id and appointment_id=h.appointment_id and revision=h.current_revision;
 if previous.outcome<>'own_cancel'or previous.cancellation_at is distinct from(select cancelled_at from private.appointment_cancellations where appointment_id=p_appointment_id)then
  raise exception 'cancel_appeal_result_unresolved'using errcode='55000';end if;
 deadline:=previous.cancellation_at+interval '24 hours';
 if received>=deadline then raise exception 'cancel_appeal_expired'using errcode='22023';end if;
 if previous.appeal_state<>'none'or report_row.final_closed_at is not null then raise exception 'cancel_appeal_review_unresolved'using errcode='55000';end if;
 appeal:=gen_random_uuid();
 insert into private.safety_appeals(id,identity_id,kind,appointment_id,received_at,deadline_at,report_id,source_episode_id)
 values(appeal,h.identity_id,'cancellation',p_appointment_id,received,deadline,p_report_id,episode);
 insert into private.safety_appointment_result_revisions(identity_id,appointment_id,revision,decision_id,outcome,cancellation_at,appeal_state,reason_code,origin)
 values(h.identity_id,h.appointment_id,h.current_revision+1,gen_random_uuid(),previous.outcome,previous.cancellation_at,'reviewing','cancellation_appeal_received',previous.origin);
 update private.safety_appointment_results set current_revision=h.current_revision+1 where identity_id=h.identity_id and appointment_id=h.appointment_id;
 result:=jsonb_build_object('appealId',appeal,'appointmentId',p_appointment_id,'resultRevision',h.current_revision+1,'state','reviewing',
  'cancelledAt',previous.cancellation_at,'deadlineAt',deadline,'receivedAt',received,'resolvedAt',null);
 insert into private.appointment_cancel_appeal_receipts values(episode,p_client_request_id,appeal,p_report_id,p_appointment_id,p_expected_result_revision,fingerprint,result);
 -- INSERT/trigger 대기 뒤 현재 권한·보관을 다시 검사한다. deadline은 신뢰 DB 접수 시각 그대로다.
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'state_conflict'using errcode='40001';end if;
 if exists(select 1 from private.member_reports where id=p_report_id and retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
 return result||jsonb_build_object('alreadyApplied',false);
exception when lock_not_available or unique_violation then raise exception 'state_conflict'using errcode='40001';end;$$;
create function public.get_my_appointment_cancel_appeal(p_appointment_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();h private.safety_appointment_results;r private.safety_appointment_result_revisions;appeal private.safety_appeals;result jsonb;begin
 h:=private.require_own_cancel_appeal_context(p_appointment_id,episode);
 select *into r from private.safety_appointment_result_revisions where identity_id=h.identity_id and appointment_id=h.appointment_id and revision=h.current_revision;
 select *into appeal from private.safety_appeals where kind='cancellation'and identity_id=h.identity_id and appointment_id=h.appointment_id and source_episode_id=episode;
 if found then
  perform 1 from private.member_reports where id=appeal.report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share;
  if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
 end if;
 result:=jsonb_build_object('appealId',appeal.id,'appointmentId',p_appointment_id,'resultRevision',h.current_revision,'state',appeal.state,
  'cancelledAt',(select cancelled_at from private.appointment_cancellations where appointment_id=p_appointment_id),'deadlineAt',(select cancelled_at+interval '24 hours'from private.appointment_cancellations where appointment_id=p_appointment_id),'receivedAt',appeal.received_at,'resolvedAt',appeal.resolved_at);
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'state_conflict'using errcode='40001';end if;
 if appeal.id is not null and exists(select 1 from private.member_reports where id=appeal.report_id and retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
 return result;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
do $$declare owner_name text;f regprocedure;g text;permission record;begin
 select pg_get_userbyid(proowner)into strict owner_name from pg_proc where oid='private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure;
 if owner_name in('anon','authenticated','service_role','authenticator','yumidang_worker_queue')then raise exception 'cancel_appeal_owner_invalid'using errcode='55000';end if;
 foreach g in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  if pg_has_role(g,owner_name,'USAGE')or pg_has_role(g,owner_name,'SET')then raise exception 'cancel_appeal_owner_invalid'using errcode='55000';end if;
 end loop;
 if not exists(select 1 from pg_roles where rolname=owner_name and(rolsuper or rolbypassrls))
  or not has_schema_privilege(owner_name,'private','USAGE')or not has_schema_privilege(owner_name,'public','USAGE')or not has_schema_privilege(owner_name,'auth','USAGE')
  or not has_function_privilege(owner_name,'private.require_member_decision_notice_episode()','EXECUTE')or not has_function_privilege(owner_name,'auth.uid()','EXECUTE')then
  raise exception 'cancel_appeal_owner_permissions_invalid'using errcode='55000';end if;
 for permission in select required.table_name,privilege_name from(values('private.member_episodes','SELECT'),('private.appointment_member_episodes','SELECT'),
  ('private.appointment_cancellations','SELECT'),('public.appointments','SELECT,UPDATE'),('private.safety_appointment_results','SELECT,UPDATE'),
  ('private.safety_appointment_result_revisions','SELECT,INSERT'),('private.member_reports','SELECT,UPDATE'),('private.safety_appeals','SELECT,INSERT'))as required(table_name,privileges)cross join lateral unnest(string_to_array(required.privileges,','))privilege_name loop
  if not has_table_privilege(owner_name,permission.table_name,permission.privilege_name)then raise exception 'cancel_appeal_owner_permissions_invalid'using errcode='55000';end if;
 end loop;
 execute format('alter table private.appointment_cancel_appeal_receipts owner to %I',owner_name);
 foreach f in array array['private.guard_cancel_appeal_report_retention()'::regprocedure,'private.require_own_cancel_appeal_context(uuid,uuid)'::regprocedure,
  'public.submit_appointment_cancel_appeal(uuid,uuid,bigint,uuid)'::regprocedure,'public.get_my_appointment_cancel_appeal(uuid)'::regprocedure]loop
  execute format('alter function %s owner to %I',f,owner_name);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f);
 end loop;
end;$$;
grant execute on function public.submit_appointment_cancel_appeal(uuid,uuid,bigint,uuid),public.get_my_appointment_cancel_appeal(uuid)to authenticated;
commit;
