# 종현 공개 검색·후기 요약·예약 실행 연결 인계

2026-09-28 · 작업자 jonghyun · `jonghyun/independent-core-handoff`

## 기준과 범위

사용자 승인에 따라 설계안을 종현 소유 코드·계약·검사로 구현했다. 시작 시 깨끗한 전용 복제본의 `742a393`에서 민규 복제본의 커밋 `f8d02b8dc6492c1584eed8762728845fe7ae335c`를 로컬 fetch와 fast-forward로 반영했다. 이력을 보존했다. 구현 단계의 커밋·푸시 제외는 아래 최신 승인으로 갱신됐다. 민규 원본 복제본은 수정하지 않았다.

정확한 기준과 담당별 허용 경로는 [이번 하네스](2026-09-28-connection-harness.json)다. A는 검색 타입/서비스와 요약 계약, B는 검색 어댑터와 작업 등록, C는 해당 검사, 총괄은 예약 실행과 계약/현황/인계를 맡았다. 기존 민규 전용 check_harness.py를 우회 변경하지 않았다. lease.ts/retry.ts는 이미 실패 횟수와 정상 재개를 구분하므로 수정하지 않았다.

## 완료한 종현 코드

- 기존 검색 계약·서비스에 unknown 비용, 날짜/작성자 나이의 익명 제한, 입력 한도와 커서, 시군구 공개 검사, 마이크로초 시각 비교를 반영했다.
- 공통 RpcClient 주입형 search_public_posts_v2 어댑터를 만들었다. DB의 페이지 순서와 조건을 보존하며 다시 필터링/정렬하지 않는다. 비용 NULL만 unknown으로 바꾸고 잘못된 카드·부가 비공개 필드는 거절한다. 기존 가상 전체행 경로는 유지했다.
- 요약 sourceRevision을 전 구간 정규 십진 문자열로 유지한다. 작업의 modelVersion/promptVersion과 실행 설정 및 checkpoint가 일치해야 하며 실제 사용 모델 modelVersions는 별도로 남긴다. 지원 프롬프트는 review-summary-v1이다.
- 실제 연결용 createReviewSummaryRegistry는 review_summary만 등록한다. 기존 4종 가상 실행 코어는 운영에 자동 활성화하지 않는다. 중복 키는 기존 SQL과 같은 review_summary 접두사와 대상/revision/모델/프롬프트 버전을 사용한다.
- scheduled-jobs는 공통 내부 인증 후 기존 maintenance HTTP를 호출한다. 명시 limit 1..100을 전달하고 완료·후기 공개 정책을 재구현하지 않는다. 자동 재시도/운영 주기/기본 배치값을 정하지 않았다. 모델·프롬프트 설정이 없으면 호출하지 않는다.

확정 계약은 [검색](../../../../backend/contracts/search.md)과 [리뷰 요약](../../../../backend/contracts/review-summary.md)에 있다. 비용 미확인은 신청 불가, 기존 이름 마스킹 유지, 날짜/나이 회원 전용, 현재 확정 약속은 확정·완료/취소/분쟁/불발은 마감이며 상세 사유를 카드에 넣지 않는다.

## 민규에게 필요한 첫 검색 연결

