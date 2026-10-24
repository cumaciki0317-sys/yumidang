# Android 후속 준비 — 2026-10-25

사용자 지시: 행사 실제 연동의 서버 대기를 관련 Notion WBS에 남기고 다음 잔여 작업을 진행한다. 종현 별도 clone/브랜치 `jonghyun/android-prep-20261025`에서 진행했다. 행사 앱 변경은 이전 미커밋 사본을 소유권 검사 후 가져왔으며 main 병합·커밋·푸시를 하지 않았다.

## 행사 인계 처리

WBS 2.8·3.8·3.3·3.4 본문에 Railway 자동 완료 runner Online, Supabase 해당 프로젝트의 service-api 미배포, 다른 배포 환경 미확인, 민규 선행·재개 조건과 사용자 보류 지시를 기록했다. 네 페이지를 다시 열어 각 기록이 정확히 한 번 저장됐음을 확인했다. 상태·담당·일정·진행률은 변경하지 않았다. [재조회 증거](evidence/blocked-wbs.json).

## 다음 범위와 작업 순서

네이티브 인증(3.1·3.2a)은 기존 native-handoff의 8종 계약·환경 인계가 필요해 임의 어댑터나 영속 토큰 저장을 만들지 않는다. 독립 가능한 7.15 설정 검사 → 격리 preview 사본 생성 → 공식 prebuild → 실제 APK 컴파일·검사, 7.7 최신 보안 근거 확보를 수행한다. 하네스의 독립 clone과 파일 단독 소유권을 적용했다.

표시용 `build:native` 명령은 JS 번들 export이며 APK 생성이 아님을 확인했다. 과거 10/06 검증 APK 기록을 재사용한 결과로 표시하지 않고 최신 코드로 새 빌드를 실행했다.

## 구현과 검증 결과

|작업|결과|근거|
|콜백 설정 검사 수정|queries 목록의 scheme만으로 PASS하던 결함 수정. enabled/exported activity 또는 유효한 alias의 같은 VIEW·DEFAULT·BROWSABLE filter를 확인|`verify-android-settings.mjs`, 회귀 14/14|
|격리 준비 스크립트|소스·asset 해시 대조, 기존 검증 ID/scheme 적용, .env/운영 서명 미복사, 원본 설정 불변|`prepare-android-validation.mjs`, preparation.json|
|프로젝트 생성|설치된 Expo57 템플릿으로 Android prebuild, 생성 manifest/gradle 검사 PASS|prebuild.log, generated-review.json|
|실제 APK|로컬 오프라인 Gradle assembleRelease 성공, 571작업·2분28초|build.log, artifact.json|
|APK 내용|최종 manifest 검사 PASS, arm64-v8a native libraries·JS 번들 내장, APK 서명 검증 통과|final-apk-review.json, badging.txt, signing.txt|
|기본 검증|TypeScript·Expo lint·diff 공백 검사 PASS|로컬 실행 결과|

APK는 **예시 데이터 모드의 내부 검증 파일**이다. 패키지 `dev.yumidang.validation`, scheme `yumidang-validation`, versionCode 1/versionName 1.0.0, minSdk24/targetSdk36. 크기 44,653,357바이트, SHA-256 `1bd4d20faf45aeffb5c0f6089b7bb0927ad3c6674a8cdd75a1e166103b95478a`. 인증서는 Android Debug이며 운영 업로드 키가 아니다.

파일 경로는 [artifact.json](evidence/artifact.json)에 기록했다. 설치·실기기·실제 네이버·회원 API·스토어·EAS 업로드는 실행하지 않았다. 생성 manifest 정적 검사는 URI host/path·실제 앱 복귀 성공이나 출시 적합성을 증명하지 않는다. 최종 manifest에 카메라/마이크 권한은 없고, INTERNET·VIBRATE·SYSTEM_ALERT_WINDOW·API32 이하 외부 저장소 권한 등이 있어 출시 전 최소 권한 검토는 남는다. `expo-system-ui` 미설치로 native userInterfaceStyle 적용 경고가 발생했으며 현재 증거를 시스템 테마 검증 완료로 표시하지 않는다.

## 의존성 보안 결과와 다음 조치

