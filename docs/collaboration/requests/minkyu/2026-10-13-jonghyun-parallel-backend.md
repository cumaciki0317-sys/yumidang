# 종현 백엔드 병렬 작업 배정 — 2026-10-13

전체 **79%(22/28)**, 핵심9/10·추가5/6·독립5/5·운영3/7. 사용자가 종현에게 백엔드 작업을 넓게 배정하고 민규와 동시에 진행 가능한지 재확인하도록 요청했다. **성호에게 신규 작업을 배정하지 않는다.** 화면 소유권을 종현으로 바꾸거나 전체28의 화면 소비 완료 조건을 제거하지 않는다.

## 배정 기준과 현재 상태

- 현재 민규 실행 소스는 `37863a66e50467f707961a7036a6efae604cb6dc`다. 종현은 자기 clone의 실제 HEAD·미커밋·actor=`jonghyun`·hook·최신 ownership을 먼저 확인한다. 민규 컴퓨터의 절대 경로·private receipt가 종현 컴퓨터에도 있다고 가정하지 않는다.
- 아래9묶음을 **종현 담당으로 배정**한다. 지금 확인된 것은 소유권과 병행 가능성이다. 종현의 실제 착수·구현·원격 전달 완료를 의미하지 않는다. 초기 인계 작성에서는 커밋·푸시하지 않았다. 사용자의 후속 “푸쉬해줘” 요청으로 현재 `minkyu/backend100-20261012` 브랜치에 인계와 최신 검증 기록을 커밋·일반 푸시한다. 원격 전달 완료는 푸시 후 remote SHA 대조로 확인하며 외부 메시지는 보내지 않는다.
- 종현의 기존 담당 범위 안에서 배정하며 정책·hook·actor를 바꾸지 않는다. Root가 실제 존재하는 대표44개 경로의 `--actor jonghyun` 검사를 통과했다. 담당 주석·과거 README 표보다 최신 ownership의 가장 구체적인 경로가 우선한다.
- 기존 summary14·AI22/23의 종현 격리 PASS, 5종 실행기·공개 탈퇴/ACK 복구·유지관리 PASS를 보존한다. 민규 과거0/14 기록을 종현 전체 실패로 해석하지 않는다. C20은 읽음 실제DB 범위, C21은 실제 로컬 Auth·합성 모델 AI·공개 AI 동의 철회 범위다.

## 종현 업무9묶음

