# 종현 검색 v2 정책 동기화 인계

2026-09-29 · actor jonghyun · jonghyun/independent-core-handoff

## 기준과 경계

종현 기준 bd15429에서 확인된 민규 로컬 복제본의 03aef5cc06e0bb5bdee594c874a0fed317983c36을 로컬 fetch와 fast-forward로 반영했다. 원격 최신 조회·공유 브랜치 병합·커밋·푸시는 수행하지 않았다. 민규 원본 복제본은 수정하지 않았다.

[이번 하네스](2026-09-29-search-v2-harness.json)는 수정 허용 12파일을 총괄/A/B/C로 나눈다. 원래 미추적 설계 HTML·Markdown 2개는 별도 보존 해시를 기록했고 수정·이동·스테이징하지 않는다. 과거 하네스/인계와 민규 SQL·인증·클라이언트·HTTP는 보존한다.

## 사용자 답변 적용

| 질문 | 확정한 내용과 미정 유지 |
|---|---|
| Q1 | 첫 완료는 검색 코어·가상 검사·인계까지. 실제 DB/GET·외부 연결은 대기 |
| Q2 | 시간 처리와 요약 분리 설계. [민규 변경 요청](2026-09-29-maintenance-decoupling-request.md) 작성만 이번 범위 |
| Q3 | AI 자연어 정렬·작성자 나이 전달은 다음 AI 단계. 이번엔 기본 검색 코어 재사용 확인 |
| Q4 | 준비된 제공처 한 개부터. 제공처별 준비 상태·첫 대상 입력 없음 → 미정 |
| Q5 | 새로 확정된 항목만 갱신. 모델·예산·외부 보관·품질·수집·운영·지표/중간 저장 입력 없음 → 기존 팀 검토 유지 |
| Q6 | 종현 백엔드 인계 후 화면 담당자 연결. 담당자·대상 화면은 미정 |

## 검색 계약

- sort는 created_desc 기본, starts_asc 선택. 전체 상태 기본/모집 중 옵션. 기간은 겹침 필터이며 모집/기간 그룹 우선 정렬 없음.
- 익명 기간 검색 허용, 나이는 all만. DB public_area 형식·60자와 동/읍/면/가를 유지하며 마지막 지역을 자르지 않음.
- 기존 search_public_posts_v2에 sort 전달. SQL 위치는 {sortAt,id}, 외부 커서는 v2와 정규화 필터/정렬에 결합. 구형/변경 조건은 INVALID_CURSOR.
- 마이크로초·동률 ID와 정렬 방향에 따른 엄격한 커서 진행. starts_asc만 마지막 startsAt과 비교. created_desc 등록 시각을 공개 카드에 추가하지 않음.
- RPC 페이지 순서 보존, 비용 NULL만 unknown, 비공개 추가 필드 거절과 실패의 빈 결과/구형 fallback 금지 유지.
- 과거 정책이 들어간 계약 사례와 AI 연결 기대값 갱신. AI 자연어 sort/age 타입·프롬프트·HTTP와 실제 모델은 변경하지 않음.

상세는 [검색 계약](../../../../backend/contracts/search.md)을 따른다. 전체행 가상 경로의 나이 상세·커서 미지원은 유지하며 페이지 검사는 주입한 페이지 저장소로 구분한다.

## 민규 GET 연결 순서

1. 기존 service-api의 GET /posts에 requireOptionalPrincipal을 연결한다. 헤더 부재만 익명이며 위조·만료·잘못된 헤더를 익명으로 낮추지 않는다. POST 생성의 회원 인증은 유지한다.
2. 익명은 createPublicClient, 회원은 검증 JWT의 createUserClient를 주입한다. caller/userId를 외부 입력으로 신뢰하거나 service-role로 일반 검색을 대신하지 않는다.
3. 종현 searchPublicPosts + createRpcPublicPostSearchRepository를 재사용한다. SQL이 필터·권한·정렬·페이지를 담당하고 별도 검색 코어를 만들지 않는다.
4. 내부 {status,posts,nextCursor}를 공통 data/requestId 응답으로 감싼다. 입력·커서 오류는 INVALID_REQUEST, 익명 상세 나이는 AUTH_REQUIRED, 내부/RPC 오류는 안전한 공통 오류로 매핑한다. 원문을 노출하지 않는다.
5. 조건/정렬 변경 시 화면에서 커서를 버리고 첫 페이지를 요청한다. 구형 list_posts/직접 조회 등 기존 호출 전환과 전체 검색 범위·관계 권한은 민규 후속 검사다.

## 검증 결과

