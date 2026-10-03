# 행사 저장·페이지 조회·회원 공개 프로필 DB 계약

민규 담당 후속 마이그레이션 `20261002131000_events_public_profile.sql`이 종현 제안04·05와 S14 공개 프로필을 연결한다. 선행 원본 `20260929100000_event_storage.sql`은 수정하지 않고 기존 기록·UUID를 보존한다. 아래 v1은 deprecated 호환 계약이다. 기준은 종현 소유 `integrations/events/port.ts`의 `SourceEventRecord`·`StoredEventRecord`, `normalize.ts`, `repositories/events.ts`, `event-service.ts`다. 기존 SQL 27개와 종현 파일은 변경하지 않는다.

현재 문서는 구현 명세이며 실제 로컬 실행 결과는 [이번 인계](../../docs/collaboration/requests/minkyu/2026-09-29-event-db-handoff.md)를 따른다. 함수 존재나 SQL 작성만으로 실행 성공·어댑터 연결·배포 완료를 주장하지 않는다.

## 단일 canonical 저장소와 신규 저장 RPC

private.source_events가 유일한 실저장소다. private.events는 그 record를 typed-column으로 투영하는 view이며 normalized data를 별도로 복사하지 않는다. view와 원본 테이블 모두 anon/authenticated/service_role 직접 접근을 회수한다. private.valid_source_event_v1 원문을 보존하고 v2 검증으로 named CHECK를 교체한다. 신규 upsert_events는 provider를 E wire의 소문자·숫자 시작/하이픈 허용 1~32자로 제한하고 v1 writer는 원래 1~80자·밑줄 호환을 유지한다. 기존 stronger URL·공개 문자열·크기·기간 검증을 유지하며 공식 안내 링크가 없는 sourceUrl:null만 추가 허용한다. 기존 저장 기록을 삭제·이동·재생성하지 않는다.

upsert_events(p_events jsonb)는 service_role 전용이고 {receivedCount,insertedCount,updatedCount,staleCount}를 반환한다. private.upsert_canonical_events가 배치 전체를 먼저 검증하고 provider/sourceId 정렬 순서로 같은 identity를 잠그면서 삽입·갱신한다. 최신 수집 시각이 더 늦을 때만 update하므로 같은 시각·과거 입력은 staleCount다. 빈 배열은 네 count가 0이다. 기존 v1 저장 RPC도 같은 helper를 호출해 savedCount=insertedCount+updatedCount를 돌려준다. 리스트에서 빠진 기록을 삭제하거나 비용 unknown을 무료로 바꾸지 않는다.

## Deprecated 내부 저장: upsert_source_events_v1

```ts
rpc("upsert_source_events_v1", { p_events: SourceEventRecord[] })
// -> { savedCount: number }
```

- 실행 권한은 `service_role`에만 부여한다. 일반 회원·비로그인은 실행할 수 없다. 내부 HTTP 호출자 검증은 종현 event-sync 진입점에서 별도로 수행해야 하며 이 RPC를 일반 요청에 노출하지 않는다.
- `private.source_events`에 `id: uuid`, `provider`, `source_id`, 비교용 `collected_at`, 검증된 공개 데이터 `record: jsonb`를 저장한다. `provider + sourceId`가 유일 식별자다. 다른 제공처의 유사 행사를 자동 병합하지 않는다.
- 최초 저장 시 생성한 UUID를 모든 갱신에서 유지한다. 더 늦은 `collectedAt`만 갱신한다. 같은 시각 또는 과거 입력은 저장된 값을 덮지 않으며 `savedCount`에 포함하지 않는다. 같은 시각의 상이한 입력은 먼저 저장한 내용을 유지한다. 따라서 `savedCount`는 입력 개수나 처리한 전체 개수가 아닌 실제 삽입·최신 갱신한 수다.
- 한 배치에 같은 제공처·ID가 반복되면 SQLSTATE `22023`으로 배치 전체를 거절한다. 실행 순서로 하나를 임의 선택하지 않는다. 하나라도 잘못된 행사이면 전체 배치를 저장하지 않는다. 빈 배열은 `{ "savedCount": 0 }`이다.
- 한 요청 최대 1,000개·JSON 직렬화 8MiB, 한 행사 64KiB는 로컬 구현의 기술 제한이다. 서비스의 노출 개수 정책을 뜻하지 않는다.
- 원천 `active`와 `cancelled`만 허용한다. `unknown`을 정상 상태로 바꾸지 않고 거절한다. 취소는 저장되어 동일 identity의 과거 active 입력으로 되살아나지 않도록 한다.

