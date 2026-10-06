# 완료 전 신고 검토 보류 연결

작업자 minkyu. 정책6-2/7-1의 실제 목표를 유지한다. 일반 신고 접수는 사실 인정이 아니며 신고자 숨김·운영 공개 제한과 동행 완료/후기 검토 보류를 구분한다. 현재 source65에서 일반 신고 저장은 완료 예약/수동 완료/새 후기 공개와 연결되지 않는다. 기존 appointment_disputes는 완료 후 분쟁만 지원하며 상태 CHECK도 disputed/no_show에 이미 완료된 필드를 요구한다. 이를 완료 전에 재사용하면서 가짜 completed_at을 입력하지 않는다.

## 구현 범위

별도WT에서 신규40900과 minkyu SQL 회귀 후보를 작성한다. owner-only helper가 reviewing/more_evidence 신고를 특정 약속의 동행 검토에 명시 연결한다. 신고 status나 최종종결 시각을 자동 변경하지 않고90일 보관 기한을 임의 시작하지 않는다. 일반 received 신고를 전부 분쟁으로 바꾸거나 운영 role/API 접근을 열지 않는다.

완료 전에는 confirmed/완료 필드NULL를 유지하는 구조화된 보류 metadata를 사용한다. 완료 쓰기·예약 생성/실행·후기 작성/새 공개·자동 결과원장에 공통 보류 조건을 연결한다. 기존 공개 후기 및 운영 숨김 override는 접수/검토만으로 변경하지 않는다.

정상 인정 시 두 사람이 합의한 최신 예상 종료+24시간 전이면 그 예약을 유지하고, 지났다면 실제 처리 시각으로 최초 완료해 그때부터 후기7일을 시작한다. 이미 완료했다면 완료시각을 보존하고 남은 후기기간을 재개하되 최소24시간을 보장한다. 다중 검토 중 하나만 끝나거나 기존 열린 분쟁/노쇼가 남으면 완료/기간 재개하지 않는다. 노쇼 보류는 귀책·운영 감점·제재 인정과 별개다.

기존 SQL 바이트/OID/owner/ACL·공개 RPC 계약을 보존하고 새 migration에서 알려진 anchor로만 연결한다. 원문 설명·신고자 정보·DB 채팅 접근 권한은 추가하지 않는다. 신고 보관/약속 물리 삭제와 새 metadata의 FK·종결 처리가 충돌하지 않는지도 검증한다.

## 완료 기준과 현재 상태

최신 합의 종료+24시간 전/후 정상 인정, 장기 검토 후 실제완료+7일, 기존 완료 최소24시간 재개, 다중 검토, 이미 공개 후기 유지, 보류중 stale 예약·양쪽 확인·새 후기 공개 차단, 안전 결과원장 pending/완료, 멱등 및 실패 전체rollback을 실제 SQL로 검증한다. 검토진입↔완료의 실제두세션 및 실제 운영담당/회원표시/API 연결은 별도 후속이며 생략된 완료 기준으로100%를 주장하지 않는다.

현재 구현의 실제 단일TX SQL 회귀는 PASS다. native66 격리 영속 적용과 반영 후 SQL 회귀는 PASS다. 실제 두 세션 경합3건도 PASS이며 HTTP/운영은 별도 후속이다. 상시 표시는 민규13영역60%다. source65의 실제 회원API14그룹 및 자동약속결과원장 검증은 [별도 증거](2026-10-05-appointment-safety-result-sync.md)를 따른다. Railway CLI/저장소 연결파일/현재 도구의 Railway 직접 기능을 읽기 확인했으나 찾지 못했으며 기존 프로젝트/서비스 링크·담당 확인 대기를 유지한다. 서비스 새로 생성·비밀값 읽기·운영배포는 하지 않았다.


## 사용자 확정과 실제 검증 진행

검토 중 쌍방이 새 종료 시각을 합의한 뒤 정상 인정하면 새 합의 종료+24시간을 적용한다. 이전 후보의 종료 변경40001 폐쇄는 이 확정에 따라 제거하고 새 기한 전 예약/기한 경과 실제 완료를 검증한다.

첫 실제 단일TX는 합성 test의 문자열 +연산 오류, 두 번째는 fixture의 PL/pgSQL변수와SQL별칭 충돌로 FAIL이었다. 두 실행 모두 전체 baseline이 원복됐고 운영/보호된 네이버 환경/Provider 변경은0이다. 이 실패를 기능 성공으로 기록하지 않는다. 사용자 확정 반영 후 고정한 후보 바이트로 다음 검증을 수행한다.

