# 서울 문화행사 신규 공식 계약 검토 요청

## 2026-10-20 현행 기준과 이 문서의 적용 범위

이 문서는 과거 요청·설계·검증 기록이다. 아래 원 관찰·명령·해시·PASS/FAIL은 당시 증거로 보존한다. 재개할 때는 다음 현행 조건을 먼저 적용하며 과거 작업 권한·보류를 현재 지시로 재사용하지 않는다.

- 담당은 현재 민규=BE·AI·검색·행사·서버 운영, 종현=FE·UX/UI·앱 API/세션 소비·빌드, 유미=UT·출시/지원 책임이다. 아래 옛 종현 BE·성호 UI 배정은 당시 기록이며 현재 실행 권한으로 사용하지 않는다. 구체 파일은 현행 소유권 정책을 따른다.

- 서울은 키/응답의 평문 HTTP 수집을 활성화하지 않는다. 검토된 HTTPS 자동 수집 경로·실제 최신 응답 envelope·페이지 재개·진행 중 갱신 확인까지 보류한다. 홈페이지 HTTPS 성공이나 HTTP 앞에 s를 붙인 주소는 API 전송 보안 검증이 아니다. 이 보류는 다른 공급사·공통 칼럼/화면 준비의 중단을 뜻하지 않는다.

최신 기준: [정책.md](../../../../정책.md). 구현과 남은 조건: [서버·DB 대조 원장](../jonghyun/2026-10-20-policy-implementation-audit/server-audit.json).


전체 **79%(22/28)** 유지. 담당은 종현이며 민규는 읽기·근거 기록만 진행했다. 기존 공급사 경로를 직접 수정하거나 활성화하지 않았다.

[공식 OA-23041 페이지](https://data.seoul.go.kr/dataList/OA-23041/S/1/datasetView.do)는 공개2026-09-30·갱신2026-10-11로 서울시 문화행사 정보를 제공한다. 페이지가 제공한 [공식 API 안내](https://data.seoul.go.kr/dataList/openApiView.do?infId=OA-23041&srvType=A)에서 서비스명 `aiViewCulture`와 HTTP8088 샘플을 직접 확인했다. 키·쿠키·회원 데이터 없이 공식 두 문서를 HTTPS로 조회해 HTTP200·TLS 검증 결과0,90,744/21,430바이트를 확인했다. 문서 조회 성공은 실제 행사 수집 성공이 아니다. API HTTPS endpoint는 아직 확인되지 않았고 HTTP 대체 수집은 하지 않았다.

원 문서·새 문서·읽기 영수증은 비공개 보존한다. 영수증SHA `91b17c7d3349e9ed1d1d2b8eecbee7ec38eb13d3a7452ae8b83a2e342a9c9025`. 이전 OA-15486과 원 endpoint의 TLS 실패 기록을 보존한다.

현재 `backend/supabase/functions/_shared/integrations/events/seoul.ts`는 OA-15486을 참조하고 `culturalEventInfo` envelope 또는 평면 응답을 해석한다. 새 `aiViewCulture` envelope는 현재 계약에서 검증되지 않았다. 서비스명을 바꾸거나 문서의 HTTPS 주소를 데이터 API HTTPS 지원 근거로 간주하지 않는다.

종현 검토 사항:

- 공식 지원 HTTPS 데이터 endpoint·인증키 취급·지원 종료/이관 관계를 확인한다. 확인 전 활성화는 닫아 둔다.
- 실제 공급사 응답의 envelope·필드·페이지 total·오류 계약을 기존 seoul.ts 책임 파일에 반영한다. 새 중복 공급사 폴더를 만들지 않는다.
- 긴 요금·최신 상세 정보·무료/장르/기간·숨김 제외 계약은 보존한다. 알 수 없는 envelope를 빈 성공으로 처리하지 않는다.
- endpoint 확인 후 새 합성 수집 scope의 HTTP·DB·실행기 결과를 함께 검증한다. 공개 문서 읽기나 모형만으로 추가 기능/운영4단계를 완료 처리하지 않는다.

외부 담당자에게 자동 메시지를 보내지 않았고 운영·기존 endpoint·소유권 정책 변경0이다.
