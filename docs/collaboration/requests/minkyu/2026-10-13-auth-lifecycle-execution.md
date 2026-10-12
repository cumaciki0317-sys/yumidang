# 실제 Auth 수명주기 실행 경로와 남은 조건

전체 **79%(22/28)**, 실제 Auth 수명주기 **NOT_RUN**이다. 오프라인 70개 회귀와 cached Deno 검사는 실제 로그인·DB 연결을 대신하지 않는다.

## 구현된 실행 경계

기존 `isolated_ai_contracts.py`의 `ReviewedSignedAuthLifecycle`과 `run_signed_auth_lifecycle`을 사용한다. CLI는 입력 검증만 하며 실행 객체를 만들지 않는다. 고정 root 코드에서 정확한 prepared root·binding/input 경로와 원 SHA·현재 source pins·4서비스 identity·별도 검토된 실제 발급 응답/영수증 SHA를 묶어야 한다. 실행 전 원 파일을 안정적인 private FD로 재읽어 hash와 JSON을 확인한다. JSON의 승인 표시만으로 변경을 실행하지 않는다.

신규 lifecycle UUID/session과 기존 baseline6은 겹치지 않는다. 원 GoTrue 응답의 토큰과 입력 토큰을 대조하고 실제 /user 성공·DB session·synthetic profile/활성 episode·scope metadata를 확인한다. 원 토큰의 자연 만료만 기다리며 새 토큰 발급·시간 이동·직접 JWT 생성으로 대체하지 않는다. 회수는 신규 현재 세션의 local logout 한 번, ban은 신규 자기 UUID 한 번이다. 응답 유실은 UNKNOWN으로 보존하고 재전송하거나 원 세션을 되살리지 않는다.

나머지 전체 행과 중복 수·권한·함수·제약·원 예산·UNKNOWN을 비교한다. 정확한 신규 회수 세션의 refresh token/MFA 행은 성공 후 0개, 미전송이면 원 행 묶음과 같아야 한다. 감사 행은 정확한 자기 소유 조건이 TRUE인 행만 제외하며 NULL/누락 필드는 보존한다.

`memberChanged`의 범위는 **AUTH_USER_BANNED_ONLY**다. 서비스 회원 탈퇴·동의 철회·실회원·운영 TLS·공급사·자연 자정·Storage 실제 바이트는 별도 미검증이다. 익명 또는 다른 Auth 문맥 입력이 없으면 그 항목은 NOT_RUN이며 부분 성공을 전체 수명주기 PASS로 올리지 않는다.

## 다음 필수 작업

기존 globally-empty/exact6 생성 API를 보존하고 별도 staged combined lifecycle producer를 같은 runner 책임 안에 구현한다. 새 빈 대상과 닫힌 제어·원 budget0·전체 baseline을 확인한 뒤 만료용 계정만 실제 생성·로그인한다. 원 UUID/session/iat/exp와 원 응답을 private 영수증에 저장하고 자연 경과를 영속 준비·재개로 이어간다. 시험창 전에 회수/ban용 계정과 필요한 baseline6을 새로 발급한다. baseline6은 남은 수명 300초 이상, 나머지는 180초 이상을 요구한다. 전체 사전 검증 후 원 만료 토큰의 잔여 60초 이내 창에서 자연 만료를 관찰한다.

early 생성 행은 정확한 발급 영수증으로만 허용하고 임의 기존 행·가짜 빈 상태·원 토큰 갱신을 허용하지 않는다. 기존 A3의 익명 비활성·signup 비활성 설정은 그대로다. 익명까지 검증할 새 대상은 처음 생성할 설정부터 따로 검토해야 하며, 기존 서비스 설정을 바꾸지 않는다. 다른 인증 문맥은 별도 자기 격리 대상의 실제 Auth6 발급·binding 증거가 필요하다.

실제 실행은 추가 격리 DB 3개 정상 중지 승인과 새 메모리/identity 확인 이후다. 시작 1GiB·실행 768MiB의 기준과 3초 감시를 유지한다. 원 Auth 변경은 보존하고 runner가 컨테이너를 임의 중지·재시작·삭제하지 않는다. 정리 중 연속 메모리 감시는 이번 경로가 보장하지 않으며 별도 검토된 root 정리 wrapper가 필요하다. 실제 sequence/physical/운영 복원 완료로 확대하지 않는다.

## staged producer 통합 후 현재 상태

producer를 같은 기존 runner에 구현했다. `ReviewedLifecycleProvisioning`을 고정 root 코드에서 구성하며 실제 포트는 `ports=None`이다. 초기 `stage_lifecycle_accounts`는 빈 Auth·profile·예산과 닫힌 제어·전체 행/권한/제약/스키마 및 실제 native119 이력을 확인한 뒤 만료용 계정을 한 번 생성·로그인한다. `resume_lifecycle_accounts`는 root가 고정한 stage 원 SHA를 확인해 새 프로세스에서 늦게 회수/ban용 계정과 baseline6을 발급한다. `bind_lifecycle_accounts`는 GET-only로 만료창을 확인하고 기존 lifecycle API가 요구하는 정확한 `auth-lifecycle-input-<scope>.json`을 만든다. 원 만료 토큰은 갱신하지 않으며 시간이 지나 창을 놓치면 실패한다.

실제 GoTrue v2.196.0 [admin 생성](https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/api/admin.go)·[이메일 확인](https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/models/user.go) 계약을 확인해 metadata의 `email_verified:true`와 삭제 audit의 `user_email`을 맞췄다. 느린 검증 중 observer 실패는 POST 직전에 다시 확인하고, 비정상 응답·원 응답 검증/저장 실패는 UNKNOWN으로 보존한다. 실패 정리는 검토된 failure 원 SHA와 정확한 자기 UUID/email/metadata만 대상으로 하며 재전송이나 원 세션 복구를 하지 않는다. 이전 잘못된 후보와 검토 기록은 비공개로 보존한다.

root 통합 Auth 오프라인 **98개 PASS**, 동의 core 모형 **18개 PASS**, 비공개 외부 정리 어댑터 모형 **32개 PASS**다. 세 결과는 실제 서버 실행 증거가 아니다. 기본 CLI 동의 경로는 JSON의 승인값과 무관하게 NOT_RUN이며, 공개 동의 철회 전 정상 ready-AI 대조군과 실제 original JWT/서비스 RPC/예산 보존 증거를 요구하는 core만 준비했다. 그 core의 typed root caller와 runtime 소스 캡처는 미구현이다. 모듈 의존성을 분석할 때 evaluate0인 사실은 runtime import까지 캡처됐다는 뜻이 아니다.

비공개 root 정리 어댑터는 전용 자식 종료 확인 후 새 4개 컨테이너만 STOP30을 각각 한 번 시도하는 계약이다. STOP 후 같은 GET과 최종 inventory에서 전체 설정 hash·소유 ID·stopped/ExitCode0/OOMfalse를 확인하도록 보강했다. 실제 launch ABI는 None으로 닫혀 있고 producer 연결은 아직 하지 않았다. source HEAD/57개 hash도 최종 통합 버전에서 다시 고정해야 한다. 전체 **79%(22/28)**와 실회원 HOLD·키 전달 승인 대기·Storage39 원 바이트 미확보·운영 적용 미검증을 유지한다.
