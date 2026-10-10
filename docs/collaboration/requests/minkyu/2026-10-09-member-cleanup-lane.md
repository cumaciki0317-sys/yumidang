# 회원 삭제 영속 실행 연결 — SQL110

작업자: `minkyu`. 기존 SQL109 및 공통 client는 수정하지 않았다. SQL110은 후속 migration이며 활성화·EXECUTE·운영 배포를 수행하지 않는다.

## 기존 구조와 필요한 연결

회원 삭제는 `private.member_cleanup_tasks`를 사용한다. 기존 claim/check/complete는 현재 global token을 검증하지만 실제 `worker_jobs`, SQL102의 고유 작업 20개 원장, SQL109의 invocation 감사에 연결되지 않았다. task UUID를 slot에만 넣고 공유 큐 연결이 완료됐다고 판정할 수 없다.

SQL110은 실제 `worker_jobs` 행을 만든다. `job.id = task.id`, `kind = member_cleanup`, `payload = {taskId}`이며 기존 `(kind,dedupe_key)` 고유 조건을 사용한다. 별도 mapping/audit table을 추가하지 않는다. UUID 충돌이나 다른 payload가 있으면 전체 claim transaction을 거절한다. 원문 경로·회원 이름·외부 응답 본문을 job payload나 invocation에 복사하지 않는다.

## 준비·실행·완료 계약

- `prepare_queue_invocation`의 기존 pending·fingerprint·global 검사 본문을 보존하면서 `member_cleanup`만 허용 목록에 추가한다. 사용자 확정 배치 상한은 10이며 11 이상은 거절한다.
- 기존 최초 dispatch CAS를 사용한다. `prepared`, 정확한 kind/token/배정, `dispatch_started`, DB deadline을 확인한 실행만 task를 claim한다. `unknown`은 새 claim·DELETE begin·ACK 기록을 허가하지 않는다.
- 기존 SQL108까지의 task claim을 먼저 호출하고 같은 transaction에서 실제 job, fence, SQL102 slot, SQL109 lease별 감사 행을 결합한다. cap20을 넘는 새 job은 task claim까지 rollback한다. 같은 job 재점유는 slot을 추가 차감하지 않는다.
- task/job 만료 시각은 기존 task 60초·공유 global 만료·invocation deadline 중 가장 이른 값으로 제한한다. global 180초를 갱신하지 않는다.
- DELETE dispatch가 없고 이전 lease가 만료된 같은 invocation의 attempt만 재점유한다. 이전 attempt는 DB에서 `superseded`로 정리하며 새 lease의 effect는 비어 있다. 이미 dispatch된 task는 기존 SQL107/108의 재점유 금지를 유지한다.
- 완료는 기존 task 완료 RPC의 ACK·외부 부재 검사를 통과한 뒤 같은 transaction에서 해당 lease의 effect와 실제 job의 `succeeded`를 기록한다. 원 dispatch와 ACK의 task/object/원 token/원 lease/profile/withdrawal/kind 결합도 확인한다.
- invocation 완료는 실제 claim/idle 감사, 모든 lease의 settlement, 마지막 task attempt의 성공, 실제 완료 task와 원 dispatch/ACK를 함께 확인한다. HTTP counts나 `observed_response`를 입력으로 받지 않는다. 결과는 기존 `{status:'ran',counts:{claimed,succeeded,retried,failed,superseded,yielded}}`이며 고유 job별 마지막 settlement를 집계한다.

기존 6종 invocation은 기존 SQL109 완료 본문으로 위임한다. 기존 kind/payload/effect CHECK는 원 표현식을 보존하고 회원 분기만 추가한다. 후속 SQL111의 행사 분기가 기존 표현식을 보존하면 `110 → 111` 순서로 공존할 수 있다.

## 검증 상태와 남은 조건

`tests/database/minkyu/member_cleanup_invocation.sql`은 합성 scratch DB 전용 rollback 테스트다. 배치 상한, actual job 연결, deadline/global 만료 제한, 같은 job의 새 lease 감사와 효과 미전승, 고유 slot 유지, cap20 rollback, UUID 충돌 rollback, 잘못된 원 ACK token 거절, 효과·settlement 없는 완료 거절, UNKNOWN 재전송 차단, 기존 review 완료 위임을 검사한다.

이 테스트의 ACK는 RPC/DB 결합을 검사하기 위한 합성 receipt다. Storage/Auth 물리 DELETE나 외부 HTTP를 호출하지 않으며 실제 외부 삭제·원격 ACK 수신·Auth hard delete 통합 검증의 PASS를 의미하지 않는다. root의 격리 clone 실제 SQL110 검증은 **PASS**다. `/private/tmp/yumidang-member110-20261009-v1/receipt.json`에서 migration SHA256 `8cda95503183c2784c6e56cf4904b34eae67824fd310a1452c7001d7f1f52125`, test SHA256 `7b0da1088ba40ec418ffc229640df5cf10363d5c2ed6b1bde44de7f529995964`, 전체 테이블 rollback·원 DB 변경0·운영 변경0을 확인했다. 기본 guard/EXECUTE가 닫혔다는 점도 운영 준비 완료를 의미하지 않는다.

