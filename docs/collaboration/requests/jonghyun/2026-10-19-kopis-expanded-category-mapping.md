<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 확정 결정·설계의 근거 기록입니다. 이후 변경된 항목은 현재 정책과 통합 원장이 우선하며, 이 문서의 제품 선택과 실제 구현·운영 완료는 구분합니다. 원본 사용자 답변과 당시 검증 결과는 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
<!-- /current-policy-sync -->

# KOPIS 순위 14범주 매핑과 검증 경계

확인일: 2026-10-19 · 작업자: 종현 · 공개 문서/웹 스크립트 읽기 전용 확인. 이번 확인에는 인증키 API 요청, 서버 변경, 배포를 수행하지 않았다.

## 확정된 제품 범위

A안: 공식 사이트의 명시된 기간·조건과 API Top 10 공연 ID·순서를 대조한 범주만 공개한다. 기준은 한국시간 어제까지 최근 7일이다. 갱신 실패 시 마지막 검증 목록의 실제 기간을 유지하고 갱신 지연을 표시한다. 최초 검증 이력이 없으면 공식 사이트 링크를 제공한다. 공급사 회신 전 일괄 보류 대신 이 공개 조건을 적용한다. 원인 없는 날짜 대체, 전체 순위의 일부를 필터링한 자체 장르 순위, 임의 동률 재정렬은 금지한다.

전체 공연을 기본으로 아래 정확히 14범주를 제공한다. 배리어프리·오픈런을 임의 추가하지 않는다. 클래식·국악·무용은 화면 표시명만 줄이며 원천 분류와 코드는 유지한다.

## 원천별 매핑

공식 공통코드 PDF 1~3쪽, 개발가이드 16~17쪽과 2026-10-19 공식 메인 웹 공개 JS를 확인했다. 아래 API 값은 **문서상 정의**이며 14범주의 실제 순위 수신·대조 통과를 의미하지 않는다. 메인 웹 매개변수는 공식 개발자 API 계약과 별개인 웹 내부 조회 조건이다.

| 화면 표시명 | 예매상황판 OpenAPI 요청 정의 | 공식 메인 웹 선택 조건 | 주의 |
|---|---|---|---|
| 전체 공연 | catecode·area 미지정 | genreGubun='', specificGubun='' | 전국·좌석수 전체 조건 필요 |
| 연극 | catecode=AAAA | genreGubun=AAAA | 특성값 공백 |
| 뮤지컬 | catecode=GGGA | genreGubun=GGGA | 특성값 공백 |
| 클래식 | catecode=CCCA | genreGubun=CCCA | 원명 서양음악(클래식) |
| 국악 | catecode=CCCC | genreGubun=CCCC | 원명 한국음악(국악) |
| 대중음악 | catecode=CCCD | genreGubun=CCCD | 특성값 공백 |
| 무용 | catecode=BBBC | genreGubun=BBBC | 원명 무용(서양/한국무용) |
| 대중무용 | catecode=BBBR | genreGubun=BBBE | **공식 PDF의 순위용 BBBR과 일반 목록·웹 BBBE가 다름. 임의 통일 금지. 실제 수신·대조 필요** |
| 서커스/마술 | catecode=EEEB | genreGubun=EEEB | 특성값 공백 |
| 복합 | catecode=EEEA | genreGubun=EEEA | 특성값 공백 |
| 아동 | catecode=KID | genreGubun='', specificGubun=kid | 장르가 아닌 특성; 장르와 중복 가능 |
| 대학로 | area=UNI, catecode 미지정 | genreGubun='', specificGubun=varsity | 지역 특성; 전국 전체와 조회 조건 구분 |
| 내한 | boxoffice 공개명세에서 전용 요청 코드 미확인 | genreGubun='', specificGubun=visit | 공연 상세 visit=Y는 존재하나 전체 Top 50 필터링으로 내한 Top 10 생성 금지 |
| 축제 | boxoffice 공개명세에서 전용 요청 코드 미확인 | genreGubun='', specificGubun=festival | 상세 festival=Y·축제 목록 prffest 존재가 축제 공식 순위 API 보장을 뜻하지 않음 |

## 웹 조회 경로와 기간 확인 경계

2026-10-19 메인 HTML에서 로드하는 공개 스크립트 `/_next`의 실제 경로는 아래 출처 링크와 같다. 메인 `useListReadMainBoxOffice`는 `genreGubun`·`specificGubun`으로 `/pco/por/main/mainBoxOffice.json`을 호출하도록 정의되어 있다. 상대 경로를 그대로 kopis.or.kr 루트에 GET한 전체/내한/축제 3요청은 HTTP 404였다. 따라서 이 상대 경로를 외부에서 바로 사용 가능한 OpenAPI라고 문서화하거나 자동 수집 계약으로 확정하지 않는다. 실제 fetcher 기본 경로와 응답 기간 확인이 필요하다.

