# 신고·취소 이의 처리 계약

## 최신 연결 검증: 2026-10-06 순차 실행

정식 격리 로컬 DB는84개·미적용0이다. 새 취소 기한의 generation 증가·예약 종류5개·빈 wake15개는 실제 SQL 회귀와 정식 적용/기존 자료·권한 보존을 통과했다. 실제 내부 budget REST와 신고 Storage 정상 삭제·durable ACK·새 프로세스의 GET-only 복구도 PASS다. 상세 범위와 영수증은 [민규 진행표](../../docs/collaboration/minkyu-progress.md)를 따른다. 아래 날짜별 이력·NOT_RUN·일시정지는 과거 기록이다.

종현 현재 background는 review_summary/event_sync만 허용하며 queue-runner도 새 취소/신고 종류의 명시 dispatch가 없다. 기존 종현 테스트41개 PASS를 해당 연결 완료로 확대하지 않는다. 이 실행은 종현 소유 파일을 변경하지 않았고 변경 계약은 [취소 작업 연결 요청](../../docs/collaboration/requests/minkyu/2026-10-06-cancellation-due-worker-connection.md)에 갱신했다. guard/EXEC는 닫혀 있고 terminal30일 유지관리·실제 응답 유실/백업·일반 신고 정책·모바일/운영은 미완료다.


## 현재 연결 기준: 2026-10-06

이 절은 현재 코드·검증 상태를 설명한다. 아래 날짜별 구현 초안의 NOT_RUN·이력 수는 그 시점 기록이며 현재 상태는 이 절과 [민규 검증 현황](../../docs/collaboration/minkyu-progress.md)을 따른다. 정식 격리 로컬 DB는 migration 78개다. source77의 신고+취소 이의 원자 접수는 실제 Auth/REST/Storage/in-process HTTP 30그룹과 두 세션 SQL 12사례를 통과했다. hosted Edge·네이버 OAuth·모바일·운영 결과로 확대하지 않는다.

직원 해소·회원 취소 통지 HTTP 10개 파일은 현재 구현에 통합됐으며 타입 검사와 모형 95개가 통과했다. 대응 source78 SQL은 단일 TX 회귀·전체 롤백까지 PASS했고 source에 통합했다. SQL78/runtime52 준비 결과 READY 후 정식 격리 로컬77→78 적용·기존 자료/권한 보존·대기0 검증을 통과했다. 새 직원 해소·취소 통지 RPC는 실제 로컬 Auth/REST/Storage/in-process HTTP 38그룹을 통과했다. 한국어4000자 실제 입력·직원 판정/정정·권한/세션 거절·회원 통지와 명시적 읽음·보관 만료를 확인했다. 마감 전 이의와 due의 실제 격리 두 세션 SQL12사례도 PASS했다. 영수증 SHA `54e8de8a30b287a7c263b203d5a630d5cd8e74f437a1e90b0598dd9a4840e3a8`이며 자료·catalog·권한·감사·보호 환경 정리와 unknown=false를 확인했다. TTL은 회원 guard의 실제 대기 중 만료이며, 탈퇴 회차·캡처는 합성 metadata 범위다. 상주 due worker·실제 외부 파기·최종 종결 전체 흐름은 별도 남아 있다. hosted Edge·모바일·운영 결과로 확대하지 않는다.

추가로 최신 createRuntimeHandler를 사용한 실제 로컬 API38그룹/런타임 요청163개도 PASS했다. 영수증 SHA `b6d49739c201daa92576faf7a432fcc6e73700a249a8a04f1d68a2ea93fe52bf`이며 원SQL 적용 증거와 변경 후 실행 graph를 분리했다. 전체 정리12항목을 확인했으며 hosted 배포 증거는 아니다.

아래 경로는 `/functions/v1/service-api` 뒤에 붙인다. 직원은 현재 Auth 세션·별도 승인·사건 배정을 모두 확인하며 원 JWT와 anon key만 사용한다. 일반 회원 자격을 직원 권한으로 대체하지 않는다.

| 메서드·경로 | 고정 입력 | 고정 결과 |
| --- | --- | --- |
| GET `/operator/reports/:reportId/cancellation-appeals/:appealId/resolution-state` | 본문·query 없음 | `reportId,appealId,reportVersion,resultRevision,incidentRevision,appealState` 6개 |
| POST `/operator/reports/:reportId/cancellation-appeals/:appealId/resolutions` | `clientRequestId,mode,expectedReportVersion,expectedResultRevision,expectedIncidentRevision,outcome` 6개 | `reportId,appealId,decisionId,reportVersion,resultRevision,appealState,alreadyApplied` 7개 |
| GET `/cancellation-notices?limit&before` | limit 기본20·1~100, before UUID 또는 생략 | `{items,nextCursor}` |
| POST `/cancellation-notices/:noticeId/read` | 빈 객체 `{}`; query 없음 | 아래 본인 통지 10개 |

직원 `mode`는 `initial|correction`, `outcome`은 `accepted|rejected`다. report/result 기대 버전은 안전 정수 1~MAX_SAFE_INTEGER-1, incident는 0~MAX_SAFE_INTEGER-1이다. 성공은 report/result 버전을 각각 1 올린다. 같은 키·같은 입력은 원 성공 영수증을 돌려주고 `alreadyApplied=true`만 바뀐다. 최신 버전은 별도 GET으로 확인한다. 서버 requestId와 clientRequestId는 다르며 충돌 때 새 키 생성·자동 재시도를 하지 않는다. actor·회차·시각·원문·제재 계획을 입력에 추가하지 않는다.

본인 취소 통지는 정확히 `noticeId,appointmentId,appealState,planState,eligibleCount,provisionalCount,hasCancellationWarning,restrictedUntil,availableAt,firstReadAt`다. `appealState`는 null 또는 `reviewing|accepted|rejected`, `planState`는 `held|applied|corrected|policy_pending`이다. 횟수는 안전한 0 이상 정수이며 순서를 증명할 수 없는 `policy_pending`에서만 두 값이 함께 null이다. UTC 마이크로초와 동일 시각 UUID 내림차순을 보존한다. 목록 조회는 읽음 처리하지 않고 명시 ACK가 최초 읽기 시각을 한 번 기록한다. 타인 정보·신고 원문·상대 귀책·임의의 이의 마감은 반환하지 않는다. 자격 미완료·활동 제한 상태의 본인 관리 조회는 허용하고 탈퇴·만료 세션은 차단한다. 응답은 no-store다.

