-- 앞선 네이버 회원 fixture와 같은 트랜잭션에서 실행한다.
set local role authenticated;
select pg_temp.safety_actor(1);
do $$declare id uuid;result jsonb;second jsonb;begin
 for n in 1..3 loop
 id:=('fd810000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
 perform public.create_service_post(id,jsonb_build_object('title','본인 공고 검증','description','신청 없는 공고','category','산책','startsAt',clock_timestamp()+interval'3 days','endsAt',clock_timestamp()+interval'3 days 2 hours','recruitmentEndsAt',clock_timestamp()+interval'2 days','publicArea','서울특별시 강남구 역삼동','registeredAddress','서울특별시 강남구 가상주소','meetingDetail','가상 입구','registeredPlaceName',null,'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0));
 end loop;
end;$$;
reset role;
update public.posts set created_at='2026-10-01T00:00:00Z'where id::text like'fd810000%';
set local role authenticated;
select pg_temp.safety_actor(1);
do $$declare a jsonb;b jsonb;begin
 a:=public.list_my_service_posts(2);assert jsonb_array_length(a->'items')=2;
 assert a->'items'->0->>'postId'='fd810000-0000-4000-8000-000000000003';
 assert a->'items'->1->>'isOwner'='true';assert a->'items'->0?'privateDetails';
 b:=public.list_my_service_posts(2,(a->>'nextCursor')::uuid);assert jsonb_array_length(b->'items')=1;assert b->>'nextCursor'is null;
 perform public.delete_service_post('fd810000-0000-4000-8000-000000000001');
 assert jsonb_array_length(public.list_my_service_posts()->'items')=2;
end;$$;
select pg_temp.safety_actor(2);
do $$begin assert public.list_my_service_posts()->'items'='[]'::jsonb;
 perform pg_temp.safety_failure('select public.list_my_service_posts(20,''fd810000-0000-4000-8000-000000000003'')','PT404');end;$$;
reset role;
do $$begin assert not has_function_privilege('anon','public.list_my_service_posts(integer,uuid)','execute');
 assert not has_function_privilege('service_role','public.list_my_service_posts(integer,uuid)','execute');end;$$;
