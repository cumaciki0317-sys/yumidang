-- 민규 SQL111 회귀: 빈 합성 scratch DB 전용. root가 실행하며 모든 자료/권한은 rollback한다.
begin;
do $$begin
 if exists(select 1 from private.worker_jobs)or exists(select 1 from private.source_events)
  or exists(select 1 from private.event_collection_progress)then raise exception 'event_lane_scratch_must_be_empty';end if;
 if(select enabled from private.event_collection_control where singleton)then raise exception 'event_lane_must_start_closed';end if;
end;$$;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create function pg_temp.require(p_ok boolean,p_name text)returns void language plpgsql as $$begin
 if p_ok is distinct from true then raise exception 'event_lane_assertion:%',p_name;end if;
end;$$;
create function pg_temp.expect_state(p_sql text,p_state text)returns void language plpgsql as $$
declare state text;begin
 begin execute p_sql;exception when others then get stacked diagnostics state=returned_sqlstate;
  if state=p_state then return;end if;raise;end;
 raise exception 'expected_event_lane_sqlstate:%',p_state;
end;$$;
do $$declare r text;f record;t regclass;begin
 for f in select oid::regprocedure sig from pg_proc where pronamespace='public'::regnamespace and proname in(
  'read_event_collection_contract','register_event_collection_jobs','claim_event_collection','commit_event_collection_page',
  'store_event_source_detail','next_event_collection_reference','list_ongoing_event_source_ids','settle_event_collection','complete_event_ranking_collection')loop
  foreach r in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
   perform pg_temp.require(not has_function_privilege(r,f.sig,'EXECUTE'),'default_rpc_closed');end loop;
 end loop;
 foreach t in array array['private.event_collection_control'::regclass,'private.event_collection_providers'::regclass,
  'private.event_collection_progress'::regclass,'private.event_source_details'::regclass]loop
  perform pg_temp.require((select relrowsecurity and relforcerowsecurity from pg_class where oid=t),'force_rls');
  foreach r in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
   perform pg_temp.require(not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE'),'direct_table_closed');end loop;
 end loop;
 perform pg_temp.require(public.read_event_collection_contract()->'capabilities'='[]'::jsonb,'default_capabilities_closed');
end;$$;
-- 검증용 GRANT이며 운영 활성화가 아니다. 순위 완료는 끝까지 닫는다.
grant execute on function public.read_event_collection_contract(),
 public.register_event_collection_jobs(text,date,jsonb,boolean,jsonb),
 public.claim_event_collection(text,text,jsonb,uuid,integer,text,text),
 public.commit_event_collection_page(uuid,uuid,uuid,integer,jsonb,boolean,jsonb,jsonb),
 public.store_event_source_detail(jsonb,uuid,uuid,uuid,text,boolean),
 public.next_event_collection_reference(uuid,jsonb),public.list_ongoing_event_source_ids(text,text,integer),
 public.settle_event_collection(uuid,uuid,uuid,text,text,boolean,integer,integer)to service_role;
update private.event_collection_control set enabled=true where singleton;
update private.worker_runtime_atomic_control set enabled=true where singleton;

create temp table event_lane_fixture(key text primary key,value jsonb)on commit drop;
do $$declare today date:=(clock_timestamp()at time zone'Asia/Seoul')::date;refs jsonb;r jsonb;reg jsonb;lease jsonb;
 ref jsonb;claim jsonb;token uuid;job uuid;jlease uuid;stamp text;stamp2 text;ev jsonb;ev2 jsonb;details jsonb;details2 jsonb;dclaim jsonb;outcome jsonb;
 saved integer;schedule jsonb;i integer;slots integer;expiry timestamptz;begin
 refs:=jsonb_build_array(
  jsonb_build_object('provider','kopis','lane','initial_history','period',jsonb_build_object('start',(today-interval'1 month')::date::text,'end',(today-1)::text)),
  jsonb_build_object('provider','kopis','lane','future','period',jsonb_build_object('start',today::text,'end',(today+30)::text)),
  jsonb_build_object('provider','kopis','lane','ongoing','period',jsonb_build_object('start',today::text,'end',today::text)),
  jsonb_build_object('provider','kopis','lane','ranking_all','period',jsonb_build_object('start',(today-7)::text,'end',(today-1)::text)),
  jsonb_build_object('provider','kopis','lane','ranking_musical','period',jsonb_build_object('start',(today-7)::text,'end',(today-1)::text)));
 perform pg_temp.require(public.read_event_collection_contract()->'capabilities' ?& array['collection','collection_details','detail_jobs'],'base_capabilities');
 perform pg_temp.require(not(public.read_event_collection_contract()->'capabilities' ? 'ranking_jobs'),'ranking_capability_held');
 reg:=public.register_event_collection_jobs('kopis',today,refs,true,null);
 perform pg_temp.require(reg->>'createdCount'='5'and reg->>'initialHistory'='registered','first_registration');
 reg:=public.register_event_collection_jobs('kopis',today,refs,true,null);
 perform pg_temp.require(reg->>'createdCount'='0'and reg->>'existingCount'='5'and reg->>'initialHistory'='already_registered','registration_dedup');
 perform pg_temp.require((select count(*)from private.event_collection_progress where held)=2,'ranking_refs_preserved');
 perform pg_temp.expect_state(format('select public.register_event_collection_jobs(''seoul'',%L::date,%L::jsonb,true,null)',today,refs),'55000');
 perform pg_temp.expect_state(format('select public.register_event_collection_jobs(''kopis'',%L::date,''[]''::jsonb,true,null)',today),'22023');
 lease:=public.acquire_worker_run(180,null);token:=(lease->>'token')::uuid;expiry:=(lease->>'expiresAt')::timestamptz;
 perform pg_temp.require(token is not null,'global_claim');
 update private.global_worker_run set expires_at=clock_timestamp()+interval'181 seconds'where singleton;
 perform pg_temp.expect_state(format('select public.next_event_collection_reference(%L::uuid,''[]''::jsonb)',token),'40001');
 update private.global_worker_run set expires_at=expiry where singleton;
 schedule:=public.read_worker_owned_queue_schedule(token,'{}',null);
 perform pg_temp.require(schedule->>'nextKind'='event_sync','same_queue_schedule');
 ref:=refs->1;
 claim:=public.claim_event_collection('kopis','future',ref->'period',token,180);
 job:=(claim->>'jobId')::uuid;jlease:=(claim->>'leaseToken')::uuid;
 perform pg_temp.require(claim->'period'=ref->'period'and claim->>'nextPage'='1'and claim->>'collectedPages'='0'and claim->'cursor'='null'::jsonb,'claim_dto');
 perform pg_temp.require((select lease_expires_at<=expiry from private.worker_jobs where id=job),'lease_not_extended');
 perform pg_temp.require((public.acquire_worker_run(180,token)->>'expiresAt')::timestamptz=expiry,'borrow_no_extend');
 perform pg_temp.expect_state(format('select public.claim_event_collection(''kopis'',''future'',%L::jsonb,%L::uuid,180)',ref->'period',gen_random_uuid()),'40001');
 stamp:=to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 stamp2:=to_char((clock_timestamp()+interval'2 seconds')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 ev:=jsonb_build_object('provider','kopis','sourceId','PFlane1','sourceStatus','active','title','합성 장기 행사',
  'category',null,'region',null,'placeName',null,'publicAddress',null,'admission',jsonb_build_object('kind','free'),
  'sourceUrl',null,'collectedAt',stamp,'precision','date','startsOn',(today-60)::text,'endsOn',(today+2)::text,
  'description','보존할 공급사 공개 설명','posterUrl','https://www.kopis.or.kr/upload/synthetic.png');
 details:=jsonb_build_array(jsonb_build_object('provider','kopis','lane','detail','sourceId','PFlane1','sourceCollectedAt',stamp,
  'period',jsonb_build_object('start',(private.event_instant_v1(stamp)at time zone'Asia/Seoul')::date::text,'end',(private.event_instant_v1(stamp)at time zone'Asia/Seoul')::date::text)));
 perform pg_temp.require(not private.valid_source_event_v2(ev),'legacy_validator_still_rejects_extras');
 outcome:=public.commit_event_collection_page(job,gen_random_uuid(),token,1,jsonb_build_array(ev),true,details,'{"page":2,"cursor":"2"}');
 perform pg_temp.require(outcome->>'status'='lease_lost'and not exists(select 1 from private.source_events),'wrong_lease_no_effect');
 outcome:=public.commit_event_collection_page(job,jlease,token,1,jsonb_build_array(ev),true,details,'{"page":2,"cursor":"2"}');
 perform pg_temp.require(outcome->>'status'='applied','first_page');
 perform pg_temp.require((select private.valid_source_event_v2(record)and not(record ?| array['description','posterUrl'])from private.source_events where source_id='PFlane1'),'canonical_extras_split');
 perform pg_temp.require((select detail->>'description'='보존할 공급사 공개 설명'from private.event_source_details),'detail_atomic_write');
 perform pg_temp.require((select next_page=2 and collected_pages=1 and cursor='2'from private.event_collection_progress where job_id=job),'page_checkpoint');
 saved:=(select count(*)from private.worker_jobs);
 outcome:=public.commit_event_collection_page(job,jlease,token,1,jsonb_build_array(ev),true,details,'{"page":2,"cursor":"2"}');
 perform pg_temp.require(outcome->>'status'='applied'and(select count(*)from private.worker_jobs)=saved and
  (select collected_pages=1 from private.event_collection_progress where job_id=job),'response_loss_replay_no_duplicate');
 perform pg_temp.expect_state(format('select public.commit_event_collection_page(%L::uuid,%L::uuid,%L::uuid,1,%L::jsonb,true,%L::jsonb,''{"page":2,"cursor":"3"}'')',job,jlease,token,jsonb_build_array(ev),details),'40001');
 outcome:=public.settle_event_collection(job,jlease,token,'yielded',null,false,600,21600);
 perform pg_temp.require(outcome->>'status'='queued'and(select failed_attempts=0 from private.worker_jobs where id=job),'yield_not_failure');
 claim:=public.claim_event_collection('kopis','future',ref->'period',token,180);
 perform pg_temp.require(claim->>'nextPage'='2'and claim->>'collectedPages'='1'and claim->>'cursor'='2','resume_exact_page');
 perform pg_temp.require((select count(*)from private.worker_runtime_job_slots where global_token=token)=1,'same_job_one_slot');
 ev2:=(ev-array['description','posterUrl'])||jsonb_build_object('collectedAt',stamp2,'admission',jsonb_build_object('kind','unknown'));
 details2:=jsonb_build_array((details->0)||jsonb_build_object('sourceCollectedAt',stamp2,
  'period',jsonb_build_object('start',(private.event_instant_v1(stamp2)at time zone'Asia/Seoul')::date::text,'end',(private.event_instant_v1(stamp2)at time zone'Asia/Seoul')::date::text)));
 outcome:=public.commit_event_collection_page(job,jlease,token,2,jsonb_build_array(ev2),true,details2,null);
 perform pg_temp.require(outcome->>'status'='lease_lost','old_job_lease_rejected');
 jlease:=(claim->>'leaseToken')::uuid;
 outcome:=public.commit_event_collection_page(job,jlease,token,2,jsonb_build_array(ev2),true,details2,null);
 perform pg_temp.require(outcome->>'status'='applied'and(select status='succeeded'from private.worker_jobs where id=job),'last_page_terminal');
 perform pg_temp.require((select record#>>'{admission,kind}'='free'from private.source_events where source_id='PFlane1'),'unknown_preserves_known_price');
 perform pg_temp.require((select detail->>'description'='보존할 공급사 공개 설명'from private.event_source_details),'missing_preserves_details');
 perform pg_temp.require(public.commit_event_collection_page(job,jlease,token,2,jsonb_build_array(ev2),true,details2,null)->>'status'='applied','terminal_page_replay');
 perform pg_temp.require(public.claim_event_collection('kopis','future',ref->'period',token,180)is null,'terminal_not_reclaimed');
 r:=details->0;
 dclaim:=public.claim_event_collection('kopis','detail',r->'period',token,180,r->>'sourceId',r->>'sourceCollectedAt');
 perform pg_temp.require(dclaim->>'sourceCollectedAt'=stamp,'detail_original_timestamp_string');
 outcome:=public.store_event_source_detail(jsonb_build_object('provider','kopis','sourceId','PFlane1','collectedAt',stamp2,'description','오래된 작업 설명'),
  (dclaim->>'jobId')::uuid,(dclaim->>'leaseToken')::uuid,token,stamp,true);
 perform pg_temp.require(outcome->>'status'='superseded','source_revision_changed');
 r:=details2->0;
 dclaim:=public.claim_event_collection('kopis','detail',r->'period',token,180,r->>'sourceId',r->>'sourceCollectedAt');
 perform pg_temp.expect_state(format('select public.store_event_source_detail(%L::jsonb,%L::uuid,%L::uuid,%L::uuid,%L,true)',
  jsonb_build_object('provider','kopis','sourceId','PFlane1','collectedAt',stamp2,'admission',jsonb_build_object('kind','described','text',repeat('a',2001))),
  dclaim->>'jobId',dclaim->>'leaseToken',token,stamp2),'55000');
 perform pg_temp.require((select status='running'from private.worker_jobs where id=(dclaim->>'jobId')::uuid),'unprojectable_price_not_completed');
 outcome:=public.store_event_source_detail(jsonb_build_object('provider','kopis','sourceId','PFlane1','collectedAt',stamp2,'description','갱신한 공개 설명'),
  (dclaim->>'jobId')::uuid,(dclaim->>'leaseToken')::uuid,token,stamp2,true);
 perform pg_temp.require(outcome->>'status'='applied'and(select detail->>'description'='갱신한 공개 설명'from private.event_source_details),'detail_completion');
 perform pg_temp.require((select record#>>'{admission,kind}'='free'from private.source_events),'detail_missing_price_preserved');
 outcome:=public.list_ongoing_event_source_ids('kopis',null,10);
 perform pg_temp.require(outcome->'sourceIds'='["PFlane1"]'::jsonb and outcome->'nextCursor'='null'::jsonb,'long_ongoing_not_start_window');
 perform pg_temp.require(public.list_ongoing_event_source_ids('kopis','PFlane1',10)->'sourceIds'='[]'::jsonb,'ongoing_keyset');
 perform pg_temp.require(public.claim_event_collection('kopis','ranking_all',refs->3->'period',token,180)is null,'ranking_no_claim');
 perform pg_temp.expect_state(format('select public.complete_event_ranking_collection(%L::uuid,%L::uuid,%L::uuid,%L::jsonb,''{}''::jsonb)',job,jlease,token,refs->3->'period'),'55000');
 perform pg_temp.require(public.get_public_event_ranking_state()->>'status'='not_enabled','public_ranking_still_held');
 -- 실제 실패 backoff는 일정과 진행 위치를 함께 보존한다.
 ref:=refs->2;claim:=public.claim_event_collection('kopis','ongoing',ref->'period',token,180);
 perform pg_temp.expect_state(format('select public.settle_event_collection(%L::uuid,%L::uuid,%L::uuid,''provider_failed'',''SOURCE_TIMEOUT'',false,600,21600)',
  claim->>'jobId',claim->>'leaseToken',token),'22023');
 outcome:=public.settle_event_collection((claim->>'jobId')::uuid,(claim->>'leaseToken')::uuid,token,'provider_failed','SOURCE_TIMEOUT',true,600,21600);
 perform pg_temp.require(outcome->>'status'='retry_wait'and(select failed_attempts=1 and available_at>clock_timestamp()+interval'590 seconds'
  from private.worker_jobs where id=(claim->>'jobId')::uuid),'retry_floor_and_failure_count');
 perform pg_temp.require(public.claim_event_collection('kopis','ongoing',ref->'period',token,180)is null,'future_retry_not_claimed');
 -- 소비자의 실행당5쪽을 DB도 제한하며 정상 양보 후 다음 실제 페이지를 보존한다.
 ref:=refs->0;claim:=public.claim_event_collection('kopis','initial_history',ref->'period',token,180);
 for i in 1..5 loop
  outcome:=public.commit_event_collection_page((claim->>'jobId')::uuid,(claim->>'leaseToken')::uuid,token,i,'[]',true,'[]',jsonb_build_object('page',i+1,'cursor',(i+1)::text));
  perform pg_temp.require(outcome->>'status'='applied','five_pages_allowed');
 end loop;
 perform pg_temp.expect_state(format('select public.commit_event_collection_page(%L::uuid,%L::uuid,%L::uuid,6,''[]'',true,''[]'',''{"page":7,"cursor":"7"}'')',claim->>'jobId',claim->>'leaseToken',token),'40001');
 outcome:=public.settle_event_collection((claim->>'jobId')::uuid,(claim->>'leaseToken')::uuid,token,'yielded',null,false,600,21600);
 claim:=public.claim_event_collection('kopis','initial_history',ref->'period',token,180);
 perform pg_temp.require(claim->>'nextPage'='6'and claim->>'collectedPages'='5','sixth_page_resumes_next_lease');
 -- 그 외 큐 종류도 같은 슬롯을 소비하므로 잔여 슬롯만 성공해야 한다.
 slots:=(select count(*)from private.worker_runtime_job_slots where global_token=token);
 for i in 1..21 loop
  ref:=jsonb_build_object('provider','kopis','lane','future','period',jsonb_build_object('start',(today+i+40)::text,'end',(today+i+40)::text));
  perform private.add_event_collection_job(ref);
  claim:=public.claim_event_collection('kopis','future',ref->'period',token,180);
  perform pg_temp.require((claim is not null)=(i<=20-slots),'unique_slot_cap');
  if i=1 then insert into event_lane_fixture values('expiry_claim',claim);end if;
 end loop;
 perform pg_temp.require((select count(*)from private.worker_runtime_job_slots where global_token=token)=20,'exact_twenty_actual_slots');
 perform pg_temp.require(not exists(select 1 from private.worker_runtime_job_slots s left join private.worker_jobs j on j.id=s.job_id
  where s.global_token=token and j.id is null),'slots_use_real_job_ids');
 perform pg_temp.require(public.next_event_collection_reference(token,'[]')is null,'no_twenty_first_reference');
 insert into event_lane_fixture values('token',to_jsonb(token));
end;$$;

-- source INSERT 중 만료: 결과/원천/진행이 모두 rollback되어야 한다.
create function pg_temp.expire_event_page()returns trigger language plpgsql as $$begin
 if new.source_id='PFexpiry'then perform pg_sleep(0.2);end if;return new;
end;$$;
create trigger event_lane_expiry_probe before insert on private.source_events for each row execute function pg_temp.expire_event_page();
do $$declare token uuid;claim jsonb;ev jsonb;before_hash text;begin
 select(value#>>'{}')::uuid into token from event_lane_fixture where key='token';
 select value into claim from event_lane_fixture where key='expiry_claim';
 update private.global_worker_run set expires_at=clock_timestamp()+interval'100 milliseconds'where singleton;
 update private.worker_jobs set lease_expires_at=(select expires_at from private.global_worker_run where singleton)where id=(claim->>'jobId')::uuid;
 ev:=jsonb_build_object('provider','kopis','sourceId','PFexpiry','sourceStatus','active','title','만료 회귀 합성 행사',
  'category',null,'region',null,'placeName',null,'publicAddress',null,'admission',jsonb_build_object('kind','unknown'),
  'sourceUrl',null,'collectedAt',to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'precision','date','startsOn',claim#>>'{period,start}','endsOn',claim#>>'{period,end}');
 select md5(row_to_json(p)::text)into before_hash from private.event_collection_progress p where job_id=(claim->>'jobId')::uuid;
 perform pg_temp.expect_state(format('select public.commit_event_collection_page(%L::uuid,%L::uuid,%L::uuid,1,%L::jsonb,true,''[]''::jsonb,null)',
  claim->>'jobId',claim->>'leaseToken',token,jsonb_build_array(ev)),'40001');
 perform pg_temp.require(not exists(select 1 from private.source_events where source_id='PFexpiry'),'expired_source_write_rollback');
 perform pg_temp.require((select md5(row_to_json(p)::text)=before_hash from private.event_collection_progress p where job_id=(claim->>'jobId')::uuid),'expired_checkpoint_rollback');
end;$$;
rollback;
