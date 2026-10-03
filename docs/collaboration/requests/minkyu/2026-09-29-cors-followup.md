# 로컬 gateway CORS 후속 검토

2026-09-29 민규 11차 하네스 C. 수정 대상은 이 문서 하나다. [기존 Edge 검토](2026-09-29-edge-review.md), [실제 Edge 결과](2026-09-29-edge-handoff.md), [검색 연결 결과](2026-09-29-search-connected.md), 현재 `cors.ts`와 `edge_e2e.py`를 대조했다.

## 판정

**앱 코드 수정 없이 해결할 수 있는 지점은 gateway 설정이지만, 현재 고정 Supabase CLI 2.116.0의 지원되는 프로젝트 설정에서 해당 조정 경로를 확인하지 못했다.** 운영 대상이 정해지지 않은 현재에는 로컬 gateway CORS를 PARTIAL로 유지한다. 생성된 설정을 몰래 수정하거나 기대값을 `*`/200으로 낮춰 PASS로 만들지 않는다. 이번 검토에서 앱·gateway·DB를 변경하거나 실제 서버를 기동하지 않았다.

기존 실제 관찰은 허용 Origin GET의 ACAO가 `*`로 변경되고, OPTIONS가 앱의 204/정확한 Origin/no-store 대신 200/`*`/no-store 없음으로 응답한 것이다. 앱의 미허용 Origin 403과 실제 사용자·내부 인증 거절은 유지됐다. 이 결과를 운영 환경에도 동일하게 적용하거나 새 보안 침해가 재현됐다고 해석하지 않는다.

## 지원 경로와 한계

| 경로 | 공식 근거와 판정 |
| --- | --- |
| 현재 CLI의 `config.toml`/함수 env | v2.116.0 고정 Kong 템플릿의 `functions-v1`에 설정 없는 `cors` 플러그인이 있다. 최신 공식 CLI 설정 목록에도 gateway CORS override 항목을 찾지 못했다. 앱 `ALLOWED_ORIGINS`, `verify_jwt`, auth redirect URL 변경으로 이 템플릿을 조정할 수 있다는 근거가 없다. |
| Kong 자체 설정 | 2.8.1 스키마는 `origins`, `preflight_continue` 등을 지원한다. 이는 Kong 설정 기능이지 현재 Supabase CLI의 노출된 설정 항목이 아니다. |
| 운영자가 관리하는 별도 Kong | 선언적 설정을 명시적으로 관리·재로딩하는 방식은 공식 지원된다. service-api에 적용되는 CORS 플러그인을 제거해 앱에 맡기거나 정확한 origins와 `preflight_continue=true`를 함께 설정하는 방안을 검증할 수 있다. 운영 선택이므로 이번에 채택·적용하지 않았다. |
| 관리형 Supabase 또는 다른 운영 gateway | 대상 endpoint를 정한 후 실제 응답을 확인해야 한다. 함수의 수동 CORS/OPTIONS 처리는 공식 가이드가 지원하지만 로컬 CLI Kong과 관리형 gateway가 동일하게 덮어쓴다는 근거는 없다. 원격 `NOT_RUN`. |

