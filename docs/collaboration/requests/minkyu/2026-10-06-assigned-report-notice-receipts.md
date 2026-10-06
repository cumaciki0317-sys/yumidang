# source75 구조화 결정과 본인 통지 facts 후보

작업자 minkyu, 하네스 A3. 기존74 SQL/HTTP/client/prepare2는 수정하지 않았다. root CLI 생성 leaf `20261005180340_assigned_report_notice_receipts.sql`를 기존 own clone에 복사해 구현했다. 이 SQL/테스트의 실제 DB/API 실행은 NOT_RUN이다.

## 저장·공개 경계

`assigned_report_decisions`는 판정 당시 mode, reportVersion, AP outcome, incident outcome/revision, responsibleRole, 유한 reason/class/type를 보존한다. 기존74는 해시만 있으므로 백필하지 않는다. 기존 `adjudicate_assigned_member_report`의 고정 source74 prosrc MD5와 정확 반환 anchor1개를 검증하고 마지막 성공 return 바로 앞에 owner helper 호출1개만 추가한다. 원 receipt가 만들어지는 같은 TX에서 결정/event가 작성되고, 그 뒤 직원 세션·승인·배정·탈퇴·report 보관 clock을 다시 검사한다. 공개 signature/return5/OID/owner/ACL/proconfig는 보존한다. 재호출의 기존 alreadyApplied 분기는 기록을 추가하지 않는다. helper 오류는 원 사건/회차/당도/hold/report/receipt 전체를 rollback한다.

고정 AP 당사자에게 normal/no_show 사실만 통지하며 책임자나 상대 위반은 공개하지 않는다. 명시 책임자로 선택된 회원에게 본인 confirmed 위반, 원 revision에 본인 효과가 있던 회원에게 invalidated 정정만 통지한다. confirmed 책임자 정정으로 새 selected에서 빠진 이전 당사자도 본인 invalidated/decision_corrected·class/type NULL을 받는다. 원 책임해제의 실제 제재 종류나 감점은 추정하지 않는다. member/post/chat no_action은 결정만 기록하고 위반을 추정하지 않는다. 피해자/신고자/직원·report ID/decision ID/identity·회차·원문 증거는 공개 DTO에 없다.

회원 RPC는 `list_my_decision_notices(integer,uuid)`와 명시 `read_my_decision_notice(uuid)`다. list는 exact2 `{items,nextCursor}`, item/ACK는 exact9 `{noticeId,appointmentId,appointmentOutcome,violationOutcome,reasonCode,violationClass,violationType,availableAt,firstReadAt}`다. 원 JWT `require_service_profile`의 account→profile→active episode guard를 재사용하고, 그 회차 identity에 묶인 exact naver_sessions 및 auth.sessions의 user/session_id 관계와 not_after를 DBclock으로 검사한다. session UUID 파싱 실패·NULL·다른회원·삭제·만료는28000이다. account/profile/episode 이후 exact auth.sessions parent SHARE→naver_sessions child SHARE다. GoTrue parent DELETE→child CASCADE와 잠금 순서를 맞추며 child 대기 뒤에도 저장한 not_after를 현재 DBclock과 다시 비교한다. 기존 탈퇴의 account/profile/episode 순서는 유지한다. 현재 episode와 notice recipient identity를 함께 검사하므로 동일identity 새회차에도 이전회차 notice가 섞이지 않는다. 신규활동 자격/제재 gate는 추가하지 않고 retired/익명/타인 접근은 거절한다. UUID 순 cursor/limit1..100이며 타인 cursor/ACK는PT404다.

