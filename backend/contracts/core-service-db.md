# 핵심 업무 DB 연결 — 민규

## 현재 업무 정책과 DB 적용 차이

무료 1:1 동행만 운영한다. 모집 마감 생략 시 시작 시각으로 설정하고 소개 메시지는 필수다. 확정 전 핵심 조건 변경은 신청자 알림·기존 동의 무효화·새 동의를 요구한다. 최종 동의는 한 번에 한 명, 발송+24시간과 시작 중 빠른 시각에 만료하며 수동 마감 후 기존 신청자 재요청도 시작 전에는 허용한다. 확정 후 미선정 대화는 읽기 전용, 공고 삭제는 미확정 관계 종료·알림, 시작 전 취소는 사유·상대 알림과 개인정보 추가 공개 종료를 적용해야 한다. 아래 기존 RPC에 없는 동작은 구현 완료가 아니라 후속 변경 목록이다.

운영자는 신고·분쟁 처리를 위해 저장된 회원 채팅을 직접 조회하지 않고 당사자 제출 캡처로 접수한다. 대화방 나가기는 본인 목록만 숨기며 상대 기록을 삭제하지 않는다. 보관 기간·캡처 처리 근거·권한·삭제는 팀 검토다. 일반 관리자 조회를 임의로 추가하지 않는다.

`20260923102000_core_service_api.sql`은 기존 자료를 변환하지 않고 새 업무 API의 저장·권한 경로를 제공한다. 지원 범위는 기존 프로필 사용자의 무료 공고·신청·양측 동의·참여자 조회·채팅·알림·프로필 사진 교체다. Supabase Auth 확인과 네이버 필수 정보·가입 자격 확인은 다르다. 이 migration은 네이버 가입·세션 연결을 구현한 근거가 아니다.

## 호출 목록

아래 RPC는 authenticated 세션의 `auth.uid()`를 사용한다. 사용자 ID를 인자로 받지 않는다. 반환은 JSON이며 HTTP envelope는 [서비스 API](service-api.md)가 붙인다.

| RPC | 필수 인수 | 반환 |
|---|---|---|
| get_my_profile | 없음 | userId, realName, avatarUrl, bio — 본인만 |
| create_service_post | p_post_id uuid, p_input jsonb | postId, alreadyCreated |
| get_service_post | p_post_id uuid | 공개 상세, 권한 충족 시 privateDetails/participantNames |
| request_service_post | p_post_id uuid, p_message text | 기존 신청의 id/post_id/status/created_at/already_existed |
| propose_match | p_request_id uuid | requestId, conditionVersion, conditions, awaiting_consent |
| get_match_consent | p_request_id uuid | 당사자만 현재 동의 조건 또는 consent:null |
| accept_match | p_request_id uuid, p_condition_version text | appointmentId/postId/requestId/status/alreadyConfirmed |
| list_my_notifications | p_limit integer, p_before uuid|null | items, nextCursor |
| list_conversation_messages | p_request_id uuid, p_limit integer, p_before uuid|null | items, nextCursor |
| send_conversation_message | p_request_id uuid, p_message_id uuid, p_content text | messageId/createdAt/alreadySent |
| set_my_profile_avatar | p_avatar_path text | 기존 반환 avatar_url/previous_avatar_path |

`get_service_post` DB 함수는 anon에도 허용한다. 현재 service-api 경로의 호출은 사용자 인증을 요구하고 공개 탐색 연결은 종현 담당이다. 목록 limit는 1~100이며 cursor는 해당 사용자의 알림/해당 대화 메시지여야 한다. 생성시각·ID 내림차순이다.

## 공고 입력·개인정보

p_input의 정확한 키: title, description, category, startsAt, endsAt, recruitmentEndsAt, publicArea, registeredPlaceName, registeredAddress, meetingDetail, preferenceNote, tags, costType, amount. nullable 두 값은 registeredPlaceName/preferenceNote, tags는 문자열 배열이다. 실제 HTTP 입력에서는 이 선택값을 생략하면 명시 기본 형태로 변환한다. API 시간은 offset이 포함된 ISO 문자열이며 구체적 한도는 service-api 계약을 따른다.

