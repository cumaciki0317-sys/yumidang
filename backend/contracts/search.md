# 공개 검색·장소·행사 조회 연결 계약

## 행사 목록·Top 10·공급사 현재 기준

일반 목록은 이번 주 새로 시작한 행사 기본·진행 중 포함 선택이다. 한국 주간은 월요일 00:00~다음 월요일 00:00 미만이며 지난 종료 행사도 조회할 수 있다. 공고 작성용 선택은 진행 중·예정만 허용한다. 순서는 진행 중(최근 시작) → 예정(빠른 시작) → 종료(최근 종료)이고 지역·유형은 공급사 원문·실제 값 목록을 사용한다. 분류 대응표가 필요하면 팀 검토한다.

Top 10은 일반 목록과 별도로 전국 전체 공연 기본·뮤지컬 전환, 어제까지 최근 7일 집계·매일 갱신, 출처·집계 기간·갱신 시각 표시로 확정했다. 실제 순위 API 연결·자료 일치 검증은 별도이며 데이터가 없으면 인기 순위를 지어내지 않는다. 행사 입장료를 동행 비용으로 쓰지 않고 비용 미확인을 무료로 바꾸지 않는다. 서울 열린데이터 연결 조건·연결 여부와 최초 과거 수집 범위는 팀 검토다.

## 현재 검색 정책과 기존 wire의 차이

공고 키워드 대상은 제목·등록 장소명·등록 주소·연결된 행사명이다. 소개·후기·상세 만남 지점은 제외하며 검색 일치와 표시 권한은 분리한다. 공고 작성자의 만 나이를 최소~최대 19~99세 숫자 범위로 지정하고 전체 선택에는 필터 상한을 적용하지 않는다. 비로그인은 나이 전체만 사용한다. 등록일 최신순 기본·시작일 빠른순 선택, 모집 상태 전체 기본·모집 중만 선택은 유지한다.

현재 서비스는 무료 동행만 제공한다. 아래 기존 `paid` 비용 값·연령대 `20s/30s/40plus`·기술 limit는 코드에 남은 wire 계약이며 새 정책 또는 유료 활성화가 아니다. 연결 행사명 검색·숫자 나이 범위를 실제 HTTP/코어/RPC에 반영하는 작업은 별도다. 일반 목록 더 보기와 AI 추가 요청의 제품상 개수는 팀 검토다. 기존 함수명·커서 형식을 문서만으로 변경하지 않는다.

