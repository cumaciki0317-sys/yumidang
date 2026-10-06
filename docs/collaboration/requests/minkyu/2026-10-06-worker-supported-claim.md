# 지원 작업 종류를 점유 전에 제한하는 DB 후보

작성자: 민규 (`minkyu`), lane C. 실제 DB/CLI/API 실행은 하지 않았다. 본 문서는 신규 SQL·합성 회귀의 후보 계약이며 실제 SQL/두 세션/HTTP/운영 PASS가 아니다.

## 현재 결함과 변경 범위

최신 root source78의 `public.claim_job(uuid,integer,uuid)`는 kind 조건 없는 기존2인자 함수를 호출한다. J `db/repositories/jobs.ts`는 `input.kinds`에 review_summary가 하나라도 있으면 DB claim을 실행한 뒤 반환 kind를 검사한다. 취소 작업이 먼저 due이면 job을 running으로 바꾼 뒤 decoder가 거절할 수 있다. `read_worker_queue_schedule`의 excludeKinds/afterKind는 예약 조회이며 점유 selector가 아니다.

기존03000/040100/040300과 J 파일을 수정하지 않는다. 후속 마이그레이션만 기존 claim2/3의 body를 바꾸고 좁은 새 public 함수1/private 함수2를 추가한다. 새 표·role·table grant·cron·schedule 변경은 없다. 기존 함수2개의 OID/owner/ACL/proconfig는 적용 트랜잭션 마지막에 원값과 비교하며 불일치 시 전체중단한다. 기존service_role claim3 EXEC는 보존한다. claim2 외부 EXEC는 폐쇄를 유지한다.

**기존2인자 owner 직접 호출의 의미 변경:** 이제 현재 전역 token을 읽어 fenced selector를 호출하므로 전역 점유가 없거나 만료면40001이다. 이전 owner가 전역 점유 없이 claim2를 사용하던 테스트·도구는 더 이상 성공하지 않는다. 숨긴 호환성 보정이 아니다. 기존 외부2인자는 이미03000에서 폐쇄되어 있다. 두 overload 모두 review_summary만 선택한다. 기존3인자의 요청 lease가 global보다 길면 global expiry로 줄인다. acquire token/expiresAt 및 job envelope/DTO의 모양은 바꾸지 않는다.

## 신규 RPC

`public.claim_supported_job(p_worker_id uuid,p_lease_seconds integer,p_worker_run_token uuid,p_supported_kinds text[])`

- worker/global은 필수 UUID, seconds는1..86400 기술 상한이다. 운영값을 확정하지 않는다.
- 배열은1차원·1..3개·NULL/중복없음. 허용값은 `review_summary`, `cancellation_safety`, `report_retention`뿐이다. event_sync는 현행 DB kind가 아니다.
- 신규 함수는 service_role JWT role만 허용하되 **EXEC는 service_role을 포함해 폐쇄**한다. PUBLIC/anon/authenticated/authenticator/yumidang_worker_queue 및 privatehelper EXEC도 폐쇄한다. root의 별도 승인 전 활성화하지 않는다.
- 반환 exact1 `{job:null}` 또는 `{job:{jobId,kind,payload,leaseToken,leaseExpiresAt,attempt,failedAttempts}}` exact7. 기존 payload를 그대로 반환하고 개인정보 원문을 추가하지 않는다.
- supportedKinds는 신뢰한 소비자 프로그램의 처리 가능 종류 선언이다. 같은 service credential을 가진 악성 호출자까지 서로 분리하는 인증 기능이 아니다. consumer별 제한이 필요한 배포는 owner-configured principal mapping 등 별도 승인 계약이 필요하다. workerId를 인증된 role로 추정하지 않는다.

## readiness와 점유 원자성

리뷰는 기존 처리 경로를 유지한다. cancellation_safety는 `private.cancellation_due_control.enabled` 및 enqueue/process 두 service EXEC가 모두 준비되어야 선택된다. report_retention은 A 후보 실제 계약 `private.report_purge_control.enabled`와 아래7개 service EXEC가 모두 있어야 한다.

1. enqueue_report_retention_purges(uuid,integer)
2. claim_report_retention_task(uuid,uuid,uuid)
3. check_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid)
4. get_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid)
5. record_report_retention_delete_ack(uuid,uuid,uuid,uuid,uuid,uuid,text)
6. complete_report_retention_task(uuid,uuid,uuid,uuid,uuid,uuid,text)
7. purge_report_retention_terminal_receipts(uuid,integer)

없는 후속 control/function은 준비되지 않음으로 제외한다. 존재하는 control의 SELECT 권한 오류는 false로 삼키지 않는다. A 교정 동결 c5b801c0f31dd8f058aafd844f90b5531cd582c7f668cc6703b0b01b3ce14a91의 실제 함수명/서명과 대조했다. 기존 d2e335 후보의 guardNULL·LOCK권한 preflight·eligible LIMIT 위치는 A가 교정했으며 현재7개 서명은 그대로다. 이후 A 변경은 다시 대조해야 한다. optional control의 SELECT FOR SHARE에 필요한 SELECT와 UPDATE 권한을 적용 preflight에서 모두 검사한다. 이 검사로 권한을 새로 부여하지 않는다. A job payload는 exact `{reportId,closureProofId}`이며 task closureRevision과 혼동하지 않는다. 이 마이그레이션은 job CHECK/payload를 새로 확장하지 않는다. source79 적용이 혼합3kind 회귀의 선행 조건이다.

