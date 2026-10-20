# 인증·DB 실행 계약 — 민규담당

## 2026-10-20 현행 기준과 이 문서의 적용 범위

이 문서는 현재 요구와 구현 계약을 구분한다. 아래 기술 시그니처·기존 SQL·검증 기록은 실제 구현 근거이며 새 정책 요구가 자동 구현됐다는 뜻이 아니다.

- 담당은 현재 민규=BE·AI·검색·행사·서버 운영, 종현=FE·UX/UI·앱 API/세션 소비·빌드, 유미=UT·출시/지원 책임이다. 아래 옛 종현 BE·성호 UI 배정은 당시 기록이며 현재 실행 권한으로 사용하지 않는다. 구체 파일은 현행 소유권 정책을 따른다.

- AI 탐색 동의는 첫 사용 시 받고 거절하면 일반 검색을 유지한다. 후기 요약은 가입 시 열람·내 프로필 생성/노출·작성 후기 활용을 기본 미선택인 별도 선택 세 항목으로 받는다. 전체 동의와 개별 자세히 보기를 유지하고 미동의 가입/일반 동행을 허용한다. 세 동의의 철회는 독립적이다. 현재 서버의 summary_allowed 하나·review_summary 일괄 철회가 이 세분화 요구를 구현했다고 해석하지 않는다. 테스트 계정 동의 간주는 실제 동의 증거·DB 값 변경·회원 원문 전송 승인이 아니다.

- KOPIS는 전체 공연·연극·뮤지컬·클래식·국악·대중음악·무용·대중무용·서커스/마술·복합·아동·대학로·내한·축제 14항목, 어제까지 최근7일·매일 갱신이다. basedate 누락만으로 영구 공개 보류하지 않고 공식 사이트의 실제 기간·조건·공연ID/순위/순서를 대조한 분류만 공개하는 A안을 적용한다. 요청 날짜로 기간을 확정하거나 일일순위를 합산하지 않는다. 확인 기간·시각·출처를 표시하고 실패 때 마지막 검증 기간을 유지한다. 아래 all/musical·basedate 필수 parser·not_enabled는 현재 구현/당시 검증의 기술적 한계이며 최신 제품 정책이 아니다. 일반 공연 수집·칼럼 매핑은 순위 대조와 병행한다.

- 직접 입력 행사는 해당 공고에만 저장/표시하며 공용 목록·별도 행사 상세·검수 후 공용화는 만들지 않는다. 행사명 필수, 공개 행사장 장소/주소 선택이며 개인 주소를 금지한다. 새 연결은 예정/진행 중만 허용하고 종료·공식취소·연기일정미정은 제한한다. 단순 검색 누락은 취소/비표출이 아니다. 제공기관 비표출 원천의 정보와 상세 진입만 숨기고 공고/독립 만남 장소·다른 유효 공개 원천은 유지한다. 공식 동일 개최 식별근거만 통합에 사용하고 원천ID·공고관계·필드출처·가역 이력을 보존한다. 현재 eventId UUID 저장을 직접 입력·통합·비표출 구현 완료로 표시하지 않는다.

- 일반 신고·허용된 증거 열람·비용 운영 책임은 대표 조유미(유미), 공개 지원 메일은 cumaciki0317@gmail.com이다. 별도 등록 사업자는 없고 대체 담당은 미지정이다. 평일09~18시/신고 첫 확인2영업일은 목표이며 실제 권한 설정·메일 수신·응답 보장 증거가 아니다. 앱 밖 삭제는 공개 방침의 직접 연결 구역과 이메일로 받고 첫 답변/본인확인 후 처리 목표는 정책13장을 따른다. 운영자는 회원 채팅 DB 원문을 직접 읽지 않는다.

최신 기준: [정책.md](../../정책.md). 구현과 남은 조건: [서버·DB 대조 원장](../../docs/collaboration/requests/jonghyun/2026-10-20-policy-implementation-audit/server-audit.json).


## 2026-10-20 행사 UX 확정과 서버 구현 경계

기준은 [최종 행사 UX 확정](../../docs/collaboration/requests/jonghyun/2026-10-20-event-ux-approved-spec.md)이다. 사용자 명시 전체 문서 동기화 승인으로 반영하며 제품 설계 확정과 실제 코드·DB·배포 완료를 구분한다.

