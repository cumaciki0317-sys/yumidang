# 후기 공개·재요약 자동화 DB 계약

현재 정책 변경: `20260929120000_review_release_and_completion_reservations.sql`. 기존 `20260923101000_review_automation.sql`은 이력으로 보존한다. 이번 사용자 승인으로 하네스 범위 안 담당 경계 예외를 적용하며 실제 실행 결과는 [새 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-review-policy-handoff.md)를 따른다.

## 공개 기준과 보존

기존 후기를 일괄 공개하지 않는다. 기존 `review_publication` 행은 `publication_source=override`로 보존한다. 이후 제출된 후기는 `policy`, `is_public=false`의 명시적 공개 후보로 등록된다. 사용자에게 새 선택 동의를 요구하는 정책을 추가하지 않는다.

양쪽 후기를 제출하면 완료 알림 기준 24시간 전이어도 즉시 공개한다. 한쪽만 제출하면 완료 알림 확인 가능 시각 +24시간부터 공개하고, 그 이후 작성 기한 안에 제출한 후기는 즉시 열람할 수 있다. 미완료·실제 분쟁·불발/노쇼는 제외하며 수동 완료는 양측 완료 확인을 요구한다. 일반 후기 작성 기간은 실제 완료 시각부터 7일이다. 분쟁 중 작성·기한·공개 보류, 동행 인정 후 남은 기간 재개·최소 24시간 보장의 기존 예외는 유지한다. 한쪽 7일 대기와 양쪽 24시간 대기 조건은 제거한다. 기존 policy 대기 후기에도 적용하며 당사자 열람·공개 프로필·칭찬·AI 입력 적격성이 같은 공개 조건을 따른다. policy 행은 is_public 정리 배치가 아직 실행되지 않아도 조회 시 현재 조건으로 판단한다. 명시적 override 숨김과 공개 후보가 없는 과거 후기는 보존한다. 한마디 없는 공개 평가는 칭찬 집계에 포함하고 AI 입력에는 제외한다.

`set_review_publication(p_review_id,p_is_public)`은 기존 서비스 역할 전용 호출이며 명시적 `override`로 저장한다. 한 번 숨긴 후기는 이후 자동화가 다시 공개하지 않는다. 조회마다 현재 완료/분쟁/시간 조건도 확인해 과거 공개 플래그가 현재 공개를 보장하지 않는다.

## 후기 작성과 조회

`submit_appointment_review(p_appointment_id uuid,p_rating integer,p_comment text,p_experience text,p_praises text[]) -> jsonb`

- 인증된 당사자만, 완료 후 작성 기한 안에서 제출한다. 보류 중 작성 가능, 분쟁 중 불가.
- 경험은 `positive/neutral/negative`, 별점 1~5, 선택 한마디 300자, 칭찬은 positive만 최대 3개·중복 불가.
- 성공 응답 `{reviewId,submittedAt,deduplicated}`. 정확히 같은 요청의 재시도는 기존 결과, 다른 값 재제출은 `23505`이다. 세 인자 구형 RPC는 경험 선택을 우회하므로 실행 권한을 회수했다.
- 칭찬 버튼 실제 목록은 미확정이다. `private.review_praise_catalog`는 기본 비어 있고 임의 운영 단어를 만들지 않았다. 빈 선택은 정상, 미등록 단어는 `22023`이다. 제품 목록 확정 후 민규 DB 구성 변경이 필요하다. 테스트 단어는 롤백 fixture에만 존재한다.

`get_appointment_review_state`의 기존 응답 형식을 유지하고 own/peer JSON에 experience/praises를 포함한다. 당사자 사이 released와 제3자 공개 권한의 저장 경계는 유지하되 공개 시점 조건은 동일하다. override 숨김·공개 후보 여부 등의 추가 제3자 권한 조건은 별도로 적용한다.

