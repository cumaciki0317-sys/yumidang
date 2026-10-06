# 배정 신고 검토 시작·현재 상태 두 세션 SQL 후보

작업자: minkyu / 하네스 C. 독립 복제본에서 아래 두 파일만 작성했다. 기존 SQL70~73, 담당자 client, HTTP/runtime graph52 및 다른 하네스 파일은 변경하지 않았다.

- `tests/integration/minkyu/assigned_report_review_concurrency_local.py`
- 이 요청 문서

## 상태와 실제 검사

root가 고정632d… 동시성 하네스를 정식 격리 native73에서 실행하여 **실제 두 세션 SQL 11개 사례 PASS**를 확인했다. agent는 DB/API를 실행하지 않았다. root가 승인한 정식 격리 native73 적용 자체는 PASS이며, 아래 고정 자료와 준비본73/runtime52를 offline 읽기 확인했다. DB/HTTP/Provider/CLI 실행은 0이다.

`/private/tmp/yumidang-native73-rollout-format-reviewed/`

| 자료 | SHA256 |
| --- | --- |
| application-receipt.json | ba1c86ef5c36397d2a9bef3f2d8a3fa4647cc0b4df4314448f65ddee1363cf14 |
| preflight.json | ab8ca34d0f8bdc58c984cda09ef5da5751828585ee06d37b332bc01deaf14e52 |
| postflight.json | b706e296e91fd7a64ce7da957238eb7751511cada28df41d3e14553f748ea27e |
| schema-after.json | ac6a98f31fdcfb18cf1e22ae4ee1c5eee93bc819e5c16c78bfb590b3f0877440 |
| apply.py | ce06bb0bd8fca43e397cc10aaaf8aed8159fd2ed21da660c6f7abad9d58c1bc5 |

준비본은 `/private/tmp/yumidang-policy73-reviewed/prepared`다. migration manifest SHA는 `eafbcfd77266fcfdafffb18539c89ce0501f721901b41f4435692942ada2fde9`, edge manifest SHA는 `4a46666ca6666155ffc209af45ef7e8fc05059aa742852276a1b872d5ee8b156`다. 새로운 start SQL은 `c1083e452b284ed66edaa11bb4e075914e6f93ce64ab918a1c266f62ad470b71`, state SQL은 `4c497604f20db4708f65750697fe8bc4f51ea5e1afe6d81d95c2e119a63f0846`이다.

실제 수행한 검사는 Python AST, offline source/영수증 pin 검사, 11개 사례 dispatch, pin 누락·오염 거절, 한국어/영어 확인, 소유권·하네스 검사다. `--self-check`는 `subprocess.run/Popen` 자체를 차단한 상태에서 4개 정식 증거와 전체258 pin, 73개 version을 검증한다. 이것은 SQL 기능·경합 성공 증거가 아니다. 초기 미확정 proof 상태에서 실제 실행 옵션을 넣어도 Docker 연결 전에 `FORMAL73_EXACT_PROOFS_PENDING` exit2가 난 결과를 보존하며, 확정 증거를 받은 이후 실제 실행 옵션으로 다시 실행하지 않았다.

## 명시 실행 경계

향후 root의 순차 START가 필요하다. B 실제 API 검사와 동시에 실행하지 않는다. 시작 인수는 `--native73-approved`, 고정 Docker host `unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock`, container `supabase_db_yumidang-minkyu-drift`, database `postgres`다. 원본 naver-live·운영 DB·다른 컨테이너는 수정하지 않는다. CLI 적용/역할 생성/컨테이너 재시작/Provider/HTTP 요청을 하지 않는다.

정식 영수증 hash와 명시 성공 필드, 정식71→73 version 집합, audit288 보존, 준비본/root source 동일 바이트를 확인한 뒤만 DB에 연결한다. 사용자 인수로 임의 영수증을 받을 수 없다. DB 연결 후 history73, 회원·공고·신고·직원 설정·cleanup task·worker queue의 빈 합성 공간, worker idle, guard false, cleanup5와 budget의 폐쇄 ACL, Storage 실제 files0, 다른 active/열린 TX0을 검사한다. 운영 직원 설정이 아니라 bare Auth 합성 직원과 실제 가입 RPC 합성 회원만 만든다. 신고 ID는 실제 `submit_member_report`의 서버 응답에서 얻는다.

## 11개 사례와 판정

1. 같은 actor/request의 약속 신고 시작: 실제 첫 start를 미커밋 유지하고 두 번째 start의 request advisory 대기를 `pg_blocking_pids`로 관측한다. COMMIT 후 같은 hold/version2, 첫 응답 false·재시도 true, receipt1/hold1/report version2를 요구한다.
2. 같은 report/다른 request: 첫 start가 잠금을 보유할 때 다른 요청은 NOWAIT40001/변경0이다. 첫 COMMIT 뒤 별도 명시 stale-version 호출도40001이다. 자동 재시도하지 않는다. SQL40001을 HTTP409 실제 증거로 부르지 않는다.
3. 승인·배정 철회: 접근 우선/철회 우선 COMMIT, 철회 우선 ROLLBACK 각각 실제 setter와 staff guard의 대기를 관측한다. 철회 COMMIT 후 start/read는42501이며 추가 receipt/hold/version/read audit가 없다. 접근이 먼저 잠갔으면 철회 COMMIT 전에 성공할 수 있다.
4. start의 session 만료: holder는 실제 actor/request advisory와 report UPDATE를 잠근다. start는 **advisory**에서 기다린다. 초기 guard 전에 DB `not_after`를 미리 설정하고 DB clock이 만료를 지난 후 해제한다. 최종28000과 report/hold/예약/결과 전체 rollback을 요구한다. NOWAIT report를 대기 만료 시험으로 오해하지 않는다.
5. state의 session 만료: report UPDATE holder 뒤 getter SHARE 대기를 관측한다. 미리 정한 DB not_after 이후 해제하면28000/read audit0이다. guard가 session SHARE를 잡은 이후 session UPDATE로 만료를 만들지 않는다.
6. 현재 version: 미커밋 start 뒤 state의 report SHARE 대기를 관측한다. COMMIT이면 reviewing2, ROLLBACK이면 received1이며 성공 read audit는1이다. owner 상태를 more_evidence로 바꾼 별도 사례는 current3/과거 receipt2를 구분한다.
7. 보관 만료: 약속·사건 연결 없는 일반 신고만 owner 합성 resolved/종결 시각 fixture로 준비한다. 동일 DB timestamp에서 final_closed_at+2160시간 CHECK를 유지한다. 대기 중 retention_due_at가 지나면PT404/audit0이다. 이 fixture는 실제 신고 종결 workflow 증거가 아니며 실제 사건/이의를 가짜 종결하지 않는다.
8. appointment UPDATE holder: start는 즉시40001이며 report/version/receipt/hold/window/예약·결과 변화가 없다. 실패 뒤 자동 재시도하지 않는다.
9. 완료 우선: 양쪽 실제 수동 완료의 두 번째 confirm을 미커밋 유지하면 start40001이다. 완료 COMMIT 후 완료 기록·양쪽 확인·알림을 검사한다. 이후 별도의 명시 검토는 기존 완료 사실을 지우지 않고 hold를 만든다.
10. 검토 우선: 실제 start의 hold 뒤 두 번째 confirm의 실제 대기를 관측한다. COMMIT이면 기존22023/완료 전 유지, ROLLBACK이면 양쪽 수동 완료가 가능하다. 실제 대기 지점을 기록하며 appointment에서 기다린다고 추정하지 않는다.
11. 회원인 직원의 탈퇴: 진행 확정 약속 없는 별도 직원에 실제 retire RPC를 호출한다. staff session SHARE→retire의 같은 TX session DELETE 대기, retire DELETE 우선→staff guard 대기, retire ROLLBACK 허용을 관측한다. 미커밋 retirement는 observer에게 보이지 않아야 한다. COMMIT 뒤 stale JWT는28000이며 기존 성공 receipt는 보존된다. actor profile lock은 추가하지 않는다.

