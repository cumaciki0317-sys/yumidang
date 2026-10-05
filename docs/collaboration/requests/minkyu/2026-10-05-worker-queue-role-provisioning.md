# worker_queue DB 역할과 LOGIN provisioning 분리 초안

작업자 minkyu. source60의 추가 후보는 `20261005040300_worker_queue_runner_role.sql` 1개이며 현재 main/source60에 반영하거나 DB에 적용하지 않았다. SQL·LOGIN·계정 실제 접속·상주 실행·운영 활성화는 모두 NOT_RUN이다. 기존 completion 역할/서비스키/owner 권한을 확대하지 않는다.

## NOLOGIN 후보 범위

`yumidang_worker_queue`를 NOLOGIN/NOINHERIT/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS로 만든다. 명시 권한은 현재 DB CONNECT, public USAGE, 다음3개의 EXECUTE뿐이다.

- `public.read_worker_queue_schedule(text[],text)`
- `public.acquire_worker_run(integer,uuid)`
- `public.release_worker_run(uuid)`

private/auth/storage schema USAGE, 원문 테이블/열/sequence 권한, public CREATE, role 소유 객체, default ACL, cleanup5·budget·completion RPC, owner 역할 USAGE/SET membership을 허용하지 않는다. 역할 이름 충돌을 기존 역할 변경·멤버 자동 회수로 해결하지 않고 전체 실패한다. 기존 NOLOGIN 후보에 승인되지 않은 명시 grant가 있어도 실패한다. PostgreSQL16+ CREATE ROLE의 관리용 자동 membership은 기존 completion의 제한과 같이 postgres 생성자/supabase_admin grantor/ADMIN=true/INHERIT=false/SET=false인 생성 시점 행만 허용한다. 앱 사용자·service·authenticator에 역할을 주지 않는다.

3개 RPC는 검토된 SECURITY DEFINER/빈 search_path가 있어야 하며 새로운 역할은 RPC owner를 상속하거나 SET할 수 없다. private 테이블 읽기는 해당 RPC 내부의 검토된 owner 경계에서만 이루어진다. queue DB 계정은 HTTP 내부 요청의 INTERNAL_WORKER_SECRET, Supabase service key, Auth/Storage 관리키를 이 SQL로 받지 않는다.

## PUBLIC 실효 권한

NOINHERIT는 PUBLIC에서 오는 권한을 없애지 않는다. 원형 completion migration도 PUBLIC CONNECT/TEMP/pg_catalog와 LISTEN의 공용 기능을 전역 회수하지 않는다. 이 후보도 전역 PUBLIC ACL/default ACL을 임의 변경하지 않는다. 현재 DB 명시 CONNECT만으로 다른 DB의 기존 PUBLIC CONNECT까지 차단했다고 말하지 않는다. 실제 전용 credentials의 접속 DB는 provisioning/config에서 고정하고 권한 catalog는 대상 DB마다 별도로 검증해야 한다.

고정 source56 schema-only SQL을 정적으로 읽었을 때 명시 `GRANT ... TO PUBLIC`은 발견되지 않았고 completion role에 명시된 public RPC는2개였다. 이것만으로 함수 생성 기본 EXECUTE, 상속, 나중에 추가된 함수의 PUBLIC 효과가 없다고 증명하지 않는다. 후보 적용 안에서 실제 `has_schema_privilege` + `has_function_privilege` + 테이블/열/sequence 실효 권한을 조사해 public/private/auth/storage/vault/realtime/cron/supabase_functions/supabase_migrations의 추가 앱 접근이 있으면 전체 실패한다. 기존 문맥의 pg_read_all_data 상속을 신규 역할에 주지 않는다. PUBLIC 때문에 실패하면 정확 객체 목록을 별도 읽기 증거로 보고하고 전역 REVOKE로 자동 교정하지 않는다.

LISTEN/NOTIFY는 채널별 ACL을 제공하지 않는다. payload가 빈 신호인 현재 queue/completion 계약을 유지하며 전용 역할이 한 채널만 LISTEN할 수 있는 권한이 생겼다고 설명하지 않는다. 단일 채널과 wake 처리 제한은 J runner의 코드 계약이다.

## LOGIN은 별도 후속 승인

migration은 password·LOGIN을 만들지 않는다. 전용 LOGIN credential 발급은 별도 root 승인 후 보안 저장소/로컬 private 설정을 통해 진행한다. secret을 SQL migration·채팅·stdout·connection URL 로그에 쓰지 않는다. completion LOGIN·기존 service credential을 재사용하지 않는다.

NOINHERIT를 LOGIN에도 유지하려면 PostgreSQL16+ membership을 ADMIN=false/INHERIT=false/SET=true로 `yumidang_worker_queue`에만 연결하고, 접속 직후 `SET ROLE yumidang_worker_queue`가 필요하다. 현재 J `scheduled-jobs/queue-runner.mjs`는 접속 후 SET ROLE 없이 LISTEN→3RPC를 호출한다. 이 초안과 직접 연결하려면 J 담당자의 SET ROLE 선행/실패 closed 연결 보완이 필요하다. J 파일은 수정하지 않았다. 고정된 역할 이름을 SQL 상수로 사용하고 외부 입력을 role 식별자로 삽입하지 않는다. 역할 전환 전후 SESSION_USER/ CURRENT_USER 및 실제권한을 기록하되 password/URL은 출력하지 않는다.

이 membership은 LOGIN이 서비스/owner 역할을 상속하거나 SET하도록 허용하지 않는다. NOLOGIN 그룹 자체의 상향 membership은0이다. 로그인 전용 role에 같은3권한을 직접 중복 부여해 SET ROLE 부재를 우회하지 않는다. 다른 방식으로 연결할 필요가 있으면 독립 권한 설계로 검토한다.

