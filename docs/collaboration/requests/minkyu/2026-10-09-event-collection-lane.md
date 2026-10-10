# SQL111 행사 수집 lane 구현과 연결 조건

작업자 `minkyu`, 별도 `minkyu/backend-eventlane-20261009` worktree다. 사용자 승인 정책 커밋 `2cabdc9`의 소유권 검사를 통과한 신규 SQL111·민규 테스트·이 요청서만 작성했다. 기존 SQL/종현 모듈/공통 client/SQL109는 편집하지 않았다. DB·외부 네트워크·배포·커밋·푸시는 실행하지 않았다.

## 구현 범위와 현재 검증

`backend/supabase/migrations/20261009011100_event_collection_lane.sql`은 기존 `event-runtime.ts`의 계약 버전 `2026-10-05`와 수집 9 RPC 이름을 제공한다. base/ongoing/detail 8개는 실제 DB 처리이며 `complete_event_ranking_collection`은 기존 공식 기간 확인 보류를 유지하는 `55000` 중단이다. `ranking_jobs` capability는 선언하지 않는다. 함수 존재를 실제 공급사 검증·운영 준비로 설명하지 않는다.

`tests/database/minkyu/event_collection_lane.sql`은 빈 `worker_jobs/source_events` scratch 전용이며 전체 transaction을 rollback한다. 운영/원본 DB에서 실행하지 않는다. 기본 RPC/테이블 권한 닫힘, FORCE RLS, 등록 중복·초기 과거 범위, 실제 작업 ID 슬롯20, 같은 job 재점유 추가0, page replay/충돌, 상세 원자 분리, 알려진 가격 보존, 원천 버전 변경 상세 supersede, 장기 진행 중 행사 keyset, retry 예약, source INSERT 중 전역 만료 rollback을 검사하도록 작성했다.

SQL111은 root가 source109를 변경하지 않는 새 격리 v3 clone에서 실제 PostgreSQL compile 및 scratch 회귀 **PASS**를 확인했다. 최종 migration SHA256은 `f9e6026400a3a7b8d6e3a0c929f9c13e65cc41ff991180fd4fb4f17e921cc34c`, 테스트는 `265ae02b5bbf62d189cbd68b49a487f1c9d78d8974dc3ac86e36b69394c1e5c2`다. 테스트 행과 임시 권한·제어는 rollback됐고 기본 닫힘이 보존됐다. 앞선 실패 clone/로그는 보존됐으며 최종 SQL을 이미 적용한 clone에 다시 적용하지 않았다. 이 에이전트는 DB·네트워크를 실행하지 않았다.

공급사 실제 API, 행사 HTTP consumer, 실제 CLI, 공개/AI 상세 투영, 운영 활성화는 **NOT_RUN**이다. SQL111 성공을 운영 완료로 확대하지 않는다.

## 실제 작업·진행·보존

- 기존 `worker_jobs.kind/payload` CHECK의 기존 식을 보존하고 `event_sync` identity-only reference 분기만 추가했다. 기존 리뷰·취소·신고 payload와 소비자를 변경하지 않는다.
- 수집 progress는 실제 worker_jobs ID를 FK로 사용한다. source 상세는 기존 source_events ID를 FK로 사용하며 전체 base record를 다른 테이블에 복사하지 않는다. 작업 payload에는 공급사 원문/응답·회원 정보·오류 메시지를 넣지 않는다. 공개 공급사 원천 저장과 회원 대화 원문 저장 금지는 서로 다르다.
- 기존 `(global_token,job_id)` 슬롯 PK를 사용한다. SQL102 슬롯에는 FK가 없지만 신규 claim은 실제 worker_jobs 행만 원자 예약하고 기존 fence를 작성한다. 동일 job 재점유는 슬롯을 추가하지 않는다. 페이지·상세 저장 호출 수를 슬롯으로 세지 않는다. 별도 detail job은 실제 별도 작업이다.
- 전역 singleton을 먼저 잠그고 current token과 DB 현재 시각을 확인한다. 전역 잔여180초를 초과하는 lease는 거절하며 개별180초는 전역 expiry로 제한한다. 자동 연장은 없다. source/page writes 후 종결 전에 global/job lease를 다시 검사한다.
- 페이지의 base upsert·선택 상세 저장·상세 작업 등록·next page/cursor·최종 종결을 하나의 transaction으로 처리한다. expected page 불일치, 변경된 replay 입력, 중복 source identity 또는 잘못된 detail reference는 성공으로 처리하지 않는다.
- 성공 페이지의 hash/page/두 토큰을 최소 재개 근거로 보관한다. 동일 입력 재조회는 source/progress를 다시 쓰지 않는다. retry/yield는 실제 다음 페이지·cursor를 보존하고 terminal에서 불필요한 cursor를 지운다. 완료 작업을 매일 재실행하지 않는다.
- 등록은 provider별 원자 처리다. 최초 과거 한 달·오늘부터31일의 전체 조각 연결을 검증한다. 최초 과거 등록은 한 번만 보존하며 재등록은 새 과거 범위로 초기화하지 않는다. 재등록의 `existingCount`에는 이미 등록된 최초 과거 workflow 조각도 포함한다.
- `claim`은 null 또는 reference와 `jobId/leaseToken/nextPage/collectedPages/cursor`를 직접 반환한다. 기존 일반 job RPC의 `{job:...}` 래퍼를 사용하지 않는다. detail의 `sourceCollectedAt` 문자열은 원래 reference 그대로 반환한다.
- 진행 중 source ID는 KST 날짜/실제 종료 시각과 active 상태로 별도 조회한다. 오래전에 시작한 미종료 행사도 포함하며 `source_id COLLATE C` keyset과 lookahead로 최대10개 및 nextCursor를 돌려준다.
- 실제 provider retryable 실패만 실패수를 올리고 600초부터 증가해21600초로 제한한다. 정상 양보는 실패를 올리지 않는다. 최신 정책의 요약 최대3회 제한을 행사 실패에 임의 적용하지 않는다. 상세/일반 nonretryable 실패는 terminal failed다. 공급사 원문 오류를 저장하지 않고 기존 worker 오류 분류로 축소한다.

