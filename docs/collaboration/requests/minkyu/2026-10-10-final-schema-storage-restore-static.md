# 소스112 기반 전체 DB·역할·Storage 복원 분기 정적 준비

- 작업자: 민규(`minkyu`), eventlane 별도 worktree.
- 관리 진행률: 기존 운영 7단계 기준 **68% 유지**. 이 문서는 운영 완료나 실행 승인을 추가하지 않는다.
- 수정 제품: 기존 `tests/integration/minkyu/product_connection_restore108_local.py`의 명시적 `--final-storage` 분기만 추가했다. 기존 SQL108 함수 10개는 AST 비교로 동일하다.
- 현재 결과: 정적 검사와 모형 경계 검사 PASS, 실제 최종 복원 **NOT_RUN**, Docker 기동 0.

## 이번 분기의 정확한 범위

`SOURCE112_PLUS_EXPLICIT_114_115_116_117_118_119_DB_ROLES_STORAGE`이다. 보호 소스112의 186개 테이블과 실제 Storage103 파일을 새 복제본에 복원한 뒤, 다음 여섯 파일만 순서대로 적용한다. 닫힌 source bundle이 검토한 118개 SQL 전체 이력을 실제로 재구성했다고 주장하지 않는다.

1. `20261009011400_worker_intent_confirmation.sql`
2. `20261009011500_member_cleanup_reconcile.sql`
3. `20261009011600_content_inspection_tickets.sql`
4. `20261009011700_member_retirement_receipt.sql`
5. `20261009024414_member_cleanup_unknown_discovery.sql`
6. `20261009031628_event_detail_projection.sql`

Storage103의 설정된 DB는 기존 `queue_tls_environment.NAME`이다. 정확한 컨테이너 ID·소유자와 DATABASE_URL host를 대조하고, 이 DB와 소스112의 모든 `storage.*` 테이블 해시가 같아야 시작한다. 알려진 자료에는 객체 메타데이터 45행과 실제 파일 6개가 있다. 각 실제 파일의 tenant/bucket/name/version 관계를 확인하고, 메타데이터에만 있는 항목은 기존 상태 그대로 보존한다. 이 분기는 존재하지 않는 원본 파일을 복원했다고 집계하지 않는다.

소스112·기존 Storage DB·Storage103에는 STOP, restart, SQL 쓰기, 파일 쓰기를 하지 않는다. 닫힌 제어·기한/점유 상태, 활성 DB 연결 0, dump/tar 전후 전체 행·카탈로그·역할·membership grantor·sequence `last_value/is_called`·파일 해시가 같아야 복제본을 만든다. 새로운 117 generated fingerprint 열은 명시적으로 그 열만 제외하여 기존 행 보존을 확인한다.

새 복제본의 전체 최종 DB와 실제 파일을 백업한다. 새 합성 파일 한 건의 Storage API DELETE 성공·GET 부재·메타데이터 부재·파일 부재를 모두 저장한 뒤, 오래된 백업에서 그 파일이 살아나는 것과 저장된 성공 목록만으로 재파기되는 것을 확인한다. 원 제품 task/DELETE/ACK의 성공 증거는 **NOT_RUN**이고, 직접 새 합성 파일을 삭제하는 검증이다. 기존 UNKNOWN·ACK·dispatch·task 행은 전체 비교로 보존하며 미확정 삭제를 재전송하지 않는다.

복제본만 백업 중 Storage를 STOP/restart한다. 동시에 실행하는 DB+Storage 쌍은 최대 하나다. 첫 쌍을 닫고 STOP한 뒤 두 번째 쌍을 만든다. 새 DB/Storage 각각 512MiB, Storage heap128MiB, cron off, no-healthcheck, no published port, 새 internal subnet, DB verify-full TLS를 사용한다. 첫 DB 전 MemAvailable 1024MiB, 이미 DB가 있는 Storage 기동 전 768MiB를 실제 읽어 검사한다. cached image만 사용하며 pull/prune/remove하지 않는다. 실패 환경·백업·UNKNOWN은 보존하고 정확한 자기 ID/labels/run_id의 컨테이너만 finally에서 닫고 STOP한다.

## 정적 검사

- 소유권, Python AST/compile, 한국어 외 문자 혼입, 기존 10개 함수 AST 동일: PASS.
- 고정 SQL 6개 및 helper/tool 3개 SHA: foundation 읽기 대조 PASS.
- private600/700, symlink/hardlink 거절, 축소/잘못된 graph 거절, unsafe tar 거절 7건: PASS.
- 활성 연결이 있는 경우와 Storage 메타데이터가 다른 경우: 모형 2건 모두 복제본 생성 0·소스 SQL 쓰기 0. 실제 Docker/DB 증거로 승격하지 않는다.
- 전체 실제 source 관계·quiescence·복원·TLS·DELETE·재파기: NOT_RUN.

## root 동결 graph와 실행 단계

graph는 private `/private/tmp` 폴더700 안의 단일 파일600이며 symlink/hardlink를 허용하지 않는다. 정확한 key는 `version`, `kind`, `approvedByRoot`, `dockerSlotReady`, `repo`, `files`, `closedArtifact`, `closedBindingSha256`, `closedReceiptSha256`, `sourceIds`, `sourceSnapshotSha256`, `sourceStorageFilesSha256`이다. version1/kind `FINAL_DB_STORAGE_RESTORE`를 사용한다. 승인/슬롯 필드는 root가 실제 조율한 새 graph에서만 true로 설정한다.

`files`는 아래 정확한 16개 경로와 현재 바이트 SHA이다. SQL6·고정 helper/tool3은 코드의 고정 SHA와도 일치해야 한다.

```text
backend/supabase/migrations/20261009011400_worker_intent_confirmation.sql
backend/supabase/migrations/20261009011500_member_cleanup_reconcile.sql
backend/supabase/migrations/20261009011600_content_inspection_tickets.sql
backend/supabase/migrations/20261009011700_member_retirement_receipt.sql
backend/supabase/migrations/20261009024414_member_cleanup_unknown_discovery.sql
backend/supabase/migrations/20261009031628_event_detail_projection.sql
tests/integration/minkyu/member_cleanup_reconcile_local.py
tests/integration/minkyu/queue_tls_environment.py
tests/integration/minkyu/product_connection_restore108_local.py
tools/local/prepare_production_backend.py
tools/local/prepare_current_policy.py
tools/local/prepare_edge.py
tools/local/prepare_database.py
tools/local/prepare_migrations.py
tools/local/compare_schema_catalog.py
tools/local/check_api_env.py
```

`sourceIds`는 세 보호 컨테이너의 실제 ID를 정확히 담는다. `sourceSnapshotSha256`는 고정 helper의 `normalized_snapshot(source112)` 값, `sourceStorageFilesSha256`는 모든 실제 tar 파일의 `safe_storage_files` 값에 대한 canonical JSON SHA다. canonical은 sort_keys=true, separators=(',',':'), ensure_ascii=false이다. sequence 원본 값은 별도 private 자료에 저장·비교하므로 기존 helper snapshot SHA 형식은 바꾸지 않는다.

닫힌 source bundle에는 외부 expected binding SHA와 receipt SHA를 모두 입력한다. verifier, 현재 제품 source SHA, 검토된 6개 SQL SHA를 다시 확인한다. 최종 receipt는 제품/binding/전체 migration manifest/실제 적용 6개 SQL/덤프/역할/파일 archive/sequence/알려진 성공 목록 SHA를 묶는다. receipt만으로 bundle의 activationAllowed=false나 실제 공급사 미승인 상태를 바꾸지 않는다.

foundation의 통합된 파일에서 기본 계획만 확인한 뒤, root의 새 graph·슬롯 승인 후 새 revision 한 번만 실행한다.

```sh
python3 -B tests/integration/minkyu/product_connection_restore108_local.py --final-storage
python3 -B tests/integration/minkyu/product_connection_restore108_local.py --final-storage --run --revision final-v1 --graph-manifest <root가 동결한 private600 graph>
```

## 검토된 SQL118개 전체 스키마 복원의 후속 조건

현재 닫힌 bundle의 `reviewedMigrations`는 118개 파일 SHA를 보유한다. 소스112 marker와 186개 테이블만으로 그중 선행 112개가 모두 정확히 적용됐다는 이력을 증명하지 못한다. 이번 subset 복원 PASS도 그 공백을 없애지 않는다.

