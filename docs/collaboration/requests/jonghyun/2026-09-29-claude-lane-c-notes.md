# 2026-09-29 lane C 인계 — C 방식 자연어 탐색의 실제 검색·성향·HTTP 연결 (설계 5.3)

작업자: jonghyun(에이전트 C). 기준: `ff9c14f` + 기존 미커밋 37개(보존, lane C 파일과 겹침 없음). 실제 모델 호출·외부 호출·원격 DB 변경·커밋·푸시는 하지 않았다. 아래 PASS는 **가상 모델·가상 RPC 기반 오프라인 검사**와 **전용 로컬 DB의 BEGIN→ROLLBACK 제안 SQL 검사**에 한정한다.

## 1. 구현한 것

| 파일 | 내용 |
|---|---|
| `_shared/contracts/ai.ts` | `AiFilters`에 `sort`·`authorAge`·`interests`·`conversationStyles`(공고 전용) 추가. `PreferenceCondition = {values:[{text,polarity}], combine?}`. 카드의 `preferenceMatch`를 `conditionStatus:{mbti?,interests?,conversationStyles?}`(`match`/`needs_check`)로 교체. `TrustedChatContext.preferences.conversationStyle`(문자열)을 `conversationStyles`(배열)로 변경 |
| `chatbot/intent.ts` | 새 필터 검증. 값 1~10개(기술 상한), 값 1~40자 정규화(앞뒤 공백 제거·연속 공백 1칸), 같은 값 중복 금지, include가 2개 이상이면 `combine` 필수(누락 시 `PREFERENCE_COMBINE_REQUIRED`). 행사 대상에 새 필터가 오면 `UNSUPPORTED_FILTER` |
| `chatbot/prompts.ts` | 해석 프롬프트: 명시 조건만, 부정은 exclude, AND/OR·대상 모호는 clarify, 본인 성향은 사용자가 직접 가리킬 때만. 새 `PREFERENCE_MATCH_PROMPT` |
| `chatbot/preference-match.ts` (신규) | `judgePreferences`(task `preference_match`), `parsePreferenceJudgments`(엄격 검사), `evaluatePreferenceCondition`, `preferenceFieldState`, `PreferenceJudgmentError` |
| `chatbot/traits.ts` (신규) | `fetchPostAuthorTraits`(get_post_author_traits 응답 엄격 검사), `loadMyPreferences`(get_my_profile_traits) |
| `chatbot/discovery.ts` (신규) | 실제 `PublicDiscoveryPort` = `createPostDiscovery({db, model, limits})`. 기존 `searchPublicPosts`+`createRpcPublicPostSearchRepository` 재사용(정렬·커서 재구현 없음) |
| `chatbot/settings.ts` (신규) | `loadAiChatSettings(read)` — 모든 한도를 `requiredPositiveInt`로 읽음, 기본값 없음 |
| `chatbot/tools.ts` | 포트 계약 변경: `search → {cards, coverage: exhausted|filled|incomplete}`, `recheck(cards:[{kind,id,traitsVersion?,conditionStatus?}]) → {cards, complete}` |
| `chatbot/result-builder.ts` | 요청한 조건마다 상태 필수·요청 안 한 조건 상태 거절, 공개 필드만 복사(성향 버전 제거) |
| `chatbot/orchestrator.ts` | coverage/complete 처리, 행사 포트(`events`) 선택, 결합 방식 누락 → 질문, 재확인 후 0건 처리 |
| `chatbot/context.ts` | 본인 성향 `conversationStyles` 배열 |
| `ai-chat/handler.ts` | `createAiChatHandler(deps)` — CORS·경로(`/functions/v1/ai-chat`, `/ai-chat`)·POST·인증·본문 제한·안전한 오류 |
| `ai-chat/index.ts` | `createAiChatRuntime(read, fetchImpl?, options?)` + 기본 Deno 진입점(import 시 환경 읽기·서버 시작 없음) |
| 제안 SQL `02_profile_traits.sql` | `private.profile_traits` + `set_my_profile_traits`/`get_my_profile_traits`/`get_post_author_traits` |

### 1.1 판단 규칙(서버 계산)

