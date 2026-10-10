# 선택형 운영 준비 closed artifact 검토

2026-10-10. 작업자 `minkyu`. 하네스의 독립 읽기 검토 결과다. 제품·도구·SQL 수정, DB·Docker 실행, 운영 활성화는 하지 않았다. 이 문서만 자기 worktree에 작성했으며 편집 전 HEAD 소유권 검사를 통과했다.

## 검토 기준

검토한 durable worktree의 원본은 다음 두 파일이다. 아래 행 번호는 이 SHA의 코드 기준이다.

- `tools/local/prepare_production_backend.py`: `ea78d9e79ef66806b7aa558300321e7360994874da4348e5709d3785264fccfe`
- `tests/database/minkyu/test_production_preparation.py`: `4eebb608a65360a9b8760ae63f41b9baf4da6eaf97ccd0f107fb8c011e96b1b5`

새 artifact는 검토용 바이트 묶음이다. 실제 DB·CLI·공급사·실회원 검증이나 운영 승인으로 승격하지 않는다. 원본 graph와 외부에서 신뢰한 digest를 고정하고, import는 실행 부작용 없이 가능해야 하며, 직접 launcher 실행은 고정 오류로 거절해야 한다.

## 확정 결함과 보완 조건

| 항목 | 원본 근거 | 영향 | 보완 및 회귀 조건 |
|---|---|---|---|
| 주석이 있는 정적 import 누락 | 도구 48~62행. `import { x } from /* fixed comment */ "file:///outside/snapshot.mjs";`는 static match 0, reject false | launcher 92행의 정적 import가 scope 검사 전에 실행되어 snapshot 밖 모듈을 불러올 수 있다. 현재 실제 graph에 이 악성 문법이 있다는 주장은 아니다. | 허용 문법의 완전한 import 검사를 하거나 모호한 문법을 거절한다. `from` 뒤 block/line comment, re-export, escape, snapshot 밖 경로를 포함한다. 원본의 regex를 AST에서 추출한 메모리 검사로 누락을 확인했으며 외부 모듈은 실행하지 않았다. |
| 직접 launcher 실행이 조용한 exit 0 | 도구 90~98행은 함수 export만 한다. 테스트 91~97·181~200행은 import 뒤 함수 호출만 검사한다. | 프로세스 기동 성공으로 잘못 집계할 수 있다. 작업 자체는 실행되지 않는다. | import만 할 때 부작용 0, 정확한 launcher 직접 실행은 `PRODUCTION_SCOPE_NOT_APPROVED` 고정 코드와 exit 1을 별도로 검증한다. JSON·환경·인자로 승인하지 않는다. |
| 외부 신뢰 digest 없이 검증 가능 | 도구 101~129행. `expected_binding=None`은 자기 해시만 비교하며 graph/복사 목록 축소와 일부 provenance 필드를 검증하지 않는다. | 자기 일관성을 검토된 원본 동결 증거로 해석할 수 있다. scope null·activation false·final evidence NOT_RUN은 검사하므로 운영 승인 우회와는 구분한다. | 외부에서 신뢰한 expected binding을 필수로 하고 exact schema·closed/provenance 값·graph↔copiedFiles↔원본 snapshot/migration/review digest를 대조한다. 축소 후 재해시, execution/deployment/review 상태 승격을 거절한다. |

## 확인된 기본 방어와 검증 범위

새 artifact 생성 경로 132~189행은 새 private 디렉터리, 700/600 권한, symlink 거절, exclusive/no-follow 파일 생성, 원본 전후 재확인과 복사 바이트 대조를 수행한다. 실패 산출물을 덮어쓰지 않는다. 기본 JSON 보고서는 optional 필드만 추가하는 구조이며 이를 비교하는 모형 테스트가 있다. 미정 공급사나 합성 receipt를 actual PASS·운영 승인으로 바꾸는 생성 경로는 확인하지 않았다.

