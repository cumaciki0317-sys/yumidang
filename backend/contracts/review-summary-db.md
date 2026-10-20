# 공개 후기·요약 DB 연결 구현

## 2026-10-20 현행 기준과 이 문서의 적용 범위

이 문서는 현재 요구와 구현 계약을 구분한다. 아래 기술 시그니처·기존 SQL·검증 기록은 실제 구현 근거이며 새 정책 요구가 자동 구현됐다는 뜻이 아니다.

- 담당은 현재 민규=BE·AI·검색·행사·서버 운영, 종현=FE·UX/UI·앱 API/세션 소비·빌드, 유미=UT·출시/지원 책임이다. 아래 옛 종현 BE·성호 UI 배정은 당시 기록이며 현재 실행 권한으로 사용하지 않는다. 구체 파일은 현행 소유권 정책을 따른다.

- AI 탐색 동의는 첫 사용 시 받고 거절하면 일반 검색을 유지한다. 후기 요약은 가입 시 열람·내 프로필 생성/노출·작성 후기 활용을 기본 미선택인 별도 선택 세 항목으로 받는다. 전체 동의와 개별 자세히 보기를 유지하고 미동의 가입/일반 동행을 허용한다. 세 동의의 철회는 독립적이다. 현재 서버의 summary_allowed 하나·review_summary 일괄 철회가 이 세분화 요구를 구현했다고 해석하지 않는다. 테스트 계정 동의 간주는 실제 동의 증거·DB 값 변경·회원 원문 전송 승인이 아니다.

- 일반 신고·허용된 증거 열람·비용 운영 책임은 대표 조유미(유미), 공개 지원 메일은 cumaciki0317@gmail.com이다. 별도 등록 사업자는 없고 대체 담당은 미지정이다. 평일09~18시/신고 첫 확인2영업일은 목표이며 실제 권한 설정·메일 수신·응답 보장 증거가 아니다. 앱 밖 삭제는 공개 방침의 직접 연결 구역과 이메일로 받고 첫 답변/본인확인 후 처리 목표는 정책13장을 따른다. 운영자는 회원 채팅 DB 원문을 직접 읽지 않는다.

최신 기준: [정책.md](../../정책.md). 구현과 남은 조건: [서버·DB 대조 원장](../../docs/collaboration/requests/jonghyun/2026-10-20-policy-implementation-audit/server-audit.json).


현재 정책의 최신 합의 종료 기준·탈퇴 후 정정 예외와 아래 기존 인터페이스·과거 검사 증거를 구분한다. 이번 문서 동기화는 RPC 인자·응답·SQL·배포를 변경하지 않으며 실제 구현의 일치 여부는 별도 확인·수정·검증한다.

현재 담당(2026-10-14): 이 서버 계약과 BE·AI 구현은 민규 전담이며 프론트 클라이언트 소비·UX/UI는 종현, QA는 공통(민규·종현·유미), UT는 유미다. 아래 과거 구현자·검사·인계 증거는 당시 기록으로 보존한다.

## 현재 정책과 구현 경계

현재 기준은 [정책.md](../../정책.md)다. 아래에서 현재 정책 목표와 기존 기술 인터페이스를 구분한다. 이번 문서 동기화는 서버 코드·SQL·설정·DB·외부 호출·배포를 변경하거나 검증하지 않았다.

예상 종료 후 본인 완료 확인을 마친 사람은 상대 확인 전에도 후기를 제출할 수 있으나 실제 완료 전에는 비공개다. 양쪽 확인 또는 예상 종료+24시간에 실제 완료하며 취소·노쇼는 제외하고 신고·분쟁 검토 중에는 보류한다. 지연 시 실제 성공 시각이 완료 시각이다. 작성 마감은 실제 완료부터 7일, 양쪽 제출은 실제 완료 후 즉시 공개, 한쪽 제출은 작성 기한 종료 시 공개한다. 완료 횟수는 실제 완료 즉시, 후기 당도는 상대 열람 가능 시 반영한다.

