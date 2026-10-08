-- 민규: 메시지 읽음 위치. 알림 읽음과 독립, 서버 시계·단조 증가.
begin;
create table private.conversation_read_states(
 user_id uuid not null references public.profiles(id)on delete cascade,
 request_id uuid not null references public.join_requests(id)on delete cascade,
 last_read_message_id uuid not null,last_read_created_at timestamptz not null,read_at timestamptz not null,
 primary key(user_id,request_id),
 foreign key(last_read_message_id)references public.chat_messages(id)on delete cascade
);
alter table private.conversation_read_states enable row level security;
revoke all on private.conversation_read_states from public,anon,authenticated,service_role;
create function private.timestamp_conversation_message()returns trigger
language plpgsql volatile security definer set search_path=''as $$declare previous timestamptz;begin
 perform 1 from public.join_requests where id=new.join_request_id for update;
 select max(created_at)into previous from public.chat_messages where join_request_id=new.join_request_id;
 new.created_at:=greatest(clock_timestamp(),previous+interval'1 microsecond');return new;
end;$$;
create trigger conversation_message_server_clock before insert on public.chat_messages for each row execute function private.timestamp_conversation_message();
revoke all on function private.timestamp_conversation_message()from public,anon,authenticated,service_role;
create function private.conversation_read_dto(p_request_id uuid)returns jsonb
language sql volatile security definer set search_path=''as $$
 select jsonb_build_object('last_read_message_id',s.last_read_message_id,'read_at',s.read_at,'unread_count',
 (select count(*)from public.chat_messages m where m.join_request_id=p_request_id and m.sender_id<>auth.uid()
 and private.conversation_message_readable(m.id)and(s.user_id is null or(m.created_at,m.id)>(s.last_read_created_at,s.last_read_message_id))))
 from(values(1))v(n)left join private.conversation_read_states s on s.user_id=auth.uid()and s.request_id=p_request_id
 and exists(select 1 from public.chat_messages marker where marker.id=s.last_read_message_id and marker.join_request_id=p_request_id and private.conversation_message_readable(marker.id));
$$;
create function public.mark_conversation_read(p_request_id uuid,p_last_read_message_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();m public.chat_messages;begin
 perform 1 from public.join_requests where id=p_request_id for update;
 perform 1 from public.get_conversation(p_request_id);
 select *into m from public.chat_messages where id=p_last_read_message_id and join_request_id=p_request_id and private.conversation_message_readable(id);
 if not found then raise exception 'message_unavailable'using errcode='PT404';end if;
 insert into private.conversation_read_states(user_id,request_id,last_read_message_id,last_read_created_at,read_at)
 values(auth.uid(),p_request_id,m.id,m.created_at,clock_timestamp())
 on conflict(user_id,request_id)do update set last_read_message_id=excluded.last_read_message_id,
 last_read_created_at=excluded.last_read_created_at,read_at=clock_timestamp()
 where(excluded.last_read_created_at,excluded.last_read_message_id)>(conversation_read_states.last_read_created_at,conversation_read_states.last_read_message_id);
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'read_episode_conflict'using errcode='40001';end if;
 return private.conversation_read_dto(p_request_id)||jsonb_build_object('request_id',p_request_id);
end;$$;
create function public.list_conversations_with_read_state()returns jsonb
language plpgsql volatile security definer set search_path=''as $$declare result jsonb;begin
 perform private.require_member_decision_notice_episode();
 select coalesce(jsonb_agg(to_jsonb(c)||private.conversation_read_dto(c.request_id)order by c.last_activity_at desc nulls last,c.request_id),'[]'::jsonb)into result from public.list_conversations()c;
 return result;
end;$$;
create function public.get_conversation_with_read_state(p_request_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''as $$declare result jsonb;begin
 perform private.require_member_decision_notice_episode();
 select coalesce(jsonb_agg(to_jsonb(c)||private.conversation_read_dto(c.request_id)),'[]'::jsonb)into result from public.get_conversation(p_request_id)c;
 return result;
end;$$;
revoke all on function private.conversation_read_dto(uuid)from public,anon,authenticated,service_role;
revoke all on function public.mark_conversation_read(uuid,uuid),public.list_conversations_with_read_state(),public.get_conversation_with_read_state(uuid)from public,anon,authenticated,service_role;
grant execute on function public.mark_conversation_read(uuid,uuid),public.list_conversations_with_read_state(),public.get_conversation_with_read_state(uuid)to authenticated;
commit;
