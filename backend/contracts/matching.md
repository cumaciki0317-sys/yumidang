# 신청·최종 동의·변경 계약

현재 기준은 [정책.md](../../정책.md)다. 아래에서 현재 정책 목표와 기존 기술 인터페이스를 구분한다. 최신 HTTP·SQL 연결은 아래 실행 범위로 구분하며 운영 적용은 아직 하지 않았다.

## 신청·확정의 현재 목표

신청 버튼은 S11 채팅으로 이동하며 첫 채팅 전송 성공 때만 신청·작성자 대화방·알림이 성립한다. 별도 신청 메시지 폼은 없다. 이탈·전송 실패는 미신청이며 미전송 입력은 화면 메모리만 사용한다. 화면 이탈 시 삭제 안내를 제공한다.

본인 철회 후 1분이 지나면 횟수 제한 없이 재신청할 수 있고 동일 공고·상대의 기존 방과 이력을 재사용한다. 작성자 거절 이력이 있으면 재신청할 수 없다. 신청 일정 겹침은 안내 후 계속할 수 있지만 최종 확정은 기존 확정 약속과 겹치면 차단한다.

작성자는 한 번에 한 신청자에게 확정 요청하고 신청자가 같은 조건·버전을 수락해야 확정된다. 요청은 요청 후 6시간과 시작 시각 중 빠른 때 만료한다. 다른 상대 선택 전 기존 요청을 철회한다. 미선정 신청은 거절이 아닌 모집 종료이고 대화는 읽기 전용이다. 확정 취소 후 작성자가 명시적으로 모집을 재개하면 이전 유효 신청·채팅을 복원하고 알린다. 거절·본인 철회는 복원하지 않는다.

확정 전 핵심 조건 변경은 알림·기존 동의 무효화·새 동의를 요구한다. 수동 마감은 새 신청만 막고 기존 유효 신청의 시작 전 재요청을 유지한다. 확정 후 공고 삭제로 취소하지 않는다.

## 변경·취소·운영 판단

양쪽 누구나 일정·장소 변경을 제안하며 상대 수락과 충돌 확인 후 반영한다. 만료는 제안+6시간·기존 시작·새 시작 중 가장 빠른 때다. 거절·철회·미응답은 기존 약속을 유지한다. 마감은 서버 접수 시각이 마감보다 빠를 때만 허용한다.

시작 전 사유 취소와 시작 후 중단·불발 신고를 구분한다. 취소 후 전체 이름 재마스킹·상세 위치 접근 회수, 완료 예약 제거를 적용한다. 차단은 신규 접촉을 막고 기존 약속 관리·기록·신고는 보존하며 취소를 자동 실행하지 않는다.

연속 취소 3회 첫 경고, 이후 다시 3회마다 7일 제한을 적용한다. 최신 합의 시작 시각 순서로 판정하며 중간 결과 미정은 보류한다. 취소 이의는 24시간 이내, 기한·검토 종료까지 관련 제재 판정을 보류하고 실제 적용부터 7일이다. 상세 집계·예외·중복 제한·일반 위반/영구 제한은 정책 2-3·6절을 그대로 따른다. 운영자는 DB 채팅 원문에 접근하지 않고 제출 자료로 처리한다. 담당자 배정·법적 보관 근거·실제 운영은 별도 확인이다.

## 기존 구현에서 변경할 경계

`request_service_post(p_post_id,p_message_id,p_message)`는 첫 채팅 저장과 신청을 한 트랜잭션으로 처리한다. HTTP `POST /posts/:id/requests`에 `{messageId,message}`를 보내며 본문은 1~1000자다. 동일 메시지 UUID·사용자·공고·본문의 재시도는 기존 성공을 반환한다. 철회 후 1분은 DB 시각으로 확인하며 기존 신청 ID·대화방·이력을 유지하고 숨김을 해제한다. 거절 이력은 재신청을 막는다. 구형 두 인수 RPC·직접 create_join_request의 실행 권한은 회수했다. 격리 DB 회귀와 두 실제 세션의 경합·합성 자료 정리를 검증했다. 최종 동의 만료, 모집 재개 복원, 변경 제안 장소·철회·6시간 상한과 제재도 아래 함수의 존재만으로 지원 완료라고 보지 않는다. 기존 RPC 인수·잠금·멱등성을 보존하면서 후속 담당자가 새 연결 계약을 작성한다.

## 확정 후 일정 변경·사유 취소 DB/API

