# Claude 구현 인수 검토 — Codex, 2026-09-30

**종합 판정: PARTIAL.** 인계에 적힌 가상·로컬 DB·Edge 검증은 재현했다. 추가 경계·동시성 검사에서 **수정이 필요한 결함 5건**을 확인했다. 제안 SQL의 정식 채택과 기능 활성화 전에 아래 결함을 수정해야 한다. 이번에는 제품 코드·제안 SQL·민규 파일을 수정하지 않고 검토 보고서와 재현 근거만 추가했다.

기준: `minkyu/foundation-harness` / `ff9c14fec069dc03b575cfd33d9deb62625fd924`. 검토 시작 시 미커밋·미추적 파일은 134개였다. [검토 하네스](2026-09-30-codex-review-harness.json), [입력 파일 해시](2026-09-30-codex-review-evidence/review-input-sha256.json), [Claude 인계 ①~⑥](2026-09-29-claude-implementation-handoff.md)를 함께 읽는다.

## 1. 먼저 수정할 결함 — 모두 별도 재현

### F1 · P1 · 잠금 대기 중 만료된 점유권으로 요약이 게시됨

- 위치: [제안 SQL 03](2026-09-29-claude-proposed-sql/03_review_summary_worker.sql) 295~298행의 `summary_job_for_lease`, 434~440행의 게시 전 snapshot 조회.
- 원인: 작업 행을 잠근 직후에는 만료를 검사하지만, 이후 `review_summary_state` 잠금을 기다린 뒤에는 시각을 다시 검사하지 않는다.
- 재현: 정상 점유 작업의 만료를 2초 뒤로 설정하고, 다른 세션이 투영 상태 잠금을 2.2초 이상 유지했다. 게시 호출이 잠금 대기하는 것을 관찰한 뒤 해제했다.
- 실제 결과: `projection_lock_wait_observed=true`, `lease_expired=true`, `status=applied`, `publications=1`. 기대값 `lease_lost` 검사는 **FAIL**했다.
- 영향: 점유 유효기간이 끝난 작업이 게시할 수 있다. 같은 검사 순서를 쓰는 중간 저장 등도 함께 점검해야 한다.
- 수정 방향: 필요한 잠금을 획득한 뒤 실제 쓰기 직전에 현재 점유·DB 시각을 재검사한다. F2의 잠금 순서와 함께 설계하고 회귀한다.
- 근거: [재현 코드](2026-09-30-codex-review-evidence/repro-lease.mjs), [실행 결과](2026-09-30-codex-review-evidence/repro-lease.log).

### F2 · P1 · 요약 worker와 재등록 처리의 잠금 순서가 반대

- 위치: [제안 SQL 03](2026-09-29-claude-proposed-sql/03_review_summary_worker.sql)의 `summary_job_for_lease → summary_job_snapshot`와 [기존 공개·예약 SQL](../../../../backend/supabase/migrations/20260929120000_review_release_and_completion_reservations.sql) 163~173행의 `process_review_summary_refresh → enqueue_job`.
- 원인: worker는 작업 행 → 투영 상태, 재등록 처리는 투영 상태 → 중복 작업 행 순서로 잠근다.
- 재현: 정상 점유 작업과 같은 revision의 재등록 의도가 있는 상태에서 세션 A가 작업 행을 잠그고, 세션 B가 재등록을 호출해 작업 잠금을 기다리게 했다. 이어 A에서 요약 원문 조회를 호출했다.
- 실제 결과: `refresh_blocked_on_job=true`, 원문 조회는 성공했지만 재등록이 **SQLSTATE 40P01(deadlock)**로 실패했다.
- 영향: worker와 일일 재등록이 겹치면 트랜잭션이 중단될 수 있다. 기존 게시·비공개 경쟁 검사 통과만으로 이 조합의 안전성을 보장할 수 없다.
- 수정 방향: 기존 원문 변경·outbox 경로까지 포함해 잠금 순서를 통일하거나 중복 등록 경로의 잠금 의존성을 없앤다. 민규 기존 migration을 직접 바꾸지 않고 종현 제안 수정과 민규 반영 요청으로 진행한다.
- 근거: [재현 코드](2026-09-30-codex-review-evidence/repro-deadlock.mjs), [실행 결과](2026-09-30-codex-review-evidence/repro-deadlock.log).

### F3 · P2 · 실제 예산 소진에서는 이미 찾은 일부 결과가 사라짐

