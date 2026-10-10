# 검증 해시에 결합한 기본 닫힘 운영 launcher 준비안

2026-10-10. 작업자 `minkyu`. foundation의 현재 준비 도구와 runtime을 읽은 기술 제안이다. 도구·제품·SQL 수정, Docker·DB·운영 변경은 없다. 합성 PASS는 공급사·실회원·운영 활성화 승인으로 변환하지 않는다.

후속 상태: 이 설계 작성 뒤 SQL119의 격리 DB·실제 소비자 오프라인 검증이 PASS하여 정확한 해시로 준비118 목록에 등록했다. 아래의119 미등록 설명은 설계 당시 상태다. 공개 공고 RPC·HTTP·실제 공급사와 운영 검증은 계속 별도이며 [실행 기록](2026-10-09-backend-execution.md)의 최신 결과를 따른다. 선택적인 closed artifact 구현은 별도 worktree에서 진행 중이다.

## 현재 계약과 준비 도구의 빈 부분

`tools/local/prepare_production_backend.py`는 읽기 catalog 비교, 검토 SQL 해시, working-tree 제품 소스 목록, offline 환경 구문 검사를 private JSON에 저장한다. `activationAllowed:false`, `operatingChanged:false`, 입력 catalog 수집 시점 미검증을 유지한다(30~40, 43~61, 99~133행). 현재 실제 소스 복사, launcher 생성, actual receipt 검토·일치 판정은 없다. 제품 목록은 전체 함수의 ts/mjs/json과 package/lock/config이며 launcher/runtime의 정확한 import graph 및 설치된 npm dependency 검증과는 다르다.

`runQueueRunnerCli`는 stock CLI와 서버 launcher가 공유하는 실제 진입점이다. trustedAssembly 허용 key는 `review`, `existing`, `safety`, `memberParentFinalization`뿐이고, 구성에서 기대한 kind 목록과 runtime.supportedKinds가 다르면 시작을 거절한다(`queue-runner.mjs` 330~378행). 환경/HTTP/JSON이나 임의 모듈 경로에서 승인 값을 가져오지 않는다. 기존 preflight·DB client·LISTEN·ready·SIGINT/SIGTERM·stop 경로를 재사용해야 한다.

stock 기본값은 다섯 업무 lane과 SQL118 scanner를 자동 승인하지 않는다. 다만 실제 DB 영속 유지관리 provider를 포함하므로 `runQueueRunnerCli()` 또는 빈 trustedAssembly 호출을 “모든 DB 요청과 mutation이 없는 닫힌 preview”로 표현하면 틀리다. 준비 산출물은 CLI 호출 이전의 명시적 닫힘이 필요하다.

## 지금 준비할 concrete artifact

기존 도구의 기본 JSON 출력 계약을 보존하고, 후속 구현에서는 명시적인 새 private artifact 디렉터리를 요청할 때만 다음 세 가지를 추가하는 최소안을 권한다. 이미 있는 결과를 덮어쓰거나 준비 중 네트워크·DB·npm 설치·서버 시작을 하지 않는다.

1. 기존 읽기 선택기를 재사용해 복사한 `backend/` 실행 소스와 package/lock/config. runtime의 고정 동적 import(`../_shared/jobs/runtime.ts`)와 고정 dependency `pg`까지 manifest에 표시한다. 상대 import가 snapshot 밖으로 나가거나 symlink·숫자 사본·누락·임의 동적 모듈을 만나면 거절한다. 저장소 원본 절대경로를 import하는 launcher는 검토 이후 소스가 바뀔 수 있어 허용하지 않는다.
2. `queue-launcher.closed.mjs`. 같은 bundle 안의 고정 상대 `queue-runner.mjs`에서 `runQueueRunnerCli`를 import한다. 실행 승인 scope는 코드의 literal `null`이다. 명시적인 start 함수 호출도 고정 오류 `PRODUCTION_SCOPE_NOT_APPROVED`로 종료하고 CLI·환경 secret loader·DB 연결 이전에 멈춘다. import만으로 서버나 타이머를 시작하지 않는다. `--activate`, 환경 boolean, 승인 JSON, `--module` 같은 우회 진입점은 없다.
3. `launcher-manifest.json`. 소스 graph/전체 제품 snapshot, 정렬된 실제 SQL 목록과 SHA, package/lock SHA, 준비 도구·검사기·template SHA, 검토된 receipt index SHA, remote history/catalog 입력 SHA, sourceHead와 working-tree 여부, launcher byte SHA를 연결한다. 상태는 `PREPARED_CLOSED_NOT_APPROVED`, 모든 lane·scanner는 `NOT_APPROVED`, execution/DB/deployment/실회원/공급사 품질은 `NOT_RUN`, activationAllowed는 false다. 비밀·DSN·JWT·원문·provider key는 넣지 않는다.

