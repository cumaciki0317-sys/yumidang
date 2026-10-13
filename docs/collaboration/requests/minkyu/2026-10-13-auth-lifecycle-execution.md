# 실제 Auth 수명주기 실행 경로와 남은 조건

전체 **79%(22/28)**, 실제 Auth 수명주기 **NOT_RUN**이다. 현재 커밋 `4e28789`의 관련 source 회귀220개가 통과했다. A9 새 격리4서비스의 실제 Auth/REST DB TLSv1.3·256bit와 native119 복원 비교는 PASS다. 서명 사용자 로그인·탈퇴 복구·자연 자정은 아직 미검증이며 아래 날짜별 이전 실패/검증을 보존한다.

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


## 2026-10-13 typed dispatch와 실제 소스 캡처 연결

전체 **79%(22/28)**다. `fed9581aa69ae85d9a5dad17c6c5a2ecb551329e`에 실제 호출 연결 후보3개를 로컬 고정했다. 원 producer binding/input을 보존하고 별도 approved 복사본·단일 durable intent로 기존 lifecycle kernel을 호출한다. Node의 제품 codeRoot와 factory 경로는 검토 객체가 지정한 private source tree로 연결하며 원 REPO는 버전·native 이력 검증에 유지한다. 원 토큰·원 발급 응답·baseline6·UNKNOWN을 바꾸지 않는다. partial 영수증은 정확한 필드·정수 횟수·원 토큰 hash·세션 복구 없음과 보존 성공을 요구하며 익명/다른 문맥/서비스 탈퇴/동의/공급사/자정/물리 복원을 NOT_RUN 또는 NOT_VERIFIED로 유지한다.

source 파일400·디렉터리500 읽기와 token/state600·private 부모700 읽기를 구분해 실제 캡처 tree의 모드 불일치를 수정했다. 동의 typed caller는 committed union91개와 factory1개를 복사하고 native import를 그 tree에서 수행한다. pre/post pin 검증은 OS 불변성이나 실제 DB 검증을 뜻하지 않는다. CLI 동의는 계속 NOT_RUN이다. 실제 C 회원 발급·원 세션/동의·headroom·전체 baseline·정리는 고정 root 조립이 별도로 제공해야 하며 아직 실제 실행하지 않았다.

root 통합 시험은 처음 소스가 기존 HEAD와 달라 Auth114개 중8오류·동의 모형27개 중7실패로 거절됐다. 당시 실제 호출0이고 영수증SHA `962e0bf097d4513af69f1d627560fcd0fa5a60513f038bddd3274f558862b9df`로 보존했다. 로컬 소스 고정 후 같은 시험을 약화 없이 재실행해 Auth114·관련61 **175개 PASS**, 동의 모형27개 PASS와 cached Deno PASS를 확인했다. 초기 두 연락처형 clientRequestId 거절은 기존 사용자1A 기준에 맞는 개인정보 거절로 원인을 확인했으며 정상 입력 성공이나 운영 탐지 품질로 확대하지 않는다. 제품 privacy/handler 변경은 없다.

현재57개 source freeze는 HEAD fed9581, mapSHA `93c8d4a642acb64b30f82df6f802653367e4d26773a3e19ecc5c5a0d8fc4ed82`, 영수증SHA `2e5dba98543f4c46424b2d5c01861666f07f6033df1da279fe3e20766ba04951`다. 올바른 private700/600 경로에서 원 HEAD 바이트와 대조했으며 자원/Auth/DB 호출0이다. HEAD가 바뀌면 실행 전에 새로 고정한다. private 단일 자식 coordinator는 자연 발급/대기/재개/dispatch/정리와 연속 메모리 감시를 연결해 검토 중이다. 익명·별도 문맥·서비스 탈퇴·자연 자정·실회원 HOLD·Storage39·공급사·운영 조건은 여전히 남는다. 푸시·운영 적용은 하지 않았다.


private coordinator v4를 root에서 재실행해 **59개 모형 PASS**를 확인했다. 기존32개 정리 모형과 새27개 조립 모형이며 actual0이다. 코드 ABI는 구현됐지만 새4개 ID/creator 성공 영수증·메모리 슬롯이 없어 실제 미배정 상태다. source 모드400/500과 private 입력600/700을 맞췄으며 준비 읽기부터 마지막 source/capsule 검사까지 감시 후 종료한다. 실제 자연3600초 경과와 exp-60 창의 SQL/Auth 지연은 검증하지 않았다. Root는 Node25.9.0 실행 파일의 단일 링크·권한·안정 FD·SHA를 읽기로 확인했고 영수증SHA `81a1cc619521227b93cdb8b484768259628d69fa41c42de5eab933e3af7fcafe`를 보존했다. 독립 읽기 검토에서 새 확정 차단 결함은 없었다. 5400초 제한은 소유한 자식의 발급부터 dispatch까지이며, 최초 읽기·비상 정리·최종 보존 확인에는 별도 호출 제한을 적용한다. 부모 전체 실행 시간의 상한으로 해석하지 않는다. 전체 **79%(22/28)**를 유지하며 C 회원/준비 조립은 계속한다.

VM 상태 읽기에서 sandbox의 `Broken/not running` 표시와 권한을 갖춘 실제 `Running` 표시를 구분했다. 실제 MemAvailable은1,077,968KiB, 시작 기준1,048,576KiB 대비29,392KiB이며 과거 creator 준비 소모27,628KiB와 변동을 고려해 새 A3 실행은 보류했다. VM 재시작·컨테이너 변경0이다. 읽기 영수증SHA `ec5279a5a878cf22b96cffb939ff0e22e9c3698bea111157fbef68d4c61b9a09`를 보존한다.

C 전용 준비 조립 초안을 root가 읽었다. 원 Auth 발급·같은 JWT·실제 profile 연결·한 번의 공개 동의 철회·차단 시 예약/모델0 계약과, controls 복원 뒤 전체 행/예산/UNKNOWN/입력/소스/대상 재검증을 포함한다. 에이전트 보고 모형은 Python26개와 Node10개 PASS이나 최종 동결 후 root 재실행/독립 검토 전이다. 실제 자식 감독·READY IPC 연결은 구현이 남아 있고 실제 네 대상 ID/credentials도 없다. 실제 Auth/SQL 호출0이며 전체22/28에 추가하지 않는다. 서비스 탈퇴는 Auth ban과 별개로 원 ID·원 인증 문맥·세션 회수·GET-only 영수증 조회 준비를 계속한다.

C 초안을 최종 동결한 뒤 root에서 Python26개와 Node10개 모형을 재실행해 PASS를 확인했고, 인계의11개 파일 해시가 일치했다. 인계SHA `d7f5606a624ca51cd409b74db3365a2ee4b9fea54a3651113ad8b1cae93798b5`다. 초기 실패3개 기록은 보존했다. 독립 검토를 진행하며 실제 자식 감독·READY IPC는 별도 후속 구현으로 남긴다. 실제 실행0, 전체79%(22/28) 유지다.

C 동결 패키지의 독립 읽기 검토도 새 확정 차단 결함 없이 완료했다. 원 공개 철회1회·양성 no_results/settled/result/finish·거절 reserve/provider0 및 복원 뒤 전체 보존 계약을 확인했다. 실제 감독 연결 미구현과 실제 대상 미확보는 유지한다. 파일 수 표기는10에서11로 정정했으며 기존 검증 루프는 원래 모든11개 파일을 비교했다. 원 영수증은 보존하고 정정SHA da8878024921c2ddab1e6b44e797a573dca5eecc59373f128a34c9c93b53ba00를 별도로 기록했다. 테스트 재실행·실제 호출은 없다.

AI24 독립 읽기 검토에서 현재 prepare 도구a5c51233·runner3e48b3ab·factorybd0b74b7의 자연 자정 경로가 live REPO/codeRoot, PATH 선택 Node와 live sibling factory를 사용함을 확인했다. 기존 lifecycle typed capsule은 invoke_case에만 연결돼 있다. 현재 HEAD/pin·warm lstat 확인을 sealed runtime 실행 증거로 확대하지 않는다. 기존 재배정 파일의 모든 준비/held/new-day·재개에 typed custody와 Node 고정을 연결하는 구현을 별도 worktree에서 시작했다. 원 정책·날짜·UNKNOWN·예산·시간창·무권한 canonical 경로는 보존하며 실제 실행0/전체79%(22/28)다.

서비스 탈퇴 private kernel/read-only proof port v1을 동결한 뒤 root 모형12개 PASS와9개 file/graph 해시 일치를 확인했다. 인계SHA29d6df64527a95dd3a41de9189f32b9bb95cfac35e8f2bc05173041fc464fdff, root 영수증SHA08bbead375ce822e8daef19aa5a8ac992318506bcc05f7c43d4a5f594f033f09다. 원 JWT의 Auth 거절/AI401 RPC·model0/stale UserClient403과 original-ID receipt GET을 구분하며 실제콜0이다. 최종 검사 뒤 성공 기록 순서를 수정했다. 추가로 inspector가 실제 성공한 현재 caller 상태를 요구하는지 검토·보완 중이며, used=true와 self-rehashed/이전 성공 파일만으로 증거가 승격되지 않도록 회귀를 추가한다. 실제 target/발급/부모검증/메모리·자식·대상 정리는 미바인딩이므로 완료에 집계하지 않는다.

서비스 탈퇴 inspector v2는 마지막 durable commit 성공 뒤에만 private WeakMap terminalProof를 기록하며 검사 시 현재 commit/receipt/final 세 SHA가 같은지 요구한다. 실패 caller의 위조/과거 성공 기록 및 성공 이후 교체를 거절하는3개 모형을 추가했다. root15개 PASS,6개 bound file+graph+handoffmd 해시 일치. 인계SHA286b84ce20f7a544f99011b6be79c0e5de7bd73a4a26885edc00746ec21ac819, root 영수증SHA0f5a9ef7f1ef1e3bd1716063cfd866314e2c306522f70b567a4f3741dbd92a99다. v1의12개 및 처음 거절 실패 기록을 보존했다. 저장소 구현 수정/실제자원 호출0이며 실제 target/발급/부모검증·감독은 미바인딩 상태로 유지한다.

