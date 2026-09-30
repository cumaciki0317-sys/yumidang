# 종현 lane E 기록 — 장소 HTTP·첫 행사 공급사·행사 DB (5.4)

- 작성: 2026-09-29, 종현 담당(lane E). 기준 HEAD `ff9c14f`, 브랜치 `minkyu/foundation-harness`. 기존 미커밋 37개 파일의 SHA256은 작업 종료 시점에도 모두 일치했다.
- 범위: [하네스](2026-09-29-claude-implementation-harness.json)의 lane E 파일만 수정했다. 민규 소유 설정·HTTP·DB 클라이언트·마이그레이션·계약 문서는 읽기만 했고, 필요한 변경은 아래 “민규 요청”에 적었다.
- 커밋·푸시·원격 DB 변경·배포는 하지 않았다. 로컬 Supabase/Colima의 시작·중지·초기화도 하지 않았다.

## 결과 요약

| 항목 | 결과 | 근거 |
|---|---|---|
| places HTTP(handler/index) | PASS(가상 검사) | `places-http.test.mjs` 8/8. 실제 Edge/gateway 실행은 NOT_RUN |
| Kakao 403 원인 진단 | 403 재현 안 됨 | 실제 GET 1회 = HTTP 200, 문서 1건. 이전 403의 원인은 특정하지 못함(아래) |
| 행사 공급사 HTTPS 확인 | KOPIS 준비됨 / 서울 BLOCKED / TourAPI NOT_READY | 키 없는 HTTPS 확인(아래) |
| KOPIS transport·정규화 | PASS(가상 11/11) + 실제 1회 PASS | 실제 응답 HTTP 200, 5건, 정규화 PASS |
| 행사 DB 제안 SQL | PASS(격리 로컬 DB, ROLLBACK) | `events.sql` PASS, 실제 KOPIS 5건 두 번 저장 → 중복 0 |
| events repository(RPC) | PASS(가상) + 실제 SQL 출력 호환 확인 | `event-sync.test.mjs` 안 저장소 검사 + ROLLBACK DB 출력 대조 |
| event-sync HTTP | PASS(가상) | `event-sync.test.mjs` 12/12. 기본 내부 클라이언트로는 저장 단계 500(민규 허용 목록 대기) |
| 공개 행사 조회 HTTP | NOT_RUN(민규 요청) | 종현 소유 공개 경로 없음. service-api GET 경로 요청 |
| 타입 검사 | NOT_RUN | Deno·tsc 미설치. Node 타입 제거 실행만 확인 |

## 실키 호출 전 명시한 검증 계획 (호출 전 기록)

- 공급사: KOPIS 공연목록(`pblprfr`) — 키 없는 HTTPS 확인이 먼저 끝난 유일한 공급사.
- 목적지: `https://kopis.or.kr/openApi/restful/pblprfr` (고정 host·path, redirect 금지, 키는 스크립트 안에서만 읽음)
- 검증 기간: **2026-10-05 ~ 2026-10-11** (7일, 공식 최대 31일 이내)
- 페이지: `cpage=1`, `rows=5` — 한 페이지만. 추가 페이지·재시도 없음.
- 출력: HTTP 상태, 공급사 결과 코드 유무, 항목 수, 정규화 PASS/FAIL만. 원문은 저장소에 저장하지 않는다.

## 외부 확인 사실 (키 없는 확인)

### KOPIS — 준비됨

```sh
curl -sS -D - -o /dev/null 'https://www.kopis.or.kr/openApi/restful/pblprfr?stdate=20261001&eddate=20261001&cpage=1&rows=1'
curl -sS -D - 'https://kopis.or.kr/openApi/restful/pblprfr?stdate=20261001&eddate=20261001&cpage=1&rows=1'
echo | openssl s_client -connect kopis.or.kr:443 -servername kopis.or.kr | openssl x509 -noout -subject -issuer -dates -ext subjectAltName
```