후속 계정 준비는 NOLOGIN 상태에서 검토·멤버십·CONNECT만 좁게 구성하고 마지막 승인 단계에서 LOGIN/password를 설정하는 순서로 분리할 수 있다. 실제 expiration/connection limit/회전 시기는 배포 조건과 root 승인에 따라 정하며 임의 운영 값이나 공급사를 확정하지 않는다. 계정이 NOLOGIN 골격으로 존재하는 것과 외부 프로세스의 실제 TLS 접속·LISTEN·3RPC 성공은 별도 증거다.

J runner 설정은 `WORKER_QUEUE_DATABASE_URL`, `WORKER_QUEUE_FUNCTION_URL`, `WORKER_QUEUE_DB_CONTRACT_ID`, `WORKER_QUEUE_QUERY_TIMEOUT_MS`, `WORKER_QUEUE_RECONNECT_MS`, `WORKER_QUEUE_HTTP_TIMEOUT_MS`, `INTERNAL_WORKER_SECRET` 이름만 전달한다. DB credential과 worker HTTP secret은 별개다. 원격 DB는 검증된 TLS, 원격 function은 현재 J 계약의 HTTPS/정확 경로를 확인한다. actual dispatch 실패·재접속·release·공정성 검증은 역할 골격 SQL만으로 완료되지 않는다.

## 후보 테스트와 실행 금지 경계

`tests/database/minkyu/worker_queue_runner_role.sql`은 이미 후보 역할이 적용된 새 격리 환경에서 owner SET SESSION AUTHORIZATION을 사용한다. 새 역할/membership을 생성하지 않는다. NOLOGIN flags/3 RPC/상향 membership0/공개 추가 앱 권한0/원문 권한0/다른 RPC 거절/역할 상승 거절, LISTEN, schedule/acquire/release exact DTO와 lease 무연장을 확인하도록 작성했다. singleton lease·임시 assertion 함수 ACL은 BEGIN/ROLLBACK이고 전역 역할과 로그인 비밀은 변경하지 않는다.

owner의 SET SESSION AUTHORIZATION으로 NOLOGIN 역할이 동작한 것은 password/TLS/전용 LOGIN 접속 증거가 아니다. 실제 연결 proof는 승인된 credential로 별도 프로세스를 시작해 SESSION_USER·CURRENT_USER·role catalog·LISTEN·3RPC·denial·원복을 검증한 후에만 기록한다.

CREATE ROLE은 cluster-global이므로 기존 drift/native60 클러스터의 다른 DB에도 영향을 준다. 현재 승인에서는 적용·role 생성0이다. 최초 실검증은 새 독립 클러스터 또는 root가 명시적으로 허용한 역할 변경 환경에서 진행해야 하며 scratch DB라는 이유만으로 기존 cluster 역할을 바꾸지 않는다. 기존 completion 역할/원본/native/운영과 PUBLIC 전역 ACL은 보존한다. migration 적용 후 credential을 연결하면 동일 이름 충돌 검사 재실행을 자동 운영 repair로 사용하지 않는다.

현재 검증은 소유권·정적 검토만이며 SQL 적용/회귀/전용 account connected proof는 NOT_RUN이다. 실제 조회 없이 native catalog와 같다고 주장하지 않는다.

## root 격리 트랜잭션 실검증 결과

2026-10-05 source60 로컬 클러스터에서 root가 단일 owner 트랜잭션으로 실제 검증했다. 최초 접속은 supabase_admin이며 SET LOCAL ROLE postgres로 후보 역할을 생성·검사한 뒤 RESET ROLE을 거쳐 NOLOGIN persona 테스트를 수행했다. 원본 migration의 외곽 BEGIN/COMMIT과 테스트의 외곽 BEGIN/ROLLBACK만 정확히 제거하고 전체를 하나의 BEGIN/ROLLBACK으로 감쌌다. password·LOGIN·영속 역할·전용 연결은 생성하지 않았다. 후보 소스의 NOT_RUN 주석과 위 준비 설명은 최초 작성 시점이며, 이번 결과가 격리 실행 상태를 추가한다. 운영 적용은 계속 NOT_RUN이다.

3RPC 실제 호출·재점유 시 만료 무연장·LISTEN 실행·다른 역할 전환·raw table·다른 RPC·public CREATE 거절이 PASS했다. 최초 catalog 비교에 table/column/default ACL 및 shared dependency 항목이 빠져 있었으므로 이를 추가한 검증을 별도로 실행했다. 확장 검증에서 역할·membership·function/schema/database/table/column/default ACL·role setting·shared dependency·SQL 이력·빈 Auth/Storage/작업·guardfalse/globalidle 전후가 모두 동일했다. 역할은 다른 세션에 COMMIT되지 않았다.

private 증거는 `/private/tmp/yumidang-queue-role-transaction-w444zx87/receipt.json`과 `role_probe_full_catalog.py`, `executed.sql`, `probe.stdout`, `probe.stderr`에 있다. receipt는 보완한 catalog 검증 결과이며 source migration/test SHA와 wrapper SHA를 포함한다. 정상 종료 코드0을 확인했다. 프로세스 timeout 발생 시에는 이 결과를 재사용하지 않고 같은 handle과 실제 DB 세션 상태를 확인한 후 읽기 검증해야 한다.

이번 결과는 전용 LOGIN/password/TLS 접속·재접속·J runner SET ROLE·HTTP dispatch 검증이 아니다. native DB의 영속 SQL 이력은60개 그대로다. source는 검토 후보1개를 추가해61개이며 준비 도구의 exact61 동기화를 진행한다. 운영 DB/원본 네이버 로컬 프로젝트/기존 cron은 변경하지 않았다.
