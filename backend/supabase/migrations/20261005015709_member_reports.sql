-- 민규: 신고 접수와 증거 소유권. 운영 판정/직원 권한/원본 채팅 열람은 추가하지 않는다.
begin;
create table private.member_reports (
 id uuid primary key default gen_random_uuid(), reporter_id uuid not null, reporter_episode_id uuid not null references private.member_episodes(id), client_request_id uuid not null,
 target_type text not null check(target_type in('post','chat','appointment','member','event')), target_id uuid not null,
 context text not null check(context in('online','offline')), reason_codes text[] not null,
 status text not null default 'received' check(status in('received','reviewing','more_evidence','resolved')),
 hide_target boolean not null, fingerprint text not null, created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(), final_closed_at timestamptz, retention_due_at timestamptz,
 resolution_summary text, unique(reporter_episode_id,client_request_id),
 check((final_closed_at is null and retention_due_at is null) or
   (status='resolved' and final_closed_at is not null and retention_due_at=final_closed_at+interval '2160 hours'))
);
-- 신고 자료는 회원 탈퇴시 자동 cascade하지 않는다. 종결+90일 삭제와 별도 검토한다.
create table private.member_report_details (
 report_id uuid primary key references private.member_reports(id) on delete cascade,
 description text not null check(description=btrim(description) and char_length(description) between 1 and 4000)
);
create table private.report_capture_assets (
 id uuid primary key, owner_id uuid not null, owner_episode_id uuid not null references private.member_episodes(id), object_name text not null unique,
 state text not null default 'reserved' check(state in('reserved','uploaded','attached','cancelled')),
 report_id uuid references private.member_reports(id) on delete restrict,
 created_at timestamptz not null default clock_timestamp(), uploaded_at timestamptz,
 check((state='attached')=(report_id is not null)),check((state in('uploaded','attached'))=(uploaded_at is not null))
);
create table private.report_access_audit (
 id bigint generated always as identity primary key, actor_id uuid not null,
 report_id uuid references private.member_reports(id) on delete cascade,
 asset_id uuid references private.report_capture_assets(id) on delete cascade,
 action text not null check(action in('capture_reference','storage_read','report_read')),
 happened_at timestamptz not null default clock_timestamp(),check(report_id is not null or asset_id is not null)
);
create index member_reports_owner_page on private.member_reports(reporter_episode_id,id);
create index member_reports_retention_due on private.member_reports(retention_due_at) where retention_due_at is not null;
create index report_capture_owner on private.report_capture_assets(owner_episode_id,id);
alter table private.member_reports enable row level security;
alter table private.member_report_details enable row level security;
alter table private.report_capture_assets enable row level security;
alter table private.report_access_audit enable row level security;
revoke all on private.member_reports,private.member_report_details,private.report_capture_assets,private.report_access_audit from public,anon,authenticated,service_role;
revoke all on sequence private.report_access_audit_id_seq from public,anon,authenticated,service_role;

create function private.require_report_member() returns uuid language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_member_uid();begin
 -- Naver 인증/탈퇴와 동일하게 계정→프로필→가입 회차 순서를 유지한다. 계정 없는 회원도 허용한다.
 perform 1 from private.naver_accounts where user_id=me for share;
 perform 1 from public.profiles where id=me for share;
 if not found then raise exception 'profile_required' using errcode='42501';end if;
 perform 1 from private.member_episodes where profile_id=me and ended_at is null for share;
 if not found then raise exception 'member_episode_required' using errcode='42501';end if;
 -- 안전 신고는 신규 동행 활동과 다르다. 네이버 자격 상실만으로 본인 안전 자료 접근을 막지 않는다.
 return me;
end;$$;
create function private.valid_report_reasons(p_codes text[]) returns boolean language sql immutable set search_path='' as $$
 select p_codes is not null and coalesce(array_ndims(p_codes),1)=1 and cardinality(p_codes) between 1 and 7
 and array_position(p_codes,null) is null and cardinality(p_codes)=(select count(distinct x)from unnest(p_codes)x)
 and p_codes<@array['sexual_harassment','threat','money_or_personal_data','impersonation','spam','no_show','other']::text[];
