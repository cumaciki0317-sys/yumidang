# 민규 서비스 API 런타임 계약

## 현재 정책 목표와 기존 인터페이스

현재 기준은 [정책.md](../../정책.md)다. 아래에서 현재 정책 목표와 기존 기술 인터페이스를 구분한다. 이번 문서 동기화는 서버 코드·SQL·설정·DB·외부 호출·배포를 변경하거나 검증하지 않았다.

예상 종료 후 본인 완료 확인을 마친 사람은 상대 확인 전에도 후기를 제출할 수 있으나 실제 완료 전에는 비공개다. 양쪽 확인 또는 예상 종료+24시간에 실제 완료하며 취소·노쇼는 제외하고 신고·분쟁 검토 중에는 보류한다. 지연 시 실제 성공 시각이 완료 시각이다. 작성 마감은 실제 완료부터 7일, 양쪽 제출은 실제 완료 후 즉시 공개, 한쪽 제출은 작성 기한 종료 시 공개한다. 완료 횟수는 실제 완료 즉시, 후기 당도는 상대 열람 가능 시 반영한다.

검토 중에는 작성·기한 진행·새 공개를 보류한다. 이미 공개된 후기는 접수만으로 숨기지 않고 운영자가 임시 비공개를 결정한 때 숨긴다. 정상 동행 인정 후 원래 종료+24시간이 지났으면 즉시 실제 완료한다. 첫 완료라면 그때부터 작성 7일, 이미 완료했다면 남은 기한을 재개하되 최소 24시간을 보장한다. 재개 후 양쪽 제출이면 공개하고 한쪽이면 재개·연장된 작성 기한 종료에 공개한다.

첫 채팅 성공 신청·기존 방 재사용·철회1분 대기, 확정 요청6시간/시작 만료, 일정·장소 변경 제안6시간/양 시작 만료, 모집 재개 유효 신청 복원은 현재 목표다. 아래 기존 신청 message/신청 ID 중심 인터페이스가 이를 이미 지원한다고 해석하지 않는다.

공고·행사10개/후기5개, 제목50·소개2,000·상세지점300자·16카테고리, 익명 일정/나이 전체·개인정보 없는 작성자 가드로 입력·응답을 맞춰야 한다. 숫자나이 HTTP·AI·커서와 확정 제재·당도·동의 철회·탈퇴 보관도 후속 구현 검증 대상이다.

기존 구현 경로는 Request→인증→입력 검증→service→repository→고정 RPC다. 시간·관계·동시성·상태 전이는 DB에서 최종 확인한다. 아래 기술 signature를 문서만으로 바꿔 신규 API가 존재하는 것처럼 안내하지 않는다.

## 기존 완료·후기 응답

기존 GET `/appointments/:id/reviews`는 table-returning RPC의 snake_case 객체 배열을 유지한다. 미완료 상태에서도 예상 종료 후 본인 완료 확인을 마치면 `appointment_completed:false`, `can_write:true`, `deadline_at:null`이 가능하다. `released:false`, `peer_review:null`로 상대 후기를 숨긴다. 제출 성공은 기존 `{reviewId,submittedAt,deduplicated}` 결과이며 HTTP가 완료·공개를 추가 실행하지 않는다. 서버가 반환한 상태를 기준으로 제출 버튼·공개 대기 안내를 결정한다.

GET `/reviews/praises`는 정해진 6개 `code`·한국어 `label`을 표시 순서대로 반환한다. `punctual` 시간 준수, `keeps_promises` 약속 내용, `communicates_well` 소통, `considerate` 배려, `enjoyable_conversation` 대화, `comfortable_companion` 편안함의 기술 코드다. label은 DB 결과를 사용하며 기존 비활성 코드·과거 후기 기록을 삭제하거나 새 선택지로 안내하지 않는다. 권한·DB 실패를 빈 목록 성공으로 바꾸지 않는다.

GET `/profiles/:id/reviews`의 `{reviews,praisesTop5,nextCursor}`에 `completedCount`를 추가한다. 실제 완료 시 기록한 횟수이며 후기 제출·공개 건수와 독립이다. 실제 완료된 이력이 있는 분쟁 검토 동행은 횟수를 유지하고 취소·불발은 제외한다. 공개 후기 적격성·집계·실제 시각은 DB 계약을 따른다. 본인 프로필 GET `/me`는 기존 `get_my_profile` 전용 반환을 유지하며 공개 프로필 RPC로 교체하지 않는다. 당도 산식은 정책 7-4절에 확정됐으며 실제 계산기 연결은 후속이다.

## HTTP 및 인증

