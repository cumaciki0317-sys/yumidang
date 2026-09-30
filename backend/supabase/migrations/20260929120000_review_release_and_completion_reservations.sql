-- 2026-09-29 사용자 확정: 양측 제출 즉시 공개, 한쪽 제출은 완료 알림 +24시간.
-- 기존 이력/override는 보존하며 실행 예약만 추가한다. 마이그레이션은 약속을 완료시키지 않는다.
begin;
create or replace function private.review_release_ready(p_appointment_id uuid)
returns boolean language sql volatile security definer set search_path = '' as $$
 select coalesce((select ap.status='completed' and ap.completed_at is not null
   and p.author_id<>jr.requester_id
   and (ap.completion_method='automatic' or (ap.completion_method='manual'
     and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=p.author_id)
     and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=jr.requester_id)))
   and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id and (d.status='open' or d.resolution='no_show'))
   and exists(select 1 from public.appointment_reviews r where r.appointment_id=ap.id and r.reviewer_id in(p.author_id,jr.requester_id))
   and ((exists(select 1 from public.appointment_reviews r where r.appointment_id=ap.id and r.reviewer_id=p.author_id)
     and exists(select 1 from public.appointment_reviews r where r.appointment_id=ap.id and r.reviewer_id=jr.requester_id))
     or clock_timestamp()>=ap.completion_notified_at+interval '24 hours')
   from public.appointments ap join public.posts p on p.id=ap.post_id
   join public.join_requests jr on jr.id=ap.join_request_id where ap.id=p_appointment_id),false);
$$;

-- 정책 후보는 조회 시각에 공개 조건을 판정한다. 운영자 비공개와 과거 기록은 우회하지 않는다.
create or replace function private.review_summary_sources(p_profile_id uuid)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('reviewId', rv.id, 'text', btrim(rv.comment)) order by rv.id), '[]'::jsonb)
  from public.appointment_reviews rv
  join private.review_publication pub on pub.review_id = rv.id and (pub.publication_source='policy' or pub.is_public)
  join public.appointments ap on ap.id = rv.appointment_id
  join public.posts p on p.id = ap.post_id
  join public.join_requests jr on jr.id = ap.join_request_id
  where rv.reviewer_id in (p.author_id, jr.requester_id)
    and p.author_id <> jr.requester_id
    and (case when rv.reviewer_id = p.author_id then jr.requester_id else p.author_id end) = p_profile_id
    and nullif(btrim(rv.comment), '') is not null
    and private.review_release_ready(ap.id);
$$;

