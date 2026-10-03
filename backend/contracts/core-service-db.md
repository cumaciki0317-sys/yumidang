# 핵심 업무 DB 연결 — 민규

## 기준과 적용 파일

현재 정책은 [정책.md](../../정책.md)의 무료 공고·신청·양쪽 최종 동의를 따른다. 기존 `20260923102000_core_service_api.sql`의 서비스 경로와 일정 잠금을 재사용하고 `20261002100000_matching_lifecycle.sql`에서 공고 수정·수동 마감·삭제와 동의 요청 생명주기를 추가한다. 기존 SQL과 과거 신청·약속·동의는 보존한다. 네이버 자격·실제 Auth 세션·사진 완료는 `20261002090000_naver_signup.sql`의 게이트를 사용한다.

파일 작성과 실제 로컬 검증·정식 Git 반영·원격 DB 적용은 구분한다. 최신 실행 결과는 [민규 현황](../../docs/collaboration/minkyu.md)과 [이번 인계](../../docs/collaboration/requests/minkyu/2026-10-02-matching-lifecycle-handoff.md)에 기록한다. 운영 배포·실제 네이버 공급사·브라우저 화면 연결은 이 DB 작업의 검증 범위가 아니다.

## RPC와 반환

사용자 RPC는 authenticated 세션의 `auth.uid()`를 사용한다. 사용자 ID를 입력으로 받지 않는다. 원문 DB 오류는 HTTP로 공개하지 않고 [서비스 API](service-api.md)의 envelope와 오류 코드로 변환한다.

| RPC | 인수 | 반환 |
|---|---|---|
| get_my_profile | 없음 | userId, realName, avatarUrl, bio — 본인만 |
| get_public_profile | p_profile_id uuid | profileId, displayName, age, gender, avatarPath, bio, interests, conversationStyles, mbti, completedCount — 회원 공개 프로필 |
| create_service_post | p_post_id uuid, p_input jsonb | postId, alreadyCreated |
| get_service_post | p_post_id uuid | 공개 상세, updatedAt, recruitmentEndsAt, 권한이 있을 때 privateDetails/participantNames |
| update_service_post | p_post_id uuid, p_input jsonb, p_expected_updated_at timestamptz | postId, status, updatedAt |
| close_service_post | p_post_id uuid | postId, status:closed, updatedAt |
| delete_service_post | p_post_id uuid | postId, status:deleted, updatedAt |
| request_service_post | p_post_id uuid, p_message text | id, post_id, status, created_at, already_existed |
| withdraw_join_request / decline_join_request | p_request_id uuid | 기존 table 반환 id, status, updated_at |
| propose_match | p_request_id uuid | requestId, conditionVersion, conditions, status, requestedAt, expiresAt |
| get_match_consent | p_request_id uuid | 같은 동의 정보 또는 consent:null |
| withdraw_match_consent / decline_match_consent | p_request_id uuid, p_condition_version text | requestId, conditionVersion, status, alreadyEnded |
| accept_match | p_request_id uuid, p_condition_version text | appointmentId, postId, requestId, status, alreadyConfirmed |
| list_my_notifications | p_limit integer, p_before uuid/null | items(notificationId, kind, requestId, createdAt, readAt, eventData), nextCursor |
| list_conversation_messages | p_request_id uuid, p_limit integer, p_before uuid/null | items, nextCursor |
| send_conversation_message | p_request_id uuid, p_message_id uuid, p_content text | messageId, createdAt, alreadySent |
| set_my_profile_avatar | p_avatar_path text | 기존 avatar_url, previous_avatar_path |

`get_service_post`는 anon에도 허용하며 비로그인에게 시스템 별칭·공개 정보만 반환한다. 목록 limit는 1~100, 커서는 본인의 알림/해당 대화 메시지여야 한다. 미검증·자격 정보 누락 회원은 기존 조회·채팅 확인·신청 철회/거절·동의 철회/거절·공고 정리를 계속할 수 있다. 새 공고·신청·최종 동의 요청/수락과 공고 수정은 네이버 세션·자격·명시 가입 완료·사진을 검사한다.

