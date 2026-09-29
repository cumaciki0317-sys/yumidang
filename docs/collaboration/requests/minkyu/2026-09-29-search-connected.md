# 검색 v2 병합·실제 GET 연결 인계

2026-09-29 민규. 사용자 “진행하자” 요청으로 종현 검색 코어를 병합하고 기본 공개 검색을 연결했다. [8차 하네스](../../minkyu-search-connect-harness.json), [독립 검토와 종현 변경 요청](2026-09-29-search-connect-review.md)을 함께 읽는다.

## 병합과 구현

- 종현 `129a871`의 14파일과 민규 `5d43a46`의 20파일은 수정 경로가 겹치지 않았다. 병합 커밋은 `2a53097`이며 종현 14파일은 원문 그대로 반영했다.
- 기본 `createRuntimeHandler(read)`와 lazy `default.fetch`가 GET `/posts`에서 종현 `searchPublicPosts(createRpcPublicPostSearchRepository(db), input)`을 호출한다. 명시 executor 주입도 유지한다. 별도 검색 코어나 RPC 우회 경로를 만들지 않았다.
- 인증 헤더가 없을 때만 익명이다. 헤더가 있으면 실제 Auth 사용자 검증 후 사용자 DB client를 사용한다. 잘못된 JWT를 익명으로 재시도하지 않으며 POST와 기존 업무 API의 인증은 유지한다.
- HTTP 입력 타입을 종현 v2 공유 계약으로 연결했다. 등록일 최신순 기본, 시작일 빠른순 선택, 전체 상태 기본/모집 필터, 익명 기간 허용/상세 나이 거절, 동 표시와 개인정보 분리를 유지한다.
- 연결 진단의 커서 fixture가 이전 시구 형식이라 최신 동 필수 제약에서 멈췄다. 민규 도구의 가상 지역만 실제 SQL 제약에 맞게 갱신했다. 코어 검증을 완화하지 않았다.

## 실제 검증

| 검사 | 결과 |
|---|---|
| 종현 검색 repository/service/discovery | Node 31개 PASS |
| 민규 HTTP·인증/DB·업무 API·검색·진단 | Node 83개 PASS |
| 검색 연결 진단 | 7개 PASS, offline_core_contract READY |
| Deno | 진입점·진단 도구·검색 테스트 3파일 타입 검사 PASS |
| Python | Edge 준비 10개 + 하네스 6개 PASS |
| 실제 Edge gateway→Auth→검색 코어→RPC | 검색 4묶음 PASS |
| 실제 Edge 기존 업무/보안/소스/로그 | 기존 8묶음 PASS |
| 로컬 gateway CORS | FAIL 1개; 전체 PARTIAL(exit2) |
| 보존 | 종현 추적94파일·SQL27개 원문 동일, 병합14파일 원문 동일 |
| 수정 경계 | 종현 직접수정0, 에이전트 수정 중복0 |
| 원격 DB·배포·외부 공급사 | NOT_RUN |

실제 검색 검사 4묶음:

1. 익명 별칭·동·정확히 허용된 카드9필드, 기본 전체 상태와 모집 중 옵션, 무료/유료 필터, 기존 NULL 비용 unknown.
2. 실제 회원 JWT·마스킹 이름·나이 필터·신청 가능성, 익명 기간 검색과 상세 나이401, 위조 JWT401.
3. 등록 주소로 공고가 검색되지만 주소·상세 지점·소개는 카드에 반환하지 않음. 상세 지점·소개는 검색 대상에서 제외.
4. 등록일/시작일 두 정렬 각각 limit1로 모든 페이지를 순회. .123456/.123457 차이와 동일 시각 UUID순에서 중복·누락 없음. v2 마이크로초 보존, 정렬/필터 변경 커서와 v1 커서400.

검사 자료는 가상 사용자3명과 검색 공고4개 및 기존 업무 공고이며 실제 로컬 Auth/DB/Edge를 사용했다. 사용자 가입 공급사 연결을 의미하지 않는다. 검증 후 users/profiles/posts/worker_jobs 잔존0, 실행 소스 해시 일치, CLI 로그의 비밀값·사용자 원문 제외를 확인했다.

## 재현

