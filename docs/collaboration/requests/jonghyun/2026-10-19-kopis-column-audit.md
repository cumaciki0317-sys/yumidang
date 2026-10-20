<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **AI 선택 동의:** AI 탐색은 첫 사용 동의·거절 시 일반 검색 유지. 후기 AI는 가입 시 열람/내 프로필 생성·노출/작성 후기 활용의 세 선택 항목·기본 미선택이며 전체 동의 편의 기능과 독립 철회를 제공한다. 기존 테스트 계정 간주와 실회원 동의 증거를 구분한다.
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미다. 일반 신고 처리와 해당 신고의 허용된 제출 증거 처리는 조유미 부재 시 종현이 대체한다. 이 지정은 고객지원·AI 비용·서버 운영의 대체 권한으로 확대하지 않는다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# KOPIS 원본 칼럼·공통 구조 대조 (2026-10-19)

새 공급사 호출 없이 기존 실응답 XML·공식 개발가이드 전체 추출문·현재 코드를 읽어 작성했다. 수신 확인과 저장/공개 지원, 실제 운영 연결 완료는 구분한다. 순위 집계 기간은 Dots의 A안 대조 결과를 기다리며 일반 행사 정리를 계속한다. 이 문서는 구현 변경 승인이 아니며 BE 구현은 민규 담당이다.

## 근거와 정확한 개수

