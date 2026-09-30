# 종현 → 민규 변경 요청 (2026-09-29 Claude 구현분 통합)

작성: 종현 범위 구현(Claude). 민규 소유 파일은 직접 수정하지 않았다. 아래가 반영되기 전까지 새 AI 탐색·요약 worker·행사 저장/조회의 **실제 런타임은 안전하게 비활성(unavailable / not_enabled / 500)** 상태다. 외부 메시지는 보내지 않았다. 세부 근거는 lane별 기록([C](2026-09-29-claude-lane-c-notes.md), [E](2026-09-29-claude-lane-e-notes.md), [S](2026-09-29-claude-lane-s-notes.md))과 [전체 인계](2026-09-29-claude-implementation-handoff.md)를 따른다.

## R1. 제안 SQL 4개의 정식 마이그레이션 채택

| 순서 | 제안 파일 | 내용 | 권한 |
|---|---|---|---|
| 1 | [01_ai_budget.sql](2026-09-29-claude-proposed-sql/01_ai_budget.sql) | AI 호출 예산 원장·예약(원자 예약/정산, 사용량 불명은 예약 전체 소비) | service_role |
| 2 | [02_profile_traits.sql](2026-09-29-claude-proposed-sql/02_profile_traits.sql) | `private.profile_traits`, 본인 성향 저장/조회, 공고 작성자 성향 조회 | authenticated(익명 28000) |
| 3 | [03_review_summary_worker.sql](2026-09-29-claude-proposed-sql/03_review_summary_worker.sql) | 작업 큐 실패 횟수 분리·종결 상태, 비공개 중간 저장, 점유 확인 요약 RPC, 원자 게시·멱등 표식, 원문 변경 시 중간 저장 삭제 | service_role |
| 4 | [04_events.sql](2026-09-29-claude-proposed-sql/04_events.sql) | `private.events`, `upsert_events`(service_role), `list_public_events`(anon·authenticated) | 표 참조 |
| 5 | [05_event_filter_values.sql](2026-09-29-claude-proposed-sql/05_event_filter_values.sql) | 행사 필터 값 목록(제공처별 지역·분류 원문 값, 취소만 가진 값 제외) — 사용자 결정 U9 | anon·authenticated |

- 파일에는 BEGIN/COMMIT이 없다. 채택 시 감싸고 `20260929120000` 뒤 버전으로 둔다. 03은 기존 `worker_jobs_status_check`, `worker_jobs_check1` 제약 이름을 교체하고 `claim_job`·`complete_job`·`retry_job`·`private.invalidate_appointment_review_summaries`·`private.refresh_review_summary_state`를 `create or replace`한다(기존 outbox 동작 보존).
- **실제 검증(2026-09-30, 전용 로컬 DB):** 28개 + 제안 4개를 처음부터 재생 PASS. 제안 적용 상태에서 `tools/local/run_database_tests.py --run` PASS(SQL 7 + 동시성 6), `review-policy-e2e.mjs` 8/8, 종현 SQL 4개·실제 다중 세션 2개·PostgREST 경유 3개 PASS. 원격 DB 적용은 NOT_RUN.
- 완료 조건: 정식 SQL로 로컬 재생 + `python3 -B tests/database/jonghyun/run_proposals.py --all`이 제안 없이도(정식 적용 후에는 `--proposal` 없이 `--test`만) PASS.

## R2. RPC 허용 목록

