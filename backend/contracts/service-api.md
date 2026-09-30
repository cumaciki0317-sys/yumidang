# 민규 서비스 API 런타임 계약

현재 구현은 `Request → 인증 → 입력 검증 → service → repository → 고정 RPC`로 연결된다. 시간·관계·동시성·상태 전이는 DB RPC가 결정하며 서비스 모듈은 같은 정책을 복제하지 않는다. 실제 로컬 Auth/JWT/DB 통합 결과는 [민규 현황](../../docs/collaboration/minkyu.md)에 별도로 기록한다.

## HTTP 및 인증

- Supabase 경로는 `/functions/v1/service-api`이며 직접 실행용 `/service-api`도 지원한다. 아래 표의 경로를 뒤에 붙인다. 임의 suffix, 인코딩 우회, 알 수 없는 경로는 404다.
- 기존 사용자 경로는 `Authorization: Bearer <검증되는 사용자 access token>`을 요구한다. 공개 검색의 선택 인증은 아래 검색 연결 계약을 따르며 종현 검색 코어와 민규 HTTP 경계를 연결한다. DB `get_service_post`의 비로그인 공개 반환 지원과 이 API의 사용자 인증 요구는 별개다.
- 내부 유지보수는 별도 내부 secret을 Bearer로 받는다. 사용자 JWT·서비스 역할 키 자체를 내부 비밀로 대신 사용하지 않는다. 사용자 경로가 실패해도 내부 클라이언트로 재시도하지 않는다.
- 허용된 정확한 Origin만 CORS 응답을 받는다. preflight 허용 헤더는 `authorization, content-type, apikey`다. apikey 자체는 사용자 인증이 아니다.
- POST는 `application/json`과 객체 본문을 사용한다. 인자가 없는 POST도 `{}`를 보낸다. 초과 필드·타입 불일치·중복 query는 400이다. 크기 한도는 `MAX_REQUEST_BYTES` 설정값이다.
- 성공은 `{data,requestId}`, 실패는 `{error:{code,message,retryable},requestId}`이며 동일 ID를 `X-Request-Id`에 넣는다. 사용자 요청 ID를 복사하지 않는다. `Cache-Control: no-store`가 적용된다.
- `data`는 각 고정 RPC 결과다. 기존 table-returning RPC는 snake_case 객체 배열, 신규 JSON RPC는 해당 DB 계약의 camelCase 객체다. 배열 첫 항목을 암묵적으로 꺼내거나 없는 결과를 성공 객체로 만들지 않는다.
- 인증 실패 401, 권한 거절 403, 대상 부재 404, 상태·조건 버전 충돌 409, 설정/외부 연결 누락 503이다. DB 오류 원문·토큰·SQL·채팅/후기 원문을 로그나 오류에 넣지 않는다.

## 사용자 경로

`id`는 UUID다. 목록에 표시한 경우에만 `?limit=1..100&before=<UUID>`를 허용한다. 생략 시 limit20은 페이지 크기이며 서비스 운영 시간 정책이 아니다.

| 메서드·경로 | 입력 및 고정 RPC |
|---|---|
| GET `/me` | `get_my_profile()`; 본인 필드만 |
| POST `/me/avatar` | `{avatarPath}` → `set_my_profile_avatar`; `<user UUID>/<image UUID>.jpg` 경로, 실제 Storage 객체 소유권·MIME·크기는 DB 확인 |
| GET `/appointments` | `list_my_appointments()` |
| GET `/appointments/:id` | `get_appointment_state(p_appointment_id)` |
| POST `/appointments/:id/confirm-completion` | `{}` → `confirm_appointment_completion`; 한쪽 확인은 완료 전 유지 |
| GET `/appointments/:id/reviews` | `get_appointment_review_state` |
| POST `/appointments/:id/reviews` | 아래 후기 입력 → 5인자 `submit_appointment_review` |
| GET `/profiles/:id/reviews` | 페이지 query → `get_public_profile_reviews`; 공개 원문·칭찬 집계 |
| GET `/notifications` | 페이지 query → `list_my_notifications` |
| POST `/notifications/:id/read` | `{}` → `mark_my_notification_read`; 동의·완료를 실행하지 않음 |
| POST `/notifications/read-all` | `{}` → `mark_all_my_notifications_read` |
| GET `/conversations` | `list_conversations()` |
| GET `/conversations/:id` | 신청 ID → `get_conversation` |
| GET `/conversations/:id/messages` | 페이지 query → `list_conversation_messages` |
| POST `/conversations/:id/messages` | `{messageId,content}` → `send_conversation_message`; content1..1000자, 같은 재시도 ID 유지 |
| POST `/posts` | 아래 무료 공고 입력 → `create_service_post` |
| GET `/posts/:id` | `get_service_post`; 마스킹과 확정 당사자의 비공개 필드 구분은 DB 검사 |
| POST `/posts/:id/requests` | `{message}` 10..300자 → `request_service_post`; 지원되는 무료 공고에만 신청 |
| GET `/requests/sent` | `list_sent_join_requests()` |
| GET `/requests/received` | `list_received_join_requests()` |
| GET `/requests/:id/consent` | `get_match_consent`; 참여자가 현재 조건·버전 확인 |
| POST `/requests/:id/withdraw` | `{}` → `withdraw_join_request` |
| POST `/requests/:id/decline` | `{}` → `decline_join_request` |
| POST `/requests/:id/propose` | `{}` → 작성자 `propose_match`; 약속을 즉시 확정하지 않음 |
| POST `/requests/:id/accept` | `{conditionVersion}` → 신청자 `accept_match`; 조회한 동일 버전 필요 |

