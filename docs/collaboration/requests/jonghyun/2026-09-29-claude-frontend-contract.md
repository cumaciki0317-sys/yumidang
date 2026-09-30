# 화면 연결 계약 — AI 탐색·장소·행사·후기 요약 (유미·성호 전달용)

기준: 2026-09-30 종현 범위 로컬 구현(사용자 답변 Q1·Q4·Q9 반영). **아직 실제 서버에서 켜진 기능이 아니다.** 아래 "현재 상태"가 연결 가능 여부다. 응답은 모두 공통 envelope `{data, requestId}` / 오류 `{error:{code,message,retryable}, requestId}`이며 헤더 `X-Request-Id`와 같다.

## 1. AI 탐색 — `POST /functions/v1/ai-chat` (로그인 회원만)

현재 상태: 백엔드 코드·가상 검사 완료. 민규 허용 목록·DB 반영과 모델 비용 근거가 없어 **실제로는 항상 `status:"unavailable"`**. 화면은 이 상태를 정상적으로 처리해야 한다.

요청 본문은 세 필드만(다른 필드 400):

```json
{ "clientRequestId": "화면에서 만든 1~128자", "messages": [{"role":"user","content":"이번 주말 조용하게 전시 볼 사람"}],
  "currentFilters": {"target":"posts"} }
```

- `messages`는 **현재 탐색 중 화면 메모리의 대화만**. 탐색 종료·새 탐색·로그아웃 때 화면에서 지운다. 서버는 대화를 저장하지 않는다.
- 인증 없음/만료 401 → 로그인 안내. 본문 초과 413, 형식 오류 400.

응답 `data`(AiChatResult):

| status | 화면 |
|---|---|
| `results` | `cards` 표시. 순서는 **등록일 최신순(기본)/시작일 빠른순(선택)** 그대로 — 화면에서 재정렬하지 않는다. |
| `no_results` | 조건에 맞는 공고가 실제로 0건. 적용 조건(`interpretedFilters`)과 조건 변경 안내. |
| `needs_clarification` | `clarificationQuestion` 한 문장 질문 표시(예: 여러 관심사를 “둘 다/하나라도” 중 무엇으로 볼지). |
| `results` + `partial:true` | 2026-09-30 결정(Q1-A): 한도 때문에 끝까지 확인하지 못했지만 찾은 카드가 있음. 카드와 함께 “일부만 확인했어요” 안내(`notice`)를 반드시 보여준다. 전체 결과처럼 표시하지 않는다. |
| `unavailable` | `notice` 표시 + 다시 시도 / 일반 탐색(S01) 이동. **0건으로 표시하지 않는다.** 한도·모델·설정 미준비, 행사 AI 미연결 모두 여기로 온다. |

- `interpretedFilters`: 서버가 해석한 조건. 수정 가능한 칩으로 보여준다. 공고 전용 새 조건: `sort`, `authorAge`, `interests`, `conversationStyles` — 형식 `{values:[{text,polarity:"include"|"exclude"}], combine?:"any"|"all"}`.
- 카드: `kind, id, title, locationLabel(동까지), startsAtOrDate, endsAtOrDate, costLabel, state, canApply`, 요청한 성향 조건이 있으면 `conditionStatus:{mbti?, interests?, conversationStyles?}` 값 `match` 또는 `needs_check`.
  - `needs_check` = 상대가 해당 성향을 입력하지 않음 → **“확인 필요”** 표시. 불일치 후보는 서버가 이미 뺐다.
  - 유사도 점수·상대 성향 원문은 오지 않는다. 만들지 않는다.
- 행사 카드(`kind:"event"`): `sourceName`(예: KOPIS) 필수, `sourceUrl`은 공식 링크가 없으면 `null` → 링크 없이 “출처: KOPIS”로 표시(Q4-A). `canApply`는 항상 false(행사는 신청 대상이 아님).
- `explanations`는 현재 항상 빈 배열(의미 검사 기준 확정 전).

## 2. 성향 편집(S06·S15-2)

저장 RPC는 제안 SQL(`set_my_profile_traits`)만 있고 **HTTP 경로는 민규 추가 대기**. 입력: 관심사·대화 방식 문자열 배열(종류별 최대 20개·값 40자, 중복 불가 — 2026-09-30 결정 Q9-A로 제품 기준), MBTI 네 글자 또는 비움. 저장 실패 시 입력 유지(기존 흐름).

## 3. 장소 검색(공고 작성) — `GET /functions/v1/places?query=…&page=1` (로그인 회원)

현재 상태: 코드·가상 검사 완료, Kakao 실제 호출 1회 200 확인. 함수 등록·`PLACES_PAGE_SIZE` 주입 전에는 503.
응답 `data`: `{status:"results"|"no_results", places:[{source:"kakao", sourceId, placeName, address|null, roadAddress|null}], nextPage:number|null}`. 좌표·거리순 없음. 오류: 입력 400, 인증 401, 공급사 문제 503(재시도 가능). 우편번호는 기존대로 Kakao 우편번호 선택창(프론트 위젯)이며 이 API와 별개다.

## 4. 행사 목록

공개 조회 HTTP(`GET /events`)는 **민규 service-api 추가 대기**. 예정 쿼리: `mode=overlapping|new_this_week|post_selection`, `periodStart`/`periodEnd`(YYYY-MM-DD 둘 다), `ongoingOnly`, `query`, `region`, `category`, `cursor`, `limit(1~50)`. 항목: 행사명·장소명·기간(날짜 또는 시각 정밀도)·상태(`ongoing/upcoming/ended`)·입장료(`unknown`이면 “정보 없음”, 무료로 표시 금지)·제공처. 첫 제공처 KOPIS는 **공식 상세 링크(sourceUrl)가 없어 null**이며 링크 없이 “출처: KOPIS”로 표시한다(Q4-A). 지역·분류는 제공처 원문(예: `서울특별시`, `서양음악(클래식)`)이다.

## 5. 후기·요약

- 후기 공개 규칙은 변경 없음(양쪽 제출 즉시, 한쪽은 완료 알림 확인 가능 +24시간). 제출 성공 후 **새로 조회**하면 반영된다. 이미 열린 화면의 자동 갱신은 별도 연결 필요.
- AI 요약은 한마디 있는 공개 후기 3개 이상일 때만. 현재 요약 worker는 안전 검사 기준 미확정으로 **생성하지 않는다** → 기존 “요약 없음/실패” 상태 표시를 유지하고 원문 후기·칭찬 차트는 그대로 보여준다.

## 6. 확인 순서(연결 시)

실제 서버 연결 뒤 브라우저에서: 401/400/413 처리, `unavailable` 문구·일반 탐색 복귀, `needs_check` 표시, 대화 정리(탐색 종료·새 탐색·로그아웃), 후기 제출 후 재조회, CORS(기존 gateway CORS는 아직 미해결)를 확인한다. 이번 작업에서 브라우저 확인은 **NOT_RUN**이다.
