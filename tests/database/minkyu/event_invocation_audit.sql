-- SQL112: 빈 합성 scratch 전용. 실제 DB 실행은 root가 담당하며 전체 rollback한다.
begin;
do $$begin
 if exists(select 1 from private.worker_jobs)or exists(select 1 from private.source_events)
  or exists(select 1 from private.worker_invocations)then raise exception 'event_invocation_scratch_must_be_empty';end if;
 if(select enabled from private.event_collection_control where singleton)or(select enabled from private.worker_invocation_control where singleton)then
  raise exception 'event_invocation_must_start_closed';end if;
end;$$;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
create function pg_temp.require(p_ok boolean,p_name text)returns void language plpgsql as $$begin
 if p_ok is distinct from true then raise exception 'event_invocation_assertion:%',p_name;end if;
end;$$;
create function pg_temp.expect_state(p_sql text,p_state text)returns void language plpgsql as $$declare v_state text;begin
 begin execute p_sql;exception when others then get stacked diagnostics v_state=returned_sqlstate;
  if v_state=p_state then return;end if;raise;end;
 raise exception 'expected_event_invocation_sqlstate:%',p_state;
end;$$;
do $$declare v_sig text;v_role text;begin
 foreach v_sig in array array['public.claim_event_collection_sql111(text,text,jsonb,uuid,integer,text,text)',
  'public.next_event_collection_reference_sql111(uuid,jsonb)','public.commit_event_collection_page_sql111(uuid,uuid,uuid,integer,jsonb,boolean,jsonb,jsonb)',
  'public.store_event_source_detail_sql111(jsonb,uuid,uuid,uuid,text,boolean)','public.settle_event_collection_sql111(uuid,uuid,uuid,text,text,boolean,integer,integer)',
  'public.complete_queue_invocation_sql110(uuid)','private.active_event_invocation(uuid)','private.event_invocation_job(uuid,uuid,uuid)']loop
  foreach v_role in array array['anon','authenticated','service_role','authenticator','yumidang_worker_queue']loop
   perform pg_temp.require(not has_function_privilege(v_role,v_sig,'EXECUTE'),'unfenced_alias_closed');end loop;
 end loop;
 perform pg_temp.require(not has_table_privilege('service_role','private.event_invocation_references','SELECT,INSERT,UPDATE,DELETE'),'observation_table_closed');
 perform pg_temp.require(public.read_event_collection_contract()->'capabilities'='[]','default_ready_closed');
end;$$;
grant execute on function public.read_event_collection_contract(),public.register_event_collection_jobs(text,date,jsonb,boolean,jsonb),
 public.claim_event_collection(text,text,jsonb,uuid,integer,text,text),public.next_event_collection_reference(uuid,jsonb),
 public.commit_event_collection_page(uuid,uuid,uuid,integer,jsonb,boolean,jsonb,jsonb),public.store_event_source_detail(jsonb,uuid,uuid,uuid,text,boolean),
 public.list_ongoing_event_source_ids(text,text,integer),public.settle_event_collection(uuid,uuid,uuid,text,text,boolean,integer,integer),
 public.prepare_queue_invocation(uuid,uuid,text,integer,integer),public.claim_queue_invocation_dispatch(uuid,uuid,text,integer,integer),
 public.get_queue_invocation(uuid),public.mark_queue_invocation_unknown(uuid),public.complete_queue_invocation(uuid)to service_role;
