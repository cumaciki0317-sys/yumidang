# 2026-10-05 운영 드리프트 읽기 확인과 적용 준비

작업자: 민규(`minkyu`). 대상 프로젝트: `bndguguarijmghnkenvt`. 현재 준비 작업의 운영 SQL 실행·DDL·배포는 **NOT_RUN**이다. 아래 운영 결과는 연결된 Supabase의 `list_migrations`와 `execute_sql`로 읽은 버전·객체·역할·cron 메타데이터만 기록한다. 회원 자료, 채팅·후기 원문, 키, 함수 본문, cron 명령 원문은 조회하지 않았다.

기준은 [정책.md](../../../../정책.md), [출시 결정과 민규 전달 사항](../../../../유미당_출시결정_보류사항_민규전달_20261005.md) 5장이다. 후자는 실제 대상·구조를 먼저 대조하고 적용 목록·영향·복구·검증 결과를 준비한 뒤 운영 변경 범위를 확인하도록 요청했다. 본 문서는 그 준비 자료이며 운영 적용 명령을 실행하라는 승인이 아니다.

## 실제 읽기 확인

| 확인 항목 | 결과 | 증거의 범위 |
|---|---|---|
| 프로젝트 | 연결된 `bndguguarijmghnkenvt` | 프로젝트를 명시한 도구 조회 |
| DB·서버 | `postgres`, `server_version_num=170006` | 사용자 행 없는 서버 메타데이터 |
| 운영 이력 | 20개, `20260916080335`부터 `20260917141449` | 버전·이름 목록. 해당 SQL의 바이트/실제 구조 일치 증거는 아님 |
| 기존 후기 상태 RPC | `get_appointment_review_state(uuid)` 존재 | 최신7일·분쟁 공개 유지 동작은 미검증 |
| 최신 첫 채팅 신청 | `request_service_post(uuid,uuid,text)` 없음 | 정확한 새 시그니처 확인 |
| 확정 제안 | `propose_match(uuid)` 없음 | 정확한 시그니처 확인 |
| 자동 완료 예약 | `list_completion_reservations()`, `execute_completion_reservation(uuid,uuid)` 없음 | 실행기와 DB 연결 미준비 |
| 공용 실행 점유 | `acquire_worker_run(integer,uuid)` 없음 | 실행기 점유 연결 미준비 |
| AI 점유·범위 예약 | 조회한 acquire·탐색 예약·요약 예약 RPC 없음 | 최신 AI 원자 계약 미준비 |
| 신규 테이블 | `private.completion_reservations`, `naver_accounts`, `worker_jobs`, `global_worker_run`, `ai_chat_requests`, `ai_member_processing`, `worker_job_run_fences`, `review_summary_state` 모두 없음 | 객체 존재 여부만 확인 |
| 전용 역할 | `yumidang_completion_runner`, `yumidang_worker_runner` 없음 | 역할 목록에서 위 두 이름 없음. 다른 로그인 계정의 존재/권한은 별도 |
| 기존 자동 완료 cron | `yumidang-auto-complete-appointments`, 매분, `active=true` | 명령 본문이나 실제 처리 성공은 확인하지 않음 |

운영에 최신 테이블이 없다는 결과와 20개 이력은 이번 조회에서 서로 일치하지만, 수동 변경이나 다른 객체의 드리프트까지 없다는 뜻은 아니다. 자동 완료 cron을 먼저 중단하지 않는다. 새로운 실행기의 실제 예약 처리·재접속 복구가 준비된 뒤 전환한다.

## 로컬 이력·준비 도구의 차이

현재 작업 브랜치 HEAD는 `0b59906`이다. 정식 파일명 SQL은48개지만 현재 Git 이력41개와 새 정책 미커밋7개를 구분한다. `event_storage 2.sql` 같은 복사본은 제외한다. 파일48개를 운영 적용48개 또는 커밋된48개라고 설명하지 않는다.

