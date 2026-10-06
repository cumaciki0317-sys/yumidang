# 신고 완료 증거 만료 정리 포트

민규(`minkyu`) 담당 기존 `report-retention-client.ts`에 `createReportRetentionMaintenancePort`를 추가했다. 새 실행기·종현 파일은 만들거나 수정하지 않았다.

호출자는 기존 공유 실행 토큰·잔여 예산 signal·공유 호출 수에서 배정한1~20개 한도를 제공한다. 한 번만 `purge_report_retention_terminal_receipts`를 서비스 JWT로 호출하고 exact `{purged}`의0~limit 정수만 인정한다. 자체 점유·enqueue·반복·해제·예산 갱신은 하지 않는다. 명확한401/403은 원 거절을 유지하고, 전송 뒤 유실/잘못된 응답/중단/5xx는 `ReportRetentionMaintenanceUnknown`으로 보존한다. 자동 재시도·성공 집계·성공으로 간주한 해제를 금지한다.

Node 모형5개와 기존 신고 RPC12개 총17/17 PASS, Deno 실제 타입 검사 PASS다. DB의 기존30일 TTL 변경·운영 권한 개방·현재 소스의 실제 REST 호출·상주 연결은 NOT_RUN이다. SQL 자체의 기존 실제 검증과 포트 현재 실행 증거를 구분한다.

종현은 기존 dispatcher에서 terminal 유지관리를 새 작업 kind로 가장하지 않고 별도 timer/공유 예산에 연결해야 한다. 만료 조회·알림·원격 완료 확인 계약은 후속이며 이 포트만으로 전체5번을 완료 표시하지 않는다.
