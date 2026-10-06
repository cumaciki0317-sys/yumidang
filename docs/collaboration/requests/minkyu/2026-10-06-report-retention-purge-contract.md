# 신고 자료와 첨부의 보관 종료·파기 연결 계약

작업자 `minkyu`, C lane. 원 제안 SHA `da91a7b3e3dc146c0af5dc5ee371b47ba5d4ee1369abf4e2a0160456590c8b77`은 별도 사본에 보존했다. 본 문서는 A79/C80 후보의 실제 계약과 단일 TX 회귀 결과를 동기화한다. C는 문서만 수정하며 실제 DB/API/Provider 실행을 하지 않았다. root는 native78에서 후보79+80을 같은 TX에 적용하고 회귀 후 전체ROLLBACK한 PASS를 확인했다. 정식history는78이며 실제 Provider 파일 파기·최종 종결 권한·J 실행 연결·운영은 미완료다.

## 기준과 현재 공백

[PLAN.md](../../../../PLAN.md) 5장과 [정책.md](../../../../정책.md) 13장은 신고 자료를 이의를 포함한 최종 종결부터90일, 종료 제재의 상세·증거를 제재 종료와 이의 종결 중 늦은 시점부터90일로 정한다. 제재·경고·연속취소 최소 연결 기록에는 이 기간을 자동 적용하지 않는다. 법적 보관 근거와 기존 백업의 실제 만료는 별도 확인 대상이다.

기존 `private.report_retention_candidates`는 resolved/final_closed_at/retention_due_at이 만료된 행을 조회할 뿐이다. A79 후보가 파기 closure/task/ACK/terminal 저장소와 닫힌 DB RPC를 추가하지만 실제 최종 종결 RPC와 Provider 첨부 파일 실행기는 아직 없다. `private.report_capture_assets.report_id`는 RESTRICT이므로 신고만 먼저 DELETE하면 첨부 연결 때문에 실패한다. source76은 reviewing 취소 이의의 신고 종결·삭제를55000으로 차단한다. source78의 직원 이의 해소 성공만으로 모든 관련 절차가 최종 종결됐다고 추정하지 않는다.

기존 `member-cleanup.ts`의 claim/check/delete ACK/complete는 탈퇴한 회원의 profile-images와 Auth 삭제 책임이다. 신고 자료는 탈퇴 후에도 배정 직원의 조회 대상이 될 수 있고, 별도의 report/asset/종결 근거/목적별 보관 의존성이 있다. 회원 cleanup에 report-evidence를 추가하지 않는다. 기존 reports 저장소·서비스 책임에 좁은 신고 파기 어댑터를 연결하고, 공통 전역 점유·작업 fence와 검증된 DELETE ACK 패턴만 재사용하는 제안이다. 같은 기능의 별도 백엔드를 만들지 않는다.

## 종결 사실과 목적별 준비 gate

최종 종결은 담당자 권한·배정·원 사건과 이의 관계·기대 revision을 검증하는 기존 운영 흐름의 후속 원자 전이여야 한다. 일반 `status='resolved'` UPDATE, worker의 현재 시각, TTL 만료 또는 actor가 전달한 날짜로 종결을 만들어서는 안 된다. 서버가 검증한 종결 사실의 불변 revision과 원 시각을 기록한다. 같은 종결 자료에 새 receipt UUID를 붙여 시각을 연장하는 것도 거절한다.

| 조건 | 파기 gate |
|---|---|
| 검증된 최종 종결과 모든 연결 이의 종결이 있음 | 해당 원 시각+90일을 DBclock으로 검사 |
| reviewing 이의·미종결 관련 사건·분쟁이 남음 | `procedure_open`으로 held |
| 일반7일 통지 epoch/관련 이의 종료를 증명할 근거가 없음 | `appeal_anchor_unresolved`로 held |
| 살아 있는 제재가 같은 증거를 사용하는데 목적·수명이 미정 | `safety_evidence_policy_pending`으로 held |
| 종료 제재 상세에 별도 확정 보관 근거가 있음 | 그 목적의 종료·이의 종결 중 늦은 시각+90일도 충족해야 공유 객체 삭제 가능 |
| 숨김 선택의 신고 상세 삭제 이후 지속 여부가 미정 | `hide_target_policy_pending`으로 held; 임의 삭제·유지 정책을 구현하지 않음 |
| 삭제 승인/역할 EXEC/실제 Storage 준비가 없음 | `execution_not_ready`로 held |

