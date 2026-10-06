# 신고 최종 종결 자료 파기 후보

상태: SQL·DB 회귀 후보 작성 중. 실제 SQL/Storage/CLI/API 검증 NOT_RUN. source78과 기존 함수 본문은 변경하지 않는다. 민규 A 소유 신규 3파일만 작성한다.

## 목적과 보관 경계

기존 `member_reports.status='resolved'`, `final_closed_at`, `retention_due_at=final_closed_at+2160 hours`가 모두 유효하고 현재 보관 기한이 지난 신고만 대상으로 한다. 새 종결 권한이나 일반 이의 7일 기준은 생성하지 않는다. `closureProofId`는 해당 행의 review_version·종결/기한·첨부 목록 hash를 캡처한 기술 snapshot UUID이며 최종종결 업무 권한을 증명하지 않는다.

reviewing hold/이의, 현재 reviewing 사건, 숨김 요청이 있는 신고와 제재 application이 하나라도 연결된 신고는 보류한다. 종료 제재라도 별도 증거 목적과 최종 이의 종료가 입증되지 않았으므로 보수적으로 보류한다. 숨김 자료 파기 후 숨김 유지/해제는 사용자 미답변이므로 이 후보에서 선택하지 않는다. 제재 상세의 별도 종료+90일 파기와 최종종결 직원 권한은 미구현이다.

신고 원문·캡처·상세 access audit와 신고 목적 decision/notice/appeal/receipt는 기존 FK 파기 관계를 따른다. report_capture_assets의 report FK RESTRICT 때문에 파일 부재 증명 후 캡처 행부터 삭제한다. 기존 no_show hold의 nullable report FK SET NULL, accepted exempt 등 최소 약속 결과 및 제재 원사건 시계는 삭제하지 않는다. 기존 report 삭제 trigger의 보류 조건을 우회하지 않는다.

## 닫힌 DB 인터페이스

`private.report_purge_control.enabled=false` 기본값이며 모든 새 public/private RPC·새 표의 PUBLIC/anon/authenticated/service_role/authenticator/worker_queue 권한은 닫힌다. owner의 기존 권한이 부족하거나 gateway가 owner로 USAGE/SET 가능하면 권한 추가 없이 55000으로 migration을 거절한다.

- `enqueue_report_retention_purges(p_global_token uuid,p_limit integer default20)` → `{enqueued}`. 범위 1..20.
- `claim_report_retention_task(p_job_id uuid,p_job_lease_token uuid,p_global_token uuid)` → task exact12 또는 null.
- `check_report_retention_task`, `get_report_retention_delete_ack` → 공통 typed6.
- `record_report_retention_delete_ack` → typed6 + `p_ack_sha256 text`.
- `complete_report_retention_task` → typed6 + `p_evidence_sha256 text`.
- `purge_report_retention_terminal_receipts(p_global_token uuid,p_limit integer default20)` → `{purged}`. 만료된 작업 완료 증거만 삭제한다.

공통 typed6 인자 순서는 taskId/taskLeaseToken/jobId/jobLeaseToken/globalToken/objectId이며 모두 uuid다. metadata task만 objectId=null이다. storage task의 정확 객체 UUID를 변경하거나 null로 넣으면 40001이다.

claim/check exact12: `{taskId,taskLeaseToken,taskExpiresAt,reportId,closureRevision,kind,assetId,bucketId,objectName,objectId,retentionDueAt,closureProofId}`. `kind='storage_object'`는 asset/object/bucket/name 모두 nonnull, `report_metadata`는 모두 null이다. ACK exact5: `{receiptId,taskId,assetId,objectId,ackSha256}`. complete exact3: `{taskId,status:'completed',alreadyApplied}`.

job kind는 `report_retention`, payload exact `{reportId,closureProofId}`다. report revision만으로 다른 snapshot을 혼동하지 않도록 기술 proof UUID에 고정한다. C의 새 `claim_supported_job(uuid,integer,uuid,text[])`에 supportedKinds=['report_retention']를 쓰는 실제 연결이 선행되어야 한다. legacy claim_job2/3는 신고 작업 점유 경로가 아니다. 회귀의 owner 직접 job/fence 합성은 scoped claim 동작이나 J 실행 증거가 아니다.

전역→job→report→목적 safety 표 SHARE NOWAIT→정확 assets UUID 순→task 잠금을 사용한다. 목적 표에 새 제재/이의가 동시에 추가되면 파기 전체가 40001로 rollback된다. task는 기존 기술 상한 60초와 job/global 실제 만료 중 가장 빠른 값으로 제한하고 연장하지 않는다. 각 check/ACK/complete는 현재 DB 시계로 fence·closure·객체 ID/이름 재사용을 재검사한다.

## Storage 증거와 이름 재사용

canonical report-evidence는 JPEG/PNG/WebP 최대 5242880 bytes(5MiB), 확장자/MIME 일치 및 양의 정수 size다. 프로필 JPEG/2MiB 기준으로 유효 신고를 제외하지 않는다. SQL 파기는 MIME 변환이나 prefix 삭제를 수행하지 않는다.

정확 bucket/name 예약은 Storage objects INSERT/UPDATE와 advisory lock으로 직렬화하고 객체 metadata와 예약 행을 파기 전 고정한다. 같은 name의 다른 ID, 기존 객체 rename, 아직 보류 중인 report/task 직접 삭제는 거절한다. 예약은 lease 만료나 DELETE 응답 손실로 풀리지 않는다. 최종 파일 부재와 유효 ACK를 모두 확인한 뒤 신고 파기와 함께 예약을 삭제한다.