v2 보류·복원 SQL 후보의 단일 TX PASS 영수증은 `/private/tmp/yumidang-cancel-resolution78-v2-single-tx-reviewed/receipt.json` SHA `a7b04d16c627720ccb65f724ec732cd1245250ad9230efaca6abb4a1fcd320a3`이다. 복수 검토·같은 원 application/기간/점수 회차 복원·unknown 접수 보존·일반 사건 불변을 SQL 범위에서 확인했고, 앞선 최소 SQL 후보의 PASS도 별도 보존한다. 최초 revision 기대값40001·미할당 record55000 FAIL과 전체 복원 증거를 보존한다. 현재 source78는 이의 없는 자동 통지의 보관 기준·일반 이의7일 시작점·정정 anchor 시계 승계·종료 회차 최초 효과를 임의로 확정하지 않으며 자동 due 활성화·종현 실행기 연결·90일 종결 engine·운영 배포를 완료로 표시하지 않는다.

## 기존 접수 기준과 단계별 검증 기록

현재 정책6-2·13을 기준으로 한다. `20261005015709_member_reports.sql`은 접수·본인 증거 소유권·내 신고 조회를 구현한다. 선행 의존은 당도51의 `private.member_episodes`와 `private.active_member_episode(uuid)`이다. 파일 날짜는 실행 순서이며 54라는 작업명은 최종 migration 개수의 증거가 아니다.

## 회원 HTTP와 입력

service-api의 회원 JWT만 사용하며 익명·내부 키·본문 신고자 ID·임의 RPC는 허용하지 않는다.

| 메서드·경로 | 입력·역할 |
| --- | --- |
| POST `/reports` | 아래 고정 입력으로 접수 |
| GET `/me/reports?limit&before` | 본인 목록, limit1~100·UUID cursor |
| GET `/me/reports/:reportId` | 본인 상세 |
| POST `/report-captures` | `{assetId:UUID,extension:'jpg'|'png'|'webp'}` 예약 |
| POST `/report-captures/:assetId/confirm` | `{}`; 실제 Storage 업로드 후 확인 |
| POST `/report-captures/:assetId/cancel` | `{}`; 제출 전 예약 취소 |

접수 입력은 정확히 `{clientRequestId,targetType,targetId,context,reasonCodes,description,assetIds,hideTarget}`다. `targetType`은 `post|chat|appointment|member|event`, `context`는 `online|offline`이다. 공고·채팅·행사는 온라인 설명과 본인이 업로드한 캡처가 필수다. 약속은 오프라인 설명으로 접수할 수 있으며 일반 회원 대상은 상황에 맞는 context를 받는다. 온라인 공고를 offline으로 보내 캡처를 생략할 수 없다. 전용 양식과 공통 양식의 화면 연결은 별도다.

사유는 성희롱 `sexual_harassment`, 협박 `threat`, 금전/개인정보 요구 `money_or_personal_data`, 사칭 `impersonation`, 스팸 `spam`, 노쇼 `no_show`, 기타 `other`를 중복 없이 복수 선택한다. 사용자 확정 정책과 달리 설명1~4000자·캡처최대5개·파일최대5MiB·JPEG/PNG/WebP는 이 초안의 기술 제한이다. URL·채팅 이력·운영 판정·AI 결과를 이 일반 입력에 섞지 않는다.

성공은 `{reportId,status,alreadySubmitted,hideTarget}`이며 최초 상태는 `received`다. 동일 가입 회차와 clientRequestId, 정규화된 동일 본문은 같은 ID를 반환한다. 다른 본문은409다. 입력400, 미인증401, 증거 권한403, 대상/본인 신고 없음404, 잘못된 RPC 성공형식503이며 SQL 오류 원문을 노출하지 않는다. 상태는 `received|reviewing|more_evidence|resolved`이고 이 초안은 운영 전환 RPC를 제공하지 않는다.

## 대상·가입 회차·동시성

채팅은 실제 대화 당사자이고 상대가 보낸 메시지인지만 검사한다. 메시지 본문을 조회·복제하지 않는다. 약속은 당사자, 행사와 공고는 실제 접근 가능한 대상, 차단 관계는 본인의 기존 연결 사건을 기준으로 검사한다. 온라인 대상 캡처는 소유권을 별도로 검사한다.

신고의 `reporter_episode_id`, 캡처의 `owner_episode_id`는 기존 가입 회차 FK다. 본인 UUID가 같아도 현재 active 회차가 다르면 이전 접수·캡처·Storage에 접근하거나 재첨부할 수 없다. 탈퇴를 이유로 증거를 cascade 삭제하지 않는다. 안전 신고는 신규 동행 자격과 구분하여 네이버 자격 상태만으로 차단하지 않는다. 회원 JWT·현재 프로필·active 가입 회차는 필요하다.

Naver 계정 FOR SHARE(있는 경우) → 회원 프로필 FOR SHARE → active 회차 FOR SHARE → 접수별 advisory transaction lock → UUID 순서의 캡처 FOR UPDATE → Storage 객체 FOR SHARE 순서로 잠근다. 접수/본문/첨부 배정/감사 기록은 같은 DB transaction이다. 첨부 한 건은 한 사건에만 배정하고 접수 실패 시 변경이 rollback된다. 탈퇴·회차 종료 구현은 같은 계정→프로필→회차 순서를 따라야 한다. 대상 권한은 기존 참여 관계로 검사하므로 같은 회원 UUID의 새 회차가 과거 약속을 새 신고 대상으로 삼는 경우를 현재 허용한다. 이 허용이 재가입 안전 신고 정책에 맞는지는 후속 확인 대상이며 이전 동행 화면을 복구했다는 뜻은 아니다. 실제 두 세션 경쟁 검증은 아직 수행하지 않았다.

## private 증거와 보관 경계

예약은 private `report-evidence` bucket과 정확한 `<회원UUID>/<assetUUID>.<extension>` 경로를 반환한다. 실제 파일 업로드는 Supabase Storage 회원 API로 별도 수행한다. confirm은 예약 소유자·active 회차·Storage owner·경로·MIME·정수 크기1~5MiB를 다시 확인한다. 알려진 다른 회원 asset UUID나 예약하지 않은 경로를 사용할 수 없다. 파일 내용 자체의 이미지 디코딩/악성 파일 검사는 이 초안에서 검증하지 않았다.

Storage INSERT는 본인 reserved asset만, SELECT는 본인 현재 회차의 예약/확인/제출/취소 asset만 허용한다. 예약 객체 SELECT는 실제 Storage INSERT RETURNING 동작에 필요하며 업로드 확인·접수 완료를 뜻하지 않는다. 취소 상태 SELECT는 실제 Storage 삭제 시 객체 탐색을 위해 필요하다. UPDATE는 허용하지 않는다. 제출 후 임의 DELETE는 막으며 제출 전 cancel은 `storageDeletionRequired`를 반환할 뿐 실제 blob 삭제 완료를 주장하지 않는다. 원본 채팅·설명·이미지·외부 AI 답변을 로그/분석/공급사로 자동 전송하지 않는다.

