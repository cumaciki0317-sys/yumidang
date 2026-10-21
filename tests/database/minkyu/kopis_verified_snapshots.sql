-- 합성 SQL 역할 검증 fixture. 실제 Auth·공급사·공식 관측·제품 게시가 아니다.
begin;
set local plpgsql.check_asserts=on;
do $$declare owner_name text;f regprocedure;t regclass;begin
 select pg_get_userbyid(proowner)into owner_name from pg_proc where oid='public.complete_event_ranking_collection(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure;
 foreach f in array array['public.publish_verified_kopis_snapshot(jsonb)'::regprocedure,'public.mark_verified_kopis_refresh_failed(text,timestamptz,timestamptz)'::regprocedure,'public.get_verified_kopis_ranking(text)'::regprocedure]loop
  assert(select pg_get_userbyid(proowner)=owner_name and prosecdef from pg_proc where oid=f),'SECDEF owner mismatch';
 end loop;
 foreach t in array array['private.kopis_verified_categories'::regclass,'private.kopis_verified_snapshots'::regclass]loop
  assert(select relrowsecurity and relforcerowsecurity and pg_get_userbyid(relowner)=owner_name from pg_class where oid=t),'RLS owner mismatch';
  assert not has_table_privilege('anon',t,'SELECT')and not has_table_privilege('authenticated',t,'INSERT')and not has_table_privilege('service_role',t,'INSERT'),'direct table privilege';
 end loop;
 assert not has_function_privilege('anon','public.publish_verified_kopis_snapshot(jsonb)','EXECUTE');
 assert not has_function_privilege('authenticated','public.mark_verified_kopis_refresh_failed(text,timestamptz,timestamptz)','EXECUTE');
 assert(select count(*)=14 from private.kopis_verified_categories);
 assert not exists(select 1 from private.kopis_verified_snapshots),'fixture requires fresh verified storage';
end;$$;
set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$declare r jsonb;begin
 r:=public.get_verified_kopis_ranking('all');assert r->>'status'='unavailable'and r->'period'='null'::jsonb and r->'items'='[]'::jsonb;
 assert r->>'officialUrl'='https://www.kopis.or.kr/por/boxoffice/boxoffice.do';
 begin perform public.publish_verified_kopis_snapshot('{"verified":true}');raise exception 'unexpected permission';exception when insufficient_privilege then null;end;
end;$$;
reset role;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $$declare s jsonb;r jsonb;now_at timestamptz:=clock_timestamp();last_period jsonb;old_checked timestamptz;begin
 s:=jsonb_build_object('status','available','mode','all','sourceName','KOPIS','period',jsonb_build_object(
  'start',((now_at at time zone'Asia/Seoul')::date-7)::text,'end',((now_at at time zone'Asia/Seoul')::date-1)::text),
  'collectedAt',to_char(now_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'checkedAt',to_char(now_at at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'refreshDelayed',false,'officialCondition','전체 공연','apiPeriodVerified',false,
  'officialUrl','https://www.kopis.or.kr/por/boxoffice/boxoffice.do','items',jsonb_build_array(
   jsonb_build_object('rank',1,'sourceId','PFTEST1','title','합성 공연','genre','뮤지컬','originalGenre','뮤지컬','performancePeriodText','합성 기간','placeName','가상 극장','region','서울')));
 begin perform public.publish_verified_kopis_snapshot('{"verified":true}');raise exception 'unexpected unsigned shape';exception when invalid_parameter_value then null;end;
 old_checked:=(s->>'checkedAt')::timestamptz;
 r:=public.publish_verified_kopis_snapshot(s);assert r->>'status'='applied';
 assert(public.publish_verified_kopis_snapshot(s)->>'status')='stale';
 r:=public.get_verified_kopis_ranking('all');last_period:=r->'period';assert r->>'status'='available'and not(r?'officialCondition')and not(r?'apiPeriodVerified');
 perform public.mark_verified_kopis_refresh_failed('all',clock_timestamp(),(s->>'checkedAt')::timestamptz);r:=public.get_verified_kopis_ranking('all');
 assert r->'period'=last_period and r->'refreshDelayed'='true'::jsonb,'failed refresh changed verified period';
 assert(public.get_verified_kopis_ranking('musical')->>'status')='unavailable','category state leaked';
 -- 성공 B가 old A의 checkedAt을 대체한 뒤 A 실패는 stale이어야 한다.
 s:=jsonb_set(s,'{checkedAt}',to_jsonb(to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 perform pg_sleep(0.002);
 s:=jsonb_set(s,'{checkedAt}',to_jsonb(to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 assert(public.publish_verified_kopis_snapshot(s)->>'status')='applied';
 assert(public.mark_verified_kopis_refresh_failed('all',clock_timestamp(),old_checked)->>'status')='stale';
 assert(public.get_verified_kopis_ranking('all')->'refreshDelayed')='false'::jsonb,'old failure overwrote new success';

 begin perform public.publish_verified_kopis_snapshot(jsonb_set(s,'{period,end}',to_jsonb(((now_at at time zone'Asia/Seoul')::date)::text)));raise exception 'unexpected invalid period';exception when invalid_parameter_value then null;end;
 assert(public.get_verified_kopis_ranking('all')->'period')=last_period;
end;$$;
rollback;
