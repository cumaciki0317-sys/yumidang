# AI 탐색 연결 계약

현재 기준은 [정책.md](../../정책.md)다. 종현 서버 코어·HTTP·RPC 어댑터의 현재 계약이다. 실제 SQL·공통 내부 클라이언트 허용 목록·외부 공급사·운영 환경 연결은 완료와 구분한다. 합성 테스트는 실제 회원 자료 전송 승인이나 개인정보 탐지 품질을 증명하지 않는다.

## 기능과 공개 경계

네이버 가입을 마친 로그인 회원이 무료 동행·행사를 찾는 기능이다. 실제 공개 카드와 확인된 자료로 추천 이유·확인할 점을 작성한다. 행사와 신청 가능한 공고는 구분한다. 대화에서 명시한 조건이 프로필보다 우선하며 관심사·대화 방식은 의미 비교, MBTI는 정확 일치다. 미입력은 확인 필요, 알려진 불일치는 제외한다. 제외 조건은 모두 적용하고 모호하면 질문한다.

검색·정렬은 [검색 계약](search.md)을 재사용한다. 공고 제목·등록 장소명·등록 주소·연결 행사명과 작성자 만 나이 19~99 범위(전체는 상한 없음)가 대상이다. GPS·거리·주변 검색은 제공하지 않으며 지역이 없으면 지역명을 묻는다. 일반 행사는 이번 주 신규 중 미종료 기본·진행 중 포함 선택이며 명시한 과거 기간 조회와 구분한다.

허용 도구는 검증된 공개 검색·재조회뿐이다. 임의 SQL/URL·회원 채팅·실명·연락처·비공개 위치 조회, 신청·확정·메시지 전송 권한을 주지 않는다. ID·사실·링크를 생성해서 채우지 않는다.

## 동의·문맥·개인정보

탐색 AI와 후기 AI를 구분해 가입 시 각각 필수 동의를 받으려는 제품 의도를 유지한다. 가입 후 철회 요청을 접수하면 해당 처리의 신규 전송을 중단하고 관련 요약 숨김·필요한 원문/외부 사본 삭제를 처리하며 일반 동행·계정은 유지한다. 필수화와 철회 처리의 법적 정합성은 검토 대기다. 확인 전 관련 가입 차단·외부 전송을 시행하지 않는다. AI 화면 설명을 제공하고 별도 첫 이용 팝업은 추가하지 않는다.

현재 탐색 `messages`는 화면 메모리만 사용하고 종료·로그아웃 때 삭제한다. 서비스 서버·브라우저 영구 저장소·로그·캐시·작업 payload에 대화 원문을 남기지 않는다. 사용자/AI 합계 20메시지·각 500자·전체 4,000자다. 초과 전에 안내하고 확인한 필터로 새 탐색하며 몰래 자르거나 저장하지 않는다.

입력 개인정보 발견 시 전송을 중단하고 수정 또는 사용자가 선택한 최소 구간의 오탐 문의를 제공한다. 출력 개인정보 발견 시 응답을 숨기고 사용자 재시도 1회를 제공하며 반복되면 일반 탐색으로 안내한다. 공개 장소명과 비공개 상세 위치를 구분하며 탐지 완벽성을 보장하지 않는다.

외부 실제 회원 원문은 포텐스닷의 보관·로그·캐시·백업·학습·삭제 조건 회신의 팀 검토와 사용자 확인 전 전송하지 않는다. 그 전에는 합성 입력만 사용한다. 공급사 포텐스닷·모델 Sonnet 5(`claude-5-sonnet`) 선택과 실제 계정·API 지원 검증은 별개다.

## 결과·실패·이용 한도

실제 후보 10개씩 최대 3쪽(30개)을 확인해 최대 5개를 표시한다. 성향 비교는 5후보씩 최대 3호출·출력 600토큰, 탐색 해석 출력은 800토큰이다. 검색 30개가 모두 의미 비교됐다고 표시하지 않는다. 반환 직전 재조회하여 공개 정보 변경 카드는 최신 정보로 표시하고 낡은 설명을 제거한다. 재조회가 일부만 끝났으면 검증된 카드 부분집합만 partial로 제공하고 검증된 카드가 0개면 unavailable이다. 성향 근거 변경·권한 상실 카드는 제외한다.

