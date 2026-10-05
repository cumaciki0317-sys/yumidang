# 2026-10-05 AI·검색·요약 구현 확인 결과

작업자 `jonghyun`, 브랜치 `jonghyun/queue-integration`, 기준 커밋 `9dfca36cfe88f6da658fcbf863d5f4a33c2d0513`. [하네스](2026-10-05-full-implementation-harness.json)의 ai-search-audit 허용 파일만 수정했다. 코드 재구현·공통 SQL/클라이언트 변경·실제 DB/공급사 요청·활성화·배포·커밋은 하지 않았다. 현재 소스와 이번 실행을 기준으로 오래된 미연결 표현을 정정했다.

## 요구 → 현재 코드 → 이번 검증 → 남은 경계

| 요구 | 현재 코드 | 이번 증거 | 남은 경계 |
|---|---|---|---|
| 제목·등록 장소명/주소·연결 행사명, 숫자 나이19~99/전체상한없음, 지역17개, 익명 작성자null | `services/search-service.ts`, `db/repositories/search.ts`, `service-api/search-http.ts` | 검색4종+응답오류 테스트, service-api Deno 통과 | 실제 DB 인증/차단/탈퇴/19·99·100세·커서 통합 검증 |
| 자연어 조건·성향 의미 비교·MBTI정확일치·미입력확인필요·반환직전재조회 | `ai/Agents/chatbot/` | chatbot/semantic/event-discovery 및 AI HTTP 테스트 | 실제 의미 품질·기기/API 통합은 미실행 |
| 회원 동시1개·KST일20회·첫모델시작만차감·내부retry추가차감없음 | `ai/providers/member-request.ts`, `budget.ts`, `provider-adapter.ts` | budget/runtime/model-router/policy-guards 및 AI HTTP 합성 테스트 | DB 두세션 경합·자정·철회경합은 별도 |
| 입력/출력 전체 개인정보 차단, 설명 검사 없으면 카드+정형안내 | `ai/providers/privacy.ts`, `chatbot/output-check.ts`, `ai-chat/index.ts` | 합성 privacy/HTTP/model-router 회귀 | 승인된 전체 개인정보/설명 의미 검사기 미주입; 운영 활성화 보류 |
| 공개 적격 텍스트3개·전체분할·checkpoint·300자·revision/lease검사 | `ai/Agents/review-summary/`, `db/repositories/review-summaries.ts`, `review-summary-worker/` | review-summary/summary-repository/worker 합성 테스트 | 운영 safety=null, 실제 원문 의미 품질·DB 게시경합·공개 HTTP 미확인 |
| 외부 처리 전 최종자격+전체예산 원자 예약·철회 | `20261005002528_ai_atomic_requests.sql`, `20261005003159_current_summary_fences.sql`; internal/user-client 허용 목록 | 이번 SQL 소스 확인, 합성 예약/철회 회귀 | SQL 실제 대상DB 적용 및 동시성은 이번 미실행 |
| 도움이 됐어요·최소첨부신고·accepted후만숨김 | `chatbot/feedback.ts`, ai-chat feedback HTTP | ai-feedback 합성 테스트 | `submit_ai_feedback` SQL/허용목록 없음; reportEvidenceHandling 미주입 |
| 모델상한·보관/법률/회원전송/비용근거 부족시 disabled | `ai/providers/runtime.ts`, `potens-adapter.ts` | adapter/runtime 합성 테스트 | 공급사회신·공식출력인코더·실계정포함량 확인·팀검토대기 유지 |

표의 services/db/ai 경로는 `backend/supabase/functions/_shared/` 아래다. ai-chat/review-summary-worker/service-api 진입점은 `backend/supabase/functions/` 아래이며 SQL은 `backend/supabase/migrations/` 아래다.

## 이번 실행

