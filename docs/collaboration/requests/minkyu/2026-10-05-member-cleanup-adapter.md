# 탈퇴 외부 삭제 어댑터 연결 요청

작업자: minkyu. 독립 worktree에서 민규 소유 auth 어댑터와 테스트만 구현했다. 운영 승인 guard는 false이고 cleanup RPC 권한은 닫힌 상태다. J 실행기·internal-client·lifecycle SQL은 수정하지 않았다. 실제 독립 로컬 Storage/Auth provider 검증은 **PASS**다. DB fence/ack와 J 실행기를 함께 연결한 상태는 **NOT_CONNECTED**이며 운영 삭제 검증은 **NOT_RUN**이다.

## 구현과 DB 연결 계약

대상 파일은 `backend/supabase/functions/_shared/auth/member-cleanup.ts`, `tests/functions/minkyu/member_cleanup.test.ts`다. `createMemberCleanupAdapter(config, fetchImpl)`는 서버 service key를 사용하고, `processMemberCleanupTask(workerRunToken, ports, adapter)`는 다음 필수 포트를 받는다. 포트가 없거나 잘못된 응답이면 삭제를 시작하지 않는다. 누락된 DB 검사를 가짜 성공으로 대신하지 않는다.

| 포트 | 연결할 RPC | 인자 | 결과 |
|---|---|---|---|
| claim | claim_member_cleanup_task | p_worker_run_token | null 또는 아래 8개 필드 |
| assertCurrent | check_member_cleanup_task | p_task_id, p_lease_token, p_worker_run_token, p_object_id | claim과 동일한 8개 필드 |
| getDeleteAck | get_member_cleanup_delete_ack | 위 4개 | null 또는 receipt 5개 필드 |
| recordDeleteAck | record_member_cleanup_delete_ack | 위 4개 + p_ack_sha256 | receipt 5개 필드 |
| complete | complete_member_cleanup_task | 위 4개 + p_evidence_sha256 | 정확히 `{"status":"applied"}` |

8개 필드는 `taskId, leaseToken, expiresAt, kind, profileId, bucketId, objectName, objectId`다. `kind=storage_object`이면 bucket은 profile-images이고 UUID 객체 ID와 DB가 소유권을 확인한 정확한 task 이름을 요구한다. `kind=auth_user`이면 bucket/name/objectId는 null이고 Auth UID는 profileId다. 이름은 UTF-8 1~1024바이트이며 control/backslash/빈 segment/`.`/`..` segment를 거절한다. 경로를 재작성하거나 추측하지 않고 segment별 URL 인코딩한다. 서비스 역할 등으로 남은 일반 파일명·확장자도 같은 exact 절차로 처리한다. DB check의 owner-or-firstfolder 판정이 최종 소유권 기준이며 이름만 보고 소유권을 추정하지 않는다.

최초 처리의 DB 검사는 claim 직후, 외부 DELETE 직전, DELETE acknowledgement 이후 record 직전, 재조회 이후 완료 직전에 실행한다. 기존 receipt 복구에서는 claim 직후와 재조회 이후 실행한다. check의 8개 필드를 claim 결과와 전부 비교한다. 전역 토큰과 작업 lease를 연장하거나 새 토큰으로 바꾸지 않는다. 프로세스 시계는 만료에 대한 보조 검사이고 DB의 전역·작업 lease/승인 검사를 대체하지 않는다. complete는 기존 5인자 RPC다. 실제 삭제 성공 후 DB가 충돌하면 처리 성공을 반환하지 않는다.

삭제 acknowledgement 해시는 task/lease/global UUID·작업 종류·객체 UUID·DELETE acknowledgement의 고정 봉투에 결합한다. 최종 완료 해시는 현재 fence·receipt UUID·acknowledgement 해시·재조회404를 포함하는 별도 봉투다. DB에는 64자리 해시만 넘긴다. 외부 응답 원문·프로필 사진 경로·키·Auth 사용자 메타데이터·채팅/후기 원문을 기록하지 않는다. 해시 자체는 DB가 외부 삭제를 확인하는 독립 증명이 아니다. 신뢰된 서버 어댑터의 단계 완료를 연결하는 표식이다.

## 외부 요청과 실패 조건

