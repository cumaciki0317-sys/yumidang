# 임의 번호 테스트 인증 — 현재 로그인에서 제외

## 현재 적용

현재 가입·로그인은 [네이버 전용 정책](../../../../정책.md)을 따른다. 이 고정 코드·임의 번호 테스트 함수는 현재 가입·로그인·자격 확인에 사용하지 않는다. 실제 네이버 필수 정보·여성 만 19세·사진·계정 연결을 대체하지 않는다. 함수 코드·과거 배포·발급 계정/세션은 이번 문서 작업에서 제거하거나 취소하지 않았다. 실제 잔존 활성화 여부와 정리는 인증 담당의 별도 확인 대상이다. 아래 설정·검증 기록은 당시 동작 확인을 위한 자료다.

2026-09-16 사용자 활성화 승인으로 지정 프로젝트에 version 1을 배포했다. 서버 secrets 3개 설정, 로컬 플래그 활성화, 별도 명시 승인 후 Vercel **yumidang**의 Production/Preview에 공개 환경 변수 3개를 추가했다. 사이트 배포는 실행하지 않았다.

- 신규 인증 만료: **2026-09-23 18:30 KST** (`2026-09-23T09:30:00Z`). 계정·프로필은 삭제하지 않으며 이미 발급된 세션을 취소하지 않는다.
- Vercel 공개 변수: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_TEST_PHONE_AUTH=true`. 설정 전에 시작한 빌드에는 반영되지 않을 수 있다. 최신 소스가 포함된 새 빌드가 필요하다.
- 오래된 `.vercel/project.json`의 `yumidang6`은 현재 대상이 아니다. Vercel 작업은 `--project yumidang`을 명시한다.

대상은 `bndguguarijmghnkenvt` 하나다. 11자리 숫자와 `123456`으로 실제 Supabase 사용자·세션을 만들고 기존 `profiles`/RLS를 사용하도록 준비한 서버다. 실제 SMS·번호 소유 확인이 아니다. 같은 번호와 공개 코드를 알면 같은 테스트 계정에 들어갈 수 있으므로 실제 고객 데이터가 있는 운영 프로젝트에는 활성화하지 않는다.

## 동작

- `POST { action: "request", phone: "01012345678" }`: 테스트 코드 안내. 임의 번호는 이 단계에서 계정을 만들거나 SMS를 보내지 않는다.
- `POST { action: "verify", phone: "01012345678", code: "123456" }`: 서버가 코드·형식·활성화·만료를 검사하고 Supabase Auth API로 계정 및 세션을 얻는다.
- 기존 20개 번호는 Supabase의 기존 OTP 요청/확인 경로를 사용한다. 기존 번호 설정과 사용자 ID를 재작성하지 않는다.
- 새로운 번호는 Admin API `createUser`에 해당하는 요청을 사용한다. 서버 전용 비밀로 번호별 비밀번호를 유도하고 phone/password 로그인으로 실제 Auth 토큰을 얻는다. 브라우저에는 비밀번호·관리자 키가 전달되지 않는다.
- 재로그인에서 기존 계정 비밀번호를 변경하지 않는다. 이 방식으로 만든 테스트 계정만 세션을 반환한다.
- `app_metadata.test_phone_auth=true`, `phone_ownership_verified=false`로 테스트 인증을 표시한다. 원격 Auth의 `phone_confirmed_at`은 실제 SMS 인증 증거가 아니다.
- 프론트엔드 `setSession` 이후 기존 UUID, 프로필 저장, 세션 복구, RLS 경로를 사용한다. 새 계정은 기본 프로필을 입력한다.
- 채팅/신청 등 기능 3~9의 원격 구현을 포함하지 않는다. 사용자 ID가 생겼다는 사실만으로 실제 다중 사용자 상호작용이 완성된 것은 아니다.

## 당시 적용 설정 — 재활성화 지침이 아님

아래는 당시 설정 내용이다. 이 문서의 존재나 과거 승인을 현재 재활성화 승인으로 사용하지 않는다.

1. 해당 ref에만 `test-phone-auth` Edge Function 배포. 로그인 전 endpoint이므로 `verify_jwt=false`가 필요하며, 함수 내부에서 고정 테스트 코드를 검증한다.
2. 서버 secrets 설정:
   - `TEST_PHONE_AUTH_ENABLED=true`: 테스트 서버 활성화. 미설정 시 거부.
   - `TEST_PHONE_AUTH_EXPIRES_AT`: 미래 ISO 시각. 이번에는 사전 안내한 7일 기본값을 설정했다. 미설정/잘못된 날짜/만료 시 거부. 기존 발급 세션 자체를 취소하는 기능은 아니다.
   - `TEST_PHONE_AUTH_SECRET`: 무작위 32자 이상 서버 전용 비밀. 번호별 내부 비밀번호를 만들므로 계정 수명 동안 유지해야 한다. 변경 시 기존 임의 번호 테스트 계정에 다시 로그인할 수 없다.
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`: Supabase가 함수에 제공하는 서버 환경. 브라우저 변수에 복사하지 않는다.
3. 실제 원격 새 계정 A/B, 잘못된 코드, 재로그인 동일 UUID, 프로필 저장/복구와 RLS를 검증한다.
4. 로컬 `.env.local`에 `VITE_TEST_PHONE_AUTH=true` 설정 완료. 실행 중인 Vite는 환경 변수를 새로 읽어야 한다.

## 검증

- 로컬 handler 테스트는 mock Auth API를 사용한다. 원격 계정 생성 성공으로 표현하지 않는다.
- 실제 원격 PASS: `node tests/remote-test-phone-auth.mjs`. 잘못된 코드 차단, 010이 아닌 임의 11자리 포함 새 Auth 계정·세션, 프로필 저장, 같은 UUID 재로그인, 세션 갱신, A/B/anon RLS, 시스템 열 쓰기 거부, 기존 20개 중 0010 OTP 회귀, 로그아웃. 테스트 계정·프로필을 실제로 남기는 명시 실행 스크립트다.
- 테스트 스크립트의 초기 upsert는 `id` UPDATE 권한 때문에 거부됐다. 앱과 동일한 INSERT/입력 열 UPDATE로 수정해 PASS. DB 권한은 넓히지 않았다.
- Vercel 재배포·배포 URL 인증 확인, 실제 SMS, 실제 7일 만료 경계 대기: `NOT_RUN`.
- 보안 Advisor: 기존 유출 비밀번호 보호 비활성 경고 1건. 이 경로는 서버 비밀에서 내부 비밀번호를 유도하며 사용자 비밀번호 입력은 없다. 실제 운영 전 공유 코드 방식 자체를 제거해야 한다.
- 같은 코드로 누구나 테스트 계정을 생성할 수 있으며, 별도의 전역 계정 생성 제한을 구현하지 않았다. Supabase 자체 Auth rate limit은 그대로 적용한다.
