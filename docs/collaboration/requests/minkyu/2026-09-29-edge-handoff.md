# 로컬 Supabase Edge·gateway 검증 인계 — 2026-09-29

민규담당. 사용자의 로컬 Edge 실행 검증 요청에 따라 전용 Colima `yumidang-minkyu`와 Supabase `yumidang-minkyu-db`를 사용한다. 기준 HEAD `03aef5c`와 미커밋 6차 HTTP 준비를 보존하며 [7차 하네스](../../minkyu-edge-harness.json)의 총괄/A/B/C 허용 파일만 수정한다.

## 구현과 실행 범위

- `tools/local/prepare_edge.py`: 기존 정식 DB 준비 도구를 재사용해 Git HEAD와 일치하는 SQL27개를 준비한다. 현재 service-api 진입점의 정적 import를 따라 필요한 TypeScript·deno.json만 복사하고 SHA256을 기록한다. 다른 함수·환경파일·키·사본을 복사하지 않는다.
- 원본 config를 보존하고 임시 실행 폴더에서만 edge_runtime.enabled=true를 적용한다. functions.service-api.verify_jwt=false는 기존 함수 자체 인증을 위한 설정이다. 전역 JWT 해제 플래그를 사용하지 않는다.
- `tests/integration/minkyu/edge_e2e.py`: 전용 DB/소켓/프로젝트·빈 fixture·준비 소스 해시를 확인한 후 실제 CLI functions serve를 시작한다. 호스트 standalone Deno 서버로 대체하지 않는다.
- 실제 gateway `/functions/v1/service-api`에서 Auth 검증과 PostgREST/RPC를 호출한다. 가상 로그인 계정은 로컬 Auth admin으로 만들며 PASS·문자 가입 완료를 의미하지 않는다. 사용자/anon/service/worker 자격 증명 구분, CORS/경로/응답, 무료 공고와 양측 매칭·주소 공개 권한, 내부 maintenance secret을 검사한다.
- runner가 CLI 프로세스 그룹·이번 가상 데이터·임시 env/log를 정리하고 총괄이 전용 Supabase/Colima를 중지한다. 로컬 volume은 보존한다.

## 재현

```sh
colima start --profile yumidang-minkyu --activate=false --ssh-config=false \
  --cpus 2 --memory 4 --disk 20 --runtime docker \
  --mount "$PWD:w" --mount /private/tmp:w
edge_output="$(TMPDIR=/private/tmp mktemp -d /private/tmp/yumidang-edge.XXXXXX)"
TMPDIR=/private/tmp python3 -B tools/local/prepare_edge.py --output "$edge_output"
SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
  DOCKER_HOST="unix://$HOME/.colima/yumidang-minkyu/docker.sock" \
  npx --yes supabase@2.116.0 start --workdir "$edge_output"
python3 -B tests/integration/minkyu/edge_e2e.py --workdir "$edge_output"
```

위 start는 기존 volume을 재사용할 수 있으므로 SQL 적용 이력을 별도 확인한다. 필요 시 비어 있는 전용 테스트 DB임을 확인하고 로컬 reset으로 정식 SQL을 재생한다. 공유/운영 DB에서 실행하지 않는다. 첫 시도는 기존 DB 전용 설정에서 시작했지만 gateway 이름 해석 실패(503)를 관찰했다. 전용 환경을 중지한 후 Edge 준비 루트의 설정으로 전체 재시작했고 이름 해석 실패가 사라졌다. 두 설정을 섞어도 항상 실패한다고 단정하지 않으며, 재현 시에는 처음부터 같은 Edge 준비 루트를 사용한다. 실제 DB의 사용자·공고·작업0개와 SQL27개 적용을 확인했다.

이번 Edge 준비 루트는 `/private/tmp/yumidang-edge-20260929-4zmy6jf_`다. `edge-manifest.json`은 현재 작업 소스 34파일과 임시 설정 해시를 기록한다. database-manifest의 config 해시는 원본이며 Edge 실행 설정 해시는 별도로 구분한다. 소스·config가 바뀌면 새 실행 루트를 준비한다. 임시 폴더 장기 보존을 가정하지 않는다.