- Supabase 경로는 `/functions/v1/service-api`이며 직접 실행용 `/service-api`도 지원한다. 아래 표의 경로를 뒤에 붙인다. 임의 suffix, 인코딩 우회, 알 수 없는 경로는 404다.
- 공개 검색·행사 및 정확한 GET `/posts/:id`는 선택 인증을 사용한다. Authorization 헤더가 아예 없을 때만 익명이며 헤더가 있으면 실제 Auth 검증을 거친 원래 사용자 JWT를 사용한다. 그 외 사용자 경로는 `Authorization: Bearer <검증되는 사용자 access token>`이 필요하다. 상세는 아래 공개 상세 계약, 검색은 종현 코어와 민규 HTTP 연결 계약을 따른다.
- 내부 유지보수는 별도 내부 secret을 Bearer로 받는다. 사용자 JWT·서비스 역할 키 자체를 내부 비밀로 대신 사용하지 않는다. 사용자 경로가 실패해도 내부 클라이언트로 재시도하지 않는다.
- 허용된 정확한 Origin만 CORS 응답을 받는다. preflight 허용 헤더는 `authorization, content-type, apikey`다. apikey 자체는 사용자 인증이 아니다.
- POST는 `application/json`과 객체 본문을 사용한다. 인자가 없는 POST도 `{}`를 보낸다. 초과 필드·타입 불일치·중복 query는 400이다. 크기 한도는 `MAX_REQUEST_BYTES` 설정값이다.
- 성공은 `{data,requestId}`, 실패는 `{error:{code,message,retryable},requestId}`이며 동일 ID를 `X-Request-Id`에 넣는다. 사용자 요청 ID를 복사하지 않는다. `Cache-Control: no-store`가 적용된다.
- `data`는 각 고정 RPC 결과다. 기존 table-returning RPC는 snake_case 객체 배열, 신규 JSON RPC는 해당 DB 계약의 camelCase 객체다. 배열 첫 항목을 암묵적으로 꺼내거나 없는 결과를 성공 객체로 만들지 않는다.
- 인증 실패 401, 권한 거절 403, 대상 부재 404, 상태·조건 버전 충돌 409, 설정/외부 연결 누락 503이다. DB 오류 원문·토큰·SQL·채팅/후기 원문을 로그나 오류에 넣지 않는다.

## 공개 공고 상세 연결

정확한 GET `/service-api/posts/:UUID` 또는 `/functions/v1/service-api/posts/:UUID`만 선택 인증을 적용한다. `resolveRouteForMethod`가 기존 prefix·UUID·메서드를 검증한 뒤 상세 query가 없는지 검사하고 `publicPostDetail:true`를 붙인다. 잘못된 prefix·suffix, 다른 메서드, 추가/중복 query·본문을 익명 경로로 우회시키지 않는다. 기존 상세 GET은 query를 받지 않는다.

`createRuntimeHandler`는 `publicPostDetails.authenticate`에 검색·행사와 같은 `authenticatePublic`을 연결한다. Authorization 헤더가 없으면 기존 `createPublicClient`, 있으면 `requireOptionalPrincipal`→Auth `/user` 검증→원래 토큰의 `createUserClient`다. 빈·잘못된 형식·위조·만료·서버 키·거절된 세션은401, Auth 연결 장애/실패는503이며 익명·내부·service-role로 재시도하지 않는다. 사용자 client의 권한을 공개 client로 대신하지 않는다.

`createServiceApi`의 선택 dependency `publicPostDetails?:{authenticate(request):Promise<{db,caller}>}`를 명시 연결한 상세 route만 이 흐름을 사용한다. dependency가 없는 기존 주입 조립은 회원 인증을 유지한다. 이는 구성 호환이며 인증 실패를 익명으로 바꾸는 fallback이 아니다. 기본 런타임에는 dependency가 연결된다.

익명 RPC 허용 목록에는 기존 검색·행사 RPC에 **`get_service_post` 하나만 추가**했다. 회원 프로필·대화·알림·등록/신청·수정/삭제·내부 유지보수는 이 추가로 익명 실행할 수 없다. 상세는 기존 route→post service→repository→`get_service_post(p_post_id)`를 재사용한다. 새 SQL이나 중복 공개 상세 RPC를 만들지 않는다.

| 관계 | 기존 DB 상세 투영 |
|---|---|
| 비로그인 | 현재 목표는 작성자 개인정보 없는 로그인 가드·공개 지역; 기존 투영 변경 필요; `privateDetails`·`participantNames` 제외 |
| 일반 회원·미확정 상대 | 마스킹 이름·공개 지역; 상대 비공개 이름/장소 제외 |
| 공고 작성자 | 본인 이름·본인이 등록한 정확한 장소 권한 유지 |
| 양쪽 확정/완료 당사자 | 기존 관계 권한에 따른 전체 이름·정확한 장소 |
| 취소 후 상대 | 다시 마스킹하고 구조화된 정확한 장소·상대 실명 공유 종료; 작성자의 본인 입력 권한과 구분 |

