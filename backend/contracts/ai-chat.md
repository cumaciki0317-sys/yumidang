# AI 탐색 연결 계약 초안

## 2026-09-29 현재 구현 — C 방식 의미 비교·HTTP 연결 (Claude 구현, 종현 범위)

아래 1~6절의 “모델 미정·실제 연결 대기·`preferenceMatch`” 문구는 당시 기록이다. 현재 계약은 이 절과 [lane C 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-lane-c-notes.md)·[전체 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-implementation-handoff.md)를 따른다. 서비스 모델은 포텐스닷 Sonnet 5(요청 ID `claude-5-sonnet`)이며 실제 호출은 추가 지출 0원 근거 확인 전 **NOT_RUN**이다.

- **필터(공고 전용 추가):** `sort`(`created_desc` 기본/`starts_asc`), `authorAge`, `interests`, `conversationStyles`. 성향 조건은 `{values:[{text, polarity:"include"|"exclude"}], combine?:"any"|"all"}`이며 include 2개 이상이면 `combine` 필수(없으면 질문으로 끝냄). exclude는 항상 모두 적용한다. 공고 `category`는 검색 v2 고정 목록만 허용한다.
- **판단(C):** 모델은 요청 값마다 후보 작성자의 등록값과 의미가 비슷한지만 답한다(`preference_match`). 부정·any/all·미입력은 서버가 계산한다. 불일치 → 제외, 등록값 없음 → 해당 조건 `needs_check`(후보 유지, 모델에 보내지 않음), 모델 오류·형식 위반·예산 소진 → `unavailable`. MBTI는 기존 정확 일치 규칙. 모델 입력에는 불투명 ref와 요청·등록값만 넣고 공고 ID·제목·이름을 넣지 않는다.
- **순서·페이지:** 결과 순서는 검색 v2 순서 그대로이며 유사도로 재정렬하지 않는다. 반환 분량을 채우거나 끝까지 확인할 때까지 다음 페이지를 처리한다. 한도에 먼저 닿으면 `unavailable`(해석 조건 보존)이며 `no_results`는 끝까지 확인한 실제 0건일 때만이다.
- **응답 직전 재확인:** 같은 회원 권한으로 검색을 다시 확인하고 작성자 성향 `traitsVersion`을 비교한다. 사라진 카드·성향이 바뀐 카드는 제외하고 새 ID를 넣지 않는다.
- **카드:** `conditionStatus:{mbti?,interests?,conversationStyles?}` 값은 `match`/`needs_check`. 원본 성향 목록·유사도·모델 추론·`traitsVersion`은 반환하지 않는다. `preferenceMatch`는 폐기했다.
- **HTTP:** `POST /functions/v1/ai-chat`, 회원 인증 필수(401), 본문 `{clientRequestId, messages, currentFilters}`만(여분 필드 400, 초과 413), 성공은 공통 envelope의 `AiChatResult`. 모델·한도·본인 성향 조회가 준비되지 않으면 검색 없이 200 `unavailable`. 대화 원문을 로그·오류에 넣지 않는다.
- **2026-09-30 사용자 답변 반영:** Q1-A 한도·예산으로 끝까지 확인하지 못했어도 찾은 카드가 있으면 `status:"results"`, `partial:true`, “일부만 확인” 안내로 보여준다(찾은 카드가 없으면 `unavailable`). Q2-A 제외 조건은 항상 모두 적용, 애매하면 질문. Q3-A 재확인에서 공개 정보만 바뀐 카드는 최신 값으로 유지하고 설명만 제거. Q4-A 행사 카드는 `sourceName`(예: KOPIS) 필수, 공식 링크가 없으면 `sourceUrl:null`. 행사 AI 탐색은 행사 저장소 `list_public_events` 기반 기본 포트로 연결했다(`event-discovery.ts`).
- **현재 차단:** 민규 허용 목록에 `get_post_author_traits`·`get_my_profile_traits`(회원)·`reserve_ai_budget`·`settle_ai_budget`(내부)이 없고 제안 SQL(`02_profile_traits.sql`, `01_ai_budget.sql`)이 정식 마이그레이션이 아니므로 실제 런타임은 항상 `unavailable`이다. 행사 AI 탐색은 회원 user-client 허용 목록에 `list_public_events`가 들어와야 실제로 동작한다.
- **설정 이름(값 없음):** `AI_CHAT_MAX_MESSAGES`, `AI_CHAT_MAX_MESSAGE_CHARS`, `AI_CHAT_MAX_TOTAL_CHARS`, `AI_CHAT_MAX_OUTPUT_TOKENS`, `AI_CHAT_SEARCH_PAGE_SIZE`, `AI_CHAT_MAX_SEARCH_PAGES`, `AI_CHAT_RECHECK_MAX_PAGES`, `AI_CHAT_MAX_RESULT_CARDS`, `AI_CHAT_MATCH_BATCH_SIZE`, `AI_CHAT_MAX_MATCH_CALLS`, `AI_CHAT_MATCH_MAX_OUTPUT_TOKENS`, 모델용 `AI_RETENTION_DECISION_ID`, `AI_COST_EVIDENCE_ID`, `AI_BUDGET_LEDGER_ID`, 선택 `POTENS_USAGE_INPUT_FIELD`/`POTENS_USAGE_OUTPUT_FIELD`. 기본값이 없다.