이전 10/17 예매상황판 캐시 JS는 별도 GraphQL `boxofficeList(startDate,endDate,genre_code,STDG_CPSGG_CD,seatScale,rankType)`를 정의한다. 장르 웹 값은 위와 동일한 일반 장르 코드·아동 KID이며, 대학로는 `STDG_CPSGG_CD=UNI`이다. 이 예매상황판 JS에 내한·축제 선택이 확인되지 않았다. **메인 14개 버튼의 존재를 곧바로 해당 GraphQL 14범주 지원·동일 주간기간 확인으로 연결하지 않는다.**

공식 가이드의 basedate 필드는 여전히 존재한다. 누락에 따른 불일치는 A안의 외부 대조를 통해 공개 판단하되, API 내부 집계가 증명되었다고 주장하지 않는다. 이번 기록만으로 14범주 검증 완료·공개 완료를 선언하지 않는다.

## 검증 실행 시 기록

범주별 요청 코드·웹 조건·공식 화면에 명시된 시작일/종료일·한국시간 수집시각·응답 순번/공식 순번·공연 ID를 보존한다. Top 10보다 실제 결과가 적다면 원천 결과 개수를 그대로 사용하며 채워 넣지 않는다. 범주별 일치 여부를 독립 판정한다. 대중무용 코드 차이와 내한·축제 지원 여부를 특히 검증한다. 미확인 범주는 승인한 A안의 공식 링크 대체 상태를 적용한다.

## 공식 출처와 로컬 근거

- [OPEN API 공통코드 PDF](https://kopis.or.kr/upload/openApi/공연예술통합전산망OpenAPI공통코드.pdf): 1쪽 일반장르, 2쪽 예매상황판 catecode, 3쪽 area=UNI. 문서의 대중무용 코드가 용도별로 다르다.
- [OPEN API 개발가이드 PDF](https://kopis.or.kr/upload/openApi/공연예술통합전산망OpenAPI개발가이드.pdf): v5.0 배포일 2026-04-23, boxoffice 요청/응답, 상세 child·daehakro·visit·festival.
- [공식 메인](https://kopis.or.kr/por/main/main.do)
- [2026-10-19 메인 선택조건 JS](https://kopis.or.kr/_next/static/chunks/19zfth-xfqt6t.js)
- [2026-10-19 메인 조회 hook JS](https://kopis.or.kr/_next/static/chunks/1t71wrud9gzoy.js)
- 로컬 당일 캐시: `/private/tmp/kopis-main-20261019.html`, `/private/tmp/kopis-main-20261019-19zfth-xfqt6t.js`, `/private/tmp/kopis-main-20261019-1t71wrud9gzoy.js`.
- 과거 별도 예매상황판 JS: `/private/tmp/kopis-15raofnw5z_98.js` (10/17 자료, 최신이라고 단정하지 않음).

## 추가 논의: 최근 7일 대신 일별

사용자가 일별 전환 가능성을 질문한 것은 아직 기간 변경의 확정으로 해석하지 않는다. 공통코드에는 ststype=day가, boxoffice 가이드에는 date(날짜, 샘플 20171219)와 stdate·eddate가 정의되어 있다. 하지만 당일 가이드의 boxoffice 요청 표에는 ststype가 직접 명시되지 않아, 날짜 변수 조합을 실제 응답 검증 없이 단정하지 않는다. basedate 누락과 내한·축제 전용 순위 요청 명세 부족은 일별로 바꾸더라도 자동 해소되지 않는다.

메인 14버튼에서 useListReadMainBoxOffice에 전달되는 조건은 genreGubun·specificGubun뿐이다. 근처에 mainStatGubun=daily/weekly/monthly 및 startDate·endDate가 있으나 이 값은 다른 통계 hook로 전달된다. 따라서 인접한 daily/weekly 선택을 순위 14범주의 기간 전환으로 착각하지 않는다. 전용 예매상황판 GraphQL은 별도 startDate·endDate를 받지만 공식 표시기간·응답 순위가 그 조건과 일치하는지 범주별 대조가 필요하다.

일별을 선택한다면 어제 한국시간 00:00~23:59:59를 제품 목표로 명시하고 공식 화면의 해당 날짜, 요청 날짜, Top 10 ID·순서를 확인하는 A안 검증을 유지하는 것이 안전하다. 이 목표 정의는 실제 원천이 해당 일자 전체를 집계했다는 확인을 대신하지 않는다.
