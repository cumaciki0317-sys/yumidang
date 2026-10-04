# 유미당 백엔드 작업 안내

기준은 [정책](../정책.md)·[계획](../PLAN.md)·[상세 설계](../PLAN_상세설계.md)다. 문서의 목표와 기존 코드 인터페이스를 구분하며 이번 문서 동기화로 서버·DB·환경·배포·외부 연결을 변경하거나 검증하지 않았다.

## 현재 반영할 기능

네이버 이름·성별·생일·출생연도로 여성·만19세이상을 확인하며 계정당회원1개·사진필수·성향선택이다. 무료1:1만 제공하며 별도 휴대폰/기관메일/계좌·유료·결제 기능은 현재 제외한다. 다른 네이버 연결·활동 이전도 제공하지 않는다.

첫 채팅 성공 때 신청과 작성자 대화방을 만들고 재신청은 기존 방을 재사용한다. 철회1분 후 재신청, 작성자 거절 후 금지, 최종 동의6시간/시작 만료와 일정·장소 변경6시간/양 시작 만료를 적용한다. 확정 취소 후 명시적 모집 재개는 유효 신청을 복원한다. 현재 RPC와의 차이는 [매칭](contracts/matching.md)·[서비스 API](contracts/service-api.md)에 표시한다.

예상 종료 후 본인 완료 확인을 마친 사람은 상대 확인 전에도 후기를 제출할 수 있으나 실제 완료 전에는 비공개다. 양쪽 확인 또는 예상 종료+24시간에 실제 완료하며 취소·노쇼는 제외하고 신고·분쟁 검토 중에는 보류한다. 지연 시 실제 성공 시각이 완료 시각이다. 작성 마감은 실제 완료부터 7일, 양쪽 제출은 실제 완료 후 즉시 공개, 한쪽 제출은 작성 기한 종료 시 공개한다. 완료 횟수는 실제 완료 즉시, 후기 당도는 상대 열람 가능 시 반영한다.

당도 산식·제재·신고·탈퇴/보관은 정책에 확정된 범위를 적용하며 법적 근거·실제 삭제·담당 배정은 별도 확인이다. 운영자가 DB 채팅 원문에 직접 접근하지 않는다. 신규 정책의 코드 반영은 [후기](contracts/reviews.md)·[가입](contracts/signup.md)에서 구분한다.

[검색](contracts/search.md)은 키워드4종·숫자나이19~99·익명일정/나이전체·개인정보없는작성자가드·공고/행사10개·후기5개가 목표다. 일반 행사는 이번 주 신규 미종료·진행 중 포함 선택·과거 조회, 공식Top10은 어제까지 최근7일 전국전체/뮤지컬이다. 실제 공급사3곳 연결과 API/화면의 반영을 별도 검증한다.

회원별 초기 한도는 한국시간 하루 20회·자정 초기화이며 분당 횟수 제한은 없다. 동일 회원은 한 번에 요청 하나만 처리하고 응답 뒤 즉시 다음 요청이 가능하다. 모델 없는 조건 버튼·일반 더보기·창 열기·새 대화·호출 전 차단은 차감하지 않는다. 자연어 해석·성향 비교·설명을 위해 모델 처리를 시작한 새 요청은 1회다. 내부 여러 호출과 같은 요청의 자동 재시도는 추가 차감하지 않으며 처리 시작 후 실패도 1회, 사용자가 새로 재시도한 요청은 새 1회다. 공급사 일일 한도·입출력 토큰 비용·요청당 호출 수를 실제 연결 후 확인해 회원 한도와 전체 예산을 재설정한다.

탐색 AI와 후기 AI를 구분해 가입 시 각각 필수 동의를 받으려는 제품 의도를 유지한다. 가입 후 철회 요청을 접수하면 해당 처리의 신규 전송을 중단하고 관련 요약 숨김·필요한 원문/외부 사본 삭제를 처리하며 일반 동행·계정은 유지한다. 필수화와 철회 처리의 법적 정합성은 검토 대기다. 확인 전 관련 가입 차단·외부 전송을 시행하지 않는다. AI 화면 설명을 제공하고 별도 첫 이용 팝업은 추가하지 않는다.

전체 AI 예산은 실제 계정의 포함량·계산 단위·초기화 주기를 확인한 뒤 포함량의 50%로 시작하고 추가 결제는 허용하지 않는다. 전체 예산 소진 시 개인 한도가 남아도 중단한다. 증액 희망은 공급사 회신·측정 후 검토하며 확인 전 활성화하지 않는다. 합성 검증 50,000은 기술 원장 단위로 원화·청구 토큰과 같지 않으며 합성 10회의 충분한 예산을 보장하지 않는다.

실회원 AI 외부 전송은 공급사 보관 회신 검토·사용자 확인 전 보류한다. [AI 탐색](contracts/ai-chat.md)·[요약](contracts/review-summary.md)·[작업 큐](contracts/worker-jobs.md)에서 선택 숫자와 실제 구현을 구분한다.

## 실행·연결 안내

[완료 DB](contracts/completion-db.md)의 건별 DB 예약·상주 Node LISTEN/NOTIFY 실행기는 direct/session 연결을 사용한다. `COMPLETION_DATABASE_URL`, `COMPLETION_RECONNECT_MS`(5초), `COMPLETION_QUERY_TIMEOUT_MS`(10초)를 명시 준비하고 실제 복구를 검증한다. 실행기 준비와 기존 cron 전환은 함께 처리하며 운영 적용 완료를 가정하지 않는다.

