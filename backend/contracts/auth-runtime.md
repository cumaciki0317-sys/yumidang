# 인증·DB 실행 계약 — 민규담당

상태: 기존 Supabase 세션 검증과 제한된 RPC 전송 계약을 유지한다. 현재 가입·로그인은 네이버만 사용하며 여성·만 19세 이상, 네이버 필수 이름·성별·생일·출생연도와 필수 사진을 확인해야 한다. 네이버와 Supabase 세션 연결은 서버 브리지·private 예약/세션 RPC로 구현했으며 실제 네이버 앱과 운영 배포 검증은 별도다. 상세는 [가입 계약](signup.md)을 따른다.

## 호출자와 권한

`requirePrincipal(request, config, fetchImpl?)`는 Authorization의 Bearer JWT를 Supabase Auth `/auth/v1/user`로 보내 매 요청 검증한다. JWT의 로컬 payload 디코딩, `x-user-id`, `x-role`, `user_metadata`를 인증 근거로 사용하지 않는다. Auth가 반환한 UUID와 `authenticated` 역할을 확인하고 익명 계정은 제외한다. 설정된 anon/service 역할 키·내부 비밀은 사용자 토큰으로 받지 않는다.

반환 `Principal`의 공개 필드는 `userId`뿐이다. 원래 JWT는 모듈의 WeakMap에 보관하며 임의로 만든 같은 모양의 객체로 사용자 DB 클라이언트를 생성할 수 없다. 사용자 DB 요청은 anon key와 원래 JWT를 함께 보내므로 `auth.uid()`와 기존 RLS를 유지한다. 서비스 키로 사용자 권한을 대신하지 않는다.

`requireInternalCaller(request, config)`는 별도 `INTERNAL_WORKER_SECRET`을 Bearer로 요구한다. SHA-256 고정 길이 digest를 전체 길이 XOR 비교한다. 사용자 JWT·서비스 키·클라이언트 역할 헤더로 내부 경로를 허용하지 않는다. HTTP 호출부는 이 함수의 성공 뒤에 내부 DB 클라이언트를 만든다. 내부 RPC 목록은 `internal-client.ts`에 고정되어 있으며 임의 테이블·SQL 호출 API를 제공하지 않는다.

