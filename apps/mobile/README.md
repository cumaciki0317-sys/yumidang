# 유미당 모바일 프론트

현재 정책 기준은 [정책.md](../../정책.md)다. 화면 요구는 [IA](../../docs/planning/design/IA.md)·[USERFLOW](../../docs/planning/design/USERFLOW.md), 서버 계약은 [공통 API](../../backend/contracts/service-api.md)·[검색](../../backend/contracts/search.md)·[AI 탐색](../../backend/contracts/ai-chat.md)·[후기 요약](../../backend/contracts/review-summary.md)을 따른다.

## 실행과 데이터 모드

```sh
npm ci
npm run web
```

기본은 로컬 예시 모드다. `/preview`는 예시 상태를 바꾸는 도구이며 실제 회원·운영 판정이 아니다. 서비스 모드는 예시 회원·공고·행사를 초기 데이터나 장애 대체 결과로 사용하지 않는다. 실패·결과 없음·로그인 필요·미연결을 구분한다.

서비스 모드의 공개 설정은 빌드 전에 넣는다. 아래 주소는 형식 예시이며 승인된 실제 주소를 대신하지 않는다. 비밀키·DB 주소·회원 토큰은 `EXPO_PUBLIC_*`에 넣지 않는다.

```sh
EXPO_PUBLIC_DATA_MODE=service
EXPO_PUBLIC_SERVICE_API_URL=https://PROJECT.supabase.co/functions/v1/service-api
EXPO_PUBLIC_AI_CHAT_URL=https://PROJECT.supabase.co/functions/v1/ai-chat
EXPO_PUBLIC_PRIVACY_URL=https://APP.example/privacy
```

데이터 모드를 바꾸면 Metro 변환 캐시를 비워 다시 빌드한다. `build:web`·`build:native`는 `--clear`를 포함한다. 설정 존재·묶음 생성·서버 응답·실제 회원 흐름·운영 배포는 각각 확인한다.

## 현재 서버 소비 구현

`src/service.ts`·`src/member-service.ts`·원격 화면은 현재 공통 API 계약을 소비한다. 일반 공고·행사는10개, 공개 후기는5개씩 조회한다. 숫자 나이19~99·지역·16개 분류 검색과 행사 조회 조건은 현재 서버 소스에 연결돼 있다. 전체 나이 검색에99세 상한을 추가하지 않는다.

- 공고 검색·상세, 행사 목록·필터, 회원 프로필·공개 후기·칭찬, AI 탐색·평가를 연결한다. 장소명은 회원 전용 `places` API에서10개씩 조회하고 주소 선택은 공식 Kakao 우편번호 콜백을 검사한다. 작성 중 행사 선택은 active·미종료·일정 겹침을 확인하며 공고 일정을 자동 변경하지 않는다.
- 공개 후기 요약은 회원 전용 `/profiles/:id/review-summary`의 정확한 `{summary}`를 사용한다. null을 철회·후기 부족·생성 중으로 추정하지 않으며 프로필·원문 후기와 실패를 분리한다.
- 본인 프로필·성향/소개 원자 저장·대표사진 교체, 첫 메시지 신청·대화·확정·일정/장소 변경·취소·완료·후기, 알림 읽음·차단/해제·신고·AI 처리 철회·탈퇴의 현재 API 소비 코드가 있다. 서버 성공과 검증된 응답 뒤에만 화면을 갱신한다. 첫 메시지·이의 접수 등 재시도용 ID와 실패한 입력을 보존하고 자동 재전송하지 않는다.
- 계정 관리에 신고 숨김 목록·본인 해제와 취소/일반 판정 안내를 연결했다. 목록·읽음과 일반 안내 성공 제공 ACK는 별도다. 검증된 안내가 화면에 표시된 뒤 ACK하고 서버의 이의 마감만 표시한다. 일반 이의 접수/조회와 취소 사유의 신고·이의 원자 접수/조회도 연결한다. 응답 유실을 접수 성공이나 추정 마감으로 바꾸지 않는다.

