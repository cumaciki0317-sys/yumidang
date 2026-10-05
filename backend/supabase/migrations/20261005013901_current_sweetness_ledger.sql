-- 민규: 당도 확정 산식과 가입 회차 기반. 회원 탈퇴·재가입·운영 액터 권한은 별도 연결한다.
begin;
create table private.member_episodes (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null,
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  check(ended_at is null or ended_at>=started_at)
);
create unique index member_episodes_one_active on private.member_episodes(profile_id) where ended_at is null;
create table private.appointment_member_episodes (
  appointment_id uuid primary key references public.appointments(id) on delete cascade,
  author_episode_id uuid not null references private.member_episodes(id),
  requester_episode_id uuid not null references private.member_episodes(id),
  check(author_episode_id<>requester_episode_id)
);
create table private.sweetness_review_contributions (
  review_id uuid primary key references public.appointment_reviews(id) on delete cascade,
  recipient_episode_id uuid not null references private.member_episodes(id),
  reaction_delta smallint not null check(reaction_delta in(-2,0,1)),
  star_delta smallint not null check(star_delta in(-2,0,1)),
  first_eligible_at timestamptz not null default clock_timestamp()
);
create table private.sweetness_review_decisions (
  decision_id uuid primary key,
  review_id uuid not null references public.appointment_reviews(id) on delete cascade,
  revision bigint not null check(revision>0),
  is_valid boolean not null,
  decided_at timestamptz not null default clock_timestamp(),
  unique(review_id,revision)
);
-- 신뢰된 확정 사건만 후속 운영 결정 계층이 기록한다. 개별 취소 로그는 자동 반영하지 않는다.
create table private.sweetness_incident_decisions (
  decision_id uuid primary key,
  incident_id uuid not null,
  recipient_episode_id uuid not null references private.member_episodes(id),
  kind text not null check(kind in('cancel_sanction','no_show','major_violation')),
  revision bigint not null check(revision>0),
  is_valid boolean not null,
  decided_at timestamptz not null default clock_timestamp(),
  unique(incident_id,recipient_episode_id,kind,revision)
);
-- 같은 사건의 대상을 여러 회차로 임의 이동하지 않는다. 교차 재가입 정책은 별도 결정이 필요하다.
create table private.sweetness_incidents (
  incident_id uuid not null,
  recipient_episode_id uuid not null references private.member_episodes(id),
  primary key(incident_id,recipient_episode_id)
);
alter table private.sweetness_incident_decisions add foreign key(incident_id,recipient_episode_id) references private.sweetness_incidents(incident_id,recipient_episode_id);
create function private.active_member_episode(p_profile_id uuid)
returns uuid language sql stable security definer set search_path='' as $$
  select id from private.member_episodes where profile_id=p_profile_id and ended_at is null;
$$;
create function private.register_member_episode()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into private.member_episodes(profile_id) values(new.id);
  return new;
end; $$;
insert into private.member_episodes(profile_id) select id from public.profiles;
create trigger sweetness_profile_episode after insert on public.profiles
  for each row execute function private.register_member_episode();
create function private.register_appointment_episodes()
returns trigger language plpgsql security definer set search_path='' as $$
declare a uuid;r uuid;begin
  select p.author_id,j.requester_id into a,r from public.posts p join public.join_requests j on j.id=new.join_request_id where p.id=new.post_id;
  insert into private.appointment_member_episodes(appointment_id,author_episode_id,requester_episode_id)
    values(new.id,private.active_member_episode(a),private.active_member_episode(r));
  return new;
end; $$;
insert into private.appointment_member_episodes
  select ap.id,private.active_member_episode(p.author_id),private.active_member_episode(j.requester_id)
  from public.appointments ap join public.posts p on p.id=ap.post_id join public.join_requests j on j.id=ap.join_request_id;
create trigger sweetness_appointment_episode after insert on public.appointments
  for each row execute function private.register_appointment_episodes();
create function private.review_sweetness_delta(p_experience text,p_rating integer)
returns smallint language plpgsql immutable set search_path='' as $$
begin
  if p_experience is null or p_experience not in('positive','neutral','negative') or p_rating is null or p_rating not between 1 and 5 then
    raise exception 'invalid_sweetness_review' using errcode='22023';
  end if;
  return (case p_experience when 'positive' then 1 when 'neutral' then 0 else -2 end
    +case when p_rating<=2 then -2 when p_rating=3 then 0 else 1 end)::smallint;