- 모델은 요청 값 i마다 “후보 등록값 중 하나라도 의미가 같거나 비슷한가”(`similar`/`different`)만 답한다. 모델에는 부정 여부를 보내지 않는다.
- include 값은 `combine`(any=하나 이상, all=모두)으로 결합한다. **exclude 값은 결합 방식과 무관하게 모두 적용**한다(하나라도 비슷하면 불일치). 관심사·대화 방식 두 조건 사이는 AND.
- 세 상태 구분: 불일치 → 제외 / 등록값 없음 → 해당 조건 `needs_check`로 유지(모델에 보내지 않음) / 모델 오류·예산 소진·형식 위반 → `PreferenceJudgmentError` → 결과 `unavailable`.
- 판단 결과 형식: `{judgments:[{ref, interests?, conversationStyles?}]}`만 허용. 모든 ref 정확히 1회, 보낸 종류만, 배열 길이 = 요청 값 수, 값은 두 문자열뿐. 하나라도 어기면 판단 실패.
- 모델 입력: `{requested:{interests?,conversationStyles?}, candidates:[{ref:"c1", ...등록값}]}` — 공고 ID·제목·작성자 이름·지역·MBTI·사용자 ID 없음. 요청했고 등록된 종류만 보낸다.
- MBTI는 기존 `matchesExplicitMbti` 정확 일치(불일치 제외·미입력 확인 필요)를 먼저 적용하고 살아남은 후보만 의미 판단한다.

### 1.2 탐색·재확인 흐름

1. 일반 조건(query·category·cost·availability·기간·sort·authorAge)을 검색 v2에 전달. 결과 순서 = DB 순서(등록일 최신순 기본/시작일 빠른순). 유사도로 재정렬하지 않는다.
2. 페이지마다 성향 조건이 있으면 `get_post_author_traits`로 작성자 성향을 읽고, DB 순서의 연속 구간을 묶음(`AI_CHAT_MATCH_BATCH_SIZE`)으로 판단한 뒤 순서대로 채택한다.
3. `AI_CHAT_MAX_RESULT_CARDS`를 채우면 `filled`, 커서 끝까지 확인하면 `exhausted`, 페이지·호출 한도에 먼저 닿으면 `incomplete`.
4. `incomplete` → `unavailable`(해석 조건 보존, 안내 문구). 결과가 몇 장 있어도 보수적으로 표시하지 않는다(질문 Q-C1). `no_results`는 `exhausted`이고 0건일 때만.
5. 응답 직전 같은 회원 RpcClient로 같은 검색을 `AI_CHAT_RECHECK_MAX_PAGES`까지 다시 훑어 카드가 보이는지 확인하고, 성향 조건이 있으면 성향을 다시 읽어 `traitsVersion`을 비교한다. 사라진 카드·성향 버전이 바뀐 카드는 제외, 새 ID는 넣지 않는다. 재확인 한도 안에 확인하지 못한 카드가 있으면 `unavailable`.
6. 재확인 후 0건: 처음 탐색이 `exhausted`면 `no_results`, `filled`였다면 남은 후보를 보지 않았으므로 `unavailable`(“결과가 방금 변경”).
7. 공개 필드만 바뀐 카드(예: 모집→마감)는 기존 동작대로 **최신 값으로 유지하고 옛 설명만 제거**한다(모집 중만 보기면 제외).

## 2. 설정 변수(이름·용도만, 값은 기록하지 않음)

| 변수 | 용도 |
|---|---|
| `AI_CHAT_MAX_MESSAGES` / `AI_CHAT_MAX_MESSAGE_CHARS` / `AI_CHAT_MAX_TOTAL_CHARS` | 현재 탐색 대화의 메시지 수·메시지 길이·전체 길이 상한(넘으면 새 탐색 안내) |
| `AI_CHAT_MAX_OUTPUT_TOKENS` | 조건 해석·설명 호출의 최대 출력 토큰 |
| `AI_CHAT_SEARCH_PAGE_SIZE` | 검색 v2 페이지 크기(1~50, 50 초과 설정은 오류) |
| `AI_CHAT_MAX_SEARCH_PAGES` | 한 탐색에서 읽을 최대 검색 페이지 수 |
| `AI_CHAT_RECHECK_MAX_PAGES` | 응답 직전 재확인에서 읽을 최대 검색 페이지 수 |
| `AI_CHAT_MAX_RESULT_CARDS` | 한 응답의 최대 카드 수 |
| `AI_CHAT_MATCH_BATCH_SIZE` | 의미 판단 1회에 보낼 최대 후보 수 |
| `AI_CHAT_MAX_MATCH_CALLS` | 한 탐색의 최대 의미 판단 호출 수 |
| `AI_CHAT_MATCH_MAX_OUTPUT_TOKENS` | 의미 판단 호출의 최대 출력 토큰 |

