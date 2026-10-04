# 최신 정책 구현 인계 — 종현 → 민규

> **서울 열린데이터 보안 연결 보류 — 사용자 A안 확정:** HTTP 구간에서는 서울 API 키를 가로채거나 행사 응답을 변조할 수 있다. 회원 정보가 전송되지는 않지만, “위험이 없다”고 설명할 수는 없다. [OWASP 전송 보안 설명](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html)을 근거로 평문 HTTP 수집은 활성화하지 않는다. KOPIS·TourAPI·서울 3개 공급사의 출시 목표는 유지하고, 서울은 안전한 HTTPS 자동 수집 경로가 확인될 때까지 보류한다. 완료한 나머지 코드는 커밋·푸시 대상으로 확정했다. 서울의 안전한 수집 연결·페이지 재개·저장 ID별 진행 중 갱신은 미완료이며 재개 담당자가 확인해야 한다.

2026-10-05 현재 인계다. 기준은 [정책.md](../../../../정책.md)와 이번 사용자 확정 답변이며, [현재 계획](../../../../260929_종현담당_PLAN.md)·[AI 탐색 계약](../../../../backend/contracts/ai-chat.md)·[요약 계약](../../../../backend/contracts/review-summary.md)·[검색 계약](../../../../backend/contracts/search.md)을 함께 확인한다. 문서·코드·로컬 검증과 실제 운영 완료를 구분한다.

작업자 `jonghyun`, 통합 worktree `.worktrees/jonghyun-policy-integration`, 브랜치 `jonghyun/policy-integration-20261005`다. 공통 인증·HTTP·DB 클라이언트·SQL·설정은 민규 소유다. 이 문서는 해당 구현 커밋에 포함하며 커밋 해시와 원격 반영 여부는 Git 기록으로 확인한다. 원격 DB·운영 키를 쓰는 공급사 요청·실제 회원 데이터 전송·배포는 하지 않았다. 공식 공개 문서와 키 없는 서울 HTTPS 미리보기·다운로드의 공개 행사 표본을 조회했다. 공개 표본 조회는 운영 수집 연결 완료가 아니다.

## 적용한 확정 조건과 구현 범위

사용자 Q1 A는 일일 최초 worker 호출 최대 1회와 별도 상주 실행기의 후속 처리를 분리한다. Q2 A는 작성자 철회 시 그 작성자의 후기를 상대 요약 근거에서 제외하고 관련 요약을 숨긴 뒤, 남은 적격 텍스트 후기 3개 이상이면 정기 재생성한다. 대상자 철회 시 본인 프로필 요약 전체를 숨기고 생성을 중단한다. 계정·일반 동행·일반 공개 후기는 유지한다. 콘서트 B는 대중음악·서양음악(클래식)·한국음악(국악)을 묶는다. 팀 유보 비용·담당·숫자는 새로 확정/재질문하지 않는다.

서버에 최신 검색 조건·카드 재조회, 개인정보 전송/답변 전체 중단, 요청 전체 자동 재시도 1회, 전체 후기 분할/checkpoint/300자 요약, 행사 조건/장애 분리를 반영했다. 월 주차는 월요일 시작·목요일의 달 귀속이다. 정책/현 계약의 AI 입력·출력·페이지·후보·호출 상한은 설정값 초과 시 실행 전 거부한다. 요약 점유180초·첫 재시도10분·예산 재확인1시간은 고정값이며 내부 정리는 최대20건이다.

모바일 서비스 모드는 공고·행사·순위·프로필·후기·요약·AI의 API 호출/검증/실패 안내를 연결했다. 새 `remote.tsx`·`service.ts`·`RemoteScreens.tsx`와 분기가 구현 결과이며 실제 API 성공은 별도다. 미리보기는 예시 데이터다. 로그인·사진·전체 작성/신청/채팅/매칭·Android/iOS 실행은 완료가 아니다.

## 민규가 연결할 AI·요약 DB

