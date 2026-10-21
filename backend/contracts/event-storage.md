# 행사 저장·페이지 조회·회원 공개 프로필 DB 계약

## 2026-10-20 현행 기준과 이 문서의 적용 범위

이 문서는 현재 요구와 구현 계약을 구분한다. 아래 기술 시그니처·기존 SQL·검증 기록은 실제 구현 근거이며 새 정책 요구가 자동 구현됐다는 뜻이 아니다.

- 담당은 현재 민규=BE·AI·검색·행사·서버 운영, 종현=FE·UX/UI·앱 API/세션 소비·빌드, 유미=UT·출시/지원 책임이다. 아래 옛 종현 BE·성호 UI 배정은 당시 기록이며 현재 실행 권한으로 사용하지 않는다. 구체 파일은 현행 소유권 정책을 따른다.

- AI 탐색 동의는 첫 사용 시 받고 거절하면 일반 검색을 유지한다. 후기 요약은 가입 시 열람·내 프로필 생성/노출·작성 후기 활용을 기본 미선택인 별도 선택 세 항목으로 받는다. 전체 동의와 개별 자세히 보기를 유지하고 미동의 가입/일반 동행을 허용한다. 세 동의의 철회는 독립적이다. 현재 서버의 summary_allowed 하나·review_summary 일괄 철회가 이 세분화 요구를 구현했다고 해석하지 않는다. 테스트 계정 동의 간주는 실제 동의 증거·DB 값 변경·회원 원문 전송 승인이 아니다.

- KOPIS는 전체 공연·연극·뮤지컬·클래식·국악·대중음악·무용·대중무용·서커스/마술·복합·아동·대학로·내한·축제 14항목, 어제까지 최근7일·매일 갱신이다. basedate 누락만으로 영구 공개 보류하지 않고 공식 사이트의 실제 기간·조건·공연ID/순위/순서를 대조한 분류만 공개하는 A안을 적용한다. 요청 날짜로 기간을 확정하거나 일일순위를 합산하지 않는다. 확인 기간·시각·출처를 표시하고 실패 때 마지막 검증 기간을 유지한다. 아래 all/musical·basedate 필수 parser·not_enabled는 현재 구현/당시 검증의 기술적 한계이며 최신 제품 정책이 아니다. 일반 공연 수집·칼럼 매핑은 순위 대조와 병행한다.

- 직접 입력 행사는 해당 공고에만 저장/표시하며 공용 목록·별도 행사 상세·검수 후 공용화는 만들지 않는다. 행사명 필수, 공개 행사장 장소/주소 선택이며 개인 주소를 금지한다. 새 연결은 예정/진행 중만 허용하고 종료·공식취소·연기일정미정은 제한한다. 단순 검색 누락은 취소/비표출이 아니다. 제공기관 비표출 원천의 정보와 상세 진입만 숨기고 공고/독립 만남 장소·다른 유효 공개 원천은 유지한다. 공식 동일 개최 식별근거만 통합에 사용하고 원천ID·공고관계·필드출처·가역 이력을 보존한다. 현재 eventId UUID 저장을 직접 입력·통합·비표출 구현 완료로 표시하지 않는다.

- 서울은 키/응답의 평문 HTTP 수집을 활성화하지 않는다. 검토된 HTTPS 자동 수집 경로·실제 최신 응답 envelope·페이지 재개·진행 중 갱신 확인까지 보류한다. 홈페이지 HTTPS 성공이나 HTTP 앞에 s를 붙인 주소는 API 전송 보안 검증이 아니다. 이 보류는 다른 공급사·공통 칼럼/화면 준비의 중단을 뜻하지 않는다.

최신 기준: [정책.md](../../정책.md). 구현과 남은 조건: [서버·DB 대조 원장](../../docs/collaboration/requests/jonghyun/2026-10-20-policy-implementation-audit/server-audit.json).


## 2026-10-20 행사 UX 확정과 서버 구현 경계

기준은 [최종 행사 UX 확정](../../docs/collaboration/requests/jonghyun/2026-10-20-event-ux-approved-spec.md)이다. 사용자 명시 전체 문서 동기화 승인으로 반영하며 제품 설계 확정과 실제 코드·DB·배포 완료를 구분한다.

행사 연결은 선택이고 행사 기간과 동행 일정의 겹침을 강제하지 않는다. 검색은 조회 가능한 전체 기간이며 동행 일정으로 자동 축소하지 않는다. 캘린더에 행사 진행 날짜만 강조한다. 일반 목록의 이번 주 신규 미종료·진행 중 포함·과거 조회·10개씩 더보기는 유지한다.

