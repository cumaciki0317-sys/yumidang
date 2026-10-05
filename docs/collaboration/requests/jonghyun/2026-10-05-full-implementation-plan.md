# 종현 전체 구현 계획

사용자 승인: 전체 설계 후 구현 시작. 문서에 명시된 종현 작업 먼저 완료한다.
기준: 9dfca36 / jonghyun/queue-integration / 독립 clone.

## 사용자 확정

- 원본 사진 최대 10,000,000 bytes. 최종 2MiB는 서버 계약 유지.
- 원격 종료 불확실 시 조기 점유 해제하지 않고 자연 만료까지 유지, 연장 없음. 민규 종료 확인 연결은 보류.
- 커밋/푸시/운영 활성화는 자동 실행하지 않음.
- 신고의 숨김 선택은 실제 서버 숨김 연결 전 보류하고 신고 접수만 연결한다. 사용자 추가 답변으로 확정.

## 순서와 완료 조건

1. 큐: TLS+고정 SET ROLE, 3kind, cleanup DTO, 종료 불확실 처리, 재접속. 담당 코드/가상 검증 완료 후 실제 DB/HTTP는 별도.
2. 검색/행사/장소: 기존 코드와 최신 공통 계약을 대조, 종현 차이 보완, M HTTP/RPC 요구를 자기 요청 문서에 남김. 서울 A 보류 유지.
3. AI/요약/피드백: 기존 코어와 최신 DB 계약 대조, 미준비 안전/공급사 조건 차단, 합성 실패/경쟁 검증. 실제 회원 전송 보류 유지.
4. 모바일: 명시된 로그인/프로필/공고/동행/후기/안전/API 연결. 사진10MB, preferences4field, 실패 입력 보존/늦은 응답 방지. M API 준비 전 실제 성공 주장 금지.
5. 담당 검증/인계: 코드·가상·실제·M대기·보류를 분리. 실제 기기/운영 검증은 환경과 승인 조건 충족 뒤.

## 수정 경계

하네스 exact allowlist와 HEAD 소유권 검사로 종현 파일만 수정. 공통 SQL/auth/config/client/최상위/성호 파일은 읽기 전용. 새 충돌은 근거와 대안을 사용자에게 질문. 이미 확정/팀 유보 정책 재질문 금지.

## 이번 검증 기록

- 큐38개 PASS; 별도 자동완료·일일등록·작업처리4파일43개 PASS. 서로다른집합, 가상DB/HTTP/timer 검사.
- AI/검색18파일186개 PASS, Deno3진입점PASS. 행사/장소10파일114개 PASS. 각각 기존합성검사를 재사용.
- 모바일 새 SDK4파일31개, 기존 정책/서비스/주소3파일41개 PASS. 전체 typecheck/lint PASS.
- 브라우저15개/가상HTTP20회 PASS: 성향 실패 입력보존·네필드 원자 저장, 첫메시지 재시도 ID/본문 유지, 공고 발행 실패 초안보존·동일 UUID/본문 재시도·무료 정책, 없는 탈퇴 endpoint 미호출.
- 실제 Expo 웹 코덱: 합성 PNG64×48→JPEG780bytes, 메타데이터검사와 브라우저 디코딩64×48 PASS. 실제 Storage 전송 아님.
- iOS/Android Hermes 번들 export PASS. 실제 기기 실행/로그인/배포 아님.


## 루트 브라우저 검증 조건

검사 파일은 `tests/integration/jonghyun/mobile-member-writes-browser.mjs`다. 운영 앱에 테스트 세션 주입 경로를 추가하지 않았다. 임시 복제본 `/private/tmp/yumidang-member-browser-uajqpmv2/apps/mobile`에서만 `/test-session`과 `/test-codec`를 생성했다. 서비스 URL은 `https://api.example.test/functions/v1/service-api`, 회원 토큰은 실제 인증정보가 아닌 `browser-synthetic-member`다. Playwright는 localhost와 이 가상 API만 허용하고 외부 요청을 거절한다.

재실행하려면 별도 임시 복제본에 테스트 부트 경로를 준비해야 한다. `/test-session?target=...`의 `Install synthetic session` 버튼은 고정 합성 사용자·ready 세션을 설치한 뒤 목적 화면으로 이동한다. `/publish`는 세션 설치 후 재렌더된 컨텍스트에서 두 번째 클릭으로 합성 무료 공고 초안을 `app.saveDraft`에 저장한다. 초안의 serviceDraftEpoch는 현재 세대와 같아야 한다. 제품의 세션 변경 방어를 우회하지 않는다. 가상 초안: 전시/가상 발행 검증/한 시간 함께 관람해요./2026-10-08T14:00~15:00/가상 미술관/서울 성동구 성수동/정문 안내대. 이 경로와 토큰은 실제 배포물에 포함하지 않는다.

웹 export 후 SPA fallback localhost8092 서버로 제공하고 검사 파일을 실행했다. 원격 실제 Auth/DB/Storage/공급사/기기/운영은 NOT_RUN이다. 최초 브라우저 실패는 제한 환경의 실행 차단과 임시 서버 작업 디렉터리 교체, 테스트 부트의 이전 세션 컨텍스트 사용으로 나누어 수정했으며 최종15개 PASS만 최종 결과로 표시한다.