삭제/없는 공고는 기존404, 권한·DB 오류는 공통 오류로 반환하며 실패를 빈 상세 성공으로 바꾸지 않는다. 성공 envelope·requestId·no-store·정확한 Origin 검사와 기존 회원/작성자/확정/취소 권한은 유지한다. 반환 개인정보 권한은 DB에서 판단하며 HTTP는 독자적으로 관계를 추정하거나 필드를 보강하지 않는다.

## 공개 상세와 사용자 경로

`id`는 UUID다. 목록에 표시한 경우에만 `?limit=1..100&before=<UUID>`를 허용한다. 생략 시 limit20은 페이지 크기이며 서비스 운영 시간 정책이 아니다.

| 메서드·경로 | 입력 및 고정 RPC |
|---|---|
| GET `/me` | `get_my_profile()`; 본인 필드만 |
| GET `/profiles/:id` | `get_public_profile(p_profile_id)`; 회원용 공개 프로필·성향·완료 횟수, 관계별 이름 표시 |
| POST `/me/avatar` | `{avatarPath}` → `set_my_profile_avatar`; `<user UUID>/<image UUID>.jpg` 경로, 실제 Storage 객체 소유권·MIME·크기는 DB 확인 |
| GET `/me/traits` | `get_my_profile_traits()` |
| POST `/me/traits` | `{interests?,conversationStyles?,mbti?}` → `set_my_profile_traits`; 가입 계약의 선택 성향 검증 |
| GET `/reviews/praises` | `get_review_praise_catalog()` → `{items:[{code,label}]}`; 기존 서비스 회원 인증 필요 |
| GET `/appointments` | `list_my_appointments()` |
| GET `/appointments/:id` | `get_appointment_state(p_appointment_id)` |
| GET `/appointments/:id/schedule-change` | `get_appointment_change_state(p_appointment_id)`; 현재 일정·조회 버전·변경/취소 상태 |
| POST `/appointments/:id/schedule-change/propose` | `{changeId,startsAt,endsAt,expectedUpdatedAt}` → `propose_appointment_schedule_change` |
| POST `/appointments/:id/schedule-change/accept` | `{changeId,conditionVersion}` → `accept_appointment_schedule_change` |
| POST `/appointments/:id/schedule-change/decline` | `{changeId,conditionVersion}` → `decline_appointment_schedule_change` |
| POST `/appointments/:id/cancel` | `{cancellationId,reason}` → `cancel_appointment`; reason1..300자 기술 한도 |
| POST `/appointments/:id/confirm-completion` | `{}` → `confirm_appointment_completion`; 한쪽 확인은 완료 전 유지 |
| GET `/appointments/:id/reviews` | `get_appointment_review_state` |
| POST `/appointments/:id/reviews` | 아래 후기 입력 → 5인자 `submit_appointment_review` |
| GET `/profiles/:id/reviews` | 페이지 query → `get_public_profile_reviews`; 공개 원문·칭찬 집계 및 후기와 독립된 `completedCount` |
| GET `/notifications` | 페이지 query → `list_my_notifications` |
| POST `/notifications/:id/read` | `{}` → `mark_my_notification_read`; 동의·완료를 실행하지 않음 |
| POST `/notifications/read-all` | `{}` → `mark_all_my_notifications_read` |
| GET `/conversations` | `list_conversations()` |
| GET `/conversations/:id` | 신청 ID → `get_conversation` |
| GET `/conversations/:id/messages` | 페이지 query → `list_conversation_messages` |
| POST `/conversations/:id/messages` | `{messageId,content}` → `send_conversation_message`; content1..1000자, 같은 재시도 ID 유지 |
| POST `/conversations/:id/leave` | `{}` → `leave_conversation(p_request_id)`; 본인 목록에서만 숨김 |
| POST `/posts` | 아래 무료 공고 입력 → `create_service_post` |
| GET `/posts/:id` | 선택 인증 → `get_service_post`; 헤더 없음만 익명, 이름/장소 관계 권한은 기존 DB 검사 |
| POST `/posts/:id/update` | 생성 입력에서 `postId`를 제외하고 `expectedUpdatedAt`을 추가한 전체 입력 → `update_service_post`; ID는 경로만 |
| POST `/posts/:id/close` | `{}` → `close_service_post`; 새 신청만 차단 |
| POST `/posts/:id/delete` | `{}` → `delete_service_post`; 공개 목록에서 숨기며 미확정 신청·대화 종료 |
| POST `/posts/:id/requests` | `{message}` 10..300자 → `request_service_post`; 지원되는 무료 공고에만 신청 |
| GET `/requests/sent` | `list_sent_join_requests()` |
| GET `/requests/received` | `list_received_join_requests()` |
| GET `/requests/:id/consent` | `get_match_consent`; 참여자가 현재 조건·버전 확인 |
| POST `/requests/:id/withdraw` | `{}` → `withdraw_join_request` |
| POST `/requests/:id/decline` | `{}` → `decline_join_request` |
| POST `/requests/:id/propose` | `{}` → 작성자 `propose_match`; 약속을 즉시 확정하지 않음 |
| POST `/requests/:id/consent/withdraw` | `{conditionVersion}` → 작성자 `withdraw_match_consent`; 신청 자체는 유지 |
| POST `/requests/:id/consent/decline` | `{conditionVersion}` → 신청자 `decline_match_consent`; 신청 자체는 유지 |
| POST `/requests/:id/accept` | `{conditionVersion}` → 신청자 `accept_match`; 조회한 동일 버전 필요 |

