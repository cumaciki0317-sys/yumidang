# 유미당 모바일 프론트

현재 정책 기준은 [정책.md](../../정책.md)다. 화면 요구는 [IA](../../docs/planning/design/IA.md)·[USERFLOW](../../docs/planning/design/USERFLOW.md), 종현 서버 계약은 [검색](../../backend/contracts/search.md)·[AI 탐색](../../backend/contracts/ai-chat.md)·[후기 요약](../../backend/contracts/review-summary.md)을 따른다.

## 실행과 데이터 모드

```sh
npm ci
npm run web
```

기본은 로컬 예시 모드다. Stitch 시안을 참고한 23개 화면에서 첫 메시지 신청·6시간 만료·완료·7일 후기 공개·분쟁·제재를 확인할 수 있다. `/preview`는 예시 상태를 바꾸는 별도 도구이며 실제 운영 판정이 아니다. 서버·DB·모델 호출 없이 동작한다.

실제 API를 읽는 모드는 빌드 전에 다음 공개 환경변수를 설정한다. 데이터 모드를 바꿀 때는 Metro 변환 캐시를 비워 다시 빌드해야 한다. `build:web`/`build:native`는 `--clear`를 포함하며, 직접 `expo export`를 실행할 때도 이 옵션을 전달한다. 캐시에 남은 예시 모드를 실제 API 연결로 잘못 표시하지 않도록 빌드 결과의 모드 안내와 요청을 확인한다.

```sh
EXPO_PUBLIC_DATA_MODE=service
EXPO_PUBLIC_SERVICE_API_URL=https://PROJECT.supabase.co/functions/v1/service-api
EXPO_PUBLIC_AI_CHAT_URL=https://PROJECT.supabase.co/functions/v1/ai-chat
```

`service` 모드에서는 예시 회원·공고·행사를 초기 데이터로 사용하지 않는다. 검색·행사 목록·상세·분류·공식 순위·회원 프로필·공개 후기·칭찬·AI 요약·AI 탐색을 `src/service.ts`와 `src/screens/RemoteScreens.tsx`가 요청한다. 실패·결과 없음·로그인 필요를 구분하고 잘못된 응답을 예시 결과로 바꾸지 않는다. 기본 공고·행사는10개, 후기는5개씩 조회한다. 장소명 검색은 회원 전용 places API10개씩, 주소 선택은 공식 Kakao 우편번호 콜백으로 처리한다. 작성 중 행사 선택은 설정한 일정과 겹치는 행사만 연결하고 일정을 자동으로 바꾸지 않는다.

실제 네이버 인증 담당이 `src/remote.tsx`의 `installServiceSession(accessToken)`에 검증된 세션을 설치하고 로그아웃·권한 철회 시 `null`을 전달해야 한다. 토큰은 메모리에만 두며 `EXPO_PUBLIC_*`나 예시 로그인으로 인증을 만들지 않는다. 세션 변경 때 이전 요청을 중단하고 이전 응답을 화면에 복원하지 않는다. 현재 네이버 인증·사진 Storage 업로드·공고/신청/약속/후기/차단/신고/철회/탈퇴의 실제 변경 API 연결은 남아 있어, 서비스 모드에서 해당 변경을 성공으로 표시하지 않는다.

AI 답변의 평가·신고는 기존 AI 함수의 `/feedback`을 사용한다. 신고는 사용자가 직접 입력한 답변 구간 또는 캡처 한 개를 미리 확인한 뒤 보내고 서버 접수 성공 때만 해당 답변을 본인 화면에서 숨긴다. 미준비·실패는 성공으로 표시하지 않는다. 캡처의 실제 Storage 업로드는 인증 담당이 `installAiReportCaptureUpload(upload)`를 설치해야 한다. 기본 미연결 상태에서는 캡처 업로드를 시작하지 않는다. 포트는 신호 취소·회원/자료 소유권·멱등 업로드·접수되지 않은 파일 정리를 보장해야 한다.

공통 서비스 API와 SQL은 민규 담당이다. 숫자 나이·지역·16개 분류와 새 행사 조건 및 추가 조회 경로를 채택해야 한다. 현재 공통 `service-api/search-http.ts`는 과거 연령대 타입이 남아 타입 검사에 실패한다. 프로필 요약·공식 Top10·행사 상세 등 새 경로도 실제 서버 지원을 확인해야 하며 URL 설정만으로 전체 연동이 완료되지 않는다. 상세 요청은 [종현 구현 인계](../../docs/collaboration/requests/jonghyun/2026-10-05-policy-implementation-handoff.md)에 둔다.