- `https://www.kopis.or.kr/...` → HTTP/2 **301**, `Location: https://kopis.or.kr/...`(같은 경로·query).
- `https://kopis.or.kr/...` → HTTP/2 **200**, `content-type: application/xml`, TLS 검증 성공. 본문은 API 오류 envelope `<dbs><db><returncode>02</returncode><errmsg>SERVICE KEY IS NOT REGISTERED ERROR</errmsg><responsetime>…</responsetime></db></dbs>` — 즉 같은 API가 HTTPS로 응답한다.
- 인증서: subject `CN=www.kopis.or.kr`, SAN `www.kopis.or.kr, kopis.or.kr`, 발급 Sectigo RSA DV, 유효 2025-11-12 ~ 2026-12-13. **만료 전 갱신 여부는 운영에서 재확인 필요.**
- HTTP(`http://www.kopis.or.kr/...`)도 같은 envelope를 반환하지만 키를 HTTP로 보내지 않는다.
- 공식 가이드 v5.0(PDF, 2026-04-23 배포) 대조: 운영 주소는 `http://www.kopis.or.kr/openApi/restful/pblprfr`, “전송레벨암호화: 없음(SSL 미표시)”. 박스오피스 예시 등은 `http://kopis.or.kr/...`(apex)를 쓴다. 요청 항목 `service, stdate, eddate(최대 31일), cpage(3자리), rows(최대 100)`, 응답 항목 `mt20id, prfnm, prfpdfrom, prfpdto, fcltynm, poster, area, genrenm, openrun, prfstate`. 목록 API에는 가격·주소·명시 취소 상태·공식 상세 페이지 주소가 없다. 코드표(`kopis_openapi_code_v3.7`)는 이번에 확보하지 못했다.
- 결론: 문서상 HTTP이지만, 같은 host 계열의 HTTPS가 실제로 API envelope를 반환하고 인증서가 두 이름을 모두 포함하므로 **apex `https://kopis.or.kr`를 고정 목적지로 사용**한다. www의 301은 따르지 않는다(redirect: "error").

### 서울 열린데이터 — BLOCKED(HTTPS 없음)

```sh
curl -sS -o /dev/null -w '%{http_code}' 'https://openapi.seoul.go.kr:8088/sample/json/culturalEventInfo/1/1/'
curl -sS -o /dev/null -w '%{http_code}' 'http://openapi.seoul.go.kr:8088/sample/json/culturalEventInfo/1/1/'
```

- `https://…:8088` → TLS 실패(curl: `tlsv1 alert protocol version`, Node: `ERR_SSL_WRONG_VERSION_NUMBER`). 8088 포트는 평문 HTTP다.
- `https://openapi.seoul.go.kr/…`(443) → Node 연결 시간 초과(10초).
- `http://…:8088/sample/…`(공개 sample 키) → HTTP 200 JSON, `RESULT.CODE=INFO-000`. 즉 API는 HTTP로만 확인됐다.
- 서울 키는 URL 경로에 들어가므로 HTTP 전송 시 평문 노출이다. **실키 호출 없음.** 공식 HTTPS 주소가 확인될 때까지 연결하지 않는다.

### TourAPI — NOT_READY

- 로컬 `.env`의 `TOUR_API_KEY_FORMAT`이 빈 값(= unknown). 설정 계약상 unknown은 요청 금지. **호출 없음.**

### Kakao 403 진단 — 실제 GET 1회

- 요청: `GET https://dapi.kakao.com/v2/local/search/keyword.json?query=%EC%84%9C%EC%9A%B8%EC%97%AD&page=1&size=1`, `Authorization: KakaoAK <키>`, redirect: "error". 키는 Node 스크립트 안에서 `yumidang/.env`의 한 줄만 읽었고 argv·출력에 넣지 않았다.
- 결과: **HTTP 200**, `application/json; charset=utf-8`, `documents` 1건, `errorType`/`code` 없음(오류 메시지 없음).
- 키 형식: 32자리 소문자 16진수(REST API 키 형식과 일치). 값은 출력하지 않았다.
- 해석: 현재 이 작업 공간의 키로는 키워드 검색이 동작한다. 이전 403(민규 기록, 다른 컴퓨터의 `.env`와 curl로 실행)의 원인은 이번 한 번으로 특정할 수 없다(키 파일 차이, 이후 콘솔 설정 변경, 일시 상태 등 가능). **“해결됨”으로 표시하지 않는다.** 이번 응답 본문은 places 어댑터에 넣어 검증하지 않았으므로(호출 1회 제한) 실제 응답의 어댑터 변환은 NOT_RUN이다.