현재 어댑터의 정확한 함수명·인수다. 예약 RPC에는 식별자만 보내고 원문은 보내지 않는다.

```text
acquire_ai_chat_request(p_user_id,p_request_id,p_client_request_id,
  p_output_retry_of,p_contract_version)
finish_ai_chat_request(p_user_id,p_request_id,p_lease_token,p_outcome)
reserve_ai_chat_model(p_ledger_id,p_provider_id,p_task,p_units,
  p_user_id,p_request_id,p_lease_token,p_contract_version)
reserve_review_summary_model(p_ledger_id,p_provider_id,p_task,p_units,
  p_job_id,p_lease_token,p_target_user_id,p_source_revision,
  p_worker_run_token,p_model_version,p_prompt_version,
  p_source_review_ids,p_contract_version)
```

계약 버전은 `2026-10-05`다. acquire는 차감 없이 회원당 동시 1개를 점유한다. `reserve_ai_chat_model`에서 첫 모델 시작의 DB 시각/KST 하루 20회 차감과 전체 예산을 원자 예약한다. 내부 호출·자동 재시도는 추가 차감하지 않고 입력 차단·모델 없는 질문·일반 더보기는 제외한다. 반환형은 AI 계약을 따른다.

출력 개인정보 재요청은 새 clientRequestId와 이전 서버 requestId인 `outputRetryOf`를 사용한다. DB는 동일 회원의 실제 output_privacy 결과·사용 여부를 검사해 1회만 허용하고 연쇄 재요청을 막는다. finish는 결과 기록/점유 해제를 확인한다. 예약 성공/예산 부족과 기존 `settle_ai_budget` 정산 계약을 연결하며 사용량 불명은 전체 예약을 유지한다.

요약 예약은 현재 작업·대상·revision·모델/프롬프트·작업 및 전역 점유·대상/작성자 동의·전체 근거 ID 일치·3개 이상을 예산과 원자 검사한다. 재조회 이후 검사 대기 중 철회/만료도 마지막 허가에서 막는다. 거부는 `consent_revoked`, `stale_revision`, `insufficient_reviews`, `invalid_evidence`, `lease_lost`이며 모두 새 모델 전송 없이 중단한다. 범위 누락·RPC 미지원은 generic 예산으로 우회하지 않는다. NIL 작업을 사용하는 시작 전 probe는 예약 없이 `lease_lost`를 반환해야 한다.

요약 6개 RPC는 `load_review_summary_source`, `load_review_summary_checkpoint`, `save_review_summary_checkpoint`, `discard_review_summary_checkpoint`, `mark_review_summary_insufficient`, `publish_review_summary_for_job`다. 모두 버전과 `p_worker_run_token`을 받고, 현재 작업 점유와 revision을 검사한다. source 성공은 `processingAllowed:true`가 필수이며 공개 조회까지 자격을 재검사한다.

철회 API와 DB 트랜잭션은 작성자/대상자 효과를 구분해 sourceRevision 증가·기존 요약 숨김·checkpoint 제거·필요한 재작업 outbox 기록을 원자 처리해야 한다. 대상자가 철회하면 재생성을 예약하지 않는다. 일반 공개 후기 삭제나 계정 사용 중단으로 대체하지 않는다. 원문·공급사 사본 삭제/백업 만료도 실제 검증해야 한다. 공통 API/SQL·내부 허용 목록은 미연결이다.

## 검색·행사·상주 실행기의 필수 연결

검색은 기존 이름 `search_public_posts_v2`를 유지하되 필수 새 `p_contract_version:'2026-10-05'`, `p_region`, `p_filters`, `p_cursor`, `p_limit`을 적용한다. authorAge는 `all` 또는 `{min,max}` 정수 19~99이며 전체 검색에는 상한을 걸지 않는다. 회원/비회원은 인증 문맥에서 결정한다. 비회원 authorDisplayName은 null이며 실제 이름·프로필을 응답/DOM에 넣지 않는다. 16개 카테고리·17개 시도·기본 10개다. 검색 대상은 제목·등록 장소명/주소·연결 행사명이다. 조건은 DB 선페이징으로 적용한다.