입력 예시:

```json
{
  "p_events": [{
    "provider": "kopis",
    "sourceId": "fixture-event-001",
    "sourceStatus": "active",
    "title": "가상 전시",
    "category": "전시",
    "region": "서울",
    "placeName": null,
    "publicAddress": null,
    "admission": { "kind": "unknown" },
    "sourceUrl": "https://example.invalid/events/fixture-event-001",
    "collectedAt": "2026-09-29T09:00:00+09:00",
    "precision": "date",
    "startsOn": "2026-10-01",
    "endsOn": "2026-10-03"
  }]
}
```

## 공개 후보: list_event_candidates_v1

```ts
rpc("list_event_candidates_v1", {
  p_region: query.region ?? null,
  p_category: query.category ?? null,
})
// -> StoredEventRecord[]
```

- 비로그인·회원·내부 서비스 역할 모두 호출할 수 있다. 출처에서 정규화한 **공개 행사 정보**만 반환하며 공고의 비공개 만남 주소와 섞지 않는다.
- 반환 배열의 각 원소는 저장한 `SourceEventRecord`에 안정적인 UUID `id`를 추가한 형태다. `record`, `source_id`, 내부 비교 컬럼 같은 DB 구조는 반환하지 않는다.
- `region`·`category`는 정확히 일치하는 값만 사전 선택한다. SQL `null` 또는 인수 생략은 제한 없음이다. 빈 문자열은 유효한 필터가 아니다. 원천 값이 null이면 특정 필터와 일치하지 않는다. 지역·분류를 추측하거나 재매핑하지 않는다.
- 취소 행사는 반환하지 않는다. 과거·진행 중·예정 행사는 모두 후보에 포함한다. 시간·기간·검색어·신규/일반/작성 선택 모드·사용자 표시 순서는 기존 종현 `queryStoredEvents` → `selectEvents`에서 처리한다. DB 배열의 UUID순은 결정적인 전송 순서이며 상품 정렬 정책이 아니다.
- 사전 필터 적용 후 후보가 1,000개를 넘으면 SQLSTATE `54000`, `EVENT_CANDIDATE_LIMIT_EXCEEDED`로 실패한다. 1,000개만 잘라 성공으로 반환하지 않는다. 후보 제한은 임시 안전 경계이며 생산 환경에서는 기존 모드·정렬과 동일한 서버 페이지네이션 계약이 후속으로 필요하다.
- 결과 없음은 `[]`이다. 후보 목록은 같은 statement snapshot에서 읽는다.

## 필드·날짜·공개 정보 검증

모든 기본 필드와 해당 precision 필드를 정확히 요구한다. `category`, `region`, `placeName`, `publicAddress`가 없으면 null을 명시한다. SQL이 모르는 필드를 제거하고 저장하는 대신 입력 전체를 거절한다. 원천 원문·HTML 설명·비밀키·공고 상세 지점 등을 JSON 여분 필드에 넣을 수 없다.

| 필드 | 기술 검증 |
|---|---|
| provider | 영문 소문자·숫자로 시작, 이어지는 소문자·숫자·`_`·`-`, 1~80자 |
| sourceId / title | 각각 최대 200자 / 500자, 비어 있지 않은 공백 정리된 일반 문자열 |
| category / region | null 또는 최대 100자 일반 문자열 |
| placeName / publicAddress | null 또는 최대 300자 / 1,000자 일반 문자열 |
| admission | `{kind:"unknown"}`, `{kind:"free"}`, `{kind:"described",text:string}` 중 하나, text 최대 2,000자 |
| sourceUrl | null 또는 최대 2,048자 공개 HTTP(S) 안내 URL, DNS/IPv4 호스트, 포트가 있으면 1~65535 |
| collectedAt | 알려진 시간대가 명시된 ISO 시각, 최대 millisecond 정밀도 |

