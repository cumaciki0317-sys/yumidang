-- SQL118 합성 자료로 발견 계약과 권한·pagination을 검사한다.
-- UNKNOWN 목록은 완료/삭제/ACK 증거가 아니다. 격리 clone에서만 실행하고 전체 rollback한다.
begin;
create function pg_temp.discovery_id(n integer)returns uuid language sql immutable as $$
 select('f1180000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.discovery_reject(command text,expected text)returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=expected,format('unexpected SQLSTATE %s expected %s',code,expected);
end;$$;
-- 원문을 출력/보관하지 않고 기존 모든 업무 테이블의 행 digest와 안정된 catalog/역할을 비교한다.
create function pg_temp.discovery_snapshot()returns jsonb language plpgsql as $$
declare t record;digest text;rows jsonb:='{}';catalog jsonb;roles jsonb;begin
 for t in select n.nspname,c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname in('public','private','auth','storage')and c.relkind in('r','p')order by 1,2 loop
  execute format('select md5(coalesce(string_agg(to_jsonb(t)::text,chr(10)order by to_jsonb(t)::text),''''))from %I.%I t',t.nspname,t.relname)into digest;
  rows:=rows||jsonb_build_object(t.nspname||'.'||t.relname,digest);
 end loop;
 select jsonb_build_object(
  'relations',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity)order by n.nspname,c.relname)from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage')),
  'functions',(select jsonb_agg(jsonb_build_array(n.nspname,p.oid::regprocedure::text,p.proowner,p.proacl,p.provolatile,p.prosecdef,p.proconfig,md5(pg_get_functiondef(p.oid)))order by p.oid)from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','private','auth','storage')and p.prokind in('f','p')),
  'constraints',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid))order by n.nspname,c.relname,k.conname)from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth','storage'))
 )into catalog;
 select jsonb_build_object(
  'roles',(select jsonb_agg(to_jsonb(r)order by rolname)from pg_roles r),
  'memberships',(select coalesce(jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option)order by roleid,member,grantor),'[]'::jsonb)from pg_auth_members)
 )into roles;
 return jsonb_build_object('rows',rows,'catalog',catalog,'roles',roles);
end;$$;
do $$declare who text;f regprocedure:='public.read_member_cleanup_unknown_invocations(uuid,integer)'::regprocedure;begin
 foreach who in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  assert not has_function_privilege(who,f,'EXECUTE'),'discovery_EXEC_default_open';
 end loop;
 assert not exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where p.oid=f and a.grantee=0 and a.privilege_type='EXECUTE'),'PUBLIC_EXEC_open';
 assert(select provolatile='v'and prosecdef and proconfig=array['search_path=""']from pg_proc where oid=f),'RPC_contract_changed';
 assert(select p.proowner=g.proowner from pg_proc p cross join pg_proc g where p.oid=f and g.oid='public.get_queue_invocation(uuid)'::regprocedure),'unexpected_definer_owner';
 assert not(select enabled from private.worker_invocation_control where singleton),'fixture_requires_closed_control';
 assert not exists(select 1 from private.worker_invocations where request_id in(select pg_temp.discovery_id(n)from generate_series(1,7)n));
 assert not exists(select 1 from private.worker_invocations where request_id in(select pg_temp.discovery_id(n)from generate_series(1001,1103)n));
 assert not exists(select 1 from auth.users where id=pg_temp.discovery_id(8));
 assert not exists(select 1 from public.profiles where id=pg_temp.discovery_id(8));
 assert not exists(select 1 from private.worker_jobs where id=pg_temp.discovery_id(20));
 assert not exists(select 1 from private.worker_jobs where kind='member_cleanup'and dedupe_key='synthetic-discovery118');
 assert not exists(select 1 from private.member_cleanup_tasks where id=pg_temp.discovery_id(20));
 assert not exists(select 1 from private.member_retirements where withdrawal_id=pg_temp.discovery_id(88));
end;$$;
create temporary table discovery_original(snapshot jsonb);
insert into discovery_original values(pg_temp.discovery_snapshot());
savepoint discovery_fixture;

-- 실제 SQL role의 EXEC 거절과 service context의 닫힌 guard를 각각 검사한다.
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(null,1)','42501');
reset role;
grant execute on function public.read_member_cleanup_unknown_invocations(uuid,integer)to service_role;
set local role service_role;
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(null,1)','55000');
reset role;
update private.worker_invocation_control set enabled=true where singleton;
-- 실행 승인/global/lease를 열지 않는다. 만료 global이 있어도 목록에서 부모가 사라지면 안 된다.
update private.global_worker_run set token=pg_temp.discovery_id(99),expires_at=clock_timestamp()-interval'1 hour'where singleton;
insert into private.worker_invocations(request_id,global_token,kind,item_limit,fingerprint,state,dispatch_started,claim_calls,remaining_ms,deadline,closed_at,result)
select pg_temp.discovery_id(n),pg_temp.discovery_id(100+n),case when n=6 then'review_summary'when n=7 then'event_sync'else'member_cleanup'end,
 10,repeat('a',64),case when n=4 then'completed'when n=5 then'prepared'else'unknown'end,n in(2,3),case when n in(2,3)then 1 else 0 end,
 1,clock_timestamp()-interval'1 hour',case when n=4 then clock_timestamp()else null end,
 case when n=4 then'{"status":"ran","counts":{"claimed":0,"succeeded":0,"retried":0,"failed":0,"superseded":0,"yielded":0}}'::jsonb else null end
from generate_series(1,7)n;
-- 100개 전송 상한에서도 여러 page를 실제로 순회하도록 103개 추가 합성 부모를 둔다.
insert into private.worker_invocations(request_id,global_token,kind,item_limit,fingerprint,state,remaining_ms,deadline)
select pg_temp.discovery_id(n),pg_temp.discovery_id(20000+n),'member_cleanup',1,repeat('c',64),'unknown',1,clock_timestamp()-interval'1 hour'
from generate_series(1001,1103)n;
-- 이미 completed task/job이고 현재 job lease가 없어도 원 UNKNOWN 부모2가 발견돼야 한다.
-- 합성 상태 행이며 실제 외부 삭제/부모 완료 PASS를 뜻하지 않는다. ACK도 만들지 않는다.
insert into auth.users(id,email)values(pg_temp.discovery_id(8),'synthetic-discovery118@example.invalid');
insert into public.profiles(id,real_name,birth_date,gender)values(pg_temp.discovery_id(8),'합성 발견 회원','1990-01-01','female');
insert into private.member_retirements(profile_id,withdrawal_id,episode_id)
 values(pg_temp.discovery_id(8),pg_temp.discovery_id(88),private.active_member_episode(pg_temp.discovery_id(8)));
insert into private.member_cleanup_tasks(id,withdrawal_id,kind,profile_id,state,evidence_sha256,completed_at)
 values(pg_temp.discovery_id(20),pg_temp.discovery_id(88),'auth_user',pg_temp.discovery_id(8),'completed',repeat('b',64),clock_timestamp());
insert into private.worker_jobs(id,kind,dedupe_key,payload,status,available_at,completed_at)
 values(pg_temp.discovery_id(20),'member_cleanup','synthetic-discovery118',jsonb_build_object('taskId',pg_temp.discovery_id(20)),'succeeded',clock_timestamp(),clock_timestamp());
insert into private.worker_invocation_jobs(request_id,job_id,job_lease_token,claim_seq,settled_status)
 values(pg_temp.discovery_id(2),pg_temp.discovery_id(20),pg_temp.discovery_id(120),1,'succeeded');

-- EXEC를 합성 트랜잭션에서만 부여해 각 caller context의 내부 거절도 검사한다.
grant execute on function public.read_member_cleanup_unknown_invocations(uuid,integer)to anon,authenticated,yumidang_worker_queue;
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select set_config('request.jwt.claim.role','anon',true);
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(null,1)','42501');
reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","is_anonymous":true}',true);
select set_config('request.jwt.claim.role','authenticated',true);
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(null,1)','42501');
select set_config('request.jwt.claims','{"role":"authenticated","sub":"f1180000-0000-4000-8000-000000000008"}',true);
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(null,1)','42501');
reset role;
set local role yumidang_worker_queue;
select set_config('request.jwt.claims','{"role":"yumidang_worker_queue"}',true);
select set_config('request.jwt.claim.role','yumidang_worker_queue',true);
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(null,1)','42501');
reset role;
revoke all on function public.read_member_cleanup_unknown_invocations(uuid,integer)from anon,authenticated,yumidang_worker_queue;

create temporary table discovery_expected(ids uuid[]);
insert into discovery_expected select array_agg(request_id order by request_id)from private.worker_invocations where kind='member_cleanup'and state='unknown';
grant select on discovery_expected to service_role;
create temporary table discovery_query_before(snapshot jsonb);
insert into discovery_query_before values(pg_temp.discovery_snapshot());
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select set_config('request.jwt.claim.role','service_role',true);
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(null,null)','22023');
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(null,0)','22023');
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(null,-1)','22023');
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(null,101)','22023');
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(''00000000-0000-0000-0000-000000000000'',1)','22023');
select pg_temp.discovery_reject('select public.read_member_cleanup_unknown_invocations(''bad-cursor'',1)','22P02');
do $$declare page jsonb;item jsonb;after_id uuid;seen uuid[];expected uuid[];size integer;calls integer;current_id uuid;begin
 select ids into strict expected from discovery_expected;
 assert pg_temp.discovery_id(1)=any(expected)and pg_temp.discovery_id(2)=any(expected)and pg_temp.discovery_id(3)=any(expected);
 assert not(expected&&array[pg_temp.discovery_id(4),pg_temp.discovery_id(5),pg_temp.discovery_id(6),pg_temp.discovery_id(7)]);
 foreach size in array array[1,2,100]loop
  after_id:=null;seen:='{}';calls:=0;
  loop
   calls:=calls+1;assert calls<=cardinality(expected)+1,'pagination_did_not_terminate';
   page:=public.read_member_cleanup_unknown_invocations(after_id,size);
   assert(select array_agg(k order by k)=array['items','nextAfterRequestId']from jsonb_object_keys(page)k),'nonminimal_page';
   assert jsonb_typeof(page->'items')='array'and jsonb_array_length(page->'items')<=size;
   if jsonb_array_length(page->'items')=0 then assert page->'nextAfterRequestId'='null'::jsonb;exit;end if;
   for item in select value from jsonb_array_elements(page->'items')loop
    assert(select array_agg(k)=array['invocationRequestId']from jsonb_object_keys(item)k),'nonminimal_item';
    current_id:=(item->>'invocationRequestId')::uuid;
    assert after_id is null or current_id>after_id,'cursor_not_exclusive';
    assert cardinality(seen)=0 or current_id>seen[cardinality(seen)],'unordered_or_duplicate_id';
    seen:=array_append(seen,current_id);
   end loop;
   assert(page->>'nextAfterRequestId')::uuid=seen[cardinality(seen)],'cursor_not_last_item';
   after_id:=(page->>'nextAfterRequestId')::uuid;
  end loop;
  assert seen=expected,'pagination_lost_or_added_ids';
 end loop;
 assert public.read_member_cleanup_unknown_invocations('ffffffff-ffff-ffff-ffff-ffffffffffff',1)='{"items":[],"nextAfterRequestId":null}'::jsonb;
end;$$;
reset role;
do $$begin
 assert pg_temp.discovery_snapshot()=(select snapshot from discovery_query_before),'discovery_changed_rows_catalog_roles';
 assert(select state='unknown'and claim_calls=0 and not dispatch_started from private.worker_invocations where request_id=pg_temp.discovery_id(1));
 assert(select state='unknown'from private.worker_invocations where request_id=pg_temp.discovery_id(2));
 assert(select token=pg_temp.discovery_id(99)and expires_at<clock_timestamp()from private.global_worker_run where singleton);
 assert not(select enabled from private.worker_runtime_atomic_control where singleton);
 assert not(select external_deletion_approved from private.member_cleanup_guard where singleton);
end;$$;
rollback to savepoint discovery_fixture;
do $$begin
 assert pg_temp.discovery_snapshot()=(select snapshot from discovery_original),'fixture_rollback_changed_existing_rows_catalog_roles';
 assert not has_function_privilege('service_role','public.read_member_cleanup_unknown_invocations(uuid,integer)','EXECUTE');
 assert not(select enabled from private.worker_invocation_control where singleton);
end;$$;
rollback;
