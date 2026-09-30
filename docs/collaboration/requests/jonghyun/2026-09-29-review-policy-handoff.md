# 후기 공개 정책·건별 자동 완료 구현 인계

기준: 2026-09-29 / `ff9c14f` / `minkyu/foundation-harness`. 이번 변경은 미커밋이다.

사용자가 “상대방이 후기 제출 했고, 내가 제출했으면 즉시 공개”까지 수정을 승인했고, 민규 승인과 이번 작업의 담당 경계 예외를 명시했다. 이에 DB·API·실행기·최신 문서를 함께 수정했다. 소유권 정책·hook·작업자 설정은 변경하지 않았다. 원격 DB·운영 배포·외부 모델 호출·커밋/푸시는 수행하지 않았다.

## 확정 동작

| 조건 | 결과 |
|---|---|
| 양쪽이 후기 제출 | 완료 알림 기준 24시간 전에도 즉시 공개 |
| 한쪽만 후기 제출 | 완료 알림을 앱에서 확인할 수 있는 시각 +24시간부터 공개 |
| 위 24시간이 지난 뒤 작성 가능 기간에 후기 제출 | 제출 후 바로 열람 가능. 배치 작업을 기다리지 않음 |
| 일반 후기 작성 기간 | 실제 완료 시각부터 7일. 알림 클릭·후기 제출 시각으로 다시 시작하지 않음 |
| 실제 분쟁 | 기존 작성·기한·공개 보류 유지. 동행 인정 후 남은 기간 재개·최소 24시간 보장 예외도 유지 |
| 미완료·불발/노쇼 | 양쪽 후기가 있어도 공개 대상 제외 |
| 수동 완료 | 두 당사자의 완료 확인 필요. 한 명만 확인하면 완료 전 상태 유지 |
| 자동 완료 | 예상 종료 +24시간의 건별 예약. 지연되면 실제 처리 시각을 완료 시각으로 기록 |

“즉시”는 제출이 성공한 뒤 새 조회에서 조건이 반영된다는 뜻이다. 이미 열려 있는 화면의 실시간 갱신·브라우저 연결은 별도다. 화면 담당은 유미·성호다. 당도·완료 횟수의 기존 반영 보류와 산식은 이번 후기 공개 변경으로 재정의하지 않았다.

## 구현

- 신규 SQL `20260929120000_review_release_and_completion_reservations.sql`로 변경했다. 기존 정식 SQL 27개와 과거 인계/설계 기록은 보존했다.
- 당사자 후기 상태·공개 프로필·칭찬 집계·AI 요약 입력이 새 공개 시점 조건을 적용한다. `policy` 후보는 조회 때 판단하므로 공개 집계용 `is_public` 변경까지 기다리지 않는다. 공개 프로필의 명시적 숨김(`override`)과 공개 근거가 없는 과거 후기는 자동 공개하지 않는다. 당사자 간 열람과 제3자 프로필 공개의 기존 권한 구분은 유지한다.
- 공개 정리 RPC `process_due_review_publications`와 요약 등록 RPC `process_review_summary_refresh`를 분리했다. 모델 설정이 없거나 잘못되어도 공개 처리는 실행한다. 요약은 `pending_configuration` / `configuration_error` / `failed`로 구분하며, 공개 뒤 요약 실패를 성공 0건으로 바꾸지 않는다. 오류 시 요약 재처리 의도(outbox)는 보존된다.
- `/internal/maintenance`는 자동 완료 일괄 RPC를 호출하지 않는다. 반환의 `completion.status`는 `managed_by_reservation`이다. 공개 실패는 HTTP 오류, 공개 성공 뒤 요약 대기/실패는 HTTP 200의 `status: partial`이다. 호출자는 HTTP 상태뿐 아니라 응답의 작업별 상태를 확인해야 한다.
- DB의 `private.completion_reservations`에 약속 ID·시각·UUID 세대를 저장한다. 일정 변경·취소·수동 완료·분쟁에 따라 예약을 갱신/제거한다. 생성 중 종료시각 변경도 공고 잠금으로 직렬화한다. 실행 RPC는 약속 잠금 후 최신 상태·세대·DB 시각을 재확인한다. 자동 완료와 두 알림 생성은 한 트랜잭션이며 중복 실행은 완료 시각을 바꾸지 않는다.
- Node 상주 실행기 `backend/supabase/functions/scheduled-jobs/completion-runner.mjs`는 DB 알림을 구독한 뒤 예약을 읽고 가장 가까운 시각에 깨어난다. 시작·재접속 시 이미 기한이 지난 예약도 복구한다. 빈 예약에는 반복 조회 타이머가 없다. 기존 매분 cron `yumidang-auto-complete-appointments`를 해제한다. 마이그레이션 자체는 기존 약속의 예약만 생성하며 자동 완료하지 않는다.
- 실행기는 직접 또는 session PostgreSQL 연결이 필요하다. transaction pool이나 짧은 Edge 요청 안의 타이머로 운영하지 않는다. 연결 URL의 query/fragment를 거절해 host·TLS 옵션 덮어쓰기를 막고 원격 연결은 인증서 검증을 사용한다. 로그에는 정형 상태 코드만 남긴다.