일반 문자열은 양끝 공백·빈 문자열·제어문자·`<`·`>`를 거절한다. HTML을 안전하다고 추정해 저장하거나 자동으로 제거하지 않는다. 공개 주소·비용을 없는 원문에서 만들어 채우지 않는다. 빈 선택 문자열은 어댑터가 null로 정규화한다.

`sourceUrl`은 API 요청 URL이 아닌 공개 안내 페이지 주소다. 사용자 이름·비밀번호가 붙은 URL, 공백·HTML·제어문자·역슬래시, 알려진 키·토큰·인증·비밀번호·서명 쿼리/fragment 이름과 인코딩된 파라미터 이름을 거절한다. 경로에 인증키가 들어갈 수 있는 `openapi.seoul.go.kr`, `apis.data.go.kr` 호스트 및 `kopis.or.kr`·`www.kopis.or.kr`의 `/openApi` API 요청 경로도 거절한다. KOPIS의 일반 공개 웹 안내 경로는 허용한다. 알려진 비밀 파라미터를 막는 것이 임의 문자열의 비밀 여부를 완전히 증명하지는 못한다. 어댑터가 불필요한 추적 정보와 비밀값을 제거한 공개 안내 주소를 공급할 책임은 유지한다. 외부 URL을 DB에서 가져오거나 검증 목적으로 호출하지 않는다.

- `precision:"date"`는 `startsOn`, `endsOn`의 실제 한국 달력 날짜를 보존한다. 종료 날짜를 포함하며 같은 날 행사도 허용한다. 시각을 알 수 없는 행사에 임의 시작 시각을 추가하지 않는다.
- 날짜는 연도 `0001`~`9999`의 실제 `YYYY-MM-DD`이며 `endsOn >= startsOn`이다. 다음 날 경계 계산이 불가능한 `endsOn="9999-12-31"`은 거절한다.
- `precision:"instant"`는 `startsAt`, `endsAt`를 사용하며 `endsAt > startsAt`이다. `Z` 또는 숫자 offset이 필수이고 `-00:00`은 알려지지 않은 시간대로 거절한다. 초·분·시·offset 범위와 실제 날짜를 확인한다. 원문 시각과 offset은 그대로 반환한다.
- date·instant 필드를 동시에 넣거나 다른 precision, 잘못된 윤년 날짜, 역전 기간, 누락된 비용, 잘못된 admission 추가 필드는 거절한다. `unknown` 비용을 무료로 바꾸지 않는다. 행사 입장료와 동행 비용을 합치지 않는다.

## 권한·실패·종현 연결

직접 테이블 접근은 `anon`, `authenticated`, `service_role` 모두 revoke하며 RLS를 활성화하고 직접 접근 정책을 두지 않는다. 두 RPC는 고정 빈 `search_path`의 SECURITY DEFINER로 필요한 작업만 수행한다. 내부 검사 함수는 외부 역할에서 실행할 수 없다.

| 상황 | 결과 |
|---|---|
| 일반 역할의 저장 RPC 실행·직접 테이블 조회 | `42501`, 권한 거절 |
| 누락/추가 필드·원천 unknown·비정상 날짜/URL/비용·중복 identity 배치 | `22023`, 고정 오류 코드, 전체 배치 미저장 |
| 동일·과거 collectedAt | 정상 응답, 해당 항목 savedCount 미포함, 기존 UUID·내용 유지 |
| 사전 필터 후 공개 후보 1,001개 이상 | `54000`, `EVENT_CANDIDATE_LIMIT_EXCEEDED`, 부분 목록 없음 |