## 상세와 기존 validator

`operatingInfo/description/posterUrl`은 base에서 분리해 `private.event_source_details`에 저장한다. 기존 `valid_source_event_v2`, 원천 CHECK, `upsert_events`, source UUID, 공개 리스트·필터·공고 연결·회원 숨김 조건은 그대로다. 새 page 경로에서는 unknown 가격이 기존 알려진 가격을 지우지 않으며 상세의 누락/null은 삭제 명령이 아니다. 상세 fetch에 대해 원천 collectedAt이 바뀌면 superseded로 종결한다.

소비자는 가격 설명10000자를 허용하지만 기존 canonical validator는2000자다. 공개 투영 없이 상세에만 긴 유료 설명을 적용하면 기존 free 표시/AI 무료 필터가 남을 수 있다. 따라서 SQL111은 상세 described 가격이2000자를 넘으면 `event_detail_price_projection_not_ready/55000`으로 쓰기·완료 전체를 중단한다. 임의 절삭·unknown 변환·validator 완화로 성공을 만들지 않는다. 이 값의 end-to-end 지원은 아래 투영 후속 전까지 미완료다.

## 기존 예약 조회와 닫힘

`read_worker_queue_schedule`와 `read_worker_owned_queue_schedule`의 event 후보는 같은 worker_jobs ID를 그대로 읽는다. 기존 OID·서명·owner·ACL을 유지하고 event 후보에 준비 제어/실제 서비스 EXECUTE/held 제외 조건만 추가한다. 기존 worker_jobs trigger의 빈 `yumidang_worker_jobs` 알림을 사용하고 event 제어 변경도 같은 빈 알림으로 깨운다.

신규 event 제어와 기존 atomic 제어·서비스 실행 권한이 모두 준비되지 않으면 capability는 빈 배열이고 event 일정은 숨긴다. 신규 함수·테이블·private helper의 PUBLIC/anon/authenticated/service_role/authenticator/queue role 권한은 기본 회수한다. 테스트의 임시 GRANT/제어 변경은 rollback되며 운영 활성화가 아니다.

서울 HTTPS는 DB 등록 단계에서도 미준비로 거절한다. KOPIS 순위 reference는 held 상태로 보존하지만 일정/claim에서는 제외한다. 기존 공개 ranking 상태·requested-only snapshot 저장소는 변경하지 않는다. 공급사 선택·문의·승인 보류 해제를 하지 않는다.

## root 및 소비자 담당에게 필요한 후속