| ID·우선순위 | 맡길 잔여 작업 | 기존 책임 경로 | 완료 증거·선행조건 |
|---|---|---|---|
| J01·즉시 | 행사 HTTP 확정 필터3개 연결과 상세 소비 계약 | `backend/supabase/functions/service-api/events-http.ts`, `service-api/handler.ts`, `_shared/db/repositories/events.ts`, `_shared/integrations/events/detail.ts` | includeOngoing/freeOnly/performanceGenre 엄격 전달, 잘못된 값·중복키·충돌조합 거절, 변경 필터 커서 거절, 최신 상세·긴 가격·숨김 제외·공고/AI 카드 DTO 일치. 기존 상세·순위 endpoint는 보존한다. |
| J02·준비 즉시/수집 조건부 | 서울 최신 응답 구조와 안전한 자동 수집 | `_shared/integrations/events/seoul.ts`, `normalize.ts`, `_shared/jobs/event-collection.ts`, `event-runtime.ts` | OA-23041 aiViewCulture의 envelope·오류·페이지·필드·진행 중 갱신 계약을 공식 근거와 실제 응답으로 연결. HTTPS 데이터 경로를 확인하기 전 비활성 유지. HTTP fallback·TLS 완화 금지. |
| J03·준비 즉시/공식 근거 조건부 | KOPIS 공식 최근7일 전국전체/뮤지컬 Top10 | `_shared/integrations/events/kopis-ranking.ts`, `kopis.ts`, `_shared/db/repositories/events.ts` | basedate 또는 공급사가 공식 확인한 동등한 기간 증거, 실제 정렬·동률·갱신·0건/오류 구분·저장 snapshot. 요청 날짜·자체 순위를 공식 기간 근거로 대체하지 않는다. |
| J04·준비 즉시/실측 조건부 | 공급사 모델·usage·출력 상한·개인정보 계약 | `_shared/ai/providers/potens-adapter.ts`, `runtime.ts`, `privacy.ts`, `provider-errors.ts`, `observability.ts` | 실제 제공 모델·입출력 사용량·공식 단위·출력 제한 적용을 기존 adapter에 연결. 보관/학습/캐시/백업/삭제/공동계정 근거표. 확인되지 않은 usage는 UNKNOWN/null 유지. 회원 원문 전송은 기존 보류 유지. |
| J05·J04와 연결 | 실제 공급사 전송 전 계정 선택과 전송 후 실패 소비 | `_shared/ai/providers/account-pool.ts`, `budget.ts`, `potens-adapter.ts` | 기존 원자 예약·등록 계정별/전체 상한을 실제 provider 오류 계약에 연결. 전송 전 부족은 다음 계정, 전송 후 오류/응답 유실은 재전송·자동 전환 없이 원 예약/UNKNOWN 보존. 기존 AI23 합성 원장 검사는 재작성하지 않는다. |
| J06·증거 인계 우선 | 후기 요약의 현재 소스·실제 연결/철회 경계 | `_shared/ai/Agents/review-summary/`, `_shared/db/repositories/review-summaries.ts`, `review-summary-worker/`, `tests/integration/jonghyun/isolated_summary_contracts.py`, `isolated_summary_factory.ts` | 자기 환경의 기존14 PASS 원 영수증·소스 pins를 대조해 안전하게 인계. 공개 한마디3개·적격 근거 전체·revision·동의철회/숨김/삭제 게시 무효화의 변경/미검증 연결만 추가 검증한다. 변경·증거 부재·실제 연결 공백이 없으면14개를 다시 실행하지 않는다. |
| J07·소비 연결 우선 | 성공 증거→helpful/신고→주기 파기 | `ai-chat/handler.ts`, `_shared/ai/Agents/chatbot/feedback.ts`, `_shared/db/ai-feedback-client.ts`, `_shared/jobs/ai-feedback-maintenance.ts`, `runtime.ts`, `safety-consumers.ts`, `_shared/services/report-retention-storage.ts`, `service-api/report-operator-http.ts` | results/needs_clarification/no_results 성공 증거, 실패/차단/timeout 성공증거 없음, 같은 요청 유실 복구. 본인 helpful/중복/권한·철회/탈퇴와90일 파기, 제출한 일부≤500자 또는 캡처1개·Storage ACL/접근기록/최종 종결90일 파기. readiness 포트는 이미 구현됐으므로 가짜 ready나 중복 기능을 만들지 않는다. 기존 큐·신고 보관 PASS는 보존한다. |
| J08·화면 제외 | 개별 메시지 읽음의 실제 API·서비스 소비 | `_shared/services/conversation-service.ts`, `_shared/db/repositories/conversations.ts`, `service-api/routes.ts`, `apps/mobile/src/member-service.ts`, `chat-read-state.ts`, `web-member-session.ts`, `remote.tsx` | 실제 본 messageIds1..100, confirmedMessageIds/unreadCount, 잘못된 방·숨김·퇴장·권한 회수와 원 인증 오류 처리. C20 DB 동시성/최초 read_at PASS를 재사용하고 실제 Auth/HTTP/서비스 소비 공백만 검증한다. 화면 배치·렌더링·viewport 수정은 배정하지 않는다. |
| J09·화면 제외/실제 Auth 조건부 | 서비스 탈퇴·원 요청 복구의 API·서비스 소비 | `service-api/member-cleanup-reconcile-http.ts`, `handler.ts`, `routes.ts`, `_shared/services/member-lifecycle-service.ts`, `_shared/db/repositories/member-cleanup.ts`, `apps/mobile/src/member-service.ts`, `web-member-session.ts`, `remote.tsx` | 같은 원 principal/JWT·탈퇴ID·ACK, processing/completed·GET-only 재확인·응답 유실 때 새 요청/일반 세션 복구 없음. 기존 공개 탈퇴→Storage/Auth→ACK 자동복구 PASS를 보존하고 새 signed Auth/HTTP/서비스 소비 공백만 닫는다. Auth ban·C21 AI 동의 철회를 서비스 탈퇴 완료로 대체하지 않는다. |

위 표의 축약 경로는 `backend/supabase/functions/` 아래이며 `_shared/`도 그 아래다. 새 시험은 종현 소유 기존 시험의 책임을 확인해 추가한다. 분류 상위/민규 이름의 기존 시험도 최신 ownership에서 종현인 경로는 사용할 수 있지만 아래 민규12개 예외는 수정하지 않는다. 모든 실제 편집 전 exact path 소유권 검사를 다시 실행한다.

### 첫 작업 J01의 실제 재현

