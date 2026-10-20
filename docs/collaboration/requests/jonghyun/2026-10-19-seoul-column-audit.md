<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미다. 일반 신고 처리와 해당 신고의 허용된 제출 증거 처리는 조유미 부재 시 종현이 대체한다. 이 지정은 고객지원·AI 비용·서버 운영의 대체 권한으로 확대하지 않는다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# 서울 열린데이터 25개 칼럼·공통 구조·화면 매핑 — 2026-10-19

> **2026-10-20 행사 UX 현행 기준:** 이 문서는 작성 당시의 설계·구현·검증 기록입니다. 현재 제품 결정은 [행사 UX 최종 확정 기준](2026-10-20-event-ux-approved-spec.md)을 따릅니다. 작성용 날짜 겹침 강제·동행 일정 자동 검색 축소는 적용하지 않습니다. 직접 입력은 공고 전용이며, 확실한 공식 동일 개최 근거가 있는 원천만 대표 행사로 통합합니다. 비표출/충돌 처리는 현행 명세를 따르며 당시 API/검증 결과가 새 기능 완료를 뜻하지 않습니다. 아래 과거 실행·응답·PASS·미지원 기록은 보존합니다.


종현의 칼럼/UX 정리 산출물. 읽기 전용 저장 원본과 현재 코드만 대조했다. 새 API 호출·환경/키 조회·서버 코드·DB·배포 변경은 하지 않았다. 서울 HTTPS 수집 구현·운영 연결은 민규 WBS 7.9 인계로 유지한다.

## 근거와 범위

- 저장 원본: `/private/tmp/jh-seoul-20261019.json`, SHA256 `939cd39cbb9a4effb4cf1006db94622c560e35a0739afc59e446b0f7d4e049d8`.
- 원본 envelope: `DESCRIPTION`(대문자 설명 25개), `DATA`(소문자 실제 칼럼 25개), 19,631행.
- 공식 출처: https://data.seoul.go.kr/dataList/OA-23041/S/1/datasetView.do
- 전체 필드·실제 샘플·지원 상태: [JSON 목록](2026-10-19-seoul-columns.json).
- `nullable`는 이 스냅샷에서 null/키누락을 관찰했는지이며, 공급사가 앞으로 non-null을 보장한다는 뜻이 아니다. 공백만인 문자열은 별도로 센다.

## 전체 필드와 결측

| 원본 칼럼 | 원천 뜻 | 실제 타입 | 키누락 | null | 빈문자열 | 공백만 | 공통 필드 후보 |
|---|---|---|---:|---:|---:|---:|---|
| `org_name` | 기관명 | string | 0 | 0 | 0 | 0 | `organizerName` |
| `player` | 출연자정보 | string | null | 0 | 17654 | 0 | 2 | `performers` |
| `org_link` | 홈페이지 주소 | string | null | 0 | 267 | 0 | 0 | `externalUrl` |
| `pro_time` | 행사시간 | string | 0 | 0 | 0 | 0 | `operatingInfo` |
| `main_img` | 대표이미지 | string | 0 | 0 | 0 | 0 | `posterUrl` |
| `themecode` | 테마분류 | string | null | 0 | 3043 | 0 | 0 | `theme` |
| `date` | 날짜 | string | 0 | 0 | 0 | 0 | `교차 검증` |
| `cgg_cd` | 자치구코드 | string | null | 0 | 121 | 0 | 0 | `districtCode` |
| `etc_desc` | 기타내용 | string | null | 0 | 19288 | 0 | 0 | `additionalInfo` |
| `title` | 공연/행사명 | string | 0 | 0 | 0 | 0 | `title` |
| `end_date` | 종료일 | integer (epoch milliseconds) | 0 | 0 | 0 | 0 | `endsOn` |
| `inquiry` | 문의 | string | null | 0 | 3411 | 0 | 0 | `contact` |
| `codename` | 분류 | string | 0 | 0 | 0 | 0 | `category` |
| `ticket` | 시민/기관 | string | 0 | 0 | 0 | 0 | `submitterType` |
| `use_trgt` | 이용대상 | string | 0 | 0 | 0 | 0 | `audience` |
| `rgstdate` | 신청일 | string | 0 | 0 | 0 | 0 | `sourceApplicationDate` |
| `place` | 장소 | string | 0 | 0 | 0 | 0 | `placeName` |
| `strtdate` | 시작일 | integer (epoch milliseconds) | 0 | 0 | 0 | 0 | `startsOn` |
| `lat` | 위도(X좌표) | string | null | 0 | 496 | 0 | 0 | `latitude` |
| `hmpg_addr` | 문화포털상세URL | string | 0 | 0 | 0 | 0 | `sourceUrl` |
| `use_fee` | 이용요금 | string | null | 0 | 10635 | 0 | 0 | `admission.text` |
| `guname` | 자치구 | string | null | 0 | 121 | 0 | 0 | `districtName` |
| `program` | 프로그램소개 | string | null | 0 | 17457 | 0 | 6 | `description` |
| `lot` | 경도(Y좌표) | string | null | 0 | 496 | 0 | 0 | `longitude` |
| `is_free` | 유무료 | string | null | 0 | 8 | 0 | 0 | `admission.kind` |