- `tools/local/prepare_migrations.py`는 Git HEAD 바이트·SHA-256·정식 이름·중복 버전/내용·심볼릭 링크를 검사한다. 미커밋 정식 파일은 배제 목록이며 변경된 추적 SQL은 거절한다. 준비 결과의 `sql_execution`은 `NOT_RUN`이다.
- 기존 `prepare_edge.py`의 `validate_reviewed_migration_history`는 검토된41개 해시와 정확한28개/41개 HEAD 집합을 확인한다. 이 검사만으로 새 정책48개가 준비됐다고 주장하지 않는다.
- `prepare_remote_baseline.py`는 정확한 운영20개 버전 입력으로 해당 과거 기준을 재현하는 준비 도구다. 운영 DB에 실제 SQL을 실행하지 않는다. 현재 정책을 그대로 운영에 적용하는 도구가 아니다.
- 이번 하네스의 신규 `prepare_current_policy.py`는 기존41개 검사를 보존하면서 새7개를 포함한 검토48개 바이트를 확인한다. 현재41개 HEAD+7개 대기와 함수 소스43개가 준비 산출물의 해시와 일치했음을 하네스가 확인했다. **SQL·Edge 실행 상태는 둘 다 `NOT_RUN`**이며, 로컬 합성 DB 검사 및 실제 운영 적용과 각각 구분한다.
- `remote_schema_catalog.sql`은 public/private 및 storage 정책·역할·ACL·함수/제약/트리거의 해시·제한된 cron 메타데이터를 반환한다. `compare_schema_catalog.py --local ... --remote ...`는 비공개 catalog JSON의 형식·메타데이터를 비교하며 DB에 접속하거나 SQL을 실행하지 않는다.

현재 신규7개가 아직 커밋되지 않은 동안에는 소스 파일명48개, 검토 준비48개, 운영20개를 각기 기록한다. 검증을 통과시키려고 소유권·hook·과거 검토 해시를 임의 변경하지 않는다.

## 차이28개와 영향 범위

운영20개 버전이 현재 로컬 첫20개와 같다는 목록상 차이는28개다. 아래는 **검토 후보**이며 즉시 일괄 적용 목록이 아니다.

| 후보 순서·영역 | 버전 | 주요 확인 |
|---|---|---|
| 작업·검색·요약·양쪽 완료·코어 | `20260923090000`, `091000`, `092000`, `100000`, `101000`, `102000` | 새 private 객체, 함수 중복 CREATE, 과거 권한 회수, 중간 완료·공개 정책 |
| 검색v2·행사·공개/완료 예약 | `20260929090000`, `100000`, `120000` | 실제 등록 장소/주소 구조, 원 후기·운영 override 보존, 예약 트리거·cron 영향 |
| 네이버·매칭·후기·일정·AI | `20261002090000`, `100000`, `110000`, `120000`, `130000` | 기존 회원 전환, 세션·자격, 정책 교체 전후 반환 권한, 범위 없는 예산 우회 회수 |
| 행사/프로필·나이·연결·순위·사진·대화 | `20261002131000`, `140000`, `150000`, `160000`, `170743`, `174755` | 기존 자료 형식·FK·길이/분류 제약, private 사진과 기존 경로, 관계별 읽기 보존 |
| 완료 전용 권한 | `20261003090000` | 역할 그룹과 실제 LOGIN 분리, 기존 함수 없으면 적용 실패 |
| 최신 완료·확정·공용 점유·검색 | `20261005001429`, `20261005001456`, `20261005001538` | 한쪽 작성 마감 공개, 기존 공개 유지,6시간 만료, 공용 실행 점유, 최신16분류/숫자 조건 |
| 첫 채팅·AI·작업/요약 fence | `20261005002006`, `20261005002528`, `20261005003000`, `20261005003159` | 메시지 원자 신청, 동의/개인20회/예산, 전역·작업 점유 매핑, 과거 RPC 권한 회수 |

표의 같은 날짜 안 축약 버전은 날짜 접두사를 유지한다. 정확한 파일 목록은 검토48개 manifest를 사용한다. 특히 기존 중간 마이그레이션에는 한쪽24시간 공개·확정 요청24시간 등 최신 정책과 다른 함수가 있으므로, 버전 순서만 확인해 중간 상태로 서비스를 재개하지 않는다. 새 정책7개까지 적용한 최종 상태로 검사해야 한다.

## 적용 전에 필요한 증거와 처리 순서