1. **실제 DB 검증:** SQL100/102 및 기존 후속들이 존재하는 새 disposable DB에서 SQL111 compile 후 빈 scratch transaction 회귀를 실행한다. clone에 기존 합성 source/job 자료가 있으면 root가 해당 clone에서만 별도 scratch를 준비한다. 원본에 테스트 fixture를 넣거나 원본 자료를 비우지 않는다.
2. **공통 client:** 실제 SQL 결과 검증 후 root가 internal-client의 정확한 8개 base/detail 수집 RPC를 연결해야 한다. consumer의 `supportsRpc` 검사 때문에 SQL만 추가해도 실제 runtime은 계속 닫혀 있다. ranking 완료를 허용한다고 ranking capability/공개 보류를 해제하지 않는다.
3. **공개/AI 투영:** `list_public_events`, `get_public_event`의 `project_post_linked_event`, 공고 연결 행사와 AI event reader가 선택 상세를 source FK로 조합해야 한다. 기존 필드/UUID/순서·pagination/숨김·퇴직/작성 선택 조건을 보존해야 한다. 특히 상세 admission을 확대할 때 SQL의 무료 필터와 AI `cost=free` 검증까지 같은 사실 값을 읽도록 해야 한다. 현재 SQL111은 이 reader를 변경하지 않으므로 상세 표시 완료가 아니다.
4. **전체 CLI 영속 호출:** ACK 담당 확인 결과 SQL109는 slot PK/FK, worker_jobs CHECK, 기존 schedule/fence 구조를 변경하지 않으나 durable invocation kind에 event가 없다. SQL111의 실제 job/slot20 통합은 event invocation prepare/CAS/claim audit/completion proof 연결 완료와 다르다. 이 조립은 새 후속112에서 기존109 파일을 건드리지 않고 확장해야 한다. event HTTP/CLI를 성공으로 표시하지 않는다.
5. **제품 실제 한도:** 기존 소비자의 최대10작업/60초·페이지5개·공급사 쪽당15초와 전역180초·고유20을 실제 SDK/HTTP에서 검증해야 한다. ongoing의 source 상세 GET 여러 건이 deadline을 넘으면 현재 consumer가 전체 page를 양보하므로 실제 공급사 지연·재개를 따로 검증한다.

이 요청서는 구현 증빙과 남은 연결 조건을 담으며 운영 적용이나 사용자 승인 보류 해제를 요청하는 문서가 아니다.

## SQL112 영속 행사 invocation 후속

신규 `20261009011200_event_invocation_audit.sql`과 민규 `event_invocation_audit.sql`을 추가했다. SQL111 파일·테스트는 위 PASS hash 그대로 유지한다. SQL110의 member whitelist를 보존해 event_sync만 추가하고, `complete_queue_invocation_sql110` → 기존 SQL110/109 위임 체인을 유지한다. 기존109 여섯 종류와110 회원 처리 파일은 편집하지 않았다.

행사 배정은 최대10작업/60000ms이며 전역180초를 넘기지 않는다. 실제 claim은109의 `(request_id,job_id,job_lease_token)` audit와 같은 actual job20 슬롯에 연결하고 deadline을 개별 lease에 적용한다. 만료 재점유는 이전 attempt를 superseded 감사로 닫고 새 lease에 이전 효과를 복사하지 않는다.

page 진행/종결·detail applied/stale/superseded·정상 양보/실패를 성공한 scoped DB 함수와 같은 transaction에서 최소 effect enum으로 기록한다. terminal lease/global UUID를 별도로 묶고 일반 complete_job이나 과거 lease 표식을 실제 source 효과로 인정하지 않는다. 완료 counts는 최신 attempt를 actual jobId별로 집계한 기존 SDK `{claimed,succeeded,retried,failed,superseded,yielded}` 계약이다. HTTP counts는 완료 근거가 아니다.

실제 next_reference 조회가 관측한 jobId만 `event_invocation_references`에 저장한다. 원천·detail 본문·cursor·payload 사본을 기록하지 않는다. 제외 reference는 실제 관측된 job에 한정하며, 관측한 작업을 claim 없이 제외하고 idle 성공을 만드는 것을 막는다. 실제 빈 조회에는 claim0의 idle 완료를 허용한다. 완료되지 않은 lease 또는 UNKNOWN은 새 효과/새 invocation을 차단하고, 이미 저장된 효과만으로 조회·완료 복구할 수 있다. CAS/원래 source 작업을 재전송하지 않는다.

신규 readiness는 기존 event/atomic 준비와109 제어·5개 공통 invocation 실제 EXECUTE까지 요구한다. 모든 새로운 wrapper와 기존 비결합 alias는 기본 닫힘이다. 서울 HTTPS/공식 ranking 보류는 유지한다.