후기 입력:

```json
{"rating":5,"experience":"positive","comment":"편안하게 대화했어요","praises":[]}
```

rating은 정수1..5, experience는 `positive|neutral|negative`, comment는 선택/null 또는1..300자다. praises는 최대3개이며 positive에만 허용한다. 실제 칭찬 목록이 아직 확정되지 않아 DB는 현재 비어 있지 않은 praises를 거절한다. 별점을 당도로 환산하지 않는다. 제출 성공 뒤 현재 공개 상태를 조회한다. 양쪽 제출은 24시간 전이어도 즉시 공개하고, 한쪽은 완료 알림 확인 가능+24시간부터 공개하며 그 이후 기한 내 제출은 즉시 열람한다. 실제 분쟁·미완료·불발/노쇼는 제외한다. 일반 후기 작성 기간은 실제 완료부터 7일이다. 실제 분쟁 중 기한 보류와 동행 인정 후 남은 기간 재개·최소 24시간의 기존 예외는 유지한다.

공고 입력 예시(가상):

```json
{
  "postId":"11111111-1111-4111-8111-111111111111",
  "title":"무료 전시 동행",
  "description":"함께 전시를 관람해요",
  "category":"전시",
  "startsAt":"2099-01-01T10:00:00+09:00",
  "endsAt":"2099-01-01T12:00:00+09:00",
  "recruitmentEndsAt":"2099-01-01T09:00:00+09:00",
  "publicArea":"서울특별시 성동구 성수동",
  "registeredPlaceName":null,
  "registeredAddress":"가상 등록 주소",
  "meetingDetail":"가상 만남 상세",
  "preferenceNote":null,
  "tags":[],
  "costType":"free",
  "amount":0
}
```

제목2..80자, 소개1..2000자, 공개지역 최대60자, 장소명 최대200자, 등록주소1..300자, 만남상세2..200자, 선택 선호문구 최대300자, 태그 최대5개·각20자다. 문자열은 앞뒤 공백을 허용하지 않는다. 시간은 offset 또는 Z가 있는 ISO 문자열이며 종료가 시작보다 늦고 모집 종료가 시작 이하여야 한다. 현재 지역 형식은 기존 DB 제약을 따르며 임의로 바꾸지 않는다.

유료 `paid_request|paid_offer`는 503이며 공급사 연결 없이 성공 처리하지 않는다. 신규 무료 공고와 달리 비용 미상인 기존 공고는 `request_service_post`에서 차단된다. 클라이언트 `authorId`, `userId`, 권한·성별·확정 상태 필드는 허용하지 않는다. PASS 가입, 공고 수정·삭제, 은행 확인, 분쟁 판정, 당도 산식 경로는 미정 사항을 임의 결정해 추가하지 않았다.

## 내부 유지보수

`POST /internal/maintenance` 본문은 `{ "limit": 20 }`이며 정수1..100이다. 별도 내부 secret·DB 설정은 필수다. 모델/프롬프트 버전 누락이나 모델 전용 설정 오류가 후기 공개 정리를 막지 않는다. 자동 완료는 [건별 예약 실행기](completion-db.md)가 담당하며 여기서 `process_due_completions`를 호출하지 않는다.

