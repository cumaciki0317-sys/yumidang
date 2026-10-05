# 탈퇴 cleanup 5포트의 전역 워커 연결 요청

작성자 minkyu. main 민규 worktree의 현행 소스를 읽은 연결 제안이다. 요청 문서만 수정하며 종현 코드·계약, main/native DB·원본·운영은 변경하지 않았다. 실제 실행·호스팅·외부 삭제 승인·worker ready 증명은 아니다. cleanup5는 아래 전용 RPC 다섯 개를 뜻하며 한 번에 다섯 회원을 삭제한다는 수치가 아니다.

## 현재 파일과 미연결 부분

- M `_shared/auth/member-cleanup.ts`: createMemberCleanupAdapter와 processMemberCleanupTask. Storage exact objectId/name/bucket 조회→삭제200 응답→Ack 기록→본문 부재 재조회, Auth exact user 조회→hard DELETE200 빈 객체→Ack→404를 검사한다. DB fence와 프로세스 시각을 함께 사용하며 전역 점유를 갱신하지 않는다.
- M `_shared/db/repositories/member-cleanup.ts`: createMemberCleanupPorts가 claim_member_cleanup_task/check_member_cleanup_task/get_member_cleanup_delete_ack/record_member_cleanup_delete_ack/complete_member_cleanup_task만 allowlist로 호출한다. 범용 internalClient의 RPC 목록을 cleanup 때문에 넓히지 않는다.
- M migrations20135/20136: 전역 점유 검증, task60초 점유, 같은 탈퇴 건 Storage 완료 후 Auth 허용, 삭제 Ack 재사용, auth/storage 실제 metadata 부재와 모든 작업 완료 후 member_retirements 완료 처리. cleanup guard 및 service_role EXECUTE는 닫혀 있다. 최초 retire_my_account는 guard와5포트 ACL이 준비됐는지 검사하지만 실행기의 실제 생존·예약 계약까지 증명하지 않는다.
- J `_shared/jobs/worker-run.ts`: open(existingToken)은 acquire_worker_run(180,existingToken)으로 기존 토큰을 검증하고 owned=false로 반환한다. 기존 토큰의 close는 전역 lease를 해제하지 않는다. runner가 소유한 토큰은 runner finally에서 release한다.
- J `scheduled-jobs/queue-runner.mjs`와 `_shared/jobs/background.mjs`: 전역180초 토큰 획득→x-worker-run-token 내부 HTTP→finally release, LISTEN yumidang_worker_jobs와 read_worker_queue_schedule(excludeKinds,afterKind) 기반 재개. 현재 허용 종류는 review_summary/event_sync 두 개뿐이며 not_enabled 제외 후 size<2도 하드코딩되어 있다.
- J `scheduled-jobs/index.ts/handler.ts`는 maintenance/daily만 처리하고 cleanup을 호출하지 않는다. review-summary-worker의 모델/안전/개인정보 승인 검사 전에 cleanup을 끼우면 AI 미설정이 회원 삭제를 막는다. completion-runner 전용 계정이나 자동 완료 예약에 삭제 책임을 섞지 않는다.
- read_worker_queue_schedule은 현행 J 연결 요청 계약이다. main 정식 SQL의 실제 함수/전용 계정 ACL/NOTIFY 준비는 이 읽기만으로 확인되지 않았다. 존재하는 runner 파일을 예약 DB 준비 완료로 설명하지 않는다. 사용자 retire HTTP도 현재 서비스 라우트에는 없다.

## 제안하는 좁은 HTTP 포트와 작업 분담

M service-api의 기존 index.ts/handler.ts/routes.ts 책임 안에 `/internal/member-cleanup`을 추가하는 안을 우선 제안한다. requireInternalCaller 뒤에만 전용 ports/adapter를 생성·주입하고 POST `{}`만 받는다. x-worker-run-token은 필수 UUID이며 회원 JWT·위조 내부키·query·body token/한도 입력은 거절한다. 인증된 기존 토큰은 createWorkerRunScope.open(token)과 같은 계약으로 검증·재사용한다. cleanup은5포트만 사용하고 worker scope의 기존 acquire/release 연결과 분리한다. 새 범용 백엔드 폴더·대체 삭제 구현을 만들지 않는다.

