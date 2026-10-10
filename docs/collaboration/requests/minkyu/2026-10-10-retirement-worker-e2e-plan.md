# 공개 탈퇴 요청부터 워커 복구·자동 부모 종결까지의 실제 연결 검증안

2026-10-10. 작업자 `minkyu`. 이 문서는 읽기 설계 결과다. 신규 실행·제품·SQL·기존 하네스 수정은 없다. 기존 actual 5종 결과를 공개 탈퇴 전체 경로의 완료로 확대하지 않는다.

## 현재 빠진 연결과 기존 증거

검토 기준은 foundation의 `tests/integration/minkyu/worker_safety_http_local.py`와 `worker_safety_http.ts`다. TS 파일명에는 `_local`이 없다. Python 333~346행은 합성 Auth 사용자와 실제 Storage bytes를 만든 뒤 `member_retirements`·episode 종료·두 `member_cleanup_tasks`를 직접 생성한다. TS 329행의 `publicMemberRetirementPipeline: NOT_RUN_MANUALLY_SEEDED_CLEANUP`은 정확한 제한이다.

기존 하네스는 최초 실제 Storage/Auth DELETE와 ACK, task 완료 RPC 전송 차단, 자연 lease 만료, SQL115의 원 ACK·외부 부재 GET 확인, 실제 큐 두 프로세스의 SQL118 자동 discovery와 저장된 원 부모 완료 조회를 이미 별도 검증하는 구조다(TS 118~127, 225~274행). 최초 공개 요청만 실제 factory로 연결하면 이를 재사용할 수 있다. 별도 중복 하네스나 새 정책·SQL은 필요하지 않다.

## 최소 변경 경계와 실행 순서

후속 단독 배정 대상은 기존 M 두 파일뿐이다. 현재 queue 실행의 파일 SHA가 동결되고 실행이 끝난 뒤 최신 foundation 바이트를 durable worktree로 받아 새 revision에서 작업한다. 이전 scenario·receipt·실패 바이트는 보존한다. 문서 작성 시 두 테스트 경로의 소유권 검사는 통과했지만 구현·실행 승인을 뜻하지 않는다. 제품·J·SUI·공통 helper 수정은 하지 않는다.

새 scenario는 `five-kind-retire-storage`와 `five-kind-retire-auth`다. 기존 다섯 종류 fixture·실제 Node CLI·Storage/Auth 서비스·TLS·SQL observer를 공유하되 각각 새 ROOT/NAME과 private artifact를 사용한다. 기존 storage/auth reconcile scenario를 변경하지 않고 두 새 이름만 FIVE_MODE 및 RECOVERY_MODE에 포함한다. 중단 대상 kind와 기대 ACK 수는 이름 문자열에 흩어 놓지 않고 명시적인 scenario 설정에서 정한다.

기존 기준 source는 하네스에 지정된 읽기 전용 SQL109 clone이다. 기존 SQL110→111→112→114→115 뒤 SQL117, SQL118을 새 clone에만 적용한다. SQL116은 이 경로에 의존하지 않는다. source를 SQL112로 교체한다면 이미 적용된 migration을 다시 적용하지 않는 별도 recipe가 필요하므로 이번 최소안에서는 원 source를 유지한다. 모든 적용 파일과 전체 상대 import graph SHA, source 전체 rows/catalog/roles/ACL 및 원 Storage bytes의 전후 증거를 남긴다. source 변경이나 기존 환경 재시작은 없다.

## 합성 회원 fixture와 최초 공개 POST

