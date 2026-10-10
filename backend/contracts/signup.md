# 가입·로그인 계약

주담당: 민규. 기준: [정책.md](../../정책.md), [상세 설계](../../PLAN_상세설계.md). 네이버 가입·세션·사진/성향의 기존 인터페이스를 설명한다. 현재 정책 전체의 코드 일치·실제 앱 동의·콜백·브라우저·운영 배포는 별도 검증이다.

## 현재 가입과 로그인

- 네이버 이름·성별·생일·출생연도를 서버에서 받아 여성·만 19세 이상인지 확인한다. 달력 날짜와 한국 날짜 기준 만 나이를 확인한다. 누락·확인 불가면 완료를 보류하며 수기 입력·metadata로 대체하지 않는다.
- 네이버 공급사 계정 ID당 회원 하나다. 다른 네이버 계정의 동일인까지 차단하는 보장은 아니다. 이름·실제 이메일로 과거 계정을 자동 병합하지 않는다.
- 사진 필수, 관심사·대화 방식·MBTI 선택이다. 관심사·대화 방식 각각 최대 20개·값당 40자이며 대소문자만 다른 중복도 거절한다. MBTI는 네 쌍의 네 글자다.
- 로그인 때 자격을 다시 확인한다. 기존 회원의 누락·자격 불충족은 새 공고·신청·최종 동의를 막지만 기존 조회·대화·약속 처리의 권한을 일괄 제거하지 않는다.
- 네이버 확인 → 세션 → 사진·선택 성향 → 가입 완료 버튼 → 완료 안내 → 홈이다. 사진 업로드만으로 완료하지 않는다. 기존 완료 회원은 로그인 전 목적 화면, 없으면 홈으로 복귀한다.

## HTTP 계약

기본 prefix는 `/functions/v1/signup`이다. 로컬 직접 서버는 `/signup`도 지원한다. 공통 `{data,requestId}` 또는 `{error,requestId}`, no-store, 정확한 Origin 정책을 사용한다. OAuth 시작·교환에는 허용 Origin이 필수다.

| 메서드·경로 | 본문 | 결과 |
|---|---|---|
| POST `/naver/start` | `codeChallenge`(verifier SHA-256 소문자 hex), 선택 `returnTo`(내부 절대 경로, 기본 `/`) | `authorizationUrl`, `expiresAt` |
| POST `/naver/callback` | `code`, `state`, `codeVerifier` | `status`, `returnTo`, `userId`, `session` 또는 null |
| GET `/state` | 없음, Supabase 사용자 Bearer JWT | `status`, `avatarPath`, `interests`, `conversationStyles`, `mbti` |
| POST `/complete` | `avatarPath`, 선택 `interests`·`conversationStyles`·`mbti` | 완료된 가입 상태 |

callback의 `session`은 `accessToken`, `refreshToken`, `expiresIn`, `tokenType`만 포함한다. 생년월일·네이버 계정 ID·원본 응답·네이버 토큰·Auth 일회용 해시·내부 이메일 별칭을 반환하지 않는다. 세션은 DB가 Auth 세션과 계정 귀속을 확인한 뒤에만 공개한다.

`information_required`: 필수 정보 누락/확인 불가, `ineligible`: 자격 불충족, `photo_required`: 사진/신규 가입 필요, `completion_required`: 사진은 있으나 명시 완료 필요, `ready`: 자격·사진·명시 완료 충족. 신규 부적격자는 계정이나 세션을 만들지 않는다. 기존 부적격자는 제한된 세션으로 기존 자료를 볼 수 있다.

성향은 `service-api`의 GET/POST `/me/traits`로 조회/전체 교체한다. POST는 `interests`, `conversationStyles`, `mbti`를 모두 요구한다. 빈 배열/null MBTI는 선택 성향 삭제다. 기존 사진 교체 RPC·최종 사진 삭제 차단을 유지한다.

검토된 사전검사 조립은 `createSignupRuntimeHandler(read, fetchImpl, {contentInspection: readiness})`로 연결한다. `readiness`는 승인값·결정 ID·정책/검사기 버전을 요구하며 HTTP 입력으로 설치할 수 없다. 기존 두 인자 factory와 기본 진입점에는 설치하지 않는다. 검사 endpoint는 service-api의 `/content-inspections`를 사용한다. 승인된 가입 완료는 원 사용자 JWT로 가입 성향 티켓을 POST 조회하고 `x-content-operation-id`, `x-content-inspection-ticket`을 같은 입력의 `complete_naver_signup`에 전달한다. DB SQL116이 digest·대상·기한·소비를 원자적으로 다시 검증한다. 가입 상태 읽기는 티켓 없이 가능하다. 프로필 생성 전 최초 가입도 이 경계를 사용하며 검증된 Auth 사용자와 네이버 세션·필수 사진 검사는 유지한다.

