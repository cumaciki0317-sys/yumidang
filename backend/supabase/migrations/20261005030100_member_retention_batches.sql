-- 민규 독립 초안: source56 schema-only 기준. 운영/native DB 미적용.
-- 종결 receipt는 실제 owner workflow가 모든 관련 절차를 검증한 뒤 제공한다.
-- 현재시각으로 절차 종료를 합성하지 않는다. 서비스/직원 원문 접근 권한을 열지 않는다.
begin;
alter table private.conversation_retention add column last_activity_at timestamptz;
alter table private.conversation_retention add column purged_at timestamptz;
alter table private.conversation_retention add column last_purged_at timestamptz;
alter table private.conversation_retention add column active_generation bigint not null default 1;
alter table private.conversation_retention add column header_redacted boolean not null default false;
create table private.member_retention_closures(
 receipt_id uuid primary key,
 post_id uuid not null references public.posts(id),
 request_id uuid references public.join_requests(id),
 generation bigint,
 final_closed_at timestamptz not null,
 source_sha256 text not null check(source_sha256~'^[a-f0-9]{64}$'),
 metadata_sha256 text not null check(metadata_sha256~'^[a-f0-9]{64}$'),
 recorded_at timestamptz not null default clock_timestamp()
);
-- 같은 종결 자료를 새 client receipt UUID로 바꾸어 보관 시각을 연장하지 않는다.
create unique index member_retention_closure_metadata_key on private.member_retention_closures
 (post_id,coalesce(request_id,'00000000-0000-0000-0000-000000000000'::uuid),coalesce(generation,0),metadata_sha256);
create unique index member_retention_closure_source_key on private.member_retention_closures
 (post_id,coalesce(request_id,'00000000-0000-0000-0000-000000000000'::uuid),source_sha256);
alter table private.conversation_retention add column closure_receipt_id uuid references private.member_retention_closures(receipt_id);
alter table private.retired_post_retention add column closure_receipt_id uuid references private.member_retention_closures(receipt_id);
-- chat 삭제 뒤에도 기존 신고가 어떤 공고의 관련 절차였는지 UUID만 유지한다.
create table private.member_retention_report_links(
 post_id uuid not null references public.posts(id),
 report_id uuid not null references private.member_reports(id) on delete cascade,
 primary key(post_id,report_id)
);
create index member_reports_retention_target on private.member_reports(target_type,target_id);

create function private.retention_related_reports(p_post_id uuid)
returns table(report_id uuid) language sql stable security definer set search_path='' as $$
 select r.id from private.member_reports r where
 (r.target_type='post' and r.target_id=p_post_id) or
 (r.target_type='appointment' and exists(select 1 from public.appointments a where a.post_id=p_post_id and a.id=r.target_id)) or
 (r.target_type='chat' and exists(select 1 from public.chat_messages m join public.join_requests j on j.id=m.join_request_id where j.post_id=p_post_id and m.id=r.target_id)) or
 (r.target_type='member' and exists(select 1 from public.posts p left join public.join_requests j on j.post_id=p.id where p.id=p_post_id and r.target_id in(p.author_id,j.requester_id))) or
 exists(select 1 from private.member_retention_report_links l where l.post_id=p_post_id and l.report_id=r.id);
$$;
create function private.link_retention_report_context()
returns trigger language plpgsql volatile security definer set search_path='' as $$
begin
 -- 최초 대상 검사와 INSERT 사이에 정리가 commit되었으면 삭제된 chat를 다시 접수하지 않는다.
 if auth.role()='authenticated' and not private.report_target_allowed(new.target_type,new.target_id,auth.uid()) then
   raise exception 'report_target_unavailable' using errcode='PT404';end if;
 insert into private.member_retention_report_links(post_id,report_id)
 select p.id,new.id from public.posts p where
 (new.target_type='post' and p.id=new.target_id) or
 (new.target_type='appointment' and exists(select 1 from public.appointments a where a.post_id=p.id and a.id=new.target_id)) or
 (new.target_type='chat' and exists(select 1 from public.chat_messages m join public.join_requests j on j.id=m.join_request_id where j.post_id=p.id and m.id=new.target_id)) or
 (new.target_type='member' and (p.author_id=new.target_id or exists(select 1 from public.join_requests j where j.post_id=p.id and j.requester_id=new.target_id)))
 on conflict do nothing;
 return new;
end; $$;
create trigger member_report_retention_context after insert or update of target_type,target_id on private.member_reports
 for each row execute function private.link_retention_report_context();
insert into private.member_retention_report_links(post_id,report_id)
 select p.id,r.report_id from public.posts p cross join lateral private.retention_related_reports(p.id) r on conflict do nothing;