## 코드 위치

| 위치 | 역할 |
|---|---|
| `src/app/`, `src/screens/`, `src/ui.tsx` | 화면·라우팅·Stitch 기반 시각 요소 |
| `src/state.tsx`, `src/data.ts` | 로컬 예시 상태와 서비스 모드의 변경 차단 |
| `src/domain.ts` | 기간·주차·만료·후기·당도·입력 규칙 |
| `src/storage.ts` | 예시 모드 계정별 초안·최근 검색어; AI 원문 저장 없음 |
| `src/api.ts`, `src/service.ts`, `src/remote.tsx` | HTTPS 전송·응답/권한 검사·세션 연결 |
| `design/stitch/manifest.json` | Stitch 프로젝트15036677317273949177의20개 화면 출처 |

과거 시안의 별도 S08 신청·연결 계정 변경·유료 결제·거리 검색·강제 AI 팝업·한쪽 후기24시간 공개는 현재 화면 요구에 사용하지 않는다. 비로그인 작성자 정보는 중립 자리표시자와 로그인 안내로 제공하며 실제 이름·사진을 DOM에 넣고 CSS로 가리지 않는다. AI 설명·안전 검사·공급사 승인 조건이 준비되지 않으면 실제 전송을 중단한다.

## 검증

```sh
npm run typecheck
npm run lint
npm run test:policy
node --experimental-strip-types --test ../../tests/functions/jonghyun/mobile-service.test.ts
npm run build:web
npm run build:native
# 해당 데이터 모드로 빌드하고 SPA 로컬 서버를 연 뒤 실행
PREVIEW_URL=http://127.0.0.1:8088 npm run test:browser
SERVICE_PREVIEW_URL=http://127.0.0.1:8089 node ../../tests/integration/jonghyun/mobile-service-browser.mjs
```

`metro.config.js`는 우편번호 공통 정규화 소스를 읽도록 backend `_shared` 경로를 포함한다. 중복 정규화 파일을 만들지 않는다. [Metro watchFolders](https://metrobundler.dev/docs/configuration/#watchfolders)·[Expo monorepo 안내](https://docs.expo.dev/guides/monorepos/)를 참고한다.

웹 export는 모든 화면 주소를 `index.html`로 연결하는 SPA 서버에서 제공한다. 브라우저 검사는 macOS Chrome 또는 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`을 사용한다. 서비스 브라우저 검사는 합성 HTTP 응답을 주입하므로 실제 인증·DB·공급사 검증과 구분한다. 회원 검사는 `/tmp`에 만든 테스트 전용 session 설치 route를 사용한다. 이 route/가상 토큰은 제품 소스에 포함하지 않는다. 우편번호 SDK도 공식 URL에 로컬 콜백 stub을 주입하며 실제 공급사 호출 성공으로 보고하지 않는다. 현재 예시57개·비로그인서비스12개·회원17개·AI/신고/홈19개 합성 브라우저 검사가 통과했다. 전체 단위/합성415개와 탐색 연동5개도 통과했으며 부분집합을 중복 합산하지 않는다. 상세 결과와 미실행 환경은 인계 문서에 기록한다. iOS·Android 묶음 생성은 실제 기기 설치·네이버 복귀·WebView·스토어 심사 통과를 뜻하지 않는다.

현재 의존성 설치 검사에는29건(높음19·중간10)이 남아 있다. 이를 출시 안전성 통과로 처리하지 않는다. 호환되지 않는 메이저 버전으로 바꾸는 `npm audit fix --force`는 적용하지 않는다. `dist`, `dist-native`, 비밀키·DB 주소·서비스 역할 키는 Git에 포함하지 않는다.

현재 작업 브랜치는 `jonghyun/policy-integration-20261005`이며 이 안내를 구현 커밋에 포함한다. 커밋 해시와 원격 반영 여부는 Git 기록으로 확인한다. 서울은 사용자 A안에 따라 안전한 자동 수집 연결까지 보류하며 3개 공급사 출시 목표를 유지한다. 실제 기기·운영·성호 UT/QA도 별도 과제다.
