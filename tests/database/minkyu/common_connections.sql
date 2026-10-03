-- 종현 공통 연결의 실제 DB 역할 검증. 외부 모델 호출/실제 원문 사용 없이 전체 rollback.
begin;
create function pg_temp.common_uid(n integer) returns uuid language sql immutable as $$
 select ('71000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.common_actor(n integer) returns void language plpgsql as $$
begin
 perform set_config('request.jwt.claim.sub',pg_temp.common_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.common_uid(n))::text,true);
end; $$;
create function pg_temp.common_expect(command text,expected text[]) returns void language plpgsql as $$
declare code text;begin
 begin execute command;exception when others then get stacked diagnostics code=returned_sqlstate;end;
 assert code=any(expected),'unexpected common connection state';
end; $$;
create function pg_temp.common_event(source text,title text,start_day integer,end_day integer,status text default 'active')
returns jsonb language sql stable as $$
 select jsonb_build_object('provider','common-synthetic','sourceId',source,'sourceStatus',status,'title',title,
  'category','전시','region','가상시','placeName','Art Hall','publicAddress','가상시 합성주소',
  'admission',jsonb_build_object('kind','unknown'),'sourceUrl',null,'collectedAt','2026-10-02T00:00:00.000Z',
  'precision','date','startsOn',to_char((now() at time zone 'Asia/Seoul')::date+start_day,'YYYY-MM-DD'),
  'endsOn',to_char((now() at time zone 'Asia/Seoul')::date+end_day,'YYYY-MM-DD'));
$$;
create temp table common_probe(name text primary key,job_id uuid,lease uuid,revision text,ids uuid[],checkpoint jsonb,published jsonb,me jsonb);
grant all on common_probe to service_role,authenticated;

set local role service_role;
do $$ declare a uuid;b uuid;r jsonb;led jsonb;begin
 perform pg_temp.common_expect('select public.reserve_ai_budget(''common-missing'',''potens'',''intent'',1)',array['P0002']);
 perform public.configure_ai_budget_ledger('common-budget',100,3);
 a:=(public.reserve_ai_budget('common-budget','potens','intent',60)->>'reservationId')::uuid;
 assert a is not null;
 assert public.reserve_ai_budget('common-budget','potens','intent',41)->'reservationId'='null'::jsonb;
 b:=(public.reserve_ai_budget('common-budget','potens','review_chunk',40)->>'reservationId')::uuid;
 assert public.settle_ai_budget(a,'usage_reported',20,5)->>'settled'='true';
 perform public.settle_ai_budget(b,'usage_unknown',null,null);
 led:=public.get_ai_budget_ledger('common-budget');assert led->>'chargedUnits'='65' and led->>'reservedUnits'='0' and led->>'unknownUsageCalls'='1';
 perform pg_temp.common_expect(format('select public.settle_ai_budget(%L,''usage_unknown'',null,null)',b),array['P0001']);
 perform public.reserve_ai_budget('common-budget','potens','intent',1);
 assert public.reserve_ai_budget('common-budget','potens','intent',1)->'reservationId'='null'::jsonb;
 perform public.configure_ai_budget_ledger('common-overflow',9223372036854775807,9223372036854775807);
 a:=(public.reserve_ai_budget('common-overflow','potens','intent',9223372036854775806)->>'reservationId')::uuid;
 assert a is not null;
 assert public.reserve_ai_budget('common-overflow','potens','intent',2)->'reservationId'='null'::jsonb;
 perform pg_temp.common_expect(format('select public.settle_ai_budget(%L,''usage_reported'',9223372036854775807,1)',a),array['22023']);
 assert public.get_ai_budget_ledger('common-overflow')->>'reservedUnits'='9223372036854775806';
 perform public.settle_ai_budget(a,'usage_unknown',null,null);
end $$;
reset role;
select 'ORDERED_CHECK:budget_limits_settlement_overflow';