위 artifact는 복사된 고정 코드와 최소 manifest를 통해 검토 가능하며, 지금은 실행되지 않는다. launcher에 존재하는 CLI import는 동일 제품 경로를 사용하기 위한 준비이지 실제 CLI PASS가 아니다. 닫힘 branch의 모델 검증에서 CLI 호출·DB/fetch/환경 secret 접근0을 증명한다.

해시 순환을 만들지 않는다. 우선 source/sql/receipt/catalog/template/closed scope로 `bindingSha256`을 계산하고 launcher에 그 고정값을 넣는다. 마지막 manifest에 launcher SHA를 추가한다. launcher SHA를 다시 binding 입력에 넣지 않는다. approval code는 JSON manifest를 읽어 trustedAssembly로 변환하지 않는다. 해시는 바이트·출처 결합의 근거이며 운영 승인 서명 또는 변경 권한이 아니다.

## receipt를 최종 source/SQL에 묶는 방법

실행 검증의 일반 `status:PASS` JSON이나 사용자가 지정한 임의 receipt 경로만 믿으면 안 된다. 검토자가 확정한 증거 종류·recipe revision·파일 SHA의 정적 목록을 준비 코드에서 선택하고, 각 actual run의 선행 source/migration manifest·하네스 SHA·receipt·close/source 불변 증거를 함께 읽는다. private regular file·소유자·700/600·중복 없는 exact schema·관계된 digest를 확인한다. fixture 승인 literal을 운영 승인 literal로 복사하지 않는다.

각 증거에는 actual/synthetic/model/NOT_RUN scope를 유지한다. receipt가 단독으로 source SHA를 갖지 않으면 해당 run의 `safety-apply-started.json`, run-source, 준비 manifest 등의 해시를 index에 묶어 provenance를 보강한다. 안전 워커 하네스는 실제로 source graph와 migration hashes를 별도 저장하고 fixture 전에 다시 대조한다(`worker_safety_http_local.py` 381~418, 536~539행). 그 파일까지 함께 고정하지 않은 receipt 단독은 전체 제품 증거가 아니다.

현재 제품의 모든 파일과 모든 과거 receipt가 동일할 필요는 없지만, 특정 PASS를 재사용하려면 그 시험의 전체 의존 graph·SQL 바이트가 final bundle과 exact 일치해야 한다. 변경이 있는 범위는 `STALE_NEEDS_REVALIDATION`; 독립 범위는 기존 graph 일치로 유지할 수 있다. 준비 도구가 파일 존재·개수·최신 날짜만 보고 새 소스에 PASS를 전승하지 않는다. 최종 5종/공개 탈퇴 actual은 진행 중인 범위이므로 지금 준비 문서에 최종 PASS를 발명하지 않는다.

SQL118은 현재 준비 목록에 들어가 있으나 개념119 행사 투영은 별도 검토 중이다. 현재 목록을 숫자119까지 자동 확장하지 않는다. 최종 런타임이 의존하는 검토 SQL이 정확한 목록에 없거나 해당 actual 증거가 아직 없으면 그 기능은 준비 또는 승인 보류다.

## 운영 승인 후의 고정 서버 코드 scope

운영 배포·DB/ACL/guard 전환과 lane 활성화는 이 준비물의 후속 승인 대상이다. 사용자가 실제 기능 범위·공급사 조건·실회원 검증 및 운영 전환을 승인한 후 M 서버 초기화 코드에 reviewed literal trustedAssembly를 작성하고 새 소스/launcher/manifest SHA를 고정한다. 준비 도구가 approved:true를 생성하거나 같은 closed SHA를 운영 승인 SHA로 재사용하지 않는다.

고정 코드에는 승인한 kind만 들어간다. review_summary는 실제 모델·원문/보관 조건·검사기·모델/프롬프트 버전·실제 budget 증거가 필요하다. event_sync는 실제 공급사 범위와 해당 projection/filter SQL·transport가 필요하다. member_cleanup/report_retention은 실제 Storage/Auth 대상·guard·권한·원 ACK/UNKNOWN/복구 경계가 필요하다. cancellation_safety도 DB114 guard/ACL 및 실행 경계가 필요하다. 공급사·계정·비용·공동 이용·법적 보관 조건이 미정인 lane을 합성 local 결과로 운영 승인하지 않는다.

memberParentFinalization은 별도 최소 scope다. 승인된 경우에만 SQL118→get/complete/get RPC를 호출하며 원 UNKNOWN을 원 stored proof로 닫는다. 이것은 새로운 task 복구·DELETE·ACK·lease 허가가 아니다. scanner만 포함하고 업무 kind를 비워도 기본 유지관리 provider가 남으므로 전체 실행 효과와 운영 DB 권한 범위를 별도로 검토한다. scanner flag를 넣었다는 이유만으로 “read-only runner”라고 부르지 않는다.