이 DB trigger가 실제 Storage backend의 in-flight upload/DELETE 이름 재사용 위험까지 해결했다는 증거는 아직 없다. 실제 provider pin과 기존 upload 실행 순서, 예약 전 시작한 업로드 및 lease 만료/응답 소실을 검증하기 전 guard/서비스 EXEC를 개방하지 않는다. 사전 info/check 성공을 물리 삭제 증거로 바꾸지 않는다.

B 어댑터는 exact info/object UUID/name/bucket 확인→check→단일 exact DELETE 성공→현재 fence로 durable ACK→인증된 info/GET 부재→check를 제공할 예정이다. 첫 유효 ACK를 보존하며 재점유 시 같은 immutable task/object ACK를 재사용한다. ACK 없는 404나 owner metadata DELETE는 실제 삭제 증거가 아니다. DELETE 응답 손실 또는 ACK 기록 전 장애는 terminal unknown 실패와 private journal 보존으로 처리하며 자동 추가 삭제/정리를 하지 않는다.

## metadata 완료 응답 손실과 작업 30일

PLAN/정책의 기존 작업 상세 30일을 근거로 경로·원문 없는 terminal receipt를 둔다. metadata 파기, 기존 complete_job3, 원 completedAt의 terminal INSERT를 같은 TX에서 완료한다. task/report/proof/job UUID·원 task/job lease UUID·evidence hash·completedAt/정확 +720h만 남기고 신고 내용/이름/제재/사용자 설명을 복사하지 않는다.

같은 complete 요청의 재조회는 새 유효 global 점유, job succeeded·원 completedAt·exact payload, 원 task/job lease와 evidence 일치를 확인하고 read-only alreadyApplied=true를 반환한다. expired running task의 쓰기 fence를 부활시키지 않는다. 최초 응답 유실은 FAIL 증거로 유지하며 후속 복구는 별도 증거다. 원 global 만료나 잘못된 lease/hash는 40001, terminal 30일 만료는 PT404다. 만료 행은 purge RPC로 실제 삭제한다. 삭제 후 과거 성공을 영구 재생하거나 상세를 재생성하지 않는다.

터미널 파기 RPC/J 예약 연결과 실제 30일 엔진 통합은 NOT_RUN이다. worker job 자체의 기존 상세 파기 책임도 이 후보가 완성됐다고 주장하지 않는다. 새 영구 tombstone 기간은 도입하지 않는다.

## 오류와 검증 범위

42501 worker role 거절, 22023 잘못 limit/형식, 40001 현재 fence/객체/closure 충돌·NOWAIT, 55000 비활성/업무 보류/파일 부재 또는 ACK 미증명, PT404 terminal 증거 만료다. SQLSTATE의 HTTP 매핑은 여기서 임의 확정하지 않는다.

회귀는 닫힌 권한/guard, PNG·WebP 5MiB metadata, 숨김 보류, reopen/closure 변화, 이름 예약, 잘못 fence/lease 및 만료 재점유, 첫 ACK 보존, ACK 없는 완료 거절, metadata 삭제 실패 전체 rollback, child-first 파기, 원 completedAt terminal replay/30일 만료 파기 및 기존 함수 metadata 불변을 확인할 예정이다. 합성 owner metadata DELETE와 hash만 사용하므로 실제 Storage bytes 삭제·Provider 성공·두 세션·보관 worker·운영종결/일반이의 증거가 아니다.

다음 실제 검증은 root가 fixed source를 검토한 후 격리 DB 단일 TX rollback으로 수행한다. 실제 provider 검증은 exact 합성 객체만 사용하고 새 scoped claim, reservation/in-flight 안전, unknown 종료 journal, 원 최소 결과·제재 시계·상세 삭제 및 최종 모든 자료 복원을 별도 확인해야 한다. SQL/Provider 검증 전 PASS 또는 파기 준비 완료로 보고하지 않는다.

## 첫 독립 검토 보완

초기 d2e33504 SQL 동결 사본은 별도 private 검사 폴더에 보존한다. control 행 부재에서 SQL NULL이 통과하는 guard를 모두 `IS DISTINCT FROM TRUE`로 교정했다. false와 행 부재는 55000으로 거절하며 정확 존재 task의 check/getACK/recordACK도 회귀로 검사한다. terminal receipt→job 읽기 잠금은 각각 SHARE NOWAIT와 55P03→40001 변환으로 무기한 대기를 피한다. 전역 점유를 먼저 검증하는 순서는 유지한다. 실제 SQL/경합 검증은 여전히 NOT_RUN이다.

ACK 및 완료 증거는 같은 hash만 멱등 재생하며 다른 hash는 원 값을 바꾸지 않고 40001로 거절한다. safety 목적 표의 SHARE NOWAIT에는 해당 owner의 SELECT 외 UPDATE/DELETE/TRUNCATE 중 하나도 선행검사한다. 부족 권한을 추가하지 않으며 migration을 55000으로 닫는다.

보류 자료가 앞쪽 LIMIT을 계속 소비해 유효 자료를 굶기지 않도록 enqueue SELECT의 LIMIT 전에 eligible predicate를 적용하고 잠금 확보 후 다시 검사한다. terminal 파기 7번째 RPC 준비·J 유지보수 예약은 실제 활성화 선행조건이며 기존 6개 Storage 처리 RPC만 준비된 상태를 전체 30일 파기 연결 완료로 보지 않는다. 현재는 모든 7개 실행 권한과 guard가 닫혀 있다.