위 held 명칭은 목적별 설계 분기이며 A79가 공개 enum으로 반환하는 DTO가 아니다. 실제 A79는 hide_target=true·reviewing hold/appeal·현재 reviewing 사건·어떤 연결 제재 application이든 남은 신고를 eligible=false로 제외한다. 살아 있는 제재만 선별해 삭제 목적을 확정한 것으로 설명하지 않는다.

held는 원 신고 읽기 TTL을 연장하거나 이미 만료된 원문을 다시 공개하지 않는다. 파기 보류와 읽기 권한은 분리한다. 최소 제재 identity·경고/연속취소 연결의 미정 종료 조건도 이 엔진이 삭제하지 않는다. 실제 정책·법적 승인 없이 별도 증거 복제를 만들어 보관을 연장하지 않는다.

## 작업과 immutable target

A79 task는 원 reportId+closureProofId+closureRevision+assetId+원 Storage objectId의 불변 조합에 결합한다. closureRevision은 기존 report.review_version이고 closureProofId는 원 final_closed_at/retention_due_at/version/첨부 집합 hash를 캡처한 private.report_purge_closures.id 기술 snapshot이다. 새 종결 권한이나 시각을 만들지 않는다. `storage_object`와 첨부가 모두 완료된 뒤의 `report_metadata` 두 kind만 허용한다. 첨부 없는 신고는 metadata task만 필요하다. 후속 J task drain은 공유 최대20 작업 예산을 지켜야 한다. 현재 A79 enqueue의 상한은 신고20건이며 첨부별 task 수까지20으로 제한한 구현은 아니다. 조회·예약은 실제 DELETE·완료를 뜻하지 않는다.

A79 실제 job kind는 `report_retention`, payload는 원문 없이 exact `{reportId,closureProofId}`이다. 원 제안의 report_retention_purge/{reportId,closureRevision}과 다르다. J registry/DTO가 이 실제 kind를 지원한다고 선언하지 않는다. source78의 cancellation_safety/review_summary fence를 약화하거나 generic RPC fallback을 추가하지 않는다.

삭제 준비 guard는 기본false이고 모든 신규 RPC의 PUBLIC/anon/authenticated/service_role EXEC는 기본 폐쇄한다. 검토된 전용 실행 연결과 guard 승인, 좁은 EXEC 준비가 모두 충족된 뒤에만 별도 활성화한다. C80은 guard만true거나 한 RPC 권한이 빠지면 해당 job의 점유를 제외하고 기존 task를 보존한다. 실제 예약 due 숨김·승인/resume wake는 J scheduler 후속 연결 사항이며 현재 구현됐다고 설명하지 않는다. wake에는 원문을 넣지 않아야 한다. 구성/승인은 이 문서가 수행하지 않는다.

## A79 actual exact RPC와 DTO

모든 입력은 typed 인자다. 임의 actor/identity/episode/종결시각/보관기한/Storage 경로/원문 JSON을 받지 않는다. UUID는 canonical UUID, revision은1..9007199254740991, 해시는 소문자64hex다. 여기의 `jobToken`은 개별 job lease, `runToken`은 전역 worker lease다. 회원 JWT로 호출할 수 없다.

### 예약·claim

`enqueue_report_retention_purges(p_global_token uuid,p_limit integer default20)`

- p_limit은1..20 **신고 수**이며 guard+현재 global fence를 양끝에 검증한다. 이미 있는 job fence를 입력받는 원 제안과 다르다.
- actual exact1 응답 `{enqueued}`이며0..20이다. `{enqueued,held}` 집계는 구현되지 않았다.
- 원 종결 proof와 현재 eligible 조건을 충족한 대상만 LIMIT 앞에서 선별한다. 처음20개가 held여도 뒤 eligible를 굶기지 않도록 교정했다.
- 원 closure와 첨부 task를 예약한 뒤 같은 TX에서 exact job payload를 만든다. enqueue 성공은 외부 DELETE 또는 최종 파기가 아니다.

