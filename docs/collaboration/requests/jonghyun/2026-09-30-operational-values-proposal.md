# 운영값 보수 제안 — 민규·팀 검토용 (2026-09-30, 미확정)

사용자 결정 U6·U7: Claude가 **보수적인 제안값**을 만들고 민규·팀이 검토해 확정한다. 아래 값은 **제안일 뿐 확정이 아니다.** 코드는 모든 값을 기본값 없이 환경값으로만 받으며, 값이 없으면 해당 기능만 꺼진다. 실제 사용량 데이터가 없어 출시 후 조정이 필요하다. 확정하면 [정책 T5](../../../../정책.md#follow-ups)에 날짜·결정자를 적고 환경에 입력한다.

**전제:** 추가 유료 지출 0원(요금제 근거 T2 대기), 한 응답이 오래 걸리지 않을 것, Supabase Edge 함수 1회 실행 시간 한도(요금제별 상이 — **배포 요금제에서 공식 수치 재확인 필요**) 안에서 끝날 것.

## 1. AI 탐색 (`ai-chat`)

| 변수 | 제안 | 이유 |
|---|---|---|
| `AI_CHAT_MAX_MESSAGES` | 20 | 한 탐색의 주고받기 10번 정도. 넘으면 “조건 유지한 채 새 탐색” 안내 |
| `AI_CHAT_MAX_MESSAGE_CHARS` | 500 | 조건 설명에 충분, 긴 붙여넣기 방지 |
| `AI_CHAT_MAX_TOTAL_CHARS` | 4000 | 모델 입력을 작게 유지(비용·속도) |
| `AI_CHAT_MAX_OUTPUT_TOKENS` | 800 | 조건 해석 결과는 짧은 JSON |
| `AI_CHAT_SEARCH_PAGE_SIZE` | 20 | 기존 공고 검색 기본 페이지 크기와 같음 |
| `AI_CHAT_MAX_SEARCH_PAGES` | 3 | 한 요청에서 최대 60건만 훑음(느려지지 않게). 넘으면 ‘일부만 확인’ |
| `AI_CHAT_RECHECK_MAX_PAGES` | 5 | 응답 직전 재확인은 탐색보다 조금 넉넉히(새 공고로 밀린 카드 찾기) |
| `AI_CHAT_MAX_RESULT_CARDS` | 10 | 화면 한 번에 보기 좋은 수 |
| `AI_CHAT_MATCH_BATCH_SIZE` | 10 | 성향 비교 1회에 후보 10명 |
| `AI_CHAT_MAX_MATCH_CALLS` | 3 | 요청당 모델 호출 최대 4회(해석 1 + 비교 3)로 비용 상한 |
| `AI_CHAT_MATCH_MAX_OUTPUT_TOKENS` | 600 | 비교 결과는 similar/different 목록뿐 |

## 2. 후기 요약 worker

| 변수 | 제안 | 이유 |
|---|---|---|
| `REVIEW_SUMMARY_WORKER_MAX_JOBS_PER_RUN` | 10 | 한 번 실행에 작업 10건까지 |
| `REVIEW_SUMMARY_WORKER_TIME_BUDGET_MS` | 60000 | 1분. Edge 실행 시간 한도보다 충분히 짧게 |
| `REVIEW_SUMMARY_LEASE_SECONDS` | 180 | 실행 시간보다 길어야 쓰기가 거절되지 않음(코드가 lease > 실행 시간 검사) |
| `REVIEW_SUMMARY_RETRY_MAX_ATTEMPTS` | 3 | 실제 실패만 3번까지(정상 이어가기는 세지 않음) |
| `REVIEW_SUMMARY_RETRY_BASE_DELAY_MS` / `..._MAX_DELAY_MS` | 600000 / 21600000 | 10분부터 늘려 최대 6시간. 공급사 장애 때 몰아치기 방지 |
| `REVIEW_SUMMARY_BUDGET_DEFER_MS` | 3600000 | 한도 소진 시 1시간 뒤 다시(실패 아님) |
| `REVIEW_SUMMARY_MAX_INPUT_CHARS` | 12000 | 한 번에 보내는 후기 분량 상한 |
| `REVIEW_SUMMARY_MAX_REVIEWS_PER_CHUNK` | 20 | 묶음당 후기 20개 |
| `REVIEW_SUMMARY_MERGE_FAN_IN` | 4 | 중간 요약 4개씩 합침 |
| `REVIEW_SUMMARY_MAX_OUTPUT_TOKENS` | 800 | 요약 JSON 응답 상한 |
| `REVIEW_SUMMARY_MAX_OUTPUT_CHARS` | 600 | 프로필 화면에 들어갈 요약 길이 |
| `REVIEW_SUMMARY_MAX_CALLS_PER_STEP` | 3 | 작업 1건을 한 번에 3호출까지 처리 후 양보 |

## 3. 장소·행사·일일 실행

| 변수 | 제안 | 이유 |
|---|---|---|
| `PLACES_PAGE_SIZE` | 10 | Kakao 최대 15 안에서 작성 화면에 충분 |
| `EVENT_SYNC_PROVIDERS` | `kopis,tour-api` | 연결 확인된 두 제공처 |
| `EVENT_SYNC_MAX_PERIOD_DAYS` | 31 | 두 제공처 공통 기술 상한 |
| `EVENT_SYNC_MAX_PAGE` | 5 | 하루 수집을 작게 시작 |
| `EVENT_SYNC_PAGE_ROWS` | 100 | 공급사 최대치(요청 수 최소화) |
| `EVENT_SYNC_DAILY_PROVIDERS` | `kopis,tour-api` | 위와 같음 |
| `EVENT_SYNC_DAILY_TIME_ZONE` | `Asia/Seoul` | 한국 날짜 기준 |
| `EVENT_SYNC_DAILY_WINDOW_DAYS` | 31 | 오늘부터 한 달 앞 행사 |
| `EVENT_SYNC_DAILY_MAX_PAGES` | 5 | 제공처당 하루 최대 500건 |
| `EVENT_SYNC_DAILY_TIMEOUT_MS` | 15000 | 페이지 1건 호출 대기 상한 |
| `DAILY_SUMMARY_WORKER_MAX_INVOCATIONS` | 1 | 일일 실행 전체가 Edge 시간 한도 안에 끝나도록 worker는 1번만 |
| `DAILY_SUMMARY_WORKER_TIMEOUT_MS` | 75000 | worker 실행 시간(60초)보다 길게 |
| 일일 실행 시각 | 매일 00:01 Asia/Seoul | 사용자 결정 U4 |

**주의(민규 확인):** 일일 실행은 한 Edge 호출 안에서 공개 정리 → 행사(제공처 2 × 최대 5페이지) → worker(최대 75초)를 차례로 한다. 배포 요금제의 실행 시간 한도가 짧으면 worker 호출을 별도 예약(예: 00:10)으로 분리하는 편이 안전하다.

## 4. AI 예산 원장 (U7)

원장은 “이 기간에 AI를 이만큼만 쓴다”는 상한이다. 호출 전에 예산을 예약하고 끝나면 실제 사용량으로 정산한다. 서버가 중간에 멈춰 사용량을 모르는 호출은 예약량 전체를 쓴 것으로 남긴다(초과 지출 방지). 그래서 원장을 주기적으로 새로 만든다.

| 항목 | 제안 | 이유 |
|---|---|---|
| 합성 평가 원장(T2 직후) | `ai-synthetic-eval-2026-10`, 호출 10회, 단위 100,000 | 합성 사례 10회 계획. 1회 최대 약 1만 단위(입력 바이트+출력 상한)로 넉넉히 잡고 10회로 막음 |
| 운영 원장 교체 주기 | **매월 1일 00:05 Asia/Seoul**에 새 원장 `ai-YYYY-MM` | 요금제·한도가 보통 월 단위이고, 중단 예약이 한 달 넘게 쌓이지 않음. 일일 실행(00:01)과 겹치지 않게 00:05 |
| 즉시 교체 조건 | ① 요금제·일일 한도 변경 ② 미정산 예약(`openCalls`)이 월 호출 한도의 5% 이상 ③ 장애로 서버가 반복 중단된 뒤 | 쓰지 않은 예산이 소진된 것으로 쌓여 AI가 일찍 꺼지는 것 방지 |
| 운영 호출 한도(월) | **요금제 월 허용량의 50%** (T2 자료로 계산) | 절반만 써서 요금제 초과·예상 밖 사용을 막음. 자료 전에는 운영 원장을 만들지 않음 |
| 운영 단위 한도(월) | 확인된 토큰 허용량의 50%. 토큰 한도가 없으면 “호출 한도 × 1회 최대 단위(약 1만)” | 위와 같음 |
| 이전 원장 | 삭제하지 않고 보존 | 월별 사용량 기록. 원문은 저장되지 않음 |

원장 설정은 service 권한으로 `configure_ai_budget_ledger(원장ID, 단위한도, 호출한도)`, 현황은 `get_ai_budget_ledger(원장ID)`로 본다(제안 SQL 01). 새 원장을 만든 뒤 환경값 `AI_BUDGET_LEDGER_ID`를 바꾸면 적용된다.