| 범위 | 이번 실제 결과 |
|---|---|
| Node 26.5.0 검색 서비스·RPC 주입·AI 코어 연결 | **PASS 31/31**. 합성 저장소/모델만 사용 |
| TypeScript 5.9.3 strict/noEmit | **PASS**. 검색 타입·서비스·저장소 3개 진입점의 의존 그래프, 캐시된 검사기 사용 |
| 소유권·하네스·기존 자료 | **PASS**. 수정 12파일·담당 중복 0·기존 설계 2파일 해시 보존, 민규 원본 복제본 무변경 |
| 문서 링크·JSON·언어·diff | **PASS**. 변경 범위의 상대 링크/JSON 파싱/언어 혼입/공백 검사 |
| 실제 Deno·DB/RLS·JWT/GET·외부 API/모델·화면·배포 | **NOT_RUN**. 이번 승인 범위 밖 |

검사에는 지역 60자·동/읍/면/숫자 가, 익명 기간/나이, 두 정렬과 상태·기간 조합, 고정된 기대 ID 목록을 사용하는 여러 페이지, 마이크로초/시간대/ID 진행, 구형·변경 필터 커서, 비용 NULL·비공개 필드·장애 전파, AI 기본 검색 순서·비공개 입력 제외를 포함했다.

실행 명령:

```sh
node --test tests/functions/jonghyun/search-service.test.mjs tests/functions/jonghyun/search-repository.test.mjs tests/integration/jonghyun/discovery-flow.test.mjs
```

타입 검사 재현 명령(종현 복제본 기준, 이번 사용한 캐시 경로):

```sh
node /Users/b/.npm/_npx/67eb4586ca667318/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --lib ES2022,DOM,DOM.Iterable backend/supabase/functions/_shared/contracts/search.ts backend/supabase/functions/_shared/services/search-service.ts backend/supabase/functions/_shared/db/repositories/search.ts
```

타입은 캐시된 TypeScript 5.9.3 strict/noEmit으로 검색 타입·서비스·저장소의 의존 그래프를 검사했다. 임시 Deno 선언이나 프로젝트 설정을 추가하지 않는다. 실제 Deno는 NOT_RUN이다.

실제 DB/RLS·JWT/GET·다중 세션 경쟁·외부 API/모델·Edge/Cron·화면·운영 배포는 이번 NOT_RUN. 가상 여러 페이지 검사와 실제 DB 순서/권한, 조회 중 데이터 변경을 고정하는 보장을 구분한다.

## 다음 단계

민규 GET 및 실제 검증 범위가 준비되면 격리 로컬에서 인증·두 정렬·여러 페이지·구형 경로를 검증한다. 외부 제공처와 AI는 계정·응답 예제·명시 모델/예산/보관/품질이 준비된 뒤 연결한다. 요약·예약은 시간 분리 및 점유·중간 저장 DB 보장 수령 후 별도 하네스로 진행한다. 화면 담당이 확정되면 실제 카드·조건 변경 첫 페이지·새 탐색/탐색 종료/로그아웃의 대화 정리를 인수한다.

## 후속 사용자 승인: 종현 브랜치 커밋·푸시

구현·검증 종료 후 사용자가 현재 변경의 커밋·푸시를 명시 요청했다. 앞선 구현 단계의 커밋·푸시 제외는 당시 범위 기록이며, 이번 공유 대상은 `origin/jonghyun/independent-core-handoff`다. 수정 12파일과 원문 해시를 보존한 설계 HTML·Markdown 2파일, 총 14개의 종현 소유 경로를 포함한다. 설계 내용은 변경하지 않았다. 민규 원본 브랜치·공유 브랜치·원격 DB·배포는 변경하지 않는다.

코드 변경이 없으므로 통과한 가상 검사 31개와 타입 검사는 반복하지 않고, 원격 이력·staged 소유권·공백·보존 해시를 확인한다. 기존 하네스의 제외 목록과 preserved_untracked는 구현 당시 경계를 보존한다. 이후 커밋 식별자·푸시 성공 여부는 실제 Git 결과로 확인한다. 다음 구현에는 새 baseline과 허용 목록을 사용한다.

스테이징 검사에서는 보존 원본 `2026-09-29-work-design.md`의 마지막 빈 줄이 `git diff --cached --check`에 잡혔다. 이 파일은 기존 SHA-256과 작업 폴더·staged 바이트가 모두 일치함을 확인해 그대로 보존했다. 해당 원본 한 파일을 제외한 나머지 13파일의 staged 공백 검사와 전체 14파일 소유권 검사는 통과했다. 코드·테스트는 추가 변경하지 않았다.
