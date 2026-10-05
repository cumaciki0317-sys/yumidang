# 전용 queue LOGIN 검증용 독립 source60 환경

2026-10-05 작업자 minkyu. 기존 native60과 원본 네이버 로컬 프로젝트에는 쓰기를 수행하지 않았다. 새 컨테이너 `yumidang-minkyu-queue-login-gk25`와 새 볼륨 `yumidang-minkyu-queue-login-gk25-data`만 생성했다. network none·socket-only·512MiB/1CPU 제한이며 host port와 외부 네트워크가 없다. source 회원 자료와 비밀번호는 복제하지 않았고 실제 queue LOGIN/password/TLS 생성은 NOT_RUN이다. 새 자원은 다음 단계 검증을 위해 유지하며 기존 자원 정리나 prune을 하지 않는다.

## 실제 입력과 복원

private artifact는 `/private/tmp/yumidang-queue-login-source60-gk25ga1j`다. native60 전체 schema-only SHA `b6ba2b32666a7ee254f71a4e70a6882b2318a7f172fcfc4ca64042aff29c51bf`를 고정했다. 초기9개 선택 schema 덤프 SHA `cb8389bf1283dea0ab0808f3a95ad90771fa68b99a4866244d1519e930c80593`는 cron extension 범위가 빠질 수 있어 실제 복원에는 사용하지 않았다. pg_dumpall 역할/비밀번호 또는 pg_authid verifier를 사용하지 않았다.

PG17.6 고정 로컬 이미지 digest `28f0e16a019e648089fc1a6d333549a55548f6019c15ae4bd7cd58b989027518`를 사용했다. 기본 이미지 entrypoint를 우회해 supabase_admin으로 명시 initdb를 실행했다. 임시 schema 재현 중 source의 비밀번호 없는 역할 flags32개와 membership26개를 복원했고 source membership exact 비교가 통과했다. 새로운 실행기 LOGIN은 만들지 않았다. shared_preload는 pg_cron·pg_stat_statements만 명시하고 cron.launch_active_jobs=off, DDL 로그 off를 확인했다.

초기 not-found 대소문자 검사 실패는 자원 생성 전이었다. 최초 스키마 복원에서는 public 기본 schema를 제거했으나 pg_dump는 기존 public을 가정해 실패했고 해당 복원 트랜잭션은 롤백됐다. 실제 source의 database owner postgres/public owner pg_database_owner를 읽기 확인한 뒤 새로운 검증 DB의 public을 보존하고 전체 복원을 재실행해 exit0을 확인했다. 역할 복원은 다시 실행하지 않았다. 각 실패 로그·원본 스크립트·정정 결과를 artifact에 보존했다.

## 비교 결과와 남은 불일치

OID를 제외한 이름 기준719개 객체를 비교했다. 함수 정의 해시/owner, schema·function·relation·column/default ACL, 역할 flags·membership을 비교한다. role setting/validUntil/password·database ACL·자료·확장 실행 config는 이 결과의 범위 밖이다. SQL 내부 char 타입·UNION name 식별자 잘림 오류를 바로잡은 뒤 비교했다. ACL 배열 순서는 Python에서 명시적으로 정규화했다.

덤프에서 graphql/graphql_public schema의 원본 USAGE ACL이 누락된 것을 확인하여 새 검증 DB에만 원본의 anon/authenticated/service_role USAGE와 postgres USAGE WITH GRANT OPTION을 동일하게 복원했다. 현재719개 중 함수·owner·모든 검사 대상 ACL·역할·membership 차이0이며, private.worker_jobs의 dedupe_key CHECK는 ((A AND B) AND C)와 (A AND B AND C)의 괄호 결합 형태 차이1개가 남는다. 이를 이유 없이 전체 동일로 표시하지 않는다.

더 중요한 실제 환경 차이를 발견했다. 원본은 datlocprovider=i/ICU, datlocale=en-US, datcollate/datctype=en_US.UTF-8, version153.121이며, 새 initdb 환경은 provider=c/libc이다. 같은 PG17.6와 locale 이름만으로 동일한 정렬·정규식 동작을 보장할 수 없다. 따라서 신규 LOGIN과 40300 적용은 아직 진행하지 않는다. 다음 단계는 이 작업의 새 cluster 안에서 원본 ICU 데이터베이스 구성을 재현하고 스키마/권한·정규식 의미를 다시 확인하는 것이다. 기존 native 데이터베이스 locale은 변경하지 않는다.

