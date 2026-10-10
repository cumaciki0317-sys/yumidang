-- 민규: 검사 결과와 실제 저장 입력을 원자 결합한다. 탐지 정책 승인/활성화·원문 로그를 대신하지 않는다.
-- 기본 enabled=false이며 기존 작성 동작은 유지된다. 적용만으로 검사 강제가 완료되지는 않는다.
-- 최소 멱등 키 보관기간은 미정이다. 소비 기록의 자동 파기/시간 경과에 따른 재전송 허가는 없다.
begin;
create table private.content_inspection_control(
 singleton boolean primary key default true check(singleton), enabled boolean not null default false,
 policy_version text, scanner_version text, max_ticket_seconds integer not null default 60 check(max_ticket_seconds between 1 and 300),
 check(not enabled or (policy_version ~ '^[A-Za-z0-9_.:-]{1,80}$' and scanner_version ~ '^[A-Za-z0-9_.:-]{1,80}$' and policy_version is not null and scanner_version is not null))
);
insert into private.content_inspection_control(singleton) values(true);
create table private.content_inspection_tickets(
 ticket_id uuid primary key default extensions.gen_random_uuid(), user_id uuid not null, operation_id uuid not null,
 action text not null check(action in ('post_create','post_update','profile_traits','profile_preferences','signup_traits','review','application_message','chat_message')),
 target_id uuid not null, input_sha256 text not null check(input_sha256 ~ '^[a-f0-9]{64}$'),
 decision text not null check(decision in ('allow','confirm_required','block')),
 policy_version text not null, scanner_version text not null, issued_at timestamptz not null default clock_timestamp(), expires_at timestamptz not null,
 confirmed_at timestamptz, consumed_at timestamptz, outcome jsonb, outcome_sha256 text,
 unique(user_id,operation_id), check(decision <> 'confirm_required' or action in ('application_message','chat_message')),
 check(confirmed_at is null or decision='confirm_required'),
 check((consumed_at is null and outcome is null and outcome_sha256 is null) or (consumed_at is not null and decision <> 'block' and outcome_sha256 is not null and outcome_sha256 ~ '^[a-f0-9]{64}$'))
);
alter table private.content_inspection_control enable row level security;
alter table private.content_inspection_tickets enable row level security;
revoke all on private.content_inspection_control,private.content_inspection_tickets from public,anon,authenticated,service_role;
create function private.content_inspection_digest(p_action text,p_input jsonb) returns text
 language plpgsql stable set search_path='' as $$
declare v jsonb:=p_input; expected text[]; actual text[];
begin
 if jsonb_typeof(v) is distinct from 'object' or octet_length(v::text)>32768 then raise exception 'invalid_content_scope' using errcode='22023'; end if;
 case p_action
 when 'post_create' then expected:=array['p_post_id','p_input'];
 when 'post_update' then expected:=array['p_post_id','p_input','p_expected_updated_at'];
 when 'profile_traits' then expected:=array['p_interests','p_conversation_styles','p_mbti'];
 when 'profile_preferences' then expected:=array['p_interests','p_conversation_styles','p_mbti','p_bio'];
 when 'signup_traits' then expected:=array['p_avatar_path','p_interests','p_conversation_styles','p_mbti'];
 when 'review' then expected:=array['p_appointment_id','p_rating','p_comment','p_experience','p_praises'];
 when 'application_message' then expected:=array['p_post_id','p_message_id','p_message'];
 when 'chat_message' then expected:=array['p_request_id','p_message_id','p_content'];
 else raise exception 'invalid_content_action' using errcode='22023'; end case;
 select array_agg(k order by k) into actual from jsonb_object_keys(v) k;
 if actual is distinct from (select array_agg(k order by k) from unnest(expected) k) then raise exception 'invalid_content_scope' using errcode='22023'; end if;
 -- PostgREST의 DB형 변환과 같도록 수정 기준 시각을 DB 표현으로 정규화한다.
 if p_action='post_update' then v:=v||jsonb_build_object('p_expected_updated_at',extract(epoch from (v->>'p_expected_updated_at')::timestamptz)); end if;
 return encode(extensions.digest(convert_to(v::text,'UTF8'),'sha256'),'hex');
