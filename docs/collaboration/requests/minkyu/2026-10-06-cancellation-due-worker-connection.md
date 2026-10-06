# 취소 자동 제재 작업의 실제 실행 연결 요청

작성자: 민규(`minkyu`). 현재 로컬 정식78/실제 API38 검증과 실제 상주 실행 연결을 구분한다. 이 요청은 종현 파일의 직접 수정·외부 메시지 전송·운영 배포·권한 개방 승인이 아니다.

## 2026-10-06 순차 실행 갱신

정식 로컬 DB는82개이며 후속83 예약 조회·84 새 취소 기한 세대는 함께 단일 TX 회귀 PASS/전체 원복을 확인했다. 정식 적용은 별도다. `claim_job`의 현재 기본 소비 범위는 review_summary뿐이다. 취소/신고 소비자는 `claim_supported_job(worker_id,lease_seconds,worker_run_token,supported_kinds)`를 명시 사용해야 한다. 아래 원78 설명의 무필터 claim 안내는 과거 기록이다.

민규 internal-client에 `read_worker_run_budget`를 통합했다. exact1 `{remainingMs}`와 원 `{p_worker_run_token}`을 사용하며 실제 로컬 서비스 권한을 검증 동안만 열어 잔여 예산·타인 토큰 거절·동일 토큰 만료 비연장·해제를 검증했다. 검증 후 EXEC는 다시 닫혀 있다. 영수증 `/private/tmp/yumidang-worker-budget-native84-v2-reviewed/receipt.json` PASS이며 상주 소비자/재시작 증거는 아니다.

83 조회는 exact3와 빈 `yumidang_worker_jobs` wake를 유지하고 종류5개를 읽는다. 실제 회귀 `/private/tmp/yumidang-schedule-generation84-v4-reviewed/receipt.json` PASS다. 84는 새24시간 기한에만 generation+1, 같은 기한/기한 제거는 원 generation 유지, 상한 초과 전체 rollback이다. process 결과의 generation은 현재 실행한 원 job 세대이며 다음 예약 세대가 아니므로 소비자가 반환 세대로 새 job을 임의 생성하지 않는다.

신고 Storage 정상 경로는 실제 로컬 삭제1회·durable ACK·인증 조회 부재·추가 DELETE 없는 ACK 복구·메타데이터 완료/원복 PASS다. `object/info`의 `size`·`content_type`을 검증하며 `metadata`는 사용자 입력으로 취급한다. 실제 API `v1.70.3` 영수증 `/private/tmp/yumidang-retention82-normal-BgMcm2/result.json`를 확인한다.

종현 파일은 이 실행에서 수정하지 않았다. 기존 queue-runner의 모든 비-event kind를 review-summary-worker URL로 보내는 fallback은 취소/신고 연결 완료 조건을 충족하지 않는다. 기존 담당 파일에서 종류별 명시 dispatch와 지원 종류 점유를 구현한 뒤 실제 혼합 큐·공유180초·공유20회·응답 유실 자동 재전송0·재접속/누락 처리/정상 종료를 함께 검증해야 한다. terminal30일 유지관리 timer/공유 예산 연결도 별도 남아 있다. 역할·guard·EXEC를 열기 전에 소비자 준비를 확인한다.

## 확인된 이전 상태

- source78의 `cancellation_safety` job payload는 정확 `identityId` UUID와 `generation` 정수(1~MAX_SAFE_INTEGER)다.
- `enqueue_cancellation_safety_due(p_limit integer,p_worker_run_token uuid)`는 `{enqueued}`를 반환한다.
- `process_cancellation_safety_due(p_identity_id uuid,p_expected_generation bigint,p_job_id uuid,p_job_lease_token uuid,p_worker_run_token uuid)`는 `status,generation,changed`를 반환한다. 상태는 `not_due|policy_pending|held|applied`이며 정책 판단은 DB가 한다.
- 실제 현재 `cancellation_due_control.enabled=false`이고 두 RPC의 실제 작업 호출 권한은 닫혀 있다. 수동 owner fixture 검증을 상주 실행 완료로 보지 않는다.
- 기존 `claim_job(worker_id,lease_seconds,worker_run_token)`에는 kind 필터가 없다. summary 전용 consumer가 cancellation job을 점유하고 처리하지 못하는 조합을 허용하면 안 된다.
- 일반 이의7일·무신고 자동 통지의 목적/파기·정정 새 anchor 시계·종료 회차 최초 효과의 미정은 별도 정책 결정이며 작업 실행기가 임의 확정하지 않는다.

## 종현 담당 연결

