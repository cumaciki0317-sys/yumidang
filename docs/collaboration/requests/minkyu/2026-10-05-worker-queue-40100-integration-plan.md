# 40100을 포함한 독립 scratch 통합 검증 계획

작업자: minkyu. 상태: 최초에는 설계만 준비했으며, 이후 root GO로 canonical 조합 검증을 실행해 아래 실제 결과를 추가했다. owner 부정 fixture는 설계만 준비/NOT_RUN이다. 종현 소유 코드와 기존 최종 4파일은 수정하지 않는다. 40100 owner guard 교정본과 root START가 모두 확인된 뒤 실행한다.

## 현재 증거와 적용 기준

`sanction-retention-combination-baseline-preserved/combined-final-receipt.json`의 명시된 16개 단계 PASS를 확인했다. 제품 3SQL, safety 연결 1개, M 호환 12개이며 저장소 전체 회귀를 대표하지 않는다. 마지막 두 회귀는 별도 `receipt-last2.json`에서 PASS했다. 앞선 FAIL 영수증은 그대로 남겼다. 최종 scratch의 회원·앱·Storage metadata·global singleton은 0행, cleanup guard는 false 설정행 1개, cleanup5 service ACL 0, 다른 DB handle 0, 전역 역할 및 safety ACL hash 불변이다.

native 원형은 독립 drift 프로젝트의 source56이다. 준비 영수증 `current56-preparation-report.json`은 56개(정식41+pending15) READY와 SQL/Edge NOT_RUN을 기록한다. 실행 증거는 별개인 `current56-sql-regressions.json`의 6개 SQL PASS 및 root가 확인한 native 재가입 12그룹/최종 정리 결과다. 이 설계 준비 중 native 서비스 테이블을 새로 조회하지 않았으므로 현재 실시간 데이터/권한 상태를 다시 증명했다고 설명하지 않는다. root 요청으로 독립 drift postgres의 pg_stat_activity metadata만 읽었고 다른 active client backend0·열린 transaction0을 확인했다. 이 수치는 해당 읽기 시점의 프로세스 증거다. 로컬 PID/프로세스명 읽기에서는 psql/docker SQL client가 없었고, Supabase CLI 2개(PID7635/93327)는 확인됐으나 상주 호스팅일 수 있어 DB 검증 handle로 분류하지 않았다. 본인 이전 실행 handle은 모두 terminal 종료다.

고정 schema-only source56 SHA256은 `783bf9451530033e73d561216565d970f46f78caff243df16afd1a7855d702d1`이다. 원본 dump에는 회원 데이터와 singleton 설정행이 없다. dump를 새로 생성하거나 native56에 후보를 적용하지 않는다.

적용 순서는 아래와 같다.

1. 동일 source56 schema-only를 새 빈 `yumidang_queue_combination_20261005`에 복원한다. 다른 scratch를 재활용하거나 기존 DB를 reset/drop하지 않는다.
2. main immutable21810 `b3c56b87385b5bf835f7ae52390b80b963d50b9308dc3878b8645a756905120f`.
3. main21811 `cf30480c6254060fbaef2bba375260d611ed17059ac200aee2af93d90da80255`.
4. 검토30100 `c7877762ca88df738a991b35fc65ae4144e1de6eaf7fca44b623caadaa7a1e60`, 관련 DBtest `ec505dbca3b12edd4e88e3f3b03d7aa616ad64980578d7274c021ca8e254b081`.
5. owner guard 교정 완료 후 root가 지정하는 40100과 DBtest를 exact SHA로 고정한다. 현재 읽은 초안을 자동 허용하지 않는다.

모든 경로·source SHA·snapshot SHA를 실행 직전에 재확인한다. 새 private700 artifact와 파일600, 단계별 새 로그/receipt를 사용한다. SQL 오류는 즉시 중단하고 전체 FAIL과 실제 성공한 단계들을 구분한다.

## owner·RLS·catalog와 닫힌 권한

DB 생성 전후 전역 역할·멤버십 hash를 비교한다. 새로운 역할·역할 상속·GRANT ROLE·전역 default ACL 변경은 금지한다. PostgreSQL core의 기존 pg_read_all_data 상속 SELECT를 회수하지 않는다. superuser/bypassRLS와 effective SELECT/UPDATE/DELETE를 읽기 metadata로 기록하여 명시 ACL과 구분한다.

