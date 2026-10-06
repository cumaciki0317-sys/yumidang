# 신고 삭제 응답 유실·백업 복원 실제 검증

작업자: 민규(`minkyu`). 사용자 승인 1~10번 계획의 4번 로컬 검증이다. 병렬 작업·운영 변경·자동 커밋/푸시는 수행하지 않았다.

## 실제 결과

- 소유 테스트 프로젝트 `yumidang-retention-unknown84`를 고정된84개 SQL로 새로 구성했다. 기존 프로젝트를 초기화하거나 정지하지 않았다.
- 실제 Storage DELETE가200으로 완료된 직후 호출자 응답만 유실시켰다. 원 정상 경로 영수증은 FAIL/UNKNOWN으로 보존한다. 별도 결함 주입 검사에서 전송 의도1·ACK0·메타데이터 미완료·예약 후보 없음·자동 정리0을 확인했다.
- 합성 Auth/신고/프로필 데이터의 DB dump와 Storage tar를 생성한 뒤 테스트 프로젝트만 초기화했다. 운영 사용자 데이터는 백업하지 않았다. 백업에는 합성 Auth 상태가 포함되므로 비공개 폴더0700·파일0600을 유지한다.
- 로컬 관리자 역할로 복원한 뒤 모든 테이블 건수와 의도/작업/ACK/예약 상태가 일치했다. Storage 파일2개 바이트도 정확히 일치했다. 서비스 재시작 뒤에도 미확정 의도는 유지하고 자동 재삭제하지 않았다.
- 기존 정식 로컬84 전체15항목과 보호 컨테이너 상태를 비교해 보존을 확인했다. 최초 보존 비교의 `allCounts`/`allTableCounts` 키 오류는 별도로 기록하고 같은 조회의 올바른 필드명으로 재확인했다.

## 증거

| 범위 | 비공개 영수증 |
|---|---|
| 실제 응답 유실 원 결과 | `/private/tmp/yumidang-retention84-normal-7qQ3yo/result.json` (FAIL/UNKNOWN) |
| 실제 DELETE200 | 같은 폴더 `provider-delete-proof.json` |
| 안전 정지·백업 | `/private/tmp/yumidang-retention-unknown84-backup/capture-receipt.json` (EXPECTED_UNKNOWN_STOP_PASS) |
| DB/Storage 복원 | `/private/tmp/yumidang-retention-unknown84-restore-v8/restore-receipt.json` (PASS) |
| 원 DB·파일 바이트 | 같은 폴더 `final-verification.json` (PASS) |

## 실패와 복원 절차의 한계

앞선 복원 실행은 시스템 trigger 소유권, realtime 상속 제약, pg_cron 확장 의존성, pgbouncer/public 기본 스키마, 기존 publication 충돌로 실패했다. 실패 영수증과 로그를 보존하며 자동 재시도하지 않았다. 새 검증 실행에서 소유한 빈 테스트 DB만 정리한 뒤 복원했다. 기존 또는 운영 DB에 이 정리 절차를 사용하지 않는다.

`supabase_admin`의 로컬 superuser 권한으로 수행한 합성 환경 검증이다. 운영 Supabase의 백업/PITR 권한·복구 시각·실제 복구 절차 검증으로 확대하지 않는다. 전체 상주 runner의 새 신고 소비자 연결, provider 응답 유실의 직원 판단/해결 절차, 운영 백업과 개인정보 보관 조건은 남아 있다. 미확정 DELETE에 ACK를 만들어 넣거나 재삭제하는 복구는 하지 않았다.