end; $$;
create function private.review_finally_valid(p_review_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select is_valid from private.sweetness_review_decisions where review_id=p_review_id order by revision desc limit 1),true);
$$;
alter function private.is_review_public_eligible(uuid) rename to is_review_public_eligible_before_sweetness;
create function private.is_review_public_eligible(p_review_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
  select private.review_finally_valid(p_review_id) and private.is_review_public_eligible_before_sweetness(p_review_id);
$$;
create function private.sync_appointment_sweetness(p_appointment_id uuid)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  perform 1 from public.appointments where id=p_appointment_id for update;
  insert into private.sweetness_review_contributions(review_id,recipient_episode_id,reaction_delta,star_delta)
    select rv.id,case when rv.reviewer_id=p.author_id then e.requester_episode_id else e.author_episode_id end,
      case rv.experience when 'positive' then 1 when 'neutral' then 0 else -2 end,
      case when rv.rating<=2 then -2 when rv.rating=3 then 0 else 1 end
    from public.appointment_reviews rv join public.appointments ap on ap.id=rv.appointment_id
    join public.posts p on p.id=ap.post_id join private.appointment_member_episodes e on e.appointment_id=ap.id
    where ap.id=p_appointment_id and rv.experience is not null and private.is_review_public_eligible(rv.id)
    on conflict(review_id) do nothing;
end; $$;
create function private.capture_sweetness_release()
returns trigger language plpgsql security definer set search_path='' as $$
declare a uuid;begin
  if tg_table_schema='private' then
    select appointment_id into a from public.appointment_reviews where id=new.review_id;
  else a:=old.id;end if;
  perform private.sync_appointment_sweetness(a);
  return new;
end; $$;
-- 변경 전 공개 조건을 기존 약속 잠금 아래 보존한다.
create trigger sweetness_before_publication before update on private.review_publication
  for each row execute function private.capture_sweetness_release();
create trigger sweetness_after_publication after insert or update on private.review_publication
  for each row execute function private.capture_sweetness_release();
create trigger a_sweetness_before_appointment_change before update on public.appointments
  for each row execute function private.capture_sweetness_release();
-- 현재 적격만 이관한다. 과거 override=false의 불명확한 공개 이력을 추측하지 않는다.
do $$ declare a uuid;begin
  for a in select id from public.appointments order by id loop perform private.sync_appointment_sweetness(a);end loop;
end $$;
create function private.current_member_sweetness(p_profile_id uuid)
returns integer language sql volatile security definer set search_path='' as $$
  with episode as (select private.active_member_episode(p_profile_id) id),
  review_values as (
    select c.review_id,(c.reaction_delta+c.star_delta)::bigint delta
    from private.sweetness_review_contributions c join episode e on e.id=c.recipient_episode_id
    join public.appointment_reviews rv on rv.id=c.review_id
    where private.review_finally_valid(c.review_id)
      and not exists(select 1 from public.appointment_disputes d where d.appointment_id=rv.appointment_id and d.resolution='no_show')
    union all
    select rv.id,private.review_sweetness_delta(rv.experience,rv.rating)::bigint
    from public.appointment_reviews rv join public.appointments ap on ap.id=rv.appointment_id
    join public.posts p on p.id=ap.post_id join private.appointment_member_episodes ae on ae.appointment_id=ap.id
    join episode e on e.id=case when rv.reviewer_id=p.author_id then ae.requester_episode_id else ae.author_episode_id end
    where rv.experience is not null and private.is_review_public_eligible(rv.id)
      and not exists(select 1 from private.sweetness_review_contributions c where c.review_id=rv.id)
  ), latest_incidents as (
    select distinct on(d.incident_id,d.kind) d.* from private.sweetness_incident_decisions d join episode e on e.id=d.recipient_episode_id
    order by d.incident_id,d.kind,d.revision desc
  ), incident_values as (
    select incident_id,min(case kind when 'cancel_sanction' then -2 when 'no_show' then -3 else -10 end) delta
    from latest_incidents where is_valid group by incident_id
  )
  select least(100::numeric,greatest(0::numeric,15::numeric
    +coalesce((select sum(delta) from review_values),0)+coalesce((select sum(delta) from incident_values),0)))::integer;
$$;
create function private.decide_review_sweetness(p_decision_id uuid,p_review_id uuid,p_revision bigint,p_is_valid boolean)
returns void language plpgsql volatile security definer set search_path='' as $$
declare a uuid;old private.sweetness_review_decisions;begin
  if p_decision_id is null or p_is_valid is null or p_revision is null or p_revision<1 then raise exception 'invalid_decision' using errcode='22023';end if;
  select appointment_id into a from public.appointment_reviews where id=p_review_id;
  if a is null then raise exception 'review_unavailable' using errcode='P0002';end if;
  perform 1 from public.appointments where id=a for update;
  select * into old from private.sweetness_review_decisions where decision_id=p_decision_id;
  if found then
    if old.review_id=p_review_id and old.revision=p_revision and old.is_valid=p_is_valid then return;end if;
    raise exception 'decision_conflict' using errcode='40001';
  end if;
  if p_revision<>coalesce((select max(revision) from private.sweetness_review_decisions where review_id=p_review_id),0)+1 then
    raise exception 'decision_revision_conflict' using errcode='40001';end if;
  perform private.sync_appointment_sweetness(a);
  insert into private.sweetness_review_decisions(decision_id,review_id,revision,is_valid) values(p_decision_id,p_review_id,p_revision,p_is_valid);
  perform private.invalidate_appointment_review_summaries(array[a]);
end; $$;
create function private.decide_incident_sweetness(p_decision_id uuid,p_incident_id uuid,p_episode_id uuid,p_kind text,p_revision bigint,p_is_valid boolean)
returns void language plpgsql volatile security definer set search_path='' as $$
declare old private.sweetness_incident_decisions;begin
  if p_decision_id is null or p_incident_id is null or p_episode_id is null or p_kind is null or p_kind not in('cancel_sanction','no_show','major_violation')
    or p_revision is null or p_revision<1 or p_is_valid is null then raise exception 'invalid_decision' using errcode='22023';end if;
  -- 미정인 탈퇴 전 사건의 재가입 후 최초 감점은 아직 이 helper로 처리하지 않는다.
  perform 1 from private.member_episodes where id=p_episode_id for share;
  if not found then raise exception 'episode_unavailable' using errcode='P0002';end if;
  if not exists(select 1 from private.member_episodes where id=p_episode_id and ended_at is null)
    and not exists(select 1 from private.sweetness_incidents where incident_id=p_incident_id and recipient_episode_id=p_episode_id) then
    raise exception 'cross_episode_decision_unresolved' using errcode='55000';end if;
  insert into private.sweetness_incidents(incident_id,recipient_episode_id) values(p_incident_id,p_episode_id) on conflict do nothing;
  perform 1 from private.sweetness_incidents where incident_id=p_incident_id and recipient_episode_id=p_episode_id for update;
  if not found then raise exception 'incident_episode_conflict' using errcode='40001';end if;
  select * into old from private.sweetness_incident_decisions where decision_id=p_decision_id;
  if found then
    if old.incident_id=p_incident_id and old.recipient_episode_id=p_episode_id and old.kind=p_kind and old.revision=p_revision and old.is_valid=p_is_valid then return;end if;
    raise exception 'decision_conflict' using errcode='40001';end if;
  if p_revision<>coalesce((select max(revision) from private.sweetness_incident_decisions where incident_id=p_incident_id and recipient_episode_id=p_episode_id and kind=p_kind),0)+1 then
    raise exception 'decision_revision_conflict' using errcode='40001';end if;
  insert into private.sweetness_incident_decisions(decision_id,incident_id,recipient_episode_id,kind,revision,is_valid)
    values(p_decision_id,p_incident_id,p_episode_id,p_kind,p_revision,p_is_valid);
end; $$;
create or replace function private.completed_appointment_count(p_profile_id uuid)
returns bigint language sql stable security definer set search_path='' as $$
  select count(distinct ap.id) from public.appointments ap join public.posts p on p.id=ap.post_id
    join public.join_requests r on r.id=ap.join_request_id join private.appointment_member_episodes e on e.appointment_id=ap.id
    where ap.completed_at is not null and ap.status in('completed','disputed') and p.author_id<>r.requester_id
      and private.active_member_episode(p_profile_id)=case when p.author_id=p_profile_id then e.author_episode_id
        when r.requester_id=p_profile_id then e.requester_episode_id else null end
      and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id and d.resolution='no_show');
