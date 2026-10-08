> 최신 추가 요청: 민규 의존을 제외한 독립 누락 보완은 [독립 구현 결과](2026-10-08-independent-result.md)를 따른다. 아래는 이전 후속 연결 단계의 증거다.

> 후속 사용자 선택: 질문1A·2A·3A 모두 확정. 요청ID 오탐수정과 메시지별/본문일부노출 소비자 보완을 진행한다. 실제공통포트·환경은 민규준비후통합으로 결정했다. 아래 최초검사와 당시미결표현은 이 선택전증거이며, 최종 보완결과는 후속절을 따른다.

# 종현 후속 연결 구현·검증·잔여 판단

2026-10-08. 사용자 승인 설계와 추천안 선택3묶음을 적용했다. 작업 공간 `/private/tmp/yumidang-jonghyun-implementation-20261007`, actor `jonghyun`, branch `jonghyun/queue-integration`, baseline `40f3c1d70f0cf83b87feaaad9939354985758921`이다. 민규 원본은 수정하지 않았다. 로컬 민규 최신 인계를 독립 clone에 fast-forward 수신했으며 새 커밋·푸시·운영 배포는 없다.

## 요구별 실제 판정

| 요구 | 결과와 근거 | 미완료/한계 |
|---|---|---|
| 독립 작업본/최신 인계/담당 분리 | 위 baseline 수신, 파일별 단독 수정 하네스, jonghyun actor/hook 유지 | root 민규 브랜치·인덱스 보존 |
| AI 정상3종 증거·순서 | handler 최종 privacy → 서버scope recordAiResultAvailable → finish → 응답. 실제 포트 조립 및 정상/실패 handler 검사 PASS | 실제 DB/외부AI 미실행. UUID 오탐은 선택1A 수정·검사 완료 |
| AI 실패·차단·취소·기록 실패 | 정상 증거/성공 반환 차단, finish 응답유실 자동 재전송 방지, late-model 만료검사 PASS | 기록RPC 시작 뒤 취소는 이미 시작된 기록을 취소하지 못할 수 있음; 화면 열람증거 아님 |
| helpful 정상응답 범위 | results/no_results/needs_clarification 기록 및 기존 정상3종 UI 렌더. actual handler+RPC adapter fixture helpful 허용/거절 PASS | 만료·탈퇴 거절은 합성 DB응답 검사이며 이번 SQL증거 아님 |
| helpful 만료 예약 | DB schedule/원자reservation 주입형 소비자와 그룹 준비, 기존 HTTPS 내부API·bounded limit·abort·응답유실 보존 검사 PASS | DB nextDue/알림/영속intent/token-scoped endpoint 미제공. 실제예약·파기 미완료. 매일cron 대체 없음 |
| 본인 공고 | /me/posts 페이지·관리·수정 권한 소비. 무신청 본인공고 브라우저 표시·관리 PASS | 실제 Auth/DB·기기 검증 별도 |
| 읽음 DTO/메시지별 포트/표시 | 선택2A: 본문 일부 양수 노출 ID만 전송, ID별 확인·중복 억제·늦은 측정/응답 차단. 긴본문 포함 브라우저13조건 PASS | 실제 메시지별 서버 계약 미제공. 포트 없으면 준비 중·전송0, 기존 watermark 대체 호출 없음 |
| 행사 상세/공식순위 | 실제 상세경로·취소표시, 선택기의 기존취소제외 유지. /events/rankings 무query not_enabled 계약 수용 및 handler/client 검사 PASS | KOPIS 공급사 보류 유지, 실제 공급사/회원DB 별도 |
| 숨김·인증 | 기존 숨김목록/해제·서버필터 계약 유지. 명시적 웹구성공급+RootLayout 설치/restore 연결 | 신규숨김 선택hold, 실제배포값/native등록·메모리외세션복구 계약 미제공 |
| 공유20 항목 | reserveItem 필수, 첨부DELETE+완료1항목/metadata별도1, RPC reserve별도, counts.processedItems. allocate≤input.limit·한도소진hold PASS | 원자 DB항목예약 실제포트 및 기존소비자/회원정리 배정limit 연결 필요 |
| 일정/복구/runtime | 명시주입 shared runtime·같은token/limit/time/signal, terminal/helpful group, stop중단/UNKNOWN 보존. 늦은조회 취소후 새dispatch 결함 수정 PASS | 자기token·외부점유만료조회·영속journal 공통계약 미제공. CLI 실제5kind/helpful 미조립 |
| 실제 두 runner/연결유실/재시작 | 모형 및 과거 민규 소비자시험을 제품증거로 쓰지 않음 | Docker socket 없음·기존 격리서비스 LISTEN 없음. TLS/전용LOGIN/HTTPS 환경 미준비로 NOT_RUN |
| 제품 전체 완료 | 승인된 담당 로컬구현·검증·연결요청 산출물 준비 | 실제통합·메시지별 읽음 서버 계약·공급사/기기/운영 남음. 전체목표 완료 아님 |