종현의 createRpcEventRepository(db)는 신규 upsert_events/list_public_events에 연결하며 createRpcEventFilterRepository(db)는 list_event_filter_values에 연결한다. v1 후보 방식은 이전 어댑터 호환용이다. 공통 client·서비스 HTTP 연결은 C 담당의 수정·실제 검증 결과를 따른다. 내부 writer에는 검증된 내부 호출 문맥의 service client를, 공개 reader에는 역할에 맞는 공개/회원 client를 사용한다.

민규 공통 클라이언트에는 역할별 허용 목록을 반영했다. `_shared/db/public-client.ts`·`user-client.ts`는 `list_event_candidates_v1`만 허용하며 저장 RPC는 네트워크 요청 전에 거절한다. `_shared/db/internal-client.ts`는 `upsert_source_events_v1`와 `list_event_candidates_v1`을 허용한다. 내부 클라이언트 생성에는 기존의 service-role 키와 유효한 `INTERNAL_WORKER_SECRET` 설정이 모두 필요하며, HTTP 호출부는 기존 `requireInternalCaller` 검사 후 생성해야 한다.

후보 한도 `54000`은 공통 transport에 별도 공개 오류 코드를 추가하지 않았다. PostgREST의 HTTP 상태가 5xx이면 `EXTERNAL_UNAVAILABLE`(공통 HTTP 503), 다른 특별 분류에 해당하지 않는 4xx이면 `INTERNAL_ERROR`(공통 HTTP 500)로 안전하게 변환한다. SQL 원문·후보 정보를 공개하지 않고 실패로 남기며 빈 목록으로 대체하지 않는다.

후보 한도 오류를 빈 목록·부분 목록으로 숨기거나 공급사 원문을 오류 응답에 붙이지 않는다. 등록된 행사가 실제 운영일·회차·잔여석을 보장하지는 않는다. 저장·조회 RPC 구현과 공급사 수집·검색 화면·AI 연결·운영 배포 완료를 구분한다.

## 신규 공개 페이지·필터 RPC

list_public_events(p_filters jsonb,p_cursor jsonb,p_limit integer)는 anon/authenticated/service_role에 허용하고 {items:[...],nextCursor:null|{rank,key,id}}를 반환한다. p_filters는 mode 필수, period:{start:YYYY-MM-DD,end:YYYY-MM-DD} 선택(종료일 포함), ongoingOnly:boolean/query/region/category 선택이다. 추가 키·비정상 null/빈 선택 값·역전 기간·잘못된 커서는 22023이다. limit 1~50은 기술 한도이며 운영 노출 개수로 확정하지 않는다. now() 하나를 기준으로 KST 날짜·주간과 상태·정렬을 계산하고 클라이언트가 기준시각을 지정하지 못한다.

mode=overlapping은 선택 기간과 겹치는 행사(과거 포함), new_this_week는 한국 월요일00:00~다음월요일00:00 사이 새로 시작해 아직 종료하지 않은 행사, post_selection은 진행중/예정 행사다. 모든 mode는 취소 행사를 숨기고 신규 reader가 지원하는 provider 형식(소문자·숫자 시작, 하이픈 허용 1~32자)만 반환한다. 기존 33~80자·밑줄 provider는 저장소와 deprecated v1 조회로 보존한다. date 종료일은 포함, instant 종료시각은 제외한다. 키워드는 행사명·장소명·공개 주소 각 필드의 부분 일치이며 소문자·연속 공백 정규화를 적용한다. 지역/분류는 제공처 원문과 정확 일치한다.

제품의 ‘진행 중 행사도 포함’은 ongoingOnly=true가 아니다. 일반 목록의 선택은 mode=overlapping과 선택 기간(화면 기본은 한국 주간 월요일~일요일), ongoingOnly=false로 보내 기간과 겹치는 장기행사를 포함한다. ongoingOnly=true는 기존 기술 계약인 현재 진행중만 필터다. 화면의 주간 날짜 계산·옵션 연결은 별도 UI 작업이며 SQL 기능 존재를 UI 검증 성공으로 설명하지 않는다.

