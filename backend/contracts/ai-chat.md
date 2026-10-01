# AI 탐색 연결 계약

주담당: 종현. 현재 정책은 [정책.md](../../정책.md), 공개 검색은 [search.md](search.md)를 따른다. 문서 동기화에서 코드·모델·DB·배포는 변경하지 않았다.

## 현재 기능과 권한

- 네이버 가입 자격을 충족한 로그인 회원의 현재 탐색에서 사용한다. 비로그인 일반 탐색과 AI 이용 권한을 구분한다.
- 자연어 조건을 해석하고 실제 공개 공고·행사 카드를 찾으며, 확인된 자료에 근거한 추천 이유·확인할 점을 제공한다. 생성 설명의 품질·근거 점검 방법과 공개 활성화는 팀 검토다.
- 현재 무료 1:1 동행만 찾는다. 유료·계좌 인증은 후속 도입 검토이며 AI가 유료 등록을 활성화하지 않는다.
- 현재 대화의 명시 조건이 프로필보다 우선한다. 관심사·대화 방식은 등록값의 의미 유사성, MBTI는 정확 일치로 판단한다. 미입력은 확인 필요로 남기고 알려진 불일치는 제외한다. 제외 조건은 모두 적용하고 애매한 조건은 질문한다.
- 공고 검색 대상은 제목·등록 장소명·등록 주소·연결 행사명이다. 작성자 만 나이 19~99 숫자 범위를 사용하고 전체에는 상한을 적용하지 않는다. 현재 wire의 연령대 값과 연결 행사명 누락은 후속 변경 대상이다.
- 주변·반경·거리순은 제공하지 않는다. ‘근처’ 요청은 미지원 안내 후 장소명·주소를 확인한다. 일반 행사는 이번 주 신규 기본·진행 중 포함 선택이고, 사용자가 명시한 기간·신규 조건을 구분한다.
- 허용 도구는 검증된 공개 공고·행사 조회다. 임의 SQL·URL 조회, 실명·연락처·계좌·비공개 만남 지점·회원 간 채팅 조회, 신청·확정·결제·메시지 전송 권한을 주지 않는다. 카드 ID·사실·URL을 모델이 지어내지 않는다.

## 현재 대화와 개인정보 처리

`messages`는 현재 탐색의 화면 메모리에서만 유지한다. 종료·새 탐색·로그아웃 때 정리하고 서비스 서버의 대화 이력·오류·사용량 로그·캐시·작업 payload에 원문을 남기지 않는다. 긴 대화를 임의로 잘라내거나 자동 저장하지 않는다.

개인 연락처·계좌·주거 상세정보·비공개 만남 안내가 입력에서 발견되면 외부 전송을 멈추고 수정을 안내한다. 출력에서 발견하면 해당 응답을 숨기고 재시도를 안내한다. 서울역·전시장처럼 정상적인 공개 장소와 구분한다. 원문을 오류 로그에 복사하지 않는다. 탐지·오탐·재시도 한도는 팀 검토이며 완전 탐지를 보장하지 않는다.

AI 첫 이용 직전에 전송 항목·목적·공급사·서버 원문 미저장·확인된 외부 보관 조건·거절 방법을 안내하고 확인받는다. 안내는 다시 볼 수 있고 조건 변경 시 재안내한다. 이 확인만으로 법적 동의의 적정성을 모두 충족했다고 표시하지 않는다.

외부 AI 실제 회원 정보 전송은 포텐스닷 보관 답변의 팀 검토와 사용자 확인 전까지 보류하며 합성 입력만 사용한다. 공급사는 포텐스닷, 모델은 Sonnet 5(`claude-5-sonnet`)다. 초기 합성 검증 추가 지출은 0원이며 이용권·한도 근거가 필요하다. 운영 예산·한도·로그 식별자와 보존·예산 원장 보존은 팀 검토다. 학습 미사용과 미보관은 다른 조건이다.

## 정렬·재확인·일부 결과·실패: 팀 검토

사용자 33번 답변에 따라 AI의 정렬·응답 직전 상태 재확인·일부 결과·실패 세부 처리는 팀 검토다. 아래 기존 구현의 `partial`, 재조회, 설명 제거 동작을 이번 사용자 확정 정책으로 승격하지 않는다. 일반 공고 검색의 등록일 최신순 기본/시작일 빠른순과 공개 권한 제한은 유지하며, AI가 임의 순위·공개 권한을 만들어내는 근거로 이 보류를 사용하지 않는다.

## 기존 HTTP·코어 인터페이스

