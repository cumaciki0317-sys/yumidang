# 검색 HTTP 병렬 준비 — 2026-09-29

민규담당. 사용자가 종현과 동시에 작업을 시작하도록 요청했다. 기준 커밋은 검색 DB·인증 구현이 푸시된 `03aef5c`이고 이번 작업은 그 이후 로컬 변경이다. [6차 하네스](../../minkyu-search-http-harness.json)에서 총괄/A/B/C의 파일을 분리하며 종현 파일과 SQL 27개는 보존한다. 이번 구현의 커밋·푸시·원격 DB 변경·배포는 수행하지 않는다.

## 서로 진행할 일

| 담당 | 이번 진행 | 다음 연결 |
|---|---|---|
| 종현 | search.ts/search-service.ts/search repository와 종현 검사를 최신 검색 정책으로 수정 | 자기 변경을 커밋·푸시하고 완료 근거/민규 요청을 자기 요청 폴더에 기록 |
| 민규 | GET 요청 형식·선택 인증·오류/CORS/응답 처리, HTTP/인증 모형 검사, 검색 코어 준비 상태 진단 | 종현 변경 검토·병합 후 실제 코어를 factory/default fetch에 연결하고 로컬 GET→Auth→RPC 검사 |

종현은 [5차 DB 인계](2026-09-29-search-db-handoff.md)의 정책·RPC 계약을 따른다. 민규가 만든 HTTP 코드를 편집하거나 검색 정책·정렬·커서 처리를 HTTP 쪽으로 옮기지 않는다. 종현과 외부 메신저로 메시지를 보내지 않았다.

## 민규가 준비한 호출 경계

`service-api/search-http.ts`가 `HttpPostSearchInput`, `PublicPostSearchExecutor`, `parsePublicPostSearchQuery`, `mapPublicPostSearchError`를 제공한다. 구체적인 URL 입력과 응답은 [서비스 API 계약](../../../../backend/contracts/service-api.md#검색-http-병렬-준비--2026-09-29)에 있다.

`createRuntimeHandler(read, {publicPostSearch})`에 executor를 명시 주입하면 정확한 GET `/service-api/posts`와 `/functions/v1/service-api/posts`를 처리한다. 익명은 anon 전용 client, 회원은 실제 Auth 검증을 거친 사용자 JWT client를 받는다. caller는 이 결과에서만 만들어지고 query로 받지 않는다. 잘못된 인증을 익명으로 바꾸지 않으며 POST 공고 작성과 나머지 업무의 인증도 유지한다.

익명 상세 나이는 HTTP 권한 경계에서 401로 차단한다. 날짜/기간은 익명도 전달할 수 있다. 정렬은 기본 created_desc/선택 starts_asc다. HTTP는 문자열·enum·중복·기간 두 값·한도를 검사하고 날짜 의미·정규화·커서·결과 투영·정렬·RPC는 종현 코어가 담당한다. 명시된 코어 입력 오류만400, 로그인필요401, 알 수 없는 내부 오류는 원문 없이500으로 반환한다.

아직 준비되지 않은 종현 코어를 기본 실행 경로에 연결하지 않는다. `default.fetch`는 현재 옵션을 주입하지 않으므로 GET `/posts`는 기존 405다. 별도 가짜 정상 결과나 검색 RPC 직접 호출로 종현 코어를 우회하는 운영 구현은 없다.

## 종현 완료 후 민규 연결 순서

1. 종현 브랜치의 새 커밋·미커밋 상태·담당 경계와 최신 인계를 검토한다. 별도 민규 worktree에서 병합한다.
2. `node tools/local/check_search_core.ts`로 실제 가져온 검색 코어가 최신 정책과 v2 wire fixture를 처리하는지 확인한다. 이 검사는 모형 DB이며 실제 DB/배포 준비 완료를 뜻하지 않는다.
3. 검사 통과 후 기존 `searchPublicPosts(createRpcPublicPostSearchRepository(db), input)`를 executor로 조립한다. 최종 타입과 exports는 실제 병합된 코드를 확인한다. HTTP나 AI에 별도 검색 코어를 만들지 않는다.
4. 기본 fetch에 이 조립을 연결하고 실제 로컬 Auth/PostgREST/GET에서 동·이름·정렬·전체/모집·익명 기간/나이·커서·오류·기존 POST 인증을 검증한다.
5. 공통 현황·API 계약을 실제 결과로 갱신한다. Edge 호스팅·AI 전체 흐름·프런트엔드·운영 배포는 각각 실제 검사 전까지 NOT_RUN이다.

## 검증 명령과 상태

```sh
node --test tests/functions/minkyu/search_http.test.ts tests/functions/minkyu/search_runtime.test.ts tests/functions/minkyu/search_core_gate.test.ts
node tools/local/check_search_core.ts
deno check --no-remote backend/supabase/functions/service-api/index.ts
python3 -B tools/collaboration/check_harness.py --manifest docs/collaboration/minkyu-search-http-harness.json --all-changes
```

최종 결과는 Node77개(기존54+새 HTTP/인증19+진단4), Python 하네스6개, Deno5진입 파일 모두 PASS다. [민규 현황](../../minkyu.md)에 기록했다. 코어 진단은 7항목 중 익명 나이 제한·민감 부가 필드 거절 2개 PASS, 기본정렬·시작일순·익명기간·동표시·2필드µs커서 5개 BLOCKED(exit1)로 현재 계약 차이를 확인했다. 종현89추적파일/SQL27개 원문 보존, 민규13파일 경계/중복0 검사도 통과했다. 현재 종현 원격 기준은 `bd15429`이며 새 코어는 아직 통합하지 않았다. 코어 진단이 BLOCKED인 것을 민규 HTTP 모형 검사의 실패나 실제 DB 장애로 해석하지 않는다.

정식 준비 도구에서 현재 HEAD SQL27개/pending0 복사·해시 검사 PASS. 임시 루트 `/private/tmp/yumidang-search-http-3avb8a_o`는 재현 자료이며 장기 보존을 보장하지 않는다. 이번에는 DB를 기동·재생하지 않았으므로 sql_execution=NOT_RUN이다. 5차의 실제 DB 통과 결과와 구분한다.
