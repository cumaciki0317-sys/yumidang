# 종현 모바일 회원 연결 구현 결과

2026-10-05, 작업자 `jonghyun`. 기준은 `minkyu/handoff-20261005`의 `9dfca36`, 작업 브랜치는 `jonghyun/queue-integration`이며 별도 작업 폴더에서 진행했다. 하네스의 모바일 SDK·인증 구역과 모바일 화면 구역을 나누어 각 파일을 한 에이전트만 수정했다. 편집 전 소유권 검사를 통과했다. 민규·성호 파일과 SQL·공통 환경 설정·운영 서비스를 변경하지 않았다.

## 구현

- `member-service.ts`는 회원 JWT를 사용하는 기존 service-api 경로에 연결한다. 본인 프로필·성향/소개·대표사진, 대화/신청/동의, 공고 작성/수정/종료/삭제/재개, 약속/일정·장소 변경/취소/완료/후기, 알림/차단/신고/제재/AI 철회 메서드를 제공한다. 없는 경로를 추가하거나 공통 DB를 직접 호출하지 않는다.
- 원격 DTO는 실제 SQL의 객체와 한 행 배열, snake_case와 camelCase를 구분한다. 첫 메시지와 변경·취소의 재전송 ID를 보존하고, 최종 동의의 조건 버전과 마이크로초 시각을 그대로 전달한다. 조건 누락·유료 값·비공개 상대 후기·다른 요청 ID를 성공으로 받지 않는다. 취소 이력의 알 수 없는 일정과 권한 회수된 새 장소의 null을 보존한다.
- `web-member-session.ts`는 기존 네이버 웹 계약을 구현한다. 서버 시작 요청, 브라우저 탭의 verifier와 state, 등록된 HTTPS 콜백, 일회용 교환, 가입 상태·완료, Supabase 세션 갱신·현재 세션 로그아웃을 연결한다. Origin을 위조하지 않으며 서버 세션·자격을 클라이언트가 생성하지 않는다. 토큰은 메모리에만 두고 URL이나 브라우저 저장소에 넣지 않는다. 새 페이지 로드에서 저장된 토큰 복원을 지원한다고 주장하지 않는다.
- 네이버 화면은 서비스 모드에서 실제 인증 어댑터가 준비된 경우만 작동하며 미준비를 성공으로 표시하지 않는다. 사진/선택 성향 이후 명시적인 가입 완료 성공과 `ready` 상태를 확인해야 홈 또는 목적 화면으로 이동한다. `auth-callback`은 웹 콜백을 처리한다.
- `avatar-service.ts`는 Expo57의 실제 JPEG 재인코딩을 사용한다. 원본은 사용자가 확정한 **10,000,000 bytes**, 저장본은 기존 서버 계약의 **2,097,152 bytes**다. 허용된 기기 URI만 입력하고, 재인코딩 결과에 iOS가 붙이는 APP1(EXIF/XMP)·APP13(IPTC)·주석을 구조 검사 후 제거한다. 화소·색상·스캔·restart 구간은 보존하고 불완전한 JPEG는 거절한다. 원본을 메타데이터 필터에 바로 넣지 않으며 압축 재시도에서 작은 사진을 확대하지 않는다.
- 실제 Android 실행에서 Hermes에 `AbortSignal.throwIfAborted`가 없어 사진 인코더가 실패함을 발견했다. `api.ts`의 기본 `aborted` 검사와 AbortController·부모 이벤트·기한 정리 함수를 SDK·사진·웹 인증에 공유해 해결했다. 직접 `throwIfAborted`와 `AbortSignal.any` 호출은 제거했으며 전역 기능을 바꾸지 않는다. 취소 후 늦게 온 응답은 계속 거절한다.
- 대표사진 Storage 어댑터는 private `profile-images`에 사용자 JWT로 새 경로를 생성하고 덮어쓰지 않는다. 교체는 업로드→포인터 변경→이전 사진 정리 순서다. 응답 소실·409 재시도는 인증된 동일 경로의 실제 바이트가 같을 때만 업로드 복구로 인정한다. 포인터 변경 결과가 불확실하고 현재 조회가 이전 사진이면 새 파일을 삭제하지 않고 `PHOTO_SWAP_UNCERTAIN`을 남긴다. 이전 사진 정리 실패는 새 대표사진 성공과 구분한다.
- 일반 신고 캡처는 기존 예약→private `report-evidence` 업로드→확인 계약을 구현한다. 같은 자산 ID와 실제 바이트를 사용하며 온라인 신고의 캡처 필수 조건을 유지한다. 취소한 자산과 경로가 일치하고 서버가 삭제 필요를 반환한 경우만 삭제한다. 접수된 증거의 삭제 권한을 확대하지 않는다.
- `remote.tsx`는 검증 세션·사진·신고 어댑터를 설치하는 포트를 제공한다. `installWebMemberConnection`은 검토된 signup URL·Supabase URL·공개 키로 구체적인 웹 인증/Storage 어댑터를 조립한다. 서비스 역할 키·비밀 키는 거절한다. 인증 포트 교체·로그아웃·갱신 실패 때 이전 세션 정보와 화면 요청 세대를 무효화한다. 늦은 이전 갱신은 새 회원의 세션을 지우지 않는다.
- 예시 모드는 보존했다. 서비스 공고 초안은 현재 세션 세대에 묶인 기기 메모리 상태이며 서버 저장이나 게시 성공이 아니다. 실제 변경은 회원 API 응답을 확인한 뒤에만 화면에 반영한다. 화면 연결 결과는 하네스의 모바일 화면 구역과 함께 검증한다.