$$;
create function private.review_belongs_current_episode(p_review_id uuid,p_profile_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select private.active_member_episode(p_profile_id)=case when rv.reviewer_id=p.author_id then ae.requester_episode_id else ae.author_episode_id end
    from public.appointment_reviews rv join public.appointments ap on ap.id=rv.appointment_id
    join public.posts p on p.id=ap.post_id join private.appointment_member_episodes ae on ae.appointment_id=ap.id
    where rv.id=p_review_id),false);
$$;
create or replace function private.get_public_profile_reviews_without_blocks(p_profile_id uuid,p_limit integer,p_before uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_reviews jsonb; v_praises jsonb; v_next uuid;
begin
  if auth.uid() is null then raise exception 'login_required' using errcode='28000'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_limit' using errcode='22023'; end if;
  if not exists(select 1 from public.profiles where id=p_profile_id) then raise exception 'profile_unavailable' using errcode='P0002'; end if;
  with eligible as (
    select rv.* from public.appointment_reviews rv join private.review_publication pub on pub.review_id=rv.id
    join public.appointments ap on ap.id=rv.appointment_id join public.posts p on p.id=ap.post_id
    join public.join_requests r on r.id=ap.join_request_id
    where rv.reviewer_id in(p.author_id,r.requester_id) and p.author_id<>r.requester_id
      and (case when rv.reviewer_id=p.author_id then r.requester_id else p.author_id end)=p_profile_id
      and private.is_review_public_eligible(rv.id) and private.review_belongs_current_episode(rv.id,p_profile_id)
  ), page as(select * from eligible where p_before is null or id<p_before order by id desc limit p_limit+1),
  visible as(select * from page order by id desc limit p_limit)
  select coalesce((select jsonb_agg(jsonb_build_object('reviewId',id,'rating',rating,'experience',experience,
      'text',comment,'praises',praises,'submittedAt',submitted_at) order by id desc) from visible),'[]'::jsonb),
    case when (select count(*) from page)>p_limit then (select id from visible order by id limit 1) else null::uuid end
  into v_reviews,v_next;
  -- UUID cursor is opaque, deterministic pagination; not a date-order promise.
  select coalesce(jsonb_agg(jsonb_build_object('code',code,'label',label,'count',n) order by n desc,code),'[]'::jsonb)
    into v_praises from (
    select c.code,c.label,count(*) n from public.appointment_reviews rv
    join private.review_publication pub on pub.review_id=rv.id
    join public.appointments ap on ap.id=rv.appointment_id join public.posts p on p.id=ap.post_id
    join public.join_requests r on r.id=ap.join_request_id cross join lateral unnest(rv.praises) x(code)
    join private.review_praise_catalog c on c.code=x.code
    where rv.experience='positive' and rv.reviewer_id in(p.author_id,r.requester_id) and p.author_id<>r.requester_id
      and (case when rv.reviewer_id=p.author_id then r.requester_id else p.author_id end)=p_profile_id
      and private.is_review_public_eligible(rv.id) and private.review_belongs_current_episode(rv.id,p_profile_id)
    group by c.code,c.label order by n desc,c.code limit 5) t;
  return jsonb_build_object('reviews',v_reviews,'praisesTop5',v_praises,'nextCursor',v_next,'completedCount',private.completed_appointment_count(p_profile_id));
end; $$;
create or replace function private.review_summary_sources(p_profile_id uuid)
returns jsonb language sql volatile security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('reviewId',rv.id,'text',btrim(rv.comment)) order by rv.id),'[]'::jsonb)
  from public.appointment_reviews rv join public.appointments ap on ap.id=rv.appointment_id
  join public.posts p on p.id=ap.post_id join public.join_requests jr on jr.id=ap.join_request_id
  join private.ai_member_processing author_consent on author_consent.user_id=rv.reviewer_id and author_consent.summary_allowed
  join private.ai_member_processing target_consent on target_consent.user_id=p_profile_id and target_consent.summary_allowed
  where rv.reviewer_id in(p.author_id,jr.requester_id) and p.author_id<>jr.requester_id
    and (case when rv.reviewer_id=p.author_id then jr.requester_id else p.author_id end)=p_profile_id
    and nullif(btrim(rv.comment),'') is not null and private.is_review_public_eligible(rv.id) and private.review_belongs_current_episode(rv.id,p_profile_id);
