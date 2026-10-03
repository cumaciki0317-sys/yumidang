# 완료 DB 연결 계약

## 개인 완료·후기 제출과 실제 완료의 경계

예상 종료 후 본인 완료 확인을 마친 당사자는 상대방 완료를 기다리지 않고 후기를 제출할 수 있다. 한 명만 확인한 상태는 동행 전체 완료가 아니며 해당 후기는 비공개다. 두 사람 확인 또는 예상 종료+24시간 자동 처리(취소·불발·분쟁 제외)로 실제 완료한다. 지연 처리면 실제 성공 시각을 완료 시각으로 기록한다. 실제 완료부터 작성 마감 7일·한쪽 후기 공개 24시간을 계산하며 양쪽 제출은 완료 조건 충족 후 즉시 공개한다. 완료 횟수는 실제 완료 즉시, 당도는 상대 후기 열람 가능 시 반영한다.

`20261002110000_completion_review_policy.sql`의 `private.can_submit_appointment_review`가 개인 확인·상태·실제 완료 이후 작성 기한을 확인한다. 공개 여부는 `private.is_review_public_eligible`로 상대 조회·공개 프로필·칭찬·요약 입력에 일치시킨다. 실제 완료 횟수는 후기와 독립적인 이력 집계이며 당도 산식은 미구현이다. 검증 결과는 [순차 작업 인계](../../docs/collaboration/requests/minkyu/2026-10-02-ordered-backend-handoff.md)에 기록한다.

