<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **AI 선택 동의:** AI 탐색은 첫 사용 동의·거절 시 일반 검색 유지. 후기 AI는 가입 시 열람/내 프로필 생성·노출/작성 후기 활용의 세 선택 항목·기본 미선택이며 전체 동의 편의 기능과 독립 철회를 제공한다. 기존 테스트 계정 간주와 실회원 동의 증거를 구분한다.
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# TourAPI 원본 칼럼·공통 구조·화면 연결 감사

> **2026-10-20 행사 UX 현행 기준:** 이 문서는 작성 당시의 설계·구현·검증 기록입니다. 현재 제품 결정은 [행사 UX 최종 확정 기준](2026-10-20-event-ux-approved-spec.md)을 따릅니다. 작성용 날짜 겹침 강제·동행 일정 자동 검색 축소는 적용하지 않습니다. 직접 입력은 공고 전용이며, 확실한 공식 동일 개최 근거가 있는 원천만 대표 행사로 통합합니다. 비표출/충돌 처리는 현행 명세를 따르며 당시 API/검증 결과가 새 기능 완료를 뜻하지 않습니다. 아래 과거 실행·응답·PASS·미지원 기록은 보존합니다.


> 확인일: 2026-10-19 KST. 작업자 jonghyun. 새 실제 API 호출·키 조회·코드/DB/배포 변경 없음.

## 근거와 관찰 범위

