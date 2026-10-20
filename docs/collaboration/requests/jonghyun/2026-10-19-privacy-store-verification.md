# 개인정보·스토어 외부 확인과 다음 연결 과제

확인일: 2026-10-19. 작업자 jonghyun. 최신 독립 clone 정책과 기존 민규 개인정보 목록·삭제/백업 기록을 대조하고 공식 공개 기준을 조회했다. 개별 서비스의 법적 적합성 확정·스토어 승인·실제 운영 검증은 아니다. 소스/DB/운영 설정/외부 메시지/회원 원문 전송은 변경하지 않았다.

## 최신 사용자 결정 — 후기 AI 가입 선택

사용자 답변: “가입 때 AI는 선택으로 받고, 미동의해도 일반 동행 이용 허용 (추천)”. 이 답변이 이전 가입 필수 의도보다 우선한다.

- 가입 화면의 후기 요약 열람·본인 요약 생성/노출·본인이 쓴 후기의 활용을 각각 선택 항목으로 받는다. 기본 미선택이다.
- 전체 동의로 같은 화면의 항목을 일괄 선택/해제할 수 있고 개별 상태와 전체 상태를 동기화한다. AI 선택 항목을 고르지 않아도 가입·일반 동행·공고·채팅·일반 후기를 이용한다.
- 각 항목 미동의는 해당 AI 기능/처리만 제한한다. 다른 두 항목에 자동 동의하거나 자동 철회하지 않는다. 예: 본인 요약 생성에 미동의해도 열람에 동의했다면 다른 회원의 허용된 요약은 볼 수 있다.
- 독립 철회·원문 활용 철회 때 영향 요약 숨김/적격 재생성·외부 삭제 확인 전 완료 표시 금지 등은 유지한다.
- AI 탐색 첫 사용 동의·거절 시 일반 검색 유지는 변경하지 않는다.
- 열람 항목이 개인정보 처리 동의인지 기능 안내/이용 선택인지의 법적 문구 분류는 추가 확인 대상이다. 선택으로 바꾼 것만으로 국외 이전·위탁·처리방침·삭제 조건이 완료되는 것은 아니다.

## 공식 근거와 적용 해석

| 항목 | 공식 기준 | 유미당 적용 및 상태 |
|---|---|---|
| 최소 수집/선택 동의 | 개인정보 보호법 제16조·제22조: 최소 필요 외 수집·선택 동의 거부로 서비스 제공을 거부하지 못하도록 함. 개별 동의 구분·명확한 고지 | AI 없이 일반 동행을 유지하는 정책과 가입 필수 AI의 충돌 위험을 사용자에게 설명한 뒤 선택으로 변경 승인. 전체 동의 편의 기능은 개별 고지를 대신하지 않음 |
| 철회 | 제37조 처리정지·동의 철회와 필요한 조치 | 최신 독립 철회 방향 유지. 대기 작업·새 외부 전송·기존 영향 요약·외부 사본/실패 추적의 실제 구현 검증 필요 |
| 기록 보관 | 제15조의 처리 근거·정당한 이익 요건, 제21조 불필요한 개인정보 파기 | 신고/제재 상세 90일과 승계 목적 중 최소 기록 유지는 운영 선택. 법정 기간/자동 적법으로 표시하지 않음. 목적·최소항목·필요성·종료조건·더 짧은 대안·권리영향을 민규/대표가 자료로 확인 |
| 외부 AI | 제26조 위탁, 제28조의8 국외 이전 등 적용 근거 | Gemini 실제 계약 주체·처리 성격·국가·항목·로그/보유·재위탁·삭제를 확정. 모든 국외 이전이 무조건 별도 동의라는 단정도 피함. 합성 테스트 통과는 실회원 원문 전송 승인 아님 |
| 테스트 계정 | 실존인 개인정보면 처리 근거는 별도 필요 | 기존 테스트 시나리오의 동의 간주는 유지. 실제 동의 증거/DB 쓰기/실회원 전송 승인으로 확대하지 않음 |
| Google 계정 삭제 | 앱 내 삭제 경로와 외부 웹 요청 경로, 필요한 보존의 이유/범위 안내 | 공개 정책의 눈에 띄는 이메일 요청 구역은 가능한 형태. 실제 공개 URL·메일 도착·본인 확인·결과 안내·삭제 동작 검증은 미실행 |
| Apple 로그인 | 4.8 외부 로그인에 대한 동등한 대안과 예외 | 네이버 프로필 정보 수신만으로 시민 신원확인 예외 인정이라고 보지 않음. 기존 iPhone 배포/계정 준비 보류를 유지하며 다른 로그인 수단을 임의 추가하지 않음. 지금 같은 결정을 재질문하지 않음 |
| Apple 탈퇴 후 UGC | 삭제 FAQ는 후기·게시물 등 사용자 콘텐츠도 계정 삭제 범위로 설명 | 현재 익명 후기 유지·탈퇴 공고 일반 본문 1년 유지와 조건부 충돌. 단순 이름 제거로 삭제 준수 단정 금지. iOS 준비 전 별도 재검토. 지금 확정한 보관 정책을 임의 삭제/단축하지 않음 |
| AI/사용자 콘텐츠 | Google 생성 AI 신고 기능, Apple UGC 신고·차단·필터·연락처 | 현재 정책에 신고가 있다는 점과 실제 AI 결과에서 신고가 작동하는지 구분. 앱/서버 연결·처리 담당·회신 실제 검증 필요 |

