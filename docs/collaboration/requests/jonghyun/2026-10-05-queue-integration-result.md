# 종현 상주 큐 실행기 구현·인계

기준: 독립 clone `jonghyun/queue-integration`, baseline `9dfca36`, actor jonghyun.
사용자 선택: 원격 종료 불확실 시 종현의 조기 해제 차단을 먼저 구현하고 서버 종료 확인은 민규 연결 대기.

## 변경과 계약

- 기존 queue-runner와 background scheduler에만 후속 구현. 자동 완료 실행기/권한 변경 없음.
- 모든 DB 연결은 로컬 포함 `ssl:{rejectUnauthorized:true,ca}`. PEM bundle의 모든 인증서를 실제 X509 파싱하고 PEM 외 내용 거절. 파싱 통과는 승인된 CA/실제 TLS 연결 증거가 아니다.
- 매 접속/재접속은 connect → 고정 SET ROLE yumidang_worker_queue → current_user/session_user 확인 → LISTEN yumidang_worker_jobs → DB schedule 재조회 → READY 순서.
- URL 사용자와 DB 로그인 역할은 추측/절삭하지 않음. `WORKER_QUEUE_DB_LOGIN_ROLE`를 명시하고 session_user와 일치 검사. LOGIN의 NOINHERIT·SET-only membership·owner 제외·최소권한 실제 검증은 민규 provisioning 책임.
- RPC는 schedule/acquire/release3개, acquire(180,null), 연장 없음. schedule의3kind/제외/afterKind 교대, claimed0과 미준비는 한 drain에서만 제외.
- 같은 승인 origin의 고정3HTTP 경로. cleanup은 `/functions/v1/service-api/internal/member-cleanup`, 내부 Bearer와 UUID header, body `{}`, query/redirect 없음.
- cleanup data는 정확 `{status:'ran',claimed,succeeded}`, 정수 `0≤succeeded≤claimed≤20`. 임의 not_enabled/중첩counts/추가키는 종료 불확실로 거절. event/summary는 counts/stopReason/hasMore 검증.
- 연결의 각 비동기 경계와 notification에서 중단/오류 상태를 재검사하며 stop은 새 dispatch부터 차단한다. 경과시간은 monotonic clock을 사용한다.
- 확인된 정상 응답과 명시 dispatch 전 실패만 release. HTTP시간초과75초/응답소실/잘못된JSON/DTO/network오류/abort무시 지연응답은 release/연장 없이 DB schedule재조회. 자연만료는 원격 Provider 종료증거가 아니다.

## 설정 연결 요청

| 환경 이름 | 의미/범위 |
|---|---|
| WORKER_QUEUE_DATABASE_URL | 전용 LOGIN의 Direct/Session 연결 URI, URL query 없음 |
| WORKER_QUEUE_FUNCTION_URL | 승인 HTTPS origin의 /functions/v1/review-summary-worker |
| WORKER_QUEUE_DB_CONTRACT_ID | 환경 준비 근거 식별값, 역할/권한 인증을 대신하지 않음 |
| WORKER_QUEUE_QUERY_TIMEOUT_MS | 양의 정수, 최대10,000 |
| WORKER_QUEUE_RECONNECT_MS | 양의 정수, 최대2,147,483,647 |
| WORKER_QUEUE_HTTP_TIMEOUT_MS | 양의 정수, 최대75,000 |
| INTERNAL_WORKER_SECRET | 내부 secret, 사용자 JWT/관리 API 키로 대체하지 않음 |
추가 필수: `WORKER_QUEUE_DB_CA_PEM`(승인 CA bundle), `WORKER_QUEUE_DB_LOGIN_ROLE`(전용 LOGIN 실제 역할). config injection도 같은 검증. 키/URI 값은 문서/로그에 기록하지 않는다.

## 이번 검증

- `node --check` runner/background PASS.
- `node --test tests/functions/jonghyun/background-runner.test.mjs` 38/38 PASS.
- 소유권 검사와 `git diff --check` PASS.
- 범위: 가상 Client/HTTP/timer로 ROLE 호출순서/거절·TLS설정/CA파싱·재접속·3kind교대·정수DTO·원격불확실유지·stop경계·연결중중단·초기처리중중단·호스트시계변경. 실제 socket/전용LOGIN/TLS/DB/HTTP는 NOT_RUN. 기존 민규 임시환경 증거로 대체하지 않는다.

## 민규 연결 대기

1. 승인 CA와 전용 LOGIN/SET-only membership/3RPC권한을 갖춘 격리환경 제공.
2. cleanup 서버 budget/정상반환과 외부 작업 종결 근거 확인. caller75초보다 앞선 서버예산/응답여유는 측정후 계약, 임의값 도입 없음.
3. 기본 service-api 비활성 cleanup404의 명시 조립/내부secret주입. guard/ACL은 종현이 열지 않음.
4. 실제 runner 코드로 TLS정상/잘못된CA·SET거절·LISTEN COMMIT/ROLLBACK·자동재접속·2runner경쟁·응답소실 검증후 원복/자료정리.

현재 완료는 종현 코드/가상검증이다. 회원 정리 운영 활성화·실제 삭제완료·상주호스트복구는 완료로 표시하지 않는다. 커밋/푸시/배포 미실행.
