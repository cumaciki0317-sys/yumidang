-- 민규: 합성 공식 순위 계약 5그룹. 실제 KOPIS 결과나 공급사 기간 검증을 대체하지 않는다.
begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);

create function pg_temp.ranking_fixture(p_mode text default 'all',p_time text default '2026-10-02T01:00:00.000Z',p_count integer default 2)
returns jsonb language sql immutable as $$
  select jsonb_build_object('mode',p_mode,'requestedPeriod',jsonb_build_object('start','2026-09-25','end','2026-10-01'),
    'collectedAt',p_time,'items',(select jsonb_agg(jsonb_build_object('rank',n,'sourceId','OPAQUE-pf:'||n,
      'title','합성공연 '||n,'genre',case when p_mode='musical' then '뮤지컬' else '연극' end,
      'performancePeriodText','2026.09.01 ~ 2026.11.01','placeName','합성공연장','region','서울') order by n)
      from generate_series(1,p_count) n));
$$;
create function pg_temp.expect_ranking_rejected(p_value jsonb,p_state text default '22023')
returns void language plpgsql as $$
declare rejected boolean:=false;
begin
  begin perform public.store_kopis_top10_snapshot(p_value);
  exception when others then
    if sqlstate<>p_state then raise; end if; rejected:=true;
  end;
  assert rejected,'invalid snapshot accepted';
end; $$;

-- 1. 입력 구조·공식 순위·실제 날짜 경계와 임의 필드 거절.
do $$ declare v jsonb:=pg_temp.ranking_fixture(); x jsonb; begin
  assert not exists(select 1 from private.kopis_top10_snapshots),'fixture target must be empty';
  perform pg_temp.expect_ranking_rejected(null);
  perform pg_temp.expect_ranking_rejected('[]');
  perform pg_temp.expect_ranking_rejected(v||'{"basedate":"invented"}');
  perform pg_temp.expect_ranking_rejected(v-'mode');
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{mode}','"weekly"'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{requestedPeriod,start}','"2026-02-30"'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{requestedPeriod,end}','"2026-09-24"'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{requestedPeriod,end}','"2026-10-26"'));
  assert private.valid_kopis_top10_snapshot(jsonb_set(v,'{requestedPeriod,end}','"2026-10-25"')),'upstream 31-day boundary rejected';
  assert private.valid_kopis_top10_snapshot(jsonb_set(v,'{requestedPeriod,end}','"2026-09-25"')),'same-day technical request rejected';
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{requestedPeriod}','{"start":"2026-09-25","end":"2026-10-01","verified":true}'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{collectedAt}','"infinity"'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{collectedAt}','null'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{items}','[]'));
  perform pg_temp.expect_ranking_rejected(pg_temp.ranking_fixture('all','2026-10-02T01:00:00.000Z',11));
  foreach x in array array['"1"'::jsonb,'1.5'::jsonb,'1e1000'::jsonb,'null'::jsonb] loop
    perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{items,0,rank}',x));
  end loop;
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{items,1,rank}','3'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{items,1,sourceId}',v#>'{items,0,sourceId}'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{items,0,performancePeriodText}','"2026.02.30~2026.11.01"'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{items,0,performancePeriodText}','"2026.12.01~2026.11.01"'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{items,0,title}','"<script>invalid</script>"'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{items,0}',(v#>'{items,0}')||'{"sales":999,"canSelect":true}'));
  perform pg_temp.expect_ranking_rejected(jsonb_set(pg_temp.ranking_fixture('musical'),'{items,0,genre}','"연극"'));
  assert not exists(select 1 from private.kopis_top10_snapshots),'invalid input wrote data';
end $$;
select 'PASS rankings_wire_rank_date';

-- 2. 마지막 항목의 실패도 기존 전체 수집본을 보존한다.
do $$ declare v jsonb:=pg_temp.ranking_fixture(); result jsonb; begin
  result:=public.store_kopis_top10_snapshot(v);
  assert result='{"status":"saved","itemCount":2,"deduplicated":false}'::jsonb;
  perform pg_temp.expect_ranking_rejected(jsonb_set(pg_temp.ranking_fixture('all','2026-10-02T02:00:00.000Z'),'{items,1,region}','null'));
  assert (select snapshot from private.kopis_top10_snapshots where mode='all')=v,'partial overwrite';
  assert (select count(*) from private.kopis_top10_snapshots)=1;
end $$;
select 'PASS rankings_atomic_batch';

