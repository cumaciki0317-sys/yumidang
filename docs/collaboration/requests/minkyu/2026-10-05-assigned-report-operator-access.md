# 승인 담당자·배정 사건의 제출 자료 읽기 후보

actor는 minkyu이며 /private/tmp/yumidang-public-deletion-20261005의 독립 candidate다. root 공유 worktree·frozen68 runtime·B 사진69 handler/index를 수정하지 않는다. CLI2.116.0 help를 읽고 DO_NOT_TRACK=1로 신규20261005143318_assigned_report_operator_access.sql을 생성했다. B69의143045 뒤143318로 정렬된다. 운영 직원 계정/배정 행은 만들지 않았고 기본 승인표/배정표는 비어 있다.

## 인증과 권한

기존 requirePrincipal의 매 요청 Supabase Auth 사용자 검증을 그대로 사용한다. 검증되지 않은 Principal 객체·worker 키·회원 입력 actor/session·네이버 프로필·실명·메일로 직원 권한을 얻을 수 없다. 새로운 report-operator-client.ts는 검증된 원 JWT와 anon key만 쓰며 get_assigned_member_report(p_report_id),get_assigned_report_capture(p_report_id,p_asset_id) 두 읽기 RPC만 허용한다. 입력은 exact UUID keys이고 추가 인수·판정/내부 RPC·잘못된 성공 DTO를 거절한다. 기존 user-client allowlist와 handler/index에 연결하지 않았다.

DB는 authenticated/nonanonymous UID와 JWT session_id를 확인한다. auth.users 부모 KEY SHARE→auth.sessions SHARE→승인 SHARE→사건 배정 SHARE→신고 SHARE→첨부 SHARE→Storage metadata SHARE 순서다. Auth harddelete는 부모 잠금에서 직렬화하며 승인/배정 회수는 같은 해당 행 exclusive update에서 직렬화된다. 실제 두 세션 검증은 NOT_RUN이다. 세션은 존재/UID 일치/not_after가NULL 또는 미래인지만 검사한다. 미설정 inactivity나 refreshed_at 기준 만료 정책을 임의로 추가하지 않는다. 로그인 제거로 세션 행이 없어지면 stale JWT의 후속 접근을 거절한다. SQL session_id는 PostgREST가 검증한 JWT claim이어야 하며 임의 SQL 세션의 합성 claims 검사는 실제 Auth 로그인 증거가 아니다.

private.report_operator_approvals는 auth.users FK ON DELETE CASCADE, report_operator_assignments.operator_uid는 ON DELETE SET NULL이다. 실제 직원 계정 harddelete가 회원 삭제 pipeline을 새 RESTRICT FK로 막지 않으며 배정 기록을 남긴다. 기존 접근감사는 actor UUID의 Auth FK가 없어서 계정 삭제로 지우지 않는다. 새로운 RLS 테이블은 gateway 직접 권한0이며 approval/assignment 설정 helper는 owner-only다. 대표 유미/조유미 이름을 직원 인증값으로 사용하지 않는다. 실제 직원 Auth UID의 승인 책임·배정·대체 담당 설정은 별도 운영 준비다.

기존 get_my_report owner만 재사용하며 필요한 기존 SELECT/row-lock UPDATE/RLS 우회·audit INSERT/sequenceUSAGE를 preflight한다. 부족하면55000으로 전체 적용을 중단하고 broad table grant/role 변경으로 해결하지 않는다. Auth session의 실제컬럼 id/user_id/not_after는 root의 metadata-only 조회에서 확인됐다. 사전 승인/배정 표는 owner 설정 외에 공개 mutation route가 없다. helper PUBLIC/anon/authenticated/service_role EXEC는 닫고 신규 public 읽기2개만 authenticated EXEC를 허용한다. 이 EXEC는 직원 승인 그 자체가 아니며 비승인 UID는42501이다.

## 반환·감사·보관

get_assigned_member_report는 정확히 reportId/targetType/context/reasonCodes/description/assets의6키다. description은 회원이 직접 제출한 신고 설명이며 DB 채팅 원문을 읽거나 복제하지 않는다. reporter UID·피해자/다른 사건·targetId·신원·직원 actor·판정 원문을 추가하지 않는다. attached 첨부만 조회하며 최대5개 기술 상한을 검사한다. get_assigned_report_capture와 assets 항목은 reportId/assetId/bucket/path/objectId/mimeType/byteSize의7키다. exact submitted asset→report 관계, Storage 객체ID/owner/경로/MIME/1~5MiB metadata를 확인한다. 원본 blob 실제 존재·이미지 내용·공급사 다운로드 성공은 이 후보의 증거가 아니다.