- costType=free, amount=0만 처리한다. 유료 인증 공급사·효력 정책 미연결 상태에서 무료로 바꾸거나 성공 처리하지 않는다.
- 기존 cost_type/amount는 NULL로 남긴다. 과거 공고의 금액을 추정하지 않으므로 새 신청/최종동의 RPC는 비용 미상 공고도 지원하지 않는다.
- 공고·상세 만남·분리 등록 주소·중복 방지용 입력은 하나의 트랜잭션에서 저장한다. 동일 postId+입력 재요청은 첫 공고를 반환하고 다른 입력은 충돌이다.
- 등록 주소는 private에만 저장하고 검색 일치 용도로 사용한다. 일반 상세에는 공개 지역과 마스킹 이름만 포함한다. 비로그인은 별칭이다.
- 작성자는 자신의 입력을, 양측 확정 당사자는 등록 주소·상세 지점과 양 당사자 실명을 확인한다. 과거 혼합 exact_location은 자동 해석하지 않는다.

## 양측 동의·일정 경쟁

작성자 propose는 동의 요청과 수신자 알림만 만든다. 신청자는 get_match_consent로 같은 일정·지역·무료 조건을 확인하고 conditionVersion을 accept에 전달한다. 다른 사용자의 읽기/확정은 없는 대상과 동일하게 거절한다.

외부 conditionVersion은 무작위 UUID다. 비공개 장소·상세를 포함한 내부 비교값을 외부에 내보내지 않으므로 장소 후보의 해시 대입에 사용할 수 없다. 실제 조건이 바뀌면 기존 동의로 확정하지 않으며 작성자가 다시 요청해야 한다.

확정은 공고/신청/동의 행을 잠그고, 양 당사자의 UUID 순서대로 transaction advisory lock을 얻는다. 다른 공고에서도 같은 사용자의 동시 확정을 직렬화한다. `[시작,종료)` 구간이 기존 confirmed 약속과 겹치면 거절한다. 약속 생성·선택 신청 matched·공고 closed·양쪽 알림은 같은 트랜잭션이다. 기존 구현은 다른 신청을 자동 종료하지 않는다. 현재 정책은 실제 확정 후 미선정 신청·동의 종료, 결과 알림과 대화 읽기 전용 전환이므로 후속 DB 변경·검증이 필요하다. 동일 확정 재요청은 첫 약속을 반환한다.

기존 author-only confirm_match와 create_post/create_join_request의 일반 호출 권한은 회수했다. 새 RPC 내부에서만 필요한 기존 구현을 재사용한다. 수기 signup/신원 컬럼 직접 insert/update도 차단했으며 기존 프로필이나 이력을 현재 네이버 자격 확인으로 자동 승격하지 않는다.

## 메시지·사진

메시지는 새 고정 RPC에서 참여자·전송 가능 상태와 요청 행 잠금을 확인한다. 같은 messageId/내용은 재전송으로 처리하고 내용 변경은 거절한다. 직접 테이블 INSERT 권한을 회수해 이 잠금을 우회하지 못한다. 사용자 간 메시지 저장은 기존 기능이며 AI 탐색 대화 저장과 다르다.

사진 교체는 본인 profile 행과 새 Storage object 행을 잠그고 존재·소유·기존 JPEG 조건을 확인한 뒤 포인터를 바꾼다. 실패하면 기존 사진을 유지한다. clear RPC 실행 권한을 회수하고 현재 참조 object 삭제를 trigger로 막는다. 교체 후 참조되지 않는 이전 object는 기존 Storage API로 삭제할 수 있다. 교체/삭제의 잠금 경쟁은 DB가 한 트랜잭션을 안전하게 중단할 수 있으며 원래 사진을 잃은 성공으로 처리하지 않는다. Storage 자체의 직접 SQL 삭제 방지 장치도 그대로 둔다.

## 오류·검증·남은 범위

28000→AUTH_REQUIRED, 42501→ACCESS_DENIED, P0002/PT404→RESOURCE_NOT_FOUND, 22023→INVALID_REQUEST, 40001/23505→STATE_CONFLICT, PT503→EXTERNAL_UNAVAILABLE. 원문·SQL detail은 공개하지 않는다.

`tests/database/minkyu/core_service_api.sql`은 권한·정보 범위·조건 변경·일정 충돌·중복·사진 포인터 보존을 rollback 검사한다. 실제 JWT/HTTP 연결은 `tests/integration/minkyu/runtime_e2e.py`로 별도 검증한다. 결과는 민규 현황에서 확인한다.

네이버 가입·세션 연결과 현재 확정된 수정·마감·삭제·동의 만료·확정 취소·미선정 종료·성향 편집은 후속 적용·검증 대상이다. 유료·계좌 공급사는 추후 도입, 분쟁 세부 판단은 팀 검토다. 모델/예약 실행기는 종현의 기존 파일에서 연결한다.
