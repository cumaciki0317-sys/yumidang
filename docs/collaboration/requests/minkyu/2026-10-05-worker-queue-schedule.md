# 작업 예약 조회·정리 실행 예산 초안

## 상태와 수정 경계

민규 독립 worktree의 신규40100 SQL·합성 DB 회귀·이 문서만 작성했다. source56 이후 적용 후보이며 실제 DB 적용/연결/실행은 아직 NOT_RUN이다. 기존30100 최종 후보와 immutable20135/20136, 종현 파일, main 파일은 수정하지 않았다. CLI `supabase@2.116.0 migration new worker_queue_schedule --workdir backend`로 생성한 파일을 소유권 확인 후 승인된40100 경로로 정리했다. 글로벌 역할 생성·변경, 실행 권한 개방, 운영 쓰기는 없다.

현재 정식 SQL에는 `read_worker_queue_schedule`이 없다. 종현 `scheduled-jobs/queue-runner.mjs`의 schedule 호출과 `_shared/jobs/background.mjs`의 응답 검사에 맞춘 조회 포트를 준비한다. 기존 `acquire_worker_run(integer,uuid)`의 exact `{token,expiresAt}` 반환은 바꾸지 않는다.

## 예약 조회 계약

`public.read_worker_queue_schedule(p_exclude_kinds text[]='{}',p_after_kind text=null)` → exact `{serverNow:string,nextDueAt:string|null,nextKind:"review_summary"|"event_sync"|"member_cleanup"|null}`.

두 시각은 PostgreSQL timestamptz의 JSON 문자열이며 J의 `Date.parse` 검사 대상이다. 후보가 없으면 nextDueAt/nextKind 둘 다 null이다. 조회 시점의 DB clock을 사용하며 원문·회원 UUID·작업 payload·token을 반환하지 않는다. excludeKinds는 최대3개, 허용 kind만 받을 수 있다. 중복은 무해하며 null/다차원/알 수 없는 값은22023이다. afterKind도 같은 허용 kind 또는 null이다.

review/event 슬롯은 worker_jobs의 queued/retry_wait available_at 또는 running lease_expires_at을 읽는다. cleanup은 실제 retirement와 같은 withdrawal/profile의 pending_cleanup task만 읽으며 pending은 현재 DB 시각, running은 점유 만료를 due로 삼는다. Auth task는 같은 withdrawal의 모든 Storage task가 completed인 경우에만 후보가 된다. 전역 singleton이 점유 중이면 nextDueAt을 해당 점유 만료보다 앞서 반환하지 않는다.

이미 due인 종류들은 caller의 afterKind 다음 순서로 교대한다. 미래 후보만 있으면 가장 이른 due를 반환한다. dispatch 이력/마지막 처리 종류를 DB에 새로 기록하지 않으며 J runner의 lastKind/excludeKinds를 그대로 사용한다. 서로 독립된 runner의 영구 공정성이나 종류별 starvation 방지까지 증명한 계약은 아니다. 조회는 claim/dispatch/삭제/완료 처리를 수행하지 않는다. 실제 실행은 동일 acquire/release 전역 점유와 기존 개별 task fence를 사용하고 한 실행의 처리 상한20은 실행 계층에서 유지해야 한다. 조회 함수가20건을 처리한 것처럼 기록하지 않는다.

## cleanup readiness와 재개

cleanup due는 external_deletion_approved=true이고 service_role의 claim/check/getDeleteAck/recordDeleteAck/complete 5개 RPC EXECUTE가 모두 유효할 때만 보인다. 이는20136 최초 탈퇴 readiness와 같은 조건이다. false 또는 권한 하나 누락 상태에서는 cleanup 후보만 숨기고 queued/pending/running task를 삭제하거나 completed로 바꾸지 않는다. review 후보는 계속 조회할 수 있다. 이 조건은 다른 계층의 실행 준비를 대신 증명하지 않으며 실제 각 RPC는 승인·현재 전역 점유·task/object 점유를 다시 검사한다.

guard 변경, task 상태 변경, worker job 변경, 전역 점유 변경은 COMMIT 이후 `yumidang_worker_jobs` 채널의 빈 payload NOTIFY로 깨운다. 권한 GRANT 자체에는 테이블 trigger가 없으므로 배포 준비를 마친 owner workflow는 마지막 승인 변경 또는 명시적 빈 payload wake/resume을 수행해야 한다. 알림 수신/재연결 후 runner는 반드시 DB 조회를 다시 한다. 아직 닫힌 native LOGIN 역할·runner 연결·실제 LISTEN 전달 증거는 별도 준비가 필요하다. 변경 중 readiness snapshot이 달라져도 task RPC가 fail closed하며 예약 조회를 성공 처리로 간주하지 않는다.

## 별도 DB 예산 포트

`public.read_worker_run_budget(p_worker_run_token uuid)` → exact `{remainingMs:integer}`. service_role JWT와 현재 전역 점유를 검사한 뒤 DB 시각 기준 남은 ms를 내림한다. 1..180000 범위를 벗어나거나 토큰 불일치·만료이면40001이다. 기존 acquire의2개 반환 필드와 허용 인수를 바꾸거나 lease를 연장하지 않는다. cleanup 실행 예산 reader는 이 포트만 허용하는 별도 transport를 사용한다. 기존 cleanup5개 RPC allowlist를 넓히거나 일반 internal RPC에 이 포트를 자동 추가하지 않는다.