브랜치는 `minkyu/foundation-harness`, worktree는 `.worktrees/minkyu-foundation`이다. 실제 실행 준비 경로는 `/private/tmp/yumidang-search-connect-edge-20260929`, 기준 HEAD는 `2a53097`이며 미커밋 구현을 해시 고정한 소스36개와 정식 SQL27개를 복사했다. 기본 config는 변경하지 않고 임시 config만 Edge 활성화했다. 소스나 HEAD가 바뀌면 새 임시 폴더로 다시 준비한다.

```sh
node --test tests/functions/jonghyun/search-service.test.mjs tests/functions/jonghyun/search-repository.test.mjs tests/integration/jonghyun/discovery-flow.test.mjs
node --test tests/functions/minkyu/http.test.ts tests/functions/minkyu/auth_db.test.ts tests/functions/minkyu/service_api.test.ts tests/functions/minkyu/search_http.test.ts tests/functions/minkyu/search_runtime.test.ts tests/functions/minkyu/search_core_gate.test.ts
node tools/local/check_search_core.ts
deno check --no-remote backend/supabase/functions/service-api/index.ts tools/local/check_search_core.ts tests/functions/minkyu/search_http.test.ts tests/functions/minkyu/search_runtime.test.ts tests/functions/minkyu/search_core_gate.test.ts
python3 -B tests/database/minkyu/test_edge_tools.py
python3 -B tests/functions/minkyu/test_harness.py
python3 -B tools/collaboration/check_harness.py --manifest docs/collaboration/minkyu-search-connect-harness.json --all-changes
```

[로컬 준비·기동 안내](../../../../tools/local/README.md)에 따라 민규 전용 Colima/Supabase를 같은 새 준비 루트에서 기동한 뒤 실행한다. 실제 이번 결과는 준비 도구의 NOT_RUN과 별개다.

```sh
python3 -B tests/integration/minkyu/edge_e2e.py --workdir /private/tmp/yumidang-search-connect-edge-20260929
```

CLI2.116.0 / Edge Runtime v1.74.3 / Kong2.8.1을 사용했다. runner 종료코드2는 검색 실패가 아니라 아래 CORS 차이를 포함한 PARTIAL이다. 비밀값은 출력하지 않으며 runner의 가상 데이터·임시 비밀파일·functions 프로세스를 정리한다. 전용 Supabase/Colima는 검증 후 종료하고 볼륨·이미지는 보존한다.

## 남은 작업과 담당

- **민규:** 운영 gateway 대상을 정한 뒤 CORS Origin·OPTIONS 정책 확인/설정·실제 검증. 로컬 Kong은 GET ACAO를 `*`로 바꾸고 OPTIONS200/`*`/no-store 없음으로 응답한다. 앱의 미허용 Origin403과 인증은 유지되지만 전체 CORS 계약 충족으로 보고하지 않는다. 운영 환경은 NOT_RUN.
- **종현 요청:** repository에서 잘못된 DB 카드 시각이 사용자 입력 오류400으로 분류되는 비차단 P2를 내부 응답 오류500으로 구분한다. 상세 재현·완료 조건은 독립 검토 문서에 있다. 민규가 종현 코드를 대신 수정하지 않았다.
- **다음 별도 분담 작업:** [종현의 유지보수/모델 분리 요청](../jonghyun/2026-09-29-maintenance-decoupling-request.md). 민규는 모델 설정 없이 자동 완료·후기 공개가 진행되도록 DB/RPC·설정·API 계약을 정리하고, 종현은 합의한 계약에 맞춰 scheduled-jobs 연결을 이어간다. 이번 단계에서는 구현하지 않았고 현재 유지보수는 여전히 모델/프롬프트 버전 설정을 요구한다.
- **별도 미완료:** AI 전체 흐름·프런트 연결·구형 검색 경로 전체 전환, PASS/문자·계좌 공급사, 미정 서비스 정책, 원격 DB/운영 배포. 이번 검색 완료를 전체 백엔드 완료로 해석하지 않는다.

병합 커밋은 로컬에 생성됐으며 이번 연결 구현·문서는 아직 미커밋이다. 원격 푸시와 외부 메시지는 수행하지 않았다. 다음 공유 요청 시 민규 변경만 검사·커밋하여 기존 승인 대상 브랜치에 공유한다.