private 접수·설명·캡처·접근감사 테이블의 직접 권한은 anon/authenticated/service_role 모두 회수했다. 회원 읽기와 증거 참조·Storage 읽기는 접근감사를 남긴다. 운영 담당 미배정이므로 직원 역할·운영 열람·상태 판정·종결·이의 API를 만들지 않았다. 접수는 사실 인정·자동 제재·동행 분쟁·완료 보류가 아니며 공고/약속/후기/당도를 바꾸지 않는다.

이의 포함 최종 종결 시각과 정확히90일 후 deadline을 저장할 schema 및 owner-only retention 후보 view만 제공한다. 만료 후 회원 조회·증거 읽기는 거부한다. 실제 최종 종결 입력, Storage blob 삭제, DB 자료 파기, 백업 반영, 정리 scheduler·접근감사 자체 보관 정책은 후속 연결이다. 직원 ACL과 실제 보관/삭제 검증이 없으므로 운영 처리 준비 또는 AI `reportEvidenceHandling.isReady()`를 true로 표시할 수 없다.

`hideTarget`은 접수 선택과 응답에 저장된다. 후속 SQL92의 본인 숨김 필터는 공개 탐색·상세·채팅 반환에 연결되어 있으며 다른 회원의 전체 공개 제한을 추가하지 않는다. 실제 소비자 v19에서 신고 접수·숨김 조회·같은 요청 재조회·숨김 해제를 확인했다. 성호 담당 화면의 표시·조작 검증은 별도다.

개별 메시지 읽음은 실제 표시된 같은 방의 UUID 1~100개를 원자 접수하며 숨긴 메시지를 포함할 수 없다. v19에서 실제 목록에서는 제외된 메시지의 개별 읽음이 받아들여지는 SQL106 결함을 발견했다. 후속 SQL120은 접수와 개별 미확인 집계에 동일한 숨김 필터를 추가한다. 기존 전체 watermark·최초 읽음 시각·함수 OID/소유자/실행 권한을 보존하며 자동 읽음 backfill을 하지 않는다. fresh v21 실제 Auth/HTTPS/MemberService/RPC/DB 검증21개가 PASS다. 숨김 직접 ACK404·추가 읽음행0·개별 미확인1을 DB와 detail/list에서 확인했고 정상 SQL120 적용1회·잘못된 원 함수 및 중복 적용55000의 전체 rollback을 확인했다. 원 함수 full metadata/OID/ACL·legacy watermark와 원본186개 전체 자료를 보존했다. 성호 담당 실제 화면·직원 판정·실회원·운영 검증은 별도다. 최초 v19/v20 실패는 보존한다. 최신 결과는 [실행 기록](../../docs/collaboration/requests/minkyu/2026-10-09-backend-execution.md)에서 확인한다.

## 실제 검증

독립 `yumidang-minkyu-drift` 컨테이너 안 새 `yumidang_reports_security_20261005` DB에 사용자 데이터 없이 schema50를 복원하고 당도51→신고 초안 전체 SQL을 적용했다. rollback 회귀는 온라인 필수/오프라인 설명, 실제 Storage metadata·RLS, 외국 소유 asset 거절, MIME/크기 오류, 멱등 충돌, 제출 첨부 보호, 행사/회원/약속 권한, 감사,90일 후보/만료 차단, 새 가입 회차 이전 자료 차단을 통과했다. 프로필·Auth·신고·Storage fixture는 합성이고 transaction rollback했다.

HTTP 검사는 실제 handler에 합성 인증/RPC를 주입한 테스트11개다. 별도 native54 환경에서 실제 Auth/Rest/Storage 바이너리 업로드/Edge 접수는 아래와 같이 검증했다. 두 세션 경쟁, 운영 열람·판정·삭제는 미검증이다. 기존 native50/51/52 및 운영 프로젝트는 이 작업에서 변경하지 않았다. 종현 AI 결과 신고 연결은 별도 요청 문서이며 일반 API의 성공을 AI 접수 성공으로 사용하지 않는다.

## Storage 정책 보안 재검토

기존 profile-images INSERT/SELECT/DELETE 정책은 bucket이 profile-images일 때만 통과하므로 신고 bucket의 권한을 우회하지 않는다. 신규 정책은 정확한 예약 경로·Storage owner·현재 회차를 별도로 검사한다. 실제 scratch에서 reserved SELECT 미허용 시 INSERT RETURNING이42501로 실패하는 것을 먼저 재현했다. 본인 reserved SELECT를 허용하는 교정 후 RETURNING 삽입을 회귀에 포함했다. 타인 SELECT/UPDATE/DELETE, 제출 후 metadata·소유자·이름·bucket 변경, private asset owner/report target 직접 수정은 허용하지 않는다.

미제출 reserved/uploaded 자료의 TTL과 자동 정리는 현재 없다. created_at이 오래돼도 같은 active 회차의 예약은 사용할 수 있다. 정책13의 종결+90일을 미제출 업로드에 임의 적용하지 않았다. 예약 만료/취소 시 파일 정리와 orphan 처리 기준은 운영 연결 전에 별도로 정하고 검증해야 한다.

SQL이 검사하는 metadata는 Storage 객체 행의 owner/MIME/size이며 blob 존재·실제 이미지 내용·실제 전송 크기를 독립 검증한 증거가 아니다. 현재 API 설정의 노출 schema는 public/graphql_public이고 storage.objects를 회원 REST에 직접 노출하지 않는다. 향후 schema 노출·직접 객체 metadata 쓰기 RPC를 추가하면 이 신뢰 경계를 재검토해야 한다. 실제 Storage API 업로드→바이너리 조회→확인→접수→제출 증거 변경 차단을 별도 격리 환경에서 검증하기 전 업로드 보안을 완료로 표시하지 않는다.

## native54 실제 Auth·Storage·Edge 증거

신고10파일을 민규 통합 worktree에 반영했다. 독립 로컬 migration54/Edge46파일에서 전체106/106 의미 검사 PASS다. 실제 회원 토큰으로 예약→PNG 업로드→정확한 바이너리 조회→업로드 확인→신고 접수→멱등 재접수→본인 조회를 통과했다. 타인 업로드·조회, 미예약 경로, MIME 오류, 제출 후 덮어쓰기·회원 삭제 시도를 차단하고 증거가 보존됨을 확인했다. 합성 파일을 실제 Storage API로 삭제하고 파일 backend의 남은 파일0 및 합성 DB/Auth 행0을 확인했다.

이 검증은 로컬 합성 회원이며 실제 네이버 로그인·운영 배포는 포함하지 않는다. 전체 검사에는 기존 native RPC의 P0002/500 응답 차이2건이 남아 있고 service-api의404 개인정보 비노출은 통과했다. 함수293/293·Deno 타입 검사·준비 도구15개도 PASS다. 업로드 초기 JWT 알고리즘 설정 오류는 로컬 공개 JWKS 설정 후 재검증했고 실패 기록을 보존했다. 운영 신고 판정·hideTarget 실제 필터·미제출 TTL·종결90일 실제 파기는 계속 미연결이다.

