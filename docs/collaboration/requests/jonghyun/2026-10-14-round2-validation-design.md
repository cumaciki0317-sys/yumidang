<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **AI 선택 동의:** AI 탐색은 첫 사용 동의·거절 시 일반 검색 유지. 후기 AI는 가입 시 열람/내 프로필 생성·노출/작성 후기 활용의 세 선택 항목·기본 미선택이며 전체 동의 편의 기능과 독립 철회를 제공한다. 기존 테스트 계정 간주와 실회원 동의 증거를 구분한다.
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# 두 번째 한시 지원·잔여 실제 연결 검증 설계 — 2026-10-14

전체 **79%(22/28)** 유지. 사용자가 두 검증 도구만 다시 한시 재배정하는1번을 승인했다. 기존 VM/새 합성 검증 승인도 유지하며 제품 정책·민규 나머지10개 예외·성호 화면·원본 공유 clone·기존 자원·실회원/공급사/운영/외부 메시지로 확대하지 않는다.

## 담당·원본과 현재 지원

별도 AI 민규 정책 관리 clone `/private/tmp/yumidang-minkyu-policy-round2-20261014`에서 backend/ownership.json 한 파일만 정책 커밋 `06e95bafb16de96bd7c7fdca81a84f5db3109d0c`로 변경했다. 사람 민규가 작업했다는 증거로 쓰지 않는다. parent는 ad08baf이고 두 exact rules와 이번 승인 범위 기록만 바뀌었다. 다른 rules·protected_paths·version·이전 재배정·hook을 보존했다. 종현 clone에서 clean index를 확인한 뒤 로컬 fetch/FF로 받았고 두 경로의 jonghyun 검사를 통과했다. 기존 종현 제품/문서 작업본은 유지한다.

- Root 단독: `tools/local/run_database_tests.py`, `tests/database/jonghyun/test_preserved_resource_guard.py`, `test_isolated_database_runner.py`, 이 문서와 자기 기록.
- ai_design 단독: `tests/integration/jonghyun/isolated_ai_contracts.py`의 지원 패치. 앞서 작성한 Node member driver와 시험은 쓰기 종료 상태다.
- event_design 단독: `tests/integration/jonghyun/member-root-boundary.py`, `tests/database/jonghyun/test_member_root_boundary.py`의 J09 v2 원 Storage 생성·새 Auth/제품 RPC·행/권한 원복 검사. Root는 별도 생성 도구와 자기 시험만 편집한다.
- progress_audit은 지원 도구와 원 서명/이력 경계 읽기 검토다. 원본 도구를 실행하는 것과 archive를 직접 import해 검사 우회하는 것은 다르다. 이번에는 승인된 현재 경로에 검토된 지원 내용을 적용하고 관련 책임 검사를 수행했다.

원 HEAD 도구2개의 바이트·SHA를 canonical 비공개 루트 `/private/var/folders/h7/6qzd7cp553q1qwhk592yhvs80000gn/T/yumidang-jonghyun-round2-baseline-20261014-ola0he1i`의700디렉터리/600파일로 보존했다. 키·회원 자료는 없다. 원본 SHA는 각각 `5e848bc7a52cadb9409b3e487b00107944613dceb8d5ff8f11ca77d41bb54d49`, `04c68bb41214e3cf865637094fdc409cd901eaa8b0c31d1f0392d0979862ad8d`다. 최종 원복은 이 원 바이트를 기준으로 한다.

지원은 기존 빈 환경 계약을 유지하면서 명시v2 기존 목록·메타데이터·비공개 입력핀을 전후 비교한다. OS canonical 임시 부모·700/600·단일 링크/FD 동일성·원 Auth6의 session/password AMR·정확한 중복 행 hashbag을 검사한다. 고정 native119 원 증거/상수와 서명 검증 정의는 바꾸지 않는다. 새121개 migration은 현재 manifest/적용 이력·각 SHA 집합으로 별도 검증하며 과거 native119 결과로 대체하지 않는다. 새 root에 native119-runtime-provenance.json이나 그 비공개 자료를 복사하지 않고 일반 SUPABASE_DB_HISTORY 경로로121개 적용 이력을 검사한다. 고정119 provenance가 존재하면 새121집합은 거절되며 이를 완화하지 않는다.

Root는 `run_current_ai`의 고정 후보에 새 `ai_result_state.sql`, `operator_receipts_retirement.sql` 책임2개를 추가했다. 기존5개 후보의 트랜잭션 의미를 보존하고 새2개는 HEAD의 정확한 바이트가 있어야 실행된다. 부분 pair와 rollback 표기 누락은 준비 단계에서 거절한다. 이 표기 검사는 범용 SQL parser나 임의 입력의 안전 판정이 아니다. 실제 후보는 검토·커밋된 고정 파일만 사용한다.

