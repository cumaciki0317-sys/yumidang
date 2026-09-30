begin;
do $$
declare target uuid:=md5('automation-target')::uuid; a uuid; p uuid; r uuid; ap uuid; rv uuid;
 x jsonb; old_revision text; ids uuid[]; submission jsonb; count_before bigint; review_state record;
begin
 insert into auth.users(id) values(target);
 insert into public.profiles(id,real_name,birth_date) values(target,'후기대상','1990-01-01');
 insert into private.review_praise_catalog(code,label) values('test_kind','테스트 친절'),('test_time','테스트 시간');
 for i in 1..7 loop
 a:=md5('automation-a'||i)::uuid; p:=md5('automation-p'||i)::uuid; r:=md5('automation-r'||i)::uuid;
 ap:=md5('automation-ap'||i)::uuid; rv:=md5('automation-rv'||i)::uuid;
 insert into auth.users(id) values(a);
 insert into public.profiles(id,real_name,birth_date) values(a,'후기작성자','1990-01-01');
 insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area)
 values(p,a,'후기 검증','공개 자동화 검증','산책',now()-interval '12 days',now()-interval '11 days',now()-interval '13 days','서울특별시 강남구 역삼동');
 insert into public.join_requests(id,post_id,requester_id,message,status) values(r,p,target,'후기 자동화 테스트입니다','matched');
 insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
 values(ap,p,r,'completed',now()-interval '10 days','automatic',now()-interval '10 days',now()-interval '9 days',now()-interval '3 days');
 insert into public.appointment_reviews(id,appointment_id,reviewer_id,rating,comment,experience,praises)
 values(rv,ap,a,5,case when i=4 then null else '공개 원문 검증 '||i end,'positive',array['test_kind']);
 end loop;
 -- Hide override survives every automatic batch.
 perform public.set_review_publication(md5('automation-rv5')::uuid,false);
 -- Both deadline/hold still in the future: no public output.
 update public.appointments set completion_notified_at=now(),dispute_deadline_at=now()+interval '24 hours',review_deadline_at=now()+interval '7 days'
 where id=md5('automation-ap6')::uuid;
 -- 한쪽 후기: 7일 작성기한 전이어도 24시간 보류가 끝나면 공개한다.
 update public.appointments set review_deadline_at=now()+interval '1 day' where id=md5('automation-ap7')::uuid;
 assert exists(select 1 from private.review_refresh_outbox where profile_id=target),'Source changes enqueue durable intent';
 x:=public.process_review_automation(1000,'test_model','test_prompt');
 assert (x->>'publishedCount')::int=5,'Only eligible policy records publish';
 assert not(select is_public from private.review_publication where review_id=md5('automation-rv5')::uuid);
 x:=public.load_public_review_snapshot(target); assert (x->>'eligibleCount')::int=4,'Blank text not AI evidence';
 old_revision:=x->>'sourceRevision';
 assert (select count(*) from private.worker_jobs where payload->>'profileId'=target::text)=1;
 perform public.process_review_automation(1000,'test_model','test_prompt');
 assert (select count(*) from private.worker_jobs where payload->>'profileId'=target::text)=1,'No duplicate jobs';
 perform set_config('request.jwt.claim.sub',target::text,true);
 x:=public.get_public_profile_reviews(target,2,null);
 assert jsonb_array_length(x->'reviews')=2 and x->>'nextCursor' is not null;
 assert (x->'praisesTop5'->0->>'count')::int=5,'Blank text included in praise aggregation';
 assert not((x->'reviews'->0)?'reviewerId');
 select array_agg((e->>'reviewId')::uuid) into ids from jsonb_array_elements(public.load_public_review_snapshot(target)->'reviews') e;
 perform public.publish_review_summary(target,old_revision,ids,'테스트 요약','test_model','test_prompt');
 perform public.set_review_publication(md5('automation-rv7')::uuid,false);
 perform public.set_review_publication(md5('automation-rv1')::uuid,false);
 assert public.get_visible_review_summary(target)->'summary'='null'::jsonb;
 assert exists(select 1 from private.review_refresh_outbox where profile_id=target);
 perform public.process_review_automation(1000,'test_model','test_prompt');
 assert not exists(select 1 from private.review_refresh_outbox where profile_id=target),'Insufficient source drains pending without job';
 assert (select count(*) from private.worker_jobs where payload->>'profileId'=target::text)=1;
 -- A failed transaction cannot commit source state without its refresh intent (or vice versa).
 select revision::text into old_revision from private.review_summary_state where profile_id=target;
 begin
   update public.appointment_reviews set comment='롤백되어야 하는 원문' where id=md5('automation-rv2')::uuid;
   assert exists(select 1 from private.review_refresh_outbox where profile_id=target);
   raise exception 'forced rollback' using errcode='ZX001';
 exception when sqlstate 'ZX001' then null; end;
 assert (select revision::text=old_revision from private.review_summary_state where profile_id=target);
 assert not exists(select 1 from private.review_refresh_outbox where profile_id=target);
 assert (select comment='공개 원문 검증 2' from public.appointment_reviews where id=md5('automation-rv2')::uuid);
 -- Submit during publication hold is allowed, immutable and retry-safe.
 ap:=md5('automation-ap6')::uuid;
 submission:=public.submit_appointment_review(ap,4,'내 후기','positive',array['test_time']);
 assert not(submission->>'deduplicated')::boolean;
 -- 같은 PL/pgSQL 호출 안의 제출 직후에도 STABLE 조회가 새 양측 후기를 본다.
 select * into review_state from public.get_appointment_review_state(ap);
 assert review_state.released and review_state.release_reason='mutual' and review_state.peer_review is not null;
 assert review_state.hold_until>clock_timestamp();
 assert (public.submit_appointment_review(ap,4,'내 후기','positive',array['test_time'])->>'deduplicated')::boolean;
 begin perform public.submit_appointment_review(ap,3,'다른 후기','neutral','{}'); raise exception 'mutation allowed'; exception when unique_violation then null; end;
 begin perform public.submit_appointment_review(md5('automation-ap7')::uuid,3,null,'neutral',array['test_kind']); raise exception 'neutral praise allowed'; exception when invalid_parameter_value then null; end;
 begin perform public.submit_appointment_review(md5('automation-ap7')::uuid,3,null,'positive',array['unknown']); raise exception 'unknown praise allowed'; exception when invalid_parameter_value then null; end;
 assert not has_function_privilege('authenticated','public.submit_appointment_review(uuid,integer,text)','execute');
 assert not has_function_privilege('authenticated','public.process_review_automation(integer,text,text)','execute');
 assert not has_function_privilege('anon','public.get_public_profile_reviews(uuid,integer,uuid)','execute');
 raise notice 'PASS policy publication, override hold, blank text, praise counts, outbox, dedupe, invalidation, immutable submission';
end; $$;
set local role authenticated;
select set_config('request.jwt.claim.sub',md5('automation-target')::uuid::text,true);
select jsonb_array_length(public.get_public_profile_reviews(md5('automation-target')::uuid,100,null)->'reviews') as public_count;
do $$ begin
 begin perform public.process_review_automation(10,'test','test'); raise exception 'member internal access'; exception when insufficient_privilege then null; end;
 begin perform public.submit_appointment_review(md5('automation-ap6')::uuid,4,'우회'); raise exception 'legacy bypass'; exception when insufficient_privilege then null; end;
end; $$;
reset role;
set local role service_role;
select public.process_review_automation(10,'test','test');
reset role;
rollback;