확인한 일부 카드만 제공하면 일부 확인 결과라고 안내한다. 확인 카드가 0개인 미완료는 결과 없음으로 처리하지 않는다. 설명 실패 시 확인된 실제 카드·정형 안내를 유지한다. 일시 오류는 자동 1회 재시도하며 실패하면 입력을 유지하고 직접 재시도·일반 탐색을 안내한다.

회원별 초기 한도는 한국시간 하루 20회·자정 초기화이며 분당 횟수 제한은 없다. 동일 회원은 한 번에 요청 하나만 처리하고 응답 뒤 즉시 다음 요청이 가능하다. 모델 없는 조건 버튼·일반 더보기·창 열기·새 대화·호출 전 차단은 차감하지 않는다. 자연어 해석·성향 비교·설명을 위해 모델 처리를 시작한 새 요청은 1회다. 내부 여러 호출과 같은 요청의 자동 재시도는 추가 차감하지 않으며 처리 시작 후 실패도 1회, 사용자가 새로 재시도한 요청은 새 1회다. 공급사 일일 한도·입출력 토큰 비용·요청당 호출 수를 실제 연결 후 확인해 회원 한도와 전체 예산을 재설정한다.

전체 AI 예산은 실제 계정의 포함량·계산 단위·초기화 주기를 확인한 뒤 포함량의 50%로 시작하고 추가 결제는 허용하지 않는다. 전체 예산 소진 시 개인 한도가 남아도 중단한다. 증액 희망은 공급사 회신·측정 후 검토하며 확인 전 활성화하지 않는다. 합성 검증 50,000은 기술 원장 단위로 원화·청구 토큰과 같지 않으며 합성 10회의 충분한 예산을 보장하지 않는다.

도움이 됐어요·문제 있어요를 제공한다. 신고는 해당 답변 또는 캡처 하나를 제출 전 확인하고 전체 대화를 자동 첨부하지 않는다. 접수 성공 시 해당 답변을 본인 화면에서 숨긴다.

## HTTP·코어 인터페이스

- `POST /functions/v1/ai-chat`: 인증된 회원의 `{clientRequestId,messages,currentFilters,outputRetryOf?}`, 여분 필드 400·초과 413·공통 envelope의 `AiChatResult`다.
- `runChat(input,trustedContext,deps,requestId,signal?)`에는 검증된 주체·명시 limits·모델·검색/재조회 포트를 주입한다. 본문 ID/역할로 권한을 만들지 않는다.
- `currentFilters`의 성향은 `{values:[{text,polarity:"include"|"exclude"}],combine?:"any"|"all"}`이고 복수 include는 combine이 필요하다. `authorAge`는 `"all" | {min,max}`이며 범위는 정수 19~99, min≤max다. 이전 연령대 값은 거절한다. region은 공고·행사 모두 공식 17개 시·도명이며 축약값을 임의 보정하지 않는다. 지역이 없으면 모델 없이 질문한다. 무료 행사 요구는 최신 와이어프레임 S20의 무료 행사 필터링과 정책9를 따른다. cost free는 DB의 freeOnly로 전달하고 공식 admission.kind free인 행사만 페이징 전에 필터링한다. described/unknown에서 무료·유료를 추정하지 않으며 paid 행사 요청은 검색 대신 지원 범위를 질문한다. 행사 `includeOngoing:true`는 이번 주 신규+이전부터 진행 중인 행사를 뜻하며 `ongoingOnly:true`와 구분한다. `performanceGenre`는 concert/musical/play이며 콘서트에는 대중음악·서양음악(클래식)·한국음악(국악)을 포함한다.
- 기존 결과 상태 `needs_clarification`, `results`, `no_results`, `unavailable` 및 `partial:true`를 화면 의미와 대조한다. `preference_match`에는 불투명 ref·요청/등록 성향만 보내고 원본 성향·유사도·추론·traitsVersion은 공개 결과에서 제외한다.
- 행사 `sourceName`과 선택 `sourceUrl:null`을 구분한다. `clientRequestId`는 탐색 요청 연결·중복 방지 키이며 신청 멱등키가 아니다. 원문 대화는 저장하지 않는다. `outputRetryOf`는 본인에게 출력 개인정보로 숨긴 이전 응답의 서버 requestId다. 클라이언트 재시도 횟수 주장을 믿지 않고 DB에서 해당 요청의 상태·소유자·1회 사용 여부를 확인한다.
- 설정명: `AI_CHAT_MAX_MESSAGES`, `AI_CHAT_MAX_MESSAGE_CHARS`, `AI_CHAT_MAX_TOTAL_CHARS`, `AI_CHAT_MAX_OUTPUT_TOKENS`, `AI_CHAT_SEARCH_PAGE_SIZE`, `AI_CHAT_MAX_SEARCH_PAGES`, `AI_CHAT_RECHECK_MAX_PAGES`, `AI_CHAT_MAX_RESULT_CARDS`, `AI_CHAT_MATCH_BATCH_SIZE`, `AI_CHAT_MAX_MATCH_CALLS`, `AI_CHAT_MATCH_MAX_OUTPUT_TOKENS`, `AI_RETENTION_DECISION_ID`, `AI_COST_EVIDENCE_ID`, `AI_PROCESSING_LEGAL_DECISION_ID`, `AI_MEMBER_TRANSMISSION_APPROVAL_ID`, `AI_BUDGET_LEDGER_ID`, 선택 `POTENS_USAGE_INPUT_FIELD`/`POTENS_USAGE_OUTPUT_FIELD`. 정책 숫자를 문서에 적었다고 환경에 주입된 것은 아니다.

