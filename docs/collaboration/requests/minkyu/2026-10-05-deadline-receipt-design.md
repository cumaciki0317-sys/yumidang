# 마감 요청의 신뢰 접수 원장 설계와 현재 구현 차이

이 문서는 민규의 설계 초안이다. 기준은 main의 고정된 50개 SQL과 정책.md 5-3이다. 51번째 `20261005012027_appointment_change_withdrawal.sql`은 독립 초안이며 main 복사·DB 적용·HTTP 연결·실제 회귀를 하지 않았다. 기존 50개 source를 수정하지 않았다.

## 확정 정책과 시각의 의미

수락·후기 제출·이의 신청 등 마감 요청은 서버 접수 시각이 마감보다 빠를 때만 허용한다. 정각부터 만료다. 시각 조건을 통과해도 다른 사람이 이미 수락했거나 약속이 취소·분쟁 상태인 경우 과거 상태를 되살리는 규칙은 없다. 요청자가 일정 변경 제안을 철회하면 원래 약속을 유지한다.

`now()`는 transaction 시작, `statement_timestamp()`는 현재 SQL 명령 수신, `clock_timestamp()`는 실제 평가 시각이다. 잠금 뒤 clock을 마감 판정에 사용하면 대기 시간이 사용자에게 전가된다. 오래 열린 transaction의 now는 마감 이후 새 명령도 과거 시각으로 판정할 수 있다. 이 차이는 [PostgreSQL 17 시각 함수 문서](https://www.postgresql.org/docs/17/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT)에 따른다.

기술안은 세 시각을 구분한다.

| 값 | 신뢰 경계와 용도 |
|---|---|
| HTTP 도착 시각 | 인증 서버가 관찰한 시각. 네트워크·인증·DB 연결 대기 이전이다. 기존 API에는 이 시각을 증명하는 DB 계약이 없다. |
| received_at | 신뢰 intake RPC의 단일 SQL command에서 DB가 `statement_timestamp()`로 생성. 마감 적격성용 제안이며 client body의 시각은 받지 않는다. |
| processed_at/resolved_at | 잠금 뒤 실제 전환 시각 `clock_timestamp()`. 감사·이력·worker lease 검사에 사용하며 접수 판정을 대신하지 않는다. |

정책의 ‘서버’가 HTTP 도착까지 보장하는지 DB의 신뢰 수신 경계까지 보장하는지는 현재 문구만으로 동일하다고 단정할 수 없다. DB 접수 기술안을 채택하더라도 HTTP→DB 대기 시간까지 해결했다고 설명하지 않는다. client supplied time을 받아 이 차이를 메우지 않는다.

## 현재 RPC별 차이

파일은 authoritative main에서 읽었으며 행 번호는 해당 source 기준이다.

| RPC/처리 | 현재 근거 | 차이 |
|---|---|---|
| 일정 변경 철회 draft | 51 SQL:28~39, post→requests→appointment→change 잠금 뒤 expiry helper, 이후 clock | 접수가 마감 전이어도 기다리는 동안 expired가 될 수 있다. saved statement 시각만 교체하면 선행 expiry가 여전히 종료한다. |
| 일정 변경 수락 | `20261002120000_appointment_changes.sql`:157~168 | 잠금과 당사자 일정 advisory lock 뒤 response_open(clock). 마감 전 접수도 40001이 될 수 있다. |
| 일정 변경 거절 | 같은 파일:188~197 | 잠금 뒤 expire(clock), 그 결과 expired 반환. 접수 시각 기준 거절과 구분되지 않는다. |
| 변경 제안/6시간 시작 | `20261005001429_current_completion_consent_policy.sql`:135~155 | requested_at을 잠금 뒤 clock으로 계산한다. 요청 처리 지연과 요청 접수 시각을 같은 값으로 볼 수 없다. |
| 후기 제출 | `20261002110000_completion_review_policy.sql`:77~100 | appointment FOR UPDATE 뒤 can_submit(clock). 기한 전 접수도 대기 뒤 거절된다. submitted_at 기본 now와 적격성 clock도 서로 다른 시각이다. 동일 내용 성공 재시도는 기한과 무관하게 기존 성공을 반환한다. |
| 완료 이의 신청 | `20260917005621_retry_completion_dispute_review_policy.sql`:291~315 | 잠금 뒤 now로 기한/남은 후기 기간을 계산한다. 대기 시각으로 늦어지지는 않지만 오래 열린 transaction의 새 명령은 기한 후에도 허용될 수 있다. raised_at 기본 now도 동일 문제다. |
| 변경 만료 worker/조회 | `20261002120000_appointment_changes.sql`:84~91, 101~102, 232~243 | worker는 post SKIP LOCKED로 혼잡을 피하지만, foreground가 아직 post를 얻지 못했거나 다른 lock에서 기다리면 먼저 expired를 commit할 수 있다. 조회도 상태를 만료시킨다. |
| 후기 공개 worker | `20260929120000_review_release_and_completion_reservations.sql`:134~148, 최신 review_release_ready는 `20261005001429...` | appointment SKIP LOCKED로 공개를 원자화한다. 아직 접수 원장에 보이지 않는 기한 전 후기/이의 요청의 존재까지 알지는 못한다. 이미 공개된 후기의 유지 정책은 별개다. |

위 항목은 source 읽기 근거다. 마감 직전 잠금 대기 실험은 이번 감사에서 실행하지 않았다. 기존 모집 재개 검증의 PASS를 이 접수 계약 검증으로 재사용하지 않는다.

## 작은 수정과 전체 해결을 분리

공개 RPC에서 `received_at := statement_timestamp()`를 먼저 저장하고, 목표/version 확인→접수 적격성→현재 상태 확인→원자 전환 순서로 처리하는 것은 첫 단계다. foreground는 이 요청을 판정하기 전에 current clock expiry를 호출하지 않는다. background lease·공개 시점·실제 종료 시각의 clock은 그대로 필요하다. 모든 시각 함수를 전역 치환하지 않는다.

그러나 worker가 이미 expired를 commit했다면 saved 시각만으로 안전하게 해결되지 않는다. 새 proposal, 조건 수정, 다른 사람의 수락·거절, 약속 취소·분쟁을 뒤집으면 안 된다. 현재 lifecycle event의 unique key는 같은 version의 종료 알림을 한 번만 보낸다. expired를 무조건 withdrawn/accepted로 바꾸면 이전 알림과 종료 이력이 틀어질 수 있다. 따라서 51 단순 timestamp 수정은 정책 완료가 아니다.

## 제안하는 gateway·DB 경계

구현 범위는 민규의 인증/HTTP/DB/RPC와 새 migration이다. 종현 worker는 요청 문서로 연결하며 직접 수정하지 않는다. DB에는 원문을 넣는 대기 작업을 추가하지 않는다.

1. 인증 gateway가 JWT와 session, 현재 회원 상태·회차, action body를 검증한다. 사용자는 receipt 시각·actor ID·새 상태를 지정하지 않는다.
2. gateway가 service_role 전용 intake RPC를 호출한다. intake가 DB 접수 시각·server UUID·자원/version 결합·payload fingerprint를 생성해 **별도 transaction으로 commit**한다.
3. commit 확인 후 같은 HTTP 흐름의 메모리에 있는 원본 body로 consume RPC를 호출한다. consume은 receipt·actor·session/회차·action·자원/version·fingerprint를 재검증하고, 기존 잠금 순서 아래에서 현재 상태를 확인하여 단 한 번 처리한다.
4. 성공/충돌/실패 결과는 안전한 receipt 결과에 기록한다. 채팅·후기·사유 원문은 receipt·작업 로그에 보존하지 않는다. 실제 성공 후기 원문은 기존 후기 저장소의 정책을 따른다.
5. 원문이 메모리에서 사라진 장애는 클라이언트가 같은 receipt ID와 같은 body를 재제출한다. durable receipt만으로 원문을 재구성하거나 자동 제출하지 않는다.

### 제안 원장 필드와 키

`private.deadline_receipts`라는 새 책임의 표를 제안한다. 기존 AI quota·작업 lease 원장을 재활용하지 않는다.

| 항목 | 목적 |
|---|---|
| receipt_id UUID | server 생성 PK |
| user_id, member_episode_id, session_id | 신뢰 회원/회차/세션 결합. 회차 exact 계약은 담당 SQL와 연결하며 본 문서에서 회차 저장소를 만들지 않는다. |
| action, resource_type, resource_id, condition_version | 요청 범위. 변경 제안은 changeId+conditionVersion, 후기·이의는 해당 기한/상태의 별도 epoch 필요. |
| client_request_hash | 재시도 요청 ID 원문은 보존하지 않고 hash. 사용자·action·자원 scope 안에서 unique. |
| payload_fingerprint, fingerprint_key_version | 기존 body 검증/정규화 후 HMAC fingerprint. 낮은 경우의 수를 가진 평가·사유 원문을 단순 공개 hash로 추측하기 어렵게 한다. |
| received_at, deadline_at, admission_epoch | 신뢰 수신과 당시 기한/세대. 사용자 입력 시각 없음. |
| status | pending, processing, succeeded, conflicted, retryable_failure 등의 기술 상태. 업무 상태와 별도. |
| consume_token, lease_expires_at | 내부 한 번 처리. lease는 clock 검증하며 마감 접수 시각을 변경하지 않는다. |
| completed_at, result_code, safe_result | 실제 처리 결과·허용 UUID/상태·deduplicated 정보. 원문·SQL detail 없음. |
| retention_until | 보관/재시도 관리. 확정 보관 정책 없이 기간을 임의 seed하지 않는다. |

같은 회원/action/자원/client request hash가 같은 fingerprint면 기존 receipt를 돌려준다. fingerprint가 다르면 충돌이다. consume은 receipt 행 잠금과 exact scope를 확인하여 같은 성공을 재반환하고 업무 알림을 다시 만들지 않는다. resource별 version은 latest proposal만이 아니라 후기/이의 기한 재개·분쟁 전환도 구분해야 한다.

### direct RPC 우회 방지

authenticated에 기존 최종 mutation EXECUTE가 남아 있으면 intake를 우회할 수 있다. 공개 사용자에게는 gateway 접근만 제공하고, 기존 핵심 함수는 private owner-only로 옮기거나 service_role 전용 consume wrapper에서만 호출하도록 명시 migration으로 전환해야 한다. PUBLIC·anon·authenticated 상속 EXECUTE를 모두 실제 권한 검사한다. service_role이 user_id를 바꿔 넣는 권한은 신뢰 gateway에 한정하며 HTTP body의 actor ID를 전달하지 않는다. JWT/session·회원 회차는 consume에서도 검증한다. 신규 기능의 서비스 사용 제한과 기존 약속 관리 허용을 혼동하지 않는다.

## admission과 worker 경합의 계약

receipt INSERT와 자원 상태 갱신을 같은 긴 transaction에 넣으면 worker가 미commit receipt를 볼 수 없다. 별도 commit이 필요하지만, 두 transaction이라는 이유만으로 다음 race가 사라지는 것도 아니다.

- intake SQL이 마감 전에 시작했으나 admission 잠금에서 기다린다.
- worker가 receipt commit 전에 같은 version을 expired로 확정하고 알린다.
- receipt가 나중에 commit한다.

따라서 admission·만료·새 version 시작을 같은 짧은 resource/epoch gate로 직렬화하고, intake가 성공적으로 등록된 pending eligible receipt는 worker가 종료/공개를 확정하기 전에 확인해야 한다. worker는 pending eligible receipt가 있으면 처리·재시도를 기다리고, receipt consume과 같은 epoch를 원자적으로 재검사한다. 변경 만료와 후기 공개/이의 기한 판단 모두 필요하다. processing lease가 만료되었다는 이유만으로 접수 자체를 기한 후로 바꾸지 않는다.

**추가 해결이 필요한 경계:** DB statement 시작을 접수 기준으로 삼으면서 admission gate를 얻기 전의 모든 요청까지 보장하려면, worker가 볼 수 없는 미commit 접수의 순서를 추적하는 intake coordinator 또는 durable ingress가 필요하다. 짧은 gate와 SKIP LOCKED만으로 완전 보장했다고 하지 않는다. admission 완료가 접수의 정의인지, SQL 도착을 앞선 접수로 보장할 것인지와 HTTP 수신완료 응답 기준을 명시해야 한다. expired를 임시 표시로 취급하거나 기존 확정 알림을 정정하는 행동은 확정 정책으로 주장하지 않는다. 이 경계 설계·검증 전 51을 전체 접수 계약 완료로 배포하지 않는다.

### 현재 상태별 처리 제안

| 현재 상태 | 제안 |
|---|---|
| 같은 version 대기 + receipt가 마감 전 | 해당 action 자격 확인 후 consume; 원래 기한을 임의 연장하지 않음 |
| 같은 receipt 이미 성공 | 기존 성공 재반환; 새 알림/후기 없음 |
| 다른 action 수락/거절/철회가 먼저 성공 | 충돌; 과거 received_at으로 상대 성공을 되돌리지 않음 |
| 새 proposal/version/조건 변경 | stale version 충돌; 새 조건에 receipt를 재결합하지 않음 |
| 약속 취소/완료/분쟁 | 현재 정책상 허용 상태 검사; receipt로 취소·분쟁을 해제하지 않음 |
| worker expired, eligible pending receipt가 이미 commit되어 있음 | worker 계약 위반. 원자 gate 아래 consume 전 만료 확정을 막도록 수정·검증 |
| worker expired, receipt가 뒤늦게 commit | 접수/만료 race 미해결. 무조건 복구·재확정·알림 정정을 구현하지 않고 admission 계약부터 해결 |
| 후기 기한/이의 상태가 분쟁 후 재개됨 | 기존 receipt epoch 유지. 새 기한으로 오래된 요청을 자동 승격시키지 않음 |

## 장애·응답·보관

intake commit이 확인되지 않으면 ‘접수 완료’라고 응답하지 않는다. commit 이후 consume 결과를 잃었으면 같은 idempotency scope로 receipt 상태를 조회하고 같은 body를 재제출할 수 있다. receipt 수신 완료는 업무 성공이 아니다. HTTP 202를 쓴다면 receiptId·receivedAt·처리 중 상태만 반환하고 실제 후기 제출/수락 완료 표시는 succeeded 이후다. 이 응답 형태는 기술 제안이며 기존 UI를 임의로 바꾸지 않았다.

pending 원문은 저장하지 않으므로 gateway 장애 후 사용자가 재제출하지 않은 receipt를 자동 완료할 수 없다. 처리 lease·재시도 관찰 기간·pending 보류 종료·최소 성공 receipt 보관·개인정보 삭제/탈퇴 뒤 보관은 별도 구분해 정해야 한다. 기술 lease를 접수 효력의 종료나 사용자 보관 정책으로 임의 대체하지 않는다. 기존 review 원문 보관 정책도 receipt 보관 기간과 같다고 가정하지 않는다.

## 실제 검증 행렬

아래는 새 계약에 필요한 검증이다. 현재 모두 NOT_RUN이며 단순 문자열/hash 검사를 기능 PASS로 세지 않는다.

| 실제 두 세션/역할 시나리오 | 확인 결과 |
|---|---|
| 마감 전 command 수신→post/appointment 잠금 대기→기한 후 실행 | receivedAt 보존, late clock만으로 expired/거절하지 않음 |
| 마감 정각/직후 command | intake 부적격, 원래 약속/예약/후기 불변 |
| 오래 열린 transaction에서 마감 후 RPC | now가 과거라도 거절 |
| gateway HTTP→DB 연결 대기 | HTTP와 DB 경계 차이를 응답/로그 계약대로 표시 |
| intake commit 중 worker 만료 경쟁 | 같은 epoch admission 순서, 미commit 경계까지 정의대로 처리 |
| commit된 pending eligible receipt + 만료 worker | 조기 expired/공개/종료 알림 없음 |
| 동일 consume 두 세션/수락↔철회 | 한 성공, 다른 충돌/기존 성공; 단일 종료 알림 |
| 새 proposal·조건 변경↔consume | version 충돌, 새 상태 보존 |
| 취소·분쟁↔후기/이의 consume | 임의 복구 없음; 후기 기한 epoch/공개 보류 유지 |
| intake 후 gateway crash/consume 결과 유실 | 같은 scope 재시도, 수신 완료와 업무 성공 구분 |
| 같은 receipt 다른 회원/회차/session/payload | 거절, 원장·업무 데이터 불변 |
| authenticated/anon/PUBLIC의 direct mutation | 실제 ACL 우회 실패; service_role gateway consume만 허용 |
| lease 만료/원문 재전송 없음 | 원문 복구·자동 제출 없음, pending 처리 정책대로 종료/보류 |
| 보관 만료·탈퇴·재가입 | 이전 회차 receipt 재사용 실패, 확정 보관 기준대로 삭제/감사 |
| SQL/API 오류·worker 로그 | 채팅/후기/사유 원문·키·SQL detail 없음 |

## 담당별 다음 산출물

민규: 접수 경계 및 보관/보류 미정 분리 → admission/consume RPC·권한 migration → gateway 재시도/202·성공 반환 → 자원 epoch와 현재 핵심 mutation 연결 → 실제 잠금/권한 회귀. 기존 50개 파일을 수정하지 않고 후속 공식 migration으로 구현한다.

종현 요청: schedule expiry·review publication·작업 실행에서 committed pending receipt/epoch 검사, admission gate 연결, 조기 만료 알림 방지, crash/retry 로그 원문 제외. 이 문서는 변경 요청이며 종현 파일을 직접 수정하거나 외부 메시지를 보내지 않는다.