## 실제 KOPIS 1회 호출 결과

- 목적지·기간·페이지: 위 계획 그대로(2026-10-05~2026-10-11, cpage=1, rows=5). 구현한 `createKopisEventProvider`로 호출했다.
- 결과: **HTTP 200, application/xml, 공급사 오류 envelope 없음, 5건, 정규화 PASS**, 다음 페이지 가능(`hasMore=true`, 5건 꽉 참).
- 관찰(원문 아님): region 값 `대전광역시/인천광역시/부산광역시/서울특별시`, category 값 `서양음악(클래식)/연극/대중음악`, placeName 모두 있음. 문서에 없는 요소는 없었다.
- 원문 응답은 저장하지 않았다. 정규화 결과는 scratchpad에 임시 저장 후 DB 검증 뒤 삭제했다.

## 실제 격리 로컬 DB 검증(ROLLBACK)

- 대상: `run_proposals.py`와 같은 전용 Colima `yumidang-minkyu` / `supabase_db_yumidang-minkyu-db`, 빈 DB 확인 후 `BEGIN → 04_events.sql → 검사 → ROLLBACK`.
- 가상 검사: `python3 -B tests/database/jonghyun/run_proposals.py --proposal docs/collaboration/requests/jonghyun/2026-09-29-claude-proposed-sql/04_events.sql --test tests/database/jonghyun/events.sql` → `PASS tests/database/jonghyun/events.sql`, `tests=1 failed=0`.
- 실제 정규화 페이지 저장(임시 SQL을 `/private/tmp`에 만든 뒤 실행 직후 삭제): 첫 저장 `insertedCount=5`, 같은 페이지 재저장 `insertedCount=0, updatedCount=5`, 저장 행 5, 공개 목록 5, 입장료 unknown 5. ROLLBACK 뒤 `private.events` 없음 확인.
- 음성 대조: 일부러 틀린 단언을 넣은 실행은 실패(exit 3)로 감지됐다.
- SQL↔TS 호환: 같은 방식으로 만든 가상 3건(날짜·시각 정밀도 섞음)의 `list_public_events` 실제 출력 2페이지를 `createRpcEventRepository().listPage`의 엄격 검사에 넣어 통과(커서 전달 포함) 확인.

## 구현 내용

