# SQL114 v2 intent 확정 후보

작업자 `minkyu`. SQL114 migration·DB rollback 검사·이 문서만 이번 산출물이다. runtime worktree의 과거 product/harness snapshot을 root의 최신 source와 함께 덮어쓰지 않는다. 실제 DB·네트워크·외부 업체·운영 배포·커밋·푸시는 실행하지 않았다.

## 해결 범위

SQL101의 `observed_response`는 HTTP 응답을 보았다는 뜻이며 DB 실행 완료가 아니다. SQL102에 같은 요청의 완료 결과가 있어도 기존101 상태에는 `confirmed`가 없어서 `pending_v2`가 계속 차단한다. SQL114는 caller 결과·count·boolean을 확정 근거로 받지 않고, 같은 요청키·전역 token·명시 operation mapping·정확한 input·fingerprint·DB 효과를 확인한 요청만 수동으로 확정한다. 과거 intent 전체를 자동 승격하지 않는다.

신규 `private.worker_intent_confirmation_control.enabled`와 신규 RPC EXEC는 기본 닫힘이다. 원문·첨부·키·Storage 경로를 새 테이블에 추가하지 않는다. 최소 식별자·scope·hash만 보관한다.

## 새 ABI

`prepare_worker_invocation_intent(p_request_id uuid, p_parent_invocation_id uuid, p_operation text, p_scope jsonb, p_predecessor_request_id uuid default null)`:

- 109 invocation의 현재 global 점유, `prepared`, 최초 dispatch CAS, kind·배정 limit·원 deadline·job/lease 감사 연결을 확인한다.
- `scope`는 SQL102 operation input 전체이며 JSONB equality로 보존한다. 기존101 validator에 맞추려고 scope를 축약하거나 결과 input을 재정규화하지 않는다.
- 반환은 정확히 `{ticket,state,fresh}`다. 새 intent만 `fresh:true`다. 기존 key는 같은 binding일 때만 `fresh:false`이며 재전송 허가는 아니다.
- source는5인수 함수 하나만 정의한다. default NULL로4인수 호출은 유지하지만 v1의4인수 regprocedure/OID와 같다는 주장은 하지 않는다. v1은 운영 미적용이며 새 disposable clone에 v2를 적용한다.4/5인수 overload를 함께 배포하지 않는다.
- ACK는 같은109 parent/global/task/job/lease/object의 BEGIN requestId를 선행키로 영속 연결한다. Storage complete는 같은 원 ACK requestId를 연결하며 metadata complete는 선행키가 없다.
- 기존 `prepare_worker_runtime_intent(uuid,text,uuid,jsonb,uuid)` ABI·validator·부모 cycle 의미는 변경하지 않는다. 신규109 binding은 별도 테이블에 둔다.

`execute_worker_invocation_operation(p_request_id uuid, p_parent_request_id uuid, p_global_token uuid, p_operation text, p_input jsonb)`:

- `p_operation`은101 이름이다. `report_storage`는102의 `report_delete_begin`, `report_storage_ack`는 `report_delete_ack`로 명시 변환한다. 입력은 준비한 전체 scope와 정확히 같아야 한다.
- 부모109 →intent101 →binding →result102 순서로 잠근다. 부모 원 fingerprint·준비/CAS·kind·limit·job/lease·deadline·현재 global을 다시 확인한다. 작업 배정은20 이하이며 실행 시간은60초 이하, deadline은 부모 생성 시각+배정 시간을 넘을 수 없다.
- child 최초 dispatch CAS와 기존102 원자 실행을 같은 트랜잭션에 결합한다. unknown/observed/confirmed, 이미 dispatch했거나102 결과가 있는 요청은 `intent_get_only`로 거절하며 기존 GET만 사용한다.
- 효과 뒤에도 같은 트랜잭션에서 global과 원 deadline을 다시 확인한다. deadline을 넘기면 child CAS·102 결과·109 감사·실제 DB 변경이 함께 rollback된다. 외부 DELETE는 이 DB executor가 직접 실행하지 않는다.
- 기존102 RPC ABI는 유지하며 새 scoped executor의 EXEC와114 guard는 기본 닫힘이다.

`confirm_worker_runtime_intent(p_request_id uuid)`:

- caller의 결과/효과/count 입력이 없다. 정확히 `{ticket,state:"confirmed"}`만 반환한다.
- 101과102의 동일 requestId/globalToken, exact scope/input 및 두 fingerprint를 검증한다.102 요청이 없거나 `external_pending`/`purged`이면 거절한다.
- 109 부모가 있으면 부모 원 fingerprint, kind·allocation·claim sequence·job lease와 최초 준비/결과 생성 시각·원 deadline을 확인한다. 만료 global을 갱신하거나 새 점유를 만들지 않는다.
- prepared/unknown/observed 상태라도 실제 DB 증거가 있으면 명시적으로 확인할 수 있다. 상태 자체는 증거가 아니다.
- 처음 확정한 증명의 최소 hash를 보관한다. 이후102 상세가 정상 파기되어도 기존114 확정 receipt와101/109 fingerprint가 일치하는 동일 요청 조회만 멱등 반환한다.

## Operation과 증거