현재 적용할 서비스 정책은 [정책.md](../../정책.md)를 따른다. 한쪽 후기 공개는 **실제 동행 완료 시각 +24시간**, 양쪽 제출은 즉시다. 당도는 상대 후기를 열람할 수 있게 될 때 동시에 반영하고, 완료 횟수는 후기와 관계없이 동행 완료 즉시 반영한다. 당도 산식은 민규·팀 검토 필요다. 아래 RPC·구현·검증 기록과 정책의 확정은 구분하며, 이번 문서 동기화에서 코드·DB·화면의 최신 정책 일치 여부는 검증하지 않았다. [반영 확인 작업](../../정책.md#follow-ups)을 확인한다.

양측 수동 완료: `20260923100000_bilateral_completion.sql`. 건별 자동 완료 예약·2026-09-29 공개 조건 구현: `20260929120000_review_release_and_completion_reservations.sql`. 기존 migration과 완료 이력은 다시 쓰지 않는다.

## 사용자 호출

`confirm_appointment_completion(p_appointment_id uuid)`는 인증된 약속 당사자만 호출한다. 기존 table 응답 signature를 유지한다. 예상 종료 이후 자신의 확인을 한 번 기록하고 한 명만 확인한 경우 `status=confirmed`, `completed_at/completion_notified_at=NULL`이다. 두 명의 확인이 있으면 `completed`, `completion_method=manual`로 바뀐다. 마지막 확인자의 ID는 감사 정보이며 상대 확인을 대신 생성하지 않는다. 재요청은 기존 확인·완료 시각을 보존한다.

`get_appointment_state(p_appointment_id uuid)`는 기존 응답에 포함된 `my_completion_at`, `peer_completion_at`을 각각 제공한다. 이미 확인한 사람에게 `can_confirm_completion=false`이며 상대 확인 대기를 표시할 수 있다. 상대·시각·주소 권한은 기존 당사자 조회 계약을 유지한다.

익명은 `28000`, 외부 회원/없는 약속은 `PT404`, 종료 이전·취소·불발·분쟁은 `22023`이다. 원본 SQL 메시지는 공통 API가 공개 오류 코드로 변환한다.

## 내부 자동 완료 — 건별 영속 예약

DB가 약속별 `appointmentId`·`dueAt`·`generation` 예약을 영속 보존하며 dueAt은 예상 종료+24시간이다. 일정 변경·취소·수동 완료·실제 분쟁 변화로 예약을 갱신/제거한다. 상주 Node 실행기가 LISTEN/NOTIFY로 변경을 받고 해당 시각 타이머를 등록한다. 시작·재접속에는 현재 예약을 읽어 이미 기한이 지난 작업을 복구한다. 알림은 깨우기 신호이며 영속 예약 행이 원천이다. 분 단위 전수 검사 cron은 후속 migration에서 해제한다.

- `list_completion_reservations()` → `{serverNow,reservations:[{appointmentId,dueAt,generation}]}`. 기존 service_role과 아래 전용 실행 역할의 고정 호출이며 DB 시각으로 타이머를 계산한다. appointmentId와 generation은 UUID 문자열이고 generation을 순번이나 숫자로 변환하지 않는다.
- `execute_completion_reservation(p_appointment_id uuid,p_generation uuid)` → `{status:"completed"|"not_due"|"stale",completedAt?:...}`. 현재 예약 세대·시각·상태를 원자적으로 재검사한다. 오래된 예약이나 수동 완료와의 경쟁으로 완료 시각을 덮지 않는다.
- 운영 상주 프로세스 배포는 별도다. 일일 행사/요약 등록 스케줄러와 자동 완료를 묶지 않는다.

## 상주 실행기 준비와 운영 전환

실행 파일은 `backend/supabase/functions/scheduled-jobs/completion-runner.mjs`다. Node 22.18.0 이상에서 실행하며 Edge 요청 수명에 장기 타이머를 맡기지 않는다. 실행 환경에 다음 값을 명시적으로 주입한다. 실행기는 `.env` 파일을 자동으로 읽지 않는다.

- `COMPLETION_DATABASE_URL`: 위 RPC를 실행할 수 있는 서버 전용 PostgreSQL 연결 문자열. LISTEN 연결을 유지할 수 있는 direct 또는 session 연결을 사용한다. transaction pool 연결은 사용하지 않으며 비밀값을 문서·로그에 남기지 않는다.
- `COMPLETION_RECONNECT_MS`: 재연결 대기 시간(밀리초). 양의 정수이며 운영 기본값은 없다.
- `COMPLETION_QUERY_TIMEOUT_MS`: 접속·쿼리·statement 제한 시간(밀리초). 양의 정수이며 운영 기본값은 없다.

밀리초 설정 상한은 2,147,483,647이다. 비로컬 연결은 TLS 인증서 검증을 켜며 URL의 ssl 관련 query 인자를 허용하지 않는다. 환경을 준비한 뒤 저장소 루트에서 실행한다.

```sh
cd backend
npm ci
npm run completion-scheduler
```

운영 전환 시 runner 의존성·명시 환경·상주 프로세스 관리 준비와 migration의 기존 cron 해제를 하나의 전환 작업으로 묶는다. 준비된 runner가 새 RPC에 연결하고 `COMPLETION_SCHEDULER_READY`를 보고하며 기존 기한 도래 예약을 복구하는지 확인한다. cron만 해제하고 runner 기동을 후속 작업으로 미루지 않는다. runner 장애 중 예약은 DB에 남고 재접속 때 복구되지만 장애 동안 자동 완료가 늦어질 수 있다. 이번 운영 migration·상주 프로세스 배포는 미실행이며 로컬 검증 결과와 구분한다.

## 호환용 배치 RPC와 완료 시각

`process_due_completions(p_limit integer)`는 `service_role` 전용이며 범위는 1~1000이다. 응답은 `{completedCount, appointments:[{appointmentId,completedAt}]}`이다. `confirmed`이면서 예상 종료 +24시간이 지난 행만 `FOR UPDATE SKIP LOCKED`로 처리하며 열린 분쟁과 불발 판정도 제외한다. 자동 처리는 개인 수동 확인 기록을 만들지 않는다.

**사용자 확정:** 지연 실행도 실제 자동 완료 처리 시각을 `completed_at`으로 기록하고, 그 시각부터 7일 작성 기한을 계산한다. 현재 정책의 한쪽 후기 공개 기준은 `completed_at +24시간`이다. 기존 구현이 함께 기록하는 `completion_notified_at`은 알림 메타데이터이며 정책의 기준 시각으로 대신 사용하지 않는다. 양쪽 후기 제출은 이 24시간 전에 즉시 공개할 수 있다. 외부 호출자가 기준 시각을 주입하지 못한다. 기존 cron이 호출하는 `private.complete_due_appointments`도 이 규칙으로 교체하며 기존 `p_at` 인수는 호환용으로만 받고 사용하지 않는다.

완료 전환과 두 당사자의 `appointment_completed` 알림은 동일 DB 트랜잭션이다. 고유 제약으로 중복 알림을 방지하고 알림 클릭은 완료를 실행하지 않는다. 한쪽 후기 공개는 실제 완료 시각을 기준으로 하며 알림 행 생성·실제 클릭 시각으로 기준을 바꾸지 않는다. 전환 방향은 위 건별 예약 경로이며 기존 분 단위 전수 검사 cron 해제는 상주 운영 실행기 준비·복구 확인과 함께 수행한다. 현재 원격의 기존 cron을 해제했다는 뜻이 아니다.

## 전용 완료 실행 역할 — 2026-10-03 로컬 검증

이 권한 변경은 [최신 자동 처리 정책](../../정책.md#자동-처리실행비용)의 건별 영속 예약·상주 Node 실행·시작/재접속 복구를 지원한다. 완료 시각·양쪽 수동 확인·예외·후기 공개 기준을 바꾸지 않는다. 원형 종현 `completion-runner.mjs`와 두 RPC의 본문/signature도 유지한다.

신규 migration `20261003090000_completion_runner_role.sql`의 대상은 `NOLOGIN NOINHERIT` 그룹 `yumidang_completion_runner`다. 앱 영역의 권한은 `public` schema USAGE와 정확한 `public.list_completion_reservations()`·`public.execute_completion_reservation(uuid,uuid)` EXECUTE다. public/private의 테이블·열·sequence 접근, schema CREATE, 다른 업무 RPC·역할 승격 권한을 추가하지 않는다. 기존 service_role의 두 RPC 권한과 anon/authenticated 거절은 유지한다. 그룹에 접속 자격 증명을 저장하거나 로그인 기능을 부여하지 않는다.

별도 LOGIN의 이름·비밀번호·연결 대상은 비공개 운영 provisioning에서 준비하고 `INHERIT`와 위 그룹 membership을 부여한다. LOGIN은 superuser·BYPASSRLS·CREATEROLE·CREATEDB·REPLICATION 및 관리자/anon/authenticated/service_role membership을 갖지 않는다. 기존 동명 역할의 더 넓은 속성·권한을 묵인하거나 역할 전체를 임의 재작성하지 않는다. 운영 LOGIN과 자격 증명의 생성·보관·교체는 이 migration에 포함하지 않는다.

PostgreSQL16 이상에서 비-superuser의 역할 생성에 따라 자동으로 생기는 관리 membership은 실행 LOGIN과 구분한다. 이번 SQL은 **해당 DO에서 그룹을 새로 생성한 경우만**, 생성 실행자·member가 `postgres`(비-superuser CREATEROLE), grantor가 `supabase_admin`(superuser)이며 `ADMIN=true / INHERIT=false / SET=false`인 자동 관리 행을 허용한다. 이는 생성자의 역할 관리 권한이며 그룹의 앱 실행 권한을 상속하거나 SET ROLE로 사용하는 권한이 아니다. 기존 동명 그룹의 membership·그룹의 parent membership 또는 다른 옵션/생성자/수여자는 거절한다. 운영 실행 LOGIN에는 별도 단일 그룹의 실행 상속을 부여하며 자동 관리 행을 실행 자격 증명으로 사용하지 않는다. 이 예외는 기존 권한을 임의 회수하거나 관리자 연결을 운영 완료로 인정하는 근거가 아니다.

명시 GRANT 두 개만 보고 실효 권한이 두 개라고 판단하지 않는다. PostgreSQL의 모든 역할이 상속하는 `PUBLIC` 권한도 검사한다. 앱 schema의 table/column/sequence/CREATE 및 함수 EXECUTE는 실효 권한 기준으로 정확한 범위를 확인한다. `PUBLIC`에 남아 있는 권한을 특정 그룹의 REVOKE만으로 차단할 수는 없다. 기존 자료·다른 호출자 권한을 보존하고 예상 밖 앱 권한이 있으면 적용을 중단한다. PostgreSQL 기본 `CONNECT`·`TEMP`·`pg_catalog` 사용 등은 공용 기반 권한으로 별도 기록하며 'DB에서 두 함수 외 모든 동작 금지'를 주장하지 않는다.

객체 ACL만으로 이름을 통한 실효 접근을 판정하지 않는다. relation/column/sequence 접근과 함수 호출은 해당 schema의 `USAGE`도 함께 확인한다. 이번 로컬 확인에서 `cron.job`·`cron.job_run_details`에 inherited PUBLIC SELECT가 남아 있었지만 전용 역할의 `cron` USAGE는false였고 실제 LOGIN의 직접 SELECT는 schema 권한으로 거절됐다. 검사는 이 잠재 ACL과 실효 접근을 구분하며 cron 전체를 검사에서 제외하거나 PUBLIC 권한을 전역 회수하지 않는다. 함수·schema CREATE 검사와 다른 앱 객체 검사도 유지한다.

LISTEN/NOTIFY에는 채널별 ACL이 없다. 원형 실행기는 `yumidang_completion_reservations` 채널을 구독하지만 DB 역할이 해당 채널만 사용할 수 있다는 권한 보장은 아니다. 알림 payload를 회원 원문·비밀의 전달 수단으로 사용하지 않고 영속 예약을 다시 조회하는 깨우기 신호로 취급한다. LISTEN 세션과 조회·실행을 지속할 direct 또는 session 연결이 필요하며 transaction pool을 사용하지 않는다. 재접속 때 LISTEN을 다시 설정한 뒤 예약을 조회한다. 호스트·TLS/접속 정보·재연결/timeout 운영값은 별도 준비이며 기본값을 임의 확정하지 않는다.

[이번 하네스](../../docs/collaboration/minkyu-completion-role-harness.json)·[총괄 인계](../../docs/collaboration/requests/minkyu/2026-10-03-completion-role-handoff.md): 총괄이 전용 로컬 CLI39 migration 적용·기동 exit0, 실제 로컬 `supabase_admin`의 DB 검사5그룹 PASS/rollback을 확인했다. 별도 실제 통합은 **4그룹·412확인 PASS**다. 합성 fixture 생성/정리에는 관리자 연결을 사용했고, 원형 완료 실행기는 별도 제한 LOGIN으로 연결했다. 앱 자료 접근·다른 업무 RPC·관리자 역할 거절과 두 RPC의 실행 권한을 확인했으며 시작 시 기한 경과 예약·committed NOTIFY 일정 변경·세션 단절 뒤 재접속·정지 중 예약 후 재시작 복구를 통과했다.

`syntheticCleanup:true`, `restrictedWorkerConnection:true`, `workerPermissions:true`이며 정리 후 앱37테이블0·임시 LOGIN 제거를 확인했다. 기존145개 파일과 원형 종현 실행기는 보존했다. 앞선 관리자 연결의 복구195확인과 이번 제한 LOGIN의412확인은 별도 실행으로 합산하지 않는다. 이 결과는 **로컬 최소 권한 검증**이며 `productionLeastPrivilege/remote:NOT_RUN`이다. 운영 LOGIN·비밀값·direct/session 대상·상주 호스팅·운영 복구/백업·기존 cron 해제·일일00:01 등록은 수행하지 않았다. 전체 진행률은43%·6/14를 유지한다.

실제 완료부터 7일은 일반 작성 기간이다. 실제 분쟁 중 작성·기한·공개 보류와 동행 인정 후 남은 기간 재개·최소 24시간 보장의 기존 예외를 유지한다. 분쟁 판단·종결·수동 완료 후 누가 이의 신청 가능한지에 관한 기존 세부 제한은 이번 작업에서 임의 재정의하지 않는다. 기존 분쟁 RPC의 상세 정책 검토가 별도로 남는다.

## 검증

`tests/database/minkyu/bilateral_completion.sql`은 트랜잭션 롤백 fixture로 한 명/양측 확인, 재시도, 권한, 이른 시점/취소/분쟁 거절, 지연 자동 완료 시각, 알림 중복 방지, 실제 DB 역할을 검사한다. 새 `review_release_policy.sql`은 예약 생성·변경·무효화·기한 전 호출·세대 경쟁·실제 자동 완료를 검증한다. 실제 실행 결과는 [새 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-review-policy-handoff.md)를 따른다.