Root가 현재 소스의 순수 `parseEventQuery`를 Node에서 실행했다. `limit=10`은 통과하지만 세 필터를 하나씩 붙이면 각각 INVALID_REQUEST/400이다. 저장소 정규화는 이미 세 필터를 지원한다. **순수 파서 실행 증거이며 네트워크 HTTP·DB 검증은 아니다.**

- 파서 소스 SHA256: `79370c98d4eabde13761aaed4edb1fb1788c87f1d5781578af7ad1e33dcc3aac`.
- private 재현 영수증 SHA256: `aae2ab9e6260fc3d04de87bb8d9bc445a9b2b2399044ae64c741888b27b987af`.
- 종현은 기존 `tests/functions/minkyu/test_event_apis.py` 등 실제 ownership이 허용하는 기존 책임 시험에서 정상 전달·오류·커서 회귀를 보완한다. 이미 존재하는 GET 상세/순위 endpoint를 새로 만들지 않는다.

### 실제로 막힌 부분과 호출 경계

J02의 공식 HTTPS 경로, J03의 공식 집계 기간, J04의 공급사 회신/출력 강제/공동 사용은 코드만으로 사실을 만들어 완료할 수 없다. 기존 공식 근거·원 응답을 먼저 검토하고 확인되지 않은 활성화는 닫아 둔다. 문의 초안 작성과 회신 정리는 가능하나 자동 외부 메시지 전송은 하지 않는다.

기존 합성 공급사 호출·계정 사용량 측정은 기존 승인된 정확한 계정/당일/포함량/호출 범위를 자기 환경에서 확인한 뒤에만 한다. 이전 일회성 승인을 새 날짜나 대표 운영 키에 확대하지 않는다. API 키 존재를 전송/비용 승인으로 간주하지 않는다. 추가 결제·회원 원문 외부 전송·운영 활성화는 이번 배정에 포함하지 않는다.

J07의 실제 캡처 바이트·ACL·접근 감사·파기 조건이 준비되지 않으면 신고 evidence 기능은 비활성이다. 보관 근거·일반 신고 담당·백업 접근/만료·지원/대체 담당은 기존 미정 목록으로 남긴다. J09의 새 실행에 필요한 실제 Auth 발급/정확한 대상·원 영수증은 민규와 경계를 맞추거나 종현 자기 격리 환경의 승인된 검증 준비를 사용한다. 화면 검증과 실회원 HOLD는 미완료 조건으로 유지하며 성호에게 신규 요청하지 않는다.

## 민규 유지 범위와 편집 금지12개

민규는 실제 Auth 수명주기·AI22/23·자연 자정 AI24의 typed 조립/준비·관찰, 전체178 행/권한·Storage 원본39개 복원, 최종 배포 준비를 계속 담당한다. 아래 경로는 종현의 broad backend 이관보다 구체적인 minkyu 예외다.

```text
tests/integration/jonghyun/isolated_ai_contracts.py
tests/integration/jonghyun/isolated_ai_factory.ts
tools/local/prepare_isolated_midnight.py
tools/local/observe_isolated.py
tools/local/run_database_tests.py
tests/database/jonghyun/test_isolated_midnight_preparation.py
tests/database/minkyu/test_signed_auth_binding.py
tests/database/minkyu/test_ai24_live_binding.py
tools/local/prepare_production_backend.py
tests/database/minkyu/test_production_preparation.py
tests/integration/minkyu/product_connection_restore108_local.py
tests/database/jonghyun/test_isolated_observer.py
```

민규가 이미 준비한 helper/검증 계약은 읽기·ABI 재사용만 가능하다. 기존 민규 private root/새 C22 대상/포트/회원/예약/UNKNOWN을 종현 시험에 재사용하지 않는다. J01~J09 내 같은 handler·repository·provider 파일은 종현 팀 안에서도 단독 편집자를 정하고 해당 의존 작업을 순서대로 진행한다.

## 실제 병행·통합 규칙

