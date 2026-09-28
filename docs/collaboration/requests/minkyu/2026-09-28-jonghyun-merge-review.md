# 종현 독립 코어 병합 검토 — 2026-09-28

사용자의 “병합 가능해?” 요청에 따라 민규 전용 로컬 브랜치에서 병합했다. 원격 푸시·공유 backend-work 병합·서비스 배포·실제 공급사 연결은 수행하지 않았다.

## 병합과 보존

- 대상: `minkyu/foundation-harness`, 이전 HEAD `2e07097a7b2af7efd7015319e0ef0cef94770994`.
- 유입: `origin/jonghyun/independent-core-handoff`, HEAD `742a393bb9216c090766dfbf699f49344c96082d`(종현 2개 커밋).
- 병합 커밋: `115600eb94e636ccdc32f98f7e23af2182e18410`, 일반 `git merge --no-ff`, 충돌 0개.
- 공통 기준 `b9acc41` 이후 민규 82개·종현 56개 파일, 수정 파일 겹침 0개. 각각 기존 ownership 정책에 일치함을 병합 전 검사했다.
- 종현 파일은 원격 커밋 그대로 가져왔으며 직접 편집하지 않았다. 기존 민규 구현·SQL 이력·원래 작업 폴더의 사용자 자료를 보존했다. 원격 DB 변경도 없다.

## 이번 검토 작업 분리

작업자는 모두 minkyu다. 총괄은 Git 병합·합본 테스트와 이 문서 및 `docs/collaboration/minkyu.md`만 새로 수정한다. 검색/행사 검토 에이전트와 요약/작업 검토 에이전트는 읽기 전용이며 수정 허용 파일이 없다. 상대 파일 소유권·hook·작업자 설정을 변경하거나 검사를 우회하지 않았다. 일반 merge로 이미 작성된 종현 커밋을 통합했으며 직접 작성한 인계 문서의 커밋에는 민규 소유권 hook을 적용한다.

## 합본 검증 결과

- Node 25.9.0: 민규 47개 + 종현 109개 = **156개 PASS**, 실패/건너뜀 0개.
- Python: 계약 9 + 준비 도구 17 + DB runner 2 + 하네스 단위 6 = **34개 PASS**.
- 합계 **190개 테스트 PASS**. 종현 코어 연결 테스트는 가상 저장소·모델이며 실제 DB 연결 검사가 아니다.
- Deno 2.9.6 / TypeScript 6.0.3: service-api 진입점과 종현 코어·계약·저장소·서비스 등 37개 진입 파일의 의존성 포함 `deno check --no-remote` PASS.
- 병합 후 실제 DB 재생·JWT/HTTP·Edge gateway·외부 공급사·AI 모델·운영 배포는 **NOT_RUN**. 기존 민규의 9월 23일 실제 DB/HTTP PASS 기록과 이번 합본 단위 검사를 구분한다.

```sh
node --test tests/functions/minkyu/*.test.ts tests/functions/jonghyun/*.test.mjs tests/ai/jonghyun/*.test.mjs tests/integration/jonghyun/*.test.mjs
python3 -B tests/contracts/minkyu/test_db_foundation.py
python3 -B tests/database/minkyu/test_local_tools.py
python3 -B tests/database/minkyu/test_database_runner.py
python3 -B tests/functions/minkyu/test_harness.py
```

## 연결 전에 해결할 계약 차이

현재 종현 HTTP 진입점과 실제 저장소 어댑터는 미연결이다. 이번 병합이 기존 민규 API 호출을 교체하지 않으므로 아래 차이가 즉시 실행 회귀를 일으키지는 않는다. 그러나 실제 통합 완료로 보고하거나 단순 이름 변환으로 연결해서는 안 된다.