근거: [CLI v2.116.0 고정 Kong 템플릿](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/commands/start/templates/kong.yml.ts), [공식 CLI 설정 목록](https://supabase.com/docs/guides/local-development/cli/config), [Kong 2.8.1 CORS 스키마](https://github.com/Kong/kong/blob/2.8.1/kong/plugins/cors/schema.lua), [Kong 선언적 설정](https://developer.konghq.com/gateway/db-less-mode/), [Supabase 함수 CORS 안내](https://supabase.com/docs/guides/functions/cors).

Kong의 `preflight_continue=true`만으로는 완전한 해결이 아니다. OPTIONS는 upstream으로 넘기지만 일반 응답의 `header_filter`는 여전히 origin을 설정한다. origin 목록이 비어 있으면 `*`를 넣는다. 반대로 `origins`만 설정하면 OPTIONS 200 선처리가 남는다. 따라서 현재 앱이 CORS와 OPTIONS를 함께 책임지는 구조에는 **해당 함수 경로의 CORS 플러그인 제외**가 가장 작은 책임 분리안이다. 유지해야 하는 경우 origins와 preflight 전달을 함께 정하고 앱과 값이 일치하는지 확인한다. `credentials=true`로 wildcard를 단순 반사하게 만드는 우회는 해결안이 아니다. [Kong 2.8.1 실제 구현](https://github.com/Kong/kong/blob/2.8.1/kong/plugins/cors/handler.lua)

운영자가 소유한 설정을 수정할 때에도 다른 함수·Auth·Storage의 CORS까지 일괄 제거하지 않는다. 현재 upstream의 전역/서비스/라우트 플러그인 적용 범위를 확인하고 service-api만 명확히 한정한다. 기본 self-hosted Supabase 템플릿에도 functions CORS 플러그인이 있으므로 self-hosting으로 바꾸기만 하면 자동 해결되는 것도 아니다. [Supabase self-hosted Kong 템플릿](https://github.com/supabase/supabase/blob/master/docker/volumes/api/kong.yml)

## 앱 코드와 실질 영향

현재 `backend/supabase/functions/_shared/http/cors.ts`는 정확한 Origin만 허용하고, 허용 preflight를 204/no-store로 응답하며 메서드·요청 헤더를 검사한다. 이 로직보다 앞에서 끝나는 gateway OPTIONS와 뒤에서 덮어쓰는 응답 헤더는 앱에 헤더를 더 붙여 해결할 수 없다. 현재 `service-api`의 앱 CORS 변경이 필요하다는 근거는 발견하지 못했다.

- OPTIONS 200 자체는 브라우저 CORS 프로토콜 위반이 아니다. Fetch 표준은 preflight의 성공 상태와 CORS 헤더를 검사한다. 여기서 204/no-store는 기존 프로젝트의 더 엄격한 응답 계약이며 임의로 완화하지 않는다.
- wildcard는 `credentials: include` 요청의 읽기를 허용하지 않는다. 반대로 credentials가 include가 아닌 요청에는 허용될 수 있으므로 wildcard가 안전하다는 결론도 내리지 않는다. 실제 브라우저 자격 증명 모드는 프런트 연결 시 확인해야 한다. [Fetch 표준](https://fetch.spec.whatwg.org/#http-cors-protocol)
- 현재 관찰에서는 미허용 Origin의 실제 업무 요청을 앱이 403으로 거절한다. permissive preflight가 사용자 JWT나 내부 secret을 생성하지 않으며, 확인된 인증 우회는 없다. 다만 거절 응답도 gateway의 wildcard가 붙을 수 있으므로 오류 본문은 계속 원문·민감정보 없이 유지한다.
- CORS는 모든 클라이언트의 인증 장치가 아니다. Origin이 없는 서버 요청도 가능하므로 실제 데이터 권한은 기존 Auth·RPC가 책임진다. 이 검토는 Origin 제한을 제거할 이유가 아니다.

프런트 SDK가 추가 헤더를 보내는지는 별도 연결 검사다. Supabase 공식 예시는 `x-client-info` 등을 포함하지만 현재 앱의 허용 헤더는 제한돼 있다. 실제 클라이언트가 필요한 헤더를 확인한 뒤 담당 파일에서 계약·검사를 함께 수정한다. 이 미래 호환성 검사를 이유로 지금 모든 헤더를 허용하지 않는다. [Supabase 공식 SDK 헤더 안내](https://supabase.com/docs/guides/functions/cors)

## 정확한 다음 실행 항목

1. 운영 후보 endpoint와 허용 프런트 Origin, 서버 bearer 방식/브라우저 credentials 모드, gateway 설정의 수정 주체를 확인한다. 도메인·운영 상품을 이 문서에서 임의 확정하지 않는다.
2. 기존 CLI 환경은 원본 그대로 `edge_e2e.py`를 실행해 PARTIAL 기준선을 유지한다. 재실행 시 새 source snapshot과 실제 적용 SQL을 확인하며 총괄의 다른 로컬 DB 검증과 동시에 환경을 재기동하지 않는다.
3. 별도 gateway 검증 환경을 선택했다면 설정 변경을 추적 가능한 파일·차이·롤백 절차로 준비한다. 앱 CORS로 위임하거나 exact origins/preflight 전달을 설정한다. CLI 생성 파일을 즉석 수정한 결과는 기본 CLI 성공으로 기록하지 않는다. 키가 있을 수 있는 전체 gateway 설정을 출력하지 않는다.
4. 허용 Origin의 GET 성공·401/403 오류와 OPTIONS에서 정확한 ACAO, Vary, no-store, 필요한 요청 헤더·메서드, request ID 노출을 검사한다. OPTIONS는 현재 프로젝트 계약대로 204여야 한다. 미허용 Origin의 GET/POST는 실제 처리 없이 거절되고, OPTIONS도 앱 계약의 거절을 유지해야 한다. 임의 헤더·메서드·Origin `null`·누락 Origin도 따로 확인한다.
5. 실제 브라우저에서 허용/비허용 Origin 각각으로 호출하고, 회원 JWT·익명·내부 secret 경계를 다시 검사한다. 프런트가 쓰지 않는 인증 방식이나 허용 헤더를 검사 통과 목적으로 추가하지 않는다.
6. 해당 검증 경로를 명시해 결과를 기록한다. 로컬 CLI PARTIAL, 별도 gateway 결과, 원격 운영 결과를 합쳐 하나의 PASS로 보고하지 않는다.

## 이번 검증 상태

- 완료: 현재 앱·runner 읽기 대조, 고정 버전 공식 소스와 최신 공식 문서 조사, 수정 필요 지점·지원 범위·다음 절차 정리.
- PASS: 문서 소유권·lane C 허용 범위 검사.
- NOT_RUN: 새 CORS 실요청, gateway 설정 변경 실험, 브라우저 검사, 원격 배포.
- 변경 없음: 앱 코드, 계정, gateway, SQL/DB, 종현 파일, 기존 검증 자료, 커밋·푸시.