## 검증 증거

- 종현 functions 전체: `/private/tmp/yumidang-followup-all-functions.log`, **519/519 PASS**, 실패/건너뜀0. 이후 조회경합 계약을 검증하는2개와 주석이 추가되어 해당 영향67개를 재검사했다. 이 부분집합을519에 중복합산하지 않는다.
- AI 신규20/기존39, 실행기 초기관련106 및 후속67, 모바일68은 위 전체와 일부 겹친다. 다른 검사집합을 전체 진행률로 환산하지 않는다.
- 모바일 TypeScript PASS, Expo lint error0/warning0. 기존 설치캐시를 임시 node_modules symlink로 재사용하고 종료 후 symlink를 제거했다. package/lock 변경·새 패키지 설치 없음.
- Deno: `/private/tmp/yumidang-followup-deno.log`, AI/scheduled 진입점·helpful 소비자 PASS. 소유권/하네스·변경 공백 검사는 최종 audit를 따른다.
- Expo 웹 build PASS, `/private/tmp/yumidang-followup-web-build.log`. 프리뷰는 canonical source의 별도 복사이며 임시 test-session route는 제품 clone에 만들지 않았다. 캐시의 이전경로 표시를 보고 clear build로 다시 검증했다.
- Chrome390×844 실제 화면 **9조건 PASS**: 무신청본인공고 관리, 보인메시지 읽음, 화면밖최신 미읽음, 스크롤 후 위치상승, 중복전송0, exact body, 합성인증, pageerror/예상외요청0. 실제Auth/DB/provider/device 증거 아님.
- 브라우저 receipt/screenshot: `/private/tmp/yumidang-followup-browser-eg46u1nm/evidence/receipt.json`, `own-post.png`, `chat-initial.png`, `chat-scrolled.png`. canonical/preview의3개 핵심 source SHA256 일치 검증 포함. 추가 관찰 `chat-long-message.png`: 긴메시지 전체스크롤 뒤 읽음전송0, 이 관찰은 완료조건PASS가 아니다.
- iOS/Android 번들: `/private/tmp/yumidang-followup-native-build.log`, `/private/tmp/yumidang-followup-native-bundles`, PASS. 설치앱·실기기·서명·네이버 복귀 검증으로 표현하지 않는다.
- 원격 읽기 확인: M foundation40f3c1d/J edfc624/M handoff2d4cbf4. 현재 로컬baseline과 동일한 M최신이며 신규공통 SQL100은 확인되지 않았다. 기본sandbox DNS실패 뒤 승인된 읽기조회로 확인했고 원격을 변경하지 않았다.

GPT/Codex 구현·대체 실행·자체 검증과 읽기전용 독립 코드리뷰다. Gemini 독립검증·실회원·운영 성공이 아니다.

## 선택 전 재현 근거와 질문 기록 (모두 A로 결정됨)

1. **개인정보 검사 오탐:** 보조 containsContact는 `{requestId:'a0101234-5678-4abc-8abc-333333333333',status:'no_results',cards:[]}`를 연락처로 판정한다. 서버 생성 유효형식 합성UUID로 재현했다. 검사필드 제외를 임의확정하지 않았다. 추천: 최종 응답에서 서버 생성requestId만 별도 UUID형식검증하고 개인정보본문 검사에서는 분리한다. 사용자입력 clientRequestId/대화/모델문장은 계속검사한다. 후속 사용자 선택1A로 승인되었다.
2. **읽음 의미 충돌:** 현재 DB 마지막읽음 위치는 이전전체도 읽음처리한다. 실제표시되지않은과거를 제외하려면 M의 메시지별읽음 계약확장이 필요하다. 긴카드는100%노출조건을 충족하지 못한다. 추천: 보인메시지ID 기준의 서버계약을 요청하고, 본문이 실제화면에 나타났을때 읽음으로 처리하는 기준을 확인한다. 기존watermark를 유지하면 그한계를 사용자결정으로 명시해야 하며 임의로선택하지 않는다.
3. **실제 연결 준비:** [공통포트 요청](2026-10-08-followup-common-contracts.md)의 원자항목배정·nextDue·영속기록·token fence·member cleanup 배정과 격리TLS/LOGIN/HTTPS환경이 미제공이다. 추천: M공통준비후 같은코드로 실제통합검증한다. 운영권한확대나 준비false를true로 바꾸어 대체하지 않는다. 비밀정보 대신 인계문서/브랜치만 확인한다.

