# 약속 결과와 연속 취소 계산 원장 연결

작업자 minkyu. 최신 정책2-3과 상세 설계의 최신 합의 시작→확정 시각→고유번호 순서, 실제 정상 완료의 횟수 초기화, 취소 후24시간·검토 중·중간 미결 보류를 연결한다. 기존 계산 함수는 전용 결과 원장을 읽지만 실제 확정·변경·취소·완료 경로의 등록 hook이 없어 기능 누락을 확인했다.

별도 WT에서 신규40800 migration과 minkyu SQL 회귀 후보를 작성 중이다. 신규 확정 때 이미 고정된 양쪽 가입 회차·검증 identity와 실제 confirmed_at·합의 시작을 기록한다. 변경은 수락 후 실제 시작 변경만 반영한다. 취소는 실제 로그의 취소자/시각을 own_cancel/peer_cancel로 기록하되 사유 인정·예외·제재는 추정하지 않는다. 양쪽 또는 자동 완료가 실제 성립하면 completed, 완료 후 분쟁·불발은 자동 원장의 pending 보류로 연결한다. 운영 정정·이의 중·면제 결과는 출처 구분을 통해 덮어쓰지 않는다.

과거 자료는 현재 공고 시각으로 합의 순서를 추정하지 않는다. 고정된 회차·identity가 확인되는 영역은 unknown 순서로 보류하고, 매핑이 없는 옛 자료는 다른 네이버 계정·이름으로 추정 연결하지 않는다. 자동 이벤트 식별자는 운영자의 사실 판정 증명이 아니다. 계정/회차의 추가 역순 잠금·감점·통지·기한 설정·제재 적용은 새 hook에 넣지 않는다.

결과 원장 FK는 유지한다. 실제 탈퇴는 회차/identity를 보존하며 현재 보관 batch는 본문/메시지를 삭제한다. 향후 약속 물리 삭제 및 보관 최종 종결 연결은 별도 검증 대상이다. 정확한 합성 fixture 정리는 revisions→results→appointments 순서가 필요하다. 기존 제재 계산 회귀는 자동 생성 이후의 원장 충돌만 조정하고 계산 검증을 제거하지 않는다.

현재 상태는 후보 작성 중이며 실제 SQL·영속 적용·회원 API·동시성 검증은 NOT_RUN이다. 전체57% 및 신고·제재50%를 유지한다.


## 기존 계산 회귀 준비 변경 검증

기존 sanction_adjudication_draft.sql의 add_plan_result는 owner 합성 순서/판정을 준비하는 fixture다. 새 자동 등록과 중복되도록 계산 검사를 제거하지 않고, 이 fixture의 특정 약속에 한해서 revisions/results를 교체한 뒤 기존 판정 INSERT와 모든 계산 assertion을 유지했다. 현재 실제 native64에서 전체 SQL/rollback PASS 및 자료·역할/권한·기존 함수·원장·컨테이너·Storage 파일0 원복을 확인했다. 증거 `/private/tmp/yumidang-sanction-regression64-38u2w8f5/receipt.json`. 아직40800이 없으므로 이 증거는 자동 등록과의 통합 PASS가 아니며 신규 실제RPC 회귀와 통합 후 재검증이 필요하다.

## 후보 실제 DB 검증: 첫 실패 보존

후보 SQL `afc727a109454d430ab2b39b7d8000c2f7f49638c4351200454827c8a2c1ab80` 및 테스트 `2ebf3b5e1ed063496e1b77cca9b533beffbc4c36be5f618a45cad9b378b96643`를 actual native64에 PRE fixture→migration 본문→POST 검증 순서의 단일 트랜잭션으로 실행했다. 첫 신규 identity 결함의 정확한 오류 assertion에서 FAIL(sqlExit3)이며 실제 오류값은 초기 assertion에 표시되지 않았다. 원본 baseline 전체 복원, 컨테이너 유지, Storage 파일0을 확인했다. 실패 증거 `/private/tmp/yumidang-safety-sync64-l1uadxxm/receipt.json`과 로그를 보존한다.

소스상 기존21811 신규활동 gate가 identity 누락을 먼저42501로 거절한다. 기존 방어를 우회하거나 제품 오류를 바꾸지 않고 해당 기존 거절과 신설 확정 후40001 방어를 별도 결함 fixture로 구분해 검증한다. 후보 영속 적용·운영 배포·실제 두 세션 경합은 여전히 NOT_RUN이다.

## 실제 native64 후보 트랜잭션 검증 PASS

