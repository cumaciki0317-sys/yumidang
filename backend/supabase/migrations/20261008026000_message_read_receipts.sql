-- SQL106: 실제 표시된 메시지별 집합. watermark 과거 자료를 자동 backfill하지 않는다.
begin;
create table private.conversation_message_reads(
 user_id uuid not null references public.profiles(id)on delete cascade,
 request_id uuid not null references public.join_requests(id)on delete cascade,
 message_id uuid not null references public.chat_messages(id)on delete cascade,
 read_at timestamptz not null default clock_timestamp(),primary key(user_id,message_id));
create index conversation_message_reads_request on private.conversation_message_reads(user_id,request_id);
alter table private.conversation_message_reads enable row level security;
revoke all on private.conversation_message_reads from public,anon,authenticated,service_role;
create function private.conversation_unread_messages(p_request_id uuid)returns bigint language sql volatile security definer set search_path=''as $$
 select count(*)from public.chat_messages m where m.join_request_id=p_request_id and m.sender_id<>auth.uid()and private.conversation_message_readable(m.id)
 and not exists(select 1 from private.conversation_message_reads r where r.user_id=auth.uid()and r.message_id=m.id);
$$;
create function public.mark_conversation_messages_read(p_request_id uuid,p_message_ids uuid[])returns jsonb language plpgsql volatile security definer set search_path=''as $$declare episode uuid:=private.require_member_decision_notice_episode();ids uuid[];n integer;begin
 if p_request_id is null or p_message_ids is null or coalesce(array_ndims(p_message_ids),0)<>1 or cardinality(p_message_ids)not between 1 and 100 or array_position(p_message_ids,null)is not null or(select count(distinct x)from unnest(p_message_ids)x)<>cardinality(p_message_ids)then raise exception 'invalid_message_ids'using errcode='22023';end if;
 perform 1 from public.join_requests where id=p_request_id for update;
 perform 1 from public.get_conversation(p_request_id);
 select array_agg(m.id order by m.id),count(*)into ids,n from public.chat_messages m where m.id=any(p_message_ids)and m.join_request_id=p_request_id and private.conversation_message_readable(m.id);
 if n<>cardinality(p_message_ids)then raise exception 'message_unavailable'using errcode='PT404';end if;
 -- 대화 행 잠금은 기존 전송/읽음과 직렬화한다. 중복 접수의 최초 서버 시각을 보존한다.
 insert into private.conversation_message_reads(user_id,request_id,message_id)select auth.uid(),p_request_id,x from unnest(ids)x on conflict(user_id,message_id)do nothing;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'read_episode_conflict'using errcode='40001';end if;
 return jsonb_build_object('messageIds',ids,'unreadCount',private.conversation_unread_messages(p_request_id));
end;$$;
create or replace function public.list_conversations_with_read_state()returns jsonb language plpgsql volatile security definer set search_path=''as $$declare value jsonb;begin
 perform private.require_member_decision_notice_episode();
 select coalesce(jsonb_agg(to_jsonb(c)||private.conversation_read_dto(c.request_id)||jsonb_build_object('unread_message_count',private.conversation_unread_messages(c.request_id))order by c.last_activity_at desc nulls last,c.request_id),'[]'::jsonb)into value from public.list_conversations()c;
 return value;
end;$$;
create or replace function public.get_conversation_with_read_state(p_request_id uuid)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare value jsonb;begin
 perform private.require_member_decision_notice_episode();
 select coalesce(jsonb_agg(to_jsonb(c)||private.conversation_read_dto(c.request_id)||jsonb_build_object('unread_message_count',private.conversation_unread_messages(c.request_id))),'[]'::jsonb)into value from public.get_conversation(p_request_id)c;
 return value;
end;$$;
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.mark_conversation_read(uuid,uuid)'::regprocedure;
 execute format('alter table private.conversation_message_reads owner to %I',own);
 execute format('alter function private.conversation_unread_messages(uuid)owner to %I',own);
 execute format('alter function public.mark_conversation_messages_read(uuid,uuid[])owner to %I',own);
end;$$;
revoke all on function private.conversation_unread_messages(uuid),public.mark_conversation_messages_read(uuid,uuid[])from public,anon,authenticated,service_role;
grant execute on function public.mark_conversation_messages_read(uuid,uuid[])to authenticated;
commit;
