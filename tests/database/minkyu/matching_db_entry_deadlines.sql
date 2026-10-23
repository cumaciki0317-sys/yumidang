-- 126 후보의 소유자 SQL helper 경계. 실제 Auth/HTTP/두 세션 경합 NOT_RUN.
begin;
insert into auth.users(id) values('d0312600-0000-4000-8000-000000000001'),('d0312600-0000-4000-8000-000000000002');
insert into public.profiles(id,real_name,birth_date,gender) values
 ('d0312600-0000-4000-8000-000000000001','합성 작성자','1990-01-01','female'),
 ('d0312600-0000-4000-8000-000000000002','합성 신청자','1990-01-01','female');
do $$declare p uuid:='d0312601-0000-4000-8000-000000000001';r uuid:='d0312602-0000-4000-8000-000000000001';
 a uuid:='d0312603-0000-4000-8000-000000000001';c uuid:='d0312604-0000-4000-8000-000000000001';
 t timestamptz:=clock_timestamp();deadline timestamptz;before_definition text;p2 uuid:='d0312601-0000-4000-8000-000000000002';r2 uuid:='d0312602-0000-4000-8000-000000000002';begin
 perform set_config('request.jwt.claims','{"role":"service_role"}',true);
 insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
 values(p,'d0312600-0000-4000-8000-000000000001','합성 마감 공고','격리 SQL 회귀','산책',t+interval '1 hour',t+interval '2 hours',t+interval '30 minutes','서울특별시 강남구 역삼동','closed');
 insert into public.join_requests(id,post_id,requester_id,message,status)values(r,p,'d0312600-0000-4000-8000-000000000002','합성 신청','matched');
 insert into public.appointments(id,post_id,join_request_id,status)values(a,p,r,'confirmed');
 insert into private.appointment_schedule_changes(change_id,appointment_id,requested_by,old_starts_at,old_ends_at,old_updated_at,new_starts_at,new_ends_at,requested_at,expires_at)
 select c,a,'d0312600-0000-4000-8000-000000000001',starts_at,ends_at,updated_at,t+interval '3 hours',t+interval '4 hours',t,t+interval '1 hour'from public.posts where id=p;
 deadline:=t+interval '1 hour';
 -- 같은 시각에는 기존 helper와 의미가 같고, 상한 정각은 거절한다.
 if private.appointment_schedule_response_open(c,t,t)is distinct from private.appointment_schedule_response_open(c,t)
 or private.appointment_schedule_response_open(c,deadline,deadline)
 or private.appointment_schedule_response_open(c,deadline+interval '1 microsecond',deadline)
 then raise exception 'matching_entry_equal_and_strict_upper';end if;
 if not private.appointment_schedule_response_open(c,deadline-interval '1 microsecond',deadline+interval '1 second')
 then raise exception 'matching_entry_predeadline_afterlock';end if;
 -- requested_at 하한은 현재 판단 시각으로 검사한다.
 if private.appointment_schedule_response_open(c,t-interval '1 second',t-interval '1 microsecond')
 then raise exception 'matching_entry_requested_lower';end if;
 -- 원 helper와 같은 시각의 전체 조건 조합: fingerprint·일정·분쟁.
 update private.appointment_schedule_changes set old_location_fingerprint='changed'where change_id=c;
 if private.appointment_schedule_response_open(c,t,t)or private.appointment_schedule_response_open(c,t)
 then raise exception 'matching_entry_location_fingerprint';end if;
 -- 만료는 기존/새 시작 및 요청+6시간과 결합된다. 종료만 바꿔 순서 제약을 유지하며 불일치를 만든다.
 update private.appointment_schedule_changes set old_location_fingerprint=null,old_ends_at=old_ends_at+interval '1 second'where change_id=c;
 if private.appointment_schedule_response_open(c,t,t)or private.appointment_schedule_response_open(c,t)
 then raise exception 'matching_entry_schedule_fingerprint';end if;
 update private.appointment_schedule_changes set old_ends_at=t+interval '2 hours'where change_id=c;
 begin
 insert into public.appointment_disputes(appointment_id,raised_by_user_id,reason,review_time_remaining)
 values(a,'d0312600-0000-4000-8000-000000000001','합성 변경 분쟁',interval '7 days');
 if private.appointment_schedule_response_open(c,t,t)or private.appointment_schedule_response_open(c,t)
 then raise exception 'matching_entry_open_dispute';end if;
 raise exception 'matching_entry_dispute_rollback'using errcode='Z1260';
 exception when sqlstate 'Z1260'then null;end;
 if not private.appointment_schedule_response_open(c,t,t)or not private.appointment_schedule_response_open(c,t)
 then raise exception 'matching_entry_restored_conditions';end if;
 update private.appointment_schedule_changes set status='expired',resolved_at=clock_timestamp()where change_id=c;
 if private.appointment_schedule_response_open(c,t,deadline+interval '1 second')then raise exception 'matching_entry_no_resurrection';end if;
 update private.appointment_schedule_changes set status='awaiting_response',resolved_at=null where change_id=c;
 update public.appointments set status='cancelled'where id=a;
 if private.appointment_schedule_response_open(c,t,t)then raise exception 'matching_entry_current_status';end if;
 -- 확정 수락의 자기 동의는 진입시각 전에는 만료하지 않고, 정각에는 만료한다.
 insert into private.match_consents(request_id,condition_version,condition_fingerprint,conditions,requested_by,requested_at)
 values(r,'matching126-version','synthetic-fingerprint','{}'::jsonb,'d0312600-0000-4000-8000-000000000001',t-interval '1 hour');
 insert into private.match_consent_lifecycle(request_id,post_id,condition_version,requested_at,expires_at,status)
 values(r,p,'matching126-version',t-interval '1 hour',t-interval '1 second','awaiting_consent');
 if private.expire_post_match_consents(p,r,t-interval '2 seconds')<>0
 or(select status from private.match_consent_lifecycle where request_id=r)<>'awaiting_consent'
 then raise exception 'matching_entry_target_not_expired';end if;
 if private.expire_post_match_consents(p,r,t-interval '1 second')<>1
 or(select status from private.match_consent_lifecycle where request_id=r)<>'expired'
 then raise exception 'matching_entry_target_exact_expiry';end if;
 if private.expire_post_match_consents(p,r,t-interval '2 seconds')<>0
 or(select status from private.match_consent_lifecycle where request_id=r)<>'expired'
 then raise exception 'matching_entry_target_never_revived';end if;
 -- 다른 공고의 동의는 자기 진입시각이 아니라 실제 DB clock으로 만료한다.
 insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,status)
 values(p2,'d0312600-0000-4000-8000-000000000001','합성 다른 마감','격리 SQL 회귀','산책',t+interval '1 day',t+interval '1 day 1 hour',t+interval '1 day','서울특별시 강남구 역삼동','closed');
 insert into public.join_requests(id,post_id,requester_id,message,status)values(r2,p2,'d0312600-0000-4000-8000-000000000002','합성 다른 신청','pending');
 insert into private.match_consents(request_id,condition_version,condition_fingerprint,conditions,requested_by,requested_at)
 values(r2,'matching126-other','synthetic-fingerprint','{}'::jsonb,'d0312600-0000-4000-8000-000000000001',t-interval '1 hour');
 insert into private.match_consent_lifecycle(request_id,post_id,condition_version,requested_at,expires_at,status)
 values(r2,p2,'matching126-other',t-interval '1 hour',t-interval '1 second','awaiting_consent');
 if private.expire_post_match_consents(p2,r,t-interval '2 seconds')<>1
 or(select status from private.match_consent_lifecycle where request_id=r2)<>'expired'
 then raise exception 'matching_entry_other_request_real_clock';end if;
 -- 새 helper는 직접 제품 역할에 공개되지 않는다.
 if exists(select 1 from pg_proc f cross join lateral aclexplode(coalesce(f.proacl,acldefault('f',f.proowner)))g
 where f.oid in('private.appointment_schedule_response_open(uuid,timestamptz,timestamptz)'::regprocedure,
 'private.expire_post_match_consents(uuid,uuid,timestamptz)'::regprocedure)and g.grantee<>f.proowner)
 then raise exception 'matching_entry_acl';end if;
