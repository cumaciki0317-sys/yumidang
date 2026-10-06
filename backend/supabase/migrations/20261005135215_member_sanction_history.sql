-- 민규: source67 이후 본인 제재 이력 읽기 후보. 판정·통지·이의 접수 권한을 열지 않는다.
begin;
create function public.list_my_sanctions(p_limit integer default 20,p_before uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_service_profile();identity uuid;result jsonb;n timestamptz:=statement_timestamp();begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_sanction_page'using errcode='22023';end if;
 -- 기존 본인 조회와 같은 account→profile→active episode 가드다. 신규 동행 자격/제재 gate를 추가하지 않는다.
 select e.identity_id into identity from private.member_episodes e
 join private.naver_identity_keys k on k.id=e.identity_id
 join private.naver_accounts a on a.subject=k.subject and a.user_id=u
 where e.profile_id=u and e.ended_at is null;
 if not found or identity is null then raise exception 'verified_member_identity_required'using errcode='42501';end if;
 if p_before is not null and not exists(select 1 from private.safety_sanction_applications a where a.identity_id=identity and a.id=p_before)then
  raise exception 'sanction_cursor_unavailable'using errcode='PT404';end if;
 -- 같은 statement snapshot에서 현재/기간종료/정정 이력을 읽고 원장 UUID 순서로 한 페이지를 제한한다.
 with candidates as materialized(
  select a.*,r.reason_code from private.safety_sanction_applications a
  join private.safety_incident_revisions r on r.incident_id=a.incident_id and r.revision=a.decision_revision
  where a.identity_id=identity and(p_before is null or a.id>p_before)order by a.id limit p_limit+1
 ), page as(select *from candidates order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
  'sanctionId',p.id,'kind',p.kind,
  'status',case when p.revoked_at is not null then 'corrected'when p.expires_at<=n then 'ended'else 'active'end,
  'reasonCode',case when p.reason_code=any(array['sexual_harassment','threat','money_or_personal_data','impersonation','spam','no_show','rule_violation','repeated_cancellation'])then p.reason_code else 'other'end,
  'correctionReasonCode',case when p.revoked_at is null then null when p.correction_reason_code=any(array['sexual_harassment','threat','money_or_personal_data','impersonation','spam','no_show','rule_violation','repeated_cancellation'])then p.correction_reason_code else 'other'end,
  'appliedAt',p.applied_at,'expiresAt',p.expires_at,'notifiedAt',p.notified_at,'revokedAt',p.revoked_at,
  'appealPolicy',case when p.kind in('cancel_warning','cancel_restriction')then 'cancellation_24h'else 'general_7d'end,
  -- notice의 완료 시각과 취소 건 관계가 아직 연결되지 않아 안내만으로 실제 마감을 계산하지 않는다.
  'appealDeadlineAt',null,
  'appealState',case when p.kind in('cancel_warning','cancel_restriction')then null else(select ap.state from private.safety_appeals ap where ap.identity_id=identity and ap.kind='general'
   and ap.sanction_id=p.id order by ap.received_at desc,ap.id desc limit 1)end
 )order by p.id)from page p),'[]'::jsonb),
 'nextCursor',case when(select count(*)from candidates)>p_limit then(select id from page order by id desc limit 1)else null end)into result;
 return result;
end; $$;
do $$declare own oid;owner_name text;t regclass;begin
 select proowner,pg_get_userbyid(proowner)into strict own,owner_name from pg_proc where oid='public.get_my_safety_state()'::regprocedure;
 if owner_name in('anon','authenticated','service_role','authenticator')then raise exception 'sanction_history_owner_incompatible'using errcode='55000';end if;
 -- 기존 실효 읽기만 사용한다. raw safety table GRANT 또는 역할 변경을 추가하지 않는다.
 foreach t in array array['private.safety_sanction_applications'::regclass,'private.safety_incident_revisions'::regclass,'private.safety_appeals'::regclass]loop
  if not has_table_privilege(owner_name,t,'SELECT')or(select relrowsecurity and not(
   (relowner=own and not relforcerowsecurity)or(select rolsuper or rolbypassrls from pg_roles where oid=own))from pg_class where oid=t)then
   raise exception 'sanction_history_owner_incompatible'using errcode='55000';end if;
 end loop;
 execute format('alter function public.list_my_sanctions(integer,uuid)owner to %I',owner_name);
end; $$;
create index safety_sanction_identity_page on private.safety_sanction_applications(identity_id,id);
revoke all on function public.list_my_sanctions(integer,uuid)from public,anon,authenticated,service_role;
grant execute on function public.list_my_sanctions(integer,uuid)to authenticated;
-- 기존40700/21810의 함수·테이블 ACL·owner·원장·통지 시각은 변경하지 않는다.
commit;
