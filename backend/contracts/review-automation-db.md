# 후기 공개·재요약 자동화 DB 계약

## 현재 기준과 적용 범위

현재 기준은 [정책.md](../../정책.md)다. 아래에서 현재 정책 목표와 기존 기술 인터페이스를 구분한다. 이번 문서 동기화는 서버 코드·SQL·설정·DB·외부 호출·배포를 변경하거나 검증하지 않았다.

예상 종료 후 본인 완료 확인을 마친 사람은 상대 확인 전에도 후기를 제출할 수 있으나 실제 완료 전에는 비공개다. 양쪽 확인 또는 예상 종료+24시간에 실제 완료하며 취소·노쇼는 제외하고 신고·분쟁 검토 중에는 보류한다. 지연 시 실제 성공 시각이 완료 시각이다. 작성 마감은 실제 완료부터 7일, 양쪽 제출은 실제 완료 후 즉시 공개, 한쪽 제출은 작성 기한 종료 시 공개한다. 완료 횟수는 실제 완료 즉시, 후기 당도는 상대 열람 가능 시 반영한다.

검토 중에는 작성·기한 진행·새 공개를 보류한다. 이미 공개된 후기는 접수만으로 숨기지 않고 운영자가 임시 비공개를 결정한 때 숨긴다. 정상 동행 인정 후 원래 종료+24시간이 지났으면 즉시 실제 완료한다. 첫 완료라면 그때부터 작성 7일, 이미 완료했다면 남은 기한을 재개하되 최소 24시간을 보장한다. 재개 후 양쪽 제출이면 공개하고 한쪽이면 재개·연장된 작성 기한 종료에 공개한다.

아래 RPC 형식은 기존 연결이다. 공개 predicate·검토 처리·당도·탈퇴 처리의 현재 정책 충족은 후속 변경·검증 대상으로 구분한다.

## 개인 확인·실제 완료·작성 기한

예상 종료 후 본인 완료 확인을 한 당사자는 confirmed 상태에서 상대 확인을 기다리지 않고 후기를 제출할 수 있다. 동행 전체는 아직 미완료이므로 그 후기는 비공개다. 이때 후기 상태의 appointment_completed=false, deadline_at=null, released=false를 반환한다. 본인이 아직 확인하지 않았거나 예상 종료 전이면 can_write=false이며 신규 제출은 22023이다.

양쪽 확인 또는 예상 종료+24시간 자동 처리로 실제 완료하며, 취소·실제 분쟁·불발/노쇼는 제외한다. 지연 처리는 실제 성공 시각을 completed_at에 기록하고 재실행으로 바꾸지 않는다. 기존 완료 RPC·건별 예약 처리·generation 검사는 그대로 사용한다.

실제 완료 후 일반 작성 마감은 completed_at+7일이다. 실제 분쟁은 작성·공개를 보류하고, 동행 인정 후 남은 작성 기간을 재개하며 최소 24시간을 보장하는 기존 review_deadline_at 처리를 유지한다. 개인 확인·알림·후기 제출로 작성 마감을 다시 계산하지 않는다. 완료 뒤 자동 처리인 경우 개인 확인이 없어도 실제 완료 기록을 근거로 작성할 수 있다. manual 완료는 양쪽 실제 확인을 요구한다.

private.can_submit_appointment_review(appointmentId,userId,serverAt)가 제출 RPC와 상태 조회의 같은 자격을 계산한다. serverAt은 실제 RPC 내부 서버 시각이며 사용자 입력으로 제공하지 않는다. public.review_submission_open의 기존 네 인자 helper와 분쟁 재개 기한도 유지한다.

## 후기 제출과 칭찬 목록

`submit_appointment_review(p_appointment_id uuid,p_rating integer,p_comment text,p_experience text,p_praises text[]) -> jsonb`

- experience는 positive/neutral/negative, rating은 1~5, 선택 comment는 기존 300자 제약이다.
- 칭찬은 positive에서만 0~3개, 1차원 배열·중복/NULL 없음·현재 등록 코드만 허용한다. neutral/negative에서 칭찬을 보내면 22023이다.
- 성공은 `{reviewId,submittedAt,deduplicated}`다. 성공 후 같은 요청은 기존 결과를 반환하고 값이 달라지면 23505다. 성공한 요청의 정확한 재시도는 이후 기한·상태·칭찬 목록 변경으로 실패하지 않는다. 기존 비활성 코드도 동일한 저장 결과의 재시도만 허용한다.
- 구형 세 인자 RPC 실행과 후기 테이블 직접 읽기/쓰기는 회수된 상태를 유지한다. 다른 참가자가 아닌 사용자에게는 PT404를 반환한다.