상태: **종현 내부 탐색 코어 구현**. 가상 모델·검색 포트로 처리 경로를 검증하며 실제 모델·HTTP·DB·보관 설정은 미연결이다. 기준: [최신 계획](../../PLAN.md) 4·6장, [상세 설계](../../PLAN_상세설계.md) 6·9·11.3장, [공개 검색 계약](search.md). HTTP 경로·실제 모델·운영 한도는 연결 전 확정한다. 포텐스닷은 우선 연결 대상이다. 사용자 제공 기본 호출 안내를 받았으며 상세 응답·계정 조건은 미확인이다.

## 1. 입력과 호출자

AI 탐색은 로그인한 회원의 현재 탐색에서만 시작한다. `messages`는 화면 메모리에 있는 이번 탐색의 대화이며 서버 저장소·캐시·작업 메시지에 남기지 않는다. 인증 사용자 ID·관계·허용 프로필 성향은 서버가 확인한다. 클라이언트가 보낸 역할·실명·권한 주장을 신뢰하지 않는다.

```json
{
  "clientRequestId": "local-request-01",
  "messages": [{"role":"user","content":"이번 주말 전시 같이 볼 사람 찾아줘"}],
  "currentFilters": {"target":"posts","category":"exhibition"}
}
```

입력 길이·메시지 수·빈 본문·허용 역할·필터를 검증한다. 요청 빈도·전체 예산의 원자 제어는 공통 연결에 의존한다. 구체적 상한은 모델·예산 결정 후 설정한다. 개발·검증 예산, AI/작업 한도·재시도, 지표/중간 요약 보관기간, 실제 AI 품질 합격 기준·검사 방식은 2026-09-23 사용자 답변에 따라 **미정·팀 검토**로 둔다. `clientRequestId`는 응답 연결용 제안 필드이며 서버의 대화 저장이나 영구 중복 방지 키가 아니다. 같은 요청을 다시 보내면 응답이 달라질 수 있으므로 신청·결제 등의 상태 변경 명령을 이 경로에 두지 않는다.

## 2. 처리·도구·권한

1. 현재 요청 메모리에서 허용 성향과 대화를 구성한다. 현재 대화에서 명시한 조건이 프로필 성향보다 우선한다. 프로필은 관심사·대화 성향·MBTI만 전달한다. 사용자가 특정 MBTI를 명시하면 알려진 불일치는 제외하며, 미입력은 확인 필요로 남긴다.
2. 모델은 조건 해석 또는 근거에 연결된 설명을 제안한다. 서버가 허용 필터·기간·비용·도구 호출을 결정한다. 모호한 중요한 조건은 질문으로 끝낸다.
3. 허용 도구는 [공개 공고·행사 검색](search.md)뿐이다. 임의 SQL·URL 가져오기·사용자 간 채팅 조회·비공개 장소 조회·신청·매칭·결제·메시지 발송은 실행하지 않는다.
4. 공고 카드의 사실 필드와 행사 카드의 사실 필드는 검색 결과에서만 만든다. 모델이 카드 ID·가격·URL을 만들어 넣지 않는다. 설명에 쓴 근거 ID가 실제 결과에 있는지 확인한다.
5. 응답 직전 공개·삭제 상태를 다시 확인하고 제외된 카드에 딸린 설명도 제거한다. 결과가 0건이면 조건을 자동으로 넓히지 않는다.