내부 `expire_match_consents(p_limit integer default 100)`은 service_role만 실행하며 `{expiredCount}`를 반환한다. p_limit은 1~1000의 기술 처리 한도다. 만료가 지난 새 생명주기 행을 공고별로 잠그고 원자 종료·양쪽 알림을 처리한다. 운영 호출 주기·실행기 연결은 별도이며 이 RPC 존재만으로 백그라운드 운영을 완료했다고 설명하지 않는다. 사용자 동의 조회/제안/수락/종료도 해당 공고의 만료를 검사한다. SQL 예외가 나면 같은 호출 안의 만료 갱신도 롤백되므로, 독립 내부 처리 또는 다음 정상 조회가 종료 알림을 확정한다.

## 종현 공통 연결 — 2026-10-02 순차 작업 3단계

공개 프로필의 `get_public_profile(p_profile_id uuid)`는 authenticated·기존 서비스 프로필을 요구한다. 응답은 `{profileId,displayName,age,gender,avatarPath,bio,interests,conversationStyles,mbti,completedCount}`다. 본인이거나 확정/완료 동행 당사자 관계면 전체 이름, 나머지는 이름 마스킹이며 취소·분쟁은 전체 이름 공개 근거가 아니다. 성향은 기존 네이버 가입 마이그레이션의 `profile_traits`를 재사용한다. `get_my_profile`은 변경하지 않으며 본인 성향 전용 RPC도 유지한다. 대상 없음은 P0002/HTTP404, 인증 없음은28000/HTTP401이다.

내부 client는 예산 `reserve_ai_budget`, `settle_ai_budget`, 작업 `yield_job`, `fail_job`, `supersede_job`, 요약 `load_review_summary_source`, `load_review_summary_checkpoint`, `save_review_summary_checkpoint`, `discard_review_summary_checkpoint`, `mark_review_summary_insufficient`, `publish_review_summary_for_job`, 행사 `upsert_events`를 추가로 허용한다. 실제 SQL의 원자성·점유·revision·예산 단위는 [작업 DB](worker-jobs.md)와 [요약 DB](review-summary-db.md)의 연결 계약을 따른다. 원장 구성·조회용 운영 RPC는 HTTP 클라이언트 허용 목록에 추가하지 않는다.

회원·익명 client는 `list_public_events(p_filters jsonb,p_cursor jsonb,p_limit integer)`와 `list_event_filter_values()`를 허용한다. 내부 `upsert_events(p_events jsonb)`는 `{receivedCount,insertedCount,updatedCount,staleCount}`를 반환하고 공개 목록은 `{items,nextCursor}`, 필터 값은 `{regions:[{provider,value,count}],categories:[{provider,value,count}]}`다. HTTP는 종현 `createRpcEventRepository.listPage`와 `listEventFilterValues`를 재사용하여 이 DB 결과를 엄격 검사·불투명 커서로 변환한다. 기존 행사 후보 RPC와 별도 데이터베이스를 중복 생성하지 않는다.

서버 `.env.example`은 필수 변수 이름과 빈 값만 추가한다. 빈 내부 키·secret은 미설정으로 처리하여 공개/사용자 기능을 시작할 수 있고 내부 호출은 여전히503이다. 공통 필수 URL·anon 키·Origin·시간/크기 설정은 완화하지 않는다. AI 보관 결정·지출 근거·원장·안전 검사·운영 한도의 부재는 각 기능의 미준비 상태를 유지한다. 파일·허용 목록 연결은 실제 회원 원문 전송·외부 모델 성공·운영 배포 승인으로 확대하지 않는다.

## 공고 입력·관리와 개인정보

p_input은 기존 생성 입력과 같은 전체 교체 형식이다. 정확한 키는 title, description, category, startsAt, endsAt, recruitmentEndsAt, publicArea, registeredPlaceName, registeredAddress, meetingDetail, preferenceNote, tags, costType, amount다. registeredPlaceName/preferenceNote는 nullable, tags는 문자열 배열이다. HTTP는 생략한 선택값을 기본 형태로 채우며 recruitmentEndsAt 생략 시 startsAt을 사용한다. 명시 null 모집 마감은 받지 않는다. 무료 costType=free, amount=0만 지원한다. 기존 금액 미상 NULL을 무료로 추정하지 않는다. 기존 카테고리·문자 길이 제약은 기술 구현 값이며 새 제품 정책을 확정한 근거가 아니다.

