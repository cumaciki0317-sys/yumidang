-- 합성 SQL helper 회귀 준비. 실제 Auth발급/HTTP ingress/두세션 잠금 경쟁 미포함.
-- approved fresh scratch에서만 root 실행. 이 파일은 원 상태를 ROLLBACK한다.
-- helper 자격·시각 분리만 검증하는 합성 SQL fixture. 실제 발급 Auth 미포함.
-- 전용 로컬 합성 자료만 사용하며 BEGIN/ROLLBACK 안에서 실행한다.
begin;
create function pg_temp.review_uid(n integer) returns uuid language sql immutable as $$
  select ('d0312500-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
create function pg_temp.review_ap(n integer) returns uuid language sql immutable as $$
  select ('d0312503-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
-- 이 단계는 기존 약속/회원의 후속 처리를 검증한다. 합성 기존 회원은 네이버 등록으로 승격하지 않는다.
insert into auth.users(id) values(pg_temp.review_uid(1)),(pg_temp.review_uid(2)),(pg_temp.review_uid(3));
insert into public.profiles(id,real_name,birth_date,gender) values
  (pg_temp.review_uid(1),'합성 완료작성자','1990-01-01','female'),
  (pg_temp.review_uid(2),'합성 완료신청자','1990-01-01','female'),
  (pg_temp.review_uid(3),'합성 외부회원','1990-01-01','female');
do $$ declare n integer;p uuid;r uuid;v_end timestamptz;v_complete timestamptz;v_status text;
begin
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  for n in 1..13 loop
    p:=('d0312502-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
    r:=('d0312504-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
    v_end:=case when n=1 then clock_timestamp()+interval '1 hour' when n in(10,11) then clock_timestamp()-interval '2 days' else clock_timestamp()-interval '1 hour' end;
    v_status:=case when n in(4,5,6,7,12) then 'completed' when n=8 then 'no_show' when n=9 then 'cancelled' else 'confirmed' end;
    v_complete:=case when n=6 then clock_timestamp()-interval '8 days' when n=12 then clock_timestamp()-interval '10 days' else clock_timestamp()-interval '1 hour' end;
    insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,cost_type,amount,status)
      values(p,pg_temp.review_uid(1),'가상 완료후기 공고','실제 자료가 아닌 로컬 검증','산책',v_end-interval '2 hours',v_end,
        v_end-interval '3 hours','서울특별시 강남구 역삼동','free',0,'closed');
    insert into public.join_requests(id,post_id,requester_id,message,status) values(r,p,pg_temp.review_uid(2),'가상 완료후기 검증 신청','matched');
    if v_status in('completed','no_show') then
      insert into public.appointments(id,post_id,join_request_id,status,completed_at,completion_method,completion_notified_at,dispute_deadline_at,review_deadline_at)
        values(pg_temp.review_ap(n),p,r,v_status,v_complete,'automatic',v_complete,v_complete+interval '24 hours',v_complete+interval '7 days');
    else
      insert into public.appointments(id,post_id,join_request_id,status) values(pg_temp.review_ap(n),p,r,v_status);
    end if;
  end loop;
  insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)
    values(pg_temp.review_ap(11),pg_temp.review_uid(1),'가상 자동 완료 제외 분쟁',interval '7 days');
end $$;

do $$declare n integer;t timestamptz;received timestamptz;decided timestamptz;ap public.appointments;old_result boolean;new_result boolean;begin
 -- 현재 실제 상태/보류/분쟁/확인 조합의 동일시각 동등성. ASSERT 비활성화와 무관하게 실패한다.
 for n in 1..13 loop
  foreach t in array array[clock_timestamp()-interval '9 days',clock_timestamp(),clock_timestamp()+interval '9 days',null::timestamptz] loop
   old_result:=private.can_submit_appointment_review(pg_temp.review_ap(n),pg_temp.review_uid(1),t);
   new_result:=private.can_submit_appointment_review(pg_temp.review_ap(n),pg_temp.review_uid(1),t,t);
   if old_result is distinct from new_result then raise exception 'review_entry_same_time_regression';end if;
  end loop;
 end loop;
 select *into ap from public.appointments where id=pg_temp.review_ap(4);
 received:=ap.review_deadline_at-interval '1 microsecond';decided:=ap.review_deadline_at+interval '1 second';
 if not private.can_submit_appointment_review(ap.id,pg_temp.review_uid(1),received,decided)
 or private.can_submit_appointment_review(ap.id,pg_temp.review_uid(1),ap.review_deadline_at,decided)
 or private.can_submit_appointment_review(ap.id,pg_temp.review_uid(1),ap.review_deadline_at+interval '1 microsecond',decided)
 then raise exception 'review_entry_strict_upper_bound';end if;
 -- T0<T1 completed_at<T2: 완료 하한은 received가 아닌 decision으로 평가한다.
 if not private.can_submit_appointment_review(ap.id,pg_temp.review_uid(1),ap.completed_at-interval '1 second',ap.completed_at+interval '1 second')
 or private.can_submit_appointment_review(ap.id,pg_temp.review_uid(1),ap.completed_at-interval '2 seconds',ap.completed_at-interval '1 second')
 then raise exception 'review_entry_completion_transition';end if;
 if private.can_submit_appointment_review(pg_temp.review_ap(2),pg_temp.review_uid(1),received,decided)
 then raise exception 'review_entry_missing_own_confirmation';end if;
 -- 적격 completed에서 제3자만 분리해 검사: hold 거절로 actor 결함을 가리지 않는다.
 if private.can_submit_appointment_review(ap.id,pg_temp.review_uid(3),received,decided)
 then raise exception 'review_entry_outsider_on_eligible';end if;
 -- confirmed의 종료 후 본인 확인 경계는 실제 true 경로를 먼저 만든다.
 insert into public.appointment_completion_confirmations(appointment_id,user_id)
 values(pg_temp.review_ap(2),pg_temp.review_uid(1));
 if not private.can_submit_appointment_review(pg_temp.review_ap(2),pg_temp.review_uid(1),received,decided)
 or private.can_submit_appointment_review(pg_temp.review_ap(2),pg_temp.review_uid(2),received,decided)
 then raise exception 'review_entry_confirmed_own_confirmation';end if;
 -- manual 감사 계약은 완료 행위자를 요구한다. 먼저 본인 확인을 만들고 같은 행위자로 기록한다.
 -- 한쪽 확인 상태는 helper 거절, 양쪽 확인 상태는 허용을 독립 검사한다.
 insert into public.appointment_completion_confirmations(appointment_id,user_id)
 values(pg_temp.review_ap(5),pg_temp.review_uid(1));
 update public.appointments set completion_method='manual',completed_by_user_id=pg_temp.review_uid(1)
 where id=pg_temp.review_ap(5);
 select *into ap from public.appointments where id=pg_temp.review_ap(5);
 if private.can_submit_appointment_review(ap.id,pg_temp.review_uid(1),ap.completed_at,ap.completed_at)
 then raise exception 'review_entry_manual_one_confirmation';end if;
 insert into public.appointment_completion_confirmations(appointment_id,user_id)
 values(ap.id,pg_temp.review_uid(2));
 if not private.can_submit_appointment_review(ap.id,pg_temp.review_uid(1),ap.completed_at,ap.completed_at)
 then raise exception 'review_entry_manual_both_confirmations';end if;
 if private.can_submit_appointment_review(pg_temp.review_ap(8),pg_temp.review_uid(1),received,decided)
 then raise exception 'review_entry_no_show';end if;
 select *into ap from public.appointments where id=pg_temp.review_ap(4);
 insert into private.appointment_review_holds(appointment_id,state)values(ap.id,'reviewing');
 if private.can_submit_appointment_review(ap.id,pg_temp.review_uid(1),received,decided)
 then raise exception 'review_entry_hold_bypassed';end if;
 if private.can_submit_appointment_review(pg_temp.review_ap(9),pg_temp.review_uid(1),received,decided)
 or private.can_submit_appointment_review(pg_temp.review_ap(11),pg_temp.review_uid(1),received,decided)
 then raise exception 'review_entry_current_status_or_actor';end if;
 if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
 where p.oid='private.can_submit_appointment_review(uuid,uuid,timestamptz,timestamptz)'::regprocedure and a.grantee<>p.proowner)
 then raise exception 'review_entry_new_helper_acl';end if;
end;$$;
select 'PASS_SQL_HELPER_ONLY_HTTP_AND_CONCURRENT_LOCK_NOT_RUN';
rollback;