Storage는 `GET /storage/v1/object/info/authenticated/profile-images/{정확경로}`의 id/name/bucket_id를 확인한 뒤, `DELETE /storage/v1/object/profile-images`에 `{"prefixes":[정확경로]}` 하나만 보낸다. DELETE 응답의 단일 id/name도 task와 같아야 한다. 이후 `GET /storage/v1/object/authenticated/profile-images/{정확경로}`가 HTTP404 또는 Storage 한정 `HTTP400 + code=NoSuchKey + statusCode="404"`여야 완료할 수 있다. [공식 Storage 삭제 구현](https://raw.githubusercontent.com/supabase/storage-js/master/src/packages/StorageFileApi.ts), [객체 정보 route](https://raw.githubusercontent.com/supabase/storage/master/src/http/routes/object/getObjectInfo.ts).

Auth는 먼저 정확한 admin URL의 GET200과 사용자 id를 확인한다. 이후 `DELETE /auth/v1/admin/users/{정확profileId}`에 `{"should_soft_delete":false}`를 보내고 HTTP200의 빈 객체 응답(추가 필드 없음)을 검증한 뒤 같은 admin URL의 GET404를 확인한다. [공식 Auth admin 구현](https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/api/admin.go).

조회200, code 없는 400/statusCode404, NoSuchBucket·JWT·권한·요청 오류, 401/403/500, 빈 삭제 배열, 다른 id/name, timeout, redirect, 잘못된 JSON은 성공으로 처리하지 않는다. 오류 원문은 고정 공개 오류로 치환한다. 설정은 HTTPS 또는 명시된 로컬 origin, 구분되는 service/anon key, 양의 timeout을 요구한다.

## 남은 연결과 복구 제한

종현 연결 대상은 기존 jobs 실행기와 `db/internal-client`이다. exact 5개 RPC 어댑터를 별도로 연결하고, 승인·권한 개방은 현재 작업에 포함하지 않는다. 런타임 담당자는 check·ack RPC 추가를 준비 중이며 운영 guard와 ACL을 닫은 상태를 유지한다. 이번 파일에 자동 실행·스케줄·삭제 승인 경로는 없다.

Storage의 GET은 metadata에서 객체를 찾은 뒤 backend asset을 읽는다. 따라서 info404 + object GET404만으로 backend에 남은 orphan bytes의 삭제를 입증할 수 없다. [공식 객체 GET route](https://raw.githubusercontent.com/supabase/storage/master/src/http/routes/object/getObject.ts). 이번 어댑터는 최초 info404 또는 DELETE 빈 응답을 완료 근거로 인정하지 않는다. 실제 DELETE acknowledgement가 durable receipt로 저장된 뒤 complete가 실패한 경우에는 새 lease에서 그 증거를 읽어 부재 확인·완료를 재시도한다. receipt가 기록되기 전 장애는 자동 완료되지 않으며 별도 공급자 backend 삭제 증명/운영 재확인이 필요하다. DB metadata 부재만으로 완료하는 우회는 넣지 않았다.

Storage DELETE는 name 기준이다. info 확인과 DELETE 사이에 관리자가 같은 name에 다른 객체를 교체하는 것을 HTTP 요청만으로 원자적으로 막지는 못한다. 이때 DELETE 응답의 다른 id는 완료를 막지만 이미 이루어진 외부 변경을 되돌리지는 못한다. lease가 네트워크 중 만료돼도 DB 완료는 막히지만 외부 DELETE를 되돌릴 수는 없다. 실서비스 연결 전에 재생성/관리자 교체 제약 및 provider 조건부 삭제 지원을 별도 검증해야 한다. 기존 signed URL의 즉시 회수나 물리 파일 삭제를 이번 합성 검증으로 완료했다고 주장하지 않는다.

## 확인 결과

- `node --experimental-strip-types --test tests/functions/minkyu/member_cleanup.test.ts`: **23그룹 PASS**. 정확 Storage/Auth target, HTTP 요청 순서, 최초 4회 fence, 해시만 완료 전달, idle, 위조 task/경로, check 불일치, DB 응답 대기 중 만료, 만료/누락 fence, 단계별 lease 상실, 외부·DB 실패, timeout·원문 비노출, 설정, durable ack 순서, complete 장애 이후 새 lease 복구, record 응답 소실 복구, 위조 receipt와 재생성 객체 거절을 검증했다.
- `deno check --no-remote backend/supabase/functions/_shared/auth/member-cleanup.ts`: **PASS**.
- 실제 독립 로컬 provider: UUID.jpg 및 `legacy photo?.jpeg`의 새 1px JPEG binary 업로드·동일 bytes 조회, 정확 info ID 불일치 거절, 삭제 직후 backend 파일0, Auth GET200→hard DELETE200{}→GET404, `%`/`#` 인코딩 후 provider InvalidKey 거절, 잘못된 인증 AccessDenied 거절, finally Auth/metadata/files0 확인 **PASS**. 실제 DB/Storage의 만료·완료 장애 복구, J 실행기 연결, 운영 적용: **NOT_RUN**.

실제 provider 재현 파일은 `tests/integration/minkyu/member_cleanup_provider_local.ts`다. 고정 독립 API http://127.0.0.1:56531과 private status 파일만 허용하고 임의 URL/키를 읽지 않는다. 최종 최소 메타 artifact는 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-cleanup-provider-XIOZv0/result.json`이며 7종 provider 검증 + 1종 합성 DB fence 거절이 PASS다. claim/check/ack/complete 포트는 합성이며 실제 DB lease 증명이 아니다. 원래 DB·운영 객체·회원·키를 사용하지 않았다.

## durable acknowledgment 구현 계약

root는 실제 DELETE 후 DB complete 장애의 재시도 복구를 기술적 필수 작업으로 지정했다. 아래의 최소 계약을 root가 승인했고 어댑터에 구현했다. runtime이 대응 SQL을 준비 중이며 실제 연결은 NOT_RUN이다. 업무 정책을 바꾸거나 운영 guard/권한을 열지 않는다.

| RPC | 인자 | 반환/검사 |
|---|---|---|
| record_member_cleanup_delete_ack | taskId, leaseToken, workerRunToken, objectId, ackSha256 | receipt. 현재 승인·전역·task lease 유효 + target 일치 + DB target 부재 |
| get_member_cleanup_delete_ack | taskId, leaseToken, workerRunToken, objectId | null 또는 정확히 receipt 5개 필드. 현재 승인·전역·task lease 유효 |

receipt는 `receiptId, taskId, kind, objectId, evidenceSha256`를 반환한다. private 저장소는 taskId UNIQUE/FK, DB 생성 receipt UUID, 최초 acknowledgement 시각, 해시, 당시 task의 불변 종류·withdrawal/target 귀속을 결합한다. 경로·provider 본문·사진·Auth 원문·키는 새로 저장하지 않는다. task 삭제 시 proof도 제거하는 연결을 제안하며 새로운 독립 보관 기한을 임의로 정하지 않는다. owner-only helper/닫힌 RPC에서만 관리한다. 일반 회원이나 AI가 proof를 쓰거나 완료를 승인할 수 없다.

최초 처리에서는 DELETE200의 exact target acknowledgement를 받은 즉시 record RPC를 실행하고 durable receipt 응답을 검증한 후 404 재조회를 진행한다. DELETE acknowledgement에 대한 해시는 task/target UUID와 당시 lease/global에 결합한다. DB는 동일 task의 첫 유효 receipt를 보존한다. adapter는 record 응답 hash가 방금 보낸 acknowledgement hash와 다르면 실패한다. 마지막 complete에는 현재 lease/global과 receipt·404 재조회를 포함한 별도 최종 hash를 전달한다.

다음 lease의 처리에서는 외부 DELETE 전에 get RPC를 호출한다. receipt가 있으면 새 DELETE를 보내지 않는다. Storage info 및 authenticated object 조회의 의미상404(위의 엄격 정규화), Auth admin GET404를 검증하고, 현재 DB target 부재/fence를 거쳐 완료한다. 다른 객체가 같은 name에 다시 있거나 Auth UID가 다시 존재하면 실패한다. receipt가 없으면 기존 최초 삭제 절차를 수행한다. record 응답이 소실됐어도 durable proof가 남으면 다음 lease에서 읽어 복구한다.

| 장애 위치 | 다음 처리 |
|---|---|
| DELETE200 exact acknowledgement → durable record 성공 → GET/complete 실패 | 기존 receipt로 재조회·완료 재시도 가능 |
| durable record commit 성공 후 HTTP 응답 소실 | get receipt로 복구 가능 |
| 외부 DELETE 응답 소실 | 증거 없음. 404만으로 성공 처리하지 않음 |
| DELETE200 뒤 record commit 이전 프로세스 종료/lease 만료 | 증거 없음. 별도 공급자/운영 재확인 필요 |
| 같은 name의 다른 객체 재생성 또는 UID 재등장 | 현재 부재 검사가 실패하며 재삭제/완료하지 않음 |

durable ack unit 6그룹에서 최초 ack 기록 순서, record 실패 후 완료 없음, 기존 receipt 재조회만 수행, 새 lease와 기존 proof 연결, receipt target/hash 위조 거절, 응답 소실 후 get 복구, 새 객체/UID 등장 시 실패를 확인했다. 실제 DB 회귀는 runtime이 닫힌 SQL을 독립 scratch에 적용한 뒤 수행하고, 실제 Storage의 삭제 acknowledgement 의미·파일 잔여는 root의 독립 환경에서 따로 확인한다.

## provider 버전과 소유권 한계

실제 drift 이미지는 Storage v1.70.3, Auth v2.196.0이다. [Storage error handler](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/http/error-handler.ts)는 일반 renderable 오류를 HTTP400으로 감싸고, [NoSuchKey 코드](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/internal/errors/codes.ts)는 의미상404를 정의한다. 이 exact 조합만 Storage 부재로 정규화하며 Auth에는 적용하지 않는다. [Storage deleteObjects](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/storage/object.ts)는 backend 삭제를 기다린 뒤 반환한다. 실제 어댑터 성공 직후 backend 파일0을 별도 검사해 finally cleanup 증거와 구분했다.

20260917052827의 가입 avatar 검증과 회원 INSERT RLS는 모두 UUID/UUID.jpg만 허용한다. 일반 파일명은 회원 업로드가 가능한 것으로 설명하지 않는다. 서비스 역할로 남은 객체는 owner_id 또는 첫 folder 일치에 따라 cleanup task로 수집될 수 있으므로 정확한 객체 이름의 삭제도 지원한다. provider 검증의 legacy 사진은 서비스 역할 업로드이며 회원 업로드 성공 근거가 아니다. [InfoRenderer](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/storage/renderer/info.ts)는 provider owner_id를 반환하지 않는다. adapter는 provider id/name/bucket을 exact 비교하고, 소유권은 필수 DB check가 실제 storage.objects의 objectId/name/bucket/profile owner-or-firstfolder를 검사해야 한다. 이번 provider 테스트의 DB 포트는 합성이므로 이 소유권·lease SQL 검증을 대체하지 않는다. 다른 prefix라도 DB가 owner_id 소유권을 확인한 exact task면 지원하지만 임의 prefix 삭제는 하지 않는다.

공급자 버전이 바뀌면 성공/오류 DTO·semantic absence·backend 삭제 의미를 재검증해야 한다. 현재 공급자는 `%`/`#` key를 InvalidKey로 거절하고 `?`/공백을 허용했다. 어댑터는 인코딩 때문에 이름을 바꾸지 않으며 provider가 거절한 이름은 실패로 남긴다. raw signed URL의 조기 회수나 운영·원본 cluster 삭제 완료를 주장하지 않는다.

## native55 연결 검증의 초기 오류

회원JWT로 legacy 파일명을 올리려던 통합 fixture는 실제 INSERT RLS에서 거절되었다. 가입·회원 업로드 정책을 바꾸지 않고 canonical 사진만 실제 회원JWT로, legacy 사진은 같은 합성 본인 folder에 서비스 역할로 올리는 방식으로 교정 중이다. 이 실행의 실패를 실제 연결 성공으로 기록하지 않는다. main 전용 `db/repositories/member-cleanup.ts`는 이미 fixed5 RPC 전달·공개/일반 내부 클라이언트 차단4그룹 검증을 통과했으나 전체 실제DB/provider 작업의 검증은 별도다.

## 공통 마감·취소 신호 보완

`processMemberCleanupTask`는 선택적인 `{deadlineAt, signal}` 실행 예산을 받는다. claim부터 최대60초 상한을 시작하고 실제 task.expiresAt 및 실행기가 전달한 실제 전역점유 마감 중 가장 이른 시각으로만 좁힌다. 어떤 경우에도 lease를 연장하지 않는다. 현재 DB fence는 그대로 필수다. 전용 cleanup5 포트와 provider 요청에 동일 AbortSignal을 전달하며 개별 upstream timeout도 함께 유지한다. 이미 마감/취소됐으면 claim을 시작하지 않고, 진행 중 예산이 끝나면 성공을 반환하지 않는다. 이 보완은 외부 provider가 이미 시작한 DELETE를 rollback한다고 주장하지 않으며 DELETE 성공후ack 미저장 공백을 해결하지 않는다.

새 deadline 테스트6개와 기존adapter23/전용ports4개 총33개 Deno 타입·동작 검사는 PASS다. 첫 RPC signal fixture는 INTERNAL_WORKER_SECRET 누락으로 실패했고 실제 내부설정 요구를 지킨 합성fixture로 보완했다. source native56 이전 실행FAIL과 provider 실제삭제 검증의 기존SHA는 보존한다. 새코드로 실제provider/native통합 재검증은 아직 미실행이다.

공통 마감 최종 보완은 timer 실행 전 시계 전진에도 실제deadlineAt을 직접 검사한다. deadline7+기존adapter23+ports4 총34개 관련검사가 PASS하며, 전체 함수는 Deno 타입검사 PASS·Node test runner334/334 PASS다. 테스트 모형의JsonValue 반환형/BodyInit 실제복사와 검색 준비검사의 최신계약을 고쳤고 입력/기대값을 타입검사 회피 목적으로 완화하지 않았다. 전체 테스트는 node:test용이며 Deno 실행환경의Deno전역쓰기/임시파일write권한 실패를 성공으로 표시하지 않는다. 최종 native driver는 실제acquire expiresAt을 budget으로 전달하도록 통합했으며 아직재실행하지않았다.