생성은 공고·비공개 지점·등록 주소·최초 입력을 한 트랜잭션으로 저장한다. 동일 postId+최초 입력 재요청은 첫 결과를 반환하며 다른 최초 입력은 충돌이다. 최초 `private.service_post_inputs`는 생성 재시도 근거이므로 수정 때 덮어쓰지 않는다.

수정은 작성자만, 기존 확정 약속이 없고 시작 전일 때 허용한다. 조회한 updatedAt을 p_expected_updated_at으로 그대로 보내야 하며 다르면 40001 충돌이다. PostgreSQL timestamp의 최대 6자리 소수 정밀도를 보존한다. 새 updatedAt은 clock_timestamp()를 사용하여 같은 트랜잭션의 여러 수정도 구분한다. 일정·장소·제목·소개·카테고리 등 핵심 조건이 바뀌면 진행 중 동의를 invalidated로 종료하고 pending 신청자에게 알린다. 신청과 대화는 유지한다. 모집 마감만 변경하면 핵심 조건 동의를 무효화하지 않는다.

수동 마감은 recruiting→closed이며 새 신청만 막는다. 시작 전 기존 pending 신청자의 제안·재제안·수락은 closed 공고에서도 허용한다. 모집 마감 시각을 지나거나 closed 공고에 새 신청하면 STATE_CONFLICT다.

삭제는 status=deleted로 숨기며 pending 미확정 신청은 not_selected로 종료한다. 해당 관계의 동의 종료·양쪽 알림을 함께 처리하고 대화는 읽기 전용으로 보존한다. 삭제 재호출은 동일 결과다. 확정 약속 이력이 있고 약속 종료 시각 전이면 삭제를 차단한다. 공고 삭제로 확정 약속을 취소하지 않는다.

등록 주소는 private에 저장하고 검색 조건에만 사용한다. 작성자는 본인 입력을 관리하며 양쪽 확정/완료 관계만 정확한 주소·상세 지점과 양 당사자의 전체 이름을 읽는다. 취소·불발·분쟁 상태를 확정 관계로 판단하지 않는다. 취소 이후 상대는 다시 마스킹된 이름과 공개 지역만 받는다. 작성자의 본인 공고 입력 조회 권한은 유지하되 취소된 상대의 전체 이름을 participantNames에 포함하지 않는다. RLS의 companion helper에도 같은 상태 조건을 적용한다. 과거 혼합 exact_location은 자동 해석하지 않는다.

## 동의 상태·중복·일정 경쟁

작성자 제안은 최종 확정이 아니다. 새 동의는 무작위 conditionVersion으로 조건을 고정하고 `min(요청 시각+24시간, 동행 시작)`에 만료한다. 내부 fingerprint에는 장소를 포함하지만 외부로 반환하지 않으므로 비공개 장소 해시 추측에 사용되지 않는다.

`private.match_consent_lifecycle`은 새 요청의 request_id, post_id, condition_version, requested_at, expires_at, status, ended_at을 기록한다. status=awaiting_consent 행은 공고별 unique index로 한 개만 허용한다. 같은 유효 요청의 재제안은 기존 버전·만료 시각을 그대로 반환한다. 다른 신청자로 바꾸려면 먼저 철회한다. 종료 후 재제안은 새 버전·새 만료 시각을 만든다.

반환 status는 awaiting_consent, accepted, expired, withdrawn, declined, invalidated다. metadata가 없는 과거 미수락 동의는 renewal_required와 expiresAt:null을 반환하며 새 버전으로 재제안해야 수락할 수 있다. 과거 수락·확정 이력은 accepted로 조회하고 동일 확정 재요청은 첫 약속을 반환한다. 적용 때 과거 동의를 일괄 종료·자동 활성화하지 않는다.

