-- SQL118: UNKNOWN 회원 삭제 부모 ID의 최소 읽기 조회. 발견은 실행 허가가 아니다.
-- Supabase CLI migration new가 생성한 실제 UTC 파일명을 유지한다.
begin;
create function public.read_member_cleanup_unknown_invocations(p_after_request_id uuid,p_limit integer)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare result jsonb;
begin
 perform private.assert_worker_invocation();
 if p_limit is null or p_limit<1 or p_limit>100 then
  raise exception 'invalid_discovery_limit' using errcode='22023';
 end if;
 if p_after_request_id='00000000-0000-0000-0000-000000000000'::uuid then
  raise exception 'invalid_discovery_cursor' using errcode='22023';
 end if;
 -- 100은 조회 전송의 기술 상한이다. 실행 배정·승인 TTL·보관 정책을 만들지 않는다.
 -- task 완료·claim 수·현재 global/lease·ACK 유무로 UNKNOWN 부모를 숨기지 않는다.
 with page as materialized (
  select v.request_id from private.worker_invocations v
  where v.kind='member_cleanup' and v.state='unknown'
   and (p_after_request_id is null or v.request_id>p_after_request_id)
  order by v.request_id limit p_limit
 )
 select jsonb_build_object(
  'items',coalesce((select jsonb_agg(jsonb_build_object('invocationRequestId',p.request_id)order by p.request_id)from page p),'[]'::jsonb),
  'nextAfterRequestId',(select p.request_id from page p order by p.request_id desc limit 1)
 )into result;
 return result;
end;$$;
-- 함수 생성과 같은 트랜잭션에서 PUBLIC 및 직접 부여 권한을 즉시 닫는다.
revoke all on function public.read_member_cleanup_unknown_invocations(uuid,integer)
 from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.get_queue_invocation(uuid)'::regprocedure;
 execute format('alter function public.read_member_cleanup_unknown_invocations(uuid,integer)owner to %I',own);
end;$$;
-- VOLATILE POST RPC이며 업무 효과는 조회뿐이다. 새 global/lease/dispatch/DELETE/ACK를 수행하지 않는다.
commit;