확실한 공식 공통 식별자·정확한 공식 행사 상세 링크 등으로 동일 개최 단위가 확인된 원천만 대표 카드·상세·연결 공고로 통합한다. 공통 기관 홈페이지·제목/날짜/장소 유사성은 통합 근거가 아니다. 근거 부족이면 출처별 유지하며 상시 수동 검수를 만들지 않는다. 모든 provider+sourceId·원천별 공고 관계·근거·통합/분리 기록을 유지하고 되돌리기를 지원해야 한다. 먼저 검증된 공개 원천을 대표로 유지하고 빈 항목만 다른 검증된 공개 원천으로 보완하며 필드별 출처를 기록한다. 대표 비표출 시 해당 값을 재사용하지 않고 유효 원천으로 전환한다.

비표출 원천 자료만 숨기고 다른 유효 공개 원천은 유지한다. 유효 공개 원천이 없으면 `연결된 행사 정보를 현재 제공할 수 없어요` / `행사 취소를 의미하지는 않아요` 안내로 대체하며 원천명·이미지·설명·주소·상세 이동을 숨긴다. 공고·약속·내부 연결은 보존한다. 기간·장소·취소/연기 등 핵심 충돌은 `기관별 정보가 달라 확인이 필요해요` 안내와 새 연결 제한으로 처리한다. 재표출은 명시 표출 상태·공개 조건·최신 자료 확인 뒤 자동 복원하며 종료/취소 안내는 유지한다.

정상 수집·유효 기간을 갖추되 취소 상태 항목이 미제공인 경우와 오류/손상/상태 해석 실패를 구분해 저장·응답해야 한다. 전자는 정상 개최 보장 없이 새 연결을 허용하고 후자는 허용 근거로 쓰지 않는다. 새 연결은 종료/공식취소/비표출/연기 일정 미정이면 제한한다. 단순 검색 누락은 취소·삭제·비표출 증거가 아니다.

현재 기술 저장소는 아래 provider+sourceId별 원천행 저장 구조이며 공식 근거 통합 관계·필드별 출처·분리 이력·직접입력 행사 저장·공개제어·상태 알림이 완성된 구조가 아니다. 현재 RPC/DTO 예시를 새 통합 스키마로 바꾸지 않았으며 민규의 후속 구현·마이그레이션·실제 검증이 필요하다. KOPIS 순위는 이 통합과 별개다.


현재 담당(2026-10-14): 이 서버 계약과 BE·AI 구현은 민규 전담이며 프론트 클라이언트 소비·UX/UI는 종현, QA는 공통(민규·종현·유미), UT는 유미다. 아래 과거 구현자·검사·인계 증거는 당시 기록으로 보존한다.

현재 기준은 [정책.md](../../정책.md)다. 아래에서 현재 정책 목표와 기존 기술 인터페이스를 구분한다. 이번 문서 동기화는 서버 코드·SQL·설정·DB·외부 호출·배포를 변경하거나 검증하지 않았다.

기준 인터페이스는 `_shared/integrations/events/port.ts`의 SourceEventRecord/StoredEventRecord와 기존 normalize·repository·event-service다. 현재 저장·페이지·필터 RPC를 재사용하고 공급사별 실제 연결·자료 범위·UI/AI 연결을 검증한다.

KOPIS·TourAPI·서울 열린데이터 실제 연동이 출시 목표다. 초기 과거1개월·미래오늘부터31일과 오래 진행 중인 행사를 갱신하며 매일00:01KST 등록한다. 31일구간·100건/쪽·최대5쪽·쪽당15초이며 진행 위치·미수집 범위를 보존한다.

일반 목록은 이번 주 신규 중 미종료 기본, 진행 중 포함은 이전 주 시작 미종료까지다. 과거 조회를 유지하며 한 주는 월요일00:00~다음월요일00:00 미만, 월별 주차는 목요일 귀속 달의 첫 목요일 포함 주부터 센다. 공고·행사10개씩 조회하고 작성용 선택은 연결 가능한 진행 중·예정 행사에서 동행 일정과의 겹침을 강제하지 않는다.

KOPIS 순위 선택은 전체 공연(기본), 연극, 뮤지컬, 클래식, 국악, 대중음악, 무용, 대중무용, 서커스/마술, 복합, 아동, 대학로, 내한, 축제의 14항목이다. 표시명은 서양음악(클래식)→클래식, 한국음악(국악)→국악, 무용(서양/한국무용)→무용으로 바꾸되 원천 코드·원래 분류는 보존한다. 아동·대학로·내한·축제는 장르와 구분되는 공식 특성·지역 조건을 따른다. 집계는 어제까지 최근7일, 갱신은 매일이다. 분류마다 공식 사이트에 표시된 실제 기간·공식 분류/지역·정렬 기준과 API 공연ID·순위·순서가 일치한 Top10만 공개한다. basedate가 없어도 이 대조를 통과한 목록은 공개할 수 있으나 API 내부 집계 기간을 증명했다고 안내하지 않는다. 요청 날짜만으로 기간을 확정하거나 일간 순위를 합산한 자체 주간 순위를 만들지 않는다. 동률은 공식 표시 순서 그대로 유지하고 10개 미만이면 검증한 개수만 표시한다. 출처·실제 확인 기간·확인 시각을 표시한다. 갱신 실패 시 마지막 검증 목록의 기존 기간을 그대로 유지하고 갱신 지연을 안내하며 최신 날짜로 바꾸지 않는다. 최초 미검증·미지원 분류는 공식 사이트 링크를 제공하고 자체 순위로 채우지 않는다. 분류별 성공·실패를 독립 관리한다. 현재 API 매핑·자동 대조·저장·서버 응답 구현과 운영 검증은 별도이며 이 정책 변경만으로 연동 완료로 표시하지 않는다.