현재 stage1 초기화·역할 복원·schema-only 복원은 완료했지만 SOURCE_REPRODUCTION 전체는 미완료다. TLS/전용LOGIN/SET ROLE/3RPC/LISTEN 재접속/최종 자원 정리는 NOT_RUN이다. source61 준비와 native60 hosted 삭제 PASS 증거를 이 접속 검증의 성공으로 재사용하지 않는다.

## ICU 교정과 실제 전용 LOGIN·TLS 후속 결과

이 작업의 새 검증 cluster 안에서만 postgres fixture DB를 template0/ICU en-US로 재생성했다. 기존 native DB는 변경하지 않았다. `icu-restore-receipt.json`에서 실제 provider i/datlocale en-US/collversion153.121와 전체schema-only 재복원 exit0을 확인했다. `corrected-baseline-receipt.json`은 실제 collation version·20개 정규식·원본 DB ACL10개·안전 role 설정11개 일치를 증명한다. 미확인 JWT 설정값·role log/session library 설정은 읽거나 복제하지 않았으며 전체 환경의 모든 설정이 동일하다고 주장하지 않는다.

최초 안전 설정 적용에서는 search_path 목록3개를 하나의문자열로 저장한 문제가 나타났다. agent의 FAIL receipt를 보존하고 새 검증 cluster에서만 set_config→ALTER ROLE SET search_path FROM CURRENT로교정했다. 비교시 역할OID로정렬된배열도 이름기준으로정규화했다. 남은719개객체CHECK괄호차이는동일3개AND피연산자의결합표현만달랐고, 별도41샘플검사에서동일값을확인했다. 이와문자locale분류검증은구분한다.

독립 fixture 컨테이너를 같은 새 볼륨·network none으로 유지하면서 TLS를 활성화했다. 실제 현재 container ID는 `tls-server-receipt.json`에 있으며 초기 stage1의 ID는 교체 전 역사다. host 포트는 게시하지 않았고 내부 loopback TCP만 사용한다. 검증용 CA/server key는 private0600이며2일 유효기간은 이번 fixture 값이다.

40300을 postgres 생성자 경로로 이새cluster에만 COMMIT했고 소유자 persona 회귀 exit0을 확인했다. `queue-group-committed-receipt.json`은NOLOGIN그룹기본검증이며실제LOGIN접속증거와별개다. native영속마이그레이션이력은60개그대로이며독립schema-clone을정식61개마이그레이션배포로표시하지않는다.

`dedicated-login-tls-receipt.json`에서 별도 fixture LOGIN·SCRAM과 실제 TCP/TLSv1.3/verify-full 접속이 PASS했다. 클라이언트는 owner DSN을 사용하지 않고 private0600 pgpass만 사용한다. SET ROLE 전3RPC 거절, SET ROLE 후 SESSION_USER는fixture LOGIN/CURRENT_USER는queue그룹,예약조회·180초점유·동일token재조회만료무연장·해제applied→lease_lost,원문표/private.worker_jobs·service_role전환·budgetRPC42501거절,RESET ROLE후LOGIN복귀를확인했다. 비밀번호원문·verifier·비밀번호hash는결과나로그에저장하지않았다. private pgpass는후속알림/재접속시험용으로유지하며Git에포함하지않는다.

`tls-negative-receipt.json`에서TLS없는접속은pg_hba no encryption거절,틀린CA는SSL암호검증거절,wrong.invalid호스트는호스트명불일치거절이모두exit2로확인됐다. 최초wrong-CA기대문구가certificate verify failed였으나동일issuer DN의틀린키에서실제invalid padding을반환했다. 최초stderr를보존하고실제cryptographic rejection범위로교정했으며성공으로오인하지않았다.

다음은실제전용LOGIN의LISTEN/COMMIT·ROLLBACK알림및끊어진연결의재접속·DB예약재조회다. J runner코드변경/운영LOGIN/외부HTTP dispatch/Railway배포/최종새자원정리는아직NOT_RUN이다. 역할과LOGIN은새검증cluster안에서COMMIT된상태이며cluster전체의영속role생성0이라고설명하지않는다. 원본네이버·native60·운영DB쓰기0을유지했다.