`claim_report_retention_task(p_job_id uuid,p_job_lease_token uuid,p_global_token uuid)`

- actual 응답은 wrapper 없이 NULL 또는 아래 exact12 객체다. 원 제안의 `{task}` envelope를 사용하지 않는다.
- `{taskId,taskLeaseToken,taskExpiresAt,reportId,closureRevision,kind,assetId,bucketId,objectName,objectId,retentionDueAt,closureProofId}`
- storage_object: assetId/objectId UUID, bucketId는report-evidence, objectName은 서버 asset와 Storage metadata에서 얻은 원 이름이다.
- report_metadata: assetId/bucketId/objectName/objectId는 모두NULL. 원 report/closure 근거만 대상이다.
- taskLeaseToken은 claim마다 새 토큰이고 만료 task는 새 lease로만 재점유한다. taskExpiresAt은 DBclock 기준이며 job/global 만료보다 늦을 수 없다. 검사·ACK·완료가 기존 lease를 연장하지 않는다.
- report_metadata claim은 모든 storage child.state=completed일 때만 선택한다. metadata complete는 child ACK·metadata 부재와 전체 snapshot을 다시 검증한다. check만으로 실제 외부 DELETE가 완료됐다고 설명하지 않는다.

### check와 DELETE ACK

공통 fence 입력 exact6 인자:

`(p_task_id uuid,p_task_lease_token uuid,p_job_id uuid,p_job_lease_token uuid,p_global_token uuid,p_object_id uuid)`

report_metadata의 p_object_id만NULL이다. 다른 target/object를 끼워 넣으면 실패한다. report와 closureRevision은 immutable task에서 서버가 도출한다.

`check_report_retention_task(공통6)` → claim의 task와 같은 exact12 객체.

- 삭제 직전 및 결과 등록 직전에 guard/task/job/global/current lease·DBclock·원 closure revision·미종결 절차·목적 gate를 다시 검사한다.
- 반환된12개 필드를 claim과 exact 비교한다. taskId만 같다고 다른 경로/객체를 수용하지 않는다.
- metadata task는 순수 DB 처리이며 외부 Storage DELETE를 호출하지 않는다.

`record_report_retention_delete_ack(공통6,p_ack_sha256 text)` 및 `get_report_retention_delete_ack(공통6)`

- record의 exact5 응답 `{receiptId,taskId,assetId,objectId,ackSha256}`. storage_object만 허용한다.
- get은NULL 또는 같은 exact5 응답이다.
- provider의 정확 object DELETE200 acknowledgement 직후, 당시 유효한 task/job/global fence로 기록한다. task/asset/object/원 closure에 결합한다.
- 동일 ACK hash 재시도는 같은 receipt를 반환한다. 같은 target의 다른 hash는40001이며 원 ACK를 덮어쓰지 않는다.
- 새 lease에서 같은 immutable task/object의 기존 ACK를 재사용할 수 있다. 이전 lease의 ACK write/complete는 거절한다.
- receipt에는 원문·키·전체 경로·provider 응답을 저장하지 않고 UUID/hash/DB 시각만 최소 저장한다.

### complete

`complete_report_retention_task(공통6,p_evidence_sha256 text)`

