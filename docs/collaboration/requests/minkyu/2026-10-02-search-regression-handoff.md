# 공개 검색 기존 회귀·DB 계약 동기화

전체100%목표와43%·6/14를 유지한다. [숫자 검색 인계](2026-10-02-search-range-handoff.md)의 실제9그룹 검증 이후, 민규 기존 public_search_v2.sql의 활동 자격 fixture와 DB 계약을 최신 구현에 맞춘다. 신규 숫자 검사·migration·종현 검색 코어·기존 사용자 DB는 보존한다.

적격 카드의 true 기대를 삭제하지 않고 실제 합성 네이버 가입·사진 metadata·세션 fixture로 증명한다. 미등록 회원 false는 별도 검증한다. 정렬·상태·이름·위치·비용·페이지 및 잘못된 입력 검사를 유지한다. DB 계약은 현재 숫자 범위와 anonymous claim 경계를 명시하고 행사명·HTTP·AI 연결 미완료를 구분한다. 실제 격리DB 실행 후 결과를 기록한다.

## 실제 검증 결과

2026-10-02 `yumidang-minkyu-search-range` DB 전용 격리 프로젝트에서 새 숫자 검색 migration과 갱신된 기존 공개 검색 검사를 한 트랜잭션에 합쳐 실행했다. SQL 종료코드0, `PASS public_search_v2_unregistered_session`, `PASS public_search_v2_regression`을 확인했다. 기존 HEAD 검사46개 assert의 원문이 모두 보존돼 있고 현재49개가 실제 실행됐다. 신청 가능 true 기대를 false로 바꾸지 않았다.

미등록 회원은 모든 카드 canApply=false를 검사한 뒤, 같은 조회 회원에 합성 네이버 적격 가입·소유 JPEG metadata·Auth/네이버 등록 세션을 갖춰 기존 true 검사를 실행한다. 합성 metadata 검증은 실제 JPEG 업로드 성공을 대신하지 않는다. 실제 사용자 사진·가입 완료는 이전 별도 로컬 OAuth 검증에서 확인한 결과다.

롤백 후 기존 함수 해시 `fa13bc97316c9937e1f853b742736d25`, Auth0/공고0/이력35/새 helper 부재를 확인했다. 갱신된 기존 검사 SHA256은 `7eeaa84002d180619f6c5cb68075f2dfe8adf9c84207069fa1ee6232c33078d6`, DB 계약은 `0fa14cfce2c8554c1dddafeb72ead8455324707b7ca8457f432838e9a6a47d54`다.

새 숫자 검색9그룹과 갱신된 기존 공개 검색 회귀는 각각 통과했다. 종현 기존 HTTP3/SQL2의 별도 기대 불일치와 HTTP·AI 공유 타입·연결 행사명 검색은 남아 있다. 전체 진행률은43%·6/14다.

검증 종료 후 프로젝트 라벨을 확인한 합성 검색 DB 컨테이너만 중지하고 볼륨을 보존했다. 실제 네이버 로그인 서버와 가입 프로젝트를 중지하거나 재설정하지 않았다.

## 다음 독립 작업

정책의 비로그인 공고 상세 허용과 달리 현재 service-api handler는 일반 상세도 회원 인증으로 보낸다. 기존 get_service_post SQL의 공개 별칭·비공개 제외 투영을 좁은 익명 DB 클라이언트로 연결하는 작업을 다음 단위로 진행한다. 검증된 회원·확정 당사자·취소 당사자 권한을 보존한다. 그다음 로컬 Edge gateway CORS와 상주 완료 실행기의 복구 검증을 진행하며 실운영 설정을 임의 확정하지 않는다.
