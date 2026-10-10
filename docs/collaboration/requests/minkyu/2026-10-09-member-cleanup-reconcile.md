# SQL115 회원 정리 ACK 복구 제품 bridge

작업자 `minkyu`, eventlane worktree의 독점 수정은 `db/repositories/member-cleanup.ts`, `auth/member-cleanup.ts`, 새 M 테스트, 추가 승인된 기존 `tests/functions/minkyu/member_cleanup.test.ts`와 이 문서다. SQL115 `20261009011500_member_cleanup_reconcile.sql` SHA256 `74a0d3b2af807310f76dd77d8769f3177ca8f47cef2161ca4b44f194bbb73081`은 읽기만 했다. 기존 SQL108/110과 runtime/handler는 수정하지 않았다. 이번 조립은 기본 미설치이며 운영 승인·guard·ACL·기존 점유를 열지 않는다.

## 구현과 완료 경계

`createMemberCleanupReconcilePorts`는 원 UNKNOWN invocation ID, task ID, 새 recovery request ID와 recovery global token의 정확한 4항목을 생성 즉시 복사·동결한다. transport 허용 목록은 SQL115 begin/get/finish 및 기존 check/get-ACK의 5개다. 일반 claim, SQL110 complete, dispatch, ACK 쓰기는 포함하지 않는다. 동일 포트 인스턴스는 begin/finish 각각 한 번만 전송하고, 응답 유실이나 재호출 때 mutation을 재전송하지 않는다. 조회로 받은 원 withdrawal/object/dispatch/global/job lease/ACK와 recovery global/lease/만료는 이후 조회에서도 바뀌면 거절한다.

`processMemberCleanupReconciliation`은 fresh begin의 정확한 task DTO와 SQL115 GET의 scope/lease/object/만료를 대조한 뒤에만 기존 processor에 task를 한 번 넘긴다. 기존 ACK의 receipt/hash/task/kind/object를 대조하고, 기존 adapter로 Auth GET 404 또는 Storage 두 GET의 정확한 부재를 확인한다. DELETE·dispatch·ACK 포트는 차단한다. SQL115 finish 응답은 완료 근거로 쓰지 않고 같은 recovery 키의 저장 GET에서 completed와 동일 evidence를 확인한다. evidence는 새 recovery fence, 기존 ACK receipt/hash, 대상 종류 및 부재 확인을 묶은 기존 version 2 해시다.

기존 키의 fresh false 또는 begin 응답 유실은 task DTO를 복원하지 않고 최소 GET으로 `pending`, `superseded`, 또는 저장된 evidence를 포함한 `applied`만 반환한다. task re-claim·lease 연장·외부 GET·finish는 시작하지 않는다. 완료된 과거 recovery의 GET은 현재 실행을 새로 허용하지 않는다. finish 응답 유실 후 저장 완료가 없으면 실패하고, 같은 키 재호출은 pending 조회로만 남긴다.

복구 task 완료와 원 invocation 완료는 별개다. SQL115 finish 뒤에도 원 invocation은 UNKNOWN이다. 모든 원 claim의 terminal DB 증거가 충족된 뒤 별도 trusted orchestration이 `complete_queue_invocation(원 request ID)`의 SQL115 검증을 통과하고 저장 GET으로 확인해야 전역 pending이 해소된다. 이 bridge 자체는 원 부모 종결 orchestration을 설치하지 않는다. root는 이후 `service-api/member-cleanup-reconcile-http.ts`와 factory의 선택 승인 옵션으로 task 복구 HTTP를 연결했고 기본404를 유지했다. 현재 global 예산을 요구하는 task 복구와 저장 증거만 확인하는 원 부모 종결은 별도 책임이다. SQL108 legacy ACK recovery 포트는 유지하지만 SQL110 tracked UNKNOWN의 제품 완료 경로로 사용하지 않는다.

## 검증

최종 Node 회귀는 새 bridge 39개와 기존 관련 M 회귀를 합쳐 **101/101 PASS**, skip 0이다. 두 제품과 두 인계 테스트의 Deno check도 PASS다. ownership·diff·언어 검사와 기존 processor 본문 불변 확인을 수행했다. 실제 DB/HTTP/Auth/Storage 통합은 이번 단위에서 실행하지 않았다.

