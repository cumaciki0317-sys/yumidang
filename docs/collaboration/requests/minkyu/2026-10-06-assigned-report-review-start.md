# 배정된 담당자의 신고 검토 시작 후보72

actor minkyu / 하네스 C의 독립 clone 후보다. 선행 source71은 root의 정식 로컬 적용과 실제 직원 파일 API12그룹 증거가 있으며, 이번 검토 시작은 별도 신규 SQL 후보다. migration은20261005155136_assigned_report_review_start.sql이다. SQL70/71·runtime graph52·직원 client·handler/index는 수정하지 않는다. 최초 후보 작성 시 SQL/HTTP/두 세션/운영은 NOT_RUN이었다. 후속 실제 SQL 후보 PASS 범위는 아래 기록을 따른다. HTTP·두 세션·운영은 여전히 NOT_RUN이다.

## 좁은 요청과 응답

새 public.start_assigned_report_review(p_report_id uuid,p_request_id uuid,p_expected_version bigint)는 authenticated만 실행할 수 있다. Auth/session/승인/해당 신고 배정의 기존 private.require_assigned_report_operator를 사용한다. 익명·서비스 역할·일반 회원·미승인/미배정·다른 사건·삭제/만료/타인 session은 허용하지 않는다. 네이버 회원 자격을 직원 권한으로 사용하지 않으며 프로필 없는 active Auth 직원도 승인/배정이면 접근할 수 있다. 자신의 UID가 탈퇴한 경우 private.profile_retired로 거절하며 다른 신고자의 탈퇴를 직원 거절 조건으로 쓰지 않는다.

요청에는 actor/target/appointment/identity/회차/시각/상태/원문이 없다. 대상 약속은 신고의 기존 target_type/target_id에서 서버가 도출한다. received 또는 more_evidence에서 reviewing으로만 전환한다. 일반 신고에는 약속 hold를 자동 생성하지 않는다. 최종종결·통지·이의 마감·제재·당도·귀책 판정을 기록하지 않는다.

응답은 reportId/status/version/holdId/alreadyApplied의 정확5키다. version은 DB CHECK로1~9007199254740991 안전 정수 범위만 허용한다. expectedVersion은1 이상 MAX 미만이어야 하며 MAX/초과는22023이다. status 변경 trigger는 old version이 MAX이면55000으로 전체중단한다. 성공 영수증의 expected/result version도 같은 경계를 강제한다. 실제 HTTP 연결에서도 exact 안전 정수 decoder를 유지해야 한다. 초기 review_version은1, 실제 상태가 바뀔 때마다 trigger로1 증가한다. 기존 owner 상태 변경 의미와 기존 DTO는 그대로다. 기존70 제출 자료 DTO에 version을 추가하지 않았다. 미래 HTTP 연결에는 승인된 담당자의 version 조회/표시 계약을 별도로 예약해야 한다. 초기1을 모든 미래 상태의 버전으로 추정해서는 안 된다.

(actorId,requestId) 성공 영수증을 구조화 변경 감사로 사용한다. 같은 report/expectedVersion 재시도는 원 성공 결과와 alreadyApplied=true를 반환하며 hold·버전·감사를 중복 기록하지 않는다. 같은 actor/requestId에 다른 report/expectedVersion은40001이다. 서로 다른 requestId의 오래된 버전, reviewing/resolved 등 새 진입 불가 상태도40001이다. 영수증 재조회도 현재 session·승인·배정·retention을 통과해야 한다. 성공 영수증의 reviewing/version은 당시 결과이며 현재 상태 확인을 대신하지 않는다. 같은 report를 추가자료 상태에서 다시 검토할 때는 새 requestId와 현재 버전을 사용한다. 기존 hold가 이미 normal/no_show로 해소됐다면 기존 helper 의미를 우회해 다시 reviewing으로 바꾸지 않고40001로 전체 롤백한다. 새 검토 회차 정책을 만들지 않는다.

## 잠금과 전체 원자성