### 대화방 나가기

POST `/conversations/:id/leave`는 UUID 신청 ID와 정확한 JSON `{}`만 받으며 `{requestId,hidden:true}`를 반환한다. 기존 회원 인증 후 원래 JWT로 `leave_conversation(p_request_id)`를 호출한다. DB가 대화 당사자를 검사하고 본인 목록 숨김을 멱등 기록한다. 없는 관계·타인 관계는404이며 신규 네이버 활동 자격을 요구하지 않는다.

본인의 `GET /conversations` 목록에서만 제외한다. 상대 목록·기존 대화/메시지 조회·전송 권한·신청/약속 상태·알림·원래 기록은 나가기 때문에 변경하지 않는다. 나가기를 신청 철회·차단·자료 삭제로 처리하지 않으며 복귀 API나 새 메시지에 따른 자동 복귀를 추가하지 않는다. 숨김 표의 직접 쓰기는 허용하지 않는다. 실제 DB/RLS·native Auth/HTTP 실행 결과는 별도 인계에서 기록한다.

### 행사 연결·내부 Top10

무료 공고 생성·수정의 선택 입력 `eventId?: string | null`은 [공고 계약](posts-search.md)을 따른다. UUID 형식만 받으며 빈 문자열·boolean·객체는400이다. 수정 생략은 전달 키 자체를 제외해 기존 연결을 보존한다. 기존 `create_service_post`·`update_service_post`·`get_service_post`를 사용하고 별도 공개 RPC를 만들지 않는다. 상세의 `eventId`·`linkedEvent`는 항상 최신 canonical 행사 정보이며 동행 일정과 공고의 정확한 장소 권한을 유지한다. 수동 연결 변경은 동의 무효화/새 동의를 요구하고 공급자 갱신은 동의를 변경하지 않는다.

| 메서드·경로 | 내부 인증 후 고정 RPC |
|---|---|
| POST `/internal/events/kopis-top10` | 정확한 `{snapshot: object}` → `store_kopis_top10_snapshot(p_snapshot)` |
| GET `/internal/events/kopis-top10/:mode` | `mode: all|musical`, query·본문 없음 → `get_kopis_top10_snapshot(p_mode)` |

두 경로는 기존 내부 secret 인증과 service-role client를 사용한다. 공개/사용자 RPC 허용 목록에는 추가하지 않는다. `snapshot`은 정확히 `{mode,requestedPeriod:{start,end},collectedAt,items}`이며 순위 항목은 `{rank,sourceId,title,genre,performancePeriodText,placeName,region}`다. 항목1~10개·연속 순위·ID 중복 없음·실제 달력/기간·뮤지컬 모드의 장르 등은 DB가 검증한다. 운영 수집 기간/빈도는 이 기술 검사로 확정하지 않는다.

저장 결과는 `{status:"saved"|"stale",itemCount,deduplicated}`다. 같은 수집 시각·같은 본문은 중복 안전, 같은 시각·다른 본문은409, 오래된 수집본은 최신 내용을 유지한다. 조회는 `{status:"available"|"unavailable",mode,source:"kopis",requestedPeriod,responsePeriod:null,periodVerification:"requested_only",collectedAt,items}`이며 자료 없으면 기간/수집시각은null, 항목은빈 배열이다. upstream 응답 기간 검증 성공으로 해석하지 않는다. 공개 Top10·종현 수집 어댑터·취소/종료 순위 자료의 공개 정책은 남아 있다.

### 확정 후 일정 변경·취소 연결

GET `/appointments/:id/schedule-change`는 `{appointmentId,status,startsAt,endsAt,updatedAt,change,cancellation}`을 반환한다. 기존 약속 상세의 table-returning snake_case signature는 바꾸지 않는다. 변경 제안에는 이 조회의 `updatedAt` 원본을 `expectedUpdatedAt`으로 보내며 ISO offset/Z·최대 소수 6자리를 보존한다. `changeId`는 UUID 재시도 ID이며 같은 요청의 재전송 때 유지한다. `startsAt`, `endsAt`는 offset/Z를 포함하고 종료가 시작보다 늦어야 한다. 시간 기한·현재 일정·동시 확정 충돌·상대 권한은 DB가 최종 검사한다.

