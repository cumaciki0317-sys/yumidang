-- 민규: 기존 본인 숨김 이관과 파기 목적 분리. 기존 보고서·fingerprint는 수정하지 않는다.
begin;
-- 앞선 migration의 INSERT trigger가 동시 신규 접수를 포착한다. 동일 최소키는 멱등 이관한다.
insert into private.member_hidden_targets(identity_id,target_type,target_id)
select distinct ep.identity_id,r.target_type,r.target_id from private.member_reports r
join private.member_episodes ep on ep.id=r.reporter_episode_id where r.hide_target
on conflict(identity_id,target_type,target_id)do nothing;
create temp table hidden_bridge_baseline on commit drop as
select oid,proowner,proacl,proconfig,prosrc from pg_proc where oid in(
 'private.report_purge_eligible(uuid)'::regprocedure,'public.read_worker_queue_schedule(text[],text)'::regprocedure);
do $$declare item record;definition text;anchor text;begin
 for item in select *from hidden_bridge_baseline loop
  -- 정식83의 본인 숨김은 기존 파기 보류 조건이었다. 최소 저장소 이관 후 이 조건만 제거한다.
  anchor:=case when item.oid='private.report_purge_eligible(uuid)'::regprocedure then ' and not r.hide_target'else ' and not r.hide_target'end;
  if(length(item.prosrc)-length(replace(item.prosrc,anchor,'')))/length(anchor)<>1 then
   raise exception 'hidden_bridge_source_changed'using errcode='55000';end if;
  select pg_get_functiondef(item.oid)into definition;
  execute replace(definition,item.prosrc,replace(item.prosrc,anchor,''));
 end loop;
 if exists(select 1 from hidden_bridge_baseline b join pg_proc p on p.oid=b.oid where
 p.proowner<>b.proowner or p.proacl is distinct from b.proacl or p.proconfig is distinct from b.proconfig)then
  raise exception 'hidden_bridge_metadata_changed'using errcode='55000';end if;
end;$$;
-- 원 guard/worker/권한은 그대로 닫힌다. 새로운 직원 열람·신고 제재·재삭제를 추가하지 않는다.
commit;
