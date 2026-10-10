# 공통 실행기 포트·격리 환경 검증 — 민규

기준은 `40f3c1d`, 작업자는 `minkyu`다. 원격 조회에서 새 종현 변경은 없었다. 기존 **8/10 · 추가 5/6**을 유지한다. SQL100/101과 아래 자료는 로컬 변경이며 자동 커밋·푸시·운영 적용 대상이 아니다.

## 확정 단위와 공통 포트

사용자 확정: 실행기의 **최대 20은 처리 대상 작업 수**다. RPC·Storage 요청 횟수를 작업 수로 환산하지 않는다. 종현은 실제 전송 전 공유 작업 한도 예약·소비 계약을 연결한다. 이 결정이 기존 개별 요약 batch의 별도 한도를 모두 변경한다는 뜻은 아니다.

| 후속 SQL | 계약과 현재 상태 |
|---|---|
| 100 `worker_owned_schedule` | `read_worker_owned_queue_schedule(uuid,text[],text)`가 현재 자기 전역 토큰을 잠금·검증한다. 자기 점유 만료 때문에 자기 일정이 늦춰지는 것을 피하며 기존 일정 RPC의 본문·ACL은 보존한다. queue 역할 전용 |
| 100 terminal 일정 | `read_report_terminal_maintenance_schedule()` → `{serverNow,nextDueAt,ready}`. 기존 파기 guard와 service EXECUTE가 준비되지 않으면 `ready:false,nextDueAt:null`. 기존 알림 경로를 재사용 |
| 101 `worker_runtime_journal` | prepare/observe/pending/get 최소 intent 포트. UUID·허용 목록의 종류 문자열·숫자·해시만 받으며 원문·인증정보·Storage 경로는 저장하지 않는다. **제어 false·서비스 EXECUTE 미부여** |

동일 접수 키·동일 입력은 원 ticket을 반환하고 다른 입력은 `40001`이다. 새 준비는 현재 전역 점유가 필요하다. 부모 cycle을 잠가 unknown 전환과 하위 준비 경합을 직렬화한다. 동일 요청의 복구 조회는 토큰 만료 후에도 가능하며 **실제 작업 실행 허가를 의미하지 않는다**. `observed_response`는 호출자가 유효 응답을 보았다는 상태이며 원격 종결 증명이 아니다. unknown→observed는 차단하고 자동 재전송 기능을 제공하지 않는다.

### 제품 활성화 전 남은 연결

- 종현 포트의 begin/prepare/confirm/unknown과 요청 ID·ticket 어댑터, operation별 필수 scope 및 claim의 supportedKinds·settlement status 계약.
- enqueue/claim/정산 등 실제 변경과 기록의 원자 연결. 현재 intent 기록만으로 이 변경을 완료했다고 표시하지 않는다.
- 공유 작업 한도 원장과 전송 전 예약. RPC 호출 예산과 별개다.
- 원격 결과 확인·unknown 해소 절차. 미확인 DELETE/ACK는 재시작 때 추가 전송하지 않는다.
- 종결 후 상세 기록 30일 파기 및 재요청 가능 기간에 맞춘 최소 중복 키 삭제 조건 검증. 현재 합성 기록만 존재하며 제품 기록 수집은 닫혀 있다.
- terminal 알림 후 자기 점유 일정 사용·점유 실패 시 재대기·권한 설정 후 명시 wake/reconnect. 과거 nextDueAt으로 바쁜 반복을 만들지 않는다.

## 실제 검증과 환경

운영과 분리된 `yumidang-minkyu-queue-tls99`에 SQL99 전체 백업을 복원한 뒤 SQL100/101을 적용했다. localhost 61622와 전용 LOGIN을 사용한다. 복원 시 역할의 유효 옵션은 보존하되 membership grantor는 격리 bootstrap이므로 운영 클러스터의 grantor까지 동일한 복구라고 주장하지 않는다. 복원된 cron은 실행을 껐다.

| 검증 | 결과·범위 |
|---|---|
| 실제 libpq TLS | verify-full 통과. 잘못된 CA·호스트·평문 거절. 전용 LOGIN의 service/admin 역할 전환·private 테이블·공개 테이블 생성 거절. 두 실제 TLS psql 프로세스 경쟁에서 전역 점유 승자 1개·자기 일정 조회·자기 점유 해제 통과 |
| SQL100 | 자기 토큰 일정, 만료·타인·null 토큰 거절, 기존 본문·ACL 보존, 미준비 terminal 비활성 통과 |
| SQL101 | 기본 비활성, 임시 검증 제어하 동일 키 멱등·입력 충돌·원문 필드 거절·unknown 보존·회원 거절 통과. 검증 설정은 종료 시 원복 |
| 실제 JWT→HTTPS→PostgREST→DB | DB 반영 후 응답 유실, 같은 요청 6개 동시 재전송의 ticket 동일, 다른 입력 충돌·anon 거절·unknown 보존 통과. service/anon JWT 검증이며 실제 네이버 회원 흐름으로 집계하지 않음 |
| 실제 내부 HTTPS handler | 신뢰 CA 통과·잘못된 CA 및 내부 비밀 거절·잘못된 limit 거절. upstream 및 mutation 0회. 종현 실제 요약 함수의 not_enabled도 확인. 제품 queue-runner 전체 검증과 별개 |