`change`가 없으면 `null`, 있으면 `{changeId,conditionVersion,status,oldSchedule,newSchedule,requestedByMe,requestedAt,expiresAt,resolvedAt}`이다. 상태는 `awaiting_response|accepted|declined|expired|cancelled`, 각 일정은 `{startsAt,endsAt}`이다. 현재 목표 응답 기한은 제안+6시간·기존 시작·새 시작 중 먼저 오는 때이며 기존 계산 변경·검증이 필요하다. 거절·만료는 기존 일정을 유지한다. 제안·수락·거절 결과는 이 변경 객체에 `appointmentId`, `deduplicated`를 추가한다. 수락·거절 때 조회한 `changeId`와 불투명 `conditionVersion`을 그대로 보내며 과거 요청이 새 제안을 종료하지 못한다. 만료된 거절이 성공 응답으로 끝나더라도 `status:expired`를 안내하고 새 일정 반영으로 표시하지 않는다.

취소는 별도의 UUID `cancellationId`와 앞뒤 공백 없는 사유1..300자를 입력한다. 같은 재전송에는 ID·사유를 유지한다. 결과는 `{appointmentId,status:"cancelled",cancellationId,reason,cancelledAt,deduplicated}`이다. 조회의 `cancellation`은 없으면 `null`, 있으면 `{cancellationId,reason,cancelledAt,cancelledByMe}`다. 시작 전 당사자 취소와 시작 후 신고를 구분하며 HTTP에 노쇼·분쟁 판정 필드를 받지 않는다. 일정 제안·수락은 새로운 네이버 활동 자격을 검사하고 조회·거절·취소는 기존 회원의 관계 정리를 유지한다. 취소 후 구조화된 정확한 주소 숨김·자동 완료 예약 제거·대화 읽기 전용·양쪽 알림은 같은 DB 전이를 따른다.

### 공고·최종 동의 생명주기 연결

공고 상세의 `updatedAt` 원본으로 전체 수정 입력을 제출한다. `update_service_post(p_post_id,p_input,p_expected_updated_at)`는 오래된 입력이면 409를 반환하므로 최신 상세를 다시 확인하고 입력을 보존한다. 수정·마감·삭제 결과는 `{postId,status,updatedAt}`다. 핵심 조건 변경 시 신청·대화는 유지하고 진행 중 동의만 무효화한다. 확정 후에는 공고 수정으로 약속 조건을 변경하지 않는다. 수동 마감은 기존 신청자와의 동의 요청·재요청을 시작 전까지 유지한다. 삭제는 미확정 관계를 종료하며 확정 약속 종료 전 삭제는 거절한다.

`propose_match`와 `get_match_consent` 결과는 `{requestId,conditionVersion,conditions,status,requestedAt,expiresAt}`이며 DB가 현재 정책의 요청+6시간/시작 중 빠른 만료를 결정하도록 후속 변경·검증한다. 없으면 `{consent:null}`, 신규 상태는 `awaiting_consent|expired|withdrawn|declined|invalidated|accepted`다. 기존 만료 정보가 없는 동의는 `renewal_required`, `expiresAt:null`로 반환하여 새 요청을 안내한다. 작성자가 다른 상대를 선택할 때는 기존 요청을 먼저 철회해야 한다. `conditionVersion`은 서버가 반환한 불투명 값을 그대로 전달하고 HTTP에서 상태·만료를 추정하지 않는다.

동의 철회·거절은 `{requestId,conditionVersion,status,alreadyEnded}`를 반환한다. `status`는 `withdrawn|declined`, 만료가 먼저면 `expired`다. 예전 버전 요청으로 새 동의를 끝내지 못하며 중복 요청은 DB가 같은 결과로 처리한다. 이 경로와 신청 자체 `/withdraw|decline`은 별개다. 최종 확정은 미선정 관계를 종료하고 기존 대화를 읽기 전용으로 보존한다. 알림의 `eventData`는 현재 상태·조건 버전·만료 시각 같은 안전한 구조값이며 알림 클릭이 동의·확정을 대신하지 않는다.

새 활동인 수정·동의 요청·수락은 DB의 최신 네이버 자격·가입 완료·등록 세션을 검사한다. 정리 기능인 마감·삭제·철회·거절은 기존 회원의 관계 정리를 허용한다. HTTP는 검증된 사용자 JWT를 같은 사용자 DB 클라이언트로 전달하고 서비스 역할로 재시도하지 않는다. 네이버 앱 설정 없이도 가상 제공처와 실제 로컬 Auth·DB로 이 단위를 검증할 수 있으며 실제 네이버 로그인 성공과 구분한다.

후기 입력:

```json
{"rating":5,"experience":"positive","comment":"편안하게 대화했어요","praises":[]}
```