기한5초, DB deadline 관측8초, barrier5초, metadata statement10초/lock3초/process15초, race statement10초/lock8초/process30초는 합성 검증 기술값이며 서비스 정책·운영 SLA가 아니다. 짧은 기한이 실제 장비에서 초기 guard 전에 만료되면 barrier 미관측으로 FAIL이며 가짜 PASS하지 않는다. root 리뷰 후 필요한 기술 여유를 명시 수정할 수 있지만 자동 retry는 없다.

## 임시 탈퇴 readiness와 정리

탈퇴 사례만 owner TX 안에서 guard 승인과 정확5 RPC EXEC를 준비한다. 실제 회원 retire가 processing을 반환하면 **같은 TX COMMIT 전에** guard false/원래 service ACL로 복원한다. 매 사례 exact proacl/owner와 baseline 비교를 요구한다. provider DELETE·삭제 ACK·task complete는 호출하지 않는다. SQL processing을 탈퇴 완료/실제 사진 삭제로 표시하지 않는다. 다른 세션에 승인 true가 커밋되는 단계가 없다.

UUID/가입 subject/사진 metadata 경로/공고/client request는 생성 전 private700 artifact의600 recovery JSON에 원자 기록한다. 요청 UUID도 기록하므로 서버 reportId 응답 파싱 실패 뒤에도 자신의 자료를 정확 찾을 수 있다. 원문/키/env/SQL stderr 원문을 영수증에 쓰지 않는다. 실제 사진 파일은 만들지 않는다.

모든 종료 경로에서 추적한 두 세션들을 먼저 ROLLBACK/로컬 client 종료한다. 하나의 close 오류가 다른 client 정리를 건너뛰지 않게 한다. 실제 backend PID 및 application namespace가 남으면 fixture cleanup을 하지 않는다. 타 세션 종료/원격 자동 terminate/재시작은 없다. timeout은 `remoteCompletionUncertain=true`, `autoRetry=false`이며 client 종료를 원격 완료로 추정하지 않는다. 확인 불가하면 FAIL/recovery 보존이다.

종결 사례별 자료만 FK 역순으로 삭제하고 원래 bucket은 보존한다. 기존 held-report DELETE trigger를 보존하며 자신의 hold/window/normal completion을 신고 DELETE보다 먼저 정리한다. B 실제 API 시험의 report-first teardown 실패와 원래 FAIL 자료는 별개로 보존하며 이 후보 정리 순서의 실제 성공은 아직 검증하지 않았다. Auth audit는 SQL 합성 호출로 추가된 것으로 추정하여 지우지 않는다. auth.audit_log_entries의 DB 내부 정렬 ID+payload SHA256와288 count를 비교한다. schemas/function owner·body·ACL/table·column·schema·defaultACL/roles·membership/constraints/indexes/triggers/views/types/enums/sequence 정의·ACL/policy OID+식/history/기존 proof/전체 table counts/guard/worker/files/보호 container metadata를 전후 exact 비교한다. sequence last_value는 되감지 않으며 보존했다고 주장하지 않는다. full Docker inspect/env 대신 고정 Name/ID/Running/StartedAt/RestartCount metadata만 읽는다.

고정632d… 코드의 SQL 구문·합성 fixture/FK 호환·동시성과 복원은 아래 root 실제 두 세션 SQL 실행에서 검증했다. 이후 코드 변경이나 다른 환경에서는 이 실행 결과를 그대로 재사용하지 않는다. 하나라도 barrier/SQLSTATE/효과/복원 미확인 또는 원격 불확실이면 전체 PASS가 아니다. 이 작업은 두 세션 SQL 범위이며 hosted Edge/HTTP/직원 credential 검증/첨부 binary/mobile/운영 판정/통지·이의/최종 절차 종결의 완료를 대신하지 않는다.

## 일정 fixture 교정

root 읽기 검토에서 같은 작성자·신청자의 모든 약속을 같은 +3일 구간에 유지하면 다음 accept가 정상 schedule_conflict40001을 내는 결함을 발견했다. 각 실제 생성/확정 약속에 3일 간격의 고유 미래 slot을 배정한다. 완료 사례의 owner 합성 시각 이동도 각각 -3~-1시간, -6~-4시간, -9~-7시간의 고유 2시간 구간으로 나눈다. 이 셋의 종료+24시간은 아직 미래이므로 두 명 수동 확인 사례를 자동 완료 만료 fixture로 바꾸지 않는다. 모집 종료는 시작보다1시간 빠르게 설정하며 하나의 DB anchor CTE를 사용한다. 이 시각 이동은 합성 테스트 전용이고 사용자 정책을 추가하지 않는다.

