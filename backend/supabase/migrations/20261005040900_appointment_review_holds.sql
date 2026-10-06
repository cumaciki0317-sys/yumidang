-- 민규: 명시적 동행 검토만 완료/후기 신규 처리에서 보류한다. 일반 신고 접수 자동 변환·직원 권한은 추가하지 않는다.
-- source65 후보 단일TX SQL 회귀 통과. native66 영속 적용/HTTP/두 세션 검증은 후속이며 운영 미배포. 과거 migration 바이트는 수정하지 않는다.
begin;
create table private.appointment_review_holds(
 hold_id uuid primary key default gen_random_uuid(),
 report_id uuid references private.member_reports(id) on delete set null,
 appointment_id uuid not null references public.appointments(id),
 state text not null check(state in('reviewing','normal','no_show')),
 version bigint not null default 1 check(version>0),
 entered_at timestamptz not null default clock_timestamp(),
 resolved_at timestamptz,
 decision_id uuid unique,
 unique(report_id,appointment_id),
 check((state='reviewing' and resolved_at is null and decision_id is null)
    or(state in('normal','no_show') and resolved_at is not null and decision_id is not null))
);
create index appointment_review_holds_active on private.appointment_review_holds(appointment_id) where state in('reviewing','no_show');
create table private.appointment_review_windows(
 appointment_id uuid primary key references public.appointments(id),
 original_due_at timestamptz not null,
 completed_before_review boolean not null,
 review_time_remaining interval,
 check((completed_before_review and review_time_remaining is not null and review_time_remaining>=interval'0 seconds')
    or(not completed_before_review and review_time_remaining is null))
);
alter table private.appointment_review_holds enable row level security;
alter table private.appointment_review_windows enable row level security;
revoke all on private.appointment_review_holds,private.appointment_review_windows from public,anon,authenticated,service_role,yumidang_worker_queue;
comment on table private.appointment_review_holds is
 'owner가 명시한 약속 대상 신고의 완료 검토 관계. 접수나 일반 reviewing만으로 생성하지 않는다. 원문/신고자 DTO를 복제하지 않는다. no_show는 보류이며 자동 귀책/제재 판정이 아니다. report 최종 종결/90일은 이 helper가 변경하지 않는다. report 파기 후 nullable 연결만 제거하고 최소 no_show 보류는 유지한다. 최소 결과 보관 근거/종료 조건은 법적 검토 대기다.';
comment on table private.appointment_review_windows is
 '검토 진입 시 최신 합의 종료+24h와 첫 검토 전 남은 후기 기간. 확정/완료 상태를 위조하지 않는다. original_due_at은 진입 당시 기록이며 정상 해소의 최초 완료 판정은 그때 최신 합의 종료+24h를 다시 읽는다.';

create function private.appointment_review_held(p_appointment_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.appointment_review_holds where appointment_id=p_appointment_id and state in('reviewing','no_show'))
 or exists(select 1 from public.appointment_disputes where appointment_id=p_appointment_id and(status='open' or resolution='no_show'));
$$;

-- source65의 정확 함수와 owner/ACL을 먼저 고정한다. 새 공개 RPC/직원 grant는 만들지 않는다.
create temp table appointment_hold_function_baseline as
 select p.oid,p.oid::regprocedure::text signature,p.proowner,p.proacl
 from pg_proc p where p.oid in(
 'private.sync_completion_reservation(uuid)'::regprocedure,
 'public.execute_completion_reservation(uuid,uuid)'::regprocedure,
 'private.complete_due_appointments(timestamptz,integer)'::regprocedure,
 'private.confirm_appointment_completion_before_member_retirement(uuid)'::regprocedure,
 'private.can_submit_appointment_review(uuid,uuid,timestamptz)'::regprocedure,
 'private.review_release_ready(uuid)'::regprocedure,
 'private.get_appointment_review_state_before_member_retirement(uuid)'::regprocedure,
 'private.sync_appointment_safety_results(uuid,boolean,boolean)'::regprocedure,
 'private.resolve_appointment_dispute(uuid,text,timestamptz)'::regprocedure);
create function pg_temp.patch_appointment_hold(p_signature text,p_anchor text,p_replacement text)
returns void language plpgsql as $$declare definition text;begin
 select pg_get_functiondef(p_signature::regprocedure)into definition;
 if p_anchor='' or(length(definition)-length(replace(definition,p_anchor,'')))/length(p_anchor)<>1 then
  raise exception 'appointment_hold_source_anchor_mismatch' using errcode='55000';
 end if;
 execute replace(definition,p_anchor,p_replacement);
