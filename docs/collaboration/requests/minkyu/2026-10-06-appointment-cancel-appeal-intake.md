# 본인 확정 취소 24시간 이의 접수 후보

작업자 minkyu, A lane. source75 기준 신규 source76 후보이며 SQL/HTTP/Provider 실제 실행은 NOT_RUN이다. 기존 SQL75·68 DTO와 제재 계산 helper는 변경하지 않는다. 소유권 3개 경로 및 root 최신 harness A 검사 PASS다.

확정 정책 근거는 정책.md 6장 취소 후 24시간 이의 및 7장 서버 접수 마감, 신고 최종 종결과 이의 포함 +90일 상세 파기다. 일반 7일 이의 시작점, hideTarget 90일, 재신청 및 종료 회차의 접수 권한은 사용자 미정이며 열지 않는다.

## 입력과 반환

`submit_appointment_cancel_appeal(uuid,uuid,bigint,uuid)`의 인자는 appointmentId, clientRequestId, expectedResultRevision, reportId다. HTTP 후보 본문은 정확히 `{clientRequestId,expectedResultRevision,reportId}`이며 appointmentId는 path다. 회원 시각·deadline·actor를 받지 않는다. expectedResultRevision은 1..9007199254740990, 새 resultRevision은 expected+1이다.

POST 정확 9개 필드는 appealId, appointmentId, resultRevision, state, cancelledAt, deadlineAt, receivedAt, resolvedAt, alreadyApplied다. 신규 성공은 reviewing/resolvedAt:null/alreadyApplied:false다. 같은 회차·요청 ID의 같은 payload 재시도는 최초 성공 8개 사실을 그대로 반환하고 alreadyApplied:true만 추가한다. CAS·마감 이후에도 이 원 receipt를 사용하지만 세션·회차·본인 관계·신고 상세 보관 권한은 매번 새로 확인한다. 같은 요청 ID의 다른 payload는 supplied report 존재 검증보다 먼저 40001로 거절하므로 타인 신고 존재를 노출하지 않는다. 서로 다른 AP에서 같은 요청 ID의 동시 INSERT unique 충돌도 40001로 원복한다.

`get_my_appointment_cancel_appeal(uuid)`은 위 8개 필드만 반환한다. 상세가 없으면 appealId/state/receivedAt/resolvedAt 네 필드는 null이고 실제 원취소 시간·그 시간+24h·현재 결과 revision을 반환한다. accepted/rejected에서는 최신 상태·해소 시각을 반환한다. report 보관 파기 뒤 null 상태는 상세의 부재를 뜻하며 한 번도 접수하지 않았다는 뜻이 아니다. 최소 exempt 결과와 실제 원취소 사실은 보존한다. current 결과가 own_cancel/exempt 외의 미결·다른 결과이거나 ordering이 불명확하면 55000으로 닫는다.

## 권한·시간·원자성

원 JWT의 source75 본인 관리 guard를 재사용한다. active 회차·identity·현재 Naver subject·정확 Auth session 관계를 검사한다. 자격 누락·기능 제한 중 본인 관리는 허용한다. 탈퇴·타인·다른 회차는 거절한다. 원취소자는 실제 appointment_cancellations.cancelled_by이며 AP 고정 회차와 result.source_episode_id를 대조한다. 신고는 같은 본인·회차가 접수한 appointment 대상이고 대상 AP가 정확히 같아야 한다.

public RPC 진입 시 `statement_timestamp()`를 캡처한다. 이것은 canonical DB statement 접수이며 Edge 최초 도착이나 모바일 서버 접수 검증과 같다고 주장하지 않는다. strict receivedAt < 실제 cancelledAt+24h다. 잠금 대기 뒤 현재 시각으로 접수 마감을 다시 판정하지 않는다. 잠금 및 INSERT 뒤 세션·회차·보관 TTL은 DB 현재 시각으로 다시 확인한다.

잠금은 기존 관리 guard의 account/profile/episode 및 auth.sessions parent→naver_sessions child 이후 AP→본인 result→report NOWAIT다. 기존 21811 사건 판정의 account/profile/episode UPDATE NOWAIT와 identity·AP 잠금 순서를 바꾸지 않는다. NOWAIT는 40001로 원복한다. 접수는 reviewing result revision·appeal·receipt를 같은 TX에 기록한다. 원 취소 시간·확정 시각·최신 합의 순서·원 origin은 보존하고 제재·당도 효과를 추가하지 않는다.

신규 owner는 effective record_incident_revision owner이며 privileged/RLS·schema·호출 helper·필수 table 권한을 사전 확인한다. 새 권한으로 기존 환경을 고치지 않는다. 공개 두 RPC는 authenticated 전용, private helper 및 receipt raw 접근은 gateway 역할에 폐쇄한다. 일반 safety_appeals의 기존 nullable 관계는 채우지 않으며 새 관계는 cancellation에만 쌍으로 허용한다.

## 보관과 미구현 범위