운영 launcher는 snapshot의 같은 `runQueueRunnerCli({trustedAssembly:고정literal})`만 호출한다. 검증 전용 dependencies/fetch rewrite/ports/model stub·임의 import 옵션을 노출하지 않는다. 정상 환경 변수는 기존 URL/credential/timeout 설정으로만 사용하며 승인이나 지원 kind의 원천이 아니다. 실제 host의 Node는 backend/package.json의 `>=22.18.0`, pg는 package-lock의 `8.22.0` 설치 무결성을 별도로 확인한다. dependency 설치/운영 기동은 준비 단계에 섞지 않는다.

## 실제 decisionId·max/time binding

| 항목 | 현재 소스 계약 | 운영 코드에서 확인할 점 |
| --- | --- | --- |
| 공통 decision | WORKER_QUEUE_DB_CONTRACT_ID는 ASCII 허용 문자1~128. runtime ports와 각 lane decisionId는 exact 일치 | 문자열 일치는 승인 출처를 증명하지 않음. 승인된 고정 literal과 env 값을 비교하며 서로 다른 decision 자동 덮어쓰기0 |
| review_summary | lane 최대 job1~10, time1~60000ms | 실제 worker/model/safety 조립과 DB CAS 입력을 함께 고정 |
| event_sync | lane 최대 job1~10, time1~60000ms | 실제 event factory의 stored request/global/kind/limit/remainingMs exact 확인 보존 |
| member_cleanup | lane 최대 job1~10, runtime 허용 time1~180000ms | 기존 합성 assembly의120000ms는 검증 fixture 설정이며 새 운영 정책이 아님. 승인된 서버 factory limit/time과 같은 scope로 더 좁힘 |
| cancellation_safety / report_retention | job1~10, time1~60000ms. scopedClaim/sharedBudgetContract/durableJournalContract와 종류별 guard/ACL 필요 | report는 terminal schedule·Storage 승인 필요. retry는 기존 validator와 의미 있는 actual 검증에 결합. readiness 누락을 성공으로 낮추지 않음 |
| memberParentFinalization | decision exact, maxExecutionMs1~60000ms. page20/최대2pages/전체RPC20 | scan 전송 상한은 global job20과 별개. GET proof·원 scope 보존·cancel/서버기한 유지 |
| 공통 실행 | 실제 global180초, 고유job20. allocate는 remaining slots/time과 승인 상한의 min | launcher에서 새 슬롯·token·시간을 만들어내지 않음. 유지관리는 provider별 별도20과 같은 global시간 사용 |
| transport | CLI HTTP timeout1~75000ms, query timeout1~10000ms, TLS verify-full | HTTP timeout은 실제 execution의 안전한 완료 증거가 아님. 더 짧은 timeout은 UNKNOWN을 남길 수 있어 기존 same-ID stored 조회·재전송0 증거 필요 |

근거는 runtime.ts 109~154, 170~175, 288~312행, queue-runner.mjs 37~90행, background.mjs 305~359행, db/member-cleanup-finalization.ts의 scanner 계약이다. 최초 prepare/get/dispatch CAS는 request/global/kind/limit/remainingMs exact 비교와 all-or-none 네 worker header·body `{}`를 유지한다. HTTP 응답 ran/not_enabled를 저장 completed 대신 사용하지 않는다. 원 UNKNOWN을 expiry만으로 dispatch하지 않는다.

member 서버 handler는 shared 입력 최대10/180000ms와 DB exact binding을 검사한다. 내부 lifecycle drain의 legacy 기본 limit20과 global180초가 있으므로 legacy 기본을 운영 회원 배정으로 대신하지 않고 명시 factory limit/time과 shared 배정을 사용한다. task 단위60초와 lane batch/global 기한은 다른 경계다. 한 숫자를 다른 계약의 최대치로 표현하지 않는다.

## 후속 구현·의미 있는 검증 범위

M 준비 도구와 기존 M `test_production_preparation.py`에 선택적인 closed artifact 기능을 추가하고, 기존 runtime 구성/CLI 회귀를 재사용한다. 최소 검증은 missing/stale source/SQL/receipt 거절, 미정 provider 승격0, symlink/외부경로/중복/기존 output 거절, secret 원문 출력0, source가 준비 중 바뀌면 거절, closed 실행의 CLI/DB/fetch0, JSON/env 승인·임의 모듈 우회0, manifest/launcher 바이트 결합이다. 현재 offline syntax 검사만 통과해도 TLS handshake·실권한·product CLI·공급사 승인은 NOT_RUN이어야 한다.

운영 승인 후에는 고정 literal의 wrong decision/상한초과/미준비 kind 거절, exact approved subset, 실제 factory와 runtime의 limit/time 일치, 두 CLI 경쟁·중단·UNKNOWN 재시작·주기 유지관리·원 ACK 복구·SQL118 자동 종결을 승인된 운영 scope에서 검증한다. 최종 backup/restore, fresh 운영 history/catalog/ACL 비교, Railway 시작 명령/secret/cron 전환과 실제 최소 권한/TLS 확인은 준비 manifest만으로 완료하지 않는다. 사용자의 실회원 “지금 안함” 결정과 공급사 보류는 유지한다.
