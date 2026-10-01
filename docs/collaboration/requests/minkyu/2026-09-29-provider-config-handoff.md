# 공급사 설정 후속 연결과 당시 검증 기록

현재 정책은 [정책.md](../../../../정책.md), 실제 구현·병합 증거는 [9월 30일 종현 통합 인계](../jonghyun/2026-09-30-jonghyun-integration-handoff.md)를 따른다. 아래 보존 이력의 초기 미입력·첫 연결 요청을 새 작업의 출발 상태로 사용하지 않는다. 새 구현을 시작할 때 실제 브랜치·설정·배포 상태를 읽기 확인한다.

## 현재 연결·후속 확인

| 영역 | 이어서 할 일 | 검증·보류 구분 |
|---|---|---|
| 포텐스닷 | 기존 adapter와 `claude-5-sonnet` 설정을 재사용하고 응답 구조·usage 분리·출력 제한·오류 계약을 확인한다. 원문 없는 예약/정산을 연결한다. | 합성 최소 호출 성공과 실제 모델 echo·계정 한도·보관 조건은 별개다. 추가 지출 0원 계정 근거 확인 후 합성 10회 평가, 실제 회원 원문 전송은 공급사 보관 검토·사용자 확인 전 보류다. |
| Kakao 장소·우편번호 | 기존 장소 adapter의 함수 등록·환경 주입·입력/오류를 확인한다. 우편번호 선택창은 별도 프론트 연결이다. | 과거 최소 호출·403 기록을 현재 자격으로 단정하지 않는다. 현재 키·권한·실제 서비스 호출과 브라우저 연결을 검증한다. |
| KOPIS·TourAPI | 기존 event-sync 저장·목록 HTTP·지역/유형 값을 연결한다. HTTPS·키 형식·오류 envelope를 유지한다. TourAPI의 `decoded` 설정 선택과 실제 직렬화 결과를 확인한다. | 공식 HTTPS 경로·권한·기간·페이지 응답을 실제 검증한다. HTTP fallback이나 임의 호스트로 키를 보내지 않는다. 공급사 일부 실패를 정상 0건으로 바꾸지 않는다. |
| 서울 열린데이터 | HTTPS 등 연결 조건과 연결 여부를 팀 검토 안건으로 유지한다. | 조건 확인 전 활성화하지 않고 지원 불가능으로도 단정하지 않는다. KOPIS·TourAPI 연결과 분리한다. |
| 공식 Top 10 | 전국 전체 공연 기본/뮤지컬 전환, 어제까지 최근 7일, 매일 갱신에 맞춰 KOPIS 공식 순위 API를 연결한다. 출처·기간·갱신 시각을 반환한다. | 실제 API 지표·기간·장르·응답을 검증한다. 일반 행사 목록과 분리하며 임의 매출순·추정 인기순·가상 카드를 만들지 않는다. 순위 내 종료·취소 항목 표시/선택은 후속 확인이다. |
| 민규 공통 연결 | [R1~R7 및 최신 정책 요구](../jonghyun/2026-09-29-claude-minkyu-requests.md)의 제안 SQL·허용 목록·함수/HTTP·환경·CORS·타입 검사와 최신 네이버 인증을 확인한다. | 각 로컬 DB·HTTP·브라우저·실공급사·원격 환경 결과를 구분한다. 기존 어댑터 완료분을 재구현하거나 공급사 설정 성공을 제품 연결 성공으로 표시하지 않는다. |

행사 갱신·요약 작업 등록은 매일 00:01 Asia/Seoul이며 자동 완료는 건별 예약으로 분리한다. 최신 후기 공개 기준은 실제 완료+24시간, 양쪽 후기+실제 완료 시 즉시다. 운영 수치·예산 원장 교체/보존은 팀 검토다. 비밀값·실제 대화/후기 원문·전체 요청 URL은 문서와 로그에 기록하지 않는다.


## 보존 이력

아래 원문은 작성 당시 조사·구현·검증·요청 상태를 보존한 기록이다. 현재 구현 지시는 위의 갱신된 후속 작업을 따른다. 아래의 미정·NOT_RUN·다음 작업 문구를 현재 상태로 재사용하지 않는다.