root의 읽기 확인에 따르면 `event_invocation_audit_local.py`는 member110을 source로 SQL111과 SQL112를 적용하고, `member_cleanup_invocation_local.py`는 source109의 SQL109를 확인한 뒤 SQL110을 적용한다. `worker_invocation_audit_local.py`와 기존 `product_connection_restore108_local.py`를 거쳐 초기 queue_tls99 chain으로 이어진다. 이 연결은 후속 적용의 근거이나, 초기99의 전체 migration receipt는 아직 확인되지 않았다. 초기99까지의 모든 바이트·적용 이력이 입증되지 않으면 전118 새 구성 fallback을 우선한다.

추가 읽기 감사에서 초기 `release88-http-isolated/supabase/migrations`의 88개 파일은 현재 bundle의 해당 SHA와 모두 같았다. source112 전체 snapshot에 저장된 앱 `supabase_migrations.schema_migrations`도 88행이다. 이는 후속 SQL의 수동 적용을 부정하는 결과가 아니라, 복사 파일·앱 이력 테이블·개별 수동 적용 receipt를 연결해야 한다는 근거다. `auth.schema_migrations` 77행과 `storage.migrations` 63행은 플랫폼 이력이며 앱 118개에 합산하지 않는다.

1. 민규가 기존 source112 생성·상위 source109/110/111/112 receipt 및 dump SHA를 읽어, 검토 118개 중 이미 포함된 정확한 파일 목록과 플랫폼 Auth/Storage 초기 스키마·역할의 출처를 명세한다. DB marker로 이력을 추정하거나 적용된 migration을 재실행하지 않는다.
2. 이미 포함됐음을 입증하지 못한 SQL이 있으면 새 격리 DB에서 검토된 플랫폼 baseline과 전 118개 파일을 정확한 순서/바이트로 한 번씩 구성한다. 기존 `prepare_database.py`/`prepare_migrations.py` 산출물과 새 적용 receipt를 사용한다. source112/Storage103는 읽기만 하며 소스 이력을 보정하지 않는다.
3. 새 구성의 전체 스키마·owner·ACL·grantor·제약/트리거/함수·비시스템 테이블·sequence를 검토된 최종 catalog와 대조한다. 데이터 이관은 정확한 source 관계·대상 스키마 호환·117 generated 열 같은 승인된 변환만 명시한다. 임의 catalog 예외나 기존 pending/UNKNOWN 삭제를 허용하지 않는다.
4. 이렇게 입증한 최종 DB+대응 실제 Storage 전체 파일에서 이번 기존 driver를 재사용해 별도 명시 분기의 백업/새 복원/known-success 재파기/UNKNOWN 보존/자기 환경 STOP 증거를 얻는다. 전체 파일 바이트가 처음부터 없었던 항목은 별도 baseline 한계로 유지한다.
5. 그 전체 스키마·제품·bundle·백업 증거를 동일한 최종 동결 graph로 연결한 뒤에만 전체 백업 완료 판정을 요청한다. 운영 배포·실제 공급사/회원·공개 지원 담당 실접수·최종 역할 적용은 기존 7단계의 별도 완료 조건으로 남는다.

현재 이 후속 구성·운영 적용은 실행하지 않았다. 임의 공급사 선택, 실제 로그인, 외부 연락, 소스 수정, 운영 활성화 승인으로 해석하지 않는다.

## 전118 새 구성의 최소 후속 작업 단위

별도 비슷한 백엔드 폴더나 두 번째 복원 driver를 만들지 않는다. 구현이 승인되면 기존 M `tests/integration/minkyu/product_connection_restore108_local.py`에 명시적 전118 새 구성 분기를 추가하고, 기존 두 분기는 보존한다. 다음 표는 필요한 승인·산출물·완료 조건이며 현재 실행 승인으로 해석하지 않는다.

| 순서 | 기존 M 위치·재사용 | 산출물과 완료 조건 |
| --- | --- | --- |
| 1. 검토118 입력 동결 | `tools/local/prepare_current_policy.py`, `tools/local/prepare_production_backend.py`, 기존 복원 driver | 검토된 118개 경로/바이트/정렬 순서, config, 제품/bundle SHA를 하나의 새 graph로 묶는다. `prepare_database.py`/`prepare_migrations.py`는 HEAD-only이므로 현재 미커밋 후속 SQL을 전체118 준비물로 취급하지 않는다. `prepare_current_policy`의 canonical/pending manifest가 필요하다. Git 커밋이나 소유 정책 변경으로 검사를 우회하지 않는다. |
| 2. 플랫폼 baseline 확인 | cached `supabase/postgres:17.6.1.165`, `gotrue:v2.196.0`, `storage-api:v1.70.3`; 기존 `member_cleanup_reconcile_http_local.py`의 이미지·TLS·메모리·닫힌 환경 계약 읽기 재사용 | 플랫폼 초기 스키마/역할과 해당 immutable image ID·초기화 SQL 출처를 먼저 동결한다. 현재 clone용 `initdb`만으로는 Auth/Storage가 만들어지지 않는다. 앱이 포함된 source112의 auth/storage schema를 아무 검토 없이 깨끗한 플랫폼 baseline으로 선언하지 않는다. cached image의 초기화 자료 및 공식 서비스의 자체 플랫폼 migration 경계가 확인되지 않으면 failclosed다. |
| 3. 새 플랫폼만 구성 | 기존 복원 driver의 자기 ID/labels/run_id, internal network, memory preflight, finally STOP | 원 소스가 아닌 새 빈 DB에서 동결한 플랫폼 초기화만 수행한다. 필요한 경우 새 Auth→STOP→새 Storage→STOP 순으로 플랫폼 migration만 완료해 동시에 실행하는 서비스 수를 줄인다. 기존 실제 검사에서 쓰는 DB512MiB/Auth128MiB/Storage512MiB·heap128MiB와 단계별 실제 MemAvailable 기준을 검토해 사용한다. 메일/SMS/공급사/가입/DELETE/ACK/외부 모델 호출은 하지 않는다. 초기화가 제삼자 코드의 네트워크나 자동 migration을 추가하면 새 동결 검토 전 멈춘다. |
| 4. 앱118 단일 순서 적용 | 기존 복원 driver, `prepare_current_policy`의 canonical SQL inventory | 첫 SQL은 `auth.users`, `auth.uid()`와 anon/authenticated 역할을 필요로 한다. 초기 사진 SQL은 `storage.buckets/objects`, owner_id·Storage 정책을 필요로 한다. extensions/pg_cron 등 기존 SQL 의존을 먼저 검사한다. 플랫폼 baseline에 앱 profiles/worker/event/reconcile 제어가 없어야 첫 적용을 시작한다. 앱 SQL의 current role은 검토 catalog가 요구하는 원 appowner 이름/권한으로 고정해야 한다. BOOT로 모든 CREATE를 실행해 SECURITY DEFINER owner를 더 강한 역할로 바꾸거나 임의 ALTER OWNER로 결과를 보정하지 않는다. 번호가 아닌 14자리 canonical 파일 정렬 순서로 각 SQL을 한 번만 적용하고 intent/success SHA를 남긴다. unknown apply는 같은 DB 재시도 없이 보존한다. |
| 5. 최종 스키마·자료 이관 판정 | `tools/local/compare_schema_catalog.py`, 고정 `member_cleanup_reconcile_local.py` snapshot, 기존 복원 driver | owner·ACL·grantor·제약·RLS·trigger·함수·정규화된 dump·sequence를 명시한 범위로 비교한다. 기존 source112 행의 이관은 최종 스키마와 정확히 호환되는 테이블/열/생성 열의 검토 목록이 있어야 한다. source112 전체 dump를 새118 DB 위에 덮어써서 새 구성 증거를 없애지 않는다. 미확인 rawACL 표현 차이는 범위로 명시하고 원 소스나 UNKNOWN을 고치지 않는다. |
| 6. 전체 복원·파기 재적용 | 기존 복원 driver의 알려진 성공 목록 분기 | 위에서 입증한 최종 DB·대응 Storage 실제 전체 파일을 백업하고 새 두 번째 복제본으로 역할/자료/sequence/파일을 복원한다. 알려진 성공만 재파기하고 기존 UNKNOWN은 보존한다. 원 제품 task/ACK 검증은 직접 Storage 파일 fixture와 별도로 판정한다. 보호 소스 불변, 자기 guard 닫힘·정확 ID STOP, OOM 없음이 receipt의 필수 조건이다. |

