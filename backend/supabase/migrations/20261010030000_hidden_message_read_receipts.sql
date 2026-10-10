-- SQL120: 숨긴 메시지는 개별 읽음 접수와 개별 미확인 집계에서 제외한다.
-- 기존 watermark·최초 read_at·함수 소유자와 실행 권한은 유지한다.
begin;
do $$
declare
 signature text;
 before_row record;
 after_row record;
 before_metadata jsonb;
 after_metadata jsonb;
 definition text;
 needle text := 'and private.conversation_message_readable(m.id)';
 replacement text := 'and private.conversation_message_readable(m.id)and not private.member_content_hidden(''chat'',m.id)';
 legacy_definition text := pg_get_functiondef('public.mark_conversation_read(uuid,uuid)'::regprocedure);
begin
 foreach signature in array array[
  'private.conversation_unread_messages(uuid)',
  'public.mark_conversation_messages_read(uuid,uuid[])'
 ] loop
  select oid,proowner,proacl,proconfig,prosecdef,provolatile,proparallel,proleakproof,prolang,prorettype,proargtypes,proallargtypes
   into strict before_row from pg_proc where oid=to_regprocedure(signature);
  select to_jsonb(p)-'prosrc' into strict before_metadata from pg_proc p where p.oid=before_row.oid;
  definition := pg_get_functiondef(before_row.oid);
  if not before_row.prosecdef or before_row.provolatile<>'v'
   or before_row.proconfig is distinct from array['search_path=""']::text[]
   or (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1
   or strpos(definition,'private.member_content_hidden')<>0 then
   raise exception 'hidden_message_read_contract_changed' using errcode='55000';
  end if;
  execute replace(definition,needle,replacement);
  select oid,proowner,proacl,proconfig,prosecdef,provolatile,proparallel,proleakproof,prolang,prorettype,proargtypes,proallargtypes
   into strict after_row from pg_proc where oid=to_regprocedure(signature);
  select to_jsonb(p)-'prosrc' into strict after_metadata from pg_proc p where p.oid=after_row.oid;
  if after_row is distinct from before_row or after_metadata is distinct from before_metadata then
   raise exception 'hidden_message_read_attributes_changed' using errcode='55000';
  end if;
  if pg_get_functiondef(after_row.oid) is distinct from replace(definition,needle,replacement) then
   raise exception 'hidden_message_read_definition_changed' using errcode='55000';
  end if;
 end loop;
 if pg_get_functiondef('public.mark_conversation_read(uuid,uuid)'::regprocedure) is distinct from legacy_definition then
  raise exception 'legacy_message_watermark_changed' using errcode='55000';
 end if;
end;
$$;
commit;
