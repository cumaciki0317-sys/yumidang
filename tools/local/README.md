# 로컬 검증 준비 도구

## 현재 정책을 검증할 때

현재 로그인은 네이버만, 현재 동행은 무료 1:1이다. 과거 테스트 Auth/비밀번호 세션은 로컬 권한 검사 도구이며 네이버 필수 정보·성인 여성 자격·필수 사진의 실제 연동 성공이 아니다. 이메일·계좌 인증은 추후 도입 검토다.

기존 SQL/HTTP 검사가 통과해도 작성자 만 나이 19~99 숫자 범위·연결 행사명 검색·개인 완료 후 선제 후기 제출·칭찬 6개·동의 만료/미선정 종료의 최신 정책 반영을 보장하지 않는다. 이 경계는 후속 코드 변경과 함께 검사한다. 문서 동기화 작업에서는 아래 DB 기동·reset·원격 호출을 실행하지 않는다. 구성·길이·배치 한도와 제품상 표시 수량·운영 보관 수치는 별도로 관리한다.

담당: 민규. Python 3.11 이상 표준 라이브러리와 Git을 사용한다. 명령은 현재 작업 중인 worktree의 최상위에서 실행한다. 환경/복사 도구는 DB를 기동하거나 SQL을 실행하지 않는다.

아래는 격리 로컬 환경을 준비하고 검증하는 실행 절차다. 사용 시 현재 HEAD·작업 공간·설정을 확인하고 과거 검증 환경·결과를 현재 재현 결과로 대신하지 않는다. 문서 최신화 자체는 DB 재기동·마이그레이션 재생·HTTP 재검증을 수행하지 않는다.

## 환경 점검

```sh
python3 -B tools/local/check_environment.py
```

PATH의 `python3`, `node`, `deno`, `supabase`, `docker` 경로와 `--version` 결과의 버전 숫자만 보고한다. 프로세스마다 5초 제한을 두며 환경 변수나 도구의 원문 stdout/stderr를 출력하지 않는다. 도구 누락·실행 실패·설정 골격은 `NOT_READY`와 종료 코드 1이다. 필요한 도구와 설정 항목이 있으면 `READY`지만 실제 설정 유효성이나 실행 성공을 의미하지 않는다. 설정은 `PRESENT_UNVERIFIED`로 구분한다.

`config.toml`은 2차에서 실행 가능한 로컬 설정으로 작성했다. Docker daemon, Supabase 시작, 실제 마이그레이션 재생, Deno 타입 검사는 **이 점검 명령**에서 실행하지 않아 `NOT_RUN`으로 표시한다. 별도 실행 결과는 민규 현황에 기록한다. Supabase CLI를 `npx`로만 실행하면 PATH 점검은 MISSING일 수 있으며 설치 실패와 혼동하지 않는다.

## 정식 마이그레이션 검사

```sh
python3 -B tools/local/prepare_migrations.py
```

기본 동작은 읽기 전용 목록·순서·SHA-256 검사다. 현재 Git에 등록된 `backend/supabase/migrations/YYYYMMDDHHMMSS_name.sql`만 선택하며 HEAD와 작업 파일이 동일해야 한다. 버전 중복, 내용 중복, 빈 SQL, 비정상 파일명, 심볼릭 링크, 변경·추가된 미커밋 SQL, 빈 이력은 거절한다. ` 2.sql` 등 숫자 사본과 미추적 파일은 제외 목록에만 표시하고 삭제하지 않는다. SQL 문법·DB 재생 검증을 뜻하지 않는다.

원래 작업 폴더의 미추적 사본은 별도 worktree로 복사되지 않는다. 따라서 두 작업 폴더의 제외 목록은 다를 수 있으며, 이 도구가 다른 worktree의 미추적 파일을 조사하거나 옮기지는 않는다.

선택적으로 복사하려면 시스템 임시 폴더 아래의 비어 있는 외부 실행 루트를 명시한다. 아래 명령은 임시 폴더 생성과 정식 SQL 복사만 수행한다.

```sh
foundation_output="$(mktemp -d)"
python3 -B tools/local/prepare_migrations.py --output "$foundation_output"
```

결과 구조:

```text
<임시 실행 루트>/
├── migration-manifest.json
└── supabase/
    └── migrations/       # 정식 SQL만 포함
```

출력은 절대 경로여야 하며 저장소 내부·임시 폴더 외부·비어 있지 않은 대상은 거절한다. 기존 파일을 덮어쓰거나 원본을 수정하지 않는다. 복사 도중 오류가 나면 부분 결과가 남을 수 있으므로 새 임시 루트에서 재시도한다. manifest의 `sql_execution: NOT_RUN`은 복사 후에도 유지한다. 이 폴더에는 실행 설정·seed가 없으며, 바로 실행 가능한 Supabase 환경을 제공하는 것이 아니다.