| 대상 | 추가할 이름 | 이유 |
|---|---|---|
| `_shared/db/internal-client.ts` | `reserve_ai_budget`, `settle_ai_budget`, `yield_job`, `fail_job`, `supersede_job`, `load_review_summary_source`, `load_review_summary_checkpoint`, `save_review_summary_checkpoint`, `discard_review_summary_checkpoint`, `mark_review_summary_insufficient`, `publish_review_summary_for_job`, `upsert_events` | 예산 예약(ai-chat·worker), 요약 worker, event-sync 저장. 현재는 전송 전 `ACCESS_DENIED` → ai-chat unavailable, worker `DB_RPC_NOT_ALLOWED`, event-sync 500 |
| `_shared/db/user-client.ts` | `get_post_author_traits`, `get_my_profile_traits`, `set_my_profile_traits`, `list_public_events`, `list_event_filter_values` | AI 탐색 후보 성향·본인 성향, S15-2 저장, 회원 행사 조회 |
| `_shared/db/public-client.ts` | `list_public_events`, `list_event_filter_values` | 비로그인 행사 조회 |

운영 코드는 이 목록을 우회하지 않는다(테스트만 전용 허용 목록 transport를 명시적으로 만든다). 완료 조건: `tests/functions/jonghyun/ai-chat-http.test.mjs`·`review-summary-worker.test.mjs`·`event-sync.test.mjs`의 “허용 목록 대기” 기대값을 성공 기대로 바꿔 통과.

## R3. HTTP 경로·함수 설정

- `service-api`: 공개 `GET /events`(인증은 공고 검색과 동일, 쿼리 ↔ `createRpcEventRepository(db).listPage`), S15-2·S06 성향 저장 경로(`set_my_profile_traits`; 22023→400, P0002→404, 28000→401). 상세 계약은 lane E M4, lane C 4절.
- **2026-09-30 사용자 결정 U13:** 성향 전용 조회는 유지하고, **공개 프로필(S14) 응답에만 성향(관심사·대화 방식·MBTI)을 추가**한다. `get_my_profile`은 바꾸지 않는다.
- `config.toml`/배포: `ai-chat`(회원 JWT), `places`(회원 JWT), `event-sync`·`review-summary-worker`·`scheduled-jobs`(내부 비밀 Bearer — gateway JWT 검사와 충돌하지 않게) 등록. 기존 gateway CORS PARTIAL은 여전히 미해결이다.
- 일일 실행 등록: `POST /functions/v1/scheduled-jobs/daily {limit}`을 **매일 00:01 Asia/Seoul**(사용자 결정 U4)에 호출하는 cron(pg_cron+net 또는 외부 스케줄러). limit과 운영 수치는 [운영값 제안](2026-09-30-operational-values-proposal.md) 검토 후 확정. `TOUR_API_KEY_FORMAT=decoded`도 운영 환경에 입력. 중복 호출은 DB dedupe·upsert·점유로 무해하다(가상 검사).

## R4. 환경 변수 이름(`.env.example`·배포 주입, 값 없음)

