# WBS7.9 서울 공식 문서·공개 HTTPS 표본 점검

민규 단독 읽기 점검. 전체79%(22/28) 유지. 실제 회원·비밀키 조회·DB/운영 변경0, 공급사 문의 발송0이다.

## 확인된 범위

2026-10-20 별도 빈 브라우저 context에서 [OA-23041 공식 Open API 명세](https://data.seoul.go.kr/dataList/openApiView.do?infId=OA-23041&srvType=A)의 실제 DOM을 읽었다. 서비스는 aiViewCulture이고 표본 URL은 HTTP8088이다. 공통 list_total_count/RESULT와 시작·종료 위치, 선택 CODENAME/TITLE/DATE를 안내하며 CGG_CD를 포함한25개 출력 필드가 있다. DATE 설명은 YYYY-MM-DD이며 과거 시작·현재 진행 행사의 갱신을 보장하는 조건/기간 의미는 이 표만으로 확인되지 않는다.

[공식 OA-23041 데이터셋](https://data.seoul.go.kr/dataList/OA-23041/S/1/datasetView.do)은 새 서비스 aiViewCulture의 필드 명세와 연결되지만, 페이지 열람은 실제 API envelope나 HTTPS 지원 증명이 아니다. 기존 OA-15486의 culturalEventInfo 검색 캐시를 새 계약으로 적용하지 않는다. 일반 페이지 공통의 종료/URL 오류 안내 overlay 텍스트도 실제 서비스 종료 판정으로 사용하지 않았다.

DOM 도구 반환 원본은 `/private/tmp/yumidang-seoul-official-contract-20261020/public-openapi-document.json`, SHA `bc8344ea125fef48559fa7b5ab4328c37c634932213b064ae06b59d3e9e6278f`다. 도구 자체 filePath 저장은 workspace 범위 제한으로 실패했고, 정상 읽기 반환 원본을 허용된 private 경로에 root가 저장했다. 다른 브라우저 탭이나 계정은 읽지 않았다.

## 실제 공개 표본 HTTPS443 결과

비밀키 없이 공개 sample만 사용해 `https://openapi.seoul.go.kr/sample/json/aiViewCulture/1/1/` GET1회를 시도했다. cURL -q, TLS 검증 유지, redirect0/retry0, 연결5초·전체10초·본문2,000,000바이트 상한이다. 원상태·stderr/헤더 파일을 판정 전 보존했다.

결과는 exit28·443 연결 timeout(약5초), HTTP000·본문0이다. TLS handshake 성공이나 공급사 응답 거절을 뜻하지 않는다. `ssl_verify_result=0`만으로 검증 성공을 주장하지 않는다. 현재 네트워크에서 안전한 실응답을 확보하지 못했다는 범위로만 판정하며 공급사의 HTTPS 영구 미지원으로 확대하지 않는다. 자기 child는 종료·reap/그룹 부재를 확인했다.

영수증 `/private/tmp/yumidang-seoul-official-contract-20261020/https443-receipt.json`, SHA `cccdb1526b976ec3d7ddf6c1c2464d21dd03d89c8446d42df144d84bfbba1e39`. 실제 개인 키 조회0, 평문 HTTP 요청0, 재요청0이다.

## 남은 조건과 다음 작업

현재 seoul.ts는 미검증 aiViewCulture envelope를 거절하고 보안 transport 없이는 호출하지 않는다. 이를 억지로 해제하거나 HTTP로 fallback하지 않았다. 공식 HTTPS 실제 도달/인증서·서비스 응답, 실제 JSON envelope/형식/total/페이지, 진행 중 행사 갱신 범위와 필터 의미가 남는다. 해당 근거를 얻은 뒤 기존 seoul.ts의 정상화·분류기와 현재 수집/재개 계약을 연결한다. 코드 변경·제품 전송·3공급사 수집·앱/AI 일치·운영 완료는 이번 점검 범위가 아니다.