end; $$;
create function private.content_ticket_view(t private.content_inspection_tickets) returns jsonb
 language sql immutable set search_path='' as $$
 select jsonb_build_object('ticketId',t.ticket_id,'userId',t.user_id,'operationId',t.operation_id,'action',t.action,'targetId',t.target_id); $$;
create function public.issue_content_inspection_ticket(p_user_id uuid,p_operation_id uuid,p_action text,p_target_id uuid,p_input jsonb,p_decision text,p_policy_version text,p_scanner_version text)
 returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c private.content_inspection_control; t private.content_inspection_tickets; h text;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'content_issuer_required' using errcode='42501'; end if;
 select * into strict c from private.content_inspection_control where singleton for share;
 if not c.enabled then raise exception 'content_inspection_not_enabled' using errcode='55000'; end if;
 if p_user_id is null or p_operation_id is null or p_target_id is null or p_user_id='00000000-0000-0000-0000-000000000000'::uuid or p_operation_id='00000000-0000-0000-0000-000000000000'::uuid or p_target_id='00000000-0000-0000-0000-000000000000'::uuid
 or p_policy_version is distinct from c.policy_version or p_scanner_version is distinct from c.scanner_version
 or p_decision is null or p_decision not in ('allow','confirm_required','block')
 or (p_decision='confirm_required' and p_action not in ('application_message','chat_message'))
 or (p_action in ('profile_traits','profile_preferences','signup_traits') and p_target_id<>p_user_id)
 or (p_action in ('application_message','chat_message') and (p_input->>'p_message_id')::uuid is distinct from p_operation_id)
 then raise exception 'invalid_content_ticket' using errcode='22023'; end if;
 h:=private.content_inspection_digest(p_action,p_input);
 insert into private.content_inspection_tickets(user_id,operation_id,action,target_id,input_sha256,decision,policy_version,scanner_version,expires_at)
 values(p_user_id,p_operation_id,p_action,p_target_id,h,p_decision,p_policy_version,p_scanner_version,clock_timestamp()+make_interval(secs=>c.max_ticket_seconds))
 on conflict(user_id,operation_id) do nothing;
 select * into strict t from private.content_inspection_tickets where user_id=p_user_id and operation_id=p_operation_id for update;
 if t.action<>p_action or t.target_id<>p_target_id or t.input_sha256<>h or t.decision<>p_decision or t.policy_version<>p_policy_version or t.scanner_version<>p_scanner_version
 then raise exception 'content_operation_conflict' using errcode='40001'; end if;
 -- 응답 유실·재조회는 원 ticket만 반환하며 유효기간/판정/소비 상태를 초기화하지 않는다.
 return private.content_ticket_view(t);
end; $$;
revoke all on function public.issue_content_inspection_ticket(uuid,uuid,text,uuid,jsonb,text,text,text) from public,anon,authenticated,service_role;
-- 회원 상태 확인은 탈퇴와 공유 잠금을 사용한다. POST 조회 RPC는 VOLATILE로 READ WRITE TX에서 실행한다.
-- 최소 DTO 조회만 수행하며 ticket 생성·갱신·소비는 하지 않는다. GET/HEAD READ ONLY에서 실행하지 않는다.
create function public.get_my_content_inspection_ticket(p_ticket_id uuid,p_operation_id uuid)
 returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=private.require_member_uid(); t private.content_inspection_tickets;
begin
 select * into t from private.content_inspection_tickets where ticket_id=p_ticket_id and user_id=u and operation_id=p_operation_id;
 if not found then raise exception 'content_ticket_not_found' using errcode='PT404'; end if;
 return private.content_ticket_view(t)||jsonb_build_object('decision',t.decision,'confirmed',t.confirmed_at is not null,'consumed',t.consumed_at is not null,'expiresAt',t.expires_at);
end; $$;
create function public.confirm_my_content_inspection_ticket(p_ticket_id uuid,p_operation_id uuid,p_action text,p_target_id uuid,p_input jsonb)
 returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid; t private.content_inspection_tickets; c private.content_inspection_control;