## 검증

| 범위 | 결과 |
| --- | --- |
| 새 회원 SDK·세션·사진·웹 인증 단위/합성 검사 | 4파일 **33/33 PASS** |
| 기존 서비스 SDK와 native 취소·메타데이터 회귀를 포함한 재검사 | 5파일 **61/61 PASS**; 위33개 포함, 중복 합산하지 않음 |
| TypeScript 검사 | 현재 전체 앱 **PASS** |
| SDK·인증 파일 린트 | 오류0·경고0 |
| 전체 앱 린트 | 모바일 화면 수정 후 **PASS**, 오류0·경고0 |
| 웹 회원 화면과 실제 SDK 연결 | 루트 조정자의 임시 화면에서 브라우저15개 검사·합성 HTTP20회 PASS; 실패 시 초안 유지·동일 UUID와 본문 재전송·무료/상세 장소 분리를 포함하며 실제 서버 실행과 구분 |
| 실제 Expo 웹 JPEG 인코딩 | 루트 조정자가 별도 임시 화면에서 PNG64×48→JPEG780 bytes·APP1 없음·브라우저 이미지 디코딩64×48 PASS를 보고함; 최종 증거는 루트 검증 기록에 연결 |
| Android 에뮬레이터 실제 예시 화면 | CarePlus_API35·Expo Go57.0.9에서 독립 **9/9 PASS**; 홈/익명 공개 조건/사진 필수/안전 영역/Go 재실행 후 프로젝트 다시 열기 검사 |
| 실제 Android JPEG 인코딩·디코딩 | 고정 합성 PNG149bytes·64×48→기존 `encodePhoto` JPEG780bytes·MIME확인·APP1없음→실제 Expo native 디코더64×48 **PASS** |
| 실제 Android data URI 사진 표시 | 제품과 같은 React Native Image·지정 크기에서 onLoad **PASS**, 합성 빨간 이미지 표시 스크린샷 확인 |
| 실제 Hermes 회원 SDK 실행 | URL·TextEncoder 존재, 성향 POST·응답 디코딩·늦은 취소 응답 거절 **PASS**; 메모리 합성 fetch이며 원격 API0회 |
| iPhone 실기기 코덱·사진 표시 | 루트 조정자 직접 실행 및 캡처 확인: iOS26.6.2·PNG149bytes64×48→JPEG701bytes·APP1/APP13없음·재디코드64×48·Image data URI 표시 **PASS** |
| iPhone 실기기 회원 SDK | 루트 조정자 직접 실행: TextEncoder/URL·성향 POST/디코딩·늦은 취소 거절 **PASS**; 메모리 합성 fetch1회, 원격 API0회 |
| Android 독립 설치 APK | 2026-10-06 CarePlus_API35에 별도 내부 release APK 설치 후 **11/11 PASS**; 네트워크 없음·직접 콜드 실행2회·익명 조건·사진 필수·선택기 열기/취소·현재 프로세스 치명 오류 검사 |
| 실제 네이버·회원 Auth/DB·Storage | **NOT_RUN** |
| 원격 배포·스토어·실제 회원 원문 외부 전송 | **NOT_RUN** |

