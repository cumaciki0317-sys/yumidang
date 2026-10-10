-- 민규: Auth 세션 회수 뒤 원 탈퇴의 결과만 조회한다. 새 탈퇴·일반 세션 복구는 없다.
begin;
alter table private.member_retirements add column request_fingerprint text
 generated always as (encode(extensions.digest('retirement:v1:'||withdrawal_id::text,'sha256'),'hex')) stored;
-- generated 값은 최초 retire_my_account INSERT의 원자 트랜잭션에 속한다.
-- 이전 영수증도 이미 저장된 withdrawal_id에서만 유도하며 새 성공 행을 만들지 않는다.
create table private.member_retirement_receipt_control(
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 expected_issuer text,
 expected_audience text not null default 'authenticated' check(expected_audience='authenticated'),
 check(expected_issuer is null or (expected_issuer=btrim(expected_issuer) and char_length(expected_issuer) between 1 and 2048 and expected_issuer !~ '[[:cntrl:]]')),
 check(not enabled or expected_issuer is not null)
);
insert into private.member_retirement_receipt_control(singleton)values(true);
alter table private.member_retirement_receipt_control enable row level security;
revoke all on private.member_retirement_receipt_control from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
create function public.get_my_retirement_receipt(p_withdrawal_id uuid,p_request_fingerprint text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 me uuid:=auth.uid();claims jsonb:=auth.jwt();
 gate private.member_retirement_receipt_control;
 receipt private.member_retirements;
 expiry numeric;
begin
 -- 서명은 PostgREST가 원 JWT로 검증한다. local decode/sub·service-role 조회를 사용하지 않는다.
 if me is null or auth.role() is distinct from 'authenticated'
  or claims->>'role' is distinct from 'authenticated'
  or coalesce(claims->>'is_anonymous','false')<>'false'
  or p_withdrawal_id is null or p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$'
 then raise exception 'login_required' using errcode='28000';end if;
 select * into gate from private.member_retirement_receipt_control where singleton;
 if not found or not gate.enabled or gate.expected_issuer is null
  or jsonb_typeof(claims->'iss') is distinct from 'string'
  or claims->>'iss' is distinct from gate.expected_issuer
  or jsonb_typeof(claims->'aud') is distinct from 'string'
  or claims->>'aud' is distinct from gate.expected_audience
  or jsonb_typeof(claims->'exp') is distinct from 'number'
  or claims->>'exp' !~ '^[0-9]{1,16}$'
 then raise exception 'login_required' using errcode='28000';end if;
 expiry:=(claims->>'exp')::numeric;
 if expiry<=extract(epoch from clock_timestamp()) then
  raise exception 'login_required' using errcode='28000';end if;
 select * into receipt from private.member_retirements
  where profile_id=me and withdrawal_id=p_withdrawal_id and request_fingerprint=p_request_fingerprint;
 if not found
  or not exists(select 1 from private.member_episodes e
   where e.id=receipt.episode_id and e.profile_id=me and e.ended_at=receipt.retired_at)
  or exists(select 1 from private.member_episodes where profile_id=me and ended_at is null)
  or exists(select 1 from private.naver_accounts where user_id=me)
  or not exists(select 1 from public.profiles where id=me
   and real_name is null and birth_date is null and gender is null and avatar_url is null and bio is null)
  or receipt.state not in('pending_cleanup','completed')
  or (receipt.state='completed')<>(receipt.completed_at is not null)
 then raise exception 'login_required' using errcode='28000';end if;
 return jsonb_build_object('withdrawalId',receipt.withdrawal_id,
  'status',case when receipt.state='completed' then 'completed' else 'processing' end,
  'memberAccessRevoked',true);
end;$$;
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.retire_my_account(uuid)'::regprocedure;
 execute format('alter table private.member_retirement_receipt_control owner to %I',own);
 execute format('alter function public.get_my_retirement_receipt(uuid,text)owner to %I',own);
end;$$;
revoke all on function public.get_my_retirement_receipt(uuid,text)from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
grant execute on function public.get_my_retirement_receipt(uuid,text)to authenticated;
commit;
