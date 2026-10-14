# J02 서울 행사 공식 계약 확인과 오류 경계 설계 — 2026-10-14

전체 **79%(22/28)** 유지. 이번 조사는 J02의 최신 응답·안전한 자동 수집이라는 전체 목표 중 공식 근거 확인이다. 실제 공급사 호출 금지 범위를 유지하며 공개 설명 문서만 조회했다. 문서 조회 성공을 API 연결 성공으로 계산하지 않는다.

## 직접 확인한 공식 근거

- [OA-23041 데이터 페이지](https://data.seoul.go.kr/dataList/OA-23041/S/1/datasetView.do): 현재 문화행사 데이터의 설명과 갱신 주기를 확인했다.
- [OA-23041 API 명세](https://data.seoul.go.kr/dataList/openApiView.do?infId=OA-23041&srvType=A): 공식 페이지의 Open API 탭이 불러오는 공개 설명 HTML이다. 웹 검색 도구는 이 fragment를 열지 못했고, Root는 페이지 JavaScript에 명시된 문서 조회 방식으로 직접 읽었다. 실제 sample 버튼·API 주소는 호출하지 않았다.
- [공식 이용 안내](https://data.seoul.go.kr/together/guide/useGuide.do): 한 번의 요청 한도와 필수 경로 인자 순서 안내를 대조했다.

| 항목 | 문서로 확인 | 문서만으로 미확인 |
|---|---|---|
| 서비스 | `aiViewCulture`, 시작/끝 행 인덱스, 선택 분류·제목·DATE | 실제 JSON envelope·자료형·DATE의 검색 의미 |
| 정상/오류 | 정상 `INFO-000`, 없음 `INFO-200`, 키 거절 `INFO-100`, 서버/DB 연결 오류 `ERROR-500/600` | HTTP 상태와 오류 envelope의 실제 조합 |
| 필드 | 제목·시작/종료일·요금·무료 여부·문화포털 상세 URL·행사시간 등25개 명칭 | 실제 날짜/무료 값 형식·cultcode의 안정성 |
| 페이지 | sample 최대5개, 일반 요청 최대1000개 | 갱신 중 순서/중복/누락·종료 인덱스의 실제 경계 |
| 갱신/수집 | 매일1회 안내, DATE 단일 선택 인자 | 진행 중 포함 조회·ID 재조회·취소/수정 추적 |
| 연결 | 설명 페이지는 HTTPS | 명세의 데이터 예시는 HTTP8088; API HTTPS 경로는 미확인 |

문서 HTTPS를 데이터 transport HTTPS의 근거로 사용하지 않는다. HTTP fallback·TLS 완화·키 URL 공개를 하지 않는다. 공통 HTML의 종료 팝업은 숨김 템플릿일 수 있으므로 그 텍스트만으로 서비스 종료를 단정하지 않는다.

공개 문서 원 bytes는 비공개 임시 증거로 보존했다. 데이터 페이지90,744바이트 SHA256 `e3c2cd08838a8568908760e78a7befe7b7f0be9895c4b7432a0d4cdddebe6616`, API 설명21,430바이트 SHA256 `b1803d3a5cef06beaf64f6f1c3327d668f1820a5764ddd5403527e2d828c0133`. 경로는 각각 `/private/tmp/yumidang-seoul-oa23041-doc-20261014.html`, `/private/tmp/yumidang-seoul-oa23041-api-doc-20261014.html`이다. 포털 원문 전체를 저장소에 복제하지 않는다.

## 이번 후속 구현 설계

실제 envelope·HTTPS·원천 ID·진행 중 재조회가 미확인인 새 수집을 임의 활성화하지 않는다. 독립적으로 근거가 확정된 **기존 응답 분류의 오류 처리**를 기존 `seoul.ts`에서 보완한다. 이 작업으로 J02 전체 완료를 선언하지 않는다.

1. 요청 rows는1~1000의 안전한 정수여야 한다. 잘못된 설정은 결과 코드와 무관하게 거절한다.
2. 기존 `culturalEventInfo` 또는 평면 RESULT 구조만 해석한다. 잘못된/중복된 wrapper와 새 미확인 aiViewCulture envelope는 거절을 유지한다.
3. `INFO-100`은 `SOURCE_AUTH_REJECTED`, `ERROR-500/600`은 `SOURCE_UNAVAILABLE`, 그 외 오류는 `SOURCE_REJECTED`로 분류한다. 공급사 MESSAGE·본문·주소·키는 오류에 포함하지 않는다. SOURCE_UNAVAILABLE은 기존 행사 worker의 재시도 가능 오류 분류를 사용하며, 같은 HTTP 처리에서 새 fetch 반복을 추가하지 않는다. 재시도 총횟수를 이번 검사로 확정하지 않는다. AI의 미전송 확인 때만 자동1회라는 결정과 별개다.
4. `INFO-200`에 총건수나 row가 있으면 각각0·빈 배열이어야 한다. 없을 때는 문서의 없음 의미를 유지한다. 실제 행/양수 총건수/잘못된 형식을0건 성공으로 숨기지 않는다.
5. `INFO-000`의 총건수·행수·행 객체 형식을 검사한다. 총건수가 반환 행수보다 작거나 null/스칼라 행이면 typed 형식 오류다. 날짜/무료 표현 등의 미확인 선택은 이번에 새로 확정하지 않는다.

담당 event_design은 actor=jonghyun으로 소유권 검사 뒤 `seoul.ts`와 `tests/functions/jonghyun/event-provider-seoul.test.mjs`만 단독 수정한다. Root는 이 문서를 작성하고 source와 결과를 검토한다. 민규 `event-sync/index.ts`·`operations.ts`, 공통 환경, 기존 검증 도구, 성호 화면은 수정하지 않는다. 실제 공급사·키·DB·Auth·VM·커밋·푸시는0이다.

검증은 오류의 공개 코드/재시도 가능 여부·공급사 본문 비노출, 없음과 실제 행이 섞인 모순, 잘못된 rows/총건수/행 구조, 새 wrapper 비활성 유지, 기존 정상 분류를 대상으로 한다. 외부 호출 없는 합성 응답 시험이며 최신 실제 공급사 연결 증거가 아니다. 바뀐 classifier를 소비하는 기존 행사 정책 시험도 실행한다.

## 다음 실제 연결 조건

공식 HTTPS 데이터 경로, 키 없이 공개 가능한 실제 응답 구조/값 증거, 안정 ID와 진행 중 재조회 의미, 페이지 정렬/갱신 중 누락 처리 근거가 필요하다. 공식 근거가 충족되면 최신 서비스 정규화·페이지 transport·ongoing 포트·수집 저장/재개를 연결한다. 실제 공급사 실행은 기존 실행 승인 범위를 따로 충족해야 하며 이번 문서 조회를 실행 승인으로 확대하지 않는다.

J07의 평가 기준 두 선택은 답변 대기 상태를 유지한다. J08 준비 변경과 옛 실제 검증 PASS는 해당 문서의 버전/범위대로 보존한다.

## 후속 구현·검증 결과

기준 HEAD `86cec202a763bcf3864f792c19e275bd8a29196a`의 종현 작업본에서 위 오류 분류를 구현했다. 작업본은 미커밋이며 actor=jonghyun·hook=.githooks를 읽기 확인했다. event_design은 지정 소스/시험 두 파일을 수정하고 Root는 문서를 작성·소스 확인·최종 시험을 실행했다. ai_design은 정책/오류 분기의 읽기 리뷰만 수행했다. 민규 도구·수집 진입점·성호 화면은 변경하지 않았다.

`node --experimental-strip-types --test tests/functions/jonghyun/event-provider-seoul.test.mjs tests/functions/jonghyun/event-policy.test.mjs`의 최종 결과는 **18/18 PASS**(신규7·기존11)다. Root의 첫 중간 시험에서는17/18이었으며, 신규 시험 helper가 명시 undefined를 기본100으로 치환한 원인을 고쳐 실제 undefined를 classifier에 전달하도록 정정한 뒤 해당 범위만 재검사했다. 제품이 undefined rows를 허용했다는 결과로 해석하지 않는다.

소유권3경로·diff 공백·언어 혼입 검사 통과. 문서 공개 조회 외 실제 데이터 API·키·DB·Auth·VM 실행은0, 커밋·푸시0이다. 실제 공급사 응답·저장·자연 갱신·운영 성공을 이번 합성 시험으로 대체하지 않는다.

| 변경 소스 | 작업본 SHA256 |
|---|---|
| `backend/supabase/functions/_shared/integrations/events/seoul.ts` | `917788edc7428fde45b32f1a58083f43006b4ea2df93cafa32805a0848195668` |
| `tests/functions/jonghyun/event-provider-seoul.test.mjs` | `b7a9168c5fff6f3bad567cd708fa59e0662f3e653ffa4dbf945847e9345e99b8` |

전체 **79%(22/28)** 유지. J02 최신 수집 활성화는 위 네 실제 연결 조건을 충족할 때까지 남아 있으며, 이번 오류 보완을 J02 전체 완료로 계산하지 않는다.