검사 명령은 아래와 같다. 테스트의 HTTP·Storage·네이버 응답은 합성이다. JPEG 마커 시험 자료의 통과를 실제 기기 인코더 성공으로 확대하지 않는다.

```sh
node --experimental-strip-types --test \
  tests/functions/jonghyun/mobile-service.test.ts \
  tests/functions/jonghyun/mobile-member-service.test.ts \
  tests/functions/jonghyun/mobile-session.test.ts \
  tests/functions/jonghyun/mobile-avatar-service.test.ts \
  tests/functions/jonghyun/mobile-web-session.test.ts
# apps/mobile에서 실행
npm run typecheck
npm run lint
```

`npm ci`와 SDK 호환 `expo install expo-image-manipulator`를 실행했다. 최초 제한 환경의 패키지 DNS 실패는 실행기에서 승인된 동일 패키지 설치로 해결했다. 기존 의존성 보안 항목29건(높음19·중간10)은 유지하며 강제 메이저 변경으로 지우지 않았다. Node의 기존 모듈 형식 경고는 기능 실패와 구분한다.

## 민규 연결과 실제 실행의 남은 조건

Android에서는 상태표시줄과 미리보기 배너가 겹치는 실제 결함을 확인해 `_layout.tsx`의 배너에 위쪽 안전 영역만 적용했다. 수정 후 시스템 상태표시줄은0~74px, 배너 글자는154~194px로 분리됨을 XML·스크린샷으로 확인했다. 전체 TypeScript와 해당 파일 린트가 통과했다. `android-runtime-validation.mjs`의 실제 증거는 `/private/tmp/yumidang-android-runtime/`에 있다. 기존 AVD와 사용자 앱은 초기화하거나 삭제하지 않았다.

실제 사진 코덱·Hermes 검사는 제품 소스 밖의 임시 스냅샷에서 실행했다. 코덱 증거는 `/private/tmp/yumidang-android-codec-display.xml`·`.png`, 메모리 fetch 증거는 `/private/tmp/yumidang-android-api-result.xml`·`.png`다. 준비 중 localhost 주소·공유 node_modules 지연분할 경로·시험용 base64 펼치기·Image.getSize(data URI) 오류는 제품 인코더 실패와 구분했다. ExpoRoot에서 mount 이전 state 변경 경고도 임시 route 진입 때 관찰했다. 최종 검사는 분할을 끈 임시 번들과 고정 합성149byte data URI로 완료했으며 원격 Storage 성공을 주장하지 않는다.

iPhone 임시 프로젝트의 ExpoAsset 초기화 실패는 공유 node_modules 링크를 실제 복사본으로 바꾸고 캐시를 비운 뒤 재진입해 해결됐다. 이후 실제 iOS 인코더가 작은 합성 사진에도 APP1/APP13을 붙여 `INVALID_PHOTO`가 발생한 원인을 마커로 확인했다. 개인정보 검사를 완화하지 않고 재인코딩 뒤 메타데이터 제거를 추가해 해결했다. 최종 iPhone 증거는 `/private/tmp/yumidang-iphone-codec-fixed.png`·`yumidang-iphone-sdk-result.png`, 최신 수정 후 Android 재검사 증거는 `/private/tmp/yumidang-android-codec-final.xml`·`.png`다. Android35는 JPEG780bytes·64×48·메타데이터 없음·data URI 표시를 다시 통과했다. 검증 후 사용자의 iPhone은 원본8081 예시 홈으로 돌아갔으며 임시8083 서버는 종료한다.