아래는 일정 변경·취소 RPC의 인수·응답이다. 장소 변경과40600 제안 철회는 후속 구현·로컬 연결을 검증했으며 신뢰 접수 시각 마감 정책은 추가 연결이 필요하다. 기존 get_appointment_state table 응답과 중복 처리 경계는 보존한다.

| RPC | 인수 | 반환 |
|---|---|---|
| get_appointment_change_state | p_appointment_id uuid | appointmentId, status, startsAt, endsAt, updatedAt, change, cancellation |
| propose_appointment_schedule_change | p_appointment_id uuid, p_change_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_expected_updated_at timestamptz | 변경 객체와 deduplicated |
| accept_appointment_schedule_change | p_appointment_id uuid, p_change_id uuid, p_condition_version text | 변경 객체와 deduplicated |
| decline_appointment_schedule_change | 같은 세 인수 | 변경 객체와 deduplicated |
| cancel_appointment | p_appointment_id uuid, p_cancellation_id uuid, p_reason text | appointmentId, status:cancelled, cancellationId, reason, cancelledAt, deduplicated |
| expire_appointment_changes | p_limit integer default 100 | expiredCount — service_role 전용 |

HTTP는 `GET /appointments/:id/schedule-change`, `POST /appointments/:id/schedule-change/propose`·`accept`·`decline`·`withdraw`, `POST /appointments/:id/cancel`이다. propose body는 changeId/startsAt/endsAt/expectedUpdatedAt, 응답 및 철회 body는 changeId/conditionVersion, 취소 body는 cancellationId/reason이다. 서버가 검증한 본인 ID를 사용하며 외부 사용자 ID·완료 시각·취소 시각을 입력받지 않는다. 시각 문자열은 offset ISO 형식이고 DB가 실제 서버 시각과 다시 대조한다. expectedUpdatedAt은 조회한 원본 소수 정밀도를 그대로 보낸다.

GET의 change는 가장 최근 제안 또는 null이다. 변경 객체는 appointmentId/changeId/conditionVersion/status/oldSchedule/newSchedule/requestedByMe/requestedAt/expiresAt/resolvedAt이며 oldSchedule/newSchedule은 startsAt/endsAt이다. status는 awaiting_response, accepted, declined, expired, cancelled다. 종료된 제안도 최신 이력으로 조회한다. cancellation은 cancellationId/reason/cancelledAt/cancelledByMe 또는 null이다. 실명·상대 ID·정확한 주소를 이 응답에 추가하지 않는다. 해당 당사자만 취소 사유를 읽을 수 있으며 사유를 알림 payload·AI 입력에 넣지 않는다.

### 제안·응답·재시도

private.appointment_schedule_changes는 기존·새 일정과 기존 post updated_at, 제안자·무작위 조건 버전·서버 요청/종료 시각을 저장한다. 제안만으로 public.posts의 실제 일정을 바꾸지 않는다. 한 약속의 대기 제안은 partial unique index로 하나만 둔다. 이는 동시 변경 경합을 막는 서버 기술 통제다. 응답이 끝난 뒤 새 ID로 다시 제안할 수 있다.

제안은 confirmed이고 기존·새 시작 시각이 모두 미래일 때만 가능하며 expectedUpdatedAt도 일치해야 한다. 동일 changeId·약속·제안자·새 일정·원래 expectedUpdatedAt의 재시도는 같은 변경 이력의 현재 상태와 deduplicated:true를 반환한다. 다른 입력/다른 약속/다른 제안자에게 같은 ID를 재사용하면 40001이다. 실패 시 입력을 유지한다.

현재 목표 응답 기한은 제안+6시간·기존 시작·새 시작 중 빠른 시각이며 기존 SQL의 기한 계산은 변경·검증 대상이다. 기한 정각부터 수락할 수 없다. 제안자 본인은 수락/거절할 수 없고 상대가 해당 changeId·conditionVersion으로 응답한다. 오래된 버전, 원래 일정/updatedAt 불일치, 완료·취소·분쟁 상태와 기한 초과는 수락 충돌이다. 거절·만료·미응답은 기존 일정을 유지한다. 거절이 시간 만료 후 도착하면 expired 상태를 반환하며 기존 일정은 그대로다.

수락은 두 당사자의 UUID 순서로 기존 key321 일정 advisory lock을 잡고 새 `[시작,종료)`와 다른 confirmed 동행의 겹침을 검사한다. 제안 자체는 충돌 시간을 미리 차단하지 않으며 실제 수락 시 검사를 최종 기준으로 한다. 충돌이면 어느 동행도 변경/취소하지 않는다. 수락된 제안을 정확히 다시 수락하면 같은 accepted 이력을 반환하고 일정·예약·알림을 다시 쓰지 않는다.