## 필드별 실제 값·기존 지원·화면 적용

### `org_name` — 기관명

- 실제 샘플: `기타`
- 매핑 후보: `organizerName`; 영역: 행사 상세.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. 원천 기관명. 기타 등 포괄 값도 있어 실명 주최자·사업자라고 단정하지 않음.

### `player` — 출연자정보

- 실제 샘플: `Piano : Kazumi Tateishi, Contrabass : Shinobu Sato, Drums : Mao Suzuki`
- 매핑 후보: `performers`; 영역: 행사 상세.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 17654, 빈문자열 0, 공백만 2. 공개 출연자 설명. 빈값 숨김, 동행 회원 정보와 분리.

### `org_link` — 홈페이지 주소

- 실제 샘플: `https://tickets.interpark.com/goods/26010350`
- 매핑 후보: `externalUrl`; 영역: 행사 상세.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 267, 빈문자열 0, 공백만 0. 주최/예매 등 외부 목적지가 혼재. http를 임의로 https로 치환하지 않고 scheme·자격증명·목적지 검증 후 외부 링크로 표시.

### `pro_time` — 행사시간

- 실제 샘플: `19:30`
- 매핑 후보: `operatingInfo`; 영역: 행사 상세.
- 현재 코드: 공통 선택필드 저장/DTO 있음; 서울 parser 미매핑.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. 자유 서술 운영시간. datetime 시작/종료 순간으로 추정하지 않음.

### `main_img` — 대표이미지

- 실제 샘플: `https://culture.seoul.go.kr/cmmn/file/getImage.do?atchFileId=401a984b98ff4af8a57122219ee0d591&thumb=Y`
- 매핑 후보: `posterUrl`; 영역: 행사 목록, 행사 상세, 공고 연결 행사.
- 현재 코드: 공통 선택필드 있음; 현재 검증 규칙과 충돌.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. 전 행 HTTPS이지만 전 행 query 포함. 현재 source 검증은 KOPIS 업로드 경로만 허용하며 query 금지; 공개 DTO도 query 금지. 서울 이미지 URL 보안 계약 확장 필요, 쿼리 제거·주소 변조 금지.

### `themecode` — 테마분류

- 실제 샘플: `기타`
- 매핑 후보: `theme`; 영역: 행사 상세.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 3043, 빈문자열 0, 공백만 0. 원천 분류를 그대로 보존. 일반 장르와 임의 통합하지 않음.

### `date` — 날짜

- 실제 샘플: `2026-12-24~2026-12-24`
- 매핑 후보: `None`; 영역: 내부 검증.
- 현재 코드: 직접 저장/DTO 없음; 달력일 쌍은 기존 지원.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. 시작~종료 문자열. strtdate/end_date의 KST 달력일과 교차 검증. 독립 행사시간 아님.

### `cgg_cd` — 자치구코드

- 실제 샘플: `3240000`
- 매핑 후보: `districtCode`; 영역: 내부 연결.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 121, 빈문자열 0, 공백만 0. 문자열 코드 보존. 외부 행정동/다른 공급사 지역 코드와 숫자만으로 결합 금지.

