# J09 탈퇴 실행 예산 조회 대기 마감 — 2026-10-14

전체 **79%(22/28)** 유지. processing/completed·실제 Auth/Storage 삭제·ACK·GET-only 복구 연결 자체는 기존 소스에 있다.10/10의 실제 완료 범위와10/14의 새 signed TLS processing 범위를 구분하며 신규 completed 실제 연결/전체 Storage/화면/자연90일을 완료로 표시하지 않는다.

## 독립 결함과 재현

`drainMemberCleanupTasks`는 readBudget를 직접 await하고 로컬 timer는 명시 maxExecutionMs에서만 시작한다. readBudget가 취소 신호를 무시하면 로컬 마감/호출자 취소 뒤에도 drain이 끝나지 않는다. Root의 합성 budget 재현은 maxExecutionMs5ms와 호출자 취소 각각25ms 관찰에서 readSignal.aborted=true·drain미완료·processTask0이었다. 실제 Auth·DB·Storage는0이다.

source SHA256=`5edffe732319f0ec17b8a12dcf76714761d5ec9564f9519414245cf3ab0354e5`. 비공개 증거 `/private/tmp/yumidang-member-budget-deadline-reproduction-20261014.json`, SHA256=`e5590cb3fdb7cfc5dfadb30cfbcfbeef16a4f5ca72ee88b44a10d93efc099843`. 짧은 관찰은 실제 장애/영구 미완료를 증명하지 않는다.

## 설계와 담당

Root가 `member-lifecycle-service.ts`, 신규 `tests/functions/jonghyun/member-budget-deadline.test.mjs`, 이 문서만 actor=jonghyun으로 단독 수정한다. exact 소유권3개 통과. event_design은 다른 두 J07 파일만 수정하며 교차 편집하지 않는다.

기존 localMs=min(180000, 명시상한 또는180000)을 budget조회부터 적용한다. 명시 옵션이 없을 때도 같은180초 타이머를 시작한다. budget Promise는 readSignal 취소와 경합하고 기존 STATE_CONFLICT로 종료한다. 취소 이전 함수 진입은 허용하지만 취소 이후 새 readBudget/processTask는0이며, 늦은 예산/거절은 새 claim·삭제·ACK·재조회로 연결하지 않는다. 성공/실패/취소에서 listener와 timer를 제거한다. 원 budget 오류는 정상 경로에서 보존한다.

기존 wall/monotonic deadline·DB budget·최소 task60초·최대20개·processTask의 기존 완료 대기/UNKNOWN 보존·원 JWT GET 복구는 변경하지 않는다. 부작용을 수행하는 processTask에 새 자동 재실행이나 임의 완료를 추가하지 않는다. 공통 transport·SQL·180초 DB lease·권한·정책 선택·민규12개·성호 화면은 수정하지 않는다.

검사 중 기존 `tests/functions/minkyu/member_lifecycle_http.test.ts`의 GET405 기대가 승인된 GET-only 원 요청 복구 계약과 어긋남을 확인했다. 현재 source뿐 아니라 HEAD의 변경 전 lifecycle source를 로딩한 검사에서도 같은400≠405가 재현됐다. 해당 파일은 최신 소유권에서 종현이며 exact 검사 통과 후 Root 수정 목록에 추가한다. 원 요청 ID 없는 GET은400, 허용되지 않은 PUT은405로 검사하고 DB/내부 호출0 조건을 유지한다. 제품 GET 복구 동작이나 권한은 변경하지 않는다.

신규 책임 시험은 비협조 budget 로컬 마감/호출자 취소·늦은 정상/거절 후 task0·기본180초 가상 시간 경과·실제 factory의 합성 fetch/JSON 대기·원 budget 오류/리스너 정리를 확인한다. 기존 batch/runtime/HTTP 소비 시험에서 변경 소스의 영향 범위를 확인하고 실제 삭제 PASS로 확대하지 않는다. 실제 검증 도구는 민규 담당 복귀 상태이며 새 실행은 정식 지원이 필요하다. 커밋/푸시/운영 변경0, 미커밋으로 보존한다.

## 구현·검사 결과

Root가 기본/명시 로컬 timer와 budget 읽기 전용 abort-race를 구현했다. 늦은 budget 정상/거절은 원 wait에 소비되며 새 조회·processTask를 시작하지 않는다. 원 budget 오류·task 처리/원장 UNKNOWN·원 JWT GET 복구 계약은 유지했다. 팀 읽기 검토에서도 새 확정 결함은 발견하지 못했다.

첫 Node 통합45개는38 PASS·7 FAIL였다. 신규 fixture6실패는 HttpError의 공개 오류 변환을 생략한 assertion4개와 최소32자 내부 secret 조건을 누락한 조립2개였다. 제품 오류 기준/내부 인증을 완화하지 않고 fixture를 교정했다. 남은 기존1실패는 위 GET405 기대였으며 HEAD source에서도 동일 재현했다. 교정된 신규7개만 재검사해 **7/7 PASS**, 갱신한 기존 HTTP 해당1개만 재검사해 **1/1 PASS**다. 변경 없는 기존37개 PASS와 함께 책임45개를 확인했다. 중간 실패나 재실행 수를 더해 새로운 검증 개수로 계산하지 않는다.

변경 product module의 Deno typecheck는 no-config/no-remote/no-npm/no-lock으로 PASS다. source SHA256=`379286175c77d45848c74b49875d97095aecbb0cb95e00bc8609d60df1f6e7e2`, 신규 시험=`a9cb6050cf7ccfb0b7aeb457ece20a576a304bf3be31445c8baa36bab713b314`, 기존 HTTP 시험=`d19d09fe0201f7dbae8d35a40d6496ef2b156c903c85021216fef93aa6af1b91`.

이번 actual Auth/Storage 삭제·ACK 완료·자연180초/90일 검증은0이다. 기본180초 책임 시험은 가상 시간으로 원 예산의 읽기 종료 경계만 검사했다. 전체 **79%(22/28)** 유지, 후속22개 변경은 종현 전용 branch의 미커밋 상태로 보존하며 원본 공유 clone은 clean이다.
