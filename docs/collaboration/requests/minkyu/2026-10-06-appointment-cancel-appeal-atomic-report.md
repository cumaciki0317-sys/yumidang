# S21 신고와 취소 이의의 원자 접수 후보

작업자 minkyu/A. 신규 leaf는 `20261005195033_appointment_cancel_appeal_atomic_report.sql`이며 root가 실제 CLI로 생성한 예약 이름을 사용한다. 원76 SQL359a 및 GET8/POST9·원 receipt·기한은 수정하지 않는다. root 최신 ownership/harness에서 A3 PASS이고 실제 SQL/HTTP/CLI/Provider는 NOT_RUN이다.

새 RPC는 `submit_appointment_cancel_appeal_with_report(uuid,uuid,bigint,text[],text,uuid[],boolean)`이다. 인자 순서는 appointmentId,clientRequestId,expectedResultRevision,reasonCodes,description,assetIds,hideTarget이다. HTTP 제안 경로는 `POST /appointments/:id/cancellation-appeals/submit`, body exact6은 clientRequestId,expectedResultRevision,reasonCodes,description,assetIds,hideTarget이다. targetType appointment/targetId path/context offline/reporter는 서버가 도출한다. 기존 신고 허용 사유·설명1..4000·첨부0..5·bool·중복 금지·서버 기존 안전 검증을 재사용한다. actor/time/reportId/identity/episode/판정 입력을 받지 않는다.

응답 exact10은 기존76의 appealId,appointmentId,resultRevision,state,cancelledAt,deadlineAt,receivedAt,resolvedAt,alreadyApplied에 reportId만 추가한다. 최초 성공 reviewing/resolvedAt null/alreadyApplied false, 재시도는 최초 snapshot9+reportId를 보존하고 alreadyApplied true다. expected1..MAXSAFE-1/result expected+1을 유지한다. 현재 해소 상태는 기존 GET8 계약이다.

## 하나의 statement

원 JWT의 source75 session/current active episode 본인 관리 guard→회차/request seed551→fresh guard→원76 AP/result NOWAIT→기존 report의 정렬 capture 잠금→기존76 report/receipt→binding→최종 fresh session/report TTL 순서다. guard는 신규 동행 자격·제재 제한을 요구하지 않는다. 기존 일반 report가 사용한 같은551을 재진입해 서로 다른 독립 포트의 같은 요청 키도 충돌시키며 legacy report/76 키를 새 성공으로 채택하지 않는다.

nested76의 statement_timestamp는 같은 canonical DB command이므로 신뢰 DB 접수 시각 하나다. 잠금 뒤 시간으로 24h 마감을 다시 판정하지 않는다. Edge 최초 도착/모바일 접수 보장은 아니다. report나 binding INSERT의 대기 뒤 세션·episode·TTL은 DB 현재 시각으로 재검사하고 실패하면 모든 부분을 rollback한다.

정렬 사유/정렬 asset UUID와 AP/expected/설명/hide의 SHA256만 신규 표에 기록한다. binding의 두 키는 원76 receipt 복합 PK를 FK CASCADE로 참조한다. report/appeal/AP/설명/경로/응답을 신규 표에 복사하지 않는다. 동일키 다른 full payload는40001이다. 같은 payload replay는 원76 성공 영수증 및 살아 있는 report TTL을 새로 검사한다. 첨부를 재첨부하거나 receipt revision을 현재 결과로 바꾸지 않는다.

## 실패·권한·보관

신고 details/hide/첨부 attached/원76 appeal·result revision/receipt/binding은 한 TX다. 후속 CAS·마감·session·첨부·binding 실패는 모두 원복하며, 사전 준비한 Storage metadata와 uploaded capture는 그대로 남아 수정 후 재시도할 수 있다. 실제 Storage 파일 삭제로 우회하지 않는다. 제재·당도·귀책/직원 판정·최종종결은 추가하지 않는다.

소유자는 effective record_incident_revision owner와 같고 privileged/RLS/schema·75/76/report helper EXEC·필수 read 권한이 부족하거나 gateway가 owner USAGE/SET 가능하면55000이다. 기존 owner/role/grant를 변경하지 않는다. 신규 public RPC는 authenticated 전용, raw binding은 gateway roles 폐쇄/RLS다. 내부 worker/service key와 사용자 시각은 받지 않는다.

