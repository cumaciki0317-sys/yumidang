-- 종현: 승인된 직원 탈퇴. 원 영수증과 신고 파기 관계는 보존하며 실제 운영 적용은 별도다.
begin;
-- 정확한 세 actor/Auth FK만 분리한다. PK/UUID/NOT NULL/원 요청 키/결과/보관 시계는 바꾸지 않는다.
do $$declare target regclass;actor smallint;client smallint;auth_id smallint;f record;total integer;begin
 select attnum into strict auth_id from pg_attribute where attrelid='auth.users'::regclass and attname='id'and not attisdropped;
 foreach target in array array['private.assigned_report_final_closures'::regclass,
  'private.general_sanction_appeal_resolutions'::regclass,'private.cancellation_clock_repair_receipts'::regclass]loop
  select attnum into strict actor from pg_attribute where attrelid=target and attname='actor_id'and attnotnull and atttypid='uuid'::regtype and not attisdropped;
  select attnum into strict client from pg_attribute where attrelid=target and attname='client_request_id'and attnotnull and atttypid='uuid'::regtype and not attisdropped;
  if not exists(select 1 from pg_constraint where conrelid=target and contype='p'and conkey=array[actor,client]::smallint[])then
   raise exception 'operator_receipt_primary_key_changed'using errcode='55000';end if;
  select count(*)into total from pg_constraint where conrelid=target and contype='f'and actor=any(conkey);
  if total<>1 then raise exception 'operator_receipt_auth_fk_changed'using errcode='55000';end if;
  select *into strict f from pg_constraint where conrelid=target and contype='f'and conkey=array[actor]::smallint[];
  if f.confrelid<>'auth.users'::regclass or f.confkey<>array[auth_id]::smallint[]or f.confdeltype<>'a'
   or f.confupdtype<>'a'or f.confmatchtype<>'s'or f.condeferrable or not f.convalidated then
   raise exception 'operator_receipt_auth_fk_changed'using errcode='55000';end if;
  execute format('alter table %s drop constraint %I',target,f.conname);
 end loop;
end;$$;

create or replace function private.require_assigned_report_operator(p_report_id uuid)
returns uuid language plpgsql volatile security definer set search_path=''as $$
declare u uuid:=auth.uid();sid uuid;n timestamptz:=clock_timestamp();begin
 if u is null or auth.role()<>'authenticated'or coalesce((auth.jwt()->>'is_anonymous')::boolean,false)then raise exception 'login_required'using errcode='28000';end if;
 begin sid:=(auth.jwt()->>'session_id')::uuid;exception when invalid_text_representation then raise exception 'login_required'using errcode='28000';end;
 if sid is null then raise exception 'login_required'using errcode='28000';end if;
 perform 1 from auth.users where id=u for key share;
 if not found then raise exception 'login_required'using errcode='28000';end if;
 perform 1 from auth.sessions where id=sid and user_id=u and(not_after is null or not_after>n)for share;
 if not found then raise exception 'login_required'using errcode='28000';end if;
 if private.profile_retired(u)then raise exception 'operator_access_denied'using errcode='42501';end if;
 perform 1 from private.report_operator_approvals where auth_user_id=u and revoked_at is null for share nowait;
 if not found then raise exception 'operator_access_denied'using errcode='42501';end if;
 perform 1 from private.report_operator_assignments where report_id=p_report_id and operator_uid=u and revoked_at is null for share nowait;
 if not found then raise exception 'operator_access_denied'using errcode='42501';end if;
 return u;
exception when lock_not_available then raise exception 'operator_state_conflict'using errcode='40001';end;$$;

create or replace function private.set_report_operator_approval(p_user_id uuid,p_approved boolean)
returns void language plpgsql volatile security definer set search_path=''as $$begin
 if p_user_id is null or p_approved is null then raise exception 'invalid_input'using errcode='22023';end if;
 perform 1 from auth.users where id=p_user_id for key share;
 if not found then raise exception 'operator_user_unavailable'using errcode='PT404';end if;
 if p_approved then
  -- 없는 profile은 비회원 직원의 기존 허용 범위다. 회원 가입 조건을 추가하지 않는다.
  perform 1 from public.profiles where id=p_user_id for key share nowait;
  if private.profile_retired(p_user_id)then raise exception 'operator_access_denied'using errcode='42501';end if;
 end if;
 insert into private.report_operator_approvals(auth_user_id)values(p_user_id)on conflict do nothing;
 perform 1 from private.report_operator_approvals where auth_user_id=p_user_id for update nowait;
 update private.report_operator_approvals set approved_at=case when p_approved and revoked_at is not null then clock_timestamp()else approved_at end,
  revoked_at=case when p_approved then null else coalesce(revoked_at,clock_timestamp())end where auth_user_id=p_user_id;
exception when lock_not_available then raise exception 'operator_state_conflict'using errcode='40001';end;$$;

