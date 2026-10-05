# 삭제 응답·ACK 기록 전 손실 복구 연구

- 작업자: minkyu. 2026-10-05.
- 상태: 공식 고정 소스 읽기 기반 기술 제안. 새 DB/provider 쓰기·재실행·운영 적용 0.
- 대상: Storage v1.70.3, Auth v2.196.0. 현재 공급사 버전이나 설정을 변경하는 제안의 채택 여부는 별도다.
- 기존 실제 provider 검증과 native56 FAIL 자료는 변경하지 않는다. 이번 연구가 복구 성공의 실행 증거를 대신하지 않는다.

## 결론

현재 외부 DELETE 성공 응답을 작업자가 수신한 뒤 자체 DB ACK를 쓰는 방식에는 응답 소실·프로세스 종료 창이 남는다. 재시도 때 metadata 404와 사전 intent만으로 성공을 만들 수 없다.

Auth의 PostgreSQL 감사 기록에는 같은 트랜잭션에 저장되는 삭제 사건이 있어 조건부 복구 후보가 있다. Storage 공개 삭제 API에서는 재조회 가능한 작업별 성공 영수증을 찾지 못했다. Storage는 공급사 내부의 삭제 성공 이후, metadata commit과 같은 트랜잭션에 durable receipt를 넣는 확장이 가장 직접적인 제안이다. 현재 hosted 환경에서 그 확장을 사용할 수 있다는 확인은 없다.

## 공식 소스에서 확인한 순서

### Storage 공개 API와 정확한 대상

