-- 제안 03_review_summary_worker.sql 검사. run_proposals.py가 BEGIN/ROLLBACK으로 감싼다(여기에 트랜잭션 제어문 없음).
-- 가상 사용자·공고·후기만 사용한다. 점유 만료는 짧은 lease + pg_sleep과 소유자 시각 조정으로 재현한다.
do $$
declare
  v_fn text; v_role text;
begin
  -- 권한: 새 RPC는 service_role만, 보조 함수·비공개 테이블은 직접 접근 불가.
  foreach v_fn in array array[
    'public.yield_job(uuid,uuid,timestamptz)', 'public.fail_job(uuid,uuid,text)', 'public.supersede_job(uuid,uuid)',
    'public.load_review_summary_source(uuid,uuid)', 'public.load_review_summary_checkpoint(uuid,uuid,text)',
    'public.save_review_summary_checkpoint(uuid,uuid,text,jsonb)', 'public.discard_review_summary_checkpoint(uuid,uuid,text)',
    'public.mark_review_summary_insufficient(uuid,uuid,text)',
    'public.publish_review_summary_for_job(uuid,uuid,text,uuid[],text,text,text)',
    'public.claim_job(uuid,integer)', 'public.complete_job(uuid,uuid)', 'public.retry_job(uuid,uuid,timestamptz,text)'] loop
    assert has_function_privilege('service_role', v_fn, 'execute'), 'service_role execute ' || v_fn;
    assert not has_function_privilege('anon', v_fn, 'execute'), 'anon execute ' || v_fn;
    assert not has_function_privilege('authenticated', v_fn, 'execute'), 'authenticated execute ' || v_fn;
  end loop;
  foreach v_fn in array array['private.review_summary_checkpoint_shape_ok(jsonb)', 'private.lock_running_job(uuid,uuid)',
    'private.summary_job_for_lease(uuid,uuid)'] loop
    assert not has_function_privilege('service_role', v_fn, 'execute'), 'helper exposed ' || v_fn;
  end loop;
  foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
    assert not has_table_privilege(v_role, 'private.review_summary_checkpoints', 'SELECT,INSERT,UPDATE,DELETE');
    assert not has_table_privilege(v_role, 'private.review_summary_job_publications', 'SELECT,INSERT,UPDATE,DELETE');
  end loop;
  assert (select relrowsecurity from pg_class where oid = 'private.review_summary_checkpoints'::regclass);
  assert (select relrowsecurity from pg_class where oid = 'private.review_summary_job_publications'::regclass);
  -- 중간 저장 테이블에 후기 원문·작성자 컬럼이 없다.
  assert not exists(select 1 from information_schema.columns where table_schema = 'private'
    and table_name in ('review_summary_checkpoints', 'review_summary_job_publications')
    and column_name ~ '(comment|text|reviewer|author|name)');
end $$;

-- 가상 자료: 작성자 a가 대상 b에게 남긴 한마디 후기 5개(모두 공개 조건 충족) + 평가만 있는 후기 1개.
do $$
declare
  a uuid := md5('rsw-author')::uuid; b uuid := md5('rsw-target')::uuid;
  p uuid; r uuid; ap uuid;
begin
  insert into auth.users(id) values (a), (b);
  insert into public.profiles(id, real_name, birth_date) values (a, '가상작성자', '1990-01-01'), (b, '가상대상자', '1990-01-01');
  for i in 1..6 loop
    p := md5('rsw-p' || i)::uuid; r := md5('rsw-r' || i)::uuid; ap := md5('rsw-ap' || i)::uuid;
    insert into public.posts(id, author_id, title, description, category, starts_at, ends_at, recruitment_ends_at, public_area)
      values (p, a, '요약 작업 검증', '가상 회귀 검사', '산책', now() - interval '4 days', now() - interval '3 days',
        now() - interval '5 days', '서울특별시 강남구 역삼동');
    insert into public.join_requests(id, post_id, requester_id, message, status) values (r, p, b, '가상 요약 검사 신청입니다', 'matched');
    insert into public.appointments(id, post_id, join_request_id, status, completed_at, completion_method,
        completion_notified_at, dispute_deadline_at, review_deadline_at)
      values (ap, p, r, 'completed', now() - interval '2 days', 'automatic', now() - interval '2 days',
        now() - interval '1 day', now() + interval '5 days');
    insert into public.appointment_reviews(id, appointment_id, reviewer_id, rating, comment)
      values (md5('rsw-rv' || i)::uuid, ap, a, 5, case when i = 6 then null else 'RAW_REVIEW_TEXT_' || i end);
  end loop;
