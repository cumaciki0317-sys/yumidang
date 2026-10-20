<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **AI 선택 동의:** AI 탐색은 첫 사용 동의·거절 시 일반 검색 유지. 후기 AI는 가입 시 열람/내 프로필 생성·노출/작성 후기 활용의 세 선택 항목·기본 미선택이며 전체 동의 편의 기능과 독립 철회를 제공한다. 기존 테스트 계정 간주와 실회원 동의 증거를 구분한다.
> **공급사·비용:** 포텐스닷 공급사 회신은 수신됐고 교육·프로토타입 조건과 보안 우려로 실서비스 대체 API를 권고했다. Gemini는 종현 테스트 프로젝트·월50,000원 사용중단 예산·합성3건 검증 상태이며 최종 청구 상한 보장/운영 연결은 별도다. 대표 유미 계정 전환은 회의 때 확인한다. 포텐스닷320만 기술 토큰과 Gemini 원화 예산을 혼합하지 않는다. 실회원 원문 전송 HOLD.
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# 민규 의존 작업을 제외한 종현 구현 결과

> **2026-10-20 행사 UX 현행 기준:** 이 문서는 작성 당시의 설계·구현·검증 기록입니다. 현재 제품 결정은 [행사 UX 최종 확정 기준](2026-10-20-event-ux-approved-spec.md)을 따릅니다. 작성용 날짜 겹침 강제·동행 일정 자동 검색 축소는 적용하지 않습니다. 직접 입력은 공고 전용이며, 확실한 공식 동일 개최 근거가 있는 원천만 대표 행사로 통합합니다. 비표출/충돌 처리는 현행 명세를 따르며 당시 API/검증 결과가 새 기능 완료를 뜻하지 않습니다. 아래 과거 실행·응답·PASS·미지원 기록은 보존합니다.


2026-10-08. 사용자 최신 요청: “민규 작업이 필요한 부분 빼고 나머지 작업부터 다 구현해줘.” 기존 구현을 보존하고 독립적으로 해결할 수 있는 누락을 재감사하여 보완했다. actor `jonghyun`, 독립 clone `/private/tmp/yumidang-jonghyun-implementation-20261007`, branch `jonghyun/queue-integration`, baseline `40f3c1d70f0cf83b87feaaad9939354985758921`이다. 민규·성호 소유 파일, SQL, 공통 인증·환경·hook은 수정하지 않았다.

## 요구와 실제 구현

| 요구/근거 | 현재 소스와 반영 | 이번 증거 |
|---|---|---|
| IA S00 실명·알림·약속·D-day·공개 지역 | BrowseScreens AccountHeader/Home에서 RemoteAccountHeader·RemoteUpcomingAppointments 사용. 기존 /me·/appointments 소비, 서버 시각 기준 남은 일정·진행 중, 미확인 시각 안내 | 합성 브라우저 홈 실명·확정 약속·D-1·지역·알림 이동 |
| IA S11 작성자의 신청 거절 | RemoteChat의 pending author 거절 확인·기존 requestAction(decline). 취소/확정 요청 철회와 구분 | 확인 전 전송0·확인 취소0·503 뒤 화면 유지와 자동 재전송0·명시 재시도 후 거절 상태 |
| IA S10 대화 상태 | RemoteChats의 서버 request_status 표시 | 신청 대기·거절 badge 표시 |
| IA S13→S14 내 공개 프로필 | RemoteMe의 확인된 profile.userId로 공개 프로필·후기 진입 | 해당 ID 경로와 공개 프로필 렌더 |
| USERFLOW 행사 상세→작성 | RemoteEventDetail의 active/미종료 모집 진입. CreateForm/PublishForm의 useRemoteEventSource로 행사 정보 재조회, 행사장 이름 후보 검색 입력, 기존 일정 보존 | 행사 ID·제목 연결, 행사장 후보 입력, 취소 행사 진입 없음 |
| 정책 시작 이후 일방 취소 불가 | appointmentCancellationGate의 서버 시각+수신 후 경과. 상세 버튼/취소 화면 분기, 제출 직전 재검사, 최종 권한은 서버 | 시작 전 취소 양식·시작 후 신고만·서버 시각 없으면 취소 없음 |
| 읽음 포트 교체 뒤 늦은 응답 차단 | 기존 본문 노출 ID 읽음에 포트 교체 시 측정/요청 중단·집합 초기화·현재 본문 재측정 추가 | 함수 경계 검사 및 긴 본문/미노출/중복/포트 부재 브라우저 회귀 |
| 실행기 예약 교체·stop | background arm의 이전 타이머 해제·handle 일치 검사. 옛 콜백이 최신 예약 삭제/깨우기 못함 | 작업 due+helpful 미래 예약 조합 stop·옛 콜백 검사, runner 관련69 PASS |
| AI 정상 추가 질문/기록 | 제품의 기록 준비 조건 유지. policy-guards의 누락된 합성 recordResultAvailable 포트 정정 | 정상 질문 record1→finish1·잘못된 입력 추가 기록0, AI 관련184 PASS |
| 기존 AI·검색·행사·요약·모바일·작업 코어 | 현재 계획·상세 설계·정책·IA·흐름과 담당 소스 대조. 재구현 없음. 본인 공고·피드백·일정·사진·취향·이의·숨김 해제 기존 기능 보존 | 아래 전체 자동 검사 및 이전 범위별 증거와 구분 |