do $$ declare fn text;begin
 foreach fn in array array['public.reserve_ai_budget(text,text,text,bigint)','public.settle_ai_budget(uuid,text,bigint,bigint)',
  'public.save_review_summary_checkpoint(uuid,uuid,text,jsonb)','public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text)',
  'public.mark_review_summary_insufficient(uuid,uuid,text)','public.yield_job(uuid,uuid,timestamptz)','public.fail_job(uuid,uuid,text)','public.supersede_job(uuid,uuid)'] loop
  assert has_function_privilege('service_role',fn,'EXECUTE');
  assert not has_function_privilege('authenticated',fn,'EXECUTE');assert not has_function_privilege('anon',fn,'EXECUTE');
 end loop;
 assert not has_table_privilege('service_role','private.review_summary_checkpoints','SELECT');
 assert not has_table_privilege('authenticated','private.ai_budget_ledgers','UPDATE');
 assert not has_function_privilege('service_role','private.review_summary_checkpoint_shape_ok(jsonb)','EXECUTE');
 assert not exists(select 1 from information_schema.columns where table_schema='private' and table_name in('ai_budget_ledgers','ai_budget_reservations')
  and column_name~'(prompt|message|text|user)');
end $$;
set local role authenticated;
do $$ begin perform pg_temp.common_expect('select public.reserve_ai_budget(''common-budget'',''potens'',''intent'',1)',array['42501']);end $$;
reset role;
select 'ORDERED_CHECK:common_internal_permissions';

-- 기존 완료된 합성 약속: 한마디3개+한마디없는평가1개. 비네이버 후속 조회/후기 이력을 유지한다.
do $$ declare i integer;p uuid;r uuid;ap uuid;begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into auth.users(id) values(pg_temp.common_uid(1)),(pg_temp.common_uid(2)),(pg_temp.common_uid(3));
 insert into public.profiles(id,real_name,birth_date,gender,bio) values
  (pg_temp.common_uid(1),'합성 후기작성자','1990-01-01','female','합성 소개'),
  (pg_temp.common_uid(2),'합성 요약대상자','1990-01-01','female','합성 소개'),
  (pg_temp.common_uid(3),'합성 공개조회자','1990-01-01','female',null);
 for i in 1..4 loop
  p:=gen_random_uuid();r:=gen_random_uuid();ap:=gen_random_uuid();
  insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
   values(p,pg_temp.common_uid(1),'합성 공통 연결','로컬 검증 자료','산책',now()-interval '4 days',now()-interval '3 days',now()-interval '5 days','서울특별시 강남구 역삼동','closed');
  insert into public.join_requests(id,post_id,requester_id,message,status) values(r,p,pg_temp.common_uid(2),'합성 공통 연결 후기 자료입니다','matched');
  insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
   values(ap,p,r,'completed',now()-interval '2 days','automatic',now(),now()+interval '24 hours',now()+interval '5 days');
  insert into public.appointment_reviews(appointment_id,reviewer_id,rating,comment,experience)
   values(ap,pg_temp.common_uid(1),5,case when i<4 then 'COMMON_SYNTHETIC_REVIEW_'||i else null end,'positive');
 end loop;