`get_review_praise_catalog() -> {items:[{code,label}]}`는 authenticated 일반 세션과 기존 본인 profile을 요구한다. anon·service_role의 직접 실행, private 칭찬 테이블 직접 접근은 허용하지 않는다. HTTP는 `GET /reviews/praises`다.

| 기술 코드 | 표시 문구 |
|---|---|
| punctual | 시간을 잘 지켜요 |
| keeps_promises | 약속한 내용을 지켜요 |
| communicates_well | 소통이 원활해요 |
| considerate | 배려심이 있어요 |
| enjoyable_conversation | 대화가 즐거워요 |
| comfortable_companion | 함께하니 편안해요 |

기존 private.review_praise_catalog를 재사용한다. 기존 코드/후기 행을 삭제하지 않고 is_active/display_order를 추가하며 확정 6개를 신규 선택 목록으로 활성화한다. 이전 코드가 있는 과거 공개 평가는 원래 label로 집계할 수 있다. 코드 이름과 정렬 컬럼은 기술 구현이며 표시 문구는 사용자 확정 정책이다.

## 공개 기준·override·상대 열람

private.review_release_ready는 실제 완료 근거와 현재 작성 기한 종료 또는 양쪽 제출을 판정해야 한다. 한쪽 공개는 분쟁 재개·연장된 기한도 반영한다. 알림 클릭·개인 확인·제출 시각은 공개 시계를 바꾸지 않는다. 취소·노쇼·미완료 제외와 검토 중 새 공개 보류, 이미 공개된 후기의 운영자 임시 숨김을 분리하도록 기존 구현을 대조한다.

private.is_review_public_eligible(reviewId)는 같은 공개 시점에 더해 실제 당사자 후기 여부와 private.review_publication의 공개 근거를 확인한다. policy 후보는 공개 정리 배치 이전에도 시간 조건으로 공개되며, 명시적 override 숨김과 공개 후보 행이 없는 과거 후기는 공개하지 않는다. override 공개도 현재 완료·분쟁·시간 조건을 우회하지 않는다. 제출 후보는 기존 AFTER INSERT trigger가 policy/is_public=false로 원자 등록한다. 과거 행을 일괄 새 후보로 만들지 않는다.

`get_appointment_review_state`는 기존 snake_case 12개 table 컬럼을 유지한다: appointment_id, appointment_completed, deadline_at, hold_until, disputed, can_write, own_review, peer_submitted, released, release_reason, peer_review, server_now. own_review는 본인 저장 내용을 반환하며 peer_review는 해당 상대 후기의 공통 공개 적격성을 만족할 때만 반환한다. 따라서 상대 후기의 override 숨김도 우회하지 않는다. released는 그 상대 내용을 열람할 수 있는지 나타내고, peer_submitted는 제출 사실만 나타낸다. hold_until은 기존 이의 기간 정보이며 공개 시계는 completed_at이다.

당사자 상대 열람·공개 프로필·칭찬·AI 요약 원문은 같은 적격성을 사용한다. 한마디 없는 공개 평가는 칭찬 집계에는 포함하고 AI 원문에서는 제외한다. 직접 RLS/table 권한을 열어 이 조건을 우회하지 않는다.

## 공개 프로필·완료 횟수·당도

`get_public_profile_reviews(p_profile_id uuid,p_limit integer,p_before uuid default null)`는 기존 `{reviews,praisesTop5,nextCursor}`에 **completedCount**를 추가한다. 로그인 회원만 호출하고 limit의 기존 기술 범위는 1~100이며 화면은 5개씩 요청한다. 리뷰는 reviewId/rating/experience/text/praises/submittedAt이며 작성자 실명·ID를 반환하지 않는다. UUID 내림차순 커서는 결정적인 분할 기준이고 작성 날짜순 약속이 아니다. 칭찬 상위 5개는 페이지와 관계없이 모든 적격 공개 평가에서 code/label/count를 실제 집계한다.