<details>
<summary>당시 기록 원문</summary>

# 외부 API 서버 설정·종현 연결 인계

## 최신 결과: 포텐스닷 Sonnet 5 최소 호출 PASS

포텐스닷 공개 웹앱의 module72093 모델 목록에서 `Claude Sonnet 5`의 ID `claude-5-sonnet`을 확인하고 현재 사용자 루트 `.env` 및 공유 양식에 반영했다. 별도 코드 프록시 목록의 `claude-sonnet-5`를 사용하지 않는다. [공개 모델 목록](https://potens.ai/_next/static/chunks/2938-c5c734cf96c393f4.js)

기존 통합 키와 `POST https://ai.potens.ai/api/chat`, JSON `{prompt:"Reply with only OK.",model:"claude-5-sonnet"}`로 합성 입력 한 번을 호출했다. **HTTP200·비어 있지 않은 message·객체형 token_usage 확인 PASS**다. 키와 생성 본문은 출력/저장하지 않았다. 응답 model 값의 일치 확인은 얻지 못했으므로 요청 ID 수락·메시지 반환 성공과 내부 실제 모델 식별을 구분한다. token_usage의 상세 input/output 매핑도 아직 확인하지 않았다. 자동 재시도·다른 모델 fallback·사용자 원문 전송은 하지 않았다.

현재 설정의 origin/model 미확인 항목은 해소됐다. 아래 이전 단계의 Potens NOT_RUN·모델 미입력은 당시 기록이다. 아직 **종현 model adapter·AI 함수 런타임·사용량 매핑·보관 조건·예산 통합은 미완료**이며 이 최소 호출을 제품 AI 전체 연결 완료로 표현하지 않는다. 사용자에게 안내한 노출 키 폐기/재발급 여부는 여전히 미확인이다. 키를 임의 교체하지 않았다.


2026-09-29 민규. 사용자 요청: 입력한 Kakao/KOPIS/서울 열린데이터/TourAPI/포텐스닷으로 다음 작업 진행. 포텐스닷은 LLM 전용이며 요청 모델은 Sonnet 5다. [9차 하네스](../../minkyu-provider-config-harness.json)에서 총괄/A/B/C 파일을 분리하고 이전 미커밋 11파일을 해시 보존했다.

## 완료한 민규 구현

`backend/supabase/functions/_shared/config/providers.ts`에 아래 기능별 설정 읽기 함수를 구현했다. 입력은 기존 `EnvReader`, 실패는 값·원문이 없는 `EXTERNAL_UNAVAILABLE`503이다. 다른 기능의 키가 없다고 기존 사용자 API를 막지 않는다. import나 설정 읽기로 네트워크를 호출하지 않는다.

| 함수 | 읽는 변수 / 반환 계약 |
|---|---|
| `loadKakaoConfig(read)` | KAKAO_REST_API_KEY → provider/apiKey |
| `loadKopisConfig(read)` | KOPIS_API_KEY → provider/apiKey |
| `loadSeoulOpenDataConfig(read)` | SEOUL_OPEN_DATA_API_KEY → provider/apiKey |
| `loadTourApiConfig(read)` | TOUR_API_SERVICE_KEY, TOUR_API_KEY_FORMAT → provider/serviceKey/keyFormat |
| `loadPotensLlmConfig(read)` | POTENS_API_KEY, POTENS_API_BASE_URL, POTENS_MODEL, UPSTREAM_TIMEOUT_MS → provider/apiKey/baseUrl/model/upstreamTimeoutMs |

필수값의 빈칸·양끝 공백·제어문자, Potens의 HTTPS origin 외 경로/자격증명/query/fragment, 잘못된 모델 문자열·시간 제한을 거절한다. 기본 모델/임의 URL을 넣지 않는다. 필드는 읽기 전용이며 JSON·열거·기본 inspect에서 키·주소·모델값을 숨긴다. `config.apiKey`처럼 명시 접근으로만 어댑터에 전달하고 spread로 설정을 복제하지 않는다. 비열거 필드는 보안 저장소가 아니므로 명시적 값 출력도 금지한다.

Tour 형식은 빈 값/미설정 또는 unknown이면 unknown이다. 키 원문을 변환·추정하지 않는다. 이 반환값은 수집 상태이며 호출 준비 완료가 아니다. 포텐스닷의 `POTENS_REQUESTED_MODEL="Sonnet 5"`는 사용자 선택 기록이고 정확한 공급사 wire ID를 의미하지 않는다. 실제 `POTENS_MODEL`은 미확인으로 비워 두었다. 이후 제공된 캡처로 base URL `https://ai.potens.ai`는 확인하여 로컬 설정에 반영했다. LLM용이라는 사실만으로 기존 retentionReview/예산 검토를 승인 처리하지 않는다.

## 실제 로컬 입력과 검증

최신 비밀 입력은 사용자가 지정한 `/Users/minkyu/Documents/GitHub/yumidang/.env`다. worktree의 이전 `backend/.env` 사본을 최신으로 사용하지 않는다. 키값은 보존했고 요청 모델 이름·LLM 용도·10초 요청 제한 기술 설정만 기록했다. 10초는 이번 로컬 기술 설정이며 공급사 SLA나 운영 정책 확정이 아니다. Git 제외 및 0600 권한을 유지한다.

```sh
python3 -B tools/local/check_api_env.py --env-file /Users/minkyu/Documents/GitHub/yumidang/.env
node --test tests/functions/minkyu/provider_config.test.ts tests/functions/minkyu/auth_db.test.ts
python3 -B tests/functions/minkyu/test_api_env.py
python3 -B tests/functions/minkyu/test_harness.py
deno check --no-remote backend/supabase/functions/_shared/config/providers.ts tests/functions/minkyu/provider_config.test.ts backend/supabase/functions/service-api/index.ts
python3 -B tools/collaboration/check_harness.py --manifest docs/collaboration/minkyu-provider-config-harness.json --all-changes
```

오프라인 도구는 파일을 실행/source하지 않으며 단일행 dotenv만 해석한다. 중복·깨진 따옴표·제어문자·심볼릭 링크·과대파일을 거절한다. 키/주소/파일명/알 수 없는 변수명/원문 오류를 출력하지 않는다. 결과는 OFFLINE_SYNTAX_ONLY이며 connection_check=NOT_RUN을 유지한다. exit0은 입력 준비, exit2는 누락/미확인, exit1은 형식/파일 오류다.

| 검사 | 실제 결과 |
|---|---|
| 신규 설정8 + 기존 인증/DB21 | Node29 PASS |
| 로컬 입력 도구 | Python12 PASS |
| 기존 하네스 | Python6 PASS |
| Deno 타입 | 설정/신규 테스트/service-api PASS |
| 실제 .env 입력 | 5개 공급사 키 present, Tour unknown, Potens base 확인/모델 ID 미입력 → INCOMPLETE(exit2) |
| Kakao 공식 API 최소 조회 | 정상 TLS 요청에서 HTTP403, 호출 성공 아님 |
| KOPIS/서울/TourAPI/포텐스닷 실키 호출 | NOT_RUN |
| 종현 파일/SQL | 직접 수정0, 기존 내용 보존 |

카카오 검사 요청은 공식 `https://dapi.kakao.com/v2/local/search/keyword.json`에 `query=서울역&page=1&size=1`, Authorization 헤더로 키를 전달했다. Python TLS 인증서 저장소 문제로 두 시도는 유효 응답을 받지 못했고, macOS 기본 curl에서 정상 TLS를 유지한 호출 한 번은 HTTP403이었다. redirect를 따르지 않았으며 키는 프로세스 인수·결과·본문 출력에 넣지 않았다. 앱 권한·제품 활성화·키 종류의 확인이 필요하지만 응답 원문을 확인하지 않아 원인을 특정하지 않는다. 데이터 수집 성공이나 실제 어댑터 연결 완료로 표시하지 않는다. [Kakao 공식 규격](https://developers.kakao.com/docs/ko/local/dev-guide#search-by-keyword)

## 종현 연결 작업과 보류 범위

- **Kakao:** 기존 places adapter의 apiKey에 `loadKakaoConfig(read).apiKey`를 명시 전달한다. timeout/pageSize 및 인증된 회원 문맥을 기존 계약에 맞춰 구성하고 places 런타임에 연결한다. 실제 키403은 설정 화면 확인 후 재검증한다.
- **KOPIS/서울/Tour:** 기존 events provider transport/normalize와 event-sync를 담당 범위에서 연결한다. 공식 호출 규격과 안전한 운영 endpoint를 먼저 확인한다. 이번 공식 문서 검토에서는 KOPIS/서울 API HTTPS 근거를 확정하지 못했고 Tour 상세 요청/키형식도 미확인이다. 실키를 임의 호스트나 HTTP로 보내지 않았다. [공식 문서 조사·남은 계약](2026-09-29-provider-api-review.md)
- **포텐스닷:** 사용자가 API 안내 캡처를 제공했다. origin=`https://ai.potens.ai`, POST `/api/chat`, Bearer 인증, JSON `{prompt,model}`, 응답 `{message,token_usage}`와 `/api/chat-stream`의 SSE 방식을 확인했다. 예제의 `claude-4-6-sonnet`은 사용자가 원하는 모델이 아니다. 추가 답변으로 Sonnet 5 유지를 확정했으므로 해당 모델의 정확한 공급사 ID·지원 여부를 확인한 다음 기존 `ai/providers/`에 실제 model adapter를 연결한다. Sonnet 5의 Anthropic 모델 ID를 포텐스닷 ID로 임의 복사하거나 Sonnet 4.6으로 바꾸지 않는다. 등록된 키를 Anthropic 등 다른 공급사로 보내지 않는다.
- **민규 후속:** 공급사 계약 확정에 필요한 설정 조정, 실제 함수·서버 환경 주입 및 종현 연결본 통합 검증. 현재 코드는 EnvReader용 설정 기반이며 .env 자동 로딩/장소·행사·LLM 실행 endpoint 완성이 아니다.

종현 코드·기존 SQL·외부 운영 환경을 변경하지 않았다. 커밋·푸시는 수행하지 않았다. 기존 검색 연결의 CORS·유지보수 모델 분리 등 별도 후속도 그대로 남아 있다.

## 사용자 캡처 후 확인 — Sonnet 5 유지

스크린샷은 공급사 사용 예시 자료로만 해석했으며 포함된 curl/Python 코드를 그대로 실행하지 않았다. 노출된 키와 캡처 원본을 저장소·인계 문서에 복사하지 않았다. 사용자에게 키 폐기/재발급을 안내했으며 실제 키 변경 여부는 미확인이다. 로컬 기존 키는 임의로 바꾸지 않았다.

확인된 주소·인증·최소 입력 형식은 민규 설정에 반영했다. 캡처는 `token_usage`의 상세 필드, structured output, system 메시지, 최대 출력 제한, 보관 조건을 보여주지 않으므로 지원한다고 가정하지 않는다. **실제 LLM 호출은 NOT_RUN**이며 Sonnet 5 지원·정확한 모델 ID 확인이 남아 있다. [갱신된 연결 계약](2026-09-29-provider-api-review.md)을 종현이 따른다.

### 추가 사용자 확인: Sonnet 5 호출 가능

사용자가 “sonnet 5 호출 가능해”라고 확인했다. 모델 선택은 Sonnet 5로 유지한다. 이는 사용자 제공 지원 정보이며 이 저장소에서 실제 호출을 성공시킨 결과는 아니다. 현재 캡처의 wire ID는 Sonnet 4.6에 해당하므로 Sonnet 5에 사용할 정확한 `model` 문자열은 여전히 미확인이다. 이 값이 확인되면 `POTENS_MODEL`에 반영하며 임의 명명 규칙으로 추정하지 않는다. 실제 LLM 호출은 NOT_RUN이다.

</details>