| 파일 | 내용 |
|---|---|
| `functions/places/handler.ts` | `createPlacesHandler(deps)`. GET `/functions/v1/places`·`/places`, query·page 두 값만(page 1..45, 검색어 1..300자, 제어문자 거절), 회원 인증 → `PlaceLookupContext{principal:{kind:"member",userId}}`, `PlaceLookupError` → INVALID_REQUEST/AUTH_REQUIRED/EXTERNAL_UNAVAILABLE 매핑, 응답은 PlaceLookupResult 필드만 다시 투영, CORS GET 전용 |
| `functions/places/index.ts` | `createPlacesRuntime(read, fetchImpl?)` + Deno 진입점. `loadRuntimeConfig`·`requirePrincipal`·`loadKakaoConfig(read).apiKey`(명시 접근)·`PLACES_PAGE_SIZE`(필수 1..15)·`timeoutMs=config.upstreamTimeoutMs`. 장소 설정은 인증된 장소 요청에서만 읽고 실패는 503(캐시 안 함). import는 env를 읽지 않음 |
| `_shared/integrations/events/kopis.ts`(신규) | 고정 `https://kopis.or.kr/openApi/restful/pblprfr`, 기간(양 끝 포함 ≤31일)·페이지(1..999)·rows(1..100) 명시, redirect 금지, 시간 제한·취소, 엄격한 평면 XML 파서(선언·`dbs/db`·속성 없는 단일 수준 요소·표준 entity·CDATA만 허용), 200 안의 `returncode` envelope = 실패(02→SOURCE_AUTH_REJECTED, 그 외→SOURCE_REJECTED), 문서 밖 요소·중복 ID·rows 초과 거절, 정규화(날짜 정밀도, `prfstate` 공연예정/공연중/공연완료 = active, 그 외 값은 오류, 입장료 unknown, publicAddress·sourceUrl null) |
| `_shared/integrations/events/port.ts` | `EventFetchRequest.page` 추가, `sourceUrl: string \| null`, `EventProviderError` 추가 |
| `_shared/integrations/events/normalize.ts` | sourceUrl null 허용(값이 있으면 기존 검사 유지) |
| `_shared/db/repositories/events.ts` | 기존 helper 유지. `syncEventPage`가 `fetchedCount` 추가 반환·저장소는 upsert만 요구. `createRpcEventRepository(db)`: `upsertBySourceIdentity`(정확한 wire 투영, 중복 식별자 사전 거절, 집계 검사), `listPage(query, cursor, limit)`(정규화 조건, 불투명 커서 v1 = 조건 지문+{rank,key,id}, limit 1..50, 응답의 필드·상태·조건·정렬·커서 일치 검사) |
| `functions/event-sync/handler.ts` | POST `/functions/v1/event-sync`·`/event-sync`, 내부 인증 뒤 본문 정확히 `{provider, period:{start,end}, page}` 검사, 응답 `{status:"synced", provider, fetchedCount, savedCount, hasMore}`. 공급사·정규화 실패 503, 저장 권한 오류(구성 문제)·집계 불일치 500 |
| `functions/event-sync/index.ts` | `createEventSyncRuntime(read, fetchImpl?, {createRpcClient?, now?})` + Deno 진입점. 허용 목록·상한 환경값 필수, 제공처 등록부는 KOPIS만. 기본 저장 client는 민규 `createInternalClient`(우회 transport 없음) |
| `proposed-sql/04_events.sql`(신규) | `private.events`(unique(provider, source_id), RLS, 직접 권한 없음), `upsert_events`(service_role 전용, 엄격 검증, 삭제 없음, 오래된 수집본은 덮어쓰지 않음, 집계 반환), `list_public_events`(anon·authenticated, DB now() 하나, 한국 달력/주간, 모드·진행 중·기간 겹침·취소 제외·키워드·지역/종류, 그룹→정렬값→id keyset) |

### 설계상 선택과 이유(편차 포함)

1. **sourceUrl nullable로 변경.** KOPIS 목록 API·가이드에 공식 상세 페이지 주소 규칙이 없다. 공개 포털 페이지(키 없는 GET 2회)는 Next.js 앱이라 상세 링크 규칙을 정적으로 확인하지 못했다. 키가 포함된 API 주소나 추정 주소를 넣지 않고 null로 둔다. 기존 테스트는 모두 통과한다. **영향: lane C `result-builder.ts`는 행사 카드의 sourceUrl이 문자열이 아니면 `MISSING_EVENT_SOURCE`로 전체를 실패시킨다** → 총괄/lane C 확인 필요(아래).
2. KOPIS `hasMore`는 전체 건수가 없어 “꽉 찬 페이지”로만 판단한다. 다음 페이지가 실제로 0건일 수 있다.
3. KOPIS “최대 31일”은 양 끝 포함 31일로 보수 해석했다(가이드 예시가 모순).
4. 공급사 region/category는 원문 그대로 저장한다(예: `서울특별시`, `서양음악(클래식)`). 앱 분류(공연·전시 등)·동 단위 지역으로 매핑하지 않았다 → 조회 필터 값의 화면 연결은 미정(열린 질문).
5. 장소 검색어 길이 300은 기존 공고 검색 HTTP 경계(`search-http.ts`)의 기술 한도를 그대로 따랐다. `list_public_events`의 limit 1..50도 기존 `search_public_posts_v2`와 같다. 새 운영 정책 값이 아니다.
6. 조회 커서는 스냅샷이 아니다. 조회 사이에 시간이 지나 상태 그룹이 바뀐 행은 페이지 경계에서 누락·중복될 수 있다(공고 검색 커서와 같은 성격).
7. 오래된 수집본(collectedAt이 저장본보다 과거)은 `staleCount`로 세고 덮어쓰지 않는다. `savedCount = inserted + updated`.
8. event_sync를 worker_jobs 큐 작업 유형으로 추가하지 않았다(자동 완료·큐 범위 밖). 24시간 호출은 lane S(scheduled-jobs)가 위 HTTP 계약으로 호출한다.