## 단일 canonical 저장소와 신규 저장 RPC

private.source_events가 유일한 실저장소다. private.events는 그 record를 typed-column으로 투영하는 view이며 normalized data를 별도로 복사하지 않는다. view와 원본 테이블 모두 anon/authenticated/service_role 직접 접근을 회수한다. private.valid_source_event_v1 원문을 보존하고 v2 검증으로 named CHECK를 교체한다. 신규 upsert_events는 provider를 E wire의 소문자·숫자 시작/하이픈 허용 1~32자로 제한하고 v1 writer는 원래 1~80자·밑줄 호환을 유지한다. 기존 stronger URL·공개 문자열·크기·기간 검증을 유지하며 공식 안내 링크가 없는 sourceUrl:null만 추가 허용한다. 기존 저장 기록을 삭제·이동·재생성하지 않는다.

upsert_events(p_events jsonb)는 service_role 전용이고 {receivedCount,insertedCount,updatedCount,staleCount}를 반환한다. private.upsert_canonical_events가 배치 전체를 먼저 검증하고 provider/sourceId 정렬 순서로 같은 identity를 잠그면서 삽입·갱신한다. 최신 수집 시각이 더 늦을 때만 update하므로 같은 시각·과거 입력은 staleCount다. 빈 배열은 네 count가 0이다. 기존 v1 저장 RPC도 같은 helper를 호출해 savedCount=insertedCount+updatedCount를 돌려준다. 리스트에서 빠진 기록을 삭제하거나 비용 unknown을 무료로 바꾸지 않는다.

## Deprecated 내부 저장: upsert_source_events_v1

```ts
rpc("upsert_source_events_v1", { p_events: SourceEventRecord[] })
// -> { savedCount: number }
```

- 실행 권한은 `service_role`에만 부여한다. 일반 회원·비로그인은 실행할 수 없다. 내부 HTTP 호출자 검증은 민규 담당 event-sync 진입점에서 별도로 수행해야 하며 이 RPC를 일반 요청에 노출하지 않는다.
- `private.source_events`에 `id: uuid`, `provider`, `source_id`, 비교용 `collected_at`, 검증된 공개 데이터 `record: jsonb`를 저장한다. `provider + sourceId`가 유일 식별자다. 현재 원천 저장 구조는 다른 제공처의 유사 행사를 자동 병합하지 않는다. 제품 목표의 공식 근거 통합 관계는 별도 후속이며 원천행 식별자를 대체하지 않는다.
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
- 취소 행사는 반환하지 않는다. 과거·진행 중·예정 행사는 모두 후보에 포함한다. 시간·기간·검색어·신규/일반/작성 선택 모드·사용자 표시 순서는 기존 `queryStoredEvents` → `selectEvents`에서 처리한다. DB 배열의 UUID순은 결정적인 전송 순서이며 상품 정렬 정책이 아니다.
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

## 권한·실패·서버 연결

직접 테이블 접근은 `anon`, `authenticated`, `service_role` 모두 revoke하며 RLS를 활성화하고 직접 접근 정책을 두지 않는다. 두 RPC는 고정 빈 `search_path`의 SECURITY DEFINER로 필요한 작업만 수행한다. 내부 검사 함수는 외부 역할에서 실행할 수 없다.

| 상황 | 결과 |
|---|---|
| 일반 역할의 저장 RPC 실행·직접 테이블 조회 | `42501`, 권한 거절 |
| 누락/추가 필드·원천 unknown·비정상 날짜/URL/비용·중복 identity 배치 | `22023`, 고정 오류 코드, 전체 배치 미저장 |
| 동일·과거 collectedAt | 정상 응답, 해당 항목 savedCount 미포함, 기존 UUID·내용 유지 |
| 사전 필터 후 공개 후보 1,001개 이상 | `54000`, `EVENT_CANDIDATE_LIMIT_EXCEEDED`, 부분 목록 없음 |

