# 공개 후기·요약 DB 연결 구현

## 현재 정책과 구현 경계

현재 기준은 [정책.md](../../정책.md)다. 아래에서 현재 정책 목표와 기존 기술 인터페이스를 구분한다. 이번 문서 동기화는 서버 코드·SQL·설정·DB·외부 호출·배포를 변경하거나 검증하지 않았다.

예상 종료 후 본인 완료 확인을 마친 사람은 상대 확인 전에도 후기를 제출할 수 있으나 실제 완료 전에는 비공개다. 양쪽 확인 또는 예상 종료+24시간에 실제 완료하며 취소·노쇼는 제외하고 신고·분쟁 검토 중에는 보류한다. 지연 시 실제 성공 시각이 완료 시각이다. 작성 마감은 실제 완료부터 7일, 양쪽 제출은 실제 완료 후 즉시 공개, 한쪽 제출은 작성 기한 종료 시 공개한다. 완료 횟수는 실제 완료 즉시, 후기 당도는 상대 열람 가능 시 반영한다.

검토 중에는 작성·기한 진행·새 공개를 보류한다. 이미 공개된 후기는 접수만으로 숨기지 않고 운영자가 임시 비공개를 결정한 때 숨긴다. 정상 동행 인정 후 원래 종료+24시간이 지났으면 즉시 실제 완료한다. 첫 완료라면 그때부터 작성 7일, 이미 완료했다면 남은 기한을 재개하되 최소 24시간을 보장한다. 재개 후 양쪽 제출이면 공개하고 한쪽이면 재개·연장된 작성 기한 종료에 공개한다.

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

게시 시 revision 일치·3개 이상·중복 없는 전체 근거 ID 집합 일치를 모두 요구한다. 동일 프로필·revision·모델/프롬프트 버전 중복 요청은 최초 저장 결과를 반환하고 본문을 덮어쓰지 않는다. 근거 ID 검사는 내용의 사실성·민감정보 제거 검증을 대체하지 않는다. 종현 워커가 생성 결과를 검증한 후 호출해야 한다.

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

탐색 AI와 후기 AI를 구분해 가입 시 각각 필수 동의를 받으려는 제품 의도를 유지한다. 가입 후 철회 요청을 접수하면 해당 처리의 신규 전송을 중단하고 관련 요약 숨김·필요한 원문/외부 사본 삭제를 처리하며 일반 동행·계정은 유지한다. 필수화와 철회 처리의 법적 정합성은 검토 대기다. 확인 전 관련 가입 차단·외부 전송을 시행하지 않는다. AI 화면 설명을 제공하고 별도 첫 이용 팝업은 추가하지 않는다.

운영 보관 선택은 일반 진단 30일·보안 90일·작업 종료 후 세부 기록 30일·공급사 한도 기간 종료 후 비용 원장 90일이다. 원문·비밀값을 제외한다. 미정산 예약은 해결까지 제한 보관하고 자동 환불·초기화를 하지 않는다. 중복방지 최소키는 재요청 가능기간에 맞춘 별도 삭제 조건을 검증한다. 법적 근거·실제 삭제·백업 만료는 별도 확인이며 활성 자료 삭제를 백업 즉시 삭제로 안내하지 않는다.

기존 분쟁 변경 trigger가 요약을 일괄 무효화하는 경우 현재 정책과 대조해야 한다. 신고·검토 개시만으로 이미 공개된 후기를 숨기지 않으며, 운영자의 임시 비공개 결정 또는 실제 근거의 공개 적격성 변화가 요약 숨김·재생성의 기준이다. 이번 문서 수정은 trigger 변경을 포함하지 않는다.
