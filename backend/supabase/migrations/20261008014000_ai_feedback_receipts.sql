-- 민규: 원문 없는 AI 결과 증거, 평가 멱등 접수, 최소 신고 첨부.
-- 회원 원문 외부 전송/운영 활성화/과거 결과 성공 추정 없음.
begin;
create table private.ai_result_receipts(
 request_id uuid primary key references private.ai_chat_requests(request_id)on delete cascade,
 user_id uuid not null references public.profiles(id)on delete cascade,
 available_at timestamptz not null default clock_timestamp()
);
create table private.ai_feedback_receipts(
 feedback_id uuid primary key default gen_random_uuid(),user_id uuid not null,
 client_hash text not null,fingerprint text not null,request_id uuid not null,
 action text not null check(action in('helpful','report')),
 report_id uuid references private.member_reports(id)on delete set null,
 accepted_at timestamptz not null default clock_timestamp(),unique(user_id,client_hash),
 check(action='report'or report_id is null)
);
create table private.ai_report_handling_control(singleton boolean primary key check(singleton),enabled boolean not null default false);
insert into private.ai_report_handling_control values(true,false);
alter table private.ai_result_receipts enable row level security;
alter table private.ai_feedback_receipts enable row level security;
alter table private.ai_report_handling_control enable row level security;
revoke all on private.ai_result_receipts,private.ai_feedback_receipts,private.ai_report_handling_control from public,anon,authenticated,service_role;
-- AI 대상은 전용 접수만 생성하며 회원 제재 대상이 아니다.
alter table private.member_reports drop constraint member_reports_target_type_check;
alter table private.member_reports add constraint member_reports_target_type_check check(target_type in('post','chat','appointment','member','event','ai_answer'));
create function public.record_ai_chat_result_available(p_user_id uuid,p_request_id uuid,p_lease_token uuid)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare r private.ai_chat_requests;stamp timestamptz;begin
 if p_user_id is null or p_request_id is null or p_lease_token is null then raise exception 'invalid_ai_result_scope'using errcode='22023';end if;
 perform 1 from private.ai_member_processing where user_id=p_user_id and active_request_id=p_request_id for update;
 if not found then raise exception 'ai_request_lease_lost'using errcode='40001';end if;
 select *into r from private.ai_chat_requests where request_id=p_request_id for update;
 if r.request_id is null or r.user_id<>p_user_id or r.lease_token<>p_lease_token or r.outcome is not null or r.expires_at<=clock_timestamp()
 or private.profile_retired(p_user_id)then raise exception 'ai_request_lease_lost'using errcode='40001';end if;
 insert into private.ai_result_receipts(request_id,user_id)values(p_request_id,p_user_id)on conflict do nothing;
 select available_at into stamp from private.ai_result_receipts where request_id=p_request_id;
 return jsonb_build_object('requestId',p_request_id,'availableAt',stamp);
end;$$;
create function public.get_ai_feedback_readiness()returns jsonb
language sql stable security definer set search_path=''as $$
 select jsonb_build_object('contractVersion','2026-10-05','helpfulReady',true,'reportReady',enabled)from private.ai_report_handling_control where singleton;
