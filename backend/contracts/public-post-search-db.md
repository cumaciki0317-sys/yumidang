# 공개 공고 검색 DB 연결

## 현재 검색 정책과 DB 구현 경계

현재 기준은 [정책.md](../../정책.md)다. 아래에서 현재 정책 목표와 기존 기술 인터페이스를 구분한다. 이번 문서 동기화는 서버 코드·SQL·설정·DB·외부 호출·배포를 변경하거나 검증하지 않았다.

검색 대상은 제목·등록 장소명·등록 주소·연결 행사명이다. 작성자 만 나이 19~99 숫자 범위와 전체 상한 없음, 등록일 최신순/시작일 빠른순, 모집 상태 전체/모집 중을 지원한다. 비로그인은 일정·나이 모두 전체만 사용하고 작성자 영역은 개인정보 없는 로그인 가드다. 공고·행사10개씩, 후기5개씩을 요청한다.

아래 기존 SQL·wire는 숫자 범위 호환을 포함하지만 익명 일정 허용·작성자 별칭·기본20·기존 카테고리는 현재 목표에 맞춰 변경·검증해야 한다. 전체 HTTP·코어·AI 연결과 구형 호출 우회도 별도 검사한다. 현재 무료만 제공하며 paid 호환 값은 유료 활성화를 뜻하지 않는다.

## 호출과 입력

```sql
public.search_public_posts_v2(
  p_filters jsonb,
  p_cursor jsonb,
  p_limit integer default 20
) returns jsonb
```

`anon`, `authenticated`, `service_role` 실행 가능. 회원은 `auth.role()='authenticated'`, `auth.uid()` 존재, JWT `is_anonymous` 키 미존재 또는 정확한 JSON boolean `false`를 모두 충족해야 한다. boolean `true`인 Supabase 게스트와 문자열 `"false"`·명시적 null·숫자·객체 등 잘못된 claim은 비회원이다. 정상 회원의 키 누락은 기존 동작을 유지한다. 인자로 caller/userId를 받지 않는다. 일반 검색은 익명/검증된 사용자 DB 클라이언트를 쓰며 service-role로 회원 자격을 대신하지 않는다. 검색의 회원 판정과 새 신청의 네이버 활동 자격은 구분한다.

`p_filters`는 JSON 객체이며 다음 키만 허용한다. `authorAge`의 숫자 범위 객체 외에는 값이 문자열이어야 하며 선택 항목 category/periodStart/periodEnd만 JSON null을 생략과 동일하게 허용한다. 그 외 명시적인 null·숫자·배열·알 수 없는 키를 거절한다. 빈 객체는 기본 검색이다.

| 키 | 기본값·의미 |
|---|---|
| query | 빈 문자열. 최대 300자, Unicode 공백을 한 칸으로 합친 후 앞뒤 공백 제거·소문자 변환. 제목/분리된 등록 장소명/등록 주소 중 문자 그대로 부분 일치 |
| category | 생략/null 시 전체. 지금·전시·축제·식사·운동·여행·클래스·산책·스터디·공연·쇼핑·기타 |
| cost | `all` 기본, `free`, `paid` |
| availability | `all` 기본, `recruiting` 선택 |
| periodStart, periodEnd | 둘 다 생략/null이면 기간 없음, 그 외에는 두 시각 함께 지정. timezone이 있는 ISO 시각, 소수점 최대 6자리. 시작 < 끝. 공고 구간과 `[start,end)` 겹침: 공고 시작 < 검색 끝, 공고 끝 > 검색 시작 |
| authorAge | 생략/`all`이면 상한 없이 전체. 회원은 정확히 `{min,max}`인 객체로 19~99의 정수 범위 지정, 양 끝 포함. Asia/Seoul 오늘 기준 기존 `korean_age`의 작성자 만 나이. `20s`·`30s`·`40plus`는 기존 코어 전환까지 기술 호환 |
| sort | 사용자 확정 기본 `created_desc`(등록일 최신순), 선택 `starts_asc`(시작일 빠른순) |

**현재 목표는 비로그인 일정·나이 전체만 허용하는 것이다. 기존 SQL의 익명 기간 허용은 변경 대상이다.** 비로그인이 `authorAge`의 all 이외 값을 지정하면 `28000`이며 회원에게만 상세 나이 필터를 적용한다. 생년월일이나 계산된 나이를 카드에 추가하지 않는다.

