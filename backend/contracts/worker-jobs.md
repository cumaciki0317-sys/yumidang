# 내부 작업 큐 RPC v1 — 민규 구현

## 현재 실행·보관 정책

후기 공개는 실제 완료 후 양쪽 제출 즉시/한쪽 완료+24시간의 제출·조회 조건으로 적용하고 일일 작업을 기다리지 않는다. 자동 완료는 예상 종료+24시간 건별 DB 영속 예약·Node 상주 실행기가 처리한다. 개인 완료 확인은 먼저 후기 제출을 허용하지만 작업자가 이를 동행 전체 완료로 바꾸지 않는다.

행사 갱신·새 요약 등록은 매일 00:01 Asia/Seoul이며 Top 10의 전국 전체/뮤지컬·어제까지 최근 7일 순위 갱신 실제 연결은 별도다. 요약 중간 결과는 비공개·원문 사본 제외, 완료·폐기·원문 변경·실패 종결 시 삭제하며 자동 TTL을 추가하지 않는다. 운영 한도·재시도·로그·예산 원장 보존은 팀 검토다. 외부 실제 회원 정보 전송은 공급사 보관 답변의 팀 검토·사용자 확인 전 보류한다.

`20260923090000_worker_jobs.sql`은 `private.worker_jobs`와 아래 RPC를 제공한다. [DB 기반 명세](db-foundation.md)의 작업 어댑터 의미를 실제 PostgreSQL 함수에 연결한다. HTTP 진입점·종현 어댑터·스케줄러·AI 모델은 이 변경에 포함하지 않는다. 격리 로컬 PostgreSQL에서 SQL 검증과 다중 세션의 중복 enqueue·SKIP LOCKED claim 검증을 통과했다. 실행 환경·전체 결과와 미검증 범위는 [민규 작업 현황](../../docs/collaboration/minkyu.md)에 기록한다. 잠금 대기 중 lease 만료의 별도 경쟁 검증은 아직 **NOT_RUN**이다.

## RPC 연결

모든 함수는 `public` 스키마에서 JSON 객체를 반환한다. 아래 반환은 HTTP `data` 안에 넣고 `requestId`는 HTTP 계층이 생성한다. 인증된 내부 서버만 `service_role`로 호출한다. 브라우저·AI 도구에 키·lease token을 전달하지 않는다.

| 어댑터 의미 이름 | 실제 RPC와 필수 매개변수 | 반환 |
|---|---|---|
| `enqueueJob` | `enqueue_job(p_kind text, p_dedupe_key text, p_payload jsonb, p_available_at timestamptz)` | `{jobId,deduplicated,status}` |
| `claimJob` | `claim_job(p_worker_id uuid, p_lease_seconds integer)` | `{job:null}` 또는 `{job:{jobId,kind,payload,leaseToken,leaseExpiresAt,attempt}}` |
| `completeJob` | `complete_job(p_job_id uuid, p_lease_token uuid)` | `{jobId,status:"succeeded"}` |
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
- RLS를 활성화하고 클라이언트 정책을 만들지 않는다. anon/authenticated/service_role에 테이블 직접 권한을 주지 않는다. 네 `SECURITY DEFINER` RPC만 service_role에 허용하며 PUBLIC/anon/authenticated 실행 권한을 회수한다. `search_path=pg_catalog,pg_temp`와 명시적인 private 테이블 참조를 사용한다. DB 소유자·관리자는 검사/마이그레이션을 할 수 있다.
- SQLSTATE `22023`/`invalid_input` → `INVALID_REQUEST`/400, `42501` → 서버가 인증 문맥을 확인해 `AUTH_REQUIRED`/401 또는 `ACCESS_DENIED`/403, `P0001`/`state_conflict` → `STATE_CONFLICT`/409. 모든 상태 충돌은 `retryable:false`. SQL 오류 detail·원문·query·payload·token을 응답/로그에 복사하지 않는다. HTTP 매핑 구현은 별도 어댑터 작업이다.
- 기본 READ COMMITTED에서 중복 INSERT 승자를 후속 SELECT로 읽는다. 높은 격리수준의 serialization failure(`40001`)는 호출자가 트랜잭션 전체를 재시도할 수 있는 인프라 오류이며 업무 성공으로 바꾸지 않는다.
- 상태는 queued/running/retry_wait/succeeded다. 최대 재시도·실패 종결·보존 기간·lease 연장·운영 수치·스케줄링은 아직 정하지 않았다. 작업 삭제나 실패 성공 변환으로 미정 정책을 대신하지 않는다. 실행은 최소 한 번이므로 외부 부작용과 요약 게시도 멱등 처리가 필요하다.

## 검증

격리 DB에 migration 적용 후 소유자 세션으로 실행한다. 이 테스트는 기존 큐를 트랜잭션 안에서 비우므로 원격/공유 운영 DB에서 실행하지 않는다. 종료 시 rollback하며 pgTAP을 요구하지 않는다.

```sh
psql -X -v ON_ERROR_STOP=1 -f tests/database/minkyu/worker_jobs.sql "$LOCAL_DATABASE_URL"
```

RLS/직접 권한, 익명·회원 거절, service_role RPC, 잘못된 payload/lease/kind/error, 같은 키 중복·payload 충돌, 빈 claim, 미래 작업 제외, 만료·재점유·옛 토큰 거절, retry 도래와 terminal 재실행 방지를 검증한다. 단일 SQL 파일의 연속 호출은 두 실제 세션의 경쟁 검증을 대신하지 않는다. 총괄의 별도 동시 세션 테스트에서 unique enqueue 경쟁과 잠긴 후보를 건너뛰는 claim을 검증했다. 잠금 대기 중 lease 만료의 별도 경쟁 검증은 **NOT_RUN**이다.

구현 근거: PostgreSQL 공식 문서의 [함수 권한과 안전한 SECURITY DEFINER](https://www.postgresql.org/docs/current/sql-createfunction.html), [SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html), [실제 시각 clock_timestamp](https://www.postgresql.org/docs/current/functions-datetime.html).