## 구현·계정 설정에서 실제 확인할 것

1. 민규: 동의 항목/버전/시각 증적과 서버 게이트, 가입 시 AI 미동의 허용, 철회 후 대기 작업과 외부 전송 차단, 요약의 원문 근거 연결·숨김·적격 재생성. 기존 RPC·SQL이 이미 새 정책과 맞는다고 표시하지 않는다.
2. 종현: 선택 라벨·기본 미선택·전체 동의 동기화, AI 선택 해제 후 가입 가능/일반 기능 유지, 각 AI 기능 제한·재동의 안내. 실제 앱 코드 변경은 이번 문서 동기화와 별도이다.
3. 민규/대표: 목적별 데이터 표, 최소 제재 연결의 정당한 이익 등 근거와 필요성, 상세 자료 90일·채팅/공고 1년의 목적·기산점·삭제/예외. 사용자가 고르는 기간만으로 법적 근거를 대신하지 않는다.
4. 민규: 실제 호스팅 종류/리전/계약/백업 설정과 DB·Storage·로그·AI 외부 사본을 분리 확인. Supabase 관리형 DB 백업은 Storage 파일 자체를 포함하지 않는다고 공식 문서가 설명한다. 실제 유미당이 관리형인지 자체 호스팅인지 확인하기 전 관리형 보관 일수를 적용하지 않는다.
5. 민규: 기존 10/6 합성 DB dump+Storage tar 복원 검증은 보존. 운영 복원으로 확대하지 않고 복구 후 삭제 목록 재적용·서명 URL·캐시·삭제 ACK 유실 시 미완료 유지 검증을 인계한다. 이번에 VM 재시작/DB 복원/파기는 하지 않았다.
6. 민규/종현: 네이버 최신 Token Revocation 안내와 현재 탈퇴 연결을 비교한다. 토큰 폐기와 앱 데이터 삭제는 별개이며 현재 구현 누락으로 단정하지 않고 실제 연결 범위를 확인한다. 신규 revoke 호출은 하지 않았다.
7. 대표/종현: 공개 처리방침 전체·삭제 직접 URL·연락처·앱과 콘솔의 개인정보 답변을 실제 처리와 맞춘다. 메일 송신/게시/스토어 제출은 하지 않았다.

## KOPIS 병행 범위

사용자 최신 확인: 집계 기간은 Dots 대조 결과 후 판단하되 일반 기능 개발·다른 API와 데이터 칼럼 정리를 병행해 해결 시 연결할 준비를 한다. 지금 추가 호출/주기 폴링을 지시한 것은 아니다. 정기 운영 수집이 이미 설치됐다는 의미는 아니다. Dots용 14일 대조 프롬프트는 전달했지만 Dots 예약 등록/실행 증거는 이 세션에서 확인하지 않았다.

이번 기본 조회는 별도 [실제 호출 결과](2026-10-19-kopis-basic-followup.md)에 기록했다. 순위 변수 17회 비교는 `/private/tmp/kopis-parameter-probe-20261019/검증결과.md`를 따른다. 집계 기간 판단 대기 때문에 일반 조회/다른 담당 작업을 보류하지 않는다.

## 공식 출처

- [개인정보 보호법 제16조](https://law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0016&lsiSeq=283839&urlMode=lsScJoRltInfoR)
- [제22조](https://www.law.go.kr/lsLawLinkInfo.do?chrClsCd=010202&lsJoLnkSeq=900078945)
- [제15조](https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0015&lsiSeq=283839&urlMode=lsScJoRltInfoR)
- [제21조](https://www.law.go.kr/lsLinkCommonInfo.do?lsJoLnkSeq=1027063705)
- [제37조](https://law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0037&lsiSeq=283839&urlMode=lsScJoRltInfoR)
- [제26조](https://www.law.go.kr/LSW/lsSideInfoP.do?docCls=jo&joBrNo=00&joNo=0026&lsiSeq=283839&urlMode=lsScJoRltInfoR)
- [제28조의8](https://www.law.go.kr/LSW/lsLinkCommonInfo.do?chrClsCd=010202&lsJoLnkSeq=1029334957)
- [개인정보위 생성형 AI 안내서 공개자료](https://pipc.go.kr/np/cop/bbs/selectBoardArticle.do?bbsId=BS074&mCode=C020010000&nttId=11410) — 보도자료 확인, 첨부 안내서 전체 열람 아님
- [Google 계정 삭제](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)
- [Google User Data](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en)
- [Google 생성 AI 콘텐츠](https://support.google.com/googleplay/android-developer/answer/13985936?hl=en)
- [Apple 심사 지침](https://developer.apple.com/app-store/review/guidelines/)
- [Apple 계정 삭제 FAQ](https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion)
- [Supabase 백업](https://supabase.com/docs/guides/platform/backups)
- [네이버 개발가이드 Token Revocation](https://developers.naver.com/docs/login/devguide/devguide.md#43-네이버-token-revocation토큰-폐기)
- [네이버 사전 검수](https://developers.naver.com/docs/login/verify/verify.md)
