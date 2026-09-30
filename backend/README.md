# 유미당 백엔드 작업 안내

현재 적용할 서비스 정책은 [정책.md](../정책.md)를 따른다. 한쪽 후기 공개는 **실제 동행 완료 시각 +24시간**, 양쪽 제출은 즉시다. 당도는 상대 후기를 열람할 수 있게 될 때 동시에 반영하고, 완료 횟수는 후기와 관계없이 동행 완료 즉시 반영한다. 당도 산식은 민규·팀 검토 필요다. 아래 RPC·구현·검증 기록과 정책의 확정은 구분하며, 이번 문서 동기화에서 코드·DB·화면의 최신 정책 일치 여부는 검증하지 않았다. [반영 확인 작업](../정책.md#follow-ups)을 확인한다.

현재 정책: 양쪽 후기는 24시간 전이어도 즉시 공개, 한쪽은 실제 동행 완료+24시간 공개, 이후 기한 내 제출은 즉시 열람한다. 일반 작성 기간은 실제 완료부터 7일이며 실제 분쟁·미완료·불발/노쇼를 제외한다. 분쟁 중 기한 보류와 동행 인정 후 남은 기간 재개·최소 24시간의 기존 예외는 유지한다. 기존 policy 대기 후보에도 적용하고 override 숨김과 과거 비후보 후기는 보존한다.

자동 완료는 DB 건별 예약·Node 상주 실행기의 LISTEN/NOTIFY·예약 타이머로 분리한다. 공개 정리와 요약 등록은 별도 RPC이며 모델 설정이 공개를 막지 않는다. 행사 갱신·새 AI 후기 요약 작업 등록은 매일 00:01 Asia/Seoul에 한 번이며, 실제 연결·배포 여부는 해당 단계의 검증 기록에서 확인한다. 2026-09-29 사용자 승인 하네스의 담당 경계 예외와 결과는 당시 범위에 한정한다. [변경 범위·실제 검증 결과](../docs/collaboration/requests/jonghyun/2026-09-29-review-policy-handoff.md)를 확인한다.

아래 구현·검사 건수는 각 단계 당시 기록이다. 공통 HTTP·인증/DB·무료 공고/양측 매칭·채팅/알림과 검색의 실제 로컬 검증 이력은 유지하며, 새 정책의 검증 결과와 구분한다. 외부 인증/계좌·AI·화면 연결·운영 배포는 별도다.

기준 문서는 [최신 계획](../PLAN.md), [상세 설계](../PLAN_상세설계.md), [프로젝트 지침](../AGENTS.md)이다. 담당 업무와 연결 계약은 상세 설계 11장을 먼저 확인한다.

**동시 수정 방지:** [ownership.json](ownership.json)이 파일별 단독 수정 담당을 정의한다. [협업 규칙](../docs/collaboration/README.md)에 따라 자기 파일만 수정하고 상대 담당 변경은 각자의 요청 폴더에 기록한다. AI 수정 전 경로 검사와 Git 커밋 검사를 사용한다.

## 자동 완료 실행기

[완료 DB 계약](contracts/completion-db.md#상주-실행기-준비와-운영-전환)에 `completion-runner.mjs` 실행 명령과 필수 환경값을 정리했다. `COMPLETION_DATABASE_URL`, `COMPLETION_RECONNECT_MS`, `COMPLETION_QUERY_TIMEOUT_MS`는 기본값 없이 명시 설정한다. LISTEN은 PostgreSQL direct/session 연결이 필요하며 transaction pool은 사용하지 않는다. 운영 전환 때 runner 준비·기동과 기존 cron 해제를 함께 진행해야 자동 완료 처리가 비는 상황을 줄일 수 있다. 이번 운영 배포는 미실행이다.

## 수집한 API 입력

실제 키는 자신이 여는 저장소 최상위 `.env`에 넣는다. [입력 안내](API_INPUT.md)에 서비스별 위치와 담당을 정리했으며 [빈 양식](.env.example)만 Git으로 공유한다. 키 저장 이후 실제 공급사 연결·검증은 별도 작업이다.

## 기존 파일을 채우는 작업 방식

기능을 구현할 때 아래 표와 각 파일의 역할·담당·TODO를 확인하고 자기 담당 파일에 작성한다. 같은 기능의 다른 이름 파일이나 별도 백엔드·AI 폴더를 중복 생성하지 않는다. 새 파일이 필요하면 기존 모듈과 책임을 구분한다. 이 안내와 상세 설계는 민규가 갱신하며, 종현은 변경 요청을 남긴다.

공통 계약 `common.ts`와 `http/`에는 요청 ID·입력 검증·JSON 응답·공개 오류·CORS 처리가 구현돼 있다. `service-api/`와 해당 서비스·저장소에는 실제 HTTP→인증→RPC 처리가 연결돼 있다. 가입·공급사 및 일부 미정 정책 모듈은 골격으로 남아 있다. 주석의 TODO는 구현·검증 완료 후 실제 상태에 맞게 바꾼다. 파일이 존재한다는 이유만으로 기능 완료로 판단하지 않는다.

## 민규 foundation 사용 순서

1. [공통 연결 규칙](contracts/conventions.md)의 응답·오류·requestId 계약을 사용한다.
2. 1차 [DB 연결 제안](contracts/db-foundation.md)의 실제 호출은 [검색 DB](contracts/public-post-search-db.md), [후기 DB](contracts/review-summary-db.md), [작업 큐 DB](contracts/worker-jobs.md)의 RPC 이름·필수 인수·반환값을 따른다. 가상 사례를 실제 함수 이름으로 간주하지 않는다.
3. [로컬 도구 안내](../tools/local/README.md)에 따라 정식 이력과 이번 신규 SQL만 분리 복사한 후 전용 DB에서 검증한다. 준비 도구 자체는 SQL을 실행하지 않는다.
4. [민규 작업 현황](../docs/collaboration/minkyu.md)과 [3차 업무 연결 전달 사항](../docs/collaboration/requests/minkyu/2026-09-23-runtime-handoff.md)에서 검증 결과와 남은 연결 범위를 확인한다.

아래 경로에서 `functions/`는 `supabase/functions/`를, `_shared/`는 그 아래 공통 폴더를 뜻한다.

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
| 인증 제공사 연결 | _shared/integrations/identity·phone·email·bank의 port.ts·adapter.ts | 민규담당 |
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

모델 호출 계약은 `_shared/ai/providers/model-port.ts`, 제공사 연결은 `provider-adapter.ts`, 오류 변환은 `provider-errors.ts`에 작성한다. 모델·공급사·예산은 아직 선정하지 않았다.

## 설정과 기존 자료 — 과거 검증 이력

- `supabase/config.toml`은 민규 전용 로컬 설정이다. 55421/55422 포트와 격리된 project_id를 사용한다. 일반 가입은 차단하고 로컬 Auth admin이 만든 가상 계정만 비밀번호로 검사했다. 운영 PASS/문자 인증을 대신하지 않는다. service-api는 자체 인증을 사용하도록 gateway JWT 검사만 해제하며 Edge 호스팅 검증은 NOT_RUN이다.
- `supabase/functions/deno.json`의 `check:common`, `check:service`는 Deno 2.9.6에서 PASS다. 실제 HTTP 검증은 같은 런타임 factory를 독립 Deno 서버에서 실행했다.
- 기존 `test-phone-auth`, `test-institutional-email-auth`와 사본 파일은 보존한 자료이며 새 상용 인증으로 연결하지 않았다.
- 기존 마이그레이션 20개는 수정하지 않았고 신규 6개를 추가했다. 총 26개를 PostgreSQL 17.6에서 처음부터 재생했다.
- 현재 `.gitkeep`은 기존 폴더 공유용 표시로 유지한다. 실제 코드 역할은 없다.
- 단위 검사 81개, SQL 권한/상태 스위트 6개, 독립 DB 세션 경쟁 6개, 실제 JWT/HTTP 통합 시나리오 8개를 통과했다. 외부 공급사·모델·Edge 호스팅·운영 배포 검증은 NOT_RUN이다. 자세한 범위는 민규 현황을 확인한다.

## 구현 완료 확인

담당 기능의 계약을 채우고 `handler → service → repository / integration` 경로로 구현한다. AI는 허용 검색 도구와 모델 어댑터를 통해 동작하도록 연결한다. 관련 권한·정상·실패·동시 처리 사례를 검증한 후 코드 주석과 문서의 미구현 표시를 갱신한다. 미정 공급사나 정책을 가짜 성공 응답으로 대신하지 않는다.