J queue-runner.invoke는 세 번째 kind `member_cleanup`을 고정 `/functions/v1/service-api/internal/member-cleanup`으로 보내고 요청 origin/URL을 외부 입력으로 바꾸지 않는다. 기존 INTERNAL_WORKER_SECRET와 토큰 header를 사용한다. J background의 허용 종류/제외 개수/lastKind 교대와 응답 투영을 세 종류 계약으로 일반화해야 한다. J worker-jobs.md 및 tests/functions/jonghyun의 변경은 종현 담당 요청이다. M 소유 RPC·HTTP·adapter·tests/functions/minkyu와 migration은 별도 구현 검토 후 담당 범위에서 반영한다.

cleanup 응답은 existing runner가 검사할 수 있는 정형 `ran`/`not_enabled` 상태와 claimed/succeeded/retryWait/leaseLost 등 집계로 합의한다. adapter의 idle는 claimed0, applied는 실제 complete 성공1이다. Provider/RPC 실패를 succeeded로 세지 않는다. cleanup 대기에는 AI 실패 최대3회 정책을 임의 적용하지 않는다. 설정/ACL/승인 미완료는 실제 거절에 근거한 not_enabled이며 임의0건성공이나 WORKER_QUEUE_READY 근거로 삼지 않는다. taskId·profileId·objectName·tokens·Provider 응답은 외부 응답/로그에 넣지 않는다.

## DB 예약·정기 재개와 다른 종류의 실행 기회

M/J가 read_worker_queue_schedule 계약을 확장해 member_cleanup의 실제 due를 포함해야 한다. pending은 즉시 후보, running은 lease_expires_at 이후, completed는 제외한다. Auth는 해당 withdrawal의 모든 Storage 완료 후에만 후보로 삼고 20136 claim 규칙과 동일하게 계산한다. DB serverNow/global lease 만료를 기준으로 wake를 예약하며 현재 점유로 충돌했을 때 같은 즉시 due를 무한 재조회하지 않는다.

탈퇴 transaction의 cleanup task INSERT, completed 변화/전역 release 등에서 같은 yumidang_worker_jobs 채널에 원문 없는 알림을 보낸다. notification은 빠른 깨우기이고 유일한 증거가 아니다. LISTEN 먼저 복원→due/만료 조회, 재시작 시 누락된 pending/running 재조회, 실제 DB 기한 timer를 통해 알림 누락·프로세스 중단을 복구한다. 별도 cleanup cron이나 두 번째 독립 global lease를 만들지 않는다. 상주 runner 자격증명은 기존 schedule/acquire/release3개만 유지하고 Auth/Storage 관리키·cleanup RPC 직접권한은 주지 않는다.

한 호출의 cleanup 작업 수는 정책14의 내부 정리20건 상한 안에서 제한한다.20건을 성공 보장하거나 매번20건 수행하지 않는다. 한 task 완료/idle/오류마다 남은 실행 시간과 토큰 만료를 검사하며 더 못 하면 보존·양보한다. 세 종류 afterKind/lastKind 교대로 cleanup backlog가 AI/event를 굶기지 않게 한다. not_enabled는 그 drain의 해당 종류만 제외한다. Provider 한 종류 실패가 runner 전체 종료/재접속을 유발하여 다른 작업을 연속 차단하지 않도록 정형 실패 결과·다음 due를 합의한다. 전역 점유180초는 연장하지 않으며 개별task60초도 갱신하지 않는다.

M 어댑터·전용 ports에는 이제 공통 task deadline/AbortSignal이 연결됐다. claim 시작 전부터 최대60초이며 실제 task expiresAt과 신뢰할 수 있는 호출자 deadline 중 이른 시각으로만 줄인다. 같은 취소 신호를5포트와 Provider 요청에 전달하고 삭제 직전 DB fence·마감 재검사를 유지한다. 관련34개 합성 검사는 통과했으며 실제 native56 삭제·완료 실패·60초 후 재점유 복구도 통과했다. 취소 신호는 이미 시작된 외부 삭제나 DB 커밋을 되돌리지 않는다. 실제 runner의 DB 기준 전역 잔여시간 전달은 아직 연결되지 않았다. native 검증기는 owner가 읽은 DB remainingMs를 호출 전 host 시각으로 보수적으로 환산했지만 이것은 운영 runner용 조회 API 구현 증거가 아니다. 단순 raw expiresAt과 host 시각 비교만으로 시계 차이를 해결했다고 설명하지 않는다. 남은 task/global 시간으로 안전하게 끝낼 수 없으면 새 claim을 시작하지 않는 runner 연결과 실제 지연·경계 검증은 계속 필요하다.

