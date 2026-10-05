# cleanup 큐의 HTTP 시간 초과와 전역 점유 해제 연결 요청

## 범위와 상태

작업자 민규. main의 종현 `functions/scheduled-jobs/queue-runner.mjs`, `_shared/jobs/background.mjs`와 민규 `_shared/services/member-lifecycle-service.ts`, `_shared/auth/member-cleanup.ts`를 읽기 검토했다. 이 요청문서만 독립 worktree에 추가했다. 종현 파일 수정, DB 연결, 승인·권한 변경, 실제 runner/provider 실행은 하지 않았다. 현재 연결은 NOT_RUN이며 기존 개별 삭제·재가입 검증이 큐 시간 초과의 안전성을 대신 증명하지 않는다.

## 현재 경로의 구체적인 위험

queue-runner의 `readQueueRunnerConfig`는 전역 점유180초와 HTTP timeout 최대75초를 사용한다. `invoke`는 이 timeout에 caller 측 fetch의 AbortController를 중단한다. background의 `drain`은 invoke의 성공·오류 모두 `finally`에서 `repository.release(token)`을 호출한다. 따라서 응답 소실, timeout, 응답 파싱 오류에서도 유효한 전역 점유를 조기에 해제할 수 있다.

민규 `drainMemberCleanupTasks`는 DB budget을 읽어 전역 최대180초의 monotonic/wall 마감을 만들고 최대20건을 처리한다. 새 task에는 최소60초 잔여 예산을 요구하며 `processMemberCleanupTask`는 claim부터 전체60초, task 만료, 전역 마감 중 최소를 사용한다. 단일 task가60초 이내여도 여러 task의 총 실행이75초를 넘을 수 있으므로 현재 HTTP 상한과 배치 마감은 동일하지 않다.

예를 들어 첫 task가45초에 끝나고 둘째 DELETE가70초에 시작하면75초에 caller가 HTTP를 중단하고 전역 점유를 해제할 수 있다. 이후 다른 실행기가 새 전역 점유를 얻는 동안 기존 provider 요청이 계속 처리될 가능성이 있다. 이는 정적 경로로 확인한 가능성이며 실제 provider 중복 실행을 관찰했다는 뜻은 아니다.

caller fetch의 AbortSignal은 원격 서버의 executor signal과 같은 객체가 아니다. 현재 factory는 `(token, signal?)`을 받지만 HTTP 진입점 연결과 request.signal 전파·런타임 연결 종료 동작은 아직 검증되지 않았다. 전파하더라도 AbortSignal이 이미 수신된 Storage/Auth DELETE의 backend 처리를 되돌리거나 중단했다는 영수증은 아니다.

`withinBudget`은 abort 시 호출자 Promise를 먼저 reject할 수 있다. 전달된 signal은 provider fetch와 DB 포트에 전파되지만, 비동기 작업 자체의 종료를 기다리는 기능이 아니다. 따라서 실패 응답이나 지역 함수 반환만으로 모든 원격 작업이 끝났다고 간주할 수 없다.

전역 해제 후 기존 토큰의 check/ack/complete는 DB fence에서 거절되어 잘못된 완료 기록을 막는다. 그러나 삭제 직전 DB check와 원격 DELETE 사이에는 원자 트랜잭션이 없으며, 이미 발행한 외부 DELETE를 fence가 취소하지는 않는다. 특히 DELETE 성공 후 ack 전 실패는 기존 lost-delete-response 연구의 미해결 창으로 남는다. task60초·전역180초 자연 만료도 원격 backend 종료를 증명하지 않는다.

## 요청하는 연결 계약