$$;
create function private.report_target_allowed(p_type text,p_target uuid,p_me uuid) returns boolean language plpgsql stable security definer set search_path='' as $$
begin
 if p_type='post' then return exists(select 1 from public.posts p where p.id=p_target and p.author_id<>p_me and
   ((p.status<>'deleted' and not private.members_blocked(p_me,p.author_id)) or
    exists(select 1 from public.join_requests r where r.post_id=p.id and r.requester_id=p_me)));
 elsif p_type='chat' then return exists(select 1 from public.chat_messages c join public.join_requests r on r.id=c.join_request_id
   join public.posts p on p.id=r.post_id where c.id=p_target and c.sender_id<>p_me and (r.requester_id=p_me or p.author_id=p_me));
 elsif p_type='appointment' then return exists(select 1 from public.appointments a join public.posts p on p.id=a.post_id
   join public.join_requests r on r.id=a.join_request_id where a.id=p_target and (p.author_id=p_me or r.requester_id=p_me));
 elsif p_type='member' then return p_target<>p_me and exists(select 1 from public.profiles where id=p_target) and
   (not private.members_blocked(p_me,p_target) or exists(select 1 from public.join_requests r join public.posts p on p.id=r.post_id
     where (p.author_id=p_me and r.requester_id=p_target)or(p.author_id=p_target and r.requester_id=p_me)));
 elsif p_type='event' then return exists(select 1 from private.events e where e.id=p_target and
   (e.source_status='active' or exists(select 1 from public.posts p
     where p.source_event_id=e.id and (p.author_id=p_me or exists(select 1 from public.join_requests r where r.post_id=p.id and r.requester_id=p_me)))));
 end if;return false;
end;$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('report-evidence','report-evidence',false,5242880,array['image/jpeg','image/png','image/webp'])
 on conflict(id)do nothing;
do $$begin
 if not exists(select 1 from storage.buckets where id='report-evidence' and not public and file_size_limit=5242880
   and allowed_mime_types=array['image/jpeg','image/png','image/webp']::text[]) then
   raise exception 'report_evidence_bucket_collision' using errcode='42501';end if;
end;$$;

create function public.reserve_report_capture(p_asset_id uuid,p_extension text)returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_report_member();a private.report_capture_assets;name text;
begin
 if p_asset_id is null or p_extension is null or p_extension not in('jpg','png','webp')then raise exception 'invalid_capture' using errcode='22023';end if;
 name:=me::text||'/'||p_asset_id::text||'.'||p_extension;
 insert into private.report_capture_assets(id,owner_id,owner_episode_id,object_name)values(p_asset_id,me,private.active_member_episode(me),name)on conflict(id)do nothing;
 select * into a from private.report_capture_assets where id=p_asset_id for update;
 if a.owner_id<>me or a.owner_episode_id<>private.active_member_episode(me) then raise exception 'capture_unavailable' using errcode='42501';end if;
 if a.report_id is not null and exists(select 1 from private.member_reports where id=a.report_id and retention_due_at<=clock_timestamp())then raise exception 'capture_unavailable' using errcode='PT404';end if;
 if a.object_name<>name or a.state='cancelled' then raise exception 'capture_conflict' using errcode='40001';end if;
 return jsonb_build_object('assetId',a.id,'bucket','report-evidence','path',a.object_name,'state',a.state);
end;$$;

create function private.report_capture_upload_allowed(p_name text,p_owner text)returns boolean language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_report_member();begin
 return p_owner=me::text and exists(select 1 from private.report_capture_assets where owner_id=me and owner_episode_id=private.active_member_episode(me) and object_name=p_name and state='reserved');