복원 SQL의 `not_after=null where id=...` 토큰 경계를 확인했다. 생성 SQL에서도 `NULLWHERE`/`NULLAND`/`NULLFROM`과 같은 결합 토큰을 offline 거절한다. 일정 분리/생성 SQL 검사는 DB실행 성공 증거가 아니며 기존 B 실제 실패와 root 복구 자료를 대체하지 않는다.

## 첫 실제 후보 실패와 observer SQL 교정

root가 일정 교정본 d466…을 실행한 첫 결과는 FAIL이다. receipt는 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-review-concurrency73-0n7ylniz/receipt.json`, SHA `2e64b160277578c16451a12655eb106b803335cfb4de05b001ba4012509a84f9`다. same_request fixture 생성 및 report state 읽기 이후 첫 blocked observer가42601을 냈고 실제 경합 PASS는 하나도 기록되지 않았다. cleanup은 PASS이고 전후 전체 fingerprint가 같았으며 remote uncertainty는false였다. 이 실패 자료는 보존한다.

생성 observer의 `pid=123and` 숫자·keyword 결합을 원인으로 진단했다. 두 PID 뒤에 공백을 넣고 숫자 PID로 실제 observer builder를 offline 호출해 토큰 경계를 검사한다. 잠금 판정은 offline 모형이며 실제 두 세션 경합을 증명하지 않는다. query 영수증에 ordinal과 barrier label을 추가하여 다음 실패를 정확히 구분한다. 기존 domain SQL·권한·상태 assertion은 완화하지 않았다. agent DB/API 호출은 여전히0이며 이 교정본의 후속 root 실제 실행 결과는 아래에 별도로 기록한다.

## 교정본 실제 두 세션 SQL 결과

root가 고정 driver `632d9712b80d61f6cd17c2670310a076dbba8f105dda4103a9ba777fce1b6774`를 정식 격리 native73에서 실행했다. terminal60740 exit0, 11개 사례 PASS, 실제 blocking PID barrier17개, session outcome75개다. receipt는 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-review-concurrency73-_in1_rx6/receipt.json`, SHA `885f3b29276f1f462882959752833479ad84ce80191cab2255b4adb3ace94f13`이다. 이 문서 갱신 전에 영수증 SHA/status/11개 사례/17개 barrier/75개 outcome 및 전후 보존 fingerprint 동등을 읽기 확인했다.

cleanupVerified=true, remoteCompletionUncertain=false, 전후 전체 fingerprint는 `4af656f7f58da8bb35dbb2a6e0d0dd8614198a60af2fe380cfe7b29b1a28d1c5`로 같다. 자신의 합성 자료 정리와 전체 catalog/counts/auth audit288 ID+payload/ACL·roles·정책/guard false/worker idle/실제 files0/보호 container/source pins 보존을 확인했다. 외부 삭제 Provider나 Auth API로 cleanup을 수행한 증거가 아니라 SQL 합성 fixture 정리 증거다.

이 결과는 같은 요청 exactly-once, 다른 요청 충돌, 승인·배정 철회 직렬화, session/보관 만료 후 최종 거절·rollback, 현재 version, 약속 NOWAIT, 완료↔hold, 동일 TX session DELETE와 직원 탈퇴 경합의 **두 세션 SQL 범위**다. 실제 Auth 자격증명/API·hosted Edge·Storage binary·모바일·운영자 배정·운영 배포·통지·이의·최종 사건 판정·절차 종결은 이 실행에서 검증하지 않았다. 해당 전체 요구를 완료로 바꾸지 않는다.

첫 d466… 실행의42601 FAIL/receipt `2e64b160277578c16451a12655eb106b803335cfb4de05b001ba4012509a84f9`와 그 cleanup PASS 자료는 계속 보존한다. 이 문서 변경은 고정 driver나 SQL70~73를 수정하지 않는다.


## 명시 source74 판정·정정 분기 후보

정식74 영수증 `/private/tmp/yumidang-native74-rollout-reviewed/application-receipt.json` SHA `5099b62eba44200125c21dc9c642c8630f0b98172ebc13f5d1928a550b132926` 및 preflight/postflight/schema-after/driver, prepared74 SQL74·runtime52를 정확 pin한다. `--source74 --native74-approved`일 때만 새 74 분기를 선택한다. 기본73 함수·사례·proof pins와 기존 실제 증거를 보존하며, 현재74 DB에 기본73 분기를 실행하려 하면 history/source gate가 차단해야 한다. formal74 pins 누락·오염은 fixture 생성 전 거절한다. 승인 플래그만으로 root 실행 허가를 대신하지 않는다.

| 사례 | 잠금/실제 장벽 | 기대 원자 결과 |
| --- | --- | --- |
| 동일 요청 | actor/request advisory | 정확 한 receipt·report 증가·incident revision·hold 증가·당도 기여, 두 번째 alreadyApplied |
| 다른 요청 | account/profile/AP/report UPDATE NOWAIT |40001·부분 효과0, commit 후 새 버전의 명시 correction만 허용 |
| 원 사건 동시 정정 | incident advisory 대기 | 동일 사건·회차, 오래된3버전40001, 명시 invalidation 뒤 제재 재계산 |
| approval 회수 | staff approval SHARE/owner UPDATE 양방향 | 회수 선행42501·원복, 판정 선행 후 회수 commit·이후 denial |
| assignment 회수 | staff assignment SHARE/owner UPDATE 양방향 | 다른 report 권한 승계 없이 위와 같은 직렬화 |
| session 만료 | request advisory 또는 getter report SHARE 대기 | DB 시계 만료 후28000, receipt/hold/원장/read audit0 |
| 보관 만료 | request advisory/getter report SHARE 대기 | 실제 CHECK를 만족하는 owner 합성 기한 만료 후PT404·원장/audit0 |
| 현재 상태 읽기 | report UPDATE→getter SHARE | commit/rollback에 따라 현재 report/hold/incident 버전, 과거 receipt 혼동0 |
| 당사자 탈퇴 | 실제 일반 report 당사자 account/profile/episode UPDATE | 탈퇴 선행 NOWAIT40001, 판정 선행 탈퇴 실제 대기, processing·closed ACL 복원 |
| 직원 탈퇴 | 같은 TX Auth session DELETE↔staff SHARE | session DELETE 선행28000, 판정 선행 실제 DELETE 대기·독립 탈퇴 commit 추정0 |
| AP/hold 경쟁 | AP UPDATE NOWAIT·기존 명시 hold resolver | AP 점유40001·부분 효과0, 실제 hold 변경 뒤 stale 버전40001 |
| 완료 경쟁 | normal 판정 profile/AP 잠금→양쪽 확인 대기 | reviewing/no_show의 실제 완료 거절, normal 해소 후 양쪽 확인의 manual 완료·중복0 |

