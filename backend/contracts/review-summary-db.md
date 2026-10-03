# 공개 후기·요약 DB 연결 구현

## 개인 완료·후기 제출과 실제 완료의 경계

예상 종료 후 본인 완료 확인을 마친 당사자는 상대방 완료를 기다리지 않고 후기를 제출할 수 있다. 한 명만 확인한 상태는 동행 전체 완료가 아니며 해당 후기는 비공개다. 두 사람 확인 또는 예상 종료+24시간 자동 처리(취소·불발·분쟁 제외)로 실제 완료한다. 지연 처리면 실제 성공 시각을 완료 시각으로 기록한다. 실제 완료부터 작성 마감 7일·한쪽 후기 공개 24시간을 계산하며 양쪽 제출은 완료 조건 충족 후 즉시 공개한다. 완료 횟수는 실제 완료 즉시, 당도는 상대 후기 열람 가능 시 반영한다.

20261002110000_completion_review_policy.sql이 개인 확인 후 선제 제출·미완료 비공개와 실제 완료+24시간 조건을 구현한다. 현재 추가 변경은 이 공통 적격성 검사를 보존한다. 앞 단계와 이번 워커의 실제 검증 결과는 총괄 인계에서 구분한다.

현재 적용할 서비스 정책은 [정책.md](../../정책.md)를 따른다. 한쪽 후기 공개는 **실제 동행 완료 시각 +24시간**, 양쪽 제출은 즉시다. 당도는 상대 후기를 열람할 수 있게 될 때 동시에 반영하고, 완료 횟수는 후기와 관계없이 동행 완료 즉시 반영한다. 당도 산식은 민규·팀 검토 필요다. 아래 RPC·구현·검증 기록과 정책의 확정은 구분하며, 이번 문서 동기화에서 코드·DB·화면의 최신 정책 일치 여부는 검증하지 않았다. [반영 확인 작업](../../정책.md#follow-ups)을 확인한다.

최초 저장소는 민규 담당이며 이번 정책 변경만 사용자 승인 하네스의 담당 경계 예외를 적용한다. `20260923092000_review_summary_storage.sql`은 기존 후기에서 공개 입력을 별도 허용하고, 버전이 일치하는 요약만 게시·열람하는 저장소를 구현한다. AI 모델 실행·출력 내용 검증·작업 큐 연결·후기 공개 스케줄러는 포함하지 않는다. 원본 후기의 작성자·약속·위치는 snapshot에 포함하지 않는다.

## 실제 RPC

모든 인수는 PostgREST의 이름 그대로 전달한다. 반환은 JSON 객체이며 공통 HTTP envelope는 어댑터에서 덧붙인다.

| RPC / 호출자 | 인수 | 반환 |
|---|---|---|
| `set_review_publication` / service_role | `p_review_id:uuid, p_is_public:boolean` | void |
| `load_public_review_snapshot` / service_role | `p_profile_id:uuid` | `{profileId,sourceRevision,reviews:[{reviewId,text}],eligibleCount}` |
| `publish_review_summary` / service_role | `p_profile_id:uuid, p_source_revision:text, p_evidence_review_ids:uuid[], p_summary:text, p_model_version:text, p_prompt_version:text` | `{summaryId,sourceRevision,sourceCount,publishedAt}` |
| `get_visible_review_summary` / authenticated | `p_profile_id:uuid` | `{summary:null}` 또는 `{summary:{summaryId,text,sourceCount,updatedAt}}` |

`sourceRevision`은 DB bigint를 문자열로 직렬화한다. 호출자는 산술 계산하지 않고 snapshot에서 받은 불투명 문자열을 그대로 돌려준다. 모델·프롬프트 버전은 영문·숫자·점·밑줄·하이픈으로 이루어진 1~64자 표식(`^[A-Za-z0-9_.-]{1,64}$`)이다. 작업 큐의 modelVersion/promptVersion과 동일한 규칙이다. 요약문 1~4000자는 저장소의 기술 상한이다. 모델·운영 예산을 결정하지 않는다.

## 공개 허용과 남은 정책 연결

- 기존 `released`는 상대방 평가 열람용이므로 공개 프로필 사용 승인이 아니다. 별도 `private.review_publication` 행이 없으면 비공개다. 기존 데이터 자동 공개·backfill은 없다.
- 신뢰된 서비스가 공개 정책을 확인한 뒤 `set_review_publication`을 호출한다. 일반 회원·익명은 호출할 수 없다. 이 RPC를 그대로 외부 사용자용 endpoint로 노출하지 않는다.
- 현재 적용할 공개 정책: 양쪽 후기를 제출하면 완료 후 24시간 전이어도 즉시 공개한다. 한쪽만 제출하면 실제 동행 완료 시각 +24시간부터 공개하고, 그 이후 작성 기한 안에 제출한 후기는 즉시 열람할 수 있다. 미완료·실제 분쟁·불발/노쇼는 제외하며 수동 완료는 양측 완료 확인을 요구한다. 일반 후기 작성 기간은 실제 완료 시각부터 7일이다. 분쟁 중 작성·기한·공개 보류, 동행 인정 후 남은 기간 재개·최소 24시간 보장의 기존 예외는 유지한다. policy 행은 is_public 정리 여부와 무관하게 조회에서 새 조건을 적용한다. snapshot·요약 게시·열람·칭찬 집계도 같은 적격성을 검사하며 override 숨김과 후보 없는 과거 후기의 비공개는 유지한다. 양쪽 제출/7일 경과의 옛 공개 gate를 재사용하지 않는다.
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

## 작업별 원자 요약 — 20261002130000

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
