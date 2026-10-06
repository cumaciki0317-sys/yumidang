# 신고 증거 DELETE 전송 의도 fence 후보

상태: source81 신규 SQL·회귀·계약 후보 작성. 실제 SQL·두 세션·Storage/API·정식 적용 NOT_RUN. source79(c5b801)/80(bbe43a) 원본 바이트는 변경하지 않는다. source79/80 단일 TX PASS f4480057 증거는 이전 계약만 증명하며 source81 실행 증거가 아니다.

## 필요한 후속 경계

source79는 ACK 없는 task의 lease가 만료되면 새 lease로 다시 점유한다. 기존 DELETE 요청이 원격에서 계속 실행 중일 수 있으므로 재점유 직후 새 DELETE를 허용하면 중복 또는 지연 DELETE 위험이 생긴다. canonical reserve_report_capture는 회원 입력 asset UUID를 사용하며 metadata 삭제 후 같은 UUID/name 재예약이 가능하다. 무작위 이름이라는 추정으로 안전성을 증명하지 않는다.

새 `public.begin_report_retention_delete(taskId,taskLeaseToken,jobId,jobLeaseToken,globalToken,objectId)`는 기존 uuid typed6를 받아 exact3 `{taskId,dispatchId,alreadyApplied}`를 반환한다. 정확 storage task의 현재 원 fence를 검증하고 immutable dispatch를 원 task/job/global lease에 결합해 durable 기록한다. 이 SQL 성공은 DELETE를 전송하려는 의도이며 Provider 완료·파일 부재·조건부 objectId DELETE 증거가 아니다.

최초 begin의 alreadyApplied=false만 새 단일 exact DELETE를 시작할 수 있다. 같은 원 lease에서 중복 begin은 같은 dispatchId/alreadyApplied=true로 기존 의도를 읽는다. 이를 새 전송 허가로 사용해서는 안 된다. begin 응답 소실도 원격 DELETE 여부가 불명확하므로 caller journal FAIL을 보존하고 자동 재전송하지 않는다.

## ACK와 재점유

ACK 없이 dispatch가 있으면 원 task lease가 만료돼도 해당 storage task는 claim 대상에서 제외한다. 다른 미전송 task는 별도 처리할 수 있으나 남은 처리 대상이 unknown dispatch이면 55000 report_delete_dispatch_unknown으로 보류한다. 소비자는 이 상태를 held 진단으로 처리하고 같은 job을 즉시 무한 claim하는 hot loop를 만들지 않는다. J held/yield 후속 연결은 미구현이며 새 재시도 간격이나 보관기간은 이 문서에서 정하지 않는다.

record ACK는 유효 dispatch와 최초 원 task/job/global lease binding 및 현재 fence를 모두 요구한다. ACK 없는 old lease는 만료 뒤 ACK를 기록할 수 없다. ACK 존재 후 새 lease가 점유한 task는 GET ACK→정확 부재 재조회→complete만 한다. 새 lease의 begin 또는 record ACK는 55000으로 거절하며 원 dispatch를 바꾸지 않는다. 동일 원 lease의 ACK 재생은 같은 hash만 허용하고 다른 hash40001 규칙을 보존한다.

storage complete와 parent metadata complete는 dispatch·asset/object ID·ACK 관계를 모두 재검사한다. unknown intent만으로 child 완료나 metadata 삭제/이름 예약 해제는 불가능하다. 원 intent의 UPDATE는40001이고 임의 DELETE는55000으로 막는다. 저장된 closure UUID와 기존 finalizing 경계가 일치하는 검증된 metadata 파기 CASCADE만 삭제한다. 원 intent/ACK는 task/report 목적 상세와 함께 CASCADE되고 새로운 보관기간 또는 영구 tombstone을 만들지 않는다. metadata terminal receipt의 기존 작업 상세30일·원 completedAt/정확720h 정책은 그대로다.

## 권한·기존 metadata

새 table private.report_purge_dispatches는 owner-only/RLS이며 모든 gateway/서비스/worker 직접 권한을 닫는다. 새 public begin RPC EXEC도 PUBLIC/anon/authenticated/service_role/authenticator/worker_queue 모두 닫는다. source79 guard=false 기본값을 유지하며 원 3개 RPC와 source80 readiness helper의 OID·owner·ACL·config를 그대로 보존한다. 후속 본문만 정확 anchor로 교정한다.

guard 행은 SHARE로 고정하고 enabled=false만 허용하며 행 부재/true도 migration55000으로 거절한다. 이전 ACK나 이미 running/completed storage task가 있는 설치는 migration55000으로 거절한다. 과거 DELETE 전송 사실을 추정해 dispatch를 백필하지 않는다. 기존 pending task는 새 begin 경계를 거쳐야 한다. source79 표/함수의 원 ownership이 호환되지 않으면 권한 확대 없이55000으로 닫는다.

source81은 source80 readiness helper의 정확 anchor 하나를 추가 교정하여 begin 포함8개 RPC의 service EXEC를 모두 요구한다. 7개만 열리고 begin이 닫힌 경우 scoped claim은 queued 작업을 변경하지 않는다. 같은 회귀 savepoint에서8개가 준비된 경우 점유를 허용하고 모든 grants/점유를 rollback한다. 실제 개방에는 B adapter의 begin 호출·alreadyApplied 처리 연결도 선행되어야 한다. 현재 B adapter는 begin을 호출하지 않으므로 외부 준비false/미연결을 유지한다. J/worker runtime 직접 파일과 원 source80 파일은 A가 수정하지 않는다. source81 후속 leaf에서 readiness 함수의 OID·owner·ACL·config는 보존하고 본문만 정확 교정한다.

## 별도 후속 회귀

새 회귀는 source79의 owner 합성 fixture 패턴을 재사용하되 ACK 전 begin이 필수인 source81 계약으로 분리한다. 기존79 회귀 파일/과거 PASS를 수정하지 않는다. 새 회귀는 다음을 검사할 예정이다.

- 신규 권한폐쇄, 원함수 metadata 보존, exact3 및 같은 원lease 중복 begin의 원dispatch 불변.
- begin 없이 ACK 거절, ACK 없는 intent의 task 만료 뒤 claim 보류/old lease ACK 거절/parent 삭제 불가.
- 다른 미전송 task 처리 허용, unknown만 남았을 때55000 및 원task token/dispatch 유지.
- 정상 원lease ACK 후 새lease GET ACK·부재·완료 허용, 새 begin/record 거절, 다른hash40001.
- metadata 실패 전체 rollback과 dispatch 보존, 모든 child 완료 뒤 report/task/intent CASCADE, 기존 최소 no_show 보류 및30일 terminal 사실 유지.

합성 owner metadata DELETE와 hash는 실제 Storage bytes/DELETE 성공 증거가 아니다. 두 세션 in-flight 재현, 실제 provider 지연 응답/응답 소실, lease 만료와 동일name 재예약, unknown 운영 진단·복구 및 source81 실제 SQL은 아직 NOT_RUN이다. Unknown을404나 전송 의도로 완료 처리하지 않는다.

## readiness 추가 독립 보완

최초 d26f4ab SQL/6bf809 회귀/df50a2d 계약 사본은 private 동결 폴더에 보존한다. 새 후보의 변경 기존 함수는 report claim/ACK record/complete 및 readiness 총4개다. 신규 begin 권한이 닫혔는데도 기존7개만 보고 job을 점유하는 상태를 남기지 않는다. savepoint 회귀의 readiness7/8 점유 검사는 실제 SQL NOT_RUN이며 의미 있는 후보 assertion으로만 작성했다.
