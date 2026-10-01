# 민규 DB 연결 기반 — 종현 어댑터용 제안

## 현재 DB 정책 요구

현재 무료 1:1·네이버 전용 가입, 작성자 만 나이 19~99 숫자 필터(전체는 상한 없음), 연결 행사명 검색을 지원해야 한다. 개인 완료 확인 후 선제 후기 제출은 허용하되 실제 완료 전 공개하지 않는다. 실제 완료는 양쪽 확인 또는 종료+24시간 자동 처리이며 완료 시 횟수, 후기 열람 가능 시 당도를 반영한다. 구조화된 이름·주소는 관계 권한과 취소 후 접근 종료를 검사한다. 기존 SQL 조사 표는 그 파일의 동작 설명이며 현재 정식 RPC 전체가 미구현이라는 뜻이 아니다.

상태: DB 어댑터의 책임·권한을 정의하는 설계 계약. 담당: 민규. 실제 RPC는 [검색 DB](public-post-search-db.md)·[후기 DB](review-summary-db.md)·[작업 큐](worker-jobs.md)·[완료 DB](completion-db.md)를 따른다. 의미 이름·가상 예시를 실제 실행 경로로 사용하지 않는다.

기준: [PLAN](../../PLAN.md) 3~6장, [상세 설계](../../PLAN_상세설계.md) 5.5·11.3장, [AGENTS](../../AGENTS.md)의 추가 사용자 결정. 공통 응답은 [conventions](conventions.md)를 따른다. [가상 사례](../../tests/fixtures/minkyu/db-foundation.json)는 어댑터 작성용이며 운영 데이터가 아니다.

## 1. 현재 연결 책임과 필요한 차이

| 영역 | 실제 계약 | 현재 정책 반영 시 확인할 차이 |
|---|---|---|
| 공개 검색 | `search_public_posts_v2`, [검색 DB](public-post-search-db.md) | 기존 연령대 wire를 작성자 만 나이 19~99 숫자 범위로 연결하고 연결 행사명 검색 추가. 정확한 주소는 일치 판단에만 사용 |
| 핵심 서비스 | `create_service_post`·`request_service_post`·`propose_match`·`accept_match`, [핵심 DB](core-service-db.md) | 마감 기본값·핵심 조건 변경·동의 만료/한 명 제한·미선정 종료·취소 후 정보 숨김을 확정 정책과 대조 |
| 완료 | `confirm_appointment_completion`·건별 예약, [완료 DB](completion-db.md) | 개인 완료 확인과 전체 완료를 구분하고 지연 시 실제 완료 시각 사용 |
| 후기 | `submit_appointment_review`·공개 적격성, [후기 DB](review-automation-db.md) | 개인 확인 후 선제 제출·미완료 비공개·완료+24시간·칭찬 6개 구성·지표 시점 구분 |
| 요약·작업 | [요약 DB](review-summary-db.md), [작업 큐](worker-jobs.md) | 공개 적격성·revision·점유·중간 저장·삭제 원자성 및 실제 정식 적용 상태 확인 |

기존 `exact_location` 같은 혼합 자료에서 주소를 임의 추출하거나 기존 후기·가입 기록을 새 자격으로 자동 승격하지 않는다. 네이버 계정·세션 연결과 추후 계좌 효력·분쟁 판정의 세부 검토는 각 계약에서 구분한다. 코드/SQL을 이번 문서 변경으로 갱신한 것은 아니다.

## 2. 공통 호출·오류 경계

아래 이름은 **어댑터 의미 이름**이다. 실제 SQL 함수명·스키마·HTTP URL로 사용하지 않는다. 실제 RPC 매핑은 위 영역별 계약을 따르며 의미 이름을 네트워크 호출에 그대로 쓰지 않는다. 모든 반환 예시는 HTTP 어댑터 관점의 `{data, requestId}` 또는 `{error:{code,message,retryable},requestId}`다. SQL 오류 원문·내부 상태·자격정보를 클라이언트로 전달하지 않는다.

- `caller`는 문서·가상 사례의 검증 전제다. 클라이언트 body의 역할·사용자 ID를 신뢰하지 않고 서버가 인증 결과에서 도출한다. `internal`은 검증된 전용 서비스 호출자이며 공개 API 역할이 아니다.
- 로그인 필요는 `AUTH_REQUIRED`/401, 내부 권한 불충족은 `ACCESS_DENIED`/403, revision·점유 경쟁은 `STATE_CONFLICT`/409로 변환한다. 충돌은 같은 입력의 자동 재전송 대상으로 보지 않아 `retryable:false`다. 최신 상태를 새로 조회한 후 새 요청을 만든다.
- ID·revision·cursor·leaseToken은 불투명 문자열이다. 예시 식별자는 테스트 전용이다. `sourceRevision`은 해당 프로필의 **전체 적격 공개 텍스트 집합** 버전이며 단순 건수·최신 후기 ID로 대체하지 않는다.
- requestId만 상관관계 추적에 쓰며 검색어·대화·후기·생성 요약 원문·leaseToken·비공개 위치는 로그에 저장하지 않는다. 가상 `state`는 테스트용 DB 사전 상태이며 응답·로그에 포함하지 않는다.

