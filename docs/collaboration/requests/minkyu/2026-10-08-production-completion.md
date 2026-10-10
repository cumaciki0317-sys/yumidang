# 백엔드 운영 완료 체크리스트와 SQL108 인계

현재 전체 관리 진행률은 **79%(22/28항목)**, 운영 완료는 **3/7**이다. 최신 [100% 계획](2026-10-09-backend-100-plan.md)과 [실행 기록4.77](2026-10-09-backend-execution.md)에서 실제 큐20/잔여0·별도 유지관리와 실행기·탈퇴 복구 완료 증거를 확인한다. 아래는2026-10-08 SQL108 시점의 과거 기록이며 최신 소유권·SQL119개 준비·진행 상태는 위 링크를 따른다. 운영 활성화·실회원·최종 복원은 아직 완료되지 않았다.

기준은 사용자 승인 운영 완료 계획, 원격/로컬 HEAD `ac06f86`이다. 2026-10-08 fetch 결과 새 원격 커밋은 없다. 민규 담당만 수정했으며 운영 DB·Railway 변경·커밋·푸시는 수행하지 않았다.

**기존 8/10 · 추가 5/6 · 독립 5/5 · 운영 완료 1/7**이다. 분모를 합산하지 않는다.

| 단계 | 상태 | 증거·대기 |
|---|---|---|
| 1 기준 코드·계약 | 완료 | 원격 확인, SQL100~107 보존, SQL108 준비 READY108/canonical99/pending9, 운영20 이력 및 정적 스키마 일치, 배포 대상88개 순서·해시 고정 |
| 2 제품 큐 계약 | 대기 | 종현 reserveItem 첨부별 집계·maintenance 큐20 차감·배정 전달 수정 필요 |
| 3 복구·제품 실행기 | 부분 검증 | SQL108 ACK 읽기 복구 DB PASS. 제품 CLI sharedRuntime 조립·cycle 확정·두 프로세스 경쟁·재시작은 종현 연결 대기 |
| 4 AI·읽음 | 부분 검증 | 이전 실제 clarification receipt/helpful HTTP/메시지별 읽음 PASS. 정상 답변·결과 없음의 실제 DB 경로와 제품 주기적 파기는 미완료 |
| 5 네이버 두 회원 | 대기 | 자격 있는 계정 두 개 직접 로그인 준비 확인 필요. 합성 JWT는 이를 대체하지 않음 |
| 6 배포·복구 준비 | 부분 검증 | 운영 정적 catalog 일치·88개 적용 순서 준비. 기존 SQL107 복원 PASS. 최종 SQL108 복원·운영 전체 백업·현재 Railway 설정 확인은 미완료 |
| 7 운영 적용 | 미실행 | 선행 제품 연결·회원 흐름·복구·실행 환경 확인 후 수행 |

## 운영 조사와 적용 대상

Supabase `bndguguarijmghnkenvt`는 ACTIVE_HEALTHY이고 현재 migration20개, Auth3·profile3·공고2·신청1·약속1·Storage metadata2개다. 행의 원문·개인정보는 조회하지 않았다. 기존 테스트 계정이라는 사용자 결정을 유지하며 이번 작업에서 삭제하지 않았다.

현재 운영 catalog와 기존 baseline20 catalog는 14개 정적 범주, 함수46개·테이블14개·Storage 정책·권한 및 기록된 completion cron 구성까지 일치했다. 이는 구조 비교이며 실제 데이터와 업무 흐름 성공을 의미하지 않는다.

`tools/local/prepare_production_backend.py`는 기존 검토 목록·원격 version/name·중복·미등록 이력·스키마 차이를 확인한다. 배포 계획은 `PREPARED_NOT_ACTIVATED`, reviewed108 / operating20 / pending88, activationAllowed=false다. SQL·권한·네트워크 배포를 실행하지 않는다. 실제 DB 적용 직전 운영 이력·catalog를 다시 확인해야 한다.

Railway의 최신 배포·브랜치·설정은 이번 실행에서 확인하지 못했다. 브라우저 제어 연결이 제공되지 않았고 native Chrome은 사용자가 다른 작업 중이었다. 과거 CRASHED나 설정 오류를 현재 상태로 재사용하지 않는다.

## SQL108: 회원 ACK의 명시적 읽기 복구

공식 Supabase CLI가 생성한 `20261008083002_member_cleanup_ack_recovery.sql`을 SQL108로 추가했다. SQL100~107은 수정하지 않았다.

