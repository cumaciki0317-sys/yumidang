# 민규 독립 공통 실행 포트 인계 (2026-10-08)

기존 8/10 · 추가 5/6을 유지한다. 이번 독립 보완은 **5/5 완료**다. 공통 서버 준비 완료이며 종현 제품 실행기·AI 연결 및 네이버 두 회원 검증을 포함한 전체 완료는 아니다. 최종 판정과 영수증은 아래 검증란에 기록한다. 운영 DB·Railway·외부 AI·모바일 변경, 커밋·푸시는 하지 않았다. SQL100/101 및 종현 파일은 보존했다.

## 적용·권한

SQL100 →101 →102 `worker_runtime_atomic` →103 `worker_runtime_retention` 순서다. 준비 도구는 기존 이력과 정확한 검토 해시를 검사한다. atomic 제어는 false, 신규 RPC EXEC는 service_role/queue 포함 기본 차단이다. 내부 client 허용 목록은 실행 권한을 부여하지 않는다. 운영 활성화는 종현 제품 연결과 미확정 전송 차단 검증 전 닫는다.

## 종현 연결

`createWorkerAtomicRuntime`의 execute(requestId,globalToken,{operation,input}), get(requestId), slots(token), recovery(afterId,limit)를 사용한다. execute와 get의 결과는 `{requestId,state,result,closedAt,replayed}`다. 같은 요청·같은 입력은 저장 결과, 다른 입력은 충돌이다. DB 변경과 결과 저장은 한 트랜잭션이다. get/recovery는 증거 조회이며 만료된 token의 실행 허가가 아니다.

| operation | 정확한 input 필드 | 결과 의미 |
|---|---|---|
| due_enqueue | kind,limit | 기존 등록 결과 |
| job_claim | workerId,leaseSeconds=180,supportedKinds | job 또는 null |
| cancellation_process | identityId,generation,jobId,jobLeaseToken | 기존 취소 처리 결과 |
| report_task_claim | jobId,jobLeaseToken | 현재 task 식별자; bucket/objectName 제외 |
| report_delete_begin | taskId,taskLeaseToken,jobId,jobLeaseToken,objectId | external_pending; dispatch 식별자 |
| report_delete_ack | 위 fence +ackSha256 | DB의 확정 ACK 기록 |
| report_task_complete | 위 fence +evidenceSha256 | 기존 ACK·Storage 부재 확인 후 완료 |
| job_settlement | jobId,jobLeaseToken,status 및 조건별 availableAt/errorCode | 기존 성공·yield·retry·실패·대체 결과 |
| terminal_maintenance | limit | 기존 terminal 원장 정리 |

모든 입력의 누락·추가 키를 거절한다. job_settlement의 정확한 상태별 형식은 TypeScript union과 SQL102 validator가 기준이다. queued availableAt:null은 기존 DB 현재 시각 의미를 보존한다. claim 결과의 경로는 기존 check_report_retention_task에 현재 fence를 보내 별도로 hydrate한다. 원장에는 경로·첨부·대화·인증정보를 넣지 않는다.

`canDispatchReportDelete`가 true인 새 external_pending 결과(replayed=false,alreadyApplied=false)에만 최초 DELETE를 시작한다. 조회·재시작·응답 유실로 이 조건을 복원하지 않는다. DELETE/ACK 응답 미확인은 자동 재전송하지 않는다. observed_response·점유 만료·30일 경과는 확정 종결 증거가 아니다. metadata 완료는 기존 RPC가 parent도 완료하므로 별도 job 완료를 재전송하지 않는다.

## 작업 수와 회원 정리

SQL102는 기존 supported queue claim의 ABI를 보존하면서 `(global_token,job_id)` 슬롯을 같은 트랜잭션에 기록한다. review_summary·cancellation_safety·report_retention의 같은 실행 고유 jobId는 최대20개다. 빈 claim, 같은 job 재점유, 첨부·ACK·완료는 추가 차감하지 않는다. terminal 유지관리는 기존 별도 한도다. 호출 수·AI 토큰으로 환산하지 않는다.

