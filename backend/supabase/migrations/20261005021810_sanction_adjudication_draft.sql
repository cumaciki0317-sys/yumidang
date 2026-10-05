-- 민규 독립 초안: 신고 접수/운영 담당 배정/접수 시각 계약/서비스 제재 gate는 별도 연결한다.
-- 선행: current_sweetness_ledger + current_member_lifecycle(identity_id). 운영/native DB 미적용.
-- 사람의 검토 결과만 기록한다. 공개/서비스 역할에 판정 실행 권한을 부여하지 않는다.
begin;
create table private.safety_incidents (
 id uuid primary key,
 created_at timestamptz not null default clock_timestamp(),
 current_revision bigint not null default 0 check(current_revision>=0)
);
-- 신고의 설명/캡처/채팅 원문을 복제하지 않는 연결 키다. member_reports FK를 연결하며 증거 원문을 저장하지 않는다.
create table private.safety_incident_report_links (
 incident_id uuid not null references private.safety_incidents(id),
 report_id uuid not null references private.member_reports(id) on delete cascade,
 primary key(incident_id,report_id)
);
create table private.safety_incident_revisions (
 incident_id uuid not null references private.safety_incidents(id),
 revision bigint not null check(revision>0),
 decision_id uuid not null unique,
 state text not null check(state in('reviewing','confirmed','invalidated')),
 reason_code text not null check(reason_code~'^[a-z][a-z0-9_]{0,63}$'),
 -- 액터는 나중에 승인된 담당자 ACL과 연결한다. 지금은 임의 담당자 계정을 생성하지 않는다.
 actor_reference uuid not null,
 subject_payload_hash text not null check(subject_payload_hash~'^[a-f0-9]{64}$'),
 decided_at timestamptz not null default clock_timestamp(),
 primary key(incident_id,revision)
);
-- 한 사건·한 안전 identity의 revision당 여러 종류 중 가장 큰 감점 하나를 선택한다.
create table private.safety_incident_subjects (
 incident_id uuid not null,
 revision bigint not null,
 identity_id uuid not null references private.naver_identity_keys(id),
 source_episode_id uuid references private.member_episodes(id),
 confirmed_kinds text[] not null default '{}',
 violation_class text not null default 'none' check(violation_class in('none','minor','major','cancellation')),
 violation_type text check(violation_type~'^[a-z][a-z0-9_]{0,63}$'),
 victim_identity_id uuid references private.naver_identity_keys(id),
 cancellation_action text check(cancellation_action in('cancel_warning','cancel_restriction')),
 check((violation_class='minor' and violation_type is not null)or violation_class<>'minor'),
 check((violation_class='cancellation' and cancellation_action is not null)or(violation_class<>'cancellation' and cancellation_action is null)),
 check(confirmed_kinds <@ array['cancel_sanction','no_show','major_violation']::text[]),
 check(array_position(confirmed_kinds,null) is null),
 primary key(incident_id,revision,identity_id),
 foreign key(incident_id,revision) references private.safety_incident_revisions(incident_id,revision)
);
create table private.safety_sanction_applications (
 id uuid primary key,
 identity_id uuid not null references private.naver_identity_keys(id),
 incident_id uuid not null,
 decision_revision bigint not null,
 source_episode_id uuid not null references private.member_episodes(id),
 stage integer not null default 0 check(stage>=0),
 kind text not null check(kind in('cancel_warning','cancel_restriction','general_warning','general_7d','general_30d','permanent')),
 applied_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz,
 notified_at timestamptz,
 revoked_at timestamptz,
 correction_reason_code text,
 foreign key(incident_id,decision_revision,identity_id) references private.safety_incident_subjects(incident_id,revision,identity_id),
 check(expires_at=case kind when 'cancel_restriction' then applied_at+interval '168 hours'
   when 'general_7d' then applied_at+interval '168 hours' when 'general_30d' then applied_at+interval '720 hours' end
   or (expires_at is null and kind in('cancel_warning','general_warning','permanent'))),
 check((kind in('cancel_restriction','general_7d','general_30d') and expires_at is not null)
   or (kind in('cancel_warning','general_warning','permanent') and expires_at is null)),
 check(revoked_at is null or revoked_at>=applied_at),
 check((revoked_at is null and correction_reason_code is null) or (revoked_at is not null and correction_reason_code is not null and correction_reason_code~'^[a-z][a-z0-9_]{0,63}$'))
);
create unique index safety_sanction_one_effective on private.safety_sanction_applications(identity_id,incident_id)where revoked_at is null;
-- 전체 결과 목록을 빠짐없이 등록해야 중간 미정 뒤 판정을 막을 수 있다. 서비스 hooks는 아직 미연결이다.
create table private.safety_appointment_results (
 identity_id uuid not null references private.naver_identity_keys(id),
 appointment_id uuid not null references public.appointments(id),
 source_episode_id uuid not null references private.member_episodes(id),
 agreed_starts_at timestamptz,
 confirmed_at timestamptz not null,
 ordering_provenance text not null check(ordering_provenance in('agreed_snapshot','unknown')),
 current_revision bigint not null default 0 check(current_revision>=0),
 primary key(identity_id,appointment_id),
 check((ordering_provenance='agreed_snapshot' and agreed_starts_at is not null)
    or (ordering_provenance='unknown' and agreed_starts_at is null))
);
create table private.safety_appointment_result_revisions (
 identity_id uuid not null,
 appointment_id uuid not null,
 revision bigint not null check(revision>0),
 decision_id uuid not null unique,
 outcome text not null check(outcome in('pending','completed','own_cancel','peer_cancel','exempt')),
 cancellation_at timestamptz,
 appeal_state text not null default 'none' check(appeal_state in('none','reviewing','resolved')),
 decided_at timestamptz not null default clock_timestamp(),
 reason_code text not null check(reason_code~'^[a-z][a-z0-9_]{0,63}$'),
 primary key(identity_id,appointment_id,revision),
 foreign key(identity_id,appointment_id) references private.safety_appointment_results(identity_id,appointment_id),
 check((outcome='own_cancel' and cancellation_at is not null) or (outcome<>'own_cancel' and cancellation_at is null)),
 check(outcome='own_cancel' or appeal_state='none')
);
-- 설명과 증거는 신고 저장소로 연결하고 여기에는 상태/기한/관계 키만 둔다.
create table private.safety_appeals (
 id uuid primary key,
 identity_id uuid not null references private.naver_identity_keys(id),
 kind text not null check(kind in('cancellation','general')),
 appointment_id uuid,
 sanction_id uuid references private.safety_sanction_applications(id),
 received_at timestamptz not null default statement_timestamp(),
 deadline_at timestamptz not null,
 state text not null default 'reviewing' check(state in('reviewing','accepted','rejected')),
 resolved_at timestamptz,
 check(received_at<deadline_at),
 check((kind='cancellation' and appointment_id is not null and sanction_id is null)
   or (kind='general' and appointment_id is null and sanction_id is not null)),
 check((state='reviewing' and resolved_at is null) or (state<>'reviewing' and resolved_at is not null and resolved_at>=received_at))
);
-- DB 접수 시각은 저장하지만 공개 이의 RPC는 receipt 경계 결정 전 열지 않는다.
-- reviewing revision은 기존 confirmed 판정/효력을 철회하지 않는다. 명시 invalidated만 무효화한다.
create function private.effective_safety_subjects(p_identity_id uuid)
returns table(incident_id uuid,decision_revision bigint,source_episode_id uuid,confirmed_kinds text[],
 violation_class text,violation_type text,victim_identity_id uuid,cancellation_action text,confirmed_at timestamptz)
