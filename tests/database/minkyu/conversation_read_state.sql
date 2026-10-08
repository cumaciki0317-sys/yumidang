-- 앞선 회원·본인 공고 fixture와 같은 TX. 새 시계/읽음/파기 연결을 실제 DB에서 검사한다.
create temp table additional_chat(request_id uuid,message_id uuid,later_id uuid);
grant all on additional_chat to authenticated;
set local role authenticated;
select pg_temp.safety_actor(2);
insert into additional_chat select (public.request_service_post('fd810000-0000-4000-8000-000000000003','fda40000-0000-4000-8000-000000000001','읽음 합성 첫 메시지')->>'id')::uuid,'fda40000-0000-4000-8000-000000000001','fda40000-0000-4000-8000-000000000002';
select pg_temp.safety_actor(1);
do $$declare r additional_chat;one jsonb;begin
 select *into r from additional_chat;
 assert public.get_conversation_with_read_state(r.request_id)->0->>'unread_count'='1';
 one:=public.mark_conversation_read(r.request_id,r.message_id);
 assert one=public.mark_conversation_read(r.request_id,r.message_id);
 assert one->>'unread_count'='0';
 perform pg_temp.safety_failure(format('select public.mark_conversation_read(%L,%L)',r.request_id,gen_random_uuid()),'PT404');
end;$$;
reset role;
-- 의도적으로 과거 시각을 공급해도 INSERT trigger가 현재 서버 순서를 적용한다.
insert into public.chat_messages(id,join_request_id,sender_id,content,created_at)
 select later_id,request_id,pg_temp.safety_uid(2),'늦게 기록된 메시지',now()-interval'1 hour'from additional_chat;
do $$begin assert(select newer.created_at>older.created_at from additional_chat f join public.chat_messages newer on newer.id=f.later_id join public.chat_messages older on older.id=f.message_id);end;$$;
set local role authenticated;
select pg_temp.safety_actor(1);
do $$declare r additional_chat;begin select *into r from additional_chat;
 assert public.get_conversation_with_read_state(r.request_id)->0->>'unread_count'='1';
 perform public.mark_conversation_read(r.request_id,r.later_id);
 assert public.mark_conversation_read(r.request_id,r.message_id)->>'last_read_message_id'=r.later_id::text;
end;$$;
reset role;
delete from public.chat_messages where id=(select later_id from additional_chat);
do $$begin assert not exists(select 1 from private.conversation_read_states where request_id=(select request_id from additional_chat));
 assert not has_table_privilege('authenticated','private.conversation_read_states','select');end;$$;
