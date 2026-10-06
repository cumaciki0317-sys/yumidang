-- 민규 A: 판정 typed 기록과 서버내 본인 게시/읽기 facts 후보. 실제 실행 NOT_RUN.
-- 일반 이의 anchor/외부 delivery/notified_at/최종종결/보관 종료는 설정하지 않는다.
begin;
create temp table notice_function_baseline as select p.oid,p.proowner,p.proacl,p.proconfig,p.proargnames,p.proargmodes,
 pg_get_function_arguments(p.oid)args,pg_get_function_result(p.oid)result from pg_proc p
 where p.oid='public.adjudicate_assigned_member_report(uuid,uuid,text,bigint,bigint,bigint,text,text,text,text,text,text)'::regprocedure;
do $$declare owner_name text;g text;begin
 select pg_get_userbyid(proowner)into strict owner_name from notice_function_baseline;
 if owner_name in('anon','authenticated','service_role','authenticator')or owner_name<>(select pg_get_userbyid(proowner)from pg_proc where oid='private.require_assigned_report_operator(uuid)'::regprocedure)then
  raise exception 'notice_owner_incompatible'using errcode='55000';end if;
 foreach g in array array['anon','authenticated','service_role','authenticator']loop
  if pg_has_role(g,owner_name,'USAGE')or pg_has_role(g,owner_name,'SET')then raise exception 'notice_owner_incompatible'using errcode='55000';end if;
 end loop;
end;$$;
-- 신고 처리 상세 기록으로 report 최종 종결+90d 파기와 함께 제거한다. 최소 제재 identity 기록이 아니다.
-- 기존74 receipt를 추정해 채우지 않는다.
create table private.assigned_report_decisions(
 decision_id uuid primary key,
 report_id uuid not null references private.member_reports(id)on delete cascade,
 report_version bigint not null check(report_version between 2 and 9007199254740991),
 mode text not null check(mode in('initial','correction')),
 appointment_id uuid references public.appointments(id)on delete set null,
 appointment_outcome text not null check(appointment_outcome in('normal','no_show','unchanged')),
 incident_id uuid references private.safety_incidents(id)on delete set null,
 incident_revision bigint not null check(incident_revision between 0 and 9007199254740991),
 incident_outcome text not null check(incident_outcome in('none','confirmed','invalidated')),
 responsible_role text not null check(responsible_role in('none','author','companion','both','target')),
 representative_reason_code text not null check(representative_reason_code in('no_action','no_show','decision_corrected','spam','rule_violation','sexual_harassment','threat','violence','stalking','privacy_exposure','sexual_exploitation')),
 violation_class text not null check(violation_class in('none','minor','major')),
 violation_type text check(violation_type in('spam','rule_violation','sexual_harassment','threat','violence','stalking','privacy_exposure','sexual_exploitation')),
 recorded_at timestamptz not null default clock_timestamp()
);
create table private.member_decision_notices(
 id uuid primary key default gen_random_uuid(),
 decision_id uuid not null references private.assigned_report_decisions(decision_id)on delete cascade,
 recipient_identity_id uuid not null references private.naver_identity_keys(id),
 recipient_episode_id uuid not null references private.member_episodes(id),
 appointment_outcome text check(appointment_outcome in('normal','no_show')),
 violation_outcome text check(violation_outcome in('confirmed','invalidated')),
 reason_code text not null check(reason_code in('normal','no_show','decision_corrected','spam','rule_violation','sexual_harassment','threat','violence','stalking','privacy_exposure','sexual_exploitation')),
 violation_class text check(violation_class in('none','minor','major')),
 violation_type text check(violation_type in('spam','rule_violation','sexual_harassment','threat','violence','stalking','privacy_exposure','sexual_exploitation')),
 available_at timestamptz not null default clock_timestamp(),
 first_read_at timestamptz,
 unique(decision_id,recipient_episode_id),
 check(appointment_outcome is not null or violation_outcome is not null),
 check(first_read_at is null or first_read_at>=available_at),
 check((violation_outcome='confirmed'and violation_class is not null)or(violation_outcome is distinct from 'confirmed'and violation_class is null and violation_type is null))
);
alter table private.assigned_report_decisions enable row level security;
alter table private.member_decision_notices enable row level security;
revoke all on private.assigned_report_decisions,private.member_decision_notices from public,anon,authenticated,service_role,authenticator;