검토 중에는 작성·기한 진행·새 공개를 보류한다. 이미 공개된 후기는 접수만으로 숨기지 않고 운영자가 임시 비공개를 결정한 때 숨긴다. 정상 동행 인정 후 두 사람이 합의한 최신 종료+24시간이 지났으면 즉시 실제 완료한다. 검토 중 새로 합의한 종료 시각도 적용하며 검토 시간을 더하지 않는다. 한 명이 이미 탈퇴했고 실제 완료 기록이 없는 불발 건을 정상 동행으로 정정하면 탈퇴자를 진행 약속으로 복귀시키지 않고 정정 시점에 완료한다. 다른 미결 검토가 있으면 보류하며 최초 실제 완료부터 7일을 적용하고 탈퇴 본인은 새 후기를 쓰지 못한다. 첫 완료라면 그때부터 작성 7일, 이미 완료했다면 남은 기한을 재개하되 최소 24시간을 보장한다. 재개 후 양쪽 제출이면 공개하고 한쪽이면 재개·연장된 작성 기한 종료에 공개한다.

기존 완료·공개 predicate와 예약 RPC는 아래 인터페이스를 유지하되 한쪽 작성 기한 종료 공개·검토 중 이미 공개된 후기 처리·당도 산식은 현재 정책에 맞춘 코드 대조와 변경·검증이 필요하다. 당도 산식은 정책 7-4절에 확정됐다. 초기 15, 반응 좋아요 +1·보통 0·별로 −2와 별점 1~2점 −2·3점 0·4~5점 +1을 합산한다. 완료 횟수·칭찬은 가산하지 않는다. 취소 제재 −2·노쇼 −3·중대 위반 −10이며 같은 사건의 운영 감점은 가장 큰 하나만, 유효 후기 기여와는 합산한다. 무효 동행의 후기 기여는 제외한다. 전체 유효 기여를 합한 뒤 표시만 0~100 정수로 제한하며 원 기여를 남겨 정정한다. 임시 후기 숨김은 반영 당도를 유지하고 최종 무효 때 제외한다. 정책 확정과 실제 점수 저장·계산기 연결은 별개다.

## 실제 RPC

모든 인수는 PostgREST의 이름 그대로 전달한다. 반환은 JSON 객체이며 공통 HTTP envelope는 어댑터에서 덧붙인다.

| RPC / 호출자 | 인수 | 반환 |
|---|---|---|
| `set_review_publication` / service_role | `p_review_id:uuid, p_is_public:boolean` | void |
| `load_public_review_snapshot` / service_role | `p_profile_id:uuid` | `{profileId,sourceRevision,reviews:[{reviewId,text}],eligibleCount}` |
| `publish_review_summary` / service_role | `p_profile_id:uuid, p_source_revision:text, p_evidence_review_ids:uuid[], p_summary:text, p_model_version:text, p_prompt_version:text` | `{summaryId,sourceRevision,sourceCount,publishedAt}` |
| `get_visible_review_summary` / authenticated | `p_profile_id:uuid` | `{summary:null}` 또는 `{summary:{summaryId,text,sourceCount,updatedAt}}` |

`sourceRevision`은 DB bigint를 문자열로 직렬화한다. 호출자는 산술 계산하지 않고 snapshot에서 받은 불투명 문자열을 그대로 돌려준다. 모델·프롬프트 버전은 영문·숫자·점·밑줄·하이픈으로 이루어진 1~64자 표식(`^[A-Za-z0-9_.-]{1,64}$`)이다. 작업 큐의 modelVersion/promptVersion과 동일한 규칙이다. 요약문 1~4000자는 기존 저장소 기술 상한이다. 현재 공개 요약 목표는 최대 300자이며 생성·저장·응답의 검증을 맞춰야 한다. 표시·재진입 때 서버 조회하며 별도 공개 결과 캐시는 두지 않는다.

## 공개 허용과 남은 정책 연결

- 기존 `released`는 상대방 평가 열람용이므로 공개 프로필 사용 승인이 아니다. 별도 `private.review_publication` 행이 없으면 비공개다. 기존 데이터 자동 공개·backfill은 없다.
- 신뢰된 서비스가 공개 정책을 확인한 뒤 `set_review_publication`을 호출한다. 일반 회원·익명은 호출할 수 없다. 이 RPC를 그대로 외부 사용자용 endpoint로 노출하지 않는다.
- 현재 공개 기준은 [후기 계약](reviews.md)과 같다. 한쪽은 작성 기한 종료, 양쪽은 실제 완료 후 즉시다. 검토 중 새 공개와 이미 공개된 후기의 운영자 임시 숨김을 분리한다. 현재 predicate·revision 무효화가 이 기준을 충족하는지 변경·검증한다.
- 명시 공개 허용 이후에도 snapshot·게시·열람에서 현재 적격성을 재확인한다. 한마디가 없는 후기와 비공개 후기는 3개 기준에 넣지 않는다.
- 최초 저장소 migration은 완료 이력을 바꾸지 않는다. 현재 후속 정책은 건별 자동 완료 예약과 제출·조회 공개 조건을 적용하며 과거 이력을 일괄 공개하지 않는다. 공개 정리·요약 등록 분리는 [자동화 계약](review-automation-db.md)을 따른다. 실제 검증은 [새 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-review-policy-handoff.md)에 한정한다.

