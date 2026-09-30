# 2026-09-29 lane S 기록 — 후기 요약 중간 저장·worker·24시간 실행 (설계 5.5·5.6)

작업자: jonghyun. lane S 에이전트가 SQL·저장소·worker·일일 실행 코드를 작성하던 중 **사용 한도로 중단**(테스트 작성 초입)되어, 총괄이 남은 코드를 검토하고 검사·이 기록을 작성했다. 커밋·푸시·원격 DB·배포 없음. 기존 미커밋 파일 중 `scheduled-jobs/index.ts` 한 개만 확장했고, 변경 전 사본의 SHA256이 시작 기준선과 같음을 확인했다(기존 maintenance 동작 보존, 기존 `scheduled-jobs.test.mjs` 8/8 무수정 통과).

## 구현

| 파일 | 내용 |
|---|---|
| 제안 SQL [03_review_summary_worker.sql](2026-09-29-claude-proposed-sql/03_review_summary_worker.sql) | `worker_jobs.failed_attempts`(점유 횟수 `attempt`와 분리), 종결 `failed`/`superseded`, `yield_job`(실패 미증가), `retry_job`(실패 +1), `fail_job`/`supersede_job`(종결+중간 저장 삭제), `complete_job`(중간 저장 삭제). 비공개 `review_summary_checkpoints`(형태 검사로 원문 사본·임의 키 거절), `review_summary_job_publications`(게시 표식). 점유 확인 RPC: `load_review_summary_source`, `load/save/discard_review_summary_checkpoint`, `mark_review_summary_insufficient`, `publish_review_summary_for_job`. 원문 변경으로 revision이 오르면 같은 트랜잭션에서 옛 revision 중간 저장 삭제(기존 outbox 보존) |
| `_shared/db/repositories/jobs.ts` | `createRpcJobRepository(db)`: claim 매핑(profileId→targetUserId, leaseExpiresAt→leaseUntil, failedAttempts), settle 매핑(succeeded→complete, queued→yield, retry_wait→retry, failed→fail, superseded→supersede), 오류 코드 명시 변환, state_conflict→lease_lost, `JOB_RPCS` |
| `_shared/db/repositories/review-summaries.ts` | `createRpcReviewSummaryRepository(db)`: reviewId→evidenceId, text→comment, bigint revision 문자열 유지, 상태 값 변환 |
| `_shared/ai/Agents/review-summary/orchestrator.ts` 외 | `budget_exhausted` 결과 추가(BUDGET_EXHAUSTED·확인된 DAILY_QUOTA_EXHAUSTED): 추가 모델 호출 없이 멈추고 중간 저장 보존, 실패 아님 |
| `_shared/jobs/registry.ts`·`lease.ts` | 예산 소진 → `REVIEW_SUMMARY_BUDGET_DEFER_MS`가 있으면 그 시각으로 yield(queued+retryAt, 실패 미증가), 없으면 즉시 yield + 중단 사유. 실행 결과에 정형 `reason` |
| `review-summary-worker/handler.ts`·`index.ts` | POST 내부 인증, 빈 본문만. 설정·버전·모델(`createConfiguredModel`)·**승인된 안전 검사기**·RPC 접근 확인(부작용 없는 probe) 중 하나라도 없으면 점유 없이 `not_enabled`. 실행당 `maxJobsPerRun`·`timeBudgetMs` 안에서 `runNextJob` 반복(정상 양보는 같은 실행에서 이어감, 무한 즉시 재점유 없음). 요청 모델 버전과 조립된 모델 표식이 다르면 점유하지 않음 |
| `_shared/jobs/daily.ts`, `scheduled-jobs/*` | `POST /functions/v1/scheduled-jobs/daily {limit}`: ① 기존 maintenance(공개 정리+요약 등록, 모델 무관) ② 설정된 공급사·기간(설정 시간대 날짜부터 N일)·최대 페이지만큼 event-sync ③ worker를 명시 최대 횟수 안에서 남은 작업이 있을 때만 재호출. 단계 독립, 단계별 상태, 실패를 0건 성공으로 숨기지 않음 |

**운영 기본값 없음:** 안전 검사기 `APPROVED_SUMMARY_SAFETY_CHECKER = null`(검사 방법·품질 기준 미확정). 따라서 현재 제품 worker는 `SAFETY_CHECK_NOT_APPROVED`로 작업을 점유하지 않는다. 방치된 중간 저장의 TTL 삭제는 만들지 않았다(팀 검토).

## 검사 결과(총괄 실행)

| 검사 | 결과 |
|---|---|
| `run_proposals.py --proposal 01 --proposal 03 --test review_summary_worker.sql`(ROLLBACK) | PASS |
| `summary-repository.test.mjs` 9, `jobs.test.mjs` 20, `review-summary-worker.test.mjs` 5, `daily-run.test.mjs` 6, `scheduled-jobs.test.mjs` 8, `review-summary.test.mjs` 19 | 전부 PASS(가상) |
| 제안 적용 DB에서 `summary-worker-concurrency.mjs`(실제 2세션) | PASS: 동시 점유 1건, 동시 중복 게시 멱등(요약·표식 1개·같은 시각), 게시↔비공개 전환 경쟁 후 표시 요약 없음/현재 revision 일치 |
| 제안 적용 DB에서 `summary-worker-rest.mjs`(PostgREST+가상 모델) | PASS: 등록→정상 양보 여러 번→병합→원자 게시→완료, 실패 0, 모델 3회 |
| 민규 SQL 8개 회귀(제안 없음/전체 적용) | 둘 다 PASS |

## 열린 사항

- 실제 cron 등록·시작 시각/시간대·limit(운영 결정), 방치 중간 저장 보관기간(팀 검토), 안전 검사 방법(첫 합성 결과 공동 검토 후).
- worker는 매 실행 시작 때 부작용 없는 RPC 접근 확인 9회를 호출한다(허용 목록 누락 시 점유 전 중단 목적). 운영 비용이 문제면 캐시 여부를 결정한다.
