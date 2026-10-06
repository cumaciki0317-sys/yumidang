-- 민규 C: 배정 담당자의 명시 검토 시작. 실제 적용/SQL 회귀는 NOT_RUN.
-- 선행70/71 불변. 판정/종결/통지/이의 시각이나 권한을 추가하지 않는다.
begin;
do $$declare own oid;owner_name text;t regclass;f regprocedure;gateway text;begin
 select proowner,pg_get_userbyid(proowner)into strict own,owner_name from pg_proc where oid='private.require_assigned_report_operator(uuid)'::regprocedure;
 if owner_name in('anon','authenticated','service_role','authenticator')or
 (select proowner from pg_proc where oid='private.enter_appointment_review(uuid,uuid)'::regprocedure)<>own then
  raise exception 'report_review_owner_incompatible'using errcode='55000';end if;
 foreach gateway in array array['anon','authenticated','service_role','authenticator']loop
  if pg_has_role(gateway,owner_name,'USAGE')or pg_has_role(gateway,owner_name,'SET')then raise exception 'report_review_owner_incompatible'using errcode='55000';end if;
 end loop;
 if not has_schema_privilege(owner_name,'private','USAGE')or not has_schema_privilege(owner_name,'auth','USAGE')then raise exception 'report_review_owner_incompatible'using errcode='55000';end if;
 foreach f in array array['auth.uid()'::regprocedure,'auth.jwt()'::regprocedure,'auth.role()'::regprocedure,'private.require_assigned_report_operator(uuid)'::regprocedure,'private.enter_appointment_review(uuid,uuid)'::regprocedure,'private.profile_retired(uuid)'::regprocedure]loop
  if not has_function_privilege(owner_name,f,'EXECUTE')then raise exception 'report_review_owner_incompatible'using errcode='55000';end if;
 end loop;
 foreach t in array array['private.member_reports'::regclass,'public.appointments'::regclass]loop
  if not has_table_privilege(owner_name,t,'SELECT')or not has_table_privilege(owner_name,t,'UPDATE')or
   (select relrowsecurity and not((relowner=own and not relforcerowsecurity)or(select rolsuper or rolbypassrls from pg_roles where oid=own))from pg_class where oid=t)then
   raise exception 'report_review_owner_incompatible'using errcode='55000';end if;
 end loop;
end;$$;
alter table private.member_reports add column review_version bigint not null default 1 check(review_version between 1 and 9007199254740991);
-- 회원 DTO는 불변. 기존 owner 상태 변경도 새 버전에 반영하며 상태 의미는 바꾸지 않는다.
create function private.bump_report_review_version()
returns trigger language plpgsql set search_path='' as $$begin
 if new.status is distinct from old.status then
  if old.review_version>=9007199254740991 then raise exception 'report_review_version_exhausted'using errcode='55000';end if;
  new.review_version:=old.review_version+1;
 end if;
 return new;
end;$$;
create trigger report_review_version before update of status on private.member_reports
 for each row execute function private.bump_report_review_version();
-- 성공 영수증 자체가 구조화 변경 감사다. Auth 삭제는 audit UUID를 지우거나 차단하지 않는다.
-- 신고 실제 파기와 함께 삭제되며 별도 보관기간을 임의 확정하지 않는다.
create table private.report_review_start_receipts(
 actor_id uuid not null,request_id uuid not null,report_id uuid not null references private.member_reports(id)on delete cascade,
 expected_version bigint not null check(expected_version between 1 and 9007199254740990),result_version bigint not null check(result_version between 1 and 9007199254740991),
 previous_status text not null check(previous_status in('received','more_evidence')),
 result_status text not null default 'reviewing'check(result_status='reviewing'),hold_id uuid,
 happened_at timestamptz not null default clock_timestamp(),
 primary key(actor_id,request_id),check(result_version=expected_version+1)
);
alter table private.report_review_start_receipts enable row level security;
revoke all on private.report_review_start_receipts from public,anon,authenticated,service_role;
create function public.start_assigned_report_review(p_report_id uuid,p_request_id uuid,p_expected_version bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid;r private.member_reports;snapshot private.member_reports;receipt private.report_review_start_receipts;
 hold jsonb;hold_id uuid;n timestamptz;result_version bigint;begin
 if p_report_id is null or p_request_id is null or p_expected_version is null or p_expected_version<1 or p_expected_version>=9007199254740991 then raise exception 'invalid_input'using errcode='22023';end if;
 actor:=private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 -- 같은 request를 다른 report에 재사용하지 않는다. raw payload/identity 입력은 없다.
 perform pg_advisory_xact_lock(hashtextextended(actor::text||':'||p_request_id::text,155136));
 select *into snapshot from private.member_reports where id=p_report_id;
 if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
 -- appointment → report 순서다. 일반 신고에 약속 보류를 자동 생성하지 않는다.
 if snapshot.target_type='appointment'then
  perform 1 from public.appointments where id=snapshot.target_id for update nowait;
  if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
 end if;
 select *into r from private.member_reports where id=p_report_id for update nowait;
 n:=clock_timestamp();
 if not found or(r.retention_due_at is not null and r.retention_due_at<=n)then raise exception 'report_unavailable'using errcode='PT404';end if;
 if r.target_type is distinct from snapshot.target_type or r.target_id is distinct from snapshot.target_id then raise exception 'report_review_target_conflict'using errcode='40001';end if;
 select *into receipt from private.report_review_start_receipts where actor_id=actor and request_id=p_request_id;
 if found then
  if receipt.report_id<>p_report_id or receipt.expected_version<>p_expected_version then raise exception 'report_review_request_conflict'using errcode='40001';end if;
  perform private.require_assigned_report_operator(p_report_id);
  return jsonb_build_object('reportId',receipt.report_id,'status',receipt.result_status,'version',receipt.result_version,'holdId',receipt.hold_id,'alreadyApplied',true);
 end if;
 if r.review_version<>p_expected_version or r.status not in('received','more_evidence')or r.final_closed_at is not null then raise exception 'report_review_state_conflict'using errcode='40001';end if;
 update private.member_reports set status='reviewing',updated_at=n where id=r.id;
 if r.target_type='appointment'then
  hold:=private.enter_appointment_review(r.id,r.target_id);
  if hold->>'state'is distinct from 'reviewing'or hold->>'holdId'is null then raise exception 'report_review_hold_conflict'using errcode='40001';end if;
  hold_id:=(hold->>'holdId')::uuid;
 end if;
 perform private.require_assigned_report_operator(p_report_id);
 select review_version into result_version from private.member_reports where id=r.id;
 insert into private.report_review_start_receipts(actor_id,request_id,report_id,expected_version,result_version,previous_status,hold_id)
 values(actor,p_request_id,r.id,r.review_version,result_version,r.status,hold_id);
 return jsonb_build_object('reportId',r.id,'status','reviewing','version',result_version,'holdId',hold_id,'alreadyApplied',false);
exception when lock_not_available then raise exception 'report_review_state_conflict'using errcode='40001';
end;$$;
do $$declare own text;f regprocedure;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='private.require_assigned_report_operator(uuid)'::regprocedure;
 execute format('alter table private.report_review_start_receipts owner to %I',own);
 foreach f in array array['private.bump_report_review_version()'::regprocedure,'public.start_assigned_report_review(uuid,uuid,bigint)'::regprocedure]loop
  execute format('alter function %s owner to %I',f,own);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end;$$;
grant execute on function public.start_assigned_report_review(uuid,uuid,bigint)to authenticated;
commit;