1. 기존 `member_retirement_auth_local.py` 268~286행처럼 clone 소유자 문맥에서 `resolve_naver_account`로 합성 계정 연결을 예약한다. 새 로컬 GoTrue의 admin 생성과 password 로그인으로 실제 signed Auth session을 받는다. 실제 네이버·외부 메일·실회원 로그인은 없다. JWT decode는 fixture session ID 식별용이며 인증 성공 증거는 실제 `/auth/v1/user`와 PostgREST 서명 검증이다.
2. `record_naver_session`으로 같은 합성 subject/user/session을 연결하고 active profile/episode를 준비한다. 기존 한 장의 실제 `profile-images` bytes와 소유 object를 준비한다. 다른 사용자 canary는 유지한다. retirement/task/ACK/dispatch/job을 직접 성공 상태로 생성하지 않는다. confirmed appointment는 없는 최소 fixture로 둔다.
3. `createRuntimeHandler(read, {memberCleanup:true, memberRetirement:true, memberCleanupExecution:기존배정})`의 실제 공개 `/functions/v1/service-api/me/retirement`를 설치한다. 승인 옵션이 없는 default factory는 404·탈퇴 RPC0임을 별도로 확인한다.
4. 최초 공개 POST는 원 signed 회원 JWT와 exact `{withdrawalId}`만 보내며 global/worker header는 없다. 호출 전 `/auth/v1/user` 200과 동일 UID를 확인한다. 실제 `retire_my_account` 호출은 정확히 한 번이다. 반환은 exact 세 필드 `{withdrawalId, status:'processing', memberAccessRevoked:true}`이며 외부 DELETE/ACK는 아직 0이다.
5. first response가 정상 생성된 뒤 하네스의 사용자 응답 전달만 유실시킨다. 동일 ID·원 JWT로 수동 공개 POST를 한 번 더 보내 실제 `/user`의 401/403 뒤 SQL117 GET 영수증을 조회한다. 새로운 retirement RPC·key·Auth refresh·익명 대체·일반 회원 권한 재설치는 0이다. SQL117과 runtime은 원 세션 거절만 이 경로에 허용하며 Auth 장애를 성공 영수증으로 바꾸지 않는다.
6. observer는 withdrawal/profile/episode 연결, episode의 실제 종료 시각과 retired_at 일치, 일반 개인정보 제거, naver user 연결 제거, Auth sessions 제거, Auth user 잔존, 실제 Storage object 잔존을 확인한다. 이 POST가 같은 withdrawal의 정확한 두 pending task를 생성해야 한다. 직접 task INSERT는 없다. 원 fingerprint는 SQL117 generated 값과 비교한다. 동일 ID 조회 전후 task/retirement 수·원 rows·catalog/roles/ACL이 불변인지 검사한다.

## transport와 SQL117의 필수 보완

현재 productFetch의 허용 경로(TS 169~178행)는 `/auth/v1/user`를 허용하지 않고 HTTP gateway(TS 87~113행)는 Auth admin만 전달하며 모든 RPC body를 JSON으로 읽는다. 공개 탈퇴를 설치하기만 하면 실제 Auth 또는 SQL117 GET에서 실패한다. 신규 scenario에서만 다음 경계를 추가한다.

- `/auth/v1/user` GET을 자기 GoTrue로 전달한다. Auth admin DELETE는 기존 fixture.cleanupMember 한 명만 허용한다. password 로그인은 Python fixture 단계이며 공개 runtime 요청으로 바꾸지 않는다.
- `get_my_retirement_receipt`는 기존 client의 GET/query 방식 그대로 전달한다. exact 두 query key와 body 없음·원 JWT를 메모리에서 검증하며, 기존 POST RPC와 분리해 빈 body JSON 파싱을 피한다. JWT·UID·path·원문 응답을 일반 이벤트나 로그에 넣지 않는다.
- SQL117 gate의 expected_issuer는 준비된 GoTrue의 신뢰된 `API_EXTERNAL_URL`과 exact 일치해야 한다. 현재 안전 하네스 값은 `http://127.0.0.1/auth/v1`이며 런타임 HTTPS gateway origin과 다르다. gateway origin을 issuer로 임의 가정하거나 JWT를 새로 서명하지 않는다. audience는 기존 authenticated 계약이다. issuer 변경이 필요하면 신규 recipe의 Auth 기동 전 한 번 설정하고 실제 signed JWT/서명 검증과 대조한다.
- 신규 clone fixture에서만 receipt gate를 연다. 기존 `retire_my_account`와 `get_my_retirement_receipt`의 authenticated EXEC를 보존하며 service_role/queue에 승격하지 않는다. SQL117 getter의 기본 authenticated EXEC와 기본 disabled gate를 구분한다. 닫을 때 gate와 역할 ACL을 준비 기준으로 복원한다. worker RPC 목록에 getter를 넣어 service_role EXEC를 부여하지 않는다.

## 실제 DELETE·UNKNOWN·GET-only·자동 discovery 증거

공개 POST와 동일 ID 영수증 재조회가 끝난 후에만 기존 두 실제 Node 큐를 기동한다. 다섯 kind, 고유 job slot 전역 상한20, 같은 global 180초, 회원 batch 최대10/120초 및 task 최대60초를 그대로 검사한다. 작업 수는 공개 POST가 생성한 실제 task와 observer에서 계산하며 기존 9라는 가정으로 임의 보정하지 않는다.