## 원자성·실패

동일 프로필의 상태 행 잠금이 source 변경 트리거·snapshot·게시·열람을 직렬화한다. 후기 추가·수정·삭제, 공개 gate 변경, 약속 변경·삭제, 완료 확인 행 변경, 분쟁 변경은 같은 트랜잭션에서 revision 증가와 현재 요약 연결 해제를 수행한다. 양쪽 프로필은 UUID 순으로 잠근다. 조회 때도 현재 전체 적격 ID와 텍스트의 fingerprint를 다시 계산하므로 시간 경과와 예외적인 상위 관계 변경도 오래된 요약을 노출하지 않는다. 정식 자동화 SQL에는 원문·공개 변경을 outbox에 남기고 `process_review_summary_refresh`에서 `enqueue_job`으로 요약 작업을 등록하는 경로가 있다. [후기 자동화 계약](review-automation-db.md)을 따르며, DB 등록 경로의 존재와 운영 일일 스케줄러·실제 모델 생성·원격 적용 여부를 구분한다.

게시 시 revision 일치·3개 이상·중복 없는 전체 근거 ID 집합 일치를 모두 요구한다. 동일 프로필·revision·모델/프롬프트 버전 중복 요청은 최초 저장 결과를 반환하고 본문을 덮어쓰지 않는다. 근거 ID 검사는 내용의 사실성·민감정보 제거 검증을 대체하지 않는다. 민규 담당 워커가 생성 결과를 검증한 후 호출해야 한다.

| SQLSTATE | 의미 / HTTP 연결 |
|---|---|
| `28000` | 로그인 필요 / AUTH_REQUIRED |
| `42501` | 함수 실행 권한 없음 / ACCESS_DENIED |
| `40001` | 공개 전제 또는 revision·근거·3개 기준 불일치 / STATE_CONFLICT; 새 snapshot 후 다시 생성 |
| `22023` | 잘못된 입력 / INVALID_REQUEST |
| `P0002` | 대상 프로필·후기 없음 / RESOURCE_NOT_FOUND |

모든 private 테이블은 RLS를 켜고 anon·authenticated·service_role 직접 접근을 허용하지 않는다. SECURITY DEFINER RPC의 허용된 반환만 사용한다. 서버 로그에 snapshot·후기·요약 원문을 출력하지 않는다. SQLSTATE 40001을 무조건 기존 생성 결과의 자동 재게시로 처리하지 않는다.

## 검증

`tests/database/minkyu/review_summary_storage.sql`은 로컬 정식 migration 재생 후 DB 소유자로 실행하며 트랜잭션을 rollback한다. 기본 비공개, 2/3개 경계, 한마디 없는 평가·비공개 제외, 근거 중복, 중복 게시, 개인정보 필드 제외, 비공개/텍스트 변경/분쟁/삭제 무효화, 보류 기간, 실제 service_role·authenticated 호출 및 ACL을 검사한다. 실행 결과는 민규 현황 문서의 실제 검증 기록을 따른다. 파일 존재만으로 실행 완료로 보지 않는다.

## 작업별 원자 요약

종현 제안03을 채택하되 기존 private.is_review_public_eligible/private.review_summary_sources를 유지한다. 완료 알림 시각으로 공개 기준을 되돌리지 않는다. 기존 set_review_publication/load_public_review_snapshot/publish_review_summary/get_visible_review_summary 계약과 후기 공개 물질화 RPC는 보존한다. 구형 별도 게시 RPC는 service_role의 명시 작업용이며 신규 worker는 아래 job-aware RPC를 사용한다.

모든 신규 함수는 service_role 전용이며 인수 이름은 아래와 같다. J는 p_job_id uuid,p_lease_token uuid이고 R은 p_source_revision text다. job의 모델·prompt 버전과 revision을 그대로 돌려준다.

