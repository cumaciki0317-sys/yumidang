-- SQL119: 합성 행사만 추가하며 기존 source/job 자료를 비우지 않는다. 모든 효과는 rollback한다.
begin;
create function pg_temp.require(ok boolean,label text)returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'event_projection_assertion:%',label;end if;
end;$$;
create function pg_temp.expect_invalid(statement text)returns void language plpgsql as $$begin
 begin execute statement;exception when sqlstate '22023' then return;end;
 raise exception 'event_projection_expected_invalid';
end;$$;
create temp table event_projection_fixture(key text primary key,value jsonb)on commit drop;
grant select on event_projection_fixture to anon,authenticated;
select set_config('request.jwt.claims','{"role":"anon"}',true);
do $$declare base jsonb;detail jsonb;source private.source_events;r jsonb;bad jsonb;
 stamp timestamptz:=clock_timestamp();day date:=(clock_timestamp()at time zone'Asia/Seoul')::date;
 prefix text:='합성투영119-'||gen_random_uuid()::text;sid text:='PFTEST'||replace(gen_random_uuid()::text,'-','');
 cost text:=repeat('가격안내',2500);role_name text;begin
 perform pg_temp.require(length(cost)=10000,'fixture_full_length');
 foreach role_name in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
  perform pg_temp.require(not has_function_privilege(role_name,'private.project_event_source_detail(uuid)','EXECUTE'),'private_helper_closed');
 end loop;
 base:=jsonb_build_object('provider','kopis','sourceId',sid,'sourceStatus','active','title',prefix,
  'category','대중음악','region','서울','placeName','합성 공연장','publicAddress','서울 합성 주소',
  'admission',jsonb_build_object('kind','free'),'sourceUrl',null,'collectedAt',
  to_char(stamp at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'precision','date','startsOn',(day+1)::text,'endsOn',(day+8)::text);
 perform pg_temp.require(private.valid_source_event_v2(base),'base_valid');
 bad:=jsonb_set(base,'{admission}',jsonb_build_object('kind','described','text',cost));
 perform pg_temp.require(private.valid_source_event_v2(bad),'canonical_full_length_valid');
 perform pg_temp.require(not private.valid_source_event_v2(jsonb_set(bad,'{admission,text}',to_jsonb(cost||'가'))),'over_limit_invalid');
 perform pg_temp.require(not private.valid_source_event_v2(jsonb_set(bad,'{admission,text}','"<script>"')),'markup_invalid');
 perform pg_temp.require(not private.valid_source_event_v2(bad||'{"secret":"forbidden"}'::jsonb),'unknown_field_invalid');
 perform private.upsert_canonical_events(jsonb_build_array(base));
 select *into strict source from private.source_events where provider='kopis'and source_id=sid;
 detail:=jsonb_build_object('provider','kopis','sourceId',sid,'collectedAt',
  to_char((stamp+interval'1 minute')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'admission',jsonb_build_object('kind','described','text',cost),
  'operatingInfo','합성 운영 안내','description','합성 상세 설명','posterUrl','https://www.kopis.or.kr/upload/fixture119.jpg');
 perform pg_temp.require(private.merge_event_detail(source,detail),'detail_applied');
 perform pg_temp.require((select record->'admission'from private.source_events where id=source.id)=detail->'admission','canonical_same_full_price');
 perform pg_temp.require((select d.detail->'admission'from private.event_source_details d where d.source_event_id=source.id)=detail->'admission','stored_detail_same_full_price');
 perform pg_temp.require(private.project_event_source_detail(source.id)=detail-array['provider','sourceId','collectedAt','admission'],'detail_public_whitelist');
 perform pg_temp.require(not private.merge_event_detail(source,detail),'same_revision_no_rewrite');
 bad:=jsonb_set(detail,'{posterUrl}','"https://example.com/private"');
 perform pg_temp.expect_invalid(format('select private.merge_event_detail(s,%L::jsonb)from private.source_events s where id=%L::uuid',bad,source.id));
 perform pg_temp.require((select record->'admission'from private.source_events where id=source.id)=detail->'admission','invalid_detail_no_price_change');
 insert into event_projection_fixture values('paidId',to_jsonb(source.id)),('detail',detail),('cost',to_jsonb(cost)),('query',to_jsonb(prefix));
 -- 별도 무료 공연과 오래전에 시작한 진행 중 공연을 사용한다.
 base:=jsonb_set(base,'{sourceId}',to_jsonb(sid||'B'));
 base:=jsonb_set(base,'{title}',to_jsonb(prefix||' 무료'));
 base:=jsonb_set(base,'{category}','"뮤지컬"');
 perform private.upsert_canonical_events(jsonb_build_array(base));
 insert into event_projection_fixture select 'freeId',to_jsonb(id)from private.source_events where source_id=sid||'B'and provider='kopis';
 base:=jsonb_set(base,'{sourceId}',to_jsonb(sid||'C'));
 base:=jsonb_set(base,'{title}',to_jsonb(prefix||' 진행 중'));
 base:=jsonb_set(base,'{category}','"연극"');
 base:=jsonb_set(base,'{startsOn}',to_jsonb((day-40)::text));
 perform private.upsert_canonical_events(jsonb_build_array(base));
 insert into event_projection_fixture select 'ongoingId',to_jsonb(id)from private.source_events where source_id=sid||'C'and provider='kopis';
 insert into event_projection_fixture values('filters',jsonb_build_object('mode','overlapping','query',prefix));
end;$$;
set local role anon;
do $$declare filters jsonb;first_page jsonb;second_page jsonb;result jsonb;paid uuid;full_price text;begin
 select value into filters from event_projection_fixture where key='filters';
 select(value#>>'{}')::uuid into paid from event_projection_fixture where key='paidId';
 select value#>>'{}'into full_price from event_projection_fixture where key='cost';
 result:=public.get_public_event(paid);
 perform pg_temp.require(result#>>'{admission,text}'=full_price,'public_detail_full_price');
 perform pg_temp.require(result->>'operatingInfo'='합성 운영 안내'and result->>'description'='합성 상세 설명','public_detail_extra_fields');
 first_page:=public.list_public_events(filters,null,1);
 second_page:=public.list_public_events(filters,first_page->'nextCursor',1);
 perform pg_temp.require(first_page->'nextCursor'<>'null'::jsonb,'keyset_page_exists');
 perform pg_temp.require(first_page#>>'{items,0,id}'<>second_page#>>'{items,0,id}','keyset_exclusive');
 result:=public.list_public_events(filters,null,50);
 perform pg_temp.require(jsonb_array_length(result->'items')=3,'all_filtered_items');
 perform pg_temp.require((select x#>>'{admission,text}'=full_price and x->>'operatingInfo'='합성 운영 안내'
  from jsonb_array_elements(result->'items')x where x->>'id'=paid::text),'list_same_full_price_and_detail');
 result:=public.list_public_events(filters||'{"freeOnly":true}'::jsonb,null,50);
 perform pg_temp.require(jsonb_array_length(result->'items')=2 and not exists(select 1 from jsonb_array_elements(result->'items')x where x#>>'{admission,kind}'<>'free'),'free_filter_before_page');
 result:=public.list_public_events(filters||'{"performanceGenre":"concert"}'::jsonb,null,50);
 perform pg_temp.require(jsonb_array_length(result->'items')=1 and result#>>'{items,0,id}'=paid::text,'concert_matches_source_genre');
 result:=public.list_public_events(filters||'{"performanceGenre":"musical","freeOnly":true}'::jsonb,null,1);
 perform pg_temp.require(jsonb_array_length(result->'items')=1 and result#>>'{items,0,category}'='뮤지컬','combined_filter_before_page');
 filters:=filters||'{"mode":"new_this_week","includeOngoing":true,"performanceGenre":"play"}'::jsonb;
 result:=public.list_public_events(filters,null,50);
 perform pg_temp.require(jsonb_array_length(result->'items')=1 and result#>>'{items,0,state}'='ongoing','old_start_ongoing_included');
 result:=public.list_public_events(filters-'includeOngoing',null,50);
 perform pg_temp.require(jsonb_array_length(result->'items')=0,'old_start_excluded_without_flag');
 perform pg_temp.expect_invalid('select public.list_public_events(''{"mode":"overlapping","includeOngoing":true}''::jsonb,null,1)');
 perform pg_temp.expect_invalid('select public.list_public_events(''{"mode":"new_this_week","includeOngoing":true,"ongoingOnly":true}''::jsonb,null,1)');
 perform pg_temp.expect_invalid('select public.list_public_events(''{"mode":"overlapping","freeOnly":null}''::jsonb,null,1)');
 perform pg_temp.expect_invalid('select public.list_public_events(''{"mode":"overlapping","performanceGenre":"invented"}''::jsonb,null,1)');
 perform pg_temp.expect_invalid('select public.list_public_events(''{"mode":"overlapping","unknownFlag":true}''::jsonb,null,1)');
end;$$;
reset role;
do $$declare paid uuid;source private.source_events;detail jsonb;begin
 select(value#>>'{}')::uuid into paid from event_projection_fixture where key='paidId';
 select value into detail from event_projection_fixture where key='detail';
 update private.source_events set collected_at=collected_at+interval'2 hours',
  record=jsonb_set(record,'{collectedAt}',to_jsonb(to_char((collected_at+interval'2 hours')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))where id=paid;
 perform pg_temp.require(private.project_event_source_detail(paid)='{}'::jsonb,'stale_source_detail_hidden');
 perform pg_temp.require(not(public.get_public_event(paid)?'operatingInfo'),'stale_public_extra_hidden');
 -- 이미 저장된 사실 가격은 unknown/free로 치환하지 않는다.
 perform pg_temp.require(public.get_public_event(paid)#>>'{admission,kind}'='described','stale_detail_not_false_free');
 select *into strict source from private.source_events where id=paid;
 detail:=jsonb_set(detail,'{collectedAt}',to_jsonb(to_char((source.collected_at+interval'1 minute')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
 perform pg_temp.require(private.merge_event_detail(source,detail),'new_source_detail_applied');
 perform pg_temp.require(public.get_public_event(paid)->>'operatingInfo'='합성 운영 안내','new_source_detail_visible');
end;$$;
-- 합성 SQL claims만 사용한다. Auth 로그인·실제 가입·공급사 호출의 증거가 아니다.
-- 개인정보 없이 새 identity/episode 두 개를 만들며 기존 회원·숨김 자료는 변경하지 않는다.
do $$declare paid uuid;viewer uuid:=gen_random_uuid();other_viewer uuid:=gen_random_uuid();
 hidden_subject text:='event119-hidden-'||gen_random_uuid()::text;
 other_subject text:='event119-other-'||gen_random_uuid()::text;hidden_identity uuid;other_identity uuid;begin
 select(value#>>'{}')::uuid into paid from event_projection_fixture where key='paidId';
 perform pg_temp.require(not exists(select 1 from private.member_episodes where profile_id in(viewer,other_viewer)),'fresh_episode_ids');
 -- user_id는 NULL이다. 실제 Auth 계정이나 공개 profile을 생성하지 않는 숨김 join 전용 fixture다.
 insert into private.naver_accounts(subject,verification_status)values(hidden_subject,'information_required'),(other_subject,'information_required');
 select id into strict hidden_identity from private.naver_identity_keys where subject=hidden_subject;
 select id into strict other_identity from private.naver_identity_keys where subject=other_subject;
 insert into private.member_episodes(profile_id,identity_id)values(viewer,hidden_identity),(other_viewer,other_identity);
 insert into private.member_hidden_targets(identity_id,target_type,target_id)values(hidden_identity,'event',paid);
 insert into event_projection_fixture values('hiddenViewer',to_jsonb(viewer)),('otherViewer',to_jsonb(other_viewer)),
  ('anonEvent',public.get_public_event(paid)),
  ('anonList',public.list_public_events((select value from event_projection_fixture where key='filters'),null,10));
 perform pg_temp.require(private.project_post_linked_event(paid)=public.get_public_event(paid),'direct_linked_projection_same_detail');
end;$$;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',
 (select value#>>'{}'from event_projection_fixture where key='hiddenViewer'),'is_anonymous',false)::text,true);
set local role authenticated;
do $$declare paid uuid;unavailable boolean:=false;result jsonb;begin
 select(value#>>'{}')::uuid into paid from event_projection_fixture where key='paidId';
 begin perform public.get_public_event(paid);exception when sqlstate 'PT404' then unavailable:=true;end;
 perform pg_temp.require(unavailable,'own_hidden_detail_pt404');
 result:=public.list_public_events((select value from event_projection_fixture where key='filters'),null,10);
 perform pg_temp.require(jsonb_array_length(result->'items')=2 and not exists(
  select 1 from jsonb_array_elements(result->'items')x where x->>'id'=paid::text),'own_hidden_list_omits_target');
end;$$;
reset role;
do $$declare paid uuid;begin
 select(value#>>'{}')::uuid into paid from event_projection_fixture where key='paidId';
 perform pg_temp.require(private.member_content_hidden('event',paid),'own_hidden_identity_join');
 perform pg_temp.require(private.project_post_linked_event(paid)is null,'own_hidden_linked_projection_null');
end;$$;
select set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',
 (select value#>>'{}'from event_projection_fixture where key='otherViewer'),'is_anonymous',false)::text,true);
set local role authenticated;
do $$declare paid uuid;begin
 select(value#>>'{}')::uuid into paid from event_projection_fixture where key='paidId';
 perform pg_temp.require(public.get_public_event(paid)=(select value from event_projection_fixture where key='anonEvent'),'other_member_detail_unchanged');
 perform pg_temp.require(public.list_public_events((select value from event_projection_fixture where key='filters'),null,10)=
  (select value from event_projection_fixture where key='anonList'),'other_member_list_unchanged');
end;$$;
reset role;
do $$declare paid uuid;begin
 select(value#>>'{}')::uuid into paid from event_projection_fixture where key='paidId';
 perform pg_temp.require(private.project_post_linked_event(paid)=(select value from event_projection_fixture where key='anonEvent'),'other_member_linked_projection_unchanged');
end;$$;
select set_config('request.jwt.claims','{"role":"anon"}',true);
set local role anon;
do $$declare paid uuid;begin
 select(value#>>'{}')::uuid into paid from event_projection_fixture where key='paidId';
 perform pg_temp.require(public.get_public_event(paid)=(select value from event_projection_fixture where key='anonEvent'),'anon_detail_unchanged');
 perform pg_temp.require(public.list_public_events((select value from event_projection_fixture where key='filters'),null,10)=
  (select value from event_projection_fixture where key='anonList'),'anon_list_unchanged');
end;$$;
reset role;
rollback;
