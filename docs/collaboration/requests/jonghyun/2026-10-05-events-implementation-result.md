# 행사·장소 현재 구현 확인과 민규 연결 요청

작성자 jonghyun, 2026-10-05. 기준 브랜치 `jonghyun/queue-integration`, 기준 커밋 `9dfca36cfe88f6da658fcbf863d5f4a33c2d0513`. 하네스의 event-audit 담당은 이 문서만 작성한다. 행사 코어·공통 HTTP·SQL·설정은 변경하지 않았고 실제 DB·공급사 호출·배포도 실행하지 않았다.

## 현재 구현과 검증

일반 행사 코어는 이번 주 신규 중 미종료, 진행 중 포함, 과거 조회, 목요일 귀속 월별 주차, 상태별 정렬, 공식 무료 판정과 공연 장르 필터를 지원한다. KOPIS·TourAPI는 목록·상세·저장된 진행 중 원천 ID 갱신, 원문 없는 상세 작업 등록, 커서 보존, 정상 양보와 공급사 실패 구분을 구현했다. 공식 Top10 전체/뮤지컬은 최근 7일의 모드별 영속 작업과 원자 snapshot 완료 계약을 사용한다. 장소 검색은 인증 후 10개씩, 공식 우편번호는 실제 선택 결과를 정규화한다.

아래 기존 합성 검사 10개 파일을 Node의 `--experimental-strip-types --test`로 함께 실행해 **114/114 PASS**를 확인했다. 새 테스트·행사 제품 코드는 만들지 않았다.

- `tests/functions/jonghyun/event-collection.test.mjs`, `event-detail.test.mjs`, `event-policy.test.mjs`
- 같은 폴더의 `event-provider.test.mjs`, `event-provider-tourapi.test.mjs`, `event-runtime.test.mjs`
- 같은 폴더의 `event-service.test.mjs`, `event-sync.test.mjs`, `places-http.test.mjs`, `places.test.mjs`

검사 범위는 주차·시간/무료/장르 필터, 공식 원천 응답 정규화, 상세 원천 버전, 점유 손실·시간 초과·재개, 공급사 장애/0건 분리, 장소 인증/비밀값 보호다. 합성 transport/DB 결과이며 실제 운영 연결 성공을 뜻하지 않는다.

## 민규에게 필요한 공통 연결

| 연결 | 현재 차이 | 필요한 계약 |
|---|---|---|
| 행사 목록 HTTP | `service-api/events-http.ts`는 `includeOngoing`·`freeOnly`·`performanceGenre`를 허용하지 않지만 종현 `db/repositories/events.ts`는 지원한다. | 확정 정책에 맞는 키/타입을 정확히 전달하고 DB 선페이징 필터·커서 조건에 반영한다. 미지원 조건을 버려 성공하지 않는다. |
| 공개 추가 조회 | 모바일 제안인 `GET /events/:id`, `GET /events/rankings?mode=all|musical`과 행사 연결 공고 조회는 현재 공통 route에서 찾지 못했다. | 공개 최소 DTO와 실제 응답을 먼저 고정하고, 원천 상세/공식 순위와 연결 공고를 반환한다. 공개 상세 위치·작성자 신원 권한은 공통 정책을 따른다. |
| 행사 영속 실행 | `event-runtime.ts`의 9개 필수 RPC는 현재 migration 정의와 internal-client 허용 목록에 없다. | 아래 RPC·권한·버전/capability를 함께 구현한 다음 허용 목록을 활성화한다. 미준비에는 원천 요청 전 `not_enabled`를 유지한다. |
| 원자 상세/순위 완료 | runtime은 페이지 저장+진척+상세 참조 등록, 상세 저장+작업 종결, 순위 snapshot+작업 성공을 같은 트랜잭션으로 요구한다. | 전역/작업 점유·원천 버전·현재 순위 기간을 DB에서 검사하며 `applied/stale/superseded/lease_lost`를 계약대로 반환한다. |

9개 RPC는 `read_event_collection_contract`, `register_event_collection_jobs`, `claim_event_collection`, `commit_event_collection_page`, `store_event_source_detail`, `next_event_collection_reference`, `list_ongoing_event_source_ids`, `settle_event_collection`, `complete_event_ranking_collection`이다. 정확한 인자와 응답은 기존 `backend/supabase/functions/_shared/jobs/event-runtime.ts`와 `2026-10-05-policy-implementation-handoff.md`를 재사용한다. 계약 버전은 `2026-10-05`; capability는 실제 준비된 `collection`, `collection_details`, `detail_jobs`, `ranking_jobs`를 선언하며 이름만 선언해 우회하지 않는다. `acquire_worker_run/release_worker_run`도 기존 전역 점유 경계 그대로 사용한다.

`yielded`는 실패 횟수를 올리지 않고 커서/페이지를 보존해 queued로 돌린다. DB가 준비되지 않은 단계는 합성 계약 검증과 실제 DB 미연결로 따로 기록한다. 기존 일회성 `/event-sync` 페이지 저장 경로의 존재를 최신 영속 수집 완성으로 판단하지 않는다.

## 기존 결정과 남은 실제 검증

서울 보안 연결/진행 중 갱신은 기존 사용자 A안으로 계속 보류한다. 공식 HTTPS 미리보기/다운로드 존재와 자동 수집/페이징 계약 미확인을 구분하며, 보류를 다시 선택하도록 묻지 않는다. HTTP 원천을 중계 뒤에 숨기는 방식으로 보안 승인하지 않는다.

민규 연결 뒤 전용 로컬 DB에서 동일 원천 중복 등록, page/detail/ranking 원자성, stale/superseded/lease_lost, 양보 후 재개, 두 실행기 경쟁, 공개 필터·추가 조회를 검증해야 한다. 공급사 자격/실제 응답/한도와 운영 상주 호스트·모바일 기기는 별도 검증이다. 현재 실제 DB·공급사·운영·기기 연결은 **NOT_RUN**이다.