## source70/71 배정 직원의 제출 자료 조회

앞선 직원 API 미구현 설명은 신고 접수 초안 시점의 기록이다. 현재 별도 승인·사건 배정과 유효 Auth 세션을 확인하는 전용 조회 경계를 구현했다. 승인과 배정의 기본 자료는0이며 일반 회원 자격을 직원 승인으로 사용하지 않는다. 신고 판정·통지·이의·종결 API는 아직 구현 완료가 아니다.

직원 GET `/operator/reports/{reportId}`는 고정6키 신고 DTO, GET `/operator/reports/{reportId}/captures/{assetId}`는 고정7키 첨부 metadata 검사를 거쳐 인증 이미지 bytes를 반환한다. 전용 client는 요청자의 원래 JWT와 anon key를 사용하며 service-role 대체나 signed URL을 발급하지 않는다. 이미지 조회 뒤 권한을 다시 검사하고 같은 JWT의 HEAD도 확인한다. 응답은 private/no-store 및 `Vary: Authorization, Origin`이며 원문 채팅이나 임의 제출 자료를 추가로 조회하지 않는다. 회원의 정상 예약·업로드·취소·삭제 경계는 유지한다.

격리 native71에서 실제 Auth·REST·Storage와 in-process HTTP12그룹이 PASS다. 미승인·미배정·다른 사건·만료/회수 세션은 거절됐고, 배정/승인 회수 중에는 이미지 응답을 차단했다. 신고자의 실제 탈퇴·Auth 삭제 뒤에도 제출 증거를 보존하고 다른 활성 담당자가 정확 JPEG를 조회했다. 탈퇴한 UID의 조회는 차단했다. 합성 자료를 정리한 뒤 기존 catalog·권한·자료 건수·Auth 감사288개 ID와 payload 해시·파일0·보호 컨테이너 보존을 확인했다.

이 증거는 로컬 합성 직원과 회원에 한정한다. 운영 직원 승인·배정, hosted Edge·모바일·CDN, 검토 시작·판정·정정·통지·이의 전체 흐름, 실제 종결90일 파기는 후속 검증이다. 준비된 SQL 후보나 조회 PASS를 신고 처리 전체 완료로 표시하지 않는다.

## source72/73 검토 시작과 현재 상태 조회

GET `/operator/reports/{reportId}/review-state`는 현재 `{reportId,status,version}`을 반환한다. POST `/operator/reports/{reportId}/review/start`는 정확히 `{clientRequestId,expectedVersion}`만 받고, `{reportId,status,version,holdId,alreadyApplied}` 처리 영수증을 반환한다. 요청 actor·대상 약속·신고자·회차·원문은 입력으로 받지 않는다. 서버 응답의 requestId와 클라이언트 멱등 키는 별개다. 전용 JWT client만 사용하고 응답은 private/no-store다.

`start_assigned_report_review`는 현재 배정 직원의 세션·승인·탈퇴·보관 상태를 확인한 뒤 received/more_evidence→reviewing으로 전환한다. 신고에서 도출한 약속에만 기존 검토 hold를 연결한다. 신고 상태·hold·예약 회수·성공 감사는 원자 처리이며 일반 신고에는 약속 보류를 만들지 않는다. 같은 성공 요청 재시도는 기존 영수증을 반환한다. 그 영수증의 상태/버전은 처리 당시 결과다. 현재 상태는 `get_assigned_report_review_state`로 별도 조회한다. 오래된 버전이나 다른 입력의 키 재사용은409이며 자동 재시도나 새 키 자동 생성으로 바꾸지 않는다.

버전은1~9007199254740991이며 시작 입력은 상한 미만이어야 한다. DB·client·HTTP가 안전 정수와 정확 DTO를 검사한다. 기존 신고 자료6키와 첨부7키 응답은 유지한다. 권한 없는 직원과 회원에게 임의 신고 상태나 원문 권한을 열지 않는다.

격리 native71에서72 검토 시작 SQL 회귀, 이어72+73 SQL/73 상태 조회 회귀를 실행·롤백해 PASS했다. 원래 DB 이력71과 전체 정책·자료·권한·감사·사진 파일·보호 컨테이너를 보존했다. root HTTP/client/사진/service-api 통합 mock76/76 및 타입4파일 검사도 PASS다. source 통합 후 격리 로컬에 정식72/73을 한 번 적용해 이력73·대기0·사전 롤백 probe와 실제 메타데이터 일치를 확인했다. 기존 자료·권한·정책·Auth 감사288 ID+payload 해시·파일0·보호 컨테이너도 보존했다. 정식 영수증 SHA는 `ba1c86ef5c36397d2a9bef3f2d8a3fa4647cc0b4df4314448f65ddee1363cf14`다. 실제 Auth/REST 검토 mutation·두 세션 경쟁·hosted/mobile·운영은 아직 NOT_RUN이다. 판정·정정·통지·이의·최종 종결 구현을 이 시작/조회 성공으로 대신하지 않는다.

실제 native73 API 검사는 검토 시작 단계 FAIL로 보존했다. 보류된 신고의 fixture 삭제 순서도 실패했으나 자기 시험 자료만 정리한 뒤 전체 정식73 기준 snapshot과 감사288개·권한·파일0의 복원을 PASS했다. 안전 진단을 포함한 후속 검증 전까지 실제 시작 API 성공으로 설명하지 않는다. 운영 DB 변경은0이다.

후속 검증에서 세션 만료 복원 SQL 공백 오류를 발견·교정했고 실제 Auth/REST/Storage/in-process HTTP14그룹이 PASS했다(영수증 SHA `aaea10f3e207b24da9170933c15b5c9f0305fa844e21cb63786e13e475a23b9f`). 검토 시작1보류/1영수증·예약회수·멱등·낡은버전409/변경0·미배정/미승인/회원/탈퇴/세션 만료·로그아웃 거절·일반 신고 보류0을 확인했다. owner 합성 상태 변경을 실제 판정 성공으로 세지 않는다. 실제 두 세션·hosted/mobile/운영·판정/정정/통지/이의는 후속이다. 전체 시험 자료와 catalog/권한/정책/감사288/파일0은 복원됐으며 원래 FAIL을 보존한다.

