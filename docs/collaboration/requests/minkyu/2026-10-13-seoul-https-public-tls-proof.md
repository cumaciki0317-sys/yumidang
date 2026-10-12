# 서울 공개 호스트 HTTPS 실제 연결 확인

2026-10-13, 작업자 minkyu. 이전 공급사 검토·HTTPS 후속 문서는 보존했다. 이번 부모 배정은 공식 공개 호스트 두 포트의 정상 인증서 검증 TLS를 한 번씩 확인하는 범위다. Docker·DB·리소스 조회·인증키·로그인·회원 원문·HTTP fallback·redirect 추종·수집 활성화는 0이다.

## 공식 안내와 시험 범위

[서울시 문화행사 공식 데이터 페이지](https://data.seoul.go.kr/dataList/OA-15486/A/1/datasetView.do)에서 문화행사 데이터와 갱신 정보가 제공됨을 확인했다. [공식 Open API 이용 안내](https://data.seoul.go.kr/together/guide/useGuide.do)의 예시는 여전히 `http://openapi.seoul.go.kr:8088`이며 공개 sample은 시작/끝 1~5를 사용한다. 공식 페이지의 HTTPS와 공식 HTTP API 예시는 API의 HTTPS 지원을 입증하지 않는다.

`openapi.seoul.go.kr`의 443·8088에 직접 연결하고 Python 기본 신뢰 저장소·호스트명 검증을 적용했다. 각 시도 전체에 5초 alarm을 적용했다. TLS가 성립할 때에만 공개 `/sample/json/culturalEventInfo/1/5` GET을 최대 한 번, 응답 64KiB 상한으로 보낼 계획이었다. scheme을 바꾼 이 후보는 공식 HTTPS 지원 계약이 아니라 제한된 기술 시험이다.

## 실제 결과

| 포트 | 실제 관측 | TLS/인증서 검증 | HTTP 상태·schema |
| --- | --- | --- | --- |
| 443 | 5,005ms에 TimeoutError | 성립하지 않음 | GET 미전송, 미확인 |
| 8088 | 23ms에 SSLError, WRONG_VERSION_NUMBER | 성립하지 않음 | GET 미전송, 미확인 |

5초 deadline 이후 정리·측정 비용이 포함된 443의 실제 경과는 5,005ms다. TimeoutError는 해당 호스트의 전역적 장애나 HTTPS 지원 부재를 단정하는 근거가 아니다. 8088 결과도 이 시도의 TLS 협상 실패로 한정한다. 인증서 DER, HTTP body 또는 행사 row는 확보하지 않았다. 재시도·HTTP 요청·TLS 완화·우회 proxy는 하지 않았다.

비공개 영수증: `/private/tmp/yumidang-seoul-public-tls-20261013-cb8ad5a816904045bc64923cf110364f/receipt.json`, SHA256 `a333de8621a113b3a243511e605a2432601e90e5e24ca1753ede3d675be42c8f`. 폴더 700·파일 600·배타적 생성과 파일/폴더/상위 폴더 fsync를 사용했다. 비공개 경로 원본을 저장소에 추가하지 않았다.

서울 HTTPS hold는 유지한다. 이번 결과로 실키 권한·전체 수집·100개 페이지 재개·진행 중 갱신·공식 HTTPS 지원·운영 완료를 인정하지 않는다. 공개 공식 문서 읽기와 두 번의 제한된 TLS 시험만 완료했으며, 관리 진행률을 올리지 않는다.

## 시스템 기본 TLS의 별도 공개 호스트 확인

2026-10-13, 전체 **79%(22/28)**를 유지한다. Python 신뢰 체인과 구분해 시스템 curl의 기본 SecureTransport로 `https://openapi.seoul.go.kr/` 공개 호스트 HEAD를 한 번 시도했다. curlrc를 읽지 않고 인증서/호스트명 검증을 유지했으며 redirect·retry·HTTP fallback·키는 사용하지 않았다. 연결 5초 한도에서 curl exit28, HTTP0, TLS app-connect0으로 실패했다. ssl_verify_result0은 handshake가 성립하지 않은 이 경우 TLS 성공 증거가 아니다.

비공개 실제 영수증 SHA `deb817371ac741fd5383c527fbb130d0b6119fd997cef3cf990d8572e72abc3b`, 경과 5,043ms다. API sample GET0·실키 사용0·회원 원문0·모델 호출0을 유지한다. 이번 클라이언트/환경의 연결 실패로만 판정하며 서울 전체 HTTPS 지원 부재나 공급사 서비스 종료로 확대하지 않는다. 실제 행사 JSON/parser/수집/운영 활성화는 미검증이다.
