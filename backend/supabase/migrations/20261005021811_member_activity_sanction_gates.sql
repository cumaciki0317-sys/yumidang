-- 민규: 신규 활동만 제재한다. 21810 파일은 immutable이며 본 migration에서 owner 함수만 보완한다.
-- DB 적용/두 세션 경합은 별도 검증 전까지 NOT_RUN이다. 운영 ACL/cleanup guard를 열지 않는다.
begin;
create function private.assert_new_member_activity_allowed()
returns void language plpgsql volatile security definer set search_path='' as $$
declare me uuid:=private.require_service_profile(); identity uuid;episode uuid;begin
 -- require_service_profile의 lifecycle account→profile→현재 episode 공유잠금을 유지한다.
 select e.identity_id,e.id into identity,episode from private.member_episodes e
 join private.naver_identity_keys k on k.id=e.identity_id
 join private.naver_accounts a on a.subject=k.subject and a.user_id=e.profile_id
 where e.profile_id=me and e.ended_at is null and a.completed_at is not null
 and a.completed_at<=clock_timestamp()and a.verified_at<=clock_timestamp();
 if not found then raise exception 'verified_member_identity_required'using errcode='42501';end if;
 -- qualification/gender/나이를 제재 identity의 조건으로 사용하지 않는다. 기존 신규활동 자격 검사는 보존한다.
 if exists(select 1 from private.safety_sanction_applications a where a.identity_id=identity and a.revoked_at is null
  and(a.kind='permanent'or(a.kind in('cancel_restriction','general_7d','general_30d')and a.expires_at>clock_timestamp())))then
  raise exception 'member_activity_restricted'using errcode='42501';end if;
end;$$;

-- 각 수정의 서명/기본값/OID/owner/ACL/결과 DTO를 보존한다. 알려진 body만 좁게 수정한다.
do $$declare sig text;definition text;before_source text;after_source text;f oid;meta jsonb;owner_name text;
 anchor text;replacement text;pair text[];begin
 select pg_get_userbyid(proowner)into owner_name from pg_proc where oid='private.create_service_post_before_member_retirement(uuid,jsonb)'::regprocedure;
 execute format('alter function private.assert_new_member_activity_allowed()owner to %I',owner_name);
 revoke all on function private.assert_new_member_activity_allowed()from public,anon,authenticated,service_role;

 sig:='private.record_incident_revision(uuid,uuid,bigint,text,text,uuid,jsonb)';f:=sig::regprocedure;
 select jsonb_build_array(proowner,proacl::text,proargnames,proargmodes,pg_get_function_arguments(oid),pg_get_function_result(oid))into meta from pg_proc where oid=f;
 select prosrc into before_source from pg_proc where oid=f;definition:=pg_get_functiondef(f);
 anchor:='union select source_episode_id from private.safety_incident_subjects where incident_id=p_incident_id)q';
 replacement:='union select source_episode_id from private.safety_incident_subjects where incident_id=p_incident_id
 union select id from private.member_episodes where ended_at is null and identity_id=any(ids))q';
 if(length(before_source)-length(replace(before_source,anchor,'')))/length(anchor)<>1 then raise exception 'sanction_lock_source_changed'using errcode='55000';end if;
 definition:=replace(definition,anchor,replacement);
 foreach pair slice 1 in array array[
  ['where k.id=any(ids)order by a.user_id,a.subject for share of a;','where k.id=any(ids)order by a.subject for update of a nowait;'],
  ['order by id for share;','order by id for update nowait;'],
  ['order by profile_id,id for share;','order by profile_id,id for update nowait;'],
  ['return p_expected_revision+1;','return p_expected_revision+1;\nexception when lock_not_available then raise exception ''state_conflict''using errcode=''40001'';']
 ]loop
  anchor:=pair[1];replacement:=replace(pair[2],E'\\n',E'\n');
  if(length(before_source)-length(replace(before_source,anchor,'')))/length(anchor)<>1 then raise exception 'sanction_lock_source_changed'using errcode='55000';end if;
  definition:=replace(definition,anchor,replacement);
 end loop;
 execute definition;
 if not exists(select 1 from pg_proc where oid=f and jsonb_build_array(proowner,proacl::text,proargnames,proargmodes,pg_get_function_arguments(oid),pg_get_function_result(oid))=meta)then
  raise exception 'sanction_function_metadata_changed'using errcode='55000';end if;

 -- 공개 RPC가 아니라 owner-only의 실제 신규 쓰기 직전이다. 성공 재시도·기존 채팅은 보존한다.
 foreach pair slice 1 in array array[
  ['private.create_service_post_before_member_retirement(uuid,jsonb)','select * into v_post from public.create_post('],
  ['private.request_service_post_without_blocks(uuid,uuid,text)','update public.join_requests set status=''pending'' where id=r.id returning * into r;'],
  ['private.request_service_post_without_blocks(uuid,uuid,text)','insert into public.join_requests(post_id,requester_id,message) values'],
  ['private.propose_match_without_blocks(uuid)','insert into private.match_consents(request_id,condition_version,condition_fingerprint,conditions,requested_by,requested_at,accepted_at)'],
  ['private.accept_match_without_blocks(uuid,text)','if v_lifecycle.request_id is null or v_lifecycle.condition_version<>p_condition_version']
 ]loop
  sig:=pair[1];anchor:=pair[2];f:=sig::regprocedure;
  select jsonb_build_array(proowner,proacl::text,proargnames,proargmodes,pg_get_function_arguments(oid),pg_get_function_result(oid)),prosrc into meta,before_source from pg_proc where oid=f;
  if(length(before_source)-length(replace(before_source,anchor,'')))/length(anchor)<>1 then raise exception 'activity_gate_source_changed'using errcode='55000';end if;
  definition:=replace(pg_get_functiondef(f),anchor,'perform private.assert_new_member_activity_allowed();'||E'\n  '||anchor);
  execute definition;
  if not exists(select 1 from pg_proc where oid=f and jsonb_build_array(proowner,proacl::text,proargnames,proargmodes,pg_get_function_arguments(oid),pg_get_function_result(oid))=meta)then
   raise exception 'activity_function_metadata_changed'using errcode='55000';end if;
 end loop;
end;$$;
commit;