1. 내부 호출자·공통 설정·본문을 검증한다.
2. 모델 없이 `process_due_review_publications(p_limit)`를 호출한다. 실패하면 기존 HTTP 오류를 반환하고 요약 등록을 시작하지 않는다.
3. 서버의 `REVIEW_SUMMARY_MODEL_VERSION`, `REVIEW_SUMMARY_PROMPT_VERSION`이 유효하면 `process_review_summary_refresh(p_limit,p_model_version,p_prompt_version)`를 별도 트랜잭션으로 호출한다. 이 연산은 모델 생성이 아니라 작업 등록이다.
4. HTTP 200의 data는 `{status:"ok"|"partial",completion:{status:"managed_by_reservation"},reviews:{status:"published",publishedCount},summary:...}`다.

summary 결과는 성공 시 `{status:"queued",processedCount,enqueuedCount}`, 설정 누락/오류 시 `{status:"pending_configuration"|"configuration_error"}`, 실행 실패 시 `{status:"failed",code,retryable}`다. 공개 정리 이후 요약 대기·실패는 `partial`이며 가짜 0건으로 숨기지 않는다. 공개 성공은 요약 실패로 롤백하지 않고 outbox를 보존한다. 버전 문자열을 실제 모델 호출 승인으로 해석하지 않는다.

후기 자체의 공개는 양쪽 제출 즉시/한쪽 알림 가능+24시간 조건을 제출·조회에서 적용하므로 이 정리 API나 하루 한 번 요약 등록을 기다리지 않는다. 행사·AI 후기 요약 등록은 하루 한 번 정책이며 실제 운영 일일 스케줄러 배포는 이번에 수행하지 않는다. 자동 완료는 실제 성공 시각부터 작성 7일을 계산한다.

## 검증 이력과 이번 변경

아래 기존 PASS는 변경 전 검사 이력이다. 이번 공개/예약·모델 분리 변경의 실제 결과는 [새 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-review-policy-handoff.md)를 따른다.

- `node --test tests/functions/minkyu/service_api.test.ts`: handler·서비스·repository 단위 검사22개 PASS. 실제 Web API, 인증 실패·권한 경로 분리·엄격한 입력·RPC 매핑·민감정보 제외를 검증한다.
- `deno check --no-remote backend/supabase/functions/service-api/index.ts`: 런타임 전체 모듈 타입 검사 PASS.
- mock 검사를 실제 JWT/SQL 검증으로 표현하지 않는다. 실제 통합 검증 증거는 총괄의 [민규 현황](../../docs/collaboration/minkyu.md)에 기록한다.


## 실행 진입점과 검증 범위

