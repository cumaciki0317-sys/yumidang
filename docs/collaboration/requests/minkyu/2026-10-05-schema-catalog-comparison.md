# 운영 이력 20개와 독립 로컬 baseline의 스키마 catalog 비교

작성자: 민규(`minkyu`) / 확인일: 2026-10-05

## 결과

운영에서 읽기 수집한 catalog의 `migrationVersions` 20개만 새 로컬 Supabase DB에 재현한 뒤, 동일 catalog SQL로 비교했다. 결과는 **`STATIC_MATCH`**다. 정적 14개 분류의 추가·누락·변경 수는 모두 0이며, PostgreSQL 버전·deparse search_path와 비교 대상 cron도 같다.

이 결과는 수집 시점과 catalog 범위의 일치를 증명한다. `semanticAssessment`는 **`NOT_ASSESSED`**다. 최신 정책 SQL의 운영 적용, 사용자 데이터 검증, HTTP/Edge 동작, 실제 cron 완료 처리까지 성공했다는 의미는 아니다. 기존 48개 정책 검증 DB와 운영 20개 이력의 차이를 drift로 판정하지 않았다.

## 원본과 재현 범위

- 기준 저장소: `minkyu/foundation-harness`, HEAD `0b599065d68ad315f2e08cc35b44dc94b9a454a4`.
- 원본 정식 migration 41개에 대한 기존 엄격한 SHA 검사와 이력 검사를 그대로 통과했다. `prepare_remote_baseline.py`가 검증된 원격 버전 20개만 선택했다. 미커밋 최신 SQL과 숫자 사본은 포함하지 않았다.
- 선택 이력은 `20260916080335_create_profiles.sql`부터 `20260917141449_notifications_join_request_index.sql`까지의 원격 20개이며, 정확한 파일·SHA는 비공개 준비 manifest에 기록했다.
- 준비 payload는 SQL 20개, 로컬 전용 config, 준비 manifest뿐이다. 소스 `.env`, 키, 회원 데이터, Edge functions를 복사하지 않았다.
- 운영 DDL·쓰기·사용자 자료 내보내기는 0건이다. 운영에서는 부모 작업자가 제공한 catalog metadata만 읽었다. 함수 본문·정책식·cron 명령 원문은 hash로만 비교했다.

## 격리 환경과 실제 실행

기존 `supabase_db_yumidang-minkyu-naver-live` cluster 안의 별도 DB는 선택 이력의 `pg_cron` 생성과 `cron.database_name` 제약 때문에 원본 20개 DDL을 그대로 재현하기에 적절하지 않다. 별도 운영 Supabase 프로젝트를 만들 필요 없이, 같은 전용 Colima daemon에서 **독립 PostgreSQL 컨테이너**를 생성했다. 기존 cluster의 role·database·volume과 분리된다.

- Docker endpoint: `unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock`.
- 새 project: `yumidang-minkyu-drift`.
- 새 DB container: `supabase_db_yumidang-minkyu-drift`.
- 이미지: `public.ecr.aws/supabase/postgres:17.6.1.165`.
- DB host port: `56532`. config에는 shadow `56530`, API `56531`, Studio `56533`, SMTP `56534`, analytics `56537`, pooler `56539`를 분리했지만 실제 기동은 DB뿐이다.
- 기동 전 동일 project container·volume 부재와 `56530..56539` listener 부재를 확인했다.
- 캐시된 Supabase CLI `2.116.0`으로 아래 명령을 실행했다. stdout/stderr는 비공개 로그에만 저장했다.

```sh
DOCKER_HOST='unix:///Users/minkyu/.colima/yumidang-minkyu/docker.sock' \
  /Users/minkyu/.npm/_npx/ade306d1eb8b9835/node_modules/@supabase/cli-darwin-arm64/bin/supabase \
  start --workdir /private/tmp/yumidang-drift-catalog-44g9wt_e/baseline20 \
  --exclude gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
```

기동 종료 코드 0이며 migration 자동적용 메시지 20개와 DB migration 이력 20개를 확인했다. 선택 SQL의 외부 HTTP·`net`·`dblink`·프로그램 실행 호출은 없었다. 등록된 cron은 새 DB 내부의 `private.complete_due_appointments`만 호출한다. 새 DB 앱 테이블 14개와 `auth.users`, `auth.sessions`, `storage.objects`의 합계 행 수는 0이다. 기존 5개 live 컨테이너와 56221/56222 포트는 그대로 실행 중이다. 기존 인프라 stop/delete/prune 명령은 실행하지 않았다.

## catalog 수집과 엄격 비교

양쪽 모두 `tools/local/remote_schema_catalog.sql`을 사용했다. 로컬에서는 새 DB만 대상으로 `BEGIN READ ONLY` 안에서 실행하고 `ROLLBACK`했다. 비교 도구는 `compare_schema_catalog.py`의 private-file 검사와 JSON 정규화를 그대로 사용했다. 파일 mode `0600`, 부모 directory mode `0700`, 소유자·단일 링크·중복 JSON key·허용 필드 검사를 통과했다.