하나라도 없거나 형식이 틀리면 AI 탐색은 인증 후 200 `unavailable`이다. 모델 자체는 lead의 `createConfiguredModel`(`AI_RETENTION_DECISION_ID`, `AI_COST_EVIDENCE_ID`, `AI_BUDGET_LEDGER_ID`, `POTENS_*`)이 ready일 때만 사용하며, 예산 RPC용 내부 클라이언트(`SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_WORKER_SECRET`)가 없어도 `unavailable`이다. 테스트의 숫자는 모두 합성값이다.

## 3. HTTP 계약(`ai-chat`)

- `POST /functions/v1/ai-chat`(별칭 `/ai-chat`), 쿼리 문자열 불가. 본문은 `{clientRequestId(1~128자·기술 상한), messages, currentFilters}` 세 필드만 — `userId` 등 여분 필드는 400.
- 인증: `requirePrincipal`(Authorization 필수). 없음·만료 → 401 `AUTH_REQUIRED`. 본인 성향 조회가 28000이어도 401.
- 본문: `readJson(maxBytes=MAX_REQUEST_BYTES)` → 초과 413, JSON 아님 415/400. 필터·메시지 검증 실패(AiInputError) → 400 `INVALID_REQUEST`(내부 코드 비노출).
- 성공 응답: `{data: AiChatResult, requestId}`, `data.requestId` = 서버 요청 ID(헤더 `X-Request-Id`와 같음).
- 모델 미준비·한도 미설정·본인 성향 조회 실패 → 200 `{status:"unavailable", interpretedFilters: currentFilters, notice}`. 이 경우 검색을 호출하지 않는다.
- CORS: `createCors`(allowedOrigins = `ALLOWED_ORIGINS`, POST, 헤더 authorization/content-type/apikey). 미허용 Origin 403.
- 대화 원문은 응답·오류·로그에 넣지 않는다(이 모듈은 console을 쓰지 않으며 검사로 확인).
- 행사 대상: `createAiChatRuntime(read, fetch, {events})`로 포트를 주입하기 전에는 `unavailable` + “행사 AI 탐색은 아직 연결되지 않았습니다”. lane E 연결 시 `events(db) → PublicDiscoveryPort`(search `{cards, coverage}` / recheck `{cards, complete}`)를 넘기면 된다.
- 생성 설명: 운영 런타임은 `verifyExplanation`을 주입하지 않으므로 설명 모델을 호출하지 않는다(5.7 의미 검사 기준 확정 전).

## 4. 민규 요청(담당 파일 직접 수정 안 함)

| 대상 파일 | 변경 | 이유 | 기대 동작 | 완료 조건 |
|---|---|---|---|---|
| 정식 마이그레이션(신규) | `02_profile_traits.sql` 채택(BEGIN/COMMIT으로 감싸기) | 성향 저장·조회·후보 성향 제공 DB 계약이 현재 없음(`get_my_profile`에 성향 없음) | 로컬 제안 검사와 같은 권한·오류(28000/22023/P0002) | 로컬 재생 + `tests/database/jonghyun/profile_traits.sql` PASS |
| `_shared/db/user-client.ts` | `userRpcs`에 `get_post_author_traits`, `get_my_profile_traits`, `set_my_profile_traits` 추가 | 현재 허용 목록 밖이라 전송 전에 `ACCESS_DENIED` → AI 탐색이 항상 `unavailable` | 회원 JWT로만 호출(RLS·auth.uid 유지) | `tests/functions/jonghyun/ai-chat-http.test.mjs`의 BLOCKED 기록 테스트가 성향 조회까지 진행(기대값 갱신) |
| `_shared/db/internal-client.ts` | `internalRpcs`에 `reserve_ai_budget`, `settle_ai_budget` 추가(lead 01 제안과 동일 요청) | 예산 예약이 service role 전용 | 모델 호출 전 원자 예약 | 예산 원장 설정 후 합성 호출 예약·정산 확인 |
| `service-api` 라우트 | S15-2 저장 경로(예: 회원 인증 `PUT/POST` → `set_my_profile_traits`) 및 S06 가입 직후 선택 성향 저장 경로 | 화면의 성향 편집·가입 선택 성향 저장 수단이 없음 | 22023→400, P0002→404, 28000→401 | 실제 HTTP로 저장→`get_my_profile_traits` 재조회 일치 |
| `get_my_profile`/공개 프로필 RPC | 성향 포함 여부 결정(별도 RPC 유지 또는 포함) | IA 4장: 로그인 회원은 공개 프로필의 성향 열람 | S13/S14 표시와 AI 판단이 같은 저장값 사용 | 계약 문서 반영 |
| `supabase/config.toml`·배포 환경 | `ai-chat` 함수 등록과 `AI_CHAT_*` 주입 | 런타임 진입점 연결 | 설정 누락 시 unavailable | 로컬 Edge에서 401/400/413/200 확인 |