21810 적용 뒤와 30100 적용 뒤의 safety4 테이블 relowner/relacl hash가 같아야 한다. 30100 helper의 safety owner·SECURITY DEFINER·빈 search_path, core EXECUTE, anon/authenticated/service_role EXECUTE 차단을 검증한다. 이번 변경의 직접 core table ACL 추가0, effective core UPDATE/DELETE0 및 사용자/service 원문 SELECT/UPDATE/DELETE0를 유지한다.

40100 적용 전 acquire_worker_run의 OID/owner/ACL/기본값/결과, 기존 guard·cleanup5 ACL·관련 테이블 RLS/ACL을 고정한다. 적용 후 기존 값이 보존되고 새 queue schedule/budget/notify 함수의 owner가 검토 기준과 일치해야 한다. 새 함수는 공개·회원·service_role 모두 닫힌 ACL이어야 하며 owner guard는 허용된 실제 owner 호출과 비소유자 거절을 분리해 검증한다. JWT role 문자열만 바꾸는 가짜 owner 성공을 사용하지 않는다. 실제 역할 전환 검증에 필요한 한시적 함수 EXECUTE 준비는 승인된 scratch 테스트 BEGIN/ROLLBACK 안에서만 하며 테이블 grant는 하지 않는다.

4개 queue NOTIFY trigger의 테이블·이벤트·statement-level·함수 OID/owner를 catalog로 확인한다. payload가 빈 문자열이고 NEW/OLD 원문·UUID·종류·token을 포함하지 않는지 검증한다. cron/net/HTTP가 추가되지 않았는지도 비교한다. 실제 LISTEN 검증은 별도 두 세션/합성 transaction 승인이 있으면 COMMIT만 알림, ROLLBACK 알림 없음까지 수행하며 상주 워커 실행 성공과 구분한다.

## 회귀와 fixture 준비

원래 제재/gate/보관 3SQL과 safety overlay·기존 명시12 M호환을 동일 조합에서 다시 실행한다. 40100 `worker_queue_schedule.sql`을 추가한다. 모든 fixture는 BEGIN/ROLLBACK이며 report/profile Storage bucket은 metadata만 준비하고 실제 blob/Provider 삭제로 설명하지 않는다.

source56에는 설정행이 없으므로 cleanup guard의 false 행은 absent일 때만 새 scratch 준비로 넣는다. global singleton(true,NULL,NULL)은 필요한 각 테스트 BEGIN 안에서 absent일 때만 넣고 ROLLBACK 후 원래0행으로 되돌아와야 한다. 기존 행을 덮어쓰거나 expiry를 준비 단계에서 변경하지 않는다. queued 테스트의 lease 만료 fixture는 원래 테스트 transaction 안의 합성 metadata이며 제품의 점유 연장 권한이 아니다.

추가 fixture는 report 종결+2160시간, account→identity 실제 FK와 bind trigger, starts<ends/recruitment<=start, 완료 알림+24시간/후기 기한, 이의 received<deadline/종료시각 CHECK를 사전에 대조한다. safety overlay는 candidate DBtest의 일시 owner-drift fixture 이전에 넣는다. ALTER OWNER fixture는 같은 transaction 안에서도 ACL을 바꿀 수 있으므로 뒤에 권한 의존 검증을 추가하지 않는다. fixture 오류가 나면 즉시 반복하지 않고 관련 FK/CHECK와 연결을 함께 정적으로 검토한다.

queue 회귀는 다음을 구분한다.

- 빈 queue의 exact serverNow/nextDueAt/nextKind 3필드, 입력 종류·배열 차원·NULL·제외3종류·afterKind 검증.
- guard false 또는 cleanup5 중 하나라도 service EXECUTE가 닫히면 cleanup 숨김. 실제 task·lease·state는 읽기 전후 불변.
- Storage 미완료 시 Auth task 제외, running lease 미래 due 및 만료 due, 준비된 cleanup과 review_summary의 순환 공정성, 모든 종류 제외 시 null.
- 전역 점유 중 due가 기존 expiresAt보다 먼저 반복되지 않음. schedule/budget 읽기가 global lease를 연장·claim·dispatch하지 않음.
- budget은 exact remainingMs 양의 정수와180000 상한, DB 잔여시간 감소, 잘못된 token/만료40001, 서비스 자격·owner 경계 및 닫힌 실제 ACL.
- event_sync는 현재 enqueue가22023으로 거절하는 기존 gap을 유지한다. 세 종류 슬롯이 존재한다고 행사 동기화 구현 완료로 표시하지 않는다.