end $$;
set local role service_role;
do $$ declare s jsonb;j uuid;t uuid;ids uuid[];cp jsonb;x jsonb;begin
 s:=public.load_public_review_snapshot(pg_temp.common_uid(2));assert s->>'eligibleCount'='3';
 select array_agg((v->>'reviewId')::uuid order by v->>'reviewId') into ids from jsonb_array_elements(s->'reviews') v;
 j:=(public.enqueue_job('review_summary','common-publish',jsonb_build_object('profileId',pg_temp.common_uid(2),
  'sourceRevision',s->>'sourceRevision','modelVersion','common-model','promptVersion','common-prompt'),clock_timestamp())->>'jobId')::uuid;
 x:=public.claim_job(gen_random_uuid(),60)->'job';assert (x->>'jobId')::uuid=j and x->>'failedAttempts'='0';t:=(x->>'leaseToken')::uuid;
 cp:=jsonb_build_object('schemaVersion',1,'sourceReviewIds',to_jsonb(ids),'nextReviewIndex',1,'nodes',jsonb_build_array(
  jsonb_build_object('sourceReviewIds',to_jsonb(ids[1:1]),'claims',jsonb_build_array(jsonb_build_object('text','합성 중간 주장','evidenceIds',to_jsonb(ids[1:1]))),
   'modelVersions',jsonb_build_array('potens.synthetic'))));
 assert public.load_review_summary_source(j,t)->>'status'='applied';
 assert public.save_review_summary_checkpoint(j,t,s->>'sourceRevision',cp)->>'status'='applied';
 assert public.save_review_summary_checkpoint(j,gen_random_uuid(),s->>'sourceRevision',cp)->>'status'='lease_lost';
 perform pg_temp.common_expect(format('select public.save_review_summary_checkpoint(%L,%L,%L,%L::jsonb)',j,t,s->>'sourceRevision',cp||jsonb_build_object('reviews','합성 원문')),array['22023']);
 x:=public.publish_review_summary_for_job(j,t,s->>'sourceRevision',ids,'합성 공개 요약','common-model','common-prompt');assert x->>'status'='applied';
 assert public.publish_review_summary_for_job(j,t,s->>'sourceRevision',ids,'중복 요청 다른 요약','common-model','common-prompt')=x;
 insert into common_probe(name,job_id,lease,revision,ids,checkpoint,published) values('published',j,t,s->>'sourceRevision',ids,cp,x);
 assert public.complete_job(j,t)->>'status'='succeeded';
end $$;
reset role;
do $$ begin
 assert not exists(select 1 from private.review_summary_checkpoints where job_id=(select job_id from common_probe where name='published'));
 assert (select count(*) from private.review_summary_job_publications where job_id=(select job_id from common_probe where name='published'))=1;
end $$;
select 'ORDERED_CHECK:worker_checkpoint_lease_publish';

set local role service_role;
do $$ declare s jsonb;j uuid;t uuid;cp jsonb;begin
 s:=public.load_public_review_snapshot(pg_temp.common_uid(2));cp:=(select checkpoint from common_probe where name='published');
 j:=(public.enqueue_job('review_summary','common-revision',jsonb_build_object('profileId',pg_temp.common_uid(2),
  'sourceRevision',s->>'sourceRevision','modelVersion','common-revision','promptVersion','common-prompt'),clock_timestamp())->>'jobId')::uuid;
 t:=(public.claim_job(gen_random_uuid(),60)->'job'->>'leaseToken')::uuid;
 assert public.save_review_summary_checkpoint(j,t,s->>'sourceRevision',cp)->>'status'='applied';
 insert into common_probe(name,job_id,lease,revision,checkpoint) values('revision',j,t,s->>'sourceRevision',cp);
end $$;
reset role;
update public.appointment_reviews set comment='수정된 합성 원문' where id=(select ids[1] from common_probe where name='published');
do $$ begin
 assert (select comment='수정된 합성 원문' from public.appointment_reviews where id=(select ids[1] from common_probe where name='published')),'synthetic_review_mutation_applied';
 assert not exists(select 1 from private.review_summary_checkpoints where job_id=(select job_id from common_probe where name='revision')),'checkpoint_deleted_after_review_mutation';
 assert (select visible_summary_id is null from private.review_summary_state where profile_id=pg_temp.common_uid(2)),'summary_hidden_after_review_mutation';
end $$;
set local role service_role;
do $$ declare c common_probe;s jsonb;begin
 select * into c from common_probe where name='revision';s:=public.load_review_summary_source(c.job_id,c.lease);
 -- 원문 조회는 최신 snapshot을 반환한다. 작업 revision과 비교해 대체하고 이전 revision 쓰기는 거절한다.
 assert s->>'status'='applied' and (s->>'sourceRevision')::bigint>c.revision::bigint;
 assert public.save_review_summary_checkpoint(c.job_id,c.lease,c.revision,c.checkpoint)->>'status'='stale_revision';
 assert public.supersede_job(c.job_id,c.lease)->>'status'='superseded';
 perform public.set_review_publication((select ids[1] from common_probe where name='published'),false);
