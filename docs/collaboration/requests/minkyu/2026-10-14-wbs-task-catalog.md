# 2026-10-14 Notion WBS 작업 카탈로그

## 2026-10-20 현행 기준과 이 문서의 적용 범위

이 문서는 현재 요구와 구현 계약을 구분한다. 아래 기술 시그니처·기존 SQL·검증 기록은 실제 구현 근거이며 새 정책 요구가 자동 구현됐다는 뜻이 아니다.

- 담당은 현재 민규=BE·AI·검색·행사·서버 운영, 종현=FE·UX/UI·앱 API/세션 소비·빌드, 유미=UT·출시/지원 책임이다. 아래 옛 종현 BE·성호 UI 배정은 당시 기록이며 현재 실행 권한으로 사용하지 않는다. 구체 파일은 현행 소유권 정책을 따른다.

- AI 탐색 동의는 첫 사용 시 받고 거절하면 일반 검색을 유지한다. 후기 요약은 가입 시 열람·내 프로필 생성/노출·작성 후기 활용을 기본 미선택인 별도 선택 세 항목으로 받는다. 전체 동의와 개별 자세히 보기를 유지하고 미동의 가입/일반 동행을 허용한다. 세 동의의 철회는 독립적이다. 현재 서버의 summary_allowed 하나·review_summary 일괄 철회가 이 세분화 요구를 구현했다고 해석하지 않는다. 테스트 계정 동의 간주는 실제 동의 증거·DB 값 변경·회원 원문 전송 승인이 아니다.

- KOPIS는 전체 공연·연극·뮤지컬·클래식·국악·대중음악·무용·대중무용·서커스/마술·복합·아동·대학로·내한·축제 14항목, 어제까지 최근7일·매일 갱신이다. basedate 누락만으로 영구 공개 보류하지 않고 공식 사이트의 실제 기간·조건·공연ID/순위/순서를 대조한 분류만 공개하는 A안을 적용한다. 요청 날짜로 기간을 확정하거나 일일순위를 합산하지 않는다. 확인 기간·시각·출처를 표시하고 실패 때 마지막 검증 기간을 유지한다. 아래 all/musical·basedate 필수 parser·not_enabled는 현재 구현/당시 검증의 기술적 한계이며 최신 제품 정책이 아니다. 일반 공연 수집·칼럼 매핑은 순위 대조와 병행한다.

- 서울은 키/응답의 평문 HTTP 수집을 활성화하지 않는다. 검토된 HTTPS 자동 수집 경로·실제 최신 응답 envelope·페이지 재개·진행 중 갱신 확인까지 보류한다. 홈페이지 HTTPS 성공이나 HTTP 앞에 s를 붙인 주소는 API 전송 보안 검증이 아니다. 이 보류는 다른 공급사·공통 칼럼/화면 준비의 중단을 뜻하지 않는다.

- 일반 신고·허용된 증거 열람·비용 운영 책임은 대표 조유미(유미), 공개 지원 메일은 cumaciki0317@gmail.com이다. 별도 등록 사업자는 없고 대체 담당은 미지정이다. 평일09~18시/신고 첫 확인2영업일은 목표이며 실제 권한 설정·메일 수신·응답 보장 증거가 아니다. 앱 밖 삭제는 공개 방침의 직접 연결 구역과 이메일로 받고 첫 답변/본인확인 후 처리 목표는 정책13장을 따른다. 운영자는 회원 채팅 DB 원문을 직접 읽지 않는다.

최신 기준: [정책.md](../../../../정책.md). 구현과 남은 조건: [서버·DB 대조 원장](../jonghyun/2026-10-20-policy-implementation-audit/server-audit.json).


