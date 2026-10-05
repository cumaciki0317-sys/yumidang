-- 민규: 본인이 제안한 일정·장소 변경만 철회한다. 원래 약속과 예약은 유지한다.
-- 마감 접수 시각 계약은 별도 과제이며 기존 서버 시각 만료 처리를 재사용한다.
begin;
alter table private.appointment_schedule_changes drop constraint appointment_schedule_changes_status_check;
alter table private.appointment_schedule_changes add constraint appointment_schedule_changes_status_check
 check(status in('awaiting_response','accepted','declined','expired','cancelled','withdrawn'));

create function public.withdraw_appointment_schedule_change(
 p_appointment_id uuid,p_change_id uuid,p_condition_version text
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_service_profile();ap public.appointments;
 c private.appointment_schedule_changes;deduplicated boolean;
begin
 -- 기존 관계 관리이므로 신규 활동 자격·제재 gate를 추가하지 않는다.
 if private.appointment_role(p_appointment_id) is null then
  raise exception 'appointment_unavailable' using errcode='PT404';end if;
 -- 회원 account→profile→episode 검사 뒤 기존 공고→신청→약속→제안 순서를 유지한다.
 ap:=private.lock_appointment_for_change(p_appointment_id);
 select * into c from private.appointment_schedule_changes
  where change_id=p_change_id and appointment_id=ap.id;
 if c.change_id is null or p_condition_version is null or c.condition_version<>p_condition_version then
  raise exception 'schedule_change_conflict' using errcode='40001';end if;
 if c.requested_by<>u then raise exception 'proposer_required' using errcode='42501';end if;
 -- 기한이 지난 제안은 expired로 종료하며 실제 약속을 변경하지 않는다.
 perform private.expire_appointment_schedule_changes(ap.id);
 select * into c from private.appointment_schedule_changes where change_id=p_change_id;
 deduplicated:=c.status<>'awaiting_response';
 if c.status='awaiting_response' then
  -- 14629의 helper가 알림 중복 방지와 대기 중 위치 원문 정리를 함께 수행한다.
  perform private.end_appointment_schedule_change(c.change_id,'withdrawn');
 elsif c.status not in('withdrawn','expired','cancelled') then
  raise exception 'schedule_change_conflict' using errcode='40001';
 end if;
 return private.appointment_schedule_change_json(c.change_id)
  ||jsonb_build_object('deduplicated',deduplicated);
end; $$;
do $$declare owner_name text;begin
 select pg_get_userbyid(proowner) into strict owner_name from pg_proc
  where oid='public.decline_appointment_schedule_change(uuid,uuid,text)'::regprocedure;
 execute format('alter function public.withdraw_appointment_schedule_change(uuid,uuid,text) owner to %I',owner_name);
end; $$;
revoke all on function public.withdraw_appointment_schedule_change(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.withdraw_appointment_schedule_change(uuid,uuid,text) to authenticated;
comment on function public.withdraw_appointment_schedule_change(uuid,uuid,text) is
 '현재 회원의 본인 변경 제안 철회. 동일 조건 버전 재시도와 expired/cancelled 종료를 보존하며 원래 약속은 유지한다.';
commit;