`createModelRouter`는 보관 검토 근거와 원자 예산 예약·정산을 요구한다. approved 문자열·합성 fixture는 실회원 승인 증거가 아니다. 사용량 미확인을 0원으로 바꾸거나 자동 환불하지 않는다. 법적 처리 근거 검토와 실제 회원 전송의 사용자 승인 근거가 각각 없으면 `LEGAL_REVIEW_PENDING`·`MEMBER_TRANSMISSION_NOT_APPROVED`로 비활성이다. 공식 출력 상한 필드가 확인되지 않았으므로 기본 런타임은 `OUTPUT_LIMIT_NOT_VERIFIED`로 비활성이다. 서버 코드에서 검토 근거와 실제 인코더 `PotensOutputLimit`을 주입하고 공급사 강제 동작을 검증한 뒤에만 활성화한다. 합성 인코더의 임의 필드명은 운영 규격이 아니다. 사용자 요청 1회와 내부 모델 여러 호출·청구량은 다르다.

`createMetricsRecorder`는 고정 결과·시간·재시도·버전·토큰 수만 받고 원문·회원 ID·임의 metadata·오류 객체를 받지 않는다. 초기 품질 지표는 영구 저장하지 않는다. 운영 보관 선택은 일반 진단 30일·보안 90일·작업 종료 후 세부 기록 30일·공급사 한도 기간 종료 후 비용 원장 90일이다. 원문·비밀값을 제외한다. 미정산 예약은 해결까지 제한 보관하고 자동 환불·초기화를 하지 않는다. 중복방지 최소키는 재요청 가능기간에 맞춘 별도 삭제 조건을 검증한다. 법적 근거·실제 삭제·백업 만료는 별도 확인이며 활성 자료 삭제를 백업 즉시 삭제로 안내하지 않는다.

회원 점유·차감·철회 RPC는 종현 어댑터가 강제하지만 민규 DB 구현과 실제 동시 세션 검증은 남아 있다. 고정 조건·일반 더보기는 모델 없는 검색 API를 사용한다. 실제 공급사 사용량 매핑·품질 승인·화면 연결은 별도 검증하며 원장 기술 단위를 공급사 토큰·원화로 보고하지 않는다.

## 회원 요청과 예산의 필수 DB 계약

현재 내부 클라이언트는 아래 3개 신규 RPC를 허용하지 않는다. 민규가 SQL·허용 목록을 연결하기 전 운영 요청은 모델 전에 중단한다. 종현은 공통 클라이언트나 마이그레이션을 수정하지 않는다.

