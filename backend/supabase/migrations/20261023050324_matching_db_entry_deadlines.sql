-- 민규: DB statement 진입 상한과 잠금 후 현재상태 판단의 분리 후보.
-- 실제 HTTP ingress/동시성/운영 검증 NOT_RUN. 기존125와 공개RPC 계약은 보존한다.
begin;
create temp table matching_entry_baseline on commit drop as
 select p.oid,p.proowner,p.proacl,p.proconfig,p.prosecdef,p.provolatile,pg_get_functiondef(p.oid) definition
 from pg_proc p where p.oid in(
'private.accept_match_without_blocks(uuid,text)'::regprocedure,'private.request_service_post_without_blocks(uuid,uuid,text)'::regprocedure,'private.accept_appointment_schedule_change_before_member_retirement(uuid,uuid,text)'::regprocedure,'private.appointment_schedule_response_open(uuid,timestamp with time zone)'::regprocedure,'private.expire_post_match_consents(uuid)'::regprocedure);
do $$begin
 if encode(sha256(convert_to(pg_get_functiondef('private.accept_match_without_blocks(uuid,text)'::regprocedure),'UTF8')),'hex')<>'b60cf2372eead589f93149b2cb71604140571c6afe1dd7005a3460af67684941'then raise exception 'matching_entry_source_changed'using errcode='55000';end if;
 if encode(sha256(convert_to(pg_get_functiondef('private.request_service_post_without_blocks(uuid,uuid,text)'::regprocedure),'UTF8')),'hex')<>'6c7e9b2d1bf6530343948422c6ebe42010307d9d074e72e1ae753bb27c6e5365'then raise exception 'matching_entry_source_changed'using errcode='55000';end if;
 if encode(sha256(convert_to(pg_get_functiondef('private.accept_appointment_schedule_change_before_member_retirement(uuid,uuid,text)'::regprocedure),'UTF8')),'hex')<>'0b037ded7b43c6c16937d5a0d216a6b3ffd343725d1447d866473e83b1a515ad'then raise exception 'matching_entry_source_changed'using errcode='55000';end if;
 if encode(sha256(convert_to(pg_get_functiondef('private.appointment_schedule_response_open(uuid,timestamp with time zone)'::regprocedure),'UTF8')),'hex')<>'7e2ece81baf99e9e47b3b55915ab26ee986146345b2a7952220a8e15d409acc6'then raise exception 'matching_entry_source_changed'using errcode='55000';end if;
 if encode(sha256(convert_to(pg_get_functiondef('private.expire_post_match_consents(uuid)'::regprocedure),'UTF8')),'hex')<>'8b092175af48b4f120e14a9ff26cfc43e2ff44cdffb52855857f7a02dde88015'then raise exception 'matching_entry_source_changed'using errcode='55000';end if;
end;$$;
-- 새 SECDEF 내부 호출은 기존 helper와 같은 owner에서만 허용한다.
do $$begin
 if (select proowner from matching_entry_baseline where oid='private.accept_match_without_blocks(uuid,text)'::regprocedure)
 is distinct from(select proowner from matching_entry_baseline where oid='private.expire_post_match_consents(uuid)'::regprocedure)
 or(select proowner from matching_entry_baseline where oid='private.accept_appointment_schedule_change_before_member_retirement(uuid,uuid,text)'::regprocedure)
 is distinct from(select proowner from matching_entry_baseline where oid='private.appointment_schedule_response_open(uuid,timestamptz)'::regprocedure)
 then raise exception 'matching_entry_owner_chain_changed'using errcode='55000';end if;
end;$$;
create function pg_temp.matching_entry_replace(signature text,anchor text,replacement text)
returns void language plpgsql as $$declare body text;begin
 select pg_get_functiondef(signature::regprocedure)into body;
 if anchor=''or(length(body)-length(replace(body,anchor,'')))/length(anchor)<>1 then
  raise exception 'matching_entry_anchor_changed'using errcode='55000';end if;
 execute replace(body,anchor,replacement);