1. 민규·종현은 별도 clone/worktree·branch·Git 인덱스를 사용한다. 복잡한 업무는 harness 팀으로 구현·권한 검토·복구 검토를 나누고 팀 내부 파일 단독 수정도 유지한다.
2. 종현이 자기 컴퓨터의 전용 격리 환경을 사용할 수 있으면 민규 실제 검증과 병행 가능하다. 이 컴퓨터에는 종현 VM이 없으며 다른 컴퓨터의 중지된 VM을 재시작했다고 가정하지 않는다. 중지된 VM 재시작은 기존 대상별 실행 경계에서 확인한다.
3. 같은 Docker daemon/DB/실행 포트를 쓰면 실제 검증은 같은 시간에 실행하지 않는다. 준비·코드·오프라인 검사는 병행하고, 실제 슬롯은 정확한 target/run ID로 순차 배정한다. 민규의 VM 크기·메모리 기준·기존 컨테이너 상태를 바꾸지 않는다.
4. 종현 변경은 자기 브랜치에서 검증한다. 민규 실제 실행 중 파일 복사/merge/source freeze·binding·SQL 집합 변경을 하지 않는다. 실행 종료·자식과 owned 대상 정리 영수증을 확인한 후 검토한 변경만 통합한다.
5. 통합 후 현재 source57/AI50/union91 closure·119개 migration의 exact version/SHA set(SQL120 파일 포함)과 영향 회귀를 다시 확인한다. 새 HEAD에 맞춰 source freeze/binding을 재발급하고 변경에 영향받은 실제 검증만 다시 한다. 옛 PASS를 새 소스로 확대하지 않는다.
6. 결과는 `docs/collaboration/requests/jonghyun/`의 종현 문서에 변경·실제/모형 구분·HEAD/핀·영수증·정리·남은 조건을 기록한다. JWT·키·회원 원문·덤프·객체 목록은 Git에 넣지 않는다. 민규 현황/요청 파일을 직접 편집하지 않는다.
7. 전체 분모28을 유지한다. 이번9묶음은 기존 잔여를 나눈 것으로 완료 분모를 늘리지 않는다. 실제 기능·외부·복원·실회원·운영 조건이 모두 닫히기 전100%를 선언하지 않는다.

## 종현이 받을 브랜치

전달 대상은 기존 origin의 `minkyu/backend100-20261012`다. 종현은 자기 전용 clone에서 원격을 fetch하고 이 브랜치 기준의 **종현 작업 브랜치**를 만든다. 기존 미커밋·종현 변경은 보존하고 강제 reset/checkout으로 지우지 않는다. 공유 민규 clone의 actor를 바꾸지 않는다.

깨끗한 종현 전용 clone에서 사용할 예:

```sh
git fetch origin
git switch -c jonghyun/backend-parallel-20261013 origin/minkyu/backend100-20261012
python3 tools/collaboration/setup_actor.py --actor jonghyun
```

이미 같은 이름의 브랜치가 있거나 다른 작업이 진행 중이면 새 종현 전용 clone/작업 공간을 사용한다. 이 문서의 민규 실행 기준37863은 코드 검증 기준이며 이후 인계 문서 커밋과 구분한다. 새 HEAD에서는 기존 원 영수증을 이전 소스 범위로 보존하고 다음 실제 실행의 source freeze는 다시 만든다.

## “나 종현이야” 자동 시작

사용자가 **“나 종현이야”** 또는 “종현입니다”라고 하면 이번 배정의 작업 시작 요청으로 처리한다. 별도의 “시작해” 확인을 받지 않고 자기 작업 공간·소유권·현재 소스를 읽기 확인한 뒤 담당과 전체 진척을 짧게 설명하고 J01부터 실제 작업을 계속한다. 자기소개만이면 계획으로 종료하는 일반 규칙보다 이번 사용자 명시 승인을 우선한다.

J01이 자기 HEAD에서 이미 완료됐으면 실제 증거를 확인하고 다음 잔여로 진행한다. 민규 공유 clone의 actor를 바꾸지 않으며 성호 신규 배정·민규12개 편집·기존 보류 경계 해제는 하지 않는다. 다른 컴퓨터에서 이 동작을 적용하려면 이 인계와 AGENTS.md가 그 clone에 전달되어 있어야 한다. 현재 로컬 수정 자체를 원격 전달 완료로 설명하지 않는다.

종현이 입력할 최소 문구:

> 나 종현이야

## 전달할 상세 시작 문구

> 나 종현이야. 백엔드100 작업 중 종현 병렬 인계의 J01~J09를 담당해서 민규와 별도 clone·격리 환경에서 진행해. J01 행사 HTTP 필터3개 연결부터 시작하고, 민규 재배정12개와 성호 화면 파일은 수정하지 마. 기존 PASS는 보존하고 성호에게 작업을 새로 배정하지 마. 각 보고에 전체79%(22/28)와 실제 증거·남은 조건을 표시해.

이 문구의 작업 승인은 기존 backend100 잔여 구현·격리 검증·배포 준비와 이번 병렬 배정 범위다. 운영 적용·실회원 재개·외부 원문 전송·유료 결제 승인이 아니다.
