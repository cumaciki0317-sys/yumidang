-- 제안 02_profile_traits.sql 검사. run_proposals.py가 BEGIN/ROLLBACK으로 감싼다. 모든 사용자·공고는 가상 자료다.
do $$
declare
  a uuid := md5('traits-author-a')::uuid; b uuid := md5('traits-author-b')::uuid; m uuid := md5('traits-member-m')::uuid;
  nop uuid := md5('traits-no-profile')::uuid;
  p1 uuid := md5('traits-post-1')::uuid; p2 uuid := md5('traits-post-2')::uuid; p3 uuid := md5('traits-post-deleted')::uuid;
  x jsonb; v1 text; v2 text; denied boolean; code text;
begin
  insert into auth.users(id) values (a), (b), (m), (nop);
  insert into public.profiles(id, real_name, birth_date) values (a, '가상작성자', '1990-01-01'), (b, '가상둘째', '1995-05-05'), (m, '가상회원', '1992-02-02');
  insert into public.posts(id, author_id, title, description, category, starts_at, ends_at, recruitment_ends_at, public_area, status)
    values (p1, a, '가상 전시 동행', '가상 설명', '전시', now() + interval '3 days', now() + interval '3 days 2 hours', now() + interval '2 days', '서울특별시 종로구 종로1가', 'recruiting'),
           (p2, b, '가상 산책 동행', '가상 설명', '산책', now() + interval '4 days', now() + interval '4 days 2 hours', now() + interval '3 days', '서울특별시 강남구 역삼동', 'recruiting'),
           (p3, a, '가상 삭제 공고', '가상 설명', '전시', now() + interval '5 days', now() + interval '5 days 2 hours', now() + interval '4 days', '서울특별시 종로구 종로1가', 'deleted');

  -- 권한: 테이블 직접 접근 없음, RPC만 노출. 원문·실명 컬럼 없음.
  assert not has_table_privilege('authenticated', 'private.profile_traits', 'select');
  assert not has_table_privilege('anon', 'private.profile_traits', 'select');
  assert (select relrowsecurity from pg_class where oid = 'private.profile_traits'::regclass);
  assert not exists (select 1 from information_schema.columns where table_schema = 'private' and table_name = 'profile_traits'
    and column_name ~ '(name|birth|phone|message|text)');

  -- 비로그인: 28000.
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', '', true);
  set local role anon;
  begin perform public.get_post_author_traits(array[p1]); denied := false;
  exception when sqlstate '28000' then denied := true; end;
  assert denied, 'anon author traits must be 28000';
  begin perform public.get_my_profile_traits(); denied := false;
  exception when sqlstate '28000' then denied := true; end;
  assert denied, 'anon my traits must be 28000';
  reset role;
  -- 익명 로그인 JWT도 회원이 아니다.
  perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  set local role authenticated;
  begin perform public.get_post_author_traits(array[p1]); denied := false;
  exception when sqlstate '28000' then denied := true; end;
  assert denied, 'anonymous sign-in must be 28000';
  reset role;

  -- 작성자 A 성향 저장(본인만, auth.uid 기준).
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  x := public.get_my_profile_traits();
  assert x = '{"interests":[],"conversationStyles":[],"mbti":null}'::jsonb, x::text;
  x := public.set_my_profile_traits(array['현대미술', '사진'], array['차분한 대화'], 'enfp');
  assert x = jsonb_build_object('interests', jsonb_build_array('현대미술', '사진'), 'conversationStyles', jsonb_build_array('차분한 대화'), 'mbti', 'ENFP'), x::text;
  -- 잘못된 값: 앞뒤 공백·중복(대소문자 무시)·41자·21개·null 배열·잘못된 MBTI → 22023, 저장값 유지.
  foreach code in array array['space', 'dup', 'long', 'many', 'nullarr', 'mbti'] loop
    begin
      case code
        when 'space' then perform public.set_my_profile_traits(array[' 사진'], '{}', null);
        when 'dup' then perform public.set_my_profile_traits(array['Photo', 'photo'], '{}', null);
        when 'long' then perform public.set_my_profile_traits(array[repeat('가', 41)], '{}', null);
        when 'many' then perform public.set_my_profile_traits((select array_agg('관심' || g) from generate_series(1, 21) g), '{}', null);
        when 'nullarr' then perform public.set_my_profile_traits(null, '{}', null);
        else perform public.set_my_profile_traits('{}', '{}', 'ABCD');
      end case;
      denied := false;
    exception when sqlstate '22023' then denied := true; end;
    assert denied, 'invalid traits must be 22023: ' || code;
  end loop;
  assert (public.get_my_profile_traits() ->> 'mbti') = 'ENFP';
  reset role;

  -- 프로필 없는 로그인 사용자는 저장 불가(P0002).
  perform set_config('request.jwt.claims', json_build_object('sub', nop, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin perform public.set_my_profile_traits('{}', '{}', null); denied := false;
  exception when sqlstate 'P0002' then denied := true; end;
  assert denied, 'profile required';
  reset role;

  -- 다른 회원 M의 조회: 입력 순서, 삭제 공고 제외, 미입력 작성자는 빈 값, 작성자 ID·실명 없음.
  perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
  set local role authenticated;
  x := public.get_post_author_traits(array[p2, p3, p1]);
  assert jsonb_array_length(x -> 'items') = 2, x::text;
  assert (x -> 'items' -> 0 ->> 'postId')::uuid = p2 and (x -> 'items' -> 1 ->> 'postId')::uuid = p1, 'input order kept';
  assert x -> 'items' -> 0 -> 'interests' = '[]'::jsonb and x -> 'items' -> 0 -> 'mbti' = 'null'::jsonb;
  assert x -> 'items' -> 1 -> 'interests' = jsonb_build_array('현대미술', '사진');
  assert (select array_agg(k order by k) from jsonb_object_keys(x -> 'items' -> 1) k) = array['conversationStyles', 'interests', 'mbti', 'postId', 'traitsVersion'];
  assert x::text !~ '가상작성자' and x::text !~ a::text and x::text !~ b::text, 'no author id or name';
  v1 := x -> 'items' -> 1 ->> 'traitsVersion';
  assert v1 ~ '^[0-9a-f]{32}$';
  -- 입력 검사: 51개·null 원소·중복 → 22023. 빈 배열은 빈 결과.
  assert public.get_post_author_traits('{}'::uuid[]) = '{"items":[]}'::jsonb;
  begin perform public.get_post_author_traits((select array_agg(gen_random_uuid()) from generate_series(1, 51))); denied := false;
  exception when sqlstate '22023' then denied := true; end;
  assert denied, 'max 50 ids';
  begin perform public.get_post_author_traits(array[p1, p1]); denied := false;
  exception when sqlstate '22023' then denied := true; end;
  assert denied, 'duplicate ids';
  begin perform public.get_post_author_traits(array[p1, null]); denied := false;
  exception when sqlstate '22023' then denied := true; end;
  assert denied, 'null id';
  -- 다른 회원의 성향을 저장할 수 없다(본인 행만 변경).
  perform public.set_my_profile_traits(array['등산'], '{}', null);
  reset role;
  assert (select interests from private.profile_traits where profile_id = a) = array['현대미술', '사진'], 'author A untouched';
  assert (select interests from private.profile_traits where profile_id = m) = array['등산'];

  -- 작성자 A가 성향을 바꾸면 traitsVersion이 바뀐다. 같은 값이면 유지된다.
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_my_profile_traits(array['현대미술', '사진'], array['차분한 대화'], 'ENFP');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
  set local role authenticated;
  assert public.get_post_author_traits(array[p1]) -> 'items' -> 0 ->> 'traitsVersion' = v1, 'same values keep version';
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.set_my_profile_traits(array['현대미술'], array['차분한 대화'], 'ENFP');
  reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', m, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v2 := public.get_post_author_traits(array[p1]) -> 'items' -> 0 ->> 'traitsVersion';
  assert v2 <> v1, 'changed traits change version';
  reset role;

  -- 프로필 삭제 시 성향도 삭제(cascade).
  delete from auth.users where id = m;
  assert not exists (select 1 from private.profile_traits where profile_id = m);
end $$;
