-- 빈 분리 로컬 20개 이력에만 적용하는 합성 자료다. 실제 회원·사진·인증 증거가 아니다.
-- 업그레이드 전 COMMIT하고, 이후 검사는 원래 컬럼의 건수와 해시만 비교한다.
BEGIN;
SET LOCAL TIME ZONE 'UTC';

DO $guard$
DECLARE
  v_versions text[];
  v_table text;
  v_count bigint;
BEGIN
  SELECT array_agg(version::text ORDER BY version) INTO v_versions
  FROM supabase_migrations.schema_migrations;
  IF v_versions IS DISTINCT FROM ARRAY[
    '20260916080335','20260916081429','20260916081750','20260916101123',
    '20260916105220','20260916105738','20260916105916','20260916110052',
    '20260916110758','20260916110943','20260916111030','20260916111437',
    '20260916114036','20260916131906','20260917005621','20260917043418',
    '20260917052827','20260917094753','20260917122744','20260917141449'
  ]::text[] OR to_regnamespace('minkyu_upgrade_fixture') IS NOT NULL THEN
    RAISE EXCEPTION 'legacy_fixture_baseline_conflict';
  END IF;
  FOREACH v_table IN ARRAY ARRAY[
    'private.female_referral_codes','private.institutional_email_verifications',
    'private.referral_signup_audit','private.signup_eligibility',
    'public.appointment_completion_confirmations','public.appointment_disputes',
    'public.appointment_reviews','public.appointments','public.chat_messages',
    'public.join_requests','public.notifications','public.post_private_details',
    'public.posts','public.profiles','auth.users','auth.sessions','storage.objects'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM %s', v_table) INTO v_count;
    IF v_count <> 0 THEN RAISE EXCEPTION 'legacy_fixture_database_not_empty'; END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM storage.buckets WHERE id = 'profile-images' AND public = false
      AND file_size_limit = 2097152 AND allowed_mime_types = ARRAY['image/jpeg']::text[]
  ) THEN RAISE EXCEPTION 'legacy_fixture_bucket_conflict'; END IF;
END;
$guard$;

