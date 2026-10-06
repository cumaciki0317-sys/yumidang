-- 민규: source66(40900 d936cb38)의 완료 전 최종 노쇼를 실제 종결 상태로 연결한다.
-- 후보 초안. SQL/DB/HTTP/두 세션 실행 NOT_RUN. 귀책·incident·감점·신고 최종종결은 자동 판단하지 않는다.
begin;
create temp table appointment_no_show_baseline as
 select p.oid,p.proowner,p.proacl from pg_proc p where p.oid in(
 'private.resolve_appointment_review(uuid,uuid,bigint,uuid,text)'::regprocedure,
 'private.resolve_appointment_dispute(uuid,text,timestamptz)'::regprocedure,
 'private.review_finally_valid(uuid)'::regprocedure,
 'private.completed_appointment_count(uuid)'::regprocedure,
 'private.member_retention_state(uuid)'::regprocedure,
 'private.conversation_generation_state(uuid,bigint)'::regprocedure,
 'private.lock_member_retention_metadata()'::regprocedure,
 'private.sync_appointment_safety_results(uuid,boolean,boolean)'::regprocedure,
 'private.notify_appointment_completion()'::regprocedure);

-- 사용자 확정: 한 명 탈퇴 후 최초 정상 인정은 정정 실행 시각에 시스템 완료한다.
-- 실제 첫 완료 근거만 저장하며 원문·상대 정보·제재 귀책을 복제하지 않는다.
create table private.appointment_review_normal_completions(
 appointment_id uuid primary key references public.appointments(id) on delete cascade,
 hold_id uuid not null references private.appointment_review_holds(hold_id) on delete cascade,
 decision_id uuid not null,
 completed_at timestamptz not null check(isfinite(completed_at))
);
alter table private.appointment_review_normal_completions enable row level security;
revoke all on private.appointment_review_normal_completions from public,anon,authenticated,service_role,yumidang_worker_queue;

-- 기존 계약 전체를 보존하고 NULL 완료정보인 no_show 경로만 추가한다.
do $$declare expression text;begin
 select pg_get_expr(conbin,conrelid) into expression from pg_constraint
 where conrelid='public.appointments'::regclass and conname='appointments_completion_contract'
 and contype='c' and convalidated;
 if expression is null then raise exception 'appointment_completion_contract_missing' using errcode='55000';end if;
 alter table public.appointments drop constraint appointments_completion_contract;
 execute format('alter table public.appointments add constraint appointments_completion_contract check ((%s) or
 (status=''no_show'' and completed_at is null and completion_method is null and completed_by_user_id is null
 and completion_notified_at is null and dispute_deadline_at is null and review_deadline_at is null))',expression);
end;$$;