create or replace function public.get_appointment_review_state(p_appointment_id uuid)
returns table (
  appointment_id uuid, appointment_completed boolean, deadline_at timestamptz, hold_until timestamptz,
  disputed boolean, can_write boolean, own_review jsonb, peer_submitted boolean,
  released boolean, release_reason text, peer_review jsonb, server_now timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := private.appointment_role(p_appointment_id);
  v_appointment public.appointments;
  v_own public.appointment_reviews;
  v_peer public.appointment_reviews;
  v_disputed boolean;
  v_released boolean;
  v_release_reason text;
begin
  if v_uid is null then
    raise exception 'login_required' using errcode = '28000';
  end if;
  if v_role is null then
    raise exception 'appointment_unavailable' using errcode = 'PT404';
  end if;
  select * into v_appointment from public.appointments ap where ap.id = p_appointment_id;
  select * into v_own from public.appointment_reviews rv where rv.appointment_id = p_appointment_id and rv.reviewer_id = v_uid;
  select * into v_peer from public.appointment_reviews rv where rv.appointment_id = p_appointment_id and rv.reviewer_id <> v_uid;
  v_disputed := v_appointment.status = 'disputed';
  v_released := private.review_release_ready(p_appointment_id);
  v_disputed := v_disputed or exists(select 1 from public.appointment_disputes d where d.appointment_id=p_appointment_id and (d.status='open' or d.resolution='no_show'));
  v_release_reason := case
    when not v_released then null
    when v_own.id is not null and v_peer.id is not null then 'mutual'
    else 'hold_elapsed'
  end;

  return query select
    p_appointment_id,
    v_appointment.status in ('completed', 'disputed'),
    v_appointment.review_deadline_at,
    v_appointment.dispute_deadline_at,
    v_disputed,
    (not v_disputed and v_own.id is null
      and (v_appointment.completion_method='automatic' or (select count(*) from public.appointment_completion_confirmations c
        join public.posts p on p.id=v_appointment.post_id join public.join_requests r on r.id=v_appointment.join_request_id
        where c.appointment_id=v_appointment.id and c.user_id in(p.author_id,r.requester_id))=2)
      and public.review_submission_open(
      v_appointment.completed_at, v_appointment.review_deadline_at, v_appointment.status, now())),
    case when v_own.id is null then null else jsonb_build_object(
      'experience',v_own.experience,'praises',v_own.praises,'rating', v_own.rating, 'comment', v_own.comment, 'submitted_at', v_own.submitted_at) end,
    v_peer.id is not null,
    v_released,
    v_release_reason,
    case when v_released and v_peer.id is not null then jsonb_build_object(
      'experience',v_peer.experience,'praises',v_peer.praises,'rating', v_peer.rating, 'comment', v_peer.comment, 'submitted_at', v_peer.submitted_at) end,
    now();
end;
$$;

create or replace function public.get_public_profile_reviews(p_profile_id uuid,p_limit integer,p_before uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_reviews jsonb; v_praises jsonb; v_next uuid;
begin
  if auth.uid() is null then raise exception 'login_required' using errcode='28000'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_limit' using errcode='22023'; end if;
  if not exists(select 1 from public.profiles where id=p_profile_id) then raise exception 'profile_unavailable' using errcode='P0002'; end if;
  with eligible as (
    select rv.* from public.appointment_reviews rv join private.review_publication pub on pub.review_id=rv.id and (pub.publication_source='policy' or pub.is_public)
    join public.appointments ap on ap.id=rv.appointment_id join public.posts p on p.id=ap.post_id
    join public.join_requests r on r.id=ap.join_request_id
    where rv.reviewer_id in(p.author_id,r.requester_id) and p.author_id<>r.requester_id
      and (case when rv.reviewer_id=p.author_id then r.requester_id else p.author_id end)=p_profile_id
      and private.review_release_ready(ap.id)
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
    join private.review_publication pub on pub.review_id=rv.id and (pub.publication_source='policy' or pub.is_public)
    join public.appointments ap on ap.id=rv.appointment_id join public.posts p on p.id=ap.post_id
    join public.join_requests r on r.id=ap.join_request_id cross join lateral unnest(rv.praises) x(code)
    join private.review_praise_catalog c on c.code=x.code
    where rv.experience='positive' and rv.reviewer_id in(p.author_id,r.requester_id) and p.author_id<>r.requester_id
      and (case when rv.reviewer_id=p.author_id then r.requester_id else p.author_id end)=p_profile_id
      and private.review_release_ready(ap.id)
    group by c.code,c.label order by n desc,c.code limit 5) t;
  return jsonb_build_object('reviews',v_reviews,'praisesTop5',v_praises,'nextCursor',v_next);
end; $$;

-- 공개 집계 물질화와 요약 작업 등록은 별도 트랜잭션 경계로 호출한다.
create function public.process_due_review_publications(p_limit integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; v_rows integer; v_published integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 1000 then raise exception 'invalid_limit' using errcode='22023'; end if;
 for v_id in select ap.id from public.appointments ap
   where private.review_release_ready(ap.id) and exists(select 1 from public.appointment_reviews r
     join private.review_publication p on p.review_id=r.id
     where r.appointment_id=ap.id and p.publication_source='policy' and not p.is_public)
   order by ap.id for update of ap skip locked limit p_limit
 loop
   update private.review_publication p set is_public=true from public.appointment_reviews r
     where r.id=p.review_id and r.appointment_id=v_id and p.publication_source='policy' and not p.is_public
       and private.review_release_ready(v_id);
   get diagnostics v_rows=row_count; v_published:=v_published+v_rows;
 end loop;
 return jsonb_build_object('publishedCount',v_published);
end; $$;

create function public.process_review_summary_refresh(p_limit integer,p_model_version text,p_prompt_version text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_profile uuid; v_snapshot jsonb; v_processed integer:=0;
  v_enqueued integer:=0; v_rows integer; v_result jsonb;
begin
  if p_limit is null or p_limit not between 1 and 1000 or p_model_version is null
    or p_model_version !~ '^[A-Za-z0-9_.-]{1,64}$' or p_prompt_version is null
    or p_prompt_version !~ '^[A-Za-z0-9_.-]{1,64}$' then
    raise exception 'invalid_automation_input' using errcode='22023';
  end if;
  -- Lock projection FIRST. Locking outbox first would deadlock source writers.
  for v_profile in select s.profile_id from private.review_summary_state s
    join private.review_refresh_outbox o on o.profile_id=s.profile_id
    order by s.profile_id for update of s skip locked limit p_limit
  loop
    v_snapshot:=private.refresh_review_summary_state(v_profile);
    if (v_snapshot->>'eligibleCount')::integer>=3 then
      v_result:=public.enqueue_job('review_summary',
        'review_summary:'||v_profile::text||':'||(v_snapshot->>'sourceRevision')||':'||p_model_version||':'||p_prompt_version,
        jsonb_build_object('profileId',v_profile,'sourceRevision',v_snapshot->>'sourceRevision',
          'modelVersion',p_model_version,'promptVersion',p_prompt_version),clock_timestamp());
      if not (v_result->>'deduplicated')::boolean then v_enqueued:=v_enqueued+1; end if;
    end if;
    delete from private.review_refresh_outbox where profile_id=v_profile;
    v_processed:=v_processed+1;
  end loop;
  return jsonb_build_object('processedCount',v_processed,'enqueuedCount',v_enqueued);
end; $$;

-- 구형 명시 호출의 계약은 보존한다. 새 런타임은 분리된 RPC를 사용한다.
create or replace function public.process_review_automation(p_limit integer,p_model_version text,p_prompt_version text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_publication jsonb; v_summary jsonb;
begin
 v_publication:=public.process_due_review_publications(p_limit);
 v_summary:=public.process_review_summary_refresh(p_limit,p_model_version,p_prompt_version);
 return v_publication||v_summary;
end; $$;
revoke all on function public.process_due_review_publications(integer),
 public.process_review_summary_refresh(integer,text,text) from public,anon,authenticated,service_role;
grant execute on function public.process_due_review_publications(integer),
 public.process_review_summary_refresh(integer,text,text) to service_role;

-- LISTEN/NOTIFY는 깨우기 신호이며 아래 예약 테이블이 복구 가능한 작업 원장이다.
create table private.completion_reservations (
 appointment_id uuid primary key references public.appointments(id) on delete cascade,
 due_at timestamptz not null check(isfinite(due_at)),
 generation uuid not null default gen_random_uuid()
);
create index completion_reservations_due_idx on private.completion_reservations(due_at,appointment_id);
alter table private.completion_reservations enable row level security;
revoke all on private.completion_reservations from public,anon,authenticated,service_role;

create function private.sync_completion_reservation(p_appointment_id uuid)
returns void language plpgsql volatile security definer set search_path = '' as $$
declare v_due timestamptz;
begin
 -- 약속 -> 예약 순서. 호출자는 source mutation 전에도 이 약속 잠금을 획득한다.
 perform 1 from public.appointments where id=p_appointment_id for update;
 select p.ends_at+interval '24 hours' into v_due
 from public.appointments ap join public.posts p on p.id=ap.post_id
 where ap.id=p_appointment_id and ap.status='confirmed'
   and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id and (d.status='open' or d.resolution='no_show'));
 if v_due is null then
   delete from private.completion_reservations where appointment_id=p_appointment_id;
 else
   insert into private.completion_reservations(appointment_id,due_at) values(p_appointment_id,v_due)
   on conflict(appointment_id) do update set due_at=excluded.due_at,generation=gen_random_uuid()
     where completion_reservations.due_at is distinct from excluded.due_at;
 end if;
end; $$;

create function private.notify_completion_reservations()
returns trigger language plpgsql security definer set search_path = '' as $$
begin perform pg_notify('yumidang_completion_reservations',''); return null; end; $$;
create trigger completion_reservations_notify after insert or update or delete on private.completion_reservations
for each statement execute function private.notify_completion_reservations();

-- FK의 KEY SHARE만으로는 종료시각 변경과 새 약속 삽입이 직렬화되지 않는다.
-- 새 약속 행을 만들기 전에 post SHARE 잠금을 잡아 최신 종료시각으로 예약한다.
create function private.completion_reservation_insert_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 perform 1 from public.posts where id=new.post_id for share;
 return new;
end; $$;
create trigger a_completion_reservation_insert_lock before insert on public.appointments
for each row execute function private.completion_reservation_insert_lock();

create function private.completion_reservation_source_lock()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
 if tg_table_name='posts' then
   perform 1 from public.appointments where post_id=old.id order by id for update;
 else
   perform 1 from public.appointments where id in (
     case when tg_op<>'INSERT' then old.appointment_id end,
     case when tg_op<>'DELETE' then new.appointment_id end) order by id for update;
 end if;
 return coalesce(new,old);
end; $$;
-- PostgreSQL의 트리거 이름 순서로 기존 projection 잠금보다 먼저 실행한다.
create trigger a_completion_reservation_lock before insert or update or delete on public.appointment_disputes
for each row execute function private.completion_reservation_source_lock();
create trigger a_completion_reservation_lock before update of ends_at on public.posts
for each row execute function private.completion_reservation_source_lock();

create function private.completion_reservation_source_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
 if tg_table_name='appointments' then
   if tg_op='DELETE' then
     delete from private.completion_reservations where appointment_id=old.id;
   else perform private.sync_completion_reservation(new.id); end if;
 elsif tg_table_name='posts' then
   for v_id in select id from public.appointments where post_id=new.id order by id loop
     perform private.sync_completion_reservation(v_id);
   end loop;
 else
   if tg_op<>'INSERT' then perform private.sync_completion_reservation(old.appointment_id); end if;
   if tg_op<>'DELETE' and (tg_op='INSERT' or new.appointment_id is distinct from old.appointment_id) then
     perform private.sync_completion_reservation(new.appointment_id);
   end if;
 end if;
 return coalesce(new,old);
end; $$;
create trigger appointments_completion_reservation after insert or update of status,post_id or delete on public.appointments
for each row execute function private.completion_reservation_source_changed();
create trigger posts_completion_reservation after update of ends_at on public.posts
for each row execute function private.completion_reservation_source_changed();
create trigger disputes_completion_reservation after insert or update or delete on public.appointment_disputes
for each row execute function private.completion_reservation_source_changed();

create function public.list_completion_reservations()
returns jsonb language sql volatile security definer set search_path = '' as $$
 select jsonb_build_object('serverNow',clock_timestamp(),'reservations',coalesce(jsonb_agg(
   jsonb_build_object('appointmentId',appointment_id,'dueAt',due_at,'generation',generation)
   order by due_at,appointment_id),'[]'::jsonb)) from private.completion_reservations;
$$;
create function public.execute_completion_reservation(p_appointment_id uuid,p_generation uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_ap public.appointments; v_res private.completion_reservations; v_due timestamptz; v_now timestamptz;
begin
 if p_appointment_id is null or p_generation is null then raise exception 'invalid_reservation' using errcode='22023'; end if;
 select * into v_ap from public.appointments where id=p_appointment_id for update;
 if not found then return jsonb_build_object('status','stale'); end if;
 select * into v_res from private.completion_reservations where appointment_id=p_appointment_id for update;
 if not found or v_res.generation<>p_generation then return jsonb_build_object('status','stale'); end if;
 select ends_at+interval '24 hours' into v_due from public.posts where id=v_ap.post_id;
 if v_ap.status<>'confirmed' or v_due is distinct from v_res.due_at
   or exists(select 1 from public.appointment_disputes where appointment_id=v_ap.id and (status='open' or resolution='no_show')) then
   perform private.sync_completion_reservation(v_ap.id);
   return jsonb_build_object('status','stale');
 end if;
 v_now:=clock_timestamp();
 if v_now<v_due then return jsonb_build_object('status','not_due'); end if;
 update public.appointments set status='completed',completed_at=v_now,completion_method='automatic',
   completed_by_user_id=null,completion_notified_at=v_now,
   dispute_deadline_at=v_now+interval '24 hours',review_deadline_at=v_now+interval '7 days'
 where id=v_ap.id;
 -- 상태 트리거가 예약을 삭제한다. 완료 알림은 기존 멱등 트리거가 생성한다.
 return jsonb_build_object('status','completed','completedAt',v_now);
end; $$;
revoke all on function private.sync_completion_reservation(uuid),private.notify_completion_reservations(),
 private.completion_reservation_insert_lock(),private.completion_reservation_source_lock(),private.completion_reservation_source_changed(),
 public.list_completion_reservations(),public.execute_completion_reservation(uuid,uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.list_completion_reservations(),public.execute_completion_reservation(uuid,uuid) to service_role;

-- 이력은 그대로 두고 예약만 복원한다. 기한 경과분은 실행기가 복구한다.
insert into private.completion_reservations(appointment_id,due_at)
 select ap.id,p.ends_at+interval '24 hours' from public.appointments ap join public.posts p on p.id=ap.post_id
 where ap.status='confirmed' and not exists(select 1 from public.appointment_disputes d
   where d.appointment_id=ap.id and (d.status='open' or d.resolution='no_show'));
-- 이전 분 단위 일괄 스캔을 해제한다. 운영 실행기는 예약 이벤트에 따라 개별 실행한다.
do $$ declare v_job bigint;
begin
 for v_job in select jobid from cron.job where jobname='yumidang-auto-complete-appointments' loop
   perform cron.unschedule(v_job);
 end loop;
end; $$;
commit;
