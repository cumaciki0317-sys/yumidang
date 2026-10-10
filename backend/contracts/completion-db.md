# 완료 DB 연결 계약

## 현재 정책과 구현 경계

현재 기준은 [정책.md](../../정책.md)다. 아래에서 현재 정책 목표와 기존 기술 인터페이스를 구분한다. 이번 문서 동기화는 서버 코드·SQL·설정·DB·외부 호출·배포를 변경하거나 검증하지 않았다.

예상 종료 후 본인 완료 확인을 마친 사람은 상대 확인 전에도 후기를 제출할 수 있으나 실제 완료 전에는 비공개다. 양쪽 확인 또는 예상 종료+24시간에 실제 완료하며 취소·노쇼는 제외하고 신고·분쟁 검토 중에는 보류한다. 지연 시 실제 성공 시각이 완료 시각이다. 작성 마감은 실제 완료부터 7일, 양쪽 제출은 실제 완료 후 즉시 공개, 한쪽 제출은 작성 기한 종료 시 공개한다. 완료 횟수는 실제 완료 즉시, 후기 당도는 상대 열람 가능 시 반영한다.

검토 중에는 작성·기한 진행·새 공개를 보류한다. 이미 공개된 후기는 접수만으로 숨기지 않고 운영자가 임시 비공개를 결정한 때 숨긴다. 정상 동행 인정 후 원래 종료+24시간이 지났으면 즉시 실제 완료한다. 첫 완료라면 그때부터 작성 7일, 이미 완료했다면 남은 기한을 재개하되 최소 24시간을 보장한다. 재개 후 양쪽 제출이면 공개하고 한쪽이면 재개·연장된 작성 기한 종료에 공개한다.

기존 완료·공개 predicate와 예약 RPC는 아래 인터페이스를 유지하되 한쪽 작성 기한 종료 공개·검토 중 이미 공개된 후기 처리·당도 산식은 현재 정책에 맞춘 코드 대조와 변경·검증이 필요하다. 당도 산식은 정책 7-4절에 확정됐다. 초기 15, 반응 좋아요 +1·보통 0·별로 −2와 별점 1~2점 −2·3점 0·4~5점 +1을 합산한다. 완료 횟수·칭찬은 가산하지 않는다. 취소 제재 −2·노쇼 −3·중대 위반 −10이며 같은 사건의 운영 감점은 가장 큰 하나만, 유효 후기 기여와는 합산한다. 무효 동행의 후기 기여는 제외한다. 전체 유효 기여를 합한 뒤 표시만 0~100 정수로 제한하며 원 기여를 남겨 정정한다. 임시 후기 숨김은 반영 당도를 유지하고 최종 무효 때 제외한다. 정책 확정과 실제 점수 저장·계산기 연결은 별개다.

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
- `COMPLETION_RECONNECT_MS`: 재연결 대기 시간(밀리초). 사용자 확정 운영 값 `5000`을 명시한다. 코드의 암묵적 기본값으로 대체하지 않는다.
- `COMPLETION_QUERY_TIMEOUT_MS`: 접속·쿼리·statement 제한 시간(밀리초). 사용자 확정 운영 값 `10000`을 명시한다. 코드의 암묵적 기본값으로 대체하지 않는다.
- `COMPLETION_REQUIRE_TLS`: 선택값은 정확한 문자열 `true`만 허용한다. 로컬 주소에서도 인증서 검증 TLS를 강제할 때 지정한다. 미지정 로컬 연결의 기존 동작은 유지하고 비로컬 연결은 항상 검증 TLS를 사용한다.
- 사설 CA를 사용하는 격리 환경은 Node 프로세스를 시작할 때 `NODE_EXTRA_CA_CERTS`로 CA 파일을 제공한다. 인증서·호스트명 검증을 끄거나 URL 인자로 우회하지 않는다.

밀리초 설정 상한은 2,147,483,647이다. 비로컬 연결은 TLS 인증서 검증을 켜며 URL의 ssl 관련 query 인자를 허용하지 않는다. 환경을 준비한 뒤 저장소 루트에서 실행한다.

```sh
cd backend
npm ci
npm run completion-scheduler
```

운영 전환 시 runner 의존성·명시 환경·상주 프로세스 관리 준비와 migration의 기존 cron 해제를 하나의 전환 작업으로 묶는다. 준비된 runner가 새 RPC에 연결하고 `COMPLETION_SCHEDULER_READY`를 보고하며 기존 기한 도래 예약을 복구하는지 확인한다. cron만 해제하고 runner 기동을 후속 작업으로 미루지 않는다. runner 장애 중 예약은 DB에 남고 재접속 때 복구되지만 장애 동안 자동 완료가 늦어질 수 있다. 이번 운영 migration·상주 프로세스 배포는 미실행이며 로컬 검증 결과와 구분한다.

## 호환용 배치 RPC와 완료 시각