새 M 회귀는 실제 RPC transport, SQL115 제품 bridge와 기존 Auth/Storage adapter에 모형 DB/외부 응답을 주입한다. 실제 SQL/ACL/Auth/Storage 검증과 구분한다. fresh Storage/Auth, immutable scope, 기존 키/응답 유실의 GET-only, false 완료 응답, 변경된 저장 증거, ACK 누락/불일치, fresh DTO 불일치, 부재 아닌 응답, guard 닫힘, 취소·기한 및 transport가 AbortSignal을 무시하는 경우를 검사한다. 모든 DELETE·dispatch·ACK 및 legacy claim/complete 호출은 fixture에서 거절한다.

최신 foundation M 회귀는 읽기 복사했다. 처음 9개 실패 중 5포트 기대 1건은 최신 RPC fixture로 해소했다. foundation 최신 `member_cleanup.test.ts`에서도 beginDelete 누락으로 기존 8FAIL을 직접 재현했고, 변경 전 fixture SHA256은 `87ce3474cbcd8ebe1087e08cbaa6e3bd502e77dddd131b41e5ab4e70d9e0909f`다. 추가 허용된 이 파일에는 원 fence의 최초 BEGIN 허가와 순서를 동기화하고, BEGIN 거절·응답 유실·alreadyDispatched=true 시 DELETE/ACK/완료 0 및 기존 ACK 복구 시 새 dispatch 0 검사를 보강했다. 기존 processor/adapter/batch 본문은 foundation과 바이트 동일하게 유지했다. 그 외 5개 최신 M fixture는 수정 없이 복사한 검증 의존이며 인계 대상이 아니다. 두 J 회귀 파일은 이전 SHA로 동결했다.

## 실제 연결 검증 제안

1. root가 source112의 읽기 dump로 새 clone을 만들고 SQL114/115 적용 상태와 전체 행·catalog·역할 hash를 전후 대조한다. 원 source와 이전 UNKNOWN 환경은 보존한다. 로컬 private 자격증명과 cached Auth/Storage만 사용하며 운영·네이버·실회원·외부 공급사·pull은 수행하지 않는다.
2. 새로운 합성 회원/사진만 생성한다. SQL110 actual prepared invocation/CAS/claim을 사용하는 정상 제품 포트로 최초 DELETE와 원 ACK를 만들고, 완료 전 실패를 주입해 원 invocation UNKNOWN을 남긴다. 원 dispatch/ACK가 이미 있는 이전 실패 fixture에는 DELETE/ACK를 재전송하지 않는다. 최초 삭제 성공과 이번 GET-only 복구 증거를 분리한다.
3. 원 task/job lease를 만료시킨 뒤 별도의 현재 recovery global token을 획득한다. trusted driver가 새 recovery 키로 이번 제품 bridge를 호출한다. Storage 두 authenticated GET 및 Auth admin GET의 실제 부재, begin fresh task, finish 저장 완료를 관측한다. bridge 구간 DELETE/dispatch/ACK/legacy claim/SQL110 complete 0, 원 ACK·dispatch·invocation global/deadline·원 audit의 jobLeaseToken과 effect(null) 불변, recovery slot의 실제 parent job ID 1개를 확인한다.
4. 별도 합성 fixture로 begin 또는 finish HTTP 응답을 한 번 유실한다. begin loss의 같은 키는 GET-only pending이며 실행 재개가 아니다. finish loss는 저장 완료·동일 evidence로만 성공하고 두 번째 finish는 0이다. ACK 없음/원 target 변경/현재 객체 또는 Auth row 재등장/권한 오류/회복 lease 만료는 거절한다. 삭제나 ACK 응답의 UNKNOWN은 자동 재전송하지 않는다.
5. 모든 원 task 완료 뒤 original request ID의 SQL115 outer completion/GET을 검증한다. 원 invocation counts·global token 불변, task terminal proof와 recovery 출처, pending 해소를 확인한다. 끝난 clone의 guard를 다시 닫고 컨테이너를 중지하되 백업·로그·UNKNOWN·볼륨은 보존한다.

실제 검증용 fixture에서만 필요한 5개 reconcile/read RPC와 기존 최초 실행에 필요한 SQL110 RPC에 명시 권한을 준다. 테이블 직접 접근이나 운영 service_role 권한 확대가 제품 설치 조건이 되어서는 안 된다. 실제 HTTP driver의 권한·DB proof·외부 부재가 확인되기 전에는 운영 완료로 표시하지 않는다.