범위의 min/max는 모두 필수이며 JSON number여야 한다. `19 <= min <= max <= 99`인 수학적 정수만 허용하므로 `19.0`·`1.9e1`은 19와 같은 값이지만 `19.1`·숫자 문자열·null·누락·추가 키·역순·범위 밖 값은 `22023`이다. JSONB의 정확한 숫자 비교로 범위를 먼저 검사하고 정수로 변환하여 거대한 숫자의 integer cast 오류를 피한다. 입력 문자열 `range`는 내부 분기명이므로 허용하지 않는다. 전체에는 99세 상한이 없고 100세도 포함하며, 기존 `40plus` 호환도 상한이 없다. `20s`는 20~29, `30s`는 30~39다.

`p_limit`은 기존 기술 한도인 기본 20, 범위 1~50이다. 현재 화면은 10개씩 요청하며 기본값의 정책 일치 여부는 후속 변경 대상이다. 명시적 null·범위 밖 값은 거절한다.

`p_cursor`는 SQL NULL/JSON null 또는 정확히 `{sortAt,id}`인 객체다. timezone 포함 시각과 UUID를 검사한다. 이전의 periodGroup/recruitingGroup 키는 받지 않는다. 커서는 권한 증거나 고정 snapshot이 아니며 새 페이지에서도 모든 공개 조건을 적용한다. HTTP opaque cursor의 필터·정렬 결합은 종현 코드 동기화 대상이다.

## 결과와 정렬

```json
{
  "items": [{
    "id": "92000000-0000-4000-8000-000000000001",
    "title": "전시 동행",
    "authorDisplayName": "김*희",
    "publicArea": "서울특별시 성동구 성수동",
    "startsAt": "2026-10-01T03:00:00.000001Z",
    "endsAt": "2026-10-01T05:00:00.000001Z",
    "cost": {"kind":"free"},
    "state": "recruiting",
    "canApply": false
  }],
  "nextCursor": {"sortAt":"2026-09-29T01:00:00.000001Z","id":"92000000-0000-4000-8000-000000000001"}
}
```

카드는 위 9개 필드만 반환한다. 마지막 페이지는 `nextCursor:null`, 0건은 `items:[]`다. UTC 시각은 DB 마이크로초 6자리를 보존한다. created_desc는 `(created_at DESC,id ASC)`, starts_asc는 `(starts_at ASC,id ASC)` keyset이며 동시각 ID 순서도 고정한다. 모집 여부·기간 안 시작 여부를 별도 정렬 우선순위로 넣지 않는다. limit+1개를 조회해 다음 페이지 존재 여부를 판단한다. 동시 변경을 고정하는 snapshot은 아니다.

공개 지역은 저장된 시·구·동까지 유지한다. 정확한 주소·등록 장소명·일치 조각·소개·상세 만남 지점·작성자 ID·실명 원본은 카드에 없다. 회원의 이름은 기존 `mask_real_name` 규칙(변종→변*, 변종현→변*현)을 적용한다. 확정 당사자의 전체 실명은 기존 관계 권한이 있는 별도 상세 경로를 유지하며 이 공개 목록에서 전체 실명을 반환하지 않는다.

비로그인 응답은 실제 개인정보를 포함하지 않는 작성자 가드로 전환해야 한다. 기존 authorDisplayName 필드의 호환 처리와 화면 계약은 후속 변경·검증한다. CSS 가림만으로 권한을 구현하지 않는다.

## 상태·비용·신청 가능 여부

삭제 공고는 제외한다. 남은 행의 상태는 다음 순서로 계산한다.

1. 현재 약속 상태 confirmed → `confirmed`.
2. 약속 completed/cancelled/disputed/no_show 또는 공고 closed → `closed`. 상세 사유는 공개 카드에 없음.
3. 공고 expired 또는 모집 마감/시작 시각 경과 → `expired`.
4. 나머지 → `recruiting`.

비용은 과거 `cost_type/amount`가 모두 NULL이면 JSON null이고 무료로 추정하지 않는다. free/0은 `{kind:"free"}`다. paid_request/paid_offer의 와이어 형식은 양의 안전 정수 amount와 각각 author_to_applicant/applicant_to_author 방향을 요구한다. 현재 스키마는 free/0 또는 NULL만 허용하므로 paid 필터는 빈 결과이며 이 변경으로 유료 등록을 활성화하지 않는다. 잘못된 비용 조합을 NULL로 숨기지 않는다.

`canApply`는 항상 boolean이다. 위 회원 조건·실제 네이버 활동 자격·프로필 존재·현재 무료 모집 공고·작성자 아님·상대 성별 조건 일치·pending/declined 신청 이력 없음이어야 true다. 비용 미확인·익명·게스트는 false다. withdrawn은 기존 실제 신청 RPC처럼 재신청 가능하다. pending의 실제 RPC 재요청은 멱등 반환이지만 카드는 이미 신청한 대상으로 새 신청 버튼을 열지 않는다.