| 대상 | 필요한 변경 |
| --- | --- |
| `backend/supabase/functions/_shared/db/repositories/jobs.ts` | 새 kind와 exact2 payload decode, generation 범위, 지원 kind claim/settle 계약 |
| `_shared/jobs/enqueue.ts`, `lease.ts`, `registry.ts` | 새 kind 정규화·실행 등록·DB 정형 결과 처리. summary handler로 대체하지 않음 |
| `_shared/jobs/background.mjs` | 새 due wake/공정한 차례·pause 제외. 빈 due 큐에서 즉시 반복 호출하지 않음 |
| `scheduled-jobs/queue-runner.mjs` | event 외 모든 작업을 summary URL로 보내는 fallback 제거. kind별 명시 dispatch·알림 채널 구독/재접속 |
| `scheduled-jobs/handler.ts`, `index.ts` | 내부 인증 후 global 점유→enqueue→정확 claim→process→complete. 회원/직원 HTTP 권한을 worker 권한으로 사용하지 않음 |
| `_shared/jobs/settings.ts`, `retry.ts` | kind별 lease/retry 정형 계약. 원문·회원 payload 로그 금지, 응답 불확실 시 판정 호출 자동 재시도 금지 |

축약 경로의 공통 앞부분은 `backend/supabase/functions/`다. 기존 책임 파일을 채우며 중복 실행기 폴더를 만들지 않는다.

## 민규 담당 연결

- `_shared/db/internal-client.ts`의 exact RPC 허용 목록·입력/출력 계약을 연결한다.
- 공유 claim의 지원 kind 범위를 DB와 소비자 양쪽에서 합의한다. 새 kind를 모르는 소비자가 점유하지 못하는 구조를 먼저 실제 검증한다.
- 후속 migration에서 필요한 실행 역할·두 RPC의 제한된 EXECUTE·큐 스케줄의 generation/next_due_at/wake/paused-kind 관계를 구현한다. 기존 함수/자료/권한을 보호한다.
- `20261005040100_worker_queue_schedule.sql`의 기존 summary/event/member_cleanup 계약을 보존하며 취소 due의 별도 일정·알림 `yumidang_cancellation_due`와 연결한다.
- 위 검증과 통지/정책 조건이 충족되기 전에는 현재 guard와 ACL을 열지 않는다.
- 실제 service-api 환경에서 정책4000자의 UTF-8/escaped JSON을 수용하도록 65536바이트 이상의 명시 설정을 검증한다. 현재 native78 테스트 설정65536은 배포 환경 증거가 아니다.

## 완료 검증

1. summary/cancellation 혼합 큐에서 지원하지 않는 consumer의 잘못된 점유0.
2. 낡은 generation, 만료 job/global, 재점유·동시 실행에서 변경0 또는 정확 rollback.
3. 성공한 process와 같은 현재 fence의 complete로 lease와 job fence 제거. stale token으로 완료 불가.
4. 여러 인스턴스의 차례·LISTEN 재접속·pause·빈 큐 no-spin. source78 `not_due|policy_pending|held`의 재호출/차단 계약 구분.
5. 실제 runtime 환경과 한국어/emoji4000·escaped4000 수용,4001 정책 거절, 바이트 상한413.
6. 실제 상주 runner 재접속·중단/재시작·원문 없는 로그·전체 자기 fixture 정리.

로컬 두 세션과 실제 API의 성공은 위 상주 연결 검증을 대신하지 않는다. Railway 서비스와 환경 확인 후 운영 실행·배포 범위는 별도 단계에서 검증한다.

## 후속 민규 source 연결 상태

두 due RPC의 내부 전송 허용 목록과 원서비스JWT/인자·권한 거절·timeout 모형검증을 통합했다. 실제 RPC EXEC·due guard는 열지 않았다. 실제 factory API38/요청163은 당시8122 실행 graph 증거이며 이후 내부 allowlist 변경96ef source는 별도 파일 준비 결과다. J dispatch·mixedkind 보호·상주 성공을 전송 목록만으로 완료 표시하지 않는다.

기존 claim2/3의 종류 필터 부재를 보완한 source80을 통합했다. source79+80과 각 회귀는 실제 native78 한 트랜잭션에서 실행·전체 롤백 PASS이며 영속 DB 이력은78개다. `claim_supported_job(p_worker_id uuid,p_lease_seconds integer,p_worker_run_token uuid,p_supported_kinds text[])`는 지원 종류를 점유 전에 제한한다. 허용 종류는 `review_summary`, `cancellation_safety`, `report_retention`이며 비어 있음·중복·NULL 원소·다차원·미지원 종류는22023이다. 기존 claim2/3은 리뷰만 점유하며 claim2도 유효 전역 점유가 필요하다. 원 OID·owner·ACL·설정은 유지한다. 신규 RPC 실행 권한은 닫혀 있고 실제 배포는 후속이다. J는 consumer가 실제 지원하는 종류만 명시해야 한다. 반환 wire7과 `{job:null}`은 유지한다.