end $$;

do $$
declare
  b uuid := md5('rsw-target')::uuid;
  w uuid := '11111111-1111-4111-8111-111111111111';
  v_payload jsonb; v_snapshot jsonb; v_rev text; v_ids text[]; v_x jsonb; v_job uuid;
  t1 uuid; t2 uuid; t3 uuid; t4 uuid; t5 uuid; v_cp jsonb; v_bad jsonb; v_denied boolean;
  v_published timestamptz; v_summary uuid; v_rows integer;
begin
  v_snapshot := public.load_public_review_snapshot(b);
  v_rev := v_snapshot->>'sourceRevision';
  assert (v_snapshot->>'eligibleCount')::int = 5, '한마디 없는 평가는 제외: ' || v_snapshot::text;
  select array_agg(x->>'reviewId' order by x->>'reviewId') into v_ids from jsonb_array_elements(v_snapshot->'reviews') x;
  v_payload := jsonb_build_object('profileId', b, 'sourceRevision', v_rev, 'modelVersion', 'model-a', 'promptVersion', 'review-summary-v1');
  v_job := (public.enqueue_job('review_summary', 'review_summary:' || b || ':' || v_rev || ':model-a:review-summary-v1',
    v_payload, clock_timestamp())->>'jobId')::uuid;

  -- 짧은 점유(1초). 점유 횟수와 실패 횟수를 따로 반환한다.
  v_x := public.claim_job(w, 1)->'job';
  t1 := (v_x->>'leaseToken')::uuid;
  assert (v_x->>'jobId')::uuid = v_job and (v_x->>'attempt')::int = 1 and (v_x->>'failedAttempts')::int = 0, v_x::text;

  -- 원문 snapshot은 revision을 문자열로 준다.
  v_x := public.load_review_summary_source(v_job, t1);
  assert v_x->>'status' = 'applied' and jsonb_typeof(v_x->'sourceRevision') = 'string' and v_x->>'sourceRevision' = v_rev, v_x::text;
  assert (v_x->>'eligibleCount')::int = 5 and jsonb_array_length(v_x->'reviews') = 5;
  v_x := public.load_review_summary_checkpoint(v_job, t1, v_rev);
  assert v_x = jsonb_build_object('status', 'applied', 'checkpoint', null), v_x::text;

  -- 중간 저장: 처리 위치·근거 ID·생성 주장만. 후기 원문이 저장되지 않는다.
  v_cp := jsonb_build_object('schemaVersion', 1, 'sourceReviewIds', to_jsonb(v_ids), 'nextReviewIndex', 2,
    'nodes', jsonb_build_array(jsonb_build_object('sourceReviewIds', to_jsonb(v_ids[1:2]),
      'claims', jsonb_build_array(jsonb_build_object('text', '가상 중간 주장', 'evidenceIds', to_jsonb(v_ids[1:2]))),
      'modelVersions', jsonb_build_array('potens.synthetic'))));
  assert public.save_review_summary_checkpoint(v_job, t1, v_rev, v_cp)->>'status' = 'applied';
  assert (select count(*) from private.review_summary_checkpoints where job_id = v_job) = 1;
  assert not exists(select 1 from private.review_summary_checkpoints where checkpoint::text like '%RAW_REVIEW_TEXT%');

  -- 원문을 그대로 복제한 주장·전체 근거 불일치는 저장하지 않는다. 기존 저장은 그대로다.
  v_bad := jsonb_set(v_cp, '{nodes,0,claims,0,text}', to_jsonb('RAW_REVIEW_TEXT_1'::text));
  -- v_ids 정렬 순서의 첫 원문이 무엇이든 한 원문과 같도록 모든 원문으로 시도한다.
  for i in 1..5 loop
    v_bad := jsonb_set(v_cp, '{nodes,0,claims,0,text}', to_jsonb('RAW_REVIEW_TEXT_' || i));
    assert public.save_review_summary_checkpoint(v_job, t1, v_rev, v_bad)->>'status' = 'invalid_evidence';
  end loop;
  assert public.save_review_summary_checkpoint(v_job, t1, v_rev,
    jsonb_set(v_cp, '{sourceReviewIds}', to_jsonb(v_ids[1:4])) || '{"nextReviewIndex":2}')->>'status' = 'invalid_evidence';
  assert not exists(select 1 from private.review_summary_checkpoints where checkpoint::text like '%RAW_REVIEW_TEXT%');
  -- 허용되지 않은 키(원문 사본 등)·근거 밖 ID는 형태 오류(22023).
  foreach v_bad in array array[
    v_cp || jsonb_build_object('reviews', jsonb_build_array('RAW_REVIEW_TEXT_1')),
    jsonb_set(v_cp, '{nodes,0,comment}', '"RAW_REVIEW_TEXT_1"'),
    jsonb_set(v_cp, '{nodes,0,claims,0,evidenceIds}', to_jsonb(array[v_ids[5]])),
    jsonb_set(v_cp, '{nextReviewIndex}', '9'),
    jsonb_set(v_cp, '{schemaVersion}', '2')] loop
    begin
      perform public.save_review_summary_checkpoint(v_job, t1, v_rev, v_bad); v_denied := false;
    exception when invalid_parameter_value then v_denied := true; end;
    assert v_denied, 'shape accepted: ' || v_bad::text;
  end loop;
  -- 작업과 다른 revision 주장은 입력 오류.
  begin perform public.load_review_summary_checkpoint(v_job, t1, (v_rev::bigint + 1)::text); v_denied := false;
  exception when invalid_parameter_value then v_denied := true; end;
  assert v_denied;

  -- 잘못된 토큰: 요약 RPC는 lease_lost, 작업 전이는 state_conflict.
  assert public.load_review_summary_source(v_job, gen_random_uuid())->>'status' = 'lease_lost';
  assert public.save_review_summary_checkpoint(v_job, gen_random_uuid(), v_rev, v_cp)->>'status' = 'lease_lost';
  assert public.discard_review_summary_checkpoint(v_job, gen_random_uuid(), v_rev)->>'status' = 'lease_lost';
  begin perform public.yield_job(v_job, gen_random_uuid(), null); v_denied := false;
  exception when sqlstate 'P0001' then v_denied := sqlerrm = 'state_conflict'; end;
  assert v_denied;

  -- 실제 DB 시각 기준 점유 만료: 이전 토큰의 조회·쓰기·전이가 모두 거절된다.
  perform pg_sleep(1.2);
  assert public.load_review_summary_source(v_job, t1)->>'status' = 'lease_lost';
  assert public.save_review_summary_checkpoint(v_job, t1, v_rev, v_cp)->>'status' = 'lease_lost';
  assert public.publish_review_summary_for_job(v_job, t1, v_rev, v_ids::uuid[], '가상 요약', 'model-a', 'review-summary-v1')->>'status' = 'lease_lost';
  begin perform public.supersede_job(v_job, t1); v_denied := false;
  exception when sqlstate 'P0001' then v_denied := true; end;
  assert v_denied;

  -- 재점유: 점유 횟수만 증가, 실패 횟수 0, 중간 저장에서 재개.
  v_x := public.claim_job(w, 60)->'job';
  t2 := (v_x->>'leaseToken')::uuid;
  assert (v_x->>'jobId')::uuid = v_job and (v_x->>'attempt')::int = 2 and (v_x->>'failedAttempts')::int = 0 and t2 <> t1;
  v_x := public.load_review_summary_checkpoint(v_job, t2, v_rev);
  assert v_x->>'status' = 'applied' and (v_x->'checkpoint'->>'nextReviewIndex')::int = 2
    and v_x->'checkpoint'->>'sourceRevision' = v_rev and v_x->'checkpoint'->>'modelVersion' = 'model-a'
    and v_x->'checkpoint'->>'profileId' = b::text, v_x::text;

  -- 정상 양보: 실패 횟수 미증가, 중간 저장 보존, 과거 시각 거절.
  begin perform public.yield_job(v_job, t2, clock_timestamp() - interval '1 minute'); v_denied := false;
  exception when invalid_parameter_value then v_denied := true; end;
  assert v_denied;
  assert public.yield_job(v_job, t2, null)->>'status' = 'queued';
  assert (select failed_attempts from private.worker_jobs where id = v_job) = 0;
  assert (select status from private.worker_jobs where id = v_job) = 'queued';
  assert exists(select 1 from private.review_summary_checkpoints where job_id = v_job);
  v_x := public.claim_job(w, 60)->'job';
  t3 := (v_x->>'leaseToken')::uuid;
  assert (v_x->>'attempt')::int = 3 and (v_x->>'failedAttempts')::int = 0;

  -- 실제 실패 재시도: 실패 횟수 증가, 중간 저장 보존.
  assert public.retry_job(v_job, t3, clock_timestamp() + interval '1 hour', 'UPSTREAM_UNAVAILABLE')->>'status' = 'retry_wait';
  assert (select failed_attempts from private.worker_jobs where id = v_job) = 1;
  assert exists(select 1 from private.review_summary_checkpoints where job_id = v_job);
  assert public.claim_job(w, 60) = '{"job":null}'::jsonb, 'future retry not claimable';
  update private.worker_jobs set available_at = clock_timestamp() - interval '1 second' where id = v_job;
  v_x := public.claim_job(w, 60)->'job';
  t4 := (v_x->>'leaseToken')::uuid;
  assert (v_x->>'attempt')::int = 4 and (v_x->>'failedAttempts')::int = 1;
  -- 점유를 잃은 이전 실행기는 현재 작업의 중간 저장을 지우지 못한다.
  assert public.discard_review_summary_checkpoint(v_job, t3, v_rev)->>'status' = 'lease_lost';
  assert exists(select 1 from private.review_summary_checkpoints where job_id = v_job);

  -- 잘못된 근거 게시 거절(부분 집합·중복·null).
  assert public.publish_review_summary_for_job(v_job, t4, v_rev, (v_ids[1:4])::uuid[], '가상 요약', 'model-a', 'review-summary-v1')->>'status' = 'invalid_evidence';
  assert public.publish_review_summary_for_job(v_job, t4, v_rev, (v_ids[1:4] || v_ids[1])::uuid[], '가상 요약', 'model-a', 'review-summary-v1')->>'status' = 'invalid_evidence';
  assert public.publish_review_summary_for_job(v_job, t4, v_rev, (v_ids[1:4] || null::text)::uuid[], '가상 요약', 'model-a', 'review-summary-v1')->>'status' = 'invalid_evidence';
  begin perform public.publish_review_summary_for_job(v_job, t4, v_rev, v_ids::uuid[], '가상 요약', 'model-b', 'review-summary-v1'); v_denied := false;
  exception when invalid_parameter_value then v_denied := true; end;
  assert v_denied, 'job model version mismatch';
  assert exists(select 1 from private.review_summary_checkpoints where job_id = v_job);

  -- 원자 게시: 요약·표시·중간 저장 삭제·게시 표식.
  v_x := public.publish_review_summary_for_job(v_job, t4, v_rev, v_ids::uuid[], '가상 요약', 'model-a', 'review-summary-v1');
  assert v_x->>'status' = 'applied' and (v_x->>'sourceCount')::int = 5 and v_x->>'sourceRevision' = v_rev, v_x::text;
  v_published := (v_x->>'publishedAt')::timestamptz; v_summary := (v_x->>'summaryId')::uuid;
  assert (select visible_summary_id from private.review_summary_state where profile_id = b) = v_summary;
  assert not exists(select 1 from private.review_summary_checkpoints where job_id = v_job);
  assert (select count(*) from private.review_summary_job_publications where job_id = v_job) = 1;

  -- settle 전 중단 → 점유 만료 → 재실행: 모델 재호출 없이 already_published, 재게시는 같은 결과·시각.
  update private.worker_jobs set lease_expires_at = clock_timestamp() - interval '1 second' where id = v_job;
  v_x := public.claim_job(w, 60)->'job';
  t5 := (v_x->>'leaseToken')::uuid;
  assert (v_x->>'failedAttempts')::int = 1, '점유 만료는 실패로 세지 않음';
  assert public.load_review_summary_source(v_job, t5)->>'status' = 'already_published';
  perform pg_sleep(0.01);
  v_x := public.publish_review_summary_for_job(v_job, t5, v_rev, v_ids::uuid[], '다른 가상 요약', 'model-a', 'review-summary-v1');
  assert v_x->>'status' = 'applied' and (v_x->>'summaryId')::uuid = v_summary and (v_x->>'publishedAt')::timestamptz = v_published, v_x::text;
  assert (select count(*) from private.review_summaries where profile_id = b) = 1;
  assert (select summary_text from private.review_summaries where id = v_summary) = '가상 요약';
  assert (select count(*) from private.review_summary_job_publications where job_id = v_job) = 1;
  assert public.complete_job(v_job, t5)->>'status' = 'succeeded';
  assert (select completed_at is not null and failed_attempts = 1 from private.worker_jobs where id = v_job);
  assert public.claim_job(w, 60) = '{"job":null}'::jsonb;