| RPC | 인수 | 반환 |
|---|---|---|
| load_review_summary_source | J | {status:"applied",profileId,sourceRevision,reviews:[{reviewId,text}],eligibleCount}, 또는 {status:"lease_lost"\|"stale_revision"\|"already_published"} |
| load_review_summary_checkpoint | J,R | {status:"applied",checkpoint:null\|object}, 또는 lease_lost/stale_revision |
| save_review_summary_checkpoint | J,R,p_checkpoint jsonb | {status:"applied"\|"lease_lost"\|"stale_revision"\|"insufficient_reviews"\|"invalid_evidence"} |
| discard_review_summary_checkpoint | J,R | {status:"applied"\|"lease_lost"} |
| mark_review_summary_insufficient | J,R | applied/lease_lost/stale_revision/invalid_evidence status 객체 |
| publish_review_summary_for_job | J,R,p_evidence_review_ids uuid[],p_summary text,p_model_version text,p_prompt_version text | {status:"applied",summaryId,sourceRevision,sourceCount,publishedAt}, 또는 lease_lost/stale_revision/insufficient_reviews/invalid_evidence |

기대 상태는 JSON status로 반환하고 잘못된 인수·job payload와 다른 revision/model/prompt는 22023이다. 오래된 작업의 현재 snapshot은 현재 revision을 반환하므로 워커가 자기 payload와 비교한 뒤 supersede한다. 그 작업의 쓰기 RPC는 stale_revision으로 거절한다. 이미 같은 job/revision이 게시되었으면 source는 already_published를 반환하여 모델을 다시 호출하지 않는다. 새 token으로 재점유한 경우에도 현재 공개 자격·revision이 맞아야 한다.

checkpoint 객체는 저장 시 `{schemaVersion:1,sourceReviewIds:[uuid],nextReviewIndex:number,nodes:[{sourceReviewIds:[uuid],claims:[{text,evidenceIds:[uuid]}],modelVersions:[label]}]}`만 허용한다. 조회 반환은 profileId/sourceRevision/modelVersion/promptVersion을 더한다. 임의 원문·작성자·위치 필드와 추가 키를 거절한다. 각 주장은 모델이 생성한 비공개 중간 결과이고 근거는 전체 공개 ID 집합의 하위 집합이다. 전체 sourceReviewIds는 현재 적격 공개 텍스트 집합과 정확히 일치하고 3개 이상이어야 한다. 원문과 완전히 같은 claim은 거절하지만 이 검사가 부분 복사·의역·민감정보·사실성 탐지 전체를 보장하지 않는다. 워커도 원문 사본을 넣지 않고 출력 검증 후 저장할 책임이 있다.

잠금은 review_summary_state → worker_jobs → checkpoint/publication marker 순서다. 식별용 job 조회 후 projection과 job을 잠그고 토큰·DB 시각·running·프로필을 다시 검사한다. save/publish는 실제 저장 직전 lease 만료를 다시 검사한다. 원문·공개 상태가 바뀌면 기존 트리거와 같은 트랜잭션에서 revision 증가·visible_summary_id 해제·outbox 기록·이전 checkpoint 삭제가 이뤄진다. 원문 변경은 job 행을 잠그지 않는다.

publish는 현재 전체 근거 ID·3개 기준·revision·버전을 검증한 뒤 요약 삽입(동일 revision/model/prompt는 최초 내용 보존), 표시 연결, checkpoint 삭제와 (jobId,sourceRevision) 게시 표식을 한 트랜잭션에서 기록한다. 같은 job 재게시도 현재 공개 자격을 검사하고 첫 publishedAt을 유지한다. 게시와 큐 complete는 별도다. 게시 후 complete 전에 중단되어도 marker를 읽어 모델을 재호출하지 않고 작업을 종결한다. 별도 publish_review_summary와의 동일버전 경쟁도 최초 요약과 게시 시각을 보존한다.

성공·폐기·공개 원문 변경·실패 종결·supersede 때 checkpoint를 지우고 retry/yield는 재개를 위해 남긴다. 자동 TTL·임의 삭제 주기·새 작업 kind를 추가하지 않는다. private checkpoint와 publication marker에 외부 역할의 직접 권한을 주지 않는다. job_id FK를 두지 않으며 등록·변경은 현재 job을 검증하는 RPC로만 가능하다. 기존 테스트의 TRUNCATE 작업에 맞춘 결정이고 운영 job 삭제 API를 제공하지 않는다.