정렬은 진행중(최근 시작) → 예정(빠른 시작) → 종료(최근 종료), 동률 id다. SQL keyset 커서는 rank와 부호 있는 epoch-second key 문자열·UUID id이며 시간 경과에 따라 그룹이 바뀌면 페이지 간 누락·중복 가능성이 있어 snapshot 커서로 주장하지 않는다. 종현 repository는 필터 조건에 결합한 불투명 커서로 변환한다. 날짜/시각은 원래 precision을 유지하고 ISO 출력은 UTC millisecond 형식이다. items는 기존 EventRecord+id/state이며 API주소·상세설명·연락처·좌표를 추가하지 않는다.

list_event_filter_values()는 {regions:[{provider,value,count}],categories:[{provider,value,count}]}다. 신규 reader가 지원하는 provider 형식의 active 행사만 집계하고 null값/취소행사만 가진값을 제외한다. 값을 추정·지역매핑·공급사별합병하지 않는다. provider/value순 정렬이며 count는 실제 행 수다. 공개 RPC와 같은 역할에 허용한다.

## S14 회원 공개 프로필

get_public_profile(p_profile_id uuid)는 authenticated만 실행하며 실제 auth.uid와 본인 profiles행이 있어야 한다. 현재 가입자격이 바뀐 기존 회원도 읽을 수 있게 새활동 네이버 gate를 붙이지 않는다. 회원 없는 호출은 28000 또는 P0002/profile_required, 대상없는호출은 P0002/profile_unavailable, null인수는 22023이다. 비로그인/서비스역할의 실행권한은 회수한다.

반환은 {profileId,displayName,age,gender,avatarPath,bio,interests:[],conversationStyles:[],mbti:null|string,completedCount}다. 본인 또는 대상과 confirmed/completed 상태인 실제 동행 당사자는 전체실명을 표시하고 나머지는 mask_real_name으로 마스킹한다. 취소·분쟁 상태만으로 전체실명 관계를 부여하지 않는다. 다른 유효한 확정 관계가 있으면 그 관계에 따른 권한은 유지한다. 출생일·네이버subject·세션·가입인증자료·정확주소는 반환하지 않는다. 사진은 기존 저장path이고 다운로드서명은 별도 이미지흐름이다.

private.profile_traits를 그대로 조회하고 새로운 traits테이블을 만들지 않는다. 미입력 관심사/대화방식은 []이고 MBTI는 null이다. completedCount는 private.completed_appointment_count로 계산하여 실제완료기록의 distinct약속수만 센다. 공개후기·칭찬·summary적격성과 완료count를 혼동하지 않는다. 점수/당도산식은 만들지 않는다. get_my_profile은 변경하지 않는다. 공개후기·칭찬·요약은 기존 분리RPC를 호출한다.

## 이번 변경 검증 경계

tests/database/minkyu/common_connections.sql과 경합runner에서 null sourceUrl·강한URL차단·양방향 v1/v2저장호환·기존ID보존·sameTimestampstale·역순batch경합·view권한회수·기간/그룹/커서·filtercounts·공개성향/관계별이름/완료횟수·get_my_profile불변을 검사한다. 선행event_storage 원본을 적용하고 새2SQL을 순차재생한 단일rollback검증의 실제결과는 총괄이 기록한다. DB작성·정적검사와 실제공급사수집·모델호출·UI·운영배포 결과는 구분한다.

기존 wide provider(33~80자 또는 밑줄)는 source_events/view 및 deprecated list_event_candidates_v1에서 그대로 보존한다. 신규 list_public_events와 list_event_filter_values는 현재 E reader가 지원하는 1~32자·하이픈 provider 범위에 한정한다. 따라서 legacy 형식의 기록이 신규 페이지나 필터 목록 전체를 오류로 만들지 않는다. 해당 기록을 삭제·이름 변경·재저장하지 않으며 신규 API가 과거 provider 전체를 지원한다고 설명하지 않는다. 더 넓은 provider를 신규 화면에 연결하려면 reader와 RPC 계약을 함께 확장해야 한다. 실제 운영 자료가 있다는 뜻은 아니며 회귀 검사는 합성 legacy 기록으로 수행한다.
