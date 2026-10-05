-- 공개 지역을 저장 가능 형식으로 선행 검증하고 별칭을 표준화한다. 합성 회귀/rollback.
begin;
do $$
declare input jsonb; result jsonb; region text; area text;
begin
 input:='{"publicArea":"서울 강남구 역삼동","registeredPlaceName":null,"registeredAddress":"합성 주소","meetingDetail":"정문 앞"}'::jsonb;
 result:=private.validate_appointment_location(input);
 assert result->>'publicArea'='서울특별시 강남구 역삼동';
 result:=private.validate_appointment_location(input||'{"publicArea":"전라북도 전주시 완산구 서신동"}'::jsonb);
 assert result->>'publicArea'='전북특별자치도 전주시 완산구 서신동';
 result:=private.validate_appointment_location(input||'{"publicArea":"강원도 춘천시 퇴계동"}'::jsonb);
 assert result->>'publicArea'='강원특별자치도 춘천시 퇴계동';
 foreach region in array array['서울특별시','부산광역시','대구광역시','인천광역시','광주광역시','대전광역시','울산광역시','세종특별자치시','경기도','강원특별자치도','충청북도','충청남도','전북특별자치도','전라남도','경상북도','경상남도','제주특별자치도'] loop
  assert private.validate_appointment_location(input||jsonb_build_object('publicArea',region||' 테스트시 테스트동'))->>'publicArea'=region||' 테스트시 테스트동';
 end loop;
 foreach area in array array['서울특별시 종로구','서울 강남구','서울특별시 강남구  역삼동','서울특별시  강남구 역삼동','미등록도 테스트시 테스트동'] loop
  begin
   perform private.validate_appointment_location(input||jsonb_build_object('publicArea',area));
   raise exception 'invalid location accepted';
  exception when sqlstate '22023' then null;
  end;
 end loop;
 assert not has_function_privilege('authenticated','private.validate_appointment_location(jsonb)','execute');
 assert not has_function_privilege('service_role','private.validate_appointment_location(jsonb)','execute');
end;$$;
rollback;