실제 두 세션 SQL11사례가 PASS했다(영수증 SHA `885f3b29276f1f462882959752833479ad84ce80191cab2255b4adb3ace94f13`). 중복/낡은 버전·승인/배정 회수·대기 중 세션/보관 만료·최신 상태·약속NOWAIT·완료↔보류·탈퇴 session DELETE↔직원 SHARE를 실제 barrier17개로 확인했다. 기존 전체 자료·catalog·ACL·정책·감사288·guard/worker·파일/컨테이너는 원복됐다. 첫 관측 SQL 구문 FAIL은 보존한다. SQL 경합 검증이며 실제 API14그룹과 별도 증거이고 판정/정정/통지/이의·hosted/mobile/운영의 완료를 뜻하지 않는다.


## source74 판정·정정 후보 연결

배정된 직원의 원 JWT로 `GET /service-api/operator/reports/:id/adjudication-state`와 `POST /service-api/operator/reports/:id/adjudications`를 연결했다. 경로 reportId와 필수 body11개만 typed12 RPC로 전달한다. 호출자가 actor/identity/회차/사건 UUID·감점·제재기간·시각·임의 subjects·원문을 입력하지 않는다. 서버의 고정 당사자/회차 metadata로 연결하고 명시 귀책만 반영한다. 신고자나 반대 당사자를 피해자로 추정하지 않는다.

현재 state는 exact5 `{reportId,status,version,holdVersion,incidentRevision}`, mutation은 exact5 `{reportId,status:"reviewing",version,decisionId,alreadyApplied}`다. 기존 state3/start5/metadata6 계약은 유지한다. 원 사건 정정·권한/세션/보관 재확인·멱등·3버전·whole-TX 반영으로 판정하며 검토 중 상태를 최종 종결로 바꾸지 않는다. 통지·이의·최종 종결, 재발의 실제 안내 근거·다중 사건·제공처 조치는 후속 전체 요건이다.

모형 HTTP/client44/44와 교정 SQL 실제 단일TX/ROLLBACK 회귀 PASS다(영수증 SHA `4f2712f38fc8de8eec208c7694dd6f0ef6b3c0ba525fcf3d24313626fe4b6eab`). 첫 변수/별칭 충돌FAIL은 보존했고 전체 정식73 기준의 자료·catalog/ACL/정책·감사288·파일/컨테이너·cleanup 폐쇄를 복원했다. source74 정식 로컬 적용·실제 판정 API/두 세션·운영은 NOT_RUN이며 기존 검토 시작 API14/두 세션11 증거를 새 판정 검증으로 확대하지 않는다.


source74 정식 격리 로컬 once CLI 적용도 PASS했다. 실제 이력74·대기0·새함수4/표1/열9/제약7/인덱스2만 확인됐고 기존 전체 metadata/ACL/roles/자료/Auth 감사288 ID+payload/파일0/guardfalse/workeridle/보호컨테이너를 보존했다. 영수증 SHA `5099b62eba44200125c21dc9c642c8630f0b98172ebc13f5d1928a550b132926`이며 별도의 실제 판정 API/경합·통지/이의/종결·운영 검증은 NOT_RUN이다. 위 후보 rollback 당시 정식73 상태와 이후 정식74 적용을 구분한다.


source74 실제 로컬 검증은 후속 실행에서 PASS했다. Auth/REST/Storage/in-process HTTP17그룹(영수증 SHA `769781f94ebb212ef68bea6454dee7b59ee7041b32fd1bc6ed3261770f318251`)과 별도 실제 두 세션 SQL12사례(영수증 SHA `ec5c571d04221b527c0b64fb4a96dc69b45ffc12e8ee184b1fdecd8076b7aa9a`)를 확인했다. 노쇼의 명시 귀책과 원 사건 정정·제재 무효화·탈퇴 당사자가 포함된 정상 완료 정정·권한 회수·대기 중 만료·완료 경합을 포함하며 전체 시험 자료와 기존 catalog/ACL/정책/감사288/파일0/guard/worker를 복원했다. 앞의 NOT_RUN은 실행 전 상태로 보존한다. 통지·이의·최종 종결·hosted/mobile·운영은 이 증거 범위 밖이다.


75 회원 통지 HTTP6파일을 최신74 runtime 기준에서 선별 통합했다. `GET /decision-notices`는 `{items,nextCursor}`, `POST /decision-notices/:id/read`는 empty body와 정확9키 본인 통지 DTO를 사용한다. 원 JWT/anon key 유지·타인 및 만료404·상대 원문/귀책 미노출·목록 조회의 ACK0·명시 ACK의 최초 시각을 검사한 신규10개와 기존 제재7개 모형 검사가 root에서17/17 PASS다. 이는 모형 HTTP 검증이며 실제 통지 SQL/RPC·Auth API·이의·운영은 NOT_RUN이다. 현재 root runtime은 통지 연결을 포함하므로 이전 prepared74 runtime manifest를 새 구현의 증거로 사용하지 않는다. 신고50·전체63.5% 유지다.


source75 본인 통지 SQL과 회귀를 정식 native74 격리 DB에서 단일 TX로 실제 실행·롤백해 PASS했다. 영수증 `/private/tmp/yumidang-notice75-candidate-reviewed/receipt.json` SHA `c369784ca1197f100c98152ad78c1bacba7ab1db919948c93ec3704910b693cc`, driver SHA `0bd762bd0d204be3e47b3b1e27337e7620a25a8d15e43d9345f2615603443328`다. 명시 읽기 최초시각/멱등·회차/identity 분리·책임 해제 정정·만료된 미삭제 자료 거절·통지/읽기 trigger 후 세션/보관 만료 전체 원복·기존 판정 metadata·report 파기 CASCADE를 검사했다. 부모 Auth session→Naver child 순서와 대기 후 만료검사는 독립 읽기에서 확인했으며 실제 두 세션 경합 증거로 확대하지 않는다. 전체 catalog/자료/ACL/정책/Auth 감사288/파일0/보호컨테이너/cleanup 폐쇄를 보존했다. 검증된 SQL·회귀·문서3개를 선별 통합했지만 정식 로컬 이력은74이며 준비75 gate·정식75 적용·실제 통지 Auth API/두 세션·이의·운영은 후속이다. 신고50·전체63.5% 유지다.


source75 준비 도구/선별검사를 통합하고 root74→75/변조/미승인미래3개 회귀 PASS 후 최신 실제 source graph를 준비했다. `/private/tmp/yumidang-policy75-agent-reviewed/prepared`는 SQL75/runtime52 READY이며 migration SHA `0f3f9a30234349b2837673782655c59ec0af5e2750d9c630de244db59accdb10`, edge SHA `b459d05404f7599cb197028a1ec407872e653e12ca5b87f35a913071a3b314ca`다. 준비 자체의 SQL/Edge 실행 상태는 NOT_RUN이다. 별도 root 정식75 적용은 독립검토 후 once CLI PASS했다. `/private/tmp/yumidang-native75-rollout-reviewed/application-receipt.json` SHA `bdc4827ba529b26dce01f163edb53fcf01f6022b65a9cdaef3b44ac9a47543f7`이며 history75·pending0이다. 신규 함수5/표2/열25/제약26/인덱스3와 기존 판정 함수1의 본문만 변경됐고 OID/owner/ACL/config 등 기존metadata·다른본문·전자료/Auth감사288 ID+payload/정책/역할/파일0/guardfalse/workeridle/보호컨테이너를 보존했다. 실제 결과는 사전 rollback probe와 일치했다. 실제 통지 Auth API·두 세션·이의·최종종결·모바일·운영은 후속이며 신고50·전체63.5% 유지다.