-- 고정 입력/서버 party metadata만 저장한다. 사고 피해자/원문/직원 정보를 공개하지 않는다.
create function private.record_assigned_report_decision_notice(
 p_decision uuid,p_report uuid,p_version bigint,p_mode text,p_appointment uuid,p_appointment_outcome text,
 p_incident uuid,p_incident_revision bigint,p_expected_incident_revision bigint,p_incident_outcome text,
 p_responsible_role text,p_reason text,p_class text,p_type text,p_parties jsonb)
returns void language plpgsql volatile security definer set search_path=''as $$
declare party_item jsonb;own_effect text;ap_effect text;chosen boolean;identity uuid;episode uuid;begin
 insert into private.assigned_report_decisions(decision_id,report_id,report_version,mode,appointment_id,appointment_outcome,
  incident_id,incident_revision,incident_outcome,responsible_role,representative_reason_code,violation_class,violation_type)
 values(p_decision,p_report,p_version,p_mode,p_appointment,p_appointment_outcome,p_incident,p_incident_revision,
  p_incident_outcome,p_responsible_role,p_reason,p_class,p_type);
 for party_item in select value from jsonb_array_elements(p_parties)loop
  identity:=(party_item->>'identityId')::uuid;episode:=(party_item->>'episodeId')::uuid;
  if not exists(select 1 from private.member_episodes ep where ep.id=episode and ep.identity_id=identity)then
   raise exception 'notice_recipient_conflict'using errcode='40001';end if;
  chosen:=p_responsible_role='both'or p_responsible_role=party_item->>'role';
  own_effect:=case when p_incident_outcome='confirmed'and chosen then 'confirmed'
   when(p_incident_outcome='invalidated'or(p_incident_outcome='confirmed'and not chosen))and exists(select 1 from private.safety_incident_subjects subject_row
    where subject_row.incident_id=p_incident and subject_row.revision=p_expected_incident_revision
     and subject_row.identity_id=identity and subject_row.source_episode_id=episode)then 'invalidated'end;
  ap_effect:=case when p_appointment is not null and p_appointment_outcome in('normal','no_show')then p_appointment_outcome end;
  if own_effect is null and ap_effect is null then continue;end if;
  insert into private.member_decision_notices(decision_id,recipient_identity_id,recipient_episode_id,
   appointment_outcome,violation_outcome,reason_code,violation_class,violation_type)
  values(p_decision,identity,episode,ap_effect,own_effect,
   case when own_effect='invalidated'then 'decision_corrected'when own_effect='confirmed'then p_reason else ap_effect end,
   case when own_effect='confirmed'then p_class end,case when own_effect='confirmed'then p_type end);
 end loop;
end;$$;