`index.ts`는 `createRuntimeHandler(read)`와 lazy `default { fetch }`를 제공한다. 실제 설정·인증·DB 조립은 factory 한 곳에 있으며, 모듈 import 시 환경을 읽거나 서버를 시작하지 않는다. 호스팅 런타임은 default fetch를 사용할 수 있고 직접 Deno 실행은 `import.meta.main`에서 같은 fetch를 `Deno.serve`에 등록한다. 이는 현재 [Supabase 공식 시작 안내](https://supabase.com/docs/guides/functions/quickstart)의 default fetch 형태를 따른다.

`verify_jwt=false`는 이 함수가 사용자 JWT와 별도 내부 작업 secret을 경로별로 직접 검증하기 위한 설정이다. 사용자 인증 검사를 생략한다는 뜻이 아니다. [공식 함수 설정](https://supabase.com/docs/guides/functions/function-configuration)

Node import 검사와 Deno 타입 검사, standalone Deno handler·로컬 Supabase의 실제 HTTP/JWT/DB 통합 결과를 관리형 Edge hosting 결과와 구분한다. **원격 관리형 Edge hosting 및 운영 배포는 NOT_RUN**이다. 2026-09-29 로컬 Supabase Edge/gateway에서 실제 인증·업무 검사를 수행했으며 아래 결과를 따른다.


## 검색 HTTP 연결 — 2026-09-29

종현 검색 v2 코어(`129a871`)를 민규 기본 런타임에 연결한다. `createRuntimeHandler(read)`와 `default.fetch`의 GET `/posts`는 `searchPublicPosts(createRpcPublicPostSearchRepository(db), input)`을 실행한다. `createRuntimeHandler(read, { publicPostSearch })`의 명시 의존성 주입은 검사·조립 용도로 유지하며 URL/본문/환경값으로 실행기를 교체하지 못한다. POST `/posts`와 다른 업무 경로는 기존 로그인 요구를 유지한다.

공개 GET 요청은 다음 순서로 처리한다.

1. 기존 정확한 경로·메서드·CORS 검사.
2. Authorization 헤더가 없으면 익명 client, 있으면 실제 Auth 검증 후 사용자 client를 만든다. 빈 값·위조·만료·서비스 키 등 실패를 익명으로 바꾸지 않는다.
3. 중복/알 수 없는 query와 caller/userId 주입을 거절하고 HTTP 문자열을 검색 입력으로 변환한다.
4. 종현 executor가 조건 정규화·커서·공개 투영·repository를 담당한다. HTTP 코드에 SQL 호출·정렬·페이지 나누기를 복제하지 않는다.
5. 기존 `{data,requestId}`/`{error,requestId}`·no-store·CORS를 적용한다. 조회 결과는 `data:{status,posts,nextCursor}`다.

| query | HTTP 처리 |
|---|---|
| query | 검색어 문자열, 최대 300문자. 정규화는 검색 코어 |
| category | 현재 허용된 카테고리 enum 검사; 검색 코어에서도 검증 |
| cost | all/free/paid |
| availability | all/recruiting |
| periodStart, periodEnd | 두 문자열을 함께 전달해 `period:{startsAt,endsAt}`로 변환. 날짜 유효성·겹침 계산은 검색 코어 |
| authorAge | all/20s/30s/40plus. 익명 상세 나이는 HTTP 경계에서도 AUTH_REQUIRED로 거절 |
| sort | 생략 시 created_desc, 선택 starts_asc |
| cursor | 불투명 문자열. 해석·필터 결합·버전 검사는 검색 코어 |
| limit | 정수 1..50. 생략하면 검색 코어의 기본값 |

잘못된 입력으로 정의한 검색 코어 오류만 공통 INVALID_REQUEST로 변환한다. AUTH_REQUIRED는 401, 이미 정해진 HttpError는 유지하고 응답/투영 불일치 및 알 수 없는 오류는 원문 없이 500으로 처리한다. 외부 오류 메시지·검색어·토큰을 로그에 출력하지 않는다.

최신 검증 방법·결과·남은 사항은 [검색 연결 인계](../../docs/collaboration/requests/minkyu/2026-09-29-search-connected.md)를 따른다. 이전 [HTTP 병렬 인계](../../docs/collaboration/requests/minkyu/2026-09-29-search-http-handoff.md)는 연결 전 기록이다.

독립 검토에서 응답 카드의 잘못된 시각이 입력 오류와 같은 코드를 던져400으로 분류되는 예외를 확인했다. 정상 SQL timestamp와는 별개이며 종현 repository의 응답 오류 구분 요청으로 기록했다. [재현·완료 조건](../../docs/collaboration/requests/minkyu/2026-09-29-search-connect-review.md)


## 연결 전 로컬 Edge/gateway 결과 — 2026-09-29

CLI2.116.0 / Edge Runtime v1.74.3 / Kong2.8.1에서 기존 default fetch를 변경 없이 실행했다. 실제 gateway→Edge→Auth/PostgREST로 사용자JWT·역할 분리·무료 공고·양측 매칭·당사자 정보 권한·내부secret 등을 확인했다. 8개 묶음 PASS, 가상 데이터 잔존0이며 상세 결과는 [Edge 인계](../../docs/collaboration/requests/minkyu/2026-09-29-edge-handoff.md)에 있다.

전체 결과는 **PARTIAL**이다. 위 HTTP 계약의 정확한 Origin/no-store/OPTIONS204는 앱 응답 기준이며, 로컬 Kong은 허용 Origin GET의 ACAO를 `*`로 변경하고 OPTIONS를200/`*`/no-store 없이 먼저 응답한다. 애플리케이션의 미허용 Origin403과 자체 인증은 실제로 유지됐다. 이 로컬 gateway 차이를 CORS 전체 통과로 기록하지 않는다. 운영 gateway의 허용 Origin·OPTIONS 정책은 대상 선정 후 확인해야 하며 원격 결과는 NOT_RUN이다.

이전 검사 당시 기본 GET 검색405는 종현 최신 코어 미연결 상태를 확인한 것이었다. 위 검색 연결 이후의 결과는 최신 인계를 따른다. PASS/문자·계좌 공급사, 외부 모델, 운영 데이터·배포를 실행하지 않았다.