availableAt는 서버내 기록 게시 사실이고 firstReadAt는 그 회차 본인의 명시 ACK 사실이다. 반복ACK는 첫 시각을 유지한다. list의 cursor·항목은 linked report가 만료되면 제외/PT404이며, 삭제 지연을 읽기 연장으로 보지 않는다. ACK는 report SHARE→notice UPDATE 순서로 잠그고 각 대기 뒤 및 UPDATE/trigger 뒤에 같은 episode·fresh session·보관 clock을 다시 검사한다. list 반환 전에도 fresh episode/session을 확인하고, 그 뒤 반환 items·nextCursor·입력cursor의 linkedreport 존재/현재 보관 기한을 재검사해 PT404로 닫는다. SQL 회귀는 query 뒤 finalguard에서 만료를 만드는 임시 owner hook으로 이 경계를 확인하며 실제 두 세션 지연 증거와 구분한다. 외부 delivery, 실제 화면 읽기, 문자/메일 성공으로 해석하지 않는다. 일반 일괄 알림 읽기와 연결하지 않는다. `notified_at`, 이의 deadline, 최종 종결 시각, 제재 applied/expires를 변경하지 않는다. 일반7일 anchor 및 hideTarget90일 정책은 답변 대기이며 선택하지 않았다.

## 보관 책임

결정과 event는 최소 제재 identity 기록이 아니라 **해당 신고 처리 상세**다. decision.report_id NOTNULL FK ON DELETE CASCADE, event.decision_id CASCADE로 기존 report의 이의 포함 최종 종결+90d 파기와 함께 제거된다. AP normal/no_show/no_action을 최소 제재 연결로 무기한 남기지 않는다. 이 후보는 report를 resolved로 전환하거나 purge기간을 설정하지 않는다. 기존 제재 상세/증거의 제재 종료·이의 종결 중 늦은+90d는 safety core에 별도로 적용되며 notice 자체를 그 core와 혼동하지 않는다. 일반7일 anchor 선택 이후 필요한 facts/이의 관계와 종결 fingerprint 연결은 별도 후속이다. 현재 닫힌 finalclose/appeal 경계를 이 후보로 우회하지 않는다.

## 의미 있는 검증 후보

기존 실제 RPC 기반 합성 회원/약속/신고/검토 fixture를 재사용한다. 옛74 receipt typed/event0, no_show confirmed의 본인/상대 privacy, original return5/멱등, foreignACK/cursorPT404, firstACK멱등, normal+major→invalidation의 원 결정 보존, event INSERT 오류 전체rollback, incidentnone no_show의 귀책추정0, 자격누락 본인읽기, 동일identity 회차 분리, 원 guard retired거절, 만료된 미삭제 report의 list/cursor/ACK, notice INSERT 뒤 직원 session 만료 전체원복, ACK trigger 뒤 회원 session/보관 만료 전체원복, confirmed 책임자 변경의 해제 통지, 실제report DELETE cascade 목적파기 및 helper/테이블 ACL을 ASSERT on으로 검사한다. 회차 변경과 retired행은 owner 합성 guard 시험이며 실제 재가입/탈퇴/Auth/HTTP 증거가 아니다. 운영 통지·문자/메일 공급사·worker·공지·이의·최종종결은 NOT_CONNECTED다.

root가 고정 SQL/test를 실제 native74 단일TX에서 적용/검증/rollback할 때 원 catalog/owner/ACL/정책/roles/counts/audit/files/컨테이너를 보존해야 한다. 실제 SQL PASS 이후에만 새로운 준비 pin/정식 적용을 검토한다.

## 실제 후보 검증

root가 native74에서 75 후보 SQL과 회귀를 단일 트랜잭션으로 실행한 뒤 전체 rollback을 확인했습니다. 영수증은 `/private/tmp/yumidang-notice75-candidate-reviewed/receipt.json`이며 SHA256은 `c369784ca1197f100c98152ad78c1bacba7ab1db919948c93ec3704910b693cc`입니다. 기존 함수 catalog·ACL·자료·Auth audit 288개·파일 0·guard=false·전역 idle·보호 컨테이너와 기존 증거가 보존됐습니다. 이는 후보 SQL의 로컬 회귀 결과이며 영속 적용·실제 회원 HTTP·외부 통지·이의 기한 확정 증거가 아닙니다. 실제 DB 이력은 74를 유지합니다.