`processMemberCleanupBatch`는 상위 limit(0..10)·deadlineAt·AbortSignal을 받으며 기존 개별 cleanup port를 재사용한다. 회원/event의 별도 task 저장소를 큐 슬롯에 연결했다고 주장하지 않는다. 제품 scheduler는 잔여 배정과 종료 신호를 전달해야 한다. 기존 회원 정리에서 ACK 없는 작업의 재시작 DELETE를 막는 durable dispatch 연결은 별도 제품 활성화 조건이다. 새 batch는 자동 재시도하지 않지만 기존 단일 함수의 UNKNOWN 재시작을 해결했다고 표시하지 않는다.

## 상세 파기·복구

SQL103은 DB 확정 completed.closedAt+720시간부터 input/result만 정리한다. requestId·fingerprint·최소 식별자와 external_pending은 보존한다. 파기 후 같은 키로 입력·증거를 재생성하지 않는다. 최소키 자동 삭제는 안전한 재요청 기간 근거가 없으므로 구현·활성화하지 않았다. SQL103 recovery는 UUID 커서로 external_pending fence만 반환(SQL101 unknown은 기존 별도 포트)하고 전송하지 않는다.

복원은 오래된 상세 기록을 되살릴 수 있다. backup manifest·파기 대상 최소 식별자/해시를 보호 저장하고, 복원 직후 cron·제어·EXEC를 닫은 채 SQL103 삭제를 재적용한다. UNKNOWN은 삭제 재적용 대상에서 제외한다. 검증·접근 권한 대조 후 제품 연결 조건을 별도 승인·검증한다.

## 실제 검증

- 실제 SQL102/103 DB: strict 필드·원자 rollback·같은 키 replay·세 종류 교대 상한20·만료·권한·30일 파기/UNKNOWN 보존 PASS. `tests/database/minkyu/worker_runtime_atomic.sql`은 격리 DB 트랜잭션 후 rollback한다.
- 실제 JWT → 검증 CA HTTPS → PostgREST → verify-full TLS DB: commit 뒤 응답 유실, 동시 재전송6개가 한 claim, 마지막 슬롯 두 요청 중 한 승자, 별도 프로세스 읽기·만료 후 읽기/신규 실행 거절 PASS. `atomic-http-receipt.json`.
- 실제 격리 file Storage: 합성 소유권 metadata를 DB로 준비한 파일3개의 실제 DELETE3·ACK2, DELETE 및 ACK 응답 유실 뒤 추가 전송0, 첨부2개 동일 queue job 슬롯, 한 신고 최종 파기·다른 UNKNOWN 보존 PASS. 회원 JWT 업로드/모바일 검증으로 확대하지 않는다. `storage-atomic-receipt.json`.
- 전체 SQL103 DB custom backup·역할(no passwords) 복원: 오래된 백업이 되살린 상세를 재삭제, 최소 fingerprint·미확정 건수·앱 EXEC 차단 보존 PASS. `runtime103-restore-receipt.json`. 이번 리허설은 DB 상세 복구다. Storage 바이너리 복원은 이전 SQL95~99 별도 증빙과 구분한다.
- Deno 타입 포함 기존/신규22개 PASS, recovery 추가4개 PASS(중복 포함); 준비 순서99→103/101→103/102→103·변조 거절 선별4개 PASS. 전체 과거 준비 검사108개를 이번 실행에서 모두 재실행했다고 주장하지 않는다.
- 준비 결과: `/private/tmp/yumidang-policy103-independent-prepared`, READY103·canonical99·pending4. 준비 도구의 SQL/Edge 실행은 NOT_RUN이며 앞의 실제 격리 적용과 구분한다.

- 실제 JWT/HTTPS 상세 파기: 종결30일 전후, 같은 요청 replay와 파기 경쟁 뒤 상세 재생성 없음, UNKNOWN 불변, anon·만료 token 거절 PASS. `runtime-retention-http-receipt.json`. 외부 전송0.
- 읽기 전용 하네스 최종 검토: 새 차단 결함 없음. 전체 진행률과 제품 대기 범위를 분리했고 회원/event 미연결·회원 UNKNOWN 재시작 대기를 명시했다.

위 영수증은 `/private/tmp/yumidang-queue-tls99/`에서 0600으로 보존한다. CA/비밀은 저장소에 넣지 않는다. 원문·키가 없는 결과만 인계한다. 제품 queue-runner 통합 및 AI 성공 응답/주기적 파기는 별도 대기다.

관련: [공통 환경 인계](2026-10-08-common-runtime.md), [종현 다음 작업](2026-10-08-jonghyun-next.md).
