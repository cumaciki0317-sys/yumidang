# 인수 검토 결함 5건 수정 — 2026-09-30

**F1~F5 수정 및 로컬 재검증 PASS.** 정식 마이그레이션 채택·운영 연결은 여전히 별도다. 커밋·푸시·원격 DB·배포·실제 공급사 호출은 하지 않았다.

기준: `minkyu/foundation-harness`, `ff9c14fec069dc03b575cfd33d9deb62625fd924`. [이전 실패 보고서](2026-09-30-codex-implementation-review.md)는 당시 근거로 보존한다. 이번 결과는 [하네스](2026-09-30-five-defects-harness.json)와 [실행 근거 JSON](2026-09-30-five-defects-evidence.json)을 따른다. JSON에는 검사별 로그·입력 해시·재생 목록·정리 결과를 담았다.

## 1. 수정 결과

| 결함 | 수정 | 검증 |
|---|---|---|
| F1 점유 만료 후 요약 게시 | SQL03에서 투영 상태와 작업 잠금을 모두 잡은 뒤 토큰·만료를 재검사. 게시·중간 저장은 쓰기 직전에도 만료 확인 | 실제 잠금 대기 중 2초 점유 만료. 게시·중간 저장·원문 조회 모두 `lease_lost`, 저장 결과 0건 |
| F2 요약·재등록 교착 | SQL03의 잠금 순서를 `투영 상태 → 작업 → 중간 저장/표식`으로 통일 | 실제 source RPC가 투영 잠금을 기다릴 때 기존 refresh RPC가 중복 enqueue까지 완료. 교착 없음·추가 작업 없음 |
| F3 예산 소진 후 부분 결과 소실 | 실제 `ModelError(BUDGET_EXHAUSTED)` 분류를 유지. 이미 채택한 카드만 `incomplete`로 보내 재확인 후 `partial` 반환 | 일부 결과·미입력 표시 유지, 삭제된 카드 제외, 일반 오류·취소·위조 코드의 가짜 성공 방지 |
| F4 TourAPI 손상 응답을 0건 처리 | `totalCount` 자료형·`items` 구조·전체 건수와 빈 페이지의 관계를 검사 | 정상 0건·단일 항목 유지. 손상 응답은 503·저장 RPC 호출 0회 |
| F5 잘못된 행사 비용 저장 | SQL04의 RPC와 CHECK에서 객체 자료형을 CASE로 먼저 확인하고 조건이 명시적 TRUE일 때만 허용 | `{}`·필수 키 누락·null·문자열·숫자·boolean·배열 등 10개 입력 거절, 배치 전체 롤백 |

SQL 변경은 종현 제안 `03_review_summary_worker.sql`, `04_events.sql`에만 반영했다. 민규 소유의 기존 마이그레이션·DB 클라이언트·service-api·config는 수정하지 않았다. 최초 F5 재검사에서 문자열 입력의 JSON 연산 오류를 발견해 자료형 CASE 검사를 보완했고, 그 실패 로그도 근거 JSON에 보존했다.

새 실제 DB 검사: [summary-lock-regression.mjs](../../../../tests/integration/jonghyun/summary-lock-regression.mjs). 이전 F2 재현은 작업 행을 외부에서 먼저 잠그는 방식이므로 수정 후 회귀로 그대로 쓰지 않는다. 새 검사는 실제 RPC가 내부에서 잡는 순서로 충돌을 만들고 확인한다.

## 2. 실행 명령과 판정

Node·Python 명령은 저장소 루트, Deno만 `backend/supabase/functions` 기준이다. 실제 DB 검사는 전용 Colima `yumidang-minkyu` / Supabase `yumidang-minkyu-db` / 로컬 API 55421·DB 55422에서 합성 자료만 사용했다. 로컬 키는 메모리에서 검사 환경 변수로 전달하고 출력하지 않았다.