end;$$;
-- 합성 SQL claims/session metadata만 사용한다. 실제 GoTrue JWT/HTTP 인증 증거가 아니다.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('profile-images','profile-images',false,2097152,array['image/jpeg']::text[])on conflict(id)do nothing;
create function pg_temp.entry_uid(n integer)returns uuid language sql immutable as $$select('d0312610-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.entry_session(n integer)returns uuid language sql immutable as $$select('d0312611-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;$$;
create function pg_temp.entry_actor(n integer)returns void language plpgsql as $$begin
 perform set_config('request.jwt.claim.sub',pg_temp.entry_uid(n)::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',pg_temp.entry_uid(n),'session_id',pg_temp.entry_session(n))::text,true);
end;$$;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop
 perform public.resolve_naver_account('matching126-owner-'||i,'합성 마감회원'||i,'F','1990-01-01');
end loop;end;$$;
reset role;
insert into auth.users(id,email)select pg_temp.entry_uid(i),a.auth_email from generate_series(1,2)i join private.naver_accounts a on a.subject='matching126-owner-'||i;
insert into auth.sessions(id,user_id)select pg_temp.entry_session(i),pg_temp.entry_uid(i)from generate_series(1,2)i;
insert into storage.objects(bucket_id,name,owner_id,metadata)select 'profile-images',pg_temp.entry_uid(i)::text||'/d0312612-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg',pg_temp.entry_uid(i)::text,'{"mimetype":"image/jpeg","size":128}'::jsonb from generate_series(1,2)i;
set local role service_role;
do $$declare i integer;begin for i in 1..2 loop perform public.record_naver_session('matching126-owner-'||i,pg_temp.entry_uid(i),pg_temp.entry_session(i));end loop;end;$$;
reset role;
do $$declare i integer;outcome jsonb;begin for i in 1..2 loop
 perform pg_temp.entry_actor(i);
 outcome:=public.complete_naver_signup(pg_temp.entry_uid(i)::text||'/d0312612-0000-4000-8000-'||lpad(i::text,12,'0')||'.jpg','{}','{}',null);
 if outcome->>'status' is distinct from 'ready'then raise exception 'matching_entry_synthetic_qualification';end if;
end loop;end;$$;
do $$declare p uuid:='d0312613-0000-4000-8000-000000000001';m uuid:='d0312614-0000-4000-8000-000000000001';
 input jsonb;first_result jsonb;retry_result jsonb;proposal jsonb;accepted jsonb;duplicate jsonb;own_request_id uuid;version text;code text;begin
 perform pg_temp.entry_actor(1);
 input:=jsonb_build_object('title','합성 DB 진입 공고','description','격리 SQL 회귀','category','산책',
 'startsAt',clock_timestamp()+interval '3 days','endsAt',clock_timestamp()+interval '3 days 1 hour',
 'recruitmentEndsAt',clock_timestamp()+interval '2 days','publicArea','서울특별시 강남구 역삼동',
 'registeredPlaceName','가상 장소','registeredAddress','비공개 가상주소 123','meetingDetail','가상 입구',
 'preferenceNote',null,'tags','[]'::jsonb,'costType','free','amount',0);
 perform public.create_service_post(p,input);
 perform pg_temp.entry_actor(2);
 first_result:=public.request_service_post(p,m,'합성 첫 메시지');own_request_id:=(first_result->>'id')::uuid;
 retry_result:=public.request_service_post(p,m,'합성 첫 메시지');
 if first_result->>'alreadySent'<>'false'or retry_result->>'alreadySent'<>'true'or retry_result->>'id'<>first_result->>'id'
 or(select count(*)from public.chat_messages where id=m)<>1 then raise exception 'matching_entry_first_message_idempotence';end if;
 -- 같은 statement 진입 정각 마감: 신규 메시지는 거절, 기존 성공 재시도는 보존한다.
 update public.posts set recruitment_ends_at=statement_timestamp()where id=p;
 begin perform public.request_service_post(p,gen_random_uuid(),'정각 새 신청');
 exception when others then get stacked diagnostics code=returned_sqlstate;end;
 if code is distinct from '40001'then raise exception 'matching_entry_first_message_exact_deadline';end if;
 retry_result:=public.request_service_post(p,m,'합성 첫 메시지');
 if retry_result->>'alreadySent'<>'true'then raise exception 'matching_entry_first_message_retry_after_deadline';end if;
 update public.posts set recruitment_ends_at=clock_timestamp()+interval '2 days'where id=p;
 perform pg_temp.entry_actor(1);proposal:=public.propose_match(own_request_id);version:=proposal->>'conditionVersion';
 -- 동일 statement 접수 정각에 만료한 동의는 수락하지 않는다. 실패의 상태 변경도 함께 롤백된다.
 update private.match_consent_lifecycle set requested_at=statement_timestamp()-interval '1 hour',expires_at=statement_timestamp()where request_id=own_request_id;
 perform pg_temp.entry_actor(2);code:=null;
 begin perform public.accept_match(own_request_id,version);
 exception when others then get stacked diagnostics code=returned_sqlstate;end;
 if code is distinct from '40001'then raise exception 'matching_entry_accept_exact_deadline';end if;
 update private.match_consent_lifecycle set expires_at=clock_timestamp()+interval '1 hour'where request_id=own_request_id;
 accepted:=public.accept_match(own_request_id,version);duplicate:=public.accept_match(own_request_id,version);
 if accepted->>'appointmentId'is null or duplicate->>'appointmentId'is distinct from accepted->>'appointmentId'
 or duplicate->>'alreadyConfirmed'<>'true'then raise exception 'matching_entry_accept_idempotence';end if;
 -- 세 번째 patched 본문도 공개 wrapper를 통해 실행한다. 원 updatedAt/상대방 검증을 유지한다.
 perform pg_temp.entry_actor(1);
 proposal:=public.propose_appointment_schedule_change((accepted->>'appointmentId')::uuid,
 'd0312615-0000-4000-8000-000000000001',
 (select starts_at+interval '1 day'from public.posts where id=p),
 (select ends_at+interval '1 day'from public.posts where id=p),
 (select updated_at from public.posts where id=p));
 version:=proposal->>'conditionVersion';perform pg_temp.entry_actor(2);
 accepted:=public.accept_appointment_schedule_change((accepted->>'appointmentId')::uuid,
 'd0312615-0000-4000-8000-000000000001',version);
 duplicate:=public.accept_appointment_schedule_change((select id from public.appointments where post_id=p),
 'd0312615-0000-4000-8000-000000000001',version);
 if accepted->>'status'is distinct from 'accepted'or duplicate->>'deduplicated'is distinct from 'true'
 then raise exception 'matching_entry_schedule_accept_idempotence';end if;

end;$$;

select 'PASS_MATCHING_ENTRY_SYNTHETIC_SQL_ONLY_HTTP_CONCURRENCY_NOT_RUN';
rollback;
