# WBS7.18 실행기 관측 실패 격리

민규 harness private 후보이며 실제 배포·운영 감시·7.18 전체 완료가 아니다. 전체79%(22/28) 유지. 원 저장소/HEAD에는 아직 반영하지 않았다.

queue/completion runner는 report 콜백이 throw하면 own 연결 정리와 재접속 예약 전에 빠져나갔다. 고정 결과 코드6곳에 내부 reportSafely를 적용해 동기 예외·거절Promise·무응답이 실행 흐름을 막지 않도록 했다. 비밀/원오류 재전송이나 보고 재시도는 없다. 정상 TLS/RPC/lease/UNKNOWN/스케줄 계약은 그대로다.

private `/private/tmp/yumidang-observability-gap-audit-20261020/`. 원본12PASS/12FAIL+미처리 rejection → 후보24PASS. 영수증 `reporting-regression-receipt.json` SHA `68cca3e29d71cb8aaf1e292c1e604dca05b7f444d31991ea0345958c6d1dbbd8`; 독립 감사 `/private/tmp/20261020-reporting-isolation-peer-review.json` SHA `d8034d7d9ad26db3a5d5e69320d6c21d132bcdb31ee26f462472c3d489f7672b`. root도 strict unhandled-rejections 모드로24개 PASS를 확인했고 `root-review.json` SHA `6949486c7aac2135bae3b1c0cc0545b211ebe1ebbd64482a2d3108431823b7e3`에 범위를 남겼다. peer는 실제 helper의 throw/reject/then getter throw/never 추가8개 순수 검사도 확인했다. 실제 DB/HTTP/외부 sink0이다.

이 첫 패치는 underlying scheduler.stop/client.end 실패 처리 자체를 해결하지 않았다. 별도 후속 후보 `/private/tmp/yumidang-runner-cleanup-failure-20261020/`를 작성 중이다. scheduler.stop reject/throw 뒤에도 own client.end를1회 시도하고, 실패를 고정 RUNNER_CLEANUP_FAILED로 보존해 자동 재접속/새 dispatch를 막으며 반복 stop에서도 실패를 확인할 수 있게 한다. background rejection을 처리하되 정리 성공으로 숨기지 않는다. never-settled stop의 취소나 종료 성공은 주장하지 않는다. 원24개와 후속 정리 회귀는 같은 최종 소스에서 대조해야 한다.

기본 배포 진입점의 optional metrics/diagnostics sink는 아직 미연결이다. fire-and-forget은 제품 응답 비지연만 보장하며 sink 수명주기·유입 상한·실제 수신·보관/파기를 보장하지 않는다. 새 sink 서비스·비용·경보 숫자·보관 정책을 이번에 고르지 않았다. 운영 heartbeat·알림 도착·실제 복구는 후속 증거로 남는다.

다음 작업: 정리 실패 후속 후보 회귀·독립 검토 → 승인된 Auth/me·121 복원의 source freeze 종료/새 source 검토 후 정식 반영 → 필요한 현재 실행기 통합검증. 관측 회귀를 운영 감시 완료로 집계하지 않는다.

## 후속54 동결과 root 추가 재현

후속 후보는 새 정리30+원 보고24=54개 PASS(173.45525ms)이며 영수증 `/private/tmp/yumidang-runner-cleanup-failure-20261020/cleanup-regression-receipt.json` SHA `1f2d0a134b950ee8ade77e2789562d1b3a2ee7a718b110da494af97fed25339e`다. completion source SHA `8fefb72d817fb3dc66625d70a4efb8f92f8189e9f70218ef16a0a3f50670b336`, queue SHA `87a1caa2e1b19ffd0b23362155ef55f930d8adfd8d0df2d9499ec7a15168f36b`. 이 통과만으로 최종 채택하지 않았다.

root가 completion 초기 list 조회를 보류한 뒤 stop을 요청하고 조회를 해제하자 own end1 뒤 `COMPLETION_SCHEDULER_READY`가 보고됐다. 조건이 `!current.failed`만 확인해 중단/닫힘을 빠뜨린 문제다. 재현 영수증 `/private/tmp/yumidang-completion-stop-ready-probe-20261020/receipt.json` SHA `374bdc3441a5ac187a81114c1079a8cd425b572e7c79b3cf39d7572278fbdba2`. 실제 DB/HTTP0의 현재 candidate factory+합성 Client 재현이며 source 자체를 편집하지 않았다.

54개 동결본은 보존하고 최종 채택을 보류했다. 별도 stop-ready variant에서 종료 뒤 READY0과 원CLI 신호 경로의 cleanup rejection 처리를 검증한다. 회귀 개수를 늘리는 것만으로 이 결함을 닫지 않으며 해당 재현이 실제로 거절되는 결과와 새 소스 핀을 확인해야 한다.

## stop-ready 최종 private variant

별도 variant는 기존54+새20=74개 PASS(497.423833ms). 영수증 `/private/tmp/yumidang-runner-cleanup-failure-20261020/stop-ready-variant/stop-ready-regression-receipt.json` SHA `b023ae79ddf114eeed68ee94052ab5541ab5b3d962bfb044bb6f1cf0550e8208`, 독립 감사 `/private/tmp/20261020-runner-cleanup-stop-ready-peer-review.json` SHA `08ef5007cd1b30664e11da8d219558273b16ee8be05cac2bcbc3f7dc9a032880`. completion은 !failed&&!stopped&&!closed를 확인하며 실제 main signal의 stop rejection을 고정 코드/exit1로 처리한다. 합성pg만 대체한 실제 own Node CLI4개에 부모가 정확PID로 SIGTERM을 보내 정상exit0/실패exit1·end1·READY0·child종료를 확인했다. 실제DB나운영signal시험은 아니다.

root는 영수증 원ref39개 SHA/길이를 검산하고, 원 falseREADY probe의 import경로만 바꿔 READY0/end1/exit0/stderr0을 독립 확인했다. 교정 영수증 `/private/tmp/yumidang-completion-stop-ready-probe-20261020/fixed-variant-receipt.json` SHA `a0d08d660a4e9cf1b819acfb87bc1594c048e7a9f5965eba183042cf0b9d4339`. 원결함/54개 기록은 보존한다.

최종5파일 패치 `/private/tmp/yumidang-runner-final-review-20261020/exact-five.patch` SHA `7c842536e5d75c91334ac5f8e0c44a5738954eeb1e4995a7455f944f4578eb08`는 source2·민규test3만 포함한다. actorM ownership5개와 현재HEAD1d9에서 git apply --check가 통과했다. 실제 적용0/indexempty/commit0/push0이며 Auth/me·121복원의 source freeze와 새 source검토 조건을 먼저 해결한다. 현재신규sink/실제운영감시 미완료는 그대로다.