- exact3 응답 `{taskId,status,alreadyApplied}`, status는completed, alreadyApplied는boolean.
- storage_object는 승인된 durable DELETE ACK+원 objectId의 metadata 부재+인증된 객체 재조회404를 만족해야 한다. evidence hash는 target/fence/receiptId/ackSha256/검증 사실만 결합한다.
- metadata는 모든 첨부 완료, 새 첨부 없음, 원 종결/목적 gate 불변을 같은 TX에서 확인한 뒤 신고 상세·첨부 연결·동반 receipt/notice/access audit를 실제 FK/CASCADE 계약대로 파기한다. 정확 대상과 삭제 범위를 실제 catalog에서 확인해야 한다.
- member_reports DELETE는 asset를 먼저 정리한 뒤다. 미종결 이의 guard를 우회하거나 trigger를 삭제하지 않는다. 제재 최소 연결 원장은 범위 밖이다.
- storage child의 동일 완료 재시도는 유효한 현재 task/job/global fence와 같은 evidence hash를 요구하고 다른 hash는40001이다. 원 completedAt을 바꾸거나 새 효과를 만들지 않는다.
- **metadata 완료는 report/asset 파기·기존 complete_job(jobId,jobLeaseToken,globalToken)·terminal receipt INSERT를 같은 TX에서 처리한다.** 성공하면 job=succeeded이고 run fence도 제거된다. J 소비자가 metadata 성공 뒤 complete_job3를 다시 호출하면 안 된다. Storage child 완료만 job을 running으로 유지한다.
- metadata 완료 응답 유실은 private.report_purge_terminal_receipts에 보존된 원 증거를 읽는 별도 replay다. 새 유효 global만 검증하고, 원 task/job lease·objectId=NULL·evidence hash 및 succeeded job의 원 payload reportId/closureProofId·completedAt을 exact 비교한다. 만료된 task lease를 새 write 권한으로 복구하거나 settled job을 running으로 가장하지 않는다. exact3 alreadyApplied=true만 반환한다.
- 원 terminal completedAt+720시간(기존 작업 상세30일)까지 읽기 증거를 유지하고 만료는PT404다. 보관 시각을 재생 때 갱신하지 않는다. 원 global만료/잘못된 lease·payload·hash는40001이다. 이 키로 별도 retry job이나 새로운 report를 만들지 않는다.

`purge_report_retention_terminal_receipts(p_global_token uuid,p_limit integer default20)` → exact1 `{purged}`.

- 만료 terminal 행만 DBclock/현재 global fence를 양끝에 검사해 최대20개 파기한다. 신규7번째 RPC이며 EXEC는 기본폐쇄다.
- C80의 report readiness는 guard=true와 enqueue/claim/check/getACK/recordACK/complete/terminal purge **7개 service EXEC** 모두 준비된 경우뿐이다. 하나라도 누락되거나 singleton 행이 없으면 새 report job 점유0이다. 신규 claim_supported_job4 자체도 별도 EXEC가 폐쇄되어 있다.
- 현재 J 실행 cycle/maintenance callback/terminal 만료 wake는 미연결이다. 향후 global 획득 후 terminal purge→enqueue→scoped claim→task drain을 공유20 작업 예산 안에서 연결하거나 별도 승인 예약 경로를 실제 검증해야 한다. 7개 EXEC 준비는 자동 dispatch 완료 증거가 아니다.

## Storage 경계와 이름 재사용

삭제 전 정보 조회의 objectId가 task.objectId와 일치하고 bucket/name이 원 asset metadata와 일치해야 한다. MIME/크기는 현재 신고 캡처 계약의 JPEG/PNG/WebP 및 최대5242880바이트(5MiB)를 따른다. 확장자와 MIME 일치, metadata size의 숫자형·양의 정수·상한 조건도 실제 metadata와 함께 확인한다. metadata가 없다는 사실만으로 이전 DELETE 성공을 추정하지 않는다. 같은 이름에 다른 objectId가 있으면 `object_replaced`로 실패하며 새 객체를 지우지 않는다.

Storage API가 이름 기반 DELETE만 제공한다면 info→DELETE 사이 이름 재사용 경합도 해결해야 한다. 현재 경로 재사용 금지·쓰기 gate와 동일 객체의 신규 업로드/교체 차단을 실제로 검증해야 한다. 단순 사전 info 확인만으로 원자적인 objectId 조건부 DELETE라고 주장하지 않는다. 그 보장이 없으면 external guard는false를 유지한다. report metadata는 attached를 완료된 파일처럼 꾸미거나 새 object를 원 task에 채택하지 않는다.

원 Storage owner가 탈퇴해도 report 목적이 준비되기 전 파일을 회원 cleanup으로 삭제하지 않는다. 삭제 역할이 profile/current Naver 자격에 의존해서는 안 되며, 보고서의 검증된 원 첨부를 처리하는 전용 권한만 사용한다. staff 열람 권한이나 DB raw chat 접근을 worker에 추가하지 않는다.