플랫폼 초기화의 깨끗한 baseline·역할/ACL·최종 catalog의 expected 입력은 아직 새 실행으로 입증되지 않았다. 위 순서를 완수하기 전에는 전체118 스키마 복원 PASS나 운영 백업 완료라고 표시하지 않는다. 공개 지원 담당 실접수와 실제 공급사·배포·운영 권한은 기존 7단계에 남는다.

## 추가 peer 검토와 수집 준비

peer는 새 복원 분기에서 확정 안전 결함을 찾지 못했고, 원 BOOT 속성은 CREATE만 제외하고 ALTER를 보존하는 편이 정확하다고 지적했다. root 승인으로 그 한 줄만 보완했으며 legacy 10함수는 그대로다. 모형에서는 원 ALTER·25개 membership GRANTED BY가 모두 보존된다. source 역할에는 쓰지 않았다.

최신 foundation16-file 비승인 metadata는 `/private/tmp/yumidang-final-restore-static-20261010-v2/graph-metadata-not-approved.json`이고, helper canonical snapshot 수집 명령은 같은 폴더의 `readonly-collection-command.txt`다. 모두 private700/600이며 수집 명령은 AST/compile만 검사하고 실행하지 않았다. `closedBindingSha256`는 manifest 파일 자체 해시가 아니라 canonical binding 해시 `72c6a0a...`다. metadata의 source ID/hash는 아직 미수집이며 두 승인 플래그는 false다. 수집 명령도 source 읽기와 private 자료 생성만 수행하고 승인 플래그는 false로 유지한다. root가 실제 슬롯·소스 읽기를 배정한 다음, root의 별도 검토로 최종 승인 graph를 동결해야 실행할 수 있다.

## 공식 upstream 플랫폼 초기화 조사

2026-10-10 공개 read-only 조회로 다음 경로를 확인했다. 태그의 공식 소스 commit과 로컬 cached image의 실제 바이트가 같다는 검증은 아직 `NOT_VERIFIED`다. 이 조회는 pull/build/start나 초기화 실행을 포함하지 않는다.