## 환경 변수(이름·용도만)

| 변수 | 용도 | 비고 |
|---|---|---|
| `PLACES_PAGE_SIZE` | Kakao 키워드 검색 size | 필수, 1..15, 기본값 없음 |
| `KAKAO_REST_API_KEY` | Kakao REST 키 | 민규 `loadKakaoConfig` |
| `EVENT_SYNC_PROVIDERS` | 수집 허용 제공처(쉼표 구분) | 필수. 현재 구현은 `kopis`만 허용 |
| `EVENT_SYNC_MAX_PERIOD_DAYS` | 한 요청 최대 기간(양 끝 포함 일수) | 필수, 허용 제공처 규격 이하(KOPIS 31) |
| `EVENT_SYNC_MAX_PAGE` | 요청 가능한 최대 페이지 | 필수, KOPIS 999 이하 |
| `EVENT_SYNC_PAGE_ROWS` | 한 페이지 rows | 필수, KOPIS 100 이하 |
| `KOPIS_API_KEY` | KOPIS 서비스 키 | 민규 `loadKopisConfig` |
| 공통 | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `INTERNAL_WORKER_SECRET`, `UPSTREAM_TIMEOUT_MS`, `MAX_REQUEST_BYTES`, `ALLOWED_ORIGINS` | 민규 `loadRuntimeConfig` |

값(행 수·기간·페이지)은 운영 결정이며 이 문서에서 정하지 않았다.

## 민규 요청

| # | 대상 | 변경 | 이유 | 기대 동작 | 완료 조건 |
|---|---|---|---|---|---|
| M1 | `backend/supabase/migrations/`(새 파일) | `proposed-sql/04_events.sql` 검토 후 정식 마이그레이션 채택(BEGIN/COMMIT) | 행사 저장·조회 DB가 없다 | `private.events`·`upsert_events`·`list_public_events` 생성, 권한은 제안 그대로 | 로컬 재생 + `tests/database/jonghyun/events.sql` PASS |
| M2 | `_shared/db/internal-client.ts` | `internalRpcs`에 `upsert_events` 추가 | 현재 event-sync 기본 저장이 transport 허용 목록에서 거절(ACCESS_DENIED→500) | 내부 인증 뒤 service-role로 upsert | `event-sync.test.mjs`의 “기본 내부 클라이언트 … 500” 검사를 성공 기대로 바꿀 수 있음 + 실제 Edge POST에서 `status:"synced"` |
| M3 | `_shared/db/public-client.ts`, `_shared/db/user-client.ts` | 허용 목록에 `list_public_events` 추가 | 공개 행사 조회는 anon·회원 모두 가능 | 헤더 없음=anon client, 회원=user client | 두 client로 RPC 호출 성공 |
| M4 | `service-api/routes.ts`·`service-api/*`(공개 GET) | `GET /events` 추가: 인증은 공고 검색과 같게(헤더 없음=익명). 쿼리 ↔ RPC: `mode`(overlapping/new_this_week/post_selection), `periodStart`·`periodEnd`(YYYY-MM-DD, 둘 다 또는 둘 다 없음 → period), `ongoingOnly`(true/false), `query`, `region`, `category`, `cursor`(불투명), `limit`(1..50). 실행은 `createRpcEventRepository(db).listPage(query, cursor, limit)` | 종현 소유 공개 경로가 없다 | 응답 `{events, nextCursor}`. 오류: `INVALID_EVENT_*`/`UNSUPPORTED_EVENT_FILTER`/`INVALID_QUERY_PERIOD`/`INVALID_EVENT_CURSOR`/`INVALID_EVENT_LIMIT` → INVALID_REQUEST, `INVALID_EVENT_REPOSITORY_RESPONSE` → INTERNAL_ERROR | 익명·회원 GET 실제 확인, 조건 변경 커서 400 |
| M5 | `.env.example`·함수 배포 설정 | 위 환경 변수 이름 추가, `places`·`event-sync` 함수에 주입 | 기본값이 없어 미설정 시 503 | 명시 값으로만 동작 | 값은 팀 결정 후 입력 |
| M6 | `backend/supabase/config.toml` 등 함수 설정 | `places`(회원 JWT)·`event-sync`(내부 비밀 Bearer) 함수 진입 설정 확인 | gateway JWT 검증 방식이 함수별로 다르다 | 내부 비밀이 gateway에서 JWT로 거절되지 않음 | 로컬 Edge에서 두 함수 호출 확인 |
| M7 | `backend/contracts/search.md`(총괄 소유) | 행사 조회·수집 계약에 이번 RPC·HTTP·sourceUrl null 반영 | 문서 동기화 | — | 총괄 반영 |