현재 무외부 모형/회귀 결과:

- 기존 자원 보존·경로/AMR·일괄 조회 책임 **16/16 PASS**.
- 기존 새 DB 준비 거절/SQL 분리와 신규2후보 pair 책임 **8/8 PASS**.
- 기존 민규 이름의 signed-auth 시험에서 ProvisioningFunctionTests·NativeSignedHistoryTests·NativeSignedHistoryV2Tests **32/32 PASS**. 민규 예외 시험을 수정하지 않았다.
- 최종 Node J09 v2 **20/20 PASS**, Root v2 연결 **54/54 PASS**. 실제 Auth/Storage 삭제는 실행하지 않은 합성 검사다.
- 새 자원 생성 도구 책임 **8/8 PASS**. 기본 CLI는 NOT_RUN이다. 기존 자원 변경·불완전/다른 자원 추가·PID 기록 실패/생성 중단·포트/프로젝트 충돌을 거절한다.
- 도구2의 현재 코드는 아직 로컬 커밋 전이다. 새 소스 전체 고정/실제 실행 준비 완료를 이 부분 검사로 주장하지 않는다.

## 현재 VM 읽기 관찰

2026-10-14 10:56 KST에 승인된 `jonghyun-backend100`만 읽기로 조회했다. 기본 sandbox 호출은 Colima 접근 불능/소켓 permission denied여서 VM 정지 증거로 쓰지 않았다. 같은 읽기 명령을 승인 검토를 통과한 외부 경계에서 재확인해 macOS Virtualization.Framework·aarch64·Docker 실행 중과 기존 프로젝트 `jonghyun-backend100-077eabaa`의 컨테이너6개 실행을 관찰했다. 재시작/컨테이너 변경/기존 DB·Storage 읽기는0이다. 이 관찰은 새 대상 생성 승인이나 현재 저장 바이트 검증이 아니다.

## 검증 순서와 완료 기준

1. 종현 소유의 AI GET/내부 RPC·J08 100개 경계·J09 v2 완료/ACK 없음 연결과 원복 계약을 준비하고 관련 합성 검사를 마쳤다. 실제 completed는 새 대상 실행 증거를 얻을 때만 판정한다.
2. 검토된 변경만 로컬 커밋으로 고정하고 현재 HEAD/source closure/SQL121개·도구SHA를 새 실행에 묶는다. 이전27개 승인으로 새 제품/시험 변경을 자동 커밋하지 않는다. 기존 VM 승인은 재질문하지 않는다.
3. 실행 직전 VM identity·자원 여유·기존 전체 목록/설정과 실제 슬롯을 다시 관찰한다. 새 target의 DB/Auth/REST/gateway뿐 아니라 Storage의 원 생성 ID/Image/설정/마운트와 새 network/volume을 정확히 결합한다. 기존 자원의 접속·중지·수정은 없다.
4. 빈 새 target에서121 SQL 적용/이력/closed guards·새SQL2 책임을 확인한다. 새 원GoTrue6 발급/AMR/binding/영수증을 만든 뒤 필요한 최신 행사·요약·AI 상태 GET/평가·읽음 경계를 검증한다. 변경 영향 없는 과거 PASS를 재작성하지 않는다.
5. 별도 새 owned scope에서 직원 권한 회수/원키 replay·재승인 차단/다른직원 보존/원3영수증·시계, 두세션40001 경합, 캡처 Storage ACL/감사/파기를 확인한다. rollback SQL 후보를 실제 직원 workflow/Storage 완료로 확대하지 않는다.
6. 해당 scope에서 필요한 조회가 끝난 뒤에만 Auth hard delete를 포함한 마지막 탈퇴를 수행한다. 다음 J09 두 경우는 별도 새 target에서 순차 실행한다.
7. 자식 프로세스 종료·원 생성 영수증에 맞춘 새 자원만 정리·기존 보존 대조를 마친다. 실패/UNKNOWN/영수증을 지워 성공을 만들지 않는다. 두 도구 원 바이트 원복·정확 SHA/로컬 복구 커밋 확인 후 정책 관리 단계에서 민규 담당 복귀를 끝낸다. 실제 잔여 목록을 마치기 전에 한시 주기를 먼저 종료하지 않는다.

## 새 대상 생성과 초기 자동 작업의 경계

