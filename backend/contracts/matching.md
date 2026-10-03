# 신청·최종 동의·변경 계약

주담당: 민규. 기준: [정책.md](../../정책.md), [상세 설계](../../PLAN_상세설계.md). 2026-10-02 공고·최종 동의 생명주기를 신규 SQL과 기존 서비스 API에 구현했다. 실제 검사와 미검증 범위는 [이번 인계](../../docs/collaboration/requests/minkyu/2026-10-02-matching-lifecycle-handoff.md)를 따른다. 원격 적용·배포 완료를 뜻하지 않는다.

## 신청과 상대 선택

- 현재 무료 1:1 동행이다. 신청 소개 메시지는 필수이며 실패하면 입력을 유지하고 성공하면 해당 대화로 연결한다. 첫 채팅 전에는 신청이 성립하지 않는 대안은 팀 검토이며 현재 적용하지 않는다.
- 신청 시 일정 겹침은 안내하고 계속할 수 있다. 최종 확정에서는 양측의 기존 확정 동행과 겹치면 차단한다.
- 같은 공고에서 거절 후 재신청은 불가하고 본인 철회 후에는 가능하다.
- 작성자가 한 신청자를 선택해 최종 동의를 요청하고 신청자가 같은 조건·버전에 동의해야 확정된다. 작성자 선택만으로 다른 신청을 종료하지 않는다.
- 활성 최종 동의 요청은 한 번에 한 명이다. 다른 사람에게 요청하려면 기존 요청을 철회한다. 여러 사람의 신청·대화 자체를 한 명으로 제한하는 뜻은 아니다.
- 요청 발송 후 24시간과 동행 시작 시각 중 먼저 오는 때에 만료한다. 만료·철회·거절은 해당 동의만 종료하고 기존 신청·대화는 유지하며 양쪽에 알린다.
- 수동 모집 마감은 새 신청만 차단한다. 유효한 기존 신청자에게는 시작 전까지 최종 동의를 새로 요청하거나 재요청할 수 있다. 이전에 공고 신청 자체를 거절당한 사람의 재신청 금지는 별개다.
- 확정 직전 공고 정원·조건 버전·양측 일정 충돌을 재검사한다. 확정이 성립하면 미선정 신청·동의 요청을 종료하고 결과를 알리며 그 대화는 읽기 전용으로 보존한다. 자동 대기자·자동 재확정은 없다.

## 수정·취소

확정 전 공고 핵심 조건(일정·장소·활동 내용) 수정 시 기존 신청자에게 알리고 진행 중 최종 동의를 무효화한다. 신청·대화는 유지하고 새 조건으로 다시 동의한다.

확정 후 시작 전에는 새 일정을 제안하고 상대 동의가 있어야 반영한다. 거절·미응답이면 기존 일정을 유지한다. 응답 기한은 기존·새 시작 시각 중 빠른 시각이며 새 일정도 충돌 검사한다. 어려우면 별도 취소한다.

시작 전 어느 쪽이든 사유를 남겨 취소할 수 있고 상대에게 알린다. 시작 이후는 중단·불발 신고로 접수한다. 취소·불발·분쟁은 자동 완료에서 제외한다. 취소 성립 후 구조화된 전체 이름은 다시 마스킹하고 정확한 주소·상세 지점은 숨긴다. 이미 본 내용이나 기존 채팅을 원격 회수하는 의미가 아니다.

## 구현과 검토 경계

`propose_match`·`get_match_consent`·`accept_match`와 새 `withdraw_match_consent`·`decline_match_consent`의 실제 인수·잠금·반환은 [핵심 DB 계약](core-service-db.md), HTTP 경로는 [서비스 API](service-api.md)를 따른다. 동의 철회·거절에는 현재 `conditionVersion`이 필요하다. 재요청은 새 버전이며 오래된 버전으로 새 요청을 종료하거나 확정할 수 없다.

새 요청은 `awaiting_consent`, `accepted`, `expired`, `withdrawn`, `declined`, `invalidated`로 구분한다. 메타데이터가 없는 과거 미수락 동의는 `renewal_required`이며 다시 요청해야 한다. 과거 행을 일괄 종료·자동 수락하지 않는다. 종료된 신청의 대화는 보존하고 본인 철회 후 재신청은 새 신청·대화를 만든다. 기존 재신청 DB 구현을 재사용한다.

만료 판단은 서버 시각으로 하고 조회·정상 후속 작업·내부 `expire_match_consents` 호출에서 종료와 양쪽 알림을 같은 트랜잭션으로 처리한다. 만료 시각 이후에는 수락할 수 없다. 기한마다 내부 RPC를 호출하는 운영 실행기의 연결·배포는 별도이며 이번 구현을 정시 알림 운영 완료로 해석하지 않는다.

확정 후 일정 변경·취소는 아래 신규 SQL/RPC로 연결한다. 실제 실행 결과와 미검증 범위는 순차 작업 인계에 기록한다. 취소 상태에서 상세/RLS를 통해 상대의 전체 이름·정확한 장소를 추가 조회하지 못하도록 반환 권한을 적용한다. 공고 삭제는 현재 문서의 확정 이력 종료 전 보호를 유지하며 취소로 공고를 자동 삭제하거나 모집을 재개하지 않는다.

노쇼·분쟁 판정·증거·소명·종결·이의 절차와 제재 세부 수치는 팀 검토다. 일반 신고·분쟁 처리를 위해 운영자가 DB 채팅 원문을 직접 열람하지 않고 당사자 제출 캡처로 접수한다. 캡처 처리 근거·접근·보관·삭제 정책도 팀 검토다.


## 확정 후 일정 변경·사유 취소 DB/API

`20261002120000_appointment_changes.sql`은 과거 최종 동의·약속·완료 시각을 수정하지 않고 시작 전 일정 변경 제안과 사유 취소를 추가한다. 파일 작성, 실제 로컬 SQL/HTTP/경쟁 검사, 원격 적용·배포는 구분한다. [순차 작업 인계](../../docs/collaboration/requests/minkyu/2026-10-02-ordered-backend-handoff.md)에 실행 결과를 기록한다. 기존 get_appointment_state table 응답은 변경하지 않는다.

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

응답 기한은 기존 시작과 새 시작 중 빠른 시각이다. 기한 정각부터 수락할 수 없다. 제안자 본인은 수락/거절할 수 없고 상대가 해당 changeId·conditionVersion으로 응답한다. 오래된 버전, 원래 일정/updatedAt 불일치, 완료·취소·분쟁 상태와 기한 초과는 수락 충돌이다. 거절·만료·미응답은 기존 일정을 유지한다. 거절이 시간 만료 후 도착하면 expired 상태를 반환하며 기존 일정은 그대로다.

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
