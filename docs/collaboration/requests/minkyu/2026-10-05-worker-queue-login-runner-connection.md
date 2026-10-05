# 종현 queue 실행기: 전용 LOGIN·TLS 연결 변경 요청

작성자 minkyu, 2026-10-05. 민규 별도 worktree에서 읽기·요청 문서만 작성했다. 후보 검토 후 민규 main worktree의 요청 문서로 반영했다. 종현 코드·DB 변경은 없다. 기존 [cleanup 연결 요청](2026-10-05-member-cleanup-worker-connection.md)과 [역할 provisioning](2026-10-05-worker-queue-role-provisioning.md)에 반영할 후속 후보이며 J 구현 완료가 아니다.

## 현재 코드와 연결 차이

| 항목 | 읽기 확인한 현재 동작 | 종현 변경 요청 |
| --- | --- | --- |
| 전용 역할 전환 | scheduled-jobs/queue-runner.mjs의 connect()는 client.connect() 뒤 SET ROLE 없이 scheduler/LISTEN/3RPC를 사용한다. | NOINHERIT LOGIN, ADMIN=false/INHERIT=false/SET=true membership 계약에 맞게 고정 yumidang_worker_queue 역할로 전환하고 확인한 뒤 LISTEN·RPC·READY를 허용한다. 새 연결마다 동일 검사하며 실패 시 closed로 종료한다. |
| 로컬 TLS | readQueueRunnerConfig()는 localhost/127.0.0.1/[::1]이면 ssl=false, 원격은 rejectUnauthorized=true다. DB URL의 search를 전부 거절한다. | 로컬 verify-full 검증 경로와 승인된 CA 전달을 명시적으로 설계·검사한다. URL에 sslmode 등을 붙이는 임시 우회로 기존 검증을 건너뛰지 않는다. 원격 검증 완화/rejectUnauthorized=false는 요구하지 않는다. |
| 세 종류 | _shared/jobs/background.mjs는 review_summary/event_sync만 허용하며 excludedKinds.size<2다. SQL40100은 member_cleanup도 반환한다. | 세 종류 허용·제외·afterKind 교대를 연결한다. cleanup이 due일 때 INVALID_QUEUE_KIND로 세션을 버리는 현재 gap을 수정한다. event_sync의 실제 실행 미연결은 별도로 남긴다. |
| 고정 HTTP 경로 | queue-runner.invoke()는 event_sync만 별도 경로로 보내고 나머지는 review-summary-worker다. | member_cleanup을 같은 승인 origin의 /functions/v1/service-api/internal/member-cleanup으로 분기한다. 내부키와 x-worker-run-token, POST {} 계약을 지키며 외부 입력 URL·회원 JWT·body token을 받지 않는다. |
| claimed DTO | background는 result.counts?.claimed===0으로 빈 실행을 판정한다. M cleanup HTTP data는 {status:'ran',claimed,succeeded} 최상위 집계다. | 종류별 wire DTO를 정확히 검증·투영한다. cleanup claimed0을 해당 drain 제외로 처리하고 다른 종류에 기회를 준다. missing counts를 성공·새 작업 존재로 해석하지 않는다. 미구현 retryWait/leaseLost 집계를 만들지 않는다. |
| 75초 HTTP 제한 | runner config 상한은75초, 전역 lease는180초다. invoke의 AbortController 취소 후 finally에서 즉시 release한다. | 취소된 remote 작업의 종료·DB fence·다음 runner 경쟁을 실제 검증한다. 요청 취소가 Provider 삭제/DB COMMIT을 되돌린다고 가정하지 않는다. 고정 lease 연장은 금지다. |

M drainMemberCleanupTasks는 DB read_worker_run_budget와 wall/monotonic deadline을 사용하며 batch20/새 claim 최소60초를 지킨다. 기본 실행 상한180초, 명시 local 검증 옵션은 더 짧게만 제한한다. 따라서 runner75초와 M 배치가 자동 정합한 상태는 아니다. stale global token은 SQL이 차단하지만 이미 시작된 외부 Provider 효과까지 롤백됐다는 증거는 아니다. 시간 계약 선택은 M/J 검토로 확정하며 이 문서가 임의로 timeout을 올리지 않는다.

## 변경 책임과 완료 기준

