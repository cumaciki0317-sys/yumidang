# native56에서 native60 cleanup 연결 검증 준비

## 현재 증거와 작업 경계

민규 읽기 설계. main의 `tools/local/prepare_current_policy.py`, `prepare_edge.py`, `tests/integration/minkyu/member_cleanup_native_local.ts`, cleanup DB ports와 서비스 executor를 확인했다. 이 문서 외 source 수정·DB 연결·쓰기·역할 변경은 하지 않았다. native56의 실제 삭제·재가입12그룹 PASS와 원래 artifact/SHA는 역사 증거로 보존한다. scratch17그룹 PASS와 main 전체 함수 검사도 native60 실제 REST·provider 연결 결과로 바꾸지 않는다.

대상은 기존 독립 `yumidang-minkyu-drift` 프로젝트의 localhost API56531/DB56532와 고정 drift 컨테이너뿐이다. 원본 naver-live·운영·linked 프로젝트·임의 db-url·roles/seed 변경·컨테이너 재생성·reset·migration repair는 범위 밖이다. 실제 적용/실행은 root의 단계별 START 이후에만 진행한다.

## 준비 artifact와 적용 전 조건

`prepare_current_policy.py`는 검토41개+19개=60개 경로·버전·내용 SHA를 검사하고 source 변경 여부를 준비 앞뒤에 비교한다. 원래 strict41 검사를 유지하며 SQL/Edge 실행은 NOT_RUN으로 기록한다. 새로운 private 출력 경로에서 다음 준비를 수행하는 안이다.

root가 실제 준비한 source artifact는 `/private/tmp/yumidang-policy60-reviewed-xze3cqci/prepared`이며 READY·SQL/Edge NOT_RUN이다. 이 source manifest를 native overlay의 출발 증거로 보존한다. 향후 runtime 예산 변경을 이식하기 전 snapshot이므로 뒤에 변경한 코드의 검증 증거로 재사용하지 않는다. 코드 변경 시 함수 snapshot과 코드 hash를 새로 기록하고 SQL60 hash와 구분한다.

```sh
python3 tools/local/prepare_current_policy.py --repo <main-root> --output <new-private-artifact> --gateway-probe
```

중요한 차이: 기본 준비 config는 `yumidang-minkyu-gateway`, API56521/DB56522이다. 그대로 push하면 기존 drift가 아니다. root가 기존 drift 이식 절차로 **임시 artifact만** project_id `yumidang-minkyu-drift`, API56531/DB56532 및 기존 drift 관련 포트로 검토된 overlay를 만들고, config 원본/overlay diff·각 SHA를 새 manifest에 별도로 기록해야 한다. main config를 수정하거나 기본 gateway 준비 증거를 drift 적용 증거로 바꾸지 않는다.

적용 전에 실제56개 버전 집합이 manifest60의 정확한 부분집합인지 읽어 비교한다. 개수56·최신20136만 맞는 것으로 충분하지 않다. 누락은 아래4개만이어야 한다.

1. `20261005021810_sanction_adjudication_draft.sql`
2. `20261005021811_member_activity_sanction_gates.sql`
3. `20261005030100_member_retention_batches.sql`
4. `20261005040100_worker_queue_schedule.sql`

이식 전 guard=false, cleanup5개와 신규 budget/schedule의 common-role 실행권한 닫힘, global token/expiry 둘 다 null, 회원·Auth·파일·cleanup·historical·신고·제재·보관 관계 자료0을 확인한다. 신규 RPC는56에서 존재하지 않는 것이 정상이며 부재를 권한 폐쇄와 구분한다. Storage 실제 backend 파일0도 확인한다. 기존 역할 catalog와 관계별 owner/ACL, 함수 owner/ACL을 기록하고 기존 컨테이너 identity·56531/56532 바인딩과 private status0600/parent0700도 확인한다. 키·토큰·원문은 결과물에 기록하지 않는다.

## 공식 local CLI 적용과 실패 경계

고정 CLI `supabase@2.116.0`의 실제 help로 해당 local/dry-run/skip-vault 옵션을 확인한 뒤 임시 drift artifact를 workdir로 사용한다. 이전 동일 프로젝트에서 사용한 `db push --local --skip-vault --yes` 절차에 앞서 dry-run 결과가 위4개 순서와 정확히 일치해야 한다. `--linked`, 운영URL, seed, 전체 reset, 자동 이력 repair는 사용하지 않는다. 공식 CLI 적용 로그는 private artifact에 남기되 자동 local 키 출력은 제거한다.

CLI가 여러 파일을 순차 적용하다 실패하면 전체4개가 한 트랜잭션처럼 되돌아간다고 가정하지 않는다. 실제 남은 이력과 catalog를 읽고 종료한 단계·SQLSTATE를 기록한다. 원인 검토 없는 재시작이나 migration 삭제·repair로 성공처럼 만들지 않는다. 신규 파일 자체의 BEGIN/COMMIT 실패는 해당 파일 경계에서 검토한다. 빈 격리 환경이어도 원래56 이력/소스 hash와 실패 결과를 보존한다.

