# WBS7.8 KOPIS 공식 분류 대조 근거 — 2026-10-21

WBS ID: 7.8 · 담당: 민규 · 범위: 공식 문서와 공개 웹의 읽기 조사. 이 기록은 실제 14분류 순위 대조·게시·매일 수집 완료 증거가 아니다. 정책의 14개 선택 항목을 변경하거나 결정을 다시 요청하지 않는다.

## 공식 문서상 확인한 후보 매핑

[공식 OPEN API 공통코드 PDF](https://www.kopis.or.kr/upload/openApi/%EA%B3%B5%EC%97%B0%EC%98%88%EC%88%A0%ED%86%B5%ED%95%A9%EC%A0%84%EC%82%B0%EB%A7%9DOpenAPI%EA%B3%B5%ED%86%B5%EC%BD%94%EB%93%9C.pdf)의 인쇄 페이지 2(PDF 인덱스 1)는 예매상황판 전용 `catecode`를, 인쇄 페이지 3(PDF 인덱스 2)는 예매상황판 전용 `area`를 정의한다. 코드 확인은 해당 분류의 최신 공식 순위와 실제 API 결과가 일치했다는 뜻이 아니다.

| 프로젝트 분류 | 공식 표시명 | 예매상황판 코드 |
|---|---|---|
| theatre | 연극 | catecode=AAAA |
| musical | 뮤지컬 | catecode=GGGA |
| classical | 서양음악(클래식) | catecode=CCCA |
| traditional | 한국음악(국악) | catecode=CCCC |
| popular_music | 대중음악 | catecode=CCCD |
| dance | 무용(서양/한국무용) | catecode=BBBC |
| popular_dance | 대중무용 | catecode=BBBR |
| circus_magic | 서커스/마술 | catecode=EEEB |
| mixed | 복합 | catecode=EEEA |
| children | 아동 | catecode=KID |
| daehakro | 대학로 | area=UNI; 장르 코드와 분리 |

같은 PDF 인쇄 페이지 1의 일반 공연목록용 `shcate`에서 대중무용은 `BBBE`다. 예매상황판의 `catecode=BBBR`와 혼용하지 않는다. 별도로 정의된 오픈런 `OPEN`을 내한·축제로 대체하지 않는다.

[공식 OPEN API 개발가이드 v5.0 PDF](https://kopis.or.kr/upload/openApi/%EA%B3%B5%EC%97%B0%EC%98%88%EC%88%A0%ED%86%B5%ED%95%A9%EC%A0%84%EC%82%B0%EB%A7%9DOpenAPI%EA%B0%9C%EB%B0%9C%EA%B0%80%EC%9D%B4%EB%93%9C.pdf) 인쇄 페이지 16~17(PDF 인덱스 15~16)의 예매상황판 요청 표는 시작·종료일, 장르, 지역, 좌석규모를 설명하고 응답 표는 `basedate`, `rnum`, `mt20id`를 설명한다. 인쇄 페이지 4(PDF 인덱스 3)의 공연상세에는 `visit`, `child`, `daehakro`, `festival` 특성이 있다. 상세 특성 존재만으로 별도 분류 순위 요청이나 공개 Top10을 증명하지 않는다.

## 공연정보 선택과 예매순위 선택의 구분

[공식 메인 페이지](https://kopis.or.kr/por/main/main.do)의 14개 버튼에는 내한·축제가 포함되지만 해당 영역의 제목은 **공연정보**다. 이를 14개 예매순위의 지원 근거로 승격하지 않는다.

[공식 예매상황판](https://kopis.or.kr/por/boxoffice/boxoffice.do)의 공개 웹 검색 본문에서는 전체·9개 장르·아동·오픈런의 12개 선택과 별도 대학로 지역을 확인했다. 기간 입력, 정렬 선택, 최종집계/게시시각도 표시한다. 하지만 이번 web 도구 읽기는 동적 순위 결과를 로딩 또는 0건으로 받아 새 공연ID·순위·원표시순서의 observation을 확보하지 못했다. 이는 실제 공연이 없다는 판정이 아니다.

## 미확정 구현 경계

| 항목 | 확보한 사실 | 아직 필요한 근거 |
|---|---|---|
| all | 공식 UI에 전체 선택 존재 | 이번 읽기에서 빈/생략 catecode의 전체 의미를 명시한 문서와 새 실제 조건·순위 대조는 미확보 |
| visiting | 공연정보의 내한 선택, 상세 visit 필드 존재 | 예매상황판 공식 내한 조건과 그 조건의 ID·순위·순서 |
| festival | 공연정보의 축제 선택, 상세 festival 필드 존재 | 예매상황판 공식 축제 조건과 그 조건의 ID·순위·순서 |
| 자동 대조 | 공식 조건 후보와 기간·ID·순위 필드 설명 | 안전하게 수집할 공개 HTML/JSON 결과 계약, 실제 표시기간·정렬·순서의 검증 |
| 매일 갱신 | 정책은 어제까지 최근 7일·매일 갱신 | 14분류별 새 대조, 게시 연결, 반복 실행·실패 보존의 실제 운영 증거 |

전체 순위를 상세 특성으로 후필터링하여 분류별 공식 Top10을 대신하지 않는다. 문서의 요청 날짜만으로 응답의 실제 표시기간을 확정하거나 일간 순위를 합산하지 않는다. `basedate`가 없어도 공식 사이트의 실제 기간·조건·ID·순위·순서 대조를 통과하면 공개할 수 있다는 기존 정책을 유지한다.

## 오늘 대상과 역사 증거

2026-10-21 한국시간 기준 정책 대상은 **2026-10-14~2026-10-20**이다. 기존 **2026-10-13~2026-10-19 전국 전체·총예매액 Top10의 UI/API 10/10 일치**는 이전 기간의 비교 증거이며 오늘의 최신 검증본으로 재명명하지 않는다. 해당 근거는 [기존 공식 비교 기록](/private/tmp/yumidang-minkyu-wbs-20261017/docs/collaboration/requests/minkyu/2026-10-21-kopis-official-comparison.json)에 분리되어 있다.

역사 승인 GET 1회는 소비됐으며 원 `FAIL_CLOSED / PRODUCT_PARSER_FAILED`와 basedate 누락 기록을 보존한다. 이번 조사는 공식 문서·공개 웹 읽기만 수행했고 **추가 인증 API 호출 0회, 키 사용 0회, 외부 메시지 0회, 회원 원문 전송 0회**다.

## 남은 조건과 다음 작업

정책에 따라 최초 미검증·미지원 분류는 [공식 사이트 링크](https://www.kopis.or.kr/por/boxoffice/boxoffice.do)를 제공하고 자체 순위로 채우지 않는다. 기존 검증 목록의 갱신 실패는 기존 실제 기간을 보존하고 지연을 안내한다. 내한·축제·전체의 불명확한 요청 의미와 자동 결과 수집 계약은 확인 전 임의 매핑하지 않는다. 문서상 후보 11개도 분류별 최신 실제 대조를 통과하기 전에는 공개 검증 완료로 계산하지 않는다.

다음 작업은 공식 조건·기간·정렬이 명확한 분류부터 새로운 공식 observation을 확보하고, 승인된 별도 API 실행의 ID·순위·순서와 비교하는 것이다. 일일 collector, 14분류 실제 대조·운영 게시·DB 반영은 이 조사에서 미실행이다. 전체 진행률 79%(22/28)를 변경하지 않는다.
