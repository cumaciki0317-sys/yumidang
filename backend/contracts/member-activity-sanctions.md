# 신규 활동 제재 gate 및 본인 상태 조회 계약

작성자 minkyu. 정책2-3/6-3을 기준으로 21810 원본 파일을 바꾸지 않고 신규 `20261005021811_member_activity_sanction_gates.sql`에서 owner 함수의 본문만 보완한다. 초기 작성 시 DB 생성/dump/apply/회귀/두 세션은 NOT_RUN이었다. 현재 격리 native65에는21810/21811·40700·40800이 적용되어 있으며, 후속 본인 조회의 SQL·HTTP 검증 범위는 아래 최신 기록을 따른다. 운영 제재 시행·모바일·운영자 연결 완료를 주장하지 않는다.

## 적용 범위와 기존 책임

| 실제 신규 쓰기 | gate 대상 owner 함수 | 보존하는 경로 |
|---|---|---|
| 공고 신규 INSERT | private.create_service_post_before_member_retirement(uuid,jsonb) | 같은 postId/동일 입력 생성 성공 재조회 |
| 신청 최초 INSERT·withdrawn→pending 재신청 | private.request_service_post_without_blocks(uuid,uuid,text) | 성공한 messageId 재시도·이미 pending인 신청의 기존 채팅 |
| 새 최종 동의 요청 INSERT/upsert | private.propose_match_without_blocks(uuid) | 같은 유효 동의 요청 재조회 |
| 새 약속 확정 | private.accept_match_without_blocks(uuid,text) | 기존 약속 alreadyConfirmed 재조회 |

복원된 pending 신청도 새 propose/accept 쓰기에 같은 본인 gate를 적용한다. public RPC의 OID/이름/인자/기본값/결과 DTO/owner/ACL은 그대로다. 공개 body·lifecycle·blocks·reopen·장소 계약을 새 별칭으로 대체하지 않는다. private 실제 쓰기 분기에 정확한 원문 anchor가 한 번 존재하는지 검사하고 CREATE OR REPLACE를 실행하며 전후 OID/owner/ACL/인자/반환 메타데이터를 비교한다. 기존 함수가 바뀌어 anchor가 없거나 중복되면 migration 전체를 중단한다.

require_service_profile/require_member_uid/현재 회원 공통 가드에 제재를 섞지 않는다. 기존 확정 관리·취소/일정 변경·완료·기존 메시지·후기·프로필/본인 자료·신고·탈퇴·재가입 함수는 수정하지 않는다. 이의 gateway는 기존에도 미연결이며 새 권한을 만들지 않는다. native의 구형 create_join_request/두 인자 request/confirm_match 등 닫힌 우회 RPC와 owner alias ACL은 회귀에서 검사한다. direct table 쓰기를 새로 허용하지 않는다.

## 본인 identity와 종료 경계

새 private.assert_new_member_activity_allowed는 기존 lifecycle account→profile→active episode 공유 가드 다음에 verified subject→account.userId→identity→같은 active episode 연결을 재조회한다. 신규 gate는 제재 identity 때문에 female/19+/qualification을 별도 요구하지 않는다. 기존 서비스의 신규 활동 자격 검사는 그대로다. verifiedAt/completedAt가 없거나 미래·회원 연결이 끊겼으면42501이며 데이터 없는 임의 identity를 허용하지 않는다.

같은 identity의 revokedAt=NULL 적용 원장에서 permanent 또는 기간제 expiresAt>DB clock일 때만 member_activity_restricted(42501)를 반환한다. expiry와 같거나 지난 시각은 허용한다. 경고만으로 활동을 막지 않는다. 겹친 기간·영구 제재는 21810 원장 그대로 읽으며 기간을 합산·연장·초기화하지 않는다. 재가입 새 UUID/episode에서도 같은 서버 검증 identity가 연결되면 기존 적용 종료 시각을 승계한다. 새 당도는15이며 과거 회차 감점을 복구하지 않는다. 종료 회차 사건의 무효 정정은 원 회차 결정을 정정하고 현재 회차 gate를 즉시 풀 수 있어야 한다. 최소 연결 정보 보관 근거·종료 정책은 확정하지 않는다.

## 판정 잠금 보완과 동시성

21810 파일의 바이트는 보존한다. 신규 migration에서 record_incident_revision의 affected episodes 집합에 각 identity의 현재 active episode를 추가한다. 기존 원 회차와 현재 회차의 account→profile→episode를 순서대로 FOR UPDATE NOWAIT 잠근 뒤 기존 identity→사건→제재/당도 처리로 진행한다. 이로써 episode SHARE 뒤 identity UPDATE 후 당도 episode UPDATE 승격을 기다리는 기존 경계를 제거한다. 종료 회차 사건을 무효화하여 현재 회원의 제한을 푸는 경우에도 현재 회차를 선행 잠근다.

