# 로컬 함수 게이트웨이 CORS 계약

담당: 민규. 기준은 Supabase CLI 2.116.0·Kong 2.8.1과 현재 service-api의 정확한 Origin 계약이다. [이번 하네스](../../docs/collaboration/minkyu-gateway-harness.json)의 지정 경로만 수정한다. **기본 설정 실제82확인 PARTIAL / 같은 하네스의 명시 조정 적용 PASS / 조정 후 실제82확인 PASS**다. 재시작 후 자동 재적용·원격·운영 결과는 NOT_RUN이다. 전체 진행률은43%·6/14이며 로컬 성공을 운영 배포 성공으로 표시하지 않는다.

## 기본 설정과 이전 부분 통과의 원인

고정 CLI 템플릿의 `functions-v1` 서비스는 `/functions/v1/`를 함수 런타임으로 보내며 설정 없는 `cors`와 별도 `request-transformer`를 둔다. 해당 변환기는 함수에 필요한 헤더를 추가하므로 보존한다. [CLI 2.116.0 공식 템플릿](https://github.com/supabase/cli/blob/v2.116.0/apps/cli/src/legacy/commands/start/templates/kong.yml.ts#L182-L204)

Kong 2.8.1 CORS 구현은 기본 preflight를200으로 먼저 끝내고 기본 Origin을 `*`로 설정한다. `preflight_continue=true`는 OPTIONS를 전달하지만 일반 응답의 `header_filter`는 남는다. Origin 목록만 정하면 OPTIONS 선처리가 남고, 한 Origin 설정은 거절 응답에도 헤더를 더할 수 있다. 기존 앱의204/no-store·정확한 허용 Origin·거절 시 허용 헤더 없음과 충돌한다. 함수 서비스의 CORS 플러그인만 제외해 앱에 위임하는 것이 현재 구조의 작은 수정안이다. [Kong 2.8.1 CORS 구현](https://github.com/Kong/kong/blob/2.8.1/kong/plugins/cors/handler.lua)

공식 프로젝트 설정 목록에서 게이트웨이 CORS 덮어쓰기 항목을 확인하지 못했다. `ALLOWED_ORIGINS`, 함수 `verify_jwt`, Auth 복귀 URL을 바꿔 Kong 템플릿을 수정할 수 있다고 설명하지 않는다. 이는 검토한 설정에서 지원 경로를 찾지 못했다는 의미이며 모든 향후 CLI 버전의 불가능을 뜻하지 않는다. [Supabase 설정 목록](https://supabase.com/docs/guides/local-development/cli/config)

## 명시적 로컬 수정 절차

Kong의 DB 없는 모드에서는 엔티티의 PATCH/DELETE로 플러그인을 하나씩 수정할 수 없다. 선언적 설정 전체를 재로드해야 하며 각 노드는 독립이다. [Kong 선언적 설정 설명](https://developer.konghq.com/gateway/db-less-mode/)

2.8.1의 GET `/config`는 현재 캐시에서 내보낸 YAML 문자열을 `{config: ...}`로 반환한다. POST `/config`는 전체 JSON/YAML을 받아 캐시를 재로드하며 성공은201이다. 재로드 응답에도 설정 정보가 있으므로 원문을 출력하지 않는다. 설정 구문 오류·로딩 실패를 성공으로 숨기지 않는다. [고정 버전 설정 API 구현](https://github.com/Kong/kong/blob/2.8.1/kong/api/routes/config.lua)

내보낸 설정의 `_format_version:2.1`, `_transform:false`, 엔티티 ID와 참조를 유지한다. 특히 `_transform:false`를 누락하거나 true로 바꾸어 자격 증명 변환을 다시 적용하지 않는다. 비활성 서비스·플러그인도 임의 제거하지 않는다. [고정 버전 설정 내보내기 구현](https://github.com/Kong/kong/blob/2.8.1/kong/db/declarative/init.lua#L382-L486)

같은 하네스에서 기존 `tools/local/prepare_edge.py --gateway-probe`를 재사용하고 `tools/local/configure_local_gateway.py`를 구현했다. 기본 읽기 READY 뒤 전용 프로젝트에 `--apply`를 실행해 적용 PASS, 조정 후 실제 요청 PASS를 확인했다. [총괄 인계](../../docs/collaboration/requests/minkyu/2026-10-02-gateway-handoff.md)의 실제 결과와 아래 보존 조건을 따른다.

1. 대상이 이번 격리 프로젝트의 Kong이며 DB 없는 고정 버전인지 확인한다. 관리 API를 외부에 새로 공개하지 않는다.
2. 현재 전체 설정을 제한된 경로로 읽어 원본을 메모리 또는0600 임시 파일에 보존한다. 키·자격 증명·전체 설정을 저장소·문서·명령 인수·출력·오류 로그에 넣지 않는다.
3. `functions-v1`과 정확한 `/functions/v1/` 경로를 검증하고 그 서비스에만 속한 `cors` 한 개를 제외한다. 글로벌/다른 경로의 CORS 충돌이나 모호한 구조가 발견되면 적용하지 않고 별도 검토한다. 이미 같은 수정 상태라면 변경 없음으로 판정하되 보존 검사를 생략하지 않는다.
4. 구조를 파싱해 비교한다. 해당 플러그인 외 Auth·REST·Storage·다른 서비스/경로·플러그인·변환기·자격 증명·ID·참조·설정이 동일해야 한다. Kong 재로드가 바꾸는 세 엔티티 목록 순서와 관리 `updated_at`만 유일 ID·단조 증가 정수 검증으로 구분하며 내부 배열 순서는 유지한다. 전체 문자열에서 `cors`를 일괄 삭제하지 않는다.
5. 전체 설정을 안전한 본문으로 POST하고 GET 재조회로 실제 캐시의 변경 범위와 나머지 보존을 확인한다. 실패 시 원본 전체 설정을 복구하며 복구 결과도 확인한다. 동시 설정 변경을 발견하면 오래된 스냅샷을 덮어쓰지 않는다.
6. 실제 게이트웨이 요청으로 아래 응답 계약과 Auth/REST 보존을 검증한다. 파일 생성·구문 검사·캐시 재로드 성공만으로 실요청 PASS를 만들지 않는다.

POST 재로드는 실행 중 메모리 설정을 바꾸며 CLI의 생성 템플릿이나 다음 시작 파일을 영구 변경하지 않는다. 따라서 CLI 재시작·재생성 후 같은 소유 도구의 변환을 다시 적용하고 확인하는 절차가 필요하다. 버전·현재 설정의 구조가 바뀌면 중단한다. 이는 재현 가능한 로컬 준비 절차이며 Supabase 기본 설정 항목의 지원이나 무조건적인 자동 재적용을 뜻하지 않는다.

설정 파서는 호스트 Ruby Psych의 로컬 안전 파싱과 AST 검사를 사용한다. 빈 배열/객체·null·false 종류를 보존하며 다중 문서·별칭/앵커·중복 키·지원하지 않는 구조와 숫자는 거절한다. PyYAML 설치나 네트워크 변환 없이 전체 설정을 메모리에서 처리한다. Kong의 `lyaml==6.2.7` 의존성은 공식 소스 근거지만 단순 `lyaml.load`→JSON 변환은 빈 배열/객체 종류를 잃을 수 있어 현재 도구의 파서로 사용하지 않는다. [공식 Kong 의존성](https://github.com/Kong/kong/blob/2.8.1/kong-2.8.1-0.rockspec#L13-L43), [고정 lyaml 파서](https://github.com/gvvaughan/lyaml/blob/v6.2.7/lib/lyaml/init.lua)

## 실요청 완료 조건

| 요청 | 확인할 결과 |
|---|---|
| 허용 Origin GET·POST | 정확한 해당 Origin 한 개, wildcard 없음, no-store, 기존 인증·응답 형식 유지 |
| 허용 Origin·메서드·헤더의 OPTIONS |204, no-store, 앱 허용 메서드/요청 헤더, 올바른 Vary |
| 미허용 Origin GET·OPTIONS |403, 허용 Origin/자격 증명 등 CORS 허용 헤더를 게이트웨이가 추가하지 않음 |
| 지원하지 않는 preflight 메서드 |405, 허용 헤더 추가 없음 |
| 지원하지 않는 preflight 요청 헤더 |403, 허용 헤더 추가 없음 |
| Origin 없는 서버 요청 |기존 인증 적용, 임의 wildcard CORS 헤더 추가 없음 |
| 잘못된 사용자 토큰·Auth 장애 |기존401/503, 익명·내부 클라이언트로 강등 없음 |
| 공개 상세·회원 전용·내부 secret 경로 |각 기존 권한과 공개 투영 유지, CORS를 인증 대체로 사용하지 않음 |
| 재시작 후 |원본 생성 설정과 명시 변환 결과를 구분하고 재적용/요청/보존을 다시 확인 |

현재 service-api 허용 헤더는 `authorization, content-type, apikey`이며 이 작업에서 임의 확대하지 않는다. 다른 SDK 헤더가 실제로 필요하면 별도 연결 계약과 검사로 반영한다. Supabase는 함수의 preflight 처리 책임을 설명하지만 현재 고정 로컬 Kong과 관리형 환경이 같은 동작이라고 보장하지 않는다. [공식 함수 CORS 안내](https://supabase.com/docs/guides/functions/cors)

## 검증 상태의 구분

- 기본 CLI: 이번 실제82확인의 API·인증 흐름은 PASS, CORS10개는 FAIL로 종합 PARTIAL이다. 이전 [부분 통과 이력](../../docs/collaboration/requests/minkyu/2026-09-29-cors-followup.md)도 보존한다.
- 명시 로컬 모드: scoped 함수 CORS 조정 APPLY PASS. ID·자격 증명·라우팅·설정 보존과 원형 재적용의 의미 일치를 확인했다. 조정 후 같은 실제82확인은 `workflowPassed:true`, `corsPassed:true`, 실패 목록 없음으로 모두 PASS다. 두 실행의 검사 수를 합산하지 않는다.
- 준비11개·조정 도구6개·probe 자체4개 검사도 PASS이며 실제 HTTP82확인과 별도 증거다. 최초 공유 밖 임시 경로의 BOOT_ERROR503은 `/private/tmp`로 다시 준비해 해결했고 CORS 실패와 구분한다.
- 자동 완료 상주 실행기의 실제4그룹·195확인과 합성 자료 정리는 PASS다. 실제 PostgreSQL·본래 CLI에서 시작/과거 예약·committed LISTEN 일정 변경·정확한 세션 단절 재접속·정지 중 예약 후 재시작 복구를 확인했다. 관리자 연결의 로컬 결과이며 운영 최소 권한·원격 연결은 NOT_RUN이다. HTTP82확인과 합산하지 않는다.
- 원격 관리형 환경·영구 재시작 자동 재적용·운영 cron·배포는 NOT_RUN이다. 로컬 성공으로 운영 대상·비밀 설정·프론트 전체 연결이 완료됐다고 설명하지 않는다.

원격 대상의 실제 게이트웨이·허용 Origin·운영 배포·상주 호스트·일일 작업 수치는 별도 입력/검증이 필요하다. 이미 확정된 앱 Origin 경계나204/no-store 계약을 기본 플러그인 결과에 맞춰 완화하지 않는다.