| 판정 | 명령 | 결과 |
|---|---|---|
| PASS | `node --test tests/functions/jonghyun/*.test.mjs tests/ai/jonghyun/*.test.mjs tests/integration/jonghyun/*.test.mjs` | **265/265** |
| PASS | `deno check --no-remote ai-chat/index.ts places/index.ts event-sync/index.ts review-summary-worker/index.ts scheduled-jobs/index.ts` | 5개 진입점 |
| PASS | `python3 -B tests/database/jonghyun/run_proposals.py --all` | 제안 SQL 검사 **5/5**, 롤백 |
| PASS | `python3 -B tests/database/jonghyun/run_minkyu_regression.py "<제안 SQL 5개 쉼표 목록>" "<민규 SQL 검사 8개 쉼표 목록>"` | **8/8** |
| PASS | `npx --offline supabase@2.116.0 db reset --local --workdir <임시 applied 폴더>` | 기존 **28개 + 제안 5개 = 33개** 처음부터 재생 |
| PASS | `python3 -B tests/database/jonghyun/run_proposals.py --test <검사 SQL> ...` | 33개 적용 상태에서 검사 **5/5**, 제안 중복 적용 없음 |
| PASS | `python3 -B tools/local/run_database_tests.py --run` | 기존 SQL **7개 + 동시성 6개** |
| PASS | `node --test tests/integration/jonghyun/summary-lock-regression.mjs` | 새 만료 3경로·교착 1경로, 1개 통합 테스트 |
| PASS | `node --test tests/integration/jonghyun/<아래 파일명>.mjs` | 기존 통합 7파일 **14/14** |

기존 통합 파일: `review-policy-e2e`(8), `ai-budget-concurrency`(1), `summary-worker-concurrency`(1), `summary-worker-rest`(1), `ai-discovery-rest`(1), `events-rest`(1), `ai-event-discovery-rest`(1). 실제 DB/REST 연결을 검증했으며 모델 응답은 합성이다.

초기 실행 폴더에는 기존 28개 SQL과 원본 config를 복사했고, 적용 폴더에는 수정된 제안 5개만 임시 migration으로 추가했다. 저장소 migration/config는 보존했다. 일반 준비 도구에 미커밋 SQL을 자동 포함시키지 않았다.

## 3. 보존·잔여 범위

- 이전 검토 입력 134개 중 변경은 허용된 코드·SQL·검사 **8개**뿐이다. 나머지 **126개**는 SHA-256 동일하다. 기존 검토 근거도 보존했다.
- 새 파일은 실제 DB 회귀 검사, 이 보고서, 하네스, 근거 JSON **4개**다. 소유권 검사 대상은 총 **12개**, 작업자는 `jonghyun`이다.
- **정리 PASS:** 사용자·프로필·공고·약속·후기·작업·예약·행사·중간 저장·요약 모두 0건. DB를 기준 28개로 복구한 뒤 잔존 자료 0건 재확인. Supabase·전용 Colima 모두 정상 종료했고 볼륨은 보존했다.
- **PARTIAL:** 전체 서비스 인수·운영 준비. 이 5건의 PASS를 출시 완료로 확대하지 않는다.
- **BLOCKED:** 민규 정식 반영 R1~R7/M1~M6, 팀 결정 T1~T5는 기존 요청대로 대기한다. 제안 운영 수치·요금·보관·품질을 확정하지 않았다.
- **NOT_RUN:** 실제 외부 AI·장소·행사, 브라우저, 이번 변경 후 Edge 재실행, 원격 DB, 배포, 커밋·푸시.
- 이전 검토의 service-api 타입 오류와 gateway CORS **FAIL**은 이번 5건 밖이다. 수정·재검사하지 않았으며 해결됐다고 표시하지 않는다.

## 4. 어느 브랜치에 커밋할지

현재 폴더는 실제로 **민규 브랜치 `minkyu/foundation-harness`**에 있다. 따라서 여기서 브랜치를 바꾸지 않고 커밋하면 민규 브랜치에 기록된다. 폴더 이름은 커밋 대상을 결정하지 않고 현재 체크아웃된 브랜치가 결정한다.

**추천: 현재 HEAD를 기준으로 새 종현 인계 브랜치를 만들고, 그 브랜치에서 변경을 구분해 커밋한 뒤 민규 브랜치로 통합한다.** 현재 민규 기반을 그대로 잇기 때문에 민규의 기존 커밋을 잃지 않는다. 과거 종현 브랜치로 단순 전환하거나 현재 미커밋 파일을 덮어쓰는 방식은 피한다.

이번 폴더에는 종현 구현뿐 아니라 이전 승인된 후기 정책 변경도 섞여 있다. 커밋 전 기존 후기 정책 변경, Claude 구현, 이번 5건 수정을 파일·변경 단위로 구분해야 한다. `git add .`로 전체를 한 번에 묶지 않는다. 팀이 이 브랜치를 공동 통합 브랜치로 쓰기로 명시하면 민규 브랜치에 공유하는 것도 가능하지만, 폴더 위치만으로 그 선택을 확정하지 않는다.

로컬 `origin/minkyu/foundation-harness` 참조와 HEAD는 동일했다. 이번에는 원격 fetch/최신 원격 HEAD 확인을 하지 않았다. 브랜치·Git 인덱스·커밋·푸시 상태도 바꾸지 않았다.