AI24 캡처 소스·Node·재개 연결4개 파일을 통합했고 root114+33+48=195개 오프라인 회귀 PASS였다. 환경값은 기존 PATH/HOME/locale만 보존하며 비밀/Node/Python/proxy 환경을 전달하지 않는다. 독립 검토 후 사용자 승인 범위에서 로컬 aafb7bb2b4a8847ea9788aa289e43be6c54ccc25 커밋으로 고정했다. 커밋 뒤 HEAD 기반 보존 검사2개도 PASS였다. 새57개 소스 영수증SHA2bd5752d7124c4157686a045940eb6a1ed144c1c80e3278ce395aaacebc8b697과 AI24 도구/관찰기/회귀를 포함한62개 영수증SHAa5d32268c29798c5fddee3d30baf7de86105f69fef710b716a55c707cb2ff6ee를 각각 기록했다. 검증 영수증SHA99dd373abaf41b26c13f6aec7cadc632f701e902196730385f3ceb2b00b0530c다. 이들은 소스 증거이며 실행 권한/실제 자정 성공이 아니다. 기존 fed private graph는 actual 시작에 재사용하지 않고, 별도 검토·바인딩 후에만 사용한다. 실제Auth/DB/VM/컨테이너 호출0, 전체79%(22/28), 푸시/운영 적용0이다.

C supervisor v3의 환경값 보존과 실제 FixedCConsentPorts.verify_capsule 위임 누락을 교정했다. root28개 모형 PASS 및 독립 읽기 검토를 통과한 뒤 good IPC-only 실제 새 부모79330/Node79334 하나를 실행했다. ACK와 own group 종료는 확인했지만 exit0 이후 stdout/stderr 미닫힘 ResourceWarning2개가 나와 clean supervision PASS로 집계하지 않는다. 원 실제 영수증과 관측SHAee4bb5ea9a591ce23763273382ce591a7fca761bca2908a06eafee51f27eb0df를 보존하며 파이프 정리를 후속 v4에서 수정한다. wrong-member는 아직 실행하지 않았다. 실제 Auth/DB/VM/컨테이너/공급사0, 메모리 값/회원 준비는 MODELED이며 전체79%(22/28) 유지다.

C supervisor v4의 명시적·한 번의 파이프 정리 보완을 root36개 모형 PASS와 독립 검토로 확인했다. 새 actual IPC-only good(부모79574/Node79578)와 wrong-member(부모79581/Node79585)는 각각 ACK1/ACK0, expected거절, own group·세 파이프·출력 reader 종료를 확인했고 ResourceWarning0이었다. 두 실제 영수증/최종 상태 해시를 묶은 root 증거SHAdffeb783abc37edab53f6ab97294e4ef1e0ee25fd165069d5c92d78ee0c2c9ab를 보존한다. 이전 v3 경고 기록은 유지한다. 실제 Auth/DB/VM/컨테이너/공급사0, memory floor는MODELED, 실제 회원/C readiness는NOT_RUN, outer own4 STOP은미연결이다. 전체79%(22/28) 유지다.

서비스 탈퇴 parent before/after 연결831e346e 동결본을 root28개 모형 PASS,3개 파일/모형 영수증 해시 및 독립 읽기 검토318fc5c3로 확인했다. 원 사용자/세션/episode/subject/탈퇴ID/JWT/입력/once원발급·SQL117gate 근거와 현재SQL값을 묶으며, 전체178 테이블·권한·예산·UNKNOWN의 원 범위와 세션삭제를 확인한다. terminalSHA는 검증·저장 성공 후에만 기록된다. producer once-journal/두 단계IPC/실제4대상/원gate복원/outer정리는 아직 미연결이다. 기존책임의공유controller로두단계IPC연결을구현중이며 actual0/전체79%(22/28)를유지한다.


## C 최신 소스 연결 검토

전체 **79%(22/28)** 유지다. C source-only release의 17개 파일 hash와 최신 aafb7bb2 소스 연결을 확인했고, 추가 연결 회귀 5개가 PASS했다. supervisor 본문은 source HEAD 한 곳 변경을 제외하고 AST가 동일하며 fixed ports는 기존 바이트와 같다. root 읽기·검증 영수증 SHA `e95c1d1e4aa8d4fc5d762adb77e562679b95dfe006436929673becf3feddc30b`를 보존한다. 실제 Auth·DB·컨테이너·공급사 호출0, 대상4·credentials·실행 슬롯·외부 정리는 미연결이다. 기존 v4 실제 IPC 증거와 이번 source-only 검토를 구분한다.

승인한 합성 원본 native-v7 DB 재시작·읽기는 기존 원본 읽기 종료 영수증에서 완료를 확인했다. 원본은 정상 중지로 반환됐으므로 같은 승인 응답으로 재시작을 반복하지 않는다.


## 탈퇴 두 단계 실행기 연결

전체 **79%(22/28)** 유지다. 두 단계 BEFORE/AFTER와 각각의 ACK, 같은 자식의 kernel inspector를 연결한 v2 실행기를 root에서 24개 회귀 PASS로 확인했다. 8개 파일·3개 의존 hash를 확인했으며 원 JWT·원 탈퇴 ID·현재 terminal 파일 hash를 유지한다. root 영수증 SHA `2247ad08a125253a94dba8365e7390beeaff167db26e3f3e856c4b7f22c1b6a6`다. 이미 실행 중인 같은 메모리 감시기는 성공·실패 뒤에도 원 소유자가 종료할 때까지 유지하며 시각·스레드를 새로 만들지 않는다. 실제 통신은 독립 검토 대기이고 Auth·DB·VM·컨테이너·공급사 호출0이다. 원 SQL117 제어 복구·실제 대상4·producer·외부 정리는 미연결이다.

최신 VM 읽기 MemAvailable1,081,272KiB, 시작 기준1,048,576KiB, 과거 준비 소모27,628KiB를 뺀 여유5,068KiB라 A3는 실행하지 않았다. VM·컨테이너 변경0, 영수증SHA3fc5ab06aa2cb5da61ca346067754e86d23e9481ae2333658b8d8677d46639ae를 보존한다.


독립 검토 SHA5a2bee78 이후 root가 실제 IPC-only good(부모80700/Node80703)와 wrong-member(부모80706/Node80709)를 각각 실행했다. ACK2/ACK0과 정상 종료·own group·세 파이프·출력 reader 종료를 확인했고 ResourceWarning0이었다. 실제 부모·Node 통신 증거 SHA `4cd8815950858ed7beca76ebc83bf154f564444f0d7d7c6731141164828a2ca5`를 보존한다. parent 의미 검증·메모리는 모형이며 kernel same-child inspector actual은 NOT_RUN, 실제 Auth·DB·VM·컨테이너·공급사0이다. 따라서 실제 회원 탈퇴 완료나 운영 단계 완료로 확대하지 않으며 전체79%(22/28)를 유지한다.


## 실제 탈퇴 복구 연결의 잔여 공백

전체 **79%(22/28)** 유지다. 연결 검토 영수증 SHA35ad39c151a69025fa2f2fbe6a00a72e41d49d8cac6c49d6fc23b0022ac7bc4f에서 세 가지 필수 연결을 확인했다. producer 이전 단일 감시기와 이후 callback을 한 번만 연결해야 한다. 원 SQL117 제어값 복구 뒤에는 활성 제어값을 전제하는 기존 callback 조회와 별도로 178개 테이블·전체 예산·UNKNOWN을 새로 확인해야 한다. own4 중지는 내부 Node와 외부 Python의 정확한 종료가 모두 확인될 때만 허용하며 어느 종료라도 UNKNOWN이면 STOP0이다. 기존 lifecycle의 Auth 사용자·profile 삭제 정리는 이번 원 탈퇴 작업 보존에 사용하지 않는다. 기존 격리 PASS를 이 미연결 경계의 실제 완료로 확대하지 않는다.


## 원 함수 producer와 복구 뒤 값 비교

전체 **79%(22/28)** 유지다. 원 fixture와 원 Auth 요청 method를 AST 그대로 캡처하고, 원 응답 bytes를 첫 JSON 해석 전에 private 기록하는 producer v2를 root26개 회귀 PASS·10개 파일 hash로 검증했다. 원 소스·함수·요청 캡처3개는 기존 바이트와 같다. 모형 표시 변경이 실제 발급 증거로 승격되지 않도록 private 생성 provenance와 정확한 fixed port/root binding을 확인한다. 이전 넓은 모형 표시 검사 결함은 보존했고 root 영수증 SHA `f2683947ae4bad153f272edc11abe63babef6b45fa7f64d11afec5cc95714d9c`를 기록한다. 실제 Auth·DB·실회원·공급사0이다.

원 SQL117 gate 복구 뒤 178개 전체 행·권한·제어13개·cron off·예산7개를 비교하는 순수 값 검증을 추가했다. 숫자1과 boolean true 비교 결함을 먼저 재현한 뒤 strict canonical JSON 비교로 수정해11개 회귀 PASS를 확인했다. 이 값 검증은 실행 권한이나 실제 복구 증거를 만들지 않으며 원 제어 복구·새 실제 읽기·정확한 own4 정리 연결은 아직 필요하다. 두 항목의 독립 검토는 대기 중이다.


## 독립 검토와 초기화 연결 후보

전체 **79%(22/28)** 유지다. producer v2 독립 source-only 검토 SHA1a74eac43b27015fbb170e2ba767b97a9638028bf9aa40b54db8fb770fb3140e와 post-gate 값 비교 v2 독립 검토 SHAe04ed6845afcfb00947a95dce0af10f3c27677a9f4816badacd278e53ab2b40d는 PASS다. 실제 Auth·복원·운영 완료 증거로 확대하지 않는다.

초기화 후보8a31은9개 파일·3개 의존 hash와 기존 supervisor3개 class AST·Node·모형 파일 보존을 root에서 확인했고 새14개 회귀 PASS다. 독립 검토에서 기존 supervisor의 변경 가능한 모형 표시가 실제 부분 PASS 표기를 선택할 수 있는 경로를 찾아 후보를 보류했다. 생성 당시 private provenance와 정확한 실제 binding으로 표기를 결정하는 후속 수정 중이다. source-only 후보·실패 근거 SHA6e09b7bb016b618b99a4ef4dbbc4055d71f7c426ec15c65dad069a4971f15c94를 보존하고 실제 호출0을 유지한다.