`get_public_profile_reviews(p_profile_id uuid,p_limit integer,p_before uuid default null)`는 로그인 회원만 호출한다. `{reviews,praisesTop5,nextCursor}`를 반환한다. 리뷰는 `{reviewId,rating,experience,text,praises,submittedAt}`이고 작성자 실명/ID는 반환하지 않는다. 칭찬은 `{code,label,count}` 상위 5개·실제 횟수이며 페이지가 아닌 전체 공개 평가를 집계한다. UUID 내림차순 커서는 결정적 페이지 분할을 위한 것으로 작성 날짜순을 의미하지 않는다. 범위 1~100, 익명 실행 금지. 당도 산식은 구현하지 않는다.

## 같은 트랜잭션의 변경 기록과 작업 등록

공개 후기 원문/공개 상태/완료/확인/분쟁 변경은 기존 BEFORE trigger에서 projection revision 증가·요약 무효화와 `private.review_refresh_outbox` 기록을 함께 수행한다. outbox는 profile별 최신 처리 필요를 합쳐 보관하며 후기 원문이나 대화 내용을 저장하지 않는다. 트랜잭션 실패 시 모두 롤백된다.

`process_due_review_publications(p_limit integer)`는 모델 설정 없이 공개 정리만 수행하고 `{publishedCount}`를 반환한다. `process_review_summary_refresh(p_limit integer,p_model_version text,p_prompt_version text)`는 outbox 소비·요약 작업 등록만 수행하며 `{processedCount,enqueuedCount}`를 반환한다. 모두 service_role 전용이고 limit는 1~1000이다. 요약 버전은 명시적 1~64자 `[A-Za-z0-9_.-]` 필수이며 가짜 기본값을 넣지 않는다. 기존 `process_review_automation`은 호환용 합성 wrapper로 세 count를 반환한다. 공개는 제출·조회 조건에 따라 즉시 적용되며, 요약 등록의 하루 한 번 주기가 공개를 지연시키지 않는다.

1. 공개 정리 RPC가 약속 행을 `SKIP LOCKED`로 점유해 policy 후보의 공개 조건을 확인한다. 이 단계에는 모델/프롬프트 버전이 필요 없다.
2. 별도 요약 등록 RPC는 profile projection을 먼저 잠근 뒤 최신 snapshot/revision을 계산한다. source 작성과 동일한 projection→outbox 순서로 잠근다.
3. 공개 비어 있지 않은 텍스트가 3개 이상이면 기존 `enqueue_job`에 `review_summary`와 `{profileId,sourceRevision,modelVersion,promptVersion}`을 넣는다. dedupe key에도 네 값을 포함한다. 원문은 작업 payload에 넣지 않는다.
4. 등록 성공 또는 3개 미만이면 해당 outbox를 제거한다. 실패하면 전체 트랜잭션이 롤백되어 유실되지 않는다. 읽기에서 시간 경과를 발견한 refresh도 같은 outbox를 만든다.

오래된 이미 등록된 작업은 물리 삭제하지 않는다. 워커는 실행 전 최신 snapshot을 읽고 revision을 대조해야 하며 `publish_review_summary`가 stale 결과 게시를 차단한다. 모델 버전만 바꾸었을 때 모든 profile 재처리 요청은 이번 API가 자동 추정하지 않는다.

## 검증과 남은 연결

`tests/database/minkyu/review_release_policy.sql`은 양쪽 24시간 전 즉시 공개·한쪽 24시간 경계·이후 제출·7일 작성 마감·분쟁/불발·기존 policy/override·예약 무효화와 실행을 검사한다. `review_automation.sql`과 `review_summary_storage.sql`은 공개·요약·권한 회귀를 검사한다. 파일 존재를 PASS로 해석하지 않으며 실제 실행 결과는 새 인계를 따른다.

후기 공개 정리와 요약 등록은 내부 HTTP에서 분리 호출한다. 자동 완료는 건별 예약 실행기 계약을 따른다. 행사 갱신·AI 후기 요약 등록 주기는 하루 한 번으로 확정했지만 실제 일일 스케줄러 배포·모델 생성·게시 연결은 이번에 실행하지 않는다. 실제 모델 품질·외부 로그 보관·분쟁 판정 정책·칭찬 버튼 목록은 별도 확인 사항이다.