## known/unknown 응답과 복구

| 관측 | 처리 |
|---|---|
| DELETE200 exact 객체 ACK와 fence 기록 성공 | 인증 재조회404·DB metadata 부재 후 complete 검증 가능 |
| storage ACK durable 후 아직 완료 전 장애 | 새 유효 task/job/global lease로 ACK 조회·부재 재검증; 재DELETE 불필요 |
| metadata 완료 응답 유실 | 새 유효 global로 원 terminal receipt·succeeded job·원 lease/hash를 읽기 재생; 별도 complete_job 재호출 금지 |
| DELETE 응답 유실 또는 ACK 기록 전 장애 | unknown. metadata404만으로 성공 처리하지 않음 |
| timeout/abort/음수 client 종료 | 원격 완료를 추정하지 않고 journal/FAIL 보존, 자동 mutative cleanup·재실행 금지 |
| 다른 objectId/다른 task/만료 fence/원 종결 변경 | state conflict로 실패; 다른 객체 삭제·완료 금지 |
| provider 재조회401/403/5xx | 404로 취급하지 않고 실패 |

provider가 abort를 무시해도 종료·삭제 완료 증거가 아니다. root 승인 복구는 원 task/UUID/ACK·진짜 원격 상태를 별도 확인한 뒤 수행하며 자동 정리와 구분한다. SQLSTATE40001/PT404/42501/55000 등의 HTTP 상태는 기존 transport와 실제 upstream 관측에 따라 검증한다. 특히55000을 무조건503이라고 단정하지 않는다.

A79 실제 terminal row는 task/report/closure/job UUID·원 task/job lease UUID·evidence hash·원 completedAt/expiresAt만 보존하고 신고 원문·첨부 이름/경로를 재보관하지 않는다. 기존 작업 상세30일 이후 실제 terminal purge로 지우며 새로운90일이나 영구 tombstone을 만들지 않는다. 제재 최소 identity의 별도 수명은 이 terminal 계약과 혼동하지 않는다. 기존 백업의 바이트 삭제까지 완료됐다고 안내하지 않는다.

## 잠금·원자성·권한 검증 계획

- 기존 global/job fence와 task row를 먼저 보호하고, report/asset/관련 목적의 락 순서를 고정한다. source76/77의 member guard→AP/result→report 및 직원 assignment/session 경계와 역순 대기가 생기면 명시 NOWAIT/40001로 whole TX rollback한다. 문서만으로 deadlock-free라 주장하지 않는다.
- dequeue/claim/check/ACK/complete 모두 server DBclock으로 task/job/global 만료를 확인한다. 중간 trigger·대기 후 만료는 receipt/metadata/완료 표식을 전부 rollback한다.
- guardfalse, EXEC 하나 누락, gateway role 상속/SET 경로, 원문 table grant/RLS 우회를 catalog와 실제 synthetic SQL로 검사한다. owner-only provision을 staff/회원에게 열지 않는다.
- attached 파일의 member upload/cancel/delete guards, report_id RESTRICT, 이의 reviewing 종결/DELETE 거절, report 최종90일·목적 held·탈퇴 첨부 열람을 실제 회귀로 확인한다.
- 두 session: final-close/correction↔claim, 새 첨부↔finalize, 승인/목적 변경↔check, lease/global expiry↔ACK/complete, 이름 재사용↔DELETE, 동일 ACK/complete 재시도를 실제 PID barrier와 원 rollback으로 검증한다.
- 실제 격리 Storage: exact DELETE200→ACK→authGET404, ACK 이후 응답 유실 복구, ACK 없는404 실패, objectId 교체 거절, uploaded/attached metadata와 binary 일치 및 모든 자체 fixture 정리를 검증한다. 원 운영 객체와 DB는 수정하지 않는다.
- before/after 전체 catalog·counts·ACL/roles·Auth audit ID/payload·files·guard·worker·cron·보호 컨테이너·활성 TX0를 검사하고 원 FAIL/unknown 자료를 보존한다. actual final-close/파기 엔진·워커 연결·운영 승인 증거는 따로 필요하다.