- **PASS:** Node 기존 테스트18파일186개, 실패0·skip0. `tests/ai/jonghyun/*.test.mjs` 10파일과 `tests/functions/jonghyun/`의 ai-chat-http, ai-feedback, review-summary-worker, summary-repository, search-repository, search-response-errors, search-policy, search-service 8파일을 한 번에 실행했다. 하위집합을 다시 합산하지 않았다.
- **PASS:** `deno check --no-remote`로 ai-chat/index.ts, review-summary-worker/index.ts, service-api/index.ts 3개 검사. 현재 숫자 나이 parser가 타입 검사를 통과하므로 과거 인계 TS2322는 해결됐다.
- **PASS(계획만):** synthetic-eval 기본 dry-run은 `DRY_RUN_NO_MODEL_CALL`, plannedCalls10을 반환했다. 실제 모델 호출·사람2명검수·안전품질 합격은 아니다.
- **NOT_RUN:** DB/REST·동시성 회귀, 실제 공급사, 원문전송, 공개화면 실API, 운영호스트/기기/배포. 통합 스크립트는 DB/Auth 레코드를 생성하는 별도 준비환경 실행이므로 이번 합성 범위로 자동 실행하지 않았다.

재현 명령:

```sh
node --experimental-strip-types --test tests/ai/jonghyun/*.test.mjs tests/functions/jonghyun/ai-chat-http.test.mjs tests/functions/jonghyun/ai-feedback.test.mjs tests/functions/jonghyun/review-summary-worker.test.mjs tests/functions/jonghyun/summary-repository.test.mjs tests/functions/jonghyun/search-repository.test.mjs tests/functions/jonghyun/search-response-errors.test.mjs tests/functions/jonghyun/search-policy.test.mjs tests/functions/jonghyun/search-service.test.mjs
deno check --no-remote backend/supabase/functions/ai-chat/index.ts backend/supabase/functions/review-summary-worker/index.ts backend/supabase/functions/service-api/index.ts
node --experimental-strip-types tests/ai/jonghyun/synthetic-eval.mjs
```

## 민규 연결 요청과 확인 기준

1. **검색:** 현재 HTTP ageMin/ageMax·region과 최신 search_public_posts_v2 SQL·허용 목록은 존재한다. 새 구현 요청으로 되돌리지 않는다. 최신 SQL 적용 대상과 익명/회원/차단/탈퇴/숫자나이/10개페이지 검증 증거를 연결한다. 잘못된 토큰을 익명으로 낮추거나 구RPC/가상0건으로 대체하지 않는다.
2. **AI·요약 원자 RPC:** acquire/finish/reserve_chat, reserve_summary, summary6 RPC의 최신 계약은 소스와 허용 목록에 있다. 대상DB 적용·개인19→20/자정/점유만료/예산거절 무차감/철회 및 게시 경쟁을 실제 두세션으로 확인한다. 개인정보 원문을 예약RPC에 넣지 않는다.
3. **공개 HTTP:** `GET /profiles/:id/summary`, `GET /events/:id`, `GET /events/rankings?mode=all|musical` 공개 경로는 현재 service-api routes에 없다. 요약은 로그인·현재revision·적격근거3개·300자·현재공개조건을 재검사하고 내부 근거ID/작업/모델 정보를 노출하지 않는다. 행사 상세/순위 DTO와 모바일 기존 요청을 맞춘다.
4. **AI 피드백:** `submit_ai_feedback(p_user_id,p_request_id,p_client_request_id,p_action,p_attachment,p_contract_version:'2026-10-05')`와 내부 허용 목록을 연결한다. 회원/답변/완료업로드 소유권·멱등fingerprint·신고ACL/접근기록/최종종결+90일정리를 접수와 함께 확인한다. 반환은 accepted/feedbackId/hideAnswer, helpful false·report true다. 응답유실은 성공으로 표시하지 않고 같은 clientRequestId로 확인한다. 일반 신고 서비스가 있다는 사실만으로 AI RPC 연결 완료를 표시하지 않는다. 자세한 반환/오류 계약은 [AI 계약](../../../../backend/contracts/ai-chat.md)을 따른다.
5. **팀 확인 대기:** 승인된 개인정보·요약 의미 검사기, 공식 출력상한 인코더, 공급사 보관/삭제/학습/로그/백업 회신, 법적동의 검토, 실계정 포함량·비용근거·실회원전송 승인. 새 숫자·담당을 임의 확정하지 않고 준비 전 unavailable/not_enabled를 유지한다. 이번 테스트의 가상 검사·approved fixture는 운영 승인이 아니다.
