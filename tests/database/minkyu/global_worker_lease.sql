-- 민규: 전역 워커 singleton 점유·재사용·만료·권한 회귀. 실제 동시 세션 검사는 별도로 수행한다.
begin;

do $$ begin
  assert has_function_privilege('service_role','public.acquire_worker_run(integer,uuid)','EXECUTE');
  assert has_function_privilege('service_role','public.release_worker_run(uuid)','EXECUTE');
  assert not has_function_privilege('anon','public.acquire_worker_run(integer,uuid)','EXECUTE');
  assert not has_function_privilege('authenticated','public.release_worker_run(uuid)','EXECUTE');
  assert not has_table_privilege('service_role','private.global_worker_run','SELECT');
  assert not has_table_privilege('authenticated','private.global_worker_run','UPDATE');
end; $$;

-- 서비스 역할 실제 권한으로 acquire/release를 실행한다.
set local role service_role;
do $$ declare a jsonb; b jsonb; t uuid; x integer; rejected boolean; begin
  foreach x in array array[null,0,-1,86401] loop
    rejected := false;
    begin perform public.acquire_worker_run(x,null);
    exception when invalid_parameter_value then rejected := true; end;
    assert rejected,'invalid lease input accepted';
  end loop;
  a := public.acquire_worker_run(180,null);
  assert a is not null and (select count(*) from jsonb_object_keys(a))=2;
  t := (a->>'token')::uuid;
  assert (a->>'expiresAt')::timestamptz > clock_timestamp();
  assert (a->>'expiresAt')::timestamptz <= clock_timestamp()+interval '180 seconds';
  assert public.acquire_worker_run(180,null) is null,'singleton acquired twice';
  assert public.acquire_worker_run(180,'00000000-0000-0000-0000-000000000000') is null;
  b := public.acquire_worker_run(86400,t);
  assert b=a,'existing token extended or changed';
  assert public.release_worker_run('00000000-0000-0000-0000-000000000000')->>'status'='lease_lost';
  assert public.acquire_worker_run(180,t)=a,'wrong release changed lease';
  assert public.release_worker_run(t)->>'status'='applied';
  assert public.release_worker_run(t)->>'status'='lease_lost';
  assert public.acquire_worker_run(180,t) is null,'released token reused';
  b := public.acquire_worker_run(180,null);
  assert b->>'token'<>a->>'token','new lease reused old token';
  assert public.release_worker_run((b->>'token')::uuid)->>'status'='applied';
end; $$;
reset role;

-- 대기 시간 없이 테스트 소유자의 fixture 시각만 조정한다. 운영 RPC에 만료 수정 API는 없다.
do $$ declare a jsonb; b jsonb; t uuid; begin
  a := public.acquire_worker_run(180,null); t := (a->>'token')::uuid;
  update private.global_worker_run set expires_at=clock_timestamp()-interval '1 second' where singleton;
  assert public.acquire_worker_run(180,t) is null,'expired existing token restored';
  assert public.release_worker_run(t)->>'status'='lease_lost';
  b := public.acquire_worker_run(180,null);
  assert b->>'token'<>a->>'token','expired token reused';
  assert public.release_worker_run(t)->>'status'='lease_lost';
  assert public.acquire_worker_run(180,(b->>'token')::uuid)=b,'old token changed current lease';
  assert public.release_worker_run((b->>'token')::uuid)->>'status'='applied';
end; $$;

set local role anon;
do $$ declare rejected boolean:=false; begin
  begin perform public.acquire_worker_run(180,null);
  exception when insufficient_privilege then rejected:=true; end;
  assert rejected,'anonymous acquired worker';
end; $$;
reset role;
set local role authenticated;
do $$ declare rejected boolean:=false; begin
  begin perform public.release_worker_run('00000000-0000-0000-0000-000000000000');
  exception when insufficient_privilege then rejected:=true; end;
  assert rejected,'member released worker';
end; $$;
reset role;
rollback;