update private.worker_runtime_atomic_control set enabled=true where singleton;
update private.worker_invocation_control set enabled=true where singleton;
update private.event_collection_control set enabled=true where singleton;
create temp table event_invocation_fixture(key text primary key,value jsonb)on commit drop;
do $$declare v_today date:=(clock_timestamp()at time zone'Asia/Seoul')::date;v_token uuid;v_id uuid;v_lease jsonb;v_out jsonb;
 v_ref jsonb;v_claim jsonb;v_claim_old jsonb;v_ev jsonb;v_stamp text;v_stamp2 text;v_source uuid;v_slots integer;v_i integer;v_seen jsonb;begin
 v_lease:=public.acquire_worker_run(180,null);v_token:=(v_lease->>'token')::uuid;
 perform pg_temp.require(v_token is not null,'global_180_claim');
 perform pg_temp.expect_state(format('select public.prepare_queue_invocation(%L::uuid,%L::uuid,''event_sync'',11,60000)',gen_random_uuid(),v_token),'22023');
 perform pg_temp.expect_state(format('select public.prepare_queue_invocation(%L::uuid,%L::uuid,''event_sync'',1,60001)',gen_random_uuid(),v_token),'22023');
 v_id:=gen_random_uuid();v_out:=public.prepare_queue_invocation(v_id,v_token,'event_sync',2,60000);
 perform pg_temp.require(v_out->>'fresh'='true','fresh_prepare');
 perform pg_temp.expect_state(format('select public.claim_queue_invocation_dispatch(%L::uuid,%L::uuid,''event_sync'',1,60000)',v_id,v_token),'40001');
 perform pg_temp.require(public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',2,60000)->>'claimed'='true','exact_first_cas');
 perform pg_temp.require(public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',2,60000)->>'claimed'='false','cas_no_resend');
 perform pg_temp.expect_state(format('select public.complete_queue_invocation(%L::uuid)',v_id),'55000');
 perform pg_temp.require(public.next_event_collection_reference(v_token,'[]')is null,'real_empty_lookup');
 v_out:=public.complete_queue_invocation(v_id);
 perform pg_temp.require(v_out->>'state'='completed'and v_out#>>'{result,counts,claimed}'='0','actual_idle_zero_complete');
 perform pg_temp.require(public.prepare_queue_invocation(v_id,v_token,'event_sync',2,60000)->>'fresh'='false','stored_prepare_no_new_effect');
 perform pg_temp.expect_state(format('select public.prepare_queue_invocation(%L::uuid,%L::uuid,''event_sync'',1,60000)',v_id,v_token),'40001');

 v_ref:=jsonb_build_object('provider','kopis','lane','future','period',jsonb_build_object('start',(v_today+40)::text,'end',(v_today+40)::text));
 perform private.add_event_collection_job(v_ref);
 v_id:=gen_random_uuid();perform public.prepare_queue_invocation(v_id,v_token,'event_sync',1,60000);
 perform pg_temp.expect_state(format('select public.claim_event_collection(''kopis'',''future'',%L::jsonb,%L::uuid,180)',v_ref->'period',v_token),'55000');
 perform public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',1,60000);
 perform pg_temp.expect_state(format('select public.next_event_collection_reference(%L::uuid,%L::jsonb)',v_token,jsonb_build_array(v_ref)),'22023');
 perform pg_temp.require(public.next_event_collection_reference(v_token,'[]')=v_ref,'actual_reference_observed');
 v_claim:=public.claim_event_collection('kopis','future',v_ref->'period',v_token,180);
 perform pg_temp.require((select count(*)from private.worker_invocation_jobs where request_id=v_id)=1,'actual_claim_audit');
 perform pg_temp.require((select w.lease_expires_at<=i.deadline from private.worker_jobs w join private.worker_invocations i on i.request_id=v_id where w.id=(v_claim->>'jobId')::uuid),'claim_deadline_clamp');
 perform pg_temp.expect_state(format('select public.complete_queue_invocation(%L::uuid)',v_id),'55000');
 -- 일반 terminal 전이만으로 source page 효과를 위조할 수 없다. subtransaction 전체 복구.
 begin
  perform public.complete_job((v_claim->>'jobId')::uuid,(v_claim->>'leaseToken')::uuid,v_token);
  perform pg_temp.expect_state(format('select public.complete_queue_invocation(%L::uuid)',v_id),'55000');
  raise exception 'rollback_unproven_fixture'using errcode='ZX001';
 exception when sqlstate'ZX001'then null;end;
 perform pg_temp.require((select status='running'from private.worker_jobs where id=(v_claim->>'jobId')::uuid),'unproven_terminal_rolled_back');
 v_stamp:=to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 v_ev:=jsonb_build_object('provider','kopis','sourceId','PFaudit','sourceStatus','active','title','합성 감사 행사','category',null,'region',null,
  'placeName',null,'publicAddress',null,'admission',jsonb_build_object('kind','unknown'),'sourceUrl',null,'collectedAt',v_stamp,
  'precision','date','startsOn',(v_today+40)::text,'endsOn',(v_today+40)::text,'description','최초 상세');
 v_out:=public.commit_event_collection_page((v_claim->>'jobId')::uuid,(v_claim->>'leaseToken')::uuid,v_token,1,jsonb_build_array(v_ev),true,'[]',null);
 perform pg_temp.require(v_out->>'status'='applied'and(select effect='event_page_complete'from private.worker_invocation_jobs where request_id=v_id),'page_effect_proven');
 perform public.mark_queue_invocation_unknown(v_id);
 update private.worker_invocations set deadline=clock_timestamp()-interval'1 second'where request_id=v_id;
 perform pg_temp.require(public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',1,60000)->>'claimed'='false','unknown_no_dispatch');
 v_out:=public.complete_queue_invocation(v_id);
 perform pg_temp.require(v_out->>'state'='completed'and v_out#>>'{result,counts,succeeded}'='1','known_effect_recovery_after_deadline');

 -- 현재 source revision에 대한 stale 상세도 실제 SQL 결과/정확한 lease 증거가 필요하다.
 perform public.register_event_collection_jobs('kopis',v_today,'[]',true,'["PFaudit"]');
 select ep.reference into strict v_ref from private.event_collection_progress ep where ep.reference->>'lane'='detail';
 v_id:=gen_random_uuid();perform public.prepare_queue_invocation(v_id,v_token,'event_sync',1,60000);
 perform public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',1,60000);
 v_claim:=public.claim_event_collection('kopis','detail',v_ref->'period',v_token,180,v_ref->>'sourceId',v_ref->>'sourceCollectedAt');
 v_out:=public.store_event_source_detail(jsonb_build_object('provider','kopis','sourceId','PFaudit','collectedAt',v_stamp,'description','동일 시각 stale 설명'),
  (v_claim->>'jobId')::uuid,(v_claim->>'leaseToken')::uuid,v_token,v_stamp,true);
 perform pg_temp.require(v_out->>'status'='stale'and(select effect='event_detail_stale'from private.worker_invocation_jobs where request_id=v_id),'detail_stale_effect');
 perform pg_temp.require(public.complete_queue_invocation(v_id)#>>'{result,counts,succeeded}'='1','detail_stale_completed');
 select id into strict v_source from private.source_events where source_id='PFaudit';
 v_stamp2:=to_char((clock_timestamp()+interval'2 seconds')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 update private.source_events set collected_at=private.event_instant_v1(v_stamp2),record=jsonb_set(record,'{collectedAt}',to_jsonb(v_stamp2))where id=v_source;
 perform public.register_event_collection_jobs('kopis',v_today,'[]',true,'["PFaudit"]');
 select ep.reference into strict v_ref from private.event_collection_progress ep where ep.reference->>'lane'='detail'and ep.reference->>'sourceCollectedAt'=v_stamp2;
 v_id:=gen_random_uuid();perform public.prepare_queue_invocation(v_id,v_token,'event_sync',1,60000);perform public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',1,60000);
 v_claim:=public.claim_event_collection('kopis','detail',v_ref->'period',v_token,180,v_ref->>'sourceId',v_ref->>'sourceCollectedAt');
 v_out:=public.store_event_source_detail(jsonb_build_object('provider','kopis','sourceId','PFaudit','collectedAt',v_stamp2,'description','갱신 상세'),
  (v_claim->>'jobId')::uuid,(v_claim->>'leaseToken')::uuid,v_token,v_stamp2,true);
 perform pg_temp.require(v_out->>'status'='applied'and(select effect='event_detail_applied'from private.worker_invocation_jobs where request_id=v_id),'detail_applied_effect');
 perform pg_temp.require(public.complete_queue_invocation(v_id)#>>'{result,counts,succeeded}'='1','detail_applied_complete');
 v_stamp:=to_char((clock_timestamp()+interval'4 seconds')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 update private.source_events set collected_at=private.event_instant_v1(v_stamp),record=jsonb_set(record,'{collectedAt}',to_jsonb(v_stamp))where id=v_source;
 perform public.register_event_collection_jobs('kopis',v_today,'[]',true,'["PFaudit"]');
 select ep.reference into strict v_ref from private.event_collection_progress ep where ep.reference->>'lane'='detail'and ep.reference->>'sourceCollectedAt'=v_stamp;
 v_stamp2:=to_char((clock_timestamp()+interval'6 seconds')at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
 update private.source_events set collected_at=private.event_instant_v1(v_stamp2),record=jsonb_set(record,'{collectedAt}',to_jsonb(v_stamp2))where id=v_source;
 v_id:=gen_random_uuid();perform public.prepare_queue_invocation(v_id,v_token,'event_sync',1,60000);perform public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',1,60000);
 v_claim:=public.claim_event_collection('kopis','detail',v_ref->'period',v_token,180,v_ref->>'sourceId',v_ref->>'sourceCollectedAt');
 v_out:=public.store_event_source_detail(jsonb_build_object('provider','kopis','sourceId','PFaudit','collectedAt',v_stamp2,'description','폐기할 설명'),
  (v_claim->>'jobId')::uuid,(v_claim->>'leaseToken')::uuid,v_token,v_stamp,true);
 perform pg_temp.require(v_out->>'status'='superseded'and(select effect='event_detail_superseded'from private.worker_invocation_jobs where request_id=v_id),'detail_superseded_effect');
 perform pg_temp.require(public.complete_queue_invocation(v_id)#>>'{result,counts,superseded}'='1','detail_superseded_complete');

 -- 같은 실제job의 만료 재점유는 lease별 audit만 늘고 슬롯/이전 효과는 전승하지 않는다.
 v_ref:=jsonb_build_object('provider','kopis','lane','future','period',jsonb_build_object('start',(v_today+70)::text,'end',(v_today+70)::text));
 perform private.add_event_collection_job(v_ref);v_id:=gen_random_uuid();perform public.prepare_queue_invocation(v_id,v_token,'event_sync',2,60000);
 perform public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',2,60000);
 v_claim_old:=public.claim_event_collection('kopis','future',v_ref->'period',v_token,180);
 perform public.commit_event_collection_page((v_claim_old->>'jobId')::uuid,(v_claim_old->>'leaseToken')::uuid,v_token,1,'[]',true,'[]','{"page":2,"cursor":"2"}');
 v_slots:=(select count(*)from private.worker_runtime_job_slots where global_token=v_token);
 update private.worker_jobs set lease_expires_at=clock_timestamp()-interval'1 second'where id=(v_claim_old->>'jobId')::uuid;
 v_claim:=public.claim_event_collection('kopis','future',v_ref->'period',v_token,180);
 perform pg_temp.require((select count(*)from private.worker_runtime_job_slots where global_token=v_token)=v_slots,'reclaim_no_new_slot');
 perform pg_temp.require((select effect is null from private.worker_invocation_jobs where request_id=v_id and job_lease_token=(v_claim->>'leaseToken')::uuid),'new_lease_no_old_effect');
 perform public.commit_event_collection_page((v_claim_old->>'jobId')::uuid,(v_claim_old->>'leaseToken')::uuid,v_token,1,'[]',true,'[]','{"page":2,"cursor":"2"}');
 perform pg_temp.require((select effect='event_reclaimed'from private.worker_invocation_jobs where request_id=v_id and job_lease_token=(v_claim_old->>'leaseToken')::uuid),'old_replay_cannot_promote_new_lease');
 perform pg_temp.expect_state(format('select public.complete_queue_invocation(%L::uuid)',v_id),'55000');
 perform public.commit_event_collection_page((v_claim->>'jobId')::uuid,(v_claim->>'leaseToken')::uuid,v_token,2,'[]',true,'[]',null);
 v_out:=public.complete_queue_invocation(v_id);
 perform pg_temp.require(v_out#>>'{result,counts,claimed}'='1'and v_out#>>'{result,counts,succeeded}'='1'
  and(select count(*)from private.worker_invocation_jobs where request_id=v_id)=2,'attempts_audited_unique_counts');
 -- 만료 실패 probe에서 실제 claim을 얻을 수 있도록 하나의 슬롯을 남긴다.
 v_slots:=(select count(*)from private.worker_runtime_job_slots where global_token=v_token);
 for v_i in 1..(19-v_slots)loop
  v_ref:=jsonb_build_object('provider','kopis','lane','future','period',jsonb_build_object('start',(v_today+100+v_i)::text,'end',(v_today+100+v_i)::text));
  perform private.add_event_collection_job(v_ref);v_id:=gen_random_uuid();perform public.prepare_queue_invocation(v_id,v_token,'event_sync',1,60000);
  perform public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',1,60000);v_claim:=public.claim_event_collection('kopis','future',v_ref->'period',v_token,180);
  perform public.commit_event_collection_page((v_claim->>'jobId')::uuid,(v_claim->>'leaseToken')::uuid,v_token,1,'[]',true,'[]',null);
  perform public.complete_queue_invocation(v_id);
 end loop;
 v_ref:=jsonb_build_object('provider','kopis','lane','future','period',jsonb_build_object('start','2030-01-01','end','2030-01-01'));
 perform private.add_event_collection_job(v_ref);v_id:=gen_random_uuid();perform public.prepare_queue_invocation(v_id,v_token,'event_sync',1,60000);
 perform public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',1,60000);v_claim:=public.claim_event_collection('kopis','future',v_ref->'period',v_token,180);
 perform public.settle_event_collection((v_claim->>'jobId')::uuid,(v_claim->>'leaseToken')::uuid,v_token,'yielded',null,false,600,21600);
 perform pg_temp.require(public.complete_queue_invocation(v_id)#>>'{result,counts,yielded}'='1','yield_effect_complete');
 v_ref:=jsonb_build_object('provider','kopis','lane','future','period',jsonb_build_object('start','2030-02-01','end','2030-02-01'));
 perform private.add_event_collection_job(v_ref);v_id:=gen_random_uuid();perform public.prepare_queue_invocation(v_id,v_token,'event_sync',1,60000);
 perform public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',1,60000);v_claim:=public.claim_event_collection('kopis','future',v_ref->'period',v_token,180);
 perform pg_temp.require(v_claim is null,'twenty_first_claim_no_slot');
 perform pg_temp.require(public.complete_queue_invocation(v_id)#>>'{result,counts,claimed}'='0','blocked_slot_not_fake_claim');
 insert into event_invocation_fixture values('token',to_jsonb(v_token));
end;$$;

create function pg_temp.delay_event_invocation_source()returns trigger language plpgsql as $$begin
 if new.source_id='PFdeadline'then perform pg_sleep(0.2);end if;return new;
end;$$;
create trigger event_invocation_expiry_probe before insert on private.source_events for each row execute function pg_temp.delay_event_invocation_source();
do $$declare v_token uuid;v_id uuid;v_ref jsonb;v_claim jsonb;v_ev jsonb;v_before text;begin
 select(value#>>'{}')::uuid into v_token from event_invocation_fixture where key='token';
 v_ref:=jsonb_build_object('provider','kopis','lane','future','period',jsonb_build_object('start','2030-01-01','end','2030-01-01'));
 perform private.add_event_collection_job(v_ref);v_id:=gen_random_uuid();perform public.prepare_queue_invocation(v_id,v_token,'event_sync',1,60000);
 perform public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',1,60000);v_claim:=public.claim_event_collection('kopis','future',v_ref->'period',v_token,180);
 perform pg_temp.require((select count(*)from private.worker_runtime_job_slots where global_token=v_token)=20,'shared_twenty_actual_jobs');
 update private.worker_invocations set deadline=clock_timestamp()+interval'100 milliseconds'where request_id=v_id;
 update private.worker_jobs set lease_expires_at=(select deadline from private.worker_invocations where request_id=v_id)where id=(v_claim->>'jobId')::uuid;
 v_ev:=jsonb_build_object('provider','kopis','sourceId','PFdeadline','sourceStatus','active','title','만료 합성 원천','category',null,'region',null,
  'placeName',null,'publicAddress',null,'admission',jsonb_build_object('kind','unknown'),'sourceUrl',null,
  'collectedAt',to_char(clock_timestamp()at time zone'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'precision','date','startsOn','2030-01-01','endsOn','2030-01-01');
 select md5(row_to_json(ep)::text)into v_before from private.event_collection_progress ep where job_id=(v_claim->>'jobId')::uuid;
 perform pg_temp.expect_state(format('select public.commit_event_collection_page(%L::uuid,%L::uuid,%L::uuid,1,%L::jsonb,true,''[]'',null)',
  v_claim->>'jobId',v_claim->>'leaseToken',v_token,jsonb_build_array(v_ev)),'40001');
 perform pg_temp.require(not exists(select 1 from private.source_events where source_id='PFdeadline'),'expired_source_rollback');
 perform pg_temp.require((select md5(row_to_json(ep)::text)=v_before from private.event_collection_progress ep where job_id=(v_claim->>'jobId')::uuid),'expired_progress_rollback');
 perform pg_temp.require((select effect is null and settled_status is null from private.worker_invocation_jobs where request_id=v_id),'expired_effect_audit_rollback');
 perform public.mark_queue_invocation_unknown(v_id);
 perform pg_temp.require(public.get_queue_invocation(v_id)->>'state'='unknown','unknown_preserved');
 perform pg_temp.require(public.claim_queue_invocation_dispatch(v_id,v_token,'event_sync',1,60000)->>'claimed'='false','unknown_cas_false');
 perform pg_temp.expect_state(format('select public.commit_event_collection_page(%L::uuid,%L::uuid,%L::uuid,1,%L::jsonb,true,''[]'',null)',
  v_claim->>'jobId',v_claim->>'leaseToken',v_token,jsonb_build_array(v_ev)),'55000');
 perform pg_temp.expect_state(format('select public.prepare_queue_invocation(%L::uuid,%L::uuid,''event_sync'',1,60000)',gen_random_uuid(),v_token),'55000');
 perform pg_temp.expect_state(format('select public.complete_queue_invocation(%L::uuid)',v_id),'55000');
end;$$;
rollback;
