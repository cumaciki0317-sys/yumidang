# 회원 차단·모집 재개·취소 이력 모바일 연결 요청

작성자 민규. 종현 소유 apps/mobile 파일은 수정하지 않았다. 기존 [현재 연결 인계](2026-10-05-current-policy-integration.md)에 추가되는 검토50 SQL 기준이다.

## 연결 계약

| 동작 | 회원 JWT 경로·입력 | 응답 |
|---|---|---|
| 차단 | POST /profiles/:id/block `{}` | `{targetId,blocked:true,alreadyApplied}` |
| 본인 차단 해제 | POST /profiles/:id/unblock `{}` | `{targetId,blocked:false,alreadyApplied}` |
| 본인 차단 목록 | GET /me/blocks?limit=20&before=UUID, 1..100 | `{items:[{targetId,blockedAt}],nextCursor}` |
| 작성자 명시 재개 | POST /posts/:id/reopen `{}` | `{postId,status:"recruiting",updatedAt,restoredCount,alreadyReopened}` |

차단/해제 응답의 blocked는 본인이 설정한 방향이다. 상대가 본인을 차단한 경우 해제로 양방향 활동이 열린다고 추정하지 말고 실제 탐색·신규활동 권한을 다시 확인한다. 목록에는 사진/이름을 서버가 추가하지 않는다. 차단은 즉시 새 메시지·신청·요청/수락을 막고 로그인 탐색·프로필을 숨긴다. 기존 대화 읽기·나가기·약속 관리는 유지하며 약속 취소를 자동으로 보내지 않는다. 완료·취소 기록은 appointment 문맥으로 조회한다. 해제는 종료 관계를 자동 복원하지 않는다.

재개는 삭제·시작/모집기한 경과·취소 아닌 약속에서409/404다. 모집기한은 자동 연장하지 않으므로 작성자가 공고 수정으로 미래 기한을 설정하고 재개한다. 최신 유효 not_selected만 복원하고 거절 이력·최신 철회·차단은 제외한다. 과거 철회 이후의 유효 재신청은 복원한다. 취소한 matched 관계는 자동 복원하지 않는다. 같은 방과 메시지를 보존하며 재개 반복은 추가 알림이 없다.

## 취소 시각의 unknown 처리

새 취소는 시작·종료·공고 updatedAt을 취소 시점에만 기록한다. 과거 근거가 없는 취소 이력은 과거 일정으로 현재 공고 값을 표시하지 않는다. get_appointment_state/list_my_appointments의 취소 시각은null일 수 있고 get_appointment_change_state의startsAt/endsAt/updatedAt도null일 수 있다. scheduleProvenance는unknown/captured_at_cancellation/current_post다. unknown 화면은 일정 근거 미상을 표시하고 날짜 파서 실패로 전체 목록을 버리지 않는다. 새 장소·주소·이름의 과거 사본을 추가 보존하지 않았다.

## 완료 확인 조건

HTTP7개·전체 함수279개·통합 SQL9파일 및 실제 두세션 차단/전송·재개 경합 PASS. 구형 작성자 RPC3개도 익명 JWT/회원프로필 없는 UID에 거절하도록 검사했다. 위 결과는 격리 합성 데이터이며 실제 모바일 Auth→HTTP→DB QA·운영 SQL 반영은 아직 대기다. 예외/재시도/차단 직후 화면·캐시 숨김을 실기기에서 확인하고 기존 약속 취소를 별도 사용자 확인 흐름으로 유지한다.
