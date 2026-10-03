-- 전용 로컬 최신 DB의 합성 회원 자료다. 실제 네이버 인증을 뜻하지 않는다.
-- 숨김은 본인 목록에만 적용하며 다른 업무 자료와 기존 메시지 권한을 보존한다.
BEGIN;
SET LOCAL plpgsql.check_asserts = on;
SET LOCAL TIME ZONE 'UTC';

CREATE FUNCTION pg_temp.cv_id(p_n integer) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT ('c6100301-0000-4000-8000-'||lpad(p_n::text,12,'0'))::uuid;
$$;
CREATE FUNCTION pg_temp.cv_claim(p_n integer, p_guest boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', CASE WHEN p_n IS NULL THEN '' ELSE pg_temp.cv_id(p_n)::text END, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',pg_temp.cv_id(p_n),
    'role','authenticated','is_anonymous',p_guest)::text, true);
END;
$$;

DO $$ BEGIN
  ASSERT current_setting('plpgsql.check_asserts') = 'on';
  ASSERT (SELECT relrowsecurity FROM pg_class WHERE oid = 'private.conversation_visibility'::regclass);
  ASSERT NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'private.conversation_visibility'::regclass);
  ASSERT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'private.conversation_visibility'::regclass
    AND contype = 'p' AND conkey = ARRAY[1,2]::smallint[]);
  ASSERT (SELECT count(*) FROM pg_constraint WHERE conrelid = 'private.conversation_visibility'::regclass
    AND contype = 'f' AND confdeltype = 'c') = 2;
  ASSERT EXISTS (SELECT 1 FROM pg_index WHERE indrelid = 'private.conversation_visibility'::regclass
    AND indisvalid AND indkey::text = '2');
  ASSERT has_function_privilege('authenticated','public.leave_conversation(uuid)','EXECUTE');
  ASSERT NOT has_function_privilege('anon','public.leave_conversation(uuid)','EXECUTE');
  ASSERT NOT has_function_privilege('service_role','public.leave_conversation(uuid)','EXECUTE');
  ASSERT NOT has_table_privilege('authenticated','private.conversation_visibility','SELECT,INSERT,UPDATE,DELETE');
  ASSERT NOT has_table_privilege('anon','private.conversation_visibility','SELECT,INSERT,UPDATE,DELETE');
  ASSERT NOT has_table_privilege('service_role','private.conversation_visibility','SELECT,INSERT,UPDATE,DELETE');
  ASSERT (SELECT prosecdef AND proconfig = ARRAY['search_path=""']::text[]
    FROM pg_proc WHERE oid = 'public.leave_conversation(uuid)'::regprocedure);
  ASSERT (SELECT proargnames = ARRAY['request_id','my_role','request_status','post_id','post_title',
    'post_starts_at','counterpart_masked_name','counterpart_avatar_url','last_message','last_message_at','last_activity_at']::text[]
    FROM pg_proc WHERE oid = 'public.list_conversations()'::regprocedure);
END; $$;
SELECT 'CONVERSATION_VISIBILITY_CHECK:acl_and_unique_cascade';

INSERT INTO auth.users(id) SELECT pg_temp.cv_id(n) FROM generate_series(1,3) n;
INSERT INTO public.profiles(id,real_name,birth_date,gender) VALUES
  (pg_temp.cv_id(1),'목록작성자','1990-01-01','female'),
  (pg_temp.cv_id(2),'목록신청자','1990-01-01','female'),
  (pg_temp.cv_id(3),'다른신청자','1990-01-01','male');
INSERT INTO public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,
  public_area,preference_note,status,cost_type,amount) VALUES
  (pg_temp.cv_id(11),pg_temp.cv_id(1),'목록 합성 공고','대화 숨김 검사용 공고','산책',
   now()+interval '30 days',now()+interval '31 days',now()+interval '29 days',
   '서울특별시 강남구 역삼동','합성 조건','recruiting','free',0),
  (pg_temp.cv_id(12),pg_temp.cv_id(1),'확정 합성 공고','확정 대화 숨김 검사용 공고','산책',
   now()+interval '32 days',now()+interval '33 days',now()+interval '31 days',
   '서울특별시 강남구 역삼동','합성 조건','closed','free',0);
