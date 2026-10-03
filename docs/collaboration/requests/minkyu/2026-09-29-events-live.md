# KOPIS·서울 문화행사 최소 실호출 검증

- 작성: 민규, 2026-09-29, 10차 하네스 lane B.
- 결과: **KOPIS 최소 HTTPS 조회 PASS**, **서울 실키 조회 NOT_RUN**.
- 수정: `tools/local/check_event_apis.py`, `tests/functions/minkyu/test_event_apis.py`, 이 문서. 종현 어댑터·SQL·키 입력 파일은 변경하지 않았다.

## 실제 확인 결과

| 항목 | 실제 결과 | 의미·한계 |
| --- | --- | --- |
| KOPIS 키 없는 HTTPS 확인 | `kopis.or.kr` API 경로 HTTP 200, curl TLS 검증 결과 0 | 공식 운영 호스트에서 HTTPS 통신 성립을 확인 |
| KOPIS www 호스트 | HTTP 301, 자동 이동 안 함 | canonical 호스트를 별도로 확인하고 사용 |
| KOPIS 실키 최소 조회 | HTTP 200, XML `dbs/db`, 필수 필드 4개 존재, 반환 1행, `PASS` | 현재 키로 최소 목록 응답을 받음. 행사 수집·정규화·저장·제품 연결 완료가 아님 |
| 서울 키 없는 HTTPS 443 확인 | 제한 시간 안에 연결을 완료하지 못함(curl 28) | 현재 환경에서 HTTPS API를 확인하지 못함 |
| 서울 키 없는 HTTPS 8088 확인 | TLS 실패(curl 35) | HTTP 문서의 포트에 HTTPS를 적용해도 이번 환경에서 성립하지 않음 |
| 서울 실키 조회 | `NOT_RUN`, `OFFICIAL_HTTPS_UNVERIFIED`, 요청 0회 | 확인되지 않은 HTTPS 주소나 HTTP로 키를 보내지 않음 |

KOPIS는 Asia/Seoul 기준 실행 당일을 `stdate=eddate`로 지정하고 `cpage=1`, `rows=1`로 실키 요청을 **1회** 보냈다. `mt20id`, `prfnm`, `prfpdfrom`, `prfpdto`가 비어 있지 않은 행을 확인했으며 공연명·주소·응답 원문·키는 출력하거나 파일로 저장하지 않았다. 도구의 종료 코드는 0이었다.

서울의 공식 문화행사 명세와 이용 안내에서 확인한 API 예시는 `http://openapi.seoul.go.kr:8088/`다. 포털의 HTTPS와 API의 HTTPS 지원을 구분한다. 이번 확인만으로 모든 환경에서 HTTPS가 불가능하다고 단정하지 않는다. 공식 지원 HTTPS endpoint가 확인되면 해당 주소로 1행 재검증하는 작업이 남는다. 현재 도구의 서울 실행은 키 파일도 읽지 않고 종료 코드 2를 반환한다.

근거: [KOPIS 공식 개발 가이드](https://kopis.or.kr/upload/openApi/%EA%B3%B5%EC%97%B0%EC%98%88%EC%88%A0%ED%86%B5%ED%95%A9%EC%A0%84%EC%82%B0%EB%A7%9DOpenAPI%EA%B0%9C%EB%B0%9C%EA%B0%80%EC%9D%B4%EB%93%9C.pdf), [서울 문화행사 공식 명세](https://data.seoul.go.kr/dataList/OA-15486/A/1/datasetView.do), [서울 공식 Open API 이용 안내](https://data.seoul.go.kr/together/guide/useGuide.do). KOPIS 공식 문서의 HTTP 예시와 별도로, 이번 HTTPS 성공은 실제 호출 결과다.

## 재현 도구와 검증

```sh
# 기본: 키 파일 읽기와 네트워크 호출 모두 하지 않음
python3 -B tools/local/check_event_apis.py --provider kopis

# 키 원문을 명령 인수에 넣지 않고, 명시한 로컬 파일에서 읽음
python3 -B tools/local/check_event_apis.py --provider kopis --run --env-file /절대경로/.env

# 현재 서울 실키 전송은 보류 상태를 보고하며 실행하지 않음
python3 -B tools/local/check_event_apis.py --provider seoul --run

python3 -B -m unittest discover -s tests/functions/minkyu -p test_event_apis.py -v
```

- 단위 검사 **7개 PASS**: 기본 무호출, HTTP·다른 호스트 거절, URL/키의 stdin 전용 전달, redirect 미추적, TLS 오류·시간 초과·본문 한도, XML/JSON 오류와 HTTP 200 오류 envelope 거절, 키·경로·예외·응답 원문 비노출.
- `/usr/bin/curl`의 기본 인증서 검증을 사용한다. `--insecure`, 사용자 CA, `.curlrc`, 자동 retry, HTTP fallback을 사용하지 않는다.
- 키가 포함된 전체 URL은 `--config -`의 stdin에만 전달한다. curl 인수·환경·출력에 넣지 않으며 stderr도 공개하지 않는다. 요청은 15초, 연결은 5초, 본문은 128 KiB로 제한한다.
- 출력은 공급사·고정 판정·HTTP 상태·반환 건수·실키 요청 시도 여부뿐이다. 예상하지 못한 예외도 고정 오류로 반환한다.
- 종료 코드: 0은 최소 응답 PASS, 2는 NOT_RUN, 1은 입력·전송·응답 검증 실패다. 모든 결과의 `service_integration`은 `NOT_RUN`이다.

## 종현에게 이어질 작업

1. KOPIS 어댑터에서 canonical HTTPS endpoint와 XML 오류·행 구조를 반영한다. 상세 조회·전체 수집·갱신·중복 처리·내부 행사 모델 변환은 별도 검증한다.
2. 서울은 공식 HTTPS API 주소를 확인한 뒤 민규에게 최소 연결 검증을 요청한다. 키가 URL 경로에 포함되므로 query만 제거하는 로그 처리는 충분하지 않다.
3. 이번 결과를 행사 DB 저장·조회 모드·AI 행사 연결이나 운영 배포 완료로 사용하지 않는다.

외부 계정 설정·원격 DB·배포·커밋·푸시는 이 lane에서 하지 않았다.