민규 담당 createRpcEventRepository(db)는 신규 upsert_events/list_public_events에 연결하며 createRpcEventFilterRepository(db)는 list_event_filter_values에 연결한다. v1 후보 방식은 이전 어댑터 호환용이다. 공통 client·서비스 HTTP의 실제 연결은 담당자가 현재 소스와 대조한다. 내부 writer에는 검증된 내부 호출 문맥의 service client를, 공개 reader에는 역할에 맞는 공개/회원 client를 사용한다.

공개/회원 client는 현재 공개 행사·필터·호환 후보 RPC를, 내부 client는 저장 RPC를 허용한다. 정확한 allowlist는 auth-runtime 계약과 현재 소스로 대조한다. 내부 저장은 requireInternalCaller 성공 후 내부 client로 호출한다.

후보 한도 `54000`은 공통 transport에 별도 공개 오류 코드를 추가하지 않았다. PostgREST의 HTTP 상태가 5xx이면 `EXTERNAL_UNAVAILABLE`(공통 HTTP 503), 다른 특별 분류에 해당하지 않는 4xx이면 `INTERNAL_ERROR`(공통 HTTP 500)로 안전하게 변환한다. SQL 원문·후보 정보를 공개하지 않고 실패로 남기며 빈 목록으로 대체하지 않는다.

후보 한도 오류를 빈 목록·부분 목록으로 숨기거나 공급사 원문을 오류 응답에 붙이지 않는다. 등록된 행사가 실제 운영일·회차·잔여석을 보장하지는 않는다. 저장·조회 RPC 구현과 공급사 수집·검색 화면·AI 연결·운영 배포 완료를 구분한다.

## 신규 공개 페이지·필터 RPC

list_public_events(p_filters jsonb,p_cursor jsonb,p_limit integer)는 anon/authenticated/service_role에 허용하고 {items:[...],nextCursor:null|{rank,key,id}}를 반환한다. p_filters는 mode 필수, period:{start:YYYY-MM-DD,end:YYYY-MM-DD} 선택(종료일 포함), ongoingOnly:boolean/query/region/category 선택이다. 추가 키·비정상 null/빈 선택 값·역전 기간·잘못된 커서는 22023이다. limit1~50은 기존 기술 한도이며 화면은10개씩 요청한다. now() 하나를 기준으로 KST 날짜·주간과 상태·정렬을 계산하고 클라이언트가 기준시각을 지정하지 못한다.

mode=overlapping은 선택 기간과 겹치는 행사(과거 포함), new_this_week는 한국 월요일00:00~다음월요일00:00 사이 새로 시작해 아직 종료하지 않은 행사, post_selection은 진행중/예정 행사다. 모든 mode는 취소 행사를 숨기고 신규 reader가 지원하는 provider 형식(소문자·숫자 시작, 하이픈 허용 1~32자)만 반환한다. 기존 33~80자·밑줄 provider는 저장소와 deprecated v1 조회로 보존한다. date 종료일은 포함, instant 종료시각은 제외한다. 키워드는 행사명·장소명·공개 주소 각 필드의 부분 일치이며 소문자·연속 공백 정규화를 적용한다. 지역/분류는 제공처 원문과 정확 일치한다.

제품의 ‘진행 중 행사도 포함’은 ongoingOnly=true가 아니다. 기존 mode=overlapping·주간 기간은 장기 진행 행사를 포함할 수 있지만 이미 종료된 이번 주 행사도 포함할 수 있다. 현재 목표인 신규 미종료+이전 주 시작 미종료에 맞도록 조회 계약을 변경·검증하고 과거 기간 조회는 별도 유지한다. ongoingOnly=true는 기존 기술 계약인 현재 진행중만 필터다. 화면의 주간 날짜 계산·옵션 연결은 별도 UI 작업이며 SQL 기능 존재를 UI 검증 성공으로 설명하지 않는다.

정렬은 진행중(최근 시작) → 예정(빠른 시작) → 종료(최근 종료), 동률 id다. SQL keyset 커서는 rank와 부호 있는 epoch-second key 문자열·UUID id이며 시간 경과에 따라 그룹이 바뀌면 페이지 간 누락·중복 가능성이 있어 snapshot 커서로 주장하지 않는다. 민규 담당 repository는 필터 조건에 결합한 불투명 커서로 변환한다. 날짜/시각은 원래 precision을 유지하고 ISO 출력은 UTC millisecond 형식이다. items는 기존 EventRecord+id/state이며 API주소·상세설명·연락처·좌표를 추가하지 않는다.

list_event_filter_values()는 {regions:[{provider,value,count}],categories:[{provider,value,count}]}다. 신규 reader가 지원하는 provider 형식의 active 행사만 집계하고 null값/취소행사만 가진값을 제외한다. 값을 추정·지역매핑·공급사별합병하지 않는다. provider/value순 정렬이며 count는 실제 행 수다. 공개 RPC와 같은 역할에 허용한다.

## S14 회원 공개 프로필