Auth user KEY SHARE → session SHARE → approval SHARE → assignment SHARE 후 actor/request advisory를 잡는다. 이어 비잠금 신고 snapshot에서 appointment ID를 도출하고 appointment UPDATE NOWAIT → report UPDATE NOWAIT 순으로 잠근다. report target가 snapshot과 바뀌었거나 retention이 만료됐으면 변경하지 않는다. 일반 신고는 appointment lock/hold가 없다. old request 성공 영수증도 이 순서와 현재 권한을 거친다.

report 상태/updated_at을 바꾸고 기존 private.enter_appointment_review(reportId,appointmentId)를 호출한다. 이 helper의 약속→report→window/hold→예약/결과원장 순서와 완료/후기 보류 의미를 보존한다. 반환이 reviewing hold가 아니면 failclosed한다. 변경·hold·예약·receipt 중 하나라도 실패하면 동일 SQL statement 전체가 rollback된다. 성공 receipt INSERT 직전과 멱등 결과 반환 직전 기존 staff guard를 다시 호출해 실제 session 시각 만료를 재검사한다. lock_not_available는40001이며 부분 성공으로 삼키지 않는다.

영수증은 actor UUID/report ID/request ID/이전·결과 상태/version/hold ID/DB 시각만 저장한다. 설명·캡처 bytes·채팅·이름·token·signed URL은 저장하지 않는다. actor UUID에는 Auth FK를 붙이지 않아 직원 Auth harddelete를 막거나 감사가 cascade되지 않는다. report FK는 실제 신고 파기 시 cascade하며 report 보관의 권위있는 최종종결+90일을 대신 결정하지 않는다. 별도 감사 보관기간이나 최소 안전 identity 삭제를 추가하지 않는다.

## owner·ACL과 기존 소스 보존

새 wrapper와 version trigger/receipt owner는 기존 staff guard의 owner다. 기존 enter_appointment_review owner와 같아야 하며 다르면55000으로 중단한다. 기존 private/auth schema USAGE, auth.uid/jwt/role·staff guard·enter helper·profile_retired EXECUTE, report/appointment SELECT 및 row-lock UPDATE, RLS 우회 적합성을 검사한다. PG17 gateway4의 owner USAGE 또는 SET이면 중단한다. 기존 역할·table ACL·old function owner/body/ACL을 확장하거나 기존 helper를 수정하지 않는다. raw safety/채팅 table grant, worker/internal-key 경로, 실제 직원 승인/배정 seed는 없다.

새 receipts는 RLS enabled·PUBLIC/anon/authenticated/service_role CRUD closed다. trigger helper EXEC도 외부 역할에 열지 않는다. 유일한 새 외부 권한은 위 고정 public RPC의 authenticated EXEC다. member_reports의 좁은 review_version 컬럼과 상태 변경 trigger만 추가한다. version은 authorization을 대신하지 않는다.

## 회귀 후보와 검증 상태

SQL 회귀는 BEGIN/ROLLBACK 합성 회원의 실제 public create/request/propose/accept/report RPC로 약속 신고2개와 일반 신고2개를 준비한다. 별도의 프로필 없는 Auth 직원3과 다른 직원4를 owner 합성 approval/assignment로 준비하며 실제 운영 배정을 주장하지 않는다.

검사 범위는 기본 승인0/미배정/다른 사건/일반 회원 거절, actual hold+reviewing+version2+정확 DTO, 같은 request 멱등·payload/버전/다른report 충돌, 일반 신고 hold 미생성, receipt INSERT 강제 실패 및 시작 guard 뒤 session 만료로 report/hold/예약 전체 복원, 실제 public 취소 뒤 helper 실패 전체 복원, 승인/배정 회수 후 성공 영수증 재조회 거절, session 만료/타인/익명/삭제, 일반 추가자료→재검토 버전, 일반 MAX-1→MAX 성공·추가 status 변경55000·MAX/초과 start22023·stale start40001과 영수증/hold 불변, owner 합성 retention 만료거절, 직원 Auth harddelete 후 감사 보존, 기존70/71 함수/역할/guard/worker/ACL 보존이다. retention 시각 fixture는 실제 절차 최종종결 workflow 증거가 아니다. profile_retired guard의 실제 탈퇴 경합/직원 UID 탈퇴 시험은 후속 실제 실행 범위로 별도 남는다.