검증 코드: `tests/integration/minkyu/queue_tls_environment.py`, `queue_tls_http.ts`, `queue_runtime_http.py`; DB 검사: `tests/database/minkyu/worker_runtime_ports.sql`, `worker_runtime_journal.sql`. 인증서·덤프·연결정보·영수증은 Git 외부 private tmp에 보관한다. 테스트 CA는 2일 유효하며 운영에 이식하지 않는다. 환경 준비 스크립트는 기존 환경을 덮어쓰지 않는다. 공개 실행기 도메인은 생성하지 않았다.

## Railway 읽기 전용 조사

[completion-runner](https://railway.com/project/b246af5a-b503-4a6b-81d5-be85e79f99f1/service/61b3f697-a30b-4d6a-82dc-d109aee88514?environmentId=474b39df-df3a-48b1-9d1b-3c0bb98ff3b0)의 과거 배포 및 2026-10-08 15:13~15:14 로그에서 `completion-scheduler` → `node supabase/functions/scheduled-jobs/completion-runner.mjs`와 `COMPLETION_SCHEDULER_NOT_CONFIGURED` 반복을 확인했다. 필요한 설정 이름은 `COMPLETION_DATABASE_URL`, `COMPLETION_RECONNECT_MS`, `COMPLETION_QUERY_TIMEOUT_MS`이며 **어느 값이 누락됐는지는 확인하지 않았다**. 현재 queue 실행 경로와 다르다.

화면에서 과거 배포 Removed 및 서비스 Crashed/Building도 관찰했다. 이번 작업에서 배포·재시작·설정 변경은 하지 않았다. 앞선 승인된 push의 자동 빌드 가능성 및 실제 연결 브랜치·빌드 원인은 추가 읽기 확인 대상으로 남긴다. 비밀값은 기록하지 않는다.

## 배포·복구 인계 순서

1. 종현 연결 브랜치와 ABI·작업 수 단위·활성화 전 조건을 확인한다. 소유권 검사 후 담당별로 통합한다.
2. 운영 적용 전 백업·역할 권한·보관 파기 최소 기록을 별도 보관하고 기존 SQL 이력은 수정하지 않는다. SQL99→100→101 순서와 준비 도구 해시를 확인한다.
3. 운영용 신뢰 CA·호스트·전용 LOGIN·HTTPS 함수 대상·최소 권한을 별도 준비한다. 테스트 인증서·로그인·bootstrap 신뢰 설정을 복제하지 않는다.
4. guard/EXECUTE를 닫은 채 실제 제품 실행기 두 프로세스 경쟁·연결 유실·재시작·미확인 DELETE/ACK 추가 전송 0회를 검사한다. 실제 AI 성공 증거·주기적 파기도 연결 검증한다.
5. 검사 통과 후에만 별도 운영 승인 범위에서 비활성 제어·시작 명령·cron 전환을 적용한다. 기존 completion 실행과 queue 실행의 중복을 막는다.
6. 장애 시 먼저 실행과 외부 전송을 차단하고 unknown 증거를 보존한다. 백업 복원 후 기존 [삭제 재적용 절차](2026-10-08-runner-recovery.md)를 수행하고 권한·숨김·접수 키·파기 상태를 확인한다. 복원만으로 파기 완료라고 표시하지 않는다.

준비 도구 전체 회귀는 실행 시간이 길어 중단했으며 전체 PASS로 주장하지 않는다. 이번 후속 SQL의 순서·해시·기존 이력 보존 준비 검사 5개 PASS, 클라이언트·내부 전송 검사 11개 PASS다. 기존99 뒤 신규2개, SQL100 없는 SQL101 거절, 두 후속 파일 변조 시 READY 미생성, 기존41 이력과 준비 tail을 검사했다.

종현 제품 연결이 아직 없어 기존 5번·추가 4번은 완료로 올리지 않는다. 자격 있는 네이버 두 계정, 실제 운영 설정·공급사 승인도 별도 대기다. [기존 추가 백엔드 인계](2026-10-08-additional-backend.md)와 [종현 다음 작업](2026-10-08-jonghyun-next.md)을 함께 따른다.