$$;
create function public.submit_ai_feedback(p_user_id uuid,p_request_id uuid,p_client_request_id text,p_action text,p_attachment jsonb,p_contract_version text)returns jsonb
language plpgsql volatile security definer set search_path=''as $$
declare r private.ai_chat_requests;prior private.ai_feedback_receipts;episode uuid;hash text;key_hash text;stamp timestamptz;
 fid uuid:=gen_random_uuid();rid uuid;asset private.report_capture_assets;o storage.objects;description text;kind text;begin
 if p_user_id is null or p_request_id is null or p_client_request_id is null or btrim(p_client_request_id)=''or length(p_client_request_id)>128
 or p_action is null or p_action not in('helpful','report')or p_contract_version is distinct from'2026-10-05'then raise exception 'invalid_ai_feedback'using errcode='22023';end if;
 if p_action='helpful'and p_attachment is not null then raise exception 'invalid_ai_attachment'using errcode='22023';end if;
 if p_action='report'then
 if jsonb_typeof(p_attachment)is distinct from'object'then raise exception 'invalid_ai_attachment'using errcode='22023';end if;
 kind:=p_attachment->>'kind';
 if kind='answer'then
 if p_attachment-array['kind','text']<>'{}'::jsonb or not(p_attachment?&array['kind','text'])or jsonb_typeof(p_attachment->'text')is distinct from'string'
 or length(btrim(p_attachment->>'text'))not between 1 and 500 then raise exception 'invalid_ai_attachment'using errcode='22023';end if;
 description:=btrim(p_attachment->>'text');
 elsif kind='capture'then
 if p_attachment-array['kind','assetId']<>'{}'::jsonb or not(p_attachment?&array['kind','assetId'])or jsonb_typeof(p_attachment->'assetId')is distinct from'string'
 or p_attachment->>'assetId'!~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'then raise exception 'invalid_ai_attachment'using errcode='22023';end if;
 description:='회원이 확인해 제출한 AI 답변 캡처';
 else raise exception 'invalid_ai_attachment'using errcode='22023';end if;
 end if;
 -- 탈퇴와 동일한 회차 행을 잠근다. 신원은 내부 HTTP가 검증한 JWT에서만 전달된다.
 select id into episode from private.member_episodes where profile_id=p_user_id and ended_at is null for share;
 if episode is null or private.profile_retired(p_user_id)then raise exception 'member_unavailable'using errcode='28000';end if;
 key_hash:=encode(sha256(convert_to(p_client_request_id,'UTF8')),'hex');
 hash:=encode(sha256(convert_to(jsonb_build_array(p_request_id,p_action,p_attachment,p_contract_version)::text,'UTF8')),'hex');
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||':'||key_hash,801400));
 select *into prior from private.ai_feedback_receipts where user_id=p_user_id and client_hash=key_hash;
 if prior.feedback_id is not null then
 if prior.fingerprint<>hash then return jsonb_build_object('status','idempotency_conflict');end if;
 if prior.action='helpful'and prior.accepted_at+interval'2160 hours'<=clock_timestamp()then raise exception 'feedback_expired'using errcode='PT404';end if;
 if prior.action='report'and not exists(select 1 from private.member_reports where id=prior.report_id and(retention_due_at is null or retention_due_at>clock_timestamp()))then raise exception 'feedback_expired'using errcode='PT404';end if;
 return jsonb_build_object('status','accepted','feedbackId',prior.feedback_id,'hideAnswer',prior.action='report');
 end if;
 select *into r from private.ai_chat_requests where request_id=p_request_id for share;
 if r.request_id is null or r.user_id<>p_user_id then return jsonb_build_object('status','request_not_owned');end if;
 select available_at into stamp from private.ai_result_receipts where request_id=p_request_id and user_id=p_user_id;
 if stamp is null or(p_action='helpful'and stamp+interval'2160 hours'<=clock_timestamp())or r.outcome is distinct from'finished'then raise exception 'ai_result_unavailable'using errcode='PT404';end if;
 if p_action='report'then
 perform 1 from private.ai_report_handling_control where singleton and enabled for share;
 if not found then raise exception 'ai_report_handling_not_ready'using errcode='PT503';end if;
 if kind='capture'then
 select *into asset from private.report_capture_assets where id=(p_attachment->>'assetId')::uuid for update;
 if asset.id is null or asset.owner_id<>p_user_id or asset.owner_episode_id<>episode or asset.state<>'uploaded'then return jsonb_build_object('status','asset_not_owned');end if;
 select *into o from storage.objects where bucket_id='report-evidence'and name=asset.object_name for share;
 if o.id is null or o.owner_id<>p_user_id::text or o.metadata->>'mimetype'is null or o.metadata->>'mimetype'not in('image/jpeg','image/png','image/webp')
 or coalesce(o.metadata->>'size','')!~'^[0-9]{1,7}$'then return jsonb_build_object('status','asset_not_owned');end if;
 if(o.metadata->>'size')::bigint not between 1 and 5242880 then return jsonb_build_object('status','asset_not_owned');end if;
 end if;
 rid:=gen_random_uuid();
 insert into private.member_reports(id,reporter_id,reporter_episode_id,client_request_id,target_type,target_id,context,reason_codes,hide_target,fingerprint)
 values(rid,p_user_id,episode,fid,'ai_answer',p_request_id,'online',array['other'],false,hash);
 insert into private.member_report_details(report_id,description)values(rid,description);
 if kind='capture'then update private.report_capture_assets set state='attached',report_id=rid where id=asset.id;end if;
 end if;
 insert into private.ai_feedback_receipts(feedback_id,user_id,client_hash,fingerprint,request_id,action,report_id)
 values(fid,p_user_id,key_hash,hash,p_request_id,p_action,rid);
 return jsonb_build_object('status','accepted','feedbackId',fid,'hideAnswer',p_action='report');