가입 factory 신규5·기존 네이버9·ticket client8 모형 검증22개와 Deno 검사 PASS다. 실제 격리 Auth/REST/SQL의 프로필 없는 최초 가입은 콘텐츠 full8-v9에서 PASS다. 검증된 합성 네이버 세션·사진 metadata→검사→가입 저장→ticket 소비→같은 키 재조회에서 전체 DB 추가 변경0을 확인했다. 실제 사진 업로드·네이버 공급사 로그인·분류기 품질·소비자 화면·운영 활성화 완료를 의미하지 않는다. [실행 기록4.16](../../docs/collaboration/requests/minkyu/2026-10-09-backend-execution.md)을 따른다.

## 브라우저 연결 순서

1. 브라우저에서 무작위 32바이트를 base64url로 바꿔 verifier(43자)를 만들고 SHA-256 hex challenge를 계산한다. 시작 요청 후 state별 verifier를 현재 탭의 sessionStorage에 보관하고 인증 URL로 이동한다. 요청·콜백 원문을 분석 로그에 남기지 않는다.
2. `NAVER_REDIRECT_URI`의 프론트 콜백에서 code/state를 읽고 같은 Origin에서 callback POST를 보낸다. 쿼리를 주소창 이력에서 제거하고 verifier를 폐기한다. 거절·취소는 세션을 생성하지 않고 다시 시작한다.
3. 세션이 있으면 Supabase `setSession`에 전달한다. 제한 상태면 네이버 정보 확인·복구 안내, 사진/완료 상태면 가입 입력으로 연결한다. ready일 때 저장된 목적 경로로 복귀한다.
4. 신규 사진은 현재 사용자 UUID/새 이미지 UUID.jpg로 private `profile-images` 버킷에 업로드한다. 완료 버튼에서 `/complete`를 호출한다. 실패한 입력은 화면에 보존한다. 소유자·객체 존재·JPEG·용량은 기존 DB 이미지 검사로 검증한다.

이 challenge는 서비스의 브라우저 귀속 증명이다. 네이버가 PKCE를 지원한다고 가정하거나 네이버 토큰 API에 임의 PKCE 필드를 보내지 않는다. 서버는 state hash·verifier hash·시작 Origin·복귀 경로·만료만 저장하며 state 원문과 네이버 토큰은 저장하지 않는다. 같은 state의 재시도는 거절하므로 실패 후 새 로그인부터 시작한다.

## 세션·DB 신뢰 경계

`identity/adapter.ts`는 공식 고정 HTTPS에 토큰 POST와 프로필 GET을 수행한다. 사용자 본문의 이름·생일·성별을 받지 않는다. 서버 전용 `resolve_naver_account`가 자격을 판단하고 고유 내부 UUID 이메일 별칭을 예약한다. 이 별칭은 이메일 주소 확인이나 이메일 로그인 기능을 뜻하지 않는다.

`session-bridge.ts`는 Supabase Auth의 admin generate_link와 verify를 서버 내부에서만 사용한다. 실제 이메일 발송·비밀번호 입력·추가 인증을 요구하지 않는다. Auth에서 받은 사용자·별칭·역할·세션을 확인한 뒤 `record_naver_session`이 private 예약과 auth.sessions를 대조한다. 직접 password 등으로 만든 별도 세션은 네이버 활동 세션으로 등록되지 않는다.

새 SQL은 `20261002090000_naver_signup.sql`이다. private 계정/세션/챌린지는 일반 사용자와 서비스 역할의 직접 테이블 접근을 금지하고 제한된 RPC만 허용한다. 사진·성향·프로필 생성·완료 표시는 원자적이다. 수기·클라이언트 주장·테스트 자격을 네이버 확인 근거로 사용하지 않는다.

## 네이버 앱 등록·남은 실제 확인