1. `GET /functions/v1/service-api/posts`를 추가한다. POST 생성의 회원 인증은 유지한다. 인증 헤더 부재만 익명이며 위조·만료·잘못된 헤더는 거절한다. 클라이언트 입력 caller/userId는 권한으로 받지 않는다. 중복/알 수 없는 인자·커서 오류는 400 INVALID_REQUEST, 익명 기간/나이 제한은 401 AUTH_REQUIRED다.
2. 공통 DB 클라이언트의 RPC 허용 목록과 익명/검증된 회원 클라이언트를 연결한다. service-role로 일반 검색을 실행해 DB 권한 제한을 우회하지 않는다. `search_public_posts_v2(p_filters jsonb,p_cursor jsonb,p_limit integer)`를 추가하고, filters는 query/category/cost/availability/periodStart/periodEnd/authorAge, cursor는 periodGroup/recruitingGroup/sortAt/id로 맞춘다. 실제 타입은 SQL 구현 시 이 JSON 계약을 만족해야 한다.
3. 반환은 `{items:[공개 카드],nextCursor:정렬 위치|null}`다. 카드에는 id/title/authorDisplayName/publicArea/startsAt/endsAt/cost/state/canApply만 둔다. DB에서 cost:null은 확인된 과거 비용 미상만 의미한다. 현재 free-only 등록 규칙과 원본 과거 NULL을 보존한다. 유료 유형/금액 오류를 NULL로 덮지 않는다.
4. DB에서 모든 필터·권한·상태·신청 자격·정렬·페이지를 처리한다. query는 제목/등록 장소명/등록 주소에서 검색하고 상세 지점은 제외한다. 기간은 겹침과 시작그룹, 모집 여부, 시작/등록시각, ID 순으로 정렬한다. limit 기본20/최대50, cursor시각은 µs 보존이다. signed cursor나 snapshot 고정은 추가하지 않는다. 커서는 권한 증거가 아니므로 DB도 매번 조건·권한을 검사한다.
5. 현재 public_area CHECK는 시도·시군구·선택구·마지막 동읍면가 형식이다. 마지막 토큰을 제거해 공개하고 원본은 보존한다. 기존 mask_real_name과 한국 날짜 만 나이를 유지하고 비회원에게는 단일 시스템 별칭만 반환한다. 생년월일을 응답하지 않는다.
6. 기존 search_public_posts/list_posts·posts 직접 SELECT·상세 RPC도 점검한다. 동 단위 지역이나 비회원 날짜/나이 제한을 우회할 수 있으면 전체 연결 완료가 아니다. 현재 저장소 코드에서 이 우회 경로가 남아 있으므로 이번 종현 코어 준비와 전체 공개 검색 완료를 구분한다.

상태 판정은 삭제 제외 → 현재 확정 약속 → 완료/취소/분쟁/불발 → 모집 기한/시작 시각 경과 → 모집 중 순이다. canApply는 실제 신청 규칙으로 계산하고 실제 신청 시 재검사한다. 미확인 비용·비회원·모집 종료는 false다.

## 민규에게 필요한 요약·예약 연결

- 조회/중간 저장/게시마다 현재 작업자·lease token·만료를 검사한다. public-review snapshot 필드(profileId 등)를 targetUserId/evidenceId/comment 계약에 맞춘다. bigint를 JS 숫자로 파싱하지 않는다.
- checkpoint에는 생성 중간 요약·근거·진행 위치·revision·요청 버전만 저장한다. 후기 원문 복제 금지. 게시할 때 현재 revision·공개 자격·전체 근거 집합을 재검사한다.
- 게시와 checkpoint 삭제를 원자 처리한다. 게시 후 작업 settle 이전에 중단되어도 같은 작업/revision은 내용·게시 시각·알림을 중복 갱신하지 않는다. 멱등 재호출도 현재 점유/공개 자격을 검사한다.
- 폐기·최종 실패·후기 변경 때 관련 checkpoint를 원자 삭제한다. failedAttempts와 claim 횟수를 분리하고 yielded/재개/deferred는 실제 실패로 세지 않는다. 작업 상태 및 반환형을 종현 포트에 연결하는 실제 어댑터는 이 DB 보장 뒤 구현한다.
- 후기 변경의 revision 증가·요약 무효화·재작업 예약(outbox) 기록을 같은 트랜잭션에 유지한다. 실제 큐 등록은 process_review_automation을 거친 maintenance가 한다.
- 예약 진입점은 `POST /functions/v1/scheduled-jobs`, 내부 Bearer 인증, body `{limit}`다. 호출 목적지는 설정된 Supabase의 `POST /functions/v1/service-api/internal/maintenance`로 고정한다. 클라이언트가 URL/버전/권한을 바꿀 수 없다.
- 기존 공통 설정은 SUPABASE_URL/ANON_KEY, INTERNAL_WORKER_SECRET, SERVICE_ROLE_KEY, ALLOWED_ORIGINS, UPSTREAM_TIMEOUT_MS, MAX_REQUEST_BYTES를 요구한다. 공통 내부 검증에 service-role 설정이 필요하지만 예약 bridge는 전송에 worker secret만 사용한다. 두 REVIEW_SUMMARY_*_VERSION도 명시 설정해야 한다. maintenance는 버전 설정이 없으면 자동 완료도 시작하지 않는다.
- 실제 Edge gateway에서 사용자 JWT가 아닌 내부 secret 인증을 처리하도록 service-api/scheduled-jobs의 설정을 민규가 확인한다. 이를 위해 공통 config.toml을 종현이 바꾸거나 실제 Cron을 등록하지 않았다. 운영 주기·배치 크기·재시도 값은 팀 검토 상태다.