-- 3. 동일 입력 재시도·같은 시각의 충돌·낡은 입력·최신 갱신.
do $$ declare v jsonb:=pg_temp.ranking_fixture(); newer jsonb:=pg_temp.ranking_fixture('all','2026-10-02T02:00:00.000Z',3); result jsonb; begin
  result:=public.store_kopis_top10_snapshot(v);
  assert result->>'status'='saved' and result->>'deduplicated'='true';
  perform pg_temp.expect_ranking_rejected(jsonb_set(v,'{items,0,title}','"다른 합성공연"'),'40001');
  result:=public.store_kopis_top10_snapshot(pg_temp.ranking_fixture('all','2026-10-02T00:00:00.000Z',1));
  assert result->>'status'='stale' and result->>'itemCount'='2' and result->>'deduplicated'='false';
  assert (select snapshot from private.kopis_top10_snapshots where mode='all')=v;
  result:=public.store_kopis_top10_snapshot(newer);
  assert result->>'status'='saved' and result->>'itemCount'='3';
  assert (select snapshot from private.kopis_top10_snapshots where mode='all')=newer;
  assert (select count(*) from private.kopis_top10_snapshots)=1,'history accumulated';
end $$;
select 'PASS rankings_latest_retry_stale';

-- 4. 두 모드 분리·공식 rank/opaque ID/원문 공개 필드 보존·기간 확인 한계.
do $$ declare v jsonb:=pg_temp.ranking_fixture('musical','2026-10-02T01:00:00.000Z',10); result jsonb; rejected boolean:=false; begin
  result:=public.get_kopis_top10_snapshot('musical');
  assert result->>'status'='unavailable' and result->'requestedPeriod'='null'::jsonb and result->'items'='[]'::jsonb;
  perform public.store_kopis_top10_snapshot(v);
  result:=public.get_kopis_top10_snapshot('musical');
  assert result->>'status'='available' and result->>'mode'='musical' and result->>'source'='kopis';
  assert result->'items'=v->'items' and result#>>'{items,9,rank}'='10' and result#>>'{items,0,sourceId}'='OPAQUE-pf:1';
  assert result->'requestedPeriod'=v->'requestedPeriod' and result->'collectedAt'=v->'collectedAt';
  assert result->'responsePeriod'='null'::jsonb and result->>'periodVerification'='requested_only';
  assert jsonb_array_length(public.get_kopis_top10_snapshot('all')->'items')=3;
  assert (select count(*) from private.kopis_top10_snapshots)=2;
  begin perform public.get_kopis_top10_snapshot(null); exception when sqlstate '22023' then rejected:=true; end;
  assert rejected,'null mode accepted';
end $$;
select 'PASS rankings_modes_rank_preserved';

-- 5. 실제 역할 ACL 및 private 직접 접근·역할 claim 경계.
do $$ declare role_name text; begin
  foreach role_name in array array['anon','authenticated'] loop
    assert not has_function_privilege(role_name,'public.store_kopis_top10_snapshot(jsonb)','execute');
    assert not has_function_privilege(role_name,'public.get_kopis_top10_snapshot(text)','execute');
    assert not has_function_privilege(role_name,'private.valid_kopis_top10_snapshot(jsonb)','execute');
    assert not has_table_privilege(role_name,'private.kopis_top10_snapshots','select,insert,update,delete');
  end loop;
  assert has_function_privilege('service_role','public.store_kopis_top10_snapshot(jsonb)','execute');
  assert has_function_privilege('service_role','public.get_kopis_top10_snapshot(text)','execute');
  assert not has_table_privilege('service_role','private.kopis_top10_snapshots','select,insert,update,delete');
end $$;
set local role anon;
do $$ declare rejected boolean:=false; begin
  begin perform public.get_kopis_top10_snapshot('all'); exception when insufficient_privilege then rejected:=true; end;
  assert rejected,'anon RPC executed';
end $$;
reset role;
set local role authenticated;
do $$ declare rejected boolean:=false; begin
  begin perform public.store_kopis_top10_snapshot('{}'); exception when insufficient_privilege then rejected:=true; end;
  assert rejected,'member writer executed';
end $$;
reset role;
set local role service_role;
do $$ declare rejected boolean:=false; begin
  assert public.get_kopis_top10_snapshot('all')->>'status'='available';
  begin perform count(*) from private.kopis_top10_snapshots; exception when insufficient_privilege then rejected:=true; end;
  assert rejected,'service directly read private table';
end $$;
reset role;
select set_config('request.jwt.claims','{}',true);
do $$ declare rejected boolean:=false; begin
  begin perform public.get_kopis_top10_snapshot('all'); exception when insufficient_privilege then rejected:=true; end;
  assert rejected,'missing service claim bypassed';
end $$;
select 'PASS rankings_acl_internal_only';
rollback;
