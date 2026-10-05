# cleanup 신뢰할 로컬 실행 상한

민규 독립 worktree에서 main 서비스와 batch 테스트의 정확 snapshot을 먼저 확보했다. 원본 SHA는 service `d81abb47cdd389fddec5c6795bef597d2869b3e6cac9e608e3f09e58754506b1`, batch test `fd3619fb46392944c69fb0fa14d4e8f903607041786d9ad019f3932c68f1f013`이다. 소유권 확인 후 이 두 파일과 이 문서만 수정했다. main/J/SQL 및 다른 의존 파일은 변경하지 않았다.

`MemberCleanupExecutionOptions = {maxExecutionMs?:number}`를 trusted 로컬 조립 옵션으로 추가했다. `drainMemberCleanupTasks(token,readBudget,processTask,signal?,options?)` 및 `createMemberCleanupExecutor(config,fetch?,options?)`가 받는다. 지정하면 양의 safe integer만 허용하며 DB180초·DB 반환 deadline·로컬 상한 중 작은 경계를 사용한다. 옵션 생략은 기존180초/20건 batch 동작을 유지한다. 운영 상한값을 새로 정하지 않았고 회원 입력/body/header/runtime HTTP에 새 deadline 필드를 추가하지 않았다. 기존 public retire 입력·processing/completed 응답은 유지한다.

wall/monotonic 시작점을 budget 조회 전에 기록한다. 명시 상한은 조회 시간부터 차감하고 조회 중에도 abort를 전달한다. budget 응답 이후에도 wall과 monotonic을 함께 검사하여 시계가 앞뒤로 움직이거나 DB 반환 시각이 길어져도 상한을 연장하지 않는다. 처리마다 전체60초 잔여를 확보하지 못하면 새 claim을 시작하지 않는다. global/task lease 갱신·추가 권한·새 삭제 로직은 없다.

abort는 종료 증거가 아니다. 새 검사는 실제 Provider/adapter가 아니라 주입한 processTask Promise 모형을 사용한다. batch가 그 모형의 반환을 기다리고 반환 후 취소·만료를 검사해 성공 집계를 거절하는 범위만 검증한다. 실제 processMemberCleanupTask의 withinBudget은 원격 operation 종료 전에도 reject할 수 있어 factory가 실제 Provider 종료를 기다린다는 증거가 아니다. signal을 무시하는 readBudget 모형도 로컬 timer가 신호만 전달하고 Promise를 강제로 끝내지는 않는다. 실제 budget 포트의 upstream timeout/취소 경계 및 HTTP75초 조기 release 문제는 별도 검증·연결이 남아 있다.

의존 파일이 없는 오래된 독립 WT 대신 `/private/tmp/yumidang-cleanup-local-budget-verification-20261005`에 main TypeScript 의존 snapshot을 복사하고 후보 서비스·batch 테스트만 overlay해 검증했다. 운영 DB/Provider 접속은 없으며 테스트 fetch는 합성 응답이다. `deno test`로 batch15/runtime3/public lifecycle6의 타입 검사와 의미 회귀24개를 실행했다. budget 조회 지연·조회 중 abort·작은 DB/로컬 상한·추가 claim 없음·wall 앞뒤 변화·provider abort 무시·기존 factory/public retire 호환을 포함한다. 결과는 root 전달 시 실제 실행 결과를 따른다. 파일 존재나 합성 회귀를 실제 운영 삭제·상주 연결 완료로 설명하지 않는다.
