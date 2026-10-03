# 자동 완료 실행기 최소 권한 준비

2026-10-03 로컬 최소 권한 구현·검증 완료이며 전체 **43% · 6/14**를 유지한다. 직전 [행사 HTTP 인계](2026-10-02-event-http-handoff.md)의 실제8그룹·769확인 PASS와 정리는 완료했다. 이번 단계는 운영 실행기의 관리자 연결을 제거할 수 있도록 DB 역할과 실제 로컬 권한·복구 검증을 완료했다. 원격 배포·운영 cron 전환은 하지 않는다.

## 파일별 작업

[이번 하네스](../../minkyu-completion-role-harness.json)는 허용9개·보존145개 파일로 구분한다. `minkyu/foundation-harness`·HEAD `58d1efc76b9d7e7b5b96aed7e47062f43652e06f`에서 민규 소유 파일만 수정한다. 종현 소유 runner·scheduler와 이전 SQL 이력을 보존한다.

- A: 전용 NOLOGIN 그룹 역할 migration, DB 권한·완료 검증, gateway 사본39개 준비 및 준비 검사.
- B: 원형 실행기·실제 PostgreSQL의 제한된 합성 LOGIN·알림·재접속·재시작·접근 거절 통합 검사.
- C: 완료 DB 계약과 현재 현황의 구현/검증 결과 동기화.
- 총괄: 로컬 프로젝트 준비·실행·정리, 증거 및 다음 운영 조건 기록.

## 목표 권한과 한계

`yumidang_completion_runner` 그룹은 LOGIN·관리자·RLS 우회 권한을 갖지 않으며 앱 스키마에서 `public` USAGE와 기존 예약 조회/실행 두 RPC의 EXECUTE만 받는 구조다. 운영 LOGIN과 비밀값은 별도로 주입하고, 해당 그룹 하나의 INHERIT만 사용한다. `authenticator`·anon·회원·service_role·소유자 역할에 그룹을 연결하지 않는다.

기존 PUBLIC·역할 상속을 포함한 실제 유효 권한을 검사한다. PostgreSQL 공용 CONNECT/TEMP·pg_catalog 권한을 앱 자료 접근 권한과 구분하며 전역 회수를 임의로 수행하지 않는다. LISTEN에는 채널별 권한 설정이 없으므로 특정 채널만 허용된다고 주장하지 않는다. 현재 알림은 빈 payload이며 원형 실행기는 수신 후 예약 RPC를 다시 조회한다.

## 실제 검증 상태

준비 검사11개 PASS. 새 전용 CLI 프로젝트에39개 SQL 적용·기동 성공, `completion_runner_role.sql` 실제5그룹 PASS 및 rollback. SQL 테스트의 실제 세션 인증 전환에는 로컬 superuser `supabase_admin`을 사용했다. 실행기의 관리자 연결은 합성 fixture 준비·정리에만 사용하며 실행 계정과 분리했다.

`completion_runner_privileges_local.mjs` 실제 **4그룹·412확인 PASS**: 제한된 별도 LOGIN의 허용2RPC·자료/역할 상승/JWT 위장 거절, 원형 실행기의 기한 경과 시작·LISTEN/timer·연결 단절/누락 복구·SIGTERM/재시작을 검증했다. 412는 폴링과 안전 검사도 포함한 확인 수이며 고정 단위 테스트 수가 아니다. 관련37개 테이블 정리와 임시 LOGIN 제거 PASS. 원형 runner·scheduler·pg8.22를 변경하지 않았다. 운영 최소 권한·원격 연결·외부 공급사 검증은 NOT_RUN이다.

첫 적용에서 두 가지 검사 문제를 실제 증거로 구분했다. PostgreSQL은 비-superuser 역할 생성자에게 ADMIN=true/INHERIT=false/SET=false 관리 행을 자동 부여한다. 새 역할을 만든 바로 그 DO에서 확인된 정확한 postgres/supabase_admin 관리 행만 구분하며 기존 역할의 외부 membership은 여전히 거절한다. cron 두 테이블에는 PUBLIC SELECT ACL이 있지만 cron USAGE가 없어 실제 LOGIN 조회는42501로 거절된다. 실효 관계 권한 검사에 schema USAGE를 포함했으며 cron 전체 제외·PUBLIC 회수·새 권한 부여는 하지 않았다.

최종 해시:

- migration: `98425e7c855914bf49899b4a68704686e615fdfeac6a2852e9674f4ecd5e65fc`
- DB 검사: `409380e3cd7e574e948408604d7cb26525784d564d45050a1920403592215f51`
- 원형 실행기 최소 권한 통합: `1f4c12d0a7f4d58705d64d1224befbbd8db103b889bd45e5540442d4c38223fa`

실제 최종 환경은 `/private/tmp/yumidang-completion-role-20261003-p5f40p_j/edge`의 `yumidang-minkyu-gateway` API56521/DB56522다. 그 전38개 디버그 환경은 종료했고 저장소 원본을 변경하지 않고 합성 역할 metadata를 확인한 뒤 롤백했다. 최종 검증 뒤 독립 조회에서 이력39·Auth0·공고0·임시 LOGIN0을 확인했다.

최종 CLI 프로젝트도 종료(exit0)했고 비밀 config·각 준비 로그를 삭제했다. Docker에서는 기존 네이버 전용5개 컨테이너만 유지한다. 운영 DB·cron·기존 네이버 로그인 환경·Git 인덱스는 변경하지 않았다.

운영 호스트·직접 또는 session DB 연결·비밀 주입·재연결/시간 제한 값·프로세스 관리·백업·복구와 기존 매분 cron의 안전한 전환은 별도 준비가 필요하다. 로컬 테스트 설정을 운영 정책의 기본값으로 채택하지 않는다.

마지막으로 읽기 확인한 원격 이력20개를 기준으로 신규 역할 SQL까지 포함한 후보는39개 중19개다. 이전 원격 준비 문서의18개 목록에 이번 역할 migration이 추가되므로 최종 적용 제안에서는 대상 이력·해시·운영 조건을 다시 대조해야 한다. 아직 원격 적용 승인 또는 실제 적용 결과로 기록하지 않는다.