이 검토는 코드·테스트 읽기와 원본 regex의 순수 메모리 반례 확인이다. `node --check --input-type=module`의 stdin 구문 검사로 block comment, line comment, re-export, 주석 뒤 escape의 네 반례가 모두 유효한 JS임을 확인했다. 해당 모듈을 실행하거나 외부 파일을 불러오지 않았다. 기존 테스트 전체를 실행했다는 증거가 아니다. 수정 담당자에게 세 경계와 반례를 전달했으며 수정본 SHA와 diff를 받은 뒤 읽기 재검토한다. 후속 통합·실행 승인으로 이 문서를 사용하지 않는다.

추가로 durable의 제품 큐 파일은 `runQueueRunnerCli` export가 없는 이전 ABI였다. 최신 foundation의 같은 파일에는 해당 export가 있으며 읽기 당시 SHA는 `15a2ae9f4de95231d02000874305c66e5983015257f5441cb4000ab86e4db837`이다. 도구 수정본의 실제 import 검증은 최신 동결 제품 graph를 기준으로 해야 한다고 담당자에게 전달했다. 이 문서 작성자는 제품 파일을 복사하거나 수정하지 않았다.

## 수정본 재검토

수정본 읽기 재검토 결과는 **PASS**다. 앞의 세 경계를 보완했으며 새 고정본에서 추가 확정 결함을 발견하지 않았다. 이 결과는 closed 준비 기능의 검토이며 운영·DB·CLI 처리 성공이나 공급사 승인이 아니다.

- 도구 최종 SHA: `cc2108bc22d65ee8bdd1aeab9248f47dc624874e9b7051faa3df2983135cf7af`
- 테스트 최종 SHA: `628fb08f597d1522e5422cce4c2474ac7611ba33462e05b961d39240ee5469ef`
- 담당자 검증 receipt: `/private/tmp/yumidang-production-closed-static-20261010-v2/receipt.json`, SHA `16f982ea107e78be62d6ce2eb94969ee500954b48d778edfb99552c9fce5b642`. 파일 권한 600을 읽기 확인했다. 담당자가 기록한 테스트 25 PASS·실패 0·skip 0 및 최신 제품 import/start의 timer·제품 환경 읽기·DB/runtime import·fetch 0은 이 receipt 범위다. 독립 검토자가 전체 25개를 다시 실행했다고 주장하지 않는다.

새 도구의 45~65행은 Node 내장 VM parser로 정적 import/re-export를 읽고 합성 namespace만 link한다. 제품의 `evaluate`를 호출하지 않으며 외부 모듈을 resolve/load하지 않는다. 원 네 반례를 새 함수의 AST 추출본으로 메모리에서 독립 검사하여 모두 정확한 dependency를 얻었다. top-level throw를 포함한 반례도 실행되지 않았다. escape와 모호한 type-only/dynamic 문법은 별도로 거절한다. 84~85행은 실제 `runQueueRunnerCli` export 계약을 확인하여 이전 ABI를 준비 성공으로 반환하지 않는다.

126~139행의 launcher는 import 시 stock CLI를 호출하지 않고, 정확한 직접 실행에서는 `PRODUCTION_SCOPE_NOT_APPROVED`만 쓰고 exit 1로 거절한다. 142~201행의 verifier는 별도 보관한 외부 expected digest를 필수로 받으며 exact schema·closed/provenance 값·중복 JSON key·실제 복사된 product/migration/document 목록·재계산 graph를 대조한다. 산출물에서 다시 읽은 digest를 외부 신뢰 근거로 사용하는 것은 허용된 사용법이 아니다.

독립 검토자는 최신 foundation graph를 실제 읽기 전용 native parse로 다시 확인했다. 30개 graph 파일, 위 `15a2…` entry SHA, `pg`만 사용하는 패키지 계약이 통과했다. 제품 평가·파일 쓰기·DB·Docker는 모두 0이었다. 기본 JSON 계약, private 경로·exclusive 쓰기·원본 동결 보호는 유지됐으며 환경·인자·JSON 승인이나 합성 receipt의 actual 승격 기능은 추가되지 않았다.