## 원 생성 provenance 교정 검증

전체 **79%(22/28)** 유지다. 초기화 후보의 모형 표시 승격 경로를 private 원 생성 witness와 정확한 현재 context/port/binding 재검증으로 교정했다. root 새2개·관련 기존24개 회귀 PASS, 원 초기화4개 class AST·기존 모형/Node/정리 본문 보존을 확인했다. 독립 검토 SHA7d6d578dca8858c182143398cf5a5fe6a751b64e48db6a6aad5a69cae68544cb와 root 영수증 SHA `8d532df7f2d46cfb8e7015793b50f7cf1bf19a68c36f98c3b2ce803f8b1c80f7`를 보존하며 기존 결함 근거를 삭제하지 않는다. 실제 호출0, actual root/target4/credentials/slot은 미연결이다.

producer가 callback·자식 생성 전에 실패하는 경우에도 정확한 미실행 증거와 own4 lease로 정리를 시도할 수 있도록 연결 중이다. Popen 시도 여부는 호출 전에 private 등록하고, 반환된 정확한 Popen만 보존한다. 시도했지만 Popen이 불명확하면 UNKNOWN이며 STOP0이다. 최종 composite의 원 제어 복구·fresh 값 비교·내부/외부 종료·own4 정리는 아직 실제 검증 전이다.


## 정확한 대상 정리와 감시 연결

전체 **79%(22/28)** 유지다. own4 정리와 감시 연결 동결본을 root에서 58개 오프라인 회귀 PASS로 확인했고 모든 파일·의존 해시가 일치했다. root 영수증 SHA `794679dc29f390d4918ff97bb8d663ba660c29e5c66952508248bfcb351719a5`다. 같은 원 감시기에 VM 메모리 조회를 시작 전에 고정하여 DB 중지 뒤에도 감시를 유지한다. 원 Popen 시도·반환 증거, 내부/외부 종료 증거, 대상별 한 번의 STOP·응답 유실 UNKNOWN 보존을 구분한다. 실제 VM·DB·컨테이너·Auth 호출0이며 actual bindings는 미배정이다. 외부 Python의 정확한 private launch witness와 최종 통합·독립 검토가 필요하므로 이 모형 결과를 실제 정리 완료로 집계하지 않는다.

서울 신규 공식 OA-23041의 aiViewCulture 안내를 확인해 별도 담당 검토 요청에 기록했다. 공식 문서 HTTPS 조회와 실제 API HTTPS 수집 증거를 구분하며 endpoint나 공급사 경로를 변경하지 않았다.

독립 검토 영수증 SHA `e3e94c001c0416ab42f3ab8615c79460e78e11282dccad20ab5942da80fee6ce`는 새 중지 권한 결함을 확인하지 않았다. 미실행 종료 증거는 실행 파일 생성 전 실패만 포함한다. 파일 생성 후 Popen 전 실패는 UNKNOWN·STOP0으로 남으며 모든 사전 실패를 자동 정리한다고 설명하지 않는다.


## 실제 실행 선행조건 점검

전체 **79%(22/28)**. 승인된 native-v7 원본 재시작·읽기는 완료했고 정상 중지로 반환했다. 새 실제 Auth 환경은 메모리 준비 여유가 부족하여 시작하지 않았다. 별도로 제시한 정확한 세 격리 DB 정상 중지 승인, Storage 원본39개, 공급사 조건·HTTPS 실제 계약, 실회원 HOLD 해제가 필요하다. 이 조건은 여러 실행에 걸쳐 유지되고 있으며 완료율을 높이기 위해 제외하지 않는다. 운영 적용은 최종 검증 묶음과 별도 승인 전까지 실행하지 않는다.


최종 통합 조립은 원 producer·두 단계 실행기·같은 kernel 증거에 묶인 최신 보존 조회·원 gate 복구·값 비교·자식 종료·own4 정리 순서로 동결했다. root15개 오프라인 회귀와5개 파일·6개 구성요소 해시 PASS, 영수증 SHA `ae949dfda60577c88f5886e9eaaea48a10b74ca2470ff2fea6e82117c2acab85`다. 실제 context/대상4/비밀/실행 슬롯은 미배정이며 실제 호출0이다. 논리 보존 증거는 중지 전 복구 뒤178개 조회 범위이며 중지 뒤 SQL·sequence·물리 삭제·Storage39개 복원 증거가 아니다. 별도 외부 Python 실행기는 구현 범위에 추가하지 않았고 필요한 정확한 종료 증거를 조건으로 유지했다. 전체79%(22/28)는 변하지 않는다.

통합 독립 검토 SHA `d4070fd890663f6ac6f4d65e4c0213ebbecf00e45da932f1d6cbe8fe43aae66a`도 새 확정 권한 결함 없이 source-only PASS다. 가능한 이번 연결·검토를 마쳤으며 반복 유지된 실제 실행 선행조건 대기로 목표 상태는 blocked다. 이는 완료나 사용자 중지 요청을 뜻하지 않는다. 조건이 충족되면 실제 검증부터 재개하며100% 판정 기준은 유지한다.


## 메모리 확보 승인 후 실제 실행 재개

전체 **79%(22/28)**. 사용자가 지정한 세 격리 DB 정상 중지를 승인했다. 실행 직전 정확한 ID·이미지·Config/HostConfig 해시·다른 client0을 확인하고 각 대상 STOP30을 한 번 실행했다. 모두 Exit0·OOMfalse·stopped이며 컨테이너/볼륨을 보존했다. 영수증 SHA `c9b679cc11b9eb36e6b70fc653bb9bb91d50e05b2081cac5d271d6dc69af2bf2`, 이후 MemAvailable1,300,788KiB다. 검토된 A3 생성기를 새 합성 환경에 한 번 실행 중이며 운영·원본 DB SQL·실회원 발급·삭제는 하지 않는다. 이전 메모리 승인 대기는 해소됐고 전체 완료 수는 실제 검증 뒤 판정한다.

A3 실제 실행은 `NATIVE119_RESTORE_MISMATCH_NO_REPAIR`로 실패했다. 원본·기존 대상은 그대로이며 새 합성 DB 한 개만 정상 중지·보존했고 Auth·계정 생성0이다. 비교 전 복원 후보를 저장하지 않는 진단 공백이 있어 현재 증거만으로 불일치 필드를 확정하지 않는다. 원 비교 조건은 유지하며 새 namespace의 후속 검증에서 후보 전체 값을 먼저 저장해 원인을 확인한다. A3 자체 재실행·불일치 임의 보정·PASS 승격은 하지 않는다. 전체79%(22/28).

A4는 비교 전 후보 전체를 저장한 뒤 같은 원 비교에서 실패했다. 전체178개 행·역할/membership·sequence4개는 일치했다. GraphQL/GraphQL_public 스키마의 원 권한이 누락돼 실효 권한8개가 달랐으며,136개 관계는 명시적 owner ACL이 NULL 기본값으로 바뀌었다. Catalog는 CHECK의 AND 묶음·정책 역할 정렬·누적 기본권한 GRANT 정렬 차이를 포함한다. 실패와 후보 원 bytes를 보존하고 원 스키마 권한 재현 및 좁은 표현 비교를 기존 복원 책임 파일에서 보완한다. 원본 권한·grantor·WITH GRANT OPTION·전체 실효 권한은 엄격 비교를 유지한다. A4 새 DB만 정상 중지했고 기존 대상은 불변이며 Auth 발급0이다. 전체79%(22/28).


## 실제 복원 권한 교정과 Auth 이력 연결

전체 **79%(22/28)**. 새 복원 대상에 원 스키마/관계 ACL을 원 grantor·WITH GRANT OPTION으로 재현하는 기능과 제한된 catalog 표현 비교를 기존 복원 helper에 연결했다. 실제 Auth 이력 검증은 V1 엄격 경로를 보존하고, V2의 고정 private clone baseline을 원119 소스 전체와 비교한 뒤 현재 raw ACL/전체 실효 권한을 다시 읽는다. source-only220개 회귀와 두 독립 검토 PASS, 로컬 커밋 `4e28789d2337ba0944e4362827708626dcb38eee`로3개 소스를 고정했다. 푸시/운영 변경0이다.

A5 실제 실행에서 원 ACL138개 대상의 보충 뒤 전체178개 행·역할/membership·raw ACL·실효 권한484096개·sequence4개 검증이 PASS했다. private 비교 영수증은 원 sourceSHA5cb91…와 복원 rawSHAf5918bd77857d06afd2f20ebfa0ada1c1be66893e42ff348ed43372709f36468을 구분한다. 이 성공은 DB 복원 범위이며 Storage39개·Auth session·실회원·운영 완료를 뜻하지 않는다. 다음 TLS 단계에서 실패해 새 DB만 정상 중지했고 prior/source는 불변이며 Auth 생성0이다.

