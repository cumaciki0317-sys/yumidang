-- Run as local database owner after canonical migrations. All fixture writes roll back.
begin;
do $$
declare
  v_target uuid := '30000000-0000-0000-0000-000000000001';
  v_author uuid; v_post uuid; v_request uuid; v_appointment uuid; v_review uuid;
  v_snap jsonb; v_before jsonb; v_published jsonb; v_again jsonb; v_visible jsonb;
  v_ids uuid[]; v_i integer; v_revision text;
begin
  insert into auth.users(id) values (v_target);
  insert into public.profiles(id, real_name, birth_date) values (v_target, '대상회원', '1990-01-01');
  for v_i in 1..6 loop
    v_author := md5('summary-author-' || v_i)::uuid;
    v_post := md5('summary-post-' || v_i)::uuid;
    v_request := md5('summary-request-' || v_i)::uuid;
    v_appointment := md5('summary-appointment-' || v_i)::uuid;
    v_review := md5('summary-review-' || v_i)::uuid;
    insert into auth.users(id) values (v_author);
    insert into public.profiles(id, real_name, birth_date) values (v_author, '작성회원', '1990-01-01');
    insert into public.posts(id, author_id, title, description, category, starts_at, ends_at, recruitment_ends_at, public_area)
      values (v_post, v_author, '테스트 동행', '후기 검증', '산책', now()-interval '11 days', now()-interval '10 days', now()-interval '12 days', '서울특별시 강남구 역삼동');
    insert into public.join_requests(id, post_id, requester_id, message, status)
      values (v_request, v_post, v_target, '함께 동행하는 테스트입니다', 'matched');
    insert into public.appointments(id, post_id, join_request_id, status, completed_at, completion_method,
      completion_notified_at, dispute_deadline_at, review_deadline_at)
      values (v_appointment, v_post, v_request, 'completed', now()-interval '10 days', 'automatic',
        now()-interval '10 days', now()-interval '9 days', now()-interval '3 days');
    insert into public.appointment_reviews(id, appointment_id, reviewer_id, rating, comment)
      values (v_review, v_appointment, v_author, 5, case when v_i = 4 then null else '친절한 동행이었어요 ' || v_i end);
  end loop;
  -- 이 suite는 역사/운영자 공개 근거를 검증한다. 새 policy 후보와 구분한다.
  update private.review_publication set publication_source='override',is_public=false
    where review_id in(select id from public.appointment_reviews where appointment_id in
      (select id from public.appointments where join_request_id in(select id from public.join_requests where requester_id=v_target)));
  v_snap := public.load_public_review_snapshot(v_target);
  assert (v_snap->>'eligibleCount')::integer = 0, 'No legacy review may be auto-published';
  for v_i in 1..2 loop perform public.set_review_publication(md5('summary-review-' || v_i)::uuid, true); end loop;
  v_snap := public.load_public_review_snapshot(v_target);
  assert (v_snap->>'eligibleCount')::integer = 2, 'Two public text reviews';
  select array_agg((x->>'reviewId')::uuid) into v_ids from jsonb_array_elements(v_snap->'reviews') x;
  begin
    perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '두개 요약', 'model1', 'prompt1');
    raise exception 'Threshold failure expected';
  exception when serialization_failure then null; end;
  perform public.set_review_publication(md5('summary-review-3')::uuid, true);
  perform public.set_review_publication(md5('summary-review-4')::uuid, true);
  v_snap := public.load_public_review_snapshot(v_target);
  assert (v_snap->>'eligibleCount')::integer = 3, 'Null comment and nonpublic reviews excluded';
  assert (select bool_and((select count(*) from jsonb_object_keys(x)) = 2) from jsonb_array_elements(v_snap->'reviews') x), 'Source fields are only reviewId and text';
  select array_agg((x->>'reviewId')::uuid) into v_ids from jsonb_array_elements(v_snap->'reviews') x;
  begin
    perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', array[v_ids[1], v_ids[1], v_ids[2]], '중복', 'model1', 'prompt1');
    raise exception 'Evidence duplicate failure expected';
  exception when serialization_failure then null; end;
  -- Same technical token bounds as the job queue: 1..64, no colon.
  perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '버전 경계값', repeat('m', 64), repeat('p', 64));
  perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '버전 최소값', '_', '-');
  begin
    perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '빈 버전', '', 'p');
    raise exception 'Empty model version must fail';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '너무 긴 버전', repeat('m', 65), 'p');
    raise exception '65-character model version must fail';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '너무 긴 버전', 'm', repeat('p', 65));
    raise exception '65-character prompt version must fail';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '금지 문자', 'model:1', 'p');
    raise exception 'Colon in model version must fail';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '금지 문자', 'm', 'prompt:1');
    raise exception 'Colon in prompt version must fail';
  exception when invalid_parameter_value then null; end;
  v_published := public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '친절한 동행이라는 후기가 있어요.', 'model1', 'prompt1');
  v_again := public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '다른 내용으로 덮어쓰기 금지', 'model1', 'prompt1');
  assert v_published = v_again, 'Duplicate returns first stored metadata';
  perform set_config('request.jwt.claim.sub', v_target::text, true);
  v_visible := public.get_visible_review_summary(v_target);
  assert v_visible->'summary'->>'text' = '친절한 동행이라는 후기가 있어요.', 'First content retained';
  assert not (v_visible->'summary' ? 'evidenceReviewIds') and not (v_visible->'summary' ? 'modelVersion'), 'Internal metadata hidden';
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.get_visible_review_summary(v_target);
    raise exception 'Auth required expected';
  exception when invalid_authorization_specification then null; end;
  perform set_config('request.jwt.claim.sub', v_target::text, true);
  v_before := v_snap;
  perform public.set_review_publication(md5('summary-review-1')::uuid, false);
  assert public.get_visible_review_summary(v_target)->'summary' = 'null'::jsonb, 'Private transition immediately hides summary';
  begin
    perform public.publish_review_summary(v_target, v_before->>'sourceRevision', v_ids, '오래된 요약', 'model1', 'prompt1');
    raise exception 'Revision conflict expected';
  exception when serialization_failure then null; end;
  perform public.set_review_publication(md5('summary-review-1')::uuid, true);
  v_snap := public.load_public_review_snapshot(v_target);
  perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '새 요약', 'model1', 'prompt1');
  update public.appointment_reviews set comment = '수정된 텍스트' where id = md5('summary-review-1')::uuid;
  assert public.get_visible_review_summary(v_target)->'summary' = 'null'::jsonb, 'Source text change invalidates summary';
  v_snap := public.load_public_review_snapshot(v_target);
  perform public.publish_review_summary(v_target, v_snap->>'sourceRevision', v_ids, '수정 반영 요약', 'model1', 'prompt1');
  insert into public.appointment_disputes(appointment_id, raised_by_user_id, reason, review_time_remaining)
    values (md5('summary-appointment-1')::uuid, v_target, '검증용 이의', interval '1 day');
  assert public.get_visible_review_summary(v_target)->'summary' = 'null'::jsonb, 'Dispute alone invalidates without appointment status update';
  v_snap := public.load_public_review_snapshot(v_target);
  assert (v_snap->>'eligibleCount')::integer = 2, 'Disputed source excluded';
  update public.appointments set completion_method = 'manual', completed_by_user_id = md5('summary-author-5')::uuid
    where id = md5('summary-appointment-5')::uuid;
  insert into public.appointment_completion_confirmations(appointment_id, user_id)
    values (md5('summary-appointment-5')::uuid, md5('summary-author-5')::uuid);
  begin
    perform public.set_review_publication(md5('summary-review-5')::uuid, true);
    raise exception 'Legacy one-sided manual completion must not qualify';
  exception when serialization_failure then null; end;
  insert into public.appointment_completion_confirmations(appointment_id, user_id)
    values (md5('summary-appointment-5')::uuid, v_target);
  perform public.set_review_publication(md5('summary-review-5')::uuid, true);
  perform public.set_review_publication(md5('summary-review-5')::uuid, false);
  update public.appointments set completion_notified_at = now(), dispute_deadline_at = now()+interval '24 hours'
    where id = md5('summary-appointment-5')::uuid;
  begin
    perform public.set_review_publication(md5('summary-review-5')::uuid, true);
    raise exception 'Hold expected';
  exception when serialization_failure then null; end;
  delete from public.appointment_reviews where id = md5('summary-review-2')::uuid;
  v_snap := public.load_public_review_snapshot(v_target);
  assert (v_snap->>'eligibleCount')::integer = 1, 'Deleted source excluded';
  assert not has_function_privilege('anon', 'public.load_public_review_snapshot(uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.load_public_review_snapshot(uuid)', 'execute');
  assert not has_function_privilege('authenticated', 'public.set_review_publication(uuid,boolean)', 'execute');
  assert not has_function_privilege('authenticated', 'public.publish_review_summary(uuid,text,uuid[],text,text,text)', 'execute');
  assert not has_function_privilege('anon', 'public.get_visible_review_summary(uuid)', 'execute');
  assert has_function_privilege('service_role', 'public.load_public_review_snapshot(uuid)', 'execute');
  assert has_function_privilege('service_role', 'public.set_review_publication(uuid,boolean)', 'execute');
  assert has_function_privilege('authenticated', 'public.get_visible_review_summary(uuid)', 'execute');
  assert not has_table_privilege('authenticated', 'private.review_summaries', 'select');
  assert not has_table_privilege('service_role', 'private.review_summaries', 'select');
  assert (select relrowsecurity from pg_class where oid = 'private.review_summaries'::regclass);
  raise notice 'PASS: review summary threshold, privacy, exact sources, idempotency, revisions, dispute, hold, deletion, grants';
end;
$$;
-- Exercise actual application roles, not just ACL catalog inspection.
set local role service_role;
select public.load_public_review_snapshot('30000000-0000-0000-0000-000000000001')->>'eligibleCount' as service_snapshot_count;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000001', true);
select public.get_visible_review_summary('30000000-0000-0000-0000-000000000001');
do $$ begin
  begin
    perform public.load_public_review_snapshot('30000000-0000-0000-0000-000000000001');
    raise exception 'Member worker call must fail';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
rollback;
