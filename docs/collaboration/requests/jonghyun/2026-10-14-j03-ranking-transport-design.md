<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# J03 공식 순위 연결 조건과 transport 보완 설계 — 2026-10-14

전체 **79%(22/28)** 유지. 목표는 어제까지 최근7일·전국 전체 기본/뮤지컬 선택·매일 갱신하는 공급사 공식 Top10의 실제 수집/저장/공개다. 이번 보완으로 목표를 transport 시험으로 축소하거나 J03 전체 완료를 선언하지 않는다.

## 공식 근거와 유지하는 보류

[현재 KOPIS 개발가이드](https://kopis.or.kr/upload/openApi/공연예술통합전산망OpenAPI개발가이드.pdf) §9,16~17쪽을 공개 PDF 다운로드·페이지 PNG 렌더링으로 직접 읽었다. v5.0 배포일2026-04-23, 요청 stdate/eddate·최대31일, 응답 basedate·rnum·공연ID가 명시돼 있다. **stdate/eddate는 문서에 없는 인자가 아니다.** 같은 요청 표는 date도 필수로 표시하지만 URL 예제는 date를 생략한다. 이 차이를 임의 해소하지 않는다.

응답의7일 샘플은 임의 최근7일 요청의 실제 적용 증거가 아니다. 갱신시각·동률·연속 순위·0건/오류 계약은 해당 표만으로 미확인이다. 실제 공급사와 데이터 API/sample은 호출하지 않았다. [이전 실제 기록](2026-10-05-real-environment-validation.md)은50개 순위를 수신했지만 basedate가 없었고, 사용자 결정으로 공개를 보류했다. 이전 결과를 이번 실제 관찰로 표현하지 않는다. 문서의 HTTP 표기를 HTTPS 지원 증거로 대신하지 않으며 키 전송·TLS 완화·공급사 문의 발송을 하지 않는다.

공개 원 PDF `/private/tmp/yumidang-kopis-guide-20261014.pdf`:859,798바이트, SHA256 `5ad22cecaa64567b6149bbff7339a546b34ef26f528ebbf464c87db7bf2a9385`. 해당 두 페이지의 렌더링만 확인했으며 원문 전체를 저장소에 복제하지 않는다.

실제 DB 소스도 공개 보류를 유지한다. SQL119개 중 행사 lane migration은 ranking claim에서 null을 반환하고 complete RPC는 `KOPIS_RANKING_PROVIDER_VERIFICATION_PENDING`으로 거절한다. 공개 GET도 not_enabled다. 공식 기간·정렬·0건 증거 없이 held 해제·migration 추가·새 snapshot 저장을 하지 않는다. 민규 담당 event-sync 진입점/조립과12개 예외·성호 화면·현재 원복된 도구는 편집하지 않는다.

## 현재 코드에서 직접 재현한 독립 결함

실제 `createKopisRankingProvider`에 네트워크 없는 합성 FetchLike/Response만 주입했다. 재현 source SHA256 `8dbc30d853a22c62a722b0e49da67b4b9c914ee4637e1e0a1754fd9377fb896d`, 증거 `/private/tmp/yumidang-kopis-ranking-boundary-reproduction-20261014.json`, 증거 SHA256 `748c053a82538f3823a92d1aced19eb89b40662b6e4ebf40c273d1acca9d9f4b`. 실제 API·자격증명 읽기·DB·Auth·VM은0이다.

| 관찰 | 현재 결과 | 수정 이유 |
|---|---|---|
| HTTP401/403/404/302 | 모두 SOURCE_UNAVAILABLE·retryable=true | 인증/요청 거절까지 일시 장애로 잘못 분류 |
| `application/xml-malicious` | 합성 XML을 verified로 반환 | MIME 접두사만 맞아도 XML로 해석 |
| 한국어 합성 본문800,216자·2,400,234 UTF-8바이트 | 큰 제목800,000자를 verified로 반환 | text.length 검사만 있어 바이트 한도가 아님 |
| timeout5ms·중단을 무시하는 합성 fetch | signal은 aborted지만35ms 관찰 창에서 collect 미완료 | 취소 신호만 전달하고 호출의 대기 마감은 강제하지 않음 |

마지막 사례는35ms의 관찰 결과이며 영구 미완료나 실제 공급사 지연을 관측했다는 뜻이 아니다. 이 보완은 공식 집계 기간 검증과 독립적인 요청·실패·자원 처리 결함이다.

읽기 리뷰에서 기존 사전 `signal.throwIfAborted()`가 try 밖에 있어 호출자의 abort reason을 그대로 전달하는 경로도 확인했다. 이를 typed CANCELLED로 정규화하고 임의 reason을 오류 message/cause에 포함하지 않는다. 이 추가 관찰은 소스 경로 확인이며 위 JSON 재현에 없는 실행 결과를 붙이지 않는다.

## 후속 구현 설계

기존 `kopis-ranking.ts` 안에서 후속 구현한다. event_design은 이 파일과 신규 `tests/functions/jonghyun/event-provider-kopis-ranking.test.mjs`만 단독 수정한다. Root는 문서·검토·최종 검사를 담당한다. 모두 actor=jonghyun이고 편집 전 소유권을 확인한다. 새 수집 활성화·공통 설정·SQL·푸시·커밋은 하지 않는다.

1. HTTP200만 정상 본문으로 처리한다.401/403은 SOURCE_AUTH_REJECTED,429는 SOURCE_RATE_LIMITED,5xx는 SOURCE_UNAVAILABLE, 그 외는 SOURCE_REJECTED다. 기존 KOPIS 목록 transport의 같은 분류를 따른다. 오류 본문/키/URL을 예외에 넣지 않는다.
2. MIME은 application/xml 또는 text/xml과 선택 파라미터만 허용한다. GET·고정 HTTPS 목적지·redirect:error를 유지하고 Accept·credentials:omit·cache:no-store를 명시한다.
3. 본문은 reader로 읽으며 최대2,000,000바이트를 누적 검사한다. UTF-8은 chunk 경계에 걸친 문자를 유지해 해석하고 잘못된 UTF-8/본문 형식은 형식 오류다. getReader/read의 일반 I/O 실패는 기존 SOURCE_UNAVAILABLE을 유지하며 디코딩/형식 오류와 구분한다. `.text()`로 전체 본문을 먼저 소비하지 않는다. 본문 길이 헤더의 확인이 실제 stream 바이트 검사 대신 쓰이지 않는다.
4. timeout과 호출자 취소를 별도의 거절 promise와 경합해 fetch와 body 대기 모두에 마감을 적용한다. timeout은 SOURCE_TIMEOUT, 호출자 취소는 CANCELLED다. 종료 뒤 타이머/리스너/reader를 정리하고 늦은 성공을 반환하지 않는다. 취소를 무시한 사용자 지정 transport의 실제 외부 실행 중단을 보장한다고 주장하지 않는다. 자동 재전송은0이다. 같은 파일의 collectKopisRanking helper도 연결된 store가 있을 때 provider 진입 전·수집 결과 후/store 진입 전 취소만 typed CANCELLED로 검사한다. 사전 취소는 provider0, 수집 중 취소는 store0이다. store.save 진입 이후 효과/결과는 취소나 미전송으로 새로 해석하지 않고 재저장하지 않는다.
5. 실제 basedate 일치·문서 계약 확인 전0건 거절·순위 원형/현재 연속번호 guard·뮤지컬 대응·공개/저장 보류는 유지한다. date/ststype 인자나 자체순위·임의 기간 증거를 추가하지 않는다.

책임 시험은 합성 streaming body의 다중 바이트 분할·한도 초과/잘못된 UTF-8·본문 대기/비협조 fetch timeout·호출자 취소·늦은 응답·상태/MIME 분류·키 원문 비노출을 검사한다. 정상 XML은 기존 기간/rank 정규화와 같은 결과여야 한다. 기존 event-policy 시험을 함께 실행한다. 모형 시험을 공급사/DB 연결 증거로 계산하지 않는다.

## 다음 실제 연결 조건

공식 응답/기간의 실제 일치 또는 공급사가 공식 확인한 동등 증거, 정렬·동률·0건 계약, 갱신 조건을 먼저 확보해야 한다. 이후 검증된 snapshot 저장 구조·ranking claim/complete 원자 연결·공개 DTO를 구현하고 격리 검증한다. 기존 requested_only 저장본은 verified로 승격하지 않는다. 이미 확정한 순위 보류를 같은 질문으로 다시 묻지 않는다.

J07 평가 기준 두 선택은 답변을 기다린다. 전체28항목의 실회원 HOLD·공급사 조건·운영 적용·민규 지원 경계를 분모에서 제거하지 않는다.

## 이번 보완 결과

종현 clone의 기준 HEAD는 `86cec202a763bcf3864f792c19e275bd8a29196a`, 변경은 미커밋 작업본이다. event_design은 지정 소스/신규 시험만 수정했고 Root는 문서·재현·최종 검사를 수행했다. ai_design의 읽기 리뷰가 새 consume catch의 I/O 분류 회귀를 찾았다. 일반 읽기 실패를 기존 SOURCE_UNAVAILABLE로 유지하고 fatal decoder/flush·잘못된 chunk·바이트 초과·달력/XML 검증을 SOURCE_INVALID_RESPONSE로 분리해 해결했다. 앞선24개 통과는 이 회귀의 검증 증거로 쓰지 않는다.

- 최종 **25/25 PASS**: 신규14개 + 기존 event-policy11개. Root가 최종 작업본에서 직접 재확인했다. reader 시작/중간 I/O 오류와 형식 오류의 구분, chunk 경계 UTF-8, 한도 초과, 늦은 응답/중단, typed 취소 원문 비노출, provider/store 전송 횟수, 기존 basedate/0건 보류를 포함한다.
- `DENO_DIR=/private/tmp/yumidang-j03-deno-check-cache-20261014 deno check --no-config --no-remote --no-npm --no-lock backend/supabase/functions/_shared/integrations/events/kopis-ranking.ts` 타입 검사 PASS. 원격/패키지 다운로드·설정/lock 변경 없이 지정 소스의 의존 범위를 검사했다.
- 소유권3경로·diff 공백·언어 혼입 검사 통과. peer는 지적한 I/O 회귀의 해결과 취소/마감 우선 분류를 마지막 읽기로 확인했고 추가 수정 근거는 없었다. 이것은 실제 공급사 독립 검증이 아니다.
- 공개 문서 조회 외 실제 공급사 API/sample·키 읽기·DB·Auth·VM·커밋·푸시는0이다. 공통 SQL·민규 조립·기존 도구·성호 화면은 변경하지 않았다.

| 변경 소스 | 작업본 SHA256 |
|---|---|
| `backend/supabase/functions/_shared/integrations/events/kopis-ranking.ts` | `34ec2160e0d6d1924713931510924c681a6b251c1367c5f7d14eb00888724a69` |
| `tests/functions/jonghyun/event-provider-kopis-ranking.test.mjs` | `ac38f709ee2df284593587219259d5209d9ce4184e7d82f5f697bef28ed51e7b` |

전체 **79%(22/28)** 유지. transport 보완 완료와 실제 공식 기간·정렬·0건·갱신·snapshot 저장/공개 완료를 구분한다. 미확인 공급사 계약과 사용자 확정 보류는 계속 남아 있다.
