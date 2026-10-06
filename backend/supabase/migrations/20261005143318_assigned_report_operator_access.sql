-- 민규: 기본 비어 있는 승인 UID/사건 배정과 제출 자료 metadata 읽기. 직원 운영 계정을 등록하지 않는다.
begin;
create table private.report_operator_approvals(
 auth_user_id uuid primary key references auth.users(id)on delete cascade,
 approved_at timestamptz not null default clock_timestamp(),revoked_at timestamptz,
 check(revoked_at is null or revoked_at>=approved_at)
);
create table private.report_operator_assignments(
 id uuid primary key default gen_random_uuid(),report_id uuid not null references private.member_reports(id)on delete cascade,
 operator_uid uuid references auth.users(id)on delete set null,
 assigned_at timestamptz not null default clock_timestamp(),revoked_at timestamptz,
 check(revoked_at is null or revoked_at>=assigned_at)
);
create unique index report_operator_one_assignment on private.report_operator_assignments(report_id,operator_uid)where revoked_at is null and operator_uid is not null;
alter table private.report_operator_approvals enable row level security;
alter table private.report_operator_assignments enable row level security;
revoke all on private.report_operator_approvals,private.report_operator_assignments from public,anon,authenticated,service_role;
create function private.require_assigned_report_operator(p_report_id uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=auth.uid();sid uuid;n timestamptz:=clock_timestamp();begin
 if u is null or auth.role()<>'authenticated'or coalesce((auth.jwt()->>'is_anonymous')::boolean,false)then raise exception 'login_required'using errcode='28000';end if;
 begin sid:=(auth.jwt()->>'session_id')::uuid;exception when invalid_text_representation then raise exception 'login_required'using errcode='28000';end;
 if sid is null then raise exception 'login_required'using errcode='28000';end if;
 -- Auth harddelete와 공유하는 부모→session→approval→assignment 순서다. 회원 가입/네이버 자격을 직원 증명으로 쓰지 않는다.
 perform 1 from auth.users where id=u for key share;
 if not found then raise exception 'login_required'using errcode='28000';end if;
 perform 1 from auth.sessions where id=sid and user_id=u and(not_after is null or not_after>n)for share;
 if not found then raise exception 'login_required'using errcode='28000';end if;
 perform 1 from private.report_operator_approvals where auth_user_id=u and revoked_at is null for share;
 if not found then raise exception 'operator_access_denied'using errcode='42501';end if;
 perform 1 from private.report_operator_assignments where report_id=p_report_id and operator_uid=u and revoked_at is null for share;
 if not found then raise exception 'operator_access_denied'using errcode='42501';end if;
 return u;
end;$$;
-- provisioning은 owner-only다. 외부 역할에 execute를 주거나 담당자를 자동 생성하지 않는다.
create function private.set_report_operator_approval(p_user_id uuid,p_approved boolean)
returns void language plpgsql volatile security definer set search_path='' as $$begin
 if p_user_id is null or p_approved is null then raise exception 'invalid_input'using errcode='22023';end if;
 perform 1 from auth.users where id=p_user_id for key share;
 if not found then raise exception 'operator_user_unavailable'using errcode='PT404';end if;
 insert into private.report_operator_approvals(auth_user_id)values(p_user_id)on conflict do nothing;
 perform 1 from private.report_operator_approvals where auth_user_id=p_user_id for update;
 update private.report_operator_approvals set approved_at=case when p_approved and revoked_at is not null then clock_timestamp()else approved_at end,
 revoked_at=case when p_approved then null else coalesce(revoked_at,clock_timestamp())end where auth_user_id=p_user_id;
end;$$;
create function private.set_report_operator_assignment(p_user_id uuid,p_report_id uuid,p_assigned boolean)
returns void language plpgsql volatile security definer set search_path='' as $$begin
 if p_user_id is null or p_report_id is null or p_assigned is null then raise exception 'invalid_input'using errcode='22023';end if;
 perform 1 from auth.users where id=p_user_id for key share;
 if not found then raise exception 'operator_user_unavailable'using errcode='PT404';end if;
 perform 1 from private.report_operator_approvals where auth_user_id=p_user_id and revoked_at is null for share;
 if not found then raise exception 'operator_access_denied'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_report_id::text||':'||p_user_id::text,143318));
 perform 1 from private.report_operator_assignments where report_id=p_report_id and operator_uid=p_user_id and revoked_at is null for update;
 if p_assigned then
  perform 1 from private.member_reports where id=p_report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for key share;
  if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
  insert into private.report_operator_assignments(report_id,operator_uid)values(p_report_id,p_user_id)
   on conflict(report_id,operator_uid)where revoked_at is null and operator_uid is not null do nothing;
 else update private.report_operator_assignments set revoked_at=clock_timestamp()where report_id=p_report_id and operator_uid=p_user_id and revoked_at is null;
 end if;