- 위치: [의미 비교](../../../../backend/supabase/functions/_shared/ai/Agents/chatbot/preference-match.ts) 78~83행, [공고 탐색](../../../../backend/supabase/functions/_shared/ai/Agents/chatbot/discovery.ts) 174~178행.
- 원인: 페이지·호출 횟수 상한은 `incomplete`를 반환하지만, 모델의 `BUDGET_EXHAUSTED`는 일반 판단 오류로 바뀌어 이미 채택한 카드까지 잃는다.
- 재현: 후보 2개를 한 개씩 판단하도록 구성했다. 첫 후보는 일치하고 두 번째 판단에서 가상 모델이 `BUDGET_EXHAUSTED`를 반환했다. 실제 AI 호출은 없다.
- 실제 결과: `judgeCalls=2`, `status=unavailable`, `cards=0`, `partial=false`.
- 기대: 9월 30일 Q1 결정대로 이미 확인한 카드를 재확인한 뒤 `results`, 카드 1개, `partial=true`. 이 기대 검사는 **FAIL**했다.
- 수정 방향: 예산 소진의 안전한 오류 분류를 유지하고, 일반 모델 오류·취소와 구분해 누적 결과를 `incomplete`로 넘긴다. 부분 결과도 기존 재확인을 거쳐야 한다.
- 근거: [합성 재현 코드](2026-09-30-codex-review-evidence/repro-partial.mjs), [실행 결과](2026-09-30-codex-review-evidence/repro-partial.log).

### F4 · P2 · TourAPI 비정상 응답을 정상 0건으로 처리

- 위치: [TourAPI 어댑터](../../../../backend/supabase/functions/_shared/integrations/events/tourapi.ts) 80~86행.
- 원인: `Number(null)`은 0이고, 없거나 잘못된 `items.item`은 `?? []`로 빈 배열이 된다.
- 재현: 성공 코드 `0000` 아래 `body={totalCount:null}`, 또는 `body={totalCount:5,items:{}}`를 전달했다.
- 실제 결과: 두 경우 모두 거절하지 않고 `{items:[],hasMore:false}`를 반환했다. 정상 0건 형식과 비정상 응답을 구분하는 검사는 **FAIL**했다.
- 영향: 공급사 응답 형식 이상을 성공 0건·마지막 페이지로 기록한다.
- 수정 방향: 필수 필드의 존재·자료형과 합의된 빈 응답 형태를 명시적으로 검사한다. 필드 누락을 0건으로 보정하지 않는다.
- 근거: [합성 재현 코드](2026-09-30-codex-review-evidence/repro-tourapi.mjs), [실행 결과](2026-09-30-codex-review-evidence/repro-tourapi.log).

### F5 · P2 · 행사 DB가 잘못된 비용 객체 `{}`를 저장

- 위치: [제안 SQL 04](2026-09-29-claude-proposed-sql/04_events.sql) 21~25행의 CHECK와 145~150행의 입력 검사.
- 원인: JSON 필수 키 누락으로 조건이 SQL NULL이 되면 `IF NOT (...)`도 CHECK도 이를 거절하지 않는다.
- 실제 로컬 DB 재현: 다른 필드가 정상인 합성 행사에 `admission={}`를 넣어 service_role로 `upsert_events`를 호출했다. `insertedCount=1`과 저장값 `{}`를 확인했다. 실행은 ROLLBACK했다.
- 판정: SQL 실행 자체는 exit 0이지만, **비정상 비용 거절 요구는 FAIL**이다.
- 영향: 저장 계약을 어긴 행이 만들어진다. [행사 repository](../../../../backend/supabase/functions/_shared/db/repositories/events.ts) 251~255행은 이를 거절하므로, 그 행을 포함한 조회 페이지가 실패할 수 있다. 페이지 실패의 영향은 코드 대조 결과이며 화면 실측은 아니다.
- 수정 방향: 입력 검사와 CHECK 모두 조건이 명확히 TRUE일 때만 허용하고, 필수 키 누락·null·잘못된 자료형을 검사한다.
- 근거: [재현 SQL](2026-09-30-codex-review-evidence/repro-event-admission.sql), [실행 결과](2026-09-30-codex-review-evidence/repro-event-admission.log).

## 2. 기존 변경 보존·소유권