종현 수정 대상은 기존 scheduled-jobs/queue-runner.mjs, _shared/jobs/background.mjs와 연결 handler/계약·tests/functions/jonghyun이다. 구체 문서 계약은 J docs/collaboration/requests/jonghyun/2026-10-05-policy-implementation-handoff.md의 상주 실행기 계약에 답변으로 남긴다. M의 DB role/migration과 cleanup 포트·HTTP·권한은 민규 책임이며 J 계약 수정이 필요하면 담당 파일/서명을 명시해 요청한다. backend/contracts/worker-jobs.md는 ownership 확인 없이 J가 수정하는 것으로 재배정하지 않는다.

종현 코드 자체가 실제 Client로 전용 LOGIN 접속→검증된 TLS→SET ROLE→LISTEN→due 조회→180초 동일 token 취득→정확 kind HTTP→종결/해제를 수행해야 완료다. 재접속 때 ROLE/LISTEN을 다시 설정하고 알림 재생에 의존하지 않고 due를 재조회한다. 권한 없는 계정·SET ROLE 거절·틀린 CA·DTO 오류·claimed0·HTTP 지연/실패·두 runner 경쟁을 실제 경로로 검사한다. SDK Client adapter가 자동 SET ROLE을 몰래 주입하거나 테스트가 바꾼 config.ssl로 J 원래 동작을 우회하는 결과는 J 실행기 증거로 쓰지 않는다. 새 중복 제품 runner는 만들지 않는다.

## 증거의 정확한 구분

- root의 /private/tmp/yumidang-queue-login-source60-gk25ga1j/dedicated-login-tls-receipt.json은 읽기 확인상 PASS, scope=new_isolated_actual_dedicated_login_tcp_tls_verify_full이다. 새 독립 PG17 cluster의 합성 전용 credential/TLS/3RPC/거절 증거이며 J queue-runner 구동 증거가 아니다.
- 후속 `dedicated-listen-proof/receipt.json`을 확인했다. 전용 LOGIN의 실제 TLS 두 세션에서 COMMIT 알림 1회, ROLLBACK 알림 없음, 수동 재접속 후 TLS·역할 재설정·새 backend PID·기존 알림 미재생·처리 예정 시각 재조회 세 경우가 PASS다. 관찰 구간은 650ms다. 합성 작업 0개, 전용 세션 0개, 전역 점유 해제와 역할·멤버십 불변을 확인했다. 이는 PostgreSQL 연결 동작의 증거이며 종현 실행기의 자동 재접속 증거는 아니다.
- M native60 cleanup driver의 실제 REST/Auth/Storage 및 로컬 hosted HTTP 검증은 승인된 합성 fixture와 임시 guard/ACL 범위다. 최종 guard false/권한 폐쇄를 확인하며 운영 활성화나 J 상주 공정성 검증을 대체하지 않는다. in-process runtime 증거와 실제 local hosted HTTP 증거도 각각의 원래 receipt scope로 구분한다.
- DB role3RPC 권한과 HTTP 내부 secret/Provider service key는 서로 다른 경계다. 전용 queue LOGIN에 cleanup5/budget/Auth/Storage 권한을 주거나 owner credential을 runtime에 사용해 연결을 해결하지 않는다.

현재 이 요청의 J 코드 수정·실제 J LOGIN/TLS·HTTP dispatch·운영 배포는 NOT_RUN이다. 기존 M 문서의 최초 NOT_RUN/정적 후보 문구는 이후 root 영수증과 분리해 시점별로 갱신해야 한다. 이 후보만으로 기존 문서의 성공 범위를 확대하지 않는다.

## 검증 환경 정리

후속 `cleanup-exact-fixture-receipt.json`은 PASS다. 이번 세션에서 만든 격리 컨테이너와 전용 볼륨을 정확한 ID·라벨·단독 사용 여부를 확인한 뒤 제거했다. 호스트의 임시 pgpass와 CA·서버·틀린 CA 개인 키 세 개도 제거하고 검증 영수증은 보존했다. 기존 네이버 실로그인 DB와 native60 통합 DB의 ID·시작 시각·재시작 횟수·실행 상태는 정리 전후 동일하다. 키의 파일 삭제를 보안 삭제 완료로 해석하지 않는다. 따라서 위 증거는 당시 실행 결과이며 현재 살아 있는 검증용 서버를 의미하지 않는다.