초기 후보는 소유권/하네스·한국어/필요한 영어·UUID·TX 경계 및 기존 SQL70/71 해시 정적 확인만 수행했고 SQL 실행은 대기했다. 현재 후속 실제 SQL 후보 검증은 아래 PASS 기록을 따른다. 두 세션·HTTP·Provider·실제 staff/운영은 NOT_RUN이다. 기존71 API12 결과를 신규 mutation 성공으로 대신하지 않는다.

후속 실제 두 세션은 assignment/approval 회수 대기, session expiry/revocation, 같은 request 동시 재시도, 같은 report 다른 request 버전 충돌, 약속 완료↔검토 시작, 약속 lock 보유/충돌40001·잔여 변경0, reporter retire/담당 Auth harddelete 교차를 확인해야 한다. 원자 fixture 실패를 실제 장애/운영 처리 성공으로 확대하지 않는다.

## 남은 연결

dedicated client allowlist와 version 조회 후보는 별도 승인 lane에서 추가됐고 아래 증거를 따른다. 실제 start-review HTTP 통합은 runtime freeze 이후 별도 검증한다. staff requirePrincipal + JWT와 DB 재검증을 재사용하고 worker credential을 사용하지 않는다. J 모바일 신고 상태 화면은 계약 요청으로 연결하며 직접 수정하지 않는다.

운영 판정·정정·제재/당도/약속 결과 원자 연결, 신고자 조치/대표 사유 표시, 실제 본인 notice, 이의 접수/검토·최종 종결은 남은 전체 목표다. 일반7일 notice epoch 및 hideTarget90일 보관의 사용자 답을 임의 확정하지 않는다. 이 후보는 이의 접수 RPC나 신고 final_closed_at/retention_due_at을 작성하지 않는다.


## 후속 실제 후보 SQL72 및 client 증거

root가 실제 격리 native71에서 고정72 전체 SQL과72 회귀를 단일 TX로 실행해 SQLexit0/PASS를 확인했다. 영수증은 /private/tmp/yumidang-review-start72-candidate-reviewed/receipt.json, SHA 9c816aa8a57c1a8d9eb09f73b4c5908a7f87a77265c15c9d31862cec0c85c1f3, driver SHA b7caee829ed28fe87b3f74daf80fa8945e0735794fe76b793262a129ff3335bd다. SQL c1083e452b284ed66edaa11bb4e075914e6f93ce64ab918a1c266f62ad470b71 및 test3315c11ad4436e06990bed1add9a4df62a6f036522888378bed9eabbe8bfea87는 그대로다. 상한 경계·멱등·보류/감사 실패 원자 rollback을 포함한 위 회귀의 실제 실행 증거다.

전체 ROLLBACK 뒤 보존 검사12개가 모두 true이며 실제 history71·기존 catalog·policy·역할·자료 수·인증 감사288개 ID/payload·guardfalse·workeridle·files0·보호 컨테이너·기존 proof·소스 핀이 보존됐다. 새72 objects는 복원 후 존재하지 않는다. candidate PASS를 정식72 등록/배포로 해석하지 않는다.

별도 C dedicated client에는 get_assigned_report_review_state와 start_assigned_report_review만 추가했다. client SHA4fc6e82f777e464596f25739ec56fc6432bb3683ffa9dab679df2f3f4921c6db, test SHA3e54b8c5e00b1e3fd8d432dce59265175f675b5e261e5b5028754b95d295e684다. 기존5+신규5 mock transport10/10과 deno check --no-remote가 PASS다. 원 JWT/anon key·정확 인수·3/5키·safe integer·변형 응답·원문 없는 실패를 검사하며 실제 HTTP나 DB 연결을 대신하지 않는다. 최초 오류 코드 확인 위치와 union fixture 타입검사 FAIL은 테스트에서 교정했으며 이력을 성공 증거와 분리한다.

Agent DB/API/Provider 실행0, 실제 검토 시작 HTTP·두 세션 잠금·정식72/73·운영 staff mapping·모바일·운영·판정/통지/이의는 NOT_RUN이다. SQL71의 직원 파일 bytes PASS를 새 검토 mutation HTTP 성공으로 확대하지 않는다. 별도 B HTTP candidate와의 최신 통합이 필요하다.