rating은 정수1..5, experience는 `positive|neutral|negative`, comment는 선택/null 또는1..300자다. praises는 최대3개이며 positive에만 허용한다. 칭찬 6개는 [후기 계약](reviews.md)에 확정됐다. GET `/reviews/praises`로 조회한 `code`를 제출하며 DB가 활성 목록 포함 여부를 최종 검증한다. HTTP가 별도 catalog 조회로 제출 상태를 판단하거나 표시 문구를 코드 대신 생성하지 않는다. 최대 3개·중복·positive 조건은 HTTP와 DB에서 검사한다. 당도는 확정된 반응·별점·운영 감점 산식으로 별도 계산한다. 공개는 실제 완료 후 양쪽 즉시/한쪽 작성 기한 종료이며 검토 중 새 공개와 기존 공개 후기를 구분한다. 자세한 기한 재개·점수 기준은 후기 계약을 따른다.

공고 입력 예시(가상):

```json
{
  "postId":"11111111-1111-4111-8111-111111111111",
  "title":"무료 전시 동행",
  "description":"함께 전시를 관람해요",
  "category":"전시",
  "startsAt":"2099-01-01T10:00:00+09:00",
  "endsAt":"2099-01-01T12:00:00+09:00",
  "recruitmentEndsAt":"2099-01-01T09:00:00+09:00",
  "publicArea":"서울특별시 성동구 성수동",
  "registeredPlaceName":null,
  "registeredAddress":"가상 등록 주소",
  "meetingDetail":"가상 만남 상세",
  "preferenceNote":null,
  "tags":[],
  "costType":"free",
  "amount":0
}
```

제목2..80자, 소개1..2000자, 공개지역 최대60자, 장소명 최대200자, 등록주소1..300자, 만남상세2..200자, 선택 선호문구 최대300자, 태그 최대5개·각20자다. 문자열은 앞뒤 공백을 허용하지 않는다. 시간은 offset 또는 Z가 있는 ISO 문자열이며 종료가 시작보다 늦고 모집 종료가 시작 이하여야 한다. `recruitmentEndsAt` 생략 시 `startsAt`을 사용하며 명시 `null`은 거절한다. 수정 `expectedUpdatedAt`은 상세 조회의 `updatedAt` 원본 문자열을 보내며 최대 소수 6자리까지 허용한다. 시각 정밀도를 줄이거나 클라이언트 현재 시각으로 대체하지 않는다. 현재 지역 형식은 기존 DB 제약을 따르며 임의로 바꾸지 않는다.

유료 `paid_request|paid_offer`는 503이며 공급사 연결 없이 성공 처리하지 않는다. 신규 무료 공고와 달리 비용 미상인 기존 공고는 `request_service_post`에서 차단된다. 클라이언트 `authorId`, `userId`, 권한·성별·확정 상태 필드는 허용하지 않는다. 네이버 가입·세션은 [가입 계약](signup.md), 이번 공고·동의 규칙은 [매칭 생명주기 인계](../../docs/collaboration/requests/minkyu/2026-10-02-matching-lifecycle-handoff.md)의 실제 검증 범위를 따른다. 유료·계좌 인증은 현재 제외하며 분쟁·당도 확정 정책의 코드 연결을 별도 검증한다.

## 공개 행사·필터와 회원 프로필 연결

GET `/events`와 `/events/filters`는 공고 검색과 동일한 선택 인증을 사용한다. Authorization 헤더가 없을 때만 익명 client, 있으면 Auth `/user` 검증 후 같은 사용자 JWT client를 사용한다. 빈·위조·만료·서버 키 인증 실패를 익명으로 강등하지 않는다. 정확한 function prefix·GET·허용 Origin·no-store·공통 envelope를 유지한다. POST나 DELETE는405, 알 수 없는/중복 query는400이다.

| GET `/events` query | HTTP → 종현 행사 저장소 입력 |
|---|---|
| mode | `overlapping|new_this_week|post_selection`, 생략 시 확정 정책 `new_this_week` |
| periodStart, periodEnd | YYYY-MM-DD 두 날짜를 함께 전달, `period:{start,end}`. 양 끝 날짜 포함·KST 날짜 검증은 기존 저장소 |
| ongoingOnly | 정확한 `true|false`, true는 현재 진행 중만 |
| query | 행사명·장소명·공개 주소 검색어; 정규화는 저장소 |
| region, category | 제공처 원문 값 정확 일치. 임의 enum·분류표를 만들지 않음 |
| cursor | 기존 저장소의 조건 결합 불투명 커서, 조건 변경·변조는400 |
| limit | 명시 필수 정수1..50 기술 범위. 현재 화면은10을 전달하며 기존 HTTP에서는 생략하면400 |

