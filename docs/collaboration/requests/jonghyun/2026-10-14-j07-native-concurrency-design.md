<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미다. 일반 신고 처리와 해당 신고의 허용된 제출 증거 처리는 조유미 부재 시 종현이 대체한다. 이 지정은 고객지원·AI 비용·서버 운영의 대체 권한으로 확대하지 않는다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# J07 직원 권한·탈퇴의 두 세션 검증 설계 — 2026-10-14

전체 **79%(22/28)** 유지. 검토29개는915fc31에 로컬 커밋됐고 아래 native 두 연결7개는 승인된 새 DB에서 **PASS_NATIVE_SQL_ONLY**를 확인했다. 이 문서와 새 드라이버2개는29개 커밋에 포함되지 않으며 별도 검토 작업본 SHA로 실행했다. 실제 Auth API·Storage API·직원 화면 workflow는 NOT_RUN이다. 실행·원복 범위와 새 자원 정리는 [두 번째 실행 기록](2026-10-14-round2-validation-result.md)의 최신 절을 따른다.

## 소스에서 확인한 잠금 계약

현재 `20261014010000_operator_receipts_retirement.sql`의 true 승인/배정은 Auth KEY SHARE 뒤 profile KEY SHARE NOWAIT를 사용한다. 일반 탈퇴는 먼저 profile을 잠근 뒤 직원 회수 trigger가 Auth UPDATE NOWAIT를 얻는다. 따라서 두 함수의 모든 양방향 경합이40001이어야 한다고 가정하지 않는다.

실제 false 승인/false 배정 또는 직원 신고 읽기가 먼저 잠금을 보유하면 탈퇴 trigger의 NOWAIT 실패와 전체 TX rollback을 확인한다. 실제 true 승인/배정과 탈퇴의 양방향은 먼저 실행한 함수의 TX를 유지하고 대기 중인 반대 연결의 원 PID와 pg_blocking_pids를 관측한 뒤, 먼저 실행한 TX를 ROLLBACK해 대기 함수가 정상 진행되는지 확인한다. 성공한 대기 함수도 전체 ROLLBACK한다. 임의 sleep만으로 순서를 증명하거나 profile 잠금을 수동으로 바꿔 실제 함수 경합으로 표현하지 않는다.

| 경우 | 보유한 실제 함수 | 두 번째 함수 | 확인할 결과 |
|---|---|---|---|
| 1 | false 직원 승인 | 회원 탈퇴 | 40001 및 전체 rollback |
| 2 | false 직원 배정 | 회원 탈퇴 | 40001 및 전체 rollback |
| 3 | 배정된 신고 읽기 | 회원 탈퇴 | 40001 및 전체 rollback |
| 4~5 | true 직원 승인/배정 | 회원 탈퇴 | 원 PID의 실제 대기 → 보유 TX rollback → 정상 반환 → 전체 rollback |
| 6~7 | 회원 탈퇴 | true 직원 승인/배정 | 원 PID의 실제 대기 → 보유 TX rollback → 정상 반환 → 전체 rollback |

단일 native 후보가 이미 검사하는 퇴직 후42501, 원 영수증3개/신고 보관 시계와 FK 보존을 새로 모형 성공으로 대체하지 않는다. 두 세션 검증 전후에도 준비된 직원/다른 직원·영수증·시계·행/권한이 정확히 유지되는지 대조한다.

## 실행·증거 범위

사용자가 승인한 새 합성 대상에만 준비하며 기존6개 자원은 metadata 보존 확인만 한다. 기존 DB·Storage에 접속하지 않는다. 준비 helper는 한시 지원된 run_database_tests의 대상/보존 검사를 재사용한다. 현재 제품 SQL121개와 두 지원 도구는 승인된29개 로컬 커밋의 HEAD에 정확히 고정한다. 기존 signed/member/source HEAD 검사를 완화하거나 CURRENT_AI_FILES를 우회하지 않는다.

새 native 드라이버2개는 별도 검토한 작업본 SHA·정확한 실행 전후 바이트·원 명령/PID·비공개 저널을 고정하는 검증 도구다. 이 결과를 “전체 실행 코드가 같은 Git HEAD”라고 표현하지 않는다. AGENTS·협업 규칙에 모든 새 검증 도구의 커밋을 요구하는 보편 규칙은 없다는 읽기 감사를 마쳤다. 새 제품/SQL 변경과 임시 민규 경로를 이 범위에 추가하지 않는다.

실행 전 정확한 새 target/소켓/SQL 이력, cron OFF·계정/작업0·외부 처리 닫힘을 확인한다. native 준비 후보의 검토된 prefix를 새 DB에만 적용해 두 연결에서 볼 수 있도록 준비 TX를 commit한다. 네이버/사진 metadata/Auth row는 이 SQL 책임의 합성 자료다. 실제 GoTrue 발급/직원 HTTP/사진 업로드·삭제·Storage ACL/감사·90일 실제 파기 결과로 표현하지 않는다. 두 연결의 pg_temp helper는 각각 설치한다.

검증 probe는 전부 rollback한다. 준비 fixture 자체는 원 행/해시로 보존하고 실패/UNKNOWN을 지워 성공을 만들지 않는다. 연 guard와5개 EXEC 권한은 원값을 비교해 복귀한다. 실패/유실·권한 복귀 실패에서는 추가 mutation을 중단하고 원 저널과 관측을 남긴다. 시작한 자식만 종료하며 관측 타임아웃을 재시작 근거로 사용하지 않는다. 새 대상의 원 생성 영수증에 따른 자원 정리는 Root의 이미 승인된 별도 절차다. 준비 fixture가 남은 DB를 다른 빈 환경 검사에 재사용하지 않는다.

## 담당

event_design은 actor=jonghyun 소유권 확인 후 `tests/integration/jonghyun/operator-retirement-concurrency.py`, `tests/database/jonghyun/test_operator_retirement_concurrency.py` 두 새 파일만 작성한다. Root는 이 설계와 최종 검사/실행 증거를 담당한다. progress_audit은 정책·증거 경계 읽기 검토만 한다. 검토29개·소유권·hook·민규12개 예외·성호 화면·원본 공유 clone은 편집하지 않는다.
