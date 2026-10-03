# 실제 네이버 로컬 검증 준비

사용자는 실제 Client ID/Secret을 최상위 로컬 .env에 입력하고, 프론트가 없으므로 로컬 로그인 검증부터 진행하도록 승인했다. 작업자는 minkyu, 전용 worktree·브랜치와 기존 변경을 보존한다. [하네스](../../minkyu-naver-live-harness.json)에서 새 테스트 서버·검사·현황/인계만 편집한다. backend 인증·SQL 구현은 재사용하며 운영 .env·원격 DB·서비스 프론트·외부 AI·커밋/푸시는 변경하지 않는다.

## 진행률과 현재 상태

[전체 현황](../../minkyu.md)의 14개 완료 체크리스트 기준36%(5/14). 이번 작업은9번에 해당하며 실제 OAuth·브라우저 세션·사진 업로드의 검증 범위를 별도 기록한다. 네이버 자격상 남성 또는 만19세 미만 계정은 ineligible가 정상 결과이며, 이 결과로 전체 신규 가입/사진 검증까지 완료로 올리지 않는다.

Client ID/Secret의 비어 있지 않음·주변 공백/제어문자 부재, 콜백 HTTPS/정규 URL 형식 확인 PASS. 실제 네이버 키 유효성은 아직 NOT_RUN. 현재 입력 콜백은 Supabase `/auth/v1/callback`이며 기존 커스텀 네이버 흐름은 프론트 code/state → signup callback POST 구조다. 공통 Supabase URL/키·Origin/body limit과 NAVER_STATE_TTL_SECONDS는 로컬 입력에 없다. 원본 값을 자동 채우거나 이전 정책의 인증 흐름으로 바꾸지 않는다.

## 준비할 로컬 환경

- 프론트 검증 Origin: `http://127.0.0.1:5173`
- 앱에 추가할 검증 Callback URL: `http://127.0.0.1:5173/naver/callback`
- 격리한 API: `http://127.0.0.1:56221`, project `yumidang-minkyu-naver-live`
- 기존 정식28개+선정 pending7개를 격리 DB에 재생한다. 기존 로컬 볼륨은 건드리지 않는다.
- 원본 .env에서 실제 키만 안전하게 읽어 권한0600 임시 설정에 주입한다. 로컬 TTL600초·본문8192bytes는 테스트값이며 운영 기본값·정책 확정이 아니다.
- OAuth code/state의 URL 쿼리를 즉시 제거하고 verifier는 sessionStorage에서 일회 삭제한다. 실제 토큰·사용자 원문은 로그·진단·화면에 출력하지 않고 브라우저 세션은 현재 메모리에만 유지한다.
- 네이버 로그인/필수 항목 동의가 필요한 때 실제 브라우저에서 확인한다. 개발자 앱의 검증 콜백 등록 여부를 먼저 맞추고, 실제 검증 결과를 가상 결과로 대체하지 않는다.

## 검증 결과

- 신규 Node 가상/브라우저 VM 검사18개, 의미 있는 기존 가입 검사2개와 Deno PASS. 설정0600/부모0700·symlink/hardlink·원문 숨김, Host/Origin/메서드/body/외부 전송 제한, 취소/위조/정보누락/자격미충족/사진필요를 검증했다. callback query·verifier를 먼저 지운 뒤 요청하며 토큰은 현재 브라우저 메모리만 사용한다. 합성 검사를 실제 OAuth 성공으로 표시하지 않는다.
- 새 임시 루트에서35개 migration 처음 재생·전용 Auth/DB/API 기동 PASS. 과거 동일 이름의 임시 준비 폴더는 덮어쓰지 않고 새 고유 폴더를 사용했다. 정확한 project/Colima 소켓·회원0 guard 후 테스트 서버 기동 PASS. `GET /`와 허용 Origin의 `GET /diagnostics` HTTP200/no-store 확인. 운영 .env 값은 수정하지 않았다.
- 실제키와 개발자 화면의 앱 Client ID 일치 확인. 앱은 개발 중이며 개발자 로그인 완료를 확인했다. 사용자의 ‘저장하고 진행해’ 확인 후 PC 웹에 기존 Supabase 콜백을 유지하고 새 loopback 콜백을 저장했다. 새로고침 후 두 PC 콜백·기존 Mobile 콜백·서비스 URL 유지와 수정 버튼 비활성 상태를 확인했다.
- 실제 로컬 `POST /api/signup/naver/start` HTTP200 확인. 공식 authorize endpoint·로컬 redirect·code 응답 방식·state 형식을 검사했으며 URL/state 원문은 출력하지 않았다. 이는 로컬 시작 단계 검증이며 실제 네이버 로그인 완료가 아니다. 이후 서버 재확인에서 페이지·진단 HTTP200/no-store, starts1/callbacks0/stateChecks0을 확인했다.
- 실제 네이버 OAuth·브라우저 Auth 세션 검증 PASS. 사용자가 로그인 시작 실행을 알린 뒤 로컬 진단 HTTP200·starts4/callbacks3/stateChecks3/rejected0, sessionIssued=true/authStateVerified=true, lastStatus=photo_required를 확인했다. 이는 네이버 응답 처리·실제 세션 발급·인증된 가입 상태 조회 성공의 근거이며 사용자 개인정보·코드·토큰 원문은 읽거나 출력하지 않았다. 현재 가입 상태는 사진 등록 필요이며 가입 완료가 아니다.
- 사진 업로드/가입 완료는 이 테스트 서버에 구현하지 않았고 NOT_RUN이며 9번 완료로 올리지 않는다. 운영 배포는 NOT_RUN이다.
- 앞선 starts2 시점에는 다른 Chrome 창이 앞으로 전환되어 검증 탭 복귀를 요청했다. 전체 접근성 트리 재조회는 무관한 사적 창 내용을 포함할 위험으로 자동 승인 검토에서 거절됐으며 우회하지 않았다. 이후 성공 확인은 허용 Origin의 안전한 서버 진단만 사용했으며 무관한 Chrome 창을 추가로 읽지 않았다.