## 검증 결과와 남은 증거

| 범위 | 결과 |
|---|---|
| 검색 서비스·RPC 주입 어댑터·AI 코어 연결 | PASS 27/27. 첫 검사에서 UUID 검증 및 기존 가상 지역 형식 문제를 찾아 수정 후 해당 범위 재검사 |
| 리뷰 요약·작업 실행 | PASS 39/39. 큰 문자열 revision·버전·점유 손실·분할 재개·게시 후 중단 복구는 가상 저장소/모델 검사 |
| 예약 handler·maintenance 주입 fetch | PASS 7/7. 내부 인증·고정 목적지·명시 limit·설정 누락·응답 최소화·실패 전파 |
| TypeScript 5.9.3 strict/noEmit | PASS. _shared 및 scheduled-jobs 83파일, 임시 최소 Deno 선언 사용 |
| 소유권·하네스 변경 범위·diff 공백 검사 | PASS. 변경/신규 23개 경로가 허용 범위에 포함. baseline/브랜치·로컬 Markdown 링크도 PASS |
| 실제 search SQL/DB/RLS·JWT/GET HTTP·다중 페이지 DB 순서 | NOT_RUN. 민규 변경 및 실제 DB 준비 후 검증 |
| 실제 요약 DB 원자성·모델 품질·Edge/Cron·브라우저 | NOT_RUN. 인터페이스/가상 성공으로 대체하지 않음 |
| Deno 실제 타입/런타임 검사 | NOT_RUN. 현재 PATH에 Deno 없음 |

이번 실행은 Node 26.5.0의 합성 검사 총73개다. 통과한 검사는 새 변경/실패/미해결 문제 없이 반복하지 않았다. 예약 검사의 만료/위조 사용자 JWT 거절은 내부 worker 인증 경계이며 공개 검색 JWT 검증 성공을 뜻하지 않는다. DB 페이지 누락/중복과 SQL 시간 정밀도는 실제 통합 검증으로 남겼다.

재현 명령(이번 통과 기록이며 재실행 지시가 아님):

```sh
node --test tests/functions/jonghyun/search-service.test.mjs tests/functions/jonghyun/search-repository.test.mjs tests/integration/jonghyun/discovery-flow.test.mjs
node --test tests/functions/jonghyun/jobs.test.mjs tests/ai/jonghyun/review-summary.test.mjs
node --test tests/functions/jonghyun/scheduled-jobs.test.mjs
```

행사 DB/제공처 변환, AI 허용 관심사·대화 성향·MBTI 조회, 실제 모델·예산·지표 연결은 후속 인계 사항이다. 첫 검색 작업에 함께 구현하지 않았다. 구현 단계에서는 원격 DB 변경·배포·커밋·푸시를 수행하지 않았다. 아래 후속 승인에서 종현 브랜치 커밋·푸시만 추가됐다.

## 후속 사용자 승인과 현재 민규 기반 재검토

사용자는 민규 작업이 남아 종현의 실제 연결 대기가 필요하면 `jonghyun/independent-core-handoff`에 커밋·푸시하도록 승인했다. 2026-09-28 재검토에서도 민규 HEAD는 f8d02b8이며 작업 트리는 깨끗하다. service-api/routes.ts의 /posts는 POST만 있고 user-client.ts 허용 목록에 새 검색 RPC가 없다. migration에도 search_public_posts_v2·요약 checkpoint 저장이 없으며 worker_jobs의 attempt는 점유 때 증가한다. 기존 publish_review_summary는 현재 작업자/lease를 받지 않으므로 이번 요구를 충족하지 않는다. 기존 maintenance API는 준비돼 있다.

따라서 첫 종현 구현의 인계 준비는 완료됐으나 실제 검색·요약 연결은 민규 변경 후 검증해야 한다. 이번 커밋·푸시는 종현 전용 브랜치만 대상으로 하며 기능 검사 73개·타입 검사 83파일의 앞선 통과 기록을 유지한다. 신규 코드 변경이 없어 검사는 반복하지 않는다. 기존 하네스 baseline은 이 구현 단위의 이력으로 보존하고 다음 작업에는 새 baseline과 수정 목록을 만든다.