상시 진행률은 사용자 요청에 따라 전체57% 대신 민규13영역60%를 사용한다. 수치 변경은 분모 변경이며 이 후보의 기능 완료를 뜻하지 않는다.


## 실제 SQL 회귀 통과

v4에서 최신 합의 기한의 검토 보류·완료·후기 연결 회귀가 PASS했다. source65 함수/OID/owner/ACL·이력·빈 자료·닫힌 guard·전역 idle·컨테이너·Storage 파일 상태가 전부 원복됐다. 첫 두 fixture 문법 오류에 더해 v3의 회원 역할에서 owner-only predicate를 직접 호출하던42501 오류도 test만 교정했고 권한을 확대하지 않았다. 세 FAIL의 baselineRestored=true를 보존한다.

실제 실행한 SQL SHA는 d936cb3854a5cb9f6ffc8e463744bdfdeaeb2350b6529b41173878021c95b292, test는295487a44cc250b4af9d02f89216cd927b1fd24a367409c7a7fbf41f10a80548이다. main 반영 시 첫2줄의 검증 상태 주석만 최신화했으며 나머지 실행본문이 동일함을 비교했다. 현재 SQL b13e5ade5891e49b049a7243ba3cbe161d8e64545212bc72d8865638a6992fe6/test face8edd11c76d86a8ea3887e645fc55e287b226a80218588b9a105b29132dcf다. 정식66 준비 도구에는 최종 SHA를 사용한다.

검토 보류중 회원 공개 완료/후기 RPC 거절, stale 예약 차단·삭제, 최초 완료 실제 시각+7일, 기존 완료 최소24시간 재개, 다중/legacy 보류, 이미 공개된 정책후기/운영override 유지, 새 합의의 미래 due/지난 due, report 조기종결 거절·노쇼 report파기 보류유지·실패 전체rollback을 검증했다. 실제 두 세션/HTTP/운영자 권한·최종노쇼 lifecycle 및 탈퇴/보관 종결은 미완료다.


## 격리 native66 정식 적용과 반영 후 회귀

최종 SQL b13e5ade5891e49b049a7243ba3cbe161d8e64545212bc72d8865638a6992fe6를 strict66 준비 manifest에 등록했다. 준비 도구33개 회귀 PASS. 준비본66개 SQL/49개 서버 파일의 해시를 확인했고 CLI dry-run40900만 확인 후 한 번 적용했다. `/private/tmp/yumidang-native66-rollout/application-receipt.json` PASS: 이력66·대기0, 기존 함수 OID/owner/ACL 유지, 예상9개 본문만 변경·신규5개 helper 닫힘, 신규11개 제약과 report guard trigger, 자료0·guard false·worker idle·기존 보호 컨테이너 불변.

적용 후 최종 test face8edd11c76d86a8ea3887e645fc55e287b226a80218588b9a105b29132dcf를 다시 실행했다. `/private/tmp/yumidang-review-holds66-regression/receipt.json` PASS, 모든 fixture 롤백·catalog/권한/자료 복원. 사용자 결정대로 새로 합의한 종료+24시간을 사용한다. 실제 운영 담당 권한/HTTP·운영 배포·최종 불발 lifecycle은 아직 완료 증거가 아니다.


## 실제 두 세션 경합3건

`appointment_review_hold_concurrency_local.py` SHA e66499ef8f91c068a5bb254eca4d4f677daac11d6506b9466873cbbb1786e10c를 native66에서 실행했다. owner의 검토 진입 COMMIT 뒤 대기 중 두 번째 회원 완료는22023으로 거절, owner ROLLBACK 뒤에는 양쪽 수동 완료·최초 완료부터7일·재시도 멱등, 이미 지난 예약 generation의 대기 실행은 stale로 종료했다. 세 경우 모두 실제 pg_blocking_pids·owner transaction·참여자 lock wait를 확인했다. `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-review-hold-race66-kc_pwdg5/result.json` PASS. fixture 전 복구 목록 저장, 종료 후 정확한 fixture 삭제·전체 관계 row counts/함수 OID owner ACL 본문/역할/이력/보호 컨테이너/Storage 파일0/세션0 복원을 확인했다. 외부 Provider·실제 운영 담당 인증·HTTP 검증은 수행하지 않았다.