실제 native75 Auth/REST/Storage/in-process HTTP 첫 실행은 통지 본인 조회 단계에서 FAIL했다. 원본 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-report-operator-native75-wSlQox/result.json` SHA `9c01eb967e49eca2ebe8376fdbe203369c25bd0622af34d0fb7e15d2c435fcfa`를 보존한다. 7개 이전 단계 통과 후 실패했으며 통지 API 성공으로 설명하지 않는다. 정리9항목은 모두 PASS/errors0이며 catalog/전자료/ACL/정책/Auth감사288 ID+payload/파일0/guardfalse/workeridle/보호컨테이너/활성TX0와 새 상세표 CASCADE0을 복원했다. 자료 복구나 삭제는 재실행하지 않고 첫 통지의 직접 REST와 회원 HTTP 호출 단계를 분리한 원문 없는 유한 오류 진단을 준비한다. 신고50·전체63.5% 유지, 운영 변경0이다.


통지 API 유한 진단 실행도 모듈 import 단계에서 FAIL했지만 원인이 구체화됐다. 영수증 SHA `fce3edf98e29d6739979afbafe84e802c3a1e73244e1edb281da3461e2ae7ecd`를 보존한다. 본인 통지 직접 REST는 HTTP200/오류코드 없음이며 검증기의 신청 결과 변수 `join`이 node:path의 `join` 함수를 가려 TypeError가 발생했다. 원본 모듈의 별도 로컬 import는 PASS했다. 정리9항목/전체기준 복원은 모두 PASS였고 원문·키·유효 토큰은 저장하지 않았다. 검증기 변수 이름만 교정하고 실제 전체 재검증 전에는 통지 HTTP PASS로 전환하지 않는다.


source75 실제 두 세션 SQL12사례 PASS다. 영수증 SHA `4bdf715b33754ff34175e34caf2e550e65c7ec3ccfef0ddde204b6d4bd67d892`이며 실제 잠금 관측23개/세션 결과187개다. 중복 ACK·부모 로그아웃 두 순서·child 대기 및 ACK 대기 중 세션/보관 만료·책임 정정·report CASCADE 삭제·탈퇴 양방향 경합을 확인했다. 전체 native75 자료/메타데이터/ACL/정책/역할/감사288/파일0/guardworker/컨테이너/활성세션을 복원했다. SQL 합성 JWT/Storage metadata 증거이며 Provider/HTTP0이다. 목록 TTL 경합은 query 단계만 증명하고 반환직전 검사는 별도 실제 단일TX hook 회귀로 구분한다. 최초 driver의 journal 정적결함은 실행 전 교정했고 실패 경합으로 세지 않는다.

통지 API 후속 실행의 실패3개째는 정상 bulk-read RPC204를200으로 기대한 fixture 오류(SHA `8a306404c049d413909609bc24b0f639ecb6e65e84b73fe8990c4a7ed6676b07`)다. 이를 교정한4개째는 실제 notice 목록/명시ACK/타인404/제재 및 자격미충족 관리조회까지 포함11그룹 통과 후 nullable SQL scalar를 JSON으로 읽다가 중단됐다(SHA `3a7413778f1197e75e24fb123abec6b152389c2500b0a7c6fddaa0416f60afce`). 각 실행의 정리9항목은 모두 PASS/errors0이며 원본 증거와 driver를 보존한다. nullable snapshot을 객체로 교정한 뒤 전체 실제 API 재검증이 필요하다. 신고50·전체63.5% 유지다.


source75 실제 로컬 Auth/REST/Storage/in-process HTTP 전체21그룹이 후속 실행에서 PASS했다. 영수증 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-report-operator-native75-sOVRdX/result.json` SHA `323d4e323c669f28da24a53290634b383805f3548c583f784d0f1526d3bd56ca`, driver SHA `6eac744390c13024fe89ce6a890793152751183ce26a512b7c2974fc69dc6133`다. 본인 통지 정확9키·상대 정보 보호·조회/일괄읽기의 명시 ACK 미변경·최초 읽기 시각 멱등·타인404·제재/자격 미충족 관리조회·정정 전 기록 보존·세션 만료/로그아웃·합성 동일 identity 새 회차 분리·탈퇴 당사자 차단을 확인했다. 정리9항목 모두 PASS/errors0이며 기존 전체 자료/catalog/권한/정책/Auth감사288 ID+payload/Storage 파일0/guard와 worker/보호컨테이너를 복원했다. 기존 실패4개와 원본 검증기는 보존한다. 실제 네이버 OAuth·hosted Edge·모바일·운영·일반 이의 7일 시작점은 미검증이다. 신고 전체 흐름이 남아 신고50·전체63.5%를 유지하며 다음은 확정24시간 취소 이의 접수·본인 조회 후보다.


취소 이의 HTTP 후보5개를 독립 읽기 검토 후 root에 정확 SHA로 선별 통합했다. `GET /appointments/:id/cancellation-appeals`는 본인 현재 상태 정확8키, POST는 `{clientRequestId,expectedResultRevision,reportId}`와 원 접수 스냅샷 정확9키를 사용한다. 원 JWT/anon만 전달하고 회원 시각·actor·다른 회차·원문 입력과 오류 원문 노출을 차단한다. microsecond 시각을 보존해 DB 결과를 검증하며 HTTP에서 접수 기한을 새로 판정하지 않는다. root 신규10+기존 통지10+제재7=27/27 모형 검사 PASS다. 원본4파일은 `/private/tmp/yumidang-appeal76-http-root-integration/`에 보존했다. SQL76은 아직 후보이며 정식 DB/source SQL 이력75를 유지한다. 현재 runtime이 변경되어 prepared75 edge manifest는 이전 통지 runtime 증거이고 새 runtime 준비는 NOT_RUN이다.

현재 POST는 기존 신고 reportId를 참조하는 별도 이의 접수다. 신고 최초 도착을 이의 접수로 소급하지 않으며, 신고 제출과 이의 판정을 사용자 한 번의 제출·동일 DB statement/TX로 묶는 S21 최종 연결은 후속 요구로 남긴다. 검토 승인/거절·경고 및 제한 실제 적용·통지·최종 종결·정리·실제 OAuth/모바일/운영도 남아 신고50·전체63.5%를 유지한다.