## 검증 명령

```sh
python3 -B tests/database/minkyu/test_local_tools.py
node --test tests/functions/minkyu/http.test.ts
python3 -B tests/contracts/minkyu/test_db_foundation.py
python3 -B tests/functions/minkyu/test_harness.py
```

Python 검증은 임시 Git 저장소에만 테스트 이력을 만들어 SQL 보존·사본 제외·중복·변경 이력 거절·출력 보호를 확인한다. 환경 검증은 가상 프로세스로 누락·타임아웃·출력 제한·미구성 상태를 확인한다. 프로젝트 Git 이력은 변경하지 않는다.

Deno가 준비된 후 공통 코드의 정적 타입 검사를 별도로 실행할 수 있다. 외부 import 의존성을 추가하지 않은 태스크다.

```sh
cd backend/supabase/functions
deno task check:common
```

Node 단위 검증 성공은 Deno 타입 검사나 Supabase 런타임 검증을 대신하지 않는다.

## 설정을 포함한 현재 정식 SQL 복사

2·3차 SQL 6개는 이제 정식 Git 이력에 포함됐다. `prepare_database.py`는 `prepare_migrations.py`의 검사를 거쳐 **현재 Git HEAD와 동일한 정식 SQL 전체**와 로컬 `config.toml`만 새 임시 루트에 복사한다. 2026-09-28 기준 정식 SQL은 26개이며, 고정된 추가 SQL 목록을 다시 붙이지 않는다.

```sh
db_output="$(TMPDIR=/private/tmp mktemp -d /private/tmp/yumidang-minkyu-db.XXXXXX)"
TMPDIR=/private/tmp python3 -B tools/local/prepare_database.py --output "$db_output"
```

이 명령은 복사만 수행한다. `config.toml`은 저장소 내부 일반 파일이어야 하며 비어 있지 않은 UTF-8 TOML인지 확인한다. 이 검사는 Supabase 설정의 의미·실행 유효성 검증을 대신하지 않는다. 기존 SQL 이력·미추적 사본·`.env`를 수정하지 않으며 변경된 정식 이력은 거절한다. 출력은 시스템 임시 루트 아래의 새 빈 경로여야 한다. 준비에 실패하거나 소스가 바뀌면 새 빈 임시 루트에서 다시 실행하며 기존 결과를 덮어쓰지 않는다.

`migration-manifest.json`에는 선택한 정식 SQL 경로·버전·SHA-256을, `database-manifest.json`에는 같은 목록과 설정 해시를 기록한다. `pending`은 빈 배열이고 `total_count`는 정식 이력의 `count`와 같다. `sql_execution: NOT_RUN`은 준비 후에도 유지하며 이후 DB 실행 성공을 자동 기록하지 않는다. 새 정식 SQL이 커밋되면 현재 HEAD 검사 목록에 포함하므로 단계별 파일명을 도구에 추가할 필요가 없다.

이번 준비에 사용한 새 임시 루트와 실제 결과는 [민규 작업 현황](../../docs/collaboration/minkyu.md)과 [2026-09-28 준비 기록](../../docs/collaboration/requests/minkyu/2026-09-28-local-refresh.md)을 확인한다. 임시 폴더의 장기 보존을 기대하지 말고 위 명령으로 재현한다.

준비 도구 검증:

```sh
python3 -B tests/database/minkyu/test_database_runner.py
```

## 전용 로컬 Supabase에서 실제 검증 — 이후 실행 안내

**2026-09-23에 사용한 검증 환경:** macOS arm64, Deno 2.9.6, Colima 0.10.3, Docker CLI 29.8.0, Supabase CLI 2.116.0, PostgreSQL 17.6. Homebrew Supabase 설치는 Command Line Tools 버전 요구로 실패했으므로 공식 npm 배포를 `npx --yes supabase@2.116.0`으로 실행했다. 시스템 Command Line Tools를 삭제하거나 교체하지 않았다. 설치 명령을 반복 실행할 필요는 없다.

아래 명령은 실제 로컬 DB를 기동하고 SQL 검사를 실행한다. **이번 2026-09-28 준비 작업에서는 실행하지 않는다.** Colima 전용 프로필은 기본 Docker context나 SSH 설정을 바꾸지 않는다. 저장소 worktree와 `/private/tmp`만 mount한다. VM의 2 CPU/4 GiB/20 GiB는 2026-09-23 로컬 검증 자원이며 운영 사양이 아니다.