get_public_profile(p_profile_id uuid)는 authenticated만 실행하며 실제 auth.uid와 본인 profiles행이 있어야 한다. 현재 가입자격이 바뀐 기존 회원도 읽을 수 있게 새활동 네이버 gate를 붙이지 않는다. 회원 없는 호출은 28000 또는 P0002/profile_required, 대상없는호출은 P0002/profile_unavailable, null인수는 22023이다. 비로그인/서비스역할의 실행권한은 회수한다.

반환은 {profileId,displayName,age,gender,avatarPath,bio,interests:[],conversationStyles:[],mbti:null|string,completedCount}다. 본인 또는 대상과 confirmed/completed 상태인 실제 동행 당사자는 전체실명을 표시하고 나머지는 mask_real_name으로 마스킹한다. 취소·분쟁 상태만으로 전체실명 관계를 부여하지 않는다. 다른 유효한 확정 관계가 있으면 그 관계에 따른 권한은 유지한다. 출생일·네이버subject·세션·가입인증자료·정확주소는 반환하지 않는다. 사진은 기존 저장path이고 다운로드서명은 별도 이미지흐름이다.

private.profile_traits를 그대로 조회하고 새로운 traits테이블을 만들지 않는다. 미입력 관심사/대화방식은 []이고 MBTI는 null이다. completedCount는 private.completed_appointment_count로 계산하여 실제완료기록의 distinct약속수만 센다. 공개후기·칭찬·summary적격성과 완료count를 혼동하지 않는다. 현재 당도 산식은 정책7-4절에 확정됐으며 이 기존 RPC에 점수 계산·반환이 연결됐다고 해석하지 않는다. get_my_profile은 변경하지 않는다. 공개후기·칭찬·요약은 기존 분리RPC를 호출한다.

## 후속 검증 경계

tests/database/minkyu/common_connections.sql과 경합runner에서 null sourceUrl·강한URL차단·양방향 v1/v2저장호환·기존ID보존·sameTimestampstale·역순batch경합·view권한회수·기간/그룹/커서·filtercounts·공개성향/관계별이름/완료횟수·get_my_profile불변을 검사한다. 선행event_storage 원본을 적용하고 새2SQL을 순차재생한 단일rollback검증의 실제결과는 총괄이 기록한다. DB작성·정적검사와 실제공급사수집·모델호출·UI·운영배포 결과는 구분한다.

기존 wide provider(33~80자 또는 밑줄)는 source_events/view 및 deprecated list_event_candidates_v1에서 그대로 보존한다. 신규 list_public_events와 list_event_filter_values는 현재 E reader가 지원하는 1~32자·하이픈 provider 범위에 한정한다. 따라서 legacy 형식의 기록이 신규 페이지나 필터 목록 전체를 오류로 만들지 않는다. 해당 기록을 삭제·이름 변경·재저장하지 않으며 신규 API가 과거 provider 전체를 지원한다고 설명하지 않는다. 더 넓은 provider를 신규 화면에 연결하려면 reader와 RPC 계약을 함께 확장해야 한다. 실제 운영 자료가 있다는 뜻은 아니며 회귀 검사는 합성 legacy 기록으로 수행한다.

## 2026-10-19 목록 페이지 연결·상한 수정

KOPIS/TourAPI 목록 lane의 영속 cursor는 다음 페이지 숫자와 일치해야 한다. collector는 이를 검사한 뒤 공급사에는 page만 전달한다. 공급사 transport의 임의 cursor 거절은 유지하며, ongoing의 원천ID cursor는 변경하지 않는다. 공급사가 건너뛴 nextCursor를 반환하면 DB commit 전에 거절한다.

TourAPI의999페이지 요청 상한과 전체 수집 완료를 구분한다. 응답 totalCount에 남은 항목이 있으면 nextCursor를 유지하고 collector는 `PROVIDER_PAGE_LIMIT` partial을 반환한다.1000페이지 실제 요청은 기존 transport 검사가 거절한다. 기존 runtime의 상한 실패 정리와 실제 DB 증거는 별도로 판단한다.

실제 공급사 factory와 합성 fetch·메모리 progress store를 연결한 신규12개 및 관련 기존 회귀를 포함해78개가 통과했다. 2페이지·5페이지 처리 후6페이지 재개·중복 효과 방지·저장cursor불일치·opaque ongoing·999페이지 잔여를 확인했다. [원 영수증](/private/tmp/yumidang-event-pagination-20261019/receipt.json)의 source3 SHA를 독립 검토했다. 외부 공급사 호출·실제 DB write·00:01운영등록·앱 표시 검증을 수행한 증거는 아니다. 최신 전체 잔여는 [민규 전체 담당](../../docs/collaboration/requests/minkyu/2026-10-19-minkyu-full-scope.md)에 유지한다.


## 2026-10-08 공개 상세 HTTP