행사·신규 요약은 [매일00:01 등록](contracts/daily-jobs.md) 후 분리 실행한다. 자동 완료·후기 공개는 모델/일일배치를 기다리지 않는다. 공급사·계정·호스트 한도와 실제 설정 주입은 후속이다.

키는 현재 작업 폴더 최상위 `.env`에 입력하고 [입력 안내](API_INPUT.md)·[빈 양식](.env.example)을 따른다. 비밀값을 프런트·문서·Git에 넣지 않는다. [로컬 도구](../tools/local/README.md)의 준비 성공과 DB/HTTP 실행 성공을 구분한다.

파일별 수정은 [소유권](ownership.json)·[협업 규칙](../docs/collaboration/README.md)과 해당 작업 하네스를 따른다. 기존 경로에서 후속 구현하고 같은 기능의 중복 폴더를 만들지 않는다. 아래 functions/는 supabase/functions/, _shared/는 그 아래다.

## 기능별 작성 위치

| 기능 | 작성할 파일·폴더 | 주담당 |
|---|---|---|
| 일반 API 진입·경로 연결 | functions/service-api/index.ts, handler.ts, routes.ts | 민규담당 |
| 가입·인증 요청 | functions/signup/, verification/의 index.ts·handler.ts | 민규담당 |
| 탐색·요약 요청 | functions/ai-chat/, review-summary-worker/의 index.ts·handler.ts | 종현담당 |
| 장소·행사·예약 실행 | functions/places/, event-sync/, scheduled-jobs/의 index.ts·handler.ts | 종현담당 |
| 사용자·내부 호출자·세션 | _shared/auth/ | 민규담당 |
| 환경·HTTP·공통 오류 | _shared/config/, http/ | 민규담당 |
| 실행 시 계약 검증 | _shared/contracts/ | search.ts·ai.ts는 종현, 나머지는 민규 |
| 업무 처리 | _shared/services/*-service.ts | search·event는 종현, 나머지는 민규 |
| DB 클라이언트 | _shared/db/user-client.ts, internal-client.ts | 민규담당 |
| DB 조회·RPC 연결 | _shared/db/repositories/ | search·events·review-summaries·jobs는 종현, 나머지는 민규 |
| 인증 제공사 연결 | _shared/auth/ 및 signup/·verification/; 기존 identity·phone 구조는 네이버 전용 전환 점검, email·bank는 후속 검토 | 민규담당 |
| 장소·행사 제공사 연결 | _shared/integrations/places·events의 port.ts·adapter.ts, events/normalize.ts | 종현담당 |
| AI 탐색 | _shared/ai/Agents/chatbot/ | 종현담당 |
| AI 리뷰 요약 | _shared/ai/Agents/review-summary/ | 종현담당 |
| AI 모델 연결 | _shared/ai/providers/ | 종현담당 |
| 작업 등록·점유·재시도 | _shared/jobs/ | 종현담당 |
| 로그·민감 필드 제거 | _shared/observability/logger.ts, redaction.ts | 민규담당 |
| 공통 처리·AI 사용량 지표 | _shared/observability/metrics.ts | 종현담당 |
| 사람이 합의할 API 계약 | contracts/*.md | search·ai-chat·review-summary는 종현, 나머지는 민규 |
| DB 변경 | supabase/migrations/의 후속 변경 파일 | 민규가 통합, 종현은 필요한 변경안 제공 |
| 로컬 가상 데이터 | supabase/seeds/minkyu/, jonghyun/ | 각자 자기 폴더만 작성, 로드 설정은 민규 |

## AI 파일 상세

탐색 요청은 `functions/ai-chat/`에서 받고 `_shared/ai/Agents/chatbot/orchestrator.ts`로 연결한다. `context.ts`는 허용 문맥, `intent.ts`는 조건 검증, `date-range.ts`는 기간 계산, `tools.ts`는 공개 검색 도구를 맡는다. `prompts.ts`, `result-builder.ts`, `output-check.ts`에 지침·실제 카드 구성·결과 검증을 작성한다.

요약 작업은 `functions/review-summary-worker/`에서 받고 `_shared/ai/Agents/review-summary/orchestrator.ts`로 연결한다. `source-loader.ts`, `eligibility.ts`, `prompts.ts`, `evidence-check.ts`, `output-check.ts`, `publisher.ts`에 원문 조회·3개 기준·생성 지침·근거 검증·출력 검사·조건부 게시를 작성한다.

모델 호출 계약은 `_shared/ai/providers/model-port.ts`, 제공사 연결은 `provider-adapter.ts`, 오류 변환은 `provider-errors.ts`에 작성한다. 공급사·모델은 포텐스닷 Sonnet 5(`claude-5-sonnet`)이며 실제 회원 정보 전송은 보관 조건 팀 검토·사용자 확인 전 보류한다. 서비스 전체 초기 예산은 확인된 공급사 포함량의50%·추가 결제 없음이며 회원별20회/일·분당제한없음이다. 실제 계정·호출 토큰 비용을 확인해 재설정한다.

## 구현 완료 판정

handler→service→repository/integration의 실제 호출·권한·오류·멱등·동시성·공개 회수를 현재 정책에 맞춰 확인한다. 공급사 설정·기술 단위 검사·로컬 통합·원격 적용·화면·실제 운영은 별도 상태로 보고한다. 과거 검사 수나 파일 존재를 현재 완료율로 사용하지 않는다.