- `POST /functions/v1/ai-chat`: 회원 인증, 본문 `{clientRequestId,messages,currentFilters}`, 여분 필드400·초과413, 공통 envelope의 `AiChatResult`. 모델·한도·본인 성향 조회가 준비되지 않으면 `unavailable`을 반환하는 구현이 있다.
- `runChat(input,trustedContext,deps,requestId,signal?)`: 서버에서 검증한 주체·명시 limits·모델·검색/재조회 포트를 주입한다. 사용자 본문의 ID·역할을 인증 근거로 삼지 않는다.
- 기존 `currentFilters`는 `sort`, `authorAge`, `interests`, `conversationStyles` 등을 받는다. 성향은 `{values:[{text,polarity:"include"|"exclude"}],combine?:"any"|"all"}`이며 include 복수 시 combine을 요구한다. 숫자 나이 범위의 정확한 wire 형식은 후속 계약으로 정한다.
- 기존 의미 비교 `preference_match` 입력에는 불투명 ref와 요청·등록 성향값만 둔다. 카드의 `conditionStatus`는 `match`/`needs_check`를 사용하고 원본 성향·유사도·추론·traitsVersion은 반환하지 않는다.
- 기존 코어 상태는 `needs_clarification`, `results`, `no_results`, `unavailable`이다. 일부 결과의 `partial:true`, 권한 재조회·traitsVersion 검사·변경 카드 설명 제거는 기존 코드 기능이며 33번 팀 검토와 일치 여부를 확인해야 한다.
- 행사 카드는 `sourceName`을 제공하고 공식 링크가 없으면 `sourceUrl:null`이다. 공고가 없는 행사를 동행 신청으로 표현하지 않는다.
- `clientRequestId`는 응답 연결용이며 영구 대화 저장·신청 중복 방지 키가 아니다. 공통 HTTP의 서버 requestId와 구분한다.

- **설정 이름(값 없음):** `AI_CHAT_MAX_MESSAGES`, `AI_CHAT_MAX_MESSAGE_CHARS`, `AI_CHAT_MAX_TOTAL_CHARS`, `AI_CHAT_MAX_OUTPUT_TOKENS`, `AI_CHAT_SEARCH_PAGE_SIZE`, `AI_CHAT_MAX_SEARCH_PAGES`, `AI_CHAT_RECHECK_MAX_PAGES`, `AI_CHAT_MAX_RESULT_CARDS`, `AI_CHAT_MATCH_BATCH_SIZE`, `AI_CHAT_MAX_MATCH_CALLS`, `AI_CHAT_MATCH_MAX_OUTPUT_TOKENS`, 모델용 `AI_RETENTION_DECISION_ID`, `AI_COST_EVIDENCE_ID`, `AI_BUDGET_LEDGER_ID`, 선택 `POTENS_USAGE_INPUT_FIELD`/`POTENS_USAGE_OUTPUT_FIELD`. 기본값이 없다.

`createModelRouter`는 서버의 제공사별 `retentionReview`와 원자 예산 예약·정산 포트를 사용한다. pending 또는 근거 참조가 없는 approved는 호출 전에 차단한다. approved 문자열·테스트 fixture가 실제 보관 검토·사용자 승인을 대신하지 않는다. 사용량 불명 실패를 0원·자동 환불로 바꾸지 않는다. 승인 없는 대체 공급사·모델·비용 기본값을 넣지 않는다.

## 구현·검증 확인 경계

포텐스닷 어댑터·HTTP·성향 비교·예산 포트의 기존 구현과 가상/로컬 검증은 [C 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-lane-c-notes.md)와 [전체 인계](../../docs/collaboration/requests/jonghyun/2026-09-29-claude-implementation-handoff.md)를 참고한다. `get_post_author_traits`, `get_my_profile_traits`, `reserve_ai_budget`, `settle_ai_budget`, `list_public_events`의 실제 허용 목록·정식 migration·배포 적용은 담당자가 별도 확인한다. 과거 인계의 차단 상태를 현재 실행 확인 없이 단정하거나 가상 검사를 실제 모델 성공으로 표시하지 않는다.

`createMetricsRecorder({sink,modelVersions,promptVersions,now?})`는 고정 결과·시간·재시도·버전·토큰 수만 받는다. 원문·회원 ID·임의 metadata·오류 객체는 받지 않는다. 초기 지표 영구 저장 금지와 로그 보관 팀 검토를 유지한다. 실제 수신부 연결·보관 조건·모델 품질·현재 정책 반영 검증은 별도다.
