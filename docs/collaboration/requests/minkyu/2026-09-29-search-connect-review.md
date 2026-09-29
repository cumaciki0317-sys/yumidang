# 검색 v2 실제 연결 전 독립 검토

작성: 2026-09-29, 민규 8차 하네스 C. 종현 원격 브랜치는 `origin/jonghyun/independent-core-handoff`이며 검토 커밋은 `129a8713da513faa59f55d3fc87231ce05fa2038`이다. 민규의 병합 기준은 `2a530970fcd098156172eefc723504535bb44888`이다.

## 판정

정상 검색 GET 연결을 막는 SQL v2 계약 불일치나 신규 권한 우회는 검토 범위에서 발견하지 못했다. 확인한 비차단 문제는 아래 P2 오류 분류 한 건이다. 코드 읽기와 주입 재현만으로 실제 Edge·Auth·DB 연결 성공을 주장하지 않는다. 이번 C는 종현 코드를 수정하지 않았다.

| 검토 영역 | 확인 내용 |
|---|---|
| DB 입력 | `search_public_posts_v2`와 query/category/cost/availability/sort/periodStart/periodEnd/authorAge가 일치한다. 선택 category·기간의 null은 SQL이 허용한다. caller·userId·토큰을 SQL 인수로 추가하지 않는다. |
| 인증 경계 | HTTP의 trusted caller와 해당 사용자 JWT 또는 익명 클라이언트를 주입하는 기존 민규 경로를 유지한다. 코어의 caller는 DB 권한을 올리는 토큰이 아니다. |
| 익명 필터 | 기간 검색은 허용하고 authorAge는 all만 허용한다. SQL도 같은 제한을 독립 검사한다. |
| 정렬 | 기본 created_desc, 선택 starts_asc, 같은 시각의 UUID ASC가 SQL과 일치한다. 기존 기간·모집 우선 순서를 페이지 위에서 다시 적용하지 않는다. |
| 커서 | 외부 v2 커서는 정규화 필터·정렬에 묶인다. DB에는 sortAt/id 두 필드만 전달한다. 다음 커서는 마지막 카드 ID와 일치해야 하고 시각·ID가 정렬 방향으로 진행해야 한다. 마이크로초와 offset 원문을 보존한다. |
| 공개 투영 | DB 응답은 items/nextCursor, 카드는 허용 9필드만 받는다. 추가 주소·실명·계좌·metadata 필드를 거절한다. NULL 비용만 unknown으로 바꾸고 익명·unknown·모집 종료의 canApply는 false다. |
| 공개 지역 | 동·읍·면·가까지의 정규식과 최대 60자가 기존 SQL 제약과 일치한다. 임의 상세 주소 분리·마지막 동 삭제를 하지 않는다. |
| 실패 처리 | RPC 실패를 구형 RPC나 가상 자료·빈 목록 성공으로 대체하지 않는다. 공통 HttpError의 안전한 메시지 처리는 유지한다. |

커서는 인증 수단이나 조회 snapshot이 아니므로 서명되지 않은 위치 변경만으로 권한 우회라고 판단하지 않는다. DB가 매번 권한·필터를 적용한다. 생성일은 카드에 없으므로 created_desc 커서 시각을 마지막 카드와 비교하지 않는 현재 구현도 계약에 맞는다. 목록의 이름은 회원에게도 마스킹이며, 확정 당사자의 전체 이름은 별도 관계 권한 경로다.

## 종현담당 변경 요청 — P2 내부 시각 오류 분류

대상은 종현 소유 `backend/supabase/functions/_shared/db/repositories/search.ts`의 `wireCard`와 관련 종현 테스트다. 문제는 `wireCard`가 호출하는 `projectPublicPostCard`에서 DB 카드 날짜가 잘못됐을 때 `INVALID_SEARCH_TIMESTAMP`를 그대로 던지는 점이다. 이 문자열은 사용자 기간 입력 검증에도 쓰이며, 민규 HTTP 오류 매핑은 이를 400 INVALID_REQUEST로 분류한다. 정상 요청에 대한 내부 데이터 오류가 사용자 입력 오류로 전달된다.

검증된 재현은 정상 `{caller:"anonymous"}` 입력에, 허용 9필드를 가진 DB 카드의 startsAt만 `2026-02-30T12:00:00Z`로 제공하는 것이다. 현재 실제 repository → service → HTTP 오류 매핑을 Node로 호출한 결과는 다음과 같다. DB 연결은 주입했다.

```json
{"scenario":"malformed_DB_timestamp","coreError":"INVALID_SEARCH_TIMESTAMP","HTTP":{"status":400,"error":{"code":"INVALID_REQUEST","message":"요청 형식이 올바르지 않습니다.","retryable":false}}}
```

요청 변경은 **DB 응답 카드의 투영·형식 검증 실패를 repository 경계에서 INVALID_SEARCH_RESPONSE 등 내부 응답 오류로 구분**하는 것이다. 입력 normalize/decode 오류와 `db.rpc`의 기존 HttpError까지 넓게 감싸지 않는다. 잘못된 사용자 기간은 계속 400, 잘못된 DB 카드 날짜는 안전한 500, RPC의 인증·권한·가용성 오류는 기존 공통 분류를 유지하는 것을 완료 조건으로 삼는다. 오류 원문·SQL·민감정보를 공개하지 않는다.

이 문제는 현재 SQL이 유효한 timestamptz를 ISO로 반환하는 정상 연결을 막지는 않는다. 소유권을 넘어 코어를 수정하거나 HTTP에 도메인 시각 검증을 중복 구현하지 않았다. 상대 변경 요청은 이 민규 문서에만 기록하며 외부 메시지를 전송하지 않는다.

## 검증과 한계

- PASS: 129a871 코드·계약 diff와 기존 검색 SQL 27번째 마이그레이션 대조.
- PASS: malformed DB timestamp 오류 분류 주입 재현. 의미상 잘못된 400이 재현됐다는 뜻이며 기능 성공 검사가 아니다.
- NOT_RUN: C 독립 검토에서 실제 Edge·회원 JWT·DB 검색 실행. A/B/총괄의 결과는 [검색 연결 인계](2026-09-29-search-connected.md)에 별도 기록한다.
- NOT_RUN: 원격 DB·운영 배포·외부 공급사.

민규 준비 검사 도구의 fixture가 동 없이 시구까지만 제공하면 최신 코어의 공개 투영 검증이 거절하는 것이 정상이다. 실제 SQL은 동 단위 형식을 강제하므로 이를 종현 코어 결함으로 보고하지 않는다. 총괄은 민규 도구의 fixture를 올바른 공개 지역으로 맞춘 뒤 재검증한다. maintenance와 AI 모델 설정의 분리 요청은 별도 후속 업무이며 이번 검색 연결에 섞지 않는다.