main M `member_cleanup_budget.test.ts`는 왕복시간 차감·wall/monotonic 시계·응답 DTO·취소·config·범용 RPC목록 폐쇄를 mock으로 검증하는 별도 단위 단계다. 실제 SQL budget 성공과 mock fetch 성공은 각각 기록한다. 미래 실제 로컬 HTTP 연결을 하더라도 이 scratch 검증만으로 Provider delete/Ack 복구·상주 실행기 fairness·운영 cleanup ready를 증명하지 않는다.

## 최종 확인과 인수인계

모든 테스트 종료 뒤 fixture FK 범위와 worker_jobs/worker_job_run_fences/global singleton이0행이어야 한다. 준비 false guard만1행 유지한다. cleanup5와 신규 schedule/budget service ACL은0, 새 helper user/service ACL 닫힘, 전역 역할/멤버십 hash와 기존 table ACL 불변, 열린 검증 backend0을 확인한다. 없던 행은 되돌리고 기존 행은 덮어쓰지 않는다. 실패 로그/receipt를 PASS로 바꾸지 않는다.

Docker host는 기존 독립 drift Colima 소켓, 컨테이너는 supabase_db_yumidang-minkyu-drift만 사용한다. stop/start/reset/prune/repair/원본/native/운영 DDL은0이다. 실행 중에는 단일 handle을 즉시 root에 알리고 종료 및 최종 정리를 전달한다. 이 문서는 새 조합 실행 승인이나 40100 검토 완료를 뜻하지 않는다.


## owner guard 부정 fixture 설계와 한계

공유/전역 역할을 CREATE/ALTER/GRANT/REVOKE하지 않고도 금지 owner 이름과 비특권 owner 분기는 새 scratch의 transaction-scoped 함수 owner fixture로 검사할 수 있다. 먼저 acquire_worker_run의 OID·owner·ACL·서명·body·default·result를 보관한다. 후보40100의 첫 anonymous owner guard DO를 원문 그대로 추출해 고정 SHA를 남긴다. SQL 전체의 BEGIN/COMMIT은 복제하지 않는다.

BEGIN/SAVEPOINT 안에서 acquire_worker_run만 기존 금지 역할(service_role 등) 또는 catalog에서 비특권으로 확인된 기존 역할로 ALTER OWNER한다. 실제 guard 원문 DO를 실행해 정확55000/worker_schedule_owner_incompatible을 기대하고 SAVEPOINT ROLLBACK으로 owner/ACL을 되돌린다. owner 변경 권한이 없으면 그 경우는 NOT_RUN이며 sharedrole 조작으로 우회하지 않는다. 테스트 종료 전 함수 metadata 원복과 역할·멤버십 hash 불변을 확인하고 전체 ROLLBACK한다. 이 fixture는 함수 소유자 변경이며 CREATE/ALTER ROLE이 아니다.

USAGE=false/SET=true membership을 새로 만드는 작업은 global roles 변경이므로 금지한다. baseline에 해당 관계가 실제 없다면 이 부정 분기는 NOT_RUN으로 기록한다. pg_has_role 함수나 owner guard 표현식을 가짜 함수/값으로 교체해 실제 catalog 검증처럼 주장하지 않는다. auth schema USAGE/auth.role EXECUTE/SELECT 누락도 기존 owner의 상속 권한 때문에 local object REVOKE로 실제 부정 상태를 만들 수 없는 경우 NOT_RUN이다. 기존 readAllData/bypassRLS를 회수하지 않는다. FORCE RLS를 이유로 privileged owner가 결과를 읽지 못했다고 가짜로 기대하지 않는다. 실제 baseline의 권한·owner/RLS 확인과 행 없는 성공을 구분한다.

이 부정 fixture는 이번 canonical GO 실행에 추가하지 않았다. 공유 역할 변경0을 보장한 별도 검토·단일 실행으로 진행할 후속 계획이다.

## root GO 이후 canonical 실제 결과

최종40100 SQL SHA `71e18556baf27779a68fb209fb5b1cb51310ef5e6511c5cd5d65402de397aee5`, DBtest SHA `995ad58695dcb736557dce3538e1f0155f0da1352a773230a50e6819f3af4247`로 고정했다. 단일 새 scratch `yumidang_queue_combination_20261005`에서 source56+21810+21811+30100+40100을 순차 fresh 적용했고 모두 PASS했다. 실행 handle80084는 samehandle poll로 exit0 종료됐으며 timeout·중복 실행은 없었다.

