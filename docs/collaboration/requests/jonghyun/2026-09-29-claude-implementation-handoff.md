# 종현 잔여 작업 구현 인계 — Claude → Codex (2026-09-29 시작, 2026-09-30 종료)

현재 확정 정책·남은 결정·팀 후속 작업은 [정책.md](../../../../정책.md#follow-ups)에서 확인한다. 아래는 당시의 구현·검증 기록이며, 미정사항 관련 링크는 통합 정책 문서로 연결한다.

설계 [260929_종현담당_PLAN.md](../../../../260929_종현담당_PLAN.md) 5.1~5.7의 로컬 구현·검증 기록이다. 대화 요약이 아니라 **재확인 가능한 변경·명령·근거**를 모은다. 커밋·푸시·원격 DB 변경·운영 배포·실제 AI 호출은 하지 않았다. 사용자 답변(Q1~Q9)까지 반영한 최종본이다.

## ① 시작·종료 상태

| 항목 | 값 |
|---|---|
| 작업 경로 | `/Users/b/Documents/Antigravity/yumidang` (별도 worktree 없음, 같은 작업 트리) |
| 브랜치 / HEAD | `minkyu/foundation-harness` / `ff9c14fec069dc03b575cfd33d9deb62625fd924` (시작·종료 동일, 커밋 없음) |
| 작업자 | jonghyun(`check_ownership.py --actor jonghyun`). Git `yumidang.actor`는 비어 있었고 바꾸지 않음 |
| 시작 시 미커밋 | 37개(수정 26 + 미추적 11: 설계 파일과 후기 공개·건별 예약 변경 36개). 2026-09-29T13:08Z 경로·SHA256: [기준선 해시](2026-09-29-claude-baseline-sha256.txt) |
| 기준선 보존 | 37개 중 **33개 해시 동일**. 변경 4개: `260929_종현담당_PLAN.md`(체크박스·근거 링크·결정 표 행 추가), `docs/collaboration/jonghyun.md`·`backend/contracts/review-summary.md`(맨 앞 새 절 추가만 — 추가분 제거 시 기준선 해시 일치 검산), `backend/supabase/functions/scheduled-jobs/index.ts`(일일 실행용 재구성, 기준선 대비 [패치](2026-09-29-claude-scheduled-jobs-index.diff)) |
| 이번 추가·수정 | 기준선 밖 약 82개 경로(아래). 전부 종현 소유 검사 통과. 민규 소유 파일·마이그레이션·소유권 정책·hook 수정 0 |
| 프로세스 | 이전 세션의 미리보기 서버(PID 98449)는 건드리지 않음. 이번 질문 미리보기 서버(127.0.0.1:8765)는 종료 |

### 팀 실행 방식

[하네스](2026-09-29-claude-implementation-harness.json)에 lane별 정확한 경로를 고정하고 Agent 도구로 에이전트 3개를 병렬 실행했다. **C(5.3)** 는 완료 보고, **E(5.4)** 는 노트 작성 직후, **S(5.5·5.6)** 는 테스트 작성 초입에서 사용 한도로 중단됐다. 총괄이 남은 코드를 읽어 검토하고 검사·문서를 이어받았다(하네스 `lead_takeover_after_lane_completion`). lane 기록: [C](2026-09-29-claude-lane-c-notes.md), [E](2026-09-29-claude-lane-e-notes.md), [S](2026-09-29-claude-lane-s-notes.md).

### 이번 추가·수정 파일

- **공통 AI:** `_shared/ai/providers/{model-port,provider-adapter,provider-errors}.ts` 수정, `potens-adapter.ts`·`budget.ts`·`runtime.ts` 신규, `_shared/jobs/settings.ts` 신규, `_shared/ai/Agents/README.md`
- **5.1:** `_shared/db/repositories/search.ts`, `_shared/contracts/search.ts`(`POST_CATEGORIES` export)
- **5.3:** `_shared/contracts/ai.ts`, `_shared/ai/Agents/chatbot/{context,intent,orchestrator,prompts,result-builder,tools}.ts` 수정, `{preference-match,discovery,traits,settings,event-discovery}.ts` 신규, `ai-chat/{handler,index}.ts`
- **5.4:** `places/{handler,index}.ts`, `event-sync/{handler,index}.ts`, `_shared/integrations/events/{kopis.ts 신규,port.ts,normalize.ts}`, `_shared/db/repositories/events.ts`
- **5.5·5.6:** `_shared/db/repositories/{jobs,review-summaries}.ts`, `_shared/jobs/{lease,registry}.ts`, `_shared/jobs/daily.ts` 신규, `_shared/ai/Agents/review-summary/{orchestrator,source-loader}.ts`, `review-summary-worker/{handler,index}.ts`, `scheduled-jobs/{handler,index}.ts`
- **제안 SQL(민규 채택 대기):** `2026-09-29-claude-proposed-sql/{01_ai_budget,02_profile_traits,03_review_summary_worker,04_events}.sql`
- **검사:** `tests/database/jonghyun/{run_proposals.py,run_minkyu_regression.py,ai_budget.sql,profile_traits.sql,review_summary_worker.sql,events.sql}`; `tests/ai/jonghyun/{potens-adapter,budget-runtime,chatbot-semantic,synthetic-eval,event-discovery}.test.mjs`·`synthetic-eval.mjs` 신규, `chatbot.test.mjs`·`model-router.test.mjs` 수정; `tests/functions/jonghyun/{search-response-errors,ai-chat-http,places-http,event-provider,event-sync,summary-repository,review-summary-worker,daily-run}.test.mjs` 신규; `tests/integration/jonghyun/{ai-budget-concurrency,summary-worker-concurrency,summary-worker-rest,ai-discovery-rest,events-rest,ai-event-discovery-rest,edge-functions-e2e}.mjs` 신규, `discovery-flow.test.mjs` 수정; `tests/fixtures/jonghyun/synthetic-eval-cases.json` 신규
- **문서:** `backend/contracts/{search,ai-chat,review-summary}.md`, `docs/collaboration/jonghyun.md`, 이 폴더의 하네스·lane 기록 3개·[민규 요청](2026-09-29-claude-minkyu-requests.md)·[화면 계약](2026-09-29-claude-frontend-contract.md)·[질문 HTML](2026-09-29-claude-implementation-questions.html)·[미정사항](../../../../정책.md#follow-ups)·scheduled-jobs 패치·이 인계

## ② 설계 대비 구현 현황

| 절 | 판정 | 구현(파일·함수) | 충족한 완료 기준 | 남은 조건 |
|---|---|---|---|---|
| 5.1 검색 오류 분류 | **완료**(3번째 항목 부분) | `search.ts wireCard`: 투영 실패만 `INVALID_SEARCH_RESPONSE` | 사용자 기간·커서 400, DB 카드 날짜 500(원문 없음), RPC 401/403/503 유지 | 민규 문서 옛 문구는 [요청 R5](2026-09-29-claude-minkyu-requests.md) |
| 5.2 포텐스닷·예산 | **부분 완료** | `createPotensModel`(`POST /api/chat`, `{prompt,model}`만, origin 고정, JSON 한 개만), `createModelRouter`(미보고 `usage:null` → 예약 전체 소비, 보고값은 실제 소비), `createRpcModelBudget` + 제안 `reserve/settle_ai_budget`, `createConfiguredModel`, 합성 평가 실행기 | 가상 구조·취소·오류·사용량 불명·지출 제한, **실제 DB 두 세션 동시 예약·이중 정산 1회** | token_usage 필드·출력 상한·실제 모델 식별 미확인, 0원 근거 없음 → 실제 호출 NOT_RUN(Q6: 팀 자료 대기) |
| 5.3 C 의미 비교·HTTP | **완료(로컬)**, 런타임 BLOCKED | `judgePreferences`/`evaluatePreferenceCondition`, `createPostDiscovery`, `createEventDiscovery`(신규, 행사 저장소 기반), `runChat`(Q1 부분 결과), `createAiChatHandler/Runtime` | 동의어·부분·부정·미입력·복수·변경·여러 페이지, 0건 오표시 없음, 한도 도달 시 찾은 카드 `partial`, **실제 Auth·PostgREST·DB로 회원 탐색·재확인** | 민규 허용 목록·마이그레이션·환경값 전까지 `unavailable`. 생성 설명 비활성(5.7) |
| 5.4 장소·첫 행사 | **부분 완료** | `createPlacesHandler/Runtime`, `createKopisEventProvider`, `createRpcEventRepository`, `createEventSyncRuntime`, 제안 `upsert_events`·`list_public_events` | KOPIS 검증 기간(2026-10-05~11) 1페이지 실호출 5건, 로컬 DB 재저장 중복 0, 실제 PostgREST 저장·조회 | Kakao 이전 403 원인 미특정, KOPIS HTTPS는 A로 결정(공식 문의·인증서 재확인 남음), 서울 HTTPS 없음, Tour 키 형식 unknown, 작업 큐 미연결, 공개 조회 HTTP는 민규 |
| 5.5 요약 중간 저장·게시 | **완료(로컬)**, 허용 목록 대기 | 제안 SQL 03, `createRpcReviewSummaryRepository`, `createRpcJobRepository` | 점유 만료·옛 토큰 거절·원문 변경 시 삭제·재개·게시 후 중단 재실행 멱등·정상 양보 실패 미증가·bigint 문자열, **실제 두 세션 경쟁·PostgREST 전체 흐름** | 허용 목록(민규), 방치 중간 저장 보관기간(미정사항 6) |
| 5.6 worker·24시간 | **부분 완료** | `createReviewSummaryWorkerRuntime`, `runDaily`(`POST /scheduled-jobs/daily`) | 정상 분할이 같은 실행에서 이어짐(실제 DB: 양보 여러 번 → 게시, 실패 0, 모델 3회), 한도 소진 시 추가 호출 없음 | cron 등록·시각(미정사항 3), 안전 검사기 없음 → `SAFETY_CHECK_NOT_APPROVED` |
| 5.7 평가·화면·운영 | **부분 완료** | 합성 사례·실행기(dry-run 10회), [화면 계약](2026-09-29-claude-frontend-contract.md), [미정사항](../../../../정책.md#follow-ups) | 유미·성호 인계 | 실제 모델 평가·품질 기준·공개 활성화, 우편번호 연결 확인, gateway CORS·Edge, 완료 실행기 운영 준비 — 미실행 |

### 설계에서 달라진 점과 근거

1. DB 변경은 **제안 SQL**로 작성했다(마이그레이션은 민규 소유, 이번 요청에 경계 예외 없음). 실제 로컬 DB에서 재생·검증했다.
2. **예산 단위** = 입력 UTF-8 바이트 + 고정 prompt 바이트 + 최대 출력 토큰(바이트 단위 토큰화의 상한 성질). 포텐스닷 내부 추가 prompt·출력 강제 여부는 미확인.
3. **출력 한도 초과 응답**은 거절하되 보고된 실제 사용량으로 정산(`model-router.test.mjs` 기대값 1건 변경).
4. **KOPIS HTTPS**: 공식 가이드는 HTTP만 표기. 키 없는 확인에서 같은 host 계열 HTTPS가 API 응답·유효 인증서를 보여 이 주소만 사용했다. 2026-09-30 사용자가 A(HTTPS 사용)로 결정.
5. **행사 수집**은 작업 큐가 아닌 일일 실행의 event-sync HTTP 직접 호출(큐는 review_summary 전용, 자동 완료 이동 없음).
6. **공고 분류**는 AI 조건에서도 검색 v2 고정 목록만 허용.

### 사용자 답변 반영(2026-09-30)

| 질문 | 답 | 반영 |
|---|---|---|
| Q1 한도 도달 시 일부 결과 | A | `AiChatResult.partial?: true`, `CHAT_NOTICES.partial`; 찾은 카드 0건이면 기존대로 `unavailable`. 검사 `chatbot-semantic`, `event-discovery` |
| Q2 제외 조건 결합 | A | 현재 규칙 유지(제외는 항상 모두 적용, 애매하면 질문). 설계 결정 표에 기록 |
| Q3 공개 필드만 바뀐 카드 | A | 현재 동작 유지. 설계 결정 표에 기록 |
| Q4 링크 없는 행사 카드 | A | `AiCard.sourceName` 필수(행사), `sourceUrl: string \| null`; `result-builder.ts` 검사 변경; 행사 AI 포트 `createEventDiscovery`를 ai-chat 기본 포트로 연결 |
| Q5 KOPIS HTTPS | 설명 후 A(2026-09-30) | 코드 변경 없음(이미 고정 HTTPS·redirect 거부·HTTP 대체 없음). 결정과 키 노출 상태, 남은 일(KOPIS 공식 문의·인증서 만료 전 재확인)을 [미정사항 1](../../../../정책.md#follow-ups)·설계 결정 표에 기록 |
| Q6 0원 근거 | A | 팀 자료 대기. 필요한 자료 목록을 [미정사항 2](../../../../정책.md#follow-ups)에 기록. 실제 호출 0회 유지 |
| Q7 일일 실행 시각 | D(C + 미정사항 문서) | 민규·팀 결정. 당시 `미정사항.md`를 신규 작성했으며 현재 확인 위치는 [정책.md](../../../../정책.md#follow-ups) |
| Q8 행사 지역·분류 매핑 | D(민규·팀 논의) | [미정사항 4](../../../../정책.md#follow-ups) |
| Q9 성향 입력 상한 | A | 20개·40자를 제품 기준으로 채택. `traits.ts`·`intent.ts`·`02_profile_traits.sql` 주석, 화면 계약 갱신 |

### 임의로 결정하지 않고 남긴 부분

[미정사항.md](../../../../정책.md#follow-ups)에 통합: KOPIS HTTPS 운영, 0원 근거 자료, 일일 실행 시각, 행사 지역·분류 매핑, 외부 보관 기준, 방치 중간 저장 보관기간, 의미 검사·품질 목표, 운영 한도 숫자, 민규 연결 작업, 공급사 확인 사항.

## ③ 검증 근거

환경: macOS arm64, Node v26.5.0(TS 타입 제거 실행), Python 3.14.6, TypeScript 5.9.3(npx 캐시, 저장소 설치 없음), Supabase CLI 2.116.0(`npx --yes supabase@2.116.0`), 전용 Colima `yumidang-minkyu`(2 CPU/4 GiB) + Supabase `yumidang-minkyu-db`(DB 55422, API 55421, PostgreSQL 17). Deno 미설치. 명령은 저장소 최상위에서 실행.

### 이번에 새로 실행한 검사

| 종류 | 명령 | 결과 |
|---|---|---|
| 가상(Node, 답변 반영 후 최종) | `node --test tests/functions/jonghyun/*.test.mjs tests/ai/jonghyun/*.test.mjs tests/integration/jonghyun/*.test.mjs` | **PASS 254/254** |
| 가상(민규 회귀) | `node --test tests/functions/minkyu/*.test.ts` / `python3 -B tests/functions/minkyu/test_api_env.py` / `test_harness.py` | **PASS 97/97**, OK, OK |
| 정적 타입(최종) | TS 5.9.3 strict·noEmit, 진입점 5개+종현 모듈 58파일(임시 tsconfig·최소 Deno 선언) | **PASS**(첫 실행 `jobs.ts` 타입 오류 1건 → 저장소 객체 타입 명시로 수정) |
| 실제 로컬 DB(ROLLBACK) | `python3 -B tests/database/jonghyun/run_proposals.py --all` | **PASS 4/4** |
| 실제 로컬 DB 회귀 | `python3 -B tests/database/jonghyun/run_minkyu_regression.py "" "<민규 SQL 8개>"` 및 제안 4개 적용 | **둘 다 PASS 8/8** |
| 실제 로컬 DB(재생) | 28개 + 제안 4개를 임시 마이그레이션으로 `supabase db reset` | **PASS**(32개 처음부터) |
| 재생 상태 | `python3 -B tools/local/run_database_tests.py --run` | **PASS** SQL 7 + 동시성 6, fixtures_remaining 0 |
| 재생 상태 | `REVIEW_POLICY_TEST_DATABASE_URL=… node --test tests/integration/jonghyun/review-policy-e2e.mjs` | **PASS 8/8** |
| 실제 두 세션 | `AI_BUDGET_TEST_DATABASE_URL=… node --test tests/integration/jonghyun/ai-budget-concurrency.mjs` | **PASS**: 8세션 동시 예약 중 3건, 동시 이중 정산 1건 |
| 실제 두 세션 | `SUMMARY_WORKER_TEST_DATABASE_URL=… node --test tests/integration/jonghyun/summary-worker-concurrency.mjs` | **PASS**: 동시 점유 1건, 동시 중복 게시 멱등, 게시↔비공개 전환 경쟁 후 불변식 |
| 실제 PostgREST | `SUMMARY_REST_*=… node --test tests/integration/jonghyun/summary-worker-rest.mjs` | **PASS**(첫 실행은 검사 SQL 매개변수 형 오류로 FAIL → 검사 쿼리만 수정) |
| 실제 Auth·PostgREST | `AI_REST_*=… node --test tests/integration/jonghyun/ai-discovery-rest.mjs` | **PASS**(가상 회원 4명 생성·삭제) |
| 실제 PostgREST | `EVENTS_REST_*=… node --test tests/integration/jonghyun/events-rest.mjs` | **PASS** |
| 외부 공급사(lane E) | Kakao 키워드 1회(합성 검색어), KOPIS 키 없는 HTTPS 확인 + 실키 1페이지 1회, 서울 HTTPS 확인 | Kakao 200, KOPIS 200·5건·정규화 PASS, 서울 HTTPS 실패 → 호출 없음. 원문 미저장 |
| Deno 타입 검사(2026-09-30 추가) | Deno 2.9.7(Homebrew 설치) `cd backend/supabase/functions && deno check --no-remote ai-chat/index.ts places/index.ts event-sync/index.ts review-summary-worker/index.ts scheduled-jobs/index.ts` | **PASS**. 참고: 민규 `service-api/index.ts`는 **FAIL** — `service-api/routes.ts:155` maintenance 응답 타입(선택 필드 `undefined`가 JsonValue 불일치). 이번 작업이 건드리지 않은 기준선 파일(해시 동일)의 기존 문제, 실행에는 영향 없음 → [민규 요청 R6](2026-09-29-claude-minkyu-requests.md) |
| 실제 Edge(2026-09-30 추가) | 임시 실행 폴더(`edge_runtime.enabled=true`, 함수별 `verify_jwt=false`, 합성 설정만, 외부 키 없음)에서 `npx supabase@2.116.0 functions serve` → `EDGE_*=… node --test tests/integration/jonghyun/edge-functions-e2e.mjs` | **PASS 7/7**(edge-runtime v1.74.3): ai-chat 401/200 unavailable/400/413, places 401/503, event-sync 403/503, worker 403/200 not_enabled, `scheduled-jobs/daily`→service-api maintenance·worker 함수 간 호출 200. 첫 실행에서 **event-sync가 공급사 설정 누락 시 인증 전 503**(설정 상태 노출) 발견 → `event-sync/index.ts`를 인증 후 503으로 수정, 단위 검사 갱신 후 재실행 PASS |
| CORS 관찰(실제 gateway) | 같은 e2e의 OPTIONS 관찰 | **FAIL(기존 문제 재현)**: 허용·비허용 Origin 모두 게이트웨이가 200 + `Access-Control-Allow-Origin: *`. 함수 자체 CORS보다 게이트웨이 설정이 앞선다. 민규 기존 PARTIAL과 동일, 해결은 민규 |
| 실제 PostgREST(2026-09-30 추가) | `EVENTS_REST_*=… node --test tests/integration/jonghyun/ai-event-discovery-rest.mjs` | **PASS**: 행사 AI 탐색 순서·취소 제외·출처 KOPIS·링크 null·한도 도달 partial·재확인 |
| 브라우저(로컬 미리보기) | chrome-devtools로 질문 HTML 열기·선택·복사 | **PASS**: 9문항 × 4선택지, 기본 선택 0, 미응답 표기, 가로 넘침 없음 |

- 실제 DB·PostgREST 검사는 **답변 반영 전 코드**에서 실행했다. 답변 반영 변경(Q1 부분 결과, Q4 행사 카드·포트, 주석)은 AI 오케스트레이터·카드 계층이며 DB·SQL 동작을 바꾸지 않아 가상 254/254·타입 검사로 확인했다. 행사 AI 포트의 실제 PostgREST 경유 실행은 2026-09-30 추가 검사로 **PASS**.
- `*_DATABASE_URL`은 `127.0.0.1:55422/postgres`만 허용한다. 로컬 키는 `npx supabase@2.116.0 status --workdir <임시 폴더> -o env`에서 셸 변수로만 읽고 출력·기록하지 않았다.
- `*-rest.mjs`는 새 RPC를 민규 transport에 **테스트 전용 허용 목록**으로 넣는다. 운영 코드는 우회하지 않으며 운영 경로의 차단은 가상 검사(`ai-chat-http`, `review-summary-worker`, `event-sync`)가 기록한다.

### 미실행·차단

- **NOT_RUN:** 실제 AI 호출, 운영(원격) Edge·gateway, 화면 연결, 원격 DB·배포·커밋·푸시. 로컬 Deno 검사·로컬 Edge는 2026-09-30 실행(위 표). 로컬 gateway CORS는 기존과 같이 미충족.
- **BLOCKED(민규):** 운영 허용 목록·정식 마이그레이션·환경값·HTTP 경로([요청](2026-09-29-claude-minkyu-requests.md)). 행사 AI는 user-client에 `list_public_events` 추가도 필요(요청 R2에 포함).
- 외부 호출: AI 0회, Kakao 1회, KOPIS 실키 1회(+키 없는 확인), 서울은 공개 sample 키로 HTTP 확인만.
- 이전 인계의 PASS는 이번 결과로 옮겨 쓰지 않았다.

## ④ 연결·운영 인계

- **API/RPC:** 제안 SQL 서명은 [민규 요청 R1·R2](2026-09-29-claude-minkyu-requests.md). 새 HTTP: `POST /functions/v1/ai-chat`, `GET /functions/v1/places`, `POST /functions/v1/event-sync`, `POST /functions/v1/review-summary-worker`, `POST /functions/v1/scheduled-jobs/daily`(기존 `POST /scheduled-jobs` 유지).
- **AI 응답 계약 변경:** `AiChatResult.partial?: true`, 행사 카드 `sourceName` 필수·`sourceUrl` null 허용, `conditionStatus`(match/needs_check).
- **migration 순서:** 기존 28개 → 01 → 02 → 03 → 04. 03은 `worker_jobs_status_check`, `worker_jobs_check1` 제약 이름에 의존. 원격 미적용.
- **환경값 이름:** [요청 R4](2026-09-29-claude-minkyu-requests.md). 값·키는 기록하지 않았다. `REVIEW_SUMMARY_MODEL_VERSION`은 `potens.<POTENS_MODEL>`과 같아야 worker가 점유한다.
- **남은 자원:** 전용 DB를 28개 기준으로 다시 초기화하고 가상 자료 0건 확인 뒤 Supabase 정지(볼륨 보존), Colima `yumidang-minkyu` 정지. 임시 폴더 `/private/tmp/yumidang-jonghyun-db.*`(기준 28개), `/private/tmp/yumidang-jonghyun-applied.*`(28+제안 4) — 재현용, 삭제 가능. 기본 Colima·`oneuldo-local`은 건드리지 않음.
- **프론트(유미·성호):** [화면 계약](2026-09-29-claude-frontend-contract.md) — AI 상태·`partial` 안내·`needs_check`·unavailable·대화 정리, 행사 카드 “출처: KOPIS”, 장소 응답, 행사 조회 예정 계약, 요약 비활성 표시.

## ⑤ 남은 질문과 다음 순서

남은 결정은 [미정사항.md](../../../../정책.md#follow-ups)(민규·팀 회의용)에 모았다. 질문 HTML은 [2026-09-29-claude-implementation-questions.html](2026-09-29-claude-implementation-questions.html)(답변 완료).

**Codex가 먼저 검토할 위험 지점**

1. `03_review_summary_worker.sql`의 `create or replace`된 `private.invalidate_appointment_review_summaries`·`refresh_review_summary_state`가 기존 outbox·잠금 순서를 보존하는지(민규 동시성 6개·후기 e2e 통과).
2. `claim_job` 재정의에서 점유 만료 재점유가 `failed_attempts`를 늘리지 않고 `retry_job`만 늘리는지.
3. worker의 부작용 없는 RPC 확인(`probeSummaryWorkerRpcs`, 9회 호출) 운영 비용.
4. 예산 원장의 미정산 예약이 영구 소비로 남는 보수 처리와 재설정 절차 부재.
5. `scheduled-jobs/index.ts` 재구성([패치](2026-09-29-claude-scheduled-jobs-index.diff))과 기존 maintenance 투영의 동일성(기존 검사 8/8 무수정 통과).
6. Q1 변경: `orchestrator.ts`에서 `partial` 결과가 재확인 후 0건이면 `unavailable`(changed)로 가는 흐름, `notice` 결합.
7. KOPIS 인증서 만료(2026-12-13)와 문서화되지 않은 HTTPS 경로.

**이어서 할 작업과 명령**

```sh
# 1) 재현(가상): 저장소 최상위
node --test tests/functions/jonghyun/*.test.mjs tests/ai/jonghyun/*.test.mjs tests/integration/jonghyun/*.test.mjs
# 2) 실제 로컬 DB(전용 환경): tools/local/README.md의 colima/supabase 시작 절차 후
python3 -B tests/database/jonghyun/run_proposals.py --all
# 3) 민규 반영 후: 허용 목록 대기 기대값을 성공으로 바꾸고 ai-chat(공고·행사)/worker/event-sync 로컬 Edge 확인
# 4) 미정사항 회의 결과 반영. Q6 자료가 오면:
node tests/ai/jonghyun/synthetic-eval.mjs            # 계획 확인(호출 없음)
# node tests/ai/jonghyun/synthetic-eval.mjs --live   # 0원 근거·상한 환경값을 셸에 명시한 경우에만
```

설계 파일 체크박스는 완료 기준을 실제 충족한 41개만 갱신했고 미충족 15개는 그대로 두었다. 사용자 결정 표에는 이번 답변(Q1~Q4, Q9, 미정사항 공유)만 날짜와 함께 추가했다.

## ⑥ 2026-09-30 미정사항 결정 후속(자동 재개 포함)

사용자 결정표 U1~U13 답변을 [설계 결정 표](../../../../260929_종현담당_PLAN.md)에 기록하고, [미정사항](../../../../정책.md#follow-ups)을 민규·팀 처리 목록(T1~T5, M1~M6)으로 정리했다. 진행 기록은 [재개 목록](2026-09-30-resume-todo.md).

| 항목 | 구현·결과 |
|---|---|
| U10 TourAPI 두 번째 행사 공급사 | 키 형식: 공식 HTTPS 주소에 두 방식 각 1회 → 둘 다 결과 코드 0000(인코딩 대상 문자 없음) → 로컬 `.env`의 `TOUR_API_KEY_FORMAT=decoded`(키는 미변경). `_shared/integrations/events/tourapi.ts` 신규(고정 `https://apis.data.go.kr/B551011/KorService2/searchFestival2`, JSON, 200 속 오류·XML 공통 오류 구분, 전화·좌표·이미지 미저장, 링크 null), `event-sync/index.ts` 등록부에 `tour-api`, 행사 카드 표시 이름 “한국관광공사”. 가상 검사 `event-provider-tourapi.test.mjs` 6/6, **실제 1페이지(2026-10-05~11, rows 5) 5건 정규화 OK** |
| U9 행사 필터 값 | 제안 SQL [05_event_filter_values.sql](2026-09-29-claude-proposed-sql/05_event_filter_values.sql)(`list_event_filter_values`, 제공처별 원문 값, 취소만 가진 값 제외) + 검사 `tests/database/jonghyun/event_filter_values.sql`, 저장소 `listEventFilterValues` |
| U6·U7 운영값 | [운영값 보수 제안](2026-09-30-operational-values-proposal.md)(항목별 이유, AI 예산 원장 월 교체·즉시 교체 조건·한도 산식) — 미확정, 민규·팀 검토 |
| U2 포텐스닷 정책 | 보안 문서: 학습 미사용·타사 미배포·TLS 1.2. 보관 기간 언급 없음 → 미정사항 T1(한 줄 문의) |
| U4·U13 | 민규 요청 R3에 “매일 00:01 Asia/Seoul”, “공개 프로필(S14)에만 성향 추가” 반영 |
| 검증(재실행) | 가상 **260/260**, 민규 97/97, Deno 진입점 5개 PASS, 실제 로컬 DB `run_proposals.py --all` **5/5**, 민규 SQL 회귀(제안 5개 적용) 8/8. DB·Colima 다시 정지, 가상 자료 0 |
