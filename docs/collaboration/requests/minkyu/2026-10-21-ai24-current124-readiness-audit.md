# AI24 current124 준비 잔여 감사 — 2026-10-21

이 문서는 WBS5.5·5.6·7.11의 다음 독립 준비 작업을 정리한 읽기 감사다. 검토 기준은 primary의 `bc58ce5` 통합 시점 코드와 아래 역사 기록이다. 이 문서 작성으로 TASK 완료율을 올리지 않는다.

**실제 범위:** 소스·기록 읽기와 문서 작성만 수행했다. 이번 감사의 Auth 발급·모델 호출·Docker·VM 조작·회원 검증·운영 적용·자정 실행은 모두 **0회 / NOT_RUN**이다. D03 전용 읽기 포트의 회귀 통과를 AI24 실행 증거로 사용하지 않는다.

## WBS5.5 — 원 세션·최신 소스·자연 자정 준비

- **변경:** 최신124 migration·6 schema182표의 typed current profile과 AI24 전용 **3명×2세션 = 원6세션** 계약을 재확인했다. 기존 Auth6의6명×1세션과 구분한다. AI 요청에는 명시된3명의 primary session만 사용하며 secondary session도 원 발급·보존 검사 대상이다.
- **실제 검증 범위:** 계약·발급 도구·소비 코드 읽기만 했다. 새6세션 발급·현행 AI24 실제 조립·자정 검증은 수행하지 않았다.
- **근거 코드:** [current profile 및 세션 대응](../../../../tests/integration/jonghyun/isolated_ai_contracts.py#L346), [primary 선택과 원 계정 검사](../../../../tests/integration/jonghyun/isolated_ai_contracts.py#L905), [issuer exact population·추가 행](../../../../tools/local/provision_current_midnight.py#L117), [원 JWT·세션 발급 확인](../../../../tools/local/provision_current_midnight.py#L250), [signed plan의 명시3명·만료 검사](../../../../tools/local/prepare_isolated_midnight.py#L285).
- **남은 조건:** D03 도구 변경이 통합된 최종 HEAD를 root가 명시 승인하고 full124 manifest SHA·정확182표 SHA·실제 source/daemon/own4 ID·전체 source pins를 새로 고정해야 한다. 관측된 issuer profile은 root의 별도 검토 입력이며 자동 실행 권한이 아니다. 원 binding의 `approvedByRoot=false`, `dockerSlotReady=false`를 수정해 권한으로 승격하지 않는다.
- **다음 작업:** 아래 시간·종결·성능 공백을 먼저 해소하고 새 전용 source에서 발급한다. 원 JWT는 재서명·수명 축소·시각 조작 없이 원문 그대로 보존한다. capsule·Node·factory·observer의 실제 소비 bytes를 사전 봉인하고 존재·권한·SHA를 확인하여 이전 positive 검증의 capsule 사전 누락을 반복하지 않는다.

### 시간·메모리 조건

[고정 WINDOWS](../../../../tools/local/prepare_isolated_midnight.py#L24)와 [check_window](../../../../tools/local/prepare_isolated_midnight.py#L376)를 유지한다.

| 단계 | 목표 한국시간 자정 기준 |
|---|---|
| 초기 준비 | 1,200~3,600초 전, 즉 23:00~23:40 |
| 실제 원 세션 발급 | 원 `exp-iat=3600`, `exp >= 목표 자정+300초`. 따라서 실질적으로 23:05 이후에 발급한 세션이어야 하며 실제 claims·DB 시간으로 판정 |
| fixture 시작 | 600~3,600초 전 |
| fixture 완료 | 최소300초 전, 즉23:55까지 |
| 재개 | 23:58 포함~23:59:55 미포함 |
| 마지막 idle 진입 | 자정3초 초과~60초 이하 전 |
| 경계 관측 | 자정 전2.2초 미만·자정 후2초 미만의 원 계약 |
| 메모리 | 시작1,048,576KiB·유지786,432KiB, 채취3초 이내. 기준을 낮추지 않음 |

23:05는 원3,600초 세션과 자정+300초 조건에서 도출한 가장 이른 시각이며, 초기 준비창 자체를 변경한 것이 아니다. 준비가 늦어지거나 첫 세션의 잔여가 부족하면 그 실행은 보류하고 새 source·세션·intent를 검토한다. 만료된 과거 준비 자료를 재사용하지 않는다.

## WBS5.6 — 늦은 정산·UNKNOWN·정리 계약

- **변경:** 실제 자연 D/D+1에서 held 요청의 늦은 정산과 새 날짜 요청을 연결하고, 기존 UNKNOWN·공유 예산을 보존하는 계약을 재확인했다.
- **실제 검증 범위:** 정적 소비 경로 확인만 했다. 실제 경계·늦은 정산·자연 날짜 원장 비교는 NOT_RUN이다. 기존 AI22/23·positive PASS를 AI24 PASS로 확대하지 않는다.
- **근거 코드:** [fixture 활성화의 닫힌 baseline·당일 예산·등록 flag 원본](../../../../tests/integration/jonghyun/isolated_ai_contracts.py#L956), [테스트 탐색 동의·준비 횟수3/20/3·UNKNOWN 원행](../../../../tests/integration/jonghyun/isolated_ai_contracts.py#L1147), [경계 실행·held 후 정산](../../../../tools/local/prepare_isolated_midnight.py#L904), [기존 행·등록 flag·guard 비교](../../../../tools/local/prepare_isolated_midnight.py#L1214), [예산·UNKNOWN 효과 판정](../../../../tools/local/prepare_isolated_midnight.py#L1438), [단일 정리·정리 증명](../../../../tools/local/prepare_isolated_midnight.py#L1525).
- **남은 조건:** 새 baseline에서 원 날짜·예산 여유·기존 UNKNOWN 전체 행을 고정한다. 새 ledger가 공유 일일 예산을 초기화하지 않는지 실제 비교가 필요하다. 단일 영속 intent·재개 상태·응답 유실 시 조회 복구를 연결하고 이전 실패/intent를 보존한다. UNKNOWN·90일 예산행은 정리로 삭제하거나 환불하지 않는다. 생성 영수증의 자기 행만 정리하고 원 등록 flags·processing guard를 복원해야 한다.
- **다음 작업:** source·6원세션·3명·scope·원장·목표 날짜가 같은 root 승인 실행 조립과 cleanup-only 절차를 먼저 검토한다. 실패 시 재전송·재준비로 덮지 않고 원문·변경 범위·미확정 상태를 남긴다.

합성 모델만 사용하며 원 회원 문장·외부 공급사 전송·유료 호출 승인이 아니다. `prepare_units`의 `exploration_allowed=true`는 명시적인 합성 fixture이며 실회원 첫 사용 동의 증거로 간주하지 않는다. 후기의 세 독립 동의나 일반 가입·계정 상태를 대신 증명하지 않는다.

## WBS7.11 — 실제 실행 전 도구 공백

- **변경:** 오늘 D03에서 확인·보완한 안전 읽기 경계가 AI24 issuer/runner에는 아직 연결되지 않은 점과 준비 시간 위험을 분리했다.
- **실제 검증 범위:** 아래 호출 경로를 읽었다. AI24 실제 포트 호출·성능 측정은 하지 않았다.
- **근거 코드:** [issuer 포트](../../../../tools/local/provision_current_midnight.py#L140) → [기존 FixedSignedProvisioningPorts.read_sql](../../../../tests/integration/jonghyun/isolated_ai_contracts.py#L1432) → [SignedMidnightRunner.read_sql](../../../../tests/integration/jonghyun/isolated_ai_contracts.py#L984). 후자는 `subprocess.run` 기반이며 원 stdout/stderr 영수증·유한 출력 상한·leader/PG 및 원 backend 종결·저장 실패 sticky를 제공하지 않는다. [기존 write SQL 경로](../../../../tests/integration/jonghyun/isolated_ai_contracts.py#L81)도 별도 실행 검토가 필요하다.
- **남은 조건:** AI24 전용으로 최소 typed 안전 포트를 검토해야 한다. 기존 SELECT/WITH·read-only·timeout·보존 전후 경계를 유지하고, bounded 원문 저장·leader+PG 종결·원 PID/backendStart와 동일 DB의 비SQL `/proc` 부재·실패 sticky를 연결한다. observer가 새 SQL observer를 재귀 생성해서는 안 된다. D03 전용 포트를 일반 skip flag나 임의 조립으로 확대하지 않는다.
- **다음 작업:** 새 Auth 발급 전에 고정 읽기 응답 크기와 준비 소요시간을 측정·검토한다. 현재 [original_rows](../../../../tests/integration/jonghyun/isolated_ai_contracts.py#L998)는182표를 표별 읽기로 수집하고 [snapshot](../../../../tests/integration/jonghyun/isolated_ai_contracts.py#L1016)이 이를 반복한다. source/Git·전체 보존검사 중복 비용을 포함하면 준비창과 원3,600초 세션을 소모할 위험이 있다. 측정 없이 현재 시간창 내 실행 가능하다고 확정하지 않는다. 필요한 최적화도 원 검사 간격·raw/종결 증거·보존 기준을 낮추지 않는다.

### 보존 증거의 정확한 범위

current profile의 행 명단은6 schema182표지만, `SignedMidnightRunner.snapshot`의 authority query는 기존4 schema 범위다. `sequence`와 `physical`은 명시적으로 `NOT_VERIFIED`다. 이 결과를6 schema 전체 ACL·sequence·물리 복원 검증으로 표시하지 않는다. 전체 current124 DB 복원과 Storage45 metadata/6원본/39미확보는 별도 작업이다.

### 역사 기록 보존

- [2026-10-17 AI24 readiness](2026-10-17-ai24-readiness.json)의121 migration·당시6명 중3명 선택·변형/중지된 세션·준비 회귀는 그 시점의 증거로 유지한다. 최신3명×2세션·124 실제 검증으로 자동 승격하지 않는다.
- [2026-10-20 실행 원장](2026-10-20-current-wbs-execution.json)의5.5·5.6 잔여는 자연 자정·늦은 정산이다.
- [2026-10-21 current124 SQL](2026-10-21-current124-sql-evidence.json)·[positive](2026-10-21-current124-positive-evidence.json)는 각 실제 검증 범위만 보존한다. 자연 AI24·실제 공급사·회원·운영 검증을 대신하지 않는다.

**현재 판정:** current124의 준비 계약은 존재하지만, AI24 실제 실행 준비 완료는 아직 증명되지 않았다. 우선순위는 전용 실행 포트의 종결/원문/sticky 공백과 Auth 발급 전 준비시간 검토이며, 이후 새 root 승인 소스·세션·capsule·자연 날짜로 실행한다.
