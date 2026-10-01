# AI 리뷰 요약·작업 연결 계약

현재 적용할 서비스 정책은 [정책.md](../../정책.md)를 따른다. 한쪽 후기 공개는 **실제 동행 완료 시각 +24시간**, 양쪽 제출은 즉시다. 당도는 상대 후기를 열람할 수 있게 될 때 동시에 반영하고, 완료 횟수는 후기와 관계없이 동행 완료 즉시 반영한다. 당도 산식은 민규·팀 검토 필요다. 아래 RPC·구현·검증 기록과 정책의 확정은 구분하며, 이번 문서 동기화에서 코드·DB·화면의 최신 정책 일치 여부는 검증하지 않았다. [반영 확인 작업](../../정책.md#follow-ups)을 확인한다.

## 2026-09-30 현재 구현 — 중간 저장·worker·24시간 실행 (Claude 구현, 종현 범위)

기존 구현의 세부 이력과 당시 검증은 [lane S 기록](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-lane-s-notes.md)과 [전체 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-implementation-handoff.md)를 따른다.

- **DB(제안, 민규 채택 대기):** [03_review_summary_worker.sql](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-proposed-sql/03_review_summary_worker.sql). 점유 횟수(`attempt`)와 실제 실패 횟수(`failed_attempts`) 분리, 정상 양보 `yield_job`(실패 미증가), 실패 `retry_job`/`fail_job`, 대체 `supersede_job`. 원문 없는 비공개 중간 저장과 점유 토큰·DB 시각·문자열 revision·근거 전체집합 확인 RPC. 게시·중간 저장 삭제·`(jobId, sourceRevision)` 표식을 한 트랜잭션으로 처리해 settle 전 중단 뒤 재실행에도 게시 시각·요약이 바뀌지 않는다. 원문 변경 트랜잭션에서 옛 revision 중간 저장을 삭제한다.
- **worker:** `POST /functions/v1/review-summary-worker`(내부 인증, 빈 본문). 설정·버전·모델·승인된 안전 검사기·RPC 허용 중 하나라도 없으면 작업을 점유하지 않고 `not_enabled`. 실행당 작업 수·시간 한도 안에서 정상 분할을 이어 처리하고, 예산 소진은 실패가 아니라 명시 지연(`REVIEW_SUMMARY_BUDGET_DEFER_MS`) 뒤 재개다.
- **24시간:** `POST /functions/v1/scheduled-jobs/daily {limit}` = 공개 정리·요약 등록(모델 무관) → 설정된 행사 갱신 → worker 명시 횟수 호출. 단계 독립, 단계별 상태. 시작 시각은 매일 00:01 Asia/Seoul로 확정되었으며 실제 운영 예약 등록은 미실행이다.
- **현재 제품 동작:** 안전(의미·개인정보) 검사 방법이 미확정이라 `APPROVED_SUMMARY_SAFETY_CHECKER = null` → 요약을 생성·게시하지 않는다. 후기 공개·원문·칭찬 차트는 영향 없다. 모델은 포텐스닷 `claude-5-sonnet`이며 `REVIEW_SUMMARY_MODEL_VERSION`은 `potens.claude-5-sonnet` 표식과 같아야 한다.

상태: 종현 요약·작업 코어와 기존 연결 구현을 아래에 설명한다. 가상/로컬 검증과 실제 모델·정식 migration·운영 배포는 구분하고, 이번 문서 작업에서는 실행하지 않았다. 기준: [최신 계획](../../PLAN.md) 3-5·4·6장, [상세 설계](../../PLAN_상세설계.md) 5.4·5.5·7·8·11.3장. 평가 제출·프로필 공개 권한의 원천 계약은 민규 소유 [reviews.md](reviews.md)다.

## 현재 완료·공개·작업 경계

예상 종료 후 본인 완료 확인을 한 사람은 상대 확인 전에도 후기를 제출할 수 있으나 실제 완료 전에는 비공개다. 실제 완료는 양측 확인 또는 예상 종료+24시간 자동 처리이며 취소·불발·분쟁은 제외한다. 실제 완료부터 일반 작성 마감 7일·한쪽 공개 24시간, 양쪽 제출은 완료 조건 충족 후 즉시 공개한다. 당도는 상대 후기 열람 가능 시, 완료 횟수는 실제 완료 즉시 반영한다. 선제 제출의 현재 DB 반영은 별도 확인 대상이다.

자동 완료는 [건별 영속 예약·Node 상주 실행기](completion-db.md)로 분리한다. 후기 공개는 제출·조회 조건이며 모델 설정·일일 작업을 기다리지 않는다. 행사 갱신·새 요약 등록은 매일 00:01 Asia/Seoul이다. 모델·프롬프트 미설정은 AI 생성 차단 조건이며 자동 완료·후기 공개를 막는 조건이 아니다.

sourceRevision은 작업·원문 snapshot·중간 저장·게시 전 구간에서 정규 십진 문자열로 전달한다. PostgreSQL bigint 범위와 요청 modelVersion/promptVersion을 보존하며 실제 사용 modelVersions와 구분한다. 버전 누락·불일치와 만료된 점유는 게시하지 않는다. 정상 분할 yielded는 실패 횟수를 늘리지 않는다.

중간 결과는 비공개·원문 사본 제외이며 완료·폐기·원문 변경·실패 종결 때 삭제한다. 자동 TTL을 추가하지 않는다. 게시·중간 저장 삭제·중복 방지 원자성과 정식 DB 반영은 별도 검증한다. 과거 실행·검증 결과는 [인계](../../docs/collaboration/requests/jonghyun/2026-09-29-review-policy-handoff.md)에 보존하며 새 정책의 구현 완료 근거로 쓰지 않는다.

## 1. 원문 자격과 읽기

AI 요약은 **로그인 회원에게 프로필 공개 조건을 충족한 한마디가 있는 후기 3개 이상**에서만 생성·노출한다. 공개 조건을 충족한 한마디는 로그인 회원에게 자동 공개하고 요약도 이 범위에서만 제공한다(2026-09-23 사용자 확인). 신고 접수만으로 비공개로 바꾸지 않고 운영자가 비공개 조치를 결정하면 공개 상태를 변경한다(2026-09-23 사용자 확인). 이때 공개 원문 revision 증가·이전 요약 무효화·재작업 예약(outbox) 기록을 같은 트랜잭션에서 처리해야 한다. 공백뿐인 한마디, 한마디 없는 평가, 비공개 후기는 제외한다. 공개 평가 총수와 실제 요약에 사용한 텍스트 후기 수를 분리한다. 기존 후기 RPC의 `released`는 당사자 사이의 상대 후기 열람 조건이며 프로필·제3자 공개 근거로 사용하지 않는다.

종현 로더가 민규의 권한 확인된 내부 조회 계약에서 받기를 제안하는 값:

```json
{
  "targetUserId": "user-01",
  "sourceRevision": "7",
  "publicTextReviews": [
    {"evidenceId":"r-01","comment":"일정 조율이 편했어요."},
    {"evidenceId":"r-02","comment":"약속 시간을 잘 지켰어요."},
    {"evidenceId":"r-03","comment":"전시 이야기를 나눴어요."}
  ]
}
```

이는 **가상 논리 응답**이다. 실제 식별자 형식·후기 공개 근거·조회 RPC는 [요약 DB 계약](review-summary-db.md)의 연결 매핑을 따른다. 원문과 revision은 일관된 상태에서 읽어야 한다. 모델에 임시 `evidenceId`를 쓰면 워커 메모리에서 실제 후기 ID와 대응시키고 게시 요청에는 검증 가능한 실제 후기 ID를 전달한다. 작성자 신원·별점만 있는 평가·비공개 후기·계좌·인증 자료는 모델에 보내지 않는다. 적격 후기는 전부 처리한다. 입력 한도를 넘으면 묶음별로 요약한 뒤 근거 ID를 보존하여 합친다. 일부만 고르거나 단일 긴 후기를 자동으로 자르지 않는다. 한 후기조차 한도를 넘으면 명시 실패로 보류한다.

## 2. 작업 입력·상태·게시

작업 메시지는 `targetUserId`, `sourceRevision`, `jobId`, `modelVersion`, `promptVersion`만 참조하고 **원문을 복제하지 않는다**. 공개 텍스트 후기 집합이 바뀌는 트랜잭션에서 revision 증가·기존 요약 무효화·재작업 예약(outbox) 기록을 함께 처리하는 DB 계약이 필요하다. 종현 워커는 작업을 점유한 뒤 최신 원문을 조회하고, 중복·이전 revision 작업은 게시하지 않는다.

| 순서 | 종현 처리 | 민규 DB 원자성·권한 |
|---|---|---|
| 조회 | 현재 공개 원문·revision 읽기, 3개 기준 검사 | 제3자 공개 근거 확인, 일관된 집합 반환 |
| 생성 | 근거 ID와 원문에 연결된 요약 생성, 과장·개인정보·원문 밖 추정 검사 | 원문을 작업 메시지·공개 응답에 노출하지 않음 |
| 게시 | `summaryText`, 실제 사용 후기 ID·실제 사용 수, `sourceRevision`, 모델·프롬프트 버전 전달 | 저장 시 현재 leaseToken·revision·원문 공개 상태·3개 기준 및 후기 ID의 대상 소속·중복 없음·수 일치 재검사. 같은 revision이어도 만료된 점유자는 거절 |
| 조회 | 게시 결과를 공개 화면에 전달 | 조회 때도 현재 revision·공개 3개 기준 확인. 무효 결과 비노출 |

내부 상태 `pending`, `ready`, `insufficient_reviews`, `failed`, `invalidated`는 **기술 제안**이며 DB enum 확정이 아니다. 3개 미만이면 `insufficient_reviews`; 모델 실패면 `failed`; 비공개 전환·revision 변경은 이전 요약을 `invalidated`로 취급한다. 실패나 부족 상태에도 원문 후기·칭찬 차트는 해당 공개 권한 안에서 계속 제공한다. 요약 생성은 열람 때마다 반복하지 않는다.

조건부 게시 요청과 결과의 가상 예:

```json
{"jobId":"job-01","leaseToken":"lease-current","targetUserId":"user-01","sourceRevision":"7","summaryText":"시간 약속과 전시 대화에 관한 긍정적 경험이 언급됐어요.","sourceReviewIds":["r-01","r-02","r-03"],"sourceReviewCount":3,"modelVersion":"example-model-v1","promptVersion":"review-summary-v1","modelVersions":["mock"]}
```

게시 결과는 `published`, `stale_revision`, `insufficient_reviews`, `not_public`, `invalid_evidence`처럼 **논리적으로 구분**해야 한다. 오류 코드·RPC 반환형은 합의 대상이다. DB는 전달한 후기 ID들이 현재 대상의 공개 텍스트 후기인지, 중복이 없는지, `sourceReviewCount`가 실제 ID 수와 일치하는지 확인해야 한다. 근거 ID가 존재해도 문장 의미가 정확하다는 보장은 없으므로 별도 평가 자료로 확인한다. 공개 조회는 로그인 회원으로 제한하고 요약문·기준 후기 수·갱신 시각·표시 상태만 담으며 내부 후기 ID·모델 버전·작업 상태 세부값은 노출하지 않는다.

## 3. 예약 작업과 완료·공개 시점의 경계

기존 순수 코어의 4종 작업과 `createReviewSummaryRegistry`의 review_summary 등록 경계는 유지한다. scheduled-jobs HTTP bridge는 내부 인증 후 고정 maintenance API를 호출하되 자동 완료를 배치 호출하지 않는다. 자동 완료는 건별 예약 실행기가 맡고 공개 정리·요약 등록은 별도 RPC다. **완료·후기 공개 정책은 공통 DB RPC**가 판단하며 워커가 개인별 완료 확인이나 시간 조건을 복제하지 않는다.

| 작업 | 호출 조건·기대 결과 | 중복·실패 경계 |
|---|---|---|
| 자동 완료 | 기한 전 한 명의 수동 확인만 있으면 완료 전 상태 유지. 예상 종료 +24시간에 미처리 상태이면 한 명 확인 여부와 관계없이 RPC가 자동 완료 판단; 취소·불발·분쟁은 제외 | 양쪽 수동 확인과 경쟁해도 완료·시각 중복 갱신 금지 |
| 후기 공개 시점 | 양쪽 제출 즉시, 한쪽은 실제 동행 완료+24시간, 이후 기한 내 제출 즉시. 완료부터 일반 작성 7일·분쟁 기한 보류/재개 예외, 실제 분쟁/미완료/불발 제외 | 제출·조회에서 적용, 일일 요약 작업이나 실제 알림 클릭을 기다리지 않음 |
| 요약 생성 | 공개 원문 집합 revision과 연결된 작업 | 중복 점유·오래된 작업의 게시 차단, 실패 시 원문 유지 |

작업 상태 `queued`·`running`·`retry_wait`·`succeeded`와 후속 `failed`·`superseded`, 점유 토큰은 기존 구현과 제안 SQL의 기술 계약이다. 실제 정식 DB에 적용된 범위는 [작업 큐 계약](worker-jobs.md)과 별도로 확인한다. AI 요약은 작업 테이블·워커와 하루 한 번 등록 경계를 사용하며 운영 일일 스케줄러 배포는 미실행이다. 자동 완료의 실행 수단은 건별 DB 예약·상주 Node 타이머이며 분 단위 전체 조회 cron을 사용하지 않는다. 재시도 횟수·간격·동시성은 운영 설정으로 명시 주입하고 임의 기본값을 두지 않는다. 지연된 자동 완료의 완료 시각·7일 작성 기한은 실제 성공 처리 시각부터 시작하며 예정 시각은 별도로 유지한다. 자동 완료를 개인의 수동 확인으로 기록하지 않는다.

## 4. 오류·검증

| 논리 결과 제안 | 처리 |
|---|---|
| `STALE_REVISION` / `NOT_PUBLIC` | 오래된 결과 폐기, 현재 revision 기준 후속 작업 확인. 이전 요약을 다시 노출하지 않음. |
| `INSUFFICIENT_REVIEWS` | 생성하지 않고 공개 요약 없음으로 응답. |
| `MODEL_UNAVAILABLE` | 합의된 범위에서 재시도. 공개 원문·칭찬은 유지. |
| `LEASE_LOST` / `DUPLICATE_JOB` | 이전 점유자의 게시 차단, 중복 완료 방지. |
| `FORBIDDEN` / `INVALID_INPUT` | 내부 호출 권한·작업 인자 거절. 오류에 원문 포함 금지. |

가상 사례는 [계약 사례](../../tests/fixtures/jonghyun/contract-cases.json)에 둔다. 확인 기준은 2개/3개·공백·비공개 제외, 생성 중 공개 변경, 중복 작업, 한 명/양쪽 수동 완료, 자동 완료 예외, 공개 보류다. 이는 로컬 DB·원격 검증 결과가 아니다. 현재 DB 계약은 [요약 DB](review-summary-db.md)·[후기 자동화 DB](review-automation-db.md), 남은 통합 요청은 [현재 민규 연결 요청](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-minkyu-requests.md)을 따른다. [9월 23일 요청](../../docs/collaboration/requests/jonghyun/2026-09-23-connection-contracts.md)은 당시 요청 근거다.

## 5. 재개형 요약과 원자 DB 포트

- `runReviewSummaryStep(job,deps)`는 명시된 호출 수·입력 크기 안에서 처리하고, 한 번에 끝나지 않으면 `yielded`로 반환한다. 실패 재시도와 정상 분할 실행을 구분한다.
- 임시 checkpoint에는 생성된 중간 요약·근거 ID·원문 revision·모델/프롬프트 버전·진행 위치만 둔다. 원문 복제·회원 조회는 금지한다. 완료·폐기·revision 변경 시 정리하며 실제 접근 제어와 정리는 민규 DB 계약으로 보장한다.
- `SummarySafetyPort`는 의미·개인정보 검사를 별도로 수행하는 필수 주입 경계다. 구조·근거 ID 검사만 통과했다고 의미 정확성을 보장하지 않는다. 현재 테스트의 검사기는 가상이며 실제 모델 품질/운영 검사 연결은 별도다.
- 조건부 게시 입력은 `jobId/leaseToken/targetUserId/sourceRevision/summaryText/claims/sourceReviewIds/sourceReviewCount/modelVersion/promptVersion/modelVersions`다. 여러 묶음/대체 모델을 썼다면 실제 사용 버전을 모두 추적한다. 게시·checkpoint 삭제는 원자 처리하고 작업 settle은 별도다. 게시 뒤 settle 전 중단에도 (jobId,sourceRevision) 기준 게시 멱등성으로 중복 효과를 막아야 한다.
- `createReviewSummaryHandler`가 요약 결과를 작업 상태에 연결하고 점유 손실은 settle 없이 반환한다. `runNextJob`·`createJobRegistry`는 요약·행사 수집·자동 완료·후기 공개 작업을 구분한다. 자동 완료/공개는 공통 RPC만 호출하며 수동 확인·완료 시각을 워커에서 대신 기록하지 않는다.
- Supabase Cron 등록·원격 실행·실제 DB 잠금/RLS·운영 수치·장애 알림은 아직 연결하지 않았다. [Edge 실행 제한](https://supabase.com/docs/guides/functions/limits)을 고려하여 분할 실행을 실제 런타임에서 검증해야 한다.

## 외부 보관 검토와 관측 연결

외부 AI 실제 회원 후기 전송은 포텐스닷의 보관 조건 답변을 팀이 검토하고 사용자가 확인하기 전까지 보류한다. 그 전에는 합성 입력만 사용한다. 보관·예외 기준은 [팀 검토 안건](../../docs/collaboration/requests/jonghyun/2026-09-23-team-ai-retention-review.md)이다. 공유 모델 라우터의 제공사별 보관 검토 상태를 거치며, 합성 승인값을 실제 계정 승인으로 사용하지 않는다. 유미당 오류·사용량 로그의 원문 미기록 정책은 유지한다.

공통 `metrics.ts`는 요청 UUID·기능·고정 결과·시간·재시도·허용된 모델/프롬프트 버전·토큰 수를 수신부에 전달한다. 원문·추가 metadata·회원 ID·오류 객체는 거절한다. 실제 워커 및 logger 연결은 아직 수행하지 않았고, 저장 위치·대상 가명 ID·보관기간은 별도 확인 항목이다.

2026-09-29 설계 답변: 추가 유료 지출은 0원, 보관 답변의 팀 검토·사용자 확인 전 합성 입력만 사용한다. 가상 공고·후기의 생성 결과를 함께 평가한 뒤 의미 검사 방법을 정하고 첫 실제 평가 결과 이후 품질 목표를 확정한다. 초기 지표는 영구 저장하지 않는다. 중간 요약은 정해진 완료·폐기·원문 변경·실패 종결 사건에 삭제하며 자동 TTL은 두지 않는다. 운영 로그·예산 원장 보존은 팀 검토다. 작업 한도·재시도 수치는 임의 운영값으로 채우지 않는다. 3개 기준·전체 적격 후기 처리·완료/폐기/후기 변경 시 중간 결과 정리는 유지한다. 이번 승인은 하네스의 로컬 정책 구현·검증이며 외부 AI 실호출 승인이 아니다.
