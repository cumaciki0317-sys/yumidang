-- 민규: 안내 성공 제공의 서버 receipt와 일반7일 시계. 목록/최초읽음/외부발송 시각을 추정하지 않는다.
-- 후속 이의접수·앱 성공제공 확인 조립 전 control은 false로 유지한다. 운영 적용 NOT_RUN.
begin;
create table private.general_notice_delivery_control(singleton boolean primary key default true check(singleton),enabled boolean not null default false);
insert into private.general_notice_delivery_control values(true,false);
create table private.general_notice_deliveries(
 id uuid primary key default gen_random_uuid(),notice_id uuid not null unique references private.member_decision_notices(id)on delete cascade,
 sanction_id uuid not null unique references private.safety_sanction_applications(id)on delete cascade,
 episode_id uuid not null references private.member_episodes(id),payload_sha256 text not null check(payload_sha256~'^[a-f0-9]{64}$'),
 prepared_at timestamptz not null default clock_timestamp(),provided_at timestamptz,deadline_at timestamptz,
 check(isfinite(prepared_at)),check((provided_at is null and deadline_at is null)or
 (provided_at is not null and deadline_at is not null and isfinite(provided_at)and provided_at>=prepared_at and deadline_at=provided_at+interval '168 hours'))
);
alter table private.general_notice_delivery_control enable row level security;
alter table private.general_notice_deliveries enable row level security;
revoke all on private.general_notice_delivery_control,private.general_notice_deliveries from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
create function private.general_notice_delivery_context(p_notice_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();n private.member_decision_notices;r uuid;sanction uuid;result jsonb;begin
 if p_notice_id is null then raise exception 'invalid_notice_delivery'using errcode='22023';end if;
 if not coalesce((select enabled from private.general_notice_delivery_control where singleton),false)then raise exception 'notice_delivery_not_ready'using errcode='55000';end if;
 select d.report_id into r from private.member_decision_notices x join private.assigned_report_decisions d on d.decision_id=x.decision_id
 where x.id=p_notice_id and x.recipient_episode_id=episode and x.recipient_identity_id=(select identity_id from private.member_episodes where id=episode);
 if r is null then raise exception 'notice_unavailable'using errcode='PT404';end if;
 perform 1 from private.member_reports where id=r and(retention_due_at is null or retention_due_at>clock_timestamp())for share nowait;
 if not found then raise exception 'notice_unavailable'using errcode='PT404';end if;
 select *into n from private.member_decision_notices where id=p_notice_id and recipient_episode_id=episode for share nowait;
 if not found or n.violation_outcome is distinct from 'confirmed'then raise exception 'notice_unavailable'using errcode='PT404';end if;
 select s.id into sanction from private.safety_sanction_applications s join private.assigned_report_decisions d on d.decision_id=n.decision_id
 where s.incident_id=d.incident_id and s.decision_revision=d.incident_revision and s.identity_id=n.recipient_identity_id
 and s.source_episode_id=episode and s.revoked_at is null and s.kind in('general_warning','general_7d','general_30d','permanent')
 and exists(select 1 from private.effective_safety_subjects(s.identity_id)e where e.incident_id=s.incident_id and e.decision_revision=s.decision_revision)
 for share of s nowait;
 if sanction is null then raise exception 'notice_unavailable'using errcode='PT404';end if;
 result:=jsonb_build_object('episodeId',episode,'sanctionId',sanction,'notice',private.member_decision_notice_dto(n));
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'state_conflict'using errcode='40001';end if;
 return result;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
create function private.general_notice_delivery_dto(p_delivery private.general_notice_deliveries,p_notice jsonb)returns jsonb
language sql stable security definer set search_path=''as $$select jsonb_build_object('deliveryId',p_delivery.id,'notice',p_notice,
 'providedAt',p_delivery.provided_at,'deadlineAt',p_delivery.deadline_at,'appealPolicy','general_7d');$$;
create function public.prepare_my_general_notice_delivery(p_notice_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare context jsonb;current_context jsonb;delivery private.general_notice_deliveries;fingerprint text;begin
 context:=private.general_notice_delivery_context(p_notice_id);
 fingerprint:=encode(sha256(convert_to(((context->'notice')-'firstReadAt')::text,'UTF8')),'hex');
 insert into private.general_notice_deliveries(notice_id,sanction_id,episode_id,payload_sha256)
 values(p_notice_id,(context->>'sanctionId')::uuid,(context->>'episodeId')::uuid,fingerprint)on conflict(notice_id)do nothing;
 select *into strict delivery from private.general_notice_deliveries where notice_id=p_notice_id for share nowait;
 if delivery.sanction_id is distinct from(context->>'sanctionId')::uuid or delivery.episode_id is distinct from(context->>'episodeId')::uuid
 or delivery.payload_sha256<>fingerprint then raise exception 'state_conflict'using errcode='40001';end if;
 current_context:=private.general_notice_delivery_context(p_notice_id);
 if(current_context-'notice')is distinct from(context-'notice')or
 ((current_context->'notice')-'firstReadAt')is distinct from((context->'notice')-'firstReadAt')then raise exception 'state_conflict'using errcode='40001';end if;
 return private.general_notice_delivery_dto(delivery,current_context->'notice');
exception when lock_not_available or unique_violation then raise exception 'state_conflict'using errcode='40001';end;$$;
create function public.acknowledge_my_general_notice_provided(p_notice_id uuid,p_delivery_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare received timestamptz:=statement_timestamp();context jsonb;fresh jsonb;delivery private.general_notice_deliveries;fingerprint text;begin
 if p_delivery_id is null then raise exception 'invalid_notice_delivery'using errcode='22023';end if;
 context:=private.general_notice_delivery_context(p_notice_id);
 fingerprint:=encode(sha256(convert_to(((context->'notice')-'firstReadAt')::text,'UTF8')),'hex');
 select *into delivery from private.general_notice_deliveries where notice_id=p_notice_id and id=p_delivery_id for update nowait;
 if not found then raise exception 'notice_delivery_unavailable'using errcode='PT404';end if;
 if delivery.episode_id is distinct from(context->>'episodeId')::uuid or delivery.sanction_id is distinct from(context->>'sanctionId')::uuid
 or delivery.payload_sha256<>fingerprint or received<delivery.prepared_at then raise exception 'state_conflict'using errcode='40001';end if;
 if delivery.provided_at is null then
  update private.general_notice_deliveries set provided_at=received,deadline_at=received+interval '168 hours'where id=delivery.id returning *into delivery;
 end if;
 fresh:=private.general_notice_delivery_context(p_notice_id);
 if(fresh-'notice')is distinct from(context-'notice')or((fresh->'notice')-'firstReadAt')is distinct from((context->'notice')-'firstReadAt')then
  raise exception 'state_conflict'using errcode='40001';end if;
 return private.general_notice_delivery_dto(delivery,fresh->'notice');
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';end;$$;
do $$declare own text;f regprocedure;t regclass;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='private.require_member_decision_notice_episode()'::regprocedure;
 if own in('anon','authenticated','service_role','authenticator')then raise exception 'delivery_owner_incompatible'using errcode='55000';end if;
 foreach t in array array['private.general_notice_delivery_control'::regclass,'private.general_notice_deliveries'::regclass]loop execute format('alter table %s owner to %I',t,own);end loop;
 foreach f in array array['private.general_notice_delivery_context(uuid)'::regprocedure,'private.general_notice_delivery_dto(private.general_notice_deliveries,jsonb)'::regprocedure,
 'public.prepare_my_general_notice_delivery(uuid)'::regprocedure,'public.acknowledge_my_general_notice_provided(uuid,uuid)'::regprocedure]loop
  execute format('alter function %s owner to %I',f,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f);
 end loop;
end;$$;
grant execute on function public.prepare_my_general_notice_delivery(uuid),public.acknowledge_my_general_notice_provided(uuid,uuid)to authenticated;
commit;
