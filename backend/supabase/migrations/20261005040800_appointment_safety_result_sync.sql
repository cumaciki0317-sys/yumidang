-- 민규: 실제 약속 사실을 연속취소 계산 원장에 연결한다. 제재·예외·통지 판정은 하지 않는다.
-- source64 이후 후보. 실제 SQL/HTTP/두 세션 검증은 별도이며 이 파일만으로 준비 완료가 아니다.
begin;

-- 과거 행의 작성 주체를 추정하지 않는다. 새 자동 기록만 명시적으로 appointment를 사용한다.
alter table private.safety_appointment_result_revisions add column origin text not null default 'legacy_unknown'
 check(origin in('appointment','operator','legacy_unknown'));
comment on column private.safety_appointment_result_revisions.origin is
 '작성 경로 메타데이터. 과거 작성 주체는 legacy_unknown이며 reason_code로 추정하지 않는다. 운영 수정은 operator를 명시한다.';

-- 이관 범위 요약만 저장한다. 회원 식별자·원문·비밀값은 포함하지 않는다.
create table private.appointment_safety_sync_audit(
 migration_version text primary key,
 recorded_at timestamptz not null default clock_timestamp(),
 legacy_appointments bigint not null check(legacy_appointments>=0),
 missing_episode_maps bigint not null check(missing_episode_maps>=0),
 missing_identity_members bigint not null check(missing_identity_members>=0),
 seeded_unknown_results bigint not null check(seeded_unknown_results>=0)
);
alter table private.appointment_safety_sync_audit enable row level security;
revoke all on private.appointment_safety_sync_audit from public,anon,authenticated,service_role;
insert into private.appointment_safety_sync_audit(migration_version,legacy_appointments,missing_episode_maps,
 missing_identity_members,seeded_unknown_results)
 select '20261005040800',(select count(*)from public.appointments),
 (select count(*)from public.appointments a where not exists(select 1 from private.appointment_member_episodes m where m.appointment_id=a.id)),
 (select count(*)from public.appointments a join private.appointment_member_episodes m on m.appointment_id=a.id
 cross join lateral(values(m.author_episode_id),(m.requester_episode_id))ids(episode_id)
 left join private.member_episodes e on e.id=ids.episode_id where e.identity_id is null),
 (select count(*)from public.appointments a join private.appointment_member_episodes m on m.appointment_id=a.id
 cross join lateral(values(m.author_episode_id),(m.requester_episode_id))ids(episode_id)
 join private.member_episodes e on e.id=ids.episode_id where e.identity_id is not null
 and not exists(select 1 from private.safety_appointment_results h where h.identity_id=e.identity_id and h.appointment_id=a.id));
comment on table private.appointment_safety_sync_audit is
 '이관 시점의 미연결/unknown 범위 집계. ready는 등록된 결과원장 기준이며 전체 과거 이력의 완전성 증명이 아니다. unknown은 owner 검증 후 정정 대상이다. 운영 자동 제재 연결은 별도 승인/정책 전까지 닫혀 있다.';

-- 과거 최신 합의 시각은 현재 posts.starts_at으로 복원하지 않는다. 고정 회차에 이미 연결된 identity만 사용한다.
-- 기존 원장/판정은 보존한다. 맵·identity 없는 과거 약속은 제외되므로 ready는 전체 과거 이력 완성을 뜻하지 않는다.
with inserted as (
 insert into private.safety_appointment_results(identity_id,appointment_id,source_episode_id,
  agreed_starts_at,confirmed_at,ordering_provenance,current_revision)
 select e.identity_id,a.id,e.id,null,a.confirmed_at,'unknown',1
 from public.appointments a join private.appointment_member_episodes m on m.appointment_id=a.id
 cross join lateral(values(m.author_episode_id),(m.requester_episode_id)) ids(episode_id)
 join private.member_episodes e on e.id=ids.episode_id
 where e.identity_id is not null on conflict(identity_id,appointment_id) do nothing
 returning identity_id,appointment_id
)
insert into private.safety_appointment_result_revisions(identity_id,appointment_id,revision,decision_id,
 outcome,cancellation_at,appeal_state,reason_code,origin)
 select identity_id,appointment_id,1,gen_random_uuid(),'pending',null,'none','historical_order_unknown','legacy_unknown'
 from inserted;