- 공식 명세: [KOPIS 개발가이드](https://kopis.or.kr/upload/openApi/공연예술통합전산망OpenAPI개발가이드.pdf), 첨부 v5.0 전체 텍스트 `/private/tmp/kopis-attached-guide-all.txt`.
- 실응답: `/private/tmp/jh-kopis-basic-20261019/`의 목록 2페이지(총 4건), 공연 상세 1건, 시설 상세 1건(공연장 3개). 결과·이미지 검사는 같은 폴더 summary.json/results.json 참조.
- 순위 원본: `/private/tmp/kopis-parameter-probe-20261019/rank-baseline.xml`, 기간·변수 비교 results.json.
- 목록 10개. 공연 상세는 최상위 34개(평면32+중첩2), 중첩 말단까지 35개. 시설 상세는 최상위 **22개**(평면21+홀목록1), 홀 내부9개를 포함한 고유 말단30개. 기존 ‘시설24’ 표현은 정확하지 않다.
- 순위는 실수신10개 + 명세에만 있는 `basedate` 1개. 동일 이름이라도 엔드포인트 의미를 분리했다.
- JSON에는 중첩 컨테이너도 포함하며 `styurls.styurl`, `relates.relate.relateurl`, `mt13s.mt13.mt13id`처럼 경로를 기록했다. 빈 문자열/공백의 실제 관찰은 nullable=true, 표본에서 값이 있다는 이유만으로 필수라고 단정하지 않아 나머지는 null. 목록의 5개 필수값만 현재 엄격 파서 기준 false다.

## 현재 구현과 원본의 차이

1. `kopis.ts`: 목록10개를 파서가 수용하지만 poster/openrun은 정규화에서 버린다. 공연명·날짜·시설명·지역·장르는 공통 레코드로 이어지고, publicAddress/sourceUrl은 null, admission은 unknown이다.
2. `detail.ts`: 가격 안내→admission(described/unknown), 시간 안내→operatingInfo, 소개→description, HTTPS 원본 포스터만 posterUrl로 만든다. 출연진·관람연령·런타임·기관명·특성 플래그·시설ID는 허용하지만 공통 모델에 저장하지 않는다. 중첩 소개이미지·예매처 목록은 검사 후 제거한다.
3. 실제 포스터는 `http://www.kopis.or.kr/...`이어서 현 코드가 posterUrl=null로 만든다. 포스터/소개이미지 각1개에 한해 `https://kopis.or.kr` HEAD200을 확인했지만, 임의 전면변환 정책/전체 안전성/이미지 실제 렌더 검증은 아니다.
4. 원천 소개 `sty`에 줄바꿈이 실제 존재한다. 현재 detail plain() 및 공통 검증이 제어문자(줄바꿈 포함)를 거절하므로 이 표본의 상세 정규화가 실패할 수 있다. 네트워크 성공을 현재 어댑터 파싱 성공으로 보고하면 안 된다. 안전한 텍스트 정규화/개행 계약을 민규와 연결할 과제다.
5. `prfplc/{mt10id}`의 주소·좌표·편의시설·홀 정보를 실제 받았지만 현재 행사 수집 코드에는 시설 fetch/join 경로가 없다. 공연상세.mt10id=시설.mt10id, 공연상세.mt13id=시설.mt13s.mt13.mt13id로 연결한 뒤 정확한 홀을 선택해야 한다. 시설명 문자열로 조인하지 않는다.
6. 저장은 `SourceEventRecord`→events.ts `toWireEvent`→RPC 경로, 공개 타입 이름은 **PublicEventItem**이다(`PublicEventDTO`라는 심볼은 없음). 클라이언트 service.ts의 엄격 검증도 같은 한정된 키만 받는다. 계약·마이그레이션·런타임 연결 완료는 코드 존재만으로 판단하지 않는다.
7. `kopis-ranking.ts`는 현재 all/musical만 지원하며 basedate·연속 순번을 필수 검사한다. 최신 제품 의도14분류/A안 대조/동률 보존과 실제 코드가 아직 같지 않다. 기간 검증 우회나 순위 활성화는 하지 않았다.

## 화면에 넣을 수 있는 정보와 경계

| 화면 | 현재 계약으로 가능한 값 | 원본에 있지만 추가 연결이 필요한 값 |
|---|---|---|
| 행사 목록 | 제목·날짜기간·지역·장르·시설명·날짜 기반 상태, 상세 보강 시 가격안내/HTTPS포스터 | 특성 플래그·관람연령·실제 포스터 HTTPS 검증/변환 |
| 행사 상세 | 위 값+가격 서술·공연시간 안내·줄거리(안전한 파싱 해결 필요) | 출연진·런타임·관람연령·소개이미지·예매처 링크·시설주소/좌표/편의시설 |
| 공고 연결 행사 | 해당 행사의 제목·기간·공개 장소·장르·안전한 포스터 등 일반 행사 요약 | 연결되는 공통 DTO 범위를 먼저 확정한 뒤 추가 |

공고 작성자·동행 날짜/시간·만남 지점·모집 상태·동행 비용은 회원/공고 데이터다. 공연기간·입장료·공연장 주소로 덮어쓰지 않는다. 주소는 공개 공연시설 주소이며 확정 당사자의 비공개 만남 지점과 다르다.

## 해석·검증 주의

- 가격은 ‘전석 40,000원’ 같은 서술이며 누락=무료가 아니다. 현 코드에서는 무료 문구도 described다. 무료 필터를 위해 명확한 원천값과 정책별 변환 검토가 필요하다.
- 공연 기간은 YYYY.MM.DD→날짜만 변환하며 날짜 역전을 검사한다. 운영시간 문자열에서 단일 행사 시각을 임의 생성하지 않는다. 실제 상세 표본은 같은 날이며 날짜 역전 없음. 4개 목록 표본도 시작≤종료다.
- `frstregdt`·`updatedate`는 공연 메타데이터 날짜다. 시간대가 없고 updatedate에는 소수초도 있다. 순위 기준일/수집시각으로 바꾸지 않는다.
- 좌석수·시설 플래그는 잔여석·주차 여유·실시간 접근성을 보장하지 않는다. N/0/빈값 의미를 분리한다.
- 원천 장르를 보존하고 클래식/국악/무용은 표시 별칭으로 둔다. 특성 필터와 순위 전용 코드를 혼용하지 않는다. 아동/내한/축제 플래그로 전체 Top50을 걸러 공식 분류 순위라고 표시하지 않는다.
- 키는 보고서/샘플에 포함하지 않았다. sourceUrl에는 인증키 포함 API URL을 넣지 않는다.

## 누락 검사

네 개 XML 전체의 모든 항목을 재귀 순회해 고유 경로 집합과 JSON의 observed 집합을 비교했다. 누락/과잉 0, endpoint+originalField 중복0. 아래 완전목록은 같은 JSON에서 생성했다.

### pblprfr

| 원본 경로 | 의미 | 공통 필드 | 관찰/지원 |
|---|---|---|---|
| `mt20id` | 공연 ID | sourceId | observed; 목록 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `prfnm` | 공연명 | title | observed; 목록 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `prfpdfrom` | 공연 시작일 | startsOn | observed; 목록 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `prfpdto` | 공연 종료일 | endsOn | observed; 목록 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `fcltynm` | 공연시설명(공연장명) | placeName | observed; 목록 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `poster` | 포스터 URL | posterUrl | observed; 목록 파서 수용; 공통 정규화에서 제외 |
| `area` | 공연 지역 | region | observed; 목록 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `genrenm` | 공연 장르명 | category | observed; 목록 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `openrun` | 오픈런 여부 | — | observed; 목록 파서 수용; 공통 정규화에서 제외 |
| `prfstate` | 공연 상태 | sourceStatus | observed; 목록 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |

### pblprfr/{mt20id}

| 원본 경로 | 의미 | 공통 필드 | 관찰/지원 |
|---|---|---|---|
| `mt20id` | 공연 ID | sourceId | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `mt13id` | 공연장 ID | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `prfnm` | 공연명 | title | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `frstregdt` | 공연정보 최초 등록일 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `prfpdfrom` | 공연 시작일 | startsOn | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `prfpdto` | 공연 종료일 | endsOn | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `fcltynm` | 공연시설명(공연장명) | placeName | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `prfcast` | 출연진 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `prfcrew` | 제작진 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `prfruntime` | 공연 런타임 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `prfage` | 관람 연령 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `entrpsnm` | 기획제작사 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `entrpsnmP` | 제작사 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `entrpsnmA` | 기획사 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `entrpsnmH` | 주최 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `entrpsnmS` | 주관 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `pcseguidance` | 티켓 가격 안내 | admission | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `poster` | 포스터 URL | posterUrl | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음; HTTPS 원본만 출력하므로 이번 HTTP 표본 posterUrl=null |
| `sty` | 줄거리/소개 원문 | description | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `area` | 공연 지역 | region | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `genrenm` | 공연 장르명 | category | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `openrun` | 오픈런 여부 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `visit` | 내한 여부 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `child` | 아동 여부 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `daehakro` | 대학로 여부 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `festival` | 축제 여부 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `musicallicense` | 뮤지컬 라이선스 여부 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `musicalcreate` | 창작 뮤지컬 여부 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `updatedate` | 공연정보 최종 수정일 | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `prfstate` | 공연 상태 | sourceStatus | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `mt10id` | 공연시설 ID | — | observed; 상세 파서 허용목록에서 수용하지만 공통 저장/공개 DTO에서 제외 |
| `dtguidance` | 공연 요일·시간 안내 | operatingInfo | observed; 상세 파서 수용; SourceEventRecord → 저장 wire → 공개 PublicEventItem 경로 있음 |
| `styurls` | 소개이미지 목록 | — | observed; 중첩 구조 검사 후 제거; 현재 저장/공개 DTO 미지원 |
| `styurls.styurl` | 소개이미지 URL | — | observed; 중첩 구조 검사 후 제거; 현재 저장/공개 DTO 미지원 |
| `relates` | 예매처 목록 | — | observed; 중첩 구조 검사 후 제거; 현재 저장/공개 DTO 미지원 |
| `relates.relate` | 예매처 항목 | — | observed; 중첩 구조 검사 후 제거; 현재 저장/공개 DTO 미지원 |
| `relates.relate.relatenm` | 예매처명 | — | observed; 중첩 구조 검사 후 제거; 현재 저장/공개 DTO 미지원 |
| `relates.relate.relateurl` | 홈페이지/예매처 URL | — | observed; 중첩 구조 검사 후 제거; 현재 저장/공개 DTO 미지원 |

### prfplc/{mt10id}

| 원본 경로 | 의미 | 공통 필드 | 관찰/지원 |
|---|---|---|---|
| `fcltynm` | 공연시설명(공연장명) | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt10id` | 공연시설 ID | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13cnt` | 공연장 수 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `fcltychartr` | 시설 특성 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `opende` | 개관 연도 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `seatscale` | 시설/공연장 좌석 규모 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `telno` | 시설 전화번호 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `relateurl` | 홈페이지/예매처 URL | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `adres` | 시설 주소 | publicAddress (후보: 시설 join 필요) | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `la` | 위도 | latitude (확장 후보) | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `lo` | 경도 | longitude (확장 후보) | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `restaurant` | 레스토랑 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `cafe` | 카페 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `store` | 편의점 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `nolibang` | 놀이방 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `suyu` | 수유실 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `parkbarrier` | 장애인 주차시설 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `restbarrier` | 장애인 화장실 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `runwbarrier` | 경사로 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `elevbarrier` | 엘리베이터 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `parkinglot` | 주차시설 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s` | 공연장 목록 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s.mt13` | 공연장 항목 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s.mt13.prfplcnm` | 공연장명 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s.mt13.mt13id` | 공연장 ID | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s.mt13.seatscale` | 시설/공연장 좌석 규모 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s.mt13.stageorchat` | 오케스트라 피트 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s.mt13.stagepracat` | 연습실 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s.mt13.stagedresat` | 분장실 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s.mt13.stageoutdrat` | 야외공연장 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s.mt13.disabledseatscale` | 장애인 객석 규모 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |
| `mt13s.mt13.stagearea` | 무대 넓이 | — | observed; 시설 XML 실수신; 현재 KOPIS 행사 어댑터에 시설 수집/join/저장 없음 |

### boxoffice

| 원본 경로 | 의미 | 공통 필드 | 관찰/지원 |
|---|---|---|---|
| `cate` | 공연 장르 | ranking.items.genre | observed; 전용 순위 파서 출력 대상; basedate 필수 검증 때문에 현재 실응답은 통과하지 못함 |
| `rnum` | 순위 | ranking.items.rank | observed; 전용 순위 파서 출력 대상; basedate 필수 검증 때문에 현재 실응답은 통과하지 못함 |
| `prfnm` | 공연명 | ranking.items.title | observed; 전용 순위 파서 출력 대상; basedate 필수 검증 때문에 현재 실응답은 통과하지 못함 |
| `prfpd` | 공연 개최 기간 | ranking.items.performancePeriodText | observed; 전용 순위 파서 출력 대상; basedate 필수 검증 때문에 현재 실응답은 통과하지 못함 |
| `prfdtcnt` | 상연 횟수 | — | observed; 전용 순위 파서 수용 후 출력 제외; basedate 필수 검증 때문에 현재 실응답은 통과하지 못함 |
| `area` | 공연 지역 | ranking.items.region | observed; 전용 순위 파서 출력 대상; basedate 필수 검증 때문에 현재 실응답은 통과하지 못함 |
| `prfplcnm` | 공연장명 | ranking.items.placeName | observed; 전용 순위 파서 출력 대상; basedate 필수 검증 때문에 현재 실응답은 통과하지 못함 |
| `seatcnt` | 좌석 수 | — | observed; 전용 순위 파서 수용 후 출력 제외; basedate 필수 검증 때문에 현재 실응답은 통과하지 못함 |
| `poster` | 포스터 URL | — | observed; 전용 순위 파서 수용 후 출력 제외; basedate 필수 검증 때문에 현재 실응답은 통과하지 못함 |
| `mt20id` | 공연 ID | ranking.items.sourceId | observed; 전용 순위 파서 출력 대상; basedate 필수 검증 때문에 현재 실응답은 통과하지 못함 |
| `basedate` | 순위 집계 기준 기간 | ranking.responsePeriod | documented; 현재 전용 파서는 필수 검증; 실제 응답에 없어 실패 |

## 원본 무결성

```json
{
  "pblprfr": {
    "topLevel": 10,
    "uniquePaths": 10,
    "leafFields": 10,
    "sha256": "422d2654c5347a72f49d81c7c269e32a440e6866c4a9e837aaa814a739e3ae5a"
  },
  "pblprfr/{mt20id}": {
    "topLevel": 34,
    "uniquePaths": 38,
    "leafFields": 35,
    "sha256": "4f4b6a9e2240169d9be39b643cf2e237473f5c5d9da40fcfd5bb2f3edb534d88"
  },
  "prfplc/{mt10id}": {
    "topLevel": 22,
    "uniquePaths": 32,
    "leafFields": 30,
    "sha256": "13aae75f86a7340c93a9a5a9a675a4126bbd08856cb1b6eee8d253305313c9ce"
  },
  "boxoffice": {
    "topLevel": 10,
    "uniquePaths": 10,
    "leafFields": 10,
    "sha256": "631d7089407ab35918be896f8a881178c931e242eb06b1179a56386d8db6de4f"
  }
}
```