language sql stable security definer set search_path='' as $$
 with effective as(select distinct on(r.incident_id)r.* from private.safety_incident_revisions r
 where r.state<>'reviewing'order by r.incident_id,r.revision desc)
 select r.incident_id,r.revision,s.source_episode_id,s.confirmed_kinds,s.violation_class,s.violation_type,s.victim_identity_id,s.cancellation_action,
 (select min(h.decided_at)from private.safety_incident_revisions h join private.safety_incident_subjects hs on hs.incident_id=h.incident_id and hs.revision=h.revision
   where h.incident_id=r.incident_id and h.state='confirmed'and hs.identity_id=s.identity_id)
 from effective r join private.safety_incident_subjects s on s.incident_id=r.incident_id and s.revision=r.revision
 where r.state='confirmed'and s.identity_id=p_identity_id;
$$;
create function private.incident_subject_penalty(p_incident_id uuid,p_identity_id uuid)
returns integer language sql stable security definer set search_path='' as $$
 select coalesce((select min(case k when 'cancel_sanction'then -2 when 'no_show'then -3 when 'major_violation'then -10 end)
 from private.effective_safety_subjects(p_identity_id)s cross join lateral unnest(s.confirmed_kinds)k where s.incident_id=p_incident_id),0)::integer;
$$;
create function private.safety_restriction_state(p_identity_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('permanent',coalesce(bool_or(kind='permanent'),false),
  'restrictedUntil',max(expires_at),'hasWarning',coalesce(bool_or(kind in('cancel_warning','general_warning')),false))
 from private.safety_sanction_applications where identity_id=p_identity_id and revoked_at is null
   and (expires_at is null or expires_at>statement_timestamp());
$$;
-- 부작용 없는 후보 계산이다. 실제 적용 시각은 적용 트랜잭션에서만 확정한다.
create function private.cancellation_sanction_plan(p_identity_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare x record; streak integer:=0;warning_seen boolean:=false; provisional integer:=0;
 blocked boolean:=false; blocked_id uuid;actions jsonb:='[]';v_at timestamptz:=statement_timestamp();begin
 -- 미상인 과거 순서를 현재 공고 시각으로 채우지 않는다. unknown이 있으면 보류한다.
 if exists(select 1 from private.safety_appointment_results where identity_id=p_identity_id and ordering_provenance='unknown') then
  return jsonb_build_object('status','ordering_unknown','actions',actions,'provisionalCount',null);
 end if;
 for x in select a.*,r.outcome,r.cancellation_at,r.appeal_state from private.safety_appointment_results a
 left join private.safety_appointment_result_revisions r on r.identity_id=a.identity_id and r.appointment_id=a.appointment_id and r.revision=a.current_revision
 where a.identity_id=p_identity_id order by a.agreed_starts_at,a.confirmed_at,a.appointment_id loop
  if x.outcome is null or x.outcome='pending' then blocked:=true;blocked_id:=x.appointment_id;exit;end if;
  if x.outcome='completed' then streak:=0;provisional:=0;
  elsif x.outcome='own_cancel' then
   provisional:=provisional+1;
   if x.appeal_state='reviewing' or (x.appeal_state='none' and v_at<x.cancellation_at+interval '24 hours') then
    blocked:=true;blocked_id:=x.appointment_id;exit;
   end if;
   streak:=streak+1;
   if streak=3 then
    actions:=actions||jsonb_build_array(jsonb_build_object('anchorAppointmentId',x.appointment_id,
      'kind',case when warning_seen then 'cancel_restriction' else 'cancel_warning' end));
    warning_seen:=true;streak:=0;provisional:=0;
   end if;
  end if;
 end loop;
 return jsonb_build_object('status',case when blocked then 'held' else 'ready' end,'heldAppointmentId',blocked_id,
  'actions',actions,'eligibleCount',streak,'provisionalCount',provisional,'hasCancellationWarning',warning_seen);
end; $$;
-- SQL owner 전용. 자격 종류가 아니라 완료된 네이버 subject→identity→현재 회원 회차를 확인한다.
create function private.require_verified_safety_episode(p_identity_id uuid,p_episode_id uuid)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare u uuid;begin
 if p_episode_id is null then raise exception 'verified_member_episode_required'using errcode='42501';end if;
 if exists(select 1 from private.member_episodes where id=p_episode_id and ended_at is not null)then
  raise exception 'cross_episode_first_effect_unresolved'using errcode='55000';end if;
 select e.profile_id into u from private.member_episodes e join private.naver_identity_keys k on k.id=e.identity_id
 join private.naver_accounts a on a.subject=k.subject and a.user_id=e.profile_id join public.profiles p on p.id=e.profile_id
 where e.id=p_episode_id and e.identity_id=p_identity_id and e.ended_at is null and a.completed_at is not null
 and a.verified_at<=clock_timestamp()and a.completed_at<=clock_timestamp();
 if not found then raise exception 'verified_member_episode_required'using errcode='42501';end if;
 return u;
end;$$;
create function private.general_sanction_epoch_end(p_at timestamptz)returns timestamptz language sql immutable set search_path=''as $$
 select((p_at at time zone 'Asia/Seoul')+interval'12 months')at time zone 'Asia/Seoul';
$$;
-- 한 identity의 유효 사건을 재계산한다. 복수 사슬/글로벌 단계는 사용자 답 전 명시 거절한다.
create function private.recompute_safety_applications(p_identity_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare x record;old private.safety_sanction_applications;desired text;v_stage integer:=0;last_minor timestamptz;
 chain_type text;chain_victim uuid;same_type boolean;same_victim boolean;v_at timestamptz;v_expires timestamptz;begin
 perform 1 from private.naver_identity_keys where id=p_identity_id for update;
 if not found then raise exception 'safety_identity_required'using errcode='42501';end if;
 update private.safety_sanction_applications a set revoked_at=clock_timestamp(),correction_reason_code='incident_invalidated'
 where a.identity_id=p_identity_id and a.revoked_at is null and not exists(
 select 1 from private.effective_safety_subjects(p_identity_id)e where e.incident_id=a.incident_id);
 for x in select *from private.effective_safety_subjects(p_identity_id)order by confirmed_at,incident_id loop
  desired:=case x.violation_class when'major'then'permanent'when'cancellation'then x.cancellation_action else null end;
  if x.violation_class='minor'then
   if last_minor is null or x.confirmed_at>=private.general_sanction_epoch_end(last_minor)then
    v_stage:=0;chain_type:=x.violation_type;chain_victim:=x.victim_identity_id;same_type:=true;same_victim:=chain_victim is not null;
   else
    same_type:=same_type and chain_type=x.violation_type;
    same_victim:=same_victim and chain_victim is not distinct from x.victim_identity_id;
    if not(same_type or same_victim)then raise exception 'general_multiple_chains_unresolved'using errcode='55000';end if;
    v_stage:=v_stage+1;
   end if;
   last_minor:=x.confirmed_at;
   desired:=case when v_stage=0 then'general_warning'when v_stage=1 then'general_7d'else'general_30d'end;
  end if;
  select *into old from private.safety_sanction_applications where identity_id=p_identity_id and incident_id=x.incident_id and revoked_at is null for update;
  if found and old.kind is not distinct from desired then
   if old.source_episode_id<>x.source_episode_id then raise exception 'incident_episode_conflict'using errcode='40001';end if;
   update private.safety_sanction_applications set decision_revision=x.decision_revision,stage=case when x.violation_class='minor'then v_stage else 0 end where id=old.id;
   continue;
  end if;
  if old.id is not null then
   update private.safety_sanction_applications set revoked_at=clock_timestamp(),correction_reason_code='decision_corrected'where id=old.id;
  end if;
  if desired is null then continue;end if;
  perform private.require_verified_safety_episode(p_identity_id,x.source_episode_id);
  -- 이미 적용한 같은 사건의 제한 정정으로 기간을 다시 시작하지 않는다.
  select min(applied_at)into v_at from private.safety_sanction_applications where identity_id=p_identity_id and incident_id=x.incident_id
   and(kind=desired or(kind in('cancel_restriction','general_7d','general_30d','permanent')and desired in('cancel_restriction','general_7d','general_30d','permanent')));
  v_at:=coalesce(v_at,clock_timestamp());
  v_expires:=case desired when'cancel_restriction'then v_at+interval'168 hours'when'general_7d'then v_at+interval'168 hours'when'general_30d'then v_at+interval'720 hours'else null end;
  insert into private.safety_sanction_applications(id,identity_id,incident_id,decision_revision,source_episode_id,stage,kind,applied_at,expires_at)
  values(gen_random_uuid(),p_identity_id,x.incident_id,x.decision_revision,x.source_episode_id,case when x.violation_class='minor'then v_stage else 0 end,desired,v_at,v_expires);
 end loop;
end;$$;
-- 새 회차에 과거 감점을 옮기지 않는다. 기존 원 회차 결정만 정정하며 최초 old-episode 감점은 거절한다.
create function private.sync_safety_incident_sweetness(p_incident_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
declare x record;k text;desired boolean;prior boolean;rev bigint;begin
 for x in select distinct identity_id,source_episode_id from private.safety_incident_subjects
 where incident_id=p_incident_id and source_episode_id is not null order by identity_id,source_episode_id loop
  foreach k in array array['cancel_sanction','no_show','major_violation']loop
   desired:=exists(select 1 from private.effective_safety_subjects(x.identity_id)e
    where e.incident_id=p_incident_id and e.source_episode_id=x.source_episode_id and k=any(e.confirmed_kinds));
   select revision,is_valid into rev,prior from private.sweetness_incident_decisions
    where incident_id=p_incident_id and recipient_episode_id=x.source_episode_id and kind=k order by revision desc limit 1;
   if not found and not desired then continue;end if;
   if rev is not null and prior=desired then continue;end if;
   if desired then perform private.require_verified_safety_episode(x.identity_id,x.source_episode_id);end if;
   perform private.decide_incident_sweetness(gen_random_uuid(),p_incident_id,x.source_episode_id,k,coalesce(rev,0)+1,desired);
  end loop;
 end loop;
end;$$;
create function private.record_incident_revision(p_incident_id uuid,p_decision_id uuid,p_expected_revision bigint,p_state text,p_reason_code text,p_actor_reference uuid,p_subjects jsonb)
returns bigint language plpgsql volatile security definer set search_path='' as $$
declare i private.safety_incidents;r private.safety_incident_revisions;x jsonb;v_hash text;v_identity uuid;v_episode uuid;v_kinds text[];
 v_class text;v_type text;v_victim uuid;v_cancel text;ids uuid[];episodes uuid[];u uuid;begin
 if p_incident_id is null or p_decision_id is null or p_expected_revision is null or p_expected_revision<0
 or p_state is null or p_state not in('reviewing','confirmed','invalidated')or p_reason_code is null
 or p_reason_code!~'^[a-z][a-z0-9_]{0,63}$'or p_actor_reference is null or p_subjects is null or jsonb_typeof(p_subjects)<>'array'
 or(p_state='confirmed'and jsonb_array_length(p_subjects)=0)then raise exception 'invalid_input'using errcode='22023';end if;
 -- 같은 사건의 대상 집합을 읽기 전에 직렬화해 동시 revision의 새 identity를 놓치지 않는다.
 perform pg_advisory_xact_lock(hashtextextended(p_incident_id::text,21810));
 -- 기존 confirmed subject까지 같은 identity 잠금에 포함하여 삭제/무효 정정을 직렬화한다.
 select array_agg(distinct identity_id order by identity_id)into ids from(
 select (value->>'identityId')::uuid identity_id from jsonb_array_elements(p_subjects)
 union select identity_id from private.safety_incident_subjects where incident_id=p_incident_id)q;
 select array_agg(distinct episode_id order by episode_id)into episodes from(
 select (value->>'sourceEpisodeId')::uuid episode_id from jsonb_array_elements(p_subjects)
 union select source_episode_id from private.safety_incident_subjects where incident_id=p_incident_id)q where episode_id is not null;
 -- lifecycle와 동일한 계정→프로필→회차 순서, 이후 identity→사건→효력/당도 순서다.
 perform 1 from private.naver_accounts a join private.naver_identity_keys k on k.subject=a.subject where k.id=any(ids)order by a.user_id,a.subject for share of a;
 perform 1 from public.profiles where id in(select profile_id from private.member_episodes where id=any(episodes))order by id for share;
 perform 1 from private.member_episodes where id=any(episodes)order by profile_id,id for share;
 perform 1 from private.naver_identity_keys where id=any(ids)order by id for update;
 v_hash:=encode(sha256(convert_to(p_subjects::text,'UTF8')),'hex');
 insert into private.safety_incidents(id)values(p_incident_id)on conflict do nothing;
 select *into i from private.safety_incidents where id=p_incident_id for update;
 select *into r from private.safety_incident_revisions where decision_id=p_decision_id;
 if found then
  if r.incident_id=p_incident_id and r.revision=p_expected_revision+1 and r.state=p_state and r.reason_code=p_reason_code and r.actor_reference=p_actor_reference and r.subject_payload_hash=v_hash then return r.revision;end if;
  raise exception 'decision_conflict'using errcode='40001';end if;
 if i.current_revision<>p_expected_revision then raise exception 'decision_revision_conflict'using errcode='40001';end if;
 insert into private.safety_incident_revisions(incident_id,revision,decision_id,state,reason_code,actor_reference,subject_payload_hash)
 values(p_incident_id,p_expected_revision+1,p_decision_id,p_state,p_reason_code,p_actor_reference,v_hash);
 for x in select value from jsonb_array_elements(p_subjects)loop
  if jsonb_typeof(x)<>'object'or(select count(*)from jsonb_object_keys(x))not in(3,7)
   or not(x?'identityId'and x?'sourceEpisodeId'and x?'confirmedKinds')
   or jsonb_typeof(x->'identityId')<>'string'or jsonb_typeof(x->'sourceEpisodeId')not in('string','null')
   or jsonb_typeof(x->'confirmedKinds')<>'array' then raise exception 'invalid_input'using errcode='22023';end if;
  if(select count(*)from jsonb_object_keys(x))=7 and not(x?'violationClass'and x?'violationType'and x?'victimIdentityId'and x?'cancellationAction')then raise exception 'invalid_input'using errcode='22023';end if;
  if exists(select 1 from jsonb_array_elements(x->'confirmedKinds')q where jsonb_typeof(q)<>'string')then raise exception 'invalid_input'using errcode='22023';end if;
  v_identity:=(x->>'identityId')::uuid;v_episode:=(x->>'sourceEpisodeId')::uuid;
  select coalesce(array_agg(value),'{}'::text[])into v_kinds from jsonb_array_elements_text(x->'confirmedKinds');
  if cardinality(v_kinds)<>(select count(distinct k)from unnest(v_kinds)k)then raise exception 'invalid_input'using errcode='22023';end if;
  if v_episode is not null and not exists(select 1 from private.member_episodes where id=v_episode and identity_id=v_identity)then raise exception 'episode_identity_conflict'using errcode='40001';end if;
  v_class:=coalesce(x->>'violationClass',case when'major_violation'=any(v_kinds)then'major'when'cancel_sanction'=any(v_kinds)then'cancellation'else'none'end);
  v_type:=x->>'violationType';v_victim:=(x->>'victimIdentityId')::uuid;
  if v_victim is not null and not exists(select 1 from private.member_episodes e join private.naver_identity_keys k on k.id=e.identity_id join private.naver_accounts a on a.subject=k.subject where e.identity_id=v_victim and a.verified_at<=clock_timestamp())then raise exception 'verified_victim_identity_required'using errcode='42501';end if;
  v_cancel:=coalesce(x->>'cancellationAction',case when v_class='cancellation'then'cancel_restriction'else null end);
  if(('major_violation'=any(v_kinds))<>(v_class='major'))or('cancel_sanction'=any(v_kinds)and v_class not in('major','cancellation'))or(v_class='minor'and('major_violation'=any(v_kinds)or'cancel_sanction'=any(v_kinds)))
   or(v_class='cancellation'and((v_cancel='cancel_warning'and cardinality(v_kinds)<>0)or(v_cancel='cancel_restriction'and not('cancel_sanction'=any(v_kinds)))))then raise exception 'invalid_input'using errcode='22023';end if;
  if p_state='confirmed'then
   perform private.require_verified_safety_episode(v_identity,v_episode);
   if exists(select 1 from private.safety_incident_subjects h join private.safety_incident_revisions hr on hr.incident_id=h.incident_id and hr.revision=h.revision
    where h.incident_id=p_incident_id and h.identity_id=v_identity and hr.state='confirmed'and h.source_episode_id is distinct from v_episode)then
    raise exception 'cross_episode_incident_unresolved'using errcode='55000';end if;
  end if;
  insert into private.safety_incident_subjects(incident_id,revision,identity_id,source_episode_id,confirmed_kinds,violation_class,violation_type,victim_identity_id,cancellation_action)
  values(p_incident_id,p_expected_revision+1,v_identity,v_episode,v_kinds,v_class,v_type,v_victim,v_cancel);
 end loop;
 update private.safety_incidents set current_revision=p_expected_revision+1 where id=p_incident_id;
 if p_state<>'reviewing'then
  foreach v_identity in array coalesce(ids,'{}'::uuid[])loop perform private.recompute_safety_applications(v_identity);end loop;
  perform private.sync_safety_incident_sweetness(p_incident_id);
 end if;
 return p_expected_revision+1;
end;$$;
alter table private.safety_incidents enable row level security;
alter table private.safety_incident_report_links enable row level security;
alter table private.safety_incident_revisions enable row level security;
alter table private.safety_incident_subjects enable row level security;
alter table private.safety_sanction_applications enable row level security;
alter table private.safety_appointment_results enable row level security;
alter table private.safety_appointment_result_revisions enable row level security;
alter table private.safety_appeals enable row level security;
revoke all on private.safety_incidents,private.safety_incident_report_links,private.safety_incident_revisions,
 private.safety_incident_subjects,private.safety_sanction_applications,private.safety_appointment_results,
 private.safety_appointment_result_revisions,private.safety_appeals from public,anon,authenticated,service_role;
revoke all on function private.general_sanction_epoch_end(timestamptz),private.effective_safety_subjects(uuid),private.require_verified_safety_episode(uuid,uuid),private.recompute_safety_applications(uuid),private.sync_safety_incident_sweetness(uuid),
 private.incident_subject_penalty(uuid,uuid),private.safety_restriction_state(uuid),
 private.cancellation_sanction_plan(uuid),private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb) from public,anon,authenticated,service_role;
commit;
