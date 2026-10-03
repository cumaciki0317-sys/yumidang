# 작성자 숫자 나이 범위 검색 연결 요청

작성자: 민규(`minkyu`). 요청 대상: 종현(`jonghyun`). 기준일: 2026-10-02.

상태: **민규 DB 숫자 범위 실제9그룹 ALL PASS / 종현 공유 계약·검색·AI 변경 요청 / 민규 HTTP 후속 연결 대기**. DB 검증과 HTTP·AI 연결 완료는 구분한다. 단독 수정 범위는 [검색 범위 하네스](../../minkyu-search-range-harness.json)를 따른다.

## 확정 정책과 현재 차이

[정책.md](../../../../정책.md)는 공고 작성자의 **만 나이 19~99세 안에서 최소~최대 범위**, 전체 선택에는 필터 상한 미적용, 비로그인은 나이 전체만을 정한다. 희망 상대 나이는 별개다. 기본 정렬 `created_desc`, 선택 정렬 `starts_asc`, 모집 상태 `all`/`recruiting`, 기간 겹침과 공개 투영은 유지한다.

현재 종현 `contracts/search.ts`, `contracts/ai.ts`, chatbot intent/prompt와 민규 `service-api/search-http.ts`는 `all|20s|30s|40plus`만 받는다. 기존 `search_public_posts_v2`를 확장해 공통 정규화·커서·AI가 같은 숫자 범위를 전달해야 한다. 기존 DB 나이 helper는 이름과 별개로 생년월일과 조회일 사이의 만 나이를 계산하므로 계산법을 바꾸는 작업이 아니다.

## 새 공통 계약

```ts
type AuthorAgeRange = { min: number; max: number };
type AuthorAgeFilter = "all" | AuthorAgeRange;
```

| 입력 | 정규화·동작 |
|---|---|
| 생략 또는 `"all"` | `"all"`; 나이 필터 상한 미적용 |
| `{min:19,max:99}` | 작성자 만 나이 19 이상 99 이하, 양끝 포함 |
| `{min:30,max:30}` | 작성자 만 나이 30세만 |
| 한쪽 누락·null·배열·추가 키·문자열 숫자·소수·19 미만·99 초과·역전 범위 | 입력 오류; 전체로 조용히 바꾸지 않음 |
| 익명의 유효 숫자 범위 | `AUTH_REQUIRED`; 인증 문맥과 DB 권한 양쪽에서 제한 |

객체에는 `min`, `max` 두 정수만 허용한다. `PublicPostListInput`과 `NormalizedPublicPostListInput`의 필드명 `authorAge`를 유지한다. 현재 공개 카드의 9개 필드와 이름/장소 마스킹을 유지하며 생년월일·실제 나이·실명을 추가하지 않는다.

### 민규 HTTP 후속 매핑

종현 공유 계약 반영 뒤 민규 소유 `service-api/search-http.ts`에서 `?authorAgeMin=19&authorAgeMax=29`를 `authorAge:{min:19,max:29}`로 매핑한다. 나이 입력 생략 또는 `authorAge=all`은 전체다. 두 범위 키는 함께 있어야 하고 정수 문자열만 허용한다. 빈 값·소수·부호·중복/알 수 없는 키·범위와 `authorAge` 동시 입력은 `INVALID_REQUEST`, 익명의 유효 범위는 `AUTH_REQUIRED`다. `caller`는 URL·모델 출력이 아닌 인증 결과에서만 채운다.

**이번 하네스에서 HTTP 파일은 보존 대상이며 아직 위 매핑을 구현하지 않았다.** 기술 입력 형식으로 최종 화면 배치·초기 카드 수를 결정하지 않는다.

### 기존 enum 호환

`20s|30s|40plus`는 기존 DB 호출·검사의 임시 호환 경계로 구분한다. 새 공유 계약·AI 출력의 목표는 숫자 객체다. 과거 enum을 최종 화면 선택지로 유지할 정책을 새로 확정하지 않는다. 기존 `40plus`는 100세 이상도 포함하므로 `{min:40,max:99}`로 몰래 정규화하지 않는다. 기존 호출의 호환과 전환은 [이번 DB 인계](2026-10-02-search-range-handoff.md)의 실제 구현을 확인해 맞추고 과거 enum과 숫자 범위를 같은 값이라고 설명하지 않는다.

## RPC·커서·저장소

RPC 이름 `search_public_posts_v2`, 인수 `p_filters`, `p_cursor`, `p_limit`, 기존 정렬 위치를 유지한다. `p_filters.authorAge`에는 정규화된 전체/객체를 그대로 보내고 HTTP 전용 `authorAgeMin/Max` 키를 추가하지 않는다.

기존 v2 커서의 canonical `filters.authorAge`에 숫자 객체를 포함한다. 최소·최대 어느 한쪽이 바뀌면 이전 커서를 `INVALID_CURSOR`로 거절한다. 같은 객체의 키 순서는 의미상 같게 처리하되 누락·추가 키·값 변경을 같은 필터로 취급하지 않는다. 기존 마이크로초 정렬 위치 비교와 전체 필터 일치 검사를 유지한다. 과거 enum 커서는 실제 호환 계약에 따르며 전체나 숫자 범위로 조용히 바꾸지 않는다.