SQL112는 root가 source110을 변경하지 않는 새 격리 clone에 SQL111→112를 적용해 실제 PostgreSQL compile 및 scratch 회귀 **PASS**를 확인했다. 최종 migration SHA256은 `d63015b7a9ef4988f5520ee25a4d8b87b7a03b7b152472e48d33ca7edf81fc61`, 테스트는 `1b7abc20bf666ecd09d3cf128eb89b732571b779bd807c8401232dc0a5c7f463`다. 정확 CAS·초기 유휴·미관측 제외 거절·무근거 terminal 거절·page와 세 detail 효과·새 lease 효과 미전승·슬롯20/21번째 null·deadline 중 source/progress/audit rollback·UNKNOWN 차단 회귀가 통과했다. 모든 scratch 행과 임시 권한·제어는 rollback됐고 원본 불변·기본 닫힘을 확인했다. SQL111·112와 테스트는 PASS hash로 고정하며 이 에이전트는 DB·네트워크를 실행하지 않았다.

root의 공통 SDK kind `event_sync`, client allowlist, event-sync의 scoped worker HTTP/CAS, CLI capability 조립과 실제 HTTP/전송 유실 검증은 별도다. 오래된 내부 one-page writer를 durable 행사 호출의 우회 완료 경로로 사용하지 않는다. SQL112가 준비돼도 공급사 원문·공개/AI 상세 투영과 긴 가격 설명 미완료가 자동 해결되지 않는다.

## SQL110 회원 파기 HTTP 배정 연결 후속

root의 별도 배정에 따라 foundation 최신 `service-api/handler.ts`·`index.ts`를 읽고 이 worktree에 동일하게 복사한 뒤 회원 파기 배정 연결만 추가했다. 기존 탈퇴·feedback 변경을 보존했다. 새 민규 `member_cleanup_invocation_http.test.ts`와 이 요청서만 추가 편집했고 root가 제공한 최신 `worker-runtime-client.ts`는 테스트 의존으로 복사만 했다. SQL111·112와 기존 테스트는 위 실제 PASS hash 그대로 고정한다.

`memberCleanup`은 명시적인 서버 조립 옵션에서만 활성화되며 기본값은 여전히 닫힘이다. 기존 token-only 요청 동작을 보존한다. 공유 배정은 `x-worker-run-token/request-id/max-jobs/time-budget-ms` 네 헤더를 모두 요구하고 body는 빈 객체다. 내부 인증을 먼저 수행하며 인증 실패를 사용자 JWT로 재시도하지 않는다. 수량1..10·시간1..180000ms를 검사한 뒤 저장된 prepared110의 정확한 kind/member_cleanup·token·수량·시간을 조회하고 최초 dispatch CAS를 한 번 실행한다. UNKNOWN/완료·CAS false·배정 불일치·취소는 삭제 실행을 허용하지 않는다. CAS 응답 유실에 자동 재호출이나 legacy fallback을 하지 않는다.

조회/CAS의 monotonic 경과 시간을 차감한 frozen allocation과 취소 신호를 실행기에 전달한다. factory는 해당 배정의 limit·남은 maxExecutionMs를 기존 실제 drain 옵션으로 적용하고 신뢰된 로컬 검증 옵션의 더 작은 상한도 보존한다. 전체 배정 timer와 실행 전후 monotonic 검사를 유지한다. HTTP 성공 집계도 배정 수량을 넘지 못하며 내부 receipt·토큰·경로·Provider 응답을 출력하지 않는다.

기존 drain은 새 task의 전체60초를 확보하지 못하면 claim 없이 `ran/claimed0/succeeded0`을 반환한다. 이 집계는 SQL110의 영속 완료 증거가 아니다. HTTP가 `complete_queue_invocation`을 호출하거나 자기 counts를 DB 완료 근거로 제출하지 않는다. invocation 조회·완료 복구와 실제 CLI 조립은 root가 담당하며 DB 효과 검증과 운영 활성화를 이 합성 HTTP 검사로 대체하지 않는다.

신규13개와 기존 cleanup/lifecycle/service-api51개 합계 **64/64 PASS**, handler/index/신규 테스트의 Deno `check --no-remote` **PASS**다. 합성 fetch에서 Auth task 한 건을 처리하고 배정limit1 후 추가claim0,59000ms 배정에서 budget 조회만 하고claim0, 정확 CAS·부분 헤더·취소·경과시간·응답 유실·UNKNOWN 차단을 검사했다. 실제 DB/Storage/Auth/외부 네트워크·배포·운영 활성화는 이 에이전트가 실행하지 않았다.

고정 SHA256:

- `service-api/handler.ts`: `ee84e79c90e4bca350076292d306d76c9582b2d4e255f108501af894f097f7bc`
- `service-api/index.ts`: `765c90139e0fc6eadb71264e8acc88fd9e9b33da115adafee231e0ccf7d9c8b8`
- `tests/functions/minkyu/member_cleanup_invocation_http.test.ts`: `d40044b8cc67d2c100017bf889b0abc8d952628915cb39f4eae59805911dfd62`