end;$$;
-- 각 source의 좁은 판정만 갱신한다.
select pg_temp.patch_appointment_hold('private.sync_completion_reservation(uuid)',
 $$where ap.id=p_appointment_id and ap.status='confirmed'$$,
 $$where ap.id=p_appointment_id and ap.status='confirmed' and not private.appointment_review_held(ap.id)$$);
select pg_temp.patch_appointment_hold('public.execute_completion_reservation(uuid,uuid)',
 $$if v_ap.status<>'confirmed' or v_due is distinct from v_res.due_at$$,
 $$if private.appointment_review_held(v_ap.id) or v_ap.status<>'confirmed' or v_due is distinct from v_res.due_at$$);
select pg_temp.patch_appointment_hold('private.complete_due_appointments(timestamptz,integer)',
 $$where ap.status = 'confirmed' and clock_timestamp() >= p.ends_at + interval '24 hours'$$,
 $$where ap.status = 'confirmed' and not private.appointment_review_held(ap.id) and clock_timestamp() >= p.ends_at + interval '24 hours'$$);
select pg_temp.patch_appointment_hold('private.confirm_appointment_completion_before_member_retirement(uuid)',
 $$if exists (select 1 from public.appointment_disputes d where d.appointment_id = p_appointment_id and (d.status = 'open' or d.resolution = 'no_show')) then$$,
 $$if private.appointment_review_held(p_appointment_id) or exists (select 1 from public.appointment_disputes d where d.appointment_id = p_appointment_id and (d.status = 'open' or d.resolution = 'no_show')) then$$);