실행은 `createRpcEventRepository(db).listPage(query,cursor,limit)`이며 응답은 `{events,nextCursor}`다. 순서·자료·기간·커서를 HTTP에 중복 구현하지 않는다. 기존 `mode=overlapping`·주간 기간 조회는 이미 종료된 이번 주 행사도 포함할 수 있다. 현재 ‘진행 중 포함’ 목표인 신규 미종료+이전 주 시작 미종료에 맞춰 조회를 변경·검증한다. `ongoingOnly=true`로 대신하지 않는다. 과거 조회는 overlapping과 과거 기간으로 가능하며 작성용 post_selection은 종료 행사를 제외한다. 실제 화면 체크박스 연결은 이번 백엔드 검사 범위가 아니다.

GET `/events/filters`는 query 없이 `listEventFilterValues(db)`로 `{regions:[{provider,value,count}],categories:[{provider,value,count}]}`를 반환한다. 제공처·원문 값·횟수를 보존하며 취소만 가진 값은 DB가 제외한다. 입력 오류만400으로 변환하고 응답/투영 오류는500, DB 오류는 기존 공통 매핑을 따른다. 실패를 첫 페이지·빈 성공으로 바꾸지 않는다.

GET `/profiles/:id`는 회원용 `get_public_profile(p_profile_id)`를 호출한다. 이름·생일 원본 노출 권한은 DB가 판단하고 HTTP가 성향으로 자격·관계를 추정하지 않는다. 공개 프로필 성향·완료 횟수와 본인 GET `/me`·성향 전용 GET `/me/traits`를 구분한다. 기존 본인 프로필의 필드·RPC는 유지한다.

`config.toml`에 ai-chat·places·event-sync·review-summary-worker·scheduled-jobs를 등록하고 handler의 회원 JWT 또는 내부 secret 검사를 사용한다. gateway JWT 검사 해제는 handler 인증을 생략하는 뜻이 아니다. 기존 gateway CORS 문제와 원격 배포는 별도 확인이다. 서버 환경 양식의 AI·worker·수집·일일 실행 값은 빈칸이며 운영 한도를 임의 기본값으로 채우지 않는다. 매일00:01 Asia/Seoul 실행 정책과 실제 예약 등록 여부는 [순차 인계](../../docs/collaboration/requests/minkyu/2026-10-02-ordered-backend-handoff.md)를 따른다.

## 내부 유지보수

`POST /internal/maintenance` 본문은 `{ "limit": 20 }`이며 정수1..100이다. 별도 내부 secret·DB 설정은 필수다. 모델/프롬프트 버전 누락이나 모델 전용 설정 오류가 후기 공개 정리를 막지 않는다. 자동 완료는 [건별 예약 실행기](completion-db.md)가 담당하며 여기서 `process_due_completions`를 호출하지 않는다.

1. 내부 호출자·공통 설정·본문을 검증한다.
2. 모델 없이 `expire_match_consents(p_limit)`를 먼저 호출한다. 시간·상태·양쪽 알림은 DB가 검사하며 잘못된 `expiredCount` 또는 실패 시 공개·요약을 호출하지 않는다. 성공한 만료 처리는 다음 공개 실패로 롤백되지 않으므로 재시도는 DB 중복 방지를 따른다. 이어 `expire_appointment_changes(p_limit)`로 일정 제안을 만료 처리하고 같은 `expiredCount` 검증을 적용한다. 일정 만료 실패 시 후기 공개·요약을 시작하지 않는다. 이어 `process_due_review_publications(p_limit)`를 호출한다. 실패하면 기존 HTTP 오류를 반환하고 요약 등록을 시작하지 않는다.
3. 서버의 `REVIEW_SUMMARY_MODEL_VERSION`, `REVIEW_SUMMARY_PROMPT_VERSION`이 유효하면 `process_review_summary_refresh(p_limit,p_model_version,p_prompt_version)`를 별도 트랜잭션으로 호출한다. 이 연산은 모델 생성이 아니라 작업 등록이다.
4. HTTP 200의 data는 `{status:"ok"|"partial",completion:{status:"managed_by_reservation"},consent:{status:"expired",expiredCount},scheduleChange:{status:"expired",expiredCount},reviews:{status:"published",publishedCount},summary:...}`다.

summary 결과는 성공 시 `{status:"queued",processedCount,enqueuedCount}`, 설정 누락/오류 시 `{status:"pending_configuration"|"configuration_error"}`, 실행 실패 시 `{status:"failed",code,retryable}`다. 공개 정리 이후 요약 대기·실패는 `partial`이며 가짜 0건으로 숨기지 않는다. 공개 성공은 요약 실패로 롤백하지 않고 outbox를 보존한다. 버전 문자열을 실제 모델 호출 승인으로 해석하지 않는다.

현재 정책은 실제 완료 후 양쪽 제출 즉시/한쪽 작성 기한 종료 조건을 제출·조회에서 적용하도록 요구하므로 이 정리 API나 하루 한 번 요약 등록을 기다리지 않는다. 행사·AI 후기 요약 등록은 하루 한 번 정책이며 실제 운영 일일 스케줄러 배포는 이번에 수행하지 않는다. 자동 완료는 실제 성공 시각부터 작성 7일을 계산한다.

