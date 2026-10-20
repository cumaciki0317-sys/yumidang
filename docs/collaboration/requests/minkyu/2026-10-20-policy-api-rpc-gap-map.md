# WBS4.2 최신 정책·API/RPC·DTO 차이 검토 및 담당 연결

2026-10-20 · actor=minkyu · 전용 clone `yumidang-minkyu-wbs-20261017` · HEAD `1d9b46b69adbc52f693accbff04ca4a00d35c547` · 정식 migration121개 기준.

이 문서는 정책→현행 API/RPC·DTO→파일 담당→기존 검증·정적 차이·실제 미검증·외부 조건의 대응 목록이다. 사전 HEAD ownership 검사1경로를 통과했고 이 신규 문서만 작성했다. 제품·SQL·테스트·계약·다른 문서 수정0, 신규 테스트/DB/Docker/Auth/HTTP/외부 호출0, Notion 쓰기·커밋·푸시0이다.

## Task 원문과 검토의 종료 기준

[WBS4.2](https://app.notion.com/p/8e9a6def75f882848e5c019c7cad8c1b)를 읽기 재조회했다. 원 페이지 최종 편집은2026-10-14T12:30:13.481Z다. 완료기준은 ‘RPC/응답/정책 갭 및 담당별 연결 목록’과 ‘위 조건의 검증 기록 또는 증빙 링크 연결’이다. 과거 실행자·증빙은 보존하고 backend/AI는 민규, 앱·서비스 소비는 종현의 현재 역할을 적용한다.

따라서 이 검토 Task는 모든 제품 결함 수정·실회원·운영 배포를 완료해야 끝나는 Task가 아니다. 아래 확인된 갭을 없앴다고 주장하지 않으며, 각 후속 WBS·담당·실행 조건으로 연결한다. 파일 manifest는 이 의미별 대응표를 대신하지 않는다.

## 읽기 기준과 snapshot 한계

[manifest-v2](2026-10-19-source-manifest-v2.json)는 캡처시각 `2026-10-19T14:58:45.562495+00:00`의 파일 inventory다. SHA `d52bede2b4f6eadd13ed8f87d52427c6ef9c4f530b756ef9bef0f9118380a3ce`,121 migration·187함수·417검증·29local tools·26계약, 총780항목이며 private adapter/credentials는 포함하지 않는다. 미커밋 검토 파일을 포함하며 실행 승인 또는 제품 성공 판정이 아니다.

이번 읽기 비교의 missing은 0개, 캡처 이후 바이트 차이는 `tests/database/minkyu/test_database_restore_preparation.py`, `tools/local/prepare_database_restore.py`다. 이 후속 수정 경로를 manifest의 과거 원자료에 덮어쓰지 않는다. 실행 직전 snapshot/정확한 실행 pin은 root의 별도 검토 대상이다. manifest의 b003 NOT_RUN은 캡처시점 표기이며 이후 실행 상태가 아니다. root가 후속 b003 실패와 별도cleanupPASS를 전달했으나 이 문서에서 해당 원영수증을 재검산하지 않았다. 실패와 정리를 합쳐 복원PASS로 바꾸지 않는다.

증거 표기는 다음을 구분한다.

- **기존 실제**: 기록된 대상·source·실제 DB/Auth/Storage/HTTP의 해당 범위만 보존한다.
- **모형/정적**: 제품 함수를 쓰더라도 가상 포트/단순 source 대조이며 실제 통합PASS가 아니다.
- **정적 갭**: 정책·계약·현재 호출 사이 확인한 차이다. 실제 재현 실패와 별개다.
- **실제 NOT_RUN/미확인**: 구현 부재와 같지 않다. 현재 환경/권한/실행 원증거가 부족한 범위다.
- **HOLD/외부 조건**: 사용자·공급사·운영 조건을 유지하며 목록에서 제외하거나 임의 확정하지 않는다.

공통 근거는 [최신 acceptance 갭과 후속 해소](2026-10-19-current-acceptance-gaps.md), [10/19 실제 증거](2026-10-19-runtime-evidence.json), [10/18 실제 증거](2026-10-18-runtime-evidence.json), [10/14 종현 최종 인계](../jonghyun/2026-10-14-minkyu-final-handoff.md)다. mutable 실행 기록의 이전 NOT_RUN·진행 표기는 뒤의 명시된 후속 결과와 함께 읽는다.

## 정책→API/RPC/DTO→책임·근거·후속 대응

아래 HTTP는 별도 표기 외 `/functions/v1/service-api` 기준이다. 실제 회원 JWT를 일반 사용자 경로에 사용하고 userId/역할·완료 상태를 본문에서 권한으로 받지 않는 경계가 기준이다. 서버 파일 수정은 민규(M), 앱/API/세션/화면 소비는 종현(J)이며 공동 QA도 파일별 단독 owner를 유지한다.

| ID·정책/WBS | 현행 API/RPC·주요 DTO | 현재 구현·증거/차이 | 담당 연결과 다음 조건 |
|---|---|---|---|
| A01 가입·계정 · 정책2 · 4.3 | signup prefix의 POST `/naver/start`·`/naver/callback`, GET `/state`, POST `/complete`; resolve/record/complete Naver RPC. callback session은 accessToken/refreshToken/expiresIn/tokenType만, 생일/원Naver토큰 비반환 | 기존 합성 자격·사진·회차 SQL/실제 로컬 Auth 증거는 존재. 새Auth6 발급 성공은 실제 Naver 여성/성인·필수정보 전체 가입 성공의 대체가 아님 | M `signup/`·공통auth/DB, J 실제 callback·저장·복귀 소비. 4.3/6.2의 실제 Naver/회원 검증HOLD와 구분. [signup계약][signup] |
| A02 본인·공개 프로필 · 정책2/3 · 4.8·LEGACY-ME | GET `/me`→`get_my_profile()` 무인자, 본인5키 userId/realName/avatarUrl/bio/sweetness. GET `/profiles/:id`→`get_public_profile`, 공개성향·관계별 마스킹·완료횟수. `/me/traits`와 `/me/preferences`는 별도DTO | 본인 전용RPC 구현과 앱 exact5필드 decoder 존재. 과거 실제 own200·익명/위조401·당도/공개값 검증 보존. 현재 `/me` 실제 만료세션과5키/공개DTO 분리의 직접 증거 연결은 남음. AI의Auth거절/RPC0 증거로 대신하지 않음 | M profiles repository/SQL·회귀근거 연결, J MemberService.profile. 서버me 응답을 공개프로필DTO로 교체하지 않음. [core계약][core] |
| A03 사진·권한 회수 · 정책3/13 · 4.7·6.3 | GET `/profile-images/:path`, 원 사용자JWT의 authenticated Storage GET→최종권한 재확인 HEAD,2MiB상한. avatar RPC는 snake_case1행 배열 | 현 deadline은 Auth body·GET/read/cancel/HEAD 전체를 bounded 처리. 사진21 포함 관련70모형PASS. 과거 실제 Storage/RLS·사진교체/탈퇴 증거 보존. 이번 deadline의 실제 Auth/Storage/native 통합은 NOT_RUN | M profile-image-http/DB 권한, J 경로·로딩/실패/회수 UI. 기존 한도·권한을 완화하지 않고 새 deadline 영향만 후속 검증. [사진갭][gaps] |
| A04 공고 검색·개인정보 · 정책3/4/9 · 4.4·5.2 | GET `/posts`→`search_public_posts_v2('2026-10-05',region,filters,cursor,limit)`.9키 공개카드, 익명authorDisplayName=null, 반개기간·19~99 범위/전체별도 | a002 실제 현재검색SQL9그룹·rollback178보존 PASS와 runChat→RPC 주차/기간24모형, 실제 Auth/factory 카드·재조회로5.2 명시범위 완료근거 연결. 비검색 필드/정확한 주소를 카드에 포함하지 않음 | M search-http/repository·SQL·AI, J 공개카드/필터/로그인가드. DB 검색과 실제모델 품질은 별도. [검색완료근거][search-acceptance] |
| A05 공고작성·관리/상세 · 정책3/4 · 4.4 | POST `/posts`·`/:id/update`→create/update_service_post, expectedUpdatedAt 원정밀도. close/delete/reopen. GET `/posts/:id`→get_service_post; 확정 관계만 privateDetails/participantNames | 무료전용·16분류/길이·소유권/조건버전·취소후권한회수 구현과 기존 실제 근거 존재. 구형 fixture의 익명별칭 기대·messageId누락은 최소교정/Node구문PASS로 후속해소. 새실제 통합 실행은 남음 | M 입력/SQL/검증기, J 최신입력·충돌/서버오류 소비. 구형fixture 수정이 실제CRUD검증 완료는 아님. [후속갭][gaps] |
| A06 첫메시지·기존방·읽음 · 정책5 · 4.5 | POST `/posts/:id/requests`의 messageId/message→3인자 request_service_post. 전송은 messageId/content. list_conversations_with_read_state·mark_conversation_messages_read, batch최대100 | 원자생성·멱등·기존방/읽음경쟁의 기존 실제PASS 보존. hidden-message SQL `20261010030000_hidden_message_read_receipts.sql`은 현재121 source에 포함. 파일 존재와 운영대상 실제적용은 별개. fixture의 재신청1분 경계도 후속 최소교정됐으며 새실행은 아님 | M matching/conversations/SQL, J 동일 재시도ID·자기 readAt·숨김후읽음 UI. 운영DB에 이 SQL이 적용됐다고 단정하지 않음. [서비스계약][service] |
| A07 최종동의·변경 마감 · 정책5-2/5-3·167행 · 4.5 | propose/accept_match의 conditionVersion; schedule-change propose/accept/decline/withdraw의 changeId/conditionVersion 및 조회버전. 만료는6시간·관련 시작의최솟값 | 동일시각 거절/기존 버전·철회/수락 경쟁의 기존PASS 보존. **서버접수시각 vs 잠금후clock_timestamp** 정적갭은 lifecycle wrapper에도 남음. 실제 새재현0 | M private 판정/만료helper·새scratch 재현, J 기존오류/버전 소비. 공개RPC시그니처·client timestamp·GUC우회 추가 없이 마감전진입/잠금대기/worker선행을 분리할 것. 세부는 아래G01 |
| A08 완료·후기·당도 · 정책7 · 4.6 | confirm_appointment_completion, get/submit_appointment_review, get_public_profile_reviews(completedCount). 실제완료+7일·양쪽즉시·분쟁보류/재개, sweetness0~100 | 기존 SQL·실제 Edge 당도/숨김/정정·전용실행기 근거 보존. 후기제출도 잠금후시각판정 갭. 수동확인·실제완료·후기공개·당도·완료횟수 시점을 같은 것으로 취급하지 않음 | M completion/review SQL·runner, J snake_case1행/상태·마감 UI. 운영자동완료/Railway/TLS·cron전환은7.1/7.2 별도. [완료계약][completion] |
| A09 신고·차단·숨김 · 정책6/상단보류 · 4.7·6.3 | `/reports`, `/report-captures`와confirm/cancel, 본인reports/blocks, `/profiles/:id/block`·unblock. 서버 hidden-targets 조회/해제 경로는 별도 | 실제 캡처 bytes·담당ACL/회수·감사·신고보존의 기존근거 존재. RemoteMemberScreens:432/542의 hideTarget:false는 현재 정책의 **숨김제공 보류에 부합**. 서버RPC가 있다고 앱숨김을 성공 제공중으로 쓰지 않음 | M reports/Storage·보존·ACL, J 제출/자기내역·보류UI. hidden 기능을 임의활성화하거나false를 곧바로제품결함으로판정하지 않음. [신고계약][reports] |
| A10 제재·통지·이의 · 정책2-3/6-3 · 4.7 | `/me/safety`4키·`/me/sanctions`12키·decision/cancellation notices·appeal RPC, 본인identity/회차·revision 결합 | 서버 제한/일반·취소 이의/담당판정·통지 관련 SQL/native 근거는 기록별로 존재. 미확인 전달시각/NULL마감·운영업무전체·앱S21 소비를 코드만으로완료확정하지 않음 | M 보고/제재/권한·사유 최소DTO, J 통지읽기·이의·기간/사유 표시. 원문/신고자/타사건 공개0·NULL마감 추정금지. 일반신고실무 담당은 기존미정 유지. [제재계약][sanctions] |
| A11 탈퇴·재가입·삭제복구 · 정책2-3/13 · 4.7 | 명시옵션의 POST/GET `/me/retirement` withdrawalId와retire_my_account·원영수증GET. 정확 DELETE/ACK·UNKNOWN·reconcile | J09의 합성회원 실제 Auth/사진삭제·ACK유실뒤completed복구와 DELETE응답불명UNKNOWN보존 근거 존재. 일반staleJWT 활동권한복구와 영수증GET은 다름. default entrypoint의retirement/cleanup옵션은 자동설치되지 않음 | M guard/삭제증거/현재운영준비, J 원탈퇴ID 유지·GET-only processing복구·재가입새회차 소비. 실회원·운영·외부AI사본/백업전부삭제 완료 아님. [최종인계][handoff] |
| A12 내용검사ticket · 정책6-4 · 4.2/4.4/6.3 | `/content-inspections`·confirm, get/confirm_my_content_inspection_ticket, 쓰기 시 x-content-operation-id/x-content-inspection-ticket. digest/user/action/target/version/expiry/consumed 묶음 | 서버의 승인된 contentInspection옵션·readiness 설치 시 write client가 ticket을필수소비. MemberService의첫메시지/공고/후기/성향 전송에는 해당취득·확인·header전달소비가없음. **enabled경로의정적연결갭**. 기본entrypoint가옵션미설치이므로 모든현재쓰기항상실패라는주장은금지 | M 검사endpoint/DB/gate·오류계약, J signup·MemberService 검사/오탐확인·같은operation재시도 연결. issuer ACL/gate를완화해통과시키지않음. 세부G02 |
| A13 AI조건·설명·0건/실패 · 정책9 · 5.2/5.3 | ai-chat의 clientRequestId/messages/currentFilters→runChat→허용검색RPC. results/no_results/unavailable·공개카드/근거설명 | a002 실제 Auth/HTTP/RPC+합성모델4case, 과거정상no_results a922,31제품회귀와 기간모형·SQL9를결합해명시범위완료. unavailable실패0건을정상0건으로계산하지않음 | M AI/공개DTO·입출력최소화, J 정형상태·재시도·일반탐색복귀. 실제공급사/실회원품질·외부전송승인은별도. [검색완료근거][search-acceptance] |
| A14 AI한도·다계정·철회 · 정책9/14 · 5.4a·5.5·5.1 | acquire/finish_ai_chat_request·reserve_ai_chat_account_model·settle_ai_account_budget, `/me/ai-processing/withdraw` kind. 회원KST20회/동시1·계정별320만/전체합계·UNKNOWN | 실제 로컬Auth·AI22/23·거절시예약/모델0·usage UNKNOWN보존 기존근거 존재. 실제KST자정AI24·공급사보고usage/원장·청구단위·운영키활성화는분리. 문서의오래된50%는M2문서반영/J USERFLOW요청연결 | M 서버예산/fence/한도·공급사조건, J 상태·철회·계정설정소비. 회원원문HOLD·추가결제금지,기존계정ID와역할배정분리. [예산문서동기화][budget-sync] |
| A15 후기요약 · 정책7-3 · 5.7 | review-summary-worker→source/checkpoint/publish·revision/lease/worker token, 적격원문3개미만insufficient, 공개300자 | 실제121 DB/RPC·합성모델경쟁8+부족6 기록상PASS. 현재4path=코드11+.gitkeep2 동일,전체194 의존성미재검증·원private바이트현재미확보. 현재0/14로되돌리지않음 | M 요약/근거fence·증거대응, J 보일때현재공개적격성/철회숨김소비. 외부사본삭제이행/공급사품질을이14PASS로표현하지않음. [14사례대응][summary14] |
| A16 행사·공식순위·수집 · 정책8 · 4.4·7.8/9/12 | GET `/events`·filters·`/:id`, list_public_events/list_event_filter_values 및 내부upsert_events·KOPIS snapshot. 기간/정렬·불투명cursor·최소DTO | J01 실제Auth→DB→HTTP→SDK의 필터/정렬/페이지근거 존재. KOPIS/TourAPI page/cursor·999상한partial 결함 수정78모형PASS는 실제공급사수집/DB/앱일치PASS아님. 서울HTTPS·KOPIS기간/동률근거보류 유지 | M provider/저장/일일재개·서버회귀, J 현재목록/필터·상세소비. 공식기간·개별공급사·진행중갱신·중단재개/표시대조는해당WBS에남김. [현재진행][progress] |
| A17 작업·보관/운영관측 · 정책13/14 · 7.1/2/13/18 | 내부인증/전용역할의 lease·revision·queue/journal·삭제ACK, completion-runner·queue-runner·일일작업. MetricsRecorder는선택포트 | 기존 격리실행기/재접속·삭제응답유실·예산UNKNOWN·복구증거를각범위로보존. metric sink·보관/파기·알림수신·현재운영heartbeat는코드존재만으로입증안됨. 현재운영metadata읽기거절을미설정으로단정안함 | M 서버/최소권한·runbook/실행준비, J앱오류소비·유미고객/출시연결. 신규외부도구·결제·운영쓰기/배포/역할생성승인은별도. [운영준비표][runbook] |
| A18 백업·복원 · 정책13 · 7.14 | prepare_database_restore와현재121 dump/roles/ACL/sequence/삭제재적용·UNKNOWN·Storage목록 | 과거준비/DB복구/Storage일부성공은그시점범위. 현재b003후속실패/별도cleanup과현재판정은root원영수증에묶을것.45metadata·과거확보6·원본39누락을전체복원PASS로표현안함 | M 원본/권한·실행receipt·실패복구, J앱/유미출시판단은후속. 실행결과를수정하거나새baseline으로실패를지우지않음. 이검토문서는실제복원완료판정아님 |

## 우선 후속 갭과 검증 경계

**G01 서버 접수시각·잠금대기 — M,4.5/4.6.** 정책167의접수기준과 private판정의clock_timestamp가다르다. accept_match는 `20261005005459_current_recruitment_reopen.sql:77~104`, 변경수락은 `20261005014629_appointment_place_change_draft.sql:139~157`, 후기제출은 `20261002110000_completion_review_policy.sql:71~99`에서 잠금후시간을쓴다. lifecycle wrapper와최신content ticket→기존본문호출도이를보완하지않는다. [재현 준비 문서](/private/tmp/yumidang-deadline-lock-reproduction-20261019.md)를따라새scratch의마감전진입/실제Lock대기/마감후취득·동일시각·expiry-worker선행을분리한다. HTTP접수/DBentry를구분하며statement_timestamp하나로해결됐다고단정하지않는다. 신규실제재현0이다.

**G02 검사ticket 앱소비 — M/J,4.2·4.4·6.3.** 서버 `service-api/index.ts:33~35·75~77`과 `db/content-inspection-client.ts:47~61`의enabled옵션소비, 앱 `member-service.ts`의preferences/firstMessage/sendMessage/create/update/review경로를읽기대조했다. J가검사호출→사용자확인필요상태→정확ticket/operation동일입력전달→재시도/만료·오류를연결하고 M이공개계약/서버guard를검토한다. 새classifier/외부전송/gate활성화·ACL변경을이문서로승인하지않는다.

**G03 신고숨김 제공 — 정책HOLD,결함과구분.** policy상단의‘일반신고 내화면숨기기 보류’와현재UI false를유지한다. 서버목록/상세숨김기능과실제클라이언트통합/회수결과가연결돼야제공여부를검토할수있다. 보류를무시해UI를true로바꾸라는요청은없다.

**G04 내정보·사진·공개DTO — M/J,4.7/4.8/6.3.** 본인5필드decoder/서버RPC·SQL과기존권한PASS를보존한다. `/me`현실제만료·공개/사적응답비교,사진신규deadline의실제Auth/Storage통합은남은직접증거다. 기존AI용Auth6profile을Naver가입완료fixture로간주해수락/후기를실행하지않는다.

**G05 fixture·수집기수정의후속 — M,4.4/7.12.** [갭문서][gaps]의초기표만읽어이미교정된익명null/messageId/쿨다운을현재미수정이라고쓰지않는다. 최소교정+Node구문PASS와새actual통합은별개다. event78·photo70모형도그영향의실제검증을대신하지않는다.

**G06 운영대상·공급사·실회원 — 별도조건.** 실제운영migration/권한·sink·Railway·키/공급사응답·실기기/실회원은이읽기대조로완료확정하지않는다. 접근거절은과거snapshot으로현재성공을대체하지않고원문미확인자료는미확인으로남긴다. 문서완료Task가이조건전부를실행해야끝나는것은아니다.

## 검토 근거의 바이트와 범위

| 읽은 로컬 자료 | 용도 | 작성시 SHA256 |
|---|---|---|
| `정책.md` | 정책 기준 | `b58c74cce4dc71718bfd45e3249d0ca8fa42b2cf6e9fca47b936584233ef386f` |
| `backend/contracts/service-api.md` | 사용자HTTP계약 | `935f4a88dcc5229a2ff16ac75daf5bff7f2733fcd754aaf0a0498199d7e2867f` |
| `backend/supabase/functions/service-api/routes.ts` | 현행route입력/RPC | `3d8c576158ae7212bf539685b39f9493b2e1f2954b90a821da18037b75e05112` |
| `backend/supabase/functions/service-api/index.ts` | runtime옵션/인증조립 | `e08ae4c6331a6aae3c466eb5b19042604985b8823c0467a7bdec1d6cf5667cb6` |
| `backend/supabase/functions/_shared/db/content-inspection-client.ts` | ticket소비 | `2c3f9d39d2a1e599c180bf84efad7f51c52771eda02777816d24fe0b056e8d44` |
| `apps/mobile/src/member-service.ts` | 종현앱DTO소비 | `f49c30ba0388802a880562a865a9c6bd797bbc8dd9e062a7b113b0d9b1d8cfcf` |
| `docs/collaboration/requests/minkyu/2026-10-19-current-acceptance-gaps.md` | 실행전후갭 | `76179078462bb8c3a77f074759fe642c1a2a8e37838a6b2fdcb4f40f9effc73e` |
| `docs/collaboration/requests/minkyu/2026-10-19-search-acceptance.md` | 5.2/5.3완료근거 | `5b7aa4d0b026d234328beb01ea2696054c940b5a3af737eff77d95326106284c` |
| `docs/collaboration/requests/minkyu/2026-10-20-summary14-acceptance.md` | 5.7기존14대응 | `b5b0392cddf803960364323272287b3c8f943456473c59c7afba81bc66f92362` |

위hash는이번작성시자료식별용이다. mutable실행기록/대장이다음root검토로갱신될수있으며,하나의글로벌원자snapshot·모든현재runtime패키지불변성을주장하지않는다. 현재manifest후속차분과각원영수증의실행source를섞지않는다.

## 판정 추천·남은조건·다음작업

**추천: WBS4.2의명시범위인정책/API/RPC·응답의주요전체영역차이목록과담당별후속연결은이문서와근거링크로완료판정가능하다.** 주요18영역과구체갭6개를서버M/앱J에연결했으며manifest만으로대체하지않았다. 이추천은위미완료구현·실제검증·HOLD가해소됐다는주장이아니다. 전endpoint/입력조합의실제실행전수검사결과도아니다.

root는다음으로이목록을현재대장/Task근거에연결하고4.5/4.6시간재현·J ticket소비·M권한/사진직접증거·행사실제연결·운영/복원조건을각원WBS에유지한다. J의소유파일은읽기만했으며별도인계후본인clone/ownership검사로수정한다. 새정책결정·공개RPC시그니처변경·client시각/GUC우회·실회원/원문전송·운영쓰기/배포승인을만들지않는다. 완료된구현을재작성하지않고민규전체미완료를계속한다.

[service]: ../../../../backend/contracts/service-api.md
[signup]: ../../../../backend/contracts/signup.md
[core]: ../../../../backend/contracts/core-service-db.md
[completion]: ../../../../backend/contracts/completion-db.md
[reports]: ../../../../backend/contracts/reports.md
[sanctions]: ../../../../backend/contracts/member-activity-sanctions.md
[search-acceptance]: 2026-10-19-search-acceptance.md
[summary14]: 2026-10-20-summary14-acceptance.md
[budget-sync]: 2026-10-19-ai-budget-policy-document-sync.md
[handoff]: ../jonghyun/2026-10-14-minkyu-final-handoff.md
[gaps]: 2026-10-19-current-acceptance-gaps.md
[progress]: 2026-10-19-local-verification-progress.md
[runbook]: 2026-10-19-operations-runbook.md