-- safety 소유권 경계: core는 원문 테이블 권한을 받지 않고 UUID 존재 판정만 사용한다.
create function private.lock_retention_safety_metadata()
returns void language plpgsql volatile security definer set search_path='' as $$
declare t text;present integer:=0;owned integer:=0;begin
 select count(*),count(*)filter(where c.relowner=(select oid from pg_roles where rolname=current_user)and c.relkind='r')into present,owned
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
 and c.relname in('safety_incident_report_links','safety_incidents','safety_incident_revisions','safety_appeals');
 if present=0 then return;end if;
 if present<>4 or owned<>4 then raise exception 'retention_safety_schema_incomplete'using errcode='55000';end if;
 foreach t in array array['safety_incident_report_links','safety_incidents','safety_incident_revisions','safety_appeals']loop
  execute format('lock table private.%I in exclusive mode nowait',t);
 end loop;
exception when lock_not_available then raise exception 'state_conflict'using errcode='40001';
end; $$;
create function private.retention_safety_pending(p_report_ids uuid[],p_appointment_ids uuid[])
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare present integer;owned integer;blocked boolean;begin
 if p_report_ids is null or p_appointment_ids is null then raise exception 'invalid_retention_safety_scope'using errcode='22023';end if;
 select count(*),count(*)filter(where c.relowner=(select oid from pg_roles where rolname=current_user)and c.relkind='r')into present,owned
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
 and c.relname in('safety_incident_report_links','safety_incidents','safety_incident_revisions','safety_appeals');
 if present=0 then return false;end if;
 if present<>4 or owned<>4 then raise exception 'retention_safety_schema_incomplete'using errcode='55000';end if;
 -- static core/user raw SELECT를 열지 않는다. 실제 safety owner의 좁은 존재 판정이다.
 execute 'select exists(select 1 from private.safety_incident_report_links where report_id=any($1))
 or exists(select 1 from private.safety_appeals where appointment_id=any($2))'into blocked using p_report_ids,p_appointment_ids;
 return blocked;
end; $$;
do $$declare core_owner text;safety_owner text;present integer;owners integer;tables integer;f regprocedure;begin
 select pg_get_userbyid(proowner)into core_owner from pg_proc where oid='private.closed_conversation_retention_open(uuid)'::regprocedure;
 select count(*),count(distinct c.relowner),count(*)filter(where c.relkind='r'),min(pg_get_userbyid(c.relowner)::text)into present,owners,tables,safety_owner
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='private'
 and c.relname in('safety_incident_report_links','safety_incidents','safety_incident_revisions','safety_appeals');
 if present=0 then safety_owner:=core_owner;
 elsif present<>4 or owners<>1 or tables<>4 then raise exception 'retention_safety_schema_incomplete'using errcode='55000';end if;
 if core_owner in('anon','authenticated','service_role')or safety_owner in('anon','authenticated','service_role')then
  raise exception 'retention_safety_owner_invalid'using errcode='55000';end if;
 foreach f in array array['private.lock_retention_safety_metadata()'::regprocedure,'private.retention_safety_pending(uuid[],uuid[])'::regprocedure]loop
  execute format('alter function %s owner to %I',f,safety_owner);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  execute format('grant execute on function %s to %I',f,core_owner);
 end loop;
end; $$;

create function private.lock_member_retention_metadata()
returns void language plpgsql volatile security definer set search_path='' as $$
declare t text;begin
 -- 기다리지 않으므로 기존 row→다른 table 쓰기 순서와 역순 교착을 만들지 않는다.
 lock table public.posts,public.join_requests,public.appointments,public.appointment_disputes,
 public.chat_messages,private.member_reports,private.member_retention_report_links,
 private.conversation_retention,private.retired_post_retention,private.retired_post_bodies,
 private.retired_consent_bodies,private.member_retention_closures,private.conversation_retention_generations,
 private.conversation_message_generations,private.conversation_generation_appointments in exclusive mode nowait;
 perform private.lock_retention_safety_metadata();
exception when lock_not_available then raise exception 'state_conflict' using errcode='40001';
end; $$;