Storage scenario는 첫 Storage DELETE와 원 ACK 저장 뒤 task complete의 네트워크 전달만 차단한다. Auth scenario는 Storage의 정상 종료를 먼저 증명하고 Auth DELETE와 원 ACK 뒤 Auth task complete 전달만 차단한다. 최초 삭제 응답 자체를 잃은 NoACK case와 구별하며, 이번 두 scenario는 ACK가 실제 저장된 UNKNOWN만 복구한다. Auth 처리 순서는 기존 DB 의존 조건으로 확인하며 하네스가 임의 우선권을 만들지 않는다.

원 UNKNOWN의 invocation/task/job/object/withdrawal/global/lease/dispatch/ACK 결합을 private 증거로 저장한다. 재시작 큐가 UNKNOWN을 새 claim·dispatch·DELETE·ACK로 바꾸지 않는지 확인하고, 실제 서버 시각으로 원 lease 만료를 기다린다. token 만료 자체를 완료 증거로 사용하거나 lease를 연장하지 않는다.

기존 SQL115 factory reconcile을 원 task/parent와 새 recovery global에 결합한다. Storage info와 bytes GET 404 또는 Auth admin GET 404, 원 ACK stored GET, 독립 recovery provenance와 실제 terminal DB 상태만 성공 근거다. 원 invocation/global/lease/dispatch/ACK hash·scopeHash·claimCalls는 불변이다. 새 lease의 effect를 원 lease에 복사하지 않는다. 복구 구간의 추가 DELETE·begin-delete·ACK 기록·claim-task는 0이다.

그 뒤 recovery global을 정상 닫고 실제 CLI 두 프로세스를 재기동한다. 기존 승인된 SQL118 discovery→원 ID get→complete→동일 ID stored completed get을 관찰한다. 수동 known-ID finalizer나 직접 SQL complete로 부모를 닫지 않는다. 자동 종결 구간에서는 기존 모형처럼 새 acquire의 wire 전달을 실패시켜 새 global 생성/claim/dispatch/DELETE/ACK0과 원 ACK 불변을 분리해 증명한다. 이는 원 task 복구를 자동화했다는 증거가 아니라, GET-only task 복구 이후 원 UNKNOWN 부모의 자동 발견·종결 증거다.

Storage scenario에서 남아 있는 Auth task는 부모 종결 후 별도 정상 cycle로 끝낸다. 최종 두 task/원 job 모두 terminal·retirement completed·Auth user와 Storage bytes 부재·canary 불변을 확인한다. 원 JWT/같은 withdrawal의 공개 POST가 exact completed 영수증을 반환하고 추가 mutation/DELETE/ACK0인지 조회 전후 DB와 wire 증거로 확인한다. processing을 최종 성공으로 표시하지 않는다.

## 의미 있는 거절·정리·최종 완료 기준

원 ID와 다른 ID·추가 body 필드·익명·다른 사용자·만료/서명 변조 JWT를 신규 mutation0으로 거절한다. 실제 회원 JWT fixture와 별개인 서명된 negative control은 합성 검사로만 기록한다. Auth 장애는 503이며 receipt GET0이어야 한다. ACK 없는 UNKNOWN은 계속 닫히며 SQL115 finish/원 부모 완료/새 claim이 허용되지 않는 대조를 기존 NoACK 증거와 연결하거나 이번 신규 recipe의 독립 대조군으로 확인한다. 원 ACK를 위조하지 않는다.

각 phase의 고정 코드와 최소 계수/digest만 공개 receipt에 남긴다. secrets·원 request/session·민감 식별자는 private700/600 artifact에만 보관한다. 실패 recipe는 같은 key로 실행을 다시 시작하지 않고 그대로 보존한다. 닫기 경로는 fixture 전 실패와 부분 적용도 처리하고 모든 processing/receipt/deletion guard를 닫고 추가 EXEC를 원 기준으로 복원한 뒤 자기 DB/REST/Storage/Auth 네 컨테이너 STOP을 확인한다. source DB/Storage 및 원 환경 불변을 다시 확인한다. 이미 committed 제품 요청이 있는 clone을 전체 rows rollback했다고 주장하지 않는다.

두 fresh recipe의 actual PASS가 있어야 공개 API→task 생성→첫 physical Storage/Auth 삭제와 ACK→원 UNKNOWN GET-only 복구→SQL118 자동 원 부모 종결→원 JWT completed 영수증의 연결을 검증 완료로 표시한다. 운영 활성화·실회원·실제 네이버·공급사 승인·모바일 실제 UI·보관기한 정책은 이 결과의 범위에 포함하지 않는다.
