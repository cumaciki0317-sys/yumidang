# 일반 신고 접수 계약 — 구현 초안

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

`hideTarget`은 접수 선택과 응답에 저장되어 있다. 현재 탐색·상세·채팅의 필터와 모바일 UI에는 연결하지 않았으며 실제 내용 숨김 완료를 의미하지 않는다. 다른 회원의 전체 공개 제한은 추가하지 않는다.

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