propose/accept는 확정 조건 변경이라는 새 활동이므로 네이버 등록 세션·자격·명시 가입 완료·필수 사진을 확인한다. 수락 시 양 당사자의 최신 자격도 검사한다. get/decline/cancel은 기존 profile과 관계만 확인하여 미검증/자격 누락 회원의 기존 약속 확인·거절·정리를 허용한다.

### 원본 일정·예약·취소의 원자성

잠금 순서는 공고→신청/최종 동의 UUID 순서→약속→변경 이력이며 일정 수락에는 양 당사자 advisory lock을 추가한다. 취소·변경과 새 메시지의 요청 행 잠금도 이 순서로 직렬화한다. 기존 완료/요약 source trigger와 예약 약속 잠금은 그대로 사용한다.

수락될 때만 public.posts.starts_at/ends_at을 변경한다. 더 빠른 새 시작보다 모집 마감이 늦어지지 않도록 기존 마감과 새 시작의 최솟값으로 조정하되 모집을 재개하지 않는다. 기존 post 종료 변경 trigger가 completion_reservations의 due_at·generation을 갱신하고 LISTEN/NOTIFY를 보낸다. 종료 시각이 같으면 같은 예약 generation을 유지한다. 거절/만료/동일 성공 재시도는 원본 일정·예약을 변경하지 않는다. 과거 match_consents의 accepted 조건은 최초 양측 확정 근거로 보존하고 새 변경 동의 근거는 별도 기록한다.

시작 전 어느 당사자든 reason을 남겨 취소할 수 있다. reason은 앞뒤 공백 제거 후 1~300자의 기술 입력 한도이며 보관 기간·노쇼·제재 판단을 확정하는 숫자가 아니다. private.appointment_cancellations에 첫 취소 ID·작성자·사유·서버 시각을 기록하고 약속을 cancelled로 바꾸며 대기 일정 제안을 cancelled로 종료한다. 정확한 같은 취소 재시도는 저장된 성공을 반환하며, 다른 ID/사유/작성자로 덮어쓰려 하면 충돌이다. 시작 후 신규 취소는 40001이며 중단·불발 신고/분쟁 기준은 별도 처리다.

상태 변경의 기존 trigger가 완료 예약 삭제와 후기 summary 무효화를 같은 트랜잭션으로 처리한다. 취소 후 전체 이름·정확한 주소·상세 지점의 상대 추가 조회를 차단한다. 작성자의 본인 공고 관리 입력은 유지하며 취소로 공고를 삭제하거나 모집을 다시 열지 않는다. 기존 matched 신청·대화·최초 확정 이력은 보존하고 cancelled 동행의 새 메시지는 허용하지 않는다. 취소 전에 성공한 같은 messageId의 재시도는 저장된 성공만 반환하며 신규 내용을 쓰지 않는다.

### 알림·만료·권한

추가 kind는 appointment_schedule_change_requested, appointment_schedule_change_ended, appointment_cancelled다. 제안·수락·거절·만료·취소를 양 당사자에게 알린다. eventData는 상태·changeId/conditionVersion·expiresAt 또는 cancellationId 같은 안전한 연결 정보만 담으며 실명·주소·사유 원문은 담지 않는다. 기존 lifecycle event 중복 방지를 재사용하고 같은 kind/관계의 새 이벤트는 기존 알림을 미확인 최신 안내로 갱신한다.

내부 expire_appointment_changes는 1~1000 약속의 기술 처리 한도, 공고 SKIP LOCKED와 동일 잠금 순서로 기한이 지난 대기 제안만 종료한다. GET·제안 재시도·거절도 해당 약속의 만료를 정리한다. 수락 오류가 나면 같은 SQL 호출 안의 변경은 롤백되므로 독립 만료 처리/정상 조회가 종료 알림을 확정한다. 내부 HTTP 유지보수 호출과 기한 정각의 운영 실행기 배포는 구분한다.

사용자 RPC는 authenticated만, 내부 만료는 service_role만 실행한다. 새 private 표와 helper 직접 접근은 회수한다. 다른 관계와 없는 약속은 PT404, 제안자 본인 응답은 42501, 잘못된 입력은 22023, 오래된 상태·버전·기한·일정 충돌은 40001이다. 공개 오류 변환은 기존 계약을 유지하고 SQL detail·사유 원문을 오류/로그로 내보내지 않는다.