`private.can_start_naver_activity()`는 호출자 인수 없이 기존 `private.assert_naver_activity_allowed()`를 호출해 등록된 네이버 Auth 세션, 최신 자격, 가입 완료, 본인 소유 JPEG 객체를 실제 신청과 같은 기준으로 검사한다. 정책 조건을 별도로 복제하지 않는다. 프로필만 있는 과거 계정·미등록/삭제된 세션·정보 누락/자격 회수·미완료 가입·사진 누락/잘못된 소유/metadata는 false다. 호출마다 한 번 계산하며 새로운 신청은 실제 신청 RPC에서 다시 검사한다.

helper는 명시적 거절만 false로 바꾼다: `28000`의 `login_required/naver_session_required`, `42501`의 `naver_signup_required/profile_image_not_owned`, `22023`의 `invalid_profile_image_path/profile_image_missing/invalid_profile_image_object`. 다른 메시지나 SQLSTATE의 DB 오류는 그대로 전파하고 정상적인 false 또는 빈 검색으로 숨기지 않는다. helper 직접 실행 권한은 PUBLIC·anon·authenticated·service_role 모두 회수하며 공개 검색의 SECURITY DEFINER 내부에서만 사용한다.

일정 겹침은 현재 신청 단계에서 안내 후 계속 가능하고 확정 시 거절하는 정책이므로 검색 canApply에 새 차단 조건을 추가하지 않는다. 가입 프로필 존재를 네이버 필수 정보·자격 확인 완료로 자동 승격하지 않는다. 검색 결과는 현재 조회 시점의 안내이며 신청 권한을 예약하거나 보장하지 않는다.

## 검색 원본·이전 경로 보존과 점검

기존 RPC는 제목·등록 장소명·등록 주소를 필드별로 비교하며 이어 붙이지 않는다. 연결 행사명 검색의 기존 DB 연결은 공고 계약을 따르며 전체 HTTP·AI 경로를 별도 대조한다. `%`와 `_`는 wildcard가 아니다. 소개·후기·공개 지역·상세 만남 지점은 키워드 검색 대상이 아니다. `private.post_search_locations`와 서비스 전용 `set_post_search_location`의 기존 권한은 그대로 유지한다. 기존 exact_location 혼합 값을 자동 파싱하거나 이전하지 않는다.

기존 `search_public_posts`는 모집 중 최소 카드·시작순의 구형 RPC이고 기존 `list_posts`는 소개·공개 지역까지 검색하는 구형 경로다. public.posts 직접 SELECT도 RLS의 삭제 제외 조건 안에서 공개 필드를 조회할 수 있다. 이번 v2 추가로 이 경로를 광범위 회수하거나 응답을 조용히 바꾸지 않았다. 따라서 **전체 서비스의 키워드 검색 범위 통일은 구형 호출 전환 후 별도 검증이 필요하다.** 동 공개는 유지하고 익명 기간 지정은 현재 정책에 따라 차단하도록 변경한다.

기존 profiles는 익명 SELECT 권한이 없고 회원 SELECT도 own RLS로 제한된다. 나이·작성자 카드 조회 RPC는 회원 전용이며 직접 posts에는 birth_date가 없다. 이 소스 점검을 모든 실행 경로의 권한 검증 완료로 대신하지 않는다. 공개 검색에서 생년월일·실명 원본·정확한 주소를 추가하지 않는다.

## 오류·검증·연결 대기

잘못된 필터/기간/커서/limit은 `22023`, 익명 상세 나이 선택은 `28000`이다. 원문 오류를 HTTP로 보내지 않고 공통 INVALID_REQUEST/AUTH_REQUIRED에 대응한다. 내부 비용 데이터 불일치는 `P0001`이며 잘못된 카드를 정상 응답으로 만들지 않는다.

`tests/database/minkyu/public_search_v2.sql`은 별도 담당이 작성하는 rollback SQL 검증이다. 해당 구현 당시 정책·공개 필드·권한·µs/동률 ID 페이지·상태·비용·문자 일치·입력 거절을 실제 격리 DB에서 확인하며 결과는 민규 현황에 기록한다.

후속 검증은 숫자 19/99·전체100세, 익명 일정/나이 제한, 작성자 가드 개인정보 제외, 정책 카테고리·페이지10, 연결 행사명·정렬·커서·네이버 자격·첫 채팅 신청/재신청 대기와 실제 신청 RPC의 일치를 확인한다. 기존 테스트의 기대도 현재 정책과 대조하며 DB 단위 성공을 HTTP·AI·원격 배포 완료로 확대하지 않는다.
