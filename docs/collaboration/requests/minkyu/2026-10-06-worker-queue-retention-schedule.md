# 취소·신고 파기 큐 예약 후속 후보

actor minkyu, lane A. source82 이후 신규83 SQL/회귀/계약 후보다. 실제 SQL·DB·Docker·CLI·Provider·J 실행은 NOT_RUN이다. source78~82 및 기존 증거는 변경하지 않았다.

## 순차 통합·실제 결과 갱신

root가 단독으로 통합했고 실제83/84 단일 TX 회귀·전체 롤백 및 로컬 정식84 적용을 통과했다. 실제 fixture의 자동 identity 생성과 기한 순서를 반영해 테스트를 갱신했다. 다음 기한 dedupe 결함은 후속 `20261006021419_cancellation_next_due_generation.sql`로 새 기한의 generation만 증가시켜 수정했다. 기존 원78은 불변이다. runtime budget 모형7개·실제 REST도 통과했고 원 권한으로 복구했다. 영수증과 미완료 범위는 [진행표](../../minkyu-progress.md)를 따른다. 아래 NOT_RUN과 미수정 설명은 최초 동결 후보 당시 기록이다.

## 구현 범위와 기술 계약

기존 public.read_worker_queue_schedule(text[],text)의 exact3 `{serverNow,nextDueAt,nextKind}` 및 실제 인자 p_exclude_kinds/p_after_kind를 유지한다. 기존 review_summary→event_sync→member_cleanup 상대 순서를 유지하고 뒤에 cancellation_safety→report_retention을 추가하는 유한5 회전이다. 기존 제외 입력의 중복 허용은 유지하며 차원·NULL·미승인 값·최대5를 검사한다. 신규 worker kind/event DB CHECK를 이 migration에서 바꾸지 않는다.

cleanup은 원 guard와 서비스 EXEC5, 사진 미완료 동안 Auth 선택 금지를 유지한다. 취소는 supported_worker_kind_ready의 control missing/false와 서비스 EXEC2, 신고는 같은 helper의 control missing/false와 exact EXEC8을 재사용한다. 신규 begin이 닫히면 신고 후보0이다. 조회가 job/status/attempt/fence/승인/점유/원문을 변경하지 않는다. Provider 준비·J routing·실제 승인까지 이 필요조건만으로 증명하지 않는다.

취소 worker job의 queued/retry_wait/running은 원 available_at/lease_expires_at을 사용한다. enqueue 전 cancellation_safety_due.next_due_at도 조회하되 동일 identity/generation payload의 기존 job이 있으면 raw due를 제외한다. 신고는 정확 reportId/closureProofId로 연결된 원 job 및 enqueue 전 적격 resolved report를 선택한다. 기존 report_purge_eligible 전체 prosrc도 migration anchor로 검증하고, 미래 timer 조회를 위해 같은 목적 predicate에서 도래 시각 비교 한 개만 제외한다. 보관90일을 새로 계산하지 않고 원 retention_due_at을 사용한다. hide/검토/이의/살아 있는 제재 목적은 제외한다.

dispatch 존재·정확 ACK 없음인 storage task가 남은 closure의 부모 report job은 예약 후보에서 제외한다. job/task/intent/reservation을 자동 해제·삭제하거나 재claim하지 않는다. ACK가 있으면 원 job 기한 후보가 다시 보일 수 있으나 실제 새 lease 작업은 GET/부재/완료 경로만 가능하며 scheduler가 DELETE를 수행하지 않는다. 지연 DELETE 및 Provider 종료 입증은 별도다.

유효 global 점유가 있으면 선택한 due를 원 expires_at까지 뒤로 보낸다. 기존 read_worker_run_budget의 1..180000ms 계약은 변경하지 않는다. 일일 호출과 큐 실행은 기존 global180초/연장0/공유 내부정리20을 연결해야 한다. 새 일일 DB 횟수·금액 한도를 만들지 않는다. AI 예산 연기는 기존 review available_at 책임이다.

## 정확 변경과 wake

기존 schedule 함수 한 개의 본문만 exact old prosrc와 목적 helper anchor가 일치할 때 교체한다. OID/owner/ACL/proconfig·나머지 함수 본문은 보존한다. privileged canonical owner, gateway/queue owner USAGE/SET 차단, schema/helper EXEC/table SELECT 및 준비 control SHARE 실효 권한을 검사하고 부족하면55000으로 적용 전체를 거절한다. 권한을 추가하지 않는다.

