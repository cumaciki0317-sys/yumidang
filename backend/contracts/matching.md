# 신청·최종 동의·변경 계약

현재 기준은 [정책.md](../../정책.md)다. 아래에서 현재 정책 목표와 기존 기술 인터페이스를 구분한다. 이번 문서 동기화는 서버 코드·SQL·설정·DB·외부 호출·배포를 변경하거나 검증하지 않았다.

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

기존 `request_service_post(p_post_id,p_message)`와 신청 ID에 연결된 메시지·대화 구조는 첫 채팅 원자 신청/기존 방 재사용에 맞춰 변경·검증해야 한다. 최종 동의 만료, 모집 재개 복원, 변경 제안 장소·철회·6시간 상한과 제재도 아래 함수의 존재만으로 지원 완료라고 보지 않는다. 기존 RPC 인수·잠금·멱등성을 보존하면서 후속 담당자가 새 연결 계약을 작성한다.

## 확정 후 일정 변경·사유 취소 DB/API

아래는 기존 일정 변경·취소 RPC의 인수·응답이다. 현재 장소 변경·제안 철회와 기한 정책은 추가 연결이 필요하다. 기존 get_appointment_state table 응답과 중복 처리 경계는 보존한다.

| RPC | 인수 | 반환 |
|---|---|---|
| get_appointment_change_state | p_appointment_id uuid | appointmentId, status, startsAt, endsAt, updatedAt, change, cancellation |
| propose_appointment_schedule_change | p_appointment_id uuid, p_change_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_expected_updated_at timestamptz | 변경 객체와 deduplicated |
| accept_appointment_schedule_change | p_appointment_id uuid, p_change_id uuid, p_condition_version text | 변경 객체와 deduplicated |
| decline_appointment_schedule_change | 같은 세 인수 | 변경 객체와 deduplicated |
| cancel_appointment | p_appointment_id uuid, p_cancellation_id uuid, p_reason text | appointmentId, status:cancelled, cancellationId, reason, cancelledAt, deduplicated |
| expire_appointment_changes | p_limit integer default 100 | expiredCount — service_role 전용 |

HTTP는 `GET /appointments/:id/schedule-change`, `POST /appointments/:id/schedule-change/propose`·`accept`·`decline`, `POST /appointments/:id/cancel`이다. propose body는 changeId/startsAt/endsAt/expectedUpdatedAt, 응답 body는 changeId/conditionVersion, 취소 body는 cancellationId/reason이다. 서버가 검증한 본인 ID를 사용하며 외부 사용자 ID·완료 시각·취소 시각을 입력받지 않는다. 시각 문자열은 offset ISO 형식이고 DB가 실제 서버 시각과 다시 대조한다. expectedUpdatedAt은 조회한 원본 소수 정밀도를 그대로 보낸다.

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