NOWAIT40001 사례는 실제 대기 장벽으로 집계하지 않는다. 보관 합성 종결은 실제 통지·이의·최종 종결 workflow 증거가 아니다. 판정이 report를 reviewing에 남기고 final_closed_at/retention_due_at를 만들지 않는 것을 성공 사례에서 확인한다. 명시 major 정정은 원 incident/episode를 유지하며 뒤 fixture의 자격을 오염시키지 않도록 이 사건의 실제 invalidation을 별도로 실행한다.

새 FK 정리는 namespace 신고에 연결된 incident만 임시 목록으로 수집하고 다른 report 링크가 있으면 ASSERT로 거절한다. 합성 hold/window/normal completion을 먼저 제거한 다음 판정 receipt→appeal/제재→당도 decisions/incidents→subjects→revision→link→incident를 정확 범위로 삭제한다. 기존 report/약속/회원 정리는 뒤에 실행한다. 원본 DB의 사건이나 최소 identity를 일괄 삭제하지 않는다. timeout은 remoteCompletionUncertain/autoRetry false로 기록하며 tracked 원격 backend 종료가 확인되지 않으면 정리를 진행하지 않는다.

오프라인 source74 검사만 PASS다: formal74 읽기 pin260/history74, 누락·오염 gate denial, 12 dispatch, 생성 SQL 토큰, namespace 및 자식 FK 정리 순서. Python AST/언어 혼입0도 확인했다. subprocess는 offline 검사에서 전부 차단했다. source74의 실제 두 세션 실행·실제 HTTP·Provider·운영 계정·통지/이의·모바일은 NOT_RUN이다. 기존73 actual11 PASS를 74 PASS로 옮겨 기록하지 않는다.


### 실제 실행 전 정리 스키마 교정

B/root 읽기 검토에서 74 후보 `51faa2…`의 `safety_appeals.incident_id` 참조가 canonical21810 DDL에 없는 열임을 확인했다. agent 실제 DB 실행 전에 삭제 조건을 `sanction_id IN (namespace 사건의 safety_sanction_applications.id)`로 교정했다. 후속 migration에도 incident_id 추가가 없고 실제 FK는 sanction_id→application.id다. 이의 원장→제재 원장→subjects/revision/incident의 삭제 순서를 보존하며 없는 열 참조 금지를 offline 생성 SQL 검사에 추가했다. SQL74·client·기존73 사례는 변경하지 않았다. 기존 후보와 정적 발견을 보존하며 실제 두 세션은 계속 NOT_RUN이다.


### source74 실제 SQL 두 세션 결과

