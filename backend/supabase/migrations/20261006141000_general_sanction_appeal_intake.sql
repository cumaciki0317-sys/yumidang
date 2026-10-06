-- 민규: 일반 제재 이의 접수 후보. 성공 제공 control은 후속 심사/앱 연결까지 false 유지.
begin;
alter table private.safety_appeals drop constraint cancellation_appeal_report_episode_pair;
alter table private.safety_appeals add constraint appeal_report_episode_pair check(
 (report_id is null and source_episode_id is null)or(report_id is not null and source_episode_id is not null));
create table private.general_sanction_appeal_receipts(
 episode_id uuid not null references private.member_episodes(id),client_request_id uuid not null,
 appeal_id uuid not null unique references private.safety_appeals(id)on delete cascade,
 notice_id uuid not null unique references private.member_decision_notices(id)on delete cascade,
 report_id uuid not null references private.member_reports(id)on delete cascade,
 reason text not null check(length(reason)between 1 and 4000 and reason=btrim(reason)and reason!~'[[:cntrl:]]'),
 fingerprint text not null check(fingerprint~'^[a-f0-9]{64}$'),primary key(episode_id,client_request_id));
alter table private.general_sanction_appeal_receipts enable row level security;
revoke all on private.general_sanction_appeal_receipts from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
create function private.general_sanction_appeal_dto(p_appeal private.safety_appeals,p_receipt private.general_sanction_appeal_receipts,p_replayed boolean)
returns jsonb language sql stable security definer set search_path=''as $$
 select jsonb_build_object('appealId',p_appeal.id,'noticeId',p_receipt.notice_id,'state',p_appeal.state,'receivedAt',p_appeal.received_at,'deadlineAt',p_appeal.deadline_at,'alreadyApplied',p_replayed);$$;
create function public.submit_my_general_sanction_appeal(p_notice_id uuid,p_client_request_id uuid,p_reason text)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();received timestamptz:=statement_timestamp();ctx jsonb;
 delivery private.general_notice_deliveries;receipt private.general_sanction_appeal_receipts;appeal private.safety_appeals;report uuid;fingerprint text;begin
 if p_notice_id is null or p_client_request_id is null or p_reason is null or length(p_reason)not between 1 and 4000 or p_reason<>btrim(p_reason)or p_reason~'[[:cntrl:]]'then
  raise exception 'invalid_general_appeal'using errcode='22023';end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_notice_id,p_reason)::text,'UTF8')),'hex');
 -- 접수 후 정정되어도 동일 요청은 원래 접수 facts로 재확인한다. 본인 현재 회차/보관 검사 유지.
 select *into receipt from private.general_sanction_appeal_receipts where episode_id=episode and client_request_id=p_client_request_id;
 if found then
  if receipt.fingerprint<>fingerprint then raise exception 'request_conflict'using errcode='40001';end if;
  perform 1 from private.member_reports where id=receipt.report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share nowait;
  if not found then raise exception 'appeal_unavailable'using errcode='PT404';end if;
  select *into strict appeal from private.safety_appeals where id=receipt.appeal_id;
  return private.general_sanction_appeal_dto(appeal,receipt,true);
 end if;
 ctx:=private.general_notice_delivery_context(p_notice_id);
 select *into delivery from private.general_notice_deliveries where notice_id=p_notice_id and episode_id=episode for update nowait;
 if not found or delivery.provided_at is null then raise exception 'notice_delivery_required'using errcode='55000';end if;
 if received>=delivery.deadline_at then raise exception 'general_appeal_deadline_elapsed'using errcode='PT409';end if;
 select report_id into strict report from private.assigned_report_decisions where decision_id=(select decision_id from private.member_decision_notices where id=p_notice_id);
 perform 1 from private.member_reports where id=report and final_closed_at is null for update nowait;
 if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
 if exists(select 1 from private.safety_appeals where kind='general'and sanction_id=delivery.sanction_id)then
  raise exception 'general_appeal_already_received'using errcode='40001';end if;
 insert into private.safety_appeals(id,identity_id,kind,sanction_id,received_at,deadline_at,report_id,source_episode_id)
 values(gen_random_uuid(),(select identity_id from private.member_episodes where id=episode),'general',delivery.sanction_id,received,delivery.deadline_at,report,episode)returning *into appeal;
 insert into private.general_sanction_appeal_receipts values(episode,p_client_request_id,appeal.id,p_notice_id,report,p_reason,fingerprint)returning *into receipt;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'state_conflict'using errcode='40001';end if;
 return private.general_sanction_appeal_dto(appeal,receipt,false);
exception when lock_not_available or unique_violation then raise exception 'state_conflict'using errcode='40001';end;$$;
create function public.get_my_general_sanction_appeal(p_appeal_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();receipt private.general_sanction_appeal_receipts;appeal private.safety_appeals;begin
 select *into receipt from private.general_sanction_appeal_receipts where appeal_id=p_appeal_id and episode_id=episode;
 if not found then raise exception 'appeal_unavailable'using errcode='PT404';end if;
 perform 1 from private.member_reports where id=receipt.report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share nowait;
 if not found then raise exception 'appeal_unavailable'using errcode='PT404';end if;
 select *into strict appeal from private.safety_appeals where id=p_appeal_id;
 return private.general_sanction_appeal_dto(appeal,receipt,true);
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
create function private.guard_general_appeal_report_retention()returns trigger language plpgsql security definer set search_path=''as $$begin
 if(tg_op='DELETE'or new.final_closed_at is not null)and exists(select 1 from private.safety_appeals where report_id=old.id and kind='general'and state='reviewing')then
  raise exception 'general_appeal_review_pending'using errcode='55000';end if;
 if tg_op='DELETE'then return old;end if;return new;end;$$;
create trigger general_appeal_report_retention before delete or update of final_closed_at on private.member_reports for each row execute function private.guard_general_appeal_report_retention();
do $$declare own text;f regprocedure;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='private.require_member_decision_notice_episode()'::regprocedure;
 execute format('alter table private.general_sanction_appeal_receipts owner to %I',own);
 foreach f in array array['private.general_sanction_appeal_dto(private.safety_appeals,private.general_sanction_appeal_receipts,boolean)'::regprocedure,
 'public.submit_my_general_sanction_appeal(uuid,uuid,text)'::regprocedure,'public.get_my_general_sanction_appeal(uuid)'::regprocedure,'private.guard_general_appeal_report_retention()'::regprocedure]loop
  execute format('alter function %s owner to %I',f,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f);
 end loop;
end;$$;
grant execute on function public.submit_my_general_sanction_appeal(uuid,uuid,text),public.get_my_general_sanction_appeal(uuid)to authenticated;
commit;