end;$$;
create function private.report_capture_read_allowed(p_name text,p_owner text)returns boolean language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_report_member();a private.report_capture_assets;begin
 select * into a from private.report_capture_assets where object_name=p_name and owner_id=me and owner_episode_id=private.active_member_episode(me) and state in('reserved','uploaded','attached','cancelled');
 if not found or p_owner<>me::text or(a.report_id is not null and exists(select 1 from private.member_reports r
   where r.id=a.report_id and r.retention_due_at<=clock_timestamp()))then return false;end if;
 insert into private.report_access_audit(actor_id,report_id,asset_id,action)values(me,a.report_id,a.id,'storage_read');return true;
end;$$;
create function private.report_capture_delete_allowed(p_name text,p_owner text)returns boolean language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_report_member();begin
 return p_owner=me::text and exists(select 1 from private.report_capture_assets where owner_id=me and owner_episode_id=private.active_member_episode(me) and object_name=p_name and state='cancelled');
end;$$;
create policy report_capture_owner_insert on storage.objects for insert to authenticated
 with check(bucket_id='report-evidence' and private.report_capture_upload_allowed(name,owner_id));
-- 실제 Storage INSERT RETURNING에 필요한 본인 reserved 행 SELECT도 허용한다. 확인/접수 완료 의미는 아니다.
create policy report_capture_owner_read on storage.objects for select to authenticated
 using(bucket_id='report-evidence' and private.report_capture_read_allowed(name,owner_id));
-- 신고에 제출한 증거는 소유자가 덮어쓰거나 임의 삭제하지 않는다. UPDATE policy를 만들지 않는다.
create policy report_capture_owner_cancel_delete on storage.objects for delete to authenticated
 using(bucket_id='report-evidence' and private.report_capture_delete_allowed(name,owner_id));

create function public.confirm_report_capture(p_asset_id uuid)returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_report_member();a private.report_capture_assets;o storage.objects;mime text;size numeric;
begin
 select * into a from private.report_capture_assets where id=p_asset_id for update;
 if not found or a.owner_id<>me or a.owner_episode_id<>private.active_member_episode(me) then raise exception 'capture_unavailable' using errcode='42501';end if;
 if a.report_id is not null and exists(select 1 from private.member_reports where id=a.report_id and retention_due_at<=clock_timestamp())then raise exception 'capture_unavailable' using errcode='PT404';end if;
 if a.state='cancelled' then raise exception 'capture_conflict' using errcode='40001';end if;
 select * into o from storage.objects where bucket_id='report-evidence' and name=a.object_name for share;
 if not found or o.owner_id<>me::text then raise exception 'capture_not_uploaded' using errcode='42501';end if;
 mime:=o.metadata->>'mimetype';
 if mime not in('image/jpeg','image/png','image/webp')or mime is null or
    mime<>(case when a.object_name like '%.jpg'then'image/jpeg'when a.object_name like '%.png'then'image/png'else'image/webp'end) or
    jsonb_typeof(o.metadata->'size')is distinct from'number' then raise exception 'invalid_capture_metadata' using errcode='22023';end if;
 size:=(o.metadata->>'size')::numeric;
 if size<=0 or size>5242880 or size<>trunc(size)then raise exception 'invalid_capture_metadata' using errcode='22023';end if;
 if a.state='reserved'then update private.report_capture_assets set state='uploaded',uploaded_at=clock_timestamp()where id=a.id;end if;
 insert into private.report_access_audit(actor_id,report_id,asset_id,action)values(me,a.report_id,a.id,'capture_reference');
 return jsonb_build_object('assetId',a.id,'state',case when a.state='attached'then'attached'else'uploaded'end);
end;$$;
create function public.cancel_report_capture(p_asset_id uuid)returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_report_member();a private.report_capture_assets;begin
 select * into a from private.report_capture_assets where id=p_asset_id for update;
 if not found or a.owner_id<>me or a.owner_episode_id<>private.active_member_episode(me) then raise exception 'capture_unavailable' using errcode='42501';end if;
 if a.state='attached'then raise exception 'capture_already_submitted' using errcode='40001';end if;
 update private.report_capture_assets set state='cancelled',uploaded_at=null where id=a.id;
 return jsonb_build_object('assetId',a.id,'state','cancelled','storageDeletionRequired',exists(select 1 from storage.objects where bucket_id='report-evidence'and name=a.object_name));
