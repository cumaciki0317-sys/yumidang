# 내부 작업 큐·AI 예산 RPC — 민규 구현

## 현재 실행·보관 정책

후기 공개는 실제 완료 후 양쪽 제출 즉시/한쪽 완료+24시간의 제출·조회 조건으로 적용하고 일일 작업을 기다리지 않는다. 자동 완료는 예상 종료+24시간 건별 DB 영속 예약·Node 상주 실행기가 처리한다. 개인 완료 확인은 먼저 후기 제출을 허용하지만 작업자가 이를 동행 전체 완료로 바꾸지 않는다.

행사 갱신·새 요약 등록은 매일 00:01 Asia/Seoul이며 Top 10의 전국 전체/뮤지컬·어제까지 최근 7일 순위 갱신 실제 연결은 별도다. 요약 중간 결과는 비공개·원문 사본 제외, 완료·폐기·원문 변경·실패 종결 시 삭제하며 자동 TTL을 추가하지 않는다. 운영 한도·재시도·로그·예산 원장 보존은 팀 검토다. 외부 실제 회원 정보 전송은 공급사 보관 답변의 팀 검토·사용자 확인 전 보류한다.

`20261002130000_ai_budget_worker.sql`은 기존 큐에 실패 횟수·종결·양보 전이를 추가하고 원자 예산 원장을 제공한다. 현재 변경의 실제 DB 검증은 총괄·독립 B 담당의 실행 결과를 따른다. 이전 큐 검증을 새 변경의 성공 근거로 사용하지 않는다. `20260923090000_worker_jobs.sql`은 `private.worker_jobs`와 아래 RPC를 제공한다. [DB 기반 명세](db-foundation.md)의 작업 어댑터 의미를 실제 PostgreSQL 함수에 연결한다. HTTP 진입점·종현 어댑터·스케줄러·AI 모델은 이 변경에 포함하지 않는다. 격리 로컬 PostgreSQL에서 SQL 검증과 다중 세션의 중복 enqueue·SKIP LOCKED claim 검증을 통과했다. 실행 환경·전체 결과와 미검증 범위는 [민규 작업 현황](../../docs/collaboration/minkyu.md)에 기록한다. 잠금 대기 중 lease 만료의 별도 경쟁 검증은 아직 **NOT_RUN**이다.

## RPC 연결

모든 함수는 `public` 스키마에서 JSON 객체를 반환한다. 아래 반환은 HTTP `data` 안에 넣고 `requestId`는 HTTP 계층이 생성한다. 인증된 내부 서버만 `service_role`로 호출한다. 브라우저·AI 도구에 키·lease token을 전달하지 않는다.

| 어댑터 의미 이름 | 실제 RPC와 필수 매개변수 | 반환 |
|---|---|---|
| `enqueueJob` | `enqueue_job(p_kind text, p_dedupe_key text, p_payload jsonb, p_available_at timestamptz)` | `{jobId,deduplicated,status}` |
| `claimJob` | `claim_job(p_worker_id uuid, p_lease_seconds integer)` | `{job:null}` 또는 `{job:{jobId,kind,payload,leaseToken,leaseExpiresAt,attempt,failedAttempts}}` |
| `completeJob` | `complete_job(p_job_id uuid, p_lease_token uuid)` | `{jobId,status:"succeeded"}` |
| `yieldJob` | `yield_job(p_job_id uuid,p_lease_token uuid,p_available_at timestamptz)` | `{jobId,status:"queued"}` |
| `failJob` | `fail_job(p_job_id uuid,p_lease_token uuid,p_error_code text)` | `{jobId,status:"failed"}` |
| `supersedeJob` | `supersede_job(p_job_id uuid,p_lease_token uuid)` | `{jobId,status:"superseded"}` |
| `retryJob` | `retry_job(p_job_id uuid, p_lease_token uuid, p_available_at timestamptz, p_error_code text)` | `{jobId,status:"retry_wait"}` |

`workerId`는 실행 인스턴스 UUID다. 초 단위 lease는 **필수 입력**, 기술 범위 `1..86400`이며 운영 기본값은 없다. 서버 운영 설정이 결정되기 전 어댑터에 임의 timeout을 넣지 않는다. DB가 현재 시각과 lease 만료값을 계산한다. 입력 timestamp는 유한값만 허용하며 enqueue는 현재/과거/미래, retry는 잠금 획득 뒤 현재 시각 이상만 허용한다. 즉시 재시도를 위해 호출자가 오래된 `now`를 보내면 거절될 수 있으므로 정책이 정한 미래 시각을 전달한다.

## 허용 payload와 보존 정보

현재 kind는 **`review_summary`만 지원**한다. 새로운 kind를 임의 등록하지 않는다. 행사·자동 완료·후기 공개 처리의 큐 연결은 각 DB 실행 계약과 함께 후속 확장한다.

```json
{
  "profileId": "22222222-2222-4222-8222-222222222222",
  "sourceRevision": "7",
  "modelVersion": "model-v1",
  "promptVersion": "prompt-v1"
}
```