- `acquire_ai_chat_request(p_user_id,p_request_id,p_client_request_id,p_output_retry_of,p_contract_version:"2026-10-05")`: 인증 서버가 전달한 회원만 인정한다. 회원 활성 상태·탐색 동의·동시 요청 1개·DB 한국시간 하루 20회·출력 재시도 소유자와 1회 사용을 확인한다. 점유 자체에는 횟수를 차감하지 않는다. 성공 `{status:"acquired",leaseToken,expiresAt}`, 거부는 `{status:"concurrent"|"daily_limit"|"consent_revoked"|"retry_exhausted"}`다. finite lease는 DB 서버 시각으로 관리하고 오래된 요청은 새 점유를 해제하지 못한다.
- `reserve_ai_chat_model(p_user_id,p_request_id,p_lease_token,p_contract_version,p_ledger_id,p_provider_id,p_task,p_units)`: 모델 처리 시작 직전에 점유·동의·회원 자격을 재확인한다. **전체 예산 예약과 해당 요청의 첫 개인 1회 차감을 하나의 트랜잭션**으로 수행한다. 예산 거부에는 개인 차감이 없으며, 내부 추가 호출·자동 재시도는 같은 requestId의 차감 표식을 유지한다. 한국시간 날짜는 첫 모델 처리 시작의 DB 시각이며 클라이언트 날짜를 받지 않는다. 응답 `{reservationId:UUID|null}`이며 null은 전체 예산 거부다. 개인 한도·철회·점유 손실은 각각 `{status:"daily_limit"|"consent_revoked"|"lease_lost"}`로 구분해 자동 재시도하지 않는다. 원문·모델 입력은 전달하지 않는다.
- `finish_ai_chat_request(p_user_id,p_request_id,p_lease_token,p_outcome:"finished"|"output_privacy")`: 현재 점유만 멱등 해제한다. 출력 개인정보 상태는 재시도 1회 검증에 사용한다. `{finished:true}`. 처리 후 실패는 첫 차감을 되돌리지 않으며, 미정산 전체 예산 예약은 해결 전 자동 환불하지 않는다.

반드시 실제 DB 두 세션에서 19→20 경합, 서로 다른 서버의 동시 요청, 한국시간 자정 전후, 점유 만료·재획득, 원장 예약 거절 시 무차감, 처리 시작 후 실패·추가 호출의 1회 차감, 철회와 모델 시작 경합을 검증한다. 합성 RPC 테스트는 이 DB 원자성을 증명하지 않는다.

## 검사기와 응답 복구

운영 기본값에는 승인된 개인정보 검사기나 생성 설명의 의미 검사기가 없다. `ApprovedPrivacyCheck`의 승인 근거·전체 입력 검사·모델별 입력/출력 검사·최종 결과 검사를 연결해야 탐색이 준비 상태가 된다. 연락처 정규식은 보조 방어이며 실명·상세 주소 검사 승인으로 쓰지 않는다. 생성 설명 검사 `verifyExplanation`이 없으면 검증된 카드와 정형 안내만 제공한다.

응답의 선택 `recovery`는 `{reason:"input_privacy"|"output_privacy"|"daily_limit"|"concurrent"|"consent"|"temporary",retryAllowed:boolean}`다. 출력 차단은 카드·설명·질문 전체를 숨긴다. 첫 출력 차단만 사용자 재시도 1회를 안내하고, 재시도에서 반복되면 일반 탐색을 안내한다. 새 사용자 요청에는 새 clientRequestId를 사용한다. 서버 오류 원문과 개인정보를 notice에 복사하지 않는다.

탐색 모델의 TIMEOUT·RATE_LIMITED·MODEL_UNAVAILABLE은 같은 회원 요청 전체에서 자동 1회만 재시도한다. intent·성향·설명 단계가 HTTP handler의 동일한 서버 점유 scope 객체를 공유하며, 라우터는 이 객체별 재시도 사용 여부를 WeakSet으로 관리한다. 단계마다 횟수를 초기화하거나 내부 scope를 복제하지 않는다. 요청 종료 뒤 식별자를 영구 보관하지 않는다. 매 시도는 전체 예산을 별도 예약하며 개인 차감은 1회다. 취소·형식 오류·예산 소진·동의 철회는 자동 재시도로 우회하지 않는다. 요약 모델은 이 탐색 자동 재시도를 적용하지 않고 작업 큐의 재시도 정책을 따른다.

## AI 답변 평가·문제 접수