end;$$;

create function public.submit_member_report(p_client_request_id uuid,p_target_type text,p_target_id uuid,p_context text,
 p_reason_codes text[],p_description text,p_asset_ids uuid[],p_hide_target boolean)returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_report_member();r private.member_reports;a private.report_capture_assets;v_assets uuid[];v_reasons text[];v_hash text;v_id uuid;
begin
 if p_client_request_id is null or p_target_id is null or p_target_type is null or p_target_type not in('post','chat','appointment','member','event')or
 p_context is null or p_context not in('online','offline')or(p_target_type in('post','chat','event')and p_context<>'online')or
 (p_target_type='appointment'and p_context<>'offline')or not private.valid_report_reasons(p_reason_codes)or
 p_description is null or p_description<>btrim(p_description)or char_length(p_description)not between 1 and 4000 or
 p_description~'[\x00-\x08\x0b\x0c\x0e-\x1f]'or p_hide_target is null or p_asset_ids is null or
 coalesce(array_ndims(p_asset_ids),1)<>1 or cardinality(p_asset_ids)>5 or array_position(p_asset_ids,null)is not null or
 cardinality(p_asset_ids)<>(select count(distinct x)from unnest(p_asset_ids)x)or(p_context='online'and cardinality(p_asset_ids)=0)then
 raise exception 'invalid_report' using errcode='22023';end if;
 select array_agg(x order by x)into v_assets from unnest(p_asset_ids)x;v_assets:=coalesce(v_assets,'{}'::uuid[]);
 select array_agg(x order by x)into v_reasons from unnest(p_reason_codes)x;
 v_hash:=encode(sha256(convert_to(jsonb_build_array(p_target_type,p_target_id,p_context,v_reasons,p_description,v_assets,p_hide_target)::text,'UTF8')),'hex');
 -- 동일 가입 회차/클라이언트 키를 직렬화하며 성공 재시도는 자료 재첨부·중복 숨김을 만들지 않는다.
 perform pg_advisory_xact_lock(hashtextextended(private.active_member_episode(me)::text||':'||p_client_request_id::text,551));
 select * into r from private.member_reports where reporter_id=me and reporter_episode_id=private.active_member_episode(me) and client_request_id=p_client_request_id;
 if found then
   if r.retention_due_at<=clock_timestamp()then raise exception 'report_unavailable' using errcode='PT404';end if;
   if r.fingerprint<>v_hash then raise exception 'report_idempotency_conflict' using errcode='40001';end if;
   return jsonb_build_object('reportId',r.id,'status',r.status,'alreadySubmitted',true,'hideTarget',r.hide_target);
 end if;
 if not private.report_target_allowed(p_target_type,p_target_id,me)then raise exception 'report_target_unavailable' using errcode='PT404';end if;
 -- 여러 첨부는 UUID 순서로 잠가 동시 접수/취소에서 잠금 역전을 막는다.
 for v_id in select unnest(v_assets)order by 1 loop
   select * into a from private.report_capture_assets where id=v_id for update;
   if not found or a.owner_id<>me or a.owner_episode_id<>private.active_member_episode(me) then raise exception 'capture_unavailable' using errcode='42501';end if;
   if a.state<>'uploaded'then raise exception 'capture_conflict' using errcode='40001';end if;
   perform public.confirm_report_capture(a.id);
 end loop;
 insert into private.member_reports(reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,hide_target,fingerprint)
 values(me,private.active_member_episode(me),p_client_request_id,p_target_type,p_target_id,p_context,v_reasons,p_hide_target,v_hash)returning * into r;
 insert into private.member_report_details(report_id,description)values(r.id,p_description);
 update private.report_capture_assets set state='attached',report_id=r.id where id=any(v_assets);
 return jsonb_build_object('reportId',r.id,'status',r.status,'alreadySubmitted',false,'hideTarget',r.hide_target);
end;$$;