네 필드는 모두 필수 문자열이며 추가 키를 거절한다. profileId는 소문자 UUID 형태, sourceRevision은 부호·선행 0 없는 0 이상 19자리 이하 정수 문자열, 버전은 `[A-Za-z0-9_.-]{1,64}` 표식이다. 큐는 revision의 실제 존재·현재 유효성이나 모델 버전의 승인 여부를 보장하지 않는다. 실행 시 snapshot과 조건부 게시 RPC에서 다시 검사한다. payload에 대화·후기·요약·검색어·위치 원문을 저장하지 않는다.

`dedupeKey`는 프로필 UUID·revision·모델/프롬프트 버전을 조합한 식별용 키로 만들고 원문을 넣지 않는다. 1~512자 영숫자·밑줄·점·콜론·하이픈만 허용한다. worker ID는 UUID만 받고 error code는 `UPSTREAM_UNAVAILABLE`, `RATE_LIMITED`, `TIMEOUT`, `STATE_CHANGED`, `INTERNAL_ERROR`만 저장한다. 구조·문자 제한은 외부 시스템의 잘못된 값 선택을 모두 판별하는 원문 탐지기는 아니다. 호출자는 버전·키에 사용자 내용을 인코딩해서 넣어서도 안 된다. 모델 출력·SQL 오류·공급자 응답은 저장하지 않는다.

## 원자성·권한·실패

- `(kind,dedupe_key)` 유일성은 DB 제약이다. 같은 키·JSON 값이 같은 payload면 첫 레코드를 돌려준다. JSON 키 순서는 무관하다. availableAt 변경 요청도 첫 시각을 유지하며 succeeded를 다시 등록하지 않는다. 같은 키의 다른 payload는 충돌이다.
- claim은 due queued/retry_wait 또는 만료 running 한 건을 `FOR UPDATE SKIP LOCKED`로 잠그고 새 토큰과 증가한 attempt를 기록한다. 다른 worker가 잠근 행은 건너뛰며 후보가 없으면 `{job:null}`이다.
- 완료·재시도는 행 잠금 후 DB `clock_timestamp()`로 토큰·running·만료 전을 재검증한다. 만료 경계는 `leaseExpiresAt <= DB now`다. 이전 토큰·만료 토큰·재시도 뒤 폐기된 토큰·완료된 작업 재완료는 모두 거절한다.
- RLS를 활성화하고 클라이언트 정책을 만들지 않는다. anon/authenticated/service_role에 테이블 직접 권한을 주지 않는다. 허용된 `SECURITY DEFINER` RPC만 service_role에 허용하며 PUBLIC/anon/authenticated 실행 권한을 회수한다. `search_path=pg_catalog,pg_temp`와 명시적인 private 테이블 참조를 사용한다. DB 소유자·관리자는 검사/마이그레이션을 할 수 있다.
- SQLSTATE `22023`/`invalid_input` → `INVALID_REQUEST`/400, `42501` → 서버가 인증 문맥을 확인해 `AUTH_REQUIRED`/401 또는 `ACCESS_DENIED`/403, `P0001`/`state_conflict` → `STATE_CONFLICT`/409. 모든 상태 충돌은 `retryable:false`. SQL 오류 detail·원문·query·payload·token을 응답/로그에 복사하지 않는다. HTTP 매핑 구현은 별도 어댑터 작업이다.
- 기본 READ COMMITTED에서 중복 INSERT 승자를 후속 SELECT로 읽는다. 높은 격리수준의 serialization failure(`40001`)는 호출자가 트랜잭션 전체를 재시도할 수 있는 인프라 오류이며 업무 성공으로 바꾸지 않는다.
- 상태는 queued/running/retry_wait/succeeded/failed/superseded다. succeeded/failed/superseded만 completed_at이 있고 다시 claim하지 않는다. 정상 분할·예산 연기는 yield로 queued에 돌려보내며 failedAttempts를 늘리지 않는다. p_available_at null은 DB 현재 시각, 지정 시 잠금 후 현재 시각 이상이다. retry/fail만 failedAttempts를 늘리고 supersede는 실패로 세지 않는다. attempt는 claim마다 증가한다.
- 성공 완료·실패 종결·대체 종결은 자기 작업 checkpoint를 삭제한다. retry/yield는 재개를 위해 보존한다. 최대 실패 횟수·지연·보존 기간·lease 연장·운영 수치와 일일 실행 환경은 별도 명시 설정이며 SQL이 기본값을 정하지 않는다. 행사·자동 완료 kind를 추가하지 않는다.
- 실행은 최소 한 번이며 현재 점유권·공개 revision을 재검사하는 게시 표식으로 모델 중복 호출을 막는다. [요약 DB 계약](review-summary-db.md)의 projection → job → checkpoint 잠금 순서를 따른다.

## 원자 AI 예산