`tools/local/start_owned_validation.py`는 기본 실행을 하지 않으며, 실제 실행은 고정 CLI2.116.0 원 바이트·현재 커밋 소스·121개 SQL 사본·설정 overlay·기존 전체 자원을 확인한다. 시작 직전 프로젝트 이름/라벨, 기존 Docker 포트, VM TCP/TCP6 listen, host IPv4/IPv6 임시 bind로 포트 충돌을 거절한다. 포트를 CLI 시작까지 예약하는 방식은 아니며 실제 순차 슬롯과 시작 직후 상태를 다시 확인한다. 원 생성 명령/발급 PID/비공개 로그와 전후6개 container·1개 network·2개 volume을 저장하고 Storage 생성 영수증을 별도로 결합한다. PID 저장 실패나 중단 시 그 명령에서 발급한 자식 그룹만 종료하며 자원 생성 결과는 별도 관찰한다.

현재 고정 CLI의 [DB 설정](https://raw.githubusercontent.com/supabase/cli/v2.116.0/apps/cli-go/pkg/config/db.go)·[PostgreSQL 시작](https://raw.githubusercontent.com/supabase/cli/v2.116.0/packages/stack/src/services/postgres.ts)·[초기화](https://raw.githubusercontent.com/supabase/cli/v2.116.0/packages/stack/src/services/postgres-init.ts)에서 최초 SQL 적용 중 cron OFF를 보장하는 설정을 찾지 못했다. 지원 근거 없는 설정이나 SQL 사본을 추가하지 않는다. 로컬 seed는 비활성이고 원121개에 등록된 cron은 새 빈 DB의 동행 자동 완료1개다. **초기화 중 OFF와 cron 실행0은 미입증**으로 기록한다. 생성 직후 원 생성 ID에 맞는 신규 DB에만 OFF 설정·reload를 적용하고, OFF·합성 계정/fixture/작업0·외부 guard 닫힘·실행 cron worker0을 실제 확인한 뒤 기준 상태와 본 검증을 진행한다. 기존 DB의 설정·행·Storage는 읽거나 바꾸지 않는다.

Storage 완료의 `storageBytesPresent=false`는 원 업로드 key의 실제 API GET에서 바이트 접근이 불가능하고 native object가 없다는 관찰이다. 전체 볼륨이나 물리 디스크의 바이트0으로 보고하지 않는다. 새 대상의 Auth image도 관측한 원 GoTrue v2.196.0과 고정 이미지 일치를 확인한 후 DELETE 응답 유실 사례를 실행한다.

## J09 완료·ACK 없음의 구분

A는 실제 Storage 업로드 원바이트/ID→원 탈퇴 POST1/processing GET→제품 cleanup HTTP/RPC에서 Storage task 먼저 완료→Auth task의 원 ACK가 DB에 저장된 뒤 **그 ACK 응답만 유실**, Auth task는 아직 미완료→자연 lease 만료 후 SQL115의 원 ACK GET-only 복구→원 부모의 저장 증거 종결→원 JWT/탈퇴ID completed 조회다. 기존 internal/member-cleanup HTTP가 claimQueueInvocationDispatch를 직접 수행하므로 Node가 앞서 같은 claim RPC를 호출하지 않는다. 초기 실제 acquire_worker_run/read_worker_run_budget/prepareQueueInvocation과 shared HTTP 헤더를 동일 원 request/token/limit/remainingMs로 결합한다. 복구의 새 acquire 뒤에는 기존 UNKNOWN 때문에 거절되는 새 prepareQueueInvocation을 하지 않고 SQL115 reconcile의 원 recoveryRequestId 경로를 직접 쓴다. SQL118 scanner의 발견 결과와 실제 finalize HTTP get/complete/get을 구분한다.

앞선 준비 설명의 “task complete가 이미 커밋된 뒤 응답 유실을 SQL115로 복구”는 SQL115 전제와 달라 정정한다. 이때는 저장된 task/부모의 상태 조회 경로를 써야 하며 task를 수동으로 미완료로 바꿔 recovery 대상으로 만들지 않는다. 제품 선택 변경이 아니라 기존 SQL 계약을 확인한 기술 설계 정정이다.

B는 DELETE/dispatch 응답 유실과 ACK 없음일 때 원 UNKNOWN·추가 DELETE/ACK/complete0을 보존한다. 불명확한 원 작업을 임의 정산해 completed로 바꾸지 않는다. 현재 제품 adapter/실제 RPC 조립을 사용하며 옛 fixturePorts의 모형 ACK/complete·고정 민규 소켓/포트/keyfile는 재사용하지 않는다. 사진은 실제 업로드/바이트 재조회로 만들며 Storage metadata INSERT로 대체하지 않는다. 다른 원5명/원행·guard/ACL CAS·원 탈퇴 영수증/dispatch/ACK/UNKNOWN의 보존 검사를 수행한다.

실제SQL/Auth/Storage/provider/새 자원 생성은 이번 지원 준비 시점 **NOT_RUN**이다. 전체 완료 조건은 여전히79%(22/28)의 잔여·공급사/실회원/운영 경계를 유지한다.
