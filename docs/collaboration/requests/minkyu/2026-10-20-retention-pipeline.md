# WBS7.13 회원 보관 파이프라인 구현 후보

민규 harness: 작성 role_audit, 독립 검토 ownership_review, 원 저장소 반영 root 단독. 전체79%(22/28) 유지. 현재 소스121개 migration과 별개인 private SQL122 기술 후보다. 실제 SQL 적용·구문 컴파일·DB 검증·삭제·배포·커밋0이며 WBS7.13 전체는 미완료다.

private 위치 `/private/tmp/yumidang-member-retention-pipeline-20261020/`. 논리5파일은 신규SQL122, worker-runtime-client/internal-client/jobs-runtime 복사본과 민규 테스트다. 신규15+기존35=50개 오프라인 회귀와 TS3파일 타입 검사가 통과했다. 영수증 `receipt.json` SHA `b9d92bf1049210dfde383009f4e39dcab830aa87201f6e7ca0dfb892f0a07f45`, SQL SHA `3886aca586c23831147158a798bbc24c59edeba8420f5b0151cdefe70deb4d1f`. 독립 감사 `/private/tmp/20261020-retention-producer-peer-review.json` SHA `d271f59dcf93f1d866a2197e9726774b07a9f58559873f5eaaa5190dc59dac3d`는 이 동결본의 소스·기존 계약·원로그 대조 범위다.

첫 후보는 원 탈퇴 withdrawal/episode/retired_at과 현재 절차 상태로 DB owner가 종료 증거를 생성한다. caller 시각/해시를 받지 않고 원1년·90일·30일 기간을 변경하지 않는다. 대화 봉인 시각은 절차 종결이 아니므로 이를 종료 근거로 쓰지 않는다. 원종결 증거가 없는 역사 자료·대화·안전 절차는 보류한다. 기본 control/새 쓰기 EXEC는 닫히며 실제122 catalog/ACL 검토를 묶은 typed 객체 없이는 현재121 runtime에서 신규RPC0이다.

기존 전역 purger는 미리 검증한 집합 밖에서 새로 만료된 대상을 선택할 수 있다. 첫 후보는 삭제 연결을 하지 않고 purgeState=NOT_READY/purged=0을 SQL 결과·TS decoder·회귀에 고정했다. 이는 첫 구현 단계이며 전체 주기 파기의 대체 완료가 아니다. 후속 설계 `/private/tmp/yumidang-retention-gap-audit-20261020/scoped-purge-followup.md` SHA `4c1eb10e6ed45c922b2af58f9896cb20ef6de6ceb02350ac0f3946cbecd09e0b`는 신규 migration에서 private selector/validator/effect를 분리해 정확PK·원due·source·metadata·fence를 동일TX로 검증하는 방향이다. Storage 외부 DELETE와 PostgreSQL 물리 원자성을 주장하지 않는다. ACK/원객체 부재와 metadata 종결만 기존 durable 절차로 연결한다.

추가 root 검토에서 적용 전제 누락을 찾았다. 후보는 prepare/core owner만 검사하고 complete의 owner/ACL·교체 OID의 등록 의존성을 고정하지 않은 채 기존 complete 권한을 revoke한다. fresh121 기본closed에서는 즉시 회귀라고 단정하지 않지만, 별도 활성 권한·등록 의존성이 있는 DB에 조용히 영향을 줄 수 있다. 기존 동결/감사를 수정하지 않고 사전 거절 검사를 갖춘 별도 variant를 작성 중이다. pg_depend 검사만으로 동적 SQL/다른 session의 모든 cached caller 부재를 증명할 수 없으며 fresh 대상·activeTX·호출 source 검증이 별도 필요하다.

남은 작업: 적용 전제 variant 독립 검토 → 별도 fresh122에서 SQL/권한/원종결·배정·유실·보존 실제 검증 → bounded scoped 파기와 대화 원종결 source/행 chunk·ACK 수명 연결 구현. 실제 SQL 전에는 /me·121 복원과 같은 실행 슬롯·source freeze를 확인한다. 기존 J07 helpful/J09 Auth·Storage 실제 성공/UNKNOWN은 재작성하지 않는다. 후보 effect limit가 SQL scan 비용 상한까지 증명한 것은 아니다.

## 사전검사 후속 이력

첫 preflight variant는15개 순수 회귀가 통과했고 root도15개를 독립 실행했다. 실제SQL은0이다. 원영수증 a6cf와 peer ef125는 이후 발견된 NOINHERIT+SET 가능한 customrole을 거절하는 증거로 사용하지 않는다. PostgreSQL17은 즉시 상속 권한 USAGE와 명시 역할전환 SET을 구분한다. [공식 역할 검사](https://www.postgresql.org/docs/17/functions-info.html), [SET ROLE](https://www.postgresql.org/docs/17/sql-set-role.html).

별도 role-capability variant는 SQLDO·readonly catalog 추출·순수 checker에서 ownerRoleCapableCallers 필수빈배열과 USAGE/SET 호출자거절을 동기화했다.19개 순수 회귀 PASS, 영수증 `/private/tmp/yumidang-member-retention-pipeline-preflight-20261020/role-capability-variant/receipt.json` SHA `8f0d01d6af19abde8c722487e2347a8f2ed47b16a74aba2f1b8cf5f656bf917f`; SQL SHA `44a198dc3ff0ab4eab8f9872709f2d0e6eb8f23991c658da05398ef056f8ff0f`. 독립 읽기 검토도 통과했다. 권한있는관리자 면제 범위를 실행자전무로 표현하지 않으며 실제fresh 전체roles/memberships/ACL의 source-bound inventory를 root가 봉인·검토해야 한다. 원동결5파일·첫variant는 불변이다. 실제SQL/OID/ACL/권한변경0이며19개 PASS로 이를 대신하지 않는다.

최종 role-capability 독립 감사: `/private/tmp/20261020-retention-role-capability-final-peer-review.json` SHA `7b2a1070f8456838354c8baef0720f1cf10e793abbe5e843a0330f574da83bc9`. SQL/catalog/checker 동기화와19개 원출력 SHA를 대조했고 실제 PostgreSQL 권한 검증을 대신하지 않았다.