INSERT INTO public.join_requests(id,post_id,requester_id,message,status,updated_at) VALUES
  (pg_temp.cv_id(21),pg_temp.cv_id(11),pg_temp.cv_id(2),'대화 숨김 검사용 합성 신청 내용','pending',now()-interval '3 hours'),
  (pg_temp.cv_id(22),pg_temp.cv_id(11),pg_temp.cv_id(3),'철회 대화 보존용 합성 신청 내용','withdrawn',now()-interval '2 hours'),
  (pg_temp.cv_id(23),pg_temp.cv_id(12),pg_temp.cv_id(2),'확정 대화 보존용 합성 신청 내용','matched',now()-interval '1 hour');
INSERT INTO public.appointments(id,post_id,join_request_id,status)
  VALUES (pg_temp.cv_id(31),pg_temp.cv_id(12),pg_temp.cv_id(23),'confirmed');
INSERT INTO public.chat_messages(id,join_request_id,sender_id,content,created_at) VALUES
  (pg_temp.cv_id(41),pg_temp.cv_id(21),pg_temp.cv_id(1),'합성 기존 메시지',now()-interval '4 hours'),
  (pg_temp.cv_id(42),pg_temp.cv_id(22),pg_temp.cv_id(3),'합성 철회 메시지',now()-interval '3 hours'),
  (pg_temp.cv_id(43),pg_temp.cv_id(23),pg_temp.cv_id(2),'합성 확정 메시지',now()-interval '2 hours');
-- 나가기 전 업무 자료의 해시와 목록 투영을 비교한다. 제품 권한을 추가하지 않는다.
CREATE TEMPORARY TABLE cv_originals AS
  SELECT 'posts' AS category, md5(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text) AS hash
    FROM public.posts p WHERE p.id IN (pg_temp.cv_id(11),pg_temp.cv_id(12))
  UNION ALL SELECT 'requests',md5(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text)
    FROM public.join_requests r WHERE r.id IN (pg_temp.cv_id(21),pg_temp.cv_id(22),pg_temp.cv_id(23))
  UNION ALL SELECT 'appointments',md5(jsonb_agg(to_jsonb(a) ORDER BY a.id)::text)
    FROM public.appointments a WHERE a.id = pg_temp.cv_id(31)
  UNION ALL SELECT 'messages',md5(jsonb_agg(to_jsonb(m) ORDER BY m.id)::text)
    FROM public.chat_messages m WHERE m.join_request_id IN (pg_temp.cv_id(21),pg_temp.cv_id(22),pg_temp.cv_id(23))
  UNION ALL SELECT 'notifications',md5(jsonb_agg(to_jsonb(n) ORDER BY n.id)::text)
    FROM public.notifications n WHERE n.join_request_id IN (pg_temp.cv_id(21),pg_temp.cv_id(22),pg_temp.cv_id(23));
CREATE TEMPORARY TABLE cv_lists(user_id uuid,request_id uuid,item jsonb);
GRANT SELECT, INSERT ON cv_lists TO authenticated;
SET LOCAL ROLE authenticated;
DO $$ DECLARE n integer; BEGIN
  FOR n IN 1..3 LOOP
    PERFORM pg_temp.cv_claim(n);
    INSERT INTO pg_temp.cv_lists SELECT pg_temp.cv_id(n),c.request_id,to_jsonb(c)
      FROM public.list_conversations() c WHERE c.request_id IN (pg_temp.cv_id(21),pg_temp.cv_id(22),pg_temp.cv_id(23));
  END LOOP;
  PERFORM pg_temp.cv_claim(1);
  ASSERT (SELECT array_agg(c.request_id) FROM public.list_conversations() c
    WHERE c.request_id IN (pg_temp.cv_id(21),pg_temp.cv_id(22),pg_temp.cv_id(23)))
    = ARRAY[pg_temp.cv_id(23),pg_temp.cv_id(22),pg_temp.cv_id(21)];
  ASSERT public.leave_conversation(pg_temp.cv_id(21)) = jsonb_build_object('requestId',pg_temp.cv_id(21),'hidden',true);
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_conversations() WHERE request_id = pg_temp.cv_id(21));
  ASSERT (SELECT count(*) FROM public.list_conversations() WHERE request_id IN (pg_temp.cv_id(22),pg_temp.cv_id(23))) = 2;
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_conversations() c JOIN pg_temp.cv_lists b ON b.request_id=c.request_id
    AND b.user_id=pg_temp.cv_id(1) WHERE to_jsonb(c)<>b.item);