## 총괄·다른 lane 확인 사항

- **lane C**: KOPIS 행사는 `sourceUrl: null`이다. 현재 `_shared/ai/Agents/chatbot/result-builder.ts`는 행사 행의 sourceUrl이 문자열이 아니면 `MISSING_EVENT_SOURCE`를 던진다. 실제 행사 목록을 AI 결과에 연결하면 전체 응답이 실패한다. null 허용(링크 없는 카드) 여부를 결정해야 한다.
- **lane S**: 24시간 행사 갱신은 `POST /functions/v1/event-sync`에 내부 비밀로 `{provider:"kopis", period:{start,end}, page}`를 보낸다. 응답 `hasMore=true`면 다음 페이지를 별도 요청해야 한다(자동 진행 없음). 어느 기간·몇 페이지를 수집할지는 운영 결정이다.

## 열린 질문(사실 포함)

1. KOPIS `stdate/eddate`가 “기간과 겹치는 공연”인지 “기간 안 시작 공연”인지 가이드에 명시가 없다. 실제 5건은 모두 창과 겹쳤지만 규칙 확정은 아니다.
2. KOPIS 오류 코드표(v3.7)를 확보하지 못했다. 관찰된 코드는 `02`(키 미등록)뿐이다. 그 외 코드는 모두 SOURCE_REJECTED로 처리한다. 명시 취소 공연을 목록 API가 어떻게 표현하는지도 미확인이다(현재 알 수 없는 prfstate 값은 페이지 전체 실패).
3. KOPIS 공식 상세 페이지 주소 규칙(→ sourceUrl) 확인 방법: 공식 문의 또는 공식 포털의 문서화된 링크 규칙.
4. KOPIS 인증서 만료 2026-12-13 — 갱신 후에도 HTTPS가 유지되는지 운영 전 재확인.
5. 공급사 region/category 원문을 앱의 지역(동 단위)·분류 필터와 어떻게 연결할지 — 매핑은 만들지 않았다.
6. 서울 열린데이터의 공식 HTTPS 주소 존재 여부 — 확인 전 연결하지 않는다. TourAPI 키 형식(encoded/decoded) 확인 필요.
7. Kakao 이전 403의 원인 — 현재는 200. 다른 환경의 키/설정에서 재현되면 그때 응답 `errorType`/`code`를 확인한다.

## 검사 명령과 결과

```sh
node --test tests/functions/jonghyun/event-provider.test.mjs   # 11/11 PASS
node --test tests/functions/jonghyun/places-http.test.mjs      # 8/8 PASS
node --test tests/functions/jonghyun/event-sync.test.mjs       # 12/12 PASS
node --test tests/functions/jonghyun/event-service.test.mjs tests/functions/jonghyun/places.test.mjs  # 34/34 PASS(기존, 수정 없음)
node --test tests/functions/jonghyun/*.mjs                     # 153/153 PASS(실행 시점, 다른 lane 파일 포함)
node --test tests/integration/jonghyun/discovery-flow.test.mjs # 5/5 PASS
python3 -B tests/database/jonghyun/run_proposals.py \
  --proposal docs/collaboration/requests/jonghyun/2026-09-29-claude-proposed-sql/04_events.sql \
  --test tests/database/jonghyun/events.sql                    # PASS, failed=0 (rolled back)
python3 -B tools/collaboration/check_ownership.py --actor jonghyun --paths <lane E 14개 경로>  # 통과
```

- 타입 검사(Deno check/tsc): NOT_RUN(도구 미설치).
- 실제 Edge/gateway·CORS·배포·원격 DB: NOT_RUN.