`GET /events/{eventId}`는 기존 저장소의 공개 투영을 재사용하는 `get_public_event`에 연결했다. 비로그인과 선택적 회원 JWT를 지원하되 잘못된 JWT를 비로그인으로 낮추지 않는다. 최신 저장 정보 및 취소 상태를 제공하고 공고의 정확한 만남 위치를 추가하지 않는다. 본인 숨김 행사 직접 조회는 404이며 다른 회원에게는 그대로 제공한다.

`GET /events/rankings` → `get_public_event_ranking_state`의 현재 응답은 `{status:"not_enabled",reason:"KOPIS_RANKING_PROVIDER_VERIFICATION_PENDING"}`다. 이 not_enabled는 기존 구현의 현재 응답이며, 새 공식 사이트 대조 공개·14분류 정책의 구현 완료를 뜻하지 않는다. 검증 상태·기간·분류·이전 성공 목록·지연 상태를 연결하는 별도 구현이 필요하다. 요청 날짜를 집계 기간으로 추정하거나 자체 순위를 생성하지 않는다. 공급사 호출은 발생하지 않는다.

## 2026-10-20 KOPIS 공식 대조 공개 gate 구현

WBS7.8의 서버 순수 검증 범위다. `KOPIS_RANKING_CATEGORIES`는 14개 키(`all`, `theatre`, `musical`, `classical`, `traditional`, `popular_music`, `dance`, `popular_dance`, `circus_magic`, `mixed`, `children`, `daehakro`, `visiting`, `festival`)와 표시명·장르/특성/지역 구분을 제공한다. 원천 `cate`는 `originalGenre`로 보존하고 표시명 세 개만 정규화한다. 특성·지역 분류를 장르 코드로 추정하지 않는다.

내부 신뢰 수집기가 가져온 API XML과 공식 사이트의 관찰 결과를 `verifyKopisOfficialRanking`으로 대조한다. 입력은 분류, 실제 표시 기간, 공식 조건의 정규화된 표시명, `official_display` 순서, 실제 확인 시각, 고정 공식 안내 URL, Top10의 공연ID·순위 목록이다. 요청 기간은 어제까지 최근7일이어야 하고 두 목록은 순서까지 일치해야 한다. 동률은 그대로 유지하며 10개 미만은 확인한 개수만 유지한다. 원천 basedate가 있으면 일치해야 하고 없으면 공식 대조 기간을 공개하되 `apiPeriodVerified:false`로 내부 집계기간 증명과 구분한다. 15분 이내 관찰만 새 대조에 사용한다. 이는 검증 실행의 기술 신선도 제한이며 제품의 순위 갱신 주기를 바꾸지 않는다.

반환 snapshot은 중첩 객체까지 동결하고 프로세스 내부 capability로 등록한다. 단순 `{periodVerification:"verified"}`·JSON 복제·DB JSON 재로딩만으로 공개/저장을 승인하지 않는다. `publicKopisRanking`, 저장 wrapper와 durable runtime의 완료 RPC 전 단계 모두 이 gate를 검사한다. 실패/미검증 분류는 공식 링크와 빈 목록을 반환하고, 보존된 같은 분류의 검증 snapshot은 기존 실제 기간·확인 시각을 유지하며 `refreshDelayed:true`를 표시한다. 다른 분류의 성공 목록으로 대체하지 않는다.

**신뢰 경계:** 대조 함수는 회원·비로그인 HTTP 입력에 연결하지 않는다. 함수 자체가 외부 사이트를 호출하거나 진위를 독립 증명하지는 않는다. 공식 관찰 수집기·영속 증거·DB 재검증/원자 게시가 연결되기 전 `GET /events/rankings`의 기존 `not_enabled`와 SQL 차단은 유지한다. 기존 영속 작업 lane은 all/musical 두 개뿐이며 나머지 12개를 요청하면 공급사/RPC 호출 없이 `RANKING_CATEGORY_LANE_NOT_CONNECTED`로 중단한다. 다른 분류를 musical lane에 넣지 않는다. 신규 SQL migration·실제 공급사 호출·DB·운영 적용은 이번 검증에서 0회다.

관련 검증: 합성 49개(Node test), 두 구현 진입점 Deno typecheck PASS. WBS7.8 전체 완료나 공식 실제 14분류 대조 완료를 뜻하지 않는다. 후속은 공식 관찰 수집·원본 증거 저장·분류별 영속 lane/DB 게시·제품 응답/앱 소비 연결과 실제 검증이다.

### 공식 공개 페이지 관찰과 자동 수집 잔여