create function private.member_retention_state(p_post_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare snapshot jsonb;blocked boolean;safety_blocked boolean:=false;closed_at timestamptz;begin
 select exists(select 1 from public.appointments a where a.post_id=p_post_id and
   (a.status in('confirmed','disputed') or a.review_deadline_at>clock_timestamp() or a.dispute_deadline_at>clock_timestamp()))
 or exists(select 1 from public.appointment_disputes d join public.appointments a on a.id=d.appointment_id where a.post_id=p_post_id and d.status='open')
 or exists(select 1 from private.member_reports r join private.retention_related_reports(p_post_id) x on x.report_id=r.id
   where r.status<>'resolved' or r.final_closed_at is null) into blocked;
 -- 최종 운영 종결 workflow가 없는 제재/이의는 단순 resolved 상태로 삭제를 승인하지 않는다.
 safety_blocked:=private.retention_safety_pending(
  array(select report_id from private.retention_related_reports(p_post_id)),
  array(select a.id from public.appointments a where a.post_id=p_post_id));
 select greatest(
  (select max(greatest(a.updated_at,a.completed_at,a.review_deadline_at,a.dispute_deadline_at)) from public.appointments a where a.post_id=p_post_id),
  (select max(d.resolved_at) from public.appointment_disputes d join public.appointments a on a.id=d.appointment_id where a.post_id=p_post_id),
  (select max(r.final_closed_at) from private.member_reports r join private.retention_related_reports(p_post_id)x on x.report_id=r.id)) into closed_at;
 select jsonb_build_object('post',(select jsonb_build_array(p.id,p.status,p.updated_at)from public.posts p where p.id=p_post_id),
 'requests',coalesce((select jsonb_agg(jsonb_build_array(j.id,j.status,case when c.purged_at is not null then c.last_activity_at else
   greatest(j.created_at,j.updated_at,(select max(m.created_at)from public.chat_messages m where m.join_request_id=j.id))end)order by j.id)
   from public.join_requests j left join private.conversation_retention c on c.request_id=j.id where j.post_id=p_post_id),'[]'::jsonb),
 'appointments',coalesce((select jsonb_agg(jsonb_build_array(a.id,a.status,a.updated_at,a.completed_at,a.review_deadline_at,a.dispute_deadline_at)order by a.id)from public.appointments a where a.post_id=p_post_id),'[]'::jsonb),
 'disputes',coalesce((select jsonb_agg(jsonb_build_array(d.appointment_id,d.status,d.raised_at,d.resolved_at)order by d.appointment_id)from public.appointment_disputes d join public.appointments a on a.id=d.appointment_id where a.post_id=p_post_id),'[]'::jsonb),
 'reports',coalesce((select jsonb_agg(jsonb_build_array(r.id,r.status,r.updated_at,r.final_closed_at)order by r.id)from private.member_reports r join private.retention_related_reports(p_post_id)x on x.report_id=r.id),'[]'::jsonb)) into snapshot;
 return jsonb_build_object('blocked',blocked or safety_blocked,'latestClosedAt',closed_at,
 'metadataSha256',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
end; $$;

create function private.member_retention_request_terminal(p_request_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select j.status in('withdrawn','declined','not_selected') or
   (j.status='matched' and exists(select 1 from public.appointments a where a.join_request_id=j.id and a.status in('completed','cancelled','no_show'))
    and not exists(select 1 from public.appointments a where a.join_request_id=j.id and a.status in('confirmed','disputed')))
 from public.join_requests j where j.id=p_request_id),false);
$$;
-- 공개 메시지 테이블/DTO는 유지하고 private UUID 맵으로 삭제 범위를 분리한다.
create table private.conversation_retention_generations(
 request_id uuid not null references public.join_requests(id) on delete cascade,
 generation bigint not null check(generation>0),
 opened_at timestamptz not null, sealed_at timestamptz, terminal_status text,
 last_activity_at timestamptz not null, procedure_closed_at timestamptz,
 purge_after timestamptz, read_until timestamptz, purged_at timestamptz,
 closure_receipt_id uuid references private.member_retention_closures(receipt_id),
 archived_header text,
 primary key(request_id,generation)
);
create table private.conversation_message_generations(
 message_id uuid primary key references public.chat_messages(id) on delete cascade,
 request_id uuid not null, generation bigint not null,
 foreign key(request_id,generation) references private.conversation_retention_generations(request_id,generation)
);
create table private.conversation_generation_appointments(
 appointment_id uuid primary key references public.appointments(id) on delete cascade,
 request_id uuid not null, generation bigint not null,
 foreign key(request_id,generation) references private.conversation_retention_generations(request_id,generation)
);
-- 20세대 batch마다 전체 메시지 맵을 반복 스캔하지 않는다.
create index conversation_message_generation_scope on private.conversation_message_generations(request_id,generation,message_id);
create index conversation_appointment_generation_scope on private.conversation_generation_appointments(request_id,generation,appointment_id);
create index conversation_generation_due on private.conversation_retention_generations(purge_after,request_id,generation)where purged_at is null;
insert into private.conversation_retention_generations(request_id,generation,opened_at,terminal_status,last_activity_at,procedure_closed_at,purge_after,read_until)
 select j.id,1,j.created_at,j.status,greatest(j.created_at,j.updated_at,(select max(m.created_at)from public.chat_messages m where m.join_request_id=j.id)),c.procedure_closed_at,c.purge_after,c.purge_after
 from public.join_requests j left join private.conversation_retention c on c.request_id=j.id;
insert into private.conversation_message_generations select id,join_request_id,1 from public.chat_messages;
insert into private.conversation_generation_appointments select id,join_request_id,1 from public.appointments;
create function private.track_conversation_retention_generation()
returns trigger language plpgsql volatile security definer set search_path='' as $$
declare g bigint;v private.conversation_retention_generations;begin
 if tg_table_name='join_requests' then
  if tg_op='INSERT' then
   insert into private.conversation_retention_generations(request_id,generation,opened_at,terminal_status,last_activity_at)
    values(new.id,1,new.created_at,new.status,greatest(new.created_at,new.updated_at));return new;
  end if;
  select * into v from private.conversation_retention_generations where request_id=new.id order by generation desc limit 1 for update;
  if old.status in('withdrawn','not_selected') and new.status='pending' then
   if v.purged_at is not null or v.read_until<=clock_timestamp() then
    -- 이미 만료된 원문만 이전 세대로 남긴다. 새 활동으로 삭제 기한을 초기화하지 않는다.
    update private.conversation_retention_generations set sealed_at=clock_timestamp(),terminal_status=old.status,
     archived_header=case when v.generation=1 then old.message else archived_header end where request_id=new.id and generation=v.generation;
    insert into private.conversation_retention_generations(request_id,generation,opened_at,terminal_status,last_activity_at)
     values(new.id,v.generation+1,clock_timestamp(),new.status,new.updated_at);
    update public.join_requests set message='보관 기간이 종료된 대화입니다.' where id=new.id;
    update private.conversation_retention set active_generation=v.generation+1,header_redacted=true,
     last_purged_at=coalesce(purged_at,last_purged_at),purged_at=null,last_activity_at=null,
     procedure_closed_at=null,purge_after=null,closure_receipt_id=null where request_id=new.id;
   else
    -- 아직 유효한 대화는 같은 세대를 유지한다. 실제 활동 앵커만 갱신한다.
    update private.conversation_retention_generations set terminal_status=new.status,last_activity_at=greatest(last_activity_at,new.updated_at),
     procedure_closed_at=null,purge_after=null,read_until=null,closure_receipt_id=null where request_id=new.id and generation=v.generation;
    update private.conversation_retention set procedure_closed_at=null,purge_after=null,closure_receipt_id=null where request_id=new.id;
   end if;
  else
   update private.conversation_retention_generations set terminal_status=new.status,last_activity_at=greatest(last_activity_at,new.updated_at)
    where request_id=new.id and generation=v.generation;
  end if;
 elsif tg_table_name='chat_messages' then
  select generation into g from private.conversation_retention_generations where request_id=new.join_request_id order by generation desc limit 1 for update;
  insert into private.conversation_message_generations values(new.id,new.join_request_id,g);
  -- 종료/만료 원문을 직접 INSERT로 되살리지는 않는다. 정상 활성 세대의 실제 메시지는 활동이다.
  update private.conversation_retention_generations set last_activity_at=greatest(last_activity_at,new.created_at),
   purge_after=case when procedure_closed_at is null then null else greatest(last_activity_at,new.created_at,procedure_closed_at)+interval '1 year' end
   where request_id=new.join_request_id and generation=g and purged_at is null and (read_until is null or read_until>clock_timestamp());
 else
  select generation into g from private.conversation_retention_generations where request_id=new.join_request_id order by generation desc limit 1;
  insert into private.conversation_generation_appointments values(new.id,new.join_request_id,g);
 end if;
 return new;
end; $$;
create trigger conversation_generation_request after insert or update of status on public.join_requests for each row execute function private.track_conversation_retention_generation();
create trigger conversation_generation_message after insert on public.chat_messages for each row execute function private.track_conversation_retention_generation();
create trigger conversation_generation_appointment after insert on public.appointments for each row execute function private.track_conversation_retention_generation();

create function private.conversation_generation_state(p_request_id uuid,p_generation bigint)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v private.conversation_retention_generations;pid uuid;snapshot jsonb;blocked boolean;safety boolean:=false;closed_at timestamptz;begin
 select * into v from private.conversation_retention_generations where request_id=p_request_id and generation=p_generation;
 select post_id into pid from public.join_requests where id=p_request_id;
 select exists(select 1 from public.appointments a join private.conversation_generation_appointments m on m.appointment_id=a.id where m.request_id=p_request_id and m.generation=p_generation
  and(a.status in('confirmed','disputed') or a.review_deadline_at>clock_timestamp() or a.dispute_deadline_at>clock_timestamp()))
 or exists(select 1 from public.appointment_disputes d join private.conversation_generation_appointments m on m.appointment_id=d.appointment_id where m.request_id=p_request_id and m.generation=p_generation and d.status='open')
 or exists(select 1 from private.member_reports r join private.retention_related_reports(pid)x on x.report_id=r.id where r.status<>'resolved' or r.final_closed_at is null) into blocked;
 safety:=private.retention_safety_pending(
  array(select report_id from private.retention_related_reports(pid)),
  array(select appointment_id from private.conversation_generation_appointments where request_id=p_request_id and generation=p_generation));
 select greatest((select max(greatest(a.updated_at,a.completed_at,a.review_deadline_at,a.dispute_deadline_at))from public.appointments a join private.conversation_generation_appointments m on m.appointment_id=a.id where m.request_id=p_request_id and m.generation=p_generation),
  (select max(d.resolved_at)from public.appointment_disputes d join private.conversation_generation_appointments m on m.appointment_id=d.appointment_id where m.request_id=p_request_id and m.generation=p_generation),
  (select max(r.final_closed_at)from private.member_reports r join private.retention_related_reports(pid)x on x.report_id=r.id))into closed_at;
 snapshot:=jsonb_build_object('request',jsonb_build_array(p_request_id,p_generation,v.terminal_status,v.last_activity_at),
 'appointments',coalesce((select jsonb_agg(jsonb_build_array(a.id,a.status,a.updated_at,a.completed_at,a.review_deadline_at,a.dispute_deadline_at)order by a.id)from public.appointments a join private.conversation_generation_appointments m on m.appointment_id=a.id where m.request_id=p_request_id and m.generation=p_generation),'[]'::jsonb),
 'disputes',coalesce((select jsonb_agg(jsonb_build_array(d.appointment_id,d.status,d.raised_at,d.resolved_at)order by d.appointment_id)from public.appointment_disputes d join private.conversation_generation_appointments m on m.appointment_id=d.appointment_id where m.request_id=p_request_id and m.generation=p_generation),'[]'::jsonb),
 'reports',coalesce((select jsonb_agg(jsonb_build_array(r.id,r.status,r.updated_at,r.final_closed_at)order by r.id)from private.member_reports r join private.retention_related_reports(pid)x on x.report_id=r.id),'[]'::jsonb));
 return jsonb_build_object('blocked',blocked or safety,'latestClosedAt',closed_at,'metadataSha256',encode(sha256(convert_to(snapshot::text,'UTF8')),'hex'));
end; $$;

create function private.record_member_retention_closure(p_post_id uuid,p_request_id uuid,p_receipt_id uuid,
 p_closed_at timestamptz,p_source_sha256 text,p_worker_run_token uuid,p_generation bigint default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare state jsonb;r private.member_retention_closures;last_at timestamptz;g bigint;v private.conversation_retention_generations;begin
 perform private.assert_current_worker_run(p_worker_run_token);
 perform private.lock_member_retention_metadata();
 perform private.assert_current_worker_run(p_worker_run_token);
 if p_receipt_id is null or p_post_id is null or p_closed_at is null or not isfinite(p_closed_at)
   or p_closed_at>clock_timestamp() or p_source_sha256 is null or p_source_sha256!~'^[a-f0-9]{64}$' then
   raise exception 'invalid_procedure_closure' using errcode='22023';end if;
 if not exists(select 1 from public.posts where id=p_post_id) or (p_request_id is not null and
   not exists(select 1 from public.join_requests where id=p_request_id and post_id=p_post_id)) then
   raise exception 'retention_target_unavailable' using errcode='P0002';end if;
 if p_request_id is not null then
  select * into v from private.conversation_retention_generations where request_id=p_request_id and(p_generation is null or generation=p_generation)order by generation desc limit 1;
  g:=v.generation;
 end if;
 if p_request_id is not null and (g is null or(v.sealed_at is null and not private.member_retention_request_terminal(p_request_id)))then
   raise exception 'request_not_closed'using errcode='40001';end if;
 if (p_request_id is null and not exists(select 1 from private.retired_post_retention where post_id=p_post_id)) then
   raise exception 'retention_not_requested' using errcode='22023';end if;
 state:=case when p_request_id is null then private.member_retention_state(p_post_id)else private.conversation_generation_state(p_request_id,g)end;
 if (state->>'blocked')::boolean or p_closed_at<coalesce((state->>'latestClosedAt')::timestamptz,p_closed_at) then
   raise exception 'procedure_not_closed' using errcode='40001';end if;
 if exists(select 1 from private.member_retention_closures cv where cv.post_id=p_post_id
   and cv.request_id is not distinct from p_request_id and cv.receipt_id<>p_receipt_id
   and ((cv.generation is not distinct from g and cv.metadata_sha256=state->>'metadataSha256') or cv.source_sha256=p_source_sha256)) then
   raise exception 'state_conflict'using errcode='40001';end if;
 select * into r from private.member_retention_closures where receipt_id=p_receipt_id;
 if found then
  if row(r.post_id,r.request_id,r.generation,r.final_closed_at,r.source_sha256,r.metadata_sha256) is distinct from
    row(p_post_id,p_request_id,g,p_closed_at,p_source_sha256,state->>'metadataSha256') then
    raise exception 'state_conflict' using errcode='40001';end if;
 else
  if p_request_id is not null and v.purged_at is not null then
   raise exception 'conversation_already_purged'using errcode='40001';end if;
  insert into private.member_retention_closures(receipt_id,post_id,request_id,generation,final_closed_at,source_sha256,metadata_sha256)
   values(p_receipt_id,p_post_id,p_request_id,g,p_closed_at,p_source_sha256,state->>'metadataSha256');
 end if;
 if p_request_id is null then
  update private.retired_post_retention set closure_receipt_id=p_receipt_id where post_id=p_post_id;
 else
  insert into private.conversation_retention(request_id)values(p_request_id)on conflict do nothing;
  last_at:=v.last_activity_at;
  update private.conversation_retention_generations set procedure_closed_at=p_closed_at,
   purge_after=greatest(last_at,p_closed_at)+interval '1 year',
   read_until=case when read_until<=clock_timestamp()then read_until else greatest(last_at,p_closed_at)+interval '1 year'end,
   closure_receipt_id=p_receipt_id where request_id=p_request_id and generation=g and purged_at is null;
  update private.conversation_retention set last_activity_at=last_at,procedure_closed_at=p_closed_at,
   purge_after=greatest(last_at,p_closed_at)+interval '1 year',closure_receipt_id=p_receipt_id where request_id=p_request_id and active_generation=g and purged_at is null;
 end if;
 perform private.assert_current_worker_run(p_worker_run_token);
 return jsonb_build_object('receiptId',p_receipt_id,'recorded',true);
end; $$;

create function private.member_retention_receipt_current(p_receipt_id uuid,p_post_id uuid,p_request_id uuid,p_generation bigint default null)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare r private.member_retention_closures;s jsonb;begin
 select * into r from private.member_retention_closures where receipt_id=p_receipt_id;
 if not found or r.post_id is distinct from p_post_id or r.request_id is distinct from p_request_id then return false;end if;
 if r.generation is distinct from p_generation then return false;end if;
 s:=case when p_request_id is null then private.member_retention_state(p_post_id)else private.conversation_generation_state(p_request_id,p_generation)end;
 return not (s->>'blocked')::boolean and r.metadata_sha256=s->>'metadataSha256';
end; $$;

create function private.purge_expired_member_retention(p_worker_run_token uuid,p_limit integer default 20)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare x record;processed integer:=0;posts_removed integer:=0;consents_removed integer:=0;conversations_removed integer:=0;n timestamptz;begin
 if p_limit is null or p_limit not between 1 and 20 then raise exception 'invalid_cleanup_limit' using errcode='22023';end if;
 perform private.assert_current_worker_run(p_worker_run_token);
 perform private.lock_member_retention_metadata();
 perform private.assert_current_worker_run(p_worker_run_token);n:=clock_timestamp();
 for x in select q.* from (
   select 'post' kind,b.post_id target,b.post_id,b.retained_until due,r.closure_receipt_id receipt,null::uuid receipt_request,null::bigint generation
     from private.retired_post_bodies b join private.retired_post_retention r on r.post_id=b.post_id where b.retained_until<=n
   union all select 'consent',b.request_id,j.post_id,b.retained_until,coalesce(c.closure_receipt_id,r.closure_receipt_id),
     case when c.closure_receipt_id is not null then b.request_id else null end,case when c.closure_receipt_id is not null then c.active_generation else null end
     from private.retired_consent_bodies b join public.join_requests j on j.id=b.request_id
     left join private.retired_post_retention r on r.post_id=j.post_id left join private.conversation_retention c on c.request_id=j.id where b.retained_until<=n
   union all select 'conversation',c.request_id,j.post_id,c.purge_after,c.closure_receipt_id,c.request_id,c.generation
     from private.conversation_retention_generations c join public.join_requests j on j.id=c.request_id where c.purge_after<=n and c.purged_at is null
  ) q where private.member_retention_receipt_current(q.receipt,q.post_id,q.receipt_request,q.generation)
  order by q.due,q.kind,q.target limit p_limit loop
  exit when processed>=p_limit;
  if not private.member_retention_receipt_current(x.receipt,x.post_id,x.receipt_request,x.generation) then continue;end if;
  if x.kind='post' then delete from private.retired_post_bodies where post_id=x.target;posts_removed:=posts_removed+1;
  elsif x.kind='consent' then delete from private.retired_consent_bodies where request_id=x.target;consents_removed:=consents_removed+1;
  else
   delete from public.chat_messages where id in(select message_id from private.conversation_message_generations where request_id=x.target and generation=x.generation);
   if x.generation=1 then
    update public.join_requests set message='보관 기간이 종료된 대화입니다.' where id=x.target;
    update private.conversation_retention set header_redacted=true where request_id=x.target;
   end if;
   update private.conversation_retention_generations set purged_at=clock_timestamp(),archived_header=null where request_id=x.target and generation=x.generation;
   update private.conversation_retention set purged_at=case when active_generation=x.generation then clock_timestamp()else purged_at end,last_purged_at=clock_timestamp() where request_id=x.target;
   conversations_removed:=conversations_removed+1;
  end if;
  processed:=processed+1;
  perform private.assert_current_worker_run(p_worker_run_token);
 end loop;
 perform private.assert_current_worker_run(p_worker_run_token);
 return jsonb_build_object('processed',processed,'postBodiesRemoved',posts_removed,'consentBodiesRemoved',consents_removed,'conversationRecordsProcessed',conversations_removed);
end; $$;
-- 55의 무점유/무근거 경로는 owner라도 더 이상 실행하지 않는다.
-- 내부 RPC transport가 연결할 수 있는 좁은 포트. service_role 권한도 아직 열지 않는다.
create function public.purge_expired_member_retention(p_worker_run_token uuid,p_limit integer default 20)
returns jsonb language plpgsql volatile security definer set search_path='' as $$begin
 if auth.role() is distinct from 'service_role' then raise exception 'worker_required'using errcode='42501';end if;
 return private.purge_expired_member_retention(p_worker_run_token,p_limit);
end; $$;
create or replace function private.record_member_retention_closure(p_request_id uuid,p_closed_at timestamptz)
returns void language plpgsql volatile security definer set search_path='' as $$begin
 raise exception 'verified_closure_required' using errcode='55000';end; $$;
create or replace function private.purge_expired_member_retention()
returns jsonb language plpgsql volatile security definer set search_path='' as $$begin
 raise exception 'worker_fence_required' using errcode='55000';end; $$;
create function private.conversation_generation_visible(p_request_id uuid,p_generation bigint)
returns boolean language sql volatile security definer set search_path='' as $$
 select coalesce((select purged_at is null and(read_until is null or clock_timestamp()<read_until)
 from private.conversation_retention_generations where request_id=p_request_id and generation=p_generation),false);
$$;
create function private.conversation_message_readable(p_message_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
 select coalesce((select private.conversation_generation_visible(request_id,generation)from private.conversation_message_generations where message_id=p_message_id),false);
$$;
create function private.conversation_header_readable(p_request_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
 select coalesce((select header_redacted from private.conversation_retention where request_id=p_request_id),false)
 or private.conversation_generation_visible(p_request_id,1);
$$;
create function private.conversation_header_public(p_request_id uuid,p_original text)
returns text language sql volatile security definer set search_path='' as $$
 select case when private.conversation_generation_visible(p_request_id,1)then p_original else '보관 기간이 종료된 대화입니다.'end;
$$;
-- 기존 OID/ACL을 유지한다. 활성 새 세대만 thread 접근을 재개할 수 있다.
create or replace function private.closed_conversation_retention_open(p_request_id uuid)
returns boolean language sql volatile security definer set search_path='' as $$
 select coalesce((select private.conversation_generation_visible(request_id,generation)from private.conversation_retention_generations
 where request_id=p_request_id order by generation desc limit 1),true);
$$;
create policy conversation_retention_header on public.join_requests as restrictive for select to authenticated
 using(private.conversation_header_readable(id));
create policy conversation_retention_message on public.chat_messages as restrictive for select to authenticated
 using(private.conversation_message_readable(id));

-- SECDEF 조회에서도 native RLS와 같은 세대별 원문 cutoff를 적용한다. OUT/default는 유지한다.
CREATE OR REPLACE FUNCTION public.get_conversation(p_request_id uuid)
 RETURNS TABLE(request_id uuid, my_role text, request_status text, request_message text, request_created_at timestamp with time zone, post_id uuid, post_title text, post_starts_at timestamp with time zone, post_ends_at timestamp with time zone, post_public_area text, post_status text, counterpart_masked_name text, counterpart_avatar_url text, can_send boolean, appointment_id uuid, server_now timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  perform private.require_conversation_retention($1);
  return query select q.request_id,q.my_role,q.request_status,private.conversation_header_public(q.request_id,q.request_message),q.request_created_at,q.post_id,q.post_title,q.post_starts_at,q.post_ends_at,q.post_public_area,q.post_status,case when private.request_other_retired(q.request_id) then '탈퇴한 사용자입니다.' else q.counterpart_masked_name end,case when private.request_other_retired(q.request_id) then null else q.counterpart_avatar_url end,case when private.request_other_retired(q.request_id) then false else q.can_send end,q.appointment_id,q.server_now from private.get_conversation_before_member_retirement($1) q;
end;
$function$;
CREATE OR REPLACE FUNCTION public.list_conversations()
 RETURNS TABLE(request_id uuid, my_role text, request_status text, post_id uuid, post_title text, post_starts_at timestamp with time zone, counterpart_masked_name text, counterpart_avatar_url text, last_message text, last_message_at timestamp with time zone, last_activity_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select q.request_id,q.my_role,q.request_status,q.post_id,q.post_title,q.post_starts_at,case when private.request_other_retired(q.request_id) then '탈퇴한 사용자입니다.' else q.counterpart_masked_name end,case when private.request_other_retired(q.request_id) then null else q.counterpart_avatar_url end,m.content,m.created_at,greatest(m.created_at,g.last_activity_at) from private.list_conversations_before_member_retirement() q left join lateral(select z.content,z.created_at from public.chat_messages z where z.join_request_id=q.request_id and private.conversation_message_readable(z.id)order by z.created_at desc,z.id desc limit 1)m on true left join lateral(select v.last_activity_at from private.conversation_retention_generations v where v.request_id=q.request_id order by v.generation desc limit 1)g on true where private.closed_conversation_retention_open(q.request_id) order by greatest(m.created_at,g.last_activity_at)desc nulls last,q.request_id;
end;
$function$;
CREATE OR REPLACE FUNCTION public.list_received_join_requests()
 RETURNS TABLE(id uuid, post_id uuid, post_title text, post_starts_at timestamp with time zone, post_status text, requester_masked_name text, requester_age integer, requester_avatar_url text, message text, status text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select q.id,q.post_id,q.post_title,q.post_starts_at,q.post_status,q.requester_masked_name,q.requester_age,q.requester_avatar_url,private.conversation_header_public(q.id,q.message),q.status,q.created_at,q.updated_at from private.list_received_join_requests_before_member_retirement() q;
end;
$function$;
CREATE OR REPLACE FUNCTION public.list_sent_join_requests()
 RETURNS TABLE(id uuid, post_id uuid, post_title text, post_starts_at timestamp with time zone, post_ends_at timestamp with time zone, post_public_area text, post_status text, author_masked_name text, message text, status text, created_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_profile();
  return query select q.id,q.post_id,q.post_title,q.post_starts_at,q.post_ends_at,q.post_public_area,q.post_status,q.author_masked_name,private.conversation_header_public(q.id,q.message),q.status,q.created_at,q.updated_at from private.list_sent_join_requests_before_member_retirement() q;
end;
$function$;
create or replace function public.list_conversation_messages(p_request_id uuid,p_limit integer,p_before uuid default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=private.require_service_profile(); v_before public.chat_messages; v_result jsonb;
begin
  perform private.require_conversation_retention(p_request_id);
  if private.request_role(p_request_id) is null then raise exception 'request_unavailable' using errcode='P0002'; end if;
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_input' using errcode='22023'; end if;
  if p_before is not null then
    select * into v_before from public.chat_messages where id=p_before and join_request_id=p_request_id and private.conversation_message_readable(id);
    if not found then raise exception 'cursor_unavailable' using errcode='P0002'; end if;
  end if;
  with candidates as materialized(select * from public.chat_messages where join_request_id=p_request_id and private.conversation_message_readable(id)
    and(p_before is null or (created_at,id)<(v_before.created_at,v_before.id)) order by created_at desc,id desc limit p_limit+1),
    page as(select * from candidates order by created_at desc,id desc limit p_limit)
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object('messageId',id,'senderId',sender_id,
    'content',content,'createdAt',created_at) order by created_at desc,id desc) from page),'[]'::jsonb),
    'nextCursor',case when (select count(*) from candidates)>p_limit then(select id from page order by created_at,id limit 1) else null end)
    into v_result;
  return v_result;
end;
$$;

-- 기존 읽기 helper와 같은 owner로 맞춰 owner-only 내부 호출/RLS를 보존한다.
do $$declare own text;f regprocedure;t text;begin
 select pg_get_userbyid(proowner) into own from pg_proc where oid='private.closed_conversation_retention_open(uuid)'::regprocedure;
 execute format('alter function public.purge_expired_member_retention(uuid,integer) owner to %I',own);
 revoke all on function public.purge_expired_member_retention(uuid,integer) from public,anon,authenticated,service_role;
 foreach t in array array['member_retention_closures','member_retention_report_links','conversation_retention_generations','conversation_message_generations','conversation_generation_appointments'] loop
  execute format('alter table private.%I owner to %I',t,own);
  execute format('alter table private.%I enable row level security',t);
  execute format('revoke all on private.%I from public,anon,authenticated,service_role',t);
 end loop;
 for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private'
 and p.proname in('retention_related_reports','link_retention_report_context','lock_member_retention_metadata','member_retention_state',
 'record_member_retention_closure','member_retention_receipt_current','purge_expired_member_retention',
 'member_retention_request_terminal','track_conversation_retention_generation','conversation_generation_state','conversation_generation_visible','conversation_message_readable','conversation_header_readable','conversation_header_public') loop
  execute format('alter function %s owner to %I',f,own);
  execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
 end loop;
end; $$;
grant execute on function private.conversation_message_readable(uuid),private.conversation_header_readable(uuid)to authenticated;
commit;