end;$$;
-- 만료 helpful은 원문 없는 메타데이터만 삭제한다. 신고는 기존 종결+90일 파기 FK를 따른다.
create function public.purge_expired_ai_feedback(p_limit integer)returns jsonb
language plpgsql volatile security definer set search_path=''as $$declare n integer;begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_limit'using errcode='22023';end if;
 with selected as(select feedback_id from private.ai_feedback_receipts where action='helpful'and accepted_at+interval'2160 hours'<=clock_timestamp()order by accepted_at,feedback_id limit p_limit for update skip locked)
 delete from private.ai_feedback_receipts f using selected s where f.feedback_id=s.feedback_id;
 get diagnostics n=row_count;
 return jsonb_build_object('deletedCount',n);
end;$$;
create function private.delete_retired_ai_helpful()returns trigger
language plpgsql security definer set search_path=''as $$begin
 if new.ended_at is not null and old.ended_at is null then
 delete from private.ai_feedback_receipts where user_id=new.profile_id and action='helpful';
 delete from private.ai_result_receipts where user_id=new.profile_id;
 end if;
 return new;
end;$$;
create trigger retired_ai_helpful after update of ended_at on private.member_episodes for each row execute function private.delete_retired_ai_helpful();
revoke all on function private.delete_retired_ai_helpful()from public,anon,authenticated,service_role;
-- AI 답변 신고에 다른 회원의 제재·당도·동행 판정을 만들지 않는다.
do $$declare definition text;begin
 select pg_get_functiondef('private.assigned_report_party_metadata(private.member_reports)'::regprocedure)into definition;
 if strpos(definition,'p_report.target_type=''event''')=0 then raise exception 'party_source_mismatch';end if;
 execute replace(definition,'p_report.target_type=''event''','p_report.target_type in(''event'',''ai_answer'')');
 select pg_get_functiondef('public.adjudicate_assigned_member_report(uuid,uuid,text,bigint,bigint,bigint,text,text,text,text,text,text)'::regprocedure)into definition;
 if strpos(definition,'snapshot.target_type=''event''')=0 then raise exception 'adjudication_source_mismatch';end if;
 execute replace(definition,'snapshot.target_type=''event''','snapshot.target_type in(''event'',''ai_answer'')');
end;$$;
revoke all on function public.record_ai_chat_result_available(uuid,uuid,uuid),public.get_ai_feedback_readiness(),public.submit_ai_feedback(uuid,uuid,text,text,jsonb,text),public.purge_expired_ai_feedback(integer)from public,anon,authenticated,service_role;
grant execute on function public.record_ai_chat_result_available(uuid,uuid,uuid),public.get_ai_feedback_readiness(),public.submit_ai_feedback(uuid,uuid,text,text,jsonb,text),public.purge_expired_ai_feedback(integer)to service_role;
commit;