create or replace function private.set_report_operator_assignment(p_user_id uuid,p_report_id uuid,p_assigned boolean)
returns void language plpgsql volatile security definer set search_path=''as $$begin
 if p_user_id is null or p_report_id is null or p_assigned is null then raise exception 'invalid_input'using errcode='22023';end if;
 perform 1 from auth.users where id=p_user_id for key share;
 if not found then raise exception 'operator_user_unavailable'using errcode='PT404';end if;
 if p_assigned then
  perform 1 from public.profiles where id=p_user_id for key share nowait;
  if private.profile_retired(p_user_id)then raise exception 'operator_access_denied'using errcode='42501';end if;
  perform 1 from private.report_operator_approvals where auth_user_id=p_user_id and revoked_at is null for share nowait;
  if not found then raise exception 'operator_access_denied'using errcode='42501';end if;
 end if;
 -- 동일 회원/신고의 기존 provisioning 직렬화 키를 유지한다.
 perform pg_advisory_xact_lock(hashtextextended(p_report_id::text||':'||p_user_id::text,143318));
 perform 1 from private.report_operator_assignments where report_id=p_report_id and operator_uid=p_user_id and revoked_at is null for update nowait;
 if p_assigned then
  perform 1 from private.member_reports where id=p_report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for key share;
  if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
  insert into private.report_operator_assignments(report_id,operator_uid)values(p_report_id,p_user_id)
   on conflict(report_id,operator_uid)where revoked_at is null and operator_uid is not null do nothing;
 else update private.report_operator_assignments set revoked_at=clock_timestamp()where report_id=p_report_id and operator_uid=p_user_id and revoked_at is null;
 end if;
exception when lock_not_available then raise exception 'operator_state_conflict'using errcode='40001';end;$$;

create function private.revoke_retired_report_operator()
returns trigger language plpgsql volatile security definer set search_path=''as $$
declare assignment_id uuid;begin
 -- 직원 이력이 없는 일반 회원은 기존 탈퇴의 Auth 잠금/실패 계약을 그대로 사용한다.
 if not exists(select 1 from private.report_operator_approvals where auth_user_id=new.profile_id)
  and not exists(select 1 from private.report_operator_assignments where operator_uid=new.profile_id)then return new;end if;
 -- 기존 탈퇴의 profile 잠금 뒤에는 기다리지 않는다. 충돌은 전체 탈퇴 TX rollback이다.
 perform 1 from auth.users where id=new.profile_id for update nowait;
 if not found then raise exception 'operator_retirement_parent_missing'using errcode='40001';end if;
 perform 1 from private.report_operator_approvals where auth_user_id=new.profile_id for update nowait;
 update private.report_operator_approvals set revoked_at=coalesce(revoked_at,new.retired_at)where auth_user_id=new.profile_id;
 for assignment_id in select id from private.report_operator_assignments where operator_uid=new.profile_id order by id for update nowait loop
  update private.report_operator_assignments set revoked_at=coalesce(revoked_at,new.retired_at)
   where id=assignment_id and operator_uid=new.profile_id;
 end loop;
 return new;
exception when lock_not_available then raise exception 'operator_state_conflict'using errcode='40001';end;$$;
create trigger retire_report_operator after insert on private.member_retirements
 for each row execute function private.revoke_retired_report_operator();

-- 기존 owner/ACL을 보존한다. 새 trigger만 같은 직원 권한 owner로 두고 공개 실행을 닫는다.
do $$declare own text;own_id oid;target regclass;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='private.require_assigned_report_operator(uuid)'::regprocedure;
 select oid into strict own_id from pg_roles where rolname=own;
 if own in('anon','authenticated','service_role','authenticator','yumidang_worker_queue')or
  not has_function_privilege(own,'private.profile_retired(uuid)','EXECUTE')or
  not has_table_privilege(own,'auth.users','SELECT')or not has_table_privilege(own,'auth.users','UPDATE')or
  not has_table_privilege(own,'public.profiles','SELECT')or not has_table_privilege(own,'public.profiles','UPDATE')or
  not has_table_privilege(own,'private.report_operator_approvals','UPDATE')or
  not has_table_privilege(own,'private.report_operator_assignments','UPDATE')then
  raise exception 'operator_retirement_owner_incompatible'using errcode='55000';end if;
 if exists(select 1 from pg_proc where oid in('private.set_report_operator_approval(uuid,boolean)'::regprocedure,
  'private.set_report_operator_assignment(uuid,uuid,boolean)'::regprocedure)and proowner<>own_id)then
  raise exception 'operator_retirement_owner_incompatible'using errcode='55000';end if;
 foreach target in array array['auth.users'::regclass,'public.profiles'::regclass,
  'private.report_operator_approvals'::regclass,'private.report_operator_assignments'::regclass]loop
  if(select relrowsecurity and not((relowner=own_id and not relforcerowsecurity)
   or(select rolsuper or rolbypassrls from pg_roles where oid=own_id))from pg_class where oid=target)then
   raise exception 'operator_retirement_owner_incompatible'using errcode='55000';end if;
 end loop;
 execute format('alter function private.revoke_retired_report_operator()owner to %I',own);
end;$$;
revoke all on function private.revoke_retired_report_operator()from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
-- Auth 승인 CASCADE/배정 SET NULL 및 report/appeal CASCADE·2160시간 파기 계약은 그대로다.
commit;