사진 선택기 조사 중 재진입 시 그리드 위치가 달라져 고정 좌표가 기존 이미지 한 개를 잘못 선택한 것으로 판단한다. 외부 전송·서버 저장·원문 증거 저장은0회이고 해당 사진은 화면에 표시되지 않았다. ImagePicker/재인코딩의 기기 임시 캐시는 생겼을 수 있으므로 로컬 저장 자체가 없었다고 단정하지 않는다. 이후에는 이름·크기 검사를 추가해 다른 자료를 변환 전에 거절했고, 최종 검사는 고정 합성 data URI만 사용해 기존 자료를 다시 읽지 않았다. 기존 자료나 앱 데이터를 일괄 삭제하지 않았다.

앞선 Expo Go 검사는 종료→런처 시작→로컬 프로젝트 열기 경로로 두 번 실행했다. Expo Go 종료 직후 프로젝트 URL만 열면 Android 홈으로 돌아가는 실패가 재현되어 별도로 남긴다. 또한 Expo Go57.0.9의 TaskManager에서 `NoSuchMethodException: ExpoHeadlessAppLoader.<init>[]`가 관찰됐다. 실제 호출은 `getDeclaredConstructor`→`AppLoaderProvider`→`TaskService`의 생성/일시정지/복귀 경로이며 해당 provider는 예외를 잡아 null을 반환한다. 아래 독립 APK의 전경 실행 통과가 이 Go 배경 실행 오류를 해결했다는 뜻은 아니다. iOS 실기기는 공식 SDK57 조건상 Expo Go와 CLI에 동일 Expo 계정 로그인이 필요하며 사용자가 직접 진행한다.

### Android 내부 설치 APK 실제 검증 — 2026-10-06

사용자가 승인한 내부 APK 검증을 위해 현재 제품 소스52파일을 `/private/tmp/yumidang-installed-apk-s4kchpx7/`에 정확히 복사하고 원본·복사본의 SHA-256 일치를 확인했다. `.env`와 임시 native 시험 화면은 포함하지 않았다. 제품의 공통 설정은 수정하지 않고 임시 복사본만 이름 `유미당 내부 검증`, 패키지 `dev.yumidang.validation`, scheme `yumidang-validation`로 분리했다. 생산 패키지명·서명·스토어 배포 결정은 하지 않았다.

공식 Expo prebuild와 로컬 `:app:assembleRelease -PreactNativeArchitectures=arm64-v8a`를 실행했다. 첫 실행의 Android Studio JDK25는 prefab CLI2.1의 JNA native-access 경고 때문에 CMake 구성에 실패했다. 같은 CMake 작업으로 재현한 뒤 이미 설치된 Homebrew JDK21.0.12.1로 바꿔 빌드가 통과했다. 공식 SDK의 NDK27.1.12297006·CMake3.22.1을 추가 설치했고 기존 SDK·앱·AVD 데이터는 삭제하지 않았다. 최종 Gradle9.3.1 빌드는2분17초·571작업으로 성공했으며 로그는 `/private/tmp/yumidang-apk-build.log`다. 클라우드 프로젝트 생성·EAS 업로드·유료 빌드는 실행하지 않았다.

최종 APK는44,401,209bytes이며 `assets/index.android.bundle` 3,047,632bytes를 포함한다. SHA-256은 `1a303e35ea2b4919758b40640a91197f6fd8c73430d4fa26531cdce4e38e8033`다. APK는 arm64·version1.0.0·minSdk24·targetSdk36이며 임시 Android debug 키로 서명된 내부 검증본이다. `DEBUGGABLE` 플래그가 없는 release 앱으로 설치됐다. CAMERA·RECORD_AUDIO·READ_MEDIA_IMAGES 권한은 없고 기존 외부 저장소 권한은 API32 이하로 제한된다. 기본 Expo 생성 manifest의 SYSTEM_ALERT_WINDOW 선언은 유지하며 스토어 제출용 최소 권한 검토는 별도다.