행사 기반 작성의 비로그인은 로그인/가입 완료 후 원래 행사 연결 작성으로 복귀하고 현재 연결 가능 상태를 재확인하는 제품 기준이다. 미완료·취소 로그인은 작성 권한을 주지 않는다. 공개 행사 정보와 공고의 당사자 전용 상세 만남 지점은 분리하며 통합 행사 조회/알림도 기존 회원·본인숨김·차단 권한을 우회하지 않는다.

새 직접입력 저장·공식 근거 통합·원천별 비표출·행사 상태 알림 및 변경계약이 아래 현재 RPC allowlist에 이미 추가됐다는 뜻이 아니다. 새 서버 경로/권한 검증은 민규 후속 작업이고 이 문서 동기화로 인증이나 코드/설정을 변경하지 않는다.


현재 담당(2026-10-14): 이 서버 계약과 BE·AI 구현은 민규 전담이며 프론트 클라이언트 소비·UX/UI는 종현, QA는 공통(민규·종현·유미), UT는 유미다. 아래 과거 구현자·검사·인계 증거는 당시 기록으로 보존한다.

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

`evaluateTrustedEligibility`는 `source: naver`, 사용자 귀속·자격 확인·계정 연결·사진·명시 완료를 확인한다. 수기·referral·user_metadata를 증거로 사용하지 않는다. 이 순수 계산 결과로 쓰기를 허가하지 않으며 실제 DB가 매번 확인한다.

네이버 전용 signup runtime만 서비스 키로 `begin_naver_login`, `consume_naver_login`, `resolve_naver_account`, `record_naver_session`을 호출한다. 내부 워커 클라이언트에 이 계정/세션 RPC를 추가하지 않았다. 사용자 클라이언트는 `get_naver_signup_state`, `complete_naver_signup`과 성향 조회/저장 RPC를 허용한다.

private `naver_sessions`는 Auth의 session_id·user_id와 계정 예약을 확인한다. Auth JWT를 직접 만들거나 사용자 metadata를 신뢰하지 않는다. 사진·가입 완료·최신 자격이 없는 회원과 네이버 미등록 Auth 세션은 새 공고·신청·최종 동의/확정에서 거절한다. 기존 사용자 자료의 읽기·대화 권한을 일괄 제거하지 않는다. 기존 일반 JWT 인증 계약과 RLS는 유지한다.

기존 계정은 이름·실제 이메일로 자동 연결하지 않는다. 다른 네이버 계정 연결·기록 이전은 현재 제공하지 않는다. `auth.sessions` 내부 테이블과 Auth REST 평면 응답에 의존하므로 Auth 버전 변경 시 로컬 통합 검증을 다시 수행한다. 실제 네이버 필수 정보 제공·브라우저·운영 gateway CORS 검증은 별도다.

## 검증 경계

원격 검증 모형·위조 Principal 거절·역할 혼동·JWT 전달·allowlist·timeout·SQLSTATE·민감정보 제외는 단위 검사, 실제 Auth/RPC는 통합 검사로 구분한다. 이번 문서 동기화에서 실행하지 않았다. 신규 제재·동의 철회·탈퇴·비로그인 작성자 가드의 실제 연결도 별도 확인한다.

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

이 연결은 민규 담당 검색 코어를 우회하지 않는다. 연결 행사명 검색은 기존9필드 카드를 유지하며 DB 연결 계약에 반영되어 있다. 현재 실행 검증은 별도다. 숫자 나이 범위의 HTTP·AI 연결과 행사 카드 확장은 별도 미완료 범위이며 [공개 검색 DB 계약](public-post-search-db.md)을 따른다. 익명 상세 연결을 전체 프론트·AI·운영 배포 완료로 판단하지 않는다.

추가 7개 모형 테스트는 헤더 부재/빈 값 구분, 잘못된 인증의 익명 fallback 차단, 서비스 키를 읽지 않는 익명 전송, 공개 RPC 목록 제한, 검증된 회원 JWT 보존을 확인한다. PostgREST의 HTTP403 응답에서도 문자열 SQLSTATE `28000`은 로그인 필요로 분류하고, 다른 403은 접근 거절을 유지한다. 실제 SQL 권한 검증은 이 모형 테스트와 구분한다.

