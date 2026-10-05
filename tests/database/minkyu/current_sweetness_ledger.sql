-- 민규: 격리 scratch 전용 합성 당도 검증. 전체 rollback한다.
begin;
create temp table sweetness_users(n integer primary key,id uuid not null);
insert into sweetness_users values(1,gen_random_uuid()),(2,gen_random_uuid());
insert into auth.users(id) select id from sweetness_users;
insert into public.profiles(id,real_name,birth_date,gender) select id,'합성 당도 회원','1990-01-01','female' from sweetness_users;
grant select on sweetness_users to authenticated;
create function pg_temp.sweet_uid(n integer) returns uuid language sql stable as $$select id from sweetness_users where sweetness_users.n=$1;$$;
create function pg_temp.sweet_fixture(p_experience text,p_rating integer,p_both boolean default true,p_completed boolean default true,p_deadline timestamptz default null)
returns uuid language plpgsql as $$
declare p uuid:=gen_random_uuid();j uuid:=gen_random_uuid();a uuid:=gen_random_uuid();begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
    values(p,pg_temp.sweet_uid(1),'합성 당도 약속','합성 자료','산책',now()-interval '4 days',now()-interval '3 days',now()-interval '5 days','서울특별시 강남구 역삼동','closed');
  insert into public.join_requests(id,post_id,requester_id,message,status) values(j,p,pg_temp.sweet_uid(2),'합성 신청','matched');
  insert into public.appointments(id,post_id,join_request_id,status,confirmed_at,completed_at,completion_method,completion_notified_at,review_deadline_at,dispute_deadline_at)
    values(a,p,j,case when p_completed then 'completed' else 'confirmed' end,now()-interval '4 days',
      case when p_completed then now()-interval '2 days' else null end,case when p_completed then 'automatic' else null end,
      case when p_completed then now()-interval '2 days' else null end,case when p_completed then coalesce(p_deadline,now()+interval '5 days') else null end,case when p_completed then now()-interval '1 day' else null end);
  insert into public.appointment_reviews(appointment_id,reviewer_id,rating,experience,comment) values(a,pg_temp.sweet_uid(1),p_rating,p_experience,null);
  if p_both then insert into public.appointment_reviews(appointment_id,reviewer_id,rating,experience,comment) values(a,pg_temp.sweet_uid(2),3,'neutral',null);end if;
  return a;
end; $$;
create function pg_temp.sweet_expect(p_sql text,p_state text) returns void language plpgsql as $$begin
  begin execute p_sql;exception when others then if sqlstate=p_state then return;end if;raise;end;
  raise exception 'expected rejection absent';
end; $$;
-- 전 조합과 초기값, 완료·칭찬은 산식 입력이 아니다.
do $$ declare x text;r integer;expected integer;a uuid;begin
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=15;
  foreach x in array array['positive','neutral','negative'] loop
    for r in 1..5 loop
      expected:=case x when 'positive' then 1 when 'neutral' then 0 else -2 end+case when r<=2 then -2 when r=3 then 0 else 1 end;
      assert private.review_sweetness_delta(x,r)=expected;
      a:=pg_temp.sweet_fixture(x,r);
      assert private.current_member_sweetness(pg_temp.sweet_uid(2))=15+expected;
      assert private.current_member_sweetness(pg_temp.sweet_uid(1))=15;
      delete from public.posts where id=(select post_id from public.appointments where id=a);
    end loop;
  end loop;
  perform pg_temp.sweet_expect('select private.review_sweetness_delta(''unknown'',5)','22023');