새 statement AFTER INSERT/UPDATE/DELETE 빈 wake trigger15개는 cancellation_safety_due, cancellation_due_control, report_purge_control, member_reports, report_capture_assets, report_purge_tasks, report_purge_dispatches, report_purge_delete_acks, report_purge_terminal_receipts, safety_appeals, appointment_review_holds, safety_incident_report_links, safety_incidents, safety_incident_revisions, safety_sanction_applications에 연결한다. 기존 notify_worker_queue_changed()의 빈 payload를 그대로 사용하며 COMMIT 후 전달된다. 원4 trigger와 Storage trigger는 유지한다. 역할/EXEC 변경은 테이블 trigger가 없으므로 coordinator가 별도 빈 NOTIFY 또는 재접속 wake를 수행해야 한다.

terminal30일 만료는 일반 report job으로 가장하지 않는다. 이번 SQL은 terminal 변경의 빈 wake만 제공하며, 그 expires_at timer와 maintenance dispatch 식별자·J 경로·공유20 실행 연결은 미연결이다. 이 때문에 전체 파기 유지관리 완료로 표시하지 않는다.

## 발견한 기존 기술 결함과 다음 단위

source78 enqueue는 identity:generation dedupe로 ON CONFLICT DO NOTHING하지만 finish_cancellation_due는 next_due_at만 갱신한다. 동일 generation의 succeeded job이 남으면 다음 실제24h due를 새로 실행하지 못할 수 있다. 이 후보는 terminal job도 raw due 중복에서 제외하여 hot loop만 차단한다. 다음 기한 처리가 해결됐다는 의미가 아니며 전체 정상 자동 취소 흐름은 미완료다. root가 별도84 기술 fix로 원24h 정책을 보존하며 generation/queueddeadline 이어가기·원시계 보존·멱등·실제 DB 재현을 검증해야 한다. source78 원본문 수정은 하지 않는다.

공통 internal-client에는 read_worker_run_budget가 없지만 dedicated createMemberCleanupBudgetReader는 이미 exact1·왕복 monotonic 차감·host clock 보수 매핑·AbortSignal을 구현했다. 공통 allowlist/typed port/일일·J 실행 연결은 별도 M/J 작업이다. exact wire `{p_worker_run_token: UUID}`, malformed exact1은 EXTERNAL_UNAVAILABLE, expired/roundtrip exhaustion은 STATE_CONFLICT, 원 권한/DB 오류는 기존 transport 계약으로 처리한다. 자동 acquire/연장/retry0. 새55000 HTTP503을 임의 확정하지 않는다.

J background는 아직 review_summary/event_sync 두 종류만 허용하며 queue runner는 event 외 review endpoint를 사용한다. 신규2 및 기존 cleanup endpoint/지원 kind별 scoped claim/공통 counts와 공유20/75초 HTTP unknown 때 무자동 release·추가 쓰기 금지는 J 후속 연결 요청이다. A는 J 파일을 수정하지 않는다. SQL83 설치만으로 기존 J가 신규 kind를 처리한다고 안내하지 않는다.

## 회귀 후보와 증거 한계

합성 owner fixture를 단일 BEGIN/ROLLBACK에서만 준비한다. 정확 control 행 missing/false/각 EXEC2·8 폐쇄 후보0·자료불변, 원3/신규5 회전·제외·잘못된 인자·회원역할 거절, 미래 신고 due·글로벌 expiry 지연·running 사진→Auth 의존, raw due와 retry/running/succeeded job 중복, unknown intent 원자료 불변·합성 ACK 뒤 후보 재개, statement 빈 wake metadata와 원함수/역할/멤버십/ACL 불변을 검사한다.

ACK와 intent는 owner가 직접 만든 합성 metadata이며 Provider 삭제·실제 durable HTTP 영수증의 증거가 아니다. 실제 LISTEN 수신/COMMIT 대 ROLLBACK의 외부세션 관측, 두 세션 잠금, J/일일 dispatcher, Provider 이름 재사용 및 terminal 유지관리 engine은 NOT_RUN이다. root가 후보 독립 읽기 후 실제 SQL을 별도 승인·실행한다.
