# 종현 → 민규 연결·정책 적용 요청

현재 정책은 [정책.md](../../../../정책.md), 당시 구현·검증 근거는 lane별 기록([C](2026-09-29-claude-lane-c-notes.md), [E](2026-09-29-claude-lane-e-notes.md), [S](2026-09-29-claude-lane-s-notes.md))과 [9월 30일 통합 인계](2026-09-30-jonghyun-integration-handoff.md)를 따른다. 이 요청은 남은 연결과 최신 정책 적용을 관리한다. 아래 제안 SQL·기존 API를 최신 정책 검토 없이 그대로 채택하지 않는다. 실제 회원 AI 원문 전송은 공급사 보관 조건 검토·사용자 확인 전 보류한다. 이번 문서 작업은 코드·DB·배포 변경이 아니다.

## R1. 제안 SQL 5개의 검토·정식 마이그레이션 채택

| 순서 | 제안 파일 | 내용 | 권한 |
|---|---|---|---|
| 1 | [01_ai_budget.sql](2026-09-29-claude-proposed-sql/01_ai_budget.sql) | AI 호출 예산 원장·예약(원자 예약/정산, 사용량 불명은 예약 전체 소비) | service_role |
| 2 | [02_profile_traits.sql](2026-09-29-claude-proposed-sql/02_profile_traits.sql) | `private.profile_traits`, 본인 성향 저장/조회, 공고 작성자 성향 조회 | authenticated(익명 28000) |
| 3 | [03_review_summary_worker.sql](2026-09-29-claude-proposed-sql/03_review_summary_worker.sql) | 작업 큐 실패 횟수 분리·종결 상태, 비공개 중간 저장, 점유 확인 요약 RPC, 원자 게시·멱등 표식, 원문 변경 시 중간 저장 삭제 | service_role |
| 4 | [04_events.sql](2026-09-29-claude-proposed-sql/04_events.sql) | `private.events`, `upsert_events`(service_role), `list_public_events`(anon·authenticated) | 표 참조 |
| 5 | [05_event_filter_values.sql](2026-09-29-claude-proposed-sql/05_event_filter_values.sql) | 행사 필터 값 목록(제공처별 지역·분류 원문 값, 취소만 가진 값 제외) — 사용자 결정 U9 | anon·authenticated |

- 아래 파일은 검토 대상 원본이다. 현재 브랜치의 마지막 정식 마이그레이션 이후 충돌하지 않는 새 버전을 정하고, 이미 채택된 항목은 중복 생성하지 않는다. 과거 날짜를 새 마이그레이션 순서로 고정하지 않는다.
- 파일에는 BEGIN/COMMIT이 없다. 채택 시 트랜잭션 경계와 최신 정식 이력 순서를 검토한다. 03은 기존 `worker_jobs_status_check`, `worker_jobs_check1` 제약 이름을 교체하고 `claim_job`·`complete_job`·`retry_job`·`private.invalidate_appointment_review_summaries`·`private.refresh_review_summary_state`를 `create or replace`한다(기존 outbox 동작 보존).
- **실제 검증(2026-09-30, 전용 로컬 DB):** 28개 + 제안 4개를 처음부터 재생 PASS. 제안 적용 상태에서 `tools/local/run_database_tests.py --run` PASS(SQL 7 + 동시성 6), `review-policy-e2e.mjs` 8/8, 종현 SQL 4개·실제 다중 세션 2개·PostgREST 경유 3개 PASS. 원격 DB 적용은 NOT_RUN.
- 위 9월 30일 실검증의 4개 제안 범위와 추가 05를 구분한다. 기존 성공 기록은 아래 최신 정책 변경의 검증이 아니다.
- 완료 조건: 정식 SQL로 로컬 재생 + `python3 -B tests/database/jonghyun/run_proposals.py --all`이 제안 없이도(정식 적용 후에는 `--proposal` 없이 `--test`만) PASS.

## R2. RPC 허용 목록

| 대상 | 추가할 이름 | 이유 |
|---|---|---|
| `_shared/db/internal-client.ts` | `reserve_ai_budget`, `settle_ai_budget`, `yield_job`, `fail_job`, `supersede_job`, `load_review_summary_source`, `load_review_summary_checkpoint`, `save_review_summary_checkpoint`, `discard_review_summary_checkpoint`, `mark_review_summary_insufficient`, `publish_review_summary_for_job`, `upsert_events` | 예산 예약(ai-chat·worker), 요약 worker, event-sync 저장. 현재는 전송 전 `ACCESS_DENIED` → ai-chat unavailable, worker `DB_RPC_NOT_ALLOWED`, event-sync 500 |
| `_shared/db/user-client.ts` | `get_post_author_traits`, `get_my_profile_traits`, `set_my_profile_traits`, `list_public_events`, `list_event_filter_values` | AI 탐색 후보 성향·본인 성향, S15-2 저장, 회원 행사 조회 |
| `_shared/db/public-client.ts` | `list_public_events`, `list_event_filter_values` | 비로그인 행사 조회 |

운영 코드는 이 목록을 우회하지 않는다(테스트만 전용 허용 목록 transport를 명시적으로 만든다). 완료 조건: `tests/functions/jonghyun/ai-chat-http.test.mjs`·`review-summary-worker.test.mjs`·`event-sync.test.mjs`에서 허용된 요청의 실제 연결과 미허용 요청 차단을 모두 검증한다. 기존 실패 기대값을 성공으로 바꾸는 것만으로 연결 성공을 판단하지 않는다.

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

