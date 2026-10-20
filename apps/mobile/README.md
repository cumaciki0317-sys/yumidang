## 현재 파일 담당 — 2026-10-14

종현은 웹·앱 Frontend, UX/UI, 화면 구현과 API·인증·세션 클라이언트 연결을 담당한다. 민규는 BE·DB·서버·AI와 서버 검색/행사/작업 실행을 전담한다. QA는 민규·종현·유미 공통, UT는 유미 담당이다. 성호의 현재 담당 배정은 제거했다. 기존 구현·검증 증거와 파일 경로는 보존하며 상세 수정 경계는 [소유권 정책](../../backend/ownership.json)을 따른다.

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

- 공고 검색·상세, 행사 목록·필터, 회원 프로필·공개 후기·칭찬, AI 탐색·평가를 연결한다. 장소명은 회원 전용 `places` API에서10개씩 조회하고 주소 선택은 공식 Kakao 우편번호 콜백을 검사한다. 현재 작성용 구현은 active·미종료·일정 겹침을 검사하지만, 현행 확정 설계는 일정 겹침 강제와 동행 일정 자동 검색 축소를 제거한다. 이 차이는 후속 수정·검증 대상이며 공고 일정을 자동 변경하지 않는다.
- 공개 후기 요약은 회원 전용 `/profiles/:id/review-summary`의 정확한 `{summary}`를 사용한다. null을 철회·후기 부족·생성 중으로 추정하지 않으며 프로필·원문 후기와 실패를 분리한다.
- 본인 프로필·성향/소개 원자 저장·대표사진 교체, 첫 메시지 신청·대화·확정·일정/장소 변경·취소·완료·후기, 알림 읽음·차단/해제·신고·AI 처리 철회·탈퇴의 현재 API 소비 코드가 있다. 서버 성공과 검증된 응답 뒤에만 화면을 갱신한다. 첫 메시지·이의 접수 등 재시도용 ID와 실패한 입력을 보존하고 자동 재전송하지 않는다.
- 계정 관리에 신고 숨김 목록·본인 해제와 취소/일반 판정 안내를 연결했다. 목록·읽음과 일반 안내 성공 제공 ACK는 별도다. 검증된 안내가 화면에 표시된 뒤 ACK하고 서버의 이의 마감만 표시한다. 일반 이의 접수/조회와 취소 사유의 신고·이의 원자 접수/조회도 연결한다. 응답 유실을 접수 성공이나 추정 마감으로 바꾸지 않는다.

다음 기능은 **제공 미완료**다. 클라이언트 차단이나 준비 안내를 기능 완료로 집계하지 않는다.

- 공개 행사 상세 `/events/:id`와 공연 순위 `/events/rankings`는 현재 서버에 있다. 상세는 최신 저장 DTO를 사용하고 순위는 공식 기간 확인 전 보류 응답을 제공한다. endpoint 존재를 실제 공급사 순위 검증 완료로 해석하지 않는다. 서울 HTTPS 연결 보류도 유지한다.
- 본인 공고 `/me/posts`와 개별 메시지 읽음 서버·서비스 계약은 구현돼 있다. 읽음은 검증된 계약 옵션과 실제 본 메시지 ID를 사용하며 기존 마지막 읽음 위치로 대체하지 않는다. 실제 Auth·HTTP·서비스 통합 검증과 화면·실회원 검증은 별도다.
- 신고 숨김은 최소 식별값 저장·조회·해제 계약이 있지만 공고/행사/검색/채팅 소비면의 지속 필터 연결이 없다. 신규 신고의 숨김 선택은 보류한다. 기존 숨김 목록·해제는 차단 해제나 신고 취소와 분리한다.

## 회원 인증·Storage 초기화 조건

`src/remote.tsx`의 `installWebMemberConnection(options)`는 웹 인증·사진·일반 신고 캡처 어댑터를 조립한다. 현재 RootLayout은 신뢰할 호스트가 `configureWebMemberConnection(options)`로 제공한 설정이 있을 때 이 함수를 호출한다. 승인된 실제 설정·계약 옵션·서버 동작 검증 없이 서비스 URL만으로 로그인·사진 업로드 완료를 판단하지 않는다.

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

공통 설정·SQL·`service-api`는 민규 담당이다. 민규 담당 서버 함수 중 장소는 `places/index.ts`, 행사 수집은 `event-sync/index.ts`의 default.fetch를 사용한다. 공통 `SUPABASE_URL`·`SUPABASE_ANON_KEY`·`UPSTREAM_TIMEOUT_MS`·`MAX_REQUEST_BYTES`·`ALLOWED_ORIGINS`가 필요하며 내부 함수는 서비스 역할 키와 내부 작업 secret을 별도로 요구한다.

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

현재 작업은 `/private/tmp/yumidang-jonghyun-implementation-20261007` 독립 clone의 `jonghyun/queue-integration`에서 진행했다. 사용자 요청에 따라 이 브랜치에 커밋·푸시하며 제출 결과는 Git 기록으로 확인한다. 이 문서나 코드 공유를 출시 완료의 증거로 사용하지 않는다. 실제 외부 요청·운영 배포는 별도 범위다. 실제 기기·운영·유미 UT·공통 QA와 승인된 인증 초기화가 남아 있다.