-- 원문 대신 기존 반환 바로 앞에 한 호출만 추가한다. 기존 replay는 새 기록을 만들지 않는다.
do $$declare f oid;definition text;anchor text;replacement text;before_source text;begin
 select oid into strict f from notice_function_baseline;
 select pg_get_functiondef(f),prosrc into definition,before_source from pg_proc where oid=f;
 if md5(before_source)<>'b509ca39962fcdf41c543f6c0a0a10a9'then raise exception 'notice_adjudication_source_changed'using errcode='55000';end if;
 anchor:=$a$ return jsonb_build_object('reportId',r.id,'status','reviewing','version',new_version,'decisionId',decision,'alreadyApplied',false);$a$;
 replacement:=$a$ perform private.record_assigned_report_decision_notice(decision,r.id,new_version,p_mode,
  case when r.target_type='appointment'then r.target_id end,p_appointment_outcome,incident,rev,p_expected_incident_revision,
  p_incident_outcome,p_responsible_role,p_representative_reason_code,p_violation_class,p_violation_type,parties);
 perform private.require_assigned_report_operator(r.id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 if exists(select 1 from private.member_reports where id=r.id and retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
 return jsonb_build_object('reportId',r.id,'status','reviewing','version',new_version,'decisionId',decision,'alreadyApplied',false);$a$;
 if(length(before_source)-length(replace(before_source,anchor,'')))/length(anchor)<>1 then raise exception 'notice_adjudication_source_changed'using errcode='55000';end if;
 execute replace(definition,anchor,replacement);
 if exists(select 1 from notice_function_baseline b join pg_proc p on p.oid=b.oid where p.proowner<>b.proowner or p.proacl is distinct from b.proacl
  or p.proconfig is distinct from b.proconfig or p.proargnames is distinct from b.proargnames or p.proargmodes is distinct from b.proargmodes
  or pg_get_function_arguments(p.oid)<>b.args or pg_get_function_result(p.oid)<>b.result)then raise exception 'notice_adjudication_metadata_changed'using errcode='55000';end if;
end;$$;

create function private.require_member_decision_notice_episode()
returns uuid language plpgsql volatile security definer set search_path=''as $$
declare u uuid:=private.require_service_profile();episode uuid;session_key uuid;session_limit timestamptz;begin
 -- 원래 JWT 회원관리 guard. 신규활동 자격과 제재 gate를 추가하지 않는다.
 select ep.id into episode from private.member_episodes ep join private.naver_identity_keys k on k.id=ep.identity_id
 join private.naver_accounts account_row on account_row.subject=k.subject and account_row.user_id=u
 where ep.profile_id=u and ep.ended_at is null;
 if not found then raise exception 'verified_member_identity_required'using errcode='42501';end if;
 begin session_key:=(auth.jwt()->>'session_id')::uuid;
 exception when invalid_text_representation then raise exception 'naver_session_required'using errcode='28000';end;
 if session_key is null then raise exception 'naver_session_required'using errcode='28000';end if;
 -- GoTrue의 parent session DELETE→naver child CASCADE와 동일한 parent→child 순서다.
 select session_row.not_after into session_limit from auth.sessions session_row where session_row.id=session_key and session_row.user_id=u for share;
 if not found or session_limit<=clock_timestamp()then raise exception 'naver_session_required'using errcode='28000';end if;
 perform 1 from private.naver_sessions session_binding where session_binding.session_id=session_key and session_binding.user_id=u
  and session_binding.subject=(select identity_key.subject from private.naver_identity_keys identity_key join private.member_episodes ep on ep.identity_id=identity_key.id where ep.id=episode)for share of session_binding;
 if not found or session_limit<=clock_timestamp()then raise exception 'naver_session_required'using errcode='28000';end if;
 return episode;
end;$$;
create function private.member_decision_notice_dto(p_notice private.member_decision_notices)
returns jsonb language sql stable security definer set search_path=''as $$
 select jsonb_build_object('noticeId',p_notice.id,'appointmentId',(select appointment_id from private.assigned_report_decisions where decision_id=p_notice.decision_id),
  'appointmentOutcome',p_notice.appointment_outcome,'violationOutcome',p_notice.violation_outcome,'reasonCode',p_notice.reason_code,
  'violationClass',p_notice.violation_class,'violationType',p_notice.violation_type,'availableAt',p_notice.available_at,'firstReadAt',p_notice.first_read_at);
$$;
create function public.list_my_decision_notices(p_limit integer default 20,p_before uuid default null)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();result jsonb;begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_notice_page'using errcode='22023';end if;
 if p_before is not null and not exists(select 1 from private.member_decision_notices where id=p_before and recipient_episode_id=episode and recipient_identity_id=(select identity_id from private.member_episodes where id=episode)and exists(select 1 from private.assigned_report_decisions decision_row join private.member_reports report_row on report_row.id=decision_row.report_id where decision_row.decision_id=private.member_decision_notices.decision_id and(report_row.retention_due_at is null or report_row.retention_due_at>clock_timestamp())))then
  raise exception 'notice_unavailable'using errcode='PT404';end if;
 with candidates as materialized(select *from private.member_decision_notices where recipient_episode_id=episode and recipient_identity_id=(select identity_id from private.member_episodes where id=episode)and exists(select 1 from private.assigned_report_decisions decision_row join private.member_reports report_row on report_row.id=decision_row.report_id where decision_row.decision_id=private.member_decision_notices.decision_id and(report_row.retention_due_at is null or report_row.retention_due_at>clock_timestamp()))
  and(p_before is null or id>p_before)order by id limit p_limit+1),page as(select *from candidates order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(private.member_decision_notice_dto(notice_row)order by notice_row.id)from page join private.member_decision_notices notice_row on notice_row.id=page.id),'[]'::jsonb),
  'nextCursor',case when(select count(*)from candidates)>p_limit then(select id from page order by id desc limit 1)end)into result;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'notice_episode_conflict'using errcode='40001';end if;
 -- 긴 조회/fresh guard 뒤 만료나 파기가 생겼다면 결과와 cursor를 반환하지 않는다.
 if exists(select 1 from(
  select item->>'noticeId'notice_id from jsonb_array_elements(result->'items')item
  union select result->>'nextCursor'where result->>'nextCursor'is not null
  union select p_before::text where p_before is not null
 )referenced_notice where not exists(
  select 1 from private.member_decision_notices notice_ref join private.assigned_report_decisions decision_ref on decision_ref.decision_id=notice_ref.decision_id
  join private.member_reports report_ref on report_ref.id=decision_ref.report_id
  where notice_ref.id=referenced_notice.notice_id::uuid and notice_ref.recipient_episode_id=episode
   and notice_ref.recipient_identity_id=(select identity_id from private.member_episodes where id=episode)
   and(report_ref.retention_due_at is null or report_ref.retention_due_at>clock_timestamp())
 ))then raise exception 'notice_unavailable'using errcode='PT404';end if;
 return result;