source76 SQL 후보 실제 검증의 첫 실행은 SQLSTATE42702로 FAIL했다. 회귀 보조 함수 `pg_temp.cancel_appeal_age`의 인수 n과 테이블 열 n이 겹쳐24시간 경계 fixture 조정에서 중단됐다. 영수증 `/private/tmp/yumidang-appeal76-candidate-reviewed/receipt.json` SHA `7ec912252c09911aba197809be117eb3a471a9b2d872eb68492f22eca23a4a83`, driver SHA `496324784d13b45d7a3dcd1a4103416e2125bd3b48c9645f51e6eea2a81bec44`를 원본 그대로 보존한다. 고정 입력·전체 catalog/자료/권한/정책/Auth 감사288·정식75 증거·파일0·보호컨테이너·다른 활성 TX0·정리 helper ACL의 복원7항목은 모두 TRUE이며 원격 완료 불확실성은 false다. 후보 변경은 모두 롤백됐고 DB 이력75/운영 변경0이다. 추가 복구나 삭제는 하지 않는다. A가 보조 함수 이름만 교정하며 migration SHA `359a8093c3a32bf7d547a17df98173de677307933780a8e78db323bc4c26fcd8`는 유지한다. 교정 회귀를 새로 고정·검토한 뒤 별도 실행하며 현재 SQL 전체 성공은 주장하지 않는다. 신고50·전체63.5% 유지다.


교정한 source76 회귀를 별도 고정 단일TX로 실행해 PASS했다. 영수증 `/private/tmp/yumidang-appeal76-age-reviewed/receipt.json` SHA `a1c048c47d40bc13afe80d0674f80575c7f8ddb9c0305f7e7cb70250580183db`, driver SHA `4e07d567da92de74f195764d94349444e351286ac7dfa9efba34c1a4981566a7`다. 검증된 SQL `359a8093c3a32bf7d547a17df98173de677307933780a8e78db323bc4c26fcd8`와 회귀 `b4cf7fc3a45cbd4b27f761e7c61717bcf323e5f6d56e239216ac1e550cd3da5e`를 root에 선별 통합했다. 최초42702 FAIL·driver·inputs는 보존한다. ASSERT on·equal/late/1microsecond early·원 접수/replay/CAS·MAXSAFE·원 취소/순서 보존·세션 만료 후 전체 원복·자격 누락 관리조회·TTL·합성 accepted-exempt의 상세 CASCADE 후 최소 결과 보존·회차/탈퇴·권한/역할/guard/worker를 검사했다. 전체8체크가 TRUE이며 candidate변경은 모두롤백했고 정식75 메타데이터/자료/권한/Auth감사288/파일0/컨테이너/활성TX0을 보존했다.

현재 승인 source graph는76이고 정식 로컬 DB는75다. 원래 제외한 중복 SQL1개가 남아 raw 파일 수는77이지만 승인 목록을 늘리지 않았으며 기존75개 SHA는 모두 그대로다. 통합 뒤 raw 파일 수를 승인 graph 수와 동일시한 root 후검사 assertion은 이를 구분해 교정했고 복사된2파일의 SHA와 이전75개/제외 파일 집합을 다시 확인했다. 새 prepared76·정식76·실제 이의 Auth/HTTP/두 세션·S21 원자 접수·직원 승인/거절·최종 종결/90일 엔진·모바일/운영은 후속이다. 신고50·전체63.5%를 유지한다.


source76 준비 gate/tool/test와 실제 PASS 문서를 root에 통합했다. 기존75 source핀·제외 중복·정확한 과거 승인집합을 보존하고 root75→76 pending1/변조/미승인 미래3개 선별 회귀가 PASS다. tool SHA `57ce1632d8759f35ddc642083154d7d98c6a984ce304e20051b4ccdc5cf6cdc7`, test SHA `09311f3a132be2437cf874059425bab3bcb886abd04a3c1a65e2418017ea42a6`다. 최신 source를 `/private/tmp/yumidang-policy76-agent-reviewed/prepared`에 실제 준비해 SQL76/runtime52 READY를 확인했다. migration manifest SHA `501144f17a46a8442d35ff24375c3f9c8ba941d9fb789f5b0adc21dc15a48621`, edge manifest SHA `a22e2b20306de8eff3340e2c46c8ede3bda108c9fdf4516c509f693f286cd126`이며 root source의 모든76 SQL/52runtime bytes와 일치한다. SQL/Edge 실행 상태는 NOT_RUN이며 정식DB 이력은75를 유지한다. 정식75→76 검증기·새25그룹 실제 Auth/HTTP 초안·두 세션 후보를 병렬 준비한다. prepared75/runtime는 과거 통지 검증 증거로 보존하고 현재76의 증거로 확대하지 않는다. 전체13영역과 남은S21/운영 요구를 유지하며 신고50·전체63.5%다.

## S21 신고와 취소 이의 동시 접수: 구현 중

후속 POST `/appointments/:id/cancellation-appeals/submit`은 clientRequestId·expectedResultRevision·reasonCodes·description·assetIds·hideTarget 6개만 받는다. AP/offline 대상과 본인 회차는 서버가 정하고 `submit_appointment_cancel_appeal_with_report` typed7 호출 한 번으로 신고·이의·멱등 연결을 같은 DB statement/TX에 저장한다. 응답은 기존 이의 접수9개에 본인 reportId를 더한10개다. 기존 접수3개/조회8개 계약은 유지한다. 현재 후보 구현 중이며 실제 검증 NOT_RUN이다.

사전 업로드 파일은 별도 준비 자료다. 접수 실패 시 신고 원문·첨부 attached 전이·숨김·이의·결과 revision·binding을 함께 롤백하고 업로드 파일을 보존해야 한다. 같은 요청 재시도는 원 성공 시각과 결과를 반환하고 다른 입력은 충돌로 거절한다. `55000`의 SQL 거절 증거와 실제 PostgREST HTTP 상태는 구분한다. 기존 transport는 upstream 상태에 따라 안전한 오류를 반환하므로 실제 상태를 확인하기 전 무조건503이라고 설명하지 않는다.


## source79/80 신고 파기와 지원 종류 점유

신고 파기의 [정확한 내부 계약](../../docs/collaboration/requests/minkyu/2026-10-06-report-retention-purge-contract.md)과 [지원 종류 점유](../../docs/collaboration/requests/minkyu/2026-10-06-worker-supported-claim.md)를 통합했다. 두 SQL과 회귀를 정식 native78 한 트랜잭션에서 실제 실행·전체 롤백해 PASS했다. 영수증 SHA `f4480057255cb7fa733b8504e5943a0a91a1001aba4375b34ec0f0aafec6c0a3`다. 현재 DB 이력78·파기 guard=false·신규 실행 권한 폐쇄·운영 변경0이다.