공통 `service-api/search-http.ts:50`는 아직 `20s/30s/40plus` 구 enum을 반환해 `deno check .../service-api/index.ts`에서 **TS2322 실패**한다. 모바일은 `ageMin`·`ageMax`·`region`을 전송하므로 민규 HTTP parser와 SQL을 함께 갱신해야 한다. 종현 코어를 구 enum으로 되돌리거나 미지원 조건을 버려 통과시키지 않는다.

행사 원천 수집의 9개 필수 RPC는 다음과 같다.

```text
read_event_collection_contract / register_event_collection_jobs
claim_event_collection / commit_event_collection_page
complete_event_ranking_collection / store_event_source_detail
next_event_collection_reference / list_ongoing_event_source_ids
settle_event_collection
```

준비 계약 `version:'2026-10-05'`와 기능 capability 선언이 필요하다. 페이지 저장/진척은 두 점유로 원자 처리하고 초기 수집은 멱등 등록한다. 생산 runtime은 공통 내부 클라이언트의 실제 허용 목록 기반 `supportsRpc(name):boolean`도 필요하며 누락/부분 허용이면 원천 호출 전에 not_enabled다. 상세·진행 중 행사·재시도·최신 참조·공급사 장애 분리는 `_shared/jobs/event-runtime.ts`를 따른다. KOPIS Top10 추가 구현은 ranking_all/ranking_musical lane을 같은 큐에서 소비하며 실패 모드만 재시도한다. 실제 DB/외부 연결 완료와 구분한다. 원천 키 `seoul-open-data`를 서울 열린데이터광장으로 표시한다. `list_public_events`/필터 값·공개 조회도 기존 SQL과 별도로 연결해야 한다.

Top10 원자 완료 RPC는 `complete_event_ranking_collection(p_job_id,p_lease_token,p_worker_run_token,p_period,p_snapshot)`이며 `{status:applied|stale|superseded|lease_lost}`를 반환한다. 같은 트랜잭션에서 snapshot 저장과 job 성공을 묶는다. 준비 capability `ranking_jobs`는 이 RPC/권한/등록 lane이 모두 준비된 때만 선언한다. 일일 직접 순위 호출을 제거하고 큐 등록만 하며 현재7일과 다른 기간은 superseded한다. claim의 rank lane 지원, settle의 superseded 전이/반환도 연결해야 한다. 기존 store_verified_kopis_top10_snapshot를 현재 runtime으로 연결하지 않는다.

KOPIS·TourAPI 상세 본문도 수동 호출에만 남겨두지 않고 원문 없는 `detail` lane으로 영속 등록했다. 준비 capability는 `collection_details`(일일 기존 원천 ID 등록·페이지 저장과 상세 참조 등록의 원자성), `detail_jobs`(상세 점유·저장/완료의 원자성)다. 준비/내부 허용 목록이 없으면 원천 호출 전에 중단한다. `/event-sync/detail`은 해당 ID 상세 작업을 등록하며 무점유 직접 저장을 하지 않는다.