select pg_temp.patch_appointment_hold('private.can_submit_appointment_review(uuid,uuid,timestamptz)',
 $$select coalesce((select p_uid in(p.author_id,r.requester_id) and p.author_id<>r.requester_id$$,
 $$select coalesce((select p_uid in(p.author_id,r.requester_id) and p.author_id<>r.requester_id and not private.appointment_review_held(ap.id)$$);
select pg_temp.patch_appointment_hold('private.review_release_ready(uuid)',
 $$select coalesce((select ap.status='completed'$$,
 $$select coalesce((select not private.appointment_review_held(ap.id) and ap.status='completed'$$);
select pg_temp.patch_appointment_hold('private.get_appointment_review_state_before_member_retirement(uuid)',
 $$v_disputed:=v_ap.status='disputed' or exists$$,
 $$v_disputed:=private.appointment_review_held(p_appointment_id) or v_ap.status='disputed' or exists$$);
select pg_temp.patch_appointment_hold('private.sync_appointment_safety_results(uuid,boolean,boolean)',
 $$v_complete:=a.status='completed'$$,
 $$v_complete:=not private.appointment_review_held(a.id) and a.status='completed'$$);
select pg_temp.patch_appointment_hold('private.sync_appointment_safety_results(uuid,boolean,boolean)',
 $$if a.status='cancelled' and c.appointment_id=a.id then$$,
 $$if private.appointment_review_held(a.id) then null;
  elsif a.status='cancelled' and c.appointment_id=a.id then$$);

create function private.resume_appointment_review_if_clear(p_appointment_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare a public.appointments;w private.appointment_review_windows;due timestamptz;n timestamptz;r private.completion_reservations;
begin
 select *into a from public.appointments where id=p_appointment_id for update;
 if not found then return;end if;
 select *into w from private.appointment_review_windows where appointment_id=a.id for update;
 if not found or private.appointment_review_held(a.id) then return;end if;
 select ends_at+interval'24 hours' into due from public.posts where id=a.post_id;
 n:=clock_timestamp();
 if w.completed_before_review then
  -- 완료 후 검토: 기존 실제 완료 시각과 공개된 후기/override는 유지한다.
  if a.completed_at is null then raise exception 'appointment_review_completion_conflict' using errcode='40001';end if;
  if a.status in('completed','disputed') then
   update public.appointments set review_deadline_at=n+greatest(w.review_time_remaining,interval'24 hours') where id=a.id;
  end if;
 elsif a.status='confirmed' and a.completed_at is null then
  -- 최초 완료: 검토 시간을 최신 합의 종료+24h에 더하지 않는다. 실제 예약 실행이 첫 완료 시각/7일/알림을 만든다.
  perform private.sync_completion_reservation(a.id);
  if n>=due then
   select *into r from private.completion_reservations where appointment_id=a.id;
   if r.appointment_id is null then raise exception 'appointment_review_reservation_conflict' using errcode='40001';end if;
   perform public.execute_completion_reservation(a.id,r.generation);
  end if;
 end if;
 delete from private.appointment_review_windows where appointment_id=a.id;
 perform private.sync_completion_reservation(a.id);
 perform private.sync_appointment_safety_results(a.id,false,false);
end;$$;

create function private.enter_appointment_review(p_report_id uuid,p_appointment_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare a public.appointments;r private.member_reports;h private.appointment_review_holds;due timestamptz;n timestamptz;remaining interval;
begin
 if p_report_id is null or p_appointment_id is null then raise exception 'invalid_appointment_review' using errcode='22023';end if;
 -- 모든 새 helper는 약속→report→window/hold→예약/원장 순서. 기존 회원 완료와 약속 잠금에서 직렬화된다.
 select *into a from public.appointments where id=p_appointment_id for update;
 if not found then raise exception 'appointment_review_unavailable' using errcode='P0002';end if;
 select *into r from private.member_reports where id=p_report_id for update;
 if not found or r.target_type<>'appointment' or r.target_id<>a.id then
  raise exception 'appointment_review_report_unavailable' using errcode='P0002';
 end if;
 select *into h from private.appointment_review_holds where report_id=r.id and appointment_id=a.id for update;
 if found then return jsonb_build_object('holdId',h.hold_id,'state',h.state,'version',h.version,'deduplicated',true);end if;
 if r.status not in('reviewing','more_evidence') or r.final_closed_at is not null then
  raise exception 'appointment_review_report_not_reviewing' using errcode='55000';
 end if;
 if a.status not in('confirmed','completed','disputed') then raise exception 'appointment_review_unavailable' using errcode='55000';end if;
 select ends_at+interval'24 hours' into due from public.posts where id=a.post_id;
 n:=clock_timestamp();
 -- 기존 open 분쟁이 먼저 진행 중이면 이미 저장한 남은 기간을 사용해 검토 시간을 차감하지 않는다.
 select review_time_remaining into remaining from public.appointment_disputes where appointment_id=a.id and status='open';
 if a.completed_at is not null then remaining:=coalesce(remaining,greatest(a.review_deadline_at-n,interval'0 seconds'));end if;
 -- 보류 진입 전에 이미 동적으로 공개된 정책 후기를 물질화한다. 운영 override=false는 건드리지 않는다.
 if private.review_release_ready(a.id) then
  update private.review_publication pub set is_public=true from public.appointment_reviews rv
   where rv.id=pub.review_id and rv.appointment_id=a.id and pub.publication_source='policy' and not pub.is_public;
 end if;
 insert into private.appointment_review_windows values(a.id,due,a.completed_at is not null,case when a.completed_at is null then null else remaining end)
 on conflict(appointment_id)do nothing;
 insert into private.appointment_review_holds(report_id,appointment_id,state,entered_at)values(r.id,a.id,'reviewing',n) returning *into h;
 perform private.sync_completion_reservation(a.id);
 perform private.sync_appointment_safety_results(a.id,false,false);
 return jsonb_build_object('holdId',h.hold_id,'state','reviewing','version',1,'deduplicated',false);
end;$$;

create function private.resolve_appointment_review(p_hold_id uuid,p_appointment_id uuid,p_expected_version bigint,p_decision_id uuid,p_outcome text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare a public.appointments;h private.appointment_review_holds;r private.member_reports;
begin
 if p_hold_id is null or p_appointment_id is null or p_expected_version is null or p_expected_version<1
  or p_decision_id is null or p_outcome is null or p_outcome not in('normal','no_show') then
  raise exception 'invalid_appointment_review_resolution' using errcode='22023';end if;
 select *into a from public.appointments where id=p_appointment_id for update;
 if not found then raise exception 'appointment_review_unavailable' using errcode='P0002';end if;
 select *into h from private.appointment_review_holds where hold_id=p_hold_id and appointment_id=a.id;
 if not found then raise exception 'appointment_review_unavailable' using errcode='P0002';end if;
 if h.report_id is not null then perform 1 from private.member_reports where id=h.report_id for update;end if;
 select *into h from private.appointment_review_holds where hold_id=p_hold_id and appointment_id=a.id for update;
 if not found then raise exception 'appointment_review_unavailable' using errcode='P0002';end if;
 if h.decision_id=p_decision_id then
  if h.state<>p_outcome then raise exception 'appointment_review_decision_conflict' using errcode='40001';end if;
  return jsonb_build_object('holdId',h.hold_id,'state',h.state,'version',h.version,'deduplicated',true);
 end if;
 if h.version<>p_expected_version then raise exception 'appointment_review_version_conflict' using errcode='40001';end if;
 -- no_show는 기존 actual completion을 만들거나 귀책/제재를 자동으로 기록하지 않는 보류 상태다.
 update private.appointment_review_holds set state=p_outcome,version=version+1,resolved_at=clock_timestamp(),decision_id=p_decision_id
  where hold_id=p_hold_id and appointment_id=a.id;
 perform private.resume_appointment_review_if_clear(a.id);
 perform private.sync_completion_reservation(a.id);
 perform private.sync_appointment_safety_results(a.id,false,false);
 return jsonb_build_object('holdId',h.hold_id,'state',p_outcome,'version',h.version+1,'deduplicated',false);
end;$$;

-- legacy 분쟁이 나중에 해소된 경우도 마지막 전체 보류가 없어야 재개한다.
select pg_temp.patch_appointment_hold('private.resolve_appointment_dispute(uuid,text,timestamptz)',
 $$update public.appointments set status = 'no_show' where id = p_appointment_id;
  end if;$$,
 $$update public.appointments set status = 'no_show' where id = p_appointment_id;
  end if;
  perform private.resume_appointment_review_if_clear(p_appointment_id);$$);

create function private.guard_appointment_review_report_state()
returns trigger language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from private.appointment_review_holds where report_id=new.id and state='reviewing')
  and(new.status not in('reviewing','more_evidence') or new.final_closed_at is not null) then
  raise exception 'appointment_review_report_still_held' using errcode='55000';
 end if;
 return new;
end;$$;
create trigger appointment_review_report_state before update of status,final_closed_at on private.member_reports
 for each row execute function private.guard_appointment_review_report_state();

-- source function OID/owner/ACL을 바꾸지 않았는지 검증한다. 새 metadata/helper는 동일 core owner와 owner-only ACL이다.
do $$declare owner_name text;signature text;begin
 if exists(select 1 from appointment_hold_function_baseline b left join pg_proc p on p.oid=b.oid
  where p.oid is null or p.proowner<>b.proowner or p.proacl is distinct from b.proacl)then
  raise exception 'appointment_review_source_catalog_changed' using errcode='55000';end if;
 if exists(select 1 from appointment_hold_function_baseline b where b.proowner<>(select relowner from pg_class where oid='public.appointments'::regclass)) then
  raise exception 'appointment_review_core_owner_mismatch' using errcode='55000';end if;
 select pg_get_userbyid(relowner)into owner_name from pg_class where oid='public.appointments'::regclass;
 execute format('alter table private.appointment_review_holds owner to %I',owner_name);
 execute format('alter table private.appointment_review_windows owner to %I',owner_name);
 foreach signature in array array['private.appointment_review_held(uuid)','private.resume_appointment_review_if_clear(uuid)',
  'private.enter_appointment_review(uuid,uuid)','private.resolve_appointment_review(uuid,uuid,bigint,uuid,text)',
  'private.guard_appointment_review_report_state()'] loop
  execute format('alter function %s owner to %I',signature,owner_name);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,yumidang_worker_queue',signature);
 end loop;
end;$$;
comment on function private.enter_appointment_review(uuid,uuid) is
 'owner-only 명시 약속 대상 신고 검토 진입. 직원 배정/운영 ACL/새 회원 분쟁 HTTP/일반 신고 자동 변환/원문 복제는 미연결.';
comment on function private.resolve_appointment_review(uuid,uuid,bigint,uuid,text) is
 'owner-only 독립 hold_id의 구조화 정상 인정 또는 노쇼 보류. 신고를 최종 종결하지 않고 제재/귀책을 자동 판단하지 않는다. 정상 해소 시 최신 합의 종료+24h와 최초 실제 완료+7d/기존 남은 후기 최소24h를 분리한다.';
drop table appointment_hold_function_baseline;
commit;