## 후속 검증

기존 handler·service·repository 단위 검사와 실제 Auth/RPC 통합을 현재 정책 기준으로 대조한다. 첫 채팅 원자 생성·방 재사용·기한 경계·제재·공개 권한·분쟁·당도·익명 가드와 동시 요청을 포함한다. 이번 문서 수정에서 테스트·외부 연결·원격 배포는 수행하지 않았다.

## 실행 진입점과 검증 범위

`index.ts`는 `createRuntimeHandler(read)`와 lazy `default { fetch }`를 제공한다. 실제 설정·인증·DB 조립은 factory 한 곳에 있으며, 모듈 import 시 환경을 읽거나 서버를 시작하지 않는다. 호스팅 런타임은 default fetch를 사용할 수 있고 직접 Deno 실행은 `import.meta.main`에서 같은 fetch를 `Deno.serve`에 등록한다. 이는 현재 [Supabase 공식 시작 안내](https://supabase.com/docs/guides/functions/quickstart)의 default fetch 형태를 따른다.

`verify_jwt=false`는 이 함수가 사용자 JWT와 별도 내부 작업 secret을 경로별로 직접 검증하기 위한 설정이다. 사용자 인증 검사를 생략한다는 뜻이 아니다. [공식 함수 설정](https://supabase.com/docs/guides/functions/function-configuration)

Node import 검사와 Deno 타입 검사, standalone Deno handler·로컬 Supabase의 실제 HTTP/JWT/DB 통합 결과를 관리형 Edge hosting 결과와 구분한다. **원격 관리형 Edge hosting 및 운영 배포는 NOT_RUN**이다. 실행 환경별 검증은 별도로 기록한다.

## 검색 HTTP 연결

기본 런타임은 기존 검색 v2 코어를 재사용한다. `createRuntimeHandler(read)`와 `default.fetch`의 GET `/posts`는 `searchPublicPosts(createRpcPublicPostSearchRepository(db), input)`을 실행한다. `createRuntimeHandler(read, { publicPostSearch })`의 명시 의존성 주입은 검사·조립 용도로 유지하며 URL/본문/환경값으로 실행기를 교체하지 못한다. POST `/posts`와 다른 업무 경로는 기존 로그인 요구를 유지한다.

공개 GET 요청은 다음 순서로 처리한다.

1. 기존 정확한 경로·메서드·CORS 검사.
2. Authorization 헤더가 없으면 익명 client, 있으면 실제 Auth 검증 후 사용자 client를 만든다. 빈 값·위조·만료·서비스 키 등 실패를 익명으로 바꾸지 않는다.
3. 중복/알 수 없는 query와 caller/userId 주입을 거절하고 HTTP 문자열을 검색 입력으로 변환한다.
4. 종현 executor가 조건 정규화·커서·공개 투영·repository를 담당한다. HTTP 코드에 SQL 호출·정렬·페이지 나누기를 복제하지 않는다.
5. 기존 `{data,requestId}`/`{error,requestId}`·no-store·CORS를 적용한다. 조회 결과는 `data:{status,posts,nextCursor}`다.

| query | HTTP 처리 |
|---|---|
| query | 검색어 문자열, 최대 300문자. 정규화는 검색 코어 |
| category | 현재 허용된 카테고리 enum 검사; 검색 코어에서도 검증 |
| cost | all/free/paid |
| availability | all/recruiting |
| periodStart, periodEnd | 두 문자열을 함께 전달해 `period:{startsAt,endsAt}`로 변환. 날짜 유효성·겹침 계산은 검색 코어 |
| authorAge | 기존 구현은 all/20s/30s/40plus. 현재 목표는 작성자 만 나이 19~99 숫자 범위(전체 상한 없음)이며 실제 wire 변경·검증 필요. 익명은 전체만 허용 |
| sort | 생략 시 created_desc, 선택 starts_asc |
| cursor | 불투명 문자열. 해석·필터 결합·버전 검사는 검색 코어 |
| limit | 정수 1..50. 생략하면 검색 코어의 기본값 |

잘못된 입력으로 정의한 검색 코어 오류만 공통 INVALID_REQUEST로 변환한다. AUTH_REQUIRED는 401, 이미 정해진 HttpError는 유지하고 응답/투영 불일치 및 알 수 없는 오류는 원문 없이 500으로 처리한다. 외부 오류 메시지·검색어·토큰을 로그에 출력하지 않는다.

현재 목표·차이는 [검색 계약](search.md)과 [정책](../../정책.md)을 따른다. DB 카드 응답 불일치는 `INVALID_SEARCH_RESPONSE`로 입력 오류와 구분한다. 게이트웨이의 실제 Origin/OPTIONS 처리는 [CORS 계약](gateway-cors.md)에 따라 확인하며 앱 단위 통과를 운영 성공으로 표시하지 않는다.