create function pg_temp.patch_appointment_no_show(signature text,anchor text,replacement text)
returns void language plpgsql as $$declare definition text;begin
 select pg_get_functiondef(signature::regprocedure)into definition;
 if anchor='' or(length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
  raise exception 'appointment_no_show_source_anchor_mismatch' using errcode='55000';end if;
 execute replace(definition,anchor,replacement);
end;$$;

create function private.sync_appointment_review_terminal_state(p_appointment_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare a public.appointments;final_no_show boolean;legacy_open boolean;normal_hold private.appointment_review_holds;n timestamptz;profile_count integer;begin
 select *into a from public.appointments where id=p_appointment_id for update nowait;
 if not found then return;end if;
 select exists(select 1 from private.appointment_review_holds where appointment_id=a.id and state='no_show')
 or exists(select 1 from public.appointment_disputes where appointment_id=a.id and resolution='no_show') into final_no_show;
 if final_no_show then
  if a.status in('confirmed','completed','disputed') then
   -- 기존 실제 완료 기록은 그대로 남긴다. 미완료에는 완료 시각/알림/후기 기한을 새로 만들지 않는다.
   update public.appointments set status='no_show' where id=a.id;
  end if;
 elsif a.status='no_show' then
  select exists(select 1 from public.appointment_disputes where appointment_id=a.id and status='open')into legacy_open;
  if a.completed_at is null then
   -- 약속→profile FK 대기를 추가하지 않는다. 탈퇴의 profile→약속 잠금과 충돌하면 전체 정정을 재시도한다.
   -- 정확한 기존 당사자2개만 UUID 순서로 NOWAIT 잠금한 뒤 탈퇴 상태를 읽는다. 계정·인증 권한은 바꾸지 않는다.
   perform pf.id from public.profiles pf join public.posts p on p.id=a.post_id
    join public.join_requests j on j.id=a.join_request_id and j.post_id=p.id
    where pf.id in(p.author_id,j.requester_id)order by pf.id for key share of pf nowait;
   get diagnostics profile_count=row_count;
   if profile_count<>2 then raise exception 'appointment_review_profiles_required' using errcode='40001';end if;
   if exists(select 1 from public.posts p join public.join_requests j on j.id=a.join_request_id
    where p.id=a.post_id and(private.profile_retired(p.author_id) or private.profile_retired(j.requester_id)))then
    -- 다른 reviewing/legacy 보류가 남으면 terminal을 유지한다. 마지막 해소만 실제 첫 완료를 만든다.
    if private.appointment_review_held(a.id) then return;end if;
    select *into normal_hold from private.appointment_review_holds where appointment_id=a.id and state='normal'
     and decision_id is not null order by resolved_at desc,hold_id limit 1;
    if not found then raise exception 'appointment_review_normal_decision_required' using errcode='40001';end if;
    n:=clock_timestamp();
    insert into private.appointment_review_normal_completions(appointment_id,hold_id,decision_id,completed_at)
     values(a.id,normal_hold.hold_id,normal_hold.decision_id,n);
    -- manual 확인을 위조하지 않는다. owner 정상 인정의 시스템 결과는 기존 automatic 계약을 따른다.
    update public.appointments set status='completed',completed_at=n,completion_method='automatic',completed_by_user_id=null,
     completion_notified_at=n,dispute_deadline_at=n+interval'24 hours',review_deadline_at=n+interval'7 days'where id=a.id;
   else
    update public.appointments set status='confirmed' where id=a.id;
   end if;
  else
   update public.appointments set status=case when legacy_open then 'disputed' else 'completed' end where id=a.id;
  end if;
 end if;
exception when lock_not_available then
 raise exception 'appointment_review_state_conflict' using errcode='40001';
end;$$;

select pg_temp.patch_appointment_no_show('private.resolve_appointment_review(uuid,uuid,bigint,uuid,text)',
 $$perform private.resume_appointment_review_if_clear(a.id);$$,
 $$perform private.sync_appointment_review_terminal_state(a.id);
 perform private.resume_appointment_review_if_clear(a.id);
 perform private.invalidate_appointment_review_summaries(array[a.id]);$$);
-- legacy 정상 인정이 다른 명시 노쇼 판정을 덮어쓰지 않는다.
select pg_temp.patch_appointment_no_show('private.resolve_appointment_dispute(uuid,text,timestamptz)',
 $$perform private.resume_appointment_review_if_clear(p_appointment_id);$$,
 $$perform private.sync_appointment_review_terminal_state(p_appointment_id);
  perform private.resume_appointment_review_if_clear(p_appointment_id);$$);
-- 공개 전 보류는 기존 공개 기여를 유지한다. 최종 노쇼만 해당 동행 후기 자격을 무효화한다.
select pg_temp.patch_appointment_no_show('private.review_finally_valid(uuid)',
 $$select coalesce((select is_valid from private.sweetness_review_decisions where review_id=p_review_id order by revision desc limit 1),true);$$,
 $$select coalesce((select is_valid from private.sweetness_review_decisions where review_id=p_review_id order by revision desc limit 1),true)
 and not exists(select 1 from public.appointment_reviews rv join public.appointments a on a.id=rv.appointment_id
  where rv.id=p_review_id and(a.status='no_show' or exists(select 1 from private.appointment_review_holds h
   where h.appointment_id=a.id and h.state='no_show')));$$);
select pg_temp.patch_appointment_no_show('private.completed_appointment_count(uuid)',
 $$where ap.completed_at is not null and ap.status in('completed','disputed')$$,
 $$where ap.completed_at is not null and ap.status in('completed','disputed')
 and not exists(select 1 from private.appointment_review_holds h where h.appointment_id=ap.id and h.state='no_show')$$);

-- 원장 완료 인정: 일반 자동완료의 원 기한 검증은 유지하고 owner 정상정정의 첫 완료 근거만 추가한다.
select pg_temp.patch_appointment_no_show('private.sync_appointment_safety_results(uuid,boolean,boolean)',
 $$(a.completion_method='automatic' and a.completed_at>=p.ends_at+interval'24 hours')$$,
 $$(a.completion_method='automatic' and(a.completed_at>=p.ends_at+interval'24 hours'
  or exists(select 1 from private.appointment_review_normal_completions n
   where n.appointment_id=a.id and n.completed_at=a.completed_at)))$$);
-- 실제 완료 알림은 활성 회원에게만 생성한다. 기존 unique 멱등과 이력은 유지한다.
select pg_temp.patch_appointment_no_show('private.notify_appointment_completion()',
 $$where p.id = new.post_id$$,
 $$where p.id = new.post_id and not private.profile_retired(ids.id)$$);

-- report90일 파기 뒤에도 마지막 관련 절차 종결 시각이 뒤로 이동하지 않는다.
alter table private.appointment_review_holds add column report_closed_at timestamptz
 check(report_closed_at is null or isfinite(report_closed_at));
create function private.preserve_appointment_review_report_closure()
returns trigger language plpgsql security definer set search_path='' as $$begin
 if exists(select 1 from private.appointment_review_holds where report_id=old.id and state='reviewing')then
  raise exception 'appointment_review_report_still_held' using errcode='55000';end if;
 if exists(select 1 from private.appointment_review_holds where report_id=old.id)then
  if old.status<>'resolved' or old.final_closed_at is null then
   raise exception 'appointment_review_report_not_closed' using errcode='55000';end if;
  update private.appointment_review_holds set report_closed_at=greatest(report_closed_at,old.final_closed_at)
   where report_id=old.id;
 end if;
 return old;
end;$$;
create trigger appointment_review_report_closure before delete on private.member_reports
 for each row execute function private.preserve_appointment_review_report_closure();

-- report 본문을 복제하지 않는 최소 구조화 판정만 closure 지문에 결합한다.
create function private.extend_retention_appointment_review_state(p_base jsonb,p_appointment_ids uuid[])
returns jsonb language sql volatile security definer set search_path='' as $$
 with holds as(select hold_id,appointment_id,state,version,entered_at,resolved_at,decision_id,report_closed_at
 from private.appointment_review_holds where appointment_id=any(p_appointment_ids)),
 state as(select coalesce(bool_or(state='reviewing'),false) pending,max(greatest(resolved_at,report_closed_at)) closed_at,
  coalesce(jsonb_agg(jsonb_build_array(hold_id,appointment_id,state,version,entered_at,resolved_at,decision_id,report_closed_at)
  order by hold_id),'[]'::jsonb) fingerprint from holds),
 normal_completed as(select coalesce(jsonb_agg(jsonb_build_array(appointment_id,hold_id,decision_id,completed_at)order by appointment_id),'[]'::jsonb) proof
 from private.appointment_review_normal_completions where appointment_id=any(p_appointment_ids))
 select p_base||jsonb_build_object('blocked',(p_base->>'blocked')::boolean or state.pending,
 'latestClosedAt',greatest((p_base->>'latestClosedAt')::timestamptz,state.closed_at),
 'metadataSha256',encode(sha256(convert_to(jsonb_build_array(p_base->>'metadataSha256',state.fingerprint,normal_completed.proof)::text,'UTF8')),'hex'))
 from state cross join normal_completed;
$$;
select pg_temp.patch_appointment_no_show('private.member_retention_state(uuid)',
 $$return jsonb_build_object('blocked',blocked or safety_blocked,'latestClosedAt',closed_at,
 'metadataSha256',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));$$,
 $$return private.extend_retention_appointment_review_state(jsonb_build_object('blocked',blocked or safety_blocked,'latestClosedAt',closed_at,
 'metadataSha256',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')),
 array(select id from public.appointments where post_id=p_post_id));$$);
select pg_temp.patch_appointment_no_show('private.conversation_generation_state(uuid,bigint)',
 $$return jsonb_build_object('blocked',blocked or safety,'latestClosedAt',closed_at,'metadataSha256',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));$$,
 $$return private.extend_retention_appointment_review_state(jsonb_build_object('blocked',blocked or safety,'latestClosedAt',closed_at,'metadataSha256',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')),
 array(select appointment_id from private.conversation_generation_appointments where request_id=p_request_id and generation=p_generation));$$);
select pg_temp.patch_appointment_no_show('private.lock_member_retention_metadata()',
 $$perform private.lock_retention_safety_metadata();$$,
 $$lock table private.appointment_review_holds,private.appointment_review_windows,private.appointment_review_normal_completions in exclusive mode nowait;
 perform private.lock_retention_safety_metadata();$$);

-- 40900과41000 사이 owner 합성 상태도 같은 명시 판정에 따라 이관한다. 접수/검토만인 약속은 바꾸지 않는다.
do $$declare appointment_id uuid;begin
 for appointment_id in select distinct h.appointment_id from private.appointment_review_holds h where h.state='no_show' order by h.appointment_id loop
  perform private.sync_appointment_review_terminal_state(appointment_id);
  perform private.sync_completion_reservation(appointment_id);
  perform private.sync_appointment_safety_results(appointment_id,false,false);
  perform private.invalidate_appointment_review_summaries(array[appointment_id]);
 end loop;
end;$$;

-- 공개/회원/워커 권한을 추가하지 않는다. 기존 OID/owner/ACL을 그대로 유지한다.
do $$declare owner_name text;signature text;begin
 if exists(select 1 from appointment_no_show_baseline b left join pg_proc p on p.oid=b.oid
 where p.oid is null or p.proowner<>b.proowner or p.proacl is distinct from b.proacl)then
  raise exception 'appointment_no_show_source_catalog_changed' using errcode='55000';end if;
 if exists(select 1 from appointment_no_show_baseline b where b.proowner<>(select relowner from pg_class where oid='public.appointments'::regclass))then
  raise exception 'appointment_no_show_core_owner_mismatch' using errcode='55000';end if;
 select pg_get_userbyid(relowner)into owner_name from pg_class where oid='public.appointments'::regclass;
 execute format('alter table private.appointment_review_normal_completions owner to %I',owner_name);
 foreach signature in array array['private.sync_appointment_review_terminal_state(uuid)',
 'private.extend_retention_appointment_review_state(jsonb,uuid[])',
 'private.preserve_appointment_review_report_closure()']loop
  execute format('alter function %s owner to %I',signature,owner_name);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,yumidang_worker_queue',signature);
 end loop;
end;$$;
comment on function private.sync_appointment_review_terminal_state(uuid) is
 'owner-only 노쇼 종결 및 마지막 정상정정 연결. 이미 탈퇴한 당사자가 있고 완료전이면 마지막 검토해소 시각에 automatic 첫 실제완료와7일을 시작한다. 탈퇴회원 활동/후기 자격·manual 확인·귀책·incident를 만들지 않는다.';
comment on table private.appointment_review_holds is
 'owner 명시 동행 검토 관계. 최종 no_show는 동행 종결/후기자격 제외이며 귀책·감점·신고종결을 자동 판단하지 않는다. report90일 파기시 연결만NULL로 만들고 최소판정/종결시각은 별도 보관근거 확인까지 유지한다.';
comment on column public.appointments.completion_method is
 'manual: 양쪽 실제 완료확인; automatic: 원 종료+24h 처리 또는 탈퇴 당사자가 있는 완료전 노쇼의 마지막 owner 정상정정 시스템 처리. 첫 실제 완료시각은 보존한다.';
comment on table private.appointment_review_normal_completions is
 'owner-only 탈퇴 이후 정상정정 첫 실제완료의 좁은 원장 근거. 원 기한 이전 처리의 예외이며 예약/회원 호출의 임의 조기완료 허용이 아니다.';
drop table appointment_no_show_baseline;
commit;