## 5. 확인이 필요한 사항(사실 기록, 추정 없음)

- **Q-C1 한도에 닿았을 때 일부 결과 표시**: 현재 구현은 설계대로 보수적 처리(찾은 카드가 반환 분량보다 적으면 전부 숨기고 `unavailable`). 찾은 카드를 “일부만 확인했다”는 안내와 함께 보여줄지는 제품 결정이다(lead 질문 HTML 대상).
- **Q-C2 exclude 결합 규칙**: “exclude 값은 항상 모두 적용, combine은 include끼리”로 구현했다. “A와 B 둘 다인 사람만 싫다” 같은 결합 부정은 지원하지 않는다.
- **Q-C3 공개 필드 변경 카드**: 재확인에서 성향 버전이 같고 공개 필드(상태 등)만 바뀐 카드는 기존 테스트 동작대로 최신 값으로 유지하고 설명만 제거한다(사라짐·성향 변경은 제외). 이 해석을 유지할지 확인이 필요하다.
- **기술 상한**: 요청 값 10개/40자, 등록 값 20개/40자, 성향 조회 50 ID, `clientRequestId` 128자는 입력 크기 제한용 기술 값이며 제품 정책이 아니다. S15-2 화면의 실제 칩 수·길이 정책이 정해지면 맞춘다.
- **분류 값**: AI 필터의 `category`는 문자열 검사만 한다. 검색 v2는 한국어 고정 목록만 받으므로 모델이 목록 밖 값을 내면 검색 입력 오류 → `unavailable`이다(계약 문서 예시의 `exhibition`도 해당). 프롬프트에 분류 목록을 넣을지는 lead의 계약 문서 동기화 때 결정.
- **본인 공고**: `get_post_author_traits`는 요청 회원 본인의 공고도 다른 공고와 같이 반환한다(검색 v2 가시 범위와 동일).
- **`backend/contracts/ai-chat.md` 동기화(lead 소유)**: 새 필터·`conditionStatus`·coverage 규칙·HTTP 계약·설정 변수 이름을 반영해야 한다. `preferenceMatch`는 더 이상 사용하지 않는다.

## 6. 검사 명령과 결과(2026-09-29 실행)

| 명령 | 결과 |
|---|---|
| `node --test tests/ai/jonghyun/chatbot.test.mjs tests/ai/jonghyun/chatbot-semantic.test.mjs tests/functions/jonghyun/ai-chat-http.test.mjs tests/integration/jonghyun/discovery-flow.test.mjs` | PASS 45 / FAIL 0 (13 + 17 + 10 + 5) |
| `node --test tests/ai/jonghyun/model-router.test.mjs tests/ai/jonghyun/budget-runtime.test.mjs tests/functions/jonghyun/search-service.test.mjs tests/functions/jonghyun/search-repository.test.mjs` (인접 회귀) | PASS 42 / FAIL 0 |
| `python3 -B tests/database/jonghyun/run_proposals.py --proposal .../01_ai_budget.sql --proposal .../02_profile_traits.sql --test tests/database/jonghyun/profile_traits.sql` | `PASS tests/database/jonghyun/profile_traits.sql` / `failed=0 (transaction rolled back)` |

- Deno 미설치로 Deno 타입 검사·실제 Edge 실행은 NOT_RUN. Node 타입 제거 실행만 확인했다.
- 실제 모델 호출 NOT_RUN(추가 지출 0원 근거 미확인). 실제 DB의 검색 v2 + 성향 RPC를 함께 쓰는 HTTP 연결은 허용 목록 미반영으로 BLOCKED(테스트로 현재 상태를 기록).
- 기존 검사 변경(계약 의도 변경): `chatbot.test.mjs`의 가상 포트를 `{cards,coverage}`/`{cards,complete}`로 감쌌고, 본인 성향을 `conversationStyles` 배열로, MBTI 검사를 `conditionStatus` 기준으로 바꿨다. `discovery-flow.test.mjs`의 행사 검사는 `events` 포트로 옮겼다. 검사 의도(순서 보존·비공개 필드 제거·설명 제거 등)는 유지했다.