## 2026-10-08 후속 서버 연결

본인 공고 `/me/posts`를 마이페이지에 연결해 신청 없는 공고도 관리한다. 작성자 권한 확인은 본인 목록의 `isOwner`와 서버 최종 검사로 수행한다. 채팅은 본문이 실제 화면과 일부라도 겹치는 메시지 ID만 개별 읽음 포트에 전달한다. 화면 밖 메시지, 로그아웃·대화방 이동 후 늦은 응답은 적용하지 않는다. 서버 `unread_count`를 목록에 표시한다.

행사 상세는 `/events/{id}`의 최신 DTO를 사용하고 취소 상태를 표시한다. 신규 선택은 기존 active/일정 검사로 제한한다. 공식 순위는 쿼리 없이 `/events/rankings`를 조회하고 `not_enabled`를 공급사 확인 보류로 표시한다. 본인 숨김 목록·해제 UI와 서버의 개별 콘텐츠 필터를 유지한다. 신규 신고의 숨김 선택 보류는 유지한다.

승인된 웹 배포값을 가진 신뢰할 호스트는 `configureWebMemberConnection(options)`를 호출한다. RootLayout은 전달된 설정으로 기존 웹 세션·사진·캡처 포트를 설치하고 restore 결과를 세션 변경 검사 후 반영한다. 새 환경변수나 URL/Origin 추정은 추가하지 않는다. 실제 설정이 아직 공급되지 않았으므로 실제 네이버 로그인은 미검증이다. 기존 웹 세션은 access/refresh token을 메모리에만 유지하므로 브라우저 새로고침 후 자동 로그인 복구는 제공하지 않는다. native 등록·callback 계약도 대기 중이다.

채팅 읽음은 사용자 2A 선택으로 개별 메시지 방식이다. `installMessageReadPort`에 민규의 검증된 어댑터가 공급되기 전에는 준비 중을 표시하고 전송하지 않는다. 기존 마지막 읽음 위치 API로 대체하지 않는다. 메시지 본문 View와 목록 viewport의 실제 화면 좌표가 겹치는지 검사하므로 긴 메시지의 일부 표시도 인정하며 카드 여백·날짜만 보일 때는 전송하지 않는다. 같은 ID는 확인 후 중복 전송을 억제하고 과거 메시지를 새로 보면 해당 ID만 별도 전송한다. 서버의 개별 메시지 접수 API 및 실제 환경은 사용자 3A 선택에 따라 민규 계약 대기다.

## 공통 포트 대기를 제외한 화면 연결 보완

홈은 실제 본인 프로필 실명·알림 진입과 확정 약속의 D-day·일정·공개 지역을 표시한다. 서버 시각이 없으면 D-day를 추정하지 않는다. 채팅 목록 상태, 작성자의 신청 거절 확인, 내 공개 프로필·후기 진입을 연결했다. 행사 상세에서 신규 모집으로 이동하면 실제 행사 상세를 다시 읽어 행사 제목·장소 후보를 표시하며 작성 일정은 보존한다.

취소 화면은 실제 약속 조회의 서버 시각과 응답 수신 이후 경과로 시작 전인지 확인하고 제출 직전에 다시 검사한다. 시작 이후는 일방 취소 양식 대신 중단·불발 신고를 제공한다. 상태·서버 시각이 미확인이면 취소를 제공하지 않고 재조회와 신고를 유지한다. 최종 취소 권한·상태는 기존 서버가 확인한다. 화면 연결 및 합성 검증은 실제 회원·공급사·기기 검증을 대신하지 않는다.


## 행사 UX 현행 구현 과제

[2026-10-20 확정 명세](../../docs/collaboration/requests/jonghyun/2026-10-20-event-ux-approved-spec.md)에 따라 일반 작성은 행사 영역 하단, 행사 상세 진입은 상단이다. API 선택·공고 전용 직접입력·연결 없음, 날짜강제 없이 달력 행사날짜 색 강조, 이미지 미제공/실패 시 글만, 로그인 후 원행사 작성 복귀를 구현한다. 검색은 실제 조회 가능한 전체 범위이며10개씩,0건/오류 구분. 비표출 A 안내·재표출 복원·확인된 취소/연기·등록확인 실패·관련 공고/앱 안 알림은 서버 상태를 소비한다.

기존 서버의 UUID 행사 연결·active/cancelled만으로 새 명세가 충족되지 않는다. 직접입력 저장, 안전한 비표출 DTO, 연기/미제공 상태 구분, 검증 동일 행사 대표/원천 관계·충돌, 날짜강제 제거, 행사 변경 합의·중복방지 알림은 민규 의존성이다. FE 모형/합성 검증·실제 연결·운영 적용을 구분하며 이 문서 변경은 코드 완료가 아니다.