회원 활동은 기존 공유 가드를 얻은 뒤 제한을 읽기만 한다. 추가 identity row lock/table SHARE/global lease 잠금은 넣지 않는다. 판정의 NOWAIT 충돌은 lock_not_available를40001 state_conflict로 변환해 전체 판정을 롤백한다. 기존 두 회원 guard의 actor-first 계정 공유 잠금과 복수 대상 판정의 정렬 계정 배타 잠금이 교차하는 경우에도 잠금 대기 대신 충돌 재시도로 처리하도록 설계한다. 완료 실패를 판정 성공으로 바꾸지 않는다. 실제 두 세션에서 검증하기 전 교착 안전성 완료로 표시하지 않는다.

필수 독립 scratch 경합 회귀 계획:

1. 세션A BEGIN/authenticated actor로 private.require_service_profile() 공유잠금 유지. 세션B owner record 확정/무효 정정은 NOWAIT40001이어야 하며 사건 revision·원장·당도 변경이 없어야 한다. A 종료 후 B 같은 expectedRevision으로 재시도 성공, 다음 A 신규 활동 gate42501/정정 후 허용 확인.
2. 세션B owner 확정 적용 뒤 COMMIT 전 잠금 유지. 세션A 신규 활동이 회원 공유잠금에서 기다린 후 B COMMIT 뒤42501이어야 한다. B ROLLBACK이면 A 정상 진행한다. 세션 timeout을 걸고 deadlock40P01이나 가짜 성공을 허용하지 않는다.
3. 종료 원 회차 사건 정정에서 현재 새 UUID/active episode 공유잠금을 A가 잡으면 B40001·원장 불변이어야 한다. A 종료 뒤 B 정정 성공과 새 회원 gate 해제를 확인한다.
4. 양 대상의 actor-first 순서와 반대 정렬로 세션A lock_live_request_pair까지 진행, B 복수 대상 판정 NOWAIT 충돌/전체 롤백을 확인한다. account→profile→episode 각 단계와 실제 retire_my_account의 동일 계정 배타 잠금 교차도 검사한다. 승인 guard는 production이 아니라 격리 합성 DB에서만 준비한다.

## 단일 transaction 회귀 준비와 제한

`tests/database/minkyu/member_activity_sanction_gates.sql`은 resolve/record_session/complete_signup을 거친 합성 회원과 실제 서비스 RPC로 준비한다. 제한 본인의 신규 생성/신규 신청/재신청/새 propose/accept 차단, 기존 pending 채팅·success retry·기존 약속 조회·후기 허용, 무효 정정 즉시 해제, 정확 기간 종료/경고 허용, 새 UUID의 기존 영구 제한 승계와 종료 회차 무효 정정, 닫힌 owner/legacy ACL을 검사하도록 작성했다. 시간 경계와 재가입 identity 이동은 owner 합성 metadata이며 실제 Auth 삭제·네이버 재인증 성공 증거가 아니다. 전체 rollback이며 독립 scratch의 실제 단독 SQL 회귀가 PASS했다. 원장 expiry를 이동할 때 appliedAt도 같은 DB 시각 anchor−168h로 맞춘다.

상대방이 제재 중인 경우 정상 본인의 새 request/accept도 막아야 하는지는 정책에 직접 명시되지 않아 사용자 답 대기다. 현재는 행위자 본인의 제한만 연결하며 이 상대방 규칙을 확정하지 않는다. 기존 공고 reopen 자체를 신규 공고 작성으로 취급해 제한할지도 직접 명시되지 않았다. reopen은 수정하지 않고 복원 신청의 새 확정 행위에 본인 gate를 적용한다. 사용자 답에 따라 별도 검토가 필요하다.

원장 판정·일반 복수 재발 사슬 정책, 제재 알림/S21, 직원 운영 권한, 이의 공개 gateway, 최소 기록 보관 법적 검토, 기존 요청·동의 정책은 이 migration으로 완성되지 않는다. 기능 상태는 '독립 source56 schema-only scratch의 SQL 회귀·실제 7개 두 세션 경합·fixture 정리 PASS, main/운영 미적용'이다.


## 실제 독립 검증 증거 (2026-10-05)