begin
 u:=auth.uid();
 if u is null or auth.role() is distinct from 'authenticated' or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'login_required' using errcode='28000'; end if;
 -- 채팅 확인은 공유 잠금만 사용한다. 양쪽 대화의 account 잠금과 호환된다.
 perform 1 from private.naver_accounts where user_id=u order by subject for share;
 perform 1 from public.profiles where id=u for key share;
 perform private.require_member_uid();
 select * into strict c from private.content_inspection_control where singleton for share;
 if not c.enabled then raise exception 'content_inspection_not_enabled' using errcode='55000'; end if;
 select * into t from private.content_inspection_tickets where ticket_id=p_ticket_id and user_id=u and operation_id=p_operation_id for update;
 if not found then raise exception 'content_ticket_not_found' using errcode='PT404'; end if;
 if t.action is distinct from p_action or t.target_id is distinct from p_target_id or t.input_sha256 is distinct from private.content_inspection_digest(p_action,p_input)
 then raise exception 'content_operation_conflict' using errcode='40001'; end if;
 if t.decision<>'confirm_required' or t.action not in ('application_message','chat_message') then raise exception 'content_confirmation_denied' using errcode='42501'; end if;
 if t.consumed_at is null and (t.expires_at<=clock_timestamp() or t.policy_version<>c.policy_version or t.scanner_version<>c.scanner_version) then raise exception 'content_ticket_expired' using errcode='40001'; end if;
 update private.content_inspection_tickets set confirmed_at=coalesce(confirmed_at,clock_timestamp()) where ticket_id=t.ticket_id returning * into t;
 return private.content_ticket_view(t);
end; $$;
revoke all on function public.get_my_content_inspection_ticket(uuid,uuid),public.confirm_my_content_inspection_ticket(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_my_content_inspection_ticket(uuid,uuid),public.confirm_my_content_inspection_ticket(uuid,uuid,text,uuid,jsonb) to authenticated;
alter function public.create_service_post(p_post_id uuid, p_input jsonb) set schema private;
alter function private.create_service_post(p_post_id uuid, p_input jsonb) rename to create_service_post_before_content_inspection;
revoke all on function private.create_service_post_before_content_inspection(p_post_id uuid, p_input jsonb) from public,anon,authenticated,service_role;
alter function public.update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamptz) set schema private;
alter function private.update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamptz) rename to update_service_post_before_content_inspection;
revoke all on function private.update_service_post_before_content_inspection(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamptz) from public,anon,authenticated,service_role;
alter function public.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text) set schema private;
alter function private.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text) rename to set_my_profile_traits_before_content_inspection;
revoke all on function private.set_my_profile_traits_before_content_inspection(p_interests text[], p_conversation_styles text[], p_mbti text) from public,anon,authenticated,service_role;
alter function public.set_my_profile_preferences(p_interests text[], p_conversation_styles text[], p_mbti text, p_bio text) set schema private;
alter function private.set_my_profile_preferences(p_interests text[], p_conversation_styles text[], p_mbti text, p_bio text) rename to set_my_profile_preferences_before_content_inspection;
revoke all on function private.set_my_profile_preferences_before_content_inspection(p_interests text[], p_conversation_styles text[], p_mbti text, p_bio text) from public,anon,authenticated,service_role;
alter function public.complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) set schema private;
alter function private.complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) rename to complete_naver_signup_before_content_inspection;
revoke all on function private.complete_naver_signup_before_content_inspection(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) from public,anon,authenticated,service_role;
alter function public.submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) set schema private;
alter function private.submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) rename to submit_appointment_review_before_content_inspection;
revoke all on function private.submit_appointment_review_before_content_inspection(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) from public,anon,authenticated,service_role;
alter function public.request_service_post(p_post_id uuid, p_message_id uuid, p_message text) set schema private;
alter function private.request_service_post(p_post_id uuid, p_message_id uuid, p_message text) rename to request_service_post_before_content_inspection;
revoke all on function private.request_service_post_before_content_inspection(p_post_id uuid, p_message_id uuid, p_message text) from public,anon,authenticated,service_role;
alter function public.send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text) set schema private;
alter function private.send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text) rename to send_conversation_message_before_content_inspection;
revoke all on function private.send_conversation_message_before_content_inspection(p_request_id uuid, p_message_id uuid, p_content text) from public,anon,authenticated,service_role;
-- 가입·preferences 내부 성향 validator 호출은 외부 gate를 다시 소비하지 않는다.
-- 정확한 기존 호출 한 곳만 교체한다. 구조가 바뀌면 migration 전체를 중단한다.
do $$ declare oid regprocedure; definition text; begin
 foreach oid in array array['private.complete_naver_signup_before_member_retirement(text,text[],text[],text)'::regprocedure,'private.set_my_profile_preferences_before_content_inspection(text[],text[],text,text)'::regprocedure] loop
 definition:=pg_get_functiondef(oid);
 if (length(definition)-length(replace(definition,'public.set_my_profile_traits(','')))/length('public.set_my_profile_traits(')<>1 then raise exception 'unexpected_nested_traits_contract'; end if;
 execute replace(definition,'public.set_my_profile_traits(','private.set_my_profile_traits_before_content_inspection(');
 end loop;
