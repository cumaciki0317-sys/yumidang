# 유미당 화면 프로토타입 · 모바일 프론트

React Native·TypeScript·Expo Router로 만든 23개 화면이다. 같은 소스로 iOS·Android용 코드 묶음과 브라우저 프로토타입을 만든다. 현재는 **예시 데이터로 화면과 정책 흐름을 확인하는 단계**다. 실제 회원 서비스나 스토어 제출용 앱이 아니다.

기준은 저장소의 [정책](../../정책.md), [IA](../../docs/planning/design/IA.md), [USERFLOW](../../docs/planning/design/USERFLOW.md), [PRD](../../docs/planning/requirements/PRD.md), [와이어프레임](../../docs/planning/design/유미당%20와이어프레임.html), [출시 결정](../../유미당_출시결정_보류사항_민규전달_20261005.md)이다. 정책 선택은 이 파일에서 새로 확정하지 않는다.

## 실행과 확인

```sh
cd apps/mobile
npm ci
npm run web
```

Expo가 출력하는 로컬 웹 주소를 연다. 상단의 `화면 목록`에서 23개 화면을 열거나 신청자·작성자 역할, 예시 시각, 처리 실패를 바꾼다. 확인 도구는 서비스 화면과 분리된 `/preview`에 있다. 화면 캡처는 [design/preview](design/preview/)에 있다.