| 검사 | 판정 | 확인 내용 |
|---|---|---|
| 브랜치·HEAD | PASS | 인계와 동일. 커밋·푸시 없음 |
| Claude 시작 기준 37개 | PASS | [기준 해시](2026-09-29-claude-baseline-sha256.txt)의 33개 동일, 변경 4개는 인계와 일치 |
| 문서 2개 삽입만 변경 | PASS | `review-summary.md`의 새 2~10행, `jonghyun.md`의 새 2~9행을 메모리에서 제외하면 기준 해시와 일치 |
| scheduled-jobs 변경 근거 | PASS | [기록된 패치](2026-09-29-claude-scheduled-jobs-index.diff)를 임시 사본에 역적용하면 기준 해시와 일치. 기존 maintenance 검사는 통과 |
| 설계 파일 | PASS | 변경된 결정 표·체크박스·인계 근거 확인. 9월 30일 결정이 이전 문구보다 우선 |
| Claude 변경 경로 소유권 | PASS | 시작 기준의 기존 변경을 제외한 실제 변경 101개 경로를 `check_ownership.py --actor jonghyun --paths ...`로 확인 |
| 이번 검토 보존 | PASS | 검토 시작 134개 파일은 내용 보존. 새 보고서·하네스·근거만 추가 |
| `.env` | PARTIAL | Git 제외와 `TOUR_API_KEY_FORMAT=decoded`만 확인. 이전 비밀 파일 사본이 없어 ‘키값은 그대로’라는 이력은 독립 검증하지 못함. 값을 출력하거나 파일을 수정하지 않음 |

정적 검토는 AI·행사/일일 실행·요약 DB로 나눴다. 세 보조 검토가 사용량 한도로 중단된 뒤 총괄이 보고된 의심 지점을 직접 읽고 재현했다. 보조 에이전트의 보고만으로 FAIL을 확정하지 않았다.

## 3. 실행 명령과 결과

아래 명령은 저장소 루트 기준이다. Deno 명령만 `backend/supabase/functions`에서 실행한다. Node 26.5.0, Deno 2.9.7, 캐시된 Supabase CLI 2.116.0을 사용했다. 전용 Colima `yumidang-minkyu`, 프로젝트 `yumidang-minkyu-db`, API 55421/DB 55422만 접근했다.