‘이번 주말 전시’는 주말과 겹치는 장기·신규 전시를 포함하고 금요일에 끝난 전시는 제외한다. 사용자가 ‘신규’라고 명시하면 범위를 좁힌다. ‘근처·주변’은 미지원임을 알리고 장소명·주소를 물어본다. 사용자가 직접 쓴 주소 검색어와 DB에서 확인한 비공개 주소를 구분하며 후자는 모델에 전달하지 않는다. 행사 검색어는 행사명·장소명·공개 주소에 부분 일치하며 대소문자·연속 공백을 무시한다. 공고·행사·후기·사용자 입력에 섞인 지시문은 데이터로 다룬다.

## 3. 출력과 상태

```json
{
  "requestId": "server-request-01",
  "status": "needs_clarification",
  "interpretedFilters": {"target":"posts","category":"exhibition"},
  "clarificationQuestion": "어느 장소명이나 주소로 찾아볼까요?",
  "cards": [],
  "notice": "주변 거리순 검색은 아직 지원하지 않아요."
}
```

| 상태 제안 | 의미 | 응답 의무 |
|---|---|---|
| `needs_clarification` | 필요한 조건이 모호하거나 미지원 주변 요청 | 한 가지 핵심 질문과 현재 해석 조건. 결과를 지어내지 않음. |
| `results` | 공개 검색에서 실제 카드가 나옴 | 검증된 카드와 근거 ID에 연결된 이유·확인할 점. |
| `no_results` | 정상 검색이 0건 | 빈 카드·적용 조건·범위 변경 제안. 자동 확대 없음. |
| `unavailable` | 해석·검색·모델 장애 | 재시도 또는 S01 일반 탐색 안내. 설명 생성만 실패하면 검증된 카드와 정형 안내 가능. |

위 상태명은 현재 내부 TypeScript 코어에 사용한다. 공통 오류 코드·HTTP 매핑은 민규 연결 전 합의한다. 공고 없는 행사는 신청 가능한 동행처럼 표현하지 않는다.

## 4. 실패·기록·확인

| 상황 | 기대 처리 |
|---|---|
| 비로그인·만료 세션 | AI 진입·응답 차단, 로그인 안내. 공개 일반 검색 권한으로 승격하지 않음. |
| 잘못된 필터·입력 초과 | 입력 오류로 반환, 대화나 조건을 임의 보정하지 않음. |
| 모델 형식 오류·시간 초과 | 합의된 상한 내 재시도 후 `unavailable`; 해석 실패 시 임의 조건으로 검색하지 않음. |
| 설명 실패·검색 성공 | 검증된 공개 카드와 정형 안내만 반환. |
| 공고 본문의 명령·없는 근거 ID | 명령 실행과 허위 설명 거절. 필요하면 결과 설명 제거. |

서비스 서버의 이력·오류·사용량 로그에는 대화 원문과 민감 필드를 저장하지 않는다. 로그에는 요청 ID·결과 코드·처리 시간·사용량 같은 비본문 정보만 남긴다. 탐색 종료·새 탐색·로그아웃 때 화면의 대화를 지운다. 외부 AI의 대화·후기 원문 미보관 요구 자체와 예외 허용 범위는 2026-09-23 최신 사용자 지시에 따라 **미정·팀 검토**로 전환했다. 포텐스닷과 실제 모델 제공사의 조건을 각각 확인하며 학습 미사용과 미보관을 구분한다. 팀 결정·계정·엔드포인트 검토 전 실제 제공사를 활성화하지 않는다. 가상 사례는 [계약 사례](../../tests/fixtures/jonghyun/contract-cases.json)에 있으며 모델 품질·실제 비저장 검증으로 간주하지 않는다.

## 5. 구현된 내부 경로와 실제 연결 조건