기존 구현의 필수 환경값 부재 시 해당 기능을 not_configured/unavailable로 두고 다른 기능, 특히 후기 공개를 막지 않는다. 운영 수치는 팀 검토 상태이며 코드 기술 한도·합성 테스트값을 서비스 정책으로 승인하지 않는다. 매일 00:01 Asia/Seoul, Sonnet 5 선택, 요약 자동 TTL 없음은 이미 확정되어 재질문하지 않는다.

## R5. 민규 소유 계약 문서 동기화

`worker-jobs.md`(kind 확장 없음, `failed_attempts`·`failed`/`superseded`·`yield_job`/`fail_job`/`supersede_job`), `review-summary-db.md`(중간 저장·점유 확인 RPC·게시 표식), `core-service-db.md`(성향 테이블·RPC), `service-api.md`(새 경로). 종현 소유 `search.md`·`ai-chat.md`·`review-summary.md`는 이번에 갱신했다.

## R6. `service-api/routes.ts` Deno 타입 오류 (2026-09-30 발견)

Deno 2.9.7 `deno check --no-remote service-api/index.ts`가 `service-api/routes.ts:155`(`/internal/maintenance` 경로)에서 실패한다. 반환 객체의 `summary`가 `{ code?: undefined; retryable?: undefined }` 형태로 추론되어 `JsonValue`(undefined 불가)와 맞지 않는다. 실행 동작에는 영향이 없지만(로컬 Edge에서 maintenance 호출 200 확인) 타입 검사가 막힌다. 선택 필드를 조건부 spread로 만들거나 반환 타입을 명시하는 수정을 요청한다. 이 파일은 종현 작업에서 수정하지 않았다(기준선 해시 동일).

## R7. 로컬 gateway CORS 재현 기록 (2026-09-30)

임시 Edge 실행에서 `OPTIONS /functions/v1/ai-chat`에 허용되지 않은 Origin을 보내도 게이트웨이가 200과 `Access-Control-Allow-Origin: *`를 돌려줬다. 기존 민규 Edge 인계의 CORS 미충족과 같은 현상이며, 종현 함수 자체의 Origin 검사는 게이트웨이 뒤에서만 동작한다. 운영 gateway 정책 결정이 필요하다.

## R8. 최신 답변에 따른 현재 적용 요구

- **인증·프로필:** 네이버만 사용한다. 이름·성별·생일·출생연도 필수, 여성 만 19세 이상, 누락·확인 불가 보류, 네이버 계정별 계정 하나다. 사진 필수·성향 선택을 연결하고 재로그인 자격 변동·복구 제한을 반영한다. 이메일 배지는 미래 검토다.
- **무료·공개:** 현재 무료 공고만 제공한다. 유료 신청·제안의 1원 인증은 추후 도입 시 필수이며 지금 화면·서버에서 유료 흐름을 다시 켜지 않는다. 별칭/마스킹/확정 당사자 전체 이름, 동 공개/정확한 주소 당사자 공개와 취소 즉시 재마스킹을 일관되게 적용한다.
- **검색:** 연결 행사명도 공고 검색 대상에 포함한다. 작성자 만 나이 19~99 직접 범위·전체, 비로그인 나이 전체, 등록일 최신순 기본/시작일 빠른순 선택, 전체 상태 기본을 유지한다.
- **공고·매칭:** 모집 마감은 미입력 시 시작 시각이며 시작보다 늦을 수 없다. 신청 거절은 재신청 불가, 본인 철회는 가능하다. 최종 동의 거절·철회·만료는 신청을 유지하고 시작 전 재요청할 수 있다. 공고당 최종 동의 대기 하나, 요청 후 24시간/시작 중 이른 만료, 수동 모집 마감 후 기존 신청자의 동의 요청·재요청, 확정 시간 겹침 차단을 반영한다.
- **완료·후기:** 예상 종료 후 본인의 완료 확인으로 선제 후기 작성 가능, 실제 동행 완료는 양쪽 확인 또는 종료+24시간 자동 처리다. 완료 전 비공개, 실제 완료+7일 작성 기한, 양쪽 후기+완료 시 즉시/한쪽은 실제 완료+24시간 공개다. 당도는 상대 후기 열람 가능 시, 완료 횟수는 실제 완료 즉시 반영하며 계산식은 팀 검토다. 신고만으로 비공개하지 않는다.
- **AI·보관:** 근거 있는 추천 이유·주의점 방향을 반영하되 반환 직전 재확인·일부 결과·실패 세부 동작과 품질 기준은 팀 검토다. 입력 개인정보 발견 시 전송 중단, 출력 발견 시 숨김·재시도, 첫 이용 전 고지·확인을 구현 대상으로 둔다. 실제 회원 원문은 보관 조건 확인·사용자 확인 전 전송하지 않는다. 요약 중간 결과 자동 TTL을 추가하지 않는다. 원장 보존기간·교체·운영 한도를 임의 확정하지 않는다.
- **행사:** 진행 중→예정→종료와 최근 시작/빠른 시작/최근 종료 순서를 반영한다. 서울 연결 조건·연결 여부는 팀 검토다. 공식 KOPIS 전국 전체 공연 Top 10 기본/뮤지컬 전환, 어제까지 최근 7일·매일 갱신을 별도 연결한다. API의 실제 지표·기간·장르 응답을 확인한다.
- **신고·분쟁:** 일반 신고 확인용 운영자 고객 DB 채팅 직접 조회를 만들지 않는다. 당사자가 제출한 스크린샷만 확인하며 접근·보존·삭제·법률 예외는 팀 검토다.

각 항목은 담당 코드·정식 SQL·HTTP·화면 계약을 함께 점검하고 기존 로컬 검증과 새 정책 검증을 구분한다. R6·R7의 오류는 아래 날짜에 관찰한 근거이며 현재 재현·해결 여부를 별도 확인한다.
