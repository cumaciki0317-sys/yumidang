-- 민규: 원 종료회차 사건의 최초 제재는 identity에 적용하며 새회차 감점을 만들지 않는다.
begin;
create function private.require_historical_safety_episode(p_identity_id uuid,p_episode_id uuid)returns uuid
language plpgsql stable security definer set search_path=''as $$
declare e private.member_episodes;begin
 select *into e from private.member_episodes where id=p_episode_id and identity_id=p_identity_id;
 if not found then raise exception 'verified_member_episode_required'using errcode='42501';end if;
 if e.ended_at is null then return private.require_verified_safety_episode(p_identity_id,p_episode_id);end if;
 if not isfinite(e.ended_at)or e.ended_at>clock_timestamp()or not exists(select 1 from private.naver_identity_keys where id=e.identity_id)
 or not exists(select 1 from private.member_retirements where episode_id=e.id and profile_id=e.profile_id and retired_at=e.ended_at)then
  raise exception 'historical_member_episode_unverified'using errcode='42501';end if;
 return e.profile_id;end;$$;
do $$declare own text;f regprocedure;definition text;old text;replacement text;count integer;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='private.require_verified_safety_episode(uuid,uuid)'::regprocedure;
 execute format('alter function private.require_historical_safety_episode(uuid,uuid)owner to %I',own);
 foreach f in array array['private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)'::regprocedure,'private.recompute_safety_applications(uuid)'::regprocedure,'private.sync_safety_incident_sweetness(uuid)'::regprocedure,'private.reconcile_cancellation_chain(uuid,uuid)'::regprocedure]loop
  select pg_get_functiondef(f)into strict definition;
  count:=(length(definition)-length(replace(definition,'private.require_verified_safety_episode(','')))/length('private.require_verified_safety_episode(');
  if count<>1 then raise exception 'historical_safety_anchor_changed'using errcode='55000';end if;
  definition:=replace(definition,'private.require_verified_safety_episode(','private.require_historical_safety_episode(');
  if f='private.sync_safety_incident_sweetness(uuid)'::regprocedure then
   old:=$a$   if not found and not desired then continue;end if;$a$;
   replacement:=$a$   if not found and (not desired or exists(select 1 from private.member_episodes where id=x.source_episode_id and ended_at is not null))then continue;end if;$a$;
   if strpos(definition,old)=0 then raise exception 'historical_sweetness_anchor_changed'using errcode='55000';end if;
   definition:=replace(definition,old,replacement);
  elsif f='private.reconcile_cancellation_chain(uuid,uuid)'::regprocedure then
   old:=$a$  if exists(select 1 from private.member_episodes where id=head.source_episode_id and ended_at is not null)then
   policy_pending:='ended_episode_first_effect_unresolved';exit;end if;
$a$;
   if strpos(definition,old)=0 then raise exception 'historical_cancellation_anchor_changed'using errcode='55000';end if;
   definition:=replace(definition,old,'');
  end if;
  execute definition;
 end loop;
end;$$;
revoke all on function private.require_historical_safety_episode(uuid,uuid)from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
commit;