completedCount는 평가 개수와 독립적이다. 실제 completed_at이 있고 status가 completed 또는 disputed인 약속에 본인이 작성자/신청자로 참여한 기록을 distinct appointment_id로 센다. 일시적인 실제 분쟁 공개 보류는 완료 이력을 지우지 않는다. cancelled/no_show/confirmed와 no_show 판정은 제외한다. 후기 미제출·비공개·override 숨김·양쪽 후기 중복으로 완료 횟수가 바뀌지 않는다. private.completed_appointment_count가 이 조회 계산을 담당하며 새 숫자를 별도 누적하거나 과거 완료 시각을 변환하지 않는다.

당도 산식은 정책 7-4절에 확정됐다. 초기 15, 반응 좋아요 +1·보통 0·별로 −2와 별점 1~2점 −2·3점 0·4~5점 +1을 합산한다. 완료 횟수·칭찬은 가산하지 않는다. 취소 제재 −2·노쇼 −3·중대 위반 −10이며 같은 사건의 운영 감점은 가장 큰 하나만, 유효 후기 기여와는 합산한다. 무효 동행의 후기 기여는 제외한다. 전체 유효 기여를 합한 뒤 표시만 0~100 정수로 제한하며 원 기여를 남겨 정정한다. 임시 후기 숨김은 반영 당도를 유지하고 최종 무효 때 제외한다. 정책 확정과 실제 점수 저장·계산기 연결은 별개다.

## revision·outbox·작업 처리 보존

기존 BEFORE trigger는 후기·공개 상태·완료 확인·약속·분쟁 변경 시 두 당사자 projection을 UUID 순서로 잠그고 revision 증가·기존 요약 무효화·private.review_refresh_outbox 기록을 같은 트랜잭션으로 처리한다. outbox와 작업 payload에 후기 원문·회원 대화를 저장하지 않는다. 새 선제 후기의 실패도 후보·revision·outbox까지 함께 롤백된다. 완료 처리와 요약 읽기의 잠금 순서를 바꾸지 않는다.

`process_due_review_publications(p_limit)`은 공개 정리만, `process_review_summary_refresh(p_limit,p_model_version,p_prompt_version)`은 outbox 소비·요약 작업 등록만 수행한다. 모두 service_role 전용이며 기존 1~1000 한도·명시 버전 검증을 유지한다. 공개는 이 배치/모델 실행을 기다리지 않고 공통 predicate로 계산한다. 구 process_review_automation은 호환 wrapper로 보존한다.

기존 private.review_summary_sources를 공통 적격성에 연결한다. 공개 텍스트가 3개 이상일 때 기존 enqueue_job의 profile/revision/model/prompt별 dedupe로 등록하고, 워커의 최신 snapshot 검증과 publish_review_summary의 오래된 revision 차단을 유지한다. 시간 경과를 읽기에서 발견하면 기존 refresh가 fingerprint/revision/outbox를 갱신한다. 기존 override 숨김은 자동화가 다시 공개하지 않는다.

## 검증·운영 한계

이번 SQL 검사는 개인 확인 전/후 선제 작성·실제 완료 전 비공개, 완료 조건 충족 후 양쪽 즉시/한쪽 작성 기한 종료 경계, 7일 작성 마감과 지연 자동 처리, 분쟁/노쇼/취소, 칭찬 목록/중복/unknown, override 숨김의 peer/프로필/칭찬/AI 경로, 완료 횟수와 공개 지표 분리, 원자 롤백·동일 재시도·직접 권한 차단을 확인한다. 실제 결과와 NOT_RUN은 이번 인계에 구분한다.

새 평가 UI·실제 브라우저·모델 생성·원격 DB/운영 배포, 확정 당도·분쟁 정책의 코드 반영 검증은 별도다. 예약 실행기와 하루 한 번 요약 작업 등록의 기존 구현·운영 연결을 파일 존재만으로 성공이라 설명하지 않는다.

기존 분쟁 변경 trigger가 요약을 일괄 무효화하는 경우 현재 정책과 대조해야 한다. 신고·검토 개시만으로 이미 공개된 후기를 숨기지 않으며, 운영자의 임시 비공개 결정 또는 실제 근거의 공개 적격성 변화가 요약 숨김·재생성의 기준이다. 이번 문서 수정은 trigger 변경을 포함하지 않는다.