실행 중인 로컬 서버는 `http://127.0.0.1:5173`이며 키를 받은 설정 파일은 권한0600/개인 임시 디렉터리0700이다. 콘솔·HTML·진단에 실제 키/세션/원문은 출력하지 않는다. 완료 후 서버·개인 설정·테스트 볼륨을 정리하고 초기 전용 Colima 정지 상태로 복원한다. 사용자 작업이 필요한 동안은 준비된 검증 환경을 유지하되 운영 환경으로 설명하지 않는다.

## 100% 목표의 사진 후속 작업

사용자가 ‘100%까지 진행해’ 목표를 지정했다. 전체14단계 범위는 유지하며 이번 하네스 작업 단위는 사진 업로드·명시 가입 완료를 기존 검증 서버에 연결한다. 운영·팀 결정·종현 소유 파일의 남은 요구를 이 로컬 사진 작업으로 대체하지 않는다.

기존 CLI start는 실행 중인 프로젝트에 누락된 Storage를 추가하지 않았다. 기존 Auth/DB를 중지·초기화하지 않고 공식 캐시 이미지 `public.ecr.aws/supabase/storage-api:v1.70.3`를 동일 전용 Docker 네트워크·project 라벨·전용 Storage 볼륨으로 추가했다. 외부 호스트 포트는 열지 않았고 기존 Kong 경로를 사용한다. 환경은 실행 중인 전용 DB의 키·비밀번호와 개인 설정에서 메모리로 읽어 권한0600 임시 env 파일로 주입한 뒤 해당 파일을 즉시 제거했다. 운영 .env는 변경하지 않았다.

Storage 내부 `/status` HTTP200, Kong 경유 비공개 `profile-images` 버킷 조회 HTTP200·JPEG 전용·최대2097152bytes를 확인했다. 이미지나 인증 원문은 조회하지 않았다. 환경 변수명은 [고정 버전 공식 예제](https://raw.githubusercontent.com/supabase/storage/v1.70.3/.env.sample)와 [공식 Storage 구성](https://supabase.com/docs/guides/self-hosting/storage/config)을 확인했다. 실제 이미지 업로드는 아직 NOT_RUN이며 파일 객체 메타데이터를 합성해 성공으로 대체하지 않는다.

lane A는 서버/UI, B는 실제 실패·보안 경계 검사, C는14단계 잔여 요구 감사와 현황을 맡는다. 새 정책 선택 없이 기존 사진 필수·성향 선택·명시 완료·실패 입력 보존을 재사용한다. 사용자 Bearer로만 저장하며 서비스 역할로 업로드 권한을 우회하지 않는다.

사진 후속 구현과 신규 검사31개·기존 가입 검사2개·Deno PASS. 브라우저에서 원본을 픽셀 디코딩한 후 새 JPEG로 인코딩해 EXIF/GPS 원문을 전송하지 않는다. 원본과 재인코딩 모두2MiB 제한이며 선택 사진·성향은 실패 시 유지한다. 사용자 Auth 확인으로 서버가 경로를 만들고 private Storage에 사용자 Bearer/anon apikey로 INSERT한다. 업로드만으로 완료하지 않으며 명시 완료 후 실제 가입 상태를 다시 확인한다. VM/가상 응답은 실제 사진 업로드 근거가 아니다.

검사된 서버 SHA256은 `e5d0bf10f4d8679be02befc8a4efbd9534d9e5a495feed4aa6494aff98c3a730`, 검사 파일 SHA256은 `414549ab74c8b66978b9ced1977c265bb5ffee8a2d06389569252c3623ae8c60`다. 정확한 기존 Node 소유자·프로세스·설정 경로를 확인해 해당 서버만 교체했고 Auth/DB는 보존했다. 명시 `--resume`도 정확한 전용 컨테이너/소켓/개인 설정과 실제 회원 수를 검사한다. 기본 모드의 회원0 제한은 유지한다.

새 서버 READY·HTML/JS HTTP200/no-store·사진 흐름 제공 확인, 실제 로컬의 인증 없는 사진 업로드401·가입 완료401·잘못된 Origin403 PASS. 원본 .env SHA256 보존도 확인했다. 사용자가 재로그인→JPG 선택→업로드→가입 완료를 확인할 수 있도록 네 단계 안내를 제공했다. 실제 선택 사진 업로드·명시 가입 완료 결과는 아직 NOT_RUN으로 유지한다. 기존 Storage 전체 열람 RLS나 프론트 전체 인수를 이 작업의 성공 근거로 확대하지 않는다.