적용 후 exact60 버전 목록·최신40100·누락0을 확인하고 기존56 함수/권한의 의도한 변경과 새 owner preflight를 검토한다. guard=false·cleanup5ACL0·budget/schedule common-role ACL0·global idle·모든 관계자료0·backendfiles0·전역 역할 불변이 적용 후 기준이다. 단순60개 이력은 실제 endpoint 성공 증거가 아니다.

## driver 증거를 분리하는 최소 변경안

현재 driver는55/56 승인 플래그만 받으며 verify-rejoin도56으로 고정한다. 전체 실행 assert와 Auth 순서 검사 역시56 분기에 있다. 이를 현재 DB 개수에 맞춰 자동 추정하거나 `>=56`으로 완화하면 역사 검증과 신규 적용 검증이 섞인다.

기존 native56 실행본·SHA·12그룹 결과는 보존하고, root 승인 후 동일 책임의 기존 driver에 명시적인60 검증 모드를 추가하거나 전용60 연결 harness를 작성한다. 별도 구현 선택은 root가 결정한다.60 모드는 reviewed manifest의 정확한 버전 집합/SQL hash를 요구하고 `scope:isolated_native60_actual_db_auth_storage` 및 새로운 artifact 경로를 사용한다. main adapter·DB ports·서비스 factory를 같은 module graph로 import하고 세 SHA를 기록한다. 단순 baseline56→60 치환만으로 실행 계약이 연결됐다고 주장하지 않는다.

신규 핵심은 owner SQL로 계산한 수동 budget 대신 **실제 REST `read_worker_run_budget` → `createMemberCleanupBudgetReader` → `createMemberCleanupExecutor`**를 검증하는 것이다. 실제 acquire180초, 남은1..180000ms, whole RTT 차감, AbortSignal, task60초 reserve, 최대20건, Storage→Auth 순서와 durable ack를 확인한다. 기존 wronglease/60초 재점유/proof 재사용 검증은 개별 task 모드로 보존하고, factory 연결 검증과 각각 이름을 구분한다.

## 다른 REST 세션에 보이는 임시 권한

owner 세션의 `BEGIN; GRANT ...; UPDATE guard ...;`를 열린 채로 두고 외부 REST를 호출하면 REST 세션은 미커밋 권한·승인 변경을 볼 수 없다. 마지막 ROLLBACK으로 되돌리는 방식은 실제 HTTP 검증 준비가 아니다. SQL rollback 회귀와 실제 REST 검증을 구분해야 한다.

승인된 합성 환경에서는 baseline 폐쇄 및 최초 retire 거절을 먼저 검증한다. 그 다음 owner가 guard=true와 cleanup5개 **및 budget1개** service_role EXECUTE를 좁게 준비해 COMMIT해야 factory의 실제 budget REST가 동작한다. schema cache 갱신이 필요한 경우 빈 정책변경과 구분해 `NOTIFY pgrst,'reload schema'`를 COMMIT하고 실제 endpoint의 사용 가능 여부를 확인한다. anon/authenticated 및 queue schedule 권한은 열지 않는다. 이 과정은 전역 역할 생성/속성/멤버십 변경이 아니라 기존 함수6개에 대한 격리된 임시 ACL 변경이며 root의 명시 승인 범위가 필요하다.

기존 driver의5개 복원 목록에 budget이 자동 포함되지 않는다. 새 harness는 finally에서 guard=false와 임시6개 권한을 baseline대로 COMMIT 복원하고 effective ACL을 common-role별로 재검사해야 한다. budget은5포트 allowlist에 넣지 않고 기존 별도 reader를 사용한다. 잘못된 token/만료의 native40001, 닫힌 권한의 SQL42501 및 실제 REST gateway 표현은 각각 기록하고 서로 같은 HTTP 형태라고 추정하지 않는다.

## 완료 기준과 남는 연결

실제 fixture 회원JWT retire, factory가 발행한 budget/claim/check/ack/complete REST 호출, provider exact DELETE/재조회, Storage 후 Auth, durable proof 재사용, 최종 rows/files0·guardfalse·6ACLbaseline·global release가 새 native60 완료 기준이다. failure/timeout은 새로운 private 결과로 남기며 이전56 PASS를 덮어쓰지 않는다. 연결이 실패해도 finally의 각 복원/청소 증거를 독립 기록한다.

`prepare_current_policy`의 함수 overlay는 service-api만 준비한다. Node에서 실제 DB/provider를 사용하는 M factory PASS는 J scheduled-jobs HTTP route 또는 상주 queue LOGIN/LISTEN 성공과 다르다. J3kind/counts와 HTTP75초 finally release의 종료 불확실성은 기존 요청문서의 연결 선행조건이며 이번 DB60 적용만으로 해결되지 않는다. 따라서 Node factory 검증은 독립적으로 진행할 수 있지만 상주 cleanup 활성화 완료를 선언하지 않는다.
