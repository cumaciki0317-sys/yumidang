# 서울 HTTPS 공개 sample 후속 확인

2026-10-10, minkyu. [동결된 공급사 검토](2026-10-10-supplier-official-evidence-review.md)는 변경하지 않았다. 이번에는 공개 sample의 제한된 HTTPS 시험 전에 기존 실제 연결 근거를 먼저 찾았다. Docker·리소스 조회·DB 질의·실키·공급사 API 요청·외부 메시지·활성화는 0이다.

## 재호출 전에 확인한 기존 근거

[종현 정책 구현 인계](../jonghyun/2026-10-05-policy-implementation-handoff.md) 75행에는 기존 OpenAPI HTTPS8088 sample의 로컬 TLS protocol 오류와 HTTPS443의 정상 서비스 미확인이 기록돼 있다. 공식 데이터셋의 HTTPS Sheet 미리보기·JSON/CSV 다운로드 성공도 함께 기록돼 있으나, 미리보기 형식과 다운로드의 페이지 번호 무시 때문에 기존 100개/쪽·영속 페이지 재개 계약에 직접 연결하지 않았다.

이 기록은 과거 실행의 인계 설명이다. 이번 검색에서 당시 정확한 URL·TLS 오류·응답을 담은 원 proof artifact는 찾지 못했고, 현재 동일 호스트의 TLS 상태를 새로 측정하지 않았다. 과거 설명을 현재 TLS 재검증 성공이나 영구 지원 불가로 확대하지 않는다.

## 공식 경로와 이번 판정

[문화행사 공식 OpenAPI 페이지](https://data.seoul.go.kr/dataList/OA-15486/S/1/datasetView.do?tab=A)의 서비스는 culturalEventInfo이며 예시는 HTTP openapi.seoul.go.kr:8088에 인증키·형식·서비스·시작/끝 인덱스를 붙인다. [공식 활용 안내](https://data.seoul.go.kr/together/guide/useGuide.do)는 공개 sample 및 최대 5행 제한을 안내하지만 HTTPS API 경로를 제시하지 않는다.

따라서 같은 호스트·sample 경로에서 scheme만 바꾸는 HTTPS8088 후보는 공식 지원 경로가 아니라 추정 후보이며, 이미 실패가 기록된 경계를 다시 호출하게 된다. 이번에는 부모 지시의 기존 실패 경로 반복 방지 조건을 적용하여 새 sample 요청을 보내지 않았다. HTTPS443 역시 정상 서비스 미확인 기록을 최신 성공으로 바꾸지 않는다.

별도의 공식 HTTPS 경로가 확인되거나 기술적으로 의미 있는 변경 근거가 생긴 뒤, 다른 정확한 후보가 승인되면 공개 sample 최대 5행·정상 인증서 검증·고정 시간/본문 상한·redirect 미추종으로 좁게 확인할 수 있다. 그런 시험이 성공해도 해당 TLS/sample 경로의 성공일 뿐, 공식 지원 계약·실키 권한·전체 행사 수집·페이징·진행 중 갱신·수집 활성화 완료는 아니다. HTTP fallback, proxy, 인증서 검증 완화를 적용하지 않았다.

## 기록과 남은 조건

private700/600 영수증은 `/private/tmp/yumidang-seoul-https-retained-proof-20261010-v1/receipt.json`이다. SHA `5c0859ff62915943a704a5367888426525131846b587833e9f51f9db74ae4486`는 생성 후 실제 해시로 대조한다. 원 인계 바이트 해시와 동결된 5e42 문서 해시를 결합하며 새 TLS/API 요청은 NOT_RUN이다. 원 로그·키·행사 본문을 새로 출력하거나 저장하지 않았다.

서울 hold와 전체 관리 75%(21/28)·운영 2/7을 유지한다. 이번 결과는 이전 실패 경계의 재확인과 중복 시험 방지이며 새 transport 성공 증거가 아니다.
