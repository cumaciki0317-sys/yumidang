-- 개인 완료 확인 후 선제 제출과 실제 완료 기준 공개·기한·횟수를 분리한다.
-- 과거 후기·override·완료 시각·예약 generation은 보존한다.
begin;

alter table private.review_praise_catalog add column is_active boolean not null default false;
alter table private.review_praise_catalog add column display_order smallint;
insert into private.review_praise_catalog(code,label,is_active,display_order) values
  ('punctual','시간을 잘 지켜요',true,1),
  ('keeps_promises','약속한 내용을 지켜요',true,2),
  ('communicates_well','소통이 원활해요',true,3),
  ('considerate','배려심이 있어요',true,4),
  ('enjoyable_conversation','대화가 즐거워요',true,5),
  ('comfortable_companion','함께하니 편안해요',true,6)
on conflict(code) do update set label=excluded.label,is_active=excluded.is_active,display_order=excluded.display_order;

create function public.get_review_praise_catalog()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile();
begin
  if auth.role() is distinct from 'authenticated' or coalesce(auth.jwt()->>'is_anonymous','false')<>'false' then
    raise exception 'login_required' using errcode='28000';
  end if;
  return jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('code',code,'label',label)
    order by display_order,code) from private.review_praise_catalog where is_active),'[]'::jsonb));
end; $$;

create function private.can_submit_appointment_review(p_appointment_id uuid,p_uid uuid,p_at timestamptz)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce((select p_uid in(p.author_id,r.requester_id) and p.author_id<>r.requester_id
    and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id
      and (d.status='open' or d.resolution='no_show'))
    and ((ap.status='confirmed' and ap.completed_at is null and p_at>=p.ends_at
      and exists(select 1 from public.appointment_completion_confirmations c
        where c.appointment_id=ap.id and c.user_id=p_uid))
      or (ap.status='completed' and ap.completed_at is not null
        and (ap.completion_method='automatic' or (ap.completion_method='manual'
          and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=p.author_id)
          and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=r.requester_id)))
        and public.review_submission_open(ap.completed_at,ap.review_deadline_at,ap.status,p_at)))
    from public.appointments ap join public.posts p on p.id=ap.post_id join public.join_requests r on r.id=ap.join_request_id
    where ap.id=p_appointment_id),false);
$$;

create or replace function private.review_release_ready(p_appointment_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
  select coalesce((select ap.status='completed' and ap.completed_at is not null and clock_timestamp()>=ap.completed_at and p.author_id<>r.requester_id
    and (ap.completion_method='automatic' or (ap.completion_method='manual'
      and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=p.author_id)
      and exists(select 1 from public.appointment_completion_confirmations c where c.appointment_id=ap.id and c.user_id=r.requester_id)))
    and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id
      and (d.status='open' or d.resolution='no_show'))
    and exists(select 1 from public.appointment_reviews rv where rv.appointment_id=ap.id and rv.reviewer_id in(p.author_id,r.requester_id))
    and ((exists(select 1 from public.appointment_reviews rv where rv.appointment_id=ap.id and rv.reviewer_id=p.author_id)
      and exists(select 1 from public.appointment_reviews rv where rv.appointment_id=ap.id and rv.reviewer_id=r.requester_id))
      or clock_timestamp()>=ap.completed_at+interval '24 hours')
    from public.appointments ap join public.posts p on p.id=ap.post_id join public.join_requests r on r.id=ap.join_request_id
    where ap.id=p_appointment_id),false);
$$;