회원 전용 `POST /functions/v1/ai-chat/feedback`(별칭 `/ai-chat/feedback`)을 기존 ai-chat 함수에 추가했다. 모델·탐색·성향·회원 일일 차감과 분리하며 전체 대화를 읽거나 자동 첨부하지 않는다. 코드 계약은 `_shared/contracts/ai.ts`의 `AiFeedbackInput`·`AiFeedbackResult`다.

- 도움이 됐어요: `{clientRequestId,requestId,action:'helpful'}`.
- 문제 있어요: `{clientRequestId,requestId,action:'report',confirmed:true,attachment:{kind:'answer',text}}` 또는 `attachment:{kind:'capture',assetId}`. 제출 전 확인이 필수이며 두 가지 중 정확히 하나만 받는다.
- requestId/assetId는 UUID, clientRequestId는 기존 최대128자다. 답변 선택 구간은 정책11의 기존 메시지 한도500자(Unicode 문자) 이내로 받으며 넘으면 자동으로 자르지 않는다. 첨부 배열·2개 첨부·전체 messages·본문 userId·임의 URL은400이다. Storage 업로드/크기 계약은 민규 기존 시스템에 연결하며 새 숫자를 정하지 않는다.

내부 RPC `submit_ai_feedback(p_user_id,p_request_id,p_client_request_id,p_action,p_attachment,p_contract_version)`를 사용하며 버전은 `2026-10-05`다. 인증한 회원 ID만 p_user_id에 넣고 helpful의 p_attachment는 null이다. 신고에는 확인한 첨부 하나만 전달한다. DB는 실제 해당 회원의 AI 결과 소유권, 캡처의 업로드 완료/Storage 소유권, 신고자료 접근·보관 capability를 접수와 함께 원자 검사한다. `(회원,clientRequestId)`와 정확한 요청 fingerprint의 동일 재요청은 기존 접수 ID를 반환하며, 다른 대상/행동/첨부로 같은 키를 재사용하면 충돌로 거부한다. 성공을 기록하기 전에 소유권·권한 검증을 완료한다.

성공은 정확히 `{status:'accepted',feedbackId:UUID,hideAnswer:boolean}`이며 helpful은 false, report는 true다. 클라이언트는 accepted를 확인한 뒤에만 본인 메모리 화면의 해당 requestId 답변을 숨긴다. 다른 회원 답변이나 일반 공고·공개 후기를 숨기지 않는다. `{status:'request_not_owned'|'asset_not_owned'}`는403, `{status:'idempotency_conflict'}`는409이며 기타 변형 성공/잘못된 UUID/잘못된 hideAnswer는503이다. RPC 미지원·내부 허용 목록 미연결·응답 유실은 `{status:'not_enabled',reason:'AI_FEEDBACK_STORAGE_NOT_CONNECTED'}`이며 성공·숨김을 반환하지 않는다. 유실 후에는 같은 clientRequestId로 재접수해 DB의 멱등 결과를 확인한다.

report의 `reportEvidenceHandling:ReportEvidenceHandlingPort`는 기존 정책13의 **첨부 소유권·배정 담당자/승인 책임자 ACL·접근 기록·이의 포함 최종 종결+90일 정리**가 실제 연결됐는지만 확인한다. 새 법률 승인·새 동의·새 보관 선택을 추가하지 않는다. actual runtime 기본 포트는 미주입이며 `{status:'not_enabled',reason:'AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED'}`로 DB 저장 전 중단한다. helpful은 원문이 없으므로 이 준비 포트 없이 RPC만 연결한다. 합성 isReady:true는 실제 운영 준비 증거가 아니다. 포트 확인 이후 DB 접수 트랜잭션에서도 같은 조건을 검사해 중간 자격 변경을 허용하지 않는다.

현재 민규 소유 reports 서비스/SQL·Storage 첨부·내부 RPC 허용 목록·ACL/접근기록/정리 capability는 미연결이다. 로컬 HTTP/RPC 합성 검증은 실제 접수·보관·삭제·외부 전송·운영 권한의 검증이 아니다. 회원 AI 답변 원문 전체를 영구 저장하거나 모델/공급사로 신고를 보내는 기능을 추가하지 않는다. 상세 연결 과제는 [AI 피드백 인계](../../docs/collaboration/requests/jonghyun/2026-10-05-ai-feedback-connection.md)를 따른다.