end;$$;
CREATE FUNCTION private.expire_post_match_consents(p_post_id uuid, p_request_id uuid, p_received_at timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare l private.match_consent_lifecycle; n integer:=0;
begin
  for l in select * from private.match_consent_lifecycle where post_id=p_post_id
    and status='awaiting_consent' and expires_at<=case when request_id=p_request_id then p_received_at else clock_timestamp()end order by request_id loop
    perform private.end_match_consent(l.request_id,'expired'); n:=n+1;
  end loop;
  return n;
end; $function$
;
CREATE FUNCTION private.appointment_schedule_response_open(p_change_id uuid, p_received_at timestamp with time zone, p_decision_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce((select c.status='awaiting_response' and ap.status='confirmed' and p_received_at<c.expires_at
    and p_decision_at>=c.requested_at
    and (c.old_location_fingerprint is null or c.old_location_fingerprint=private.appointment_location_fingerprint(p.id))
    and p.starts_at=c.old_starts_at and p.ends_at=c.old_ends_at and p.updated_at=c.old_updated_at
    and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id and (d.status='open' or d.resolution='no_show'))
    from private.appointment_schedule_changes c join public.appointments ap on ap.id=c.appointment_id
    join public.posts p on p.id=ap.post_id where c.change_id=p_change_id),false);
$function$
;
revoke all on function private.expire_post_match_consents(uuid,uuid,timestamptz) from public,anon,authenticated,service_role,yumidang_worker_queue;
do $$declare owner_name text;begin select r.rolname into owner_name from pg_roles r join matching_entry_baseline b on b.proowner=r.oid where b.oid='private.accept_match_without_blocks(uuid,text)'::regprocedure;execute format('alter function private.expire_post_match_consents(uuid,uuid,timestamptz) owner to %I',owner_name);end;$$;
revoke all on function private.appointment_schedule_response_open(uuid,timestamptz,timestamptz) from public,anon,authenticated,service_role,yumidang_worker_queue;
do $$declare owner_name text;begin select r.rolname into owner_name from pg_roles r join matching_entry_baseline b on b.proowner=r.oid where b.oid='private.accept_appointment_schedule_change_before_member_retirement(uuid,uuid,text)'::regprocedure;execute format('alter function private.appointment_schedule_response_open(uuid,timestamptz,timestamptz) owner to %I',owner_name);end;$$;
select pg_temp.matching_entry_replace('private.accept_match_without_blocks(uuid,text)',$anchor$declare v_uid uuid:=private.require_service_profile();$anchor$,$replacement$declare v_received_at timestamptz:=statement_timestamp(); v_uid uuid:=private.require_service_profile();$replacement$);
select pg_temp.matching_entry_replace('private.request_service_post_without_blocks(uuid,uuid,text)',$anchor$declare v_uid uuid:=private.require_service_profile();$anchor$,$replacement$declare v_received_at timestamptz:=statement_timestamp(); v_uid uuid:=private.require_service_profile();$replacement$);
select pg_temp.matching_entry_replace('private.accept_appointment_schedule_change_before_member_retirement(uuid,uuid,text)',$anchor$declare v_uid uuid:=private.require_service_profile();$anchor$,$replacement$declare v_received_at timestamptz:=statement_timestamp(); v_uid uuid:=private.require_service_profile();$replacement$);
select pg_temp.matching_entry_replace('private.accept_match_without_blocks(uuid,text)',$anchor$perform private.expire_post_match_consents(v_post.id);$anchor$,$replacement$perform private.expire_post_match_consents(v_post.id,p_request_id,v_received_at);$replacement$);
select pg_temp.matching_entry_replace('private.accept_match_without_blocks(uuid,text)',$anchor$v_lifecycle.expires_at<=clock_timestamp()$anchor$,$replacement$v_lifecycle.expires_at<=v_received_at$replacement$);
select pg_temp.matching_entry_replace('private.accept_match_without_blocks(uuid,text)',$anchor$v_post.starts_at<=clock_timestamp()$anchor$,$replacement$v_post.starts_at<=v_received_at$replacement$);
select pg_temp.matching_entry_replace('private.request_service_post_without_blocks(uuid,uuid,text)',$anchor$p.recruitment_ends_at<=v_now or p.starts_at<=v_now$anchor$,$replacement$p.recruitment_ends_at<=v_received_at or p.starts_at<=v_received_at$replacement$);
select pg_temp.matching_entry_replace('private.accept_appointment_schedule_change_before_member_retirement(uuid,uuid,text)',$anchor$private.appointment_schedule_response_open(c.change_id,clock_timestamp())$anchor$,$replacement$private.appointment_schedule_response_open(c.change_id,v_received_at,clock_timestamp())$replacement$);
do $$begin
 if exists(select 1 from matching_entry_baseline b join pg_proc p on p.oid=b.oid
 where p.proowner<>b.proowner or p.proacl is distinct from b.proacl or p.proconfig is distinct from b.proconfig
 or p.prosecdef<>b.prosecdef or p.provolatile<>b.provolatile)then raise exception 'matching_entry_catalog_changed';end if;
 if exists(select 1 from matching_entry_baseline b where b.oid in(
 'private.appointment_schedule_response_open(uuid,timestamptz)'::regprocedure,
 'private.expire_post_match_consents(uuid)'::regprocedure)and pg_get_functiondef(b.oid)<>b.definition)
 then raise exception 'matching_entry_original_helper_changed';end if;
 if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
 where p.oid in('private.appointment_schedule_response_open(uuid,timestamptz,timestamptz)'::regprocedure,
 'private.expire_post_match_consents(uuid,uuid,timestamptz)'::regprocedure)and a.grantee<>p.proowner)
 then raise exception 'matching_entry_new_helper_acl';end if;
end;$$;
commit;