end;$$;
create function public.read_my_decision_notice(p_notice_id uuid)
returns jsonb language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();notice_row private.member_decision_notices;report_key uuid;begin
 if p_notice_id is null then raise exception 'invalid_input'using errcode='22023';end if;
 select decision_row.report_id into report_key from private.member_decision_notices notice_ref join private.assigned_report_decisions decision_row on decision_row.decision_id=notice_ref.decision_id
  where notice_ref.id=p_notice_id and notice_ref.recipient_episode_id=episode and notice_ref.recipient_identity_id=(select identity_id from private.member_episodes where id=episode);
 if not found then raise exception 'notice_unavailable'using errcode='PT404';end if;
 perform 1 from private.member_reports where id=report_key for share;
 if not found or exists(select 1 from private.member_reports where id=report_key and retention_due_at<=clock_timestamp())then raise exception 'notice_unavailable'using errcode='PT404';end if;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'notice_episode_conflict'using errcode='40001';end if;
 select *into notice_row from private.member_decision_notices where id=p_notice_id and recipient_episode_id=episode and recipient_identity_id=(select identity_id from private.member_episodes where id=episode) for update;
 if not found or exists(select 1 from private.member_reports where id=report_key and retention_due_at<=clock_timestamp())then raise exception 'notice_unavailable'using errcode='PT404';end if;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'notice_episode_conflict'using errcode='40001';end if;
 update private.member_decision_notices set first_read_at=coalesce(first_read_at,clock_timestamp())where id=notice_row.id returning *into notice_row;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'notice_episode_conflict'using errcode='40001';end if;
 if exists(select 1 from private.member_reports where id=report_key and retention_due_at<=clock_timestamp())then raise exception 'notice_unavailable'using errcode='PT404';end if;
 return private.member_decision_notice_dto(notice_row);
end;$$;
do $$declare owner_name text;f regprocedure;begin
 select pg_get_userbyid(proowner)into strict owner_name from notice_function_baseline;
 execute format('alter table private.assigned_report_decisions owner to %I',owner_name);
 execute format('alter table private.member_decision_notices owner to %I',owner_name);
 foreach f in array array[
  'private.record_assigned_report_decision_notice(uuid,uuid,bigint,text,uuid,text,uuid,bigint,bigint,text,text,text,text,text,jsonb)'::regprocedure,
  'private.require_member_decision_notice_episode()'::regprocedure,'private.member_decision_notice_dto(private.member_decision_notices)'::regprocedure,
  'public.list_my_decision_notices(integer,uuid)'::regprocedure,'public.read_my_decision_notice(uuid)'::regprocedure]loop
  execute format('alter function %s owner to %I',f,owner_name);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator',f);
 end loop;
end;$$;
grant execute on function public.list_my_decision_notices(integer,uuid),public.read_my_decision_notice(uuid)to authenticated;
commit;