```sh
colima start --profile yumidang-minkyu --activate=false --ssh-config=false \
  --cpus 2 --memory 4 --disk 20 --runtime docker \
  --mount "$PWD:w" --mount /private/tmp:w
db_output="$(TMPDIR=/private/tmp mktemp -d /private/tmp/yumidang-minkyu-db.XXXXXX)"
TMPDIR=/private/tmp python3 -B tools/local/prepare_database.py --output "$db_output"
SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
  DOCKER_HOST="unix://$HOME/.colima/yumidang-minkyu/docker.sock" \
  npx --yes supabase@2.116.0 start --workdir "$db_output"
python3 -B tools/local/run_database_tests.py --run
```

CLI 시작 출력에는 로컬 키가 포함될 수 있으므로 공유 로그·커밋에 넣지 않는다. 준비 도구는 원본 SQL이나 `.env`를 수정하지 않는다. 출력 폴더는 system temporary root 아래의 빈 경로여야 한다. 준비 결과 `sql_execution: NOT_RUN`은 복사만 했다는 뜻이며 이후 DB 실행 성공을 자동 기록하지 않는다.

정식 SQL과 설정의 복사 범위·manifest 필드는 위의 현재 준비 계약을 따른다. 미추적 SQL·사본을 재생 목록에 포함하지 않는다.

같은 project_id의 로컬 DB가 이미 있으면 `start`는 기존 volume을 재사용하므로 신규 SQL 재생을 보장하지 않는다. **테스트만 든 전용 DB임을 확인한 뒤** 새 임시 루트에서 위와 같은 환경 변수로 `npx --yes supabase@2.116.0 db reset --local --workdir "$db_output"`을 실행해 재검증한다. 공유 DB에서 사용하지 않는다.

`run_database_tests.py`는 기본 호출 시 실행 목록과 `NOT_RUN`만 출력한다. `--run`은 지정된 Colima Unix socket·Supabase project label·실행 상태·빈 users/profiles/jobs를 확인한다. DB advisory lock으로 runner 중복 실행을 거절한다. 컨테이너 내부 Unix socket만 사용하며 DB URL·키 입력을 받지 않는다.

- 6개 SQL 파일은 각각 트랜잭션을 rollback한다. 작업 큐 테스트의 임시 TRUNCATE도 rollback된다.
- 경쟁 검증은 서로 다른 실제 연결을 사용한다. 명시적 advisory barrier와 대기 관찰로 중복 enqueue, SKIP LOCKED claim, 게시→비공개, 비공개→오래된 게시, 겹치는 일정의 양측 매칭, 수동/자동 완료 경합을 검사한다.
- 경쟁용 무작위 fixture는 finally에서 이번 ID만 정리하고 잔존 데이터가 없는지 확인한다. 프로세스 강제 종료 시 fixture가 남을 수 있으며 다음 실행은 빈 DB 검사에서 멈춘다. 자동 초기화로 지우지 않는다.
- SQL 결과·환경 비밀 대신 테스트 이름과 PASS/FAIL만 출력한다. 이 결과는 HTTP/Edge/외부 모델/원격 DB/부하 검증을 의미하지 않는다.

검증 종료 후 자원을 정리한다. `stop`은 로컬 volume을 보존하며 자동 기동 서비스를 등록하지 않는다.

```sh
SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
  DOCKER_HOST="unix://$HOME/.colima/yumidang-minkyu/docker.sock" \
  npx --yes supabase@2.116.0 stop --workdir "$db_output"
colima stop --profile yumidang-minkyu
```