- `register_event_collection_jobs`는 `p_detail_provider:boolean`, `p_detail_source_ids:null|string[]`를 추가한다. null은 저장된 적격 원천 ID 전체에 해당하며, 명시 ID는 수동 등록이다. DB가 현재 원천 collectedAt을 포함한 참조를 멱등 등록한다.
- `commit_event_collection_page`는 `p_preserve_missing:true`, `p_detail_references:[{provider,lane:'detail',sourceId,sourceCollectedAt,period}]`를 추가한다. 원천 upsert·다음 페이지/완료·상세 참조 등록을 한 트랜잭션으로 묶는다.
- `claim_event_collection`의 detail 요청은 `p_source_id`, `p_source_collected_at`을 추가한다. 기존 lane 호출과 공존하도록 NULL 기본값을 지원한다. 반환은 현재 job/lease/원천 참조와 일치해야 한다.
- `store_event_source_detail(p_detail,p_job_id,p_lease_token,p_worker_run_token,p_source_collected_at,p_preserve_missing:true)`는 전역/작업 점유와 현재 원천 버전을 원자 검사한다. 반환은 `{status:'applied'|'stale'|'superseded'|'lease_lost'}`이며 상세 저장과 작업 완료를 같은 트랜잭션으로 처리한다. 재실행으로 목록 전체를 다시 수집하지 않는다.
- 미제공 소개/운영/포스터와 unknown 비용은 삭제 명령이 아니다. 기존 값을 유지하고 승인 없는 HTTP→HTTPS 변환·미확인 가격의 무료 추정은 하지 않는다. 원천CollectedAt이 변경된 후 예전 상세 응답으로 덮어쓰지 않는다.