1. **대상과 배포 소스 고정:** 운영 프로젝트 ID, 브랜치·정확한 커밋, 변경 파일48개 해시를 고정한다. 미커밋7개는 검토·커밋 후 manifest를 재생성한다. 비밀번호나 연결 주소는 채팅·공유 문서에 기록하지 않는다.
2. **이력과 구조 분리 비교:** 운영20개 버전 목록을 비공개 입력으로 보관하고20개 과거 기준의 격리 DB를 재현한다. 그 catalog와 운영 catalog를 비교한다. 서버 버전/deparse 차이, 역할·ACL, 실제 앱 구조, cron 차이를 분리한다. 이번 존재 조회만으로 전체 catalog 일치를 주장하지 않는다.
3. **드리프트 객체별 결정:** 이력에 없는 객체가 이미 존재하면 `CREATE TABLE/FUNCTION/TYPE` 충돌을 확인한다. 존재가 같아도 컬럼·제약·본문 해시·권한이 다르면 같은 적용으로 보지 않는다. `IF NOT EXISTS`로 차이를 숨기거나 이력만 applied로 덮어쓰지 않는다. 객체·원인·정확한 조정 SQL을 신규 검토 마이그레이션으로 준비한다.
4. **자료 보존·제약 사전 검사:** 원 회원·공고·신청·후기·운영 override·예약/동의 이력을 보존한다. 기존12분류와 새16분류, 공고 제목/지점 길이, 행사 정규화, 사진 경로·참조, 중복 신청·세션·FK를 확인한다. 실제 회원 값이나 원문을 내보내지 않고 필요 시 조건별 수량만 승인된 검사로 집계한다. 기존 회원 네이버 전환에 필요한 안내와 기존 약속 관리 유지도 준비한다.
5. **운영 변경 묶음 검증:** 최종48개 상태로 격리 재현·실제 JWT/RPC·동시성·후기/분쟁·사진 반환·쿼터/예산/철회·과거 함수 우회 차단을 검사한다. 각 마이그레이션이 독립 트랜잭션이라 중간 상태가 노출될 수 있고, 기존 매분 cron이 작동 중임을 고려한다. 필요한 배포 잠금·요청 차단·배치 원자 적용 방식은 별도 설계·검증하고 운영에서 임의로 cron을 꺼 해결하지 않는다.
6. **복구 준비와 운영 범위 확인:** 적용 순서·예상 잠금/영향·검증 SQL·실패 중단 지점·복구 계획을 완성해 전달 문서의 운영 변경 범위를 확인한다. 스냅샷/백업의 실제 생성·복원 가능성, 이전 함수/권한 메타데이터, 배포된 서버와 DB의 호환 관계를 확인한다. 역순 DROP나 기존 DB 초기화를 복구 전략으로 사용하지 않는다. 자료 변환 후 복구는 검토된 보정 마이그레이션 또는 확인된 백업 복원을 구분한다.
7. **전용 계정·호스트 연결:** 완료 권한 그룹과 실제 LOGIN 계정은 별개다. LOGIN의 super/createRole/createDb/bypassRls와 PUBLIC·상속 권한을 검사하고 예약 조회/실행만 허용한다. 작업 실행기는 다른 전용 계정·fence 권한을 사용한다. Direct 또는 Session pooler로 실제 연결하고 Transaction pooler는 사용하지 않는다. 재접속5초·쿼리 제한10초는 확정 설정값이며 연결 성공 증거가 아니다.
8. **실행·복구·전환 확인:** 새 완료 실행기의 `COMPLETION_SCHEDULER_READY`, 승인된 실제 기한 도래 건 처리, 재시작·재접속 누락 복구, 중복 실행 방지를 확인한다. 그 뒤 기존 cron과 새 실행기의 전환을 검증한다. Running 상태나 배포 버튼 성공만으로 완료 처리하지 않는다. 운영 전용 계정·URL·호스트·cron 전환은 모두 아직 미검증이다.
9. **후속 상태 기록:** 실제 적용 버전, 최종 catalog/ACL, 배포 커밋, 연결 방식, 처리·복구·전환 결과를 비밀값 없이 기록한다. 자동 완료 배포를 행사·AI·모바일 배포 완료로 확대하지 않는다. AI 외부 전송 가드는 법적·공급사·사용자 승인 확인 전 false로 유지한다.