### `etc_desc` — 기타내용

- 실제 샘플: `https://nol.yanolja.com/ticket/products/26010247`
- 매핑 후보: `additionalInfo`; 영역: 행사 상세.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 19288, 빈문자열 0, 공백만 0. 내용뿐 아니라 URL도 들어 있어 본문으로 무조건 출력하지 않음. HTML/외부 링크 구분·정제 필요.

### `title` — 공연/행사명

- 실제 샘플: `2026 카즈미 타테이시 트리오 내한공연-크리스마스, 재즈를 만나다-(서울)`
- 매핑 후보: `title`; 영역: 행사 목록, 행사 상세, 공고 연결 행사.
- 현재 코드: 공통 저장/DTO 있음; 기존 대문자 TITLE 대응.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. 공백·HTML·제어문자 정제, 빈 제목 격리. 현재 소문자 필드는 미지원.

### `end_date` — 종료일

- 실제 샘플: `1798038000000`
- 매핑 후보: `endsOn`; 영역: 행사 목록, 행사 상세, 공고 연결 행사.
- 현재 코드: 공통 date 정밀도 저장/DTO 있음; 기존 문자열 END_DATE와 형식 다름.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. epoch 밀리초→Asia/Seoul YYYY-MM-DD. 종료일 포함. 시작>종료 54행 격리, 임의 교환 금지.

### `inquiry` — 문의

- 실제 샘플: `070-8680-8477 / 02-337-3103`
- 매핑 후보: `contact`; 영역: 행사 상세.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 3411, 빈문자열 0, 공백만 0. 전화/자유서술 정보. 운영자 고객지원 연락처 및 회원 연락처와 분리.

### `codename` — 분류

- 실제 샘플: `콘서트`
- 매핑 후보: `category`; 영역: 행사 목록, 행사 상세, 공고 연결 행사.
- 현재 코드: 공통 저장/DTO 있음; 기존 대문자 CODENAME 대응.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. 원천 장르 보존. KOPIS 장르코드/필터와 자동 등치하지 않음.

### `ticket` — 시민/기관

- 실제 샘플: `시민`
- 매핑 후보: `submitterType`; 영역: 내부 보존.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. DESCRIPTION 뜻은 시민/기관. 티켓판매수·예약가능·예매상태가 아님.

### `use_trgt` — 이용대상

- 실제 샘플: `성인, 청소년`
- 매핑 후보: `audience`; 영역: 행사 상세.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. 자유서술 이용대상이며 유미당 여성·만19세 회원 자격 또는 동행 모집 조건과 별개.

### `rgstdate` — 신청일

- 실제 샘플: `2026-07-23`
- 매핑 후보: `sourceApplicationDate`; 영역: 내부 보존.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. DESCRIPTION=신청일. 신규등록·수정·수집 시각으로 단정하지 않음. 이번 주 신규 조건에 자동 사용 금지.

### `place` — 장소

- 실제 샘플: `강동아트센터 대극장 한강`
- 매핑 후보: `placeName`; 영역: 행사 목록, 행사 상세, 공고 연결 행사.
- 현재 코드: 공통 저장/DTO 있음; 기존 대문자 PLACE 대응.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. 공개 행사장명. 동행 상세 만남 지점·주소로 대신 쓰지 않음.

### `strtdate` — 시작일

- 실제 샘플: `1798038000000`
- 매핑 후보: `startsOn`; 영역: 행사 목록, 행사 상세, 공고 연결 행사.
- 현재 코드: 공통 date 정밀도 저장/DTO 있음; 기존 문자열 STRTDATE와 형식 다름.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. epoch 밀리초→Asia/Seoul YYYY-MM-DD. UTC 날짜 절단 금지. 날짜 정밀도를 유지하고 00:00 공연 시작이라고 표시하지 않음.

### `lat` — 위도(X좌표)

