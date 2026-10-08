-- 민규: 공개 저장 행사 상세와 공급사 검증 전 순위 준비 상태.
begin;
create function public.get_public_event(p_event_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''as $$declare result jsonb;begin
 perform private.assert_not_retired_caller();
 if private.member_content_hidden('event',p_event_id)or not exists(select 1 from private.events where id=p_event_id and provider ~ '^[a-z0-9][a-z0-9-]{0,31}$')then raise exception 'event_unavailable'using errcode='PT404';end if;
 result:=private.project_post_linked_event(p_event_id);
 if result is null then raise exception 'event_unavailable'using errcode='PT404';end if;
 return result;
end;$$;
create function public.get_public_event_ranking_state()returns jsonb
language plpgsql volatile security definer set search_path=''as $$begin
 perform private.assert_not_retired_caller();
 return jsonb_build_object('status','not_enabled','reason','KOPIS_RANKING_PROVIDER_VERIFICATION_PENDING');
end;$$;
revoke all on function public.get_public_event(uuid),public.get_public_event_ranking_state()from public,anon,authenticated,service_role;
grant execute on function public.get_public_event(uuid),public.get_public_event_ranking_state()to anon,authenticated;
commit;