현재 [공고 검색](../../정책.md#posts)·[행사 정책](../../정책.md#events)은 정책.md를 따른다. 특히 행사 일반 목록은 이번 주 신규 기본·진행 중 포함 선택이다. 아래 API의 기술 조건과 화면 정책을 구분하며, 이번 문서 동기화에서 코드·DB·화면 연결은 검증하지 않았다. [반영 확인 작업](../../정책.md#follow-ups)을 확인한다.

상태: **2026-09-29 검색 v2 정책 동기화**. 민규의 검색 SQL·선택 인증·공개/회원 DB 클라이언트를 기준으로 종현 검색 코어를 맞췄다. 실제 GET·DB 연결과 외부 제공처는 이번 범위 밖이며, 검증 결과는 [최신 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-search-v2-handoff.md)에 구분한다. 기준은 `PLAN.md` 3-3·3-6장, `PLAN_상세설계.md` 5.2·6.3·8·11.3장, `AGENTS.md`다. 공고 작성·수정과 위치 공개 권한의 원천 계약은 민규 소유 [posts-search.md](posts-search.md)에 둔다.

## 1. 기존 실행 코드의 입력과 호출 권한

민규 HTTP 진입점은 `GET /functions/v1/service-api/posts`이며 동일 경로의 공고 생성 POST는 회원 인증을 유지한다. 기존 HTTP 연결 이력은 서비스 API와 인계에 있으며 이번 최신 필터까지 반영된 것은 아니다. 종현 내부 입력의 `caller`는 검증된 인증 문맥에서만 만든다.

| HTTP 입력 | 기존 기술 계약·새 정책 적용 필요 |
|---|---|
| query | 선택, 최대 300자. 빈 값은 목록, 영문 소문자·앞뒤/연속 공백 정규화 |
| category | 기존 카테고리 값, 전체는 생략 |
| cost / availability | all/free/paid, all/recruiting. 기본 all |
| periodStart / periodEnd | 둘 다 생략하거나 시간대 포함 ISO, 시작 포함·끝 제외. 내부 period.startsAt/endsAt로 변환 |
| authorAge | all/20s/30s/40plus, 기본 all. DB 한국 날짜 기준 만 나이, 생년월일 반환 금지 |
| sort | created_desc 기본(등록일 최신순), starts_asc 선택(시작일 빠른순) |
| cursor / limit | 이전 응답 커서, 기본 20·최대 50. 기존 기술 한도이며 새 사용자 페이지 정책 아님 |

인증 헤더가 없으면 익명, 있으면 반드시 검증한다. 만료·위조 토큰을 익명으로 바꾸지 않는다. 익명의 기간 검색은 허용한다. 익명의 all 이외 나이 조건은 코어 `AUTH_REQUIRED`, DB SQLSTATE `28000`이며 HTTP에서는 `401 AUTH_REQUIRED`로 연결한다. userId/caller 등 권한 주장·알 수 없는 필터·중복 인자·잘못된 커서는 `400 INVALID_REQUEST`다. 종현 코어의 입력 오류를 이 HTTP 오류로 연결하는 책임은 민규에게 있다.

기존 구현의 키워드는 제목·등록 장소명·등록 주소 각각의 연속 부분 문자열을 검색한다. 현재 확정된 연결 행사명 검색은 추가 연결·검증해야 한다. 소개·리뷰·상세 만남 지점·혼합 exact_location은 제외한다. 좌표·반경·거리순은 추가하지 않는다. 기간과 양의 겹침이 있는 공고를 포함한다.

정렬은 `created_desc`일 때 등록 시각 내림차순, `starts_asc`일 때 시작 시각 오름차순이며 둘 다 동률 ID 오름차순이다. 기간은 겹침 필터일 뿐이며 모집 여부·기간 안 시작 그룹을 사용자가 선택한 정렬보다 우선하지 않는다. 필터·권한·정렬·페이지는 DB에서 끝내며 서비스는 받은 페이지를 다시 정렬하거나 걸러내지 않는다.

## 2. 반환과 공개 경계

```ts
{ data: { status: "results" | "no_results", posts: PublicPostCard[], nextCursor: string | null }, requestId: string }
```

카드는 id/title/authorDisplayName/publicArea/startsAt/endsAt/cost/state/canApply만 포함한다. 실제 RPC는 호출자에 맞는 표시 이름 하나만 반환한다. 회원은 기존 DB 마스킹, 비회원은 시스템 별칭을 사용한다. 예: 변종→변*, 변종현→변*현. 익명 응답에 회원 마스킹을 함께 넣지 않는다.

비용은 free, paid_request(작성자→신청자), paid_offer(신청자→작성자), unknown이다. **unknown은 ‘비용 미확인’, 항상 신청 불가**, 금액·방향 없음이다. 확인된 과거 비용 NULL만 변환하고 잘못된 유형·금액은 오류로 드러낸다. 전체 목록에는 포함하되 무료·유료 필터에서는 제외한다.

공개 지역은 **동까지** 유지한다. DB public_area의 현재 형식인 시도·시군구·선택 구·마지막 동/읍/면/가, 최대 60자를 검사하고 원문을 그대로 반환한다. 숫자가 있는 종로1가도 허용한다. 앞뒤 공백·상세 주소를 수정해 정상 지역으로 만들지 않으며 정확한 주소를 임의 분해하지 않는다. 행정구역 실존을 확인하는 검사는 아니다. 정확한 주소·상세 지점·원본 실명은 카드와 AI 입력에서 제외한다. 본인 관리·양쪽 확정 당사자의 권한 조회는 민규의 별도 경로다. 제목 자체의 위치 노출은 작성 단계 수정 요청 정책을 유지하며 자동 탐지의 완전성을 주장하지 않는다.

DB 공개 상태 우선순위는 삭제 제외 → 현재 확정 약속 confirmed → 완료/취소/분쟁/불발 closed(마감) → 모집 기한 또는 시작 시각 경과 expired → recruiting이다. 상세 마감 사유는 카드에 넣지 않는다. DB는 현재 신청 규칙으로 canApply를 계산하고 실제 신청 때 재검사한다. 비회원·미확인 비용·모집 종료는 항상 false다.

## 3. 행사 모드·장소 입력

일반 목록의 제품 기본값은 **이번 주 새로 시작한 행사**, 선택은 **진행 중 포함**이다. 진행 중 포함은 선택 기간과 겹치는 장기 행사를 함께 보여주는 뜻이다. 아래 기존 API의 `ongoingOnly`는 조회 시점에 진행 중인 행사만 고르는 기술 조건이므로 화면의 포함 옵션과 동일하게 연결하지 않는다. 화면 기본값·기간·조회 모드의 실제 연결 검증은 후속 작업이다.

| 모드 | 포함·정렬 기준 |
|---|---|
| `overlapping` | 기간 겹침 조회용이며 일반 목록의 기본값이 아님. 정규화된 region/category 값을 정확히 일치시켜 지역·종류를 좁힌다. 기간 미선택이면 과거·진행 중·예정 전체, 기간 선택 시 겹치는 행사. `ongoingOnly=false`가 기본이고 ON이면 조회 시점에 진행 중인 행사와 선택 기간의 교집합 |
| `new_this_week` | 기존 API는 이번 한국 주간에 시작하며 조회 시점에 미종료인 행사만 반환. 첫 수집 주간을 사용하지 않음. 현재 제품의 이번 주 신규 기본·과거 조회와 별도로 미종료 조건이 있으므로 화면 기본과 완전히 일치한다고 간주하지 않고 실제 연결을 점검 |
| `post_selection` | 진행 중·예정만 선택 가능. 기간 미선택이면 전체, 기간 선택 시 겹치는 행사. 작성 입력·일정을 자동 변경하지 않음 |

정렬: 진행 중(최근 시작순) → 예정(빠른 시작순) → 종료(최근 종료순), 동률 ID. 날짜만 있는 자료는 한국 달력 날짜이고 종료 날짜 포함, 시각이 있는 자료는 명시 offset이 필요하며 종료 시각부터 제외한다. 취소는 새 조회·선택에서 숨긴다. 과거 조회와 진행 중 필터가 함께 선택되어 0건이 되어도 조건을 자동 초기화하지 않는다. 원천 상태·날짜를 알 수 없으면 정상으로 추정하지 않고 정규화 오류를 구분한다.

날짜 전용 `selectDateOnlyEvents`는 호환용 계산 helper이며 실조회는 원천 상태를 검사하는 `selectEvents`를 사용한다. 실제 행사 공급사 변환·DB 페이지 연결 전에는 완전한 외부 행사 목록을 제공한다고 설명하지 않는다.

카카오 장소 후보는 `source/sourceId/placeName/address/roadAddress`로 제한한다. 전화번호·좌표·거리·제공사 부가정보는 반환하지 않는다. API 키·페이지 크기·제한 시간은 명시 설정이며 인증된 작성자만 사용한다. 키워드 API의 실제 호출은 아직 검증하지 않았다. [공식 규격](https://developers.kakao.com/docs/ko/local/dev-guide#search-by-keyword).

우편번호 공급사는 **Kakao 우편번호 서비스로 확정**했다(2026-09-23 사용자 답변). 실제 선택창 연결은 사용자 지시로 대기하며 현재 코드는 미설정 오류를 반환한다. 별도 키 없이 사용할 수 있는 주소 선택 서비스이며 장소 검색 API와 구분한다. [공식 안내](https://postcode.map.kakao.com/guide). 장소 후보의 전체 주소는 공고 작성용이며 공고가 등록된 뒤의 공개 주소가 아니다. 선택한 행사도 공고 일정을 자동 변경하지 않는다. 행사 입장료가 불명확하면 무료로 추정하지 않는다. 최초 과거 수집 범위는 **제공처의 지원 범위 확인 후 팀에서 결정**한다. 수집 주기는 매일 00:01 Asia/Seoul로 확정했다. KOPIS·TourAPI 연결 방향을 유지하며 서울 열린데이터광장의 HTTPS 등 연결 조건과 연결 여부는 팀 검토다. 키 입력과 실제 운영 연결 확인은 [팀·운영 후속 작업](../../정책.md#follow-ups)을 따른다.

**2026-09-30 행사·장소 연결 기록(Claude 구현, 종현 범위):** 당시 첫 행사 제공처는 키 없는 HTTPS 확인이 먼저 끝난 **KOPIS**(`https://kopis.or.kr/openApi/restful/pblprfr`)였다. 당시 서울 열린데이터 연결은 HTTPS 등 조건 미확인으로 보류했고 TourAPI는 키 형식 unknown으로 미호출했다. 서울의 HTTPS 지원 부재를 확인한 것이 아니며 현재 연결 조건·여부는 팀 검토다. 저장은 제안 [04_events.sql](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-proposed-sql/04_events.sql)의 `upsert_events`(제공처+원천 ID, 삭제 없음, 취소·비용 미상·날짜 정밀도 보존), 조회는 `list_public_events`(모드·진행 중·기간 겹침·키워드·지역/분류, 상태 그룹 정렬 후 keyset)다. 수집 HTTP는 `POST /functions/v1/event-sync {provider, period:{start,end}, page}`(내부 인증), 장소는 `GET /functions/v1/places?query&page`(회원)다. KOPIS 목록에는 공식 상세 링크가 없어 `sourceUrl`은 null을 허용한다. 현재 공개 행사 HTTP·허용 목록 등 후속 연결은 [민규 연결 요청](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-minkyu-requests.md)을 따른다. 당시 근거: [lane E 기록](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-lane-e-notes.md).

## 4. RPC·커서와 오류

`createRpcPublicPostSearchRepository(db)`는 공통 `RpcClient`를 주입받아 다음 계약만 호출한다. 클라이언트는 서버가 검증한 회원 JWT 또는 익명 권한으로 구성하며 caller/userId를 SQL 권한 인자로 넘기지 않는다.

```ts
search_public_posts_v2({
  p_filters: { query, category: string | null, cost, availability,
    periodStart: string | null, periodEnd: string | null, authorAge, sort },
  p_cursor: { sortAt: string, id: string } | null,
  p_limit: number
})
// DB 반환: { items: PublicPostCard[], nextCursor: position | null }
```

DB wire 비용의 예외는 확인된 과거 비용 `cost:null`이다. 어댑터가 이를 `{kind:"unknown"}`으로 바꾼다. DB에서 unknown 객체·누락 필드·잘못된 비용을 보내면 거절한다. 카드 UUID·필드 목록·지역·시각·비용·중복 ID·페이지 크기·마지막 커서 일치를 검사한다. 원본 주소나 추가 필드가 섞인 응답은 빈 결과로 숨기지 않는다.

외부 커서는 `{v:2,filters:{query,category,cost,availability,period,authorAge,sort},position:{sortAt,id}}` JSON의 UTF-8 base64url(패딩 없음, 최대4096자)이다. 정규화한 전체 필터·정렬의 구조적 일치를 검사한다. 구형 v1·다른 필터/정렬·4필드 구형 위치는 `INVALID_CURSOR`로 거절한다. limit는 페이지 크기이므로 지문에 포함하지 않는다. 화면은 조건 변경 시 커서를 버리고 첫 페이지를 요청하며 서버가 잘못된 커서를 첫 페이지 성공으로 바꾸지 않는다. sortAt는 created_desc에서 등록 시각, starts_asc에서 시작 시각이며 PostgreSQL 마이크로초 문자열을 그대로 보존한다. 다음 커서 ID는 마지막 카드 ID와 같아야 한다. starts_asc만 마지막 startsAt과 시각을 비교하고 created_desc는 카드에 없는 등록 시각을 startsAt으로 대신 검사하지 않는다. 입력 커서가 있으면 bigint 마이크로초·소문자 UUID로 정렬 방향에 따른 엄격한 진행을 검사한다. 같은 시각에는 ID가 커져야 하며 동일 순간의 다른 offset 표현도 동률이다. 커서는 인증 수단이나 데이터 snapshot이 아니며 DB는 매번 권한과 필터를 재검사한다. 정적 데이터의 페이지 검증과 조회 중 데이터 변경 고정은 구분한다.

**2026-09-29 오류 분류 보완(Claude 구현, 종현 범위):** repository `wireCard`는 DB 카드의 날짜·공개 지역·상태 투영 검증 실패를 `INVALID_SEARCH_RESPONSE`로 바꿔 던진다. 따라서 잘못된 DB 카드 날짜는 원문 없는 `500 INTERNAL_ERROR`이고, 잘못된 사용자 기간·커서는 DB 호출 전 `400 INVALID_REQUEST`를 유지한다. 입력 정규화·커서 해석·`db.rpc`의 공통 HttpError(401/403/503)는 넓은 catch로 감싸지 않는다. 회귀: `tests/functions/jonghyun/search-response-errors.test.mjs`(가상 RpcClient + 민규 service-api handler, 실제 DB/Edge 아님). [재현 요청](../../docs/collaboration/requests/minkyu/2026-09-29-search-connect-review.md)

정상 빈 페이지는 no_results/posts:[]/nextCursor:null이다. RPC/응답 검증 실패를 0건 또는 구형 RPC/가상 데이터로 대체하지 않는다. HTTP에서는 입력·커서 오류를 INVALID_REQUEST, 인증 필요를 AUTH_REQUIRED, 내부/RPC 실패를 안전한 공통 오류로 매핑하며 원문을 노출하지 않는다. 행사·장소 장애와 공고 검색 결과는 구분한다.

## 5. 구현 범위와 실제 연결 조건

- `searchPublicPosts`는 실제 페이지 저장소의 순서를 보존하고 공개 카드를 검사한다. 기존 전체행 가상 저장소 경로도 보존하며 이 경로의 나이·커서는 명시 미지원이다.
- 민규의 v2 SQL·선택 인증·익명/회원 클라이언트는 `03aef5c`에 구현됐다. 기존 GET 연결·DB/JWT/HTTP 검증 이력은 [서비스 API](service-api.md)에 있다. 숫자 나이·연결 행사명 등 이번 정책의 코드 검증은 별도다. 주입 검사 결과는 DB 권한 증거가 아니다. 헤더 부재만 익명으로 처리하고 일반 검색에 service-role을 쓰지 않는다.
- 기존 search_public_posts/list_posts·직접 테이블 조회·공고 상세는 민규가 호출 전환·검색 범위·관계 권한을 별도 확인한다. 동 공개·익명 기간 허용을 우회 문제로 취급하지 않는다. 구형 경로가 남은 상태를 전체 검색 통일 완료로 표시하지 않는다.
- 행사 selectEvents/queryStoredEvents/syncEventPage, 장소 입력 코어는 유지했다. 실제 제공처 변환·DB 페이지·외부 호출은 후속 작업이다.
- 구체적인 연결 요청·검사 결과는 [최신 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-search-v2-handoff.md)를 따른다. [9/28 인계](../../docs/collaboration/requests/jonghyun/2026-09-28-connection-handoff.md)의 시군구·익명 기간 제한·기간/모집 우선 정책은 과거 기록이다.
- AI는 최신 검색 코어의 기본 정렬을 재사용한다. 기존 AI의 sort·authorAge 연결과 이번 숫자 나이 범위 전환은 구분하며 새 범위 지원 완료로 안내하지 않는다.

행사 `query`는 **행사명·장소명·공개 주소** 중 한 필드에 연속 부분 일치하면 찾는다. 영문 대소문자·연속 공백 차이는 무시하고, 빈/공백 검색어는 다른 필터만 적용한다(2026-09-23 사용자 확정 검색 범위 및 기존 빈 검색 계약). 필드를 이어 붙여 일치시키거나 설명·비공개 만남 지점을 검색하지 않는다. 키워드는 지역·종류·기간·진행 중 필터와 교집합으로 적용하며 기존 정렬을 유지한다.