웹승인값/native등록·실제적격 네이버계정·공급사조건의 기존보류는 새정책질문으로 다시확정하지 않는다. 공통준비없이는 제품runner 검증을 완료처리하지 않는다.

## 최종 작업공간 확인

`/private/tmp/yumidang-followup-final-audit.json`: 변경30경로 actor소유권·단독하네스·baseline/branch·언어혼입·공백 PASS, 중복0/허용밖0. 최초 audit에서 검사 import가 만든 bytecode cache를 발견하여 해당 임시 cache만 정리하고 bytecode생성을 끈 재검사로 통과했다. 민규 원본은 `minkyu/foundation-harness`/40f3c1d/clean으로 동일하다. 임시 node_modules symlink와 localhost8099 프리뷰 서버는 종료·정리했다. 브라우저영수증과 native/web산출물은 재현증거로 private/tmp에 보존한다.

## 사용자 선택1A·2A·3A 후속 반영

세 선택은 확정되었으며 같은 질문을 다시 요구하지 않는다.

- **1A 완료:** 서버 `result.requestId`의 UUID 형식과 context 일치를 확인한 뒤 그 필드 하나만 최종 본문 검사에서 분리했다. 연락처 형태 합성 UUID의 정상3응답, 위조·비정상 ID 거절, 입력/모델/카드 연락처 차단을 포함해 AI 신규29+기존39 총68개와 Deno 타입 검사가 통과했다. 공통 개인정보 검사기는 변경하지 않았다.
- **2A:** 실제 화면에 나타난 메시지 본문 ID별 읽음 소비자를 보완한다. 본문 일부 노출도 포함하며 기존 마지막 읽음 위치를 대체 호출하지 않는다. 민규의 실제 계약이 없으면 준비 중으로 표시하고 전송하지 않는다. 모바일 관련70개·TypeScript·lint(0오류/0경고), 실제 localhost 브라우저 합성13조건이 통과했다.
- **3A:** 민규가 원자 항목 배정·일정·영속 기록·메시지별 읽음 포트와 격리 환경을 제공하면 실제 통합을 이어간다. 현재 실제 연결은 미완료다. [공통 연결 계약](2026-10-08-followup-common-contracts.md)에 필요한 입력·보장·증거를 남겼으며 외부 메시지를 보내지는 않았다.

### 선택 반영 후 최종 검증

- functions 전체45개 파일 **532/532 PASS**, 실패·건너뜀0: `/private/tmp/yumidang-followup-final-functions.log`. 최초 실행은 디렉터리를 Node 검사 파일로 넘겨 실패했고, 실제 검사 파일 목록을 명시해 다시 실행했다. 이는 제품 결함 판정이 아니다.
- Expo web clear build PASS: `/private/tmp/yumidang-followup-per-message-web-build.log`. iOS/Android clear export PASS: `/private/tmp/yumidang-followup-per-message-native-build.log`, 산출물 `/private/tmp/yumidang-followup-per-message-native`. 기기 설치·실제 네이버 복귀 증거는 아니다.
- Chrome390×844 **13조건 PASS**: 포트 부재 안내/전송0·watermark 호출0, 본문 노출 ID별 읽음, 화면밖 최신 미전송, 스크롤 후 새 ID만 전송, 중복 억제, viewport보다 긴 본문의 일부 노출 처리, 본인 공고 관리, 합성 인증 및 예상외 요청/화면 오류0.
- 영수증·화면: `/private/var/folders/h7/6qzd7cp553q1qwhk592yhvs80000gn/T/yumidang-followup-per-message-wija321c/evidence/receipt.json` 및 `chat-long-message.png`. canonical/preview 핵심4파일 SHA256 일치. `test-session`과 합성 읽음 포트는 프리뷰 복사에만 있고 제품에는 없다. 첫 브라우저 실행은 임시 서버의 SPA 경로404로 실패하여 서버 경로 처리를 고쳐 재검사했다.
- 서버 실제 wire를 추정하지 않았으며 port의 `{confirmedMessageIds,unreadCount}`는 내부 DTO다. 계약 도착 후 adapter·실제 Auth/DB 경쟁·unread 정확성 검증이 필요하다. 자동 검사나 합성 포트 성공을 그 결과로 대신하지 않는다.

새 미결 정책 질문은 없다. 다음 의존성은 선택3A의 민규 공통 계약과 격리 환경이다. 전체 실제 통합 완료로 표시하지 않는다.