기존 CarePlus_API35 에뮬레이터에 새 패키지로 설치한 뒤 AVD의 WiFi/모바일 데이터 초기값1/1을 기록하고 일시 껐다. `Active default network: none` 상태에서 `MainActivity` 직접 콜드 실행2회가 실제 `LaunchState: COLD`로 확인됐고 예시 홈이 표시됐다. 비로그인 공고의 이름·상세 지점 비노출, 사진 없이 가입 완료 차단, 실제 Android 시스템 사진 선택기 열기·선택 없이 취소·가입 화면 복귀, 현재 앱 PID의 JS/native 치명 오류 검사까지 **11/11 PASS**다. 선택기 그리드의 개인사진 스크린샷은 저장하지 않았으며 사진 선택·원문 읽기·실제 회원 API 호출은 하지 않았다. 사진 재인코딩의 실제 기기 근거는 앞선 고정 합성 PNG 코덱 검사와 구분한다.

검사 종료 후 WiFi/데이터1/1 복구, 기존 사용자 앱·Expo Go 설치 유지, 원본8081의 `packager-status:running`을 다시 확인했다. 결과·스크린샷·APK 정보는 `/private/tmp/yumidang-installed-apk-evidence/`의 `result.json`, `offline-cold-1.png`, `offline-cold-2.png`, `artifact.json`에 있다. 실행기는 `/private/tmp/yumidang-installed-apk-validation.mjs`다. Android 실물 기기·실제 회원 서버·스토어 설치·운영 배포는 **NOT_RUN**이며 iPhone에서 자체 설치한 iOS 바이너리 검증은 Apple 계정 준비 이후 과제다. 아래 민규 연결·공급사·배포·실제 사용자 검증 조건은 여전히 남는다.

1. **native 네이버 계약:** 현재 signup 서버는 네이버 시작/교환에 허용된 웹 Origin을 필수로 요구하고 DB와 바인딩한다. native scheme 설정만으로 이 조건이 해결되지 않는다. HTTPS 웹 콜백에서 native 앱으로 안전하게 돌아오는 계약·네이버 앱 등록·복귀/취소/중복/만료 기준을 민규와 연결한 뒤 해당 인증 포트를 설치한다. 임의 Origin·토큰 포함 URL·가상의 native callback 경로를 사용하지 않는다.
2. **탈퇴 HTTP 계약:** `retire_my_account`와 공통 삭제 서비스는 존재하지만 현재 회원 service-api에 해당 탈퇴 경로가 없다. 원격 탈퇴 포트는 미설치로 닫고 명시적인 공통 경로/응답을 받은 뒤 연결한다. 요청 접수의 `processing`을 외부 삭제 `completed`로 표시하지 않는다.
3. **공고 소유권·본인 목록·대화 읽음:** 공개 상세의 privateDetails는 공고 작성자 여부를 증명하지 않는다. 본인 공고 목록/명시적인 서버 소유권과 대화 읽음 경로는 현재 없으므로 임의 endpoint·버튼 권한을 만들지 않는다. 기존 수정 SDK는 서버 권한 검사를 유지한다.
4. **추가 공개 조회:** 프로필 요약·행사 상세·공식 순위·행사 연결 공고·작성자 프로필 ID의 실제 공통 route/DTO를 연결한다. 모바일에 제안 조회가 있다는 이유로 서버 지원 완료를 주장하지 않는다.
5. **실제 환경:** 검토된 공개 URL·공개 키와 네이버 앱 등록 값을 신뢰할 초기화 코드에 연결한다. 실제 Auth/DB/Storage와 신고/사진 권한·철회/분쟁/동시 저장/응답 소실/기기 복귀를 검사한다. 서버 배포·권한 활성화·실제 공급사 호출은 자동으로 수행하지 않는다.

공식 구현 근거: [Expo57 ImageManipulator](https://docs.expo.dev/versions/v57.0.0/sdk/imagemanipulator/), [Expo57 AuthSession](https://docs.expo.dev/versions/v57.0.0/sdk/auth-session/), [Expo57 WebBrowser](https://docs.expo.dev/versions/v57.0.0/sdk/webbrowser/), [Supabase Auth 공식 OpenAPI](https://github.com/supabase/auth/blob/master/openapi.yaml), [Supabase private Storage 다운로드](https://supabase.com/docs/reference/javascript/storage-from-download). SecureStore 문서는 조회 오류였으며 확인 완료로 처리하거나 native 세션 보관 구현에 사용하지 않았다.