end;$$;
create function private.assigned_report_capture_json(p_report_id uuid,p_asset_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare a private.report_capture_assets;o storage.objects;size_value numeric;begin
 select *into a from private.report_capture_assets where id=p_asset_id and report_id=p_report_id and state='attached'for share;
 if not found then raise exception 'capture_unavailable'using errcode='PT404';end if;
 select *into o from storage.objects where bucket_id='report-evidence'and name=a.object_name and owner_id=a.owner_id::text for share;
 if not found then raise exception 'capture_unavailable'using errcode='PT404';end if;
 if a.object_name!~('^'||a.owner_id::text||'/'||a.id::text||'\.(jpg|png|webp)$')or coalesce(o.metadata->>'mimetype','')not in('image/jpeg','image/png','image/webp')
 or coalesce(o.metadata->>'size','')!~'^[0-9]{1,7}$'then raise exception 'capture_unavailable'using errcode='PT404';end if;
 size_value:=(o.metadata->>'size')::numeric;
 if size_value not between 1 and 5242880 then raise exception 'capture_unavailable'using errcode='PT404';end if;
 return jsonb_build_object('reportId',p_report_id,'assetId',a.id,'bucket','report-evidence','path',a.object_name,
 'objectId',o.id,'mimeType',o.metadata->>'mimetype','byteSize',size_value);
end;$$;
create function public.get_assigned_report_capture(p_report_id uuid,p_asset_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_assigned_report_operator(p_report_id);result jsonb;begin
 perform 1 from private.member_reports where id=p_report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share;
 if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
 result:=private.assigned_report_capture_json(p_report_id,p_asset_id);
 insert into private.report_access_audit(actor_id,report_id,asset_id,action)values(u,p_report_id,p_asset_id,'capture_reference');
 return result;
end;$$;
create function public.get_assigned_member_report(p_report_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_assigned_report_operator(p_report_id);r private.member_reports;description_value text;assets jsonb:='[]';a record;begin
 select *into r from private.member_reports where id=p_report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share;
 if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
 select description into description_value from private.member_report_details where report_id=p_report_id for share;
 if not found then raise exception 'report_unavailable'using errcode='PT404';end if;
 for a in select id from private.report_capture_assets where report_id=p_report_id and state='attached'order by id loop
  assets:=assets||jsonb_build_array(private.assigned_report_capture_json(p_report_id,a.id));
  if jsonb_array_length(assets)>5 then raise exception 'report_invalid_assets'using errcode='55000';end if;
 end loop;
 insert into private.report_access_audit(actor_id,report_id,action)values(u,p_report_id,'report_read');
 return jsonb_build_object('reportId',r.id,'targetType',r.target_type,'context',r.context,'reasonCodes',r.reason_codes,'description',description_value,'assets',assets);
end;$$;
do $$declare own oid;owner_name text;t regclass;f regprocedure;begin
 select proowner,pg_get_userbyid(proowner)into strict own,owner_name from pg_proc where oid='public.get_my_report(uuid)'::regprocedure;
 if owner_name in('anon','authenticated','service_role','authenticator')then raise exception 'operator_owner_incompatible'using errcode='55000';end if;
 foreach t in array array['auth.users'::regclass,'auth.sessions'::regclass,'private.member_reports'::regclass,'private.member_report_details'::regclass,'private.report_capture_assets'::regclass,'storage.objects'::regclass]loop
  if not has_table_privilege(owner_name,t,'SELECT')or not has_table_privilege(owner_name,t,'UPDATE')or(select relrowsecurity and not((relowner=own and not relforcerowsecurity)or(select rolsuper or rolbypassrls from pg_roles where oid=own))from pg_class where oid=t)then
   raise exception 'operator_owner_incompatible'using errcode='55000';end if;
 end loop;
 if not has_table_privilege(owner_name,'private.report_access_audit','INSERT')or not has_sequence_privilege(owner_name,'private.report_access_audit_id_seq','USAGE')then raise exception 'operator_owner_incompatible'using errcode='55000';end if;
 foreach t in array array['private.report_operator_approvals'::regclass,'private.report_operator_assignments'::regclass]loop execute format('alter table %s owner to %I',t,owner_name);end loop;
 foreach f in array array['private.require_assigned_report_operator(uuid)'::regprocedure,'private.set_report_operator_approval(uuid,boolean)'::regprocedure,'private.set_report_operator_assignment(uuid,uuid,boolean)'::regprocedure,'private.assigned_report_capture_json(uuid,uuid)'::regprocedure,'public.get_assigned_report_capture(uuid,uuid)'::regprocedure,'public.get_assigned_member_report(uuid)'::regprocedure]loop
  execute format('alter function %s owner to %I',f,owner_name);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end;$$;
grant execute on function public.get_assigned_member_report(uuid),public.get_assigned_report_capture(uuid,uuid)to authenticated;
-- no rows, staff credential/assignment seed, Storage SELECT policy, blob proxy, state/decision/notice/appeal mutation added.
commit;