`process_due_completions(p_limit integer)`는 `service_role` 전용이며 범위는 1~1000이다. 응답은 `{completedCount, appointments:[{appointmentId,completedAt}]}`이다. `confirmed`이면서 예상 종료 +24시간이 지난 행만 `FOR UPDATE SKIP LOCKED`로 처리하며 열린 분쟁과 불발 판정도 제외한다. 자동 처리는 개인 수동 확인 기록을 만들지 않는다.

지연 자동 완료의 completed_at은 실제 성공 시각이며 외부 입력으로 주입하지 않는다. 일반 작성 7일과 한쪽 작성 기한 종료 공개는 이 완료 시각을 기준으로 한다. completion_notified_at과 알림 클릭은 기준을 바꾸지 않는다. 건별 예약·기존 호환 RPC는 같은 판정을 사용해야 하며 후속 코드 대조가 필요하다.

완료 전환과 두 당사자의 `appointment_completed` 알림은 동일 DB 트랜잭션이다. 고유 제약으로 중복 알림을 방지하고 알림 클릭은 완료를 실행하지 않는다. 한쪽 후기 공개는 실제 완료 시각을 기준으로 하며 알림 행 생성·실제 클릭 시각으로 기준을 바꾸지 않는다. 전환 방향은 위 건별 예약 경로이며 기존 분 단위 전수 검사 cron 해제는 상주 운영 실행기 준비·복구 확인과 함께 수행한다. 현재 원격의 기존 cron을 해제했다는 뜻이 아니다.

## 전용 완료 실행 역할

이 권한 변경은 [최신 자동 처리 정책](../../정책.md)의 건별 영속 예약·상주 Node 실행·시작/재접속 복구를 지원한다. 완료 시각·양쪽 수동 확인·예외·후기 공개 기준을 바꾸지 않는다. 원형 종현 `completion-runner.mjs`와 두 RPC의 본문/signature도 유지한다.

신규 migration `20261003090000_completion_runner_role.sql`의 대상은 `NOLOGIN NOINHERIT` 그룹 `yumidang_completion_runner`다. 앱 영역의 권한은 `public` schema USAGE와 정확한 `public.list_completion_reservations()`·`public.execute_completion_reservation(uuid,uuid)` EXECUTE다. public/private의 테이블·열·sequence 접근, schema CREATE, 다른 업무 RPC·역할 승격 권한을 추가하지 않는다. 기존 service_role의 두 RPC 권한과 anon/authenticated 거절은 유지한다. 그룹에 접속 자격 증명을 저장하거나 로그인 기능을 부여하지 않는다.

별도 LOGIN의 이름·비밀번호·연결 대상은 비공개 운영 provisioning에서 준비하고 `INHERIT`와 위 그룹 membership을 부여한다. LOGIN은 superuser·BYPASSRLS·CREATEROLE·CREATEDB·REPLICATION 및 관리자/anon/authenticated/service_role membership을 갖지 않는다. 기존 동명 역할의 더 넓은 속성·권한을 묵인하거나 역할 전체를 임의 재작성하지 않는다. 운영 LOGIN과 자격 증명의 생성·보관·교체는 이 migration에 포함하지 않는다.

PostgreSQL16 이상에서 비-superuser의 역할 생성에 따라 자동으로 생기는 관리 membership은 실행 LOGIN과 구분한다. 이번 SQL은 **해당 DO에서 그룹을 새로 생성한 경우만**, 생성 실행자·member가 `postgres`(비-superuser CREATEROLE), grantor가 `supabase_admin`(superuser)이며 `ADMIN=true / INHERIT=false / SET=false`인 자동 관리 행을 허용한다. 이는 생성자의 역할 관리 권한이며 그룹의 앱 실행 권한을 상속하거나 SET ROLE로 사용하는 권한이 아니다. 기존 동명 그룹의 membership·그룹의 parent membership 또는 다른 옵션/생성자/수여자는 거절한다. 운영 실행 LOGIN에는 별도 단일 그룹의 실행 상속을 부여하며 자동 관리 행을 실행 자격 증명으로 사용하지 않는다. 이 예외는 기존 권한을 임의 회수하거나 관리자 연결을 운영 완료로 인정하는 근거가 아니다.

명시 GRANT 두 개만 보고 실효 권한이 두 개라고 판단하지 않는다. PostgreSQL의 모든 역할이 상속하는 `PUBLIC` 권한도 검사한다. 앱 schema의 table/column/sequence/CREATE 및 함수 EXECUTE는 실효 권한 기준으로 정확한 범위를 확인한다. `PUBLIC`에 남아 있는 권한을 특정 그룹의 REVOKE만으로 차단할 수는 없다. 기존 자료·다른 호출자 권한을 보존하고 예상 밖 앱 권한이 있으면 적용을 중단한다. PostgreSQL 기본 `CONNECT`·`TEMP`·`pg_catalog` 사용 등은 공용 기반 권한으로 별도 기록하며 'DB에서 두 함수 외 모든 동작 금지'를 주장하지 않는다.