end; $$;
create function private.execute_inspected_content(p_action text,p_input jsonb) returns jsonb
 language plpgsql volatile security definer set search_path='' as $$
begin
 case p_action
 when 'post_create' then return private.create_service_post_before_content_inspection((p_input->>'p_post_id')::uuid,p_input->'p_input');
 when 'post_update' then return private.update_service_post_before_content_inspection((p_input->>'p_post_id')::uuid,p_input->'p_input',(p_input->>'p_expected_updated_at')::timestamptz);
 when 'profile_traits' then return private.set_my_profile_traits_before_content_inspection(case when p_input->'p_interests'='null'::jsonb then null else array(select jsonb_array_elements_text(p_input->'p_interests')) end,case when p_input->'p_conversation_styles'='null'::jsonb then null else array(select jsonb_array_elements_text(p_input->'p_conversation_styles')) end,p_input->>'p_mbti');
 when 'profile_preferences' then return private.set_my_profile_preferences_before_content_inspection(case when p_input->'p_interests'='null'::jsonb then null else array(select jsonb_array_elements_text(p_input->'p_interests')) end,case when p_input->'p_conversation_styles'='null'::jsonb then null else array(select jsonb_array_elements_text(p_input->'p_conversation_styles')) end,p_input->>'p_mbti',p_input->>'p_bio');
 when 'signup_traits' then return private.complete_naver_signup_before_content_inspection(p_input->>'p_avatar_path',case when p_input->'p_interests'='null'::jsonb then null else array(select jsonb_array_elements_text(p_input->'p_interests')) end,case when p_input->'p_conversation_styles'='null'::jsonb then null else array(select jsonb_array_elements_text(p_input->'p_conversation_styles')) end,p_input->>'p_mbti');
 when 'review' then return private.submit_appointment_review_before_content_inspection((p_input->>'p_appointment_id')::uuid,(p_input->>'p_rating')::integer,p_input->>'p_comment',p_input->>'p_experience',case when p_input->'p_praises'='null'::jsonb then null else array(select jsonb_array_elements_text(p_input->'p_praises')) end);
 when 'application_message' then return private.request_service_post_before_content_inspection((p_input->>'p_post_id')::uuid,(p_input->>'p_message_id')::uuid,p_input->>'p_message');
 when 'chat_message' then return private.send_conversation_message_before_content_inspection((p_input->>'p_request_id')::uuid,(p_input->>'p_message_id')::uuid,p_input->>'p_content');
 else raise exception 'invalid_content_action' using errcode='22023'; end case;
end; $$;
create function private.apply_content_inspection(p_action text,p_target_id uuid,p_input jsonb) returns jsonb
 language plpgsql volatile security definer set search_path='' as $$