동시 수락의 일정 충돌, 취소↔수락, 취소↔새 메시지, 기존 generation 무효화, 후기/완료 횟수 취소 제외, 비네이버 기존 회원의 사유 취소, 개인정보 반환과 실제 role 직접 접근을 로컬에서 검증한다. 실제 노쇼·제재·신고 판정과 보관/운영 배포는 이번 SQL의 성공으로 설명하지 않는다.

## 2026-10-05 확정 요청 6시간 연결

추가 마이그레이션 `20261005001429_current_completion_consent_policy.sql`의 `propose_match`는 요청+6시간과 동행 시작 시각 중 빠른 때를 `expiresAt`으로 저장한다. 기존 대기 요청의 만료 상한도 줄이고, 수락·종료 이력과 신청·대화는 보존한다. 마이그레이션 자체는 요청 종료나 약속 완료를 실행하지 않으며 기존 조회·만료 처리기가 상태와 알림을 처리한다. 동일 제안 재시도는 같은 조건 버전을 반환한다. 실제 SQL 실행·운영 적용은 별도 검증한다.

일정 변경 제안도 요청+6시간·기존 시작·새 시작의 최소 시각으로 만료된다. 기존 대기 제안만 새 상한으로 줄이고 종료된 제안의 원 만료·해결 이력은 보존한다. 새 DB 제약은 대기 제안의6시간 상한과 모든 제안의양 시작 상한을 검사한다. 장소 변경 입력은 이 마이그레이션에서 추가하지 않았으며 별도 연결 과제다.

## 명시 모집 재개와 취소 이력

`POST /posts/:id/reopen`은 작성자의 원래 JWT로 `reopen_service_post(p_post_id)`만 호출한다. `{postId,status:"recruiting",updatedAt,restoredCount,alreadyReopened}`를 반환한다. 취소 자체는 재개하지 않으며 삭제·시작/모집기한 경과·취소 아닌 약속이 있으면 거절한다. 모집기한을 자동 연장하지 않고 작성자가 공고 수정으로 기한을 변경한 뒤 재개할 수 있다.

현재 pending을 보존하고 같은 공고·회원의 전체 신청 이력 중 최신 row가 유효 not_selected인 경우만 기존 신청/방을 복원한다. 영구 거절 이력·최신 철회·차단은 제외하고, 이전 철회 이후의 유효 재신청은 복원한다. 취소된 matched 관계는 자동 복원하지 않는다. 재개 재시도는 추가 복원·알림을 만들지 않는다. 취소 약속을 제외한 partial unique로 새로운 확정을 허용하며 원래 취소 약속·조건·메시지는 보존한다.

새 취소에는 당시 시작·종료·공고 updatedAt 세 시각만 snapshot으로 기록한다. 기존 취소에 근거가 없으면 과거 시각을 추정하지 않는다. 이 경우 약속 get/list 시각은null이고 변경 상태의 startsAt/endsAt/updatedAt도null, scheduleProvenance는unknown이다. 새 정상 취소는captured_at_cancellation, 활성 약속은current_post다. 장소·주소·이름 snapshot을 추가 보존하지 않는다. 모바일에서 unknown을 현재 일정으로 대체하지 않도록 연결해야 한다.

실제 scratch SQL9그룹 및 두세션 재개3그룹 PASS. 다른 종료 이력·pending 공존·최신선택·후속 새 확정·차단 경합·취소 일정 조회를 확인했다. 운영 적용 및 모바일 통합은 별도 대기다.

## 장소 포함 변경 제안: 로컬 통합 검증

`POST /appointments/:id/schedule-change/propose`의 기존 `changeId`, `startsAt`, `endsAt`, `expectedUpdatedAt`에 선택 `location`을 추가한다. location을 보낼 때는 `publicArea`, `registeredPlaceName`(null 허용), `registeredAddress`, `meetingDetail` 네 필드를 모두 보낸다. 입력 한도는 각각 1~60, null 또는 1~200, 1~300, 2~300자이며 등록 장소 입력과 길이 검증을 공유한다. 공개 지역은 기존 17개 지역과 기존 지역 별칭만 받는다. 사용자 접수 시각·만료·역할·추가 필드는 받지 않는다. 시간만 바꿀 때 location을 생략하며 기존 5인자 RPC를 호출한다. location:null은 생략과 다르게 잘못된 입력이다.

시간과 장소를 함께 제안할 수 있으며 장소만 바꿀 때도 기존 시작·종료와 조회한 원본 updatedAt을 보낸다. 상대 수락 전에는 현재 공고·공개 검색·정확 위치가 바뀌지 않는다. 수락할 때 일정과 위치를 같은 트랜잭션에서 반영한다. 상대 응답 전 기존 위치 fingerprint가 달라지면 충돌이며 원래 값은 보존한다.