잠금은 global FOR UPDATE→요청 kind 정렬 순 control SHARE→지원 kind의 due job FOR UPDATE SKIP LOCKED→기존 job/global fence 기록이다. 승인 false 또는 EXEC누락은 queued/retry_wait/만료running을 모두 건너뛰며 상태·attempt·token·fence를 바꾸지 않는다. 선택 이후 DBclock/global과 readiness를 재검사하고 leaseExpiresAt은 min(DBnow+requested,global expiry)이다. 끝에서 현재 job/global fence를 재검사한다. 자동 연장이나 다른 token 승계는 없다. 잠금 대기나 trigger 후 만료면 claim 전체 rollback이다.

같은 지원 집합 안에서 실제 due시각,id 순서로 선택한다. SKIP LOCKED로 다른 점유를 건너뛰고, running 재점유에도 kind조건을 적용한다. 재점유는 새 joblease/fence를 쓰며 옛 lease의 complete는40001이다. unsupported backlog는 조회 실패나 성공으로 꾸미지 않으며 unsupported 행을 fail/delete하지 않는다.

## 후속 J 연결과 공정성

기존 J registry/repository는 이번에 수정하지 않는다. 새 adapter가 이 RPC를 호출하기 전 exact payload/DTO·kind 지원 여부를 구현해야 한다. 구 소비자는 계속 claim3를 사용하면 리뷰만 점유한다. 새 종류의 실행 guard를 열기 전에 이 DB 보완이 먼저 적용되고 실제 혼합 큐 회귀가 통과해야 한다.

040100 schedule은 아직 새2kind를 반환하지 않으며 J runner kinds에도 없다. afterKind/exclude 회전을 실제 DB 지원 종류·readiness와 맞추는 예약 조회 확장은 별도 후속이다. terminal purge7은 완료 증거 상세의30일 실제 정리 책임이므로 EXEC가 없으면 매번 report claim을 막는다. 이는 신규 실행의 기술 준비조건이다. 후속 J report cycle에서 global 획득 후 terminal purge→enqueue→scoped claim→task drain을 연결하거나 별도 승인 maintenance callback과 만료 wake를 실제 구현해야 한다. 정리 호출도 공유20 예산에 포함한다. EXEC7개 준비만으로 dispatch 실행을 증명하지 않는다. 현재 후보의 due,id 순서를 영구 공정성 또는 자동 dispatch 완료로 설명하지 않는다. shared20 실행 예산은 호출자 worker orchestration이 책임지며 claim은 한 작업만 점유한다. 새로운 persistent dispatch metadata는 만들지 않는다.

claim 응답유실/timeout/음수 프로세스 종료는 원격완료 불확실로 journal FAIL을 남기고 자동 재claim/자동정리/추정settle를 하지 않는다. 정확 토큰·현재 점유·세션 종료 증거와 실제 만료 뒤 승인된 복구만 가능하다. Consumer 반환 decoder 실패를 성공/실패 효과로 자동종결하지 않는다.

## 회귀와 실제 검증 상태

새 `tests/database/minkyu/worker_supported_claim.sql`은 source79 이후 빈 scratch 큐에 BEGIN/ROLLBACK로만 실행하도록 작성했다. 합성 job3kind 각각 queued/retry_wait/expiredrunning과 review를 사용한다.

- legacy2/3 NULL 및 review 전용선택, unsupported 원행/fence 불변
- guardfalse·singleton행누락·guardtrue/EXEC없음·terminal7만 폐쇄·한 EXEC만 철회 시 선택제외
- 배열 NULL/빈값/중복/NULL원소/unknown/event/다차원 거절
- existing wire7·failedAttempts·global상한·동일 job 재점유·옛lease40001
- 준비한 report/cancellation만 scoped 점유, 정확 fence와 complete_job3 사용
- 실제 UPDATE trigger가 global을 만료시키면 job/fence/global 변경 전체rollback
- 신규/private ACL 폐쇄·회원 거절·role/tableACL 불변

기존 test 파일은 수정하지 않았다. worker_job_fences의 service3 경로는 새 DTO/fence와 호환할 의도이지만 실제 재실행하지 않았다. 기존owner2 무전역 점유를 기대하는 회귀는 의미변경으로 실패할 수 있으며 root의 기존 전체회귀로 확인해야 한다. 새 합성 테스트는 readiness를 테스트 트랜잭션에서만 열고 전체ROLLBACK한다.

실제 SQL compile/마이그레이션 적용/단독 DB 회귀/기존 전체회귀/두 세션 SKIPLOCKED 및 guard철회/실제 consumer/HTTP/운영은 모두 NOT_RUN이다. 정적 언어·소유권·harness 및 SQL 문장 검토만 완료할 수 있다. 후속 actual 검사에서 함수 OID/owner/ACL/proconfig 기존값, roles/memberships/tableACL·audit·queue/global idle·cron·파일·보호컨테이너 불변을 검증해야 한다. source79 A의 실제 Provider 삭제 안전성과 제재/숨김 목적 정책은 이 selector로 완료되지 않는다.