CLI status·start 원문에는 로컬 키가 포함될 수 있으므로 공유 로그/커밋에 넣지 않는다. runner는 키를 출력하지 않고 임시 env에 프로젝트 전용 설정만 기록한다. `SUPABASE_*` 값은 CLI가 내부 `kong:8000` 주소·키로 주입하며 사용자 env로 덮어쓰지 않는다. CLI 함수명 인수는 격리 수단이 아니므로 준비 폴더에 service-api 하나만 둔다. [독립 호환성 검토와 공식 근거](2026-09-29-edge-review.md)

종료:

```sh
SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 \
  DOCKER_HOST="unix://$HOME/.colima/yumidang-minkyu/docker.sock" \
  npx --yes supabase@2.116.0 stop --workdir "$edge_output"
colima stop --profile yumidang-minkyu
```

## 검증 결과와 다음 작업

최종 결과는 **PARTIAL(exit2)**다. 실제 Supabase CLI2.116.0·Edge Runtime v1.74.3·Kong2.8.1에서 다음8개 묶음이 PASS다: gateway 진입, 실제 JWT/역할 거절, 애플리케이션 Origin 거절/정확경로/검색405, 무료 공고 생성·멱등·충돌·공개 투영, 양측 매칭/확정 당사자 정보, 내부secret 권한, 실행소스 보존, 자격증명/사용자원문 로그 제외. 가상 사용자·프로필·공고·작업 잔존0이다. 전용 Supabase와 Colima 종료 완료, 볼륨과 이미지는 보존했다. 종현89파일/SQL27개 원문 일치와 이전8파일 해시 보존도 확인했다. 준비 도구 Python10개와 하네스6개도 PASS다.

**미충족1개: 로컬 gateway CORS 계약.** 허용 Origin의 GET에도 Access-Control-Allow-Origin이 `*`로 바뀌고, OPTIONS는 앱의204/exact Origin/no-store 대신 gateway의200/`*`/no-store 없음으로 응답했다. 애플리케이션은 미허용 Origin에 실제403을 반환했고 사용자/내부 인증도 유지됐다. 따라서 인증 우회가 확인됐다는 뜻은 아니며, 엄격한 응답 헤더 계약을 충족한 것으로 보고하지 않는다.

고정 CLI의 Kong 템플릿에 CORS plugin이 들어가며 지원되는 config 옵션으로 덮어쓰는 경로는 확인하지 못했다. 검사 통과를 위해 생성된 gateway 설정을 임의 변경하거나 실제 미충족을 PASS로 바꾸지 않았다. 운영 대상 gateway를 정한 뒤 Origin·OPTIONS 정책을 설정/검증해야 하며 **원격 gateway에서 동일 현상이 발생하는지는 NOT_RUN**이다. 근거는 C의 [공식 소스 검토](2026-09-29-edge-review.md)를 따른다.

readiness 판정은 애플리케이션401과 동일requestId로 분리했고 CORS는 독립 검사항목으로 검사한다. 미충족이 있으면 끝까지 업무 검사를 진행한 후 PARTIAL/exit2를 반환한다. 시작 실패는 HTTP상태/공통응답 여부/알려진 실패분류/경과초만 출력하며 원문로그·키를 출력하지 않는다.

최종 결과는 [민규 현황](../../minkyu.md)의 7차 항목에도 기록한다. 이번 로컬 Edge/gateway 검사는 원격 호스팅·운영 배포 검증과 구분한다. 검색 코어 연결은 종현 수정본 검토 후 별도 진행하며 기본 GET `/posts`는 아직405다. PASS/문자·은행 공급사·외부 AI·원격 DB·운영 배포는 NOT_RUN이다.

검증 완료 후 사용자가 이전6차 HTTP 준비와 이번7차 결과를 함께 커밋·푸시하도록 요청했다. 대상은 `origin/minkyu/foundation-harness`다. 문서의 구현 단계 미커밋 표시는 당시 상태이며 실제 공유 여부는 Git 이력과 원격 브랜치로 확인한다. 종현의 파일과 기존 SQL27개는 원문 그대로 보존한다.