- [공공데이터포털 공식 KorService2 명세](https://www.data.go.kr/data/15101578/openapi.do)를 직접 확인했다. 페이지 수정일 2026-02-26, embedded Swagger `2.0`, 서비스 info.version `1.0.0`. 공개 문서 HTML과 embedded Swagger를 내려받았으며 이는 인증 API 호출이 아니다.
- 조사 대상 코드: `backend/supabase/functions/_shared/integrations/events/tourapi.ts`, `port.ts`, `detail.ts`, `backend/supabase/functions/_shared/db/repositories/events.ts`, `backend/contracts/event-storage.md`, `apps/mobile/src/service.ts`.
- `2026-10-05-real-environment-validation.md`에는 실제 목록/Common/Intro 성공 기록이 있으나 이 문서에 원천 필드 전체 응답은 없다. 보존된 JSON/CSV 검색에서도 TourAPI 실제 원본을 확보하지 못했다. `event-provider-tourapi.test.mjs`의 가상 축제/전화/이미지는 합성 자료이므로 observed로 기록하지 않았다.
- JSON의 evidence=documented는 공식 Swagger 응답 필드 확인을 뜻한다. sample=null은 실제 원본 예시 미확보다. nullable=null은 명세의 JSON null 허용 여부 미확정이며 비어 있거나 누락 가능성은 notes/현재 검증에서 구분한다. 현재 필수 수집값(contentid/title/기간)은 손상 시 실패, 선택값은 미확인 처리한다.
- 공식 Swagger SHA256: `49f2ff3723b87baa2fd5b714be3863d355acf0648462bca6e9b2990b9418a5ce`. 로컬 조사용 원본 `/private/tmp/tourapi-official-page.html`, `/private/tmp/tourapi-official-swagger.json`은 공개 문서다.

## 중요한 차이와 인수인계

1. **기존 지역·분류 코드가 폐기 예정이다.** `areaCode2`, `categoryCode2`는 미사용·삭제예정으로 명시됐다. `areacode`, `sigungucode`, `cat1/2/3`도 동일하다. 새 `ldongCode2`의 `lDongRegnCd/lDongSignguCd`와 `lclsSystmCode2`를 기준으로 준비하되 실제 코드 목록은 이번에 호출하지 않았다. 관광 콘텐츠 타입과 새 분류체계는 별도 값이며 type15로 축제공연행사를 제한하는 현재 구현을 다른 타입 전체 지원으로 확대 해석하지 않는다.
2. **취소·연기 정보가 있어도 현 코드에서 버려진다.** searchFestival2의 `progresstype`는 취소·행사연기, `festivaltype`은 상시·온라인·격년제 필드다. 현 정규화는 `sourceStatus=active`로 고정한다. 민규가 실제 응답 값과 상태 매핑을 확인해야 하며, 이름만 보고 임의 코드값을 만들지 않는다.
3. **addr2는 상세주소다.** 현재 목록 코드가 placeName으로 사용하는 의미 차이가 있다. 상세 Intro의 eventplace가 있으면 대체한다. FE에서는 실제 행사장명이 확보됐다고 단정하지 않아야 한다.
4. **요금 필드 이름 주의:** `usetimefestival`은 시간 아닌 이용요금이다. 현재 described/unknown으로 저장하므로 빈 값을 무료로 표시하지 않는다. `playtime`은 운영/공연시간 원문이며 회원 동행 약속 시간을 자동 생성하지 않는다.
5. **HTML 원문 때문에 정보가 빠질 수 있다.** Common.overview/Intro.playtime/usetimefestival/eventplace는 optionalPlain에서 태그/제어문자 발견 시 제외한다. 안전한 본문 변환이 구현됐다고 표현하지 않는다.
6. **이미지·출처 링크가 API에 존재해도 앱 지원은 별개다.** firstimage/firstimage2, homepage/eventhomepage, detailImage2 URL/권리 필드는 현재 미수집이며 TourAPI posterUrl/sourceUrl=null이다. Type1/Type3 권리와 안전 URL 검증 후 연결할 작업을 민규에게 넘긴다. 홈페이지와 예매처는 구분하고 링크가 없으면 출처명만 보여준다.
7. **동기화 준비:** areaBasedSyncList2는 showflag/oldContentid/modifiedtime을 제공하지만 현 TourAPI 수집기는 searchFestival2뿐이다. 누락을 삭제로 처리하지 않는다. cpyrhtDivCd 설명에는 오류코드 문구가 있어 명세 오류 가능성을 따로 기록했다.

## 현재 공통 구조와 화면 매핑

| 화면 | 현재 사용 가능한 구조 | 추가 원천 후보와 남은 연결 |
|---|---|---|
| 행사 목록 | sourceId/title/startsOn/endsOn/category(고정 행사·공연·축제)/region/publicAddress | firstimage2 이미지·새 분류/법정동 표시명은 현재 미연결. 기간으로 앱 상태를 계산하더라도 취소·연기는 별도 보완 필요 |
| 행사 상세 | 위 기본값 + eventplace/overview/playtime/usetimefestival에서 장소·설명·운영·요금 | agelimit, bookingplace, program, subevent, sponsor1/2, 문의처, 반복정보, 이미지·홈페이지는 현재 별도 DTO 없음/미연결 |
| 공고 작성 연결 행사 | provider+sourceId 및 내부 행사 ID로 선택·기간겹침 확인, 행사명·기간·장소 후보 | 행사 기간은 동행 약속 아님. 행사장/주소는 후보이며 상세 만남 지점과 분리 |
| 공고 상세 연결 행사 | 행사명·행사기간·공개 장소 요약·행사 상세 이동 | 동행인 프로필·동행비용·신청/확정·후기 정보는 이 API에서 받지 않음 |

SourceEventRecord와 앱 public event DTO의 기본 필드 재사용이 우선이다. 전화·좌표·연령·주최·분류코드 등의 추가 저장 구조를 이 문서에서 확정하지 않았다. 화면 항목은 후보이며 공급사가 실제 제공한 값만 표시한다. 다른 공급사와 제목이 비슷하다는 이유로 병합하지 않는다.

## 원본 필드 전체 목록

JSON 동반파일은 아래 endpoint별 응답을 행으로 기록한다. detailIntro2는 type15와 공통 ID, detailInfo2는 행사에 적용되는 일반 반복정보만 포함하며 숙박·음식점·코스 전용 필드는 이번 행사 범위에서 제외했다.

### searchFestival2

| 원본 칼럼 | 뜻 | 공통 필드 | 현재 코드 |
|---|---|---|---|
| lclsSystm2 | 분류체계 2Deth | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm3 | 분류체계 3Deth | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| tel | 전화번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| title | 제목 | title | 현재 어댑터 수집·검증 → SourceEventRecord.title → 저장/public event DTO 지원 |
| addr1 | 주소 | publicAddress | 현재 어댑터 수집·검증 → SourceEventRecord.publicAddress → 저장/public event DTO 지원 |
| addr2 | 상세주소 | placeName | 현재 어댑터 수집·검증 → SourceEventRecord.placeName → 저장/public event DTO 지원 |
| areacode | 미사용항목(삭제예정-법정동 시도코드 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cat1 | 미사용항목(삭제예정-분류체계 1Deth 코드로 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cat2 | 미사용항목(삭제예정-분류체계 2Deth 코드로 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cat3 | 미사용항목(삭제예정-분류체계 3Deth 코드로 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| contentid | 콘텐츠ID | sourceId | 현재 어댑터 수집·검증 → SourceEventRecord.sourceId → 저장/public event DTO 지원 |
| contenttypeid | 콘텐츠타입ID | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| createdtime | 등록일 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| eventstartdate | 행사시작일(형식 : YYYYMMDD) | startsOn | 현재 어댑터 수집·검증 → SourceEventRecord.startsOn → 저장/public event DTO 지원 |
| cpyrhtDivCd | 저작권 유형 (Type1:제1유형(출처표시-권장), Type3:제3유형(제1유형+변경금지) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| eventenddate | 행사종료일(형식 : YYYYMMDD) | endsOn | 현재 어댑터 수집·검증 → SourceEventRecord.endsOn → 저장/public event DTO 지원 |
| firstimage | 대표이미지(원본) | posterUrl | 공통 DTO 자리(posterUrl)는 있으나 이 원천 필드는 현재 미수집·미저장; TourAPI 현재 결과 null |
| firstimage2 | 대표이미지(썸네일) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| mapx | GPS X좌표 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| mapy | GPS Y좌표 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| mlevel | Map Level | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| modifiedtime | 수정일 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| sigungucode | 미사용항목(삭제예정-법정동 시군구 코드 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| zipcode | 우편번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| progresstype | 축제형태(취소,행사연기) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| festivaltype | 진행형태(상시,온라인,격년제) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lDongRegnCd | 법정동 시도코드 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lDongSignguCd | 법정동 시군구코드 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm1 | 분류체계 1Deth | 없음 | 미수집·미저장·DTO 전용 필드 없음 |

### detailCommon2

| 원본 칼럼 | 뜻 | 공통 필드 | 현재 코드 |
|---|---|---|---|
| lclsSystm3 | 분류체계 3Deth | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| overview | 개요 | description | 현재 어댑터 수집·검증 → SourceEventRecord.description → 저장/public event DTO 지원 |
| contentid | 콘텐츠ID | sourceId | 현재 어댑터 수집·검증 → SourceEventRecord.sourceId → 저장/public event DTO 지원 |
| sigungucode | 미사용항목(삭제예정-법정동 시군구 코드 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cat1 | 미사용항목(삭제예정-분류체계 1Deth 코드로 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cat2 | 미사용항목(삭제예정-분류체계 2Deth 코드로 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cat3 | 미사용항목(삭제예정-분류체계 3Deth 코드로 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| addr1 | 주소 | publicAddress | 현재 어댑터 수집·검증 → SourceEventRecord.publicAddress → 저장/public event DTO 지원 |
| addr2 | 상세주소 | placeName | 현재 어댑터 수집·검증 → SourceEventRecord.placeName → 저장/public event DTO 지원 |
| zipcode | 우편번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| mapx | GPS X좌표 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| mapy | GPS Y좌표 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| mlevel | Map Level | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cpyrhtDivCd | 저작권 유형 (Type1:제1유형(출처표시-권장), Type3:제3유형(제1유형+변경금지) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| contenttypeid | 콘텐츠타입ID | 없음 | 현재 어댑터 수집·검증; ID/type 일치 확인용 |
| createdtime | 등록일 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| homepage | 홈페이지주소 | sourceUrl | 공통 DTO 자리(sourceUrl)는 있으나 이 원천 필드는 현재 미수집·미저장; TourAPI 현재 결과 null |
| modifiedtime | 수정일 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| tel | 전화번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| telname | 전화번호명 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| title | 콘텐츠명(제목) | title | 현재 어댑터 수집·검증 → SourceEventRecord.title → 저장/public event DTO 지원 |
| firstimage | 대표이미지(원본) | posterUrl | 공통 DTO 자리(posterUrl)는 있으나 이 원천 필드는 현재 미수집·미저장; TourAPI 현재 결과 null |
| firstimage2 | 대표이미지(썸네일) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| areacode | 미사용항목(삭제예정-법정동 시도코드 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lDongRegnCd | 법정동 시도코드 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lDongSignguCd | 법정동 시군구코드 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm1 | 분류체계 1Deth | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm2 | 분류체계 2Deth | 없음 | 미수집·미저장·DTO 전용 필드 없음 |

### detailIntro2

| 원본 칼럼 | 뜻 | 공통 필드 | 현재 코드 |
|---|---|---|---|
| eventhomepage | 행사공연축제(15) : 행사홈페이지 | sourceUrl | 공통 DTO 자리(sourceUrl)는 있으나 이 원천 필드는 현재 미수집·미저장; TourAPI 현재 결과 null |
| eventplace | 행사공연축제(15) : 행사장소 | placeName | 현재 어댑터 수집·검증 → SourceEventRecord.placeName → 저장/public event DTO 지원 |
| eventstartdate | 행사공연축제(15) : 행사시작일 | startsOn | 현재 어댑터 수집·검증 → SourceEventRecord.startsOn → 저장/public event DTO 지원 |
| festivalgrade | 행사공연축제(15) : 축제등급 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| discountinfofestival | 행사공연축제(15) : 할인정보 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| eventenddate | 행사공연축제(15) : 행사종료일 | endsOn | 현재 어댑터 수집·검증 → SourceEventRecord.endsOn → 저장/public event DTO 지원 |
| playtime | 행사공연축제(15) : 공연시간 | operatingInfo | 현재 어댑터 수집·검증 → SourceEventRecord.operatingInfo → 저장/public event DTO 지원 |
| placeinfo | 행사공연축제(15) : 행사장위치안내 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| contentid | 기본정보 : 콘텐츠ID | sourceId | 현재 어댑터 수집·검증 → SourceEventRecord.sourceId → 저장/public event DTO 지원 |
| contenttypeid | 기본정보 : 콘텐츠타입ID | 없음 | 현재 어댑터 수집·검증; ID/type 일치 확인용 |
| program | 행사공연축제(15) : 행사프로그램 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| spendtimefestival | 행사공연축제(15) : 관람소요시간 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| sponsor1 | 행사공연축제(15) : 주최자정보 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| sponsor1tel | 행사공연축제(15) : 주최자연락처 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| agelimit | 행사공연축제(15) : 관람가능연령 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| bookingplace | 행사공연축제(15) : 예매처 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| sponsor2 | 행사공연축제(15) : 주관사정보 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| sponsor2tel | 행사공연축제(15) : 주관사연락처 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| subevent | 행사공연축제(15) : 부대행사 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| usetimefestival | 행사공연축제(15) : 이용요금 | admission | 현재 어댑터 수집·검증 → SourceEventRecord.admission → 저장/public event DTO 지원 |

### detailInfo2

| 원본 칼럼 | 뜻 | 공통 필드 | 현재 코드 |
|---|---|---|---|
| contentid | 기본정보 : 콘텐츠ID | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| contenttypeid | 기본정보 : 콘텐츠타입ID | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| fldgubun | 숙박/여행코스제외타입 : 일련번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| infoname | 숙박/여행코스제외타입 : 제목 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| infotext | 숙박/여행코스제외타입 : 내용 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| serialnum | 숙박/여행코스제외타입 : 반복일련번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |

### detailImage2

| 원본 칼럼 | 뜻 | 공통 필드 | 현재 코드 |
|---|---|---|---|
| cpyrhtDivCd | 저작권 유형 (Type1:제1유형(출처표시-권장), Type3:제3유형(제1유형+변경금지) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| contentid | 기본정보 : 콘텐츠ID | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| imgname | 이미지명 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| originimgurl | 원본이미지 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| serialnum | 이미지일련번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| smallimageurl | 썸네일이미지 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |

### areaCode2

| 원본 칼럼 | 뜻 | 공통 필드 | 현재 코드 |
|---|---|---|---|
| code | 코드 : 지역코드또는시군구코드 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| name | 코드명 : 지역명또는시군구명 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| rnum | 일련번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |

### categoryCode2

| 원본 칼럼 | 뜻 | 공통 필드 | 현재 코드 |
|---|---|---|---|
| name | 코드명 : 대,중,소분류코드명 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| rnum | 일련번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| code | 코드 : 대,중,소분류코드 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |

### ldongCode2

| 원본 칼럼 | 뜻 | 공통 필드 | 현재 코드 |
|---|---|---|---|
| lDongSignguNm | 법정동 시군구명 (lDongListYn : Y일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| name | 법정동 : 시도명, 시군구명 (lDongListYn : N일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| rnum | 일련번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| code | 법정동 : 시도코드, 시군구코드 (lDongListYn : N일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lDongRegnCd | 법정동 시도코드 (lDongListYn : Y일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lDongRegnNm | 법정동 시도명 (lDongListYn : Y일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lDongSignguCd | 법정동 시군구코드 (lDongListYn : Y일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |

### lclsSystmCode2

| 원본 칼럼 | 뜻 | 공통 필드 | 현재 코드 |
|---|---|---|---|
| lclsSystm3Nm | 분류체계 소분류명(lclsSystmListYn : Y 일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| name | 코드:1Depth,2Depth,3Depth 코드명(lclsSystmListYn : N 일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| rnum | 일련번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| code | 코드:1Depth,2Depth,3Depth 코드(lclsSystmListYn : N 일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm1Cd | 분류체계 대분류코드(lclsSystmListYn : Y 일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm1Nm | 분류체계 대분류명(lclsSystmListYn : Y 일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm2Cd | 분류체계 중분류코드(lclsSystmListYn : Y 일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm2Nm | 분류체계 중분류명(lclsSystmListYn : Y 일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm3Cd | 분류체계 소분류코드(lclsSystmListYn : Y 일때 표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |

### areaBasedSyncList2

| 원본 칼럼 | 뜻 | 공통 필드 | 현재 코드 |
|---|---|---|---|
| oldContentid | 이전 컨텐츠 ID ( DB 저장 동기화시 이전 KEY 값으로 조회 용도  ) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm3 | 분류체계 3Deth | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| mapx | GPS X좌표(WGS84 경도좌표) 응답 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| mapy | GPS Y좌표(WGS84 위도좌표) 응답 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| mlevel | Map Level 응답 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| modifiedtime | 콘텐츠수정일 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| showflag | 표출여부(0:비표출,1:표출) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| sigungucode | 미사용항목(삭제예정-법정동 시군구 코드 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| tel | 전화번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| title | 콘텐츠제목 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| addr1 | 주소(예, 서울중구다동)를응답 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| addr2 | 상세주소 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| areacode | 미사용항목(삭제예정-법정동 시도코드 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cat1 | 미사용항목(삭제예정-분류체계 1Deth 코드로 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cat2 | 미사용항목(삭제예정-분류체계 2Deth 코드로 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cat3 | 미사용항목(삭제예정-분류체계 3Deth 코드로 대체) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| contentid | 콘텐츠ID | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| contenttypeid | 관광타입(관광지, 숙박등) ID | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| createdtime | 콘텐츠최초등록일 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| cpyrhtDivCd | 필수요청파라메터가없음(NO_MANDATORY_REQUEST_PARAMETERS_ERROR) | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| firstimage | 원본대표이미지 (약 500*333 size) URL 응답 | 없음 | 미수집·미저장·DTO 전용 필드 없음; TourAPI 현재 결과 null |
| firstimage2 | 썸네일대표이미지 (약 150*100 size) URL 응답 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| zipcode | 우편번호 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lDongRegnCd | 법정동 시도코드 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lDongSignguCd | 법정동 시군구코드 | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm1 | 분류체계 1Deth | 없음 | 미수집·미저장·DTO 전용 필드 없음 |
| lclsSystm2 | 분류체계 2Deth | 없음 | 미수집·미저장·DTO 전용 필드 없음 |

## 다음 실제 검증

민규 소유 서버 작업에서 새 분류·법정동 코드와 취소/연기 실제 값, HTML 포함 원문, 이미지 권리/호스트, 공식 링크 URL, 반복정보 응답을 최소 표본으로 확인해야 한다. 이번 문서 정리가 API 추가 연결·지속 수집·운영 배포·화면 표시 완료를 뜻하지 않는다.