CREATE SCHEMA minkyu_upgrade_fixture;
REVOKE ALL ON SCHEMA minkyu_upgrade_fixture FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE minkyu_upgrade_fixture.snapshots (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  columns text[] NOT NULL,
  row_count bigint NOT NULL,
  row_hash text NOT NULL,
  PRIMARY KEY (schema_name, table_name)
);
CREATE TABLE minkyu_upgrade_fixture.markers (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE FUNCTION minkyu_upgrade_fixture.uuid(p_label text) RETURNS uuid
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT (substr(h,1,8)||'-'||substr(h,9,4)||'-4'||substr(h,14,3)||
          '-8'||substr(h,18,3)||'-'||substr(h,21,12))::uuid
  FROM (SELECT md5('minkyu-legacy-upgrade:'||p_label) AS h) s;
$$;
CREATE FUNCTION minkyu_upgrade_fixture.photo_path(p_owner_label text, p_image_label text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT minkyu_upgrade_fixture.uuid(p_owner_label)::text || '/' ||
         minkyu_upgrade_fixture.uuid(p_image_label)::text || '.jpg';
$$;
CREATE FUNCTION minkyu_upgrade_fixture.capture_snapshot(p_schema text, p_table text)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_columns text[];
  v_projection text;
  v_count bigint;
  v_hash text;
BEGIN
  SELECT array_agg(a.attname::text ORDER BY a.attnum),
         string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum)
  INTO v_columns, v_projection
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = p_schema AND c.relname = p_table
    AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_columns IS NULL THEN RAISE EXCEPTION 'legacy_fixture_snapshot_table_missing'; END IF;
  EXECUTE format(
    'SELECT count(*), md5(coalesce(string_agg(j, E''\n'' ORDER BY j), ''''))
     FROM (SELECT to_jsonb(q)::text AS j FROM (SELECT %s FROM %I.%I) q) s',
    v_projection, p_schema, p_table)
  INTO v_count, v_hash;
  INSERT INTO minkyu_upgrade_fixture.snapshots
    VALUES (p_schema, p_table, v_columns, v_count, v_hash);
END;
$$;

DO $seed$
DECLARE
  v_base timestamptz := date_trunc('second', clock_timestamp());
  v_label text;
  v_kind text;
  v_image text;
  v_start timestamptz;
  v_end timestamptz;
  v_completed timestamptz;
  v_user uuid;
  v_author uuid := minkyu_upgrade_fixture.uuid('author');
  v_peer uuid := minkyu_upgrade_fixture.uuid('peer');
  v_users jsonb := '{}'::jsonb;
  v_sessions jsonb := '{}'::jsonb;
  v_posts jsonb := '{}'::jsonb;
  v_requests jsonb := '{}'::jsonb;
  v_appointments jsonb := '{}'::jsonb;
  v_images jsonb := '{}'::jsonb;
  v_reviews jsonb := '{}'::jsonb;
BEGIN
  FOREACH v_label IN ARRAY ARRAY['author','peer','third','fourth'] LOOP
    v_user := minkyu_upgrade_fixture.uuid(v_label);
    INSERT INTO auth.users(id, role, email, created_at, updated_at)
      VALUES (v_user, 'authenticated', 'legacy-'||v_label||'@example.invalid',
              v_base - interval '60 days', v_base - interval '60 days');
    INSERT INTO auth.sessions(id, user_id)
      VALUES (minkyu_upgrade_fixture.uuid('session-'||v_label), v_user);
    v_image := minkyu_upgrade_fixture.photo_path(v_label, 'image-'||v_label||'-current');
    -- 객체 메타데이터는 RLS 검사용 합성 자료이며 실제 JPEG 업로드를 뜻하지 않는다.
    INSERT INTO storage.objects(bucket_id, name, owner_id, metadata)
      VALUES ('profile-images', v_image, v_user::text,
              '{"mimetype":"image/jpeg","size":512}'::jsonb);
    INSERT INTO public.profiles(id, real_name, birth_date, gender, avatar_url, bio, created_at, updated_at)
      VALUES (v_user, '합성회원 '||v_label, DATE '1990-01-01',
              CASE WHEN v_label = 'third' THEN 'male'
                   WHEN v_label = 'fourth' THEN NULL ELSE 'female' END,
              v_image, '업그레이드 검사용 합성 소개',
              v_base - interval '60 days', v_base - interval '60 days');
    INSERT INTO private.signup_eligibility(user_id, signup_route, institutional_email, completed_at)
      VALUES (v_user, CASE v_label WHEN 'peer' THEN 'female_referral'
                    WHEN 'third' THEN 'institutional_email' ELSE 'legacy' END,
              CASE WHEN v_label = 'third' THEN 'legacy-third@example.invalid' END,
              v_base - interval '60 days' + CASE WHEN v_label = 'third' THEN interval '6 minutes' ELSE interval '0' END);
    v_users := v_users || jsonb_build_object(v_label, v_user);
    v_sessions := v_sessions || jsonb_build_object(v_label, minkyu_upgrade_fixture.uuid('session-'||v_label));
    v_images := v_images || jsonb_build_object(v_label||'_current', v_image);
  END LOOP;
  FOREACH v_label IN ARRAY ARRAY['author_pending','author_old','orphan'] LOOP
    v_kind := CASE WHEN v_label = 'orphan' THEN 'orphan-owner' ELSE 'author' END;
    v_image := minkyu_upgrade_fixture.photo_path(v_kind, 'image-'||v_label);
    INSERT INTO storage.objects(bucket_id, name, owner_id, metadata)
      VALUES ('profile-images', v_image, minkyu_upgrade_fixture.uuid(v_kind)::text,
              '{"mimetype":"image/jpeg","size":512}'::jsonb);
    v_images := v_images || jsonb_build_object(v_label, v_image);
  END LOOP;
  INSERT INTO private.female_referral_codes(owner_id, code, active, created_at)
    VALUES (v_author, 'YMD-AAAA0001', true, v_base - interval '61 days');
  INSERT INTO private.referral_signup_audit(referred_user_id, referrer_user_id, created_at)
    VALUES (v_peer, v_author, v_base - interval '60 days');
  INSERT INTO private.institutional_email_verifications
    (user_id, normalized_email, requested_at, expires_at, verified_at, attempt_count, last_attempt_at)
    VALUES (minkyu_upgrade_fixture.uuid('third'), 'legacy-third@example.invalid',
            v_base - interval '60 days', v_base - interval '60 days' + interval '10 minutes',
            v_base - interval '60 days' + interval '5 minutes', 1,
            v_base - interval '60 days' + interval '5 minutes');

  FOREACH v_label IN ARRAY ARRAY['future','manual_single','automatic','disputed','no_show'] LOOP
    v_start := CASE WHEN v_label = 'future' THEN v_base + interval '29 days'
                    ELSE v_base - interval '12 days' END;
    v_end := CASE WHEN v_label = 'future' THEN v_base + interval '30 days'
                  ELSE v_base - interval '11 days' END;
    v_completed := CASE WHEN v_label = 'future' THEN NULL ELSE v_base - interval '10 days' END;
    INSERT INTO public.posts
      (id, author_id, title, description, category, starts_at, ends_at, recruitment_ends_at,
       public_area, preference_note, tags, status, created_at, updated_at)
      VALUES (minkyu_upgrade_fixture.uuid('post-'||v_label), v_author,
              '합성 공고 '||v_label, '원래 공고 내용을 보존하는 업그레이드 검사', '산책',
              v_start, v_end, v_start - interval '1 day', '서울특별시 강남구 역삼동',
              '합성 조건', ARRAY['검사'], 'closed', v_base - interval '14 days', v_base - interval '14 days');
    INSERT INTO public.post_private_details(post_id, exact_location, created_at, updated_at)
      VALUES (minkyu_upgrade_fixture.uuid('post-'||v_label), '합성 상세 만남 지점',
              v_base - interval '14 days', v_base - interval '14 days');
    INSERT INTO public.join_requests(id, post_id, requester_id, message, status, created_at, updated_at)
      VALUES (minkyu_upgrade_fixture.uuid('request-'||v_label),
              minkyu_upgrade_fixture.uuid('post-'||v_label), v_peer,
              '업그레이드 검사용 합성 신청 메시지', 'matched',
              v_base - interval '14 days', v_base - interval '14 days');
    INSERT INTO public.appointments
      (id, post_id, join_request_id, status, confirmed_at, updated_at, completed_at,
       completion_method, completed_by_user_id, completion_notified_at, dispute_deadline_at, review_deadline_at)
      VALUES (minkyu_upgrade_fixture.uuid('appointment-'||v_label),
              minkyu_upgrade_fixture.uuid('post-'||v_label), minkyu_upgrade_fixture.uuid('request-'||v_label),
              CASE v_label WHEN 'future' THEN 'confirmed' WHEN 'disputed' THEN 'disputed'
                WHEN 'no_show' THEN 'no_show' ELSE 'completed' END,
              v_base - interval '13 days', v_base - interval '10 days', v_completed,
              CASE WHEN v_label = 'future' THEN NULL WHEN v_label = 'automatic' THEN 'automatic' ELSE 'manual' END,
              CASE WHEN v_label IN ('future','automatic') THEN NULL ELSE v_author END,
              v_completed, v_completed + interval '24 hours', v_completed + interval '7 days');
    IF v_label IN ('manual_single','disputed','no_show') THEN
      -- 구형 단측 완료 이력이다. 두 번째 완료 확인을 새로 만들지 않는다.
      INSERT INTO public.appointment_completion_confirmations(appointment_id, user_id, confirmed_at)
        VALUES (minkyu_upgrade_fixture.uuid('appointment-'||v_label), v_author, v_completed);
    END IF;
    INSERT INTO public.chat_messages(id, join_request_id, sender_id, content, created_at)
      VALUES (minkyu_upgrade_fixture.uuid('chat-'||v_label), minkyu_upgrade_fixture.uuid('request-'||v_label),
              v_author, '업그레이드 검사용 합성 대화', v_base - interval '13 days');
    v_posts := v_posts || jsonb_build_object(v_label, minkyu_upgrade_fixture.uuid('post-'||v_label));
    v_requests := v_requests || jsonb_build_object(v_label, minkyu_upgrade_fixture.uuid('request-'||v_label));
    v_appointments := v_appointments || jsonb_build_object(v_label, minkyu_upgrade_fixture.uuid('appointment-'||v_label));
  END LOOP;
  INSERT INTO public.appointment_disputes
    (appointment_id, raised_by_user_id, reason, raised_at, review_time_remaining, status, resolved_at, resolution)
    VALUES (minkyu_upgrade_fixture.uuid('appointment-disputed'), v_peer, '합성 진행 중 분쟁',
            v_base - interval '10 days' + interval '1 hour', interval '6 days 23 hours', 'open', NULL, NULL),
           (minkyu_upgrade_fixture.uuid('appointment-no_show'), v_peer, '합성 불발 기록',
            v_base - interval '10 days' + interval '1 hour', interval '6 days 23 hours', 'resolved',
            v_base - interval '8 days', 'no_show');
  FOREACH v_label IN ARRAY ARRAY['manual_single','automatic_author','automatic_peer','disputed','no_show'] LOOP
    v_kind := CASE WHEN v_label LIKE 'automatic_%' THEN 'automatic' ELSE v_label END;
    INSERT INTO public.appointment_reviews(id, appointment_id, reviewer_id, rating, comment, submitted_at)
      VALUES (minkyu_upgrade_fixture.uuid('review-'||v_label),
              minkyu_upgrade_fixture.uuid('appointment-'||v_kind),
              CASE WHEN v_label = 'automatic_peer' THEN v_peer ELSE v_author END,
              4, '업그레이드 검사용 합성 후기',
              CASE WHEN v_kind IN ('disputed','no_show') THEN v_base - interval '10 days' + interval '30 minutes'
                   ELSE v_base - interval '9 days' END);
    v_reviews := v_reviews || jsonb_build_object(v_label, minkyu_upgrade_fixture.uuid('review-'||v_label));
  END LOOP;
  INSERT INTO minkyu_upgrade_fixture.markers(key, value) VALUES
    ('users',v_users),('sessions',v_sessions),('posts',v_posts),('requests',v_requests),
    ('appointments',v_appointments),('images',v_images),('reviews',v_reviews),
    ('base_time',to_jsonb(v_base)),
    ('expected_counts','{"app_tables":14,"snapshot_tables":18,"users":4,"sessions":4,"profiles":4,"posts":5,"requests":5,"appointments":5,"confirmations":3,"reviews":5,"storage_objects":7,"reservations_after":1}'::jsonb);
END;
$seed$;

DO $snapshots$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'private.female_referral_codes','private.institutional_email_verifications',
    'private.referral_signup_audit','private.signup_eligibility',
    'public.appointment_completion_confirmations','public.appointment_disputes',
    'public.appointment_reviews','public.appointments','public.chat_messages',
    'public.join_requests','public.notifications','public.post_private_details',
    'public.posts','public.profiles','auth.users','auth.sessions','storage.objects','storage.buckets'
  ] LOOP
    PERFORM minkyu_upgrade_fixture.capture_snapshot(split_part(v_table,'.',1), split_part(v_table,'.',2));
  END LOOP;
  IF (SELECT count(*) FROM minkyu_upgrade_fixture.snapshots) <> 18 THEN
    RAISE EXCEPTION 'legacy_fixture_snapshot_count_conflict';
  END IF;
  RAISE NOTICE 'legacy_upgrade_fixture_ready snapshots=18 profiles=4 posts=5 appointments=5';
END;
$snapshots$;
REVOKE ALL ON ALL TABLES IN SCHEMA minkyu_upgrade_fixture FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA minkyu_upgrade_fixture FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