변경 객체의 `locationChanged:true`, `newLocation:object|null`은 장소가 포함된 제안에만 존재한다. 시간 전용 제안·GET에는 두 키를 추가하지 않아 기존 DTO를 보존한다. newLocation은 대기 중 confirmed 약속의 실제 당사자에게만 반환한다. 종료·취소·익명·비당사자에는 null이며 원래 공고 위치는 기존 조회 권한을 따른다. 장소 원문은 알림·오류 로그에 추가하지 않는다. 종료된 제안의 대기 장소 입력을 정리하는 동작은 검증된 기술 최소안이며 별도 제품 보관 정책 확정으로 설명하지 않는다.

독립 schema-only 장소 DB에서 SQL 8그룹, 두 세션 5그룹, HTTP 18개 테스트를 검증했다. 시간 전용 5인자/DTO 호환성과 선택 위치 입력·수락/거절/만료·현재 공고 검색·예약 원자성을 확인했다. 별도 철회 초안은 해당 DB에 적용하지 않았고 실제 withdraw는 NOT_RUN이다. 신뢰 접수 시각·마감 대기 경합 정책, 모바일 실제 연결, 운영 적용도 별도 미완료다.

민규 main worktree에는 장소 변경 SQL과 HTTP 연결을 통합했다. 정식 SQL 집합은 기존41개+신규11개=52개이며 함수282/282 및 서비스 API 타입 검사 PASS다. 독립 장소 DB의 위 검증과 main 전체 SQL 집합 검증은 별도 증거로 구분한다. 운영 적용·모바일 연결·마감 접수 경계는 완료되지 않았다.

53 입력 보완: 장소 제안의 publicArea는 기존 posts_public_area_format 전체형식(표준 시도+시군구+읍면동/가)을 사전 검사한다. 첫 지역 별칭은 기존17개 표준명으로 정규화한다. 동 누락 제안은 수락까지 대기시키지 않고 즉시 INVALID_REQUEST로 거절한다. 장소52 원문은 보존하며 별도53 migration을 추가했다. 실제 독립 Auth/Edge85개·장소 및 입력 보완 SQL 회귀 PASS다. 마감 접수·철회·모바일·운영은 별도 미완료다.

## 변경 제안 철회 후속 구현

40600과 POST `/appointments/:id/schedule-change/withdraw`를 연결했다. `{changeId,conditionVersion}`만 받으며 DB의 본인 제안자 검사 후 기존 종료 helper로 withdrawn 처리한다. 기존 약속·일정·장소·완료 예약은 유지하고 제안 위치 원문은 정리한다. withdrawn/expired/cancelled는 멱등 반환, 수락/거절 완료 및 옛 조건 버전은 충돌이다. 시간 전용 제안에 위치 키를 강제로 추가하지 않는다.

격리 native63 영속 적용 및 실제 Auth/REST/Storage12그룹, 별도8개 약속/제안 SQL 회귀가 PASS다. HTTP handler는 프로세스 내부 실행이고 네이버 응답은 합성이다. 철회/수락 실제 경합·신뢰 접수 시각 마감·hosted/모바일/운영은 남는다. [검증 범위와 영수증](../../docs/collaboration/requests/minkyu/2026-10-05-appointment-change-withdrawal.md)을 따른다.

## 2026-10-08 채팅 읽음 서버 연결

`POST /conversations/{requestId}/read`는 `{lastReadMessageId}`만 받는다. JWT 본인의 현재 열람 가능한 대화에 속하고 숨겨지지 않은 실제 메시지만 인정한다. 읽음 시각은 서버가 기록하며 `(메시지 생성 시각, UUID)` 위치가 후퇴하지 않는다. 중복·역순 요청은 현재 저장 결과를 반환한다. 새 메시지의 생성 시각은 대화 잠금 하에서 단조 증가한다. 조회와 알림 읽음은 이 상태를 변경하지 않는다.

회원 DB 허용 목록에 `mark_conversation_read`, `list_conversations_with_read_state`, `get_conversation_with_read_state`를 추가했다. 기존 대화 행에 본인 `last_read_message_id`, `read_at`, `unread_count`를 추가하며 상대 읽음 상태는 반환하지 않는다. 메시지 삭제 시 FK로 최소 읽음 상태를 삭제한다. 메시지 숨김은 목록·상세·읽지 않은 수에 반영하고 확정 동행 관리 API는 유지한다. 모바일 DTO 연결은 종현 인계 범위다.