$$;
create or replace function public.get_my_profile()
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_member_uid();v jsonb;begin
  select jsonb_build_object('userId',id,'realName',real_name,'avatarUrl',avatar_url,'bio',bio,'sweetness',private.current_member_sweetness(id)) into v from public.profiles where id=u;
  if v is null then raise exception 'profile_required' using errcode='42501';end if;
  return v;
end; $$;
create or replace function public.get_public_profile(p_profile_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
begin
  if private.member_is_blocked(p_profile_id) then raise exception 'profile_unavailable' using errcode='P0002';end if;
  return private.get_public_profile_without_blocks(p_profile_id)||jsonb_build_object('sweetness',private.current_member_sweetness(p_profile_id));
end; $$;
-- 모든 원장·판정·회차 helper는 DB owner만 사용한다. 실제 운영 액터 권한을 임의 생성하지 않는다.
do $$ declare n text;begin
  foreach n in array array['member_episodes','appointment_member_episodes','sweetness_review_contributions','sweetness_review_decisions','sweetness_incident_decisions','sweetness_incidents'] loop
    execute format('alter table private.%I enable row level security',n);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',n);
  end loop;
end $$;
revoke all on function private.active_member_episode(uuid),private.register_member_episode(),private.register_appointment_episodes(),
  private.review_sweetness_delta(text,integer),private.review_finally_valid(uuid),private.is_review_public_eligible(uuid),
  private.is_review_public_eligible_before_sweetness(uuid),private.sync_appointment_sweetness(uuid),private.capture_sweetness_release(),
  private.current_member_sweetness(uuid),private.review_belongs_current_episode(uuid,uuid),private.decide_review_sweetness(uuid,uuid,bigint,boolean),
  private.decide_incident_sweetness(uuid,uuid,uuid,text,bigint,boolean) from public,anon,authenticated,service_role;
commit;