declare c private.content_inspection_control; t private.content_inspection_tickets; u uuid; headers jsonb; ticket uuid; operation uuid; result jsonb; safe_keys text[]; h text;
begin
 select * into strict c from private.content_inspection_control where singleton for share;
 if not c.enabled then return private.execute_inspected_content(p_action,p_input); end if;
 u:=auth.uid();
 if u is null or auth.role() is distinct from 'authenticated' or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception 'login_required' using errcode='28000'; end if;
 -- 프로필 전체 교체만 배타 잠금을 먼저 확보한다. 대화/약속의 양쪽 공유 잠금은 유지한다.
 if p_action in ('profile_traits','profile_preferences','signup_traits') then
  perform 1 from private.naver_accounts where user_id=u order by subject for update;
  perform 1 from public.profiles where id=u for update;
 else
  perform 1 from private.naver_accounts where user_id=u order by subject for share;
  perform 1 from public.profiles where id=u for key share;
 end if;
 perform private.require_member_uid();
 headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 ticket:=nullif(headers->>'x-content-inspection-ticket','')::uuid;
 operation:=nullif(headers->>'x-content-operation-id','')::uuid;
 if ticket is null or operation is null then raise exception 'content_ticket_required' using errcode='42501'; end if;
 h:=private.content_inspection_digest(p_action,p_input);
 select * into t from private.content_inspection_tickets where ticket_id=ticket and user_id=u and operation_id=operation for update;
 if not found then raise exception 'content_ticket_not_found' using errcode='42501'; end if;
 if t.action is distinct from p_action or t.target_id is distinct from p_target_id or t.input_sha256 is distinct from h
 then raise exception 'content_operation_conflict' using errcode='40001'; end if;
 if t.decision='block' then raise exception 'content_blocked' using errcode='42501'; end if;
 if t.decision='confirm_required' and t.confirmed_at is null then raise exception 'content_confirmation_required' using errcode='40001'; end if;
 if t.consumed_at is not null then
  -- 성공한 변경을 다시 실행하지 않는다. 원문 DTO를 복사하지 않고 현재 동일 결과만 조회한다.
  case p_action
   when 'profile_traits' then result:=public.get_my_profile_traits();
   when 'profile_preferences' then result:=public.get_my_profile_traits()||jsonb_build_object('bio',(select bio from public.profiles where id=u));
   when 'signup_traits' then result:=public.get_naver_signup_state();
   else result:=t.outcome;
  end case;
  if encode(extensions.digest(convert_to(result::text,'UTF8'),'sha256'),'hex') is distinct from t.outcome_sha256 then raise exception 'content_result_changed' using errcode='40001'; end if;
  if p_action='post_create' then result:=result||jsonb_build_object('alreadyCreated',true);
  elsif p_action='review' then result:=result||jsonb_build_object('deduplicated',true);
  elsif p_action in ('application_message','chat_message') then result:=result||jsonb_build_object('alreadySent',true); end if;
  return result;
 end if;
 if t.expires_at<=clock_timestamp() or t.policy_version<>c.policy_version or t.scanner_version<>c.scanner_version then raise exception 'content_ticket_expired' using errcode='40001'; end if;
 result:=private.execute_inspected_content(p_action,p_input);
 if t.expires_at<=clock_timestamp() then raise exception 'content_ticket_expired' using errcode='40001'; end if;
 if jsonb_typeof(result) is distinct from 'object' then raise exception 'invalid_content_result' using errcode='55000'; end if;
 if p_action not in ('profile_traits','profile_preferences','signup_traits') then
  case p_action
   when 'post_create' then safe_keys:=array['postId','alreadyCreated'];
   when 'post_update' then safe_keys:=array['postId','status','updatedAt'];
   when 'review' then safe_keys:=array['reviewId','submittedAt','deduplicated'];
   when 'application_message' then safe_keys:=array['id','post_id','status','created_at','already_existed','messageId','messageCreatedAt','alreadySent'];
   when 'chat_message' then safe_keys:=array['messageId','createdAt','alreadySent'];
  end case;
  if exists(select 1 from jsonb_each(result) e where not e.key=any(safe_keys) or jsonb_typeof(e.value) not in ('string','number','boolean','null')) then raise exception 'unexpected_content_result_shape' using errcode='55000'; end if;
 end if;
 update private.content_inspection_tickets set consumed_at=clock_timestamp(),
  outcome=case when p_action in ('profile_traits','profile_preferences','signup_traits') then null else result end,
  outcome_sha256=encode(extensions.digest(convert_to(result::text,'UTF8'),'sha256'),'hex') where ticket_id=t.ticket_id;
 return result;