기존 report_access_audit의 report_read/capture_reference action을 재사용한다. audit에는 제출 설명·이미지·토큰·외부 URL을 복제하지 않는다. 신고 retention_due_at이 지났으면 읽기를404로 거절한다. 기존 신고/asset 삭제 때 audit가 cascade하는 종결+90일 관계를 보존하며 새 audit 보관기간을 정책처럼 만들지 않는다. 기존 owner 신고자료/증거 table권한과 Storage SELECT 정책은 추가로 열지 않는다. 배정 직원도 아직 Storage bytes를 직접 읽을 새 policy/proxy가 없다.

## 검증 상태·다음 단계

신규 client 합성5그룹은 타입검사 포함 PASS다. 최초 invalid union 입력 fixture의 TypeScript cast 오류는 테스트에서 교정했으며 실행 성공과 구분한다. 테스트는 forged principal/고정 인수/원 JWT+anon key/내부 판정 차단/변형·원문 DTO 비노출/DB 거절의 실패 전달을 검사한다. 승인/배정/세션의 실효 DB 권한 증거는 아니다.

assigned_report_operator_access.sql DB 회귀는 BEGIN/ROLLBACK으로 defaultempty 거절→owner 합성 승인→미배정 거절→정확 제출 자료·첨부metadata·접근감사→배정/승인 회수→세션 not_after/삭제/익명 거절→Auth harddelete FK 정리/기록 보존·ownerhelper/publicACL·roles/cleanupguard/globalworker 불변을 검사하도록 작성했다. 실제 SQL와 session/assignment/revoke/Authdelete 두 세션은 NOT_RUN이며 root 검토 후 별도 단일 실제 검증이 필요하다. source69 뒤 전체freshapply와 기존 신고/탈퇴/cleanup 호환 회귀도 필요하다. 운영 계정 seed·DB/Provider/메일/푸시/프로세스 변경0이다.

이 후보는 제출 설명 및 첨부 metadata의 폐쇄된 읽기 경계다. 전체 신고 처리 완료가 아니다. 실제 bytes용 승인된 경로와 기록, handler/index 인증 연결, 담당 심사/추가 자료/판정 gateway, 실제 안내, 이의 접수·결과·명백한 오류 정정, 최종 종결·보관실행은 후속 구현이다. 일반 안내 후7일의 epoch는 사용자 답 대기이며 그 의존 코드는 구현하지 않았다. 취소24시간/일반7일/제한 중 본인 지원 허용 등 기존 확정 정책을 다시 선택하지 않는다. 직원 UI/mobile/J 파일은 수정하지 않는다.


## 후속 실제 후보 SQL 검증

Root가 native68에서 신규70 전체 migration과 수정 회귀를 같은 transaction으로 실제 실행했다. sqlExit0/PASS 후 전체 ROLLBACK으로 catalog/역할/자료·Storage·보호 컨테이너 baseline을 복원하고 신규 운영자 객체가 남지 않았음을 확인했다. 증거는 /private/tmp/yumidang-operator70-candidate-reviewed/receipt.json이다. 검증한 migration SHA는296cc4fc48fce2f66f1ad72d10b39b3a12d2f7a225033a61fb8ab2b56a4486fd, 수정 DB 회귀 SHA는f5aa5c17e1723b49573df40f66303cf13ecfe6c41f68209bff35fb847587b182다. 실제 SQL 후보 검증 상태는 앞선 NOT_RUN에서 PASS로 갱신되며 영속70 통합/배포 완료를 뜻하지 않는다.

최초 실제 FAIL은 fixture signup 마지막 회원2의 JWT claims가 RESET ROLE 뒤 남아 신고 대상2를 본인으로 검사한 report_target_unavailable이었다. 기존30100 trigger와 권한 검사를 유지하고 신고자1→대상2의 명시 claims를 합성 fixture에 지정했다. 다른 승인 담당의 실제 존재 사건·다른 사용자 session·session claim 누락 거절도 추가했다. migration 바이트는 변경하지 않았다. 최초 /private/tmp/yumidang-operator70-candidate/receipt.json과 stderr.log는 실패 증거로 보존한다.

현재 client 합성5그룹과 실제 후보 SQL 회귀는 PASS다. 승인/배정/세션 회수의 실제 두 세션 경합·Storage bytes·직원 HTTP·실제 직원 승인/배정·사유 통지·이의 접수·모바일·운영은 NOT_RUN이다. SQL 승인/배정 행은 transaction 안의 합성 fixture이고 실제 운영 직원을 생성하거나 인증한 결과가 아니다. Agent는 문서만 갱신했으며 DB/API/Provider 호출0이다.