end $$;
reset role;
select 'ORDERED_CHECK:worker_revision_checkpoint_invalidation';

set local role service_role;
do $$ declare n integer;s jsonb;j uuid;t uuid;begin
 for n in 2..3 loop
  s:=public.load_public_review_snapshot(pg_temp.common_uid(n));assert s->>'eligibleCount'=case when n=2 then '2' else '0' end;
  j:=(public.enqueue_job('review_summary','common-insufficient-'||n,jsonb_build_object('profileId',pg_temp.common_uid(n),
   'sourceRevision',s->>'sourceRevision','modelVersion','common-model','promptVersion','common-prompt'),clock_timestamp())->>'jobId')::uuid;
  t:=(public.claim_job(gen_random_uuid(),60)->'job'->>'leaseToken')::uuid;
  assert public.mark_review_summary_insufficient(j,t,s->>'sourceRevision')->>'status'='applied';
  assert public.complete_job(j,t)->>'status'='succeeded';
 end loop;
end $$;
reset role;
select 'ORDERED_CHECK:worker_empty_insufficient';

-- 물리 저장은 source_events 하나이고 events는 typed VIEW다. null URL/동일 시각 stale/v1호환.
set local role service_role;
do $$ declare e jsonb;x jsonb;begin
 e:=pg_temp.common_event('ongoing','가상 진행 전시',-2,2);
 assert public.upsert_events(jsonb_build_array(e))->>'insertedCount'='1';
 assert public.upsert_events(jsonb_build_array(e))->>'staleCount'='1';
 assert public.upsert_source_events_v1(jsonb_build_array(e))->>'savedCount'='0';
 x:=jsonb_set(e,'{sourceUrl}','"https://example.invalid/events?api_key=synthetic"');
 perform pg_temp.common_expect(format('select public.upsert_events(%L::jsonb)',jsonb_build_array(x)),array['22023']);
 x:=jsonb_set(e,'{collectedAt}','"2026-10-03T00:00:00.000Z"');
 assert public.upsert_events(jsonb_build_array(x))->>'updatedCount'='1';
 perform public.upsert_events(jsonb_build_array(pg_temp.common_event('upcoming','가상 예정 전시',3,4),
  pg_temp.common_event('ended','가상 종료 전시',-10,-8),pg_temp.common_event('cancelled','가상 취소 전시',-1,1,'cancelled')));
 -- 구 v1 제공처 ID는 원본 저장/조회에서 보존하고 새 reader의 목록·필터에서만 제외한다.
 x:=pg_temp.common_event('legacy','보존할 합성 이전 행사',1,2)||jsonb_build_object(
  'provider','demo_provider','region','합성 이전 지역','category','합성 이전 분류','sourceUrl','https://example.invalid/common');
 assert public.upsert_source_events_v1(jsonb_build_array(x,x||jsonb_build_object('provider',repeat('a',33))))->>'savedCount'='2';
end $$;
reset role;
do $$ begin
 assert (select relkind='v' from pg_class where oid='private.events'::regclass);
 assert (select relkind='r' and relrowsecurity from pg_class where oid='private.source_events'::regclass);
 assert (select count(*) from private.source_events where provider='common-synthetic')=4;
 assert (select count(*) from private.events where provider='common-synthetic')=4;
 assert not exists(select 1 from private.events v join private.source_events s using(id) where v.provider='common-synthetic' and v.source_id<>s.source_id);
 assert not has_table_privilege('service_role','private.events','SELECT');
 assert (select count(*) from private.source_events s join private.events v using(id)
  where s.provider in('demo_provider',repeat('a',33)) and s.record->>'title'=v.title)=2;
end $$;
select 'ORDERED_CHECK:events_single_canonical_stale_null_url';