create function private.sync_appointment_safety_results(p_appointment_id uuid,p_register boolean default false,
 p_schedule_only boolean default false)
returns void language plpgsql volatile security definer set search_path='' as $$
declare a public.appointments;p public.posts;c private.appointment_cancellations;
 item record;head private.safety_appointment_results;previous private.safety_appointment_result_revisions;
 desired text;cancel_at timestamptz;v_revision bigint;v_author uuid;v_requester uuid;v_complete boolean;
begin
 -- 약속/공고를 이미 잡은 호출에서 역순 대기를 추가하지 않는다. 경합 시 호출 전체를 재시도한다.
 select *into a from public.appointments where id=p_appointment_id for update nowait;
 if not found then return;end if;
 select *into p from public.posts where id=a.post_id;
 select r.requester_id into v_requester from public.join_requests r where r.id=a.join_request_id;
 v_author:=p.author_id;
 if p_register and a.status='confirmed' then
  -- 실제 authenticated 신규 확정은 양쪽 검증된 고정 identity가 필요하다. owner/service 과거 합성의 미연결 범위와 구분한다.
  if auth.role()='authenticated' and ((select count(*)from private.appointment_member_episodes m
    cross join lateral(values(m.author_episode_id,v_author),(m.requester_episode_id,v_requester)) ids(episode_id,profile_id)
    join private.member_episodes e on e.id=ids.episode_id and e.profile_id=ids.profile_id
    join private.naver_identity_keys k on k.id=e.identity_id
    join private.naver_accounts n on n.subject=k.subject and n.user_id=e.profile_id
    where m.appointment_id=a.id)<>2
   or(select count(distinct e.identity_id)from private.appointment_member_episodes m
    cross join lateral(values(m.author_episode_id),(m.requester_episode_id))ids(episode_id)
    join private.member_episodes e on e.id=ids.episode_id where m.appointment_id=a.id)<>2) then
   raise exception 'verified_appointment_identity_required' using errcode='40001';
  end if;
  with inserted as (
   insert into private.safety_appointment_results(identity_id,appointment_id,source_episode_id,
    agreed_starts_at,confirmed_at,ordering_provenance,current_revision)
   select e.identity_id,a.id,e.id,p.starts_at,a.confirmed_at,'agreed_snapshot',1
   from private.appointment_member_episodes m
   cross join lateral(values(m.author_episode_id),(m.requester_episode_id)) ids(episode_id)
   join private.member_episodes e on e.id=ids.episode_id
   where m.appointment_id=a.id and e.identity_id is not null
   on conflict(identity_id,appointment_id) do nothing
   returning identity_id,appointment_id
  )
  insert into private.safety_appointment_result_revisions(identity_id,appointment_id,revision,decision_id,
   outcome,cancellation_at,appeal_state,reason_code,origin)
   select identity_id,appointment_id,1,gen_random_uuid(),'pending',null,'none','appointment_state_sync','appointment' from inserted;
 end if;
 select *into c from private.appointment_cancellations where appointment_id=a.id;
 v_complete:=a.status='completed' and a.completed_at is not null and a.completed_at<=clock_timestamp()
  and not exists(select 1 from public.appointment_disputes d where d.appointment_id=a.id
   and(d.status='open' or d.resolution='no_show'))
  and((a.completion_method='automatic' and a.completed_at>=p.ends_at+interval'24 hours')
   or(a.completion_method='manual'
    and exists(select 1 from public.appointment_completion_confirmations f where f.appointment_id=a.id and f.user_id=v_author)
    and exists(select 1 from public.appointment_completion_confirmations f where f.appointment_id=a.id and f.user_id=v_requester)));
 -- 회원 생애주기 행 잠금을 뒤늦게 추가하지 않는다. 고정 회차를 참조하고 결과원장만 갱신한다.
 for item in select identity_id from private.safety_appointment_results where appointment_id=a.id order by identity_id loop
  select *into head from private.safety_appointment_results
   where identity_id=item.identity_id and appointment_id=a.id for update nowait;
  select *into previous from private.safety_appointment_result_revisions
   where identity_id=head.identity_id and appointment_id=head.appointment_id and revision=head.current_revision;
  -- 과거 작성 경로 미상 행과 운영 판정을 추정하여 덮어쓰지 않는다.
  if previous.revision is null or previous.origin<>'appointment' or previous.appeal_state<>'none' or previous.outcome='exempt' then continue;end if;
  if p_schedule_only then
   if a.status='confirmed' and head.ordering_provenance='agreed_snapshot'
    and previous.origin='appointment' and previous.outcome='pending' then
    update private.safety_appointment_results set agreed_starts_at=p.starts_at
     where identity_id=head.identity_id and appointment_id=a.id and agreed_starts_at is distinct from p.starts_at;
   end if;
   continue;
  end if;
  desired:='pending';cancel_at:=null;
  if a.status='cancelled' and c.appointment_id=a.id then
   -- 취소한 profile을 현재 회차로 재연결하지 않는다. 약속의 고정 회차 소유자를 사용한다.
   if exists(select 1 from private.member_episodes e where e.id=head.source_episode_id and e.profile_id=c.cancelled_by) then
    desired:='own_cancel';cancel_at:=c.cancelled_at;
   elsif c.cancelled_by in(v_author,v_requester) then desired:='peer_cancel';end if;
  elsif v_complete then desired:='completed';end if;
  if head.current_revision>0 and previous.outcome=desired
   and previous.cancellation_at is not distinct from cancel_at and previous.appeal_state='none' then continue;end if;
  v_revision:=head.current_revision+1;
  insert into private.safety_appointment_result_revisions(identity_id,appointment_id,revision,decision_id,
   outcome,cancellation_at,appeal_state,reason_code,origin)
   values(head.identity_id,a.id,v_revision,gen_random_uuid(),desired,cancel_at,'none','appointment_state_sync','appointment');
  update private.safety_appointment_results set current_revision=v_revision
   where identity_id=head.identity_id and appointment_id=a.id;
 end loop;