원본: [WBS (1)](https://app.notion.com/p/3f9a6def75f880ae8f31f6cdbd69ea78) · `collection://987a6def-75f8-8338-9785-07f248cc9096`
확인 시각: 2026-10-14 23:42 KST. 노션 쓰기·상태 변경·복구·삭제를 실행하지 않았다.

현재 활성 **112행**, 삭제 표시 **5행**, 대조 기록 **117행**이다. 이전117행에서 빠진5개는 모두 개별 fetch의 `deleted`를 확인했다. [8.17]도 삭제 표시가 있으므로 자동 시작 후보에 넣지 않는다. 삭제 이유·재개 여부를 임의 확정하거나 복구하지 않는다.

| 활성 노션 상태 | 행 수 |
|---|---:|
| 대기 | 62 |
| 최종 완료 | 3 |
| 작업 중 | 42 |
| 배포 완료 | 2 |
| 퍼블리싱 완료 | 2 |
| BE 연동 대기 | 1 |

상태는 노션 값을 그대로 보존한다. 최종 완료3건과 배포 완료2건·퍼블리싱 완료2건을 구분한다. 배포·퍼블리싱 단계의 완료를 전체 검증 완료로 환산하지 않는다. 마지막 명시 전체 기준 **79%(22/28)**는 이 카탈로그 수집으로 바꾸지 않는다.

## 자기소개 후 첫 시작 후보

| 작업자 | 후보 | 현재 상태 | 시작 범위 |
|---|---|---|---|
| 민규 | [[4.2] 최신 정책·API 계약·DB 구현 차이 검토](https://app.notion.com/p/8e9a6def75f882848e5c019c7cad8c1b) | 작업 중 | 기존 PASS·실제 최신 소스와 서버 계약의 차이부터 읽기 확인. 운영 쓰기·VM 실행 조건을 해제하지 않는다. |
| 종현 | [[3.1] 앱 라우팅·인증·서비스 연결 지점 확인](https://app.notion.com/p/516a6def75f883e19d13016dd99e5788) | 작업 중 | 앱 라우팅·인증·세션·서비스 연결 지점을 현재 서버 계약과 대조하고 종현 소유 클라이언트 잔여부터 구현. |
| 유미 | [[2.4] UT 시나리오와 판정 기준 설계](https://app.notion.com/p/b1ea6def75f88233b2ee816474c82f24) | 대기 | 실회원 검증 없이 UT 시나리오·판정 기준을 준비하고 2.5 개선 Task 체계로 연결. |

후보는 새 우선순위 확정이 아니다. 재개 때 노션·HEAD·소유권·최신 실행 증거를 다시 읽고 이미 완료된 구현을 보존하며 해당 작업자의 독립 잔여부터 진행한다. 협업/선행 관계를 설계·읽기·준비까지 일괄 차단하는 조건으로 쓰지 않는다.

## 담당과 실행 경계

- 민규: BE·AI·Infra·서버 OPS 및 공통 정책·서버 인증·DB·RPC·SQL·도구·서버 테스트. 실제 운영 DB 쓰기·배포·VM/컨테이너 실행은 대상별 기존 실행 조건을 따른다.
- 종현: FE·UX/UI·앱 인증/세션 소비·클라이언트 연동·빌드. 서버 AI·API 집행 정책은 민규 계약을 소비하며 직접 서버 담당을 이어받지 않는다.
- 유미: Brand&Marketing·UT, PM/정책 주담당. 정책 공동 정리는 종현과 유지하되 공통 정책 파일은 민규가 수정한다. 유미 파일 수정은 UT·본인 요청 경로만 허용된다.
- QA: 민규·종현·유미 공통 판정. 각 파일의 단독 owner와 격리 clone/worktree는 유지한다. 일반 신고 실무·부재 대체 담당의 미정 상태는 임의 지정하지 않는다.
- 실회원 HOLD, 공급사·법적 확인, 회원 원문 외부 전송, 운영 적용·스토어 제출·SNS 게시·외부 메시지·추가 결제·커밋/푸시의 기존 실행 경계를 유지한다. 자기소개는 접근 인증이 아니다.

## 활성 작업112행

| WBS ID | 업무 항목 | 영역 | 담당자 | 실제 상태 | 우선순위 |
|---|---|---|---|---|---|
| — | [(제목 없음) ](https://app.notion.com/p/223a6def75f8839e911981ea905ceff3) | — | 미배정 | 대기 | — |
| — | [(제목 없음) ](https://app.notion.com/p/ae6a6def75f883ce8402016cd066d17f) | — | 미배정 | 대기 | — |
| — | [공통 컴포넌트 작업 ](https://app.notion.com/p/d4ca6def75f882eea2ad01027d36dcac) | FE/화면 구현 | 종현 | 최종 완료 | P0 |
| — | [내 정보 조회 API <mention-page url="https://app.notion.com/p/16b44227a435829c83ca01e724ba2e7e"/> ](https://app.notion.com/p/b92a6def75f88348899901be76df77d9) | BE | 민규 | 작업 중 | P0 |
| — | [배포 환경 설정 ](https://app.notion.com/p/9dfa6def75f8824790b581cd025de4f2) | BE | 민규 | 배포 완료 | P0 |
| — | [앱인 토스 출시 ](https://app.notion.com/p/f72a6def75f88220acd20121cadb9832) | — | 미배정 | 대기 | P3 |
| — | [어떤 미팅을 진행할 예정인가요? ](https://app.notion.com/p/313a6def75f883bf9bf881ecc0be46cc) | — | 미배정 | 대기 | — |
| — | [요구사항 명세서 작성 ](https://app.notion.com/p/706a6def75f88248b33c019daf76864c) | AI | 민규 | 최종 완료 | P0 |
| — | [이름: 사유를 간략히 입력해 주세요 ](https://app.notion.com/p/e8da6def75f882269f480194122fdbb7) | — | 미배정 | 대기 | — |
| — | [회원가입 API <mention-page url="https://app.notion.com/p/4c844227a435835dad0781d4edd628ec"/> ](https://app.notion.com/p/c8ea6def75f88383b1e481cc54debd2d) | BE | 민규 | 배포 완료 | P0 |
| 1.1 | [[1.1] MVP 포함·제외·보류 범위 정합성 검토 ](https://app.notion.com/p/348a6def75f8832ba45c815cc6585414) | PM/기획 | 유미·종현 | 작업 중 | P0 |
| 1.2 | [[1.2] 정책·PRD·IA·USERFLOW·구현 차이 목록 정리 ](https://app.notion.com/p/099a6def75f883a2af55012cf217b65a) | PM/기획 | 유미·종현 | 작업 중 | P0 |
| 1.3 | [[1.3] 변경·보류 의사결정 로그 준비 ](https://app.notion.com/p/55fa6def75f882fb96d5010ba09af412) | PM/기획 | 유미·종현 | 작업 중 | P0 |
| 1.4 | [[1.4] 출시 필수 검증 조건 목록 합의 ](https://app.notion.com/p/c5da6def75f882ae97d781ef71a46d1c) | PM/기획 | 유미·종현 | 작업 중 | P0 |
| 1.5 | [[1.5] WBS 책임·우선순위·실행 범위 승인 ](https://app.notion.com/p/e0ba6def75f88225a6580192a539e7f1) | PM/기획 | 유미 | 대기 | P1 |
| 1.6 | [[1.6] 최신 정책·계획·협업 문서의 승인된 차이 반영 ](https://app.notion.com/p/c85a6def75f883af940901663676f842) | PM/기획 | 민규 | 대기 | P1 |
| 1.7 | [[1.7] 담당·소유권·작업 환경 인계 정합성 확인 ](https://app.notion.com/p/526a6def75f882d0a511014db6697359) | PM/기획 | 민규 | 대기 | P1 |
| 2.1 | [[2.1] 실제 화면 목록과 IA 대조 ](https://app.notion.com/p/192a6def75f882c1a1c801906dce8d3d) | UX/UI | 종현 | 작업 중 | P1 |
| 2.2 | [[2.2] 가입→탐색→동행→채팅→완료 UX 점검 ](https://app.notion.com/p/679a6def75f882d1884501d68181bde7) | UX/UI | 종현 | 작업 중 | P0 |
| 2.3 | [[2.3] 비로그인·빈 결과·실패 화면 점검 ](https://app.notion.com/p/fafa6def75f8821595210191ded00d3d) | UX/UI | 종현 | 작업 중 | P0 |
| 2.4 | [[2.4] UT 시나리오와 판정 기준 설계 ](https://app.notion.com/p/b1ea6def75f88233b2ee816474c82f24) | UX/UI | 유미 | 대기 | P1 |
| 2.5 | [[2.5] UT 관찰과 개선 Task 정리 ](https://app.notion.com/p/871a6def75f883599ef081cb9cab1eab) | UX/UI | 유미 | 대기 | P1 |
| 2.6 | [[2.6] 현재 화면의 공통 디자인 기준·컴포넌트 반영 ](https://app.notion.com/p/738a6def75f8824cbfe20138db215630) | FE/화면 구현 | 종현 | 대기 | P1 |
| 2.7 | [[2.7] 가입·프로필·마이페이지·탈퇴 화면 개선 ](https://app.notion.com/p/4cea6def75f883c89f4e813d06dd6da7) | FE/화면 구현 | 종현 | 대기 | P0 |
| 2.8 | [[2.8] 탐색·행사·동행 작성/상세 화면 개선 ](https://app.notion.com/p/893a6def75f8827980a38172eb090eba) | FE/화면 구현 | 종현 | 대기 | P0 |
| 2.9 | [[2.9] 채팅·확정/변경·후기·신고·AI 화면 개선 ](https://app.notion.com/p/dbea6def75f882779d9c81e8e5eb8d5a) | FE/화면 구현 | 종현 | 대기 | P0 |
| 2.10 | [[2.10] 접근성·글자 확대·키보드·작은 화면 결함 개선 ](https://app.notion.com/p/e73a6def75f88287a02881652c183d43) | FE/화면 구현 | 종현 | 대기 | P1 |
| 2.11 | [[2.11] 브랜드·세로 영상·게시물 재사용 템플릿 준비 ](https://app.notion.com/p/d7da6def75f88238aba1018c6e8f4cdc) | UX/UI | 종현 | 대기 | P1 |
| 2.12 | [[2.12] Android 앱 아이콘·Play 그래픽 제작·검수 ](https://app.notion.com/p/5f6a6def75f882f9b7ad01323e3956de) | UX/UI | 종현 | 대기 | P0 |
| 2.13 | [[2.13] Android 실제 화면 스크린샷·스토어 이미지 검수 ](https://app.notion.com/p/9b2a6def75f883759ef781c4012832f9) | UX/UI | 종현 | 대기 | P0 |
| 3.1 | [[3.1] 앱 라우팅·인증·서비스 연결 지점 확인 ](https://app.notion.com/p/516a6def75f883e19d13016dd99e5788) | 앱·서비스 연동 | 종현 | 작업 중 | P0 |
| 3.2a | [[3.2a] 네이버 로그인 인증·세션 연동 검증 ](https://app.notion.com/p/040a6def75f883e3b3cd81b4f7a917ba) | 앱·서비스 연동 | 종현 | 퍼블리싱 완료 | P0 |
| 3.2b | [[3.2b] 네이버 가입·사진·자격 확인 서비스 연동 검증 ](https://app.notion.com/p/895a6def75f883f9aff981dad6ff6e71) | 앱·서비스 연동 | 종현 | 퍼블리싱 완료 | P0 |
| 3.3 | [[3.3] 메인 동행 목록 API 연동 검증 ](https://app.notion.com/p/731a6def75f883ca9a5f018d896eaafd) | 앱·서비스 연동 | 종현 | 작업 중 | P0 |
| 3.4 | [[3.4] 동행 작성·첫 메시지 신청·확정/변경 연동 검증 ](https://app.notion.com/p/e22a6def75f8837bb90b81b71cefcffa) | 앱·서비스 연동 | 종현 | 작업 중 | P0 |
| 3.5 | [[3.5] 완료·후기·신고·차단 API·상태 연동 검증 ](https://app.notion.com/p/296a6def75f882dfbd52011ecf7c6b13) | 앱·서비스 연동 | 종현 | 작업 중 | P0 |
| 3.6 | [[3.6] API 실패·재시도·권한 회수의 앱 상태 연동 검증 ](https://app.notion.com/p/e3aa6def75f8825dbc9001b4f42bca22) | 앱·서비스 연동 | 종현 | 작업 중 | P0 |
| 3.7 | [[3.7] 검색어·초안 저장/만료/삭제 실기기 검증 ](https://app.notion.com/p/8ffa6def75f88365aeb2012fc5401e26) | 앱·서비스 연동 | 종현 | 작업 중 | P0 |
| 3.8 | [[3.8] 행사 목록·상세 실제 API 연동 검증 ](https://app.notion.com/p/3dba6def75f8836bb29401f78cd39506) | 앱·서비스 연동 | 종현 | 작업 중 | P0 |
| 3.9 | [[3.9] 마이페이지 회원·사진·탈퇴 API 연동 검증 ](https://app.notion.com/p/672a6def75f8824fb3070152c7b5f7ef) | 앱·서비스 연동 | 종현 | BE 연동 대기 | P0 |
| 3.10 | [[3.10] 유입·가입·첫 신청 퍼널의 측정 연결과 정확성 검증 ](https://app.notion.com/p/84ca6def75f8829bad07815230411f8e) | 앱·서비스 연동 | 종현 | 대기 | P1 |
| 4.1 | [[4.1] 목표 운영 DB 식별과 실제 구조 확인 ](https://app.notion.com/p/68ba6def75f88253a107017eede551d6) | BE | 민규 | 작업 중 | P0 |
| 4.2 | [[4.2] 최신 정책·API 계약·DB 구현 차이 검토 ](https://app.notion.com/p/8e9a6def75f882848e5c019c7cad8c1b) | BE | 민규 | 작업 중 | P0 |
| 4.3 | [[4.3] 실제 네이버 인증·가입 서버 통합 검증 ](https://app.notion.com/p/d8aa6def75f8833cb20701769ca5e118) | BE | 민규 | 작업 중 | P0 |
| 4.4 | [[4.4] 행사·공고 조회/작성/수정·공개 DTO 검증 ](https://app.notion.com/p/a50a6def75f8825eade20138b6009554) | BE | 민규 | 작업 중 | P0 |
| 4.5 | [[4.5] 첫 메시지 신청·확정·변경·만료 동시성 검증 ](https://app.notion.com/p/80da6def75f88269be2c8103f82bf4c5) | BE | 민규 | 작업 중 | P0 |
| 4.6 | [[4.6] 실제 완료·분쟁 보류·후기 공개 시점 검증 ](https://app.notion.com/p/5f2a6def75f88367878d014b1e35e5ea) | BE | 민규 | 작업 중 | P0 |
| 4.7 | [[4.7] 신고·차단·탈퇴·제재 승계·사진 파기·RLS 검증 ](https://app.notion.com/p/ecba6def75f882fead1681432f030dd3) | BE | 민규 | 작업 중 | P0 |
| 4.8 | [[4.8] 내 정보 조회 서버 권한·응답 검증 ](https://app.notion.com/p/58ca6def75f88217980a010dda12b177) | BE | 민규 | 작업 중 | P0 |
| 5.1 | [[5.1] AI 외부전송·동의·공급사 조건 확인 ](https://app.notion.com/p/7a5a6def75f883068a69814c5c7a9edf) | PM/기획 | 유미·민규 | 작업 중 | P0 |
| 5.2 | [[5.2] 자연어 조건과 실제 DB 검색 연동 검증 ](https://app.notion.com/p/512a6def75f88249afbb81226a0a0043) | AI | 민규 | 작업 중 | P0 |
| 5.3 | [[5.3] 모델 설명·개인정보 필터·0건/실패 검증 ](https://app.notion.com/p/c3ba6def75f8837b80e9818c1542538f) | AI | 민규 | 작업 중 | P0 |
| 5.4a | [[5.4a] 회원 하루20회·동시1개 서버 한도 검증 ](https://app.notion.com/p/ef7a6def75f882af9eb681080a111ae7) | BE | 민규 | 작업 중 | P0 |
| 5.4b | [[5.4b] AI 한도·중단 응답의 앱 상태 연동 검증 ](https://app.notion.com/p/990a6def75f88225b0a5011c9a890108) | 앱·서비스 연동 | 종현 | 작업 중 | P0 |
| 5.5 | [[5.5] 다중 계정 예산·원장 런타임 연결 검증 ](https://app.notion.com/p/acca6def75f88212a93281641203618f) | AI | 민규 | 작업 중 | P0 |
| 5.6 | [[5.6] 출력 상한·실제 모델·공급사 사용량 측정 검증 ](https://app.notion.com/p/6f7a6def75f8827f956a01d6837b5e24) | AI | 민규 | 작업 중 | P0 |
| 5.7 | [[5.7] 후기 AI 요약의 경쟁·철회·숨김·삭제 통합 검증 ](https://app.notion.com/p/990a6def75f882c0afd281cef4c7e203) | AI | 민규 | 대기 | P0 |
| 6.1 | [[6.1] 출시 필수 QA 케이스와 증빙 방식 정의 ](https://app.notion.com/p/2eea6def75f88245b5dd810ae8e7117f) | QA | 민규·종현·유미 | 작업 중 | P0 |
| 6.2 | [[6.2] 로그인→후기 실제 회원 회귀 QA ](https://app.notion.com/p/553a6def75f88276be33011a751fca59) | QA | 민규·종현·유미 | 대기 | P0 |
| 6.3 | [[6.3] 신고·차단·비로그인·AI 위험 케이스 QA ](https://app.notion.com/p/47ea6def75f8827fab90814de9fd15b6) | QA | 민규·종현·유미 | 작업 중 | P0 |
| 6.4a | [[6.4a] Android 독립 설치 앱 QA ](https://app.notion.com/p/ef6a6def75f8820483f601c0b48dc19b) | QA | 민규·종현·유미 | 작업 중 | P0 |
| 6.4b | [[6.4b] iPhone 독립 설치 앱 QA 준비 ](https://app.notion.com/p/46ca6def75f883788dae818db298fce0) | QA | 민규·종현·유미 | 대기 | P3 |
| 6.5 | [[6.5] 수정 재검증과 출시 차단 후보 정리 ](https://app.notion.com/p/c22a6def75f883caa733014eb5c55a38) | QA | 민규·종현·유미 | 작업 중 | P0 |
| 6.6 | [[6.6] Android 비공개 베타 운영·결함 분류·수정 재검증 ](https://app.notion.com/p/ccba6def75f88371a1e8014fc312844f) | QA | 민규·종현·유미 | 대기 | P0 |
| 6.7 | [[6.7] 정식 공개 후 Play 설치·로그인·핵심 흐름 확인 ](https://app.notion.com/p/09ea6def75f88379a9cf8192a6898e79) | QA | 민규·종현·유미 | 대기 | P0 |
| 7.1 | [[7.1] 현재 Railway·운영 DB 연결 재검증 ](https://app.notion.com/p/566a6def75f883f0a413011071b40c71) | Ops | 민규 | 작업 중 | P0 |
| 7.2 | [[7.2] 자동완료 실행기 DB 권한·실제 처리·복구 검증 ](https://app.notion.com/p/af8a6def75f882e4b49e81a03a577568) | Ops | 민규 | 작업 중 | P0 |
| 7.3a | [[7.3a] Android 내부 APK 빌드·설치 검증 ](https://app.notion.com/p/541a6def75f882fe955b015ffc320e15) | 빌드·출시 기술 준비 | 종현 | 작업 중 | P0 |
| 7.3b | [[7.3b] iOS 빌드·서명·배포 준비 검토 ](https://app.notion.com/p/1dda6def75f8835591cb81245fe3359a) | 빌드·출시 기술 준비 | 종현 | 작업 중 | P3 |
| 7.4 | [[7.4] 스토어 제출·운영 정책 조건 체크리스트 ](https://app.notion.com/p/4a8a6def75f88310b2e101cf52d37d19) | PM/기획 | 유미·종현 | 작업 중 | P0 |
| 7.5 | [[7.5] 플랫폼별 출시 승인/보류 결정표 ](https://app.notion.com/p/f69a6def75f883dda9b70192edcb0f0a) | PM/기획 | 유미 | 작업 중 | P0 |
| 7.6 | [[7.6] J1 취소·신고 소비자 로컬 구현·가상 검증 ](https://app.notion.com/p/0d1a6def75f8829e8701016c568cbf03) | Ops | 민규 | 최종 완료 | P0 |
| 7.7 | [[7.7] 의존성 보안·Expo 호환 패치 검토 ](https://app.notion.com/p/076a6def75f882c3aee581cfa3bda841) | 빌드·출시 기술 준비 | 종현 | 대기 | P0 |
| 7.8 | [[7.8] KOPIS 공식 순위 기간·표기 검증 준비 ](https://app.notion.com/p/562a6def75f882ddb5f2817590b37a16) | Ops | 민규 | 작업 중 | P0 |
| 7.9 | [[7.9] 서울 행사 안전 HTTPS 자동 수집 검증 ](https://app.notion.com/p/b17a6def75f8829ca8408158830e21e0) | Ops | 민규 | 대기 | P0 |
| 7.10 | [[7.10] 출시 전 협업 변경 검사 체계 점검 ](https://app.notion.com/p/621a6def75f883f1a8fa81255cf24217) | Ops | 민규 | 대기 | P1 |
| 7.11 | [[7.11] 백엔드·AI 검증 환경과 기존 인계 자료 정리 ](https://app.notion.com/p/0e3a6def75f882c3968281d2ea300005) | Ops | 민규 | 대기 | P0 |
| 7.12 | [[7.12] 행사 일일 수집·갱신·재개와 앱·AI 표시 일치 검증 ](https://app.notion.com/p/a68a6def75f8825c98c801dfb46c1f1c) | Ops | 민규 | 대기 | P0 |
| 7.13 | [[7.13] 개인정보·AI 피드백·신고 자료의 주기 파기 연결 검증 ](https://app.notion.com/p/695a6def75f882e19c97818193aa1d46) | Ops | 민규 | 대기 | P0 |
| 7.14 | [[7.14] 최종 DB·권한·Storage 원본 백업과 격리 복원 검증 ](https://app.notion.com/p/5b8a6def75f88204be8e01a4c193d12a) | Ops | 민규 | 대기 | P0 |
| 7.15 | [[7.15] Android 앱 식별자·서명·버전 설정 확인 ](https://app.notion.com/p/eafa6def75f88247b4e2018a8f4cc67b) | 빌드·출시 기술 준비 | 종현 | 대기 | P0 |
| 7.16 | [[7.16] Google Play 제출용 AAB 빌드·검증 ](https://app.notion.com/p/5c9a6def75f882128ae70141ce4ba47b) | 빌드·출시 기술 준비 | 종현 | 대기 | P0 |
| 7.17 | [[7.17] Play 내부·비공개 테스트 트랙의 기술 설정·배포 ](https://app.notion.com/p/030a6def75f882c4ab3681a22e9fb3f5) | 빌드·출시 기술 준비 | 종현 | 대기 | P0 |
| 7.18 | [[7.18] 출시 후 서버·수집·AI·오류 감시와 긴급 복구 준비 ](https://app.notion.com/p/e84a6def75f88262a2240108488cf18d) | Ops | 민규 | 대기 | P0 |
| 8.1 | [[8.1] 핵심 페르소나·페인포인트·소구점 문서화 ](https://app.notion.com/p/853a6def75f883aba40401550ff46c9a) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.2 | [[8.2] 브랜드 가치제안·포지셔닝 검토 ](https://app.notion.com/p/3afa6def75f88258ad64812c0fdb5f20) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.3 | [[8.3] 유입→탐색→동행 퍼널·KPI 설계 ](https://app.notion.com/p/51da6def75f882c0bf48010b1e029e9b) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.4 | [[8.4] Reels·TikTok·Threads 콘텐츠 필러·오가닉 테스트 설계 ](https://app.notion.com/p/7e9a6def75f883eb8bc1815ee3d55118) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.5 | [[8.5] 출시 단계별 콘텐츠 실행 계획 초안 ](https://app.notion.com/p/ea2a6def75f883dd9e00812bad9ece52) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.6 | [[8.6] Instagram·TikTok·Threads 소개·프로필·이동 경로 준비 ](https://app.notion.com/p/488a6def75f882609205014292eeb1d4) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.7 | [[8.7] 첫 세로 영상 1개와 채널별 변형 만들기 ](https://app.notion.com/p/e72a6def75f882b5b28881cb572e596a) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.8 | [[8.8] 첫 Threads 글·Instagram/TikTok 게시 문구 만들기 ](https://app.notion.com/p/24ba6def75f883a0ba9d0162f7a45541) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.9 | [[8.9] AI 콘텐츠 자동화의 입력자료·단계·검수 기준 정하기 ](https://app.notion.com/p/5b3a6def75f8828eaf4781e582b6cd39) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.10 | [[8.10] AI 대본·음성·자막으로 콘텐츠 한 묶음 시험 제작 ](https://app.notion.com/p/1d7a6def75f88317a01301f6449c69c5) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.11 | [[8.11] 반복 제작 템플릿·승인 대기 목록으로 두 번째 콘텐츠 만들기 ](https://app.notion.com/p/f48a6def75f8821f9797015e030ef774) | Brand&Marketing | 유미 | 대기 | P2 |
| 8.12 | [[8.12] 승인 콘텐츠의 채널별 게시·기록 ](https://app.notion.com/p/7ffa6def75f88298b4b881bc8bbe447a) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.13 | [[8.13] 비공개 베타 참여자 모집·참여 선택 확인 ](https://app.notion.com/p/76ba6def75f88219b8f4016075899901) | Brand&Marketing | 유미 | 대기 | P0 |
| 8.14 | [[8.14] 초기 동행 공고 공급·첫 이용 안내 준비 ](https://app.notion.com/p/d79a6def75f882efbfff812e108cca6d) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.15 | [[8.15] 출시·콘텐츠·AI 운영의 비용과 시간 범위 검토 ](https://app.notion.com/p/f8fa6def75f88371ba83015c11adf3cc) | PM/기획 | 유미 | 대기 | P1 |
| 8.16 | [[8.16] Google Play 앱 소개·스토어 문구 작성·검수 ](https://app.notion.com/p/6eda6def75f88230ab1901cf5bccb26c) | PM/기획 | 유미 | 대기 | P0 |
| 8.18 | [[8.18] 게시 반응·유입 경로 기록·다음 소재 결정 ](https://app.notion.com/p/e71a6def75f88216b6500157a7450b9e) | Brand&Marketing | 유미 | 대기 | P1 |
| 8.19 | [[8.19] 개인 Play 개발자 계정의 검증·생성 시점·테스트 요건 확인 ](https://app.notion.com/p/ef4a6def75f882418105812cc66bbe0b) | PM/기획 | 민규 | 대기 | P0 |
| 8.20 | [[8.20] 베타 설치·사용·피드백 제출 안내 만들기 ](https://app.notion.com/p/9c3a6def75f88363aa11812912a0f1c5) | PM/기획 | 유미 | 대기 | P0 |
| 8.21 | [[8.21] Play 데이터 보안·등급·콘텐츠·심사 접근 자료 준비 ](https://app.notion.com/p/f51a6def75f8832da0fc018439d947d9) | PM/기획 | 유미·종현 | 대기 | P0 |
| 8.22 | [[8.22] 비공개 테스트 요건 충족 확인·정식 출시 권한 신청 ](https://app.notion.com/p/17aa6def75f882f58328814711fa46b8) | PM/기획 | 민규 | 대기 | P0 |
| 8.23 | [[8.23] Android 제출 자료 최종 대조·심사 제출 ](https://app.notion.com/p/6f5a6def75f883b88856013b84464959) | PM/기획 | 민규 | 대기 | P0 |
| 8.24 | [[8.24] 심사 결과 확인·반려 사유 분류·재제출 관리 ](https://app.notion.com/p/acda6def75f883de8f500196e84f1639) | PM/기획 | 유미 | 대기 | P0 |
| 8.25 | [[8.25] Android 정식 공개 실행·스토어 노출 확인 ](https://app.notion.com/p/b7fa6def75f883698dfb0100390d273e) | PM/기획 | 민규 | 대기 | P0 |
| 8.26 | [[8.26] 지원메일·삭제 요청 접수·응답 경로 시험 확인 ](https://app.notion.com/p/0e7a6def75f883e4a031012d55e96328) | PM/기획 | 유미 | 대기 | P0 |
| 8.27 | [[8.27] 필요한 지출의 사전 승인·집행·증빙 관리(발생 시) ](https://app.notion.com/p/f09a6def75f88327ada681fde7d4cc0b) | PM/기획 | 유미 | 대기 | P2 |
| 9.1 | [[9.1] 신고·개인정보·지원 운영 체계 검토 ](https://app.notion.com/p/f9aa6def75f882ae8c9901f42b34617a) | Ops | 유미 | 작업 중 | P0 |
| 9.2 | [[9.2] 출시 직후 문의·리뷰·첫 사용 문제 확인과 개선 결정 ](https://app.notion.com/p/391a6def75f883cda74b811d988e9fde) | Ops | 유미 | 대기 | P1 |

## 삭제 표시5행의 보존 기록

| WBS ID | 업무 항목 | 마지막 담당 속성 | 실제 상태 | 조회 사실 |
|---|---|---|---|---|
| — | [(제목 없음) ](https://app.notion.com/p/618a6def75f88393a05301dbb31944ff) | 미배정 | 대기 | deleted; 자동 시작 제외 |
| — | [(제목 없음) ](https://app.notion.com/p/8ffa6def75f8825b8d8f81e0c93c1a15) | 미배정 | 대기 | deleted; 자동 시작 제외 |
| — | [(제목 없음) ](https://app.notion.com/p/a04a6def75f88392a0af010f96b510df) | 미배정 | 대기 | deleted; 자동 시작 제외 |
| — | [TASTK ](https://app.notion.com/p/c4da6def75f8825d93ae01a8f4717fb7) | 미배정 | 대기 | deleted; 자동 시작 제외 |
| 8.17 | [[8.17] 공개 개인정보·탈퇴 요청·고객지원 문서 검수·게시 준비 ](https://app.notion.com/p/df3a6def75f8827f910501d4d189d4ab) | 유미·종현 | 대기 | deleted; 자동 시작 제외 |

## 기존 완료 범위 보존

`배포 환경 설정`의 현재 담당 속성은 민규지만 Railway 결제·GitHub 연결의 완료 수행자는 유미다. 그 완료 근거를 보존하고 서버 정상 동작·운영 DB·Runner·복구는7.1 잔여로 구분한다. 7.6은 로컬·가상 소비자 검증의 완료 범위이며 운영 배포·실회원·후속 요약/AI22/23까지 완료로 확대하지 않는다. 다른 최종 완료/배포 완료 카드도 해당 노션 기록의 범위로만 해석한다.

기계 판독 원본은 [카탈로그 JSON](2026-10-14-wbs-task-catalog.json)이다. 페이지 ID·URL·담당 계정 ID·실제 상태·삭제 여부·일정·관계·편집 시각을 보존했다. 현재 실행 권한은 [최신 역할 재배정](2026-10-14-role-reassignment.md)과 [소유권 정책](../../../../backend/ownership.json)을 대조한다.

## 업무별 저장소 진입 후보

JSON의 모든 작업에는 `repo_entrypoints.mapping = candidate`와 `paths`를 넣었다. 노션 본문과 실제 소스의 정확한 대응 파일을 아직 확정한 목록이 아니다. 아래 경로에서 기존 기능 경계와 가장 구체적인 owner를 확인하고 작업별로 대상 파일을 정한다.

| 업무 영역 | 기존 읽기·구현 진입 후보 | 경계 |
|---|---|---|
| BE | `backend/contracts/`, `backend/supabase/functions/`, `backend/supabase/migrations/` | 민규 서버 계약·인증·DB·RPC·SQL |
| AI | `_shared/ai/Agents/chatbot/`, `Agents/review-summary/`, `ai/providers/`, `ai-chat/`, `review-summary-worker/` | 앞의 생략 경로는 `backend/supabase/functions/` 및 같은 `_shared/ai/` 아래 기존 경로; 민규 전담 |
| 서버 OPS | `backend/contracts/`, `backend/supabase/functions/scheduled-jobs/`, `_shared/jobs/`, `tools/local/` | 민규; 운영 실행·VM 경계 유지 |
| FE·UX/UI | `frontend/`, `apps/mobile/src/screens/`, `app/`, `components/`, `apps/mobile/design/`, `docs/planning/design/` | 종현; 새 presentation은 props로 표시·이벤트를 받음 |
| 앱·서비스 연동 | `apps/mobile/src/service.ts`, `remote.tsx`, `api.ts`, `member-session.ts`, `member-service.ts`, `web-member-session.ts` | 종현 클라이언트; 민규 서버·domain 계약 소비 |
| 빌드·출시 기술 준비 | `apps/mobile/` | 종현 기술 준비; 민규 Console 조작과 유미 출시 판단·별도 실행 조건 유지 |
| PM·Brand·지원 준비 | `docs/collaboration/requests/yumi/`; `정책.md`·`PLAN.md`·`docs/planning/requirements/` 읽기 | 요청/yumi 경로는 아직 생성 전의 허용 산출물 후보. 유미가 공통 정책/요구사항을 직접 수정하지 않음 |
| UT | `docs/planning/ut/`, `requests/yumi/` | 유미 시나리오·판정·관찰·개선 Task 자료 |
| QA | `tests/database/minkyu/`, `tests/functions/minkyu/`, `tests/frontend/`, 지정 `tests/functions/jonghyun/`, `docs/planning/ut/` | 세 사람 공통 판정·영역별 파일 단독 수정; 폴더명만으로 owner를 판단하지 않음 |

각 Task의 후보 경로는 JSON 레코드에서 확인한다. 삭제 표시 작업에도 역사 카탈로그 대응을 보존하되 자동 실행하지 않는다. 이번 수집은 새 코드·테스트·노션 Task 생성이나 정책 확정이 아니다.