다음 기능은 **제공 미완료**다. 클라이언트 차단이나 준비 안내를 기능 완료로 집계하지 않는다.

- 공개 행사 상세 `/events/:id`와 공연 순위 `/events/rankings`는 현재 서버에 없다. 클라이언트는 추측 경로·내부 API를 호출하지 않고 미연결 오류와 준비 안내를 제공한다. KOPIS 순위 기간과 서울 HTTPS 연결 보류는 유지한다.
- 본인 공고 목록·직접 소유권 조회와 대화 읽음 경로가 없다. 공고 관리는 현재 서버의 작성자 대화 근거가 있는 범위만 제공하며 신청 없는 본인 공고까지 관리할 수 있다고 표시하지 않는다.
- 신고 숨김은 최소 식별값 저장·조회·해제 계약이 있지만 공고/행사/검색/채팅 소비면의 지속 필터 연결이 없다. 신규 신고의 숨김 선택은 보류한다. 기존 숨김 목록·해제는 차단 해제나 신고 취소와 분리한다.

## 회원 인증·Storage 초기화 조건

`src/remote.tsx`의 `installWebMemberConnection(options)`는 검증된 웹 인증·사진·일반 신고 캡처 어댑터를 조립한다. 현재 제품의 초기화 경로는 이 함수를 호출하지 않는다. 서비스 URL만 설정해 실제 로그인·사진 업로드가 동작한다고 판단하지 않는다.

신뢰할 초기화 코드가 승인된 `signupUrl`, `supabaseUrl`, `publicApiKey`, `callbackUrl`과 실제 browser를 공급해야 한다. callback은 현재 HTTPS 앱 origin의 정확한 `/auth-callback`을 사용한다. 토큰은 메모리에 두고 로그아웃·철회 때 세션을 비운다. 세션 변경·화면 이동은 이전 요청과 응답을 차단한다. 시험용 세션 설치 경로와 가상 토큰은 제품에 포함하지 않는다.

native 복귀·세션 어댑터는 별도 준비가 필요하다. 웹 origin·PKCE 처리를 native 인증 성공으로 재사용하지 않는다. 실제 네이버 적격 계정2개, 실제 Auth/DB/Storage, iOS·Android 복귀·사진·WebView·탈퇴 및 전체 동행 흐름 검증이 남는다. `app.json`의 iOS bundle identifier·Android package·EAS project 식별자도 승인된 발급값이 필요하다.

AI 신고 캡처는 별도의 `installAiReportCaptureUpload(upload)` 포트가 필요하다. 미설치 때 업로드하지 않는다. 포트는 취소 신호·소유권·멱등·미접수 파일 정리를 처리해야 한다. 공급사 보관·검사 승인과 회원 원문 전송 보류를 유지한다.

## 코드와 배포 산출물

| 위치 | 역할 |
|---|---|
| `src/app/`, `src/screens/`, `src/ui.tsx` | 화면·라우팅·표시 |
| `src/state.tsx`, `src/data.ts`, `src/domain.ts` | 예시 상태·규칙과 서비스 모드 경계 |
| `src/api.ts`, `src/service.ts`, `src/member-service.ts` | 전송·정확한 응답 검사·서버 소비 |
| `src/remote.tsx`, `src/web-member-session.ts`, `src/avatar-service.ts` | 신뢰할 세션·Storage 포트 조립 |
| `design/stitch/manifest.json` | 디자인 원천 기록 |

공통 설정·SQL·`service-api`는 민규 담당이다. 종현 함수 산출물 중 장소는 `places/index.ts`, 행사 수집은 `event-sync/index.ts`의 default.fetch를 사용한다. 공통 `SUPABASE_URL`·`SUPABASE_ANON_KEY`·`UPSTREAM_TIMEOUT_MS`·`MAX_REQUEST_BYTES`·`ALLOWED_ORIGINS`가 필요하며 내부 함수는 서비스 역할 키와 내부 작업 secret을 별도로 요구한다.