- 실제 샘플: `37.5512204558342`
- 매핑 후보: `latitude`; 영역: 지도 후보.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 496, 빈문자열 0, 공백만 0. 원천 설명 X/Y는 GIS 관례와 다를 수 있으므로 필드명/수치 확인. 숫자표본 약36~37도는 위도. 도분초·기호 혼재 값은 단순 float 실패하므로 별도 검증.

### `hmpg_addr` — 문화포털상세URL

- 실제 샘플: `https://culture.seoul.go.kr/culture/culture/cultureEvent/view.do?cultcode=158770&menuNo=200008`
- 매핑 후보: `sourceUrl`; 영역: 행사 상세, 공고 연결 행사, 내부 연결.
- 현재 코드: 공통 sourceUrl/sourceId 저장/DTO 있음; 기존 대문자 HMPG_ADDR 대응.
- 주의: 19631행 기준 키누락 0, null 0, 빈문자열 0, 공백만 0. https/http 검증, host=culture.seoul.go.kr, path=/culture/culture/cultureEvent/view.do, 자격증명 없음, 양의 정수 cultcode→sourceId. 전행 19631개 고유 ID, 임의 제목해시 금지.

### `use_fee` — 이용요금

- 실제 샘플: `VIP석 88,000원 / R석 77,000원 / S석 66,000원 / A석 55,000원`
- 매핑 후보: `admission.text`; 영역: 행사 상세, 행사 목록.
- 현재 코드: 공통 admission 저장/DTO 있음; 기존 대문자 USE_FEE 대응.
- 주의: 19631행 기준 키누락 0, null 10635, 빈문자열 0, 공백만 0. 요금 설명은 described 후보. 빈 요금을 0원/무료로 간주 금지; 상세 우선 노출.

### `guname` — 자치구

- 실제 샘플: `강동구`
- 매핑 후보: `districtName`; 영역: 행사 목록, 행사 상세.
- 현재 코드: 현재 지역은 서울특별시 고정; 구 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 121, 빈문자열 0, 공백만 0. 구명이며 상세 주소 아님. region에 시도와 구를 혼합하지 말고 확장 후보로 분리.

### `program` — 프로그램소개

- 실제 샘플: `Let It Snow, White Christmas 등 크리스마스 캐롤 명곡을 피아노, 콘트라베이스, 드럼의 일본 재즈 트리오 연주로 듣는 공연`
- 매핑 후보: `description`; 영역: 행사 상세.
- 현재 코드: 공통 선택필드 저장/DTO 있음; 서울 parser 미매핑.
- 주의: 19631행 기준 키누락 0, null 17457, 빈문자열 0, 공백만 6. 빈값/공백만 값은 미제공. 공개 본문 정제 및 길이 제한 필요.

### `lot` — 경도(Y좌표)

- 실제 샘플: `127.157342546961`
- 매핑 후보: `longitude`; 영역: 지도 후보.
- 현재 코드: 현재 저장/DTO 없음.
- 주의: 19631행 기준 키누락 0, null 496, 빈문자열 0, 공백만 0. 숫자표본 약126~127도는 경도. latitude와 뒤집지 않음. 다른 공급사와 결합시 명시 좌표계 확인; 좌표로 주소를 추정하지 않음.

### `is_free` — 유무료

- 실제 샘플: `유료`
- 매핑 후보: `admission.kind`; 영역: 행사 목록, 행사 상세.
- 현재 코드: 공통 admission 저장/DTO 있음; 기존 대문자 IS_FREE 대응.
- 주의: 19631행 기준 키누락 0, null 8, 빈문자열 0, 공백만 0. 무료12852/유료6771/null8. 무료 명시만 free; 그 외는 요금설명 있으면 described, 없으면 unknown. 유료이며 설명 누락이면 unknown은 가격정보 미상이지 무료 의미 아님.

## 화면별 권장 범위