- `read_member_cleanup_recovery(afterId,limit)`은 task·dispatch 식별자, 종류·상태, 원 dispatch와 일치하는 ACK 여부만 반환한다. 경로·첨부·대화·인증정보를 반환하지 않는다. 조회는 실행 허가가 아니다.
- `claim_member_cleanup_ack_recovery(taskId,globalToken)`은 atomic/member 제어, 현재 전역 점유, 원 dispatch와 ACK의 회원·탈퇴·종류·object·원 lease/token 일치를 검사한다. 현재 유효 task lease는 뺏지 않는다. 증거 없는 UNKNOWN은 거절한다.
- 승인된 만료 task에 새 점유만 부여하고 원 ACK/dispatch는 보존한다. 공통 processor는 기존 ACK를 읽고 실제 provider GET 부재를 확인한 뒤 기존 complete RPC로 완료한다.
- `createMemberCleanupAckRecoveryPorts`는 신규 beginDelete와 recordDeleteAck를 전송 전에 거절한다. 일반 scheduler가 아니라 별도 복구 진입점에서 사용한다.
- SQL104 pending 함수의 후속 확장에 미완료 회원 dispatch도 포함했다. pending=true를 없애기 위해 임의 성공으로 바꾸지 않는다.
- 신규 RPC EXEC는 기본 닫힘이다. 최소키 TTL이나 ACK 없는 작업의 재삭제 정책은 추가하지 않았다.

## 검증과 실행 장애

실제 격리 SQL108 rollback 검사: ACK 없음 거절, active lease 거절, 일치 ACK 새 lease 복구, 원 ACK 불변, 오래된 token/lease 거절, DB 완료·완료 후 idle·앱 ACL 차단 PASS. 읽기 전용 하네스 검토에서 추가 치명적 결함은 발견하지 못했다. 조회의 ACK 조건을 claim과 일치하도록 보완했다.

회원 정리 계약·마감·배정 회귀15개와 신규 복구 전송 차단·최소 조회 검사2개가 통과했다. 운영 이식 준비의 중복/미등록/이름 변경/빈 이력/추가 입력 거절3개가 통과했다. 준비 도구의 전체 과거 검사에는 완료로 집계하지 않은 중단 실행이 있으며, 이번 변경의 SQL99/101/102 이후 적용 순서·해시 변조 검사3개는 통과했다.

추가 실제 Storage/HTTPS 복구 driver와 SQL108 복원 driver를 작성했다. 격리 Docker exec가 반복 120초 시간 초과하여 이 추가 검증은 아직 PASS가 아니다. 응답 미확인 DB 작업을 자동 재전송하거나 공유 VM을 재시작하지 않았다. 먼저 격리 환경을 확인하고 시작된 작업·제어 상태를 조회한 뒤 검증을 재개해야 한다. 기존 SQL107 복원 증빙을 SQL108 최종 복원으로 확대하지 않는다.

## 배포·중단·복구 절차

1. 최종 제품 CLI와 성공 증거·주기 파기, 네이버 두 회원 흐름을 검증한다. 공급사·AI 신고 등의 활성화 조건을 확인하고 미확인 기능은 닫아 둔다.
2. 최신 원격 commit·로컬 검토 해시·운영 catalog를 고정한다. 운영 전체 DB와 역할·Storage 복구 지점을 확보하고 최종 스키마로 격리 복원한다. 백업 보유만으로 복구 성공을 주장하지 않는다.
3. 내부 실행 제어를 닫고 기존 cron·completion·queue 실행 경로를 확인한다. pending88개를 검토된 순서대로 적용하며 각 실패 시 후속 적용을 중단한다. 적용 결과가 미확인이면 이력·catalog 조회로 확정하고 자동 재전송하지 않는다.
4. 검증된 API를 배포하고 최소 권한 전용 LOGIN·검증 CA/TLS·HTTPS·내부 인증을 주입한다. service role·비밀은 클라이언트에 제공하지 않는다. 역할·제어·EXEC를 기능별 승인 범위로만 연다.
5. completion과 queue의 담당 작업이 중복되지 않게 cron을 전환한다. Railway의 실제 제품 CLI에서 LISTEN 재접속·두 실행기 경쟁·재시작·주기 파기를 확인한다. 실행기 공개 도메인은 만들지 않는다.
6. 장애 시 신규 claim과 외부 전송을 닫고 미확정 식별자를 보존한다. 이전 앱으로 되돌릴 때 새 DB와의 호환성을 먼저 확인한다. 데이터가 있는 DB를 무조건 이전 스키마로 내리지 않는다.
7. DB 복원이 필요하면 cron·제어·EXEC가 닫힌 상태에서 복원한다. 보호한 삭제 최소키/목록으로 삭제를 재적용하고 UNKNOWN·읽음·권한을 대조한 뒤 실행을 연다.

관련 제품 수정 요청은 [제품 연결 인계](2026-10-08-product-connection.md)에 유지한다. 종현은 큐 집계·maintenance 분리·영속 requestId 헤더·cycle 확정·CLI 조립을 담당한다. 민규는 DB/RPC·최소 권한·환경·검증·복구를 담당한다. 본 문서는 운영 활성화 완료 보고가 아니다.


2026-10-10 최신 갱신: 공개 Auth task 완료 응답 유실의 실제 복구와 최종 own4 종료·source/prior 보존까지 통과하여 운영3을 완료했다. 최신 **79%(22/28항목)**, 핵심9/10·추가5/6·독립5/5·운영3/7이다. 이전 표는 당시 기록이며 [실행 기록4.77](2026-10-09-backend-execution.md)과 최신 전체 계획을 따른다.