-- 작성자/상대 공개·칭찬·AI 입력·당도 입력의 공통 적격성. 비공개 override를 자동 공개하지 않는다.
create function private.is_review_public_eligible(p_review_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
  select coalesce((select (pub.publication_source='policy' or pub.is_public)
    and rv.reviewer_id in(p.author_id,r.requester_id) and p.author_id<>r.requester_id
    and private.review_release_ready(ap.id)
    from public.appointment_reviews rv join private.review_publication pub on pub.review_id=rv.id
    join public.appointments ap on ap.id=rv.appointment_id join public.posts p on p.id=ap.post_id
    join public.join_requests r on r.id=ap.join_request_id where rv.id=p_review_id),false);
$$;

create or replace function public.submit_appointment_review(p_appointment_id uuid,p_rating integer,p_comment text,p_experience text,p_praises text[])
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_ap public.appointments; v_existing public.appointment_reviews;
  v_comment text:=nullif(btrim(coalesce(p_comment,'')),''); v_praises text[];
begin
  if v_uid is null then raise exception 'login_required' using errcode='28000'; end if;
  select * into v_ap from public.appointments where id=p_appointment_id for update;
  if v_ap.id is null or private.appointment_role(p_appointment_id) is null then raise exception 'appointment_unavailable' using errcode='PT404'; end if;
  if p_praises is null or coalesce(array_ndims(p_praises),1)<>1 then raise exception 'invalid_review' using errcode='22023'; end if;
  if p_rating is null or p_rating not between 1 and 5 or p_experience is null or p_experience not in('positive','neutral','negative')
    or length(v_comment)>300 or cardinality(p_praises)>3 or (p_experience<>'positive' and cardinality(p_praises)>0)
    or exists(select 1 from unnest(p_praises) x where x is null)
    or cardinality(p_praises)<>(select count(distinct x) from unnest(p_praises) x) then
    raise exception 'invalid_review' using errcode='22023';
  end if;
  select coalesce(array_agg(x order by x),'{}') into v_praises from unnest(p_praises) x;
  select * into v_existing from public.appointment_reviews where appointment_id=p_appointment_id and reviewer_id=v_uid;
  if v_existing.id is not null then
    -- 제출 성공 후 동일 요청 재시도는 상태·기한·목록 변경과 관계없이 기존 성공을 반환한다.
    if v_existing.rating=p_rating and v_existing.comment is not distinct from v_comment
      and v_existing.experience=p_experience and v_existing.praises=v_praises then
      return jsonb_build_object('reviewId',v_existing.id,'submittedAt',v_existing.submitted_at,'deduplicated',true);
    end if;
    raise exception 'already_submitted' using errcode='23505';
  end if;
  if exists(select 1 from unnest(p_praises) x where not exists(select 1 from private.review_praise_catalog c where c.code=x and c.is_active)) then
    raise exception 'invalid_review' using errcode='22023';
  end if;
  if not private.can_submit_appointment_review(p_appointment_id,v_uid,clock_timestamp()) then
    raise exception 'review_unavailable' using errcode='22023';
  end if;
  insert into public.appointment_reviews(appointment_id,reviewer_id,rating,comment,experience,praises)
    values(p_appointment_id,v_uid,p_rating,v_comment,p_experience,v_praises) returning * into v_existing;
  return jsonb_build_object('reviewId',v_existing.id,'submittedAt',v_existing.submitted_at,'deduplicated',false);
end; $$;

create or replace function public.get_appointment_review_state(p_appointment_id uuid)
returns table(appointment_id uuid,appointment_completed boolean,deadline_at timestamptz,hold_until timestamptz,
  disputed boolean,can_write boolean,own_review jsonb,peer_submitted boolean,released boolean,release_reason text,peer_review jsonb,server_now timestamptz)
language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_ap public.appointments; v_own public.appointment_reviews; v_peer public.appointment_reviews;
  v_disputed boolean; v_released boolean; v_now timestamptz;
begin
  if v_uid is null then raise exception 'login_required' using errcode='28000'; end if;
  if private.appointment_role(p_appointment_id) is null then raise exception 'appointment_unavailable' using errcode='PT404'; end if;
  select * into v_ap from public.appointments ap where ap.id=p_appointment_id for share;
  v_now:=clock_timestamp();
  select * into v_own from public.appointment_reviews rv where rv.appointment_id=p_appointment_id and rv.reviewer_id=v_uid;
  select * into v_peer from public.appointment_reviews rv where rv.appointment_id=p_appointment_id and rv.reviewer_id<>v_uid;
  v_disputed:=v_ap.status='disputed' or exists(select 1 from public.appointment_disputes d
    where d.appointment_id=p_appointment_id and (d.status='open' or d.resolution='no_show'));
  v_released:=v_peer.id is not null and private.is_review_public_eligible(v_peer.id);
  return query select p_appointment_id,v_ap.status in('completed','disputed') and v_ap.completed_at is not null,
    v_ap.review_deadline_at,v_ap.dispute_deadline_at,v_disputed,
    v_own.id is null and private.can_submit_appointment_review(p_appointment_id,v_uid,v_now),
    case when v_own.id is null then null else jsonb_build_object('experience',v_own.experience,'praises',v_own.praises,
      'rating',v_own.rating,'comment',v_own.comment,'submitted_at',v_own.submitted_at) end,
    v_peer.id is not null,v_released,case when not v_released then null when v_own.id is not null then 'mutual' else 'hold_elapsed' end,
    case when v_released then jsonb_build_object('experience',v_peer.experience,'praises',v_peer.praises,
      'rating',v_peer.rating,'comment',v_peer.comment,'submitted_at',v_peer.submitted_at) end,v_now;
end; $$;

revoke all on function private.can_submit_appointment_review(uuid,uuid,timestamptz),private.is_review_public_eligible(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.get_review_praise_catalog() from public,anon,authenticated,service_role;
grant execute on function public.get_review_praise_catalog() to authenticated;
-- 구형 후기 입력·테이블 직접 접근은 복원하지 않는다.
revoke all on function public.submit_appointment_review(uuid,integer,text) from public,anon,authenticated,service_role;
revoke all on public.appointment_reviews,private.review_praise_catalog from public,anon,authenticated,service_role;

create or replace function private.review_summary_sources(p_profile_id uuid)
returns jsonb language sql volatile security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('reviewId', rv.id, 'text', btrim(rv.comment)) order by rv.id), '[]'::jsonb)
  from public.appointment_reviews rv
  join private.review_publication pub on pub.review_id = rv.id
  join public.appointments ap on ap.id = rv.appointment_id
  join public.posts p on p.id = ap.post_id
  join public.join_requests jr on jr.id = ap.join_request_id
  where rv.reviewer_id in (p.author_id, jr.requester_id)
    and p.author_id <> jr.requester_id
    and (case when rv.reviewer_id = p.author_id then jr.requester_id else p.author_id end) = p_profile_id
    and nullif(btrim(rv.comment), '') is not null
    and private.is_review_public_eligible(rv.id);