| 영역 | 차이와 후속 작업 |
|---|---|
| 검색 공개 범위 | 종현 계약은 시·군·구만 반환하지만 기존 검색 RPC는 동까지 포함한 public_area를 반환한다. 공개 범위 합의 후 안전한 반환 projection을 구현한다. |
| 검색 필터·정렬 | 전체 상태·일정 겹침·그룹 정렬·공백 정규화와 기존 DB의 모집 중·시작일 중심 정렬이 다르다. 비용/일정/등록 시각/신청 자격 필드와 동일 정렬의 커서를 맞춘다. 기존 비용 NULL을 무료로 추정하지 않는다. |
| 인증·오류 | 검증된 Principal을 trusted context로 연결하고, 검색 RPC 허용 목록과 종현의 검증/장소 오류를 공통 오류로 명시 변환한다. 사용자 입력의 userId를 신뢰하지 않는다. |
| 행사 DB | 실제 행사 테이블·RPC·RLS·provider+sourceId 유일성·시각 정밀도·페이지 정렬·제공처별 변환이 필요하다. 현재 포트만 존재한다. |
| 요약 데이터형 | targetUserId/profileId, evidenceId/reviewId, comment/text를 맞춘다. 종현 revision은 number, DB bigint revision은 십진 문자열이므로 무조건 Number 변환하지 않는다. |
| 점유 중 게시 | 현재 publish_review_summary에는 jobId/leaseToken 검사가 없다. 같은 revision의 만료 워커도 막으려면 DB에서 점유와 revision·전체 근거를 함께 검사하는 새 계약이 필요하다. |
| 중간 저장 | checkpoint 테이블/RPC가 없다. 점유·revision 검사, 생성 요약/근거 저장, 게시·폐기·원문 변경과의 원자적 삭제를 구현해야 한다. 원문 복제는 금지한다. |
| 게시 멱등성 | 종현은 (jobId,sourceRevision) 단위 게시 효과와 checkpoint 삭제를 요구한다. 게시 후 settle 전 중단에 대비해야 하며 다중 모델 버전과 현재 단일 버전 계약도 맞춰야 한다. |
| 작업 종결·횟수 | 종현 queued/yielded·failed·superseded와 checkpoint 정리가 기존 complete/retry RPC에 없다. DB attempt는 점유 횟수이므로 실패만 세는 failedAttempts로 그대로 넘기지 않는다. |
| 등록·점유 단위 | JSON 형태 중복 키와 DB 허용 문자, 4개 kind와 DB review_summary 전용, 모델/프롬프트 메타데이터, 밀리초/초·오류 allowlist를 명시적으로 맞춘다. |
| 완료/공개 실행 | 종현 약속별 작업 포트와 민규 배치 RPC 호출 방식이 다르다. 예약 실행 연결 방식부터 합의한다. 자동 완료 실제 처리 시각부터 후기 7일 정책은 이미 일치한다. |

종현의 [실제 연결 요청](../jonghyun/2026-09-23-independent-core-integration.md), 민규의 [런타임 인계](2026-09-23-runtime-handoff.md)를 함께 기준으로 삼는다. 외부 AI 보관·비용·운영 한도는 종현 문서의 팀 검토 항목이며 이번 병합으로 승인된 것으로 해석하지 않는다.

## 다음 순서

1. 새 병합 기준으로 다음 구현 하네스와 담당별 정확한 수정 목록을 정의한다. 과거 하네스 baseline은 이전 작업 기록으로 보존한다.
2. 정식 SQL 26개를 처리하도록 `prepare_database.py`의 이전 PENDING 목록·관련 테스트/문서를 갱신한다. 현재 도구를 그대로 실행하면 이미 커밋된 버전 중복으로 중단한다.
3. 위 계약 차이를 범위별로 합의하고 민규는 DB/공통부, 종현은 어댑터/코어를 각각 수정한다. 변경 요청을 상대 요청 문서로 남기며 파일을 직접 교차 편집하지 않는다.
4. 실제 DB 연결을 검증한 뒤 HTTP/예약 실행/모델/외부 API 순으로 별도 연결한다. 공급사·접근 권한·정책이 필요한 단계는 민규 현황의 준비 목록을 따른다.
