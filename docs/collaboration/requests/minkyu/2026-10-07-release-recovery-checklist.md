# 민규 배포·복구 인수인계 준비

이 문서는 운영 변경 승인이나 서비스 출시 완료를 뜻하지 않는다. 민규 담당 10번의 산출물과 격리 리허설 증거다.

## 현재 적용 차이

- 운영 프로젝트 `bndguguarijmghnkenvt`: 마지막 읽기 수집 기준 이력 20개. [동일 20개 재현 비교](2026-10-05-schema-catalog-comparison.md)는 STATIC_MATCH이며 실제 서비스 동작 판정은 별도다. 배포 직전에 새 read-only catalog를 수집해 이력·해시·권한·cron을 다시 대조한다. 현재 운영 상태를 과거 자료로 추정하지 않는다.
- 원 정식 로컬: 88개. 기존 회원·이력·권한을 보존했다.
- 최신 준비: 94개, Git 이력 86개와 미커밋 후보 8개. `/private/tmp/yumidang-policy94-reviewed-prepared/current-policy-manifest.json` READY. SQL/Edge 실행 NOT_RUN. 검토된 기존 SQL을 수정하지 않는다.
- 연결 검증용 격리 프로젝트: 기존 CLI 이력 88개에 후보89~94를 개별 검증 적용했다. 원 로컬에서 단일 TX/rollback 검증도 수행했다. 격리 프로젝트의 후보 적용을 정식94개 이력 등록으로 표현하지 않는다.

## 배포 순서와 확인 조건

1. 운영 접근과 담당자를 확인하고 최신 catalog·migration 목록을 비공개 수집한다. 기대 이력/해시와 다르면 적용을 중단한다. 회원 자료는 문서·로그에 내보내지 않는다.
2. DB와 Storage bytes를 같은 유지관리 구간에 백업하고 파일 hash·권한·보관/암호화·접근 담당을 기록한다. API 쓰기와 worker를 멈춰 일관된 snapshot을 확보한다. 운영 백업 보관 조건은 운영자가 확인해야 한다.
3. 준비 manifest의 버전 순서대로 미적용 SQL만 적용한다. 운영이 20개라면 이후 74개가 검토 대상이며, 최신 재수집 결과가 바뀌면 이 숫자도 다시 계산한다. 중간 오류 후 전체를 재실행하지 않는다.
4. 기존 cron과 신규 예약 처리의 중복을 제거한 뒤 단일 실행 경로를 선택한다. 이전 cron 비활성화, 신규 큐/상주 실행기 활성화는 하나의 점검 구간에서 진행하며 완료·취소·분쟁 예외와 예약 상태를 확인한다. 종현 소비자 미연결 상태에서는 취소/신고 예약 기능을 활성화하지 않는다.
5. 회원 HTTP는 JWT와 사용자 DB client, 운영자 HTTP는 배정된 직원 JWT, 작업은 별도 내부 인증과 제한된 큐 역할을 사용한다. `service_role`은 서버에서만 보관하며 회원 요청에 전달하지 않는다. 인증·RLS·RPC EXECUTE 권한과 정확한 DTO를 배포 후 검사한다.
6. 네이버 콜백·사진 접근·공고/확정·양쪽 완료·후기·신고와 이의를 실제 계정으로 smoke 검증한다. 미검증 공급사 기능은 control/외부 전송 guard를 닫아 둔다.
7. 실패 시 기능 guard/worker를 먼저 닫고 마지막 성공 버전·배포 hash를 확인한다. DB 복구는 별도 승인된 대상에서 진행한다. 사용자 데이터에 영향을 주는 다운 SQL을 추측해 작성하지 않는다.

## 복구 리허설: 실제 DB와 Storage

비공개 증거: `/private/tmp/yumidang-release94-recovery/recovery-receipt.json` **PASS**.

- source: 검증용 `yumidang-release88-http`; target: 별도로 생성한 `yumidang-release92-restore`(API60621). 기존 로그인 서버와 운영 DB 유지.
- 최신 SQL94 제재 clock lineage 2개까지 포함해 pg_dump custom 형식과 Storage 실제 bytes를 백업했다. 별도 target의 빈 합성 환경에 단일 TX로 pg_restore했다.
- 전체 테이블 행 수, public/private 함수 정의·ACL, Storage 파일별 SHA가 정확히 일치했다. 기존 컨테이너 보존 검사 통과.
- 합성 JPEG 하나를 백업한 후 source에서 알려진 성공 DELETE를 확인했다. 복원된 target에서 사진 재등장을 확인하고 성공 삭제 manifest를 재적용했다. 이후 HTTP 객체 부재와 DB metadata 부재를 확인했다.
- 실제 Storage 객체 부재 응답은 HTTP400이었다. 첫 검사의 404 기대 실패는 보존했고, 삭제 재전송 없이 읽기로 부재를 확인해 후속 단계만 재개했다.
- 미확인 DELETE/ACK를 자동 재전송하지 않았다. 알려진 삭제만 원 bucket/name/hash와 성공 영수증을 비교해 재적용한다. 미확인 요청은 별도 확인/운영자 판단이 필요하며 복구 성공을 이유로 완료 ACK를 만들어 넣지 않는다.
- 비공개 dump에는 합성 Auth 자료와 로컬 상태가 있으므로 Git에 추가하지 않는다. secret이 있는 status 파일과 산출물은 비공개 디렉터리에 보관한다.

## 공개 문서와 출시 대기

공개 삭제 안내 초안은 [삭제 페이지](2026-10-05-public-deletion-page.html), 개인정보 항목·수명 초안은 [데이터 목록](2026-10-06-privacy-data-inventory.md)을 따른다. 운영자 조유미, 확인된 연락처 `cumaciki0317@gmail.com`. 실제 공개 URL·지원 담당 확정과 게시가 남아 있다.

| 대기 조건 | 담당/완료 증거 |
|---|---|
| 신고/취소 소비자와 실제 두 실행기 경쟁·재시작 | 종현 구현, 민규 DB/Storage 포트 통합. [요청](2026-10-06-runner-consumer-integration.md) |
| AI 다계정 실제 서비스 runtime 연결 | 종현. 민규 adapter와 실제 pool/RPC 검증 완료; 외부 호출/운영 활성화는 미실행 |
| 실제 네이버 적격 회원 2명 | 팀원 계정 준비, 민규 전체 흐름 검증. 현재 계정 연결 성공/자격 미충족 차단 확인 |
| Railway 프로젝트·서비스 접근과 배포 | 팀원/운영 담당. 링크·환경·최소 권한·재시작 증거 필요 |
| AI 업체 개인정보·공동 사용·출력 상한 | 공급사 답변/운영 담당. 답변 전 외부 전송 비활성 |
| 행사 공급사 보류 조건 | 공급사/종현. 미확인 연동 비활성 |
| 공개 URL·지원 담당·Apple 및 스토어 | 운영/배포 담당. 민규 구현 진행률과 별도 |

운영 DDL·데이터 쓰기, 자동 커밋·푸시는 수행하지 않았다.