report 종류의 payload는 정확 `{reportId,closureProofId}`다. [파기 계약](2026-10-06-report-retention-purge-contract.md)에 따라 metadata task 성공은 DB 내부에서 complete_job까지 처리하므로 J가 다시 완료하지 않는다. 첨부 task 완료는 parent job을 running으로 유지한다. 보고서 신규 점유는 guard와 Storage용6 RPC 및30일 terminal 증거 파기 RPC 총7개 service 실행 권한이 모두 준비됐을 때만 가능하다. 실제 dispatch·terminal 정리/만료 wake·원 요청 journal·불확실 DELETE 보존·지연 요청 안전성·종류 간 공정성은 별도 연결·검증 대상이다. 전송 허용 목록이나 합성 SQL PASS만으로 상주 실행을 완료 표시하지 않는다.


## 현재 종현 연결 누락 — 소스 읽기 감사 (2026-10-06)

최신 SQL80의 기존 `claim_job`은 요약만 점유하므로 다른 종류를 선점하는 문제로 설명하지 않는다. 현재 누락은 신규 소비자·선택·통지 연결이다. 아래 종현 파일은 읽기만 했으며 민규가 편집하지 않았다.

| 종현 파일 | 필요한 연결 |
|---|---|
| `_shared/db/repositories/jobs.ts` 7·48·132~151행 | 요약 payload 한정과 기존 claim 호출을 유지 중이다. 지원 종류를 명시한 claim_supported_job과 취소 exact2/report exact2 payload decoder가 필요하다. |
| `_shared/jobs/enqueue.ts` 16~40행 | 신규 종류의 dedicated enqueue RPC를 사용하고 generic 중복 enqueue를 만들지 않는다. |
| `_shared/jobs/registry.ts` 48~49행·lease.ts 7·33행 | 취소due·신고retention 소비자를 등록해야 한다. |
| `_shared/jobs/background.mjs` 56·105·111~115행 | 신규 종류를 readiness와 결합하고 외부 결과 UNKNOWN이면 실패 처리/전역점유 해제/자동 재전송하지 않는다. |
| `scheduled-jobs/queue-runner.mjs` 6·109·144~174행 | cancellation wake channel과 신규 종류 dispatcher 연결이 필요하다. |
| `scheduled-jobs/index.ts` 101~122행 | 취소due enqueue·신고retention enqueue·terminal receipt 유지 처리 연결이 필요하다. |
| `_shared/jobs/lease.ts` 60~65행·retry.ts 30~35행 | terminal UNKNOWN을 일반 실패로 settle/retry하지 않고 journal·intent·예약을 보존한다. |

위 경로는 `backend/supabase/functions/` 아래다. 민규는 applied `20261005040100_worker_queue_schedule.sql`을 고치지 않고 후속 migration에서 selector/준비조건/통지/공유 DBbudget을 연결한다. `read_worker_run_budget`의 공통 internal-client 허용 목록과 일일 처리 연결은 민규 연결 사항이다. 전용 `createMemberCleanupBudgetReader`는 정확1개 인자·왕복 시간 차감·clock/signal 처리가 이미 구현돼 있어 전체 미구현으로 표시하지 않는다. report enqueue의20개 상한은 reports 기준이며 task drain은 공유20개/남은 DBbudget 범위로 별도 계산해야 한다. metadata task는 DB가 parent `complete_job`을 원자 처리하므로 소비자가 다시 완료하지 않는다.

전송 의도 연결5파일의 root 모형32·타입5 PASS는 상주 실행을 허용하는 증거가 아니다. SQL81/82의 실제 롤백 회귀는 PASS이나 정식 DB는80이고 Provider와 신규 소비자는 미검증이다.


후속 확인: SQL81/82는 격리 로컬에 정식 적용 PASS했고 실제 이력82·미적용0이다. 영수증 SHA `db9a5bad3975e2df984de7832a4b06e1d5b8a258bb69df086c5452a4b4ff3765`다. 실행 제어/서비스EXEC는 닫힌 상태이며 위 소비자·selector·Provider 연결 누락은 그대로 남아 있다. 운영 적용0이다.


실제82에서 동일 generation의 완료 job을 남기고 새 due 도래 시각을 두면 enqueue가0이 되는 결함을 합성 단일TX로 재현했다. 전체 롤백/자료·권한 보존 PASS 영수증 SHA `56c97707084e47c90dc214a9c2e98a9862ab07c8107c22ab44950b8b12076bff`다. owner fixture의 기계적 dedupe 검증이며 실제24시간 정책 결과를 뜻하지 않는다. source83 private 후보도 이 결함 해결·terminal 유지관리·J 연결을 완료했다고 주장하지 않는다. 현재 작업 마무리 후 정지하라는 사용자 요청에 따라 후속 수정/적용은 보류했다.