[네이버 앱 등록](https://developers.naver.com/apps/#/register)에서 네이버 로그인을 선택하고 이름·성별·생일·출생연도를 필수 제공 항목으로 설정한다. 서비스 웹 URL과 프론트 콜백 URL을 등록하고 동일 URL을 서버 `NAVER_REDIRECT_URI`에 넣는다. Client ID/Secret은 채팅·Git에 붙이지 않고 로컬 `.env`/배포 Secrets에 입력한다. callback Origin은 `ALLOWED_ORIGINS`에 있어야 한다.

`NAVER_STATE_TTL_SECONDS`는 600초(10분)를 선택했으며 명시 주입한다. 일반 외부 요청15초·JSON64KiB이며 실제 환경 지원·주입은 별도 검증한다. 사진 업로드는 JSON 상한과 구분한다.

실제 네이버 동의와 누락 정보 응답, 앱 심사/운영 권한·콜백, 기존 계정 확인 절차, 브라우저 화면·gateway CORS·배포는 별도 검증이다. 가상 네이버 응답이나 로컬 Auth 성공을 실제 네이버 로그인 성공으로 표시하지 않는다.

공식 계약: [네이버 로그인 API](https://developers.naver.com/docs/login/api/api.md), [프로필 조회](https://developers.naver.com/docs/login/profile/profile.md), [Supabase Auth API](https://supabase.github.io/auth/). 검증 결과는 [이번 인계](../../docs/collaboration/requests/minkyu/2026-10-02-naver-signup-handoff.md)에 기록한다.

## 동의·사진·탈퇴의 현재 목표와 추가 연결

탐색 AI와 후기 AI를 구분해 가입 시 각각 필수 동의를 받으려는 제품 의도를 유지한다. 가입 후 철회 요청을 접수하면 해당 처리의 신규 전송을 중단하고 관련 요약 숨김·필요한 원문/외부 사본 삭제를 처리하며 일반 동행·계정은 유지한다. 필수화와 철회 처리의 법적 정합성은 검토 대기다. 확인 전 관련 가입 차단·외부 전송을 시행하지 않는다. AI 화면 설명을 제공하고 별도 첫 이용 팝업은 추가하지 않는다.

사진은 JPG·JPEG·PNG 원본10MB 이하이며 최종 저장 JPEG 경로와 원본 수신/변환 검증을 구분한다. 위 기존 `/complete` 본문에 동의 필드·철회 기능이 구현됐다고 해석하지 않는다. 다른 네이버 계정 연결·활동 이전은 제공하지 않는다.

진행 중 확정 약속은 탈퇴를 막되 후기 기한만 남거나 진행 약속 없이 분쟁만 남으면 탈퇴할 수 있다. 탈퇴 시 프로필·사진 활성 저장소 삭제와 접근 회수, 공고·신청 취소, 최소 안전 기록 분리를 적용한다. 즉시 재가입은 새 프로필·당도15·완료0이고 동일 네이버 검증 식별값으로 경고·제재·연속취소만 연결한다. 식별값 보관 근거·기술 지원·백업 만료와 실제 삭제는 별도 확인이다. 정식 삭제 요청은 공개 처리방침의 삭제 구역과 `cumaciki0317@gmail.com`을 사용하며 게시 전 운영자명·처리시간·처리 체계를 준비한다.


## 2026-10-09 탈퇴 HTTP 준비 — 기본 비활성

`POST /functions/v1/service-api/me/retirement`(직접 서버 `/service-api/me/retirement`)은 회원 Bearer JWT와 `{withdrawalId: UUID}`만 받는다. query·actor·Auth ID·Storage 경로·완료 주장 등 추가 필드는 거절한다. 사용자 client는 원 JWT와 anon key로 `retire_my_account(p_withdrawal_id)`만 호출하며 서비스 키/내부 인증으로 대체하지 않는다.

응답은 `{data:{withdrawalId,status:"processing"|"completed",memberAccessRevoked:true},requestId}`다. `processing`은 접근 회수와 삭제 작업 접수이며 외부 자료 파기 완료가 아니다. `completed`도 다른 보관 자료/백업의 즉시 삭제를 주장하지 않는다. DB 결과가 다른 요청이거나 접근 미회수/비정상 형태이면 성공 응답을 만들지 않는다.

기본 진입점은 이 경로에404를 반환한다. 신뢰된 서버 조립의 `createRuntimeHandler(read,{memberCleanup:true,memberRetirement:true})`에서만 연결하며 cleanup 없이 retirement를 켜면 시작을 거절한다. 이는 로컬 통합 준비 옵션이고 DB의 삭제 승인 guard·실제 pipeline/제품 실행기 검증을 대신하지 않는다. HTTP body/header로 활성화할 수 없다.

입력·권한·기본 닫힘·상태 계약·회원 client 연결은 모형13개 PASS다. 실제 Auth는 최초 탈퇴 때 세션이 삭제되므로 응답 유실 후 원 JWT 재시도·완료 후 상태 확인 가능 여부를 실제 Auth로 검증해야 한다. 실패를 익명/내부 권한으로 우회하거나 새 withdrawalId로 재전송하지 않는다. Storage→Auth 실제 정리·제품 실행기·실회원/운영 활성화는 미완료다.