appeal/receipt는 report 최종 종결+90일 상세 파기에 CASCADE한다. reviewing cancellation appeal에 연결된 report만 final_closed_at 설정·DELETE를 거절한다. 일반 신고 접수만으로 분쟁·귀책·제재를 생성하지 않는다. accepted 최소 exempt 결과는 기존 safety_appointment_result_revisions에 별도로 남아 상세 CASCADE가 취소 효과를 되살리지 않는다. 이 후보는 accepted/rejected 운영 handler·최종 종결 handler·90일 실제 삭제 worker를 구현하지 않는다. 최소 결과의 법적 보관 종료 조건은 별도 검토 대상이며 새 기간을 정하지 않는다.

SQL 회귀의 accepted/rejected·보관 만료·탈퇴는 owner 합성 metadata fixture다. 실제 직원 판정, 실제 90일 retention engine, Auth/Storage provider, 실제 두 세션 잠금 대기, 모바일 S21에서 신고+이의 원자 제출의 성공 증거가 아니다. 기존 신고를 참조하는 접수 단계이며 화면의 신고 제출과 이의 접수를 한 statement로 연결하는 후속 계약이 필요하다.

오류는 invalid/safe integer/deadline 22023, 타인·신고 관계·보관 만료 PT404, CAS·다른 payload·NOWAIT·동시 unique 40001, 세션 28000, 탈퇴 42501, 재신청·회차 이전·순서/결과 미결·조기 종결 55000이다. 원문·신고 설명·증거·신고자 DTO 복사는 없다.

## 후보 검증

회귀는 ASSERT on 및 전체 rollback을 명시한다. 실제 본인 취소 RPC→신고 RPC 기반 합성 사례, absent/타인 분리, exact DTO/replay/CAS/payload, equal/late/1µs early 접수, MAXSAFE 증가, INSERT 이후 세션 만료의 전체 원복, 자격 누락 본인 조회, TTL 만료, report CASCADE 후 exempt 보존, 회차 변경·탈퇴 차단, private ACL·역할·membership·guard·worker 보존을 확인하도록 작성했다. 기존 general 집합 지문·nullable 열을 검사하며 존재하지 않는 일반 이의 업무 시나리오를 성공했다고 주장하지 않는다.

정적 검사만 완료하며 실제 PostgreSQL 함수 컴파일·실행과 회귀 PASS는 root의 고정 바이트 단일 TX 검증 후 별도로 기록한다. 이번 후보 실제 SQL/HTTP/Provider는 NOT_RUN이다.

## 첫 실제 후보 검증과 fixture 교정

root 첫 단일 TX 검증은 FAIL이며 원본 영수증 `/private/tmp/yumidang-appeal76-candidate-reviewed/receipt.json` SHA `7ec912252c09911aba197809be117eb3a471a9b2d872eb68492f22eca23a4a83`를 보존한다. migration 컴파일과 초기 본인 접수·replay를 진행한 뒤 test의 age helper 인수 `n`과 cases 열 `n`이 충돌하여 42702가 발생했다. 전체 catalog·자료·권한·감사 288·formal75·파일·컨테이너·활성 TX·closed ACL 원복 검사는 true이며 remote uncertain은 false다. 전체 회귀 PASS로 간주하지 않는다.

해당 helper만 `p_case_number`/`p_offset_value`로 인수를 구분하고 cases의 `case_row.n`을 명시했다. 다른 PL/pgSQL helper에서 같은 인수/열 패턴이 없음을 읽기 점검했다. SQL migration SHA `359a8093c3a32bf7d547a17df98173de677307933780a8e78db323bc4c26fcd8`는 변경하지 않는다. 교정 회귀 실제 재실행은 NOT_RUN이며 root가 별도 증거 폴더에서 고정 바이트로 실행한다.

## age 교정 후 실제 후보 SQL 검증

root 고정 SQL359a/testb4cf 단일 TX 재검증 PASS: `/private/tmp/yumidang-appeal76-age-reviewed/receipt.json`, SHA `a1c048c47d40bc13afe80d0674f80575c7f8ddb9c0305f7e7cb70250580183db`, driver `4e07d567da92de74f195764d94349444e351286ac7dfa9efba34c1a4981566a7`. checks 8개가 모두 true, uncertain false이며 전체 rollback 뒤 형식 이력은 75로 유지됐다. Provider 실제 실행은 0이다. 첫 FAIL 영수증은 보존한다. 이 증거는 SQL 후보와 owner 합성 회귀에 한정하며 실제 직원·회원 HTTP·S21·운영 적용 완료가 아니다.

준비 도구는 승인된 canonical 41+35=76 집합과 기존 HEAD28/41/60..75의 정확한 집합만 수용하도록 확장한다. 원본 raw SQL 77개 중 기존 중복 `20260929100000_event_storage 2.sql`은 계속 제외하므로 raw glob 개수를 승인 이력으로 사용하지 않는다. prepared artifact 생성 및 76 영속 적용은 별도 root 검증 단계다.