| 분류 | 로컬 / 운영 수 | 차이 |
| --- | ---: | ---: |
| schemas | 2 / 2 | 0 |
| tables | 14 / 14 | 0 |
| columns | 93 / 93 | 0 |
| indexes | 35 / 35 | 0 |
| constraints | 80 / 80 | 0 |
| policies | 10 / 10 | 0 |
| storagePolicies | 3 / 3 | 0 |
| triggers | 6 / 6 | 0 |
| functions | 46 / 46 | 0 |
| schemaGrants | 10 / 10 | 0 |
| tableGrants | 201 / 201 | 0 |
| columnGrants | 7 / 7 | 0 |
| defaultGrants | 96 / 96 | 0 |
| migrationVersions | 20 / 20 | 0 |

정적 전체 SHA-256은 양쪽 모두 `741cc9fc35eea8cc586f1dd4df17681922ece25e62d309123d68ee02c3e16a59`다. context는 양쪽 `serverVersionNum=170006`, `serverVersion=17.6`, `deparseSearchPath=pg_catalog`다. 운영 화면의 표시 이름과 달리 SQL이 반환한 실제 PostgreSQL 버전은 17.6이다. 비교 대상 cron 1개의 이름·주기·활성 상태·명령 hash도 같다.

## 비공개 실행 증거와 다음 단계

비공개 root: `/private/tmp/yumidang-drift-catalog-44g9wt_e`.

- `remote-catalog.json`: 부모가 수집한 운영 metadata.
- `remote-versions.json`: strict 검증 뒤 추출한 버전 20개.
- `baseline20/remote-baseline-manifest.json`: 준비 원본·선택 파일·SHA 증거. 원래 준비 시점의 `sql_execution=NOT_RUN`, `edge_execution=NOT_RUN`을 보존했다.
- `baseline-start.log`: 별도 DB 기동 및 20개 migration 적용 로그. CLI 출력에 로컬 접속 정보가 포함될 수 있으므로 공유하지 않는다.
- `baseline20-catalog.json`: 새 DB read-only catalog.
- `baseline20-comparison.json`: 실제 비교 결과 `STATIC_MATCH`.

후속 최신 정책 이식 검증은 이 독립 baseline 20개에서 출발해야 한다. 추가 이력의 정확한 적용 묶음과 회귀 테스트를 검토한 뒤 별도 승인 범위에서 진행한다. 운영 최신 migration 적용과 외부 서비스 연결은 아직 실행하지 않았다. 이 작업은 독립 baseline DB를 실행 상태로 남겼으며, 종료·삭제는 후속 작업 계획에 따라 별도로 결정한다.

## 독립 DB 20→50 이식 실행 결과

2026-10-05: 동일한 독립 로컬 프로젝트 `yumidang-minkyu-drift`에서 누락30개를 dry-run으로 정확히 대조하고 공식 CLI `db push --local --skip-vault --yes`를 실행했다. 종료0·적용 메시지30개·최종 이력50개가 일치한다. `migration repair`, seed, linked 또는 운영 db-url은 사용하지 않았다. 이전20개 파일·manifest·catalog·STATIC_MATCH 비교 결과는 역사 증거로 보존했다. 현재 로컬 실행 DB의 상태 표시는 `current50`다.

`current50-upgrade-execution.json`과 `current50-catalog.json`의 SHA-256을 부모가 다시 대조했다. 앱/회원/세션/파일 객체 합계 행0이며 완료 전용 역할은 NOLOGIN, NOINHERIT이고 superuser·createdb·createrole·replication·bypassRLS 권한이 없다. 이 역할 생성은 독립 클러스터 안에서만 수행했다. 원본 네이버 로컬 클러스터와 운영 DB는 변경하지 않았다. 최신 catalog는 테이블48개·함수228개·마이그레이션50개다.

준비 도구는 기존 strict41 검사를 유지하고 명시 검토한9개 SQL 해시만 추가한다. HEAD28/41/full50 허용, 이전48/부분49 및 변조 거절을 포함한15개 검사 PASS다. 준비 manifest의 SQL/Edge NOT_RUN은 그대로 유지하며 실제 SQL 적용은 별도 실행 receipt에 기록했다. native Auth/API·Edge·모바일·운영 실행은 아직 미검증이다.

후속 통합 회귀: 부모가 독립 current50 DB에서 최신9개 SQL 검증을 직접 실행하여 모두 PASS했다. 각 테스트는 합성 자료를 전부 롤백한다. source SHA와 exit code는 private `current50-sql-regressions.json`에 기록했으며 이전 scratch 회귀와 구분한다. Auth/REST/Kong 추가를 위한 backup 보존 stop/start 뒤 history50와 정적 catalog/context 일치가 유지됐다. 운영 서버는 변경하지 않았다.
