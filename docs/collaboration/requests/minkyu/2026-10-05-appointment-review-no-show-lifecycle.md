# 민규: 약속 검토의 최종 불발 종결

현재 민규13영역60%를 유지한다. 41000 후보는 실제 native66 단일 트랜잭션 SQL 검증 PASS 후 전체 롤백했다. native67 영속 적용·HTTP 운영 권한·불발과 보관의 두 세션 경합은 아직 수행하지 않았다. SQL 첫2줄의 NOT_RUN은 후보 작성 당시 상태이며 현재 증거는 이 문서를 따른다.

## 구현과 권한

최종 불발 판정은 약속을 no_show로 종결한다. 완료 전에는 완료 시각·완료 방식·알림·평가 기한을 만들지 않고, 이미 완료됐으면 실제 완료 기록을 보존한다. 최종 불발의 후기 기여·완료 횟수는 제외하며 귀책·감점·사건 원장·신고 최종종결을 자동 결정하지 않는다. 정상 정정은 남은 다른 보류를 유지하고 최신 합의 종료+24시간 및 최초 실제 완료+7일 기준을 재사용한다.

신고 원문 파기 후에도 최소 종결 시각과 판정 지문을 남겨 보관 기산이 앞당겨지지 않게 한다. 검토 중 파기는 거절한다. 기존7개 함수 OID/owner/ACL을 보존하고 신규3개 helper는 owner-only다. 회원·워커 공개 권한은 추가하지 않는다.

사용자는 탈퇴 후 완료 기록이 없는 불발의 정상 정정을 정정 시점 정상 완료·탈퇴자 후기 불가로 확정했다. 최종 main SQL은 이 정책을 반영했고 실제 단일TX SQL 검증도 PASS다. 아래 초기 c689 증거는 수정 전 후보 기록이며 최신 바이트와 증거는 마지막 절을 따른다.

## 실제 검증

SQL SHA c689b9925aed95f1127d077b8479601064c92a4fb02336e5e9e7ee6b5b19de4b, test SHA6051a3eadf51ef30d6286481e52f560db598efdf92746a1374a518efc78289ec. `/private/tmp/yumidang-no-show66-candidate-validation-actor-fixed/receipt.json` PASS: 실제 SQL exit0, 모든 합성 자료·함수 본문/권한/제약/trigger/hold열·역할·history66·guard false·worker idle 원복, 기존 보호 컨테이너/Storage 파일0 유지.

처음 실패는 사례7에서 회원3 세션이 남은 상태로 회원1의 사례2 신고를 시도한 테스트 오류였다. `/private/tmp/yumidang-no-show66-candidate-validation/receipt.json` FAIL, baselineRestored true. 제품의 신고 접근 정책을 넓히지 않고 테스트 계정만 복원해 재검증했다. 탈퇴 검사에서는 트랜잭션 안에서만 기존 cleanup5 권한·guard를 준비하고 검사 후 회수 및 원래 catalog를 확인했다. 실제 외부 Auth/Storage 삭제나 운영 준비 완료 증거가 아니다.


## 탈퇴 후 정상 정정 정책의 실제 SQL 검증

사용자 확정은 정정 시점 최초 완료·탈퇴자 후기 불가다. SQL ee7ad50db2617101c1f8a63cb3328903240e8493a39558b41ceb6a006ed2ae1d/test0fdb83c04dadaa9bac4d2e428d6948785c4eee2e31b128e8142b204a4d8a913b를 실제 native66에 단일TX로 실행했다. `/private/tmp/yumidang-no-show66-candidate-validation-retired-normal/receipt.json` PASS, SQL exit0·전체 baseline 복원. 한 명 탈퇴 후 정정시각 automatic 첫 완료/7일, manual 확인0, 활성 상대 알림·후기 작성, 탈퇴자 후기42501, 결과원장/완료 횟수, 정정 멱등, 다른 보류가 있으면 no_show 유지와 마지막 해소 완료, 새 최소근거의 보관 지문을 검증했다. 외부 Provider/운영 DB 변경은 없다.

읽기 감사에서 정상정정 알림의 profile FK 잠금과 동시 상대 탈퇴의 잠금 순서가 충돌할 가능성을 확인했다. 실제 교착 재현 완료로 설명하지 않으며 정확한 당사자 profile KEY SHARE NOWAIT/40001 원자 재시도 보강을 적용했다. 이 보강 후 새 SHA의 SQL 검증을 별도로 기록한다.


## 최종 NOWAIT 보강 후 실제 SQL

최종 main SQL b780d364f0d614a160934bd57bb2c1347f24d6a9321275baadbbaf632db3ed50/test0fdb83c04dadaa9bac4d2e428d6948785c4eee2e31b128e8142b204a4d8a913b. 정확한 두 당사자 profile을 UUID순 KEY SHARE NOWAIT로 확인하며 충돌/당사자 부족은40001로 전체 정정을 롤백한다. 기존 실제 PASS와 구분해 최종 바이트를 한 번 더 실행했다. `/private/tmp/yumidang-no-show66-candidate-validation-profile-nowait/receipt.json` PASS, SQL exit0·전체 baselineRestored true·보호 컨테이너/Storage 파일0 유지. 이 단일TX 증거로 실제 정정/탈퇴 두 세션 경합이 완료됐다고 주장하지 않는다. native67 영속 적용과 HTTP/운영 검증은 아직 후속이다.


## 배포 준비 검증

최종67 gate main 반영. 전체구조37개와 최종pin 관련6개 준비 검사 PASS. `/private/tmp/yumidang-policy67-final-reviewed/prepared` READY67·49개 서버 파일 SHA main과 일치, source working_tree_snapshot HEAD0b59906. 준비본 자체SQL/Edge NOT_RUN이며 native67 영속 적용은 하지 않았다. 운영배포·커밋·푸시도 이번 단계에 포함하지 않는다.


## native67 정식 격리 적용

`/private/tmp/yumidang-native67-rollout/application-receipt.json` PASS. root검토한apply75af1fc213b4fe0a2591dded508acf99784275ec66e346a864fde4e6c5f30b9d에서정확67준비SHA/main바이트/native66원본을확인했다. CLI dry-run41000하나만확인→한번적용→최종dry-run대기0. 이력67·기존9개함수OID/owner/ACL/proconfig유지·예상본문9개만변경, 신규helper3/ledger1/hold열1/검증된CHECK확장1/constraint5/trigger1. 전체자료counts·guardfalse·workeridle·Storagefiles0·기존보호컨테이너불변. 실제운영과Provider는변경하지않았다. 최종source준비본의NOT_RUN과이영속적용증거를구분한다.


## 실제 정정·탈퇴 경합2건

최종769c7c driver의실행영수증은 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-normal-retirement-race67-wi2d1vy0/result.json` PASS/cleanupVerifiedtrue다. case1은owner가정확profile을잠근fixture와이후실제회원retireRPC롤백을구분하며normal40001무효과와재시도완료/후기를검증했다. case2는실제retireRPC가정정의profile잠금에대기하는PID barrier와양쪽COMMIT을검증했다. 전체함수/constraint/trigger/RLS/ownerACL·역할·자료counts·guardfalse/workeridle·사진files0·세션0·보호컨테이너원복. 실제Provider삭제/운영담당HTTP/운영배포는이증거에포함되지않는다.