$$;


-- 완료 횟수는 공개 후기/분쟁 중 공개 보류와 별개인 실제 완료 이력을 센다.
create function private.completed_appointment_count(p_profile_id uuid)
returns bigint language sql stable security definer set search_path='' as $$
  select count(distinct ap.id) from public.appointments ap join public.posts p on p.id=ap.post_id
    join public.join_requests r on r.id=ap.join_request_id
    where ap.completed_at is not null and ap.status in('completed','disputed') and p.author_id<>r.requester_id
      and p_profile_id in(p.author_id,r.requester_id)
      and not exists(select 1 from public.appointment_disputes d where d.appointment_id=ap.id and d.resolution='no_show');
$$;
revoke all on function private.completed_appointment_count(uuid) from public,anon,authenticated,service_role;

create or replace function public.get_public_profile_reviews(p_profile_id uuid,p_limit integer,p_before uuid default null)
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
      and private.is_review_public_eligible(rv.id)
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
      and private.is_review_public_eligible(rv.id)
    group by c.code,c.label order by n desc,c.code limit 5) t;
  return jsonb_build_object('reviews',v_reviews,'praisesTop5',v_praises,'nextCursor',v_next,'completedCount',private.completed_appointment_count(p_profile_id));
end; $$;


comment on column private.review_praise_catalog.is_active is '현재 신규 후기에서 선택 가능한 정책 칭찬. 과거 코드/후기는 삭제하지 않는다.';
comment on function private.is_review_public_eligible(uuid) is '상대 열람·공개 프로필·칭찬·요약·당도 입력의 공개 적격성. 당도 점수 산식은 포함하지 않는다.';
commit;