create function public.list_my_reports(p_limit integer default 20,p_before uuid default null)returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_report_member();items jsonb;cursor_id uuid;begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_report_page' using errcode='22023';end if;
 with candidates as materialized(select * from private.member_reports where reporter_id=me and reporter_episode_id=private.active_member_episode(me) and(p_before is null or id>p_before)
   and(retention_due_at is null or retention_due_at>clock_timestamp())order by id limit p_limit+1),page as(select * from candidates order by id limit p_limit)
 select coalesce((select jsonb_agg(jsonb_build_object('reportId',id,'targetType',target_type,'targetId',target_id,'context',context,
   'reasonCodes',reason_codes,'status',status,'hideTarget',hide_target,'createdAt',created_at,'updatedAt',updated_at)order by id)from page),'[]'::jsonb),
 case when(select count(*)from candidates)>p_limit then(select id from page order by id desc limit 1)else null end into items,cursor_id;
 insert into private.report_access_audit(actor_id,report_id,action)select me,(x->>'reportId')::uuid,'report_read'from jsonb_array_elements(items)x;
 return jsonb_build_object('items',items,'nextCursor',cursor_id);
end;$$;
create function public.get_my_report(p_report_id uuid)returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_report_member();r private.member_reports;v_description text;assets jsonb;begin
 select * into r from private.member_reports where id=p_report_id and reporter_id=me and reporter_episode_id=private.active_member_episode(me) and(retention_due_at is null or retention_due_at>clock_timestamp());
 if not found then raise exception 'report_unavailable' using errcode='PT404';end if;
 select description into v_description from private.member_report_details where report_id=r.id;
 select coalesce(jsonb_agg(id order by id),'[]'::jsonb)into assets from private.report_capture_assets where report_id=r.id;
 insert into private.report_access_audit(actor_id,report_id,action)values(me,r.id,'report_read');
 return jsonb_build_object('reportId',r.id,'targetType',r.target_type,'targetId',r.target_id,'context',r.context,'reasonCodes',r.reason_codes,
 'description',v_description,'assetIds',assets,'status',r.status,'hideTarget',r.hide_target,'createdAt',r.created_at,'updatedAt',r.updated_at,
 'resolutionSummary',r.resolution_summary,'finalClosedAt',r.final_closed_at,'retentionDueAt',r.retention_due_at);
end;$$;

-- 운영 담당/승인 책임자 배정이 아직 없다. 운영 열람/상태 변경/종결 RPC 또는 역할을 만들지 않는다.
-- 내부 삭제 대상 조회 기반만 제공한다. Storage 실제 파일 삭제/백업 파기는 별도 연결 후 검증한다.
create view private.report_retention_candidates with(security_invoker=true)as
 select r.id report_id,r.final_closed_at,r.retention_due_at,a.id asset_id,a.object_name
 from private.member_reports r left join private.report_capture_assets a on a.report_id=r.id
 where r.status='resolved'and r.final_closed_at is not null and r.retention_due_at<=clock_timestamp();
revoke all on private.report_retention_candidates from public,anon,authenticated,service_role;
revoke all on function private.require_report_member(),private.valid_report_reasons(text[]),private.report_target_allowed(text,uuid,uuid),
 private.report_capture_upload_allowed(text,text),private.report_capture_read_allowed(text,text),private.report_capture_delete_allowed(text,text)
 from public,anon,authenticated,service_role;
grant execute on function private.report_capture_upload_allowed(text,text),private.report_capture_read_allowed(text,text),private.report_capture_delete_allowed(text,text)to authenticated;
revoke all on function public.reserve_report_capture(uuid,text),public.confirm_report_capture(uuid),public.cancel_report_capture(uuid),
 public.submit_member_report(uuid,text,uuid,text,text[],text,uuid[],boolean),public.list_my_reports(integer,uuid),public.get_my_report(uuid)
 from public,anon,authenticated,service_role;
grant execute on function public.reserve_report_capture(uuid,text),public.confirm_report_capture(uuid),public.cancel_report_capture(uuid),
 public.submit_member_report(uuid,text,uuid,text,text[],text,uuid[],boolean),public.list_my_reports(integer,uuid),public.get_my_report(uuid)to authenticated;
commit;