작성자 withdraw_match_consent와 신청자 decline_match_consent는 해당 최종 동의만 종료하며 pending 신청·대화를 유지한다. 같은 버전의 같은 종료 재호출은 alreadyEnded:true다. 시간이 먼저 만료됐다면 expired를 반환한다. 다른 종료 사유·다른 버전·수락된 동의를 바꾸려는 요청은 충돌이다. 정보 누락 회원의 종료 처리에서는 자격 게이트가 걸린 원본 match_consents를 변경하지 않고 생명주기 metadata만 변경한다.

신청 자체의 withdraw_join_request는 withdrawn으로 보존하고 재신청은 새 행·새 대화로 만든다. decline_join_request는 declined이며 같은 공고 재신청을 금지한다. 최종 동의 거절과 신청 자체 거절은 별개다.

모든 관리·제안·수락·종료는 공고→신청 UUID 순서→동의 UUID 순서로 잠근다. 수락은 기존 양 당사자의 UUID 순서 advisory lock을 추가하여 다른 공고의 같은 사용자 최종 확정도 직렬화한다. 기존 confirmed 약속과 `[시작,종료)`가 겹치면 거절한다. 새로운 약속 생성·선정 신청 matched·공고 closed·양쪽 알림·미선정 pending의 not_selected 종료를 같은 트랜잭션으로 처리한다. 미선정 대화는 새 메시지를 받지 않으며 자동 대기자·재확정으로 바꾸지 않는다.

## 알림·채팅·사진

추가 알림 kind는 match_consent_ended, post_conditions_changed, post_deleted, match_not_selected다. eventData에는 상태·conditionVersion·expiresAt 등 안내에 필요한 안전한 값만 담는다. 원문 채팅·실명·정확한 주소를 넣지 않는다. private.match_lifecycle_events로 같은 이벤트의 재실행을 중복 방지한다. 기존 (recipient_id,kind,join_request_id) 유일키는 유지하며, 같은 관계에서 새 이벤트가 생기면 해당 알림의 created_at/read_at/event_data를 갱신하여 다시 안내한다. 따라서 알림 목록은 그 kind의 최신 안내이며 버전별 독립 알림 이력은 아니다. 페이지 이동 중 재알림 시 커서 앞쪽으로 이동할 수 있어 새로고침으로 최신 알림을 확인한다.

메시지는 참여자·전송 가능 상태와 요청 행 잠금을 확인한다. 같은 messageId/내용의 재전송은 첫 결과를 반환하며 내용을 바꾸면 충돌이다. withdrawn/declined/not_selected 또는 삭제 공고의 대화는 읽기 전용이다. 직접 INSERT 권한은 회수된 상태를 유지한다. AI 탐색 대화는 별도 화면 메모리 정책이며 이 회원 간 메시지 저장과 혼동하지 않는다. 운영자의 채팅 원문 열람 API는 추가하지 않는다.

사진 교체는 본인 profile과 새 Storage object를 잠근 뒤 기존 JPEG·소유 조건을 확인하고 포인터를 바꾼다. 실패하면 기존 사진을 유지한다. 마지막 사진 삭제 방지 trigger와 clear RPC 철회는 유지한다.

## 권한·오류·검증 경계

새 사용자 RPC는 authenticated만, 내부 만료는 service_role만 실행한다. 신규 private 저장소와 helper는 직접 접근할 수 없다. 구 create_post/create_join_request/author-only confirm_match 실행과 직접 공고·신청·약속 쓰기를 복원하지 않는다. 기존 SELECT/RLS·과거 이력·완료/취소/후기 흐름은 보존한다.

28000→AUTH_REQUIRED, 42501→ACCESS_DENIED, P0002/PT404→RESOURCE_NOT_FOUND, 22023→INVALID_REQUEST, 40001/23505→STATE_CONFLICT, PT503→EXTERNAL_UNAVAILABLE다. SQL detail은 외부로 내보내지 않는다. 실제 로컬 SQL·동시성·HTTP 결과는 이번 인계와 현황에 구분하여 기록한다.

확정 후 일정 변경·새 취소 API·분쟁 판정·유료/계좌·새 카테고리 정책은 이번 범위에 포함하지 않는다. 기존 완료/후기 정책의 추가 반영과 내부 만료의 운영 스케줄 연결은 후속 작업이다.
