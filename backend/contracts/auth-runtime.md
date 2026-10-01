# 인증·DB 실행 계약 — 민규담당

상태: 기존 Supabase 세션 검증과 제한된 RPC 전송 계약을 유지한다. 현재 가입·로그인은 네이버만 사용하며 여성·만 19세 이상, 네이버 필수 이름·성별·생일·출생연도와 필수 사진을 확인해야 한다. 네이버와 Supabase 세션 연결의 실제 적용·검증은 별도이며 [가입 계약](signup.md)을 따른다.

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

## 가입 자격 목표와 기존 함수의 차이

현재 자격 정책은 검증된 네이버 정보·여성 만 19세 이상·네이버 계정당 하나·필수 사진이다. PASS·DI·문자 인증을 요구하지 않는다. 기존 `evaluateTrustedEligibility(principal, proof)`에는 이전 신원·DI 전제의 검사 구조가 남아 있으므로 네이버 자격 경계로 개편해야 한다. 이 함수의 기존 `eligible`만으로 최신 가입 자격을 충족했다고 보지 않는다. 요청 본문이나 사용자 metadata를 신뢰된 proof로 넘기지 않는다.

기존 `verification_required`·`photo_required` 결과와 네이버 정보 누락 시 가입 보류의 매핑은 후속 연결 대상이다. 기존 female_direct/referral/이메일 기록을 네이버 자격 확인으로 자동 승격하지 않는다. 기존 계정은 네이버 확인 전 새 등록·신청·확정을 제한하되 진행 중 약속·대화 확인과 취소·지원 요청은 허용한다. 선택 성향은 자격을 차단하지 않는다.

## 검증

`node --test tests/functions/minkyu/auth_db.test.ts`의 기존 14개와 공개 검색 인증 7개를 합한 21개 테스트 및 Deno 타입 검사를 통과했다. 원격 검증 모형, 위조 Principal 거절, 역할 혼동 거절, 토큰 전달, allowlist, 네트워크·timeout, SQLSTATE 매핑, 민감정보 제외를 포함한다. 실제 Supabase HTTP/JWT 통합 결과는 총괄의 [민규 현황](../../docs/collaboration/minkyu.md)에서 별도 기록한다. 모형 테스트 통과를 네이버 가입·세션 연결이나 추후 계좌 인증의 성공으로 판단하지 않는다.


## 공개 검색의 선택 인증 — 2026-09-29

`requireOptionalPrincipal(request, config, fetchImpl?)`는 **Authorization 헤더가 아예 없는 요청에만 null**을 반환한다. 헤더가 있다면 기존 `requirePrincipal`을 그대로 호출한다. 빈 헤더·잘못된 형식·만료 JWT·anon key·service role key·내부 작업 secret은 비로그인으로 전환하지 않고 `AUTH_REQUIRED`로 실패한다. Auth 조회 장애도 익명 결과로 대체하지 않으며 `EXTERNAL_UNAVAILABLE`이다. Supabase 익명 Auth 계정 역시 일반 회원으로 인정하지 않는다.

검증된 회원은 `createUserClient(config, principal, fetchImpl?)`를 사용한다. `search_public_posts_v2`를 사용자 RPC 목록에 추가했으며, 기존과 같은 anon apikey 및 검증된 원래 사용자 JWT를 보내 DB의 `auth.uid()`·RLS 문맥을 유지한다.

비로그인은 `createPublicClient(config, fetchImpl?)`를 사용한다. 이 클라이언트는 **`search_public_posts_v2` 한 개만 허용**한다. apikey와 Authorization Bearer에 모두 `supabaseAnonKey`만 쓰고 서비스 키·내부 secret·사용자 토큰을 읽거나 대신 사용하지 않는다. 프로필 조회·공고 쓰기·신청·작업 RPC·이전 검색 RPC도 네트워크 요청 전에 `ACCESS_DENIED`로 거절한다.

호출부 연결 방식은 다음과 같다. 인증 오류를 잡아서 null로 바꾸는 fallback을 추가하면 안 된다.

```ts
const principal = await requireOptionalPrincipal(request, config);
const db = principal === null
  ? createPublicClient(config)
  : createUserClient(config, principal);
```

이 변경은 인증과 DB 호출 기반만 제공한다. 검색 입력 정규화·HTTP GET 경로를 새로 구현하거나 종현 담당 검색 코어를 우회하지 않았다. 검색 HTTP 연결 완료와 실제 RPC 통합 결과는 총괄의 작업 현황에서 별도로 기록한다.

추가 7개 모형 테스트는 헤더 부재/빈 값 구분, 잘못된 인증의 익명 fallback 차단, 서비스 키를 읽지 않는 익명 전송, 공개 RPC 목록 제한, 검증된 회원 JWT 보존을 확인한다. PostgREST의 HTTP403 응답에서도 문자열 SQLSTATE `28000`은 로그인 필요로 분류하고, 다른 403은 접근 거절을 유지한다. 실제 SQL 권한 검증은 이 모형 테스트와 구분한다.