1. 기존180초 전역 lease와60초 task 상한을 유지한다. lease 자동 연장, caller 지정 업무 시각, timeout을 성공으로 바꾸는 처리는 추가하지 않는다.
2. 내부 HTTP 실행기는 trusted 실행 요청의 로컬 예산을 DB budget과 함께 더 짧게 제한할 수 있어야 한다. 사용자 입력 deadline을 신뢰하지 않고, 내부 인증·허용 상한을 적용한다. caller75초보다 앞선 서버 중단·응답 여유를 확보하고 새 claim의60초 reserve에도 적용한다. 구체적인 여유값은 측정 후 기술값으로 정하며 이 문서에서 임의 확정하지 않는다.
3. HTTP 진입점에서 request.signal을 executor로 전달하고 budget reader, claim/check/ack/complete, provider GET/DELETE까지 전파한다. 연결 종료가 request.signal을 실제로 중단하는지는 배포 런타임에서 따로 검증한다.
4. 정상 성공 응답은 해당 호출이 발행한 provider 작업의 응답을 확인하고 DB 작업이 끝난 뒤 반환한다. timeout·연결 종료·실행 취소·응답 소실·부분 응답은 종료 불확실 상태로 구분한다. `status:ran`이나 HTTP 오류 응답만으로 외부 작업 정지를 선언하지 않는다.
5. caller가 원격 종료를 확인하지 못한 경우 즉시 release하는 경로를 바꿔야 한다. 최소 안전 조치는 기존 점유를 자연 만료까지 유지하고 토큰을 연장하지 않는 것이다. 이는 조기 중복 실행을 줄이는 기술안이며 자연 만료 후까지 지연된 provider 요청의 배타 실행을 보장하지 않는다. 더 강한 완료 기준에는 provider 완료 증거 또는 검증 가능한 종료 프로토콜이 필요하다.
6. 응답이 도착하지 않았다는 이유로 provider를 재삭제하거나 task를 completed로 기록하지 않는다. durable ack가 있으면 같은 immutable task/object의 기존 proof로 복구하고, proof가 없으면 명확한 실패로 남긴다. 빈 metadata404나 사전 intent만으로 DELETE 성공을 추정하지 않는다.

현재 J의3kind 지원과 `counts.claimed` 대 M 최상위 `claimed` 차이는 root의 별도 연결 요청 범위다. 이 문서는 timeout·해제 경계에 집중하며 해당 변경을 직접 수행하지 않는다. cleanup HTTP 경로도 명시적으로 정해야 하며 현재 review/event 분기에 cleanup을 억지로 통과시키지 않는다.

## 연결 완료 확인 조건

| 검증 | 필요한 증거 |
|---|---|
| 총 배치75초 초과 | caller timeout 이전 서버 예산 때문에 다음 claim이 시작되지 않음, 전역 lease 연장0 |
| caller 중단 | HTTP request signal에서 executor·5개 DB 포트·provider까지 실제 전파됨 |
| provider DELETE 처리 중 연결 종료 | 새로운 DELETE/DB complete 차단과 진행 중 요청의 실제 최종 결과를 따로 기록 |
| timeout·잘못된 응답·응답 소실 | 원격 종료 확인 없는 즉시 release가 없음, 성공/완료로 기록하지 않음 |
| 정상 완료 | 해당 호출의 모든 provider 응답과 DB 종료 확인 후에만 점유 해제 |
| abort를 무시하는 provider 모형 | 함수의 조기 reject를 backend 정지로 판단하지 않음, 지연 DELETE 결과를 분리 |
| DB fence | 해제/만료된 global token과 옛 task lease의 ack/complete 거절 유지 |
| 재시도 | 기존 durable proof만 재사용하고 동일 객체 재삭제·lease 연장 없음 |
| 실제 LISTEN/재연결 | 격리 LOGIN 프로세스 handle로 timeout 후 재접속·재조회·점유 상태를 확인 |
| 최종 청소 | 합성 회원/파일/작업0, guard false, cleanup 실행 ACL 폐쇄, 전역 점유 최종 상태 확인 |

단위 검증에서는 제어 가능한 timer와 늦게 resolve하는 provider 모형으로 조기 release 경로를 재현할 수 있다. 실제 검증은 root가 승인한 격리 환경에서만 별도로 진행하며, 현재 이 문서는 준비 단계다. 운영 활성화나 물리 삭제 완료의 일반적인 보장은 주장하지 않는다.


## root 인수 시 현재 구현과 증거 구분

M handler는 이미 request.signal을 executor에 전달하며 명시적인 로컬 runtime 조립도 구현했다. 합성 fetch의 실제 인증→budget→claim 연결 검사는 통과했다. 따라서 위의 HTTP 진입점 미연결 문구는 실제 배포/runtime 연결 종료 전파와 큐 통합이 미검증이라는 범위로 해석한다. 기본 배포 진입점은 여전히 비활성404이며 실제 원격 요청의 종료 증거는 없다.40100도 USAGE/SET 경로 및 auth 의존 권한 검사 보완 후 격리 적용 검증을 시작한 후보이고 운영 적용이 아니다.