end; $$;
create function public.create_service_post(p_post_id uuid, p_input jsonb) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.apply_content_inspection('post_create',p_post_id,jsonb_build_object('p_post_id',p_post_id,'p_input',p_input)); $$;
revoke all on function public.create_service_post(p_post_id uuid, p_input jsonb) from public,anon,authenticated,service_role;
grant execute on function public.create_service_post(p_post_id uuid, p_input jsonb) to authenticated;
create function public.update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamptz) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.apply_content_inspection('post_update',p_post_id,jsonb_build_object('p_post_id',p_post_id,'p_input',p_input,'p_expected_updated_at',p_expected_updated_at)); $$;
revoke all on function public.update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.update_service_post(p_post_id uuid, p_input jsonb, p_expected_updated_at timestamptz) to authenticated;
create function public.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.apply_content_inspection('profile_traits',auth.uid(),jsonb_build_object('p_interests',p_interests,'p_conversation_styles',p_conversation_styles,'p_mbti',p_mbti)); $$;
revoke all on function public.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text) from public,anon,authenticated,service_role;
grant execute on function public.set_my_profile_traits(p_interests text[], p_conversation_styles text[], p_mbti text) to authenticated;
create function public.set_my_profile_preferences(p_interests text[], p_conversation_styles text[], p_mbti text, p_bio text) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.apply_content_inspection('profile_preferences',auth.uid(),jsonb_build_object('p_interests',p_interests,'p_conversation_styles',p_conversation_styles,'p_mbti',p_mbti,'p_bio',p_bio)); $$;
revoke all on function public.set_my_profile_preferences(p_interests text[], p_conversation_styles text[], p_mbti text, p_bio text) from public,anon,authenticated,service_role;
grant execute on function public.set_my_profile_preferences(p_interests text[], p_conversation_styles text[], p_mbti text, p_bio text) to authenticated;
create function public.complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.apply_content_inspection('signup_traits',auth.uid(),jsonb_build_object('p_avatar_path',p_avatar_path,'p_interests',p_interests,'p_conversation_styles',p_conversation_styles,'p_mbti',p_mbti)); $$;
revoke all on function public.complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) from public,anon,authenticated,service_role;
grant execute on function public.complete_naver_signup(p_avatar_path text, p_interests text[], p_conversation_styles text[], p_mbti text) to authenticated;
create function public.submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.apply_content_inspection('review',p_appointment_id,jsonb_build_object('p_appointment_id',p_appointment_id,'p_rating',p_rating,'p_comment',p_comment,'p_experience',p_experience,'p_praises',p_praises)); $$;
revoke all on function public.submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) from public,anon,authenticated,service_role;
grant execute on function public.submit_appointment_review(p_appointment_id uuid, p_rating integer, p_comment text, p_experience text, p_praises text[]) to authenticated;
create function public.request_service_post(p_post_id uuid, p_message_id uuid, p_message text) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.apply_content_inspection('application_message',p_post_id,jsonb_build_object('p_post_id',p_post_id,'p_message_id',p_message_id,'p_message',p_message)); $$;
revoke all on function public.request_service_post(p_post_id uuid, p_message_id uuid, p_message text) from public,anon,authenticated,service_role;
grant execute on function public.request_service_post(p_post_id uuid, p_message_id uuid, p_message text) to authenticated;
create function public.send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text) returns jsonb language sql volatile security definer set search_path='' as $$
 select private.apply_content_inspection('chat_message',p_request_id,jsonb_build_object('p_request_id',p_request_id,'p_message_id',p_message_id,'p_content',p_content)); $$;
revoke all on function public.send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text) from public,anon,authenticated,service_role;
grant execute on function public.send_conversation_message(p_request_id uuid, p_message_id uuid, p_content text) to authenticated;
revoke all on function private.content_inspection_digest(text,jsonb),private.content_ticket_view(private.content_inspection_tickets),private.execute_inspected_content(text,jsonb),private.apply_content_inspection(text,uuid,jsonb) from public,anon,authenticated,service_role;
comment on table private.content_inspection_tickets is '원문을 저장하지 않는 입력 digest와 최소 소비 증거. 보관 TTL 미정이며 자동 삭제나 재전송 허가가 없다.';
notify pgrst,'reload schema';
commit;