[Supabase 공식 마이그레이션 안내](https://supabase.com/docs/guides/deployment/database-migrations)는 직접 원격 구조 변경이 이력 불일치를 만들 수 있고, 한 명이 배포를 담당하도록 설명한다. 따라서 이번 차이는 자료와 구조를 대조한 검토 마이그레이션으로 정리하며, `db push` 또는 `migration repair`를 확인 없이 실행하지 않는다.

## 재확인용 읽기 SQL

아래는 사용자 자료를 반환하지 않는다. 이력·객체·역할·cron은 존재 및 메타데이터만 읽는다. 역할 비밀번호·함수본문·cron command는 조회하지 않는다.

```sql
select version,name from supabase_migrations.schema_migrations order by version;
select x.signature,to_regprocedure(x.signature) is not null as present
from (values
 ('public.request_service_post(uuid,uuid,text)'),
 ('public.list_completion_reservations()'),
 ('public.execute_completion_reservation(uuid,uuid)'),
 ('public.acquire_worker_run(integer,uuid)'),
 ('public.acquire_ai_chat_request(uuid,uuid,text,uuid,text)')
) x(signature);
select rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls
from pg_roles where rolname in('yumidang_completion_runner','yumidang_worker_runner');
select jobname,schedule,active from cron.job
where jobname='yumidang-auto-complete-appointments';
```

전체 스키마 비교에는 위의 존재 SQL을 대체물로 쓰지 않고 `tools/local/remote_schema_catalog.sql`과 비공개 JSON 비교를 사용한다. 현재 단계에서 전체 운영 catalog 캡처/비교·자료 제약 집계·운영 적용과 배포는 수행하지 않았다.

## 후속 읽기 수집

`remote_schema_catalog.sql`을 운영에 읽기 실행해 앱테이블14개·함수46개의 정규화 metadata를 수집했다. 사용자 행·함수본문·정책식·cron 명령원문은 반환하지 않았다. catalog는 비공개 임시0700폴더/0600파일에 보관했다. 현재48개 scratch와 차이를 운영 드리프트라고 부르지 않으며, 같은 과거20개 이력의 격리 기준 재현·parse·비교가 다음 단계다. 이 수집은 운영 구조 일치·SQL 적용 완료 증거가 아니다.

## 최신 후속 상태

이 문서 초기 검토48개 이후 명시 모집 재개05459와 회원 차단05855 두 검토 SQL이 추가되어 현재 HEAD41개+미커밋9개=50개다. 운영 이력20개와의 적용 후보 차이는30개다. 새2개는 취소 약속 부분 unique·취소 일정 snapshot·신청 복원·양방향 차단·기존 약속 관리·legacy 작성자RPC 익명 접근 제한을 포함한다. 현재 scratch 통합 SQL9파일 PASS며 역할41의 전체 배포 검증은 별도다. 검토50개 준비 도구 갱신 후 실제 준비와20→50 순차 이식을 독립 빈 DB에서 확인할 예정이다.

[동일 과거20개 catalog 비교](2026-10-05-schema-catalog-comparison.md)는 실제 독립 재현 뒤 STATIC_MATCH를 확인했다. 정적14분류·서버context·cron의차이는0이나 업무 의미와 실제 자료 적합성은 별도 미검증이다. 앞선 초기48개/차이28개 목록은 당시 검토 기록이며 현재 최종 운영 적용 수로 재사용하지 않는다.

## 독립 DB 20→50 이식 실행 결과

2026-10-05: 동일한 독립 로컬 프로젝트 `yumidang-minkyu-drift`에서 누락30개를 dry-run으로 정확히 대조하고 공식 CLI `db push --local --skip-vault --yes`를 실행했다. 종료0·적용 메시지30개·최종 이력50개가 일치한다. `migration repair`, seed, linked 또는 운영 db-url은 사용하지 않았다. 이전20개 파일·manifest·catalog·STATIC_MATCH 비교 결과는 역사 증거로 보존했다. 현재 로컬 실행 DB의 상태 표시는 `current50`다.

`current50-upgrade-execution.json`과 `current50-catalog.json`의 SHA-256을 부모가 다시 대조했다. 앱/회원/세션/파일 객체 합계 행0이며 완료 전용 역할은 NOLOGIN, NOINHERIT이고 superuser·createdb·createrole·replication·bypassRLS 권한이 없다. 이 역할 생성은 독립 클러스터 안에서만 수행했다. 원본 네이버 로컬 클러스터와 운영 DB는 변경하지 않았다. 최신 catalog는 테이블48개·함수228개·마이그레이션50개다.

준비 도구는 기존 strict41 검사를 유지하고 명시 검토한9개 SQL 해시만 추가한다. HEAD28/41/full50 허용, 이전48/부분49 및 변조 거절을 포함한15개 검사 PASS다. 준비 manifest의 SQL/Edge NOT_RUN은 그대로 유지하며 실제 SQL 적용은 별도 실행 receipt에 기록했다. native Auth/API·Edge·모바일·운영 실행은 아직 미검증이다.
