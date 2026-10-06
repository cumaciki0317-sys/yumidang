-- 민규: 본인 선택 숨김의 최소 식별 기록. 신고 원문/증거/판정/직원 정보와 분리한다.
-- forward-only 확장. 복구는 후속 보정으로 수행하며 운영에서 역순 DROP하지 않는다.
begin;
create table private.member_hidden_targets(
 id uuid primary key default gen_random_uuid(),
 identity_id uuid not null references private.naver_identity_keys(id)on delete cascade,
 target_type text not null check(target_type in('post','chat','appointment','member','event')),
 target_id uuid not null check(target_id<>'00000000-0000-0000-0000-000000000000'::uuid),
 unique(identity_id,target_type,target_id)
);
alter table private.member_hidden_targets enable row level security;
revoke all on private.member_hidden_targets from public,anon,authenticated,service_role,authenticator;
create function private.capture_member_report_hidden_target()returns trigger
language plpgsql security definer set search_path=''as $$declare identity_key uuid;begin
 if new.hide_target then
  select identity_id into strict identity_key from private.member_episodes where id=new.reporter_episode_id;
  insert into private.member_hidden_targets(identity_id,target_type,target_id)
  values(identity_key,new.target_type,new.target_id)on conflict(identity_id,target_type,target_id)do nothing;
 end if;
 return new;
end;$$;
create trigger member_report_capture_hidden_target after insert on private.member_reports
for each row execute function private.capture_member_report_hidden_target();
create function public.list_my_hidden_targets(p_limit integer default 20,p_before uuid default null)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();identity_key uuid;result jsonb;begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_hidden_page'using errcode='22023';end if;
 select identity_id into strict identity_key from private.member_episodes where id=episode;
 if p_before is not null and not exists(select 1 from private.member_hidden_targets where id=p_before and identity_id=identity_key)then
  raise exception 'hidden_cursor_unavailable'using errcode='PT404';end if;
 with candidates as materialized(select *from private.member_hidden_targets where identity_id=identity_key
  and(p_before is null or id>p_before)order by id limit p_limit+1),page as(select *from candidates order by id limit p_limit)
 select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('targetType',target_type,'targetId',target_id)order by id)from page),'[]'::jsonb),
  'nextCursor',case when(select count(*)from candidates)>p_limit then(select id from page order by id desc limit 1)end)into result;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'hidden_episode_conflict'using errcode='40001';end if;
 return result;
end;$$;
create function public.unhide_my_report_target(p_target_type text,p_target_id uuid)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare episode uuid:=private.require_member_decision_notice_episode();identity_key uuid;begin
 if p_target_type is null or p_target_type not in('post','chat','appointment','member','event')or p_target_id is null
  or p_target_id='00000000-0000-0000-0000-000000000000'::uuid then raise exception 'invalid_hidden_target'using errcode='22023';end if;
 select identity_id into strict identity_key from private.member_episodes where id=episode;
 delete from private.member_hidden_targets where identity_id=identity_key and target_type=p_target_type and target_id=p_target_id;
 if private.require_member_decision_notice_episode()is distinct from episode then raise exception 'hidden_episode_conflict'using errcode='40001';end if;
 return jsonb_build_object('targetType',p_target_type,'targetId',p_target_id,'hidden',false);
end;$$;
do $$declare own text;f regprocedure;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='private.require_member_decision_notice_episode()'::regprocedure;
 if own in('anon','authenticated','service_role','authenticator')then raise exception 'hidden_owner_incompatible'using errcode='55000';end if;
 execute format('alter table private.member_hidden_targets owner to %I',own);
 foreach f in array array['private.capture_member_report_hidden_target()'::regprocedure,'public.list_my_hidden_targets(integer,uuid)'::regprocedure,'public.unhide_my_report_target(text,uuid)'::regprocedure]loop
  execute format('alter function %s owner to %I',f,own);
  execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator',f);
 end loop;
end;$$;
grant execute on function public.list_my_hidden_targets(integer,uuid),public.unhide_my_report_target(text,uuid)to authenticated;
commit;