## root 통합 이후 상태

root 관련90/90 skip0 및 HTTP/factory·탈퇴·콘텐츠/배정36/36 skip0·Deno PASS다. 실제 SQL115 원자/출처 검증과 모형 HTTP를 구분한다. 실제 factory HTTP의 Storage/Auth GET·finish·원 부모 complete 검증은 새 private graph를 동결해 순차 진행 중이다. 최초 원 dispatch/ACK를 SQL 합성 fixture로 준비한 레시피는 실제 original DELETE/ACK 증거가 아니며, 후속 전체 물리 경로가 필요하다. 최신 제품3HTTP SHA와 전체62파일 graph는 [실행 기록](2026-10-09-backend-execution.md)을 따른다.

원 부모 종결은 root의 별도 finalize executor와 두 정확한 HTTP prefix에 구현했다. SQL115가 모든 원 claim의 terminal 상태·원 dispatch/ACK/global/lease·독립 completed recovery 출처를 확인하므로, 새 DELETE/ACK나 recovery global 재획득 없이 원 부모만 완료할 수 있다. completed 저장 상태는 그대로 반환하고 UNKNOWN에 대한 complete는 한 번 호출한 뒤 저장 GET으로만 확인한다. HTTP 응답 유실 또는 lease 만료는 재삭제 허가가 아니다. 신규 종결·복구와 관련 회귀52개 skip0 및 Deno PASS이며 실제 factory/DB의 만료된 recovery global 이후 종결·complete 응답 유실·미정산 pending은 진행 중이다. completed task가 남긴 UNKNOWN 부모의 자동 discovery는 아직 미구현이다.


## 2026-10-09 실제 복구 네 경계

storage-v4·finish_loss-v1·begin_loss-v1·no_ack-v1의 실제 factory/DB 검증은 PASS다. 원 ACK 합성 fixture와 실제 부재 GET/저장 완료/원 부모 종결을 구분한다. 원 source186 전체 행·catalog·역할 및 기존10개 queue 테이블의 원 작업·lease·ACK·UNKNOWN 불변과 own clone 폐쇄/STOP을 확인했다. Auth와 종결 응답 유실은 새 revision으로 검증 중이며 이전 준비 실패는 보존했다. 영수증·SHA·기동 진단·117개 준비 증거는 [실행 기록4.17](2026-10-09-backend-execution.md)을 따른다.

SQL118 읽기 발견 RPC는 task 완료 뒤 남은 UNKNOWN 부모도 반환하도록 작성했고 guard/EXEC는 기본 닫힘이다. ID cursor로 빈 페이지까지 읽으며 최소 ID만 반환한다. 실제 SQL rollback 검증·승인된 HTTP/runner 자동 연결은 아직 남는다. discovery를 새 task claim·DELETE·ACK·전역 실행 허가로 사용하지 않는다.


## 여섯 경계 완료와 자동 발견의 현재 범위

Auth-v3·finalize_loss-v3가 추가 통과하여115 실제 여섯 경계는 PASS다. source186/기존10개 queue 작업 불변·own32 컨테이너 STOP과 이전 실패7건 보존을 확인했다. SQL118 실제 DB rollback/최소 cursor 조회/기본 닫힘도 PASS다. 원 최초 prepared/물리 DELETE·ACK는 여전히 별도 실제 검증이 필요하다. 정확한 영수증/graph/원인 및 범위는 [실행 기록4.18](2026-10-09-backend-execution.md)을 따른다.

승인된 queue runtime은 common pending OR 전에 SQL118로 UNKNOWN 회원 부모를 발견하고 원 저장 GET→complete 최대1→원 GET을 수행한다. page20·2페이지·RPC20의 기술 상한, 미처리 ID 재개 cursor, queryTimeout/stop 신호·자체 기한을 사용한다. 일반 job/global/task/DELETE/ACK 능력을 만들지 않는다. 기본 호출0·미정산/legacy pending 차단·자기 UNKNOWN park를 유지하며 재시작/정상 worker wake에서 작동한다. 신규14개와 root 관련19개 모형·Deno는 PASS지만 실제 자동 orchestration은 아직 NOT_RUN이다.