| 검사·명령 | 판정 | 이번 결과·근거 |
|---|---|---|
| `node --test tests/functions/jonghyun/*.test.mjs tests/ai/jonghyun/*.test.mjs tests/integration/jonghyun/*.test.mjs` | PASS | **260/260**, [로그](2026-09-30-codex-review-evidence/jonghyun-node.log) |
| `node --test tests/functions/minkyu/*.test.ts` | PASS | **97/97**, [로그](2026-09-30-codex-review-evidence/minkyu-node.log) |
| `deno check --no-remote ai-chat/index.ts places/index.ts event-sync/index.ts review-summary-worker/index.ts scheduled-jobs/index.ts` | PASS | 진입점 5개. 외부 import 내려받기 없음 |
| `deno check --no-remote service-api/index.ts` | FAIL | 기존 `routes.ts:155:62` TS2345: 선택 필드의 undefined가 JsonValue와 불일치. 파일 기준 해시 동일, 기존 R6와 일치 |
| `python3 -B tests/database/jonghyun/run_proposals.py --all` | PASS | **5/5**, BEGIN→제안 5개→검사→ROLLBACK, [로그](2026-09-30-codex-review-evidence/proposals-rollback.log) |
| `python3 -B tests/database/jonghyun/run_minkyu_regression.py "<제안 SQL 5개를 쉼표로 연결>" "<민규 검사 SQL 8개를 쉼표로 연결>"` | PASS | **8/8**, [로그](2026-09-30-codex-review-evidence/minkyu-regression.log). 이 도구는 두 인수가 필요함 |
| `npx --offline supabase@2.116.0 db reset --local --workdir <임시 applied 폴더>` | PASS | 기존 **28개 + 제안 5개 = 33개** 처음부터 재생. 제안은 임시 migration에만 BEGIN/COMMIT으로 감쌈. [소스 해시](2026-09-30-codex-review-evidence/manifest.json) |
| `python3 -B tests/database/jonghyun/run_proposals.py --test <검사 SQL> ...` | PASS | 33개 재생 상태에서 제안을 재적용하지 않고 검사 **5/5**, [로그](2026-09-30-codex-review-evidence/committed-proposals-tests.log) |
| `python3 -B tools/local/run_database_tests.py --run` | PASS | 기존 SQL 7개 + 동시성 6개, 잔존 fixture 0, [로그](2026-09-30-codex-review-evidence/committed-regression.log) |
| `node --test tests/integration/jonghyun/review-policy-e2e.mjs` | PASS | 실제 Node↔PostgreSQL **8/8**, [로그](2026-09-30-codex-review-evidence/review-policy-e2e.log) |
| `node --test tests/integration/jonghyun/ai-budget-concurrency.mjs` | PASS | 실제 다중 세션 예약·정산, [로그](2026-09-30-codex-review-evidence/ai-budget-concurrency.log) |
| `node --test tests/integration/jonghyun/summary-worker-concurrency.mjs` | PASS | 기존 점유·중복 게시·공개 변경 경쟁, [로그](2026-09-30-codex-review-evidence/summary-worker-concurrency.log). F1/F2 시나리오는 이 검사에 없음 |
| `node --test tests/integration/jonghyun/summary-worker-rest.mjs` | PASS | 실제 PostgREST 분할 재개·게시, [로그](2026-09-30-codex-review-evidence/summary-worker-rest.log) |
| `node --test tests/integration/jonghyun/ai-discovery-rest.mjs` | PASS | 실제 Auth·PostgREST 검색·성향, [로그](2026-09-30-codex-review-evidence/ai-discovery-rest.log) |
| `node --test tests/integration/jonghyun/events-rest.mjs` | PASS | 실제 PostgREST 행사 저장·조회, [로그](2026-09-30-codex-review-evidence/events-rest.log) |
| `node --test tests/integration/jonghyun/ai-event-discovery-rest.mjs` | PASS | 행사 AI 포트·부분 결과·재확인, [로그](2026-09-30-codex-review-evidence/ai-event-discovery-rest.log) |
| `node --test tests/integration/jonghyun/edge-functions-e2e.mjs` | PARTIAL | 기능 검사 카운트 **7/7**. 인증·설정 미비의 안전한 비활성·daily→maintenance/worker 호출 PASS. CORS는 아래 FAIL. [로그](2026-09-30-codex-review-evidence/edge-e2e.log) |

실제 DB·REST·Edge 검사의 로컬 키는 CLI `status -o env` 출력을 메모리에서 받아 해당 검사 파일의 명시 환경 변수로 전달했다. 명령 인수·보고서에 비밀값을 넣지 않았다. REST 검사에 쓰인 RPC 허용 목록은 테스트 전용이다. 운영 허용 목록이 연결됐다는 뜻이 아니다. 가상 모델과 가상 안전 검사기로 처리한 요약은 실제 모델 품질·안전성 검증이 아니다.

Edge는 별도 임시 폴더에 필요한 함수 6개와 `_shared`를 복사하고, 임시 config에서만 Edge 활성화·함수별 gateway JWT 옵션을 설정했다. 합성 실행 한도·임시 내부 비밀만 주입했고 실제 외부 공급사 키와 보관 승인값은 넣지 않았다. 원본 config는 보존했다. `event-sync`는 잘못된 내부 인증 403, 인증 성공 뒤 공급사 설정 누락 503의 순서를 확인했다.

**기존 gateway CORS: FAIL 재현.** 허용·비허용 Origin 모두 OPTIONS 200 / `Access-Control-Allow-Origin: *`. 현재 Edge 검사 파일의 CORS 항목은 관찰만 출력하므로 테스트 7/7이 CORS PASS를 뜻하지 않는다. R7이 그대로 남는다.

### 추가 실패 재현 명령

근거 폴더의 `.mjs`는 기존 합성 fixture를 이용하며 저장소 상대 import로 옮겨 두었다. 실행 로그는 임시 사본을 실행한 결과다. 아래 DB 재현은 **28+제안 5개가 적용된 빈 전용 로컬 DB**와 기존 검사와 같은 명시적 로컬 환경 변수가 필요하다. 현재 DB는 검증 후 28개로 복구·정지돼 있다.