end $$;
-- 실제 완료 전과 한쪽 기한 전은 미반영. 기한 경계는 maintenance 없이 조회에 반영한다.
do $$ declare a uuid;v uuid;begin
  a:=pg_temp.sweet_fixture('positive',5,true,false);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=15;
  update public.appointments set status='completed',completed_at=now()-interval '1 day',completion_method='automatic',completion_notified_at=now(),dispute_deadline_at=now()+interval '1 day',review_deadline_at=now()+interval '6 days' where id=a;
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=17;
  delete from public.posts where id=(select post_id from public.appointments where id=a);
  a:=pg_temp.sweet_fixture('positive',5,false,true,clock_timestamp()+interval '1 hour');
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=15;
  update public.appointments set review_deadline_at=clock_timestamp() where id=a;
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=17;
  select id into v from public.appointment_reviews where appointment_id=a;
  perform public.set_review_publication(v,false);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=17,'released then hidden score lost';
  assert not private.is_review_public_eligible(v);
  perform private.decide_review_sweetness(gen_random_uuid(),v,1,false);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=15;
  perform private.decide_review_sweetness(gen_random_uuid(),v,2,true);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=17;
  assert not private.is_review_public_eligible(v),'validity correction automatically republished hidden review';
  delete from public.posts where id=(select post_id from public.appointments where id=a);
  a:=pg_temp.sweet_fixture('positive',5,false,true,clock_timestamp()+interval '1 hour');
  select id into v from public.appointment_reviews where appointment_id=a;
  perform public.set_review_publication(v,false);
  update public.appointments set review_deadline_at=clock_timestamp() where id=a;
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=15,'hidden before release contributed';
  delete from public.posts where id=(select post_id from public.appointments where id=a);
end $$;
-- 노쇼로 동행·후기 자격이 무효면 기여를 제외하고 정상 동행 정정 때 원 기여를 복원한다.
do $$ declare a uuid;begin
  a:=pg_temp.sweet_fixture('positive',5);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=17;
  insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining,status,resolved_at,resolution)
    values(a,pg_temp.sweet_uid(2),'합성 노쇼 판정',interval '1 day','resolved',clock_timestamp(),'no_show');
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=15;
  update public.appointment_disputes set resolution='actual_meetup' where appointment_id=a;
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=17;
  delete from public.posts where id=(select post_id from public.appointments where id=a);
end $$;
-- 같은 사건 운영 감점은 최대 하나다. 무효 정정 후 원 합계를 재계산한다.
do $$ declare e uuid:=private.active_member_episode(pg_temp.sweet_uid(2));i uuid:=gen_random_uuid();d uuid:=gen_random_uuid();a uuid;begin
  a:=pg_temp.sweet_fixture('negative',1);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=11;
  perform private.decide_incident_sweetness(d,i,e,'cancel_sanction',1,true);
  perform private.decide_incident_sweetness(d,i,e,'cancel_sanction',1,true);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=9;
  perform private.decide_incident_sweetness(gen_random_uuid(),i,private.active_member_episode(pg_temp.sweet_uid(1)),'no_show',1,true);
  assert private.current_member_sweetness(pg_temp.sweet_uid(1))=12,'same incident second responsible member rejected';
  perform private.decide_incident_sweetness(gen_random_uuid(),i,e,'no_show',1,true);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=8;
  perform private.decide_incident_sweetness(gen_random_uuid(),i,e,'major_violation',1,true);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=1;
  perform private.decide_incident_sweetness(gen_random_uuid(),i,e,'major_violation',2,false);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=8;
  perform pg_temp.sweet_expect(format('select private.decide_incident_sweetness(%L,%L,%L,''no_show'',1,false)',d,i,e),'40001');
  delete from private.sweetness_incident_decisions where incident_id=i;delete from private.sweetness_incidents where incident_id=i;
  delete from public.posts where id=(select post_id from public.appointments where id=a);