## 내부 Top10 권한 경계

`/internal/events/kopis-top10` 두 경로는 `requireInternalCaller` 성공 뒤에만 기존 내부 client의 `store_kopis_top10_snapshot`·`get_kopis_top10_snapshot`을 호출한다. Bearer 헤더 없음은401, 사용자 JWT·anon/service 역할 키·잘못된 secret은403이며 Auth/공개 client로 fallback하지 않는다. 공개 읽기5개·사용자 RPC 목록은 그대로다. 직접 PostgREST 호출도 native 권한 거절을 확인했다(회원403/42501, anon401/42501). HTTP의 내부 인증과 직접 DB 역할 거절은 별도 검사다.

## 운영 선택과 적용 확인

일반 JSON64KiB·외부 요청15초를 명시 주입한다. 기존 설정의 기본값 없음과 정책 선택을 구분하고 실제 계정·호스트 지원을 확인한다. 운영 보관 선택은 일반 진단 30일·보안 90일·작업 종료 후 세부 기록 30일·공급사 한도 기간 종료 후 비용 원장 90일이다. 원문·비밀값을 제외한다. 미정산 예약은 해결까지 제한 보관하고 자동 환불·초기화를 하지 않는다. 중복방지 최소키는 재요청 가능기간에 맞춘 별도 삭제 조건을 검증한다. 법적 근거·실제 삭제·백업 만료는 별도 확인이며 활성 자료 삭제를 백업 즉시 삭제로 안내하지 않는다.

AI 탐색은 첫 사용 시 동의받고 동의 확인 전 모델 처리·질문 외부 전송을 시작하지 않는다. 거절·철회 시 일반 검색·일반 동행·계정을 유지한다. 가입 동의·전체 동의에 AI 탐색 동의를 포함하지 않는다.

후기 요약은 가입 때 `요약 열람`, `내 프로필의 요약 생성·노출`, `내가 작성한 후기의 AI 요약 활용`을 각각 선택 체크로 받는 제품 의도다. 기본 미선택·개별 자세히 보기와 `전체 동의`를 제공한다. 전체 선택/해제는 같은 가입 화면의 모든 개별 항목에 적용하고 개별 항목을 하나라도 해제하면 전체 동의도 해제한다. 모든 개별 항목이 선택되면 전체 동의도 선택된다. 후기 작성 때는 활용 안내만 재표시하고 체크를 반복하지 않는다. 후기 요약 세 동의는 독립 철회한다. 열람 철회는 본인의 열람만, 생성·노출 철회는 본인 프로필 요약 숨김·새 생성/갱신 중단, 원문 활용 철회는 본인이 쓴 기존·향후 후기의 AI 근거 제외와 영향 요약 우선 숨김이다. 다른 두 동의는 자동 철회하지 않는다. 남은 허용 공개 텍스트3개 이상과 대상자 생성·노출 동의·현재 공개/전송 조건을 충족할 때만 재생성·공개하며 부족·미확인·실패 시 숨김을 유지한다. 계정·일반 동행·일반 후기 원문·별점·당도는 AI 철회만으로 바꾸지 않는다. AI 처리용 복제본·외부 사본·관련 생성물의 필요한 삭제는 실제 확인 전 완료로 표시하지 않는다.

현재 기존 계정은 모두 테스트 계정이므로 테스트에서는 동의 완료로 간주한다. 이 가정을 실제 동의 증거 생성·DB 동의 값 변경·외부 전송 승인으로 사용하지 않는다. AI 미동의를 이유로 가입을 거부하거나 일반 동행·계정을 차단하지 않고 미동의 항목에 해당하는 AI 기능만 제한한다. 선택 동의의 법적 분류·문구·공급사 조건 확인과 회원 원문 외부 전송 보류를 유지한다. 이번 문서는 최신 정책의 요구사항을 동기화한 것이며 아래 기존 RPC의 인자·반환형·버전을 변경하거나 새 세분화 동의 저장·열람 차단·삭제가 현재 서버에 구현됐다고 뜻하지 않는다. 현재 구현과 정책 차이는 민규가 별도 확인·설계·구현·검증해야 한다.
