# 공급사 API 후속 확인과 당시 공식 자료 조사

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

# 9차 공급사 API 공식 문서 검토

- 작성: 민규 lane C, 2026-09-29. 수정 범위는 이 문서 한 개다.
- 판정: 공통 설정 준비와 실제 공급사 연결 성공은 별도다. 이 검토에서는 사용자 키를 읽거나 API 키를 포함한 요청을 보내지 않았다.
- 설정 검토 대상: `backend/supabase/functions/_shared/config/providers.ts`. 종현의 공급사 어댑터는 읽기만 하며 변경하지 않았다.

## 최신 결과와 검토 범위

총괄의 후속 검증에서 `claude-5-sonnet`을 지정한 합성 입력 1회가 HTTP 200, 비어 있지 않은 `message`, 객체형 `token_usage`를 반환했다. [최신 실호출 결과와 종현 인계](2026-09-29-provider-config-handoff.md)를 따른다. 이는 요청 모델 ID 수락과 응답 형식의 최소 검사이며 내부 실제 모델의 echo 확인·사용량 상세 매핑·제품 AI 연결 완료를 뜻하지 않는다. 아래 공식 자료 조사와 캡처 확인은 이 실호출 이전에 진행한 기록이고, lane C 자체 실키 호출은 계속 `NOT_RUN`이다.

## 공식 근거와 연결 상태

| 공급사 | 확인한 계약 | 남은 확인 / 실제 호출 |
| --- | --- | --- |
| Kakao Local | HTTPS GET `https://dapi.kakao.com/v2/local/search/keyword.json`, `Authorization: KakaoAK <REST_API_KEY>`, 필수 검색어 `query` | 최소 조회 예시 `query=서울역&page=1&size=1`. 이 lane의 실키 호출 `NOT_RUN` |
| KOPIS | 공연 목록 경로 `/openApi/restful/pblprfr`, query `service`, `stdate`, `eddate`, `cpage`, `rows`. XML 반환. 공식 v5.0 문서는 HTTP 운영 주소와 SSL 미사용을 표시 | 문서에서 HTTPS 지원을 확정하지 못했다. 실키를 HTTP로 전송하지 않는다. HTTPS 지원·최종 호스트 확인 후 하루 범위, `cpage=1&rows=1`로 검사. `NOT_RUN` |
| 서울 열린데이터 | `culturalEventInfo`, 경로에 KEY/TYPE/SERVICE/START_INDEX/END_INDEX. 공식 예시는 `http://openapi.seoul.go.kr:8088/{KEY}/json/culturalEventInfo/1/1/` | 문서에서 HTTPS API 주소를 확정하지 못했다. 포털 HTTPS와 API 전송 HTTPS를 혼동하지 않는다. HTTPS 확인 전 실키 호출 `NOT_RUN` |
| TourAPI | 한국관광공사 국문 관광정보 서비스의 공식 포털 및 별도 활용 신청·권한 오류 계약 확인 | 상세 스키마가 동적으로 제공되어 이번 정적 열람으로 정확한 운영 endpoint·키 인코딩 입력 형태를 확정하지 못했다. 현재 키 형식은 `unknown` 유지. `NOT_RUN` |
| 포텐스닷 | 사용자 캡처에서 HTTPS origin·`/api/chat`·Bearer·JSON 계약 확인. 공식 웹앱에서 `claude-5-sonnet` 확인 후 총괄의 합성 입력 1회 최소 호출 PASS | 내부 모델 echo·사용량 상세 매핑·추가 생성 옵션·보관 조건은 미확인. 종현 adapter·제품 AI 연결은 별도. 이 lane 자체 호출 `NOT_RUN` |

