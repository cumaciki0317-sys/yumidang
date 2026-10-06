-- 민규: 승인·배정된 담당자의 attached 신고 증거 GET/HEAD. 원본 DB 채팅이나 서명 bearer를 열지 않는다.
-- 선행70 immutable296cc. 실제 담당 승인/배정은 기본 비어 있으며 이 migration은 행을 만들지 않는다.
begin;
do $$begin
 if to_regprocedure('private.require_assigned_report_operator(uuid)')is null or to_regprocedure('private.assigned_report_capture_json(uuid,uuid)')is null
 or to_regprocedure('storage.operation()')is null or to_regprocedure('storage.allow_any_operation(text[])')is null or to_regprocedure('storage.allow_only_operation(text)')is null then
  raise exception 'assigned_capture_contract_missing'using errcode='55000';end if;
 if not exists(select 1 from storage.buckets where id='report-evidence'and not public and file_size_limit=5242880 and allowed_mime_types=array['image/jpeg','image/png','image/webp']::text[])then
  raise exception 'assigned_capture_bucket_contract_missing'using errcode='55000';end if;
 if not exists(select 1 from pg_policies where schemaname='storage'and tablename='objects'and policyname='report_capture_owner_read'and cmd='SELECT'and roles=array['authenticated']::name[])then
  raise exception 'assigned_capture_member_policy_missing'using errcode='55000';end if;
end;$$;
create function private.assigned_report_capture_storage_read_allowed(p_name text,p_owner text)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare a private.report_capture_assets;u uuid;proof jsonb;begin
 -- 비회원 담당자도 일반 가입 helper 없이 검증된 staff session을 사용한다.
 if coalesce(auth.role(),'')<>'authenticated'or auth.uid()is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false)then return false;end if;
 if p_name is null or p_owner is null or not storage.allow_any_operation(array[
  'storage.object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info']::text[])then return false;end if;
 -- 아직 잠그지 않은 대상 탐색은 payload/본문을 반환하지 않는다. 이후70의 auth→session→approval→assignment 순서부터 잠근다.
 select *into a from private.report_capture_assets where object_name=p_name and owner_id::text=p_owner and state='attached';
 if not found then return false;end if;
 begin u:=private.require_assigned_report_operator(a.report_id);
 exception when sqlstate '28000'or sqlstate '42501'then return false;end;
 perform 1 from private.member_reports where id=a.report_id and(retention_due_at is null or retention_due_at>clock_timestamp())for share;
 if not found then return false;end if;
 begin proof:=private.assigned_report_capture_json(a.report_id,a.id);
 exception when sqlstate 'PT404'then return false;end;
 if proof->>'path'<>p_name or proof->>'bucket'<>'report-evidence'then return false;end if;
 -- 감사는 권한/metadata 접근이다. blob 전송 완료 영수증으로 주장하지 않는다.
 insert into private.report_access_audit(actor_id,report_id,asset_id,action)values(u,a.report_id,a.id,'storage_read');
 return true;
end;$$;
do $$declare own oid;owner_name text;r text;begin
 select proowner,pg_get_userbyid(proowner)into strict own,owner_name from pg_proc where oid='public.get_assigned_report_capture(uuid,uuid)'::regprocedure;
 if owner_name in('anon','authenticated','service_role','authenticator')then raise exception 'assigned_capture_owner_incompatible'using errcode='55000';end if;
 foreach r in array array['anon','authenticated','service_role','authenticator']loop
  if pg_has_role(r,own,'USAGE')or pg_has_role(r,own,'SET')then raise exception 'assigned_capture_owner_incompatible'using errcode='55000';end if;
 end loop;
 if not has_schema_privilege(owner_name,'auth','USAGE')or not has_schema_privilege(owner_name,'storage','USAGE')
 or not has_schema_privilege(owner_name,'private','USAGE')or not has_function_privilege(owner_name,'auth.uid()','EXECUTE')
 or not has_function_privilege(owner_name,'auth.role()','EXECUTE')or not has_function_privilege(owner_name,'auth.jwt()','EXECUTE')
 or not has_function_privilege(owner_name,'storage.allow_any_operation(text[])','EXECUTE')
 or not has_function_privilege(owner_name,'private.require_assigned_report_operator(uuid)','EXECUTE')
 or not has_function_privilege(owner_name,'private.assigned_report_capture_json(uuid,uuid)','EXECUTE')
 or not has_table_privilege(owner_name,'private.report_capture_assets','SELECT')or not has_table_privilege(owner_name,'private.member_reports','SELECT')
 or not has_table_privilege(owner_name,'private.member_reports','UPDATE')or not has_table_privilege(owner_name,'private.report_access_audit','INSERT')
 or not has_sequence_privilege(owner_name,'private.report_access_audit_id_seq','USAGE')then raise exception 'assigned_capture_owner_incompatible'using errcode='55000';end if;
 execute format('alter function private.assigned_report_capture_storage_read_allowed(text,text)owner to %I',owner_name);
end;$$;
revoke all on function private.assigned_report_capture_storage_read_allowed(text,text)from public,anon,authenticated,service_role;
-- Boolean RLS predicate만 공개하며 원문 반환/담당 변경 helper는 닫힌 상태를 유지한다.
grant execute on function private.assigned_report_capture_storage_read_allowed(text,text)to authenticated;
-- CASE는 비회원 직원에게 기존 require_report_member 예외가 permissive OR를 깨뜨리는 것을 방지한다.
-- bucket/owner가 일치하는 기존 회원 경로에서만 이전 가드·감사를 그대로 호출한다.
alter policy report_capture_owner_read on storage.objects using(
 case when bucket_id='report-evidence'and owner_id=auth.uid()::text then private.report_capture_read_allowed(name,owner_id)else false end);
create policy report_capture_assigned_operator_read on storage.objects for select to authenticated using(
 case when bucket_id='report-evidence'then private.assigned_report_capture_storage_read_allowed(name,owner_id)else false end);
-- 전역 bucket 권한을 넓히지 않는다. 서명·변환·S3·TUS·token·list·copy·upsert는 allowlist 밖이다.
create policy report_capture_authenticated_operations_only on storage.objects as restrictive for select to authenticated using(
 bucket_id is distinct from 'report-evidence'or storage.allow_any_operation(array[
 'storage.object.get_authenticated','object.get_authenticated_info','object.head_authenticated_info',
 'storage.object.upload','storage.object.delete','storage.object.delete_many']::text[]));
-- signed upload 발급은 INSERT 검사이므로 별도 제한한다. 정규 member upload만 기존 reserved 가드와 함께 허용한다.
create policy report_capture_authenticated_upload_operation_only on storage.objects as restrictive for insert to authenticated with check(
 bucket_id is distinct from 'report-evidence'or storage.allow_only_operation('storage.object.upload'));
-- staff INSERT/UPDATE/DELETE 또는 broad table GRANT, role, approval row, signed URL issuer를 추가하지 않는다.
commit;