- 모델: `AI_RETENTION_DECISION_ID`(팀 보관 검토 결정 참조), `AI_COST_EVIDENCE_ID`(추가 지출 0원 계정 근거 참조), `AI_BUDGET_LEDGER_ID`, 선택 `POTENS_USAGE_INPUT_FIELD`/`POTENS_USAGE_OUTPUT_FIELD`(확인된 token_usage 필드명). 기존 `POTENS_API_KEY`·`POTENS_API_BASE_URL`·`POTENS_MODEL`·`UPSTREAM_TIMEOUT_MS`.
- AI 탐색: `AI_CHAT_MAX_MESSAGES`, `AI_CHAT_MAX_MESSAGE_CHARS`, `AI_CHAT_MAX_TOTAL_CHARS`, `AI_CHAT_MAX_OUTPUT_TOKENS`, `AI_CHAT_SEARCH_PAGE_SIZE`, `AI_CHAT_MAX_SEARCH_PAGES`, `AI_CHAT_RECHECK_MAX_PAGES`, `AI_CHAT_MAX_RESULT_CARDS`, `AI_CHAT_MATCH_BATCH_SIZE`, `AI_CHAT_MAX_MATCH_CALLS`, `AI_CHAT_MATCH_MAX_OUTPUT_TOKENS`.
- 요약 worker: `REVIEW_SUMMARY_WORKER_MAX_JOBS_PER_RUN`, `REVIEW_SUMMARY_WORKER_TIME_BUDGET_MS`, `REVIEW_SUMMARY_LEASE_SECONDS`, `REVIEW_SUMMARY_RETRY_MAX_ATTEMPTS`, `REVIEW_SUMMARY_RETRY_BASE_DELAY_MS`, `REVIEW_SUMMARY_RETRY_MAX_DELAY_MS`, `REVIEW_SUMMARY_BUDGET_DEFER_MS`, `REVIEW_SUMMARY_MAX_INPUT_CHARS`, `REVIEW_SUMMARY_MAX_REVIEWS_PER_CHUNK`, `REVIEW_SUMMARY_MERGE_FAN_IN`, `REVIEW_SUMMARY_MAX_OUTPUT_TOKENS`, `REVIEW_SUMMARY_MAX_OUTPUT_CHARS`, `REVIEW_SUMMARY_MAX_CALLS_PER_STEP` + 기존 `REVIEW_SUMMARY_MODEL_VERSION`(모델 표식 `potens.<POTENS_MODEL>`과 같아야 함)·`REVIEW_SUMMARY_PROMPT_VERSION`.
- 장소·행사: `PLACES_PAGE_SIZE`, `EVENT_SYNC_PROVIDERS`, `EVENT_SYNC_MAX_PERIOD_DAYS`, `EVENT_SYNC_MAX_PAGE`, `EVENT_SYNC_PAGE_ROWS`.
- 일일 실행: `EVENT_SYNC_DAILY_PROVIDERS`, `EVENT_SYNC_DAILY_TIME_ZONE`, `EVENT_SYNC_DAILY_WINDOW_DAYS`, `EVENT_SYNC_DAILY_MAX_PAGES`, `EVENT_SYNC_DAILY_TIMEOUT_MS`, `DAILY_SUMMARY_WORKER_MAX_INVOCATIONS`, `DAILY_SUMMARY_WORKER_TIMEOUT_MS`.

모든 수치에 기본값이 없다. 없으면 해당 기능이 not_configured/unavailable이며 다른 기능(특히 후기 공개)은 막지 않는다.

## R5. 민규 소유 계약 문서 동기화

`worker-jobs.md`(kind 확장 없음, `failed_attempts`·`failed`/`superseded`·`yield_job`/`fail_job`/`supersede_job`), `review-summary-db.md`(중간 저장·점유 확인 RPC·게시 표식), `core-service-db.md`(성향 테이블·RPC), `service-api.md`(새 경로). 종현 소유 `search.md`·`ai-chat.md`·`review-summary.md`는 이번에 갱신했다.

## R6. `service-api/routes.ts` Deno 타입 오류 (2026-09-30 발견)

Deno 2.9.7 `deno check --no-remote service-api/index.ts`가 `service-api/routes.ts:155`(`/internal/maintenance` 경로)에서 실패한다. 반환 객체의 `summary`가 `{ code?: undefined; retryable?: undefined }` 형태로 추론되어 `JsonValue`(undefined 불가)와 맞지 않는다. 실행 동작에는 영향이 없지만(로컬 Edge에서 maintenance 호출 200 확인) 타입 검사가 막힌다. 선택 필드를 조건부 spread로 만들거나 반환 타입을 명시하는 수정을 요청한다. 이 파일은 종현 작업에서 수정하지 않았다(기준선 해시 동일).

## R7. 로컬 gateway CORS 재현 기록 (2026-09-30)

임시 Edge 실행에서 `OPTIONS /functions/v1/ai-chat`에 허용되지 않은 Origin을 보내도 게이트웨이가 200과 `Access-Control-Allow-Origin: *`를 돌려줬다. 기존 민규 Edge 인계의 CORS 미충족과 같은 현상이며, 종현 함수 자체의 Origin 검사는 게이트웨이 뒤에서만 동작한다. 운영 gateway 정책 결정이 필요하다.
