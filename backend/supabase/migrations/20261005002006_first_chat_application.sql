-- 민규: 첫 채팅 저장 성공과 신청 성립을 한 트랜잭션으로 처리한다.
-- 사용자 제재·상대 차단 저장소는 별도 연결 과제이며 이 변경이 구현했다고 주장하지 않는다.
begin;
alter table public.join_requests drop constraint join_requests_message_length;
alter table public.join_requests add constraint join_requests_message_length
  check (message=btrim(message) and char_length(message) between 1 and 1000);
comment on column public.join_requests.message is 'Historical first-message header. Canonical conversation messages live in chat_messages.';
alter table public.join_requests add column withdrawn_at timestamptz;
update public.join_requests set withdrawn_at=updated_at where status='withdrawn';
create function private.record_request_withdrawal()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status='withdrawn' and old.status is distinct from 'withdrawn' then new.withdrawn_at:=clock_timestamp(); end if;
  return new;
end; $$;
revoke all on function private.record_request_withdrawal() from public,anon,authenticated,service_role;
create trigger join_requests_record_withdrawal before update on public.join_requests
  for each row execute function private.record_request_withdrawal();

-- 성공 표식에는 원문을 복사하지 않는다. chat_messages의 immutable 본문으로 재시도를 확인한다.
create table private.first_chat_applications (
  message_id uuid primary key references public.chat_messages(id) on delete cascade,
  request_id uuid not null references public.join_requests(id) on delete cascade,
  request_existed boolean not null
);
alter table private.first_chat_applications enable row level security;
revoke all on private.first_chat_applications from public,anon,authenticated,service_role;

create function public.request_service_post(p_post_id uuid,p_message_id uuid,p_message text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); p public.posts; r public.join_requests;
  m public.chat_messages; receipt private.first_chat_applications; v_text text:=btrim(p_message);
  v_existing boolean:=false; v_reactivated boolean:=false; v_now timestamptz; v_gender text;
begin
  if p_post_id is null or p_message_id is null or v_text is null or char_length(v_text) not between 1 and 1000 then
    raise exception 'invalid_first_message' using errcode='22023';
  end if;
  -- send_conversation_message와 같은 메시지 ID 잠금. 성공 응답 재시도는 현재 모집/신청 상태를 변경하지 않는다.
  perform pg_advisory_xact_lock(hashtextextended(p_message_id::text,322));
  select * into receipt from private.first_chat_applications where message_id=p_message_id;
  if found then
    select * into strict m from public.chat_messages where id=p_message_id;
    select * into strict r from public.join_requests where id=receipt.request_id;
    if m.sender_id<>v_uid or r.post_id<>p_post_id or m.content<>v_text then
      raise exception 'first_message_conflict' using errcode='40001';
    end if;
    return jsonb_build_object('id',r.id,'post_id',r.post_id,'status','pending','created_at',r.created_at,
      'already_existed',receipt.request_existed,'messageId',m.id,'messageCreatedAt',m.created_at,'alreadySent',true);
  end if;
  if exists(select 1 from public.chat_messages where id=p_message_id) then
    raise exception 'message_id_conflict' using errcode='40001';
  end if;
  perform private.assert_naver_activity_allowed();
  select * into p from public.posts where id=p_post_id and status<>'deleted' for update;
  if not found then raise exception 'post_unavailable' using errcode='P0002'; end if;
  if p.author_id=v_uid then raise exception 'own_post' using errcode='42501'; end if;
  if p.cost_type is distinct from 'free' then raise exception 'bank_integration_unavailable' using errcode='PT503'; end if;
  v_now:=clock_timestamp();
  if p.status<>'recruiting' or p.recruitment_ends_at<=v_now or p.starts_at<=v_now
    or exists(select 1 from public.appointments where post_id=p.id and status<>'cancelled') then
    raise exception 'recruitment_closed' using errcode='40001';
  end if;
  perform private.lock_match_post_requests(p.id);
  if exists(select 1 from public.join_requests where post_id=p.id and requester_id=v_uid and status='declined') then
    raise exception 'request_declined_history' using errcode='42501';
  end if;
  select gender into v_gender from public.profiles where id=v_uid;
  if p.partner_gender<>'any' and v_gender is distinct from p.partner_gender then
    raise exception 'partner_condition_mismatch' using errcode='42501';
  end if;
  select * into r from public.join_requests where post_id=p.id and requester_id=v_uid
    order by (status='pending') desc,created_at desc,id desc limit 1;
  if found then
    v_existing:=true;
    if r.status='withdrawn' then
      if r.withdrawn_at is null or clock_timestamp()<r.withdrawn_at+interval '1 minute' then
        raise exception 'withdrawal_cooldown' using errcode='40001';
      end if;
      update public.join_requests set status='pending' where id=r.id returning * into r;
      v_reactivated:=true;
    elsif r.status<>'pending' then
      raise exception 'request_not_active' using errcode='40001';
    end if;
  else
    insert into public.join_requests(post_id,requester_id,message) values(p.id,v_uid,v_text) returning * into r;
  end if;
  insert into public.chat_messages(id,join_request_id,sender_id,content)
    values(p_message_id,r.id,v_uid,v_text) returning * into m;
  insert into private.first_chat_applications values(m.id,r.id,v_existing);
  delete from private.conversation_visibility where request_id=r.id;
  if v_reactivated then
    insert into public.notifications(recipient_id,kind,join_request_id,created_at)
      values(p.author_id,'join_request',r.id,clock_timestamp())
      on conflict(recipient_id,kind,join_request_id) do update set created_at=excluded.created_at,read_at=null;
  end if;
  return jsonb_build_object('id',r.id,'post_id',r.post_id,'status','pending','created_at',r.created_at,
    'already_existed',v_existing,'messageId',m.id,'messageCreatedAt',m.created_at,'alreadySent',false);
end; $$;

-- 구형 별도 신청 경로와 직접 create_join_request를 닫아 첫 채팅 없이 신청하는 우회를 막는다.
revoke all on function public.request_service_post(uuid,text),public.create_join_request(uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function public.request_service_post(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.request_service_post(uuid,uuid,text) to authenticated;
commit;