worker_queue_schedule 실제 SQL 1개, 제품3SQL, safety 연결1개, 앞서 명시한 호환12개를 같은 새 조합에서 다시 실행해 총17개 test step이 PASS했다. canonical queue test는 실제 owner의 권한·RLS 호환, 닫힌 ACL, auth.role 의존, schedule 종류/순환/실제 cleanup guard5, storage→auth 선행 의존, exact budget와 잔여 감소/만료/토큰 오류, global lease 무연장을 검사했다. event_sync 미구현22023 gap은 유지된다. 별도의 실제 LISTEN·Provider 삭제·상주 워커 실행 증거는 아니다.

마지막 신규 RPC3개의 anon/authenticated/service_role EXECUTE0·4개 trigger, cleanup5 service ACL0·false guard1개, 전체 합성 fixture와 global singleton0행, 다른 DB handle0, 역할/멤버십 hash 불변, safety rawACL hash 불변과 신규 core 직접 table grant0를 확인했다. 이전 모든 FAIL 영수증과 기존 최종4파일을 변경하지 않았다. 원본/native/운영/전역 roles 쓰기는0이다. 비공개 근거는 `queue40100-combination/receipt.json`이며 source exact SHA와 실제 단계 목록을 포함한다.


## 별도 owner LISTEN 실제 증거

추가 root GO로 같은 scratch의 두 owner 세션에서 실제 LISTEN을 검증했다. 합성 review_summary job COMMIT 후 정확1개의 빈 payload 알림, due 변경 ROLLBACK 후 추가 알림0/due 불변, listener 연결 종료 중 변경 COMMIT 뒤 재접속의 과거 알림 재생0과 정확한 현재 due 재조회가 모두 PASS했다. backend PID가 달라진 것도 확인했다. handle50261은 samehandle poll로 exit0 종료됐다.

마지막에는 자기 dedupe의 합성 job만 삭제해 queue0/global singleton0으로 되돌렸다. guard false·cleanup5 ACL 원상·신규 RPC user/service ACL 폐쇄·역할 hash 불변·다른 handle0을 확인했다. 별도 증거는 `queue40100-combination/notify-proof/receipt.json`이다. 이 owner SQL 알림 증거는 전용 LOGIN·상주 worker·HTTP 인증·Provider 삭제 성공을 대신하지 않는다. 최초17-step receipt와 이전 FAIL 기록은 보존했다.


## 후속 owner 부정 fixture 실제 결과

별도 root GO로 기존5역할 anon/authenticated/service_role/authenticator/yumidang_completion_runner의 transaction-local acquire_worker_run owner fixture를 실행했다. 각 실제 owner 변경 후 후보40100의 원문 preflight DO만 실행해 정확55000/worker_schedule_owner_incompatible을 받았으며 ROLLBACK 후 함수OID·owner·ACL·body·config·args/default/result 전체 metadata hash가 원래 값과 동일했다. 공유 역할/멤버십·새 역할 변경은0이다. 실행은0.341초 안에 exit0으로 종료됐으며 별도 live handle이 남지 않았다.

근거는 `queue40100-combination/negative-owner-proof/receipt.json`이다. actual role flags·SQLSTATE·message·metadata 복구를 case별로 기록하고 exact-preflight.sql에 원문을 보존했다. SET-only membership 생성과 상속 권한을 제거해야 하는 부정 분기는 NOT_RUN으로 유지한다. guard/cleanupACL/roleshash 불변·queue/global0·다른 handle0 확인도 PASS했다.

알림 실행 source는 같은 artifact 상위의 notify_probe.py, 부정 owner source는 negative_owner_probe.py다. 두 프로그램이 사용하는 Session은 승인된 소스80592의 바이트 SHA를 확인한 뒤 exec(compile(...))로 읽으며 session.py 복제본은 없다. 원본 경로는 tests/integration/minkyu/member_activity_sanction_concurrency_local.py다. `execution-source-index.json`에 실제 절대경로/파일 SHA와 증거 위치를 기록했다. 알림 raw psql stdout은 별도로 보존하지 않았으며 receipt의 assert 결과를 raw 관찰 transcript처럼 표현하지 않는다.