## 3. 공개 검색 경계

`searchPublicPosts({query, filters, cursor}) → {items, nextCursor}`. 일반 탐색은 비로그인·회원 모두 가능하고 AI HTTP 진입점은 별도 로그인 검사를 적용한다. `filters`의 제품 정의는 종현 검색 계약과 연결하며 주변·좌표·반경·거리순 정렬은 제공하지 않는다.

- 일치 판단은 제목·등록 장소명·등록 주소·연결된 행사명에 한정한다. 소개·후기·상세 만남 지점은 검색하지 않는다. 등록 주소는 DB 내부 비교에만 사용하며 주소가 검색어와 같더라도 응답에 추가하지 않는다.
- 가상 공개 카드는 `postId,title,publicArea,authorDisplayName`만 사용한다. 실제 제품의 비용·일정 카드 필드는 검색 DB 계약에 명시된 공개 필드를 따른다. 비로그인은 시스템 별칭, 로그인은 마스킹 이름이다. `nextCursor`는 마지막 페이지에서 null이다.
- 정확주소·상세지점·전체실명·원본 `exact_location`·주소 일치 조각·내부 검색 레코드는 일반/AI 검색 결과에서 제외한다. 양쪽 확정 당사자도 이 **공개 검색 경로**에서는 같은 최소 카드를 받고 권한 있는 별도 상세 화면에서 추가 정보를 확인한다.
- 기존 공고의 주소가 분리되지 않았다면 알려진 제목·장소명으로만 일치시킨다. 기존 `exact_location`을 대신 검색하지 않는다. 주소 일치를 통한 위치 추정 가능성이 있으므로 완전한 위치 비밀 보장을 주장하지 않는다.
- 0건은 성공 `{items:[],nextCursor:null}`이다. 관련 예시: `search_address_anon`, `search_address_member`, `search_empty`.

## 4. 공개 후기 snapshot·요약 게시·조회

| 의미 이름·호출자 | 입력 | 성공 data |
|---|---|---|
| `loadPublicReviewSnapshot` / internal | `profileId` | `profileId,sourceRevision,reviews:[{reviewId,text}],eligibleCount` |
| `publishReviewSummary` / internal | `profileId,sourceRevision,evidenceReviewIds,summary,modelVersion,promptVersion` | `summaryId,sourceRevision,sourceCount,publishedAt` |
| `getVisibleReviewSummary` / member | `profileId` | `summary:null` 또는 `summary:{summaryId,text,sourceCount,updatedAt}` |

`load`는 동일 snapshot의 revision·목록·건수를 읽는다. 공개·시간/분쟁 보류 종료·한마디 trim 후 비어 있지 않음이 모두 성립한 후기만 적격이다. 원본 작성자 신원·약속·위치 등은 AI 원문 입력에 붙이지 않는다. 0~2개 조회 자체는 성공이지만 생성·게시하지 않는다. 비로그인 프로필 상세/요약 조회는 `AUTH_REQUIRED`, 일반 회원의 원문 worker 호출은 `ACCESS_DENIED`다.

`publish`는 프로필의 집합 변경과 직렬화 가능한 같은 트랜잭션에서 다음을 검사한다. (1) 현재 revision 일치, (2) 적격 텍스트 후기 3개 이상, (3) 근거 ID가 중복 없이 현재 적격 집합 **전체와 일치**. v1 예시는 전체 집합 요약만 지원한다. 후속 대규모 묶음 요약은 별도 계약으로 다룬다. 실패 시 저장하지 않고 `STATE_CONFLICT`로 반환한다. 모델·프롬프트 버전은 불투명 추적 표식이며 특정 제공사 선택이 아니다.

근거 ID의 존재·집합 일치는 **요약 내용의 사실성 검증이 아니다**. 종현의 생성 경로는 원문에 없는 평가·신원·위치 노출을 검증해야 하고, DB 성공을 이 검증의 대체로 쓰면 안 된다. 검증 경로를 거치지 않은 일반 클라이언트의 게시 접근은 금지한다. 같은 프로필·revision·모델/프롬프트 버전으로 중복 게시하면 첫 저장 결과를 유지하는 조건부 저장을 제안한다.

적격 집합에 영향을 주는 추가·공개/비공개·삭제·시간/분쟁 상태 변경은 revision 증가와 기존 요약 노출 중단을 원자적으로 수행해야 한다. 조회에서도 revision·현재 공개 상태·3개 기준을 다시 확인하며 오래된 요약은 `summary:null`이다. 비공개 전환과 생성 완료 경쟁 시 예전 원문을 다시 올리지 않는다. 캐시도 이 차단을 우회하면 안 된다. 재처리는 별도 작업이며 조회 실패를 모델 호출로 대체하지 않는다.