## 실패 재시도와 Provider Ack 경계

이미 저장된 Ack가 있으면 재점유된 현재 task/lease/global/objectId를 다시 검증하고 verifyAbsent 후 새 fence의 완료 증거를 만든다. getAck는 기록 당시 lease와 같을 것을 요구하지 않으므로 Ack 저장 후 응답 소실/완료 실패는 새 점유로 복구 가능하다. Storage 메타데이터와 실제 본문을 모두 재조회하며 NoSuchKey의 정확 구조화400/404만 부재로 인정한다. NoSuchBucket·JWT·권한 오류는 성공이 아니다. 같은 이름의 다른 objectId는 삭제하지 않는다. Auth는 해당 withdrawal Storage 완료 이후 exact user만 hard delete한다.

Provider DELETE 성공 후 Ack 저장 전 장애는 별도 공백이다. 응답 소실이나 afterDelete fence 만료로 Ack가 없으면 다음 실행은 단순404만으로 완료하지 않는다. 기존 어댑터는 삭제 전200/exact object를 요구하므로 이 상태를 자동 복구했다고 주장할 수 없다. 무기한 재시도·대체 성공을 만들지 말고 원문 없는 운영 알림/보류를 표시한다. 공개 retire 전에 Provider가 검증 가능한 삭제 영수증/감사 조회를 제공하는지 확인하고 승인된 복구 담당·정확 target 증거 검증 계약을 정해야 한다. 서버의 사전 intent 기록만으로 실제 삭제200 Ack를 대체하지 않는다. 현재5포트에는 이 공백의 복구/재시도 간격/실패 분류 저장 포트가 없으므로 필요 시 M 별도 migration·전용 계약을 검토한다.

일반 transient 실패는 task를 완료로 바꾸지 않고 현재 running lease가 끝난 뒤 재점유한다. 재시도 때 새 전역 토큰·개별 lease를 발급받으며 기존 lease 수명을 늘리지 않는다. 실패를 이유로 같은 token을 재취득해180초를 연장하거나 저장된 expiresAt을 수정하지 않는다. backoff/운영 보류 원장이 없는 현행60초 재점유를 이미 정책 확정 retry 시스템이라고 표현하지 않는다.

## 사용자 retire HTTP 전에 충족할 조건

1. lifecycle20135/cleanup20136 exact 검토·합성 DB 권한 회귀와 HTTP fence 테스트, Storage 실제 blob/Auth 삭제·부재·Ack 재점유 복구, FK 의존/Storage→Auth순서 검증을 마친다.
2. 세 종류 예약 SQL/runner/HTTP 연결, 실제 LISTEN 재접속·누락 알림·서버 재시작·빈/대기/실패 공정성·전역/개별 점유 만료·Provider 지연을 검증한다. AI 모델이 없어도 cleanup이 독립 실행돼야 한다.
3. 삭제 후 Ack 미저장 공백의 승인된 복구 경로·담당·실패 알림과 회원 processing/completed 상태 조회를 준비한다. 즉시 활성 저장소 삭제 완료 정책에 맞는 실제 실행 지연·실패 대응을 확인하며 단순 비공개를 삭제 완료로 표시하지 않는다.
4. 마지막 승인 단계에서만 해당 환경의 좁은5개 service_role EXECUTE와 external_deletion_approved guard를 명시적으로 연다. broad 표권한/anon/authenticated cleanup권한을 열지 않는다. 승인 범위·환경·실제 준비 증거를 남기고 어댑터·runner가 권한이나 guard를 자동 변경하지 않는다. 이 문서는 그 활성화를 승인하거나 실행하지 않는다.
5. M 사용자 라우트는 본인 인증/CSRF·origin/멱등 withdrawalId 검증과 retire 응답을 연결한다. processing은 활성 접근 회수와 정리 접수 상태이며 completed만 실제 모든 작업 완료다. DB의5포트 privilege/guard 조건만으로 실행기 생존을 보장하지 않으므로 준비조건을 별도 검증한다. 사진/Auth 삭제 완료 전 UI에서 완료로 안내하지 않는다.