공식 설치·실행 근거: [Supabase 로컬 개발](https://supabase.com/docs/guides/local-development/cli/getting-started), [Colima](https://github.com/abiosoft/colima#installation).

## 3차 Auth/JWT·업무 HTTP 검증 — 2026-09-23 기록과 재현 안내

```sh
node --test tests/functions/minkyu/http.test.ts tests/functions/minkyu/auth_db.test.ts tests/functions/minkyu/service_api.test.ts
(cd backend/supabase/functions && deno task check:service)
python3 -B tests/integration/minkyu/runtime_e2e.py --workdir "$db_output"
```

빈 전용 DB와 같은 Docker socket을 사용한다. 통합 검사는 로컬 Auth admin API로 가상 사용자 3명을 만들고 실제 비밀번호 로그인 토큰을 발급받는다. 동일한 `createRuntimeHandler`를 127.0.0.1의 임시 Deno 서버에서 실행하고 실제 Auth/PostgREST/RPC로 무료 공고→신청→양측 매칭→완료→후기 공개→중복 없는 요약 큐를 검증한다. SQL 보조 fixture로 시간과 후기 개수 조건을 준비하므로 실제 24시간 대기나 모델 생성 검사가 아니다. 서버·가상 사용자는 finally에서 정리한다. 자격 증명·본문을 로그로 출력하지 않는다.

로컬 `auth.enable_signup=false`는 일반 가입을 차단한다. `auth.email.enable_signup=true`는 CLI의 이메일/비밀번호 provider를 켜기 위한 설정이다. Mailpit은 로컬 수집기이며 외부 SMTP가 아니다. 현재 네이버 가입·로그인 연동을 구현·검증한 것으로 해석하지 않는다.

`functions.service-api.verify_jwt=false`는 handler의 사용자 Auth 검증과 별도 내부 비밀 검증을 사용하기 위한 설정이다. gateway가 내부 비밀을 사용자 JWT로 거절하지 않게 한다. 인증을 생략하는 공개 업무 경로는 추가하지 않았다. [Supabase custom 인증 안내](https://supabase.com/docs/guides/functions/auth)를 따른다. Supabase Edge 호스팅 자체는 NOT_RUN이고 로컬 기본 edge_runtime도 비활성이다. 배포 전에 Edge 기동·gateway 경로 검증이 필요하다.

**2026-09-23 과거 검증 기록:** 당시 실행 루트는 `/private/tmp/yumidang-minkyu-runtime-20260923-v5`였고, 26개 SQL 재생·rollback 스위트 6개·경쟁 시나리오 6개·HTTP 시나리오 8개가 각각 PASS였다. 마지막 gateway 설정은 당시 실행 후 보완했다. 외부 공급사·모델·배포는 NOT_RUN이었다. 이 기록은 2026-09-28 병합본의 DB/HTTP 재검증 결과가 아니다. 현재 준비 복사본에는 현재 설정이 포함되지만 실제 DB·HTTP 실행 여부는 별도로 확인해야 한다.


## 실제 로컬 Supabase Edge 검증 — 2026-09-29

`prepare_edge.py`는 기존 정식 SQL 준비를 재사용하며 service-api 진입점의 정적 import로 필요한 소스만 새 임시 루트에 복사한다. 현재 작업 파일을 SHA256으로 고정하므로 미커밋 HTTP 준비도 검사할 수 있다. 준비를 실행 성공으로 표시하지 않으며 `edge_execution/sql_execution=NOT_RUN`을 유지한다.

```sh
edge_output="$(TMPDIR=/private/tmp mktemp -d /private/tmp/yumidang-edge.XXXXXX)"
TMPDIR=/private/tmp python3 -B tools/local/prepare_edge.py --output "$edge_output"
```

원본 config는 보존하고 임시 config만 Edge 활성화한다. `edge-manifest.json`의 최종 config 해시와 `database-manifest.json`의 원본 해시는 구분한다. symlink·외부/동적 import·다른 함수·키/.env·사본은 준비 대상에서 제외하거나 거절한다. 새 소스/설정으로 검증하려면 새 임시 루트를 만든다.

전용 Colima를 위 안내대로 시작한 후 **같은 Edge 준비 루트로** Supabase를 시작하고 검사한다. CLI는 모든 함수 폴더를 실행하므로 함수명 인수만으로 범위를 제한한다고 가정하지 않는다.

```sh
SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
  DOCKER_HOST="unix://$HOME/.colima/yumidang-minkyu/docker.sock" \
  npx --yes supabase@2.116.0 start --workdir "$edge_output"
python3 -B tests/integration/minkyu/edge_e2e.py --workdir "$edge_output"
```

기존 volume에 새 SQL이 아직 적용되지 않았다면 빈 전용 DB를 확인하고 로컬 reset을 수행한다. runner는 준비 이후 소스 변동·다른프로젝트/소켓·남은 fixture를 거절한다. 키는 CLI에서 읽어 메모리로 사용하고 내부 설정만0600 임시 env에 기록한다. gateway `/functions/v1/service-api`를 실제 호출하며 standalone Deno 서버로 대체하지 않는다. 사용한 가상 데이터·CLI프로세스그룹·임시env/log를 정리하고, 종료 시 전용 Supabase/Colima stop은 호출자가 수행한다(볼륨 보존).

2026-09-29 당시 결과는 **8개 묶음 PASS + 로컬 gateway CORS 미충족1개 = PARTIAL(exit2)**다. CLI Kong이 GET의 Origin을`*`로 바꾸고 OPTIONS를200/`*`/no-store 없이 응답한다. 앱의 미허용Origin403과 인증은 유지됐다. 이 알려진 차이를 검사 성공으로 숨기지 않는다. exit0은 전체 통과, exit1은 시작/기능 실패, exit2는 검사를 완료했으나 미충족 사항 존재다. 원격운영gateway/배포는 NOT_RUN이다.

[실제 실행 근거·상세 결과·CORS 후속](../../docs/collaboration/requests/minkyu/2026-09-29-edge-handoff.md)을 따른다. 준비 도구 회귀는 `python3 -B tests/database/minkyu/test_edge_tools.py`로 실행한다.