가상 저장소가 나이 계산 자료를 갖지 않으면 명시적 미지원으로 거절한다. RPC 구현만으로 가상 검색도 나이 필터를 지원한다고 표시하지 않는다. 내부 나이 필터를 로그·카드·AI의 새 개인정보 노출로 확대하지 않는다.

## 실제 DB 결과와 기존 검사 기대 차이

총괄이 실제 가입 DB와 별도인 search-range DB에서 최종 SQL·검사로 9그룹 ALL PASS를 확인했다. 숫자19/99·전체100세 이상, 잘못된/큰 숫자, enum 호환, 두 정렬 keyset, 조건 조합, 공개9필드, 익명/문맥 위장, canonical `canApply`의 자격·사진·세션·게스트/잘못된 claim 경계와 Storage 보존을 확인했다. rollback 뒤 기존 함수 정의·Auth0/공고0·migration35·새 helper 부재가 같았다. DB 결과만으로 공유 계약·HTTP·AI·행사 연결을 완료 처리하지 않는다.

이전 **민규 소유** `tests/database/minkyu/public_search_v2.sql:227`은 네이버 활동 세션 없는 기존 fixture에도 `canApply=true`를 기대한다. 실제 신청과 같은 자격·사진·세션 게이트를 적용한 새 카드 계약과 불일치하며 원본을 수정하지 않았다. 전체 기존 회귀 PASS가 아니며, 민규 후속 검사에서 적격 fixture의 true와 부적격 fixture의 false를 각각 검증해야 한다. 종현 검색·AI 소비자는 이 false를 나이 필터 오류나 무료 여부로 바꾸지 말고 신청 가능 표시로 전달한다. 이 항목은 아래 기존 종현 HTTP3개/SQL2개 갱신 요청과 별도다.

## 종현 변경 대상과 완료 조건

아래 코드는 `backend/supabase/functions/` 기준이며 문서·검사 행은 저장소 루트 기준이다. 종현만 수정하며 민규는 읽기 검토만 했다.

| 대상 | 변경 요청 |
|---|---|
| `_shared/contracts/search.ts` | 숫자 타입·엄격 정규화·익명 제한·canonical 필터/커서 범위 |
| `_shared/db/repositories/search.ts` | 동일 RPC 객체 전달·공개 투영 유지·가상 저장소 지원 경계 |
| `_shared/services/search-service.ts` | 기존 코어를 재사용해 공통 입력을 끝까지 전달 |
| `_shared/contracts/ai.ts` | `AiFilters.authorAge`에 같은 숫자 타입 적용 |
| `_shared/ai/Agents/chatbot/intent.ts` | 모델 범위 검증·생략은 전체 의미 유지 |
| `_shared/ai/Agents/chatbot/prompts.ts` | 작성자 만 나이와 희망 상대 조건 구분·숨은 범위/상한 생성 금지 |
| `_shared/ai/Agents/chatbot/discovery.ts` | 범위를 공고 검색에 전달·재검사하고 행사 검색에서 제외 |
| `backend/contracts/search.md`, `tests/분류/jonghyun/` | 자기 담당 문서·검사에 입력/오류/커서/AI 전달 경계 반영 |

AI에서 범위·대상이 모호하면 기존 clarify 흐름을 사용한다. 희망 상대 조건을 작성자 범위로 바꾸거나 프로필로 범위를 추정하지 않는다. 별도 검색 폴더·새 버전 RPC·중복 정규화기를 만들지 않는다.

1. 19·99·같은 최소/최대·생일 전후 만 나이·범위 밖 제외·전체의 100세 이상 포함을 확인한다.
2. 잘못된 객체·숫자·익명 범위를 HTTP/코어/직접 RPC 각 경계에서 거절하고 인증 문맥 주입을 막는다.
3. RPC 객체와 canonical 필터의 일치, 최소/최대 변경 시 커서 불일치, 두 정렬의 마이크로초 경계를 확인한다.
4. AI의 명시 작성자 범위·희망 상대 구분·생략 시 전체·모호한 요청 clarify·행사 입력 차단을 확인한다.
5. 종현 공유 변경 뒤 민규 HTTP를 연결하고 실제 Auth/DB/HTTP 통합 결과를 별도 기록한다. DB 파일 존재·가상 검사만으로 6번 전체를 완료하지 않는다.

기존 HTTP 검사3개·SQL 검사2개 기대 갱신은 [순차 인계의 종현 검사 갱신 요청](2026-10-02-ordered-backend-handoff.md#종현-검사-갱신-요청)을 따른다. 새 요청 작성으로 기존 실패를 완료 처리하지 않는다.

행사 선택 때 기존 입력/일정 보존과 취소·종료 행사의 **새 선택 제외**는 정책에 있다. 이미 연결한 행사 표시를 최신 정보로 갱신할지 선택 당시 정보로 유지할지는 명시되지 않아 의존 구현을 보류한다. 숫자 나이 범위는 독립적으로 진행한다. 전체는 **43%·6/14**다. 실제 로컬 네이버 OAuth·인증 세션·사진 업로드·명시적 가입 완료·완료 후 상태 조회를 확인해 9번을 완료로 갱신했다. 운영 배포·프론트 전체 종단 연결은 별도다.