`npm run start`는 기기 개발을 시작한다. 실제 네이버 OAuth·네이티브 연결 검증에는 Development Build가 필요하다. 이번 작업에서 앱 서명·기기 설치·스토어 제출·배포를 실행하지 않았다. [Expo 실행 안내](https://docs.expo.dev/get-started/start-developing/), [Development Build 안내](https://docs.expo.dev/develop/development-builds/introduction/).

```sh
npm run typecheck
npm run lint
npm run test:policy
npm run build:web
npm run build:native
# 웹 미리보기 서버가 실행 중일 때
PREVIEW_URL=http://127.0.0.1:8087 npm run test:browser
```

웹 export의 `dist`는 모든 화면 주소를 `index.html`로 연결하는 SPA 서버에서 제공한다. 브라우저 검사는 macOS Chrome을 사용하거나 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`로 실행 파일을 지정한다. Chrome이 없으면 Playwright Chromium 설치가 필요하다. `SCREENSHOT_DIR`로 캡처 경로를 지정할 수 있다. `dist`, `dist-native`, 기기 설정·비밀값은 Git에 포함하지 않는다.

## Stitch 참고 범위

Google Stitch MCP의 `list_projects`·`list_screens` 읽기로 프로젝트 `15036677317273949177`의 시안을 가져왔다. 20개 참고 HTML·PNG와 화면 출처는 [design/stitch/manifest.json](design/stitch/manifest.json)에 있다. 연결 키는 임시 파일로만 사용하고 삭제했으며 앱·저장소에 포함하지 않았다. 이 세션에서 직접 조회했으며 지속적인 MCP 등록은 하지 않았다.

보라색 `#6C2CF5`, 밝은 배경, 둥근 카드, 행사 배너, 4개 하단 메뉴, 필터와 약속·후기 구성을 참고했다. 다음 과거 시안은 현재 동작에서 제외했다.

- S08 별도 신청 화면, 별도 신청 문구 입력: S11 첫 메시지 성공이 신청이다.
- 다른 계정 연결, 유료 신청·결제·1원 인증, 강제 안전 서약·AI 필수 동의 팝업.
- 근거 없는 당도 99·신뢰도 비율, 거리 검색·지도 길찾기, 과거 한쪽 후기 24시간 공개 기준.
- 실제 작성자 정보를 HTML에 넣고 CSS로만 가리는 표현.

## 코드와 연결 경계

| 위치 | 역할 |
|---|---|
| `src/app/` | 23개 화면 주소, 하단 메뉴와 공통 프레임 |
| `src/screens/` | 탐색·작성, 채팅·프로필·약속, 로그인·AI 화면과 별도 확인 도구 |
| `src/ui.tsx` | 공통 카드·버튼·입력·프로필 가드와 시각 요소 |
| `src/state.tsx`, `src/data.ts` | 모의 회원·동행 상태와 예시 데이터. 외부 전송 없음 |
| `src/domain.ts` | 주차·만료·완료·후기 공개·당도·입력 검증 |
| `src/storage.ts` | 계정별 기기 초안 1개·검색어 10개·7일 만료·로그아웃 삭제. AI 저장 없음 |
| `src/api.ts` | HTTPS·회원 토큰·실패·시간 제한을 가진 서비스 API 전송 코드. 화면과 아직 연결하지 않음 |

신청·확정·취소·변경 제안·후기·차단·신고·철회·탈퇴는 **로컬 모의 처리**다. 서비스 데이터는 새로고침하면 초기화된다. 초안·검색어만 기기에 저장하며 민감한 실제 정보를 넣지 않는다. 사진 선택은 Expo ImagePicker를 사용하되 서버 업로드·실제 회원 사진 삭제는 실행하지 않는다.

AI는 로컬 조건 처리로 답변·카드를 보여준다. 횟수·동시 요청·철회 흐름을 확인할 수 있지만 실제 모델 품질·공급사 비용을 측정한 것은 아니다. 후기 요약도 공개 원문 발췌 미리보기이며 AI 생성 결과가 아니다. 실제 회원 원문 외부 전송은 기존 정책의 확인 조건을 따른다.

백엔드 담당과 [서비스 API 계약](../../backend/contracts/service-api.md)을 최신 정책에 맞춰 확인한 다음 로컬 어댑터를 교체한다. 특히 첫 메시지 신청, 상태 버전·중복 요청·실시간 권한, 확정 요청 6시간, 변경 제안 장소 정보, 실제 완료와 후기 공개, 취소 순서·이의 검토·운영 제재, 차단 관계·네이버 재가입 승계, 신고 자료·계정 삭제를 서버에서 최종 검증해야 한다. 현재 예시 제재 상태 전환은 운영 판정을 자동화하지 않는다. 기존 RPC를 최신 정책 지원으로 가정하거나 SQL을 자동 적용하지 않는다.

공개 개인정보처리방침 주소는 `.env.example`의 `EXPO_PUBLIC_PRIVACY_URL`에 게시 후 설정한다. 게시 전 화면은 준비 중임을 표시하고 정책의 고객지원 메일을 안내한다. `EXPO_PUBLIC_*`에는 비밀키를 넣지 않는다. URL 설정만으로 네이버·서비스 API가 실연결되지 않는다.

## 확인 결과 · 2026-10-05

타입 검사·린트 통과, 정책 경계 테스트 14개 통과, Expo 검사 21개 통과. 웹·iOS·Android 코드 묶음 생성 통과. 브라우저 검사 57개 통과(화면 캡처 25개). 23개 화면, 개인정보 가드·목적 화면 복귀·필수 사진·가입 완료 팝업, 첫 전송 실패·재전송, 최종 동의, 후기·분쟁·운영 숨김, AI 횟수·화면 이탈·로그아웃, 초안 저장·검색어 10개 상한·로그아웃 삭제, 한쪽 후기 7일 공개·6시간 만료·예상 종료+24시간 자동 완료, 작은 화면·데스크톱 프레임을 검사했다. 실제 네이버 로그인·서버·DB·AI·기기·운영 검증과 성호의 UT/QA는 남아 있다.

의존성 검사에는 SDK 57 계열 및 하위 패키지 관련 29건(높음 19·중간 10)이 남아 있다. 일반 `npm audit fix`를 적용했으나 모두 해소되지 않았다. `--force`가 Expo의 과거 버전이나 다른 메이저 버전으로 바꾸는 제안은 적용하지 않았다. 이 결과를 출시용 안전성 통과로 처리하지 않으며, 실제 연결·출시 전에 호환되는 공식 패치를 확인해야 한다.

공유 브랜치는 `jonghyun/stitch-prototype`이다. 사용자 요청에 따라 프론트 코드·테스트·참고 시안·화면 캡처와 [민규 인수인계](../../유미당_출시결정_보류사항_민규전달_20261005.md)를 함께 커밋·푸시한다. 최초 출시 결정 전달 문서는 `minkyu/foundation-harness`에 `8807803`으로 공유했다.