원장은 사용자 ID·대화·후기·프롬프트를 저장하지 않는다. ledgerId, 제공처 표식, 기술 작업 종류, 예약·보고 사용량만 저장한다. 개인별 이력이나 운영 로그로 사용하지 않는다. 한도·원장 교체 주기·보존·열람 범위는 팀 검토이며 자동 일일 재설정·기본 원장·자동 TTL을 추가하지 않는다.

모든 예산 RPC는 service_role 전용이다. configure/get은 신뢰된 운영·검증 경로에서만 호출하고 일반 HTTP 라우트에 노출하지 않는다.

| RPC | 인수 | 반환 |
|---|---|---|
| configure_ai_budget_ledger | p_ledger_id text,p_unit_limit bigint,p_call_limit bigint | {ledgerId,configured:true} |
| reserve_ai_budget | p_ledger_id text,p_provider_id text,p_task text,p_units bigint | {reservationId:uuid} 또는 {reservationId:null} |
| settle_ai_budget | p_reservation_id uuid,p_outcome text,p_input_tokens bigint,p_output_tokens bigint | {settled:true} |
| get_ai_budget_ledger | p_ledger_id text | {ledgerId,unitLimit,callLimit,reservedUnits,chargedUnits,openCalls,settledCalls,unknownUsageCalls} 또는 null |

단위는 입력 UTF-8 바이트·고정 prompt 바이트·최대 출력 토큰으로 산정한 보수적 상한이다. 금액·공급사 청구 토큰과 같은 값이라고 설명하지 않는다. task는 intent/preference_match/explanation/review_chunk/review_merge만 허용한다. ledgerId는 `[A-Za-z0-9_.:-]{1,64}`, providerId는 `[a-z0-9_.-]{1,32}`이다. 한도·예약량은 양수 bigint다.

같은 원장의 예약과 정산은 원장 → 예약 행 순서로 잠근다. reserved+charged 및 open+settled에 신규 예약을 포함해 명시 한도를 넘으면 reservationId:null이다. 설정된 원장이 없으면 P0002/budget_ledger_unavailable로 실패한다. configure는 이미 소비·예약한 양을 지우지 않는다. 한도를 낮추면 새 예약만 막는다. 비교 합산은 numeric으로 수행하여 bigint overflow가 제한 검사를 우회하지 못하게 한다.

usage_reported는 확인된 입력·출력 토큰을 소비하고 예약 상한을 넘는 보고도 숨기지 않는다. usage_unknown은 전체 예약을 소비하며 두 토큰 인수는 null이어야 한다. 중단·사용량 미확인 예약은 정산 전까지 한도를 계속 점유하고 임의 환불하지 않는다. 예약은 한 번만 정산되어 두 번째 요청은 P0001/budget_reservation_settled다. 합산·저장 범위를 넘으면 22023으로 전체 정산을 rollback하고 원래 예약을 보존한다. 공급사 보고 필드의 신뢰성은 호출 계층이 확인한다.

모델·보관 결정·비용 근거·원장 설정·호출 한도 등 필수 설정이 없으면 모델 호출 전 실패한다. DB의 원장 검사만으로 공급사 보관 조건·사용자 동의·무료 호출이 검증된 것으로 보지 않는다. 외부 실제 회원 원문 전송은 보류 상태를 유지한다.

## 검증

격리 DB에 migration 적용 후 소유자 세션으로 실행한다. 이 테스트는 기존 큐를 트랜잭션 안에서 비우므로 원격/공유 운영 DB에서 실행하지 않는다. 종료 시 rollback하며 pgTAP을 요구하지 않는다.

```sh
psql -X -v ON_ERROR_STOP=1 -f tests/database/minkyu/worker_jobs.sql "$LOCAL_DATABASE_URL"
```

RLS/직접 권한, 익명·회원 거절, service_role RPC, 잘못된 payload/lease/kind/error, 같은 키 중복·payload 충돌, 빈 claim, 미래 작업 제외, 만료·재점유·옛 토큰 거절, retry 도래와 terminal 재실행 방지를 검증한다. 단일 SQL 파일의 연속 호출은 두 실제 세션의 경쟁 검증을 대신하지 않는다. 총괄의 별도 동시 세션 테스트에서 unique enqueue 경쟁과 잠긴 후보를 건너뛰는 claim을 검증했다. 잠금 대기 중 lease 만료의 별도 경쟁 검증은 **NOT_RUN**이다.

구현 근거: PostgreSQL 공식 문서의 [함수 권한과 안전한 SECURITY DEFINER](https://www.postgresql.org/docs/current/sql-createfunction.html), [SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html), [실제 시각 clock_timestamp](https://www.postgresql.org/docs/current/functions-datetime.html).

추가 변경의 필수 검증은 tests/database/minkyu/common_connections.sql 및 별도 경합 검사에서 예산 동시 예약·중복 정산·overflow rollback, yield/retry 실패 수 분리, terminal 재점유 금지와 공개 변경 대 게시 경합을 확인한다. 실제 실행 결과는 총괄 인계에 기록하고 NOT_RUN과 PASS를 구분한다.