| 영역 | 표시 후보 | 결측·경계 |
|---|---|---|
| 행사 목록 | 제목·대표이미지·날짜·장소·분류·서울/구·명시 무료 | 이미지 계약 미지원이면 자리표시자; 비용 미상은 무료 표시 금지; 구가 없으면 서울만 |
| 행사 상세 | 목록 기본값 + 운영시간·프로그램·가격·이용대상·출연자·기관·문의·외부링크·출처 | 선택 항목 비면 숨김. 신규 상세항목은 저장/DTO 확장 후만 연결 |
| 공고의 연결 행사 영역 | 연결 행사 ID·제목·기간·장소·이미지·원천 상세 링크 | 행사 장소/기간은 참고정보. 공고의 만남 시각·상세 지점·동행 비용·상대 정보와 분리 |
| 지도 후보 | 좌표를 검증한 행사장 위치 | 현재 계약 미지원이며 주변/반경/거리순 검색을 추가하는 승인 아님 |

## 현재 코드와 새 원본의 차이

`seoul.ts`는 대문자 `TITLE/STRTDATE/END_DATE/HMPG_ADDR`와 `culturalEventInfo`/`RESULT/list_total_count/row`만 해석한다. 새 전체 JSON은 소문자 키·숫자 epoch·DESCRIPTION/DATA다. 따라서 공통 계약에 대응 필드가 있어도 새 원본을 그대로 기존 transport에 주입할 수 없다. 기존 parser 구현이 곧 신규 수집/저장/화면 적용 완료라는 뜻은 아니다.

공통 `SourceEventRecord`와 DB 저장/공개 투영은 title/category/region/placeName/publicAddress/admission/sourceUrl, date 정밀도의 startsOn/endsOn, 선택 operatingInfo/description/posterUrl를 지원한다. 나머지 신규 후보는 raw 보존 후 민규와 계약 확장한다. 여기서 commonField는 권장 후보이며 현 DTO 존재 표시가 아니다.

특히 **main_img 19,631행 전부 HTTPS지만 query를 가진 서울 이미지 주소**다. `normalize.ts` source 검증은 KOPIS 호스트/upload 경로만 허용하고 query를 금지하며 `events.ts` 공개 parser도 query를 금지한다. `posterUrl`에 바로 넣으면 거절되므로 민규의 서울 이미지 허용 규칙 또는 검증된 이미지 전달 설계가 필요하다. 쿼리를 임의 제거하지 않는다.

## 날짜·식별자·좌표의 필수 검증

- epoch 두 필드는 KST 달력일로 변환하면 모든 행의 date 범위와 일치. precision=date 유지; UTC ISO 날짜 절단으로 하루 앞당기지 않는다. 시작>종료 54행은 격리하며 임의 교환하지 않는다.
- `hmpg_addr` 전 행의 host/path/cultcode 검증 가능, 19,631개 고유 ID. 저장 identity는 provider+sourceId이며 다른 공급사 행사와 제목만으로 자동 합치지 않는다.
- `rgstdate`의 원천 설명은 신청일. 신규 등록 시각·수정 시각·수집 시각을 증명하지 않는다. `collectedAt`는 실제 수집 실행에서 생성한다.
- `lat` 숫자 변환 가능값 범위 약36.48~37.69, `lot` 약126.77~127.33. 직접 float 변환 실패는 lat 9행, lot 7행이며 둘 다 null 각496행이다. 대시·도분초·북위/서경 기호·물결표 값이 혼재한다. 부분 숫자 추출이나 임의 좌표 보정 금지.
- publicAddress 원천 칼럼 없음. 구/장소/좌표를 주소로 채우지 않는다. sourceStatus 취소 여부 원천 칼럼도 없으므로 active 고정과 snapshot 누락/삭제 의미는 민규 계약 확인 과제다.

## 확인한 코드

- `backend/supabase/functions/_shared/integrations/events/seoul.ts`
- `backend/supabase/functions/_shared/integrations/events/port.ts` 및 `normalize.ts`
- `backend/supabase/functions/_shared/integrations/events/detail.ts`
- `backend/supabase/functions/_shared/db/repositories/events.ts`
- `backend/supabase/functions/service-api/events-http.ts`
- `backend/supabase/migrations/20261009031628_event_detail_projection.sql`

검사: 실제 DATA의 키 합집합과 JSON originalField 25개가 완전히 일치하며 중복 없음. DESCRIPTION 25개도 대소문자 정규화 후 같은 집합. 서버/화면 구현 완료 검사나 실시간 공급사 응답 검사는 아니다.