binding은 report→76receipt 상세 파기와 함께 지운다. accepted 최소 exempt 결과는 기존 원장 수명과 별도여서 report CASCADE가 제재 효과를 되살리지 않는다. 상세가 살아 있지만 TTL이 만료되면 원 성공도 PT404다. 파기 후 성공한 요청의 식별 tombstone이 없으므로 원문 파기 후 동일키 PT404를 무조건 보장하지 않는다. 기존 최소 exempt/해소·미결 상태에 따라55000 등으로 안전 거절하고 report/appeal 신규 성공0을 유지한다. 새 tombstone 보관 기간이나 재접수 정책을 만들지 않는다.

SQLSTATE는 invalid/deadline22023, foreign/살아 있는 상세 TTL PT404, CAS/fullhash/독립 포트키/NOWAIT/unique40001, session28000, retired/첨부42501, 기존 재신청·회차·미결 관계55000이다. 55000의 HTTP503은 이 문서에서 확정하지 않으며 공통 HTTP 오류 계약과 독립 검토한다. 일반7d anchor/hide90·재신청·종료 회차는 계속 닫혀 있다.

## 회귀와 남은 실제 검증

합성 SQL 회원의 실제 기존 match/cancel/report RPC로 fixture를 준비한다. 신규 statement report+appeal 성공 exact10/원 snapshot replay·fullhash 충돌·타인거절, 정규화 사유 순서 replay, 같은 outer statement의 마감 동일/1µs 이후 실패와 1µs 이전 성공, report/details/첨부/hide가 생성된 뒤 CAS/마감 실패의 전체 원복, uploaded metadata 보존, 정상 첨부 attached/재시도, 독립 신고 키 거절, binding INSERT 이후 session clock 실패의 전체 원복, 자격 누락 관리 허용, 살아 있는 report TTL 거절, 상세 파기 뒤 원 expected CAS40001/현재 expected 최소 exempt55000 분리, 최소 exempt 보존 및 새 접수0, private ACL·역할/membership·guard/worker 불변을 검사하도록 작성했다. ASSERT on 및 전체 ROLLBACK이다.

attachment·expired/accepted/rejected fixture는 owner metadata이며 실제 Storage bytes/직원 handler·90일 engine의 증거가 아니다. 원76 실제 API25/경합12·formal76 증거는 그대로 보존한다. root 실제 단일 TX 검증 뒤 original JWT REST/HTTP exact6→typed7→exact10, 원문 비노출, 실제 사전 첨부 준비·rollback 재사용, 실제 두 세션551/capture/AP/result·session/retirement/incident 순서와 S21 한 번 제출·실패 입력 보존을 별도로 검증해야 한다. accepted/rejected 담당 workflow·취소 연속 재계산·통지/이의·최종종결·모바일/hosted/운영까지 전체 목표는 유지한다.

## 최신 실제 검증

root가 같은 고정 SQL53750fc/testacc206f 후보를 native76에서 단일 TX로 실제 실행했다. 후보 회귀 PASS/checks8 모두true/전체 ROLLBACK/불확실 종료false이며 이력76을 보존했다. 영수증은 `/private/tmp/yumidang-appeal77-candidate-reviewed/receipt.json`, SHA `a9bf3db6c15c43165728502069bf35286b03f5c7d17528a385ee00c6e8343f9c`다. 처음 NOT_RUN 표시는 작성 시점 기록이다.

이후 정식 격리 native76→77 CLI once 적용 및 metadata probe 대조가 PASS였다. 영수증 `/private/tmp/yumidang-native77-rollout-reviewed/application-receipt.json` SHA `1b24b7d643cac797391a39e46f5a533aa2bf7b24962eca881b54b6f84891c799`이며 이력77/대기0이다. 기존 함수·자료·권한·감사288/파일0/guardfalse/workeridle/보호 환경을 보존했다.

실제 로컬 Auth/REST/Storage와 in-process 회원 HTTP API30 그룹도 PASS했다. 결과 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-report-operator-native77-21PaLF/result.json` SHA `dab0d69b4993ee9f77cbbe188e26e3f8380c594e7032a5eab069319a9d9a98b7`, cleanup11/errors0/전체 원복이다. 실제 사전 JPEG 첨부 업로드·CAS 실패 후 uploaded 및 bytes 유지·정상 exact10·replay/fullhash·세션·상세 TTL을 검증했다. 합성 provider binding이며 실제 네이버 OAuth 성공이나 hosted Edge 실행으로 확대하지 않는다.

신규77 두 세션 경합, 직원 accepted/rejected 해소·연속 제재 재계산·취소 전용 통지·최종종결/실제90일 엔진, hosted/mobile/운영 연결은 남아 있다. 일반7일 이의 anchor·hide90 및 법적 보관 미정도 그대로다. 원76/77 SQL·회귀의 고정 바이트는 변경하지 않는다.