공통 typed client의 kind 허용 목록과 회원 HTTP의 정확한 배정 조회·CAS·batch 주입은 root 통합 범위다. CLI의 회원 lane은 이 연결과 실제 검증이 완료될 때까지 활성화할 수 없다. 실회원 네이버 로그인 검증을 지금 수행하지 않는 기존 사용자 결정을 유지한다.

## tracked UNKNOWN의 GET-only 복구 gap

SQL108 ACK 복구는 원 dispatch·ACK를 보존하고 새 global token·새 task lease로 GET-only 확인한다. SQL109 invocation은 원 global token·원 job lease에 결합되어 있다. 새 SQL110에 연결된 UNKNOWN task의 terminal 복구를 기존 SQL108만으로 완료하려 하면 이 결합이 맞지 않아 안전하게 거절한다. SQL110에 연결되지 않은 기존 task의 SQL108 복구 경로는 기존 guard/권한 조건에서 보존된다.

백엔드 100% 계획을 닫으려면 후속 DB reconcile 계약이 필요하다. 원 invocation 식별자, 원 dispatch와 원 ACK의 결합, GET-only로 확인된 실제 task terminal 상태를 읽어 실제 job terminal과 invocation 결과를 원자 확정해야 한다. 원 token을 바꾸거나 새 lease의 effect를 원 lease에 복사하지 않으며 DELETE·dispatch·ACK를 추가 전송하지 않는다. ACK가 없는 UNKNOWN은 계속 보류한다. SQL110 fresh lane 검증 뒤 별도 후속으로 진행한다.


## SQL115: tracked UNKNOWN의 독립 GET-only 복구 출처

후속 파일은 `20261009011500_member_cleanup_reconcile.sql`과 `tests/database/minkyu/member_cleanup_reconcile.sql`이다. SQL109·110·112·114의 원 파일과 공통 client를 수정하지 않는다. 새 `private.member_cleanup_reconciliations`는 원 invocation/task/job/withdrawal/object/dispatch/global/lease/ACK receipt·hash와 복구 global/lease/만료·완료 증거를 결합한다. 경로·회원 이름·외부 응답 원문을 저장하지 않으며 target 결합은 hash로 보존한다. 원 lease의 `effect`는 그대로 두고, 독립 복구 원장으로 완료 출처를 증명한다. 새로운 TTL·자동 삭제 정책을 추가하지 않는다.

RPC 계약은 다음과 같다.

- `begin_member_cleanup_reconcile(recoveryRequestId,invocationRequestId,taskId,recoveryGlobalToken)`은 ACK와 정확히 결합된 원 `unknown`만 허용한다. 최초 호출은 기존 SQL108 ACK 복구 claim을 한 번 사용하며 `{recoveryRequestId,state,fresh:true,task}`를 반환한다. `task`는 기존 cleanup DTO다. 같은 key 재조회는 `fresh:false,task:null`이며 claim·lease 갱신을 하지 않는다. input이 달라지면 거절한다.
- `get_member_cleanup_reconcile(recoveryRequestId)`는 `{recoveryRequestId,invocationRequestId,taskId,state,original,recovery,evidenceSha256,closedAt}`의 최소 proof만 반환한다. `original`은 withdrawal/object/dispatch/global/jobLease/ACK receipt·hash, `recovery`는 global/lease/expiresAt이다. 경로는 반환하지 않는다.
- `finish_member_cleanup_reconcile(recoveryRequestId,evidenceSha256)`는 기존 GET-only adapter가 실제 Storage/Auth 외부 부재를 확인한 뒤 호출한다. SQL은 기존 ACK 및 Storage metadata/Auth row 부재 계약을 재사용한다. 새 점유의 현재성·만료, 원 binding·target hash를 작업 전후 검사하고 task 완료·실제 원 job terminal·독립 recovery 완료를 같은 transaction으로 기록한다. 원 job lease의 effect를 새 lease에서 복사하지 않는다.

provenance의 상태는 `prepared`, `completed`, `superseded`다. 만료된 GET-only 시도의 새 key 재시도는 같은 원 proof를 다시 확인한 뒤에만 가능하며, 이전 기록을 지우지 않는다. 새 복구 current global에서 동일한 실제 job ID의 slot을 예약하고 고유20을 넘으면 claim까지 rollback한다. 원 global slot·invocation token·deadline은 바꾸지 않는다. 복구 task lease는 기존60초와 현재 global 만료 중 이른 값이며 global180초를 갱신하지 않는다.