end $$;
-- 마지막 표시만 clamp한다. 높은 원합계와 낮은 원합계를 무효화 후 정확히 복원한다.
do $$ declare a uuid;v uuid;n integer;begin
  for n in 1..50 loop perform pg_temp.sweet_fixture('positive',5);end loop;
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=100;
  for v in select id from public.appointment_reviews where reviewer_id=pg_temp.sweet_uid(1) limit 10 loop
    perform private.decide_review_sweetness(gen_random_uuid(),v,1,false);
  end loop;
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=95;
  delete from public.posts where author_id=pg_temp.sweet_uid(1);
  for n in 1..5 loop perform pg_temp.sweet_fixture('negative',1);end loop;
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=0;
  for v in select id from public.appointment_reviews where reviewer_id=pg_temp.sweet_uid(1) limit 2 loop
    perform private.decide_review_sweetness(gen_random_uuid(),v,1,false);
  end loop;
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=3;
  delete from public.posts where author_id=pg_temp.sweet_uid(1);
end $$;
-- 새 가입 회차로 과거 약속·점수·완료 횟수를 이전하지 않는다. 실제 탈퇴 API는 별도다.
do $$ declare old uuid:=private.active_member_episode(pg_temp.sweet_uid(2));a uuid;i uuid:=gen_random_uuid();begin
  a:=pg_temp.sweet_fixture('positive',5);
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=17;
  assert private.completed_appointment_count(pg_temp.sweet_uid(2))=1;
  perform private.decide_incident_sweetness(gen_random_uuid(),i,old,'cancel_sanction',1,true);
  update private.member_episodes set ended_at=clock_timestamp() where id=old;
  insert into private.member_episodes(profile_id) values(pg_temp.sweet_uid(2));
  assert private.current_member_sweetness(pg_temp.sweet_uid(2))=15;
  assert private.completed_appointment_count(pg_temp.sweet_uid(2))=0;
  perform private.decide_incident_sweetness(gen_random_uuid(),i,old,'cancel_sanction',2,false);
  perform pg_temp.sweet_expect(format('select private.decide_incident_sweetness(gen_random_uuid(),gen_random_uuid(),%L,''no_show'',1,true)',old),'55000');
  perform set_config('request.jwt.claim.sub',pg_temp.sweet_uid(2)::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.sweet_uid(2))::text,true);
  assert private.get_public_profile_reviews_without_blocks(pg_temp.sweet_uid(2),20,null)->'reviews'='[]'::jsonb;
  assert(select requester_episode_id from private.appointment_member_episodes where appointment_id=a)=old;
end $$;
-- 내부 원장·판정 helper의 일반 사용자·service_role·PUBLIC 상속 권한을 닫는다.
do $$ declare r text;f text;begin
  foreach r in array array['authenticated','anon','service_role'] loop
    foreach f in array array['private.active_member_episode(uuid)','private.sync_appointment_sweetness(uuid)',
      'private.current_member_sweetness(uuid)','private.decide_review_sweetness(uuid,uuid,bigint,boolean)',
      'private.decide_incident_sweetness(uuid,uuid,uuid,text,bigint,boolean)'] loop
      assert not has_function_privilege(r,f,'EXECUTE');
    end loop;
    assert not has_table_privilege(r,'private.member_episodes','SELECT');
    assert not has_table_privilege(r,'private.sweetness_review_contributions','INSERT');
  end loop;
end $$;
set local role authenticated;
do $$ begin
  perform set_config('request.jwt.claim.sub',pg_temp.sweet_uid(2)::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.sweet_uid(2))::text,true);
end $$;
do $$ begin
  assert public.get_my_profile()->>'sweetness'='15';
  assert public.get_public_profile(pg_temp.sweet_uid(2))->>'sweetness'='15';
  perform pg_temp.sweet_expect('select private.current_member_sweetness(gen_random_uuid())','42501');
  perform set_config('request.jwt.claims',(auth.jwt()||'{"is_anonymous":true}')::text,true);
  perform pg_temp.sweet_expect('select public.get_my_profile()','28000');
  perform pg_temp.sweet_expect(format('select public.get_public_profile(%L)',pg_temp.sweet_uid(2)),'28000');
end $$;
reset role;
rollback;