END; $$;
RESET ROLE;
CREATE TEMPORARY TABLE cv_first_hidden AS SELECT hidden_at FROM private.conversation_visibility
  WHERE user_id=pg_temp.cv_id(1) AND request_id=pg_temp.cv_id(21);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  PERFORM pg_temp.cv_claim(1);
  PERFORM public.leave_conversation(pg_temp.cv_id(21));
  PERFORM public.leave_conversation(pg_temp.cv_id(21));
  PERFORM pg_temp.cv_claim(2);
  ASSERT (SELECT count(*) FROM public.list_conversations() WHERE request_id IN (pg_temp.cv_id(21),pg_temp.cv_id(23))) = 2;
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_conversations() c JOIN pg_temp.cv_lists b ON b.request_id=c.request_id
    AND b.user_id=pg_temp.cv_id(2) WHERE to_jsonb(c)<>b.item);
END; $$;
RESET ROLE;
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM private.conversation_visibility WHERE request_id=pg_temp.cv_id(21))=1;
  ASSERT (SELECT hidden_at FROM private.conversation_visibility WHERE user_id=pg_temp.cv_id(1)
    AND request_id=pg_temp.cv_id(21))=(SELECT hidden_at FROM pg_temp.cv_first_hidden);
  BEGIN
    INSERT INTO private.conversation_visibility(user_id,request_id) VALUES(pg_temp.cv_id(1),pg_temp.cv_id(21));
    RAISE EXCEPTION 'expected_unique_denial';
  EXCEPTION WHEN unique_violation THEN NULL; END;
END; $$;
SELECT 'CONVERSATION_VISIBILITY_CHECK:self_only_order_projection_and_retry';

SET LOCAL ROLE authenticated;
DO $$ DECLARE bad uuid; BEGIN
  PERFORM pg_temp.cv_claim(3);
  FOREACH bad IN ARRAY ARRAY[pg_temp.cv_id(21),pg_temp.cv_id(999),NULL::uuid] LOOP
    BEGIN PERFORM public.leave_conversation(bad); RAISE EXCEPTION 'expected_party_denial';
    EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
  END LOOP;
  PERFORM pg_temp.cv_claim(NULL);
  BEGIN PERFORM public.leave_conversation(pg_temp.cv_id(21)); RAISE EXCEPTION 'expected_login_denial';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL; END;
  PERFORM pg_temp.cv_claim(1,true);
  BEGIN PERFORM public.leave_conversation(pg_temp.cv_id(21)); RAISE EXCEPTION 'expected_guest_denial';
  EXCEPTION WHEN SQLSTATE '28000' THEN NULL; END;
  PERFORM pg_temp.cv_claim(1);
  BEGIN PERFORM 1 FROM private.conversation_visibility; RAISE EXCEPTION 'expected_table_denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN INSERT INTO private.conversation_visibility(user_id,request_id) VALUES(pg_temp.cv_id(1),pg_temp.cv_id(22));
    RAISE EXCEPTION 'expected_write_denial'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END; $$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$ BEGIN
  BEGIN PERFORM public.leave_conversation(pg_temp.cv_id(21)); RAISE EXCEPTION 'expected_anon_denial';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END; $$;
RESET ROLE;
SELECT 'CONVERSATION_VISIBILITY_CHECK:party_guest_unknown_and_direct_acl';

