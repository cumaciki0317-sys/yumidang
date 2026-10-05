-- 장소 제안 때 저장 가능한 공개 지역 형식을 검사해 수락 불가능한 대기 제안을 방지한다.
-- 기존 장소52 SQL은 보존하고 입력 검증만 보완한다. 마감 접수·철회 정책을 변경하지 않는다.
begin;
create or replace function private.validate_appointment_location(p_input jsonb)
returns jsonb language plpgsql immutable security definer set search_path='' as $$
declare v_key text;v_area text;v_address text;v_detail text;v_place text;v_region text;
begin
 if p_input is null then return null;end if;
 if jsonb_typeof(p_input) is distinct from 'object'
  or not p_input ?& array['publicArea','registeredPlaceName','registeredAddress','meetingDetail']
  or p_input-array['publicArea','registeredPlaceName','registeredAddress','meetingDetail']<>'{}'::jsonb then
  raise exception 'invalid_location' using errcode='22023';end if;
 foreach v_key in array array['publicArea','registeredAddress','meetingDetail'] loop
  if jsonb_typeof(p_input->v_key) is distinct from 'string' then raise exception 'invalid_location' using errcode='22023';end if;
 end loop;
 if jsonb_typeof(p_input->'registeredPlaceName') not in('string','null') then raise exception 'invalid_location' using errcode='22023';end if;
 v_area:=btrim(p_input->>'publicArea');v_address:=btrim(p_input->>'registeredAddress');v_detail:=btrim(p_input->>'meetingDetail');
 v_place:=nullif(btrim(p_input->>'registeredPlaceName'),'');
 v_region:=private.post_search_region(v_area);
 -- 공개 지역 첫 토큰을 기존 17개 지역 표준명으로 정규화한다.
 v_area:=v_region||substr(v_area,length(split_part(v_area,' ',1))+1);
 if char_length(v_area) not between 1 and 60 or char_length(v_address) not between 1 and 300
  or char_length(v_detail) not between 2 and 300 or char_length(v_place)>200
  or v_area !~ '^[가-힣]+(특별시|광역시|특별자치시|특별자치도|도) [가-힣]+(시|군|구)( [가-힣]+구)? [가-힣0-9]+(동|읍|면|가)$'
  or v_region is null or v_region not in('서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도') then
  raise exception 'invalid_location' using errcode='22023';end if;
 return jsonb_build_object('publicArea',v_area,'registeredPlaceName',v_place,'registeredAddress',v_address,'meetingDetail',v_detail);
end; $$;
revoke all on function private.validate_appointment_location(jsonb) from public,anon,authenticated,service_role;
commit;