```sh
evidence=docs/collaboration/requests/jonghyun/2026-09-30-codex-review-evidence
# SUMMARY_WORKER_TEST_DATABASE_URL을 로컬 검사 환경에만 주입. 값은 출력하지 않는다.
node --test "$evidence/repro-lease.mjs"
node --test "$evidence/repro-deadlock.mjs"
# 외부 호출 없는 합성 재현
node "$evidence/repro-partial.mjs"
node "$evidence/repro-tourapi.mjs"
# BEGIN/ROLLBACK 안에서 비정상 비용 저장을 관찰한다.
docker --context colima-yumidang-minkyu exec -i supabase_db_yumidang-minkyu-db \
  psql -X -qAt -U postgres -d postgres -v ON_ERROR_STOP=1 < "$evidence/repro-event-admission.sql"
```

앞 네 검사는 올바른 동작을 기대하므로 현재 코드에서 exit 1이다. 마지막 SQL은 비정상 저장 성공을 관찰하는 명령이므로 exit 0이 결함 부재를 뜻하지 않는다. 새 실패를 기존 테스트의 PASS에 섞지 않는다.

## 4. 정리 결과

**PASS:** 실제 재현 뒤 사용자·프로필·공고·약속·후기·작업·완료 예약·행사·중간 저장·요약 모두 0건을 확인했다. 임시 baseline 폴더로 DB를 **28개 migration** 기준에 복구한 뒤 다시 잔존 자료 0건을 확인했다. Supabase stop과 Colima `yumidang-minkyu` stop 모두 exit 0, 볼륨은 보존했다. [정리 결과](2026-09-30-codex-review-evidence/cleanup.json).

임시 Edge serve 프로세스는 종료했고 합성 환경 파일·비공개 실행 로그를 삭제했다. 기존 미리보기 서버와 기본 Colima 프로필은 변경하지 않았다. 외부 AI·장소·행사 호출은 이번 검토에서 **0회**다. 원격 DB·배포·커밋·푸시는 하지 않았다.

## 5. 이어받은 상태와 다음 작업

| 구분 | 판정 | 다음 행동 |
|---|---|---|
| 로컬 구현 인수 | PARTIAL | F1~F5를 미해결 결함으로 인수. 우선 F1/F2 SQL03, 다음 F3~F5 수정·해당 회귀 |
| 민규 반영 R1~R7 / M1~M6 | BLOCKED | 허용 목록·정식 migration·공통 HTTP·환경·CORS 등은 민규 반영 대기. 제안 SQL 03/04는 결함 수정 후 채택 |
| 실제 AI 호출 | BLOCKED | T2 추가 지출 0원 근거 전까지 호출하지 않음 |
| 실제 회원 원문 | BLOCKED | T1 보관 기간 답변과 사용자 확인 전까지 전송하지 않음 |
| 생성 설명·요약 공개 | BLOCKED | T3 첫 결과의 팀 2명 이상 검토·품질 기준·안전 검사 확정 대기 |
| 운영 한도·예산 원장 | BLOCKED | T5 제안값 검토·확정 대기. 제안 문서를 운영 설정으로 사용하지 않음 |
| 실제 외부 공급사·모델·브라우저·운영 | NOT_RUN | 이번 검토에서는 실행하지 않음. Claude의 과거 외부 호출 기록은 이번 관찰과 구분 |

최신 사용자 결정은 [설계 1절](../../../../260929_종현담당_PLAN.md)을 기준으로 인수했다. Q1 일부 결과, U4 매일 00:01 Asia/Seoul, U5 자동 TTL 없음·종결 시 정리, U9 원문 필터값 목록, U10 TourAPI, U13 공개 프로필 성향 추가를 옛 미정으로 되돌리지 않는다. U5와 관련해 설계의 앞선 일반 행·일부 주석에는 ‘보관기간 팀 검토’라는 이전 문구가 남아 있다. 새 운영 보관기간을 만들지 않고 최신 결정과 맞추는 문서 동기화가 필요하다. 외부 AI 보관 기간 T1은 별개의 미해결 사항이다.

현재 발견한 다섯 항목은 구현 결함이므로 사용자에게 새로운 제품 정책을 선택하게 할 필요가 없다. 이미 답변한 질문 HTML을 다시 제시하지 않는다. 민규 요청·팀 결정 목록은 [미정사항](../../../../정책.md#follow-ups), [R1~R7](2026-09-29-claude-minkyu-requests.md), [운영 제안](2026-09-30-operational-values-proposal.md), [재개 목록](2026-09-30-resume-todo.md), [프론트 계약](2026-09-29-claude-frontend-contract.md)을 이어받는다.