잠금 순서는 global singleton → 원 invocation → recovery row/task → 실제 job이다. 원 token의 만료 자체는 성공 증거가 아니다. ACK 없음, 잘못된 원 binding, 다른 target, 아직 유효한 이전 task lease, cap20, 현재 global/복구 lease 만료, Storage metadata 또는 Auth row 존재는 모두 완료를 거절한다. DELETE·새 dispatch·ACK 재전송을 수행하는 RPC는 추가하지 않는다. 기본 guard와 EXECUTE는 닫힘을 유지한다.

`complete_queue_invocation`은 최신 기존 함수에 위임하는 후속 wrapper다. 회원 `unknown`에 한해, 중단 이후 새 claim이 불가능한 상태에서 이미 claim한 모든 job의 terminal 증거를 검사해 실제 고유 job counts로 닫는다. 원 SQL110 fresh 완료 proof 또는 SQL115 독립 recovery proof가 필요하며, 미처리 lease 하나라도 있으면 계속 보류한다. UNKNOWN에서 중단된 부분 배치는 미사용 배정만큼 새 작업을 실행하지 않고 확인된 실제 처리량만 반환한다. 다른 kind 및 이미 완료된 결과는 기존 delegate chain을 사용한다. SQL114 legacy intent pending 계약은 변경하지 않는다.

SQL115의 합성 rollback 테스트는 기본닫힘/RLS, ACK 없는 UNKNOWN 보류, 원 ACK token 불일치, cap20 rollback, 새 lease·독립 출처·원 token/fence 보존, begin replay의 claim·갱신0, target 변경 거절, Storage metadata/Auth row 존재 거절, 현재 global 및 복구 만료 거절, 원 dispatch/ACK 불변, 원 effect 미복사, 실제 terminal·부분 배치 counts, 기존 review delegate를 검증한다. Auth row 제거 사례도 합성 DB metadata를 rollback 범위에서만 바꾸며 외부 Auth DELETE를 호출하지 않는다.

격리 clone의 실제 SQL115 DB 회귀는 **PASS**다. `tests/integration/minkyu/member_cleanup_reconcile_local.py`로 원 SQL112 DB `yumidang-minkyu-event112-20261009-v1`을 읽기 복제하고 새 `yumidang-minkyu-member115-20261009-v2`에 최종 SQL114와 SQL115를 적용했다. 원본은 현재 186개 비시스템 테이블이며 적용 후 clone은 190개다. 전체 테이블 rows digest·schema catalog·role/membership/ACL을 비교해 원본 변경0과 합성 회귀 전체 rollback을 확인했다. clone은 `--network=none`, 캐시 이미지 `--pull=never`, socket-only, cronoff이며 guard/global/EXECUTE는 기본닫힘이다. 기존 SQL114 confirmation과 행사 guard/EXECUTE의 닫힘도 읽기 전용으로 보완 확인했다.

최종 영수증은 `/private/tmp/yumidang-member115-20261009-v2/receipt-final.json`이다. 원 `receipt.json`과 v1의 Docker socket sandbox 접근 실패 자료도 private600으로 보존했다. migration SHA256은 `74a0d3b2af807310f76dd77d8769f3177ca8f47cef2161ca4b44f194bbb73081`, test SHA256은 `9c570376c88e104d0944540f006cab6f119530dc5e2e3dda2cd6756f8e233ddd`, 적용 SQL114 SHA256은 `7ba321e924e02bfea41a244435a21a5fc52d71e049421e178ca72a91358065ed`이다. physical Storage/Auth GET-only 및 DELETE, 실제 회원·제품 API/CLI 연결은 **NOT_RUN**이며, 합성 ACK·evidence가 실제 외부 확인의 PASS를 대신하지 않는다. 이번 실행의 추가 외부 DELETE·dispatch·ACK와 외부 통신은 0이다. 운영 배포·실회원 로그인·commit/push는 수행하지 않았다.

clone prerequisite은 SQL108 ACK recovery 및 `complete_member_cleanup_task_sql109`, SQL109/110, 최신 SQL112/114 연결이다. scratch transaction 안에서 `worker_jobs`, `worker_runtime_intents`, `worker_runtime_results`, `worker_runtime_job_slots`, `worker_invocations`, `member_cleanup_tasks`, `member_cleanup_dispatches`, `member_cleanup_reconciliations`를 CASCADE truncate하고 테스트 첫 BEGIN만 제거해 최종 ROLLBACK한다. 의존 event progress 및 SQL114 confirmation도 FK CASCADE로 같은 transaction 안에서 정리된다. fixture auth/profile UUID `d1150000-0000-4000-8000-000000000001`~`000000000003`의 원본 충돌이 없어야 한다. 최종적으로 모든 테이블 digest가 원 상태와 같아야 한다.
