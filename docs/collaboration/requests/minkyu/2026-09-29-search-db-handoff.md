# 최신 검색 정책 DB·공개 인증 인계 — 2026-09-29

담당 민규. `minkyu/foundation-harness`의 기준 `bd15429` 이후 로컬 구현이다. [5차 하네스](../../minkyu-search-db-harness.json)에서 총괄/A/B/C 수정 파일을 분리했다. 구현 완료 후 사용자가 커밋·푸시를 요청했으며 공유 대상은 `origin/minkyu/foundation-harness`다. 원격 DB 변경·배포는 포함하지 않는다.

## 구현한 계약

- [DB 계약](../../../../backend/contracts/public-post-search-db.md): `search_public_posts_v2(p_filters,p_cursor,p_limit)` 반환은 `{items,nextCursor}`. 신규 SQL 한 개이며 기존 26개 이력은 변경하지 않는다.
- 등록일 최신순 `created_desc`가 기본, 시작일 빠른순 `starts_asc` 선택. 상태 기본 전체/`recruiting` 선택. 날짜 겹침은 필터이며 모집/기간 그룹을 정렬 앞에 붙이지 않는다.
- 동까지 공개. 익명 기간 검색 허용, 나이는 `all`만 허용. 공개 카드의 익명 별칭/회원 마스킹을 유지하며 확정 당사자 전체 이름은 별도 관계 권한 경로다.
- 키워드는 제목·등록 장소명·등록 주소에만 일치한다. 일치한 주소·상세 지점·소개·생년월일·실명 원본은 카드에 반환하지 않는다.
- SQL 커서는 `{sortAt,id}`이며 UTC 마이크로초를 유지한다. 다음 페이지는 같은 필터/정렬로 호출한다. HTTP 커서의 필터 결합·버전 변경은 종현 구현 대상이다.
- nullable `category/periodStart/periodEnd`는 생략과 동일하다. 기간 한쪽만 있는 경우 거절한다. 기본 20/최대 50은 기존 기술값이다. 유료 등록을 활성화하지 않으며 기존 비용 NULL을 무료로 바꾸지 않는다.
- [인증 계약](../../../../backend/contracts/auth-runtime.md): `requireOptionalPrincipal`은 Authorization 자체가 없는 경우만 null. 잘못된 인증을 익명으로 낮추지 않는다. `createPublicClient`는 anon key로 v2 검색 하나만 허용하며 `createUserClient`는 실제 검증한 사용자 JWT로 v2를 호출한다.

## 종현담당 다음 수정

자기 브랜치에서 최신 민규 변경을 받은 후 아래 파일을 담당 범위에서 수정한다. 민규 파일을 직접 수정하지 않는다.

1. `backend/contracts/search.md`, `_shared/contracts/search.ts`: 동 허용·익명 기간 허용·정렬 입력 `created_desc/starts_asc`와 새 커서 계약 반영.
2. `_shared/services/search-service.ts`: 기존 익명 기간 거절과 모집/기간 그룹 우선 정렬 전제를 제거하고 나이 all 제한·카드 비공개 필드 거절 유지.
3. `_shared/db/repositories/search.ts`: RPC 이름을 v2로 연결하고 sort 전달, `{sortAt,id}` 변환, µs 보존. 구형 cursor는 버전 검증으로 거절하고 필터/정렬 변경 시 초기화한다.
4. 종현 테스트: 동 카드, 익명 기간/나이, 두 정렬, 기본 전체/모집 필터, 페이지 중복/누락, 비공개 필드 제외를 새 계약으로 검증한다. AI도 최신 검색 코어를 재사용한다.

`_shared/`는 `backend/supabase/functions/_shared/`다. 기존 동 거절·익명 날짜 제한·구형 커서 코드가 남아 있어 **GET 검색 API 연결 완료가 아니다.** 종현 코어가 맞춰지면 민규가 기존 서비스 HTTP 진입점에서 optional principal → public/user client → 종현 검색 service/repository를 연결하고 실제 GET 검사를 추가한다. 중복 검색 코어를 만들지 않는다.

## 검증과 재현

전용 Colima `yumidang-minkyu`, Supabase `yumidang-minkyu-db`, PostgreSQL 17.6, CLI 2.116.0을 사용한다. 원격 URL을 입력받지 않는 검사다. 이번 임시 실행 루트는 `/private/tmp/yumidang-search-v2-20260929-cir5lkiy`.

이번 검증 당시 정식 준비 도구는 기준 HEAD의 26개만 준비했다. 이번 검증에는 검토한 신규 `20260929090000_public_search_v2.sql` 한 개만 임시 폴더에 따로 복사하고 `search-v2-pending.json`에 해시를 기록했다. 모든 미추적 SQL 자동 포함이나 ` 2.sql` 사본 재생은 하지 않았다. 신규 SQL 커밋 이후에는 일반 준비 도구가 정식 27개로 인식한다.

```sh
python3 -B tools/local/run_database_tests.py --run
python3 -B tests/integration/minkyu/search_rpc_e2e.py --workdir /private/tmp/yumidang-search-v2-20260929-cir5lkiy
python3 -B tools/collaboration/check_harness.py --manifest docs/collaboration/minkyu-search-db-harness.json --all-changes
```

최종 검증은 SQL 재생 27개, SQL 스위트 7개, 경쟁 사례 6개, 실제 Auth/PostgREST 시나리오 6개, Node 21개, Python 16개와 Deno 타입 검사 모두 PASS다. 기존 SQL 26개 보존·하네스 17파일 경계·담당 중복 0도 확인했다. 최종 결과는 [민규 현황](../../minkyu.md)에 함께 기록했다. 검증 후 가상 데이터 잔존 0을 확인하고 전용 Supabase/Colima를 중지했으며 볼륨은 보존했다. 실제 Auth/PostgREST 검사는 민규 TypeScript 인증/DB 클라이언트를 직접 호출하며 아직 GET 라우트를 검사하지 않는다. 구형 list_posts 등 검색 호출 전체 전환·AI/프런트엔드·Edge 호스팅·외부 공급사·원격 배포는 `NOT_RUN`이다.