운영 실행에 필요한 명시 환경값과 시작 명령은 [완료 DB 계약](../../../../backend/contracts/completion-db.md)을 따른다. `COMPLETION_DATABASE_URL`, `COMPLETION_RECONNECT_MS`, `COMPLETION_QUERY_TIMEOUT_MS`에 임의 운영 기본값을 넣지 않았다. 저장소 `.env`를 자동으로 읽지 않으며 실행 환경이 주입한다. `backend/package-lock.json`에 `pg@8.22.0`을 고정했다.

## 실제 검증 결과

환경: 전용 Colima `yumidang-minkyu`, Supabase `yumidang-minkyu-db`, 로컬 DB 포트 55422. Supabase CLI 2.116.0, Node 26.5.0. 원격 프로젝트는 연결하지 않았다. 테스트에는 가상 사용자·공고·후기만 사용했다.

| 검사 | 결과와 범위 |
|---|---|
| 최종 마이그레이션 처음부터 재생 | **PASS** — 기존 27개 + 신규 1개를 격리 임시 폴더에서 적용 |
| 신규 `review_release_policy.sql` | **PASS** — 양쪽/한쪽/0건, 24시간 경계, 세 조회 경로, 분쟁/불발/미완료, 역사/override, outbox, 예약/세대/권한/알림 |
| 기존 DB SQL 7개 | **PASS** — 작업 큐·검색·후기 요약·양측 완료·후기 자동화·서비스 API·검색 v2 |
| 기존 DB 동시 실행 6개 | **PASS** — 작업 등록/점유·요약 공개/숨김·매칭 충돌·수동/자동 완료 경쟁 |
| Node API·인증·bridge | **PASS 57/57** — 가상 HTTP/RPC 전송, 설정 누락/오류 분리, 부분 성공·오류 정제 포함 |
| Node 예약 실행기 단위 검사 | **PASS 8/8** — 무예약 시 반복 조회 없음, 예약 갱신, 재시작, 조회 중 알림, 재접속, URL/TLS 우회 차단 |
| 실제 Node ↔ PostgreSQL 통합 | **PASS 8/8** — 상위 1개+시나리오 7개. 예약 시각 실행, 변경/취소/분쟁, 강제 연결 종료 복구, 약속 생성/종료시각 변경 경쟁, 두 세션 중복 호출, 실제 후기 제출 직후 공개·기한 종료, 프로세스 재시작 |
| 같은 DB 호출 안에서 제출 직후 상태 조회 | **PASS** — 24시간 이전 양쪽 제출의 `mutual` 공개 확인 |
| 변경 경로·이력 보존 검사 | **PASS** — 하네스 밖 수정/담당 lane 중복 0, 보존 대상 55개 SHA256 동일 |
| 문서·공백 검사 | **PASS** — 변경 링크와 한자/일본어 혼입, `git diff --check` 확인 |

핵심 검사는 다음 파일로 재현한다. 실제 DB 검사는 가상 자료가 없는 전용 로컬 DB에서만 실행한다.

```sh
node --test tests/functions/minkyu/service_api.test.ts tests/functions/minkyu/auth_db.test.ts tests/functions/jonghyun/scheduled-jobs.test.mjs
node --test tests/functions/jonghyun/completion-scheduler.test.mjs
python3 -B tools/local/run_database_tests.py --run
# 전용 로컬 DB 연결값을 환경에 넣은 뒤 실행. 연결값을 문서/로그에 기록하지 않는다.
node --test tests/integration/jonghyun/review-policy-e2e.mjs
```

신규 SQL 검사는 `tests/database/minkyu/review_release_policy.sql`을 `ON_ERROR_STOP=1`로 실행한다. 테스트 SQL은 rollback하며 통합 검사에서 커밋한 가상 자료는 `finally`에서 제거한다.

최종 조회에서 가상 users/profiles/appointments/reservations/jobs와 실행기 DB 연결이 모두 0임을 확인했다. 전용 Supabase 서비스를 종료하고 DB 볼륨을 보존했다. 로컬 시작 로그는 정리했다.

## 남은 연결과 운영 전환

- **NOT_RUN:** Deno 정적 타입 검사, 실제 Edge HTTP 연결, 프론트 화면/브라우저 갱신, 원격 DB 마이그레이션, 상주 실행기 운영 배포. 기존 GET 검색 연결의 과거 검증 결과를 이번 변경의 HTTP 검증으로 표시하지 않는다.
- 운영에서는 상주 실행기 호스트·DB 연결·재접속/쿼리 제한값을 준비하고, 신규 migration의 cron 해제와 실행기 기동을 같은 전환 작업으로 수행해야 한다. 예약 조회·READY·기한 경과 예약 복구를 확인한다. 이번 턴에는 운영 연결이나 실행 주기를 활성화하지 않았다.
- 행사 갱신·AI 후기 요약 등록의 사용자 선택은 24시간 주기다. 자동 완료와 후기 열람은 이 일일 주기를 기다리지 않는다. 실제 일일 스케줄러·외부 공급사/모델 실행은 별도 남은 작업이다.
- AI 검증은 가상 공고·후기로 결과를 함께 확인한 후 의미 검사/품질 기준을 정한다. 추가 유료 지출 0원, 외부 원문 보관 팀 검토, 그전 합성 입력만이라는 이전 선택을 유지한다. 이번에 모델 호출이나 원문 보관 정책을 임의 확정하지 않았다.

정확한 수정 허용 경로·보존 해시는 [이번 하네스](2026-09-29-review-policy-harness.json)에 있다. 사용자 승인 예외는 이번 정책 변경에 한정하며 소유권 정책 자체를 바꾸지 않는다.