최종 SQL SHA `afc727a109454d430ab2b39b7d8000c2f7f49638c4351200454827c8a2c1ab80`, 테스트 SHA `0ad40162c97d02bc75d3c345c10afa1a49565e14a2bbbcf2953aaf22cbdd81f9`의 PRE fixture→migration 본문→POST 순서 actual SQL 실행 PASS. 증거 `/private/tmp/yumidang-safety-sync64-5rcjzowb/receipt.json`. 과거4약속/미연결 맵1/identity누락2/unknown신규3의 실제 비어 있지 않은 이관, 원래 판정 보존, authenticated 신규 확정의 양쪽 고정 identity, 기존42501 및 신규40001의 원자 rollback, 합의 일정 수락·철회·거절, own/peer 취소·재시도·24시간 보류, 양쪽 완료·예약 RPC 자동 완료, 완료 후 분쟁 보류·정상 인정 복원·노쇼 보류, 보호 origin·이의·면제, owner/ACL/FK 경계를 확인했다.

전체 SQL/자료/역할/권한/트리거/새 origin·감사 schema는 rollback 후 원복했으며 보호 컨테이너 유지·Storage 파일0을 확인했다. 후보는 동일 SHA로 민규 작업 트리에 통합했다. 파일의 초기 NOT_RUN 주석은 후보 작성 시점이며 현재 실제 검증 범위는 이 절이다. 아직 영속 적용·회원 HTTP·실제 두 세션 경합·제재 통지/이의 업무 검증 완료는 아니다. 완료 전 신고 검토 연결과 과거 순서 복구·보관 종결도 다음 연결 과제다. 전체57% 유지.

검증 준비 runner의 첫 schema baseline 확장은 SQL 괄호 오류로 제품 실행 전에 중단됐다(`/private/tmp/yumidang-safety-sync64-zp6ag400`). 실행하지 않은 준비 실패와 실제 후보 실패를 구분하여 보존한다.

## 기존 계산과 신규 자동 원장 통합 회귀 PASS

actual native64에40800 후보 본문→기존 sanction_adjudication_draft.sql을 단일 TX로 실행해 모든 기존 계산 assertion PASS를 확인했다. 자동 등록 후 특정 owner 계산 fixture만 명시 교체하며 검사를 제거하지 않았다. 증거 `/private/tmp/yumidang-sync-sanction64-rp_hg7xw/receipt.json`; 원본 baseline/schema/자료/컨테이너 복원과 Storage 파일0 확인. 영속 적용은 하지 않았다.

## 65개 준비 및 실제 로컬64→65 적용 PASS

준비 도구/회귀 후보는29개 관련 검사 PASS(별도WT 78.814초)를 확인하고 동일 SHA로 통합했다. tools/local/prepare_current_policy.py SHA `e44eda561a68c88983133f3fed1a98a95b937987525ad0bb216a71f7103a7601`, 테스트 SHA `126daa3a39dabb59f4ba10fbbbdfd1f03960091bdcdb12b9d57b1084ea9579dd`. 기존28/41/60/61/62/63/64 및65 exact 집합, 변조·부분 이력 거절을 보존했다. 원래 strict41 도구는 수정하지 않았다.

main 실제 준비 artifact `/private/tmp/yumidang-policy65-reviewed-e0hpsl74/prepared`는65개SQL/49개서버 검토 SHA를 확인했다. migration-manifest SHA `2303e3ae6507bfad1859d012ae16b96814563a5ceb2001c44591d116515e5ee6`, edge-manifest SHA `003deb8f7931a9d9c2cd6f9afdaf20a242fdd39a90b50d227cde965248a5650d`. READY는 파일 준비 증거이며 SQL/Edge 실행은 이 artifact에서 NOT_RUN으로 유지한다.

공식 cached CLI로 격리 native64→65에40800 한 개만 실제 적용했다. dry-run pending1→한 번 적용→이력65/대기0/새 private함수 직접 ACL폐쇄/기존 함수·역할·멤버십·profile ACL·원래 제약 보존/cleanup guard false/worker idle/자료와 Storage 파일0/기존 컨테이너 유지 PASS. 빈 DB 이관 집계는0이며 비어 있지 않은 과거 이관 검증은 앞의 별도TX 증거를 따른다. 증거 `/private/tmp/yumidang-native65-rollout-947ottay/application-receipt.json`. 운영DB/실제 네이버 환경은 변경하지 않았다. 회원 API65 연결 검증은 다음 단계다.

## 실제 native65 회원 API 14개 그룹 PASS