|101 operation|102 operation|추가 증거|
|---|---|---|
|due_enqueue|due_enqueue|같은 input의 원자 DB 결과, `{enqueued}`와 배정 상한|
|job_claim|job_claim|원자 idle 결과 또는 실제 unique slot·job/fence·109 claim sequence|
|cancellation_process|cancellation_process|identity/generation job payload와 실제109 cancellation effect|
|report_task_claim|report_task_claim|원자 null 결과 또는 같은 task/job/lease/global의 실제 task|
|report_storage|report_delete_begin|102 completed, 원 dispatch·ACK와 같은 task/job/lease/global/object/asset, task 완료와 실제 Storage metadata 부재|
|report_storage_ack|report_delete_ack|같은 BEGIN 선행키·원 dispatch·ACK receipt/task/asset/object/hash/time·Storage metadata 부재|
|report_task_complete|report_task_complete|같은 evidence hash의 task 완료·원 dispatch/ACK·absence 또는 metadata terminal receipt|
|job_settlement|job_settlement|정확한 결과 status, 실제 job 상태와109 lease settlement|
|terminal_maintenance|terminal_maintenance|legacy의 완전한 scope와 실제102 원자 purged 결과|

`cycle`에는 실제102 operation proof가 없으므로 confirmed로 바꾸지 않는다. legacy scope가 완전하지 않으면 확인을 거절한다. report dispatch가 미확정인 동안엔 실제 저장 결과와 원 ACK를 읽는 작업만 허용하며 DELETE/ACK 재전송을 추가하지 않는다.

## 잠금과 pending

신규 준비는109 부모 →현재 global 검증/잠금 →101 request advisory/row →binding 순서다. 확정은109 부모 →101 intent →102 result 순서로 잠그며 global 점유는 건드리지 않는다. 효과 증거 조회는 mutation을 수행하지 않는다. 실제 경쟁 실행의 잠금 검증은 root의 새 disposable DB probe가 필요하다.

`pending_v2`는 새114 receipt가 있는 confirmed만 제외한다. 기존 prepared/unknown/observed,102 external_pending,109 prepared/unknown, 완료되지 않은 member dispatch는 계속 포함한다. legacy observed를 일괄 close하지 않는다.

## 연결 후속과 한계

- root의 SDK/internal-client는 새 RPC·새 confirmed DTO를 별도로 연결해야 한다. 이 후보는 그 파일을 수정하지 않았다.
- safety adapter는 새114 scoped executor를 실제102 변경 경계로 사용해야 한다. 외부 Storage 요청은 기존107 dispatch·원 ACK와 별도 중단 경계를 지켜야 하며114가 대신 실행하지 않는다.
- 기존 SQL102 report_task_claim은 저장 결과에서 bucketId/objectName을 제거한다. 원 stored scope 확인 뒤 기존 `check_report_retention_task`를 읽어 transient full task를 조립해야 한다. 제거된 주소를 가짜 값으로 채우지 않는다.
- report_storage는 task 완료 전102 external_pending인 동안 confirmed를 거절한다. v2는 원 BEGIN→ACK→Storage task complete의 requestId 사슬을 검사한다. ACK를 실제 저장/확정한 뒤 task complete를 실행하고 BEGIN 확정은 그 뒤로 지연한다. metadata 완료 뒤 task/ACK가 CASCADE되기 전에 Storage child들을 확정한다. 기존 UNKNOWN/원 ACK를 새키 전송 허가로 삼지 않는다.
- 현재 safety `held`는 lease settlement 없이 반환한다.109 outer completion이 요구하는 settlement가 없으므로 추가 refusal/yield proof 계약 없이 큐 완료로 표시할 수 없다.
- J 소유 `backend/supabase/functions/_shared/db/repositories/jobs.ts`의 claim/settlement requestId를 실제102 atomic executor로 전달하는 주입 포트가 필요하다. 사용자 재배정에 따라 root가 policy-only65c1c83에서 M 소유로 확정했다. 이번 산출물은 해당 파일을 수정하지 않았다. event-runtime/lease/provider 파일은 이 최소 연결안에서 수정 필수로 판단하지 않았다.

## 검사 상태

DB 검사 파일은 fresh disposable SQL109+114 scratch의 빈 작업/intent/result를 요구하며 마지막에 rollback한다. scoped executor의 다른 부모/입력·늦은 최초 실행 거절, 실제102 idle claim 뒤 deadline 초과 시 CAS/result/audit의 전체 rollback, 저장 결과의 재실행 거절과 원 GET 유지, 실제102 idle claim→109 audit→unknown intent의 late confirmation, 실제102 legacy terminal purge→명시 confirmation, incomplete observed 유지, scope/token/operation 불일치, external_pending 거절, 기본 guard/ACL/RLS를 검사한다. v2는 실제 report DB BEGIN→ACK→Storage complete→metadata complete와 원자 proof를 검사하며 외부 Provider/bytes 검증으로 표현하지 않는다. 선행키 없음/다른 키·ACK 없이 부재만 존재·늦은 ACK·원 ACK 새키 재발신·external pending을 검사한다. negative private fixture는 실패 경계를 검사하는 자료이며 실제 성공 evidence로 쓰지 않는다.

**v1 migration5f1c2237/testb12c42ab은 root의 isolated SQL 검증에서 실제 PASS했다. v1 원 산출물·manifest·PASS 기록을 보존하며 이 v2 source로 과거 결과를 덮어쓰지 않는다. **v2 실제 SQL apply/rollback 검사는 아직 실행하지 않았다.**** 파일 내용·정적 확인을 DB 통과로 표현하지 않는다. root가 새 clone에서 migration·검사를 실행하고 전체 row 복구 및 기본 닫힘을 확인해야 한다. 운영5종·회원 모델·실회원 로그인·외부 공급사 완료는 이 산출물의 완료 범위가 아니다.
