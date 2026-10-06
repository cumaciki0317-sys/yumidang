# 신고 자료와 본인 선택 숨김 분리

작업자 민규(`minkyu`). 최신 종현26aca72의 사용자 확정: 신고 자료는 최종 종결+90일 삭제, 본인 화면 숨김은 본인 해제까지 최소 식별 기록만 유지한다. 차단·제재·전체 공개 제한과 별개다.

## 구현

- 후속 `20261006123430_member_report_hidden_targets.sql`: identity/target종류/targetUUID와 paginationUUID만 저장한다. 신고 ID·이유·원문·증거·시각·직원 정보가 없다. 동일 네이버 identity의 회차 변경에도 유지하며 identity 자체 삭제 때 cascade한다. 회원의 현재 검증된 JWT/session으로 본인 목록/해제만 허용한다. 테이블 및 helper 직접 접근은 닫혀 있다.
- 후속 `20261006123447_member_report_hidden_targets_bridge.sql`: 기존 true선택 최소키를 멱등 이관하고 신규 접수 INSERT trigger와 연결한다. 기존 보고서·요청 fingerprint는 변경하지 않는다. 원 파기 eligible 및 예약 조회의 `not r.hide_target` 제외 조건만 제거하며 함수 OID/owner/ACL/config는 보존한다. guard/서비스 EXEC는 열지 않는다.
- 기존 민규 repository/service/user-client/routes에 `GET /me/hidden-targets?limit=...&before=...`, `POST /me/hidden-targets/unhide`의 `{targetType,targetId}`를 연결했다. 목록 exact `{items:[{targetType,targetId}],nextCursor}`, 해제 exact `{targetType,targetId,hidden:false}`다. 해제는 본인 최소 기록만 삭제하고 부재도 같은 응답이다.

## 실제 검증과 준비

실제 기존 native84 DB에서 두 SQL·두 합성 네이버 회원의 조회/해제/타인 분리/직접권한/자료삭제 뒤 최소키 유지/기존 최소키 이관·새 중복INSERT를 단일 TX 실행 후 전부 rollback했다. 후속 기한 경계 검사에서 hide=true인 종결+91일 신고가 원 SQL에서는 대상false, 이관 후 대상true임을 확인했다. 영수증 `/private/tmp/yumidang-hidden86-probe-v4/receipt.json` PASS·fullNative84Restored=true·formalApplied=false·operating=false다. v3도 최소키/권한 회귀 PASS다. v1/v2의 잘못된 합성 대상/actor 실패와 전체 원복은 보존한다. v2 드라이버 작성 전 workdir 누락 실행은 실제 DB 실행 없는 인프라 오류다.

새 HTTP4개+기존 신고15개 총19/19 PASS, 준비 strict경계4개 PASS·실제86묶음 READY, Deno gateway 타입 PASS다. Git 추적65+미커밋21이며 실제 DB이력84/pending0과 구분한다. 준비 묶음 `/private/tmp/yumidang-policy86-hidden-targets-prepared`의 SQL/Edge 실행은 NOT_RUN이다. CLI 초기 telemetry 권한 오류는 DO_NOT_TRACK=1로 해소했고 승인검사 우회/권한정책 변경은 없었다. 동일초 생성된 빈 bridge 이름은 담당검사 후 제거해 CLI가 별도 버전을 생성했다.

## 종현 연결과 남은 조건

종현 모바일은 목록을 서버에서 재조회해 본인 화면 숨김/해제에 연결한다. 신고 submit의 hideTarget은 원 요청 선택 fact이며 현재 숨김의 권위값으로 사용하지 않는다. 동일 clientRequest 재전송은 새 INSERT가 아니어서 해제 후 서버 최소키를 다시 만들지 않는다. 새 별도 신고에서 true선택하면 다시 숨김을 생성한다. 최소키만으로 게시물/채팅 원문·당사자 관리 권한을 늘리지 않는다. 화면 관리 동작과 서버 파기는 분리한다.

종현 소유 파일은 편집하지 않았고 소비자 연결 전 숨김 선택 제공의 보류는 유지한다. 정식 로컬86 적용·실제 REST JWT/모바일 연결·상주 파기·운영 적용은 아직 NOT_RUN이다. 일반 제재 이의7일 성공 안내 anchor와 마감/접수 API는 이번 변경에 포함하지 않았으며 다음 연결이다.