추가 검증: 기존 공개/칭찬과 같은 Phase1 gate, 잘못된 token/lease 탈취, source 2/3개, 숨김·원문 변경의 revision과 checkpoint 삭제, 정상 양보와 실패 수 분리, job-aware 게시 중복 시각 보존, publish 대 숨김·lease 재점유 경합, private ACL. tests/database/minkyu/common_connections.sql과 별도 경합 runner의 실제 결과를 총괄이 기록한다. SQL 작성·정적 검사와 모델 실호출·운영 공개 활성화는 구분한다.

## 동의 철회·보관 연결

AI 탐색은 첫 사용 시 동의받고 동의 확인 전 모델 처리·질문 외부 전송을 시작하지 않는다. 거절·철회 시 일반 검색·일반 동행·계정을 유지한다. 가입 동의·전체 동의에 AI 탐색 동의를 포함하지 않는다.

후기 요약은 가입 때 `요약 열람`, `내 프로필의 요약 생성·노출`, `내가 작성한 후기의 AI 요약 활용`을 각각 선택 체크로 받는 제품 의도다. 기본 미선택·개별 자세히 보기와 `전체 동의`를 제공한다. 전체 선택/해제는 같은 가입 화면의 모든 개별 항목에 적용하고 개별 항목을 하나라도 해제하면 전체 동의도 해제한다. 모든 개별 항목이 선택되면 전체 동의도 선택된다. 후기 작성 때는 활용 안내만 재표시하고 체크를 반복하지 않는다. 후기 요약 세 동의는 독립 철회한다. 열람 철회는 본인의 열람만, 생성·노출 철회는 본인 프로필 요약 숨김·새 생성/갱신 중단, 원문 활용 철회는 본인이 쓴 기존·향후 후기의 AI 근거 제외와 영향 요약 우선 숨김이다. 다른 두 동의는 자동 철회하지 않는다. 남은 허용 공개 텍스트3개 이상과 대상자 생성·노출 동의·현재 공개/전송 조건을 충족할 때만 재생성·공개하며 부족·미확인·실패 시 숨김을 유지한다. 계정·일반 동행·일반 후기 원문·별점·당도는 AI 철회만으로 바꾸지 않는다. AI 처리용 복제본·외부 사본·관련 생성물의 필요한 삭제는 실제 확인 전 완료로 표시하지 않는다.

현재 기존 계정은 모두 테스트 계정이므로 테스트에서는 동의 완료로 간주한다. 이 가정을 실제 동의 증거 생성·DB 동의 값 변경·외부 전송 승인으로 사용하지 않는다. AI 미동의를 이유로 가입을 거부하거나 일반 동행·계정을 차단하지 않고 미동의 항목에 해당하는 AI 기능만 제한한다. 선택 동의의 법적 분류·문구·공급사 조건 확인과 회원 원문 외부 전송 보류를 유지한다. 이번 문서는 최신 정책의 요구사항을 동기화한 것이며 아래 기존 RPC의 인자·반환형·버전을 변경하거나 새 세분화 동의 저장·열람 차단·삭제가 현재 서버에 구현됐다고 뜻하지 않는다. 현재 구현과 정책 차이는 민규가 별도 확인·설계·구현·검증해야 한다.

운영 보관 선택은 일반 진단 30일·보안 90일·작업 종료 후 세부 기록 30일·공급사 한도 기간 종료 후 비용 원장 90일이다. 원문·비밀값을 제외한다. 미정산 예약은 해결까지 제한 보관하고 자동 환불·초기화를 하지 않는다. 중복방지 최소키는 재요청 가능기간에 맞춘 별도 삭제 조건을 검증한다. 법적 근거·실제 삭제·백업 만료는 별도 확인이며 활성 자료 삭제를 백업 즉시 삭제로 안내하지 않는다.

기존 분쟁 변경 trigger가 요약을 일괄 무효화하는 경우 현재 정책과 대조해야 한다. 신고·검토 개시만으로 이미 공개된 후기를 숨기지 않으며, 운영자의 임시 비공개 결정 또는 실제 근거의 공개 적격성 변화가 요약 숨김·재생성의 기준이다. 이번 문서 수정은 trigger 변경을 포함하지 않는다.

현재 source/게시의 processingAllowed 등 기존 필드·기술 signature는 유지한다. 최신 정책에서는 처리 대상자의 생성/노출 동의와 각 원문 작성자의 활용 동의를 생성·게시 전에 확인하고, 공개 조회 때 열람 회원의 별도 열람 동의를 확인해야 한다. 기존 DB가 이 세 상태를 표현·강제하는지는 별도 대조·구현·검증 대상이며 문서 갱신만으로 현재 RPC 응답이 변경됐다고 안내하지 않는다.