근거: [Kakao Local 공식 개발 가이드](https://developers.kakao.com/docs/ko/local/dev-guide#search-by-keyword), [KOPIS 공식 개발 가이드 v5.0](https://kopis.or.kr/upload/openApi/%EA%B3%B5%EC%97%B0%EC%98%88%EC%88%A0%ED%86%B5%ED%95%A9%EC%A0%84%EC%82%B0%EB%A7%9DOpenAPI%EA%B0%9C%EB%B0%9C%EA%B0%80%EC%9D%B4%EB%93%9C.pdf), [서울 문화행사 공식 명세](https://data.seoul.go.kr/dataList/OA-15486/A/1/datasetView.do), [TourAPI 공식 공공데이터포털](https://www.data.go.kr/data/15101578/openapi.do), [한국관광콘텐츠랩](https://api.visitkorea.or.kr/), [포텐스닷](https://potens.ai/).

## Sonnet 5와 포텐스닷을 구분

Anthropic 공식 문서에는 `claude-sonnet-5`가 존재한다. 그러나 이는 포텐스닷이 같은 ID·프로토콜로 제공한다는 증거가 아니다. 사용자 제공 포텐스닷 API 안내 캡처의 모델 예시는 `claude-4-6-sonnet`이지만, 사용자는 추가 답변에서 **Sonnet 5 유지**를 확정했다. Sonnet 4.6으로 대체하지 않는다. OpenAI 호환이나 Anthropic 직결을 가정하지 않는다. [Anthropic Sonnet 5 공식 문서](https://platform.claude.com/docs/ko/models/sonnet-5/whats-new-sonnet-5)

초기 공개 문서 열람에서는 모델 ID를 확인하지 못했으나, 이후 총괄이 [포텐스닷 공식 웹앱 공개 번들](https://potens.ai/_next/static/chunks/2938-c5c734cf96c393f4.js)의 module `72093`에서 `id: claude-5-sonnet`, `label: Claude Sonnet5` 매핑을 확인했다. 같은 목록의 4.6 ID는 캡처와 같은 `claude-4-6-sonnet`이다. 따라서 포텐스닷 API 연결에 사용할 설정 후보는 `claude-5-sonnet`이다. 이것은 공식 웹앱의 모델 목록 근거이며 `/api/chat`에서 해당 모델로 실제 성공했다는 증거는 아니다. 배포 해시가 포함된 번들은 이후 바뀔 수 있으므로 확인 날짜와 module을 함께 남긴다.

별도 [공개 번들](https://potens.ai/_next/static/chunks/4371-f290c74d1589fd16.js)의 `claude-sonnet-5`는 총괄 확인상 `NEXT_PUBLIC_CLAUDE_CODE_PROXY_BASE_URL` 모듈의 코딩 프록시 문맥이다. 일반 `/api/chat`용 ID와 혼용하지 않는다.

당시 총괄은 로컬 origin `https://ai.potens.ai` 및 위 모델 ID를 설정하고 합성 prompt 1회 검사를 준비했다. 이후 최소 호출이 완료됐으며 [최신 인계의 PASS와 한계](2026-09-29-provider-config-handoff.md)가 현재 상태다. 이 lane은 비밀 입력 파일을 열람하거나 실제 API를 호출하지 않았다. 이 lane의 웹 열람 도구로 번들을 재확인하려는 시도는 접근 오류였으므로, 번들 내용은 총괄의 공개 소스 확인 보고를 근거로 기록했다.

## 사용자 제공 포텐스닷 API 자료 반영

아래 사항은 2026-09-29 대화에 제공된 API 안내 캡처에서 확인한 계약이다. 공개 웹에서 독립적으로 찾은 API 명세나 실제 호출 성공 결과는 아니다. 캡처의 키·원본 이미지·키가 포함된 예제는 이 문서에 복사하지 않는다.

| 항목 | 캡처에서 확인한 내용 |
| --- | --- |
| 일반 요청 | POST `https://ai.potens.ai/api/chat` |
| 헤더 | `Authorization: Bearer <서버에서 읽은 키>`, `Content-Type: application/json` |
| 요청 본문 | JSON 필드 `prompt`, `model`. 모델 예시는 `claude-4-6-sonnet` |
| 일반 응답 | JSON 필드 `message`, `token_usage` |
| 스트리밍 요청 | POST `https://ai.potens.ai/api/chat-stream`, 같은 요청 본문 |
| 스트리밍 응답 | SSE `data`의 JSON에 `type=text/reasoning/done`. `text` 이벤트의 `text`, `done` 이벤트의 `token_usage` 예시 |

종현에게 필요한 후속 계약은 다음과 같다.

- `token_usage`의 자료형·입력/출력 토큰 분리·누적/최종 사용량 의미를 확인한다. 현재 `ModelResponse.usage`의 `inputTokens`/`outputTokens`에 임의 분배하거나 0을 채워 성공으로 처리하지 않는다.
- `system`, 구조화 출력, `maxOutputTokens`에 대응하는 공급사 필드와 지원 여부는 캡처에서 확인되지 않았다. 기존 내부 `system`·입력을 `prompt` 하나로 합치는 방식과 출력 스키마 검증은 별도 설계·검증이 필요하다. 존재하지 않는 공급사 필드를 만들어 전송하지 않는다.
- SSE의 분할 청크·종료·오류·취소 계약을 확인한다. `reasoning` 이벤트의 저장·사용자 노출은 이 예시가 허용한 것으로 해석하지 않는다. 대화와 추론 원문을 로그에 남기지 않는다.
- 오류 envelope, 타임아웃, 서버의 출력 제한, 요금·사용량 단위, 공급사 보관·학습 이용 조건은 미확인이다. 현재 예산 예약·보관 검토 장치를 우회하지 않는다.

보관 조건 검토도 별도다. 기존 `ai/providers/provider-adapter.ts`의 `retentionReview: approved`와 예산 예약은 실제 검토·정책 결정 후 연결해야 하며, 설정 파일이 존재한다는 이유로 승인 상태를 만들지 않는다.

## 민규 설정과 종현 어댑터 연결 계약

1. 민규 설정은 입력 원문을 보존하고 기능별로 읽는다. 키를 자동으로 trim·인코딩·디코딩하지 않는다. 현재 TourAPI `unknown | encoded | decoded` 구분과 `unknown` 요청 보류는 적절하다.
2. TourAPI의 아래 직렬화 규칙은 공급사 확인 후 적용할 구현 계약이다. `decoded`는 URL 쿼리 직렬화 단계에서 한 번 인코딩한다. `encoded`는 확인된 인코딩 문자열을 다시 URLSearchParams에 넣어 이중 인코딩하지 않는다. 원문은 별도 보존하고, 임의 문자 패턴으로 형태를 추측하거나 두 형태를 자동 재시도하지 않는다. `unknown`은 요청하지 않는다.
3. 캡처에 따른 `POTENS_API_BASE_URL` 후보는 HTTPS origin `https://ai.potens.ai`이며 path를 포함하지 않는 현재 설정 계약과 맞는다. `/api/chat` 또는 `/api/chat-stream` 및 Bearer 인증은 종현 어댑터의 책임이다. 설정 검증 성공은 키 유효성·모델 지원·실제 연결 성공을 증명하지 않는다. 공개 홈페이지 `https://potens.ai`를 API origin으로 사용하지 않는다.
4. 공급사별 HTTP adapter는 종현이 기존 담당 모듈에 작성한다. 임의 호스트로 비밀을 전송하지 않도록 공식 호스트 확인을 선행하고, 키가 포함된 요청의 자동 외부 redirect는 허용하지 않는 방식으로 연결한다. 키·Authorization·전체 URL·공급사 응답 원문은 서비스 오류·사용량 로그에 남기지 않는다. 서울 키는 URL path에도 들어가므로 query 삭제만으로 마스킹되지 않는다.
5. 확인된 HTTPS 경로에 한해 최소 공개 데이터 한 건을 조회한다. 단순 HTTP 200만으로 성공 판정하지 않는다. 서울은 `RESULT.CODE`, TourAPI는 공급사 오류 envelope도 확인해야 한다. 키 오류·권한 미승인·호출 제한과 정상 빈 결과를 구분한다. 정상 응답에서도 원문 출력 없이 공급사/HTTP 상태/안전한 상태 코드/건수만 검증 증거로 남긴다.

TourAPI 권한·오류 근거는 [공식 포털 오류 설명](https://www.data.go.kr/data/15101578/openapi.do), 서울 응답 코드는 [공식 문화행사 명세](https://data.seoul.go.kr/dataList/OA-15486/A/1/datasetView.do)를 따른다. 원문 보존·한 번 직렬화·로그 제한은 이 프로젝트의 구현 제안이며, 미확인 공급사 키 형식을 공식 사실로 단정하지 않는다.

## 검증과 인수인계

- 완료: 공식 자료 조사, 사용자 제공 포텐스닷 API 캡처의 비밀 제외 계약 반영, 설정 원문 보존 및 미확인 상태 구분 검토, 종현 연결 요청 정리. ownership 및 lane C 허용 목록 검사 `PASS`.
- 확정: 사용자 모델 선택은 Sonnet 5 유지. 캡처의 Sonnet 4.6 예시로 대체하지 않는다.
- 추가 확인: 총괄이 공식 공개 웹앱 모델 목록에서 Sonnet 5 → `claude-5-sonnet` 매핑 확인 후 별도 합성 입력 최소 호출 PASS. 모델 목록과 실호출은 서로 다른 검증 근거다.
- 보류: 포텐스닷 내부 모델 echo 확인·사용량 및 생성 옵션 세부 계약·보관 조건·종현 adapter/제품 AI 연결, KOPIS/서울 API의 HTTPS 근거, TourAPI 상세 명세·현재 발급 키의 형식.
- 이 lane의 실제 키 유효성 검사·LLM 호출·공급사 데이터 수집·배포는 모두 `NOT_RUN`. 총괄이 따로 수행하는 실호출 결과는 별도 인계 문서에서 확인한다.
- 사용자 키 입력 파일, 종현 파일, DB 및 Git 커밋·푸시는 변경하지 않았다.

</details>
