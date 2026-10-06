# 취소 due 실행 제어 행 부재 차단

작업자 minkyu, coordinator. source78의 두 due RPC는 `if not(select enabled...)`가 행 부재 때 NULL이어서 차단 분기를 지나갈 수 있었다. 후속82 후보는 정확한78 함수 본문을 확인한 뒤 guard 한 표현만 `is distinct from true`로 바꾼다. 원 SQL78·24시간 기한·제재 시계·점유·출력·정책은 유지한다.

기본 false인 singleton과 service 실행 권한 폐쇄 상태에서만 적용하며 기존 OID·owner·ACL·설정을 보존한다. 새 함수·테이블·권한·예약 작업을 만들지 않는다. 회귀는 false/행 부재55000·true 이후 잘못된 입력22023·일반 JWT42501 및 빈 큐 보존을 검사한다. 실제 제재 효과는 기존78 검증과 구분한다.

현재 private 후보이며 실제 SQL/운영 적용은 NOT_RUN이다. source81과 독립적인 guard 수정이고 파일 준비 도구에는 아직 등록하지 않았다. 검토·단일TX/ROLLBACK 실제 검증 후 최신 순서로 통합한다.