원인은 시작 명령의 `-c ssl=off`가 이후 ALTER SYSTEM보다 우선하는 구성이다. [PostgreSQL17 설정 문서](https://www.postgresql.org/docs/17/config-setting.html)의 우선순위를 확인했다. 새 검증 대상에서는 시작 전 변경 가능한 파일로 초기 off를 구성하고 원 TLS 설정·reload를 한 번 실행한 뒤 bounded read로 on/설정 출처/인증서 경로를 확인하도록 교정 중이다. A5 재실행·source/운영 설정 변경·메모리 임계값 완화는 하지 않는다.

A6는 초기 ssl off 파일 설정과 이후 on/설정 출처/인증서 경로 확인을 실제 DB에서 통과했다. Auth/REST 인증서 복사 단계에서 REST 이미지의 /tmp 경로 부재로 실패해 새3대상만 정상 중지했다. A7은 공개 CA 파일 위치를 /auth6-ca.crt로 교정해4서비스 HTTP health/rest200 및 signed service missing-user GET404를 통과했으나 실제 DB 서비스 역할2개 확인에서 실패했다. 계정/실회원 발급0, 기존/source 불변, 전체79%(22/28)다.

A8은 실제 읽기 전용 Auth users/REST profiles GET으로 빈 초기 데이터를 확인한 직후 원 TLS 역할 조회를 실행하며, 원 관측 bytes와 파싱 값을 먼저 저장한다. 역할/TLSversion/bits 기준은 유지한다. HTTP timeout2는 socket timeout과 반환 뒤 elapsed 수락 기준이며, trickled response를 강제 종료하는 별도 전체 deadline 증거로 확대하지 않는다. root 회귀6개와 독립 읽기 검토 통과 후 새 namespace에서 실제 실행 중이다.

A8 실제 관측은 REST authenticator 두 연결의 TLSv1.3/256bit를 확인했지만 Auth 역할 연결이 없어 실패했다. 원 관측과 신규4개 정상 중지 증거를 보존한다. Auth v2.196.0의 기본 idle0 설정에 따른 연결 종료를 공식 소스와 대조했다. A9는 새 합성 Auth fixture에만 max pool4/idle1을 추가하며 역할2개·TLS·메모리·계정 한도와 REST 설정은 보존한다. creator SHA `58b0989c18ab00b83e616104381a6a97a00555dc8b93c00d8db01d6ef59dc201`, handoff SHA `7f6c91555192091c9792c6e834ee8e7cdca5d81779cb559186dada295a94d4ca`의 회귀1개와 독립 검토 PASS 뒤 새 namespace에서 실제 실행을 시작했다. 전체79%(22/28), signed user/자연 자정/운영 적용은 아직 완료로 집계하지 않는다.

A9 실제 creator는 `PASS_NEW_CLOSED_NATIVE119_FOUR_SERVICES_ONLY`로 종료했다. Auth supabase_auth_admin과 REST authenticator의 현재 DB TLSv1.3/256bit를 확인했으며 verify-full URI를 유지했다. 원119 전체행178·roles/membership·원 ACL·실효권한484096·sequence4 및 제한된 catalog 표현 비교가 통과했다. 기존 inventory는 불변, source SQL0, Auth 사용자 발급0이다. 비공개 증거 루트 `/private/tmp/yumidang-native-auth6-created-20261013-a9`의 영수증 해시는 다음과 같다: created-proof.json `79eeb3ee916ecf7f830f585f6f2166fd940e064ea57d18399d366b480d560b4f`; actual-service-tls.json `f7766cffd8d4f80b80818815e633bfe9f455e830334a40d318c98e697d4f6e70`; native119-source-acl-comparison.json `369023956b1a02afd0ba7c0da85abbda8804d6878e7b085799b96df175408639`; native119-final-service-comparison.json `369023956b1a02afd0ba7c0da85abbda8804d6878e7b085799b96df175408639`. 새 환경에서 실제 서명 사용자 및 원 탈퇴 요청 복구를 이어간다. Storage39 원 바이트·실회원 HOLD·공급사·운영 적용을 포함한 전체 완료율은79%(22/28)를 유지한다.

A9 현재 identity와 `signed_verify_history`를 기존 실제 FixedLifecycleProvisioningPorts로 읽기 실행해 PASS를 확인했다. private 영수증 `/private/tmp/yumidang-a9-current-history-tjtimm2p/receipt.json`, SHA `e7e7f45164421295f33f83eb52dcdbb723d044ab458984720d5b5c417f231644`다. 현재 권한·전체 실효 권한과 원119 대응을 재검사했으며 Auth 사용자/모델 호출0이다. MemAvailable1,094,060→1,086,200KiB를 읽어 원 시작/유지 가드를 보존한다. 독립 peer는 source/baseline 값 일치를 검증했고, prior 전체 보존은 creator 실제 비교의 recorded priorExact assertion으로 구분한다(별도 raw after-inventory peer 비교로 확대하지 않음). 전체79%(22/28).

A9 실제 Root typed 호출은 source-only factory의 91제품/92파일 캡처를 수행한 뒤 PRODUCER 단계에서 사용자/원 요청 전송 전 실패했다. producer sent=[], gate 원값 보존/복구 영수증 PASS, 신규4개 STOP 각1회·Exit0/OOMfalse/UNKNOWN없음·EXACT_OWN4_CLOSED를 확인했다. 전 과정/실회원/탈퇴 API 성공으로 집계하지 않는다. 최초 실패의 고정 원인 코드가 누락돼 generic ValueError로 보존되었으며 해당 진단 공백을 보완한다. 현재 source119 전체178개 중 cron2/vault1이 존재하지만 FixedLifecycleProvisioningPorts의 공통 행 조회는 auth/public/private/storage만 반환해175개가 된다. producer의 FULL_NATIVE119_ROWS=178 조건과 충돌하는 확정 코드 결함이 실패 위치와 일치한다. 실제 최초 에러 코드가 이 조건이었다는 직접 영수증은 없어 추론 범위를 구분한다. 178개 기준을 내리지 않고 lifecycle 전체 행 조회에 누락 namespace를 포함한다. A9는 중지/보존하며 재실행·재시작하지 않는다. 비공개 원 실패/정리 증거 루트 `/private/tmp/yumidang-retirement-a9-root-reviewed-20261013-v1`, 해시 producer-failure.json `531fce3c7ca89128a1d91c5ad818e5b3ccd7cbfb35e9e338e6fdde540b51bddf`; composite-final.json `5afc79ae4fd145c8f4d596a2ba5cd4303073a54e3d5f0ed655a0b1b7347421f6`; own-four-final.json `88fa960ae02927da468dff6e90b8e3236a092ac32c020969c1159dd0c6d1f665`; gate-restore-receipt.json `88164222e8af674f02959b80345ab7a6c547a34d43c87941c9c595b7f335d438`; source-only-factory-result.json `7eed5ae6dd88ced72566a11f576924d73fdb332fd084cb30a13137cb0708ad3c`. 전체79%(22/28).

누락 namespace 수정은 기존 lifecycle 전용 메서드에만 적용했다. cron/vault 행과 구조를 포함하며 원 자정/base 네 schema 동작을 보존했다. lcp_snapshot에는 정확한 cron.job·cron.job_run_details·vault.secrets만 추가 허용했고, 원 bag 변경·추가 schema/임의 관계를 거절하는 회귀를 포함했다. root 기존 M 회귀143개와 독립 peer PASS, 소유권/staged/hook PASS 후2개 소스를 로컬 커밋 `7dd774c74cebaaba58c50ebc8532144ab436dce7`로 고정했다. runner SHA `f565ef4d019661e2eb462040f6b7bbf4e86cb4fed5bcbb6f9e14fc27a8ecdae3`, M회귀 SHA `4b2d7abb764f2c7ded3fb9731dd744b2447f9924975d11c6fb906008d804832a`다. 새57 source freeze SHA `986365da3654bb5a7751a54745959139eeb9b2e95c97dd1b94367e3261724bcc`, pins SHA `00a5860176cefac50a242c0f718d150af074775bcdb987a29d23ec32a4ea721a`. A10은 A9 생성 로직을 보존하고 새 namespace/CIDR216·217 등9개 상수만 바꿨으며 SQL119 원 bytes를 보존했다. 독립 검토 뒤 새 creator SHA `0aaf9bdca7d13389b50947a233b581f47825214c14e1b9885eb222f0f0d9c2b8`을 한 번 실제 실행 중이다. 전체79%(22/28), 기존A9중지/보존·실회원HOLD·Storage39·공급사·운영 조건을 유지한다.

A10 실제 호출은 리소스 생성 전에 `PREPARED_ALREADY_CONSUMED`로 거절됐고 creatorRoot가 생성되지 않았다. 새 prepared에 execution-intent.json이 잘못 포함됐으며 migration-manifest.json 대신 이전A9 intent를 복사한 준비 오류를 확인했다. 표시파일 SHA `843a2a128bd52330e65562d56a3a60b36e57d84dfce9892b2bdfe546423910ea`를 보존한다. A10 표시를 삭제/수정하거나 같은대상을 재실행하지 않는다. 기존 원 검사 기준과 생성 로직은 유지하고 새A11은119 SQL·config·database/migration manifest의 정확한122개 파일 및5개 소비 표시 부재를 확인한다. A10 계정/컨테이너/SQL 호출0, 전체79%(22/28)다.

A11은 정확한122개 정적파일과5개 소비표시 부재를 root/독립peer 확인한 뒤 creator를 한 번 실행해 `PASS_NEW_CLOSED_NATIVE119_FOUR_SERVICES_ONLY`를 확인했다. 기존 대상/source SQL0·Auth 사용자 발급0, source/baseline 전량 비교와 Auth/REST TLSv1.3·256bit/verify-full PASS다. 실제 서명 사용자/탈퇴 검증은 다음 단계이며 별도 판정한다. private 루트 `/private/tmp/yumidang-native-auth6-created-20261013-a11`, 해시 created-proof.json `a3895f46be719a513c5e7d5358f09e8a0a77b0c8751343f7a1a86ac060038159`; actual-service-tls.json `3be0ae606b5ca35eaabafeff6f3ec62ec1425f2282723df158bb16a692454c74`; native119-final-service-comparison.json `369023956b1a02afd0ba7c0da85abbda8804d6878e7b085799b96df175408639`. 전체79%(22/28).

A11 actual Root 호출은 source91/92 캡처와 실제 issuer/identity 확인 뒤 원 요청 전송 전 실패했다. 새 진단에 causeType=RuntimeError/causeCode=SQLSTATE_42601·sent=[]가 기록됐다. 고정 제어 상태 SQL의 column+from 결합에 공백이 없어 enabledfrom/external_processing_allowedfrom을 생성하는 실제 문법 결함을 확인했다. 이 메서드는 full rows 검사보다 먼저 실행된다. 원 namespace175/178 결함과 별도로 보고하며 A9의 유실된 최초 코드를 복구한 것으로 간주하지 않는다. 기존 M runner의 SQL literal 공백만 보완하며 역할/제어/행 개수/시간 조건은 변경하지 않는다. A11 원 gate 복구와 신규4 STOP1회/각Exit0/OOMfalse/UNKNOWN없음 PASS, Auth 생성/원 요청0이다. 원 증거 `/private/tmp/yumidang-retirement-a11-root-reviewed-20261013-v1`, 해시 producer-failure.json `e97a9cd0cd759cb8c5bbb6601919f15457b70d22ec5c4ed0654874bda6525025`; composite-final.json `85c39f5e92c073a9afe4be598efaa4a6c467c7e61e4aac2cadf12ad21215a036`; own-four-final.json `caf51076dadca08618ab0ea9d7530d93eca90feeafb09c9659fa4730d5bea09e`. 전체79%(22/28).

제어 SQL의 FROM 앞 공백 한 글자만 수정하고 실제 생성 쿼리를 원 상태로 되돌리면 구문 오류를 거절하는 SQLite 문법 회귀를 추가했다(SQLite 모형이며 실제 PostgreSQL 성공으로 확대하지 않음). root 회귀144개/독립peer/소유권/staged/hook PASS 뒤 source2를 로컬 `53df35d93f1bcd4e21dce6365d90a48e4ead664e`로 고정했다. runner SHA `d882328ef044d193353e9476a2a415cee0b27c520e2db8fb59b75572876b77b5`, M회귀 SHA `9161a2b709874731190e83b47607a03aae19bb2e340458c09c528feb04f0f1b4`, 원178개 보존 개선을 유지한다. 다음A12는 기존 생성 로직/SQL119를 보존하며 새namespace·220/221 CIDR과 정확한122파일·5개 표시 부재를 확인한다. 전체79%(22/28), 푸시/운영 변경0.

A12 생성기/정확한122파일·표시5개 부재/현재53df source57의 독립 검토 뒤 실제 creator를 한 번 실행해 `PASS_NEW_CLOSED_NATIVE119_FOUR_SERVICES_ONLY`를 확인했다. 원/baseline whole 비교·실제 Auth/REST DB TLS PASS, 사용자 발급0이고 운영/Storage 복원 증거로 확대하지 않는다. Private 루트 `/private/tmp/yumidang-native-auth6-created-20261013-a12`, 해시 created-proof.json `89ed4ba4893f35baa525fd404c8e5f2cd4bdc1e5044a09e182c7e1accc6cb5c0`; actual-service-tls.json `fd5d55fa015f08401f9cbe418728fbd2703556997832028de58bfce6b4b6e389`. 현재 source57 freezeSHA `b6b42047c72643a89f833b9cbf2b4565d73c436d3fbec548f8216bee14df1e56`, pinsSHA `2519806e02d34cf53a0ca2a451dc3d81856c08d0ef55b3b54730c816043e186a`다. 전체79%(22/28).

A12 실제 후속 호출은 원 fixture 함수의 Auth admin 생성1회·password 로그인1회(각 HTTP200), 회원 연결 SQL3종과 원 서명 세션 검증을 통과했다. source91제품/92파일 캡처와 원178개 전체 snapshot을 확인했다. 이는 합성 회원의 실제 로컬 Auth 연결이며 실회원 네이버/탈퇴/AI 성공으로 확대하지 않는다. producer 영수증 SHA `d0e90a317f64f46b8b7eaab0051a904dd8ff73b42091df18b0048012f5a7e05f`다.

탈퇴 호출 직전 BEFORE 검증은 약281.95초에 실패했다. 원 탈퇴 API 전송0·ACK0이며 최초 원인 코드는 UNKNOWN으로 보존한다. 원 snapshot과 후속 snapshot은178개 및 권한/catalog/constraint 해시가 일치한다. 별도 정적 검토에서 보존 비교 SQL4곳의 UUID 캐스트 다음 공백 누락(`::uuidand`/`::uuidfrom`)을 확인했지만 직접 최초 원인 영수증으로 간주하지 않는다. 새 private 검증 패킷에 최소 수정과 안전한 오류 코드/쿼리 해시 진단을 준비한다.

원 gate=false 복구는 확인했다. 신규4개는 각 정상 STOP 응답·Exit0·OOMfalse를 기록했지만, 연속300초 감시 제한 이후 최종 전체 inventory 확인이 실패해 `own-four-final=FAIL_UNKNOWN`을 유지한다. 전체 정리 PASS로 집계하지 않는다. Auth 사용자/원 세션1개와 데이터·컨테이너·원 증거는 중지 상태로 보존하고 같은A12 재실행/재시작/삭제는 하지 않는다. private 증거 `/private/tmp/yumidang-retirement-a12-root-reviewed-20261013-v1`, callback 실패 SHA `dd6bc910900f3b84faf5548f3f45e3d952ffa7a9daf750f68f6fee920c18758d`, own-four-final SHA `4c7bb5babad01897bd4ccf712302fbeba62a8fc98edc1c3315cadcc98d157d1a`, composite-final SHA `0b496bd2320b842595cdef3bd8c6be96edc37c22553a9acbfb0f11b49c6d2fe3`다. 최초 실패가300초 전에 발생했으므로 시간 초과를 최초 원인으로 단정하지 않는다. 다음 독립 작업은 SQL4곳 교정과 현재 권한·메모리 검사를 유지하는 검증 비용 점검이다. 전체79%(22/28), 실회원HOLD/Storage39/공급사/운영 조건을 유지한다.

실패 이후 별도 읽기 전용 조회로 A12 정확한4개 ID가 현재 모두 stopped/Exit0/OOMfalse인 것을 재확인했다. 변경 호출0이며 원300초 종료 실패/UNKNOWN을 소급 PASS로 바꾸지 않는다. 후속 현재 상태 영수증 `/private/tmp/yumidang-a12-later-current-stop-m642ux7l/receipt.json`, SHA `cd3cf4341e4a05cb48ec15b0219500395962e8a71a733f5de7d4129cc0353a6c`다.

SQL4공백과 원 오류의 고정 코드/클래스/쿼리 SHA 진단은 기존 패킷을 보존한 새 private successor에 반영했다. root도 생성 SQL 문법·오류 전달 모형6개 PASS를 확인했다. 패킷 `/private/tmp/yumidang-retirement-parent-sql-diagnostic-1p3b_4un/handoff.json` SHA `32f6e3a96fc4fcb97452cabbe96f2a6942f6358426c7e6448c68d46e2ee23cfa`, preservation SHA `c03cb8bc372280a831e8343dd0184c743289d6c2f77f1e044501b8a677ae5a5e`, callback assembly SHA `303676f4a9d307a6168103f4a9bac5e4396ea7dca317c6a6c04d7d86af5f0c6a`다. 원 SQL 포트·timeout·300초·메모리 임계값은 유지하며 실제 PostgreSQL/탈퇴 PASS로 집계하지 않는다.

반복 검증 비용의 로컬 읽기 측정에서 원/복원 baseline 각50MB 파싱과 순수 전체 비교·원 canonical projection의 중복 계산이 history1회당 약3.11초였다(단일 로컬 표본, 실제 DB 비용 아님). 현재 실효 권한484096개·catalog·역할·identity·원장·메모리는 매번 새로 검사하면서 immutable 원 바이트의 순수 검증 결과만 재사용하는 최소 최적화를 준비한다. `/private/tmp/yumidang-native-history-cost-review-8f939815-de3d-47b8-a379-77c1a42bf250/review.json` SHA `1d6c7a292ebff8db8e434d7f6ed97a68d1107dfd39476747fbdfaeec80e1c22c`다. 아직300초 내 전체 실제 검증 가능의 증거는 아니며 제한을 연장/재설정하지 않는다. 전체79%(22/28).

불변 원 자료의 순수 비교 결과만 maxsize1 캐시로 재사용하도록 기존 runner를 수정했다. 키는 원/복원/helper 실제 bytes와 기대 SHA이며 반환값은 tuple·bytes·str·int만 포함한다. 매 history 호출의 stable-FD 전체 읽기/SHA·119개 영수증·helper HEAD 검증과 현재 DB raw ACL/전체 실효 권한/역할/catalog/identity 검사는 유지한다. V1은 캐시를 쓰지 않는다. 현재 권한·catalog·원본/helper 변경 거절, 실패 비교 미캐시 등 신규7개를 포함해 agent151개 PASS19.972초·root151개 PASS21.167초·독립peer/소유권/staged/hook PASS 후 로컬 커밋 `ed3bde1e606efe38e01fdf1577fe10a94d0cfb18`로 source2개만 고정했다. runner SHA `2675ebe9fb917248fc7bf326bc954d5b4be6a4ae4cc70283a49b7f8d4e5fdd78`, M회귀 SHA `07903b8d825a82925582f811731e2334afcba29e2662d51fe303ec4691ed9c01`다. 약149MB host 캐시와 로컬 cold3.454/warm0.053초 측정은 전체300초 실제 성공 증거가 아니다. 메모리/시간 조건은 완화하지 않았다.

현재57개 source가 HEAD와 일치하는 새 동결 자료 `/private/tmp/yumidang-retirement-source-ed3b-a13-2z97zp_b/source-freeze.json` SHA `b99d465a3379f5be64008e89751d64167e48efcd92981327f15ab833c3b6ea0b`, sourcePins SHA `88e42f83f97238b8acecd163cacb2a14171adbb02d11d91b7957551b20b64422`를 생성했다. 이전57개 중 runner1개만 변경이며 source-only 범위다. A13의 기존 생성 로직·원119 bytes·정적122파일/소비표시5개 부재를 root/peer 확인한 뒤 creator SHA `f8f13dba26a27e378b3996b0c0d34bb826f36609c30bcc37420cc346e87e362b`를 한 번 실제 실행 중이다. 새222/223 CIDR·project `jonghyun-backend100-a13c0d01`을 사용하며 기존/운영/source SQL0·실회원HOLD를 유지한다. 푸시/운영 변경0, 전체79%(22/28).

A13 실제 creator는 `PASS_NEW_CLOSED_NATIVE119_FOUR_SERVICES_ONLY`로 종료했다. 원119의 전체178행·역할/membership·raw ACL·실효 권한484096·sequence4의 엄격 비교와 실제 Auth/REST 역할의 TLSv1.3/256bit·verify-full 연결을 확인했다. source/기존 SQL0·priorExact 기록·신규 사용자0이다. 이는 환경/DB 복원 증거이며 Storage39·signed user·실회원·AI24·운영 적용으로 확대하지 않는다. private `/private/tmp/yumidang-native-auth6-created-20261013-a13`, created-proof SHA `3eea446af8ba164d9bf25ec7718d00e98220537aaf0e1425ba0b5e1765a47ade`, actual-service-tls SHA `4be7c0bdc2be82a578d78114bd3cc903dc3d81b9d3251ff21e68ea8b4c5b9eb5`, native119-final-service-comparison SHA `369023956b1a02afd0ba7c0da85abbda8804d6878e7b085799b96df175408639`다. 새 실제 private 증거 pin을 원 Root caller에 연결해 후속 검증한다. 전체79%(22/28).

A13 실제 Root 단일 호출의 producer는 Auth 생성/로그인과 회원 연결을 통과했다(영수증 약148.792초, A12 약197.464초보다 단축). 원178개 BEFORE 검증은 약235.813초에 통과했고 원 탈퇴 RPC wire intent가 약236.135초에 기록됐다. 요청1회 뒤 kernel `PUBLIC_PROCESSING` 조건이 실패했다. 성공 응답/AFTER 증거는 없으며 실제 HTTP 상태/SQLSTATE가 저장되지 않아 직접 응답 원인은 UNKNOWN이다. 재전송/세션 복원/삭제/ACK/workerclaim은0이다.

독립 정적 검토와 보존된 실제 원장으로 선행조건 누락을 확인했다: member_cleanup_guard=false이며 원 source/clone의 service_role EXECUTE5개도 false다. 최초 retire_my_account는 guard=true와 정확한5개 권한을 요구하므로 HTTP factory 옵션만 열어서는 processing에 도달할 수 없다. 제품 준비 가드는 보존하고, 새 격리 clone에서만 한시적 준비 조건을 명시적으로 관리·복원하는 최소 fixture 연결과 실패 전 안전한 응답 상태/SHA 진단을 준비한다. 운영 권한 부여/활성화 승인을 뜻하지 않는다.

retained snapshot178개 전체 행·권한/catalog/constraint 해시는 fixtureFullBaseline과 일치하고 원 예산/UNKNOWN을 보존했다. 원 receipt gate=false 복구를 확인했다. 신규4개 각각 정상 STOP/Exit0/OOMfalse를 기록했지만 최종 prior inventory가 원300초를 넘어 own-four-final은 FAIL_UNKNOWN이다(최종 약313.878초, composite 약320.155초). 원 제한을 재설정/연장하지 않는다. A13은 데이터·원 세션·컨테이너·증거를 보존하며 재실행/재시작하지 않는다. private 증거 루트 `/private/tmp/yumidang-retirement-a13-root-reviewed-20261013-v1`의 주요 해시는 아래와 같다.

- producer-receipt.json: `d09bda2988768cb8deba2a301d5b1e8d66aac3506797111ab2459d46a67a960b`
- callback-before-proof.json: `33882b713ba36f7e64db18f9082cb3c89b8cf60879d0974255de43b08974ee5f`
- retirement-first-failure.json: `ecea918953e8e00378d550830c364214378bedc6dad2612e9306fe85bcc99e89`
- own-four-final.json: `10054e34cc4f50c356beffe3787bb76da1e4bfe00ad92b2803397c18491a54dc`
- composite-final.json: `54db6f56f5622a5f653555e3172c9c9e5db2a76b9b811eb63e9db84214890178`
- gate-restore-receipt.json: `c65c6981cd0d67c72b936c6f26b63765d745ff4552cf2eea598cf953daf06a4c`

전체79%(22/28) 유지. 다음 독립 작업은 현재 실효 권한을 매번 새로 검증하는 왕복 비용 축소, 새 clone의 명시적 readiness fixture, 별도 새 환경의 실제 AI 정상/동의 철회 C 연결이다. 실회원HOLD·Storage39 원 바이트·공급사·운영 적용 조건은 유지한다.


## C14 실제 연결과 검증 비용 개선

전체 **79%(22/28)** 유지. 역할 권한 조회를 네 역할씩 묶는 변경은 로컬 커밋 `4b2a3559e24777525af5e44197aa960fa5fd5247`과 회귀157개로 고정했다. 원 역할 목록·raw ACL·membership 전후 확인과 전체 실효 권한484096개 검사는 보존한다. 기본 복원 수집은 기존 한 역할씩 조회를 유지한다. C14의 실제 읽기 전용 현재 이력 검증이 통과했다(약11.967초, SQL 변경0). 영수증 SHA `b103a68fb414b9c18cfee92c35d7bf0882547217927aae3ed34128de586487af`다.

C14 신규 환경은 전체178행·역할·권한·sequence·Auth/REST TLS 검증을 통과했고 실제 합성 Auth 생성/로그인1회 및 AI 준비까지 실행했다. Node 실행 전 실패하여 READY·정상 AI 답변·동의 철회는 NOT_RUN이다. 직접 최초 원인은 UNKNOWN이며 새 진단을 별도 검토한다. 신규4개 정상 중지와 최종 기존 inventory 보존은 EXACT_OWN4_CLOSED로 확인했다. 전체 원 행 보존의 최종 C 증거는 UNPROVEN이며 성공으로 대체하지 않는다. C14 재시작·재실행은 하지 않는다.

C14 증거 루트는 `/private/tmp/yumidang-consent-C-root-reviewed-20261013-v1`다. root-final SHA `790d33d57731353ce77fa35d365b8e8ab91003f627fe87a3dd24fe4a482f086e`, own-four-final SHA `540018f667b86dbbb2c6fe5c63717c66ee74213d3172324f90783fd2394d56e6`, c-failure SHA `7f0bea4e10c19e3c727cd0c67b5ac65b07e6370388ce93f33e7b6910cdb9b700`다.

178개 테이블 행 해시/개수를 동일한 단일 SQL로 수집하도록 lifecycle 전용 조회를 개선했다. 실제 C14 읽기 검증에서 기존178회 약8.943초와 새1회 약0.197초의 결과가 정확히 같았다. 영수증 SHA `80360c271dc64071c641ca77885ee95a0590101f683caa5134ccb7a0ec0326ad`다. 누락·중복 JSON·잘못된 bag·timeout 거절 회귀를 포함해 root162개 PASS23.200초와 독립 구현 검증을 통과했다. 로컬 커밋 `7a47bc41c4803f324327bd8cbaa746171312fa59`, source57 동결 SHA `7965d337e031191f34f0c08e0fcd7450b239ade6ee096aa29e0672467d6b1a94`로 고정했다. 원300초·메모리 기준·전체 비교는 유지한다. 푸시·운영 적용0이다.

다음은 새 C15에서 안전한 실행 전 진단을 포함한 실제 Auth·AI 연결이며, 별도 탈퇴 fixture의 준비 권한 복원 검토를 병행한다. 실회원 HOLD·Storage39 실제 바이트·공급사·운영 승인 조건은 유지한다.


C15 실제 환경 생성·전체178행/역할/권한/sequence와 Auth/REST TLS 검증 PASS, created-proof SHA `d7726f411198da2ca9de8336c0bdbe1e812621f9e55b93e1a2085f979f5e4630`다. 실제 Auth 생성·로그인1회와 AI 준비까지 통과했으나 실행 직전 메모리 기준에서 거절됐다. 신규 안전 진단은 `PRELAUNCH_STARTUP_MEMORY` / `C_MEMORY_FLOOR_OR_DEADLINE`와 available1,019,872KiB·minimum1,048,576KiB·읽기339ms를 기록했다. 과거 C14 원인은 여전히 UNKNOWN이며 이번 직접 증거로 소급 확정하지 않는다. main Node/READY/AI 요청/동의 철회 NOT_RUN, 원 기준 완화0이다.

C15 신규4개 각1회 정상 STOP/Exit0/OOMfalse·최종 기존 inventory 보존은 EXACT_OWN4_CLOSED다. 전체 C 원 행 보존 최종 조건은 UNPROVEN으로 유지한다. `/private/tmp/yumidang-consent-C15-root-reviewed-20261013-v1/root-final.json` SHA `18e49799dbf6bbd2d7f982ef152054c3921a50b069e83013c02ae603b9a47521`, own-four-final SHA `5ddb35039ca1309498eb6af1dcad7928115bcc75715289240c6f39408ffcf5e5`다. C15 재시작/재실행은 하지 않는다.

다음 검증을 위한 기존 취소 경합 격리 DB 한 개의 다른 접속0을 읽기 확인하고 대상별 정상 중지 승인을 요청했다. 승인 전에는 해당 DB를 중지하지 않는다. 탈퇴 readiness와 원상 복원 연결 검토는 독립적으로 계속한다. 전체79%(22/28), 실회원HOLD·Storage39 실제 바이트·외부/운영 조건은 유지한다.


후속 실제 실행 준비는 A16 탈퇴와 C17 AI 동의의 서로 다른 신규 namespace로 분리했다. A16 creator handoff SHA `a5de7d81f49cd390652203bfff713b1d7a16df31c830fd0bccdc065e8b5ff6a9`, corrected caller SHA `5907325fb25844c89e3df496d2a67c04a9797e9bdf8e8c1243603332959df2e3`다. C17 creator handoff SHA `9510037dabab245024412cf62790ba017926534c9aea62d639d3b84c8d03a620`, caller SHA `735d9c92af4b895eb159e5bc3f98263c33874a4b30be6762d743c9447de211ba`다. 원 source7a47·122개 준비 파일·5개 소비 표시 부재·정적 해시 대응을 확인했다. 실제 대상 생성0이며 실제 증거/슬롯은 미바인딩이다.

readiness의 정확한5개 권한과 guard를 원 BEFORE 확인 뒤 한 번 부여하고, AFTER 또는 독립 finally에서 원 권한을 복구하는 순서는 독립 검토 PASS다. 응답 진단은 단조 시계와 await 전후·완료·반환 전 시간 검사를 추가해 늦은 done을 거절하는 신규 모형1개가 PASS했다. 기존8+6 모형은 보존하며 실제 탈퇴 성공으로 확대하지 않는다. 현재 진행률79%(22/28), 다음 실제 실행은 메모리 조건과 해당 승인 경계 충족 뒤 진행한다.


AI24 현재 소스 읽기 검토에서 signed Auth 연결 경로는 존재하지만 실제 검증은 NOT_RUN이다. 기본 보존 범위는 auth/public/private/storage의175개 테이블이며, lifecycle의6-schema178개 최적화와 구분한다. cron/vault3개 행의 전체 보존 증거로 확대하지 않는다. 원 허용 창은 초기 준비23:00~23:40, fixture 준비23:00~23:50와23:55까지 완료, 재개23:58 포함~23:59:55 미포함이다. 23:57은 준비/재개 창 밖이며 임의 변경하지 않는다. 새 현재 소스·6개 원 서명 세션·명시 선택3명·빈 당일 예산·영속 UNKNOWN·캡처/정리 바인딩이 필요하다. 추가 실제 검증은 아직 진행하지 않았다.


## 승인 대기 중 AI24 서명 계정 준비 구현

전체79%(22/28). 승인 대기를 전체 작업 중단으로 처리하지 않고, 기존 `tools/local/prepare_isolated_midnight.py`에 `build_signed_plan`을 구현했다. 원 서명 binding6명 중 명시한3명의 순서를 유지하고 DB ID/image·소스·6명 모두의 자정+300초 선언 만료를 검사한다. 계획에는 원 입력 경로/SHA·선택 ID만 넣으며 토큰·이메일·비밀키·승인 flags를 넣지 않는다. 영속 저장 직전 원 입력을 다시 읽어 hash/선택을 비교하므로 같은 ID의 토큰 변경도 저장 전에 거절한다. 기존 offline CLI·시간창·UNKNOWN·실행 권한 경계는 유지한다.

기존48+신규6=54개 시험은 agent0.256초·root 통합0.349초 PASS, 독립 peer 읽기 검토/소유권/staged/hook도 PASS다. 두 파일만 로컬 커밋 `37863a66e50467f707961a7036a6efae604cb6dc`로 고정했다. 푸시·운영·실제 회원·자정 실행0이다. source57 동결 SHA `9f1ecfe2aca67420c68d4e94dcbfbdcb7f70b5af7e69de1cd18c1b20ddcfaa7e`, 현재 AI24 계약 source58 읽기 확인 영수증 SHA `0f0cf87ed35416412264430eec239640c5ff46ce7c88a554bfdabcb6d49e82a3`다. 다음 A16/C17 패킷의 HEAD/해시 연결을 새 후속본에서 갱신한다. 기존 actual C15/A13 실패·중지 증거는 변경하지 않는다.


## A16 기준 충족 후 실제 검증 재개

전체79%(22/28). 추가 DB 중지 승인은 보류로 유지하지만 현재 메모리1,276,096KiB가 원 시작 기준1,048,576KiB를 충족해, 기존 승인 범위의 새 A16 clone을 한 번 생성했다. 이 실행은 추가 DB 중지 승인으로 간주하지 않으며 기존 컨테이너/VM/운영 변경0이다. 전체 native119 행178·권한/역할·실효 권한·sequence와 Auth/REST TLS 검증을 통과했다. created-proof SHA `ddda9ab216d501a3e1bd7de3b87a7bba547eaf45990067dd7a1de0f086d5790c`다. Auth 회원 생성0인 환경 준비 증거이며 실제 탈퇴/AI/운영 성공으로 확대하지 않는다. genuine5개 원 증거+credential을 새 runtime caller에 연결하며, 원300초와 이후 시작/유지 메모리 검사도 유지한다.


A16 실제 호출자는 PRODUCER의 `ORIGINAL_START_MEMORY` 조건에서 거절됐다. 원 조건은 정수 여유값>=1,048,576KiB와 읽기<=3초이며 실패 당시 값/시간이 기록되지 않아 어느 조건인지 직접 확정하지 않는다. producer sent=[]·Auth 생성0·readiness/탈퇴 API NOT_RUN이다. 신규4개 각1회 정상 STOP·기존 inventory 보존은 EXACT_OWN4_CLOSED이며 UNKNOWN없음이다. 원 gate를 캡처하기 전 거절돼 gate 복구/후속 비교 실패도 원 composite에 남아 있으며 전체 보존·물리/sequence 성공으로 바꾸지 않는다. A16 컨테이너·데이터·실패 증거를 보존하고 재시작/재실행하지 않는다. producer failure SHA `d22e915217d19b4d1071366203829515aaef5d57f065b3c4a8e9d8d4c403907f`, composite final SHA `f0c5d8d4c7aadb8c04a1bd03a5ec099f140ac7e257dfbca00c0564785516c729`, own-four-final SHA `9cc6e3d27a591f265897c74fe35057266e61ee8023b1cb4d6e6321f2a612f116`다. 전체79%(22/28). 같은 자원 조건의 전체 Auth 검증 반복은 보류하고, 별도 DB 동시성 검증 준비를 진행한다.


## SQL120 실제 동시성 검증 준비

전체79%(22/28). 현재119개 마이그레이션에 이미 포함된 SQL120을 재적용하지 않고, native119 원본 아카이브에서 새 격리 DB 한 개를 복원해 같은/겹친 메시지 읽음 경쟁을 검증하는 패킷을 동결했다. 원본 DB는 중지 상태를 유지하고 변경하지 않는다. 창작한 로그인 성공이 아니라 합성 SQL 인증 문맥의 DB 계약 검증으로 범위를 제한한다. 실제 Auth·REST·네이버·화면·Storage 바이트 성공으로 확대하지 않는다.

생성/복원/정리 모형12개와 동시성 모형3개 PASS, 실제 자원 호출0이다. 원300초와 시작1,048,576KiB/유지786,432KiB를 유지한다. 처음 복원한178개 원 행·역할·권한·sequence를 증거로 고정하고, 두 실제 PostgreSQL backend의 잠금 경쟁·중복 기록·최초 읽음 시각을 확인한 뒤 새 DB만 정상 중지한다. 자식 프로세스뿐 아니라 등록한 실제 DB 세션의 종료를 확인해야 중지할 수 있다. creator handoff SHA `16a637fc1e9fe9ad77b5b655874924390f477b9d356708bb0d605f6600d5dbe1`, driver handoff SHA `0ec157de6e27a38c3fa601095d44bf3760c96cf61dadd6b4ea1ab2bd0a5ca3b5`다. 실행 결과는 후속 기록에서 별도 판정한다.


SQL120-C18 첫 실제 시도는 원본 입력 검토의 `selected_helpers`가 캡처된 전역에서 `ast`를 찾지 못해 DB inventory/생성 전에 실패했다. DB 생성0·Auth 생성0·driver NOT_RUN·STOP0이며 실패 기록을 보존한다. 메모리 표본은 원 기준을 통과했지만 기능 성공으로 집계하지 않는다. prior inventory가 캡처되기 전에 실패해 final inventory 조건은 FAIL_UNKNOWN으로 남으며 완료로 바꾸지 않는다. 누락된 모듈 연결만 수정하고 원본 자료를 이용한 오프라인 dependency 검사 후 별도 실행 기록에서 재검증한다. 전체79%(22/28).


SQL120-C18v2는 도구 연결 교정 뒤 새 DB 한 개 생성/시작을 통과했지만 복원 SQL 전 `FULL_CONFIG_DRIFT`로 거절됐다. 생성 시 고정한 HostConfig SHA와 이후 읽기 SHA는 달랐으며, 원 값 복원 검산에서 `OomKillDisable`만 false로 되돌리면 정확한 원 SHA가 된다. 시작 뒤 관측값은 null이고 Config/Mounts SHA는 동일하다. 기존 해시는 이 한 필드의 관측 차이를 입증하며 변화의 주체나 일반적인 null/false 동등성을 확정하지 않는다. 임의 설정 변경을 허용하지 않고 새 실행에서 시작 직전/직후 전체 원자료와 정확한 한 필드 변화만 증명하는 후속 절차를 검토한다. 기존 실행은 실패/UNKNOWN으로 보존하며 성공으로 바꾸지 않는다. 새 DB `a5dbc902400edf6d27cc7f98b3148e24dee63264f4174ef51cf9e474cfc11ac4`는 1회 정상 STOP/Exit0/OOMfalse를 확인했고 재시작하지 않는다. 복원 SQL/Auth/driver는 NOT_RUN이다. 전체79%(22/28).


SQL120-C19 실제 검증에서 원본178개 행·31개 역할·권한·484096개 실효권한·4개 sequence 복원이 PASS했다. 같은 두 메시지/겹친 메시지의 서로 다른 PostgreSQL backend 잠금 경쟁과 최초 읽음 시간 보존, 숨긴 메시지 PT404의 무효과도 PASS했다. 마지막 전체 보존 검사는 합성 데이터의 trigger가 만든 메시지 generation6개·대화 retention generation1개·알림1개를 소유 범위에서 누락해 `SQL120_ORIGINAL_NONFIXTURE_ROW_CHANGED_DURING_SEED`로 실패했다. 따라서 전체는 FAIL_UNKNOWN_NO_REPLAY로 보존하고 기능 전체 완료로 집계하지 않는다. 당시 최종 native snapshot은 검증 전 영속 저장하지 않았으므로 최종 전체 비교 성공으로 추정하지 않는다.

등록된 실제 PostgreSQL backend가 모두 종료됐고 새 DB만 정상 중지됐으며 EXACT_OWN_DB_CLOSED·UNKNOWN0다. C19 DB/실패/부분 PASS 기록을 보존하며 재시작하지 않는다. 후속에서는 이3개 테이블의 정확한 테스트 request/message/recipient 범위만 추가하고 원본 비소유 행과 나머지 테이블 비교는 유지한다. 실패 원자료 보존을 위해 최종 snapshot/행/소유 bag도 검증 전에 저장한다. 실제 Auth·네이버·화면·Storage 바이트/운영 검증은 별도이며 전체79%(22/28)다.


## SQL120-C20 실제 DB 동시성 최종 PASS

전체79%(22/28), 이번 세부 검증은 `PASS_SQL120_DATABASE_CONCURRENCY_ONLY`다. 원본178개 행·31개 역할·484096개 실효권한·4개 sequence 복원, 서로 다른 PostgreSQL backend의 같은/겹친 메시지 원 RPC 경쟁, 최초 read_at 보존, 숨긴 메시지 PT404 무효과를 실제로 통과했다. 정확한 테스트 범위18개 테이블의 원 비소유 행과 나머지 원 테이블 전체, rawACL/실효권한/역할/catalog/sequence·예산·UNKNOWN 보존도 PASS다. 최종 원자료를 검증 전에 저장했다. 모든 등록 DB backend 종료와 새 DB 한 번 정상 STOP, 기존 inventory 보존까지 EXACT_OWN_DB_CLOSED/UNKNOWN0/실패0이다.

이 성공은 합성 SQL 인증 문맥의 실제 DB 계약 검증이다. 실제 GoTrue Auth·REST·네이버·화면·Storage 바이트·실회원·운영 검증 완료로 확대하지 않는다. C18/C19 실패 기록은 보존하고 재시작하지 않는다. 증거 디렉터리는 `/private/tmp/yumidang-sql120-c20-runtime-v1`이며 최종 SHA와 범위는 현재 coverage JSON의 actualSql120C20에 연결했다. 추가 마지막 항목의 화면 소비/현재 HTTP·외부 조건 등이 남아 분모28·완료22를 유지한다.


## 현재 실행 조건 재확인

전체79%(22/28), 직전 C20 실제 DB 동시성/보존/정리 PASS는 세부 완료로 기록했다. 과거 A8 prerequisite의 “격리3개 중지 승인 대기” 문구는 이행된 승인과 충돌하므로 역사 필드에 보존하고 현재 조건으로 교체했다. 기존3개 승인/중지는 완료됐으며 재요청·재실행하지 않는다. 현재 추가 대상 cancel-race78 한 개만 별도 승인 대기다. 새 VM 메모리 읽기1,292,464KiB/889ms/Swap0은 원 시작 기준을 통과했지만 전체 Auth 환경 생성 후 producer 시작 조건 성공을 증명하지 않는다. 현재 Auth/AI 경로·자연 자정·화면 소비·외부 조건·실회원HOLD·원 Storage39 바이트·운영 조건은 각각 남는다. 승인 대기를 다른 독립 작업의 중단 근거로 사용하지 않는다.


## C17 실제 Auth 연결과 원 시작 기준 거절

전체79%(22/28). 미사용 C17을 한 번 실행해 합성 native119 원본 DB/역할/권한/sequence 복원과4개 실제 서비스 준비를 통과했다. 현재 합성 native119 원본 Storage 행은0개이며 과거 SQL108의45개 metadata/실제6파일·누락39바이트와 다른 범위다. 원본 전체 복원 표현은 합성 native119 범위로 제한하고 운영 전체 백업으로 확대하지 않는다.

새 합성 Auth 회원1명 생성/원 로그인 영수증을 확보했으나 Node 실행 직전 읽기1,027,304KiB/253ms가 원1,048,576KiB에 미달해 거절됐다. Node childLaunchAttempted=false, READY/AI/no_results/동의철회 NOT_RUN이다. 원 Auth/행 전체 보존은 UNKNOWN_NOT_PROMOTED이며 원 C 실패와 closure 실패를 유지한다. 신규4개 각1회 정상 STOP/Exit0/OOMfalse와 기존 inventory 보존은 EXACT_OWN4_CLOSED/UNKNOWN0이다. C17은 재시작·재실행하지 않는다. 현재 누적 실제 Auth 생성5명은 각 합성 격리 시도 범위이며 실제 서비스 기능 전체 완료 수를 뜻하지 않는다. 다음 동일 Auth 실행은 자원 조건이 실제로 바뀐 뒤 검토한다.


## 원 SQL108 Storage45 실제 메타데이터 확보

전체79%(22/28). 원 SQL108 백업 source.dump의 고정SHA를 stdin으로 전달한 read-only/network-none/64MiB 전용 pg_restore 유틸리티에서 DB 연결 없이 객체 데이터45행을 추출했다. 14열/45행 구조와 실제 파서8개 회귀/독립 검토를 사용해 bucket/name/version 등6필드의45개 객체 목록을 비공개 파일에 저장했다. 실 파일 바이트 복구는0개며 새 합성 native119의Storage0·운영Storage2와 구분한다.

유틸리티·자식 종료/Exit0/OOMfalse와 입력 source/해시 검사 후 최종 prior 비교가 UNKNOWN으로 남아 전체 reader는 FAIL_UNKNOWN을 보존한다. 현재 읽기 재확인에서 기존8개 컨테이너의 mount SHA만 달랐으며, current Mounts 전체 항목을 순서만 바꿔 각각 정확한 원SHA를 재구성했다. 원 항목의 내용·수·속성 변경으로 추정하지 않으며 원 실행을 소급 PASS로 바꾸지 않는다. 미래 비교는 전체 mount 항목을 canonical 정렬해 순서만 제외하도록 보완한다. 실제export/파싱 증거는 coverage의 actualStorage45MetadataExport에 연결했다. 원6실파일과의 정확한 대응 및 누락39 원본 바이트는 다음 조건이다.

## 원본 파일 경로 대조 완료

전체 **79%(22/28)** 유지. SQL108 Storage 메타데이터45개와 보존된 원본 파일6개를 정확한 Storage103 OCI 배포 코드의 경로 규칙으로 대조해 모두 매칭했다. 실제 바이트가 없는39개 비공개 목록을 고정했다. NULL version은 접미사가 없고 실제 버킷 접두사를 포함하는 원 규칙을 적용했다. 경로 추측과 회원 객체 경로 공개는 하지 않았다.

매칭 영수증: `/private/tmp/yumidang-original-storage45-mapping-final-qmrwc92x/receipt.json`, SHA256 `348824ecfc55daed238f8c3e322c9b50b2f30f526e79e5f4d0f0869beec5fa0e`. 누락39 목록 SHA256 `8c822c58f65426f1b724d86165e249f0f7aff50e3ed4197de4b5682cfa03ef5a`. 실제39개 바이트 복구는0이고 전체 복원은 미증명이다. 앞선 config-only 이미지 불일치 결론은 OCI index → platform manifest → config 체인 확인으로 정정했으며, 이전 매칭 실패와 전체 reader FAIL_UNKNOWN은 보존한다. 독립 검토에서17개 파일 고정값, OCI14개 레이어·diffID와40개 whiteout, 최종10개 배포 코드, 원45개 경로와6개 바이트 해시를 별도로 확인해 PASS_OFFLINE_MAPPING_ONLY를 받았다. 39개는 보존된 tar에 없는 객체의 정확한 보수이며 외부 저장소 전체에서의 부재를 증명하지 않는다.

지정된 마지막 미검사 후보인 v2 삭제 전 백업을 안정 FD로 읽기 확인했다. 정규 파일7개 중 원본6개는 경로·바이트 해시가 모두 일치했고 누락39개 경로와 교집합은0이다. 추가1개는 원본으로 승격하지 않았다. 후보 영수증 SHA256 `110d8fb4ffc4c5ab92d5bf860f033095488b3d235b87fb15156b931522e85e2d`, 위치 `/private/tmp/yumidang-storage39-v2-candidate-62fyp3a7/receipt.json`. 원 파일 변경·추출·네트워크·컨테이너 호출0이며 누락 바이트 확보0이다. 추가 원본 저장소의 위치 또는 원39개 바이트가 필요하다. 전체79%(22/28)는 유지한다.

## 승인된 cancel-race78 정상 중지와 Auth 재개

전체 **79%(22/28)** 유지. 사용자가 정확한 한 개 DB 정상 중지를 승인했다. ID·이미지·시작 시점과 다른 client backend0개를 재확인하고 stop1회, ExitCode0·OOMfalse·컨테이너 및 데이터 보존을 확인했다. 중지 영수증 SHA `1d4f499de4ff1fa96606cee841fc194f1c4e988ae1fc332f1bf4cd8ee8ace49c`. 기존 중지 승인 대기는 충족됐으며 재질문하지 않는다.

중지 후 VM MemAvailable1,375,428KiB·swap0을 읽기 확인했다(SHA `546fa4e8610e6e366589519fafe75bd7594c529f0978177e58a836d4cbd80881`). 새 격리 Auth/AI 준비를 재개한다. 원 시작/실행 메모리 기준과 기존 실패·UNKNOWN·실회원 HOLD·원본39바이트·공급사·운영 승인 경계는 유지한다.

## C21 실제 Auth·AI·공개 동의 철회 통합 PASS

전체 **79%(22/28)** 유지. 새 C21 환경의 실제 로컬 Auth 신규 합성회원1개와 제품 AI factory·HTTP Auth·PostgREST/RPC를 연결했다. 결과 없음 응답1개, 합성 모델1회, 예산 예약의 실제 전송·정산, 공개 철회1회가 통과했다. 같은 원 토큰의 철회 후 요청은 consent_revoked로 거절되며 예산 예약0·모델 호출0이다. 원 Auth·행·UNKNOWN과 소스/이전 자원 보존 및 새4개 정상 중지1회씩 ExitCode0·OOMfalse가 최종 통과했다.

원 기준의 시작 메모리1,124,792KiB와 실행 기준을 유지했다. 최종 영수증 SHA `b60f79f1117af8d0718a42d2e37cde889176a46aa497b0198ecfc599d582bfa9`, 위치 `/private/tmp/yumidang-consent-C21-root-reviewed-20261013-v1/root-final.json`. 공개 철회 영수증 SHA `4c0972e853d88447b718b8957269f44222402a1b8a736aa7334e72f7496efa37`. 독립 actual 검토도 PASS_C_SIGNED_CONSENT_ONLY다. 원178개/효과 후·복구 후 예산/UNKNOWN 보존은 고정된 성공 코드와 최종 영수증으로 확인됐으나, 두 사후 전체 데이터 파일을 별도로 보관하지 않아 독립 전체 사후 비교로 확대하지 않는다. 자식 그룹·스트림 종료와 원4개 STOP/Exit0/OOMfalse, 메모리46개 샘플은 독립 대조했다. sequence/물리 바이트는 이 검증에서 미확인이다. AI22·AI23·자연 AI24·물리 응답 유실·서비스 탈퇴·실회원·실제 공급사는 NOT_RUN이며 이번 통과로 대체하지 않는다. 누적 Auth 생성6개는 별도 실행의 합계로서 AI24용 실제 서명6세션 준비 완료를 의미하지 않는다.