2026-10-20 키 없는 공개 웹 조회에서 [공식 PC 순위 페이지](https://kopis.or.kr/por/boxoffice/boxoffice.do?menuId=MNU_00024)는 본문 추출이 비어 있었고, [공식 모바일 순위 페이지](https://kopis.or.kr/mob/box/boxoffice.do)는 날짜/선택 입력과 빈 결과 안내만 추출됐다. 공식 검색 색인의 [PC 순위 페이지](https://kopis.or.kr/por/boxoffice/boxoffice.do?STDG_CPSGG_CD=&endDate=20261007&excelGbn=0&genre_code=CCCA&menuId=MNU_00024&mt20Id=PF293222&rankType=ntssAmountSm&search=boxoffice&seatScale=&startDate=20260908&type=m)에는 날짜·지역·정렬 선택 및 `startDate/endDate/genre_code/mt20Id/rankType` query가 관찰됐으나, 이는 현재 순위의 실제 기간·선택 조건·공연ID/순서 대조 증거가 아니다. 공식 메인의 분류 선택에서는 장르와 별도 특성 선택이 확인되지만, 그 버튼을 API 필터로 추정하지 않는다.

웹 추출만으로는 행 데이터·실제 선택된 기간/조건·공개 JSON endpoint 계약을 확보하지 못했다. 로컬의 키 없는 공식 HTML 읽기는 DNS 해석 실패로 원문을 확보하지 못했다. 따라서 미확인 HTML 선택자/JSON 경로/분류 코드를 추정한 collector나 영속 게시 SQL을 추가하지 않았다. 후속은 접근 가능한 환경에서 공식 공개 HTML/사용 스크립트/동적 응답의 실제 계약을 읽기 관찰하고, 기간·조건·ID·순위·순서를 함께 추출할 수 있음을 확인한 뒤 bounded HTTPS collector를 연결하는 것이다. OpenAPI 키 사용·인증된 API 호출·쓰기·실제 공개는 0회다.

## WBS4.4 공고 전용 직접 입력·행사 변경 계약 구현

추가 migration `20261020130000_post_private_events.sql`과 기존 공고 HTTP를 확장했다. 실제 DB 적용·운영·앱 소비는 아래 검증 증거와 별도로 판정한다.

- 기존 공고 생성/수정 입력에 선택 `manualEvent:{title,placeName,publicAddress,publicAddressConfirmed}`를 추가한다. 제목1~200자, 장소0~200자, 공개 주소0~300자이며 모두 문자열, 확인은 boolean이다. 주소가 있으면 확인이 true여야 한다. 추가 키·HTML·제어문자를 거절한다. 공개 주소는 만남 상세 주소/위치와 별개다.
- `eventId`와 non-null 직접 입력은 배타적이다. 수정에서 두 키 생략은 보존, 직접 입력 object만 주면 원천 연결 해제, 원천 UUID만 주면 직접 입력 해제다. 각각 명시 null은 그 항목의 해제이며 전체 해제는 두 키를 null로 보낸다. 기존 클라이언트의 생략 의미는 유지한다.
- 직접 입력은 private 공고별 테이블에만 저장하며 `source_events`·공용 행사 UUID·공용 목록/독립 상세를 생성하지 않는다. 원생성 직접 입력과 현재 값을 분리해 수정 후 원생성 재시도를 과거 값으로 되돌리지 않는다. 기존 `GET /posts/:id`와 `get_service_post`의 exact 응답 키는 변경하지 않는다. 새 명시 `GET /posts/:id/event-link` → `get_service_post_event_link`는 원래 상세 RPC의 탈퇴·숨김·공개 권한 검사를 먼저 실행하고 `{postId,eventId,manualEvent,linkedEvent,eventLinkState}`만 반환한다. 비로그인도 같은 공개 인증 연결을 사용하고 잘못된 JWT를 익명으로 재시도하지 않는다. 기존 비공개 상세/이름은 확장 DTO에 복사하지 않는다.
- 직접 입력 세 문자열은 기존 공개 content inspection에 모두 포함하고 ticket digest는 전체 p_input을 결합한다. 기존 검사가 비활성이면 새 직접 입력 저장을 `manual_event_inspection_not_enabled`로 거절한다. 확인 checkbox를 개인정보 검사 승인으로 취급하지 않는다. 검사기/서버 연결 없이 텍스트를 우회 저장하지 않는다.
- 직접 입력은 동의 condition fingerprint와 공고 행사명 검색에 포함한다. 행사의 날짜와 동행 날짜 겹침을 새로 강제하지 않는다. 기존 확정 동행 간 일정 충돌 판정은 유지한다.

### 확정 후 명시적인 행사 변경 합의

확정된 공고는 기존의 일반 전체 수정을 계속 거절한다. 작성자는 기존 `/posts/:id/update`에 전체 현재 공고 값과 새 행사 선택, 신규 `eventChangeId` UUID를 전송해 **행사 전용 제안**을 만든다. 행사 이외 필드는 현재 값과 같아야 한다. 콘텐츠 검사를 통과한 제안만 기존 약속 변경 원장에 저장하고 제안 시 현재 공고/행사는 바꾸지 않는다. 만료는 제안+6시간과 기존 시작 중 빠른 때이며 같은 시각의 수락을 거절한다. 상대·자격·분쟁·현재 updatedAt·일정 충돌의 기존 검증을 보존한다.

기존 약속 변경 조회의 행사 제안에만 `changeKind:"event"`, `eventFingerprint`, `newEventInput:{eventId,manualEvent}`, `newLinkedEvent`가 추가된다. 제안 원문은 대기 중의 당사자에게만 반환한다. 종료 시 원문을 정리하고 fingerprint·상태·조건 버전만 남긴다. 기존 날짜/장소 전용 제안 응답에는 새 필드를 추가하지 않는다.

**구형 수락은 행사 제안을 수락할 수 없다.** 새 `POST /appointments/:id/schedule-change/accept-event`는 정확히 `{changeId,conditionVersion,eventFingerprint}`를 받으며 fingerprint는 소문자 hex64다. 본인 JWT의 `accept_appointment_event_change`만 호출한다. 일치하는 행사 내용을 표시·확인한 상대의 명시 요청으로만 기존 권한/시간/조건 검증과 행사 반영을 같은 transaction에서 처리한다. 공개 범위 밖 회원/서비스 역할에는 새 RPC 권한을 부여하지 않는다. 구형 앱이 날짜 동일만 보고 기존 accept를 호출해도 서버에서 거절한다.

종현 소비자는 행사 제안의 새 종류·전후 행사 내용·원천 비표출 상태를 명시 표시하고 확인한 fingerprint로 새 수락을 호출해야 한다. 준비 전에는 행사 변경을 활성화하지 않고 실패/입력을 보존한다. 이번 작업은 앱 파일을 수정하지 않았다.

### 비표출과 적용/되돌림 경계

owner-only `private.event_source_display`는 원천 비표출 판정을 별도로 보존한다. 일반 수집 upsert가 이를 자동 재공개하지 않는다. 공고의 원천ID와 약속 관계는 유지하면서 linkedEvent 원천 값은 null로 투영한다. 새 행사 연결 확장 DTO만 `eventLinkState:"hidden"`을 반환하고 기존 상세의 키는 유지한다. 공개 행사 목록/상세·AI 후보·필터 집계·행사명 검색도 숨긴 원천 값을 제외한다. 현재 DB owner가 명시 판정을 기록하는 경계만 있으며 공급사 상태 자동 판정·공식 확인 후 재표출 writer·운영 권한 배정은 잔여다.

기존 migration/행사 행/공고 생성 원문은 수정하지 않고 공고별 테이블은 빈 상태로 추가한다. 롤백 시 데이터 삭제나 과거 migration 수정 대신 새 기능 호출을 중단하고 원천/직접입력/제안 자료를 보존한 추가 migration을 검토한다. 구형 앱 사용 중 새 행사 제안을 기존 수락으로 우회시키지 않는다. 실제 적용 전에는 새 격리 DB에서 schema·wrapper ACL·content ticket·조건 지문·당사자 명시 수락·비표출/정리 회귀를 통과해야 한다.

### 행사 제안 응답 유실·종료 후 재시도

`eventChangeId`가 이미 존재하면 원 요청 전체 SHA256, 작성자·공고·기존 expectedUpdatedAt을 대조한 뒤 기존 만료 처리를 실행하고 제안을 다시 읽는다. 다른 요청으로 같은 ID를 재사용하면40001이다. 실제 대기 상태만 `event_change_pending`을 반환한다. 승인 후에는 `event_change_accepted`와 승인 transaction의 `event_applied_updated_at`을 반환하며 재적용하지 않는다. 이 시각은 해당 변경의 영수증으로, 이후 공고의 최신 시각이라고 안내하지 않는다. 거절·만료·취소·철회는 각각 `event_change_declined|expired|cancelled|withdrawn`을 반환하며 대기 제안을 다시 만들지 않는다. 새 제안은 새 changeId와 새 검사 ticket이 필요하다.

소비된 기존 `post_update` 검사 ticket도 원 사용자·대상·입력 digest를 먼저 검증한 뒤 행사 제안에 한해서 같은 상태 resolver를 사용한다. 따라서 저장된 예전 pending outcome을 현재 상태로 오인하지 않는다. 다른 쓰기의 ticket 재시도·승인·원문 결합·ACL은 유지한다. 새 ticket으로 같은 행사 제안을 재요청하는 경우도 같은 판정을 사용한다. SQL fixture는 승인 응답 유실/소비 ticket·새 ticket 재시도, 거절 재시도, 합성 SQL 시간창 만료 후 재시도를 포함한다. 합성 삽입 세션·시간창 조정은 실제 Auth 발급·자연 만료 검증으로 집계하지 않는다.