객체 ACL만으로 이름을 통한 실효 접근을 판정하지 않는다. relation/column/sequence 접근과 함수 호출은 해당 schema의 `USAGE`도 함께 확인한다. 검사 시 cron 객체의 잠재 PUBLIC ACL과 전용 역할의 schema USAGE를 함께 확인한다. 검사는 이 잠재 ACL과 실효 접근을 구분하며 cron 전체를 검사에서 제외하거나 PUBLIC 권한을 전역 회수하지 않는다. 함수·schema CREATE 검사와 다른 앱 객체 검사도 유지한다.

LISTEN/NOTIFY에는 채널별 ACL이 없다. 원형 실행기는 `yumidang_completion_reservations` 채널을 구독하지만 DB 역할이 해당 채널만 사용할 수 있다는 권한 보장은 아니다. 알림 payload를 회원 원문·비밀의 전달 수단으로 사용하지 않고 영속 예약을 다시 조회하는 깨우기 신호로 취급한다. LISTEN 세션과 조회·실행을 지속할 direct 또는 session 연결이 필요하며 transaction pool을 사용하지 않는다. 재접속 때 LISTEN을 다시 설정한 뒤 예약을 조회한다. 호스트·TLS/접속 정보는 별도 준비다. 재접속 5초·DB 쿼리 10초를 선택했으며 실제 설정·연결 복구·호스트 제약은 별도 검증한다.

운영 LOGIN·비밀값·direct/session 대상·상주 호스팅·복구/백업·기존 cron 해제·일일 등록은 실제 실행 환경에서 별도 검증한다. 로컬 검증이나 문서 선택만으로 운영 최소 권한·배포 완료를 주장하지 않는다.

## 검증

`tests/database/minkyu/bilateral_completion.sql`은 트랜잭션 롤백 fixture로 한 명/양측 확인, 재시도, 권한, 이른 시점/취소/분쟁 거절, 지연 자동 완료 시각, 알림 중복 방지, 실제 DB 역할을 검사한다. 새 `review_release_policy.sql`은 예약 생성·변경·무효화·기한 전 호출·세대 경쟁·실제 자동 완료를 검증한다. 실제 실행 결과는 [새 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-review-policy-handoff.md)를 따른다.

## 원형 실행기 로컬 LOGIN 검증

민규 전용 `tests/integration/minkyu/completion_runner_current_local.mjs`는 독립 schema54 scratch에서 종현 소유 실행기·scheduler를 수정하지 않고 실제 프로세스를 실행했다.7그룹 PASS: 전용 LOGIN의2개 RPC와 업무/권한상승 차단, 시작 시 누락 처리, 커밋 알림·예약, 양쪽 수동 완료, 합성 분쟁 자동 완료 제외, 실제 backend 종료 후5초 재접속·누락 처리, SIGTERM 정상 종료다. 일시 역할·회원·예약·세션 정리 PASS다. 다른 DB의 PUBLIC CONNECT를 회수하지 않았으므로 클러스터 전체 배타 접근을 주장하지 않는다. 운영 LOGIN·TLS·Railway·cron 전환은 NOT_RUN이다.


## 완료 전 명시 신고 검토 연결

40900은 일반 접수를 자동 분쟁으로 만들지 않고 owner-only 명시 약속 검토를 완료/예약/후기 쓰기·새 공개의 공통 보류에 연결한다. 쌍방 합의 종료가 검토 중 바뀌면 최신 합의 종료+24시간을 적용한다. 검토 후 첫 실제 완료부터7일, 기존 완료는 남은 기간 최소24시간을 재개한다. 단일TX 실제 SQL 회귀와 native66 격리 영속 적용·반영 후 SQL 회귀 PASS. 실제 두 세션 경합3건도 PASS. 회원·운영 HTTP/최종 불발 종결은 별도 후속이다. [검증 범위](../../docs/collaboration/requests/minkyu/2026-10-05-appointment-review-holds.md)를 따른다.


41000 최종 불발 lifecycle 후보는 native66 실제 단일TX SQL 검증 PASS 후 전체 롤백했다. 완료 전 불발은 완료 필드를 만들지 않는 종결이며, 기존 완료의 최종 불발 정정은 실제 시각을 유지하고 후기 기여·완료 횟수에서 제외한다. 귀책·감점·신고 종결은 별도다. 영속native67·HTTP·불발/보관 경합·탈퇴 후 미완료 불발 정정 정책은 후속이다. [범위와 실제 증거](../../docs/collaboration/requests/minkyu/2026-10-05-appointment-review-no-show-lifecycle.md)를 따른다.


2026-10-10 완료 실행기 파일은 사용자 재배정에 따른 정책 전용 커밋 `52b813e`(통합 `88abce4`)부터 민규 담당이다. TLS 설정·기존 예약 실행·운영 설정의 관련 회귀15개는 PASS다. 이 설정 회귀를 실제 TLS 연결·예약 복구·운영 배포 성공으로 집계하지 않는다. 새 격리 환경에서 원 실행 명령의 실제 검증을 이어간다.
