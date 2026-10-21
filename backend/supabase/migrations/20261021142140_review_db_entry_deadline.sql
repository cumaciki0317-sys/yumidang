-- 민규: DB statement 접수 마감만 분리한다. HTTP ingress 미증명 / policyComplete=false.
-- 기존 3인수 helper/OID/ACL 및 deepest write의 idempotent 분기를 보존한다.
begin;
create temp table review_entry_baseline on commit drop as
select p.oid,p.proowner,p.proacl,p.proconfig,p.prosecdef,p.provolatile,pg_get_functiondef(p.oid) definition
from pg_proc p where p.oid in(
 'private.can_submit_appointment_review(uuid,uuid,timestamptz)'::regprocedure,
 'private.submit_appointment_review_before_member_retirement(uuid,integer,text,text,text[])'::regprocedure);
do $$begin
 if (select encode(sha256(convert_to(definition,'UTF8')),'hex') from review_entry_baseline
 where oid='private.can_submit_appointment_review(uuid,uuid,timestamptz)'::regprocedure)
 <> 'f2ac1dfe9d6f9c519e75977c1115936df05cefddc43265ca12bd7c57978f20c1'
 or (select encode(sha256(convert_to(definition,'UTF8')),'hex') from review_entry_baseline
 where oid='private.submit_appointment_review_before_member_retirement(uuid,integer,text,text,text[])'::regprocedure)
 <> 'f63b808809a7d8a27c7a8d1149096562e16f1932219d8305169d8b6bf4193102' then
 raise exception 'review_entry_source_changed' using errcode='55000';end if;
end;$$;
create function private.can_submit_appointment_review(p_appointment_id uuid,p_uid uuid,p_received_at timestamptz,p_decision_at timestamptz)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select p_uid in(p.author_id,r.requester_id) and p.author_id<>r.requester_id and not private.appointment_review_held(ap.id)
    and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id
      and (d.status='open' or d.resolution='no_show'))
    and ((ap.status='confirmed' and ap.completed_at is null and p_decision_at>=p.ends_at
      and exists(select 1 from public.appointment_completion_confirmations c
        where c.appointment_id=ap.id and c.user_id=p_uid))
      or (ap.status='completed' and ap.completed_at is not null
        and (ap.completion_method='automatic' or (ap.completion_method='manual'
          and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=p.author_id)
          and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=r.requester_id)))
        and (ap.review_deadline_at is not null and p_decision_at>=ap.completed_at and p_received_at<ap.review_deadline_at)))
    from public.appointments ap join public.posts p on p.id=ap.post_id join public.join_requests r on r.id=ap.join_request_id
    where ap.id=p_appointment_id),false);
$$;
revoke all on function private.can_submit_appointment_review(uuid,uuid,timestamptz,timestamptz)
 from public,anon,authenticated,service_role,yumidang_worker_queue;
do $$declare owner_name text;definition text;anchor text;replacement text;begin
 select r.rolname into owner_name from pg_roles r join review_entry_baseline b on b.proowner=r.oid
 where b.oid='private.can_submit_appointment_review(uuid,uuid,timestamptz)'::regprocedure;
 execute format('alter function private.can_submit_appointment_review(uuid,uuid,timestamptz,timestamptz) owner to %I',owner_name);
 if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 where p.oid='private.can_submit_appointment_review(uuid,uuid,timestamptz,timestamptz)'::regprocedure
 and a.grantee<>p.proowner) then raise exception 'review_entry_unexpected_new_acl';end if;
 select b.definition into definition from review_entry_baseline b
 where b.oid='private.submit_appointment_review_before_member_retirement(uuid,integer,text,text,text[])'::regprocedure;
 anchor:='declare v_uid uuid:=auth.uid();';
 replacement:='declare v_received_at timestamptz:=statement_timestamp(); v_decision_at timestamptz; v_uid uuid:=auth.uid();';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'review_entry_declaration_anchor';end if;
 definition:=replace(definition,anchor,replacement);
 anchor:='if not private.can_submit_appointment_review(p_appointment_id,v_uid,clock_timestamp()) then';
 replacement:='v_decision_at:=clock_timestamp();
  if not private.can_submit_appointment_review(p_appointment_id,v_uid,v_received_at,v_decision_at) then';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'review_entry_decision_anchor';end if;
 execute replace(definition,anchor,replacement);
 if exists(select 1 from review_entry_baseline b left join pg_proc p on p.oid=b.oid
 where p.oid is null or row(p.proowner,p.proacl,p.proconfig,p.prosecdef,p.provolatile)
 is distinct from row(b.proowner,b.proacl,b.proconfig,b.prosecdef,b.provolatile)
 or (b.oid='private.can_submit_appointment_review(uuid,uuid,timestamptz)'::regprocedure and pg_get_functiondef(p.oid)<>b.definition))
 then raise exception 'review_entry_original_catalog_changed';end if;
end;$$;
commit;
