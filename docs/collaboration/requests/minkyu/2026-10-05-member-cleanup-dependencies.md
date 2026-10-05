# 회원 삭제 순서·최초 탈퇴 준비 검사

작업자: minkyu. 선행: 적용 완료 lifecycle55 `20261005020135_current_member_lifecycle.sql`. 해당 파일은 SHA `d24d3e338e9a8876c3d34c761f3fe9c863095faa95d93bf0055c471a81ab266d` 그대로 보존한다. 신규 보완은 `20261005020136_member_cleanup_dependencies.sql`이다.

## 확정 구현

- 같은 `withdrawal_id`의 `storage_object` 작업이 모두 `completed`여야 `auth_user` 작업을 처음 점유하거나 만료 후 다시 점유할 수 있다. 다른 탈퇴 건의 사진 작업은 영향을 주지 않는다.
- `check_member_cleanup_task`와 `complete_member_cleanup_task`가 동일 의존성을 재검사한다. check를 재사용하는 ack 기록·조회도 미완료 사진이 있으면 `40001`로 거부된다. 기존 task 8필드, ack 5필드, complete 반환 서명은 그대로다.
- 기존 global singleton 잠금을 유지하여 사진 완료 트랜잭션이 commit된 뒤에만 다른 세션의 Auth claim이 진행된다. 사진 완료가 rollback되면 Auth claim은 실패 없이 SQL NULL을 반환한다. lease 자동 연장은 없다.
- 최초 `retire_my_account`는 `external_deletion_approved=true`와 cleanup5 RPC의 `service_role` EXECUTE 전체 준비를 요구한다. flag만 true이거나 하나라도 권한이 없으면 `55000/member_cleanup_pipeline_not_ready`이다. 기존 로그인/guest/본인 검사는 먼저 유지한다.
- 이미 접수된 동일 본인·동일 withdrawal 영수증은 준비 조건이 다시 닫혀도 조회할 수 있다. `processing`을 `completed`로 바꾸지 않는다. 다른 회원의 영수증과 다른 withdrawal 재시도는 허용하지 않는다.
- migration은 guard를 켜거나 cleanup5 권한을 열지 않는다. 실제 worker가 준비됐다는 운영 확인 후 권한/승인 활성화는 별도 연결이다. worker가 실행 중임을 SQL 권한 검사만으로 증명한다고 설명하지 않는다.

## 실제 검증

`supabase_db_yumidang-minkyu-drift`의 native55 `postgres`는 읽기 전용으로 schema-only dump했다. 이력은 dump 전후 55였다. dump 전 profile/Auth/episode는 0/0/0, dump 후 0/1/0이었다. 병렬 provider fixture의 Auth 자료 자체는 읽거나 복사하지 않았다. 새 `yumidang_cleanup_dependencies_20261005`에만 복원·20136 적용했다. 전역 role 생성/변경과 운영/native source 쓰기는 없다.

`tests/database/minkyu/member_cleanup_dependencies.sql`의 합성 begin/rollback 회귀:

- 작은 UUID의 Auth task보다 사진 작업을 우선 선택한다.
- 미완료 사진이 있을 때 오래된 Auth lease의 check/ack/complete를 거부한다.
- 실제 사진 SQL 완료 이후 Auth claim을 허용하며 다른 withdrawal의 미완료 작업은 제외한다.
- 기존 ack가 있더라도 사진 상태가 다시 pending이면 Auth ack 조회/완료를 거부한다.
- 만료된 task 점유를 재확보한 뒤 기존 immutable ack를 복구하며 과거 token을 거부한다.
- global 만료를 사전 검사와 완료 UPDATE 중간 모두 주입한다. 중간 만료 시 task/retirement 상태가 rollback되고 이미 저장된 ack는 보존된다.
- 승인 false, flag만 true, cleanup5 각각의 권한 누락, guest/NULL UID/잘못된 JWT 역할/anon SQL 역할/다른 caller를 검사한다. 준비된 본인 최초 요청과 준비가 닫힌 뒤 processing 영수증 재시도를 검사한다.
- helper 소유자와 check 함수 소유자가 동일함을 확인하고 user/service_role helper 및 cleanup3 EXECUTE가 닫혀 있음을 확인한다.

기존 `current_member_lifecycle.sql`은 소유권 확인 후 합성 readiness 준비/권한 회수를 명시하여 source55+20136에서 전체 PASS했다. baseline 차단을 먼저 검사하며 최초 탈퇴 두 건을 각각 준비하고 다시 닫는다. 마지막 전체 rollback으로 false/ACL0 상태를 보존한다.

실제 두 세션 하네스 `/private/tmp/member-cleanup-dependencies-concurrency.py`도 독립 scratch에서 순차 PASS했다. 사진 완료 commit/rollback 중 Auth claim이 global row 잠금에서 기다리고, commit 후에만 Auth task를 얻는다. finally의 profile/Auth/task/ack fixture 합계는 0이고 승인 false/global token NULL이다. 회귀의 임시 trigger DDL과 경합 하네스는 같은 DB에서 동시에 실행하지 않는다.

## 검증 한계·후속 작업

native55 Storage metadata의 FK는 bucket FK만 있었다. 합성 객체를 남긴 채 Auth SQL DELETE가 성공하며 owner_id가 남음을 rollback probe로 확인했다. 이는 SQL FK 관찰이며 실제 Auth provider 요청/Storage 객체 bytes 삭제 성공과 구분한다. SQL 회귀의 metadata 삭제·합성 ack는 외부 DELETE200 증거가 아니다. 실제 provider 통합 검증은 별도 담당 결과를 사용한다.

Storage 객체가 뒤늦게 새로 생기는 경로를 새 승인 정책으로 추가하지 않는다. 이미 탈퇴한 caller/대상의 Storage 가드는 lifecycle55를 보존한다. 알려진 객체 전체 삭제, provider ack·404 재조회, 완료 직전 fence 검사는 기존 adapter 계약을 따른다. 회원이 직접 owner-only 완료 상태를 주입할 수 없다.

다음 보관 정리 확장은 이 파일과 분리한다. 최대20건·근거 있는 관련 절차 최종 종결·마지막 활동 앵커·첫 신청 복제 본문 삭제·미종결 분쟁 제외를 검토 중이며 아직 구현/적용했다고 설명하지 않는다. 미정 안전 identity 보관 삭제, 직원 원문 대화 열람, 자유문 자동 가림 완료와 외부 AI 원문 전달은 추가하지 않았다.