`yumidang_activity_concurrency_20261005`에 source56 스키마만 복원하고 immutable21810와21811을 적용했다. 준비 설정은 누락된 member_cleanup_guard singleton에 false를 INSERT한 것이며 앱·회원 자료와 구분한다. 실제 두 세션 harness는 공유 guard→판정40001/재시도, 판정 COMMIT→신규42501, ROLLBACK→허용, 종료회차 정정의 현재회차 잠금, actor-first 복수대상 propose 경합, 탈퇴↔판정 양방향 경합을 검증했다. 실제 pg_stat_activity Lock 대기와 판정 metadata rollback을 확인했고 7건 모두 PASS했다.

첫 SQL 구문 오타와 schema-only guard 행 누락, Storage metadata bucket 정리 보호 오류는 별도 FAIL artifact로 보존했다. 교정 후 단독 SQL와 run3 전체 결과가 PASS했다. 마지막 FK cascade 합성 fixture 범위는 모두0이며 false guard·cleanup5 ACL·global roles hash가 실행 전후 동일했다. 열린 probe handle도0이다. retire 준비의 임시 ACL/guard는 해당 transaction에서 항상 ROLLBACK했다. source/native/운영 및 전역 역할은 변경하지 않았다. Storage 객체 blob·실제 Provider 삭제·실제 네이버 재인증은 이 검증의 증거가 아니다.

비공개 실행 증거는 `activity-concurrency-run3/receipt.json`, 단독 SQL는 `activity-concurrency-preparation/regression2.log`이며 최종 파일 SHA는 `member-activity-sanctions-final-handoff.json`으로 전달한다. 사용자 답 대기 정책은 그대로 미완료다.


## 본인 현재 제한 조회 연결

GET `/me/safety` → 회원 `get_my_safety_state()`는 기존 회원 관리 가드와 active episode/account/key 연결을 확인하고 같은 SQL statement에서 기존 `safety_restriction_state` 요약과 유효 원장 목록을 읽는다. 신규 활동 제한을 본인 조회 가드에 추가하지 않는다. 반환4키는 permanent/restrictedUntil/hasWarning/sanctions, 목록5키는 sanctionId/kind/appliedAt/expiresAt/notifiedAt이며 원문·타인 사건·추정 마감은 없다. 무효·만료 원장은 목록에서 제외한다. 종료 이력·사유·이의 안내는 아직 이 DTO로 구현되지 않았다.

40700의 native63 단일TX 실제 SQL 검증 및 전체rollback은 PASS다. 영속40700·실제Auth/REST·모바일·운영은 미완료다. [범위와 실패/수정 기록](../../docs/collaboration/requests/minkyu/2026-10-05-member-safety-state.md)을 따른다. 이 새 조회 증거가 본문의 과거 제재 gate 초안 전체의 운영 완료를 뜻하지 않는다.


후속 검토64개 소스 준비와 격리63→64 공식CLI 영속 적용은 PASS다. 신규40700 조회 함수만 추가했고 기존 public/private 함수 정의와 owner/ACL, 역할/자료/제약을 보존했다. 준비만으로 실제회원API를 검증했다고 보지 않으며 실제회원API는 별도 진행한다.


후속 native64 실제회원API13그룹/정리 PASS: 본인현재제재의 exact DTO, 타인/만료/무효제외·정정·정보누락본인관리를 확인했다. 안전원장은owner 합성이며 운영판정·통지·이의·모바일·운영은 이 증거에 포함하지 않는다.


후속40800은 실제 약속 확정·합의 일정·취소·완료 사실을 고정 회차/검증 identity의 결과원장에 연결한다. 새 자동 기록은 origin appointment, 과거 미상은 legacy_unknown으로 구분하고 운영 판정·검토·면제 기록을 덮어쓰지 않는다. 과거 순서는 현재 공고로 추정하지 않으며 미연결 집계/unknown은 전체 과거 이력 완성 증거가 아니다. owner 결과 함수 직접 실행 권한은 공개하지 않고 자동제재·사유 판정·통지를 추가하지 않는다.

native64+40800 실제SQL/RPC·비어 있지 않은 과거이관·기존 계산 통합 회귀/rollback과 격리64→65 공식CLI 적용 PASS. native65 회원API14그룹은 실제HTTP 확정·합의수락·취소로 파생된 결과원장과 exactfixture정리/권한/이력/컨테이너 보존을 확인했다. 완료 연결은 SQL/RPC 증거이며 이번API에서 완료HTTP를 검증하지 않았다. 새원장의 실제두세션/완료전신고검토/통지/이의/운영/모바일은 남는다. [현재 연결 검증](../../docs/collaboration/requests/minkyu/2026-10-05-appointment-safety-result-sync.md)을 따른다.
