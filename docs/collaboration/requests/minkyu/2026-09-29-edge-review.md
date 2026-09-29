# 실제 로컬 Edge 진입점 독립 검토

작성: 2026-09-29, 민규 7차 하네스 C. 대상 CLI는 캐시에서 확인한 Supabase 2.116.0이다. 코드 호환 근거와 실제 실행 결과를 구분한다.

## 검토 판정

현재 `service-api/index.ts`의 default 객체에 `fetch`를 내보내는 형태는 Supabase 공식 HTTP 진입점 계약에 맞는다. `createRuntimeHandler`는 import 시 환경을 읽지 않고, default fetch의 첫 요청에서 설정을 읽는다. 따라서 종현의 미완성 검색 코어를 주입하거나 진입점을 다시 만들 필요가 없다. [Supabase 공식 사용 예제](https://supabase.com/docs/reference/server/usage-examples)

`if (import.meta.main) Deno.serve(entrypoint.fetch)`는 직접 실행 시 서버를 시작하는 별도 경로다. Deno 문서는 `deno run`의 명시적 `Deno.serve`와 `deno serve`의 default fetch 로딩을 구분한다. 이 조건문의 Supabase user worker 실행 여부는 문서만으로 확정하지 않는다. 실제 Edge에서 요청이 도달하는지 확인한 뒤 문제가 있으면 최소 수정한다. 현재 7차에서는 index.ts를 수정하지 않았다. [Deno serve 공식 설명](https://docs.deno.com/runtime/reference/cli/serve/)

`verify_jwt=false`는 gateway의 JWT 검사를 끄는 설정이다. 사용자 경로의 Auth `/user` 검증과 내부 경로의 별도 secret 검증은 기존 handler에서 계속 수행한다. OPTIONS가 gateway에서 막히지 않는지, 잘못된 사용자 JWT와 내부 secret이 애플리케이션의 공통 오류로 거절되는지는 실제 gateway 검증 대상이다. 전역 `--no-verify-jwt`로 범위를 넓히지 않는다. [Supabase 공개 함수 설정](https://supabase.com/docs/reference/server/usage-examples)

## CLI 2.116.0 환경 확인

공식 버전 소스의 `startEdgeRuntimeContainer`는 함수 컨테이너에 `SUPABASE_URL=http://kong:8000`, 프로젝트의 anon key·service role key를 주입한다. 같은 소스의 `filterCustomEnv`는 env 파일·설정에서 시작 이름이 `SUPABASE_`인 사용자 값을 제외한다. 따라서 테스트 env에 호스트용 `http://127.0.0.1:55421`이나 Supabase 키를 복사해 덮어쓰지 않는다. 기존 `env.ts`는 내부 `kong` 호스트의 HTTP를 이미 허용한다. [CLI v2.116.0 serve 소스](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/shared/functions/serve.ts)

`ALLOWED_ORIGINS`, `UPSTREAM_TIMEOUT_MS`, `MAX_REQUEST_BYTES`, `INTERNAL_WORKER_SECRET` 등 프로젝트 전용 값은 임시 env에 제공한다. 키·secret 값은 결과나 문서에 출력하지 않는다. 일반 Deno 실행과 CLI 함수 실행은 env 파일 로딩 방식도 다르다. [Supabase 환경 변수 설명](https://supabase.com/docs/guides/functions/secrets)

실제 캐시 바이너리의 `functions serve --help`는 positional 함수 이름을 legacy 인수로 표시하며 모든 함수를 제공한다고 안내한다. 그러므로 이름 인수만으로 종현 함수의 실행을 막았다고 판단하지 않는다. 준비 snapshot은 `service-api` 진입점과 필요한 공유 파일만 포함한다. CLI 도움말 호출에는 `SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1`을 설정했다.

## 확인 결과와 남은 검증

| 항목 | 이 검토의 결과 |
|---|---|
| CLI 버전·실제 help | PASS — 캐시 package 2.116.0, serve 도움말 실행 |
| 공식 default fetch 계약 | PASS — 공식 문서에서 확인 |
| 내부 URL·예약 env 이름 처리 | PASS — v2.116.0 공식 소스 및 동일 캐시 바이너리의 포함 코드 확인 |
| 기존 환경 URL 허용 | PASS — `env.ts`의 `kong` 허용 읽기 확인 |
| 실제 Supabase Edge gateway → handler | NOT_RUN — C 단독 검토 시점. 총괄이 실행하고 7차 인계에 별도 기록 |
| 실제 Edge → Auth → RPC | NOT_RUN — C 단독 검토 시점. B 통합 도구로 검증 예정 |
| 운영 배포 | NOT_RUN — 이번 범위 밖 |

실제 Edge 오류가 확인되기 전에는 index.ts를 변경하거나 Node import 검사와 같은 대체 검증을 추가하지 않는다. 실제 실행 결과는 [7차 Edge 인계](2026-09-29-edge-handoff.md)를 따른다. 이 검토 문서의 문헌 PASS를 호스팅 완료로 해석하지 않는다.

## 첫 gateway 실패에 대한 후속 읽기 검토

총괄의 첫 실제 실행은 gateway 503과 `name resolution failed`를 반환했다. 이 결과는 위 사전 검토 시점의 NOT_RUN과 구분하며, 실제 성공 결과가 아니다. handler에 도달했다는 증거가 없으므로 `service-api/index.ts`는 수정하지 않는다.

CLI v2.116.0의 `start`와 `functions serve`는 Edge 컨테이너 생성용 `startEdgeRuntimeContainer`를 공유한다. 함수 제공 경로는 전용 네트워크에 `edge_runtime` 별칭을 등록하고, 생성 후 Kong을 reload한다. 따라서 Go와 TypeScript 구현 차이만으로 네트워크 이름 충돌을 확정할 수 없다. [CLI 함수 실행 소스](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/shared/functions/serve.ts)

Kong의 함수 upstream은 `EdgeRuntimeId`로 렌더링한 컨테이너 이름의 8081 포트다. `kong` 별칭은 Edge에서 Auth/RPC에 접근할 때의 반대 방향 주소이므로, 그 별칭이 정상이라는 사실만으로 gateway에서 Edge로 가는 DNS가 정상임을 입증하지 못한다. [CLI Kong 템플릿](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/commands/start/templates/kong.yml.ts)

다음 검사는 실제 Kong 설정의 함수 upstream URL 한 줄, 해당 이름과 `edge_runtime`의 컨테이너 내부 DNS, Edge의 실행 상태·네트워크·8081 접근 결과를 대조한다. Kong 전체 설정은 키가 포함될 수 있어 출력하지 않는다. 총괄이 일관된 Edge 준비 경로에서 로컬 스택을 다시 시작해 확인한다. 이 재시작의 결과와 최종 판정은 7차 인계에 기록한다.

## 재기동 후 handler 도달 및 gateway CORS 차이

총괄은 Edge를 활성화한 준비 설정으로 다시 기동한 뒤 `/me` 요청에서 애플리케이션의 401·공통 requestId·no-store를 확인했다. 따라서 첫 DNS 실패를 진입점 코드 오류로 해석하지 않는다. 현재 index.ts를 그대로 실제 Edge가 실행했다는 증거이며, 이 근거로 진입점 수정은 하지 않는다.

동시에 허용 Origin 요청의 응답 `Access-Control-Allow-Origin`이 앱이 지정한 단일 origin 대신 `*`로 관찰됐다. CLI v2.116.0의 고정 Kong 템플릿은 functions-v1 서비스에 설정 없는 cors 플러그인을 추가한다. 이 부분은 사용자 origin을 받을 템플릿 항목이 없고, 검토한 공식 CLI 설정 문서에서도 해당 플러그인의 origin을 바꾸는 지원 옵션을 찾지 못했다. 이를 임의의 `config.toml` 키로 해결했다고 기록하지 않는다. [고정 Kong 템플릿](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/commands/start/templates/kong.yml.ts), [CLI 설정 목록](https://supabase.com/docs/guides/local-development/cli/config)

Kong 공식 cors 구현은 origin 목록이 없으면 응답 헤더에 `*`를 설정한다. 기본 preflight 처리도 upstream으로 전달하지 않고 gateway에서 응답한다. 따라서 gateway의 OPTIONS 응답을 handler의 CORS 검사 통과로 세지 않는다. [Kong CORS 구현](https://github.com/Kong/kong/blob/2.8.1/kong/plugins/cors/handler.lua), [Kong CORS 설정](https://docs.konghq.com/hub/kong-inc/cors/configuration/)

판정은 **로컬 gateway의 CORS 헤더 덮어쓰기 관찰, 엄격한 origin 헤더 검증 미충족**이다. 이를 readiness와 분리해 Auth·RPC·업무 응답 검사는 계속할 수 있지만, CORS 검사를 성공 처리하거나 앱의 origin 제한을 `*`로 완화하지 않는다. 비허용 Origin 실제 업무 요청이 앱에서 403으로 거절되는지도 별도 검사한다. gateway 설정을 임시 수정하는 경우에는 원래 CLI 환경의 성공으로 혼합하지 말고 별도 실험으로 기록해야 한다. 이번 C 검토에서는 gateway 설정과 앱 코드를 변경하지 않았다. 원격·운영 gateway의 동작은 NOT_RUN이다.
