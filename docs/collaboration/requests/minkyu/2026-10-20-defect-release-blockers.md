# WBS6.5 미해결 결함·수정 재검증·출시 차단 후보 대장

기준: 한국시간 2026-10-20 00:12 · actor=minkyu · 전용 clone `yumidang-minkyu-wbs-20261017` · HEAD `1d9b46b69adbc52f693accbff04ca4a00d35c547`. 이 문서는 현재 이슈와 증거를 연결하는 대장이다. 전체 44개 작업은 진행 중이며 마지막 명시 프로젝트 기준 79%(22/28)를 유지한다. 문서 작성 중 Docker·SQL·Auth·제품 HTTP 실행, Notion 수정, 커밋·푸시는 하지 않았다.

## 1. 명시 완료기준과 판정 범위

[Notion WBS6.5 원문](https://app.notion.com/p/c22a6def75f883caa733014eb5c55a38)을 이번에 직접 조회했다. 페이지 최종 편집은 `2026-10-14T12:33:23.116Z`, QA 공통 담당은 민규·종현·유미, 우선순위는 P0다. 완료기준은 다음 두 항목이다.

- 미해결 이슈·재현·담당·검증/보류 근거
- 위 조건을 확인한 검증 기록 또는 증빙 링크를 연결한다.

아래 표로 이 정리 범위의 근거를 연결한다. 모든 결함 해결·실회원 검증·운영 배포 성공을 이 Task의 추가 완료조건으로 만들지 않는다. 개별 결함의 수정 완료와 실제 검증 잔여, 출시 판단은 각각 유지한다. Notion의 10/11 점검에 적힌 AI22/23 NOT_RUN 등은 당시 기록이며 [10/18 완료 기록](2026-10-18-plan-completion.md)과 [현재 실제 증거](2026-10-19-runtime-evidence.json)를 함께 읽는다. 원 과거 실패는 바꾸지 않는다. 선행 작업 후보는 6.2·6.3·6.4a다.

## 2. 현재 이슈·담당·우선 조치

P0/P1은 이 대장의 조치 제안이다. 출시 차단 확정·실행 승인·보류 해제를 뜻하지 않는다. 서버 수정/격리 검증은 민규, 앱·FE 소비는 종현, UT 관찰·출시 협업은 유미이며 QA 판정은 공통이다. 실제 파일 편집은 현재 ownership을 따른다.

| ID / 관련 WBS | 원 실패·재현 및 현재 상태 | 수정·회귀·독립 검토 | 실제 검증 잔여·출시 판단 조건 | 담당·우선 조치 |
|---|---|---|---|---|
| D01 사진 proxy / 4.7·6.3 | signal을 무시하는 GET, 무응답 read/cancel/HEAD/HEAD-body-cancel 및 caller abort가 40ms 한도를 넘겨 watchdog 500ms에서 실패했다. 초기 18개 중 5개 실패와 추가 GET 실패를 보존한다. **합성 I/O 결함 재현·수정 완료 범위**다. | Auth·GET·read·cancel·HEAD 전체에 단일 deadline을 적용하고 늦은 결과로 후속 HEAD/바이트 전송을 시작하지 않게 했다. 사진 21개 포함 관련 70개 PASS, strict unhandled rejection·Deno no-remote 검사 PASS(E01). 사진 개별 독립 리뷰 원문은 현재 미연결이며 추정하지 않는다. | 실제 Auth·Storage·native HTTP 통합은 NOT_RUN. 원 JWT/RLS, 2MiB, GET 뒤 HEAD 권한 재검사를 실제 연결에서 확인해야 한다. 70개를 실기기/Storage 완료로 계산하지 않는다. | 민규 서버, 종현 화면 연동. P1: 개별 리뷰 연결 후 새 typed 환경에서 실제 연결 검증을 준비한다. |
| D02 행사 수집 page/cursor / 7.12 | 실제 factory의 page transport에 저장된 numeric cursor가 전달되어 2쪽 이후 거절되었다. 5쪽 yield 후 재개와 cursor/page 불일치도 범위에 포함한다. TourAPI 999쪽에 잔여가 있어도 완료로 처리하던 결함을 별도 RED로 재현했다. **오프라인 제품 경로 수정 완료 범위**다. | collector는 nextPage/cursor 모순을 선행 거절하고 page transport에 page를 전달한다. ongoing opaque cursor는 보존한다. TourAPI는 실제 totalCount를 유지하고 999쪽 뒤 잔여를 PARTIAL/PROVIDER_PAGE_LIMIT로 남기며 1000쪽 transport는 선행 거절한다. 관련 78개 PASS(E02), 독립 읽기 리뷰 차단 finding 없음. | 실제 공급사·DB 실행·운영 일일 수집은 이 회귀에 포함되지 않는다. DB settle은 기존 실패 경로에서 cursor=null로 정리하므로 fixture의 cursor1000 보존을 DB까지 확장하지 않는다(next_page1000은 보존). | 민규. P1: 현재 공급사 조건·정확 대상/보존 guard를 만족하는 실제 수집 증거와 변경 영향을 연결한다. |
| D03 서버 접수 시각 / 4.5·4.6 | 정책167은 마감보다 빠른 서버 접수를 기준으로 한다. 현재 handler는 접수 timestamp 없이 Auth→body→필요한 검사/ticket→RPC로 진행하고, 업무 잠금 뒤 clock_timestamp로 판정한다. **정적 계약 공백 / 실제 실패 미재현**이다. | 코드·SQL 수정 0. 잠금 대기 재현 계획과 ingress 읽기 검토(E03)를 작성했다. statement_timestamp는 같은 DB 명령 이후 잠금 대기만 다루며 이전 HTTP/Auth/검사 지연을 복구하지 못한다. accept_match 내부 선행 expire와 worker의 첫 post 잠금도 별도 관측 대상이다. | 새 합성 자격 fixture·원 Auth·현재121/정확 자원·원178행/권한 보존을 묶어 마감 전 DB 진입/잠금 대기→마감 후 취득을 실제 관측해야 한다. HTTP 접수를 못 입증하면 DB_ENTRY_ONLY로 제한한다. 새 client timestamp/GUC/ACL 우회는 사용하지 않는다. | 민규. **P0 출시 차단 후보**: 실제 재현·정책 충족 경계 판정부터 수행하며 아직 확인된 운영 장애로 단정하지 않는다. |
| D04 상세 권한 검증 fixture / 4.5·6.3 | 오래된 fixture는 비로그인 authorDisplayName을 가명 문자열로 기대했고 첫 신청 messageId가 없었다. 제품 null 계약·필수 입력과 불일치한 **검증기 결함**이다. | `public_post_detail_local.ts`를 익명 null 기대와 crypto.randomUUID messageId로 교정했다. MAX_REQUEST_BYTES=65536을 유지했다. private 초안과 현재 repo 바이트 일치, 구문·오프라인 Deno typecheck PASS(E04). | 수정 스크립트 실제 실행은 NOT_RUN. 옛 hardcoded 대상에 실행하지 않고 fresh typed 대상·원행/권한/예산 보존·정리 계약을 먼저 정식화한다. 이 수정으로 실제 익명 공개 안전성을 새로 PASS 처리하지 않는다. | 민규 검증기, 종현 소비. P1: 현재 fixture로 실제 권한 통합검증을 연결한다. |
| D05 매칭 lifecycle 검증 fixture / 4.5·6.3 | 첫 신청 messageId 누락과 철회 직후 즉시 pending 재신청 기대가 정책167의 최소 1분과 충돌했다. **검증기 결함**이며 제품 정책을 바꾸지 않는다. | 첫 신청 ID를 추가했다. 고정한 새 messageId/본문으로 즉시 STATE_CONFLICT를 확인한 뒤 실제 61초 경과 후 같은 ID/본문 성공을 검사하도록 교정했다. 시계/DB 철회시각 조작·대기 단축·자동 재시도는 없다. 구문·typecheck PASS(E04). | 실제 61초 대기와 성공/거절·동일 ID 의미의 통합 실행은 NOT_RUN. AI용 Auth6 profile을 정상 Naver 가입 자격 fixture로 간주하지 않는다. | 민규. P1: 새 업무 전용 자격 fixture/정확 행차분을 검토한 뒤 실제 실행한다. |
| D06 ICU source DB 복원 / 7.14 | b002는 provider=i·locale=en-US·version153.121인 실제 source를 기존 libc 전용 도구가 DATABASE_LOCALE_UNSUPPORTED로 거절했다. target 생성0, source/기존 metadata 보존·child 종료인 **원 FAIL_CLOSED**를 보존한다(E05). | 별도 6번째 database-locale packet, ICU initdb, 원 lc_* 및 실제 collation version/rules 엄격 비교를 추가했다. 7개 고정 locale 관측 원문을 O_EXCL/0600/fsync/read-pin으로 판정 전에 저장한다. 기존45개에 잘못된 version/rules 원문 보존2개를 더해 47개 PASS(E06), 독립 리뷰 PASS. | 새 b003의 6파일 CAPTURE PASS(E07): source 불변, 1659명령 exit0/childclosed, 최소2084472KiB. **RESTORE는 TARGET_CONFIGURATION_CHANGED로 FAIL_CLOSED**(E08). ICU 수정 후 capture 성공과 전체 restore 성공을 구분한다. 새 HostConfig 차이는 D07로 분리하며 역할/ACL/sequence/UNKNOWN·최종 전체 복원 검증은 미완료다. Storage 원본39개는 별도 미해결이다. | 민규. P0 운영 복구 검증 잔여: b002 재사용 없이 b003 원결과를 연결한다. 원 ICU 실패를 PASS로 바꾸지 않으며 최신 개별 실행 결과는 실제 증거 목록을 따른다. |
| D07 target 시작 뒤 HostConfig / 7.14 | b003는 target을 생성·시작한 뒤 TARGET_CONFIGURATION_CHANGED로 중단했다. 원 Config SHA는 같고 HostConfig에서 OomKillDisable=false→null 변화가 관측되었다. root가 해당 필드만 역치환하면 시작 전 SHA와 일치함을 확인했다. **실제 실행 실패 / Docker 시작 정규화 추정**, 아직 정식 수정·확정 범위 없음. | 소스 수정0, guard 우회0. 원 FAIL_CLOSED/receipt와 사후 inspect를 보존한다(E08). sourceUnchanged·existingMetadataPreserved=true, restore SQL 전송0은 root 확인이다. | target `5149bc31…57bba3`는 이 기록 시점 running 상태로 남았다. 기존 stricttarget 검사를 느슨하게 하거나 수동 중지를 반복하지 않는다. 별도 exact-ID cleanup 계약을 검토 중이며, 정상 종료 영수증 전에는 정리 PASS로 쓰지 않는다. | 민규. P0 검증 환경 차단 후보: 한 필드의 시작 정규화와 실제 변조 거절을 구분하는 재현/회귀 후 새 검증을 설계한다. 원 b003 NO_REPLAY 유지. |


## 3. 원자료와 바이트 식별자

아래 SHA256은 이번 읽기에서 확인했다. private 경로는 이 컴퓨터의 증거 위치이며 저장소 복제만으로 전달되지 않는다. JWT·자격자료·회원 원문은 이 대장에 복사하지 않는다. 회귀 수는 서로 다른 범위이므로 합산 완료율로 사용하지 않는다.

| 근거 | 원자료·SHA256 | 판정 범위 |
|---|---|---|
| E01 사진 | [receipt](/private/tmp/yumidang-profile-deadline-20261019/receipt.json) `23851756a48dd8a5ba9353413f24259f33639a729026a2d79932df195bb17b30`; [원 RED](/private/tmp/yumidang-profile-deadline-20261019/red.stdout) `63a6f9ecfbd5323e2961711de0865bd390bb09c363018f338a2e0efe081a2f5c`; [70개 원결과](/private/tmp/yumidang-profile-deadline-20261019/regression.stdout) `11a71bede8ab2db3bb4c49d31737ee80503bbaa95aac5edd070e5314137b5da6`; [typecheck](/private/tmp/yumidang-profile-deadline-20261019/typecheck-receipt.json) `366503320ba1653000bf639b99f3aa31f3fb29b68ade1a32c5e3893c54709625` | 합성 I/O/구문 검사. source/test SHA는 receipt에 고정. |
| E02 행사 | [receipt](/private/tmp/yumidang-event-pagination-20261019/receipt.json) `3490a1fb87a8dce9f1679439b1c4c903be32e4e4272770630d40c01583d01a7d`; [78개 원결과](/private/tmp/yumidang-event-pagination-20261019/green-regression.log) `5ace046efc14a192d8aaafde42f95310eeb9df16a2a7d162f4aad293af6e1b6b`; [999쪽 RED](/private/tmp/yumidang-event-pagination-20261019/tour-limit-red.log) `3b230c8cfcf93c9096ccbebd24818318375f5c20310c8718580aa71b57956e47` | 실제 factory+합성 fetch. 최초 resume RED 7FAIL/3PASS는 tool output만 있으며 별도 원로그 파일 없음. 독립 리뷰도 tool 메시지이며 별도 receipt로 꾸미지 않는다. |
| E03 접수 시각 | [잠금 재현 계획](/private/tmp/yumidang-deadline-lock-reproduction-20261019.md) `ba548e03caa1ce06da0471818bade7901a4ca705032276d877c581431b0a5221`; [ingress 검토](/private/tmp/yumidang-deadline-ingress-review-20261019.md) `4190081c4e06255c18e9aeb1198da7b49d8e7555e3aa6c29d62cd505db708fe9` | PLAN_ONLY/정적 읽기. 실제 재현·구현 없음. 읽은 소스 SHA·잠금/worker 범위는 문서에 수록. |
| E04 fixture | [상세 검증기](../../../../tests/integration/minkyu/public_post_detail_local.ts) `58febb63cc1aca19726b9fbd8a6bb34a71f975801ba7ed1b25cd9a538be06645`; [매칭 검증기](../../../../tests/integration/minkyu/matching_lifecycle_local.ts) `6925c50e542fd1517164bc3dd06acffafef6350db7bc777b6a6cba82f6848f48`. 원 private 초안은 `/private/tmp/yumidang-current-policy-fixtures-20261019/`의 동명 파일. | root의 Node 구문2건·주차24 이관 검사 영수증은 `/private/tmp/yumidang-week-boundary-evidence-20261019/repository-formalization-receipt.json`, SHA `80c4803bfd4ae6ca14cbc1e8868df8bf43e673a44a4280ec120d03c804ca2c93`에 보존했다. private Deno typecheck 결과는 tool output이며 별도 로그는 미확보다. 실제 fixture 실행 성공 영수증은 아니다. |
| E05 b002 원 실패 | [원 restore-receipt](/private/tmp/yumidang-db121-20261019-a002/restore-execution/restore-receipt.json) `a3400dd74ff7ec9becb5d92e949fb5e48fd43a849b685ab753a48edafc2e6a25`; [당시 capture](/private/tmp/yumidang-db121-20261019-a002/capture-execution/capture-receipt.json) `a3ccf9b749d3ea2d0c70779b89e0b720df5361ac4f5452cf57e5a21d908fd7c8` | 실제 FAIL_CLOSED/target 생성0. 원 packet·예약·실패는 불변, NO_REPLAY. |
| E06 ICU47 | [후속 receipt](/private/tmp/yumidang-db121-icu-20261019/locale-raw-followup-receipt.json) `71f126505b38ec533e589a58e1ad4d391c9a99c315fb77e451cf65ac704fc11d`; core `488fb1b2cad07a0a78fd01aab5fa3273834df8921d755d205be6711a978931b5`; test `77e84024968d034200cdd59affa4030d81cb85a8f1f59d90dd1b6d9d62a8ddda` | 47개 오프라인 회귀·독립 읽기 PASS. 실제 전체 복원 판정은 별도. 원 libc 도구·ICU45·raw 보강 전 소스는 같은 private 폴더에 보존. |
| E07 b003 capture | [새 capture-receipt](/private/tmp/yumidang-db121-20261019-b003/capture-execution/capture-receipt.json) `329e726a8e8f11da08af38b4f71823c75097e75bcd0b314abbeae63f00c98509`; 실행 graph `2945c5c96295b12ca24f9768dd6b1e6266f107571f76c3b061d1caadfe6b7027`; target `5149bc31d50ae33322bfd3e46319f8553cf89db5f575c68baa0742f46257bba3` | 새 capture 실제 PASS. 이후 restore 실패는 E08로 분리해 보존. |
| E08 b003 실제 실패 | [restore-receipt](/private/tmp/yumidang-db121-20261019-b003/restore-execution/restore-receipt.json) `5e8397bbef87fbad37b1a468535939c231ff236c065b3d422b9112e98fd3abcf`; [사후 private inspect](/private/tmp/yumidang-db121-20261019-b003/target-postfailure-inspect-private.json) `f9d01e5a7a7ad69e2cf8c7d160978a29637be69106ba57a0942309ceedcf4e5d` | FAIL_CLOSED/TARGET_CONFIGURATION_CHANGED, activationAllowed=false/fullRestore=false. 남은 target ID는 E07과 동일. 정리 결과는 미확정이며 inspect 원문을 공개 문서에 복사하지 않음. |


## 4. 외부·운영 조건과 출시 후보의 구분

| 조건 | 현재 근거·담당 | 다음 조건 |
|---|---|---|
| 실회원·Naver·실기기 통합 | 실회원 HOLD, 실제 Naver OAuth/실기기 검증 제외. 서버 민규·앱 종현·UT 유미 공동 확인. | 현재 합성 GoTrue/Auth6·SQL seed를 실제 Naver 가입/사진/실회원 자격으로 승격하지 않는다. 사용자 재개·정식 fixture/권한·기기 조건 후 개별 검증. |
| 외부 AI·행사 공급사와 비용 | 공급사 보관 조건/회원 원문 전송 조건·실측 토큰 비용/한도 측정 잔여. 민규 및 PM 협업. | 실제 공급사 조건을 충족한 승인 실행에서만 측정한다. 합성 모델 검색 PASS는 실제 모델 품질/실비용 증거가 아니다. |
| 운영 권한·배포·전체 복구 | 운영 Supabase 접근은 소유자 초대/수락·연결 갱신 필요. Storage39 원본 미확보, 전체 복원·AI24 자연자정·운영 적용은 잔여. | 다른 프로젝트로 대체하거나 source guard/권한을 낮추지 않는다. DB만의 복원 결과를 Storage 포함 전체 재난복구·출시 승인으로 표현하지 않는다. |

전체44개 acceptance의 기능별 범위는 [전체 대장](2026-10-19-minkyu-full-scope.json), 실제 실행 변화는 [증거 목록](2026-10-19-runtime-evidence.json)·[진행 기록](2026-10-19-local-verification-progress.md), 현재 자원/실행 가능 경계는 [환경 인계](2026-10-20-verification-environment-handoff.md)에 연결한다. 새 실패는 원결과·소비 intent·최종 원자료를 보존하고 다른 ID의 새 검증과 구분한다. 담당이 다른 파일은 요청으로 전달하며, 문서 정리 완료를 이유로 개별 출시 후보나 보류를 해제하지 않는다.

## b003 최종 실패·신규 대상 정리

b003 복원은 `TARGET_CONFIGURATION_CHANGED`로 FAIL_CLOSED이며 원영수증 SHA `5e8397bbef87fbad37b1a468535939c231ff236c065b3d422b9112e98fd3abcf`를 보존한다. 원 DB 불변·기존 metadata 보존·childclosed이며 역할/덤프 복원 전송은 시작하지 못했다. 새 target의 Config는 동일하고 HostConfig.OomKillDisable만 false→null로 바뀌었다. 역치환한 전체 HostConfig SHA가 생성 전핀과 일치함을 root와 독립 검토자가 확인했다.

원core/guard를 변경하지 않은 exact-ID 정리 도구를 독립 검토 후 실행했다. target5149bc31…57bba3 한 개 stop1회/재전송0/타stop0/삭제0/재시작0, 원 guard5파일 SHA·daemon·source·기존 metadata 전후 확인과 stop그룹 종료 증거를 저장했다. cleanup SHA `951c242f03763a0c924a12e19621fad6f1689af35ac8c81780742954b8445f6a`, 최소2125208KiB·metadata명령32개 모두exit0/closed다. target은 정지·보존됐으며 원 복원 실패를 PASS로 바꾸지 않는다.

후속은 새target의원관측선저장·명시시작전이만허용하는도구정식화와거절회귀다. 원source/기존자원guard를정규화하지않는다. 정지된b003는원a002baseline밖의새자원이므로, 후속검증은이를명시보호하는새typed계약이나완전히새source가필요하다. 기존intent/packet을재생하거나baseline을자동재설정하지않는다.

## a002 원source4 실제 종료 완료

고정 currentbinding+원baseline/정지b003 델타의18회귀·독립리뷰 뒤 실제53908에서 `PASS_SHUTDOWN_ONLY`를 저장했다. 원 영수증SHA `1f9be22040e99e531ecd1f439843e9eba4931622aac6ae8a47a59e8a94bb71d5`는 `/private/tmp/yumidang-source4-failure-closure-20261020/execution-a002/closure-receipt.json`이다. current121/closed13/합성UNKNOWN2와178개모든행bag/authority/constraints/catalog가seedfinal6c4c와정확일치했고 sequence[41,true]를보존했다. 정확own4만각1회정지·Exit0/OOMfalse/잔여0,타stop0·network/volume삭제0·SQL쓰기0·예산/UNKNOWN삭제0,정지b003와기존metadata보존·자기child종료PASS다. 최소2091616KiB/명령376개모두exit0·closed를확인했다.

실제run은성공한뒤마지막root요약print가반환dict에없는historicalRestoreStatus를읽어KeyError로wrapper exit1이었다. 디스크의save가덧붙인원FAIL표기는그대로존재하며원영수증·종료/보존자료를재확인했다. 표시실패와작업결과를분리하고실제명령을재실행하지않았다. 원b003복원은여전히FAIL_CLOSED다. source4·Auth6·합성정산/UNKNOWN·volume자료를보존하며새source승인/자정/운영완료로확대하지않는다.

다음은/me정상5키/공개DTO·인증거절의읽기전용3파일후보검토와새HEAD/새문맥준비다. 현재후보는private에만있고새실제실행·추가커밋·푸시0이다. 원a002만료token을새Auth문맥에보내만료단독검증으로표시하지않는다.