검토한 driver SHA `82b566eac2d1fd0627f77cee041ea5101a0cd1872222027366ec5c27943a05da`를 main에 동일 bytes로 반영하고 --native65-approved의 고정 manifest/edge/SQL65/서버49 검사를 통과했다. 실제 로컬 Auth·REST·Storage와 프로세스 내부 회원HTTP14그룹 PASS, cleanup verified true/failures0. API 확정에서 양쪽 고정identity를 생성하고, qualified 양쪽의 실제HTTP 일정 제안·수락(+30분) 후 최신합의 순서가 반영되며, 정보누락/자격불충족 상태의 기존 약속 취소에서도 own/peer 시각·origin·revision 이력이 일치했다. 자동제재를 추가하지 않았으며 결과 확인의 owner SQL은 읽기 전용이다. 기존 본인 제재조회의9개 owner 합성 원장은 별도 범위다.

결과 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-naver-native65-1DzRqP/result.json`.38개관계 및 실제Storage 파일0, durable recovery 파일 제거, 이관 감사집계 byte보존, 역할/권한/guard false/worker idle/65이력을 확인했다. 최종 독립 DB 비교 `/private/tmp/yumidang-native65-rollout-947ottay/final-database-receipt.json` 및 보호컨테이너 비교 `final-container-receipt.json` PASS다.

실제 네이버 OAuth·hosted Edge·모바일·운영제재/통지·이의·새원장 실제두세션은 이 API 증거에 포함하지 않는다. 완료 원장 연결은 앞의 실제SQL/RPC 회귀로 검증했으며 이번14그룹에서 완료 HTTP를 실행한 것은 아니다. 전체57%/신고·제재50 유지.

## 새 원장 실제 두 세션: 초기 조회 timeout 보존

경합 driver 초기 SHA `8b13c6f064e675d5285c627088d67f027da457205dfe2bf110cfff92794be7dd`를 실제native65에 실행했다. terminal exit1/OWNER_QUERY_TIMEOUT, cases0/lockEvidence0/cleanupVerified false로 실패했다. 증거 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-safety-result-race65-c18dyk84/result.json`. 복구 파일과 fixture가 없으며 초기 owner 조회 실패의 구체 단계·원인은 당시 driver가 기록하지 않아 미확정이다. 실패를 경합 검증 PASS로 취급하지 않는다.

재실행 전 별도 read-only actual DB 확인으로65이력/last40800와users·profiles·posts·safetyresults0을 확인했다. client backend3개는 모두idle/열린TX false이고 새harness세션이 없었다. 이어 원래postflight와 기존 함수/역할/멤버십/ACL/자료를 비교해 보존 PASS, 안전원장0/이관감사집계0 단일행을 확인했다. 별도 증거 같은 실패 디렉터리의 `post-timeout-readonly.json`. 운영/원래네이버 환경을 재시작하지 않았다.

검증 후보는 query 단계/번호·duration만 기록하고 SQL원문/비밀값은 기록하지 않는 진단을 보완하며, 모든schema테이블 count를 동일 범위의 묶음조회로 바꾼다. SQL statement10초/lock8초는 유지하고 로컬process 조회상한만30초로 구분한다. 잠금·40001·원자rollback의 실제PASS는 재검증 결과로 따로 기록한다.

## 실제 새 원장·취소 두 세션3조건 PASS

최종 driver SHA `fede35fe64f52d200e1c573e70a7ccef816c08d4cce89b11e13e40dda5d9743b`를 actualnative65에서 실행해 terminal0/세 조건 PASS를 확인했다. 뒤identity 원장 행의 owner 실제잠금에서 취소40001/전체snapshot rollback→ownerrollback후 동일CID성공, owner operator pending revision COMMIT후본인판정보존/다른쪽peer반영, owner revision ROLLBACK후원래pointer복원/ownpeer취소성공을 검증했다. 정상취소 동일CID재시도의전체snapshot도보존된다.

각 owner/member는 다른backendPID이며 owner완료barrier/xact와 같은행의 별도55P03 실패로 실제잠금을 확인했다. blockingPID부재를증거로쓰지 않았다. snapshot은 공고/약속/신청·동의/장소·상세/예약/변경/이벤트/알림/취소/양쪽원장·revision을포함한다. owner 합성 판정은 실제운영직원권한증명이 아니다.

결과 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-safety-result-race65-rytvgjwv/result.json`. cleanupVerified true, 원래모든schema관계count·역할/멤버십/ACL/guard/65이력보존·Storage파일0·자기session0·복구파일제거를확인했다. 실패원인은미확정으로보존하며최종PASS가첫timeout원인을설명한것은아니다. 이검증은SQL경합이며 실제Auth/HTTP/Provider/운영/모바일증거로확대하지않는다. 전체57%유지.