set local role anon;
do $$ declare r jsonb;next_page jsonb;begin
 r:=public.list_public_events('{"mode":"overlapping","region":"가상시"}',null,2);
 assert jsonb_array_length(r->'items')=2 and r#>>'{items,0,state}'='ongoing' and r#>>'{items,1,state}'='upcoming';
 assert r#>'{items,0,sourceUrl}'='null'::jsonb and r#>>'{items,0,admission,kind}'='unknown';
 next_page:=public.list_public_events('{"mode":"overlapping","region":"가상시"}',r->'nextCursor',2);
 assert jsonb_array_length(next_page->'items')=1 and next_page#>>'{items,0,state}'='ended';
 assert jsonb_array_length(public.list_public_events('{"mode":"post_selection","region":"가상시"}',null,50)->'items')=2;
 assert jsonb_array_length(public.list_public_events('{"mode":"overlapping","region":"가상시","ongoingOnly":true}',null,50)->'items')=1;
 assert jsonb_array_length(public.list_public_events('{"mode":"overlapping","region":"가상시","query":"  ART   hall "}',null,50)->'items')=3;
 assert public.list_event_filter_values()->'regions' @> '[{"provider":"common-synthetic","value":"가상시","count":3}]'::jsonb;
 assert not exists(select 1 from jsonb_array_elements(public.list_public_events('{"mode":"overlapping"}',null,50)->'items') i
  where i->>'provider' in('demo_provider',repeat('a',33)));
 assert jsonb_array_length(public.list_public_events('{"mode":"overlapping","region":"합성 이전 지역"}',null,50)->'items')=0;
 assert not exists(select 1 from jsonb_array_elements(public.list_event_filter_values()->'regions') i where i->>'value'='합성 이전 지역');
 assert not exists(select 1 from jsonb_array_elements(public.list_event_filter_values()->'categories') i where i->>'value'='합성 이전 분류');
 assert jsonb_array_length(public.list_event_candidates_v1('합성 이전 지역',null))=2;
 perform pg_temp.common_expect('select public.upsert_events(''[]''::jsonb)',array['42501']);
 perform pg_temp.common_expect('select 1 from private.events',array['42501']);
end $$;
reset role;
select 'ORDERED_CHECK:events_filters_order_cursor';

set local role authenticated;
do $$ declare r jsonb;before jsonb;begin
 perform pg_temp.common_actor(2);before:=public.get_my_profile();
 perform public.set_my_profile_traits(array['전시'],array['차분한 대화'],'INFP');r:=public.get_public_profile(pg_temp.common_uid(2));
 assert r->>'displayName'='합성 요약대상자' and r->>'mbti'='INFP' and r->'interests'='["전시"]'::jsonb;
 assert r->>'completedCount'='4';assert public.get_my_profile()=before;
 assert (select array_agg(k order by k) from jsonb_object_keys(before) k)=array['avatarUrl','bio','realName','userId'];
 perform pg_temp.common_actor(3);r:=public.get_public_profile(pg_temp.common_uid(2));
 assert r->>'displayName'=public.mask_real_name('합성 요약대상자');
 assert not(r?'realName') and not(r?'birthDate') and not(r?'authEmail');
 perform pg_temp.common_actor(1);assert public.get_public_profile(pg_temp.common_uid(2))->>'displayName'='합성 요약대상자';
 perform pg_temp.change_actor(2);
 assert public.get_public_profile(pg_temp.change_uid(6))->>'displayName'=public.mask_real_name('합성 기존회원');
 perform pg_temp.common_actor(3);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',pg_temp.common_uid(3),'role','authenticated','is_anonymous',true)::text,true);
 perform pg_temp.common_expect(format('select public.get_public_profile(%L)',pg_temp.common_uid(2)),array['28000']);
end $$;
reset role;
set local role anon;
do $$ begin perform pg_temp.common_expect(format('select public.get_public_profile(%L)',pg_temp.common_uid(2)),array['42501','28000']);end $$;
reset role;
-- 정식 종현 회귀 검사는 관리 역할 합성 fixture를 삽입하며 회원 자격으로 승격하지 않는다.
do $$ begin perform set_config('request.jwt.claim.sub','',true);perform set_config('request.jwt.claims','{"role":"service_role"}',true);end $$;
select 'ORDERED_CHECK:public_profile_traits_identity_me_preserved';
rollback;