end $$;

-- 원문 변경·비공개 전환: 같은 트랜잭션에서 중간 저장 삭제, 오래된 게시·저장 거절, 대체 종결.
do $$
declare
  b uuid := md5('rsw-target')::uuid; w uuid := '11111111-1111-4111-8111-111111111111';
  v_rev text; v_new text; v_ids text[]; v_job uuid; t uuid; v_x jsonb; v_cp jsonb; v_denied boolean;
  v_scenario text;
begin
  foreach v_scenario in array array['edit', 'private'] loop
    v_x := public.load_public_review_snapshot(b);
    v_rev := v_x->>'sourceRevision';
    select array_agg(x->>'reviewId' order by x->>'reviewId') into v_ids from jsonb_array_elements(v_x->'reviews') x;
    v_job := (public.enqueue_job('review_summary', 'review_summary:' || b || ':' || v_rev || ':model-' || v_scenario || ':review-summary-v1',
      jsonb_build_object('profileId', b, 'sourceRevision', v_rev, 'modelVersion', 'model-' || v_scenario, 'promptVersion', 'review-summary-v1'),
      clock_timestamp())->>'jobId')::uuid;
    t := (public.claim_job(w, 60)->'job'->>'leaseToken')::uuid;
    v_cp := jsonb_build_object('schemaVersion', 1, 'sourceReviewIds', to_jsonb(v_ids), 'nextReviewIndex', 1,
      'nodes', jsonb_build_array(jsonb_build_object('sourceReviewIds', to_jsonb(v_ids[1:1]),
        'claims', jsonb_build_array(jsonb_build_object('text', '가상 중간 주장', 'evidenceIds', to_jsonb(v_ids[1:1]))),
        'modelVersions', jsonb_build_array('potens.synthetic'))));
    assert public.save_review_summary_checkpoint(v_job, t, v_rev, v_cp)->>'status' = 'applied';
    if v_scenario = 'edit' then
      update public.appointment_reviews set comment = 'RAW_REVIEW_TEXT_EDITED' where id = md5('rsw-rv1')::uuid;
    else
      perform public.set_review_publication(md5('rsw-rv2')::uuid, false);
    end if;
    -- 원문 변경 트랜잭션에서 이미 삭제됨.
    assert not exists(select 1 from private.review_summary_checkpoints where job_id = v_job), v_scenario;
    assert public.publish_review_summary_for_job(v_job, t, v_rev, v_ids::uuid[], '가상 요약', 'model-' || v_scenario, 'review-summary-v1')->>'status' = 'stale_revision';
    assert public.save_review_summary_checkpoint(v_job, t, v_rev, v_cp)->>'status' = 'stale_revision';
    assert public.load_review_summary_checkpoint(v_job, t, v_rev)->>'status' = 'stale_revision';
    assert public.mark_review_summary_insufficient(v_job, t, v_rev)->>'status' = 'stale_revision';
    v_x := public.load_review_summary_source(v_job, t);
    v_new := v_x->>'sourceRevision';
    assert v_x->>'status' = 'applied' and v_new::bigint > v_rev::bigint, v_x::text;
    assert public.supersede_job(v_job, t)->>'status' = 'superseded';
    assert (select status = 'superseded' and completed_at is not null and failed_attempts = 0 from private.worker_jobs where id = v_job);
    assert public.claim_job(w, 60) = '{"job":null}'::jsonb, 'superseded not claimable';
    -- 이전 요약은 더 이상 표시되지 않는다.
    assert (select visible_summary_id from private.review_summary_state where profile_id = b) is null;
  end loop;