공식 근거: [Supabase getUser](https://supabase.com/docs/reference/javascript/auth-getuser)의 서버 검증 방식과 [Supabase Auth OpenAPI](https://github.com/supabase/auth/blob/master/openapi.yaml)의 사용자 조회 계약을 참고했다.

## 설정

`loadRuntimeConfig(read)`는 환경 조회 함수를 주입받는다. 공통 모듈은 Deno 전역이나 dotenv 패키지에 의존하지 않는다. 값 누락·잘못된 형식은 값과 변수 내용을 공개하지 않는 `EXTERNAL_UNAVAILABLE` 오류로 처리한다.

| 변수 | 적용 범위 |
|---|---|
| `SUPABASE_URL` | 필수. HTTPS origin. 로컬 localhost/127.0.0.1/::1 및 Supabase 내부 kong만 HTTP 허용 |
| `SUPABASE_ANON_KEY` | 사용자 인증·사용자 RPC 필수 |
| `ALLOWED_ORIGINS` | 정확한 origin 문자열의 JSON 배열. `[]` 허용, wildcard·경로 불허 |
| `MAX_REQUEST_BYTES` | 필수 양의 정수, 기본값 없음 |
| `UPSTREAM_TIMEOUT_MS` | 필수 양의 정수, 최대 2147483647, 기본값 없음 |
| `SUPABASE_SERVICE_ROLE_KEY` | 내부 RPC 필수. 사용자 API 시작에는 선택 |
| `INTERNAL_WORKER_SECRET` | 내부 경로 필수. 키들과 별도인 32~4096자 영문/숫자/`_`/`-` 값. 운영자는 충분한 무작위성을 가진 비밀 생성 필요 |
| `REVIEW_SUMMARY_MODEL_VERSION` | 후기 자동화 호출 시 필수, 공급사/모델을 임의 선택하지 않음 |
| `REVIEW_SUMMARY_PROMPT_VERSION` | 후기 자동화 호출 시 필수 |

내부 배치 한도는 HTTP 본문의 명시적인 `limit`를 사용한다. 별도 환경 기본값은 없다. 내부 비밀 미구성은 내부 기능을 닫지만 이미 인증 가능한 일반 사용자 API까지 막지 않는다. 설정 객체와 토큰을 로그로 출력하지 않는다. 설정의 JSON 직렬화는 비밀값 대신 구성 여부만 반환한다.

## RPC와 오류

공통 인터페이스는 `RpcClient.rpc(name: string, args: Record<string, JsonValue>): Promise<JsonValue>`다. 성공 JSON을 반환하며 204는 null이다. 사용자/익명/내부 클라이언트 각각의 고정 목록 밖 이름은 요청 전 `ACCESS_DENIED`다. 가입 legacy RPC와 기존 `create_post`·`create_join_request`는 사용자 목록에 넣지 않는다. 새 `create_service_post`·`request_service_post` 경로를 사용한다.

모든 요청은 timeout과 AbortController를 사용하며 redirect를 따라가지 않는다. 오류 원문·SQL·힌트·토큰·요청 본문을 로그나 공개 오류에 붙이지 않는다. 원문에 포함된 error code 문자열도 알려진 SQLSTATE만 매핑한다.

| DB/상위 응답 | 공개 오류 |
|---|---|
| HTTP401 또는 SQLSTATE28000 | AUTH_REQUIRED401 |
| HTTP403 또는42501 | ACCESS_DENIED403 |
| 22023/22P02/23502/23514 | INVALID_REQUEST400 |
| 23505/P0001/40001 | STATE_CONFLICT409 |
| P0002/PT404 | RESOURCE_NOT_FOUND404 |
| PT503/40P01/네트워크·timeout/미분류5xx·429 | EXTERNAL_UNAVAILABLE503 |
| 그 외 미분류 DB 오류 | INTERNAL_ERROR500 |

`40001`은 현재 요약 revision·업무 상태 충돌에 사용되므로 409다. 호출자는 최신 상태를 다시 조회하며 무조건 성공으로 변환하지 않는다. 요청 자동 재전송은 없다. 변경 RPC의 중복/재시도 안전성은 DB 계약이 보장한다.

## 네이버 가입 자격과 활동 제한

`evaluateTrustedEligibility`는 `source: naver`, 사용자 귀속·자격 확인·계정 연결·사진·명시 완료를 확인한다. PASS/DI·수기·referral·user_metadata를 증거로 사용하지 않는다. 이 순수 계산 결과로 쓰기를 허가하지 않으며 실제 DB가 매번 확인한다.

네이버 전용 signup runtime만 서비스 키로 `begin_naver_login`, `consume_naver_login`, `resolve_naver_account`, `record_naver_session`을 호출한다. 내부 워커 클라이언트에 이 계정/세션 RPC를 추가하지 않았다. 사용자 클라이언트는 `get_naver_signup_state`, `complete_naver_signup`과 성향 조회/저장 RPC를 허용한다.

private `naver_sessions`는 Auth의 session_id·user_id와 계정 예약을 확인한다. Auth JWT를 직접 만들거나 사용자 metadata를 신뢰하지 않는다. 사진·가입 완료·최신 자격이 없는 회원과 네이버 미등록 Auth 세션은 새 공고·신청·최종 동의/확정에서 거절한다. 기존 사용자 자료의 읽기·대화 권한을 일괄 제거하지 않는다. 기존 일반 JWT 인증 계약과 RLS는 유지한다.

기존 계정은 이름·실제 이메일로 자동 연결하지 않는다. 계정 확인/전환의 운영 절차는 별도다. `auth.sessions` 내부 테이블과 Auth REST 평면 응답에 의존하므로 Auth 버전 변경 시 로컬 통합 검증을 다시 수행한다. 실제 네이버 필수 정보 제공·브라우저·운영 gateway CORS 검증은 별도다.

## 검증

`node --test tests/functions/minkyu/auth_db.test.ts`의 기존 14개와 공개 검색 인증 7개를 합한 21개 테스트 및 Deno 타입 검사를 통과했다. 원격 검증 모형, 위조 Principal 거절, 역할 혼동 거절, 토큰 전달, allowlist, 네트워크·timeout, SQLSTATE 매핑, 민감정보 제외를 포함한다. 실제 Supabase HTTP/JWT 통합 결과는 총괄의 [민규 현황](../../docs/collaboration/minkyu.md)에서 별도 기록한다. 모형 테스트 통과를 네이버 가입·세션 연결이나 추후 계좌 인증의 성공으로 판단하지 않는다.


## 공개 읽기의 선택 인증 — 현재 연결

`requireOptionalPrincipal(request, config, fetchImpl?)`는 **Authorization 헤더가 아예 없는 요청에만 null**을 반환한다. 헤더가 있다면 기존 `requirePrincipal`을 그대로 호출한다. 빈 헤더·잘못된 형식·만료 JWT·anon key·service role key·내부 작업 secret은 비로그인으로 전환하지 않고 `AUTH_REQUIRED`로 실패한다. Auth 조회 장애도 익명 결과로 대체하지 않으며 `EXTERNAL_UNAVAILABLE`이다. Supabase 익명 Auth 계정 역시 일반 회원으로 인정하지 않는다.

검증된 회원은 `createUserClient(config, principal, fetchImpl?)`를 사용한다. `search_public_posts_v2`를 사용자 RPC 목록에 추가했으며, 기존과 같은 anon apikey 및 검증된 원래 사용자 JWT를 보내 DB의 `auth.uid()`·RLS 문맥을 유지한다.

비로그인은 `createPublicClient(config, fetchImpl?)`를 사용한다. 이 클라이언트는 아래 **정확한 5개 읽기 RPC만 허용**한다. apikey와 Authorization Bearer에 모두 `supabaseAnonKey`만 쓰고 서비스 키·내부 secret·사용자 토큰을 읽거나 대신 사용하지 않는다. 일반 사용자·프로필 조회·공고 쓰기·신청·작업 RPC·임의 이름·구형 `search_public_posts`는 네트워크 요청 전에 `ACCESS_DENIED`로 거절한다. 테이블·SQL·자유 URL 전달 경로는 제공하지 않는다.

| 허용 RPC | 범위 |
|---|---|
| `search_public_posts_v2` | 공개 공고 카드 검색. 비로그인 나이 전체·공개 필드는 DB 계약 적용 |
| `get_service_post` | 기존 공고 상세의 호출자별 공개 투영 |
| `list_event_candidates_v1` | 기존 행사 후보 읽기 호환 경로 |
| `list_public_events` | 공개 행사 목록 읽기 |
| `list_event_filter_values` | 공개 행사 필터 값 읽기 |

호출부 연결 방식은 다음과 같다. 인증 오류를 잡아서 null로 바꾸는 fallback을 추가하면 안 된다.

```ts
const principal = await requireOptionalPrincipal(request, config);
const db = principal === null
  ? createPublicClient(config)
  : createUserClient(config, principal);
```

실제 `createRuntimeHandler`는 공개 검색·행사와 공고 상세에 같은 `authenticatePublic`을 연결한다. 공고 상세는 `resolveRouteForMethod`에서 정확한 prefix·UUID·GET·query 없음 검사를 통과한 `/service-api/posts/:uuid` 또는 `/functions/v1/service-api/posts/:uuid`에만 `publicPostDetail:true`를 표시한다. handler는 본문 없음도 확인한 뒤 선택 인증을 수행하고 기존 `get_service_post` 경로를 실행한다. 잘못된 메서드·query·본문·인코딩된 경로·다른 prefix·비공개/내부 경로는 이 선택 인증 경로에 들어가지 않는다.

`ServiceApiDependencies.publicPostDetails.authenticate`를 명시적으로 연결하지 않은 factory는 기존 회원 인증을 유지한다. 이는 구성 호환이며 인증 실패를 익명·내부·서비스 역할로 재시도하는 fallback이 아니다. 작성자/일반 회원/양쪽 확정/취소 후 재마스킹/삭제·없는 공고의 권한과 공개 필드는 기존 RPC가 판단한다. 별도 상세 projection이나 새 RPC를 추가하지 않았다.

이 연결은 종현 담당 검색 코어를 우회하지 않는다. 연결 행사명 검색은 기존9필드 카드를 유지하며 2026-10-03 실제 로컬 통합에서 확인했다. 숫자 나이 범위의 HTTP·AI 연결과 행사 카드 확장은 별도 미완료 범위이며 [공개 검색 DB 계약](public-post-search-db.md)을 따른다. 익명 상세 연결을 전체 프론트·AI·운영 배포 완료로 판단하지 않는다.

추가 7개 모형 테스트는 헤더 부재/빈 값 구분, 잘못된 인증의 익명 fallback 차단, 서비스 키를 읽지 않는 익명 전송, 공개 RPC 목록 제한, 검증된 회원 JWT 보존을 확인한다. PostgREST의 HTTP403 응답에서도 문자열 SQLSTATE `28000`은 로그인 필요로 분류하고, 다른 403은 접근 거절을 유지한다. 실제 SQL 권한 검증은 이 모형 테스트와 구분한다.

[공개 상세 인계](../../docs/collaboration/requests/minkyu/2026-10-02-public-detail-handoff.md)에 신규 단위 15개 PASS와 실제 격리 Auth·PostgREST·DB·기본 HTTP runtime 통합 346개 확인 PASS를 기록했다. 합성 계정/공고/사진 metadata의 권한 검증과 정리까지 수행했으며 외부 네이버·실제 사용자 사진 업로드·Edge gateway·운영 배포는 해당 runner 범위가 아니다. 이전 익명 client의 `get_service_post` 차단 기대를 현재 5개 허용 목록에 맞추는 기존 인증 회귀는 [별도 인계](../../docs/collaboration/requests/minkyu/2026-10-02-public-client-regression-handoff.md)에서 실행 결과를 구분한다. 이 문서 갱신은 제품 코드나 SQL을 변경하지 않는다.

## 내부 Top10과 행사 연결 검증 — 2026-10-03

`/internal/events/kopis-top10` 두 경로는 `requireInternalCaller` 성공 뒤에만 기존 내부 client의 `store_kopis_top10_snapshot`·`get_kopis_top10_snapshot`을 호출한다. Bearer 헤더 없음은401, 사용자 JWT·anon/service 역할 키·잘못된 secret은403이며 Auth/공개 client로 fallback하지 않는다. 공개 읽기5개·사용자 RPC 목록은 그대로다. 직접 PostgREST 호출도 native 권한 거절을 확인했다(회원403/42501, anon401/42501). HTTP의 내부 인증과 직접 DB 역할 거절은 별도 검사다.

[이번 인계](../../docs/collaboration/requests/minkyu/2026-10-02-event-http-handoff.md)의 실제 통합8그룹·769확인 PASS는 실제 로컬 Auth·원형 factory/native RPC·배포된 gateway 호출을 포함한다. 합성 회원3명의 자격과 사진 metadata만 주입했고 실제 외부 네이버·사진 업로드는 실행하지 않았다. 행사 연결의 최신 정보·수동 교체 재동의와 확정/취소 후 이름·정확 장소 권한을 확인했으며, 생성 식별자로만 정리한 뒤 관련23테이블0을 확인했다. 최신38 SQL·원본135개 보존 검사를 적용했다. 이 결과는 외부 AI·공식 행사 수집·원격 운영 배포의 성공 증거가 아니다.
