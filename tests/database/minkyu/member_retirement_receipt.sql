-- 민규: SQL117의 기본 닫힘·단일 조회 권한·영수증 생성 경계. 실제 JWT는 별도 GoTrue/REST 검사다.
begin;
do $$declare id uuid:=gen_random_uuid();denied boolean:=false;begin
 if not exists(select 1 from pg_proc where oid='public.get_my_retirement_receipt(uuid,text)'::regprocedure
  and provolatile='s' and prosecdef and proconfig @> array['search_path=""'])then raise exception 'RECEIPT_NOT_READ_ONLY';end if;
 if has_function_privilege('anon','public.get_my_retirement_receipt(uuid,text)','EXECUTE')
  or has_function_privilege('service_role','public.get_my_retirement_receipt(uuid,text)','EXECUTE')
  or not has_function_privilege('authenticated','public.get_my_retirement_receipt(uuid,text)','EXECUTE')
  or has_table_privilege('authenticated','private.member_retirement_receipt_control','UPDATE')
  or has_table_privilege('service_role','private.member_retirement_receipt_control','SELECT')
 then raise exception 'RECEIPT_PRIVILEGE_BROADENED';end if;
 if not exists(select 1 from pg_attribute where attrelid='private.member_retirements'::regclass
  and attname='request_fingerprint' and attgenerated='s')then raise exception 'RECEIPT_NOT_ATOMIC_FINGERPRINT';end if;
 if(select enabled from private.member_retirement_receipt_control where singleton)then raise exception 'RECEIPT_DEFAULT_OPEN';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',id,'role','authenticated',
  'iss','https://fixture.invalid/auth/v1','aud','authenticated','exp',extract(epoch from clock_timestamp())::bigint+3600)::text,true);
 begin perform public.get_my_retirement_receipt(id,repeat('0',64));
 exception when sqlstate '28000'then denied:=true;end;
 if not denied then raise exception 'RECEIPT_DEFAULT_NOT_CLOSED';end if;
end;$$;
rollback;