장소 추가 설정은 `KAKAO_REST_API_KEY`·`PLACES_PAGE_SIZE=10`이다. 행사 추가 설정은 `EVENT_SYNC_PROVIDERS`·`EVENT_SYNC_MAX_PERIOD_DAYS`·`EVENT_SYNC_MAX_PAGE`·`EVENT_SYNC_PAGE_ROWS`와 원천별 `KOPIS_API_KEY` 또는 `TOUR_API_SERVICE_KEY`·확인된 `TOUR_API_KEY_FORMAT`이다. 수집 상한은 코드에서 공급사 규격으로 검사하며 임의 운영 기본값을 만들지 않는다. 설정값·키를 문서에 기록하지 않는다. 함수·worker의 전체 연결은 [현재 구현 결과](../../docs/collaboration/requests/jonghyun/2026-10-07-implementation-result.md)를 따른다.

웹 export는 SPA 주소를 `index.html`로 연결하는 서버에서 제공한다. native export는 JavaScript·자산 묶음이며 서명된 설치 파일·기기 설치·스토어 심사 결과가 아니다. `dist`·`dist-native`·비밀값은 Git에 포함하지 않는다. 현재 실제 운영 배포를 수행하지 않았다.

## 검증과 남은 조건

```sh
npm run typecheck
npm run lint
npm run test:policy
node --experimental-strip-types --test ../../tests/functions/jonghyun/mobile-service.test.ts ../../tests/functions/jonghyun/20261007-integration-mobile.test.ts
npm run build:web
npm run build:native
# 해당 데이터 모드의 SPA 로컬 서버를 연 뒤 실행
PREVIEW_URL=http://127.0.0.1:8088 npm run test:browser
SERVICE_PREVIEW_URL=http://127.0.0.1:8089 node ../../tests/integration/jonghyun/mobile-service-browser.mjs
```

`metro.config.js`는 우편번호 공통 정규화 소스를 읽는 backend 경로를 포함한다. [Metro watchFolders](https://metrobundler.dev/docs/configuration/#watchfolders)·[Expo monorepo 안내](https://docs.expo.dev/guides/monorepos/)를 참고한다.

이번 J3의 실제 HTTP handler+합성 RPC 검사, 타입 검사·lint와 localhost 브라우저 검증은 [구현 결과](../../docs/collaboration/requests/jonghyun/2026-10-07-implementation-result.md)에 실행 범위별로 기록했다. 브라우저는 합성 HTTP·시험용 세션·공식 우편번호 콜백 stub을 사용한다. 실제 네이버·공급사·DB·기기·운영 성공으로 표현하지 않는다. 새 변경 관련 검사와 과거 전체 검사를 중복 합산하지 않는다. GPT/Codex 대체 실행·자체 검증이며 Gemini 독립 검증과 구분한다.

과거 의존성 설치 검사에29건(높음19·중간10)이 기록돼 있으나 현재 재검사 수치가 아니다. 이번 작업에서 네트워크 audit를 반복하지 않았다. 이를 현재 보안 통과나 현재 결함 개수로 해석하지 않는다. `npm audit fix --force`로 호환되지 않는 메이저 변경을 하지 않는다.

현재 작업은 `/private/tmp/yumidang-jonghyun-implementation-20261007` 독립 clone의 `jonghyun/queue-integration`에서 진행했다. 사용자 요청에 따라 이 브랜치에 커밋·푸시하며 제출 결과는 Git 기록으로 확인한다. 이 문서나 코드 공유를 출시 완료의 증거로 사용하지 않는다. 실제 외부 요청·운영 배포는 별도 범위다. 실제 기기·운영·성호 UT/QA와 승인된 인증 초기화가 남아 있다.