M HTTP reader는 전체 왕복 시간을 차감하고 보수적인 host deadline으로 변환해야 한다. host 시각이 DB와 같다고 가정하지 않는다. 예산 조회 후에도 외부 삭제 직전 check 및 ack/complete의 DB fence는 필수다. 단독 예산 조회는 네트워크 작업 동안 lease가 유효하다는 보장이 아니다.

## 권한·남은 연결

적용 첫 DO는 기존 acquire owner의 catalog를 검사한다. owner는 일반 gateway 역할(anon/authenticated/service_role/authenticator)이거나 이 역할들이 즉시 상속 USAGE 또는 SET ROLE 전환 가능한 역할이면55000으로 중단한다. owner가 rolsuper 또는 rolbypassrls가 아닌 일반 역할인 경우도 중단하여 RLS가 후보를 조용히 숨기는 구성을 허용하지 않는다. private/public/auth schema USAGE, auth.role() 및 assert_current_worker_run EXECUTE, jobs/tasks/guard/retirements/global5개 ordinary table의 실효 SELECT와 global UPDATE가 필요하다. 부족하면 권한을 추가하지 않고 전체 transaction을55000으로 중단한다. global UPDATE는 helper의 FOR UPDATE 점유 검사에 필요하다. 이 검사는 FORCE RLS도 우회하는 기존 privileged owner만 허용하며 owner/RLS/ACL을 바꾸지 않는다.

보존된 실제 source56 schema-only dump `/private/tmp/yumidang-retention-source56-schema.sql`에서 acquire/helper/jobs/tasks/guard/global owner가 postgres이고 해당 private table에 RLS가 활성화된 것을 읽었다. 앞선 조합 검증의 `/private/tmp/yumidang-drift-catalog-44g9wt_e/sanction-retention-combination-corrected/core-permissions2.json`은 postgres rolsuper=false/bypassrls=true를 실제 확인한 증거다. 새 DB 접속은 하지 않았으며 최신 main59 canonical catalog 전체의 실효 권한·gateway 상속은 아직 재확인하지 않았다. 적용 START 전 읽기 preflight로 이 조건을 확인해야 한다. 과거 source56 증거를 main59 현재 검사 완료로 설명하지 않는다.

두 public RPC와 notify helper의 owner는 검사를 통과한 기존 acquire owner와 같다. PUBLIC/anon/authenticated/service_role EXECUTE를 모두 회수하며 새 LOGIN 역할/GRANT를 추가하지 않는다. 미래 scheduler role은 queue 조회·acquire·release에만 좁게 연결하고 Auth/Storage 키나 cleanup5개 직접 권한을 받지 않는 안이다. budget의 service EXECUTE도 지금은 닫혀 있다. DB/HTTP 오류를 빈 큐나 성공 결과로 삼키지 않는다.

현행 worker_jobs kind/payload CHECK와 enqueue_job·J DB_KINDS는 review_summary만 지원한다. event_sync의 조회 슬롯이 있어도 실제 행사 due를 만들 수 없고 claim/HTTP worker 포트도 아직 미연결이다. 신규 행사 payload/claim contract를 이 SQL에서 임의 확장하지 않는다. J background/queue-runner의 kinds·exclude 상한·member_cleanup HTTP 집계 연결은 별도 요청 범위다. 현재 SQL 존재나 정적 검사만으로 행사 처리·cleanup 상주 실행·배포 준비 완료라고 설명하지 않는다.

## 준비한 검증과 미검증

합성 BEGIN/ROLLBACK 회귀는 exact 반환/input/ACL, guard false·flag만 true·5개 중 각각 누락·준비된 조건의 due, task 보존, Storage→Auth due 의존, 종류 교대/exclude, 전역 점유 중 due, 예산 감소/잘못된 토큰/만료, event enqueue 미지원, 빈 payload trigger의 정적 범위를 확인하도록 작성했다. 합성 metadata completed 전이는 실제 provider 삭제 증거가 아니다. fixture 승인/5개 권한 준비는 rollback transaction 안에서만 수행한다.

추가 owner catalog 회귀는 apply 후 같은 owner·privileged role·schema/helper/table 실효 권한을 검사하도록 준비했다. 분리 owner/SELECT 부족/helper EXEC 부족/gateway USAGE/SET 경로·auth runtime 권한 부족/일반 역할 조건의 실제 실패 주입은 아직 NOT_RUN이며 별도 scratch fresh apply에서 기존 ACL·글로벌 역할 hash 불변과 함께 확인해야 한다. 테스트를 위해 기존 글로벌 역할을 변경하지 않는다. 실제 DB 적용·회귀·두 세션·COMMIT 알림 전달·신규 포트의 native role 연결·host/DB clock skew·상주 처리20건 집계는 아직 검증하지 않았다. root START 전 DB 연결/실행0을 유지한다.

PG17의 USAGE는 즉시 사용 가능한 역할 권한, SET은 SET ROLE 전환 가능 여부이므로 두 경로를 모두 거절한다. [PostgreSQL17 역할 권한 검사 공식 문서](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-INFO-ACCESS-TABLE)를 기준으로 확인했다.