SET LOCAL ROLE authenticated;
DO $$ BEGIN
  PERFORM pg_temp.cv_claim(1);
  ASSERT (SELECT can_send FROM public.get_conversation(pg_temp.cv_id(21)));
  ASSERT jsonb_array_length(public.list_conversation_messages(pg_temp.cv_id(21),20,NULL)->'items')=1;
  PERFORM public.leave_conversation(pg_temp.cv_id(22));
  PERFORM public.leave_conversation(pg_temp.cv_id(23));
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_conversations() WHERE request_id IN (pg_temp.cv_id(21),pg_temp.cv_id(22),pg_temp.cv_id(23)));
  ASSERT (SELECT NOT can_send AND request_status='withdrawn' FROM public.get_conversation(pg_temp.cv_id(22)));
  ASSERT (SELECT appointment_id=pg_temp.cv_id(31) FROM public.get_conversation(pg_temp.cv_id(23)));
  PERFORM pg_temp.cv_claim(2);
  ASSERT (SELECT count(*) FROM public.list_conversations() WHERE request_id IN (pg_temp.cv_id(21),pg_temp.cv_id(23)))=2;
  PERFORM public.leave_conversation(pg_temp.cv_id(21));
  ASSERT NOT EXISTS (SELECT 1 FROM public.list_conversations() WHERE request_id=pg_temp.cv_id(21));
  ASSERT (SELECT can_send FROM public.get_conversation(pg_temp.cv_id(21)));
END; $$;
RESET ROLE;
DO $$ DECLARE expected record; actual text; BEGIN
  FOR expected IN SELECT * FROM pg_temp.cv_originals LOOP
    CASE expected.category
    WHEN 'posts' THEN SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY p.id)::text) INTO actual FROM public.posts p WHERE p.id IN(pg_temp.cv_id(11),pg_temp.cv_id(12));
    WHEN 'requests' THEN SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text) INTO actual FROM public.join_requests r WHERE r.id IN(pg_temp.cv_id(21),pg_temp.cv_id(22),pg_temp.cv_id(23));
    WHEN 'appointments' THEN SELECT md5(jsonb_agg(to_jsonb(a) ORDER BY a.id)::text) INTO actual FROM public.appointments a WHERE a.id=pg_temp.cv_id(31);
    WHEN 'messages' THEN SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY m.id)::text) INTO actual FROM public.chat_messages m WHERE m.join_request_id IN(pg_temp.cv_id(21),pg_temp.cv_id(22),pg_temp.cv_id(23));
    WHEN 'notifications' THEN SELECT md5(jsonb_agg(to_jsonb(n) ORDER BY n.id)::text) INTO actual FROM public.notifications n WHERE n.join_request_id IN(pg_temp.cv_id(21),pg_temp.cv_id(22),pg_temp.cv_id(23));
    END CASE;
    ASSERT actual IS NOT DISTINCT FROM expected.hash, 'leave_changed_existing_records';
  END LOOP;
  ASSERT NOT EXISTS(SELECT 1 FROM private.naver_accounts WHERE user_id IN(pg_temp.cv_id(1),pg_temp.cv_id(2),pg_temp.cv_id(3)));
END; $$;
SELECT 'CONVERSATION_VISIBILITY_CHECK:legacy_closed_matched_and_records_preserved';

SET LOCAL ROLE authenticated;
DO $$ DECLARE result jsonb; BEGIN
  PERFORM pg_temp.cv_claim(2);
  result:=public.send_conversation_message(pg_temp.cv_id(21),pg_temp.cv_id(44),'숨김 이후에도 기존 정책으로 전송');
  ASSERT result->>'messageId'=pg_temp.cv_id(44)::text AND result->>'alreadySent'='false';
  ASSERT jsonb_array_length(public.list_conversation_messages(pg_temp.cv_id(21),20,NULL)->'items')=2;
  ASSERT NOT EXISTS(SELECT 1 FROM public.list_conversations() WHERE request_id=pg_temp.cv_id(21));
  PERFORM pg_temp.cv_claim(1);
  ASSERT NOT EXISTS(SELECT 1 FROM public.list_conversations() WHERE request_id=pg_temp.cv_id(21));
  ASSERT (SELECT can_send FROM public.get_conversation(pg_temp.cv_id(21)));
END; $$;
RESET ROLE;
SELECT 'CONVERSATION_VISIBILITY_CHECK:message_send_does_not_restore_list';

-- FK 삭제 동작도 테스트 안에서만 확인한다. 나가기 RPC는 삭제를 수행하지 않는다.
SET LOCAL storage.allow_delete_query='true';
DELETE FROM public.join_requests WHERE id=pg_temp.cv_id(22);
DO $$ BEGIN
  ASSERT NOT EXISTS(SELECT 1 FROM private.conversation_visibility WHERE request_id=pg_temp.cv_id(22));
END; $$;
SELECT 'CONVERSATION_VISIBILITY_CHECK:request_cascade';
ROLLBACK;