| 플랫폼 | 공식 소스 기준 | 확인한 초기화 경계 |
| --- | --- | --- |
| Postgres `17.6.1.165` | [공식 release commit `73119f8bfae2bfb07ddfa18240ab8e5f56f737a8`](https://github.com/supabase/postgres/commit/73119f8bfae2bfb07ddfa18240ab8e5f56f737a8) | [Dockerfile-17](https://raw.githubusercontent.com/supabase/postgres/17.6.1.165/Dockerfile-17)은 `migrations/db`를 `/docker-entrypoint-initdb.d/`로 복사하고 pgbouncer `init-scripts/00-schema.sql`, stat extension `migrations/00-extension.sql`을 추가한다. 실제 cached image가 이 Dockerfile로 만들어졌는지는 아직 미검증이다. |
| Auth `v2.196.0` | [공식 release commit `0204331ca41a5b49f076b6fa3dc6c0d20b996590`](https://github.com/supabase/auth/commit/0204331ca41a5b49f076b6fa3dc6c0d20b996590) | [Dockerfile](https://raw.githubusercontent.com/supabase/auth/v2.196.0/Dockerfile)은 `/usr/local/etc/auth/migrations/`와 auth 바이너리를 넣는다. 그러나 [main.go](https://raw.githubusercontent.com/supabase/auth/v2.196.0/main.go)의 embedded migrations를 [migrate_cmd.go](https://raw.githubusercontent.com/supabase/auth/v2.196.0/cmd/migrate_cmd.go)가 실제 사용하므로 파일 디렉터리 SHA만으로 실행 SQL을 증명하지 못한다. |
| Storage `v1.70.3` | [공식 release commit `288dd95c4c06f3df72a2369ea5196a8e400aeed7`](https://github.com/supabase/storage/commit/288dd95c4c06f3df72a2369ea5196a8e400aeed7) | [Dockerfile](https://raw.githubusercontent.com/supabase/storage/v1.70.3/Dockerfile)은 `/app/migrations`와 `/app/dist`를 넣는다. [tenant inventory](https://github.com/supabase/storage/tree/v1.70.3/migrations/tenant)는 `0001-initialmigration.sql`부터 `0062-object-versioning-core.sql`까지 보인다. 이는 공식 소스 목록이며 실제 이미지 목록·적용 이력의 검증은 별도다. |

Postgres의 [init-scripts 목록](https://github.com/supabase/postgres/tree/73119f8bfae2bfb07ddfa18240ab8e5f56f737a8/migrations/db/init-scripts)은 다음 네 파일이다. 추가 `migrations/*.sql` 전체 목록과 실제 이미지 내 추가 파일은 다음 수집에서 확인해야 한다.

```text
00000000000000-initial-schema.sql
00000000000001-auth-schema.sql
00000000000002-storage-schema.sql
00000000000003-post-setup.sql
```

[migrate.sh](https://github.com/supabase/postgres/blob/73119f8bfae2bfb07ddfa18240ab8e5f56f737a8/migrations/db/migrate.sh)는 postgres 역할을 준비하고 init-scripts는 postgres, 후속 플랫폼 migrations는 supabase_admin으로 실행한다. USE_DBMATE 분기와 `/etc/postgresql.schema.sql` 후처리도 있으므로 네 SQL만 가져와 플랫폼 전체 baseline이라고 표시할 수 없다. 이 역할 순서는 플랫폼 자료이며 앱118의 원 owner를 바꾸는 근거가 아니다.

[initial-schema](https://raw.githubusercontent.com/supabase/postgres/73119f8bfae2bfb07ddfa18240ab8e5f56f737a8/migrations/db/init-scripts/00000000000000-initial-schema.sql)는 anon/authenticated/service_role/authenticator와 extensions/default grants를 만든다. [auth-schema](https://raw.githubusercontent.com/supabase/postgres/73119f8bfae2bfb07ddfa18240ab8e5f56f737a8/migrations/db/init-scripts/00000000000001-auth-schema.sql)는 auth 초기 테이블·함수, 초기 migration version 7개, supabase_auth_admin owner를 만든다. [storage-schema](https://raw.githubusercontent.com/supabase/postgres/17.6.1.165/migrations/db/init-scripts/00000000000002-storage-schema.sql)는 storage 스키마·supabase_storage_admin·기본 권한을 준비한다. 테이블 owner_id 같은 최신 Storage 상태는 서비스 후속 migration이 필요하다. [post-setup](https://raw.githubusercontent.com/supabase/postgres/73119f8bfae2bfb07ddfa18240ab8e5f56f737a8/migrations/db/init-scripts/00000000000003-post-setup.sql)의 pg_cron/pg_net event trigger도 결과 catalog에 포함해야 한다.

Auth 기본 명령은 [root_cmd.go](https://raw.githubusercontent.com/supabase/auth/v2.196.0/cmd/root_cmd.go)에서 migrate 후 serve를 실행한다. 플랫폼만 구성할 때는 실제 cached 바이너리의 지원 명령·namespace/DB/TLS 설정을 검토하고 명시적 migrate-only를 사용해 불필요한 HTTP·background worker 기동을 줄이는 후보로 둔다. 바이너리 SHA는 실제 사용 바이트의 근거이며 embedded source/build provenance는 별도 검증 항목이다. commit label 부재만으로 런타임 baseline 구성을 막지 않는다. `00_init_auth_schema.up.sql`은 namespace template이므로 임의 문자열 치환해 독자 runner로 실행하지 않는다.

Storage [server 시작 경로](https://raw.githubusercontent.com/supabase/storage/288dd95c4c06f3df72a2369ea5196a8e400aeed7/src/start/server.ts)는 single-tenant migration 외 queue·pubsub·HTTP 시작도 포함한다. [migration runner](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/internal/database/migrations/migrate.ts)는 schema/role 설정·access method 변환·추적 hash를 반영한다. 따라서 SQL 파일 수동 연결만으로 원 runner와 같다고 판단하지 않는다. [config](https://raw.githubusercontent.com/supabase/storage/v1.70.3/src/config.ts)의 `DB_INSTALL_ROLES`, `DB_SUPER_USER`, `DB_ANON_ROLE`, `DB_AUTHENTICATED_ROLE`, `DB_SERVICE_ROLE`, `DB_MIGRATIONS_FREEZE_AT`, `DB_ALLOW_MIGRATION_REFRESH`를 명시해 기록해야 한다. hash mismatch를 이력 변경으로 덮지 않도록 `DB_ALLOW_MIGRATION_REFRESH=false`를 새 baseline 후보 설정에 포함한다. vector/analytics/queue/multitenant 분기는 필요 없는 경우 닫혀 있음을 실제 설정으로 확인하며 임의 추가 DB를 만들지 않는다.

## 다음 플랫폼 baseline 증거 단위

현재 제품 driver `3c954b6...`와 비승인16경로 수집 초안은 그대로 동결했다. 다음은 별도 구현 배정 후 기존 M driver/준비 도구에 연결할 최소 단위다.

1. 캐시에 이미 있는 정확한 PG/Auth/Storage image ID, OS/architecture, RepoDigests와 OCI source/revision label을 read-only로 수집한다. tag·registry manifest digest·Docker config image ID를 같은 종류의 해시로 취급하지 않는다. commit label이 없으면 `sourceCommitBinding=NOT_VERIFIED`로 유지한다. 운영·보호 source 컨테이너는 수정하거나 STOP하지 않는다.
2. 실행 없는 이미지 파일 추출 방법을 먼저 검토한다. root가 별도로 배정한 자기 stopped 컨테이너 또는 image archive에서만 초기화 파일·바이너리·entrypoint/config의 정확 bytes와 SHA를 private700/600으로 수집한다. 기존 보호 컨테이너의 execute/start/restart, pull/build는 하지 않는다. symlink·archive escape·암호/키 출력은 거절한다. PG init-scripts와 migrations 전체, migrate.sh, 추가 schema/extension SQL, 적용 config를 빠짐없이 등록한다. Auth는 auth 바이너리 SHA/build 정보와 embedded migration 출처를 함께 등록한다. Storage는 migration 전체와 실제 dist runner/config SHA를 등록한다.
3. official commit의 소스 목록↔cached 파일 목록↔실제 설정을 대조한 baseline manifest를 만든다. full118 앱 inventory와 분리하고 검증 안 된 파일·template 변환·embedded 매핑은 그대로 미검증이다. 새 DB에서 플랫폼-only가 된 뒤 Auth/Storage version과 hash 목록, roles/membership grantor, owner/ACL/default ACL, extensions/event triggers·sequence를 수집한다. 앱 profiles/worker/event 등은 0이어야 한다. 기존 source112의 플랫폼77/63행은 비교 참고이며 예상값을 억지로 맞추는 목표가 아니다.
4. 그 baseline과 current-policy118 manifest/제품 binding을 새 graph로 묶은 다음에만 원 appowner의 단일 canonical 적용을 시작한다. source112의 일부 schema-only dump를 초기화 재료로 쓰고 앱118을 겹쳐 적용하지 않는다. 새 DB apply UNKNOWN은 보존하고 동일 migration을 자동 재전송하지 않는다. 전체118 구성·데이터 이관·DB+Storage 복원은 이후 별도 receipt이며 현재 subset 성공 판정을 확대하지 않는다.

이번 문서 보완의 실제 범위는 공식 공개 자료 조회·로컬 코드 읽기·문서 변경이다. cached 이미지 추출, Docker 기동, DB 쓰기, 플랫폼 migration 실행, 전체118 적용은 모두 `NOT_RUN`이다.

## 승인된 offline 플랫폼 byte 수집 분기

root의 다음 구현 배정으로 기존 `product_connection_restore108_local.py`에 `--platform-manifest`를 추가했다. 기본은 고정 cached image 3개·허용 파일 경로·향후 read-only 명령과 appowner catalog SELECT를 출력하며 Docker 호출은 없다. offline 입력은 root가 나중에 고정 image inspect와 image save로 private700/600 파일을 수집한 뒤 연결한다. create/exec/start/pull/build로 이미지 내부 파일을 실행하거나 host에 tar를 풀지 않는다. appowner SELECT의 `exec psql`은 보호 source의 catalog SELECT만을 위한 별도 계획이며 현재 실행하지 않았다.

```sh
python3 -B tests/integration/minkyu/product_connection_restore108_local.py --platform-manifest
python3 -B tests/integration/minkyu/product_connection_restore108_local.py --platform-manifest --collect-offline --input-bundle /private/tmp/<private700 입력폴더>/input.json --output-root /private/tmp/yumidang-platform-manifest-<fresh 이름>
```

입력 JSON의 정확한 key는 `version=1`, `kind=CACHED_PLATFORM_OFFLINE_INPUT`, `images`, `appOwnerCatalog`다. images에는 `db`, `auth`, `storage`만 들어가며 각각 정확한 `imageReference`, private absolute `inspectFile`, `archiveFile`을 지정한다. 임의 이미지 이름, 입력 symlink/hardlink, duplicate JSON, 출력 덮어쓰기를 거절한다. 출력은 private700의 새 폴더와 wx600 `manifest.json` 하나다.

Docker-save outer archive는 8GiB·2만 항목, 레이어는 2GiB·50만 항목, 레이어 개별 파일은 256MiB, 허용 수집 파일은 128MiB까지 스트리밍한다. 처음 f703 분기는 uncompressed layer만 지원했다. 아래 OCI/gzip 후속도 compressed blob과 uncompressed diffID를 구분하며 무제한 해제를 허용하지 않는다. config ID/OS/architecture/RootFS/config 전체를 inspect 입력과 대조한다. 중복 normalized 경로·절대 경로·상위 탈출·Windows separator·예상하지 않은 tar type을 거절하고, layer 순서·whiteout/opaque 삭제 뒤 허용 파일만 SHA/크기/권한 목록으로 합성한다. 선택 파일과 조상 symlink는 거절한다. 실제 파일을 host에 추출하지 않는다.

수집 범위는 PG init-scripts/migrations/entrypoint/config, Auth migration 디렉터리와 auth 바이너리, Storage migrations/dist runner/package metadata다. Env·label·role/function config는 원문 대신 SHA를 기록한다. stdout에는 고정 상태와 manifest SHA만 출력한다. 원 appowner 입력에는 profiles 초기 owner 후보와 public/private table·function의 서로 다른 owner 분포, 관련 모든 owner 역할 속성, ACL, RLS/forceRLS/SECURITY DEFINER를 보존한다. 실제 owner 이름이 BOOT와 같더라도 그대로 보존하며 이름만으로 거절하거나 더 강한 역할로 바꾸지 않는다. 이 자료로 canonical 적용 role을 자동 결정하거나 ALTER OWNER를 실행하지 않는다.

결과 상태는 `COLLECTED_OFFLINE_BASELINE_NOT_VERIFIED`다. image/binary byte SHA는 실제 캐시 입력의 바이트 근거로만 사용하고, `cachedCommitBinding`, Auth embedded SQL 출처·build provenance, native 플랫폼-only 실행은 별도로 미검증/미실행이다. 공식 소스 재현성이 미확인인 경우에도 정확한 trusted cached image ID·바이너리 SHA·향후 native migration receipt/version/catalog를 결합해 실제 사용한 런타임 baseline을 입증할 수 있다. 공급사 승인이나 운영 활성화로 승격하지 않는다.

root 읽기 검토 후 모든 regular file 경로를 overlay 타입 상태로 추적하도록 보완했다. 허용 목록 밖 `app` 같은 파일이 디렉터리를 대체하면 기존 허용 자손도 제거한다. 이후 디렉터리 복구나 symlink 자손 복구는 새 레이어 바이트만 사용한다. outer/inner tar 크기는 nonnegative 정수만 허용하고, whiteout은 zero-size regular file만 허용한다.

정적 결과: 기존 16개 top-level 함수 AST 전체 동일(legacy10 포함), Python AST/compile·owner·문자·diff PASS. synthetic Docker-save bytes의 private JSON roundtrip/whiteout/opaque-order/서로 다른 definer-owner·권한/실제 이름 BOOT 보존/파일 조상·symlink 자손 재구성 모형8건 PASS, 경로·중복·링크·FIFO·config/diffID·압축·oversize·음수 size·잘못된 whiteout·허용 이미지·기존 출력 보존 등 거절 모형25건 PASS. 실제 cached image 수집/Docker 호출/native migration은 0이다. static receipt는 `/private/tmp/yumidang-platform-model-2drnp5cz/receipt.json`, SHA `b84ff9aeafa9941f01d6477f063556c3e81dc8e969f807bb003c83c783f2957c`다. 앞의 3c driver용 metadata와 수집 초안은 보존했으며, 새 driver를 통합하면 root가 새 SHA로 별도 graph를 동결해야 한다.

## 실제 cached archive 수집과 닫힌 f703 실패

위 정적 단위 후 root가 read-only 수집 슬롯을 배정했다. `/private/tmp/yumidang-platform-cached-20261010-v1`에 정확한 cached 이미지 inspect와 immutable image ID의 image save를 exclusive600으로 저장했다. disk 여유는 처음 163GiB였으며 archive당8GiB와 수집 중16GiB headroom을 지켰다. 컨테이너 create/start/pull/build와 플랫폼 실행은 0이다.

| 이미지 | archive bytes | archive SHA256 |
| --- | --- | --- |
| PG | 366956544 | `500fb715b7d65e132a28e390cccf1ba7ce7dc5a3a1f878d924c9efe527d40fef` |
| Auth | 27828224 | `bbac444988251785f81882e7393da6b294c8292c00dbc28227d95c76de1dcfae` |
| Storage | 234750976 | `e4404800a8af99085dde71df8b714ea06a46684259a6215129ae36744a46dba1` |

f703의 offline collector는 config SHA를 inspect.Id로 해석하는 line852 조건에서 실패해 manifest를 만들지 않았다. raw 오류 없이 private frame만 보존했다. source112 appowner catalog는 READ ONLY 트랜잭션으로 조회했다. 전후186개 테이블·catalog·역할/멤버십·sequence·source ID/config/mount·guard 닫힘을 대조한 finalization SHA는 `5477752a624138fff88b28b916ce1b197a4ef2b8d863b722b65a3b16abf8ee7b`이며 sourceWholeUnchanged/sourceControlsClosed=true다. 실패 후 image save를 다시 실행하거나 source를 수정하지 않았다.

별도 로컬 archive 읽기 진단에서 inspect.Id가 OCI index digest인 것을 확인했다. exact inspect.Descriptor의 digest/size/mediaType부터 index→linux/arm64 단일 manifest→config→ordered gzip blob을 따라가는 전체 chain이 세 이미지에서 일치했다. 각 blob의 compressed SHA/size와 decode 후 RootFS diffID가 각각 일치했으며 총49레이어(PG29/Auth6/Storage14), 최대 decoded layer1300511744 bytes였다. 이 진단은 host 추출·Docker 호출을 하지 않았다. `/private/tmp/yumidang-platform-cached-20261010-v1/oci-chain-readonly-proof.json` SHA `2a3716637e856ce38159faafc3642148e63d3b1206fd76eec6b0b97d629a7600`다. source commit/공식 build 재현성이나 native baseline 실행을 입증한 결과가 아니다.

root 승인으로 기존 collector에 OCI/gzip 지원만 추가했다. inspect.Descriptor→index SHA/size/type→single matching platform→manifest SHA/size/type→config SHA/size→compatibility manifest의 config/layer 순서를 모두 검사한다. OnBuild absent/null 한 표현차만 정규화하고 원 config 두 hash를 보존한다. 다른 config 값은 exact다. streaming decoded reader는 tar가 읽거나 건너뛰는 바이트와 EOF까지 hash/count하며 perlayer2GiB·image aggregate8GiB cap을 읽는 중 적용한다. 압축 blob digest와 decoded diffID는 별도로 기록한다. 기존 경로·타입·whiteout·overlay/privatewx 검사는 유지한다.

이 후속은 아직 정적 모형 검증만 수행했다. 기존 모형8+거절25와 OCI 모형3+거절19가 PASS다. OCI 음성 사례는 descriptor/manifest/config/layer digest·size·mediaType·platform·순서·config 값·CRC·diffID·개별/전체 expansion 경계를 포함한다. receipt는 `/private/tmp/yumidang-platform-model-hxe6yxnd/oci-receipt.json`, SHA `786bd27514ebe962a8f6ccc38c78ac4f3687f6f409c8e9eb052b446ec90709f1`이다. native 플랫폼 실행·118 적용은 `NOT_RUN`이며 root frozen patch 검토 전 새 parser의 실제 archive 실행도 보류한다. 기존 실패/수집 source 증거는 그대로 보존한다.


## a974 실제 offline 적용의 닫힌 실패

root가 a974 전체 diff를 검토·통합한 뒤 기존 immutable archive와 input을 재사용해 local offline 적용만 승인했다. 새 증거 폴더는 `/private/tmp/yumidang-platform-offline-evidence-20261010-v2`다. 실행은 `PLATFORM_SELECTED_LINK_REFUSED`(platform_archive line951)에서 닫혔으며 새 manifest/output 폴더를 만들지 않았다. 실패 SHA는 `34296220c116d883b31188c617e5aeb55c8b5631aa55e6ec71ee3f489c77fadb`, finalization SHA는 `b129928e547c22708d6cf65636c053f18fc3ddaa1e03790507adc9a1877e7566`이다. 세 archive의 전후 SHA/크기는 최초 export receipt와 정확히 같고 driver a974도 그대로다. Docker 호출·source query·save 재실행·native 플랫폼 실행은 모두0이다. 앞의 f703 실패도 보존했다.

로컬 archive metadata 읽기로 링크 원인을 확정했다. DB layer22의 `etc/postgresql-custom/conf.d`는 size0 symlink이며 대상은 `/etc/postgresql/postgresql.conf.d`다. 세 이미지의 허용 범위 안 링크는 이 1건이었다. 진단 SHA는 `ecc529fe6ddb1a67180d9ba207d336d25c19364d139c33cddff8d7b426183de5`다. host 추출이나 링크 따라가기는 하지 않았다. 일반 링크 허용·경로 guard 완화 없이 root에게 이 단일 config directory alias를 별도 metadata로 기록하고 실제 target regular bytes만 기존 allowlist로 수집하는 좁은 후속안을 제안했다. 현재는 코드 변경·재실행하지 않았다.

native platform-only 설계는 아직 실행 승인 전이다. 먼저 이 닫힌 수집을 해결해 실제 cached entrypoint/migrate.sh/init SQL/Storage runner 파일 SHA와 실행 순서를 확정해야 한다. 다음 검토 graph는 cached index→manifest→config→layer chain, 별도 입력의 heterogeneous appowner/ACL/definer distribution, 명시적 runtime 설정을 함께 묶는다. 원 source 일부 스키마를 초기화 재료로 쓰지 않는다. 새 empty DB의 플랫폼만 만든 뒤 Auth migrate-only와 Storage 원 runner의 최소 경로를 검토·순차 실행하고 역할/권한·플랫폼 migration version/hash·catalog를 실제 수집한다. 앱 public.profiles/private worker/event 객체0과 외부 공급사/가입/DELETE/ACK0이 필수 조건이다. 원 appowner 보존 판정과 검토118 canonical 단일 적용은 그 다음 별도 단계이며 이번 실패를 전체118 준비 완료로 집계하지 않는다.


## 단일 config directory alias 정적 보완

root가 위 exact 링크 metadata에 근거한 좁은 예외를 승인했다. db의 `etc/postgresql-custom/conf.d`가 symlink/type·size0·target `/etc/postgresql/postgresql.conf.d` 모두 정확할 때만 `configDirectoryAliases`에 layer index/digest·mode/uid/gid/target을 별도로 기록한다. regular file inventory에는 alias를 넣지 않고 링크를 따라가거나 host에 추출하지 않는다. 최종 target은 기존 선택 경로 안의 실제 directory여야 하고 해당 directory의 실제 regular bytes가 정상 수집돼야 한다. 다른 path/target/type/이미지·링크 자손은 거절한다.

whiteout/opaque 및 모든 node type replacement에 alias metadata도 같은 overlay 제거 규칙을 적용한다. alias가 directory로 대체되거나 삭제되면 metadata를 제거하며, 다시 나타난 alias는 새 layer digest로 기록한다. target directory의 파일/링크 대체·삭제·파일 전체 제거는 닫힌 실패다. 앞의 실제 v2 실패와 archive는 그대로 보존했다.

새 driver SHA는 `a0a1a821a0afa998e1c1345e4f8c9ec578333dbd3df0e1afe5e14274dcfae615`다. exact alias 및 overlay state 모형5 positive/16 negative, 기존8 positive/25 negative, OCI3 positive/19 negative가 PASS다. alias 모형 receipt는 `/private/tmp/yumidang-platform-model-ruzsr3rf/alias-receipt.json`, SHA `2e9aa412df08dc9b3528c9aa87f9e592dbe365cc9945bf4e21ed400ec10dda5c`다. OCI 모형 receipt SHA는 `01231cdd1ede5c8235a15d2f38ca15dcf46b585201d050aa61b0c7aa9a856eef`다. a974 대비 최소 diff는 `/private/tmp/yumidang-platform-alias-static-20261010-v1/driver.diff`에 private600으로 저장했다. 기존16 함수 AST·owner·compile·문자·diff 검사가 통과했고 foundation a974는 불변이다. 새 parser actual archive 실행·Docker/source query/native 플랫폼 실행은0이며 root frozen diff 검토 후 별도 승인으로만 진행한다.


## cached byte 실제 PASS 및 native 플랫폼-only 정적 분기

root가 a0a1을 정확히 통합한 뒤 기존 immutable archive/input으로 offline v3을 실행했다. `/private/tmp/yumidang-platform-manifest-cached-20261010-v3/manifest.json` SHA `7d699d68add889e18daeaf746ce2450490867546e8656a13c9dd8383c1f70de4`, `/private/tmp/yumidang-platform-offline-evidence-20261010-v3/receipt.json` SHA `d33a6d6af64de72d3d678a8d045a34819a1cc796f11637c4363759119ad9b597`다. 일반 파일 DB85/Auth71/Storage1179, SQL inventory DB70/Auth70/Storage91, decoded image bytes DB1329953280/Auth58879488/Storage881476608를 검증했다. 단일 config alias는 regular inventory와 분리했다. 세 archive 전후 초기 export SHA/크기와 a0a1이 같으며 Docker/source query/host 추출/native/full118 적용은0이었다. v1/v2 실패는 보존한다. 공식 build 재현성·Auth embedded source mapping은 계속 NOT_VERIFIED다.

이 실제 byte manifest를 고정해 root가 기존 M driver의 `--platform-baseline` 구현을 배정했다. 기본은 NOT_RUN·승인/슬롯 false이며 앱 SQL0이다. private graph는 정확 manifest7d699와 source112 ID/186개 table 포함 whole snapshot+sequence/원 owner catalog SHA, 고정 helper·TLS 도구·driver 바이트를 결합한다. 임의 env/module/공급사 입력은 받지 않는다. root 통합·독점 슬롯·실제 MemAvailable768MiB 이상이 있어야 새 자기 환경을 시작할 수 있다. 기존 full final restore의 1GiB 가드는 바꾸지 않았다.

새 native PG는 cached 실제 entrypoint와 migrate.sh를 실행한다. initial bootstrap 역할 `supabase_admin`과 앱 초기 owner `postgres`를 구분한다. 실제 cached default POSTGRES_HOST는 Unix socket이며 PG initdb/임시 서버와 최종 PID1 postgres를 분리해 기다린다. DB512MiB/runner128MiB·heap64MiB·CPU0.5·pids128·no-healthcheck·Docker raw log 저장0·host port0·전용 fresh internal subnet을 고정한다. 생성한 새 CA/정확 DNS mplatform-pg leaf를 사용하고 hostssl+verify-full과 실제 Auth/Storage 역할별 pg_stat_ssl 관측을 모두 요구한다. 사진·회원 원문과 외부 HTTP는 없다. Auth/Storage migration용 container user0은 private600 CA bind를 읽는 격리 테스트 설정이며, DB native owner나 회원 principal 복구를 의미하지 않는다.

실행 순서는 native PG entrypoint init→`/usr/local/bin/auth migrate`→Auth 종료·STOP→`node dist/scripts/migrate-call.js`→Storage 종료·STOP이다. Storage cached CLI SHA `59bc11e561eedd00e478403eacc33297792874c9ffb0265fd57ab766ca4c4940`가 원 runMigrationsOnTenant를 호출하며 HTTP/queue 서버를 실행하지 않는다. single-tenant·queue/vector off·새 DB 추가0·DB_INSTALL_ROLES=false·DB_ALLOW_MIGRATION_REFRESH=false·freeze 없는 원 runner를 고정한다. 같은 실패 migration을 재전송하지 않는다. 전체 native table/catalog/roles·Auth version·Storage id/name/hash 이력을 private receipt에 담고 profiles/private worker/event·주요 앱 RPC·앱 migration 이력0, 회원/Storage objects·buckets0, auth.uid()/owner_id 같은 초기 앱 의존을 확인한다. source112 전후 whole/identity/sequence/guard는 같아야 하며 finally는 exact labels/name/image/ID의 자기 환경만 STOP한다. create 응답 유실도 해당 run_id의 자기 ID만 찾아 보존·STOP한다.

source112의 실제 public/private owner 입력은 table135/function576/SECURITY DEFINER535 모두 postgres이며 rolsuper=false, CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS=true다. 새 native 결과가 원 attrs와 다르면 private 차이를 남기고 FAIL하며 ALTER OWNER/role 보정을 하지 않는다. 원 postgres 관련 membership12개는 grantor가 모두 recovery BOOT이고, 그중 completion_runner/worker_queue2개는 앱 적용 후 역할이다. 따라서 native 초기 membership을 원 dump chain과 같다고 가정하지 않는다. native 각 단계에서 source/native memberships·grantor·options와 없는 역할을 그대로 기록한다. 차이가 있으면 canonical 앱 적용 준비=false와 고정 hold reason을 남긴다. native migration PASS는 native baseline 실행 범위이며 source authority exact/full 앱 schema/운영 readiness로 승격하지 않는다.

이번 새 분기는 정적 모형만 검증했다. native graph/default/URI·closed 환경/source write0·exact own ID/caps/환경/네트워크·원 owner 속성 차단7 positive/45 negative PASS이고 receipt는 `/private/tmp/yumidang-native-platform-model-52jdt4vd/receipt.json`, SHA `20c7c9e784aac9356b99953a146404f6820d8be89d9bb3cb47541901384bbdc1`이다. 이전 collector8/25·OCI3/19·alias5/16도 PASS이며 root a0a1의 기존27 함수 AST 전체 동일, compile/문자/diff PASS다. native 실제 실행은 NOT_RUN이다. full 앱 canonical은 root SQL120 실제 검증·등록 후 새119개 입력으로 다시 동결해야 하며 검토118 결과를 최종 schema라고 확대하지 않는다.

현재 native driver SHA `873a6fbcdf4f6c849526a551f45f21f24382073ac69bd7dc83004c6a70aa739f`, a0a1 대비 private diff SHA `31c6d6fe1a0307dc06468c8ec063a2a45d99de2812f4a4d70761985ec4a143d9`, 승인 전 graph draft SHA `65fa8be345c9dd37e1cd4102f9e9f3d3b217a8a111210604a3fccdd6c03392b8`다. 둘 다 `/private/tmp/yumidang-native-platform-static-20261010-v1/`에 private700/600으로 보존했다. graph의 approval/slot은 false이며 source hash는 초기 export 관측값이므로 root actual 직전에 source 불변을 다시 확인한다.


## native OOM 및 실패 시 자기 STOP 보강

root 최종 읽기 검토에 따라 identity와 full invariant를 분리했다. 먼저 exact ID/name/run label/image를 확인한 자기 컨테이너만 STOP한다. 메모리·설정·OOM invariant가 실패해도 자기 STOP은 실행하며, 그 실패는 계속 FAIL로 남긴다. 다른 ID/name/run/image에는 STOP0이다. finally는 실제 physical stopped와 모든 invariant 검증을 나눠 기록하고, 각 최종 ID의 running/OOMKilled 상태를 private finalization과 성공 receipt에 넣는다. OOMKilled가 정확히 false가 아니면 성공하지 않는다.

빠른 migration 종료에서도 TLS observer는 먼저 실제 pg_stat_ssl 행을 확인한다. exact role·TLSv1.2/1.3·cipher·128bits 이상 행을 실제 관측한 경우에만 통과하며, 행 없이 종료된 경우 NOT_VERIFIED에 해당하는 `NATIVE_ROLE_TLS_NOT_OBSERVED` 실패를 유지한다. health·configured URI·migrate exit0으로 TLS 증거를 대신하지 않는다. 정적 모형은 exact caps/OOM 실패 뒤 자기 STOP·다른 ID/name/run/image STOP0·빠른 종료의 TLS 없음/실제 있음·plaintext/wrongrole를 포함해10 positive/56 negative PASS다. receipt `/private/tmp/yumidang-native-platform-model-_qhvnxg5/receipt.json` SHA `1970af7cc18b9ab232618bc4c127de3710d532a4a93d184c76976f21aa4def24`다.

새 driver SHA `31958d9d3ca26644d1cf701a78081b3e236c4b6ce7806556cc74ee6c21467d52`, 873 기준 최소 diff SHA `c953cb8e48cf307b090d736e953ebcf3c660b1d80039e5dc024439efb843ce90`, a0a1 기준 전체 diff SHA `0187edb3f187c39ef35dbd03fc2462354e7ce65dc7dc9274a665b9629deee8d9`이며 `/private/tmp/yumidang-native-platform-static-20261010-v2/`에 private700/600으로 보존했다. 앞 native graph draft65fa는873 바이트에 묶인 승인 전 자료이므로 새 실행에 사용하지 않는다. root가 새 driver·source proof·슬롯으로 graph를 다시 동결해야 한다. 기존27 함수 AST·compile·문자 검사가 통과했고 Docker/native 실제 실행은0이다.


## canonical119 실제 적용과 새 합성 DB·Storage 복구 정적 인계

이후 native-v7 실제 결과는 `PASS_NATIVE_PLATFORM_ONLY`다. receipt50cdf2·final8dd2에서 실제 Auth77/Storage63 migration, 최소 역할의 TLS, 보호 소스186 불변, 자기3개 STOP/OOMfalse를 확인했다. 원 source112 membership grantor와 새 native grantor 차이는 역할 변경으로 덮지 않았다. root430 driver의 canonical-v1은 원119개 SQL을 정확한 native DB에서 한 번 적용했고 `PASS_NATIVE_CANONICAL_119_APPLICATION_ONLY`다. receipt SHA `fafeb72231850417dde552c00c39bb759baa536eacc5fcfb8e2cbf8551b20d4d`, finalization `62faad40d8bc685875d08912783080888a5ead38ea373407a262d4a14a58802e`, canonical178 snapshot `bc3736e55f5c684c3c30d0bb1dfff3c9087495e89bf2c724db08e6bed3ee2724`이며 native 기존 역할·membership·grantor를 보존했다. 이 기록은 실제 운영 데이터 또는 Storage 백업이 아니다. canonical 당시 snapshot은 rows/catalog/roles이며 sequence는 새 복구 분기에서 현재 값을 수집해야 한다.

root 승인 설계에 따라 기존 M driver에 `--native-final-backup` 분기를 추가했다. 기본 NOT_RUN, 승인·슬롯 false, Docker0이며 기존38개 함수 AST는 root430과 같다. actual 실행은 아직0이다. 대상은 정확히 stopped native-v7 DB `497e5d1bc98835d4074a2fbb7ccb37575d539984c18f571d38b6d8fbec692c2f`의 현재 canonical119/178개 table 상태다. old source112+6후속 SQL 복구, 원 Storage103, 운영20개 적용 DB와 구분한다. 운영 v2 read-only의 역할31/membership25/앱 sequence0을 이 합성 canonical DB의 복구 근거로 합치지 않는다.

새 graph는 원 canonical 승인 graph318969·실제 receipt와178 snapshot, native byte manifest7d699, 현재 product162 SHA95ed와 원119 SQL registry 및 개별 파일 바이트, exact stopped ID/config/host/mount/network, private native Storage env/CA hash를 결합한다. graph draft `/private/tmp/yumidang-native-final-static-20261010-v3/graph-false.json` SHA `58483c9ca2d32e1210fe0f5ca18bdd4a70eff46bb904d687dfefd160d522dee5`는 승인false/슬롯false다. 현재 root430을 실행하거나 draft flag를 임의 변경해 실행하지 않는다. root의 독립 diff 검토·통합·새 승인 graph·독점 슬롯·fresh source proof가 필요하다.

실행은 source DB512MiB+새 Storage512MiB/heap128 → 두 서비스 STOP → target DB512MiB+새 Storage512MiB로 직렬화한다. 시작 전 MemAvailable1GiB 기준을 유지하고 utility 생성·attached start에도 다시 확인한다. CPU0.5/pids128/no-healthcheck/port0/log-none/내부 네트워크·exact mount/ID/label/image를 검증한다. created 상태의 endpoint ID 없음은 정확한 never-started 상태에서만 허용하며 running/exited는 materialized ID가 필요하다. 설정 invariant가 실패해도 identity가 맞는 자기 컨테이너 STOP을 먼저 수행하고 실패를 유지한다. create 응답 유실은 exact 새 run/name/image label로 자기 ID만 수집하며 다른 source를 STOP하지 않는다.

source 원178 snapshot·PID1 cached ELF·최종 native server·닫힌 control·cron을 확인한 뒤 fresh 직접 SQL Auth행/버킷/UNKNOWN행과 실제 Storage PUT2건을 만든다. 정상 public 가입이나 physical UNKNOWN DELETE를 관측했다고 설명하지 않는다. 기존119 SQL은 재실행하지 않으며 원 postgres 승격·역할 선생성·GRANTED BY 제거가 없다. 각 쓰기는 exclusive intent 후 첫 전송만 하고 불확실하면 중단·보존한다. phase 예약은 source DB ID+phase로 고정하고 file→directory→parent fsync가 모두 성공해야 진행하므로 revision 변경도 동일 phase의 재전송을 허용하지 않는다.

DB checkpoint는 전체 table rows·catalog·역할 속성·membership 및 grantor, raw ACL의 NULL/명시 값, DB role settings, PUBLIC 포함 실제 권한 및 grant option, 현재 모든 sequence last_value/is_called를 포함한다. PostgreSQL17의 MAINTAIN도 [공식 권한 조회 계약](https://www.postgresql.org/docs/17/functions-info.html)에 따라 포함한다. SQL 조회 자체의 실제 실행은 아직 NOT_RUN이다. password는 roles dump에서 제외하며 target Storage만 새 비밀번호를 사용한다. large object가 있으면 이 좁은 합성 범위는 닫힌 실패다. dump 전후와 Storage STOP 후 상태가 같아야 백업을 인정한다. roles restore는 동일 supabase_admin의 CREATE만 제외하고 원 ALTER·grantor를 그대로 적용한다. 실제 raw ACL/CHECK/catalog 표현 차이가 나오면 예외로 생략하지 않고 실패를 보존한다.

cached Storage GET 경로는 bucket/object SELECT 뒤 파일 stream이며 해당 경로에서 last_accessed_at UPDATE를 발견하지 않았다. 이를 모든 GET의 무변경 보장으로 확대하지 않고 실제 GET 전후 checkpoint를 비교한다. backend file SHA935d·config SHA7213·경로 파일 바이트를 immutable manifest와 대조했다. 파일 내용뿐 아니라 mode/uid/gid/nlink1/모든 xattr를 수집·복원한다. backend는 `user.supabase.content-type`과 `user.supabase.cache-control`을 사용한다. plain tar만으로 이 속성을 잃는 경계를 막는다. target GET의 Content-Type·Cache-Control·MD5 ETag와 SHA 바이트가 source GET과 같아야 한다. mtime/atime/ctime/inode·전체 physical snapshot·모든 HTTP header 동일성은 이 증거에 포함하지 않는다. HTTP는 격리 container 내부 loopback이며 운영 HTTPS 검증으로 승격하지 않는다. DB 연결은 hostssl+verify-full 및 실제 supabase_storage_admin TLS 행을 요구한다.

전체 volume tar는 bounded regular/directory만 허용하고 링크·특수 타입·traversal·Windows 경로·정규화 중복·파일 ancestor·과대 파일/총량·PAX·특수 mode를 거절한다. 모든 실제 파일과 version을 metadata와 대응시킨다. source 서비스 중지 후 dump+roles+tar+xattr checkpoint를 만들고 다시 시작한 source API에서 GET-only readiness와 상태 동일성을 확인한다. 첫 Storage HTTP DELETE200 및 metadata/모든 관련 version bytes 소실을 실제 확인한 known receipt만 target 복원 후 한 번 재적용한다. 이 receipt는 제품 ACK가 아니다. UNKNOWN행과 그 파일에는 DELETE/ACK/dispatch를 하지 않고 source/target 최종 전체 상태가 같아야 한다. 각 API STOP 뒤 DB·파일 checkpoint도 다시 비교한다.

현재 driver SHA `34dd659d5681929e3fcbc4c0b73852170e6f59d9ef1ea7caf958ed8019fbc8d5`, root430 대비 diff SHA `754dd39a44af83d37fae36ce0569abe85417bac47c50aaa8c0f4f1f939b96748`다. 정적 모형18 positive/85 negative, generated Node syntax2개, 기존38 함수 AST·owner·Python compile 검사가 PASS다. 모형 receipt `/private/tmp/yumidang-native-final-static-20261010-v3/receipt.json` SHA `3c5eadb4768adf259b19ac8cf9aec617597eaec3b561f924446ca5026963ed59`, identity/STOP 모형 receipt SHA `b50391c77cee0270668eca458b5045e9e8597472864e97bcf0c2db9ae3c9e198`다. 이 검사는 DB·Docker·Storage 실행을 하지 않았다. own worktree에는 queue helper가 없어 정적 default 검사는 root의 읽기 전용 helper 경로를 PYTHONPATH로 지정했다. root 통합 실행에는 고정6개 dependency graph를 재확인한다.

후속 actual 명령은 root 통합·새 승인·슬롯 배정 후 foundation에서 `python3 -B tests/integration/minkyu/product_connection_restore108_local.py --native-final-backup --run --graph-manifest <새 승인 graph> --revision native-final-v1`이다. 지금은 실행하지 않는다. 보호 source112의186개 table/6개 sequence·authority·identity는 전후 읽기 비교만 하며 source STOP/restart/write0이다. protected Storage103 access0이다. 기존 missing39 바이트 UNRESOLVED, live operating DB/Storage backup NOT_RUN, 실제 physical UNKNOWN 삭제 NOT_RUN, public 가입 NOT_RUN, Stage6 미완료·activationfalse를 유지한다.


## 실행 전 검토 보완: 기존 실행 소유권·원 DB metadata·기록 내구성

앞34dd 정적 동결은 실제 실행하지 않았으며 v3 자료를 보존한다. peer 검토에서 초기 canonical DB가 이미 running인 경우, 이번 실행이 시작하지 않았는데 finally가 STOP할 수 있는 경계를 찾았다. 이제 exact source가 처음 stopped임을 검증하고 durable source-start intent를 만든 뒤, 실제 start 호출 직전에 설정한 실행 소유 flag가 있을 때만 source STOP한다. 초기 running 또는 start intent fsync 실패는 source STOP0이다. start 응답 유실은 flag가 남아 정확한 자기 source STOP을 수행하며 재시작하지 않는다.

모든 새 save는 exclusive600 파일 write→flush→file fsync→root directory fsync→parent directory fsync를 완료해야 반환한다. 기존 root 재사용에도 parent fsync를 생략하지 않는다. 단계 예약뿐 아니라 사진 PUT intent·덤프·tar·xattr·historical200 success도 이 가드를 쓴다. sync 실패 파일은 보존하고 다음 쓰기·원 DELETE 재전송을 하지 않는다. actual 모델은 private 임시 파일만 사용하며 DB/Docker는 실행하지 않았다.

cached migrate.sh는 DB owner를 postgres로 지정한다. 기존 supabase_admin owner 가정을 제거하고 새 actual checkpoint에서 관측한 owner가 원 role inventory에 있을 때만 허용한다. original archive의 native pg_restore TOC에서 postgres DB 항목1개·원 owner를 확인한다. 원 datacl/DB role settings/comment/security label이 있으면 대응하는 metadata 항목도 필요하다. 이 검증 자체는 아직 실제 TOC NOT_RUN이며 모델만 검사했다. target 전체 raw authority 비교로 값까지 동일해야 통과한다.

DB owner·ACL·DB별 설정을 원 archive에서 복원하려면 [PostgreSQL17 pg_restore의 create 계약](https://www.postgresql.org/docs/17/app-pgrestore.html)을 사용해야 한다. create와 single-transaction은 [공식 구현](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/bin/pg_dump/pg_restore.c)의 옵션 검사에서 함께 사용할 수 없다. 따라서 singleTransaction:false·recreatedFromOriginalArchive:true를 기록한다. 부분/UNKNOWN에는 재실행하지 않고 exact own target STOP과 원 자료 보존으로 끝낸다.

cron.database_name은 postgres, cron.launch_active_jobs는 off를 유지한다. cached pg_cron1.6.4의 `/nix/store/g40m8ka4f30np4zhmpdncn99n6hyxs7x-pg_cron-1.6.4/share/postgresql/extension/pg_cron--1.0.0.sql` SHA `927d4b64a32d12d8f0dbbbb928707cd0d9ee9f9f055cf985099ce27a6b9fede5`는 current_database와 cron.database_name이 다르면 extension 생성을 거절한다. template1로 cron 설정을 바꿔 postgres extension을 복원하는 방법은 사용하지 않는다.

root 승인한 새 target-only 절차는 exact 새 ID/run/image와 기존 source/protected ID 제외·source STOP·원 roles/memberships 동일·non-system relation0을 먼저 확인한다. durable 한 번의 restore intent 뒤, 이 새 빈 target의 postgres에만 `dropdb --force --maintenance-db=template1 postgres`를 한 번 호출한다. 자신의 cron launcher가 연결해 DB DROP을 막는 경계를 정리한 뒤 `pg_restore --create --exit-on-error -d template1`로 원 full archive를 한 번 복원한다. clean/-1 옵션·manual ALTER OWNER·GRANTED BY 변경·role promotion·원 source DROP은 없다. 이 단계가 실패하면 부분 상태/intent를 보존하고 추가 적용하지 않는다.

cached PUT route16cd4b는 uploadFromRequest에 isUpsert:true를 직접 전달한다. fresh UUID 파일2개에 PUT 첫 전송만 하며 x-upsert를 추가하거나 uncertain PUT을 재전송하지 않는다. ETag는 설정된 MD5 모드에서 source/target 문자열 동일성으로만 기록하고 독립적인 수학적 MD5 검증으로 설명하지 않는다. Content-Type/Cache-Control 및 bytes/xattr 검증은 유지한다.

최종 정적 driver SHA `dcacbb4832b886c685f6bf9919ec205ef52f1031957382d8ef15503fc7ec5b74`이며 기존38 함수 AST가 같다. root430 전체 diff `71acbe43eae1cce687d2509789611a08fdf94b8b4054769c8ad3ec572f791508`, 이전34dd 보완 최소 diff `83a0955be458024332dbb6b140e52a3fc0e3a12a958b758683fdcfb17b9127c6`, 승인false/슬롯false graph `4da0abb1fa26bdd7c4928c474ef2a303e495c6c54dea894cbf446b74f13a965c`다. `/private/tmp/yumidang-native-final-static-20261010-v5/`의 모형27 positive/105 negative, generated Node syntax2개·compile·owner·문자·diff 검사가 PASS다. 보완 모형 receipt `390ed02f6aa5352fdd3b2cfa28ab786e2f3ef00f8c8d0620d86fd7109b491978`는 TOC owner/ACL/settings 경계·sync 실패/상위 dir 재사용·초기 running STOP0·start intent 실패 start0·응답 유실 owned flag·target만 force-drop/호환 restore 옵션을 검증한다. 실제 target DROP/restore·native-final backup은 아직 NOT_RUN이다. 기존39 missing bytes·live operating backup·Stage6/TTL/support 완료를 이 결과로 승격하지 않는다.