기존 신뢰된 최종종결·90일 만료·검토 목적 부재를 만족하는 신고만 대상으로 하며 새로운 업무 종결 권한을 만들지 않는다. hideTarget와 연결 제재 목적은 아직 확정/검증되지 않아 파기를 보류한다. 첨부의 정확한 객체 ID와 경로를 예약하고 기존 ACK·완료 증거가 다른 해시이면409로 거절한다. 첨부 전부 완료 뒤 metadata를 원자 삭제하고 최소 결과/노쇼 hold를 보존한다. metadata 성공과 parent job 완료는 같은 DB 트랜잭션이며 호출자가 complete_job을 다시 실행하지 않는다. 원 완료 증거의 재생은 유효한 새 전역 점유 안에서30일 동안만 허용한다.

실제 Storage 파기 어댑터는 모형13/13·타입 검사만 통과했다. DB 연결 포트·durable intent·불확실 DELETE/ACK 후 자동 mutation 차단·지연 요청의 객체 이름 재사용 안전성·실제 물리 bytes 제거·상주 실행은 아직 미검증이다. metadata 직접 삭제와 합성 해시를 실제 Provider 삭제 증거로 사용하지 않는다. 전체 신고 종결·이의/제재 보관·미제출 TTL·운영/모바일 조건은 남아 있다.

신고 전용 `db/report-retention-client.ts`의 check/getAck/recordAck 서비스 포트와 exact6/7 전송을 source에 통합했다. adapter와 연결한 모형을 포함한28/28·타입3 검사 PASS이며 실제 gateway/worker import와 DB/Provider 호출은 후속이다. ACK dispatch 뒤500/503·응답 유실은 terminal unknown으로 분류한다. SQL81 전송 의도 후보는 private 구현 단계이며 기존79의 lease 만료 재claim 경계를 보완한 실제 DB 증거는 아직 없다. 실제 실행 guard/EXEC를 열지 않는다.


### 전송 의도 연결 검증 범위 (2026-10-06)

`begin_report_retention_delete`는 정확6개 task/object/job/global fence를 받으며 정확3키 `taskId/dispatchId/alreadyApplied`를 반환한다. Storage adapter는 ACK가 없을 때만 최초false 확인 후 새 DELETE를 전송한다. 중복true와 불확실한 응답은 전송 의도 UNKNOWN으로 끝내고 자동 재DELETE/완료/정리하지 않는다. 기존 durableACK가 있으면 새 begin 없이 GET 부재 조회로 복구한다. root 모형32개와 타입5개 및 독립 SQL 계약 검토 PASS는 실제 Provider 종료·DB 점검 이후 지연 전송·실제 상주 소비자 연결의 증거가 아니다. externalReady는false다.


2026-10-06 후속 SQL81/82의 격리 로컬 정식 적용은 PASS다. 이력82·미적용0이며 영수증 SHA `db9a5bad3975e2df984de7832a4b06e1d5b8a258bb69df086c5452a4b4ff3765`다. 전송 의도 표와 정확6→3 begin 함수는 설치됐고 기본 서비스EXEC/실행 제어는 폐쇄다. 설치는 실제 Provider 호출·dispatcher 활성화의 증거가 아니다.


2026-10-06 실제 정상 Storage 파기 검증은 DELETE 연결 단계의 HttpError로 FAIL했다. 합성 업로드/첨부/bytes 조회 PASS와 전체 삭제 성공을 구분한다. 원 FAIL SHA `14af932f55f47686394b11f13de33c62f6e9bc8bcbbc201475f90740effc2a5b`를 보존했고 합성 프로필 사진2개 명시 복구 후 전체82 기준 원복 PASS SHA `73ea1158b7cac8aebdf63c2a2ac7f702edc7cf5561b3ace440c19b6eb533593f`다. unknown=false/파일0/권한 폐쇄이며 externalReady=false를 유지한다. 사용자 요청에 따라 다음 원인 수정·재검증은 일시정지했다.

## 2026-10-08 AI 피드백 DB·권한 연결

기존 `POST /ai-chat/feedback` 계약 `2026-10-05`와 종현 HTTP 모듈을 재사용한다. 내부 `submit_ai_feedback`는 JWT에서 검증된 회원, 요청 식별자, 접수 키, helpful/report 및 최소 첨부만 받는다. 회원+키를 잠가 동시 접수를 직렬화하며 동일 입력은 동일 ID, 다른 입력은 충돌이다. 일반 회원 신고 입력의 대상 허용 목록은 확대하지 않는다.

`record_ai_chat_result_available`는 활성 처리의 회원·요청·lease를 검사해 원문 없는 결과 제공 준비 증거만 기록한다. 실패 종료를 성공으로 바꾸거나 과거 finished를 일괄 성공 처리하지 않는다. 실제 성공 응답을 만드는 종현 경로의 연결이 필요하며 합성 증거 검증은 실제 AI 응답 검증을 대신하지 않는다. 원문 없는 결과 제공 증거는 요청 FK 및 탈퇴 수명주기를 따르며 helpful만 제공+90일 이후 새 접수를 거절한다. 신규 신고에 임의의 90일 접수 마감을 추가하지 않는다. 이는 일반 제재 이의 7일·취소 이의 24시간과 별개다.

helpful 및 그 중복 기록은 접수+90일 또는 실제 탈퇴 RPC에서 삭제한다. `purge_expired_ai_feedback`는 회당 1~100개로 만료 helpful만 정리한다. `internal/ai-feedback-maintenance` 포트는 준비했으며 상주 실행기 연결 전 주기적 파기 운영 완료로 표시하지 않는다.

신고는 회원이 확인한 답변 일부 500자 또는 uploaded 상태의 본인 캡처 하나만 저장한다. Storage 객체 소유권·MIME·크기 및 회차를 검사한다. 기존 신고 배정·담당자 접근 감사·무제재 종결·최종 종결+90일 보관·파기 FK를 재사용한다. AI 증거는 생성 원문 일치 보증이 아니다. `ai_answer`는 운영자 읽기 DTO에서만 추가 허용하며 일반 신고 API의 임의 대상 입력으로 접수할 수 없다.

`createAiReportEvidenceHandling` 준비 어댑터와 서버 허용 목록을 구현했다. 신고 제어는 기본 false이고 실제 로컬 검증에서만 열었다가 닫았다. 실제 Storage 업로드·담당자 접근·접근 기록·종결은 검증했으나 상주 파기 실행 및 성공 응답 증거 연결 전 신고 활성화하지 않는다.

AI 신고 파기 시 첨부·설명은 삭제하며 원문 없는 최소 접수 키 기록은 유지한다. 신고 FK는 SET NULL이고 동일 키 재접수는 만료로 거절해 삭제된 증거를 복원하지 않는다. helpful 중복 기록의 90일/탈퇴 삭제와 구분한다.