Root가 고정 driver `2491794681832072da0760b8aaf28f03a432072e49fc24235ac051ee1ec5d8ea`를 정식 격리 native74에서 실행했다. 영수증 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-review-concurrency74-awpsfmk6/receipt.json` SHA `ec5c571d04221b527c0b64fb4a96dc69b45ffc12e8ee184b1fdecd8076b7aa9a`는 PASS다. 12사례 모두 통과, 실제 차단 장벽16개, 세션 결과123개, cleanupVerified true, remoteCompletionUncertain false를 확인했다. SQLSTATE와 실제 DB 잠금 증거이며 HTTP 상태나 통지 성공으로 확대하지 않는다.

전후 snapshot SHA `cd9363759b7d817567734742e3b6c5502a83862480ddbaa86258ea7baab18274`가 정확히 동일하다. 전체 catalog·table counts·ACL·roles·policies, 기존 Auth audit288 ID/payload SHA `da9021ff46ac743e429ae7b84915ebbf5c996f8066ccd3b52fe9a89c20ac9a37`, guardfalse·workeridle·파일0·보호 컨테이너가 복원됐다. 시퀀스 현재값 복원은 검증 범위가 아니다.

첫 정리 후보 `51faa2…`의 없는 appeal incident_id 열은 실제 실행 전에 독립 읽기에서 발견됐고, 그 발견을 위 교정 절에 보존한다. 정식73의 기존 실제11 PASS·첫42601 실패 보존도 유지한다. source74의 위 실제 SQL 경합 증거는 기존 오프라인12 계획을 대체하는 새 결과이며 과거 NOT_RUN 상태 기록을 삭제하지 않는다. 이 driver 자체의 Auth HTTP/Storage binary/Provider·notice/appeal·모바일·운영 담당자 배정 및 운영 배포 증거는 없다. B의 별도 실제 API 검증은 별도 영수증으로 판단한다.

## source75 본인 통지 두 세션 후보

source73/74 분기와 실제 74의 12개 PASS 영수증은 유지한다. 새 `--source75 --native75-approved` 분기를 추가했으며 이 분기의 실제 실행은 NOT_RUN이다. 기존 Driver/Driver74/Session, source73/74 게이트와 기존 offline 검사 AST가 root의 원 driver와 같음을 확인했다. source75는 별도 subclass로 기존 핵심 코드의 동작을 바꾸지 않는다.

준비75는 `/private/tmp/yumidang-policy75-agent-reviewed/prepared`의 SQL75/runtime52이다. migration manifest `0f3f9a30234349b2837673782655c59ec0af5e2750d9c630de244db59accdb10`, edge manifest `b459d05404f7599cb197028a1ec407872e653e12ca5b87f35a913071a3b314ca`를 고정한다. 정식75 `/private/tmp/yumidang-native75-rollout-reviewed`의 application receipt `bdc4827ba529b26dce01f163edb53fcf01f6022b65a9cdaef3b44ac9a47543f7`, preflight `3e93773b9bdec6c4153140c2b9744637734c87b1f8d944a97e6d7c732c173005`, postflight `d5a009fbab7d522399678804e79c8baa2106f6b7995c1edaf02ec7c0e576382c`, schema-after `857cf946c8641b0ab8ff56d70294741170797122fb7faac942dd122c2d6e0225`, apply driver `029c879902e18159607ddec59f4aa60187e650d21586edef35879a08cd6a2258`를 root가 전달했다. receipt의 실제 PASS/history75/pending0/완료·불확실 상태와 원복 조건도 검사한다. 누락·변조되면 artifact/연결/fixture 전 차단한다. source75 SQL `880e62099cbb2f405da1e9035bcba2bdb0ff19c2f5a4d5222c63586240fbfc6b`와 현재 root/준비본의 모든 SQL 및 runtime52 파일을 대조한다.

| 그룹 | 실제 경합 지점과 판단 |
| --- | --- |
| notice_duplicate | 같은 본인 ACK의 notice UPDATE 대기. commit 시 최초 firstReadAt 동일, rollback 시 단일 새 ACK만 남음 |
| notice_logout_first | auth.sessions parent DELETE를 먼저 잡고 목록/ACK parent SHARE 대기. commit28000, rollback 성공 및 child CASCADE 확인 |
| notice_logout_after | 실제 목록/ACK parent SHARE 후 DELETE 대기. 조회가 자동 ACK를 만들지 않으며 삭제 뒤 재요청28000 |
| notice_child_expiry | naver_sessions child UPDATE 뒤 본인 guard child SHARE 대기. 시작 전에 설정한 auth parent 만료를 DBclock으로 넘긴 뒤28000 |
| notice_ack_session_expiry | notice UPDATE 대기 중 미리 설정한 not_after 만료.28000 및 ACK/모든 사건 효과 불변 |
| notice_ack_retention_expiry | notice UPDATE 또는 report UPDATE 대기 중 합성 TTL 만료. PT404 및 ACK/모든 사건 효과 불변 |
| notice_list_retention_expiry | notice 테이블 ACCESS EXCLUSIVE 뒤 실제 목록 query 대기. TTL 만료 후 빈 페이지 또는 만료 cursor PT404 |
| notice_correction | actual both→author typed 정정 뒤 기존 ACK report SHARE 대기. 새 본인 책임해제 invalidated/decision_corrected만 표시; rollback은 새 통지 없음 |
| notice_report_delete_first | exact report DELETE CASCADE와 목록/ACK. ACK는 report SHARE 대기. MVCC 목록은 row DELETE를 기다리지 않으므로 이 변형을 잠금 barrier로 기록하지 않음 |
| notice_report_delete_after | ACK report SHARE 후 report DELETE 대기. CASCADE로 decision/notice 모두 없어지고 이후 ACK PT404 |
| notice_retire_first | 일반 신고 대상 회원의 실제 retire guard/session 경계와 ACK. commit42501, rollback 성공; 새 가입회차 생성 없음 |
| notice_retire_after | ACK guard/session SHARE 이후 실제 retire 대기. processing 및 세션 회수 확인, 기존 회차 통지/최초읽기는 보존 |

각 사례에는 독립 두 회원과 실제 가입/신고/검토/판정 RPC를 사용한다. major나 탈퇴가 다음 사례의 회원 활동을 막지 않도록 회원을 공유하지 않는다. 임의 notice INSERT로 판정 통지 성공을 대신하지 않는다. bare Auth 직원은 기존 승인·배정 helper로 합성 준비하고 실제 운영 직원을 등록하지 않는다. typed 판정은 서버 party를 사용하며 no_show 사실에서 책임을 추정하지 않는다.

응답은 exact9 및 해당 본인의 noticeId/AP/책임 효과를 검사한다. 실패 시 최초읽기·판정·사건·제재·당도·신고·접근감사를 대조한다. 공개 응답에 report/actor/identity/episode/타인 위반/원문/감점/이의 기한이 들어오면 실패한다. 실제 barrier는 pg_blocking_pids, 열린 holder TX, active waiter의 Lock 상태로 수집하고 단순 지연을 barrier로 계산하지 않는다. 만료는 초기 guard 전에 설정한 미래값과 DBclock만 사용한다.

목록 query-before-TTL 잠금은 materialized result 이후 최종 반환 시점의 별도 barrier가 아니다. 원본 list에 instrumentation을 추가하지 않았다. 최종 목록 TTL 재검사는 root가 실행한75 단일 TX guard hook 회귀 증거와 분리하며 본 드라이버가 그 마지막 경계를 재현했다고 주장하지 않는다.

보관 fixture는 owner가 합성 status='resolved'/final_closed_at/90일 관계 TTL을 구성하여 실제 무결성을 지킨다. 이는 서비스의 모든 절차 종료나 운영 purge gateway 완료 증거가 아니다. 실제 adjudicate는 final close, notice 배송, 이의 시계 등을 추가하지 않는다. report DELETE는 자기 namespace의 FK/CASCADE 검사이고 미종결 운영 사건을 임의 종결하거나 guard/trigger를 끄지 않는다.

새 cleanup은 notice→decision을 먼저 정리하고 source74 incident 자식 정리를 재사용한다. report CASCADE가 이미 지운 link의 incident는 생성 당시 자신의 report에서 확인해 저장한 정확 UUID 집합만 합산한다. 다른 report의 incident link가 있으면 ASSERT로 전체 정리를 거절한다. 기존 appeal의 sanction_id FK, hold/window/normal completion 선행 정리, profile/episode/Auth/Storage metadata 정리 순서를 유지한다. 원문을 journal에 넣지 않으며 다른 namespace를 정리하지 않는다.

retire의 guard/5 service EXEC 준비는 기존 단일 owner TX 패턴으로 임시 구성·원복한다. 외부 삭제를 수행하지 않고 processing을 completed로 만들지 않는다. 이전처럼 전체 catalog/count/정책/ACL/role/기존 audit288 ID+payload/guardfalse/workeridle/파일0/보호 container/active DB session0을 전후 대조한다. remote completion이 불확실하면 자동 재시도와 후속 mutation/정리를 차단하고 journal을 보존한다.

실행한 검사는 subprocess 자체를 막은 `--self-check --source75`, AST, 생성 RPC/cleanup SQL token·canonical appeal FK·namespace cleanup 순서, 준비/정식 source 핀 읽기 대조, 누락 proof 차단 모형 검사다. actual two-session/HTTP/GoTrue logout/Provider 삭제/배송·수신/이의/hosted/mobile/운영 검증은 NOT_RUN이다.

### 독립 읽기에서 발견한 복구 목록 보강

A의 독립 읽기에서 첫 source75 후보 `5db0c870…`의 incident/decision 복구 UUID가 메모리에만 있고 기존 fixture-recovery.json에 없다는 결함을 발견했다. report DELETE CASCADE 후 link가 사라진 상태에서 프로세스가 중단되면 그 journal만으로 incident 목록을 복원할 수 없었다. 실제 실행 전 정적 발견이며 원 발견을 보존한다.

Driver75만 durable journal을 좁게 override하여 기존 fixture/세션/불확실 상태와 noticeIncidents/noticeDecisions를 같은 private600 atomic write·fsync로 기록한다. 최초 판정 뒤 같은 미커밋 세션에서 자기 report의 incident UUID를 읽고 판정 decision UUID와 함께 COMMIT 전 지속화한다. 정정 판정의 decision UUID 및 report 삭제 COMMIT 전에도 지속화한다. rollback된 UUID가 journal에 남아도 namespace 밖 자료를 정리하지 않으며 실제 존재 여부와 자기 report 관계를 확인하는 기존 경계를 유지한다. 다른 actor의 자료나 원문·인증키를 journal에 추가하지 않는다.

오프라인 검사는 자기 report/incident/decision UUID를 disk journal에 기록한 뒤 메모리 목록을 제거해도 report CASCADE 이후 복구에 필요한 UUID가 private600 파일에 남는지 확인했다. 실제 DB DELETE나 프로세스 강제중단을 수행한 검사가 아니라 파일 복구 모형임을 구분한다. source73/74 기존 클래스·게이트·offline 검사 AST 불변과 source75 self-check를 다시 확인했다. 실제 두 세션은 여전히 NOT_RUN이다.

### 실제 source75 두 세션 SQL PASS

root가 고정 driver `8327ec356b1a296f3f323333c94e35e087dcbc585a20fb28f2471713bffc1ff3`를 정식 격리 native75에서 실행했다. 본 문서 작성자는 DB/API를 실행하지 않고 최종 영수증 파일의 정확 해시와 결과를 읽기 확인했다.

- 영수증: `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-review-concurrency75-btnyujwz/receipt.json`
- SHA: `4bdf715b33754ff34175e34caf2e550e65c7ec3ccfef0ddde204b6d4bd67d892`
- source75 전체 12개 그룹 PASS, 실제 blocking 관측 23개, session outcomes 187개
- cleanupVerified=true, remoteCompletionUncertain=false, autoRetry=false, Provider 호출0
- 전후 snapshot SHA 모두 `c497b3c9065b9a7911108e6acfc0a7e8c353308fcf6461f42253259a0e3f8bde`
- 전체 catalog/count/감사/ACL/roles/policies/guard/worker/files/보호 container 복원=true
- 기존 Auth audit288 ID+payload 해시 `da9021ff46ac743e429ae7b84915ebbf5c996f8066ccd3b52fe9a89c20ac9a37` 보존

이는 합성 JWT claims와 Storage metadata를 사용하는 실제 두 세션 SQL 검증이다. GoTrue 실제 로그인/로그아웃 HTTP, OAuth, Auth/Storage Provider 삭제·binary, 모바일·hosted·운영 연결의 검증이 아니다. 공개 HTTP와 배송·수신·이의도 이 영수증의 범위 밖이다. source75 HTTP mock 및 다른 root API 영수증과 섞지 않는다.

목록의 실제 TTL 경합은 query 단계 대기까지만 검증했다. listReturnBoundaryInstrumentation=false이며 반환 직전 TTL 검사는 별도75 단일 TX guard hook 회귀 근거다. 이 23개 barrier가 최종 반환 직전 지연을 재현했다고 설명하지 않는다.

앞의 source75 후보/오프라인 절에 있는 NOT_RUN은 실제 실행 전 상태를 기록한 이력이다. 현재 이 절의 두 세션 SQL 범위는 PASS로 갱신됐다. source73/74 기존 실제 PASS는 그대로 보존한다. 최초 `5db0c870…` journal 누락은 실제 실행 전 독립 읽기에서 발견·교정된 정적 결함이며 실제 DB 실패로 바꾸어 기록하지 않는다. driver 및 SQL/runtime 바이트는 문서 갱신에서 수정하지 않았다.

## source76 취소 이의 접수 경합 후보

2026-10-06 민규 C 후보는 기존 source73·74·75 분기와 source75 복구 journal을 보존하고 `--source76` 분기를 추가했다. 비교한 기존 Driver/Session/gate/self-check 10개 AST는 동일하다. 이 변경의 검증은 오프라인 검사만이며 실제 DB·HTTP·Provider 호출은 하지 않았다. source76 단일 TX 후보의 실제 PASS는 root가 제공한 영수증 SHA `a1c048c47d40bc13afe80d0674f80575c7f8ddb9c0305f7e7cb70250580183db`와 구분한다. 정식 DB는 아직75이고 준비76·정식76 증거는 미확정이다.

미래 정식 경로는 `/private/tmp/yumidang-native76-rollout-reviewed`, 준비 경로는 `/private/tmp/yumidang-policy76-agent-reviewed/prepared`이다. manifest·edge·정식 실행 driver SHA와 정식 영수증/preflight/postflight/schema proof 핀 및 기대 필드는 비워 두었다. 그 상태에서 `FORMAL76_EXACT_PROOFS_PENDING`으로 Docker 연결과 fixture 생성 전에 차단한다. 정식 증거 경로를 호출자가 바꾸거나 이전75 증거를76으로 채택하지 않는다. 고정 SQL76 SHA는 `359a8093c3a32bf7d547a17df98173de677307933780a8e78db323bc4c26fcd8`이다.

| 후보 그룹 | 확인할 실제 동작 |
| --- | --- |
| 중복 요청/CAS | 같은 AP 동시 NOWAIT 거절 뒤 같은 요청 재시도는 원 스냅샷과 단일 효과, payload/CAS 충돌 원자 롤백 |
| 다른 AP의 같은 요청 | 같은 회차/request PK 대기 후 먼저 커밋하면40001, 먼저 롤백하면 다른 AP만 접수 |
| logout 먼저 | Auth parent DELETE 대기 후 커밋은28000, 롤백은 정상 GET/POST |
| 본인 관리 조회/접수 먼저 | parent SHARE 뒤 logout DELETE가 기다리고 후속 stale 세션 거절 |
| child 대기 중 만료 | Naver child 대기 후 DB clock의 session 만료를 재검사 |
| receipt 대기 중 만료 | receipt table 잠금 뒤 final session guard가 전체 접수 롤백 |
| 신뢰 DB 접수 시각 | 일치하는 합성 원 취소 사실을 사용해 deadline 전 statement가 대기 후 종료되어도 원 receivedAt 사용 |
| report 삭제 먼저 | report NOWAIT40001은 blocking 관측으로 세지 않으며 삭제 커밋 뒤 PT404/효과0 |
| 접수 먼저/report 삭제 | report 잠금 대기 뒤 reviewing 이의가 있으면55000으로 삭제 거절; 접수 롤백이면 삭제 가능 |
| report TTL 대기 | owner 합성 TTL metadata가 대기 중 만료되면 PT404/효과0 |
| 실제 탈퇴 먼저 | 같은 TX retirement guard/session 삭제와 본인 GET/POST 직렬화, 커밋 거절/롤백 허용 |
| 본인 관리 먼저/탈퇴 | 공유 guard 때문에 탈퇴가 대기하고 이후 processing만 반환, 상세 임의 삭제나 completed 표시 없음 |

deadline 시험은 실제24시간 경과 시험이 아니다. DB에서 실제 취소를 만든 뒤 취소 시각과 원 own_cancel revision을 일치시킨 합성 clock 경계 시험 후보다. report TTL도 owner negative fixture이며 실제 절차 종결이나90일 파기 엔진의 증거가 아니다. source76의 기존 reportId 참조 접수는 신고 생성과 이의 접수의 단일 사용자 제출 원자성을 증명하지 않는다. S21 atomic report+appeal 후속 계약은 별도다.

복구 journal은 본인이 만든 AP/report/원 회차와 서버가 반환한 appeal ID를 mode600 파일로 fsync한다. 취소 전 AP를 기록하며 접수 중 응답 유실에도 AP·회차 범위로 자기 자료를 식별한다. reviewing report 삭제 guard를 끄지 않고 자기 receipt→cancellation appeal→AP 결과 revision/head 순서로 정리한 뒤 기존 namespace 정리를 실행한다. 원격 완료가 불확실하면 자동 정리·재실행을 금지하는 기존 경계를 유지한다. 원 신고 본문을 복사하거나 다른 namespace의 자료를 정리하지 않는다.

오프라인 `--source76 --self-check` PASS: 미래 proof 미확정 차단, 12개 dispatch, 생성 SQL 숫자/키워드 경계, child-first·회차 범위 정리, 메모리 목록 제거 후 disk 복구 ID와600 권한을 확인했다. subprocess는 검사 동안 전부 차단했다. 실제 두 세션 잠금·접수 시각·Auth API·HTTP·Provider·운영 검증은 **NOT_RUN**이다. 기존 source75 실제12PASS와 정적 journal 결함 발견 기록은 변경하지 않았다.

### 정식76 핀 반영 및 오프라인 재검사

root 정식76 적용 PASS를 읽어 확인하고 이전 미확정 후보 driver `a4248b4f805bfd50bfb42879d716591b3ace26aa0567b39f40448b2ab8eb9c82`와 문서 `2cdd00216e6d60d2a5cc72f3551d0f0d84a1501f0d607069114b34127315e618`를 `/private/tmp/yumidang-source76-pending-proof-backup`에 보존했다. 앞 단락의 미확정 상태는 이 반영 이전 후보의 기록이다.

정식 `/private/tmp/yumidang-native76-rollout-reviewed`의 exact SHA를 고정했다.

- application-receipt.json: `69c7dcf942a9de44669db19a398629b6e628a6d2bdc544a7f1db75d4222d32b9`
- preflight.json: `49bc84cba04a595177e860bebf6b452a5d94677c0b315772bdc2b978095c738b`
- postflight.json: `85ba674099ef61121bf1d42264d683ca6ed4f0d1ee1c870602e1cace430c8198`
- schema-after.json: `d42429bbef889c2e5c23d3eafcf31add980f634983ba72ebfeca28fdcd0f9cb7`
- apply.py: `689931b35bccca14958ef392109fd6184a923b893b0523cb84f28ffcfc89e0f1`

준비76 manifest `501144f17a46a8442d35ff24375c3f9c8ba941d9fb789f5b0adc21dc15a48621`, edge `a22e2b20306de8eff3340e2c46c8ede3bda108c9fdf4516c509f693f286cd126`를 고정했다. gate는 history76/pending0/applicationCompleted true/unknown false, SQL76 exact hash, 새 함수4·표1·열10·제약12·index2·trigger1, 기존 metadata/Auth감사288/파일0/guard false/worker idle/보호 컨테이너 보존 기대값을 검사한다. 준비 artifact와 root 현재 SQL76/runtime52도 전체 바이트를 대조한다.

오프라인 재검사 PASS: 264개 source/proof 핀, history76, proof 누락과 변조의 fixture 이전 거절, 12개 dispatch와 disk journal 검증. 검사 중 subprocess는 차단했다. 이 재검사는 정식 적용 증거를 읽은 검사이며 C 실제 DB·API 실행은0이다. source76 실제 두 세션/HTTP/접수 시각 경합·90일 엔진·S21 원자 제출 검증은 여전히 **NOT_RUN**이다. 기존73·74·75 AST와 과거 검증 증거는 보존했다.

### source76 원격 불확실 시 자동 쓰기 정리 차단

root 검토에 따라 Driver76에만 `cleanup()` 경계를 추가했다. 이미 remote_uncertain이거나 자기 세션 종료/rollback 중 불확실로 전환되거나 종료 확인이 실패하면, journal과 FAIL을 보존하고 `SOURCE76_REMOTE_COMPLETION_UNCERTAIN_NO_MUTATIVE_CLEANUP`으로 종료한다. 이때 자기 PID 종료가 확인될 수 있다는 이유로 fixture DELETE를 자동 실행하지 않는다. 다른 namespace나 개발 테스트 휴대폰 계정도 삭제하지 않는다. 해당3개 실패 경로에서는 inherited mutative cleanup과 DB 호출에 도달하지 않는 오프라인 검사를 추가했다.

정상 세션 종료 경로는 기존 PID/namespace/다른 활성 TX 검사와 정확한 자기 fixture 정리를 그대로 호출한다. 원73·74·75 cleanup은 변경하지 않았다. 정상 inherited cleanup 호출1회와 불확실 경로 호출0회 검사 PASS이며, 이는 모형 세션/함수 경계 검사로 실제 원격 종료나 실제 DB 정리 증거가 아니다. 정식76 핀264개 및 기존10 AST 보존 검사도 재통과했다. C DB/API 실행은0이고 실제76 경합은 **NOT_RUN**이다.

## source77 S21 원자 신고·취소 이의 경합 후보

C는 기존 source73·74·75·76 Driver/Session/gate/self-check 13개 AST를 보존하고 `--source77` 분기를 추가했다. 신규12개 그룹은 실제 DB 실행 전 후보이며 **NOT_RUN**이다. 기존75 실제12PASS와76 원격 불확실 시 자동 쓰기 차단을 변경하지 않았다.

root 정식77 영수증을 읽기 확인하고 다음 exact 핀을 고정했다. 경로는 `/private/tmp/yumidang-native77-rollout-reviewed`이다.

- application-receipt.json: `1b24b7d643cac797391a39e46f5a533aa2bf7b24962eca881b54b6f84891c799`
- preflight.json: `d3fbf7a5ca56b8e7f738469aa6ffea411bdd2f2a362acd8b34291e75c0f3af5b`
- postflight.json: `e57f493f359b0cd4f4a20809d5f7335cc571a1539a87b015d8e23462ae75cdf9`
- schema-after.json: `75144f0b37bcfd29796f60cae1e5a2c18743ef7a8d0e944b257c4aeb3c609a03`
- apply.py: `63def4cfee23670d7995953d9c24de40f94545f52b059af101c9c54090b2b577`

준비 `/private/tmp/yumidang-policy77-agent-reviewed/prepared` manifest `501bc9a741a6c64a6ebf7c5a5bd77aebb93dc7fb99b7a2d1b2eff444e3e04ee8`, edge `e9ee9553ad57abe350aa0b1bc982446b79b062d9f1554e865ed7365e865b654e`, SQL `53750fc93d7edf48ff863807ccfa267c3e759213d55385b3d0d28103ec71f745`를 고정했다. gate는 history77/pending0/scope/native76→77/원metadata 보존/감사288/파일0/guard false/worker idle/신규 함수1·표1·열3·제약3·index1·trigger0를 검사하고, 핀 누락·변조 시 fixture 이전 거절한다.

| 신규 그룹 | 실제 두 세션 후보의 판정 기준 |
| --- | --- |
| 같은 원자 요청 | 동일551 잠금 대기 후 커밋은 원receipt replay/단일효과, 롤백은 두 번째 최초 성공 |
| 기존 독립 신고 포트 | 기존 submit_member_report의551 대기 후 커밋은40001로 원자 성공 채택 금지, 롤백이면 원자 접수 가능 |
| 다른 AP의 같은 키 | 동일 회차·키551 대기 뒤 다른 payload는40001이며 두 번째 AP는 부분 변화0 |
| AP/result 선점 | 각각의 NOWAIT40001, report/첨부/receipt/binding 변화0; blocking으로 세지 않음 |
| 첨부 정렬 대기 | 입력 역순이어도 최소UUID 첨부 잠금에서 대기하고, 순서만 바뀐 재시도는 원receipt |
| 첨부 취소 | 실제 cancel_report_capture 선점 후 커밋은40001/부분접수0, 롤백이면 성공 |
| 첨부 metadata 변경 | 첨부 잠금 후 잘못된 MIME/확장 조합이 커밋되면22023, uploaded 상태 유지 |
| 551 대기 중 세션 만료 | 초기 session SHARE 뒤551 대기, DB clock 만료 후28000/전체 원복 |
| statement 접수 마감 | 원 취소 사실과 원 revision이 일치하는 합성 시각을 설정하고 첨부 대기 뒤 deadline 경과해도 최초 DB statement 시각 보존 |
| report 삭제와 replay | replay가 report를 선점하면 삭제 대기 뒤55000, owner rejected negative fixture의 삭제가 먼저면 NOWAIT40001·CASCADE 뒤 재생성0 |
| logout/탈퇴 양순서 | 실제 Auth parent DELETE 또는 retirement와 원자 접수의 공유 guard 직렬화, stale denial/processing/원binding 유지 |
| binding INSERT 후 세션 만료 | binding 표 SHARE는 조회를 허용하고 ROW EXCLUSIVE INSERT만 대기시켜, 신규 report/appeal 이후 final session 실패를 전체 롤백 |

binding 대기는 ACCESS EXCLUSIVE 조회 차단과 구분한다. 마지막 그룹은 SHARE 표 잠금으로 SELECT를 통과시키고 INSERT를 실제 대기시키는 후보다. 실제 관측이 없으므로 해당 잠금 위치가 입증됐다고 기록하지 않는다. `statement` 마감도 실제24시간 대기나 Edge 최초 도착을 증명하지 않고 합성 취소시각과 실제 DB 시계/statement를 비교하는 후보다. report 삭제 negative fixture는 실제 운영 판정·90일 엔진의 증거가 아니다.

첨부는 자기 owner/episode의 reserve/confirm RPC와 합성 Storage metadata만 사용한다. binary 파일을 업로드하거나 Provider를 호출하지 않는다. 실패 후 uploaded metadata 존속과 성공 시 attached만 검사한다. journal은 원자 request를 dispatch 전에 reportRequests에 등록하고 자기 AP/회차/첨부UUID/정확 path를600 파일에 지속화한다. 응답 유실 시에도 reporter+request 범위로 자기 report를 식별할 수 있으며 불확실 상태에서 자동 복구 쓰기는 하지 않는다.

정상 cleanup은 첨부 audit→capture row→자기 report-evidence metadata→76 receipt/appeal→report/AP 결과 순서다. receipt FK CASCADE가77 binding을 정리하며 reviewing 삭제 guard는 끄지 않는다. 기존 전체 catalog/권한/role/정책/Auth감사288/전체개수/파일0/보호컨테이너/활성TX 복원 판정과 uncertainty FAIL을 유지한다.

오프라인 self-check PASS: 266개 source/proof 핀, history77, 누락·변조 거절,12 dispatch, 생성SQL 숫자 token/문자열 밖 괄호, 첨부 FK 정리 순서, disk journal600/복구 ID, inherited uncertain 쓰기 차단. 최초 모형 journal 검사에서 세션 name 누락 AttributeError가 있었고 모형 세션에 name을 명시한 뒤 재통과했다. 실제 DB/HTTP/Provider/원 binary/운영 검증은0이다.
