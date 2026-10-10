-- SQL103: DB확정 결과의 상세만30일 뒤 정리. 최소키·미확정은 임의 TTL 삭제하지 않는다.
begin;
create function public.read_worker_runtime_retention_schedule()returns jsonb language plpgsql volatile security definer set search_path=''as $$declare due timestamptz;begin
 perform private.assert_worker_runtime_atomic();
 select min(closed_at+interval'720 hours')into due from private.worker_runtime_results where state='completed';
 return jsonb_build_object('serverNow',clock_timestamp(),'nextDueAt',due);
end;$$;
create function public.purge_worker_runtime_details(p_global_token uuid,p_limit integer)returns jsonb language plpgsql volatile security definer set search_path=''as $$declare removed integer;begin
 perform private.assert_worker_runtime_atomic();perform private.assert_current_worker_run(p_global_token);
 if p_limit is null or p_limit not between 1 and 20 then raise exception 'invalid_runtime_limit'using errcode='22023';end if;
 with due as(select request_id from private.worker_runtime_results where state='completed'and closed_at+interval'720 hours'<=clock_timestamp()order by closed_at,request_id limit p_limit for update skip locked)
 update private.worker_runtime_results r set input=null,result=null,state='purged',purged_at=clock_timestamp()from due where r.request_id=due.request_id;
 get diagnostics removed=row_count;
 perform private.assert_current_worker_run(p_global_token);
 return jsonb_build_object('purged',removed);
end;$$;
create function private.notify_worker_runtime_retention()returns trigger language plpgsql security definer set search_path=''as $$begin
 perform pg_notify('yumidang_worker_jobs','');return null;
end;$$;
create trigger worker_runtime_retention_changed after insert or update or delete on private.worker_runtime_results for each statement execute function private.notify_worker_runtime_retention();
do $$declare own text;f record;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 for f in select oid::regprocedure sig from pg_proc where proname in('read_worker_runtime_retention_schedule','purge_worker_runtime_details','notify_worker_runtime_retention')and pronamespace in('public'::regnamespace,'private'::regnamespace)loop
 execute format('alter function %s owner to %I',f.sig,own);execute format('revoke all on function %s from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue',f.sig);end loop;
end;$$;
-- 최소키 삭제·운영 활성화는 재요청 가능기간의 검증 조건을 충족하기 전 닫힘.
commit;

-- 최소 식별자·fence만 반환하는 읽기 전용 복구 페이지. 자동 dispatch 권한이 아니다.
begin;
create function public.read_worker_runtime_recovery(p_after_request_id uuid default null,p_limit integer default 20)returns jsonb
 language plpgsql volatile security definer set search_path=''as $$declare rows jsonb;cursor uuid;begin
 perform private.assert_worker_runtime_atomic();
 if p_limit is null or p_limit not between 1 and 20 then raise exception 'invalid_runtime_limit'using errcode='22023';end if;
 select coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'globalToken',global_token,'operation',operation,'input',input,'createdAt',created_at)order by request_id),'[]'::jsonb)into rows
 from(select *from private.worker_runtime_results where state='external_pending'and(p_after_request_id is null or request_id>p_after_request_id)order by request_id limit p_limit)r;
 if jsonb_array_length(rows)=p_limit then cursor:=(rows->(p_limit-1)->>'requestId')::uuid;end if;
 return jsonb_build_object('pending',rows,'nextCursor',cursor);
end;$$;
do $$declare own text;begin
 select pg_get_userbyid(proowner)into strict own from pg_proc where oid='public.read_worker_queue_schedule(text[],text)'::regprocedure;
 execute format('alter function public.read_worker_runtime_recovery(uuid,integer)owner to %I',own);
 revoke all on function public.read_worker_runtime_recovery(uuid,integer)from public,anon,authenticated,service_role,authenticator,yumidang_worker_queue;
end;$$;
commit;