현재 lockfile을 npm 공개 권고와 대조한 결과 **영향 패키지 11개(high5/moderate6)**다. 이는 고유 advisory 11개가 아니라 직접 advisory 4개와 전이 영향이다. 자동 fix·패키지/lockfile 변경은 하지 않았다.

|직접 advisory|현재 경로|판단|
|[decode-uri-component](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)|0.2.2 ← query-string7.1.3 ← Expo Router57.0.28|실제 빌드 sourcemap에 두 모듈 포함 확인. URL 파싱 경로의 CPU 소진 위험 대응 우선. 공격 입력 실행은 안 함|
|[node-forge](https://github.com/advisories/GHSA-86w9-cpqp-85rv)|1.4.0 ← Expo CLI/code-signing-certificates|확인 경로는 개발·서명 도구. 공식 권고 수정 버전 없음|
|[Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)|3.25.76 ← Expo CLI·eslint-plugin-react-hooks|확인 경로는 개발 도구. 수정4.6.6은 현재 요구 범위 밖|
|[uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq)|7.0.3 ← xcode3.0.1 ← config-plugins|iOS 생성 도구. 확인된 호출은 v4로 권고의 v3/v5/v6+외부 buffer 조건과 다름|

npm의 expo44 하향/router58 상향 자동 제안은 SDK57 호환 수정으로 채택하지 않는다. decode 수정판0.5.0은 ESM이고 현 query-string은 CommonJS require 결과를 함수로 호출하므로 단순 override도 안전한 수정으로 단정하지 않는다. 다음 순서는 SDK57 호환 공식 backport 확인 → 없으면 CJS 호환 패치 또는 Router 파싱 전 입력 제한 설계 → 정상/잘못된 URL·앱 복귀 회귀 → APK 재생성이다. 화면 내부 입력 제한은 Router 파싱 이후라 충분하지 않다. **7.7 보안 완료·출시 가능으로 표시하지 않는다.**

## 재현과 남은 결정

1. `node --test tests/mobile/android-settings.test.mjs`
2. `node apps/mobile/scripts/prepare-android-validation.mjs > /private/tmp/android-preparation.json`
3. 결과의 app 디렉터리에서 prebuild 명령 배열을 실행한다. 예시 모드·EXPO_NO_DOTENV=1을 명시한다. 생성 native 폴더를 손으로 수정하지 않는다.
4. 기존 JDK21/Android SDK로 `./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a --offline --console=plain`. 원본 프로젝트나 운영 서명 파일을 사용하지 않는다.
5. 생성 manifest와 최종 APK manifest를 `verify-android-settings.mjs --mode validation`으로 각각 확인하고 APK SHA·서명·내장 번들을 대조한다.

운영 package ID/기존 Play 등록·서명 관리 주체는 아직 입력이 없다. 재시작 후 로그인 유지 정책과 native 교환·세션 수명은 기존 인계 사항이며 이번 예시 APK로 대신 확정하지 않는다. 기존 운영 식별자·서명이 있으면 재사용 여부를 먼저 대조한다.

절차 근거: [Expo57 문서](https://docs.expo.dev/versions/v57.0.0/), [로컬 빌드 안내](https://docs.expo.dev/guides/local-app-development/), 설치된 CLI `prebuild --help`. 앱의 AGENTS 지침대로 SDK 버전 문서와 실제 설치 도구를 확인했다.

## 후속 업데이트 — Router 패치 및 WBS 의존 표시

위 초기 빌드 결과 이후 공식 디코더0.5.1 연결과 새 APK 검증을 완료했다. 최신 근거는 [보안 보완 결과](router-security-design.md)와 evidence/router-security-artifact.json이다. 초기 APK와 최신 APK를 구분한다.

사용자 후속 요청으로 WBS18개 상태를 민규 필요로 변경했다. 위 초기 인계의 속성 미변경은 당시 범위다. 변경 명세는 evidence/wbs-minkyu-needed-20261025.json. 새 상태 진행률0%는 기존 수식의 결과이며 실제 작업 초기화가 아니다.

현재 연결된 Android 기기0개. 기존 CarePlus_API35 AVD는 사용하지 않았다. [모아서 확인할 선택](questions.md)에 진행률 표시·설치 검증 대상·운영 앱 등록 여부를 정리했다.
