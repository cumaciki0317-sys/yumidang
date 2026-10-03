-- legacy20 합성 fixture COMMIT → 정식40 적용 이후에만 실행한다.
-- 원래 컬럼 전체를 비교하며 새 파생 상태는 별도로 검사한다. 실제 OAuth/사진 업로드 증거가 아니다.
begin;
set local plpgsql.check_asserts=on;
set local time zone 'UTC';

create temporary table upgrade_markers as select key,value from minkyu_upgrade_fixture.markers;
grant select on upgrade_markers to authenticated,anon,service_role;
create function pg_temp.upgrade_id(p_group text,p_label text) returns uuid language sql stable as $$
  select (value->>p_label)::uuid from pg_temp.upgrade_markers where key=p_group;
$$;
create function pg_temp.upgrade_image(p_label text) returns text language sql stable as $$
  select value->>p_label from pg_temp.upgrade_markers where key='images';
$$;
create function pg_temp.upgrade_claim(p_label text,p_role text default 'authenticated')
returns void language plpgsql as $$
declare u uuid:=pg_temp.upgrade_id('users',p_label); s uuid:=pg_temp.upgrade_id('sessions',p_label);
begin
  perform set_config('request.jwt.claim.sub',coalesce(u::text,''),true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role',p_role,'session_id',s,'is_anonymous',false)::text,true);
end; $$;
-- SECURITY INVOKER: 역할 전환 후 helper도 호출 역할의 실제 RLS/EXECUTE 권한으로 실행한다.
create function pg_temp.upgrade_visible(p_label text) returns boolean language sql stable as $$
  select exists(select 1 from storage.objects where bucket_id='profile-images' and name=pg_temp.upgrade_image(p_label));
$$;
create function pg_temp.upgrade_assert_originals() returns void language plpgsql as $$
declare s record; cols text; n bigint; h text;
begin
  assert (select count(*) from minkyu_upgrade_fixture.snapshots)=18;
  assert (select count(*) from minkyu_upgrade_fixture.snapshots where schema_name in('public','private'))=14;
  assert (select count(*) from minkyu_upgrade_fixture.snapshots where (schema_name,table_name) in
    (('auth','users'),('auth','sessions'),('storage','objects'),('storage','buckets')))=4;
  for s in select * from minkyu_upgrade_fixture.snapshots order by schema_name,table_name loop
    assert s.schema_name ~ '^[a-z0-9_]+$' and s.table_name ~ '^[a-z0-9_]+$';
    assert cardinality(s.columns)>0 and s.row_hash ~ '^[0-9a-f]{32}$';
    select string_agg(format('%I',c),',' order by ord) into cols from unnest(s.columns) with ordinality x(c,ord);
    execute format('select count(*),md5(coalesce(string_agg(j,E''\n'' order by j),'''')) from '
      ||'(select to_jsonb(projected)::text j from (select %s from %I.%I) projected) original_rows',
      cols,s.schema_name,s.table_name) into n,h;
    assert n=s.row_count, 'upgrade_original_count_changed';
    assert h=s.row_hash, 'upgrade_original_columns_changed';
  end loop;
end; $$;

do $$ begin
  assert current_setting('plpgsql.check_asserts')='on';
  assert (select value->>'snapshot_tables' from pg_temp.upgrade_markers where key='expected_counts')='18';
  assert (select count(*) from pg_temp.upgrade_markers)=9;
  assert not (select columns && array['cost_type','amount','source_event_id']::text[]
    from minkyu_upgrade_fixture.snapshots where schema_name='public' and table_name='posts');
  perform pg_temp.upgrade_assert_originals();
end; $$;
select 'LEGACY_UPGRADE_CHECK:original_eighteen_snapshots';

do $$ declare signature text; function_oid oid; r text; checked integer:=0; begin
  assert not exists(select 1 from private.naver_accounts);
  assert not exists(select 1 from private.naver_sessions);
  assert not exists(select 1 from private.naver_login_challenges);
  assert not exists(select 1 from private.profile_traits);
  -- 구형 가입·직접 생성·한쪽 확정 경로를 새 서버 RPC의 대안으로 남기지 않는다.
  foreach signature in array array[
    'public.complete_signup_with_avatar(text,date,text,text,text,text)',
    'public.complete_signup(text,date,text,text,text)',
    'public.check_signup_eligibility(text,text)',
    'public.confirm_match(uuid)',
    'public.create_join_request(uuid,text)',
    'public.create_post(uuid,text,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,text,text[],text)',
    'public.clear_my_profile_avatar()'
  ] loop
    function_oid:=to_regprocedure(signature)::oid;
    assert function_oid is not null, 'upgrade_expected_legacy_rpc_missing';
    foreach r in array array['anon','authenticated','service_role'] loop
      assert not has_function_privilege(r,function_oid,'EXECUTE'), 'upgrade_legacy_rpc_still_executable';
    end loop;
    checked:=checked+1;
  end loop;
  assert checked=7, 'upgrade_legacy_rpc_inventory_incomplete';
  assert not has_table_privilege('authenticated','public.chat_messages','INSERT');
  assert exists(select 1 from pg_roles where rolname='yumidang_completion_runner' and not rolcanlogin
    and not rolsuper and not rolcreaterole and not rolcreatedb and not rolbypassrls);
end; $$;
select 'LEGACY_UPGRADE_CHECK:no_auto_naver_attachment_and_legacy_revokes';

do $$ begin
  assert (select count(*) from public.posts)=5;
  assert not exists(select 1 from public.posts where cost_type is not null or amount is not null or source_event_id is not null);
  assert not exists(select 1 from public.appointment_reviews where experience is not null or praises<>'{}'::text[]);
  assert not exists(select 1 from public.notifications where event_data<>'{}'::jsonb);
  assert (select status='completed' and completion_method='manual' and completed_at is not null
    from public.appointments where id=pg_temp.upgrade_id('appointments','manual_single'));
  assert (select completed_at=(select (value#>>'{}')::timestamptz-interval '10 days'
    from pg_temp.upgrade_markers where key='base_time') from public.appointments
    where id=pg_temp.upgrade_id('appointments','manual_single'));
  assert (select count(*) from public.appointment_completion_confirmations
    where appointment_id=pg_temp.upgrade_id('appointments','manual_single'))=1;
  assert not private.review_release_ready(pg_temp.upgrade_id('appointments','manual_single'));
end; $$;
select 'LEGACY_UPGRADE_CHECK:new_defaults_and_manual_history_preserved';

do $$ begin
  assert (select count(*) from private.completion_reservations)=1;
  assert exists(select 1 from private.completion_reservations r join public.appointments ap on ap.id=r.appointment_id
    join public.posts p on p.id=ap.post_id where ap.id=pg_temp.upgrade_id('appointments','future')
    and ap.status='confirmed' and r.due_at=p.ends_at+interval '24 hours' and r.generation is not null);
  assert (select p.ends_at=(select (value#>>'{}')::timestamptz+interval '30 days'
    from pg_temp.upgrade_markers where key='base_time') from public.posts p
    where p.id=pg_temp.upgrade_id('posts','future'));
  assert not exists(select 1 from private.completion_reservations r join public.appointments ap on ap.id=r.appointment_id
    where ap.status in('completed','cancelled','disputed'));
  assert not exists(select 1 from private.completion_reservations r join public.appointment_disputes d
    on d.appointment_id=r.appointment_id where d.status='open' or d.resolution='no_show');
  assert not exists(select 1 from cron.job where jobname='yumidang-auto-complete-appointments');
end; $$;
select 'LEGACY_UPGRADE_CHECK:exact_future_reservation_and_old_cron_removed';

do $$ declare rv record; u record; begin
  assert not exists(select 1 from private.review_publication);
  assert not exists(select 1 from private.review_summaries);
  assert not exists(select 1 from private.review_summary_checkpoints);
  assert not exists(select 1 from private.review_summary_job_publications);
  for rv in select id from public.appointment_reviews loop
    assert not private.is_review_public_eligible(rv.id);
  end loop;
  for u in select id from public.profiles loop assert private.review_summary_sources(u.id)='[]'::jsonb; end loop;
end; $$;
set local role service_role;
do $$ declare label text; result jsonb; begin
  assert current_user='service_role';
  perform pg_temp.upgrade_claim(null,'service_role');
  foreach label in array array['author','peer','third','fourth'] loop
    result:=public.load_public_review_snapshot(pg_temp.upgrade_id('users',label));
    assert result->>'eligibleCount'='0' and result->'reviews'='[]'::jsonb;
  end loop;
end; $$;
reset role;
select 'LEGACY_UPGRADE_CHECK:no_automatic_publication_or_ai_sources';

set local role authenticated;
do $$ declare label text; result jsonb; conversation record; begin
  assert current_user='authenticated';
  foreach label in array array['author','peer','third','fourth'] loop
    perform pg_temp.upgrade_claim(label);
    result:=public.get_my_profile();
    assert (result->>'userId')::uuid=pg_temp.upgrade_id('users',label);
    assert result->>'avatarUrl'=pg_temp.upgrade_image(label||'_current');
    result:=public.get_public_profile(pg_temp.upgrade_id('users','author'));
    assert (result->>'profileId')::uuid=pg_temp.upgrade_id('users','author');
  end loop;
  foreach label in array array['author','peer'] loop
    perform pg_temp.upgrade_claim(label);
    select * into strict conversation from public.get_conversation(pg_temp.upgrade_id('requests','future'));
    assert conversation.request_id=pg_temp.upgrade_id('requests','future');
    assert conversation.request_status='matched';
    assert conversation.appointment_id=pg_temp.upgrade_id('appointments','future');
    result:=public.list_conversation_messages(pg_temp.upgrade_id('requests','future'),20,null);
    assert jsonb_array_length(result->'items')=1;
  end loop;
end; $$;
reset role;
select 'LEGACY_UPGRADE_CHECK:legacy_member_profile_and_conversation_reads';

set local role authenticated;
do $$ begin
  assert current_user='authenticated';
  perform pg_temp.upgrade_claim('author');
  begin
    perform public.propose_match(pg_temp.upgrade_id('requests','future'));
    raise exception 'upgrade_expected_new_activity_denial';
  exception when sqlstate '28000' then assert sqlerrm='naver_session_required'; end;
  perform pg_temp.upgrade_claim('peer');
  begin
    perform public.request_service_post(pg_temp.upgrade_id('posts','future'),'합성 신규 신청 거절 검사');
    raise exception 'upgrade_expected_new_activity_denial';
  exception when sqlstate '28000' then assert sqlerrm='naver_session_required'; end;
  begin
    perform public.accept_match(pg_temp.upgrade_id('requests','future'),'synthetic-upgrade-version');
    raise exception 'upgrade_expected_new_activity_denial';
  exception when sqlstate '28000' then assert sqlerrm='naver_session_required'; end;
  begin
    perform public.confirm_match(pg_temp.upgrade_id('requests','future'));
    raise exception 'upgrade_expected_legacy_rpc_denial';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
select 'LEGACY_UPGRADE_CHECK:unregistered_legacy_sessions_cannot_start_activity';

set local role authenticated;
do $$ begin
  assert current_user='authenticated';
  perform pg_temp.upgrade_claim('author');
  assert pg_temp.upgrade_visible('author_current') and pg_temp.upgrade_visible('author_pending') and pg_temp.upgrade_visible('author_old');
  assert pg_temp.upgrade_visible('peer_current') and pg_temp.upgrade_visible('third_current') and pg_temp.upgrade_visible('fourth_current');
  assert not pg_temp.upgrade_visible('orphan');
  perform pg_temp.upgrade_claim('peer');
  assert pg_temp.upgrade_visible('author_current') and pg_temp.upgrade_visible('peer_current');
  assert not pg_temp.upgrade_visible('author_pending') and not pg_temp.upgrade_visible('author_old') and not pg_temp.upgrade_visible('orphan');
end; $$;
reset role;
set local role anon;
do $$ begin
  assert current_user='anon';
  perform pg_temp.upgrade_claim(null,'anon');
  assert not pg_temp.upgrade_visible('author_current') and not pg_temp.upgrade_visible('author_pending')
    and not pg_temp.upgrade_visible('author_old') and not pg_temp.upgrade_visible('orphan');
end; $$;
reset role;
do $$ begin
  -- 읽기 RPC 및 새 snapshot 파생 행이 기존18표의 원래 컬럼을 바꾸지 않았는지 다시 확인한다.
  perform pg_temp.upgrade_assert_originals();
  assert not exists(select 1 from private.naver_accounts) and not exists(select 1 from private.naver_sessions);
  assert not exists(select 1 from private.review_publication);
end; $$;
select 'LEGACY_UPGRADE_CHECK:actual_photo_rls_and_originals_still_preserved';
rollback;