- `runChat(input,trustedContext,deps,requestId,signal?)`: 공통 인증이 만든 주체, 명시 limits, 모델, 검색·재조회 포트를 주입한다. 클라이언트 userId로 인증하지 않는다.
- 모델 조건 해석 후 검증된 필터만 검색에 전달한다. 상대 날짜는 한국 달력 코드로 계산하며, 미지원 필터를 조용히 버리지 않는다. 현재 내부 필터는 공고/행사 대상·검색어·분류·공고 비용/모집 상태·날짜·MBTI·행사 지역/진행 중/신규다. 나이 등 전체 제품 필터 연결은 공통 조회 계약과 함께 후속 구현한다.
- 결과 ID·사실은 저장소에서 구성한다. 응답 직전 같은 필터·주체로 재검사하며, 검색 순서를 보존하고 바뀌거나 제거된 카드의 설명을 없앤다. 의미 검사기가 없으면 생성 설명 대신 검증된 카드와 정형 안내만 제공한다. 실제 의미 품질은 별도 평가가 필요하다.
- 긴 대화는 확정 필터를 보존하고 새 탐색을 안내한다. 자동 요약·자동 잘라내기·서버 대화 저장은 하지 않는다.
- `createModelRouter`: 서버 구성의 제공사별 `retentionReview`와 원자 예산 예약/정산 포트를 주입한다. 보관 검토가 pending이거나 approved의 결정 참조가 없으면 `RETENTION_REVIEW_PENDING`으로 호출 전에 차단한다. approved는 팀이 정한 기준 검토 완료이며 ZDR을 강제하거나 실제 보관 조건을 코드가 증명한다는 뜻이 아니다. 확인된 일일 한도 소진 오류에만 승인된 대체 모델로 전환한다. 단순 429나 시간 초과를 일일 한도로 추정하지 않는다. 사용량 불명 실패의 예약을 무조건 환불하지 않는다.
- 포텐스닷 무료 종료는 2027년 6월경이라는 사용자 추정이다. 정확한 종료일·API 무료 포함 여부·모델·한도·보관은 미확인. AI 개발·검증 예산의 금액/기간은 최신 사용자 답변에 따라 **미정·팀 검토**이며 현재 승인된 유료 호출 예산은 없다.
- 모델 토큰/문자 수·요청 수·대체 공급사·비용 기본값을 운영값처럼 숨기지 않는다. 테스트 값은 합성 사례 전용이다. 실제 제공사 어댑터·HTTP 진입·사용량 저장·사용자별 제한은 후속 연결이다.

포텐스닷의 Claude 기반, HTTP 호출 규격·모델 식별자는 [사용자 제공 API 안내](../../docs/collaboration/requests/jonghyun/2026-09-23-potens-api-reference.md)에 키를 제외하고 정리했다. 안내의 기본 식별자는 claude-4-6-sonnet이며 유미당의 최종 모델 선정은 미정이다. 실제 응답 상세·계정 한도·계약 적용은 미확인이고 API 연결은 대기한다. 외부 보관 기준의 현재 상태와 질문 목록은 [팀 검토 문서](../../docs/collaboration/requests/jonghyun/2026-09-23-team-ai-retention-review.md), 비용·제공사 자료는 [확인 자료](../../docs/collaboration/requests/jonghyun/2026-09-23-ai-cost-and-retention.md)를 따른다. 기존 미보관 필수 결정을 현행 요구로 사용하지 않는다.

## 6. 원문 없는 지표 인터페이스

`createMetricsRecorder({sink,modelVersions,promptVersions,now?})`는 서버가 정한 버전 목록과 기록 수신부를 주입받는다. `begin(feature)`에서 만든 요청 UUID로 `runChat` 응답을 연결할 수 있다. `finish`에는 고정 결과 코드·재시도 횟수·허용된 모델/프롬프트 버전·정수 토큰 수만 전달하고 시간은 모듈이 계산한다. 임의 requestId·metadata·오류 객체·원문·회원 식별자를 받지 않는다. 같은 실행의 중복 finish와 기록 실패는 정형 상태로 구분하며 원문 예외나 자동 재시도를 만들지 않는다.

현재 이 지표 모듈은 가상 수신부로 검증했다. 실제 처리 코드/공통 logger 연결·저장 위치·보관기간은 별도 연결 항목이다. 배포 설정의 버전 목록을 요청 본문으로 구성해서는 안 되며, 이 모듈의 검사가 외부 제공사의 보관 조건을 증명하지 않는다.