`DELETE /object/:bucketName`은 `prefixes` 배열을 받는다. 현재 경로에는 호출자가 지정하는 object UUID나 작업별 idempotency key/영수증 조회 계약이 없다. 이름 하나를 전달하는 기존 어댑터의 사전 info ID 비교는 중요하지만, info와 DELETE 사이의 동일 이름 교체까지 API 자체가 UUID 조건으로 막는 것은 아니다. [삭제 route](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/http/routes/object/deleteObjects.ts), [공식 remove API](https://supabase.com/docs/reference/javascript/storage-from-remove).

Storage 내부 `deleteObjects`는 metadata DELETE 반환 행에서 이름·version을 얻고, 그 행의 실제 backend key와 `.info` key를 삭제한 뒤 metadata 트랜잭션을 마친다. bulk 경로의 backend 삭제는 await되지만 외부 backend와 PostgreSQL이 하나의 원자 트랜잭션을 이루는 것은 아니다. [object.ts](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/storage/object.ts).

`StoragePgDB.withTransaction`은 callback 완료 후 commit한다. metadata 삭제 쿼리는 bucket과 이름을 비교해 기존 행을 반환한다. 따라서 backend 삭제 후 DB rollback이 발생하면 실제 파일은 없어지고 metadata는 남을 수 있다. 이때 metadata가 여전히 존재한다는 사실도 파일 존재 증거가 아니다. [pg.ts](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/storage/database/pg.ts).

local file backend는 지정된 실제 경로 제거를 기다리고 실패를 전달한다. 기존 provider 검증의 즉시 backend 파일 0은 이 환경에 대한 실행 증거다. 해당 결과를 운영 S3나 다른 provider에 확대하지 않는다. [file backend](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/storage/backend/file.ts).

### S3 backend의 추가 위험 후보

고정 S3 adapter의 bulk 삭제는 AWS SDK promise의 rejected 여부를 검사하지만 fulfilled 응답의 `Errors`를 검사하는 코드는 해당 함수에서 확인되지 않았다. AWS 공식 `DeleteObjects` 계약은 HTTP 200 응답에도 개별 key 실패를 담을 수 있다. 그러므로 이 고정 구현의 API 200과 metadata 없음만으로 운영 S3의 모든 물리 key 삭제를 보증해서는 안 된다. 이는 공식 코드 비교로 찾은 후보이며 실제 S3 재현은 NOT_RUN이다. Supabase의 `object.version` 경로 값과 S3 bucket version ID도 같은 값으로 취급하지 않는다. [S3 adapter](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/storage/backend/s3/adapter.ts), [AWS DeleteObjects](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html).

### 삭제 webhook은 단독 영수증이 아니다

삭제 이벤트 payload는 name/bucket/version 등을 포함하지만 object UUID가 명시된 별도 성공 영수증 계약은 아니다. [ObjectRemoved 정의](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/storage/events/lifecycle/object-removed.ts).

`BaseEvent.sendWebhook`은 별도 `Webhook.send`를 호출하고 실패를 catch해 로그로 남긴다. 삭제의 metadata transaction에 queue 삽입을 넘기는 인자는 확인되지 않았다. 이벤트 발행 실패가 삭제를 확실히 실패시킨다는 보증도 없다. [base-event.ts](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/storage/events/base-event.ts).

Webhook은 별도 큐·worker에서 전송되며 URL 미설정이면 건너뛰고 tenant 설정으로 비활성화할 수 있다. bulk 삭제 이벤트는 metadata commit 전에 보내는 순서이므로 수신 사건만으로 그 commit 성공까지 증명하지 못한다. 일반 DB DELETE webhook/트리거도 metadata 삭제 사실만 증명한다. 이를 외부 DELETE 200 또는 물리삭제 영수증으로 변환하지 않는다. [webhook.ts](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/storage/events/lifecycle/webhook.ts).

### Auth의 실제 트랜잭션 감사 후보

`adminUserDelete`는 동일 `db.Transaction` callback에서 `UserDeletedAction` 감사행과 사용자 삭제를 처리한 뒤 빈 object 200을 반환한다. hard delete와 soft delete가 모두 같은 action을 사용한다. 따라서 action만 확인해서 hard delete를 확정하면 안 된다. [admin.go](https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/api/admin.go), [deleteUser API](https://supabase.com/docs/reference/javascript/auth-admin-deleteuser).

`NewAuditLogEntry`는 DB 저장을 사용하면 전달받은 동일 tx로 감사행을 만든다. 단, `DisablePostgres`가 true이면 DB 행을 만들지 않는다. 또한 외부 로그는 tx commit 전에 출력된다. 로그 스트림만으로 commit 성공을 주장할 수 없다. DB payload에는 action/actor/traits의 user ID 등이 있지만 hard-delete flag와 request ID가 별도 DB 영수증 필드로 저장되지는 않는다. 원문 payload에는 이메일·전화 등이 있으므로 복구 경로에서 전체 내용을 반환·복사·출력하지 않는다. [audit_log_entry.go](https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/models/audit_log_entry.go).

공식 문서도 PostgreSQL 감사 저장은 선택 사항이라고 설명한다. 현재 운영 설정·감사 보관 기간·쓰기 권한은 이번 연구에서 확인하지 않았다. 감사 API는 action 등의 필터와 pagination을 제공하지만 작업 ID로 제한한 성공 영수증 API는 아니다. [Auth audit 문서](https://supabase.com/docs/guides/auth/audit-logs), [audit API 소스](https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/api/audit.go).

## 실패 창과 현재 처리

| 시점 | 실제로 가능한 상태 | 현재 안전한 판단 |
| --- | --- | --- |
| DELETE 전 intent만 저장 | 아직 삭제하지 않음 | 완료 금지 |
| Storage metadata TX 안에서 backend 삭제 전에 실패 | DB rollback·파일 잔존 가능 | 실제 삭제 재시도 필요 |
| backend 삭제 후 metadata commit 전 종료 | 파일 부재·metadata 잔존 가능 | 해당 old ID/version의 진짜 삭제 재시도 또는 provider proof 필요 |
| metadata commit 후 API 응답 소실 | 파일 삭제됐을 수 있으나 작업자 ACK 없음 | metadata 404만으로 완료 금지 |
| DELETE 200 수신 후 ACK commit 전 종료 | 삭제 성공 응답이 프로세스와 함께 소실 | durable provider proof 없으면 증거 부족으로 실패 유지 |
| 자체 ACK commit 후 응답 소실 | 자체 영수증이 이미 존재 | 새 유효 fence로 기존 task/object proof 조회·부재 재검사·완료 |
| Auth delete tx commit 전 실패 | DB 감사와 사용자 삭제 모두 rollback 가능 | 로그 스트림은 성공 증거로 사용하지 않음 |
| Auth delete tx commit 후 응답 소실 | 사용자 부재·DB 감사 존재 가능 | 아래 조건부 감사 복구를 검증한 후 사용 |

마지막 자체 ACK 이후 복구는 기존 SQL/unit 증거가 있지만 native DB+HTTP 전체 복구는 아직 PASS가 아니다. native56 첫 실행은 삭제 단계에서 FAIL이고 finally rows/files 0·guard false·cleanup ACL 0·global 해제만 확인했다. 정확 오류 분류를 추가한 다음 driver는 아직 재실행하지 않았다.

## 기술 제안 A: Auth DB 감사의 제한된 복구

1. 고정 버전과 PostgreSQL 감사 저장 활성화, 감사행 수정 권한·사용자 삭제 권한의 신뢰 경계를 확인한다. 일반 service RPC에 전체 감사 payload나 임의 proof 입력을 개방하지 않는다.
2. 기존 immutable cleanup task의 정확 Auth UID·profile·withdrawal, 생성 시각과 최소 감사 식별 watermark를 연결한다. watermark/intent는 범위 제한일 뿐 삭제 증거가 아니다.
3. owner-only 제한 extractor가 해당 UID의 새 `user_deleted` DB 감사행과 실제 Auth UID 부재를 함께 확인한다. hard DELETE 실행 계약, 승인된 provider 액터, 동일 UID 재생성 금지, soft-delete 사건과 다른 삭제 경로의 혼동 방지가 선행 조건이다.
4. extractor는 감사행 ID·task/object ID·증거 종류·해시처럼 최소 검증 결과만 전달한다. 기존 외부 200 ACK와 다른 `auth_committed_audit` 증거 종류를 사용한다. API 200을 받았다고 위장하지 않는다.
5. 감사 없음/DB 저장 비활성/여러 사건의 연결이 모호함/UID 재생성/권한 실패/아직 사용자 존재는 실패 또는 별도 조사 상태로 유지한다. 현재 complete 계약은 ACK 필수이므로 새 증거를 받아들이려면 별도 SQL/권한 변경과 actual regression이 필요하다.

이 후보는 동일 DB transaction이라는 코드 근거가 있으나 현재 worker 연결·감사 extractor·실제 응답 손실 복구는 NOT_IMPLEMENTED/NOT_RUN이다. 새 감사 보관 기간이나 법적 보관 근거는 정하지 않는다.

## 기술 제안 B: Storage provider 내부 durable receipt

공개 API의 표준 기능으로 존재한다고 주장하지 않는다. 공급사 확장 또는 관리 가능한 독립 provider의 구현 제안이다.

- 삭제 명령은 task ID/idempotency key + 정확 object UUID/bucket/name/version + 불변 target hash를 받는다. 같은 key에 다른 target이면 거절한다.
- provider는 metadata 행을 잠그고 exact object UUID/version을 다시 확인한다. 이름만 같은 새 객체는 삭제하지 않는다. caller의 사전 intent와 이 provider 검사 결과를 구분한다.
- 진짜 backend exact key 삭제를 기다린 뒤 개별 key 성공/실패를 검증한다. S3의 `Errors`, bucket versioning/delete-marker 의미, 보조 `.info` key도 다룬다.
- 성공 검증 후 metadata 삭제와 provider receipt/outbox 삽입을 **같은 provider DB transaction**으로 commit한다. metadata DELETE trigger로 증거를 만들지 않는다. backend 호출 결과를 확인한 실행 경로만 receipt를 만든다.
- 응답이 소실돼도 인증된 receipt 조회 API가 동일 key/object ID의 commit된 결과를 반환한다. 현재 global/task lease가 만료됐다면 새 유효 lease로 그 불변 proof를 소비한다. 기존 lease 연장을 성공 증거로 사용하지 않는다.
- backend 성공 후 provider TX rollback이면 receipt도 없고 metadata도 복원된다. 같은 old ID/version에 대한 실제 backend idempotent DELETE를 다시 수행해 새 commit 증거를 만든다. API가 이미 없어진 metadata를 건너뛰고 빈 결과만 반환하는 현재 경로를 성공 proof로 사용할 수 없다.
- backend와 DB의 원자 commit은 여전히 불가능하므로, provider receipt가 없고 metadata도 소실된 이례 경로에는 exact backend locator/version의 직접 검증·재삭제 경로가 추가로 필요하다. 애플리케이션에는 현재 그 backend 권한·공식 운영 계약이 제공됐다는 증거가 없다.

단순 reverse proxy의 응답 기록도 upstream 삭제 후 proxy 기록 전 종료 창이 있어 완전한 해결이 아니다. metadata GET 404를 backend HEAD 404로 부르는 방식도 금지한다. 공식 backend에 직접 접근해 인증된 exact locator/version을 확인하는 방식은 별도의 권한·동일 이름 재생성·버전·파일 잔존 검증이 필요한 기술 대안이다.

## 다음 검증과 채택 경계

| 검증 | 현재 상태 | 통과 기준 |
| --- | --- | --- |
| local Storage/Auth 정상 삭제 응답 | 기존 provider 검증 PASS | exact ID/name/UID, 즉시 실제 파일 0·Auth 404 |
| native56 end-to-end ACK 후 재점유 | FAIL, 재실행 대기 | task 실제 만료→same receipt→두 번째 DELETE 0→Auth 후순서→최종 0 |
| Auth 감사의 hard/soft/rollback 비교 | NOT_RUN | commit된 hard 사건만 UID 부재와 연결, rollback/log-only/soft 부정 사례 거절 |
| API 응답 소실 후 Auth 감사 복구 | NOT_RUN | 실제 hard DELETE와 응답 손실, 최소 DB 감사 proof, 새 fence 완료 |
| Storage provider receipt 확장 | NOT_IMPLEMENTED | backend 성공→receipt+metadata 원자 commit, 응답 소실 후 조회, 다른 object ID 거절 |
| S3 fulfilled 응답의 개별 오류 | NOT_RUN | HTTP 200+Errors에도 완료 금지, 실제 backend old version 잔존 판별 |

이번 산출물은 최소 기술 선택지를 정리한 요청 문서다. 운영 공급사 변경, audit 활성화, 새로운 보관 정책, worker 활성화, service_role proof 권한 개방은 하지 않았다. root의 adapter deadline/AbortSignal 변경 이후에는 이전 adapter SHA를 사용하는 native driver를 실행하지 않는다.
