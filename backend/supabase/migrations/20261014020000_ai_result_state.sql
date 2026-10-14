-- 종현: 본인 AI 결과의 메타데이터만 조회한다. 결과 생성·점유 해제·평가 쓰기 없음.
begin;
create function public.get_ai_result_state(p_user_id uuid,p_request_id uuid)returns jsonb
language plpgsql stable security definer set search_path=''as $$
declare r private.ai_chat_requests;stamp timestamptz;now_at timestamptz:=statement_timestamp();state text;
begin
 if p_user_id is null or p_request_id is null then raise exception 'invalid_ai_result_scope'using errcode='22023';end if;
 -- 현재 회원 조건은 기존 평가 접수와 같다. AI 철회를 새 조회/평가 거부 조건으로 추가하지 않는다.
 if private.profile_retired(p_user_id)or not exists(select 1 from private.member_episodes
  where profile_id=p_user_id and ended_at is null)then raise exception 'ai_result_unavailable'using errcode='PT404';end if;
 select *into r from private.ai_chat_requests where request_id=p_request_id and user_id=p_user_id;
 if not found then raise exception 'ai_result_unavailable'using errcode='PT404';end if;
 select available_at into stamp from private.ai_result_receipts where request_id=p_request_id and user_id=p_user_id;
 if stamp is not null and stamp+interval'2160 hours'<=now_at then raise exception 'ai_result_unavailable'using errcode='PT404';end if;
 if r.outcome='finished'and stamp is not null then
  return jsonb_build_object('requestId',r.request_id,'status','available','availableAt',stamp,'helpfulAllowed',true);
 end if;
 state:=case when r.outcome is null and r.expires_at>now_at then 'pending'else 'unavailable'end;
 return jsonb_build_object('requestId',r.request_id,'status',state,'availableAt',null,'helpfulAllowed',false);
end;$$;
-- 기존 평가 함수와 같은 DB 소유자를 사용한다. 새 직원/회원 권한이나 정책 guard를 열지 않는다.
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.submit_ai_feedback(uuid,uuid,text,text,jsonb,text)'::regprocedure;
 if own in('anon','authenticated','service_role','authenticator')then raise exception 'ai_result_owner_incompatible'using errcode='55000';end if;
 execute format('alter function public.get_ai_result_state(uuid,uuid)owner to %I',own);
end;$$;
revoke all on function public.get_ai_result_state(uuid,uuid)from public,anon,authenticated,service_role,authenticator;
grant execute on function public.get_ai_result_state(uuid,uuid)to service_role;
commit;