exception when lock_not_available then
 raise exception 'appointment_safety_result_conflict' using errcode='40001';
end;$$;

create function private.sync_appointment_safety_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='appointments' then
  perform private.sync_appointment_safety_results(new.id,tg_op='INSERT',false);
 elsif tg_table_name='posts' then
  if new.starts_at is distinct from old.starts_at then
   perform private.sync_appointment_safety_results(a.id,false,true)
    from public.appointments a where a.post_id=new.id and a.status='confirmed' order by a.id;
  end if;
 else
  perform private.sync_appointment_safety_results(new.appointment_id,false,false);
 end if;
 return new;
end;$$;
-- 같은 종류의 AFTER INSERT는 이름순이다. 고정 회차를 만드는 sweetness_appointment_episode 뒤에 실행한다.
create trigger z_safety_appointment_insert after insert on public.appointments
 for each row execute function private.sync_appointment_safety_trigger();
create trigger z_safety_appointment_update after update of status,completed_at,completion_method on public.appointments
 for each row execute function private.sync_appointment_safety_trigger();
create trigger z_safety_post_schedule after update of starts_at on public.posts
 for each row execute function private.sync_appointment_safety_trigger();
-- 분쟁 행만 갱신되어도 열린 절차를 보류한다. 판정 내용과 원문을 복제하지 않는다.
create trigger z_safety_dispute_state after insert or update on public.appointment_disputes
 for each row execute function private.sync_appointment_safety_trigger();

-- 기존 결과원장 소유자와 같게 설정하며 외부 RPC/원문 열람 권한을 추가하지 않는다.
do $$declare owner_name text;begin
 select pg_get_userbyid(relowner)into owner_name from pg_class where oid='private.safety_appointment_results'::regclass;
 execute format('alter function private.sync_appointment_safety_results(uuid,boolean,boolean) owner to %I',owner_name);
 execute format('alter function private.sync_appointment_safety_trigger() owner to %I',owner_name);
end;$$;
revoke all on function private.sync_appointment_safety_results(uuid,boolean,boolean),
 private.sync_appointment_safety_trigger() from public,anon,authenticated,service_role;
comment on function private.sync_appointment_safety_results(uuid,boolean,boolean) is
 '실제 약속 상태만 자동 origin 원장에 원자적으로 반영한다. 취소 사유·분쟁 원문·제재·통지·운영 권한을 추가하지 않는다. 과거 미연결 자료와 unknown은 전체 집계 완료 증명이 아니다.';
commit;