예시: `snapshot_public`, `snapshot_below_threshold`, `snapshot_denied`, `summary_publish`, `summary_revision_conflict`, `summary_insufficient`, `summary_evidence_conflict`, `summary_visible`, `summary_hidden`, `summary_auth_required`.

## 5. 작업 중복·점유·완료

아래 모두 internal 전용이다. 비로그인/일반 회원 호출은 각각 AUTH_REQUIRED/ACCESS_DENIED로 거절한다. 작업 payload에는 식별자·revision만 담고 대화·후기·요약 원문은 담지 않는다.

| 의미 이름 | 입력 | 성공 data |
|---|---|---|
| `enqueueJob` | `kind,dedupeKey,payload,availableAt` | `jobId,deduplicated,status` |
| `claimJob` | `workerId` | `job:null` 또는 `job:{jobId,kind,payload,leaseToken,leaseExpiresAt,attempt}` |
| `completeJob` | `jobId,leaseToken` | `jobId,status:'succeeded'` |
| `retryJob` | `jobId,leaseToken,availableAt,errorCode` | `jobId,status:'retry_wait'` |

- `(kind,dedupeKey)`는 원자적 유일키다. 요약 키는 프로필·revision·모델/프롬프트 처리 버전을 포함한다. 동일 키+동일 payload는 기존 작업을 반환하며 완료 작업도 재실행하지 않는다. 같은 키의 다른 payload는 STATE_CONFLICT. 보존·정리 기간은 미정이며 먼저 유일성을 삭제해 재실행시키지 않는다.
- `queued` 또는 `retry_wait` 중 `availableAt <= DB now`인 작업 하나를 원자적으로 점유한다. 두 worker 경쟁에서 한 명만 새 토큰을 받는다. 다른 후보가 없으면 `job:null` 성공이다. claim 호출자의 시각·lease 만료값을 받지 않는다.
- `leaseExpiresAt <= DB now`면 만료다. 재점유 시 새 불투명 토큰 발급, attempt 증가. 예시의 1분은 가상값이며 운영 timeout 정책이 아니다. leaseToken은 모델/브라우저에 전달하지 않는다.
- 완료·재시도는 현재 `running`, 토큰 일치, 만료 전을 모두 검사한다. 잘못된 토큰·만료·재점유된 이전 worker는 STATE_CONFLICT로 거절한다. `succeeded` 작업의 완료 요청도 이 v1 계약에서는 충돌이며 내부 상태 조회로 결과를 확인한다.
- 재시도는 현재 lease를 폐기하고 `retry_wait`로 이동한다. 실제 재시도 간격·최대 횟수·회복 불가 상태는 운영 미정 사항이다. 도메인 완료·후기 공개 시점은 민규 공통 RPC 판단에 맡긴다.
- 실행 의미는 최소 한 번이다. lease는 모델 중복 호출·외부 부작용을 완전히 막지 못하므로 요약 게시 등 실제 부작용도 별도 조건부 저장을 사용한다.

예시: `job_enqueue`, `job_duplicate`, `job_payload_conflict`, `job_claim`, `job_competing_claim`, `job_reclaim`, `job_complete`, `job_stale_token`, `job_expired`, `job_retry`, `job_denied`.

## 6. 검증·연결 상태

```sh
python3 -m unittest discover -s tests/contracts/minkyu -p 'test_db_foundation.py' -v
```

이 검사는 가상 계약의 공개 필드·snapshot 적격성·revision/근거 거절·중복키·lease 경쟁 사례 불변조건과 잘못된 사례를 거절하는 능력을 확인한다. SQL·RLS·실제 경쟁 상태·모델 품질 검증은 아니다. 이 가상 계약 검사에서는 실제 DB·migration 재생·네트워크를 실행하지 않는다. 별도 실행 이력은 영역별 계약·인계에 있고 이번 문서 작업에서 재실행하지 않았다.

후속 실제 연결의 완료 조건은 익명/일반/당사자/내부 권한 테스트, 주소 일치 후 비공개 반환 차단, 같은 transaction의 revision·공개 상태 재검증, 비공개 전환 중 생성 경쟁, 두 worker 동시 claim·만료 토큰 차단, 양쪽 수동 완료·자동 완료 경쟁의 로컬 DB 테스트다. 종현은 이 제안·가상 자료로 자기 파일에서 어댑터를 작성하고 실제 RPC가 생기기 전에는 가상 결과를 운영 성공으로 노출하지 않는다. 실제 RPC 이름·공개 카드는 영역별 계약을 따르고, 새로운 필드·운영 수치·대규모 요약 연결 변경은 후속 계약과 검증으로 반영한다.
