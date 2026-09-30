# 공개 후기·요약 DB 연결 구현

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
- 2026-09-29 후속 정책: 양쪽 후기를 제출하면 완료 알림 기준 24시간 전이어도 즉시 공개한다. 한쪽만 제출하면 완료 알림 확인 가능 시각 +24시간부터 공개하고, 그 이후 작성 기한 안에 제출한 후기는 즉시 열람할 수 있다. 미완료·실제 분쟁·불발/노쇼는 제외하며 수동 완료는 양측 완료 확인을 요구한다. 일반 후기 작성 기간은 실제 완료 시각부터 7일이다. 분쟁 중 작성·기한·공개 보류, 동행 인정 후 남은 기간 재개·최소 24시간 보장의 기존 예외는 유지한다. policy 행은 is_public 정리 여부와 무관하게 조회에서 새 조건을 적용한다. snapshot·요약 게시·열람·칭찬 집계도 같은 적격성을 검사하며 override 숨김과 후보 없는 과거 후기의 비공개는 유지한다. 양쪽 제출/7일 경과의 옛 공개 gate를 재사용하지 않는다.
- 명시 공개 허용 이후에도 snapshot·게시·열람에서 현재 적격성을 재확인한다. 한마디가 없는 후기와 비공개 후기는 3개 기준에 넣지 않는다.
- 최초 저장소 migration은 완료 이력을 바꾸지 않는다. 현재 후속 정책은 건별 자동 완료 예약과 제출·조회 공개 조건을 적용하며 과거 이력을 일괄 공개하지 않는다. 공개 정리·요약 등록 분리는 [자동화 계약](review-automation-db.md)을 따른다. 실제 검증은 [새 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-review-policy-handoff.md)에 한정한다.

## 원자성·실패

동일 프로필의 상태 행 잠금이 source 변경 트리거·snapshot·게시·열람을 직렬화한다. 후기 추가·수정·삭제, 공개 gate 변경, 약속 변경·삭제, 완료 확인 행 변경, 분쟁 변경은 같은 트랜잭션에서 revision 증가와 현재 요약 연결 해제를 수행한다. 양쪽 프로필은 UUID 순으로 잠근다. 조회 때도 현재 전체 적격 ID와 텍스트의 fingerprint를 다시 계산하므로 시간 경과와 예외적인 상위 관계 변경도 오래된 요약을 노출하지 않는다. 변경 후 자동 재요약 enqueue는 아직 연결하지 않았다.

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