`Remote*`·`BrowseScreens`는 `apps/mobile/src/screens/`, cancellation helper는 `apps/mobile/src/member-service.ts`, background는 `backend/supabase/functions/_shared/jobs/background.mjs`다. 새 endpoint·RPC·서버 wire를 추정하지 않았다.

## 최종 검증

- functions/AI/contracts 및 합성 discovery integration **56파일 657/657 PASS**, 실패·건너뜀0. 로그 `/private/tmp/yumidang-independent-all-tests.log`. DB/Auth를 생성하는 실제 통합 스크립트나 live 공급사 실행은 제외했다. AI 검사까지 포함해 이전 functions 단독532와 혼용하지 않는다.
- 모바일 TypeScript PASS, Expo lint 오류0·경고0. 웹 clear export와 iOS/Android Hermes export PASS. 로그 `/private/tmp/yumidang-independent-web-build.log`, `/private/tmp/yumidang-independent-native-build.log`. 번들을 실제 설치·네이버 로그인 성공으로 표현하지 않는다.
- localhost Expo+Chrome390×844: 추가 흐름 **17조건 PASS**, 기존 읽음 **13조건 PASS**. 합성 세션·mock HTTP/읽음 포트이며 실제 회원·DB·Storage·provider·native 증거는 아니다. 처음 추가 화면 검사에서 이전 숨겨진 행사 화면과 현재 작성 화면의 같은 제목이 중복 선택되어 실패했고, 현재 화면 선택자를 정정한 뒤 통과했다. 최종 표시 보완 후 웹 재빌드가 교체한 폴더를 임시 서버가 참조해 연결이 한 번 중단됐고, 서버 예외의 삭제된 cwd 원인을 확인해 새 산출물 폴더에서 재실행했다.
- 브라우저 영수증과 화면은 `/private/var/folders/h7/6qzd7cp553q1qwhk592yhvs80000gn/T/yumidang-independent-dizfjczs/independent-evidence/receipt.json` 및 `evidence/receipt.json`. canonical/preview 4개 핵심 파일 해시 일치, 예상외 외부 요청·pageerror0. 테스트 route/합성 회원/포트는 임시 프리뷰에만 생성했다.
- 소유권·하네스 단독 수정·공백·언어 혼입·원본 보존 **34경로 PASS**, 중복/허용밖0. 최종 기록은 `/private/tmp/yumidang-independent-final-audit.json`이다. 임시 프리뷰 서버와 dependency symlink는 종료·제거하며 결과 증거는 보존한다.

GPT/Codex 구현·대체 실행·자체 검증이다. Gemini 독립 검증·출시·실사용 성과가 아니다.

## 이번 구현에서 제외한 의존성

- **민규:** 원자적 처리 항목 배정, 자기 토큰/경쟁 점유 만료 일정, 영속 intent·UNKNOWN 복구, token-scoped helpful endpoint, 회원 정리 배정 limit, 메시지별 읽음 DB/HTTP 및 기존 집계 호환, 행사별 관련 공고 검색 계약, 실제 인증/native 등록·Storage·격리 환경. 상세 입출력·증거는 [공통 연결 계약](2026-10-08-followup-common-contracts.md)에 남겼다.
- **기존 공급사·팀 보류:** 승인된 운영 개인정보/의미·근거 검사 자료, 공식 출력 상한 필드, 공급사 보관·삭제·회원 원문 전송 조건, KOPIS 기간 증명·서울 HTTPS 경로, 실제 계정·기기·운영 전환. 이번 포괄 구현 요청으로 기존 보류를 임의 해제하지 않았다. 합성 검사/주입 준비와 운영 readiness는 구분한다.

현재 승인된 독립 구현 범위는 완료했다. 실제 통합·외부 조건·출시 전체 완료는 아니다. 새 정책 충돌이나 추가 역질문은 없다. 커밋·푸시·배포·외부 메시지는 수행하지 않았다.

## 사용자 후속 승인: 커밋·푸시 제출

2026-10-08 사용자가 “푸시/커밋 ㄱㄱ”라고 승인했다. 검증된 종현34개 변경 경로만 별도 clone의 `jonghyun/queue-integration`에 커밋하고 같은 origin 브랜치에 일반 푸시한다. 원격 종현 `edfc624`와 민규 `40f3c1d`를 조회했고 현재 HEAD의 조상 관계를 확인한다. 정상 hook·staged 소유권·변경 경로를 검사하며 운영 활성화·민규 원본 편집으로 확대하지 않는다. 위 미커밋 설명은 구현 단계 당시 상태이며 실제 제출 결과는 Git HEAD와 원격 해시로 확인한다.