TourAPI(`tour-api`)의 진행 중 저장 원천 ID 갱신과 새 future/history 행사의 상세 큐도 연결했다. [공식 국문 서비스 페이지](https://www.data.go.kr/data/15101578/openapi.do)의 embedded Swagger를 확인해 HTTPS `KorService2/detailCommon2`·`detailIntro2` 응답을 같은 contentid/type15로 검사한다. title/addr1/addr2/overview와 시작·종료/장소/playtime/요금 문구를 사용하며 두 응답이 모두 완성된 뒤 저장한다. 0건·ID/유형 불일치·기간 누락/역전은 실패이며 원천 삭제로 추정하지 않는다. 요금 문구는 described이며 무료라는 단어로 free를 확정하지 않는다. HTML 소개/운영 문구·미확인 이미지·전화/좌표는 수집/노출하지 않고 기존 값을 삭제하지 않는다.

`list_ongoing_event_source_ids(p_provider,p_cursor,p_limit=10)`은 TourAPI 숫자 ID도 지원해야 한다. next-reference/excluded 참조는 detail의 sourceId+sourceCollectedAt까지 비교해 같은 날짜 다른 행사가 기아되지 않게 한다. `store_event_source_detail`의 stale는 해당 작업의 원자 종결을 포함하며, sourceCollectedAt 불일치면 superseded로 종결하고 이전 내용을 새 원천에 쓰지 않는다. lease_lost는 저장/종결 모두 금지다.

서울은 필드 정규화/보안 transport 주입 경계까지 있으며 실제 보안 연결과 저장 원천 ID의 진행 중 갱신 어댑터 구현은 남았다. [서울 공식 OpenAPI 안내](https://data.seoul.go.kr/together/guide/useGuide.do)는 HTTP8088 예제를 안내한다. 기존 OpenAPI의 HTTPS8088 sample은 로컬 TLS protocol 오류였고 HTTPS443도 정상 서비스를 확인하지 못했다. 다만 [공식 데이터셋](https://data.seoul.go.kr/dataList/OA-15486/A/1/datasetView.do)의 HTTPS Sheet 미리보기·JSON/CSV 다운로드는 공개 행사 표본으로 정상 응답을 확인했다. 미리보기는 JSON 아닌 JS 객체 형식이며 자동 수집 계약이 미확인이고, JSON 다운로드는 페이지 번호를 무시하고 필터 결과 전체를 반환한다. 현재 100개/쪽·영속 페이지 재개 계약에 그대로 연결하지 않는다. 문화포털 HTTPS JSON은 스키마·요금 정보가 달라 별도 검토가 필요하다. HTTPS가 전혀 없거나 영구 불가능하다고 단정하지 않으며, HTTPS 중계 뒤 원천 HTTP를 숨기는 방식도 보안 해결로 인정하지 않는다. A안에 따라 서울 보류를 명시하고 실제 연결은 활성화하지 않았다.

일반 목록은 이번 주 신규 중 미종료, 진행 중 포함·과거 기간은 명시 선택이다. `includeOngoing`, `performanceGenre`, `freeOnly`를 DB 선페이징 조건과 커서에 함께 묶는다. 무료는 공식 `admission.kind==='free'`만 포함하며 described/unknown이나 KOPIS 안내문을 임의 해석하지 않는다. KOPIS Top10 전체/뮤지컬은 일반 목록과 분리해 어제까지 최근 7일·매일 갱신으로 검증한다.

상주 실행기의 별도 DB 계정은 `read_worker_queue_schedule(p_exclude_kinds text[],p_after_kind text)`, `acquire_worker_run(p_lease_seconds,p_existing_token)`, `release_worker_run(p_token)` 3개와 `LISTEN yumidang_worker_jobs`만 필요하다. Direct/Session 연결을 쓰고 자동 완료 전용 계정 권한을 확대하지 않는다. schedule은 제외/직전 종류로 due 행사·요약을 교대하고 한 종류의 not_enabled가 다른 종류를 막지 않는다. 실행기가 전역 180초 점유를 얻어 내부 HTTP `x-worker-run-token`으로 전달하고 worker는 같은 토큰을 검증·재사용한다. jobs claim/settle·행사 변경·요약 변경/예약 모두 DB가 전역 점유를 원자 재검사하며 만료된 실행기의 쓰기를 거부한다. 점유 연장은 없다. LISTEN·복구·호스팅 실제 검증은 미실행이다.

행사 worker의 60초 시간 제한은 목록·상세·순위 세 경로 모두 정상 양보(`yielded`)로 정산하고 다음 실행에서 이어받는다. 부모 또는 자체 시간 예산 소진과 실제 외부 취소를 구분하며, 제한 직후 원천 저장·페이지 전진·순위 완료를 하지 않는다. 세 경로의 시간 제한/취소 회귀를 추가해 검증했다. 민규 DB는 yielded를 실패 횟수 증가 없이 queued로 전환하고 기존 커서·페이지를 유지해야 한다.

## 공통 API·인증·운영의 남은 작업과 확인 기준

공개 `GET /profiles/:id/summary`, `GET /events/:id`, `GET /events/rankings?mode=all|musical`은 모바일이 제안 계약으로 호출하지만 현재 service-api route 구현이 없다. 실제 HTTP를 연결하기 전 합성 응답 검증만 완료했다. 공개 요약은 로그인·처리 자격·revision·300자·근거 3개 이상을 보장하고 내부 근거/작업 정보를 노출하지 않아야 한다. 회원 공고 DTO에 `authorProfileId`가 없어 작성자 프로필 이동의 민규 연결이 필요하다. 행사 상세→연결 공고 조회/이동도 미연결이다. 서비스 공고 상세의 linkedEvent 카드와 행사 상세 이동 UI는 연결했다. 행사 상세→연결 공고 조회/작성자 프로필 ID는 공통 API가 남았다. `installServiceSession`은 검증된 네이버 세션을 받는 포트일 뿐 로그인 구현이 아니며, avatarStorage의 실제 업로드/접근 통제·URL 조회도 별도 연결한다.

첫 메시지 성공 시 신청 생성, 확정 요청/변경 제안의 6시간 및 시작 시각 만료, 만료 시각과 같은 수락 거부, 실제 완료+7일 후기 마감·양쪽 제출/마감 공개·분쟁 보류는 민규 공통 HTTP/SQL에서 이행해야 한다. 당도·제재·탈퇴·상세 위치/실명 권한도 공통 DB에서 검증한다. 모바일 예시 상태나 작업 큐를 공통 정책 완료로 보고하지 않는다.

승인된 개인정보/의미 검사기는 없고 요약 안전 검사기는 null이다. 보관·비용·법적 처리 근거·실제 회원 전송 승인·공식 출력 토큰 상한 인코더가 없는 모델은 disabled, 준비 안 된 worker는 not_enabled다. 합성 검사기는 운영 승인 증거가 아니다. 공급사 규격·한도 재측정·운영·스토어 요건은 별도 확인한다.

최종 검증 수치는 아래 표에 갱신한다. 동일 테스트의 분리 실행 결과를 중복 합산하지 않는다. 공통 service-api의 구 나이 타입 실패는 민규 연결이 필요하며, 그 단계에 의존하는 실제 API/DB 연동은 완료로 표시하지 않는다.

| 검증 | 현재 결과 |
|---|---|
| 종현 단위·합성 테스트 | 37파일415개 통과; 부분집합 중복 합산 없음 |
| 탐색 합성 연동 | 5개 통과 |
| 예시 브라우저 | 57개·스크린샷25개·외부 요청/페이지 오류0 |
| 비로그인 서비스 브라우저 | 12개·합성HTTP·페이지 오류0 |
| 회원 서비스 브라우저 | 17개·합성세션/HTTP/우편번호SDK stub·페이지 오류0 |
| AI·신고·홈 서비스 브라우저 | 19개·합성AI/신고·외부 요청/페이지 오류0 |
| 모바일 타입·린트 | 오류0·경고0 |
| 웹 및 iOS/Android 코드 export | 통과; 실제 기기 실행은 미실행 |
| 종현 HTTP5개 Deno | ai-chat·review-summary-worker·event-sync·places·scheduled-jobs 통과 |
| 공통 service-api Deno | TS2322 실패: 구 연령대 반환 |
| 실제 로컬 DB 요약 회귀 | 전용 DB/pg 환경 미준비로 미실행 |
| 실제 네이버·Storage·공급사·DB동시성/철회·상주 호스트·배포·UT/QA | 미실행 |

회원 브라우저의 세션 설치 route/가상 bearer는 `/tmp` 테스트 전용 앱에만 둔다. 제품 소스에는 포함하지 않았다. 우편번호 스크립트도 공식 URL에 합성 콜백을 주입하며 실제 공급사 성공이 아니다. 예시/서비스 모드 전환 때 Metro 캐시가 남는 문제를 발견해 빌드 명령에 `--clear`를 추가하고 최신 서비스 모드 요청을 재검증했다.

최상위 260929 계획의 과거 코드 차이 목록은 민규가 최신 코드·공통 연결·외부 검증으로 구분해 갱신해야 한다. 숫자 나이·한도/점유·요약/행사/상주 어댑터를 처음부터 다시 구현할 과제로 유지하지 않는다. Q1 A·Q2 A·콘서트 B 확정 내용은 정책·PLAN에 반영하고 팀 검토 항목을 임의 확정하지 않는다. 종현 소유 현재 현황/계약/모바일 안내는 이번 구현과 맞췄다.

AI 평가/최소 첨부 신고는 [별도 인계](2026-10-05-ai-feedback-connection.md)의 submit_ai_feedback·정책13 처리 준비 포트가 필요하다. SDK/UI는 확인 전 전송 차단·실패 보존·멱등 재접수·접수 후 해당 답변만 숨김·늦은 응답 차단까지 합성 검증했다. 실제 DB 접수/Storage/ACL/최종종결+90일 정리는 미연결이며 기본 준비 포트가 실제 신고 전송을 중단한다. UI 캡처는 installAiReportCaptureUpload에 실제 업로드/소유권/멱등성/미접수 자료 정리를 연결해야 한다.

## 전체 진행률의 기준

시간/출시 성공률이 아닌 종현 작업8개 묶음의 완료 개수다. 검색·AI 탐색·후기 요약·행사 목록/필터·작업 실행·프론트 연결·통합 합성 검증/인계7개 완료, 수집/공급사/장소/순위 묶음은 서울 보안 연결/진행 중 갱신 코드가 남아 부분 완료다. 7/8≈88%로 표시한다. 민규 공통 연결·실제 공급사·DB·기기·운영 검증은 이 수치에 포함하지 않는다. 사용자 A안으로 이번 실행 범위는 서울을 보류한 나머지 구현·검증·인계·커밋·푸시까지다. 이번 범위 종료를 전체 출시 준비100%로 표시하지 않는다.
