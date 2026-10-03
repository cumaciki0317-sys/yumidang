# 민규 공급사 실호출·종현 연결 인계

2026-09-29. 사용자 요청에 따라 종현 공유를 먼저 완료하고 민규 API 검증을 이어간다.

## 공유 완료

`ff9c14fec069dc03b575cfd33d9deb62625fd924`를 `origin/minkyu/foundation-harness`에 푸시했고 `git ls-remote`로 원격 SHA를 확인했다. 검색 실제 GET 연결, 서버 API 설정, 오프라인 검사, Sonnet5 최소호출 결과, 최신 종현 시작 계획이 포함됐다. 실제 `.env`나 캡처는 포함하지 않았다. 종현은 자신의 작업을 보존하면서 이 브랜치를 반영한 후 `AGENTS.md`와 [공급사 연결 인계](2026-09-29-provider-config-handoff.md)를 따른다.

## 병렬 범위

[10차 하네스](../../minkyu-live-api-harness.json)의 기준은 ff9c14f다. A는 Kakao403 원인, B는 KOPIS/서울 행사, C는 TourAPI를 검증한다. 민규 소유 tools/local·테스트·요청 문서만 수정하며 종현 코드·SQL·외부 계정설정을 건드리지 않는다. 입력은 사용자 지정 루트 `.env`이며 stdout/stderr·프로세스 인수에 키를 넣지 않는다.

## 진행 상태

| 대상 | 실제 결과 | 다음 조치 |
|---|---|---|
| Kakao | 사용자 사용 설정 ON 후 HTTP200, PUBLIC_QUERY_SUCCEEDED PASS | 종현 places 어댑터 연결·서비스 통합 검증 |
| KOPIS | 공식 canonical HTTPS HTTP200, 공연 XML1행·필수필드 확인 PASS | 종현 transport/normalize 연결에 이 endpoint·계약 사용 |
| 서울 문화행사 | NOT_RUN, 공식 HTTPS 주소 미확인 | HTTPS 전송 경로 확인 전 실키 전송하지 않음 |
| TourAPI | HTTPS HTTP200, 정상코드0000, 행사1건 확인 PASS | 현 저장 원문을 한 번 URL직렬화하는 확인된 전송 방식으로 종현 연결 |

사용자가 카카오맵 사용 설정 ON 완료를 알린 뒤 동일 최소 요청을 한 번 재검증해 HTTP200 성공을 확인했다. 도구 출력에는 실제 반환 건수가 없으므로 한 건 반환을 주장하지 않는다. 에이전트가 외부 계정 설정이나 결제 설정을 직접 변경하지 않았다. [Kakao 진단](2026-09-29-kakao-live.md), [공연·서울 진단](2026-09-29-events-live.md), [Tour 진단](2026-09-29-tour-live.md)을 각각 따른다.

## 종현 코드 연결과 별개인 부분

공급사 최소 조회가 성공해도 places/event-sync/ai-chat 함수 배포나 서비스 전체 연결 성공은 아니다. 기존 `EventRepositoryPort`는 실제 DB/RPC를 주입받는 계약으로 남아 있으며 공급사 데이터를 수집했다고 테이블 저장까지 완료한 것으로 표현하지 않는다. 민규 DB 계약이 추가로 필요한 경우 요청 문서로 연결한다.

포텐스닷은 종현의 ModelPort에 맞춰 message의 구조화 파싱, token_usage의 input/output 매핑, 출력한도, 모델 버전 근거, 보관·예산 처리를 확인해야 한다. 민규가 해당 소유 파일을 대신 수정하지 않는다. 종현은 자기 담당에서 독립 구현을 이어가며 실제 공급사 권한 문제는 이 진단 결과와 구분해 처리한다.

## 재현 도구와 완료 검증

```sh
# 네트워크 없는 테스트
python3 -B tests/functions/minkyu/test_kakao_api.py
python3 -B tests/functions/minkyu/test_event_apis.py
python3 -B tests/functions/minkyu/test_tour_api.py
python3 -B tests/functions/minkyu/test_harness.py

# 직접 재검증할 때만 --run 사용. 키는 명령 인수에 넣지 않는다.
python3 -B tools/local/check_kakao_api.py --env-file /본인경로/.env --run
python3 -B tools/local/check_event_apis.py --provider kopis --env-file /본인경로/.env --run
python3 -B tools/local/check_tour_api.py --env-file /본인경로/.env --raw-input --run
```

- Python: Kakao7 + 공연/서울7 + Tour15 = 신규29개 PASS, 기존 하네스6개 PASS, 총35개. HTTP200에 들어 있는 공급사 오류를 성공으로 처리하지 않는 것과 키/원문 미출력·명령 인수 제외·리디렉트 거절·TLS 및 응답 한도 등을 검사했다.
- 실키 요청: Kakao2회(최초403, 사용자 사용 설정 ON 후 동일 요청 재검증200 PASS), KOPIS1회PASS, Tour2회(최초 응답은 00만 허용한 검사기에서 UNKNOWN으로 분류했다. 원문을 저장하지 않아 당시 코드는 재확인하지 못했다. 공식 문서에 따라 0000도 정상으로 처리한 뒤 동일 요청1회 재검증 PASS). 서울은0회다. 키가 없는 HTTPS 지원 여부 probe는 별도로 수행했다.
- TourAPI는 `https://apis.data.go.kr/B551011/KorService2/searchFestival2`의 하루 범위/한 건을 요청했다. 필수 MobileOS/MobileApp/eventStartDate/serviceKey를 공식 명세와 대조했다. 결과코드00·0000을 모두 정상으로 정의한 공식 근거를 확인했고 파서를 보완했다. [Tour 공식 상세 근거](2026-09-29-tour-live.md)
- 성공한 전송 방식은 `urlencode({serviceKey: 저장된 원문, ...})` 한 번이다. 발급 화면의 encoded/decoded 명칭을 추정하거나 로컬 키/형식 설정을 바꾸지 않았다. 종현은 이 확인된 직렬화를 어댑터에 반영하고 이중 인코딩·자동 fallback을 추가하지 않는다.
- KOPIS canonical endpoint는 `https://kopis.or.kr/openApi/restful/pblprfr`다. www의301을 따라가지 않고 canonical 호스트의 TLS/API 응답을 먼저 확인했다. XML 오류·0건과 실제 유효행을 구분하며 비용/상태 등 도메인 정규화는 종현의 별도 검사다.

## 남은 조치

1. Kakao 활성화와 최소요청 재검증은 완료했다. 종현은 기존 places 어댑터 연결과 서비스 통합 검증을 이어간다.
2. 서울은 현재 검증환경에서 공식호스트443 timeout,8088 TLS실패였다. API 지원HTTPS 경로 확인 전 키를 HTTP로 보내지 않는다. 모든 환경에서 HTTPS가 불가능하다는 판정은 아니다.
3. 종현은 이미 공유한 ff9c14f의 설정·인계로 AI 작업을 시작할 수 있다. 이번 Kakao/KOPIS/Tour 검증 결과는 후속 adapter 연결 근거이며 실제 DB 저장·조회·서비스 API 성공이 아니다.
4. 이번 추가 진단 도구/문서는 로컬 미커밋 상태다. 앞의 ff9c14f 푸시와 구분하며 자동 추가 푸시는 하지 않았다.