## J 연결 요청과 다음 단위

J 소유 jobs/queue-runner/background는 신규 kind의 exact payload·공정성·예약 조회·작업 dispatch 지원을 별도 검토한다. 실제 SQL에 존재하고 guard/ACL 준비가 검증되기 전 supportsRpc=true나 자동 due 성공을 선언하지 않는다. 전역 점유180초의 기존 DTO를 바꾸지 않고 budget·Abort·task lease를 보수적으로 사용하며 소유한 기존 워커 경계에서 연결한다. 원문 없는 wake만 사용하고 빈 준비 상태를 hot loop로 만들지 않는다.

M 후속 최소 단위는 검증된 최종 종결 권한 포트→DB 후보의 정식 적용→기존 reports 책임의 전용 Provider 어댑터→J dispatch/terminal maintenance→격리 실제 Storage/FK/경합 회귀다. 일반7일 anchor·숨김 파기후 지속·활성 제재 공유 증거 목적이 불분명한 분기는 held로 남기며 사용자 정책을 새로 정하지 않는다. 운영 파기 승인과 백업/법적 확인은 별도다.

## source78 실제 증거의 정확한 범위

root 실제 scratch v2 receipt `54e8de8a30b287a7c263b203d5a630d5cd8e74f437a1e90b0598dd9a4840e3a8`는12 시나리오 PASS, 전체 fixture 복원true, uncertain=false, persisted baseline 보존true다.5개 barrier 기록은 실제 PID blocking3개와 DBclock 관측2개이다. 모든12개가 대기 장벽은 아니다. TTL은 member guard의 account 대기 중 만료이며 report SHARE 증거가 아니다. 원 due-first statement 접수시각·원24h와 rejected 원 application 시계는 별도 assertion으로 확인했다.

이 실행의 scratch Auth audit baseline ID는0이며 native288개 직접 검증과 구분한다. archived native proof의 바이트 불변을 확인했을 뿐이다. Storage metadata와 합성 ended episode를 사용했고 실제 OAuth/Providerbinary/탈퇴·재가입/90일 파기 엔진·운영은 입증하지 않았다. 원 FAIL13ad/882/5a7dc/c950와 v1 재현78858은 보존됐다. 현재 진행률63.5%를 이 문서나12 PASS만으로 올리지 않는다.

## source79+80 후보 실제 검증과 남은 범위

root receipt `/private/tmp/yumidang-report79-claim80-single-tx-reviewed/receipt.json` SHA `f4480057255cb7fa733b8504e5943a0a91a1001aba4375b34ec0f0aafec6c0a3`: scope candidate79_80_on_native78_single_tx_rollback, sqlExit0/PASS, checks8=true, remoteCompletionUncertain=false, autoRetry=false, migrationCommitted=false다. 기존 정식78 proof·전체 catalog/count/policies/Auth audit288·roles/ACL·파일0·보호 컨테이너·활성 TX0와 폐쇄 cleanup 경계를 복원했다. 합성 owner Storage metadata 삭제와 ACK/evidence hash fixture이지 실제 Provider DELETE/물리 bytes 제거가 아니다.

검증 후보 A79 SQL c5b801c0f31dd8f058aafd844f90b5531cd582c7f668cc6703b0b01b3ce14a91 / 회귀 f1fcbe5a967addec547634ef55346f5af0191326bb045bab4fe73f745f26ad8c, C80 SQL bbe43a5adaef287145d832a37353c9c32991a813663b28975f8c1d5ad532fa8b / 회귀 de05e67454e3bc9851013af1d8bbbfcfd3cf4fd26f22f38227df779c228706f8를 사용했다. 정식79/80 적용·Provider exact DELETE/응답유실 복구·lease 종료 뒤 in-flight 및 이름 재사용 TOCTOU·새 두 세션·J/HTTP/mobile/운영은 아직 NOT_RUN이다. 기존 SQL-only PASS를 실제 파기 완료로 확대하지 않는다.