현재 검증은 파일·계약 읽기와 요청 문서 작성뿐이다. 실행기의 연결 구현, 실제 정기 처리, DB 적용·운영 활성화는 미실행이다. 원문·회원자료·키를 내보내지 않았다. 다른 삭제 배치(보관30100), 안전 최소 identity 원장, 일반 공고/채팅 보관은 cleanup 사진/Auth 대상과 섞지 않는다.

## 실제 검증 범위 갱신

2026-10-05 격리 native56의 실제 탈퇴→사진2개 DELETE→Ack 저장→잘못된 토큰 완료 실패(40001)→실제60초 만료→새 점유 기존 Ack 재사용→사진 재삭제0→Storage 완료 후 Auth 삭제→탈퇴 completed의9개 그룹이 통과했다. 마지막 자료·파일0/guard false/cleanup 권한0/전역 점유 해제를 확인했다. Provider DELETE 응답 유실로 Ack가 전혀 없는 복구, 상주 큐·예약 SQL·LISTEN 재접속·공정성·운영 활성화는 여전히 미검증이다. 이 요청 문서의 과거 정적 검토와 새 실제 검증을 구분한다.


## 2026-10-05 연결 구현 후 현재 계약

앞의 제안과 구분해 현재 구현을 기록한다. M service-api handler와 명시적인 로컬 runtime 옵션에는 POST `/internal/member-cleanup`이 연결됐다. 기본 배포 진입점은 아직 활성화하지 않아404다. 실제 내부키 인증 후 UUID `x-worker-run-token`, query 없음, JSON `{}`만 허용한다. 전역 budget을 한 번 읽는 별도 `read_worker_run_budget` 포트와 기존 cleanup5포트를 사용하며 acquire/release/lease 연장을 수행하지 않는다. 배치는 최대20개, 새 claim 전 최소60초 여유를 요구하고 실패를 성공으로 바꾸지 않는다.

현재 성공 응답은 정확히 `{ "status": "ran", "claimed": 0, "succeeded": 0 }` 형태의 data다. 두 건수는 최상위이며 `counts` 중첩이 없다. M은 `not_enabled`를 임의 성공으로 반환하지 않는다. 현재 J background는 `result.counts?.claimed === 0`만 빈 실행으로 처리하므로 cleanup 응답을 그대로 연결하면 idle 반복 조회가 생길 수 있다. 종류별 응답을 원문 없는 공통 집계로 투영하고 실제 claimed0이면 해당 drain에서 제외해야 한다. retryWait/leaseLost 등의 미구현 집계를 추측해 만들지 않는다.

종현 담당 변경 완료 조건:

- background의 종류 검증과 제외 상한을 세 종류로 확장하고 afterKind 교대를 유지한다.
- queue-runner는 같은 승인 origin의 고정 service-api cleanup 경로로 내부키와 UUID 토큰을 전달한다. 회원 JWT·임의 URL·token body 입력을 허용하지 않는다.
- cleanup의 최상위 claimed/succeeded를 검증하고 기존 review/event 응답과 구분해 투영한다. 실제 idle은 재접속이나 무한 실행 없이 다른 종류의 기회를 유지한다.
- 현재 HTTP timeout 상한75초는 전역180초 배치보다 짧다. owner 전역 점유 해제 전에 취소된 HTTP 작업이 실제로 종료되는 계약을 검증한다. 단순 요청 취소만으로 이미 시작된 외부 삭제나 DB 커밋이 취소됐다고 판단하지 않는다.
- LISTEN 복원 후 재조회, 알림 누락/중단 후 재개, 두 runner 경쟁, 토큰 만료와 세 종류 실행 기회를 실제 DB와 연결해 검증한다.
- event_sync는 현재 DB kind 제약과 claim 경로 및 실제 worker HTTP가 미연결이다. 조회 슬롯을 실제 행사 실행 완료로 표시하지 않는다.

M 예약/budget40100 후보는 정적 검토 중이며 아직 main/native/운영 DB에 적용하지 않았다. cleanup guard와5개 service EXEC가 준비된 경우에만 예약 후보를 노출한다. 이 조건은 실행기 생존을 증명하지 않으므로 J 연결 전 guard/권한을 열지 않는다. 새 함수 권한은 닫혀 있고 전용 LOGIN 계정도 아직 준비되지 않았다. 기존 운영 자동 완료 cron은 대체 실행기가 검증되기 전 중지하지 않는다.
