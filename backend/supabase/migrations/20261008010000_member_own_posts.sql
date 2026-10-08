-- 민규: 본인 공고 관리 목록. 공개 검색과 분리된 회원 전용 조회.
begin;
create index posts_author_created_idx on public.posts(author_id,created_at desc,id desc) where status<>'deleted';
create function public.list_my_service_posts(p_limit integer default 20,p_before uuid default null) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare episode uuid:=private.require_member_decision_notice_episode(); actor uuid:=auth.uid(); anchor public.posts; result jsonb;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_post_page'using errcode='22023';end if;
 if p_before is not null then
  select *into anchor from public.posts where id=p_before and author_id=actor and status<>'deleted';
  if not found then raise exception 'post_cursor_unavailable'using errcode='PT404';end if;
 end if;
 with candidates as materialized(select p.*from public.posts p where p.author_id=actor and p.status<>'deleted'
  and(p_before is null or(p.created_at,p.id)<(anchor.created_at,anchor.id))order by p.created_at desc,p.id desc limit p_limit+1),
 page as(select *from candidates order by created_at desc,id desc limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(public.get_service_post(id)||jsonb_build_object('createdAt',created_at,'isOwner',true)order by created_at desc,id desc)from page),'[]'::jsonb),
 'nextCursor',case when(select count(*)from candidates)>p_limit then(select id from page order by created_at,id limit 1)end)into result;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'post_episode_conflict'using errcode='40001';end if;
 return result;
end;$$;
revoke all on function public.list_my_service_posts(integer,uuid)from public,anon,authenticated,service_role;
grant execute on function public.list_my_service_posts(integer,uuid)to authenticated;
commit;
