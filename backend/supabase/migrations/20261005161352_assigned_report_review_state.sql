-- 민규 C: source72 이후 담당자용 현재 상태/안전정수 버전 읽기. 실제 실행 NOT_RUN.
-- 원문/신고자/약속/시각/증거 없이 reportId/status/version만 반환한다. SQL70/71/72 불변.
begin;
do $$declare own oid;owner_name text;f regprocedure;gateway text;begin
 select proowner,pg_get_userbyid(proowner)into strict own,owner_name from pg_proc where oid='public.get_assigned_member_report(uuid)'::regprocedure;
 if owner_name in('anon','authenticated','service_role','authenticator')or
 (select proowner from pg_proc where oid='private.require_assigned_report_operator(uuid)'::regprocedure)<>own then raise exception 'report_state_owner_incompatible'using errcode='55000';end if;
 foreach gateway in array array['anon','authenticated','service_role','authenticator']loop
  if pg_has_role(gateway,owner_name,'USAGE')or pg_has_role(gateway,owner_name,'SET')then raise exception 'report_state_owner_incompatible'using errcode='55000';end if;
 end loop;
 if not has_schema_privilege(owner_name,'private','USAGE')or not has_schema_privilege(owner_name,'auth','USAGE')then raise exception 'report_state_owner_incompatible'using errcode='55000';end if;
 foreach f in array array['auth.uid()'::regprocedure,'auth.jwt()'::regprocedure,'auth.role()'::regprocedure,'private.require_assigned_report_operator(uuid)'::regprocedure,'private.profile_retired(uuid)'::regprocedure]loop
  if not has_function_privilege(owner_name,f,'EXECUTE')then raise exception 'report_state_owner_incompatible'using errcode='55000';end if;
 end loop;
 if not has_table_privilege(owner_name,'private.member_reports','SELECT')or not has_table_privilege(owner_name,'private.member_reports','UPDATE')or
 (select relrowsecurity and not((relowner=own and not relforcerowsecurity)or(select rolsuper or rolbypassrls from pg_roles where oid=own))from pg_class where oid='private.member_reports'::regclass)or
 not has_table_privilege(owner_name,'private.report_access_audit','INSERT')or not has_sequence_privilege(owner_name,'private.report_access_audit_id_seq','USAGE')then
  raise exception 'report_state_owner_incompatible'using errcode='55000';end if;
end;$$;
create function public.get_assigned_report_review_state(p_report_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare actor uuid;r private.member_reports;begin
 if p_report_id is null then raise exception 'invalid_input'using errcode='22023';end if;
 actor:=private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 -- 쓰기 경로의 appointment → report 순서를 역전하지 않는다. 약속/hold에는 잠금을 추가하지 않는다.
 select *into r from private.member_reports where id=p_report_id for share;
 if not found or(r.retention_due_at is not null and r.retention_due_at<=clock_timestamp())then raise exception 'report_unavailable'using errcode='PT404';end if;
 if r.review_version is null or r.review_version not between 1 and 9007199254740991 or r.status not in('received','reviewing','more_evidence','resolved')then
  raise exception 'report_state_invalid'using errcode='55000';end if;
 -- row lock 대기 뒤 세션 시각/권한과 보관 시각을 다시 판정한다. 권한 실패는 audit도 남기지 않는다.
 perform private.require_assigned_report_operator(p_report_id);
 if private.profile_retired(actor)then raise exception 'operator_access_denied'using errcode='42501';end if;
 if r.retention_due_at is not null and r.retention_due_at<=clock_timestamp()then raise exception 'report_unavailable'using errcode='PT404';end if;
 insert into private.report_access_audit(actor_id,report_id,action)values(actor,r.id,'report_read');
 return jsonb_build_object('reportId',r.id,'status',r.status,'version',r.review_version);
end;$$;
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.get_assigned_member_report(uuid)'::regprocedure;
 execute format('alter function public.get_assigned_report_review_state(uuid) owner to %I',own);
end;$$;
revoke all on function public.get_assigned_report_review_state(uuid)from public,anon,authenticated,service_role;
grant execute on function public.get_assigned_report_review_state(uuid)to authenticated;
commit;