end $$;

-- 3개 경계: 3개 이상이면 insufficient 거절, 미만이면 DB가 재확인 후 표시 요약·중간 저장 정리.
-- 실패 종결은 실패 횟수 증가·중간 저장 삭제. 큰 revision은 문자열 그대로.
do $$
declare
  b uuid := md5('rsw-target')::uuid; w uuid := '11111111-1111-4111-8111-111111111111';
  v_rev text; v_ids text[]; v_job uuid; t uuid; v_x jsonb; v_cp jsonb; v_denied boolean;
begin
  v_x := public.load_public_review_snapshot(b);
  v_rev := v_x->>'sourceRevision';
  assert (v_x->>'eligibleCount')::int = 4, v_x::text;
  select array_agg(x->>'reviewId' order by x->>'reviewId') into v_ids from jsonb_array_elements(v_x->'reviews') x;
  v_job := (public.enqueue_job('review_summary', 'review_summary:' || b || ':' || v_rev || ':model-f:review-summary-v1',
    jsonb_build_object('profileId', b, 'sourceRevision', v_rev, 'modelVersion', 'model-f', 'promptVersion', 'review-summary-v1'),
    clock_timestamp())->>'jobId')::uuid;
  t := (public.claim_job(w, 60)->'job'->>'leaseToken')::uuid;
  assert public.mark_review_summary_insufficient(v_job, t, v_rev)->>'status' = 'invalid_evidence', '4개는 부족 아님';
  v_cp := jsonb_build_object('schemaVersion', 1, 'sourceReviewIds', to_jsonb(v_ids), 'nextReviewIndex', 0, 'nodes', '[]'::jsonb);
  assert public.save_review_summary_checkpoint(v_job, t, v_rev, v_cp)->>'status' = 'applied';
  begin perform public.fail_job(v_job, t, 'PRIVATE RAW MODEL ERROR'); v_denied := false;
  exception when invalid_parameter_value then v_denied := true; end;
  assert v_denied, 'raw error code rejected';
  assert public.fail_job(v_job, t, 'INTERNAL_ERROR')->>'status' = 'failed';
  assert (select status = 'failed' and failed_attempts = 1 and completed_at is not null and last_error_code = 'INTERNAL_ERROR'
    from private.worker_jobs where id = v_job);
  assert not exists(select 1 from private.review_summary_checkpoints where job_id = v_job);
  assert public.claim_job(w, 60) = '{"job":null}'::jsonb, 'failed not claimable';
  -- 같은 키 재등록은 종결 상태를 그대로 돌려준다(자동 부활 없음).
  v_x := public.enqueue_job('review_summary', 'review_summary:' || b || ':' || v_rev || ':model-f:review-summary-v1',
    jsonb_build_object('profileId', b, 'sourceRevision', v_rev, 'modelVersion', 'model-f', 'promptVersion', 'review-summary-v1'), clock_timestamp());
  assert v_x->>'status' = 'failed' and (v_x->>'deduplicated')::boolean;

  -- 2개로 줄이면 부족 처리.
  perform public.set_review_publication(md5('rsw-rv3')::uuid, false);
  perform public.set_review_publication(md5('rsw-rv4')::uuid, false);
  v_x := public.load_public_review_snapshot(b);
  v_rev := v_x->>'sourceRevision';
  assert (v_x->>'eligibleCount')::int = 2, v_x::text;
  v_job := (public.enqueue_job('review_summary', 'review_summary:' || b || ':' || v_rev || ':model-i:review-summary-v1',
    jsonb_build_object('profileId', b, 'sourceRevision', v_rev, 'modelVersion', 'model-i', 'promptVersion', 'review-summary-v1'),
    clock_timestamp())->>'jobId')::uuid;
  t := (public.claim_job(w, 60)->'job'->>'leaseToken')::uuid;
  assert public.save_review_summary_checkpoint(v_job, t, v_rev, v_cp)->>'status' = 'insufficient_reviews';
  assert public.publish_review_summary_for_job(v_job, t, v_rev, v_ids::uuid[], '가상 요약', 'model-i', 'review-summary-v1')->>'status' = 'insufficient_reviews';
  update private.review_summary_state set visible_summary_id = (select id from private.review_summaries limit 1) where profile_id = b;
  assert public.mark_review_summary_insufficient(v_job, t, v_rev)->>'status' = 'applied';
  assert (select visible_summary_id from private.review_summary_state where profile_id = b) is null;
  assert public.complete_job(v_job, t)->>'status' = 'succeeded';

  -- bigint revision: JS 안전 정수 초과값도 문자열 그대로 왕복한다.
  update private.review_summary_state set revision = 9007199254740993 where profile_id = b;
  v_x := public.load_public_review_snapshot(b);
  assert v_x->>'sourceRevision' = '9007199254740993', v_x::text;
  v_job := (public.enqueue_job('review_summary', 'review_summary:' || b || ':9007199254740993:model-l:review-summary-v1',
    jsonb_build_object('profileId', b, 'sourceRevision', '9007199254740993', 'modelVersion', 'model-l', 'promptVersion', 'review-summary-v1'),
    clock_timestamp())->>'jobId')::uuid;
  t := (public.claim_job(w, 60)->'job'->>'leaseToken')::uuid;
  v_x := public.load_review_summary_source(v_job, t);
  assert v_x->>'sourceRevision' = '9007199254740993' and jsonb_typeof(v_x->'sourceRevision') = 'string';
  assert public.load_review_summary_checkpoint(v_job, t, '9007199254740993')->>'status' = 'applied';
  assert public.supersede_job(v_job, t)->>'status' = 'superseded';
end $$;

-- 실제 service_role 호출 경로(권한 부여 확인). 다른 역할은 거절.
set local role service_role;
do $$ begin
  assert public.load_review_summary_source(gen_random_uuid(), gen_random_uuid())->>'status' = 'lease_lost';
  assert public.discard_review_summary_checkpoint(gen_random_uuid(), gen_random_uuid(), '1')->>'status' = 'lease_lost';
  begin perform count(*) from private.review_summary_checkpoints; raise exception 'direct read allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set local role authenticated;
do $$ begin
  begin perform public.load_review_summary_source(gen_random_uuid(), gen_random_uuid()); raise exception 'member allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
