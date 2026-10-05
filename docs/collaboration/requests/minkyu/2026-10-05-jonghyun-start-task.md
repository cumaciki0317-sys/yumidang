# 종현 작업 시작: 상주 큐 실행기 연결

작성자 `minkyu`, 2026-10-05. GitHub의 `minkyu/handoff-20261005`를 시작 기준으로 종현에게 첫 구현을 맡긴다. 종현의 별도 clone에서 `jonghyun/queue-integration` 브랜치를 만들고 아래 작업을 지금 구현한다. 자기소개만 받은 상황과 다르므로 계획 설명에서 멈추지 않는다. [GitHub 시작·제출 안내](2026-10-05-jonghyun-start.md)를 따른다. ZIP이나 별도 launcher는 사용하지 않는다.

## 처음 구현할 것

**기존 queue-runner가 전용 DB 역할로 접속하고 세 종류 작업을 올바르게 분기·재개하도록 연결한다.** 검색·AI·모바일을 동시에 다시 만들지 않는다. 지금 첫 작업에 집중하고 검증 결과와 민규 연결 요청을 남긴다.

| 순서 | 현재 실제 gap | 구현 완료 기준 |
| --- | --- | --- |
| 1 | `queue-runner.mjs`는 DB 접속 뒤 SET ROLE 없이 LISTEN/3RPC를 사용한다. localhost이면 TLS도 꺼진다. | 매 연결·재접속에서 고정 `yumidang_worker_queue`로 전환·검사한 후 LISTEN/조회/READY를 허용한다. 별도 NOINHERIT LOGIN의 SET-only membership과 승인된 CA 검증 경로를 실제 코드로 지원한다. 권한/CA 거절은 closed다. |
| 2 | `background.mjs`는 `review_summary`/`event_sync` 두 종류와 제외 상한2만 허용한다. | SQL의 `member_cleanup`까지 정확한 세 종류·제외·afterKind 교대를 지원한다. 한 종류의 미설정/빈 실행으로 다른 종류를 굶기거나 무한 즉시 재조회하지 않는다. |
| 3 | cleanup dispatch가 없고 빈 실행은 `counts.claimed`만 읽는다. | 같은 승인 origin의 고정 cleanup 경로로 POST `{}`를 보내고 최상위 `claimed`/`succeeded`를 검증한다. 기존 review/event 응답과 구분해 투영한다. 실제 claimed0은 그 drain에서만 제외한다. |
| 4 | HTTP 최대75초에 caller 취소 후 `finally`에서 전역 점유를 바로 해제한다. M 배치는 전역 최대180초를 사용할 수 있다. | 응답 소실/timeout/JSON 오류의 경우 원격 처리가 종료됐다고 가정하지 않는다. 기존 점유를 연장하지 않고 다음 runner와 중복 Provider 효과가 생기지 않는 종결·해제 계약을 M과 맞춘다. 근거 없는 timeout 숫자 변경으로 완료 처리하지 않는다. |
| 5 | fake Client 재접속 검사가 실제 전용 LOGIN/TLS/J 실행기의 증명이 아니다. | 실제 J 코드의 접속→역할→LISTEN→due 재조회→kind HTTP→안전한 해제와 자동 재접속을 격리 합성 환경에서 검증한다. 필요한 환경은 M에게 의뢰하고 준비 전에는 NOT_RUN으로 남긴다. |

## 소유 범위와 읽을 파일

첫 구현은 다음 기존 J 파일에서 진행한다. 편집 전 각 경로를 ownership 도구로 확인한다.

- `backend/supabase/functions/scheduled-jobs/queue-runner.mjs`
- `backend/supabase/functions/_shared/jobs/background.mjs`
- `tests/functions/jonghyun/background-runner.test.mjs`
- 작업 결과·M 변경 요청: `docs/collaboration/requests/jonghyun/`의 자기 새 문서

다음은 읽기·계약 근거이며 J가 직접 수정하지 않는다.

- [PLAN.md](../../../../PLAN.md), [PLAN_상세설계.md](../../../../PLAN_상세설계.md)의 11장 및 6~9장, [AGENTS.md](../../../../AGENTS.md), [정책.md](../../../../정책.md), [backend/README.md](../../../../backend/README.md).
- [소유권](../../../../backend/ownership.json), [협업 규칙](../../README.md). 마이그레이션·공통 auth/config/client·최상위 문서·`tools/local/`·`backend/package.json`과 `backend/contracts/worker-jobs.md`는 민규 소유다.
- `backend/supabase/migrations/20261005040100_worker_queue_schedule.sql`, `20261005040300_worker_queue_runner_role.sql`, `20261005001456_global_worker_lease.sql`.
- `backend/supabase/functions/service-api/handler.ts`, `index.ts`, `_shared/services/member-lifecycle-service.ts`, `_shared/auth/member-cleanup.ts`, `_shared/db/repositories/member-cleanup.ts`.
- [전용 LOGIN/TLS 연결 요청](2026-10-05-worker-queue-login-runner-connection.md), [cleanup 포트 연결 요청](2026-10-05-member-cleanup-worker-connection.md), [HTTP 시간 초과 연결 요청](2026-10-05-cleanup-queue-timeout-handoff.md). 과거 제안/NOT_RUN 문구와 이후 실제 증거를 구분한다.

## 현재 사용할 계약

DB 실행기는 전용 LOGIN에서 고정 NOLOGIN 역할 `yumidang_worker_queue`로 SET ROLE한다. LOGIN의 membership은 ADMIN=false/INHERIT=false/SET=true다. owner/completion 계정이나 service key를 runtime DB credential로 재사용하지 않는다. 역할 생성·멤버십·공통 권한·LOGIN/TLS credential provisioning은 M 책임이다.

실행기의 DB 호출은 다음 세 개뿐이다. raw table SELECT, cleanup5, budget, Auth/Storage 관리 권한을 추가하지 않는다. LISTEN 채널은 `yumidang_worker_jobs`이며 payload는 빈 신호다.

| RPC | 인수/응답 |
| --- | --- |
| `read_worker_queue_schedule` | `p_exclude_kinds text[]`, `p_after_kind text`; `{serverNow,nextDueAt,nextKind}`. 종류는 `review_summary`, `event_sync`, `member_cleanup`. 비어 있으면 due/kind는 null이다. |
| `acquire_worker_run` | `p_lease_seconds integer`, `p_worker_run_token uuid`; 새 점유는 현재 runner처럼 `(180,null)`로 요청한다. 점유 충돌은 null, 성공은 `{token,expiresAt}`. 기존 token 재취득/자동 연장 금지. |
| `release_worker_run` | `p_worker_run_token uuid`; `{status:'applied'|'lease_lost'}`. 종결이 확인되지 않은 원격 작업이 있을 때의 해제는 별도 시간 초과 계약을 따른다. |

Cleanup은 같은 승인 origin의 `/functions/v1/service-api/internal/member-cleanup`으로 보낸다. 서버 내부 route는 `/internal/member-cleanup`이다. 요청은 `Authorization: Bearer <내부 secret>`, UUID `x-worker-run-token`, JSON `{}`, query 없음이다. 회원 JWT·body token·임의 실행 대상·한도를 입력으로 받지 않는다. secret/토큰/Provider 응답은 로그에 남기지 않는다.

성공 envelope의 `data`는 **`{status:'ran',claimed:number,succeeded:number}`**이며 `counts`로 중첩되지 않는다. `0≤succeeded≤claimed≤20`인 정수만 허용한다. M은 임의 `not_enabled` 성공 응답을 만들지 않는다. 기본 service-api 진입점은 cleanup 옵션을 자동 활성화하지 않으므로 준비하지 않은 환경에서 실제404/거절을 성공·worker ready로 바꾸지 않는다. 배포 옵션/내부 secret 주입은 M 연결 요청으로 남긴다.

M cleanup은 DB `remainingMs` 예산, 새 task 최소60초 여유, 개별 task 최대60초, 최대20건 배치를 사용한다. budget RPC는 M HTTP 내부에서만 사용한다. runner의 raw `expiresAt`와 host 시계 차이만으로 안전한 잔여 시간을 증명했다고 하지 않는다. 토큰 만료·실제 지연·중단 이후 효과는 시간 초과 요청 문서의 경계를 따른다. `event_sync` 슬롯/분기 지원을 실제 공급사 행사 동기화 완료로 표현하지 않는다.

## 이번에 증명된 것과 아직 할 것

M 팀은 격리 로컬 native65 SQL 적용·회원 API14그룹·cleanup의 실제 로컬 REST/Auth/Storage 및 hosted HTTP를 검증했다. 각각 합성 자료·해당 임시 승인 범위의 증거이며 마지막 guard/ACL은 닫힌 상태로 원복했다. 운영 서버에65가 배포됐거나 종현 컴퓨터에 같은 DB/credential이 있다는 뜻이 아니다.

별도 독립 PG17에서 전용 LOGIN/TLS/3RPC/권한 거절과 LISTEN의 COMMIT/ROLLBACK/수동 재접속을 실제 검증한 증거도 있다. 해당 임시 환경은 정리됐다. 종현 queue-runner의 SET ROLE·TLS·자동 재접속·cleanup dispatch·세 종류 공정성은 그 증거로 대체하지 않는다.

지금 바로 할 수 있는 일은 기존 코드 구현과 가상 Client/fetch 테스트다. 실제 연결 단계는 코드 자체가 SET ROLE/TLS를 수행해야 하며, 테스트 adapter가 몰래 전환하거나 TLS 옵션을 바꿔 준 성공은 인정하지 않는다. 외부 AI·행사 공급사·실회원 삭제·운영 DB/역할 활성화는 이번 시작 지시의 범위가 아니다.

## 테스트와 보고

프로젝트 루트에서 Node 22.18 이상을 사용한다. 키 없이 다음 구문/기존 단위 테스트부터 진행할 수 있다.

```sh
node --check backend/supabase/functions/scheduled-jobs/queue-runner.mjs
node --check backend/supabase/functions/_shared/jobs/background.mjs
node --test tests/functions/jonghyun/background-runner.test.mjs
```

의미 있는 추가 검증은 SET ROLE 성공/거절 후 호출 순서, 재접속에서 ROLE→LISTEN→조회 재실행, CA/config 거절, 세 종류 교대·claimed0·미설정 처리, cleanup 최상위 DTO 오류, HTTP timeout/응답 소실과 점유 해제 경계다. 전체 저장소 포맷·자동 수정·대량 staging은 하지 않는다. 키가 없어도 코드·테스트는 진행하고 실제 통합은 NOT_RUN으로 정확히 남긴다.

완료 보고에는 변경 파일·검증 명령/결과·실제 통합 여부·남은 M 요청을 포함한다. M 요청은 필요한 서명·DTO·config/환경 이름·완료 조건을 자신의 요청 폴더에 쓴다. 운영 guard/권한을 직접 열지 않는다. 커밋/푸시/운영 활성화는 자동으로 하지 않는다.

## 실행기에 전달할 작업 프롬프트

```text
유미당에서 작업자 jonghyun으로 아래 첫 구현을 지금 시작하세요.

이 문서 docs/collaboration/requests/minkyu/2026-10-05-jonghyun-start-task.md를 끝까지 읽고 따르세요.
현재 작업 공간의 PLAN.md, PLAN_상세설계.md, AGENTS.md와 정책.md를 먼저 읽으세요.
PLAN_상세설계 11장 책임/계약, 6~9장 흐름/검증, backend/README.md,
backend/ownership.json과 docs/collaboration/README.md를 확인하세요.
첫 응답에는 현재 workspace의 PLAN/상세/AGENTS 링크, 담당 범위와 우선 계획을 짧게 설명한 뒤 바로 구현하세요.
이것은 자기소개만 받은 요청이 아니라 명시적인 작업 시작 지시입니다.

공유 민규 worktree/인덱스를 사용하지 말고 제공된 종현 별도 clone/worktree에서 작업하세요.
작업자 jonghyun을 유지하고 고립된 본인 저장소의 actor/hook 설정을 읽기 확인하세요.
복잡한 작업에는 harness agent team을 사용하되 runner/background/tests를 에이전트별 단독 수정으로 나누세요.
편집 전에 아래 경로의 ownership을 --actor jonghyun으로 검사하세요.

첫 작업:
backend/supabase/functions/scheduled-jobs/queue-runner.mjs
backend/supabase/functions/_shared/jobs/background.mjs
tests/functions/jonghyun/background-runner.test.mjs
에서 전용 LOGIN→고정 yumidang_worker_queue SET ROLE/TLS 확인→LISTEN→due 재조회,
세 종류 review_summary/event_sync/member_cleanup 분기/교대,
cleanup의 고정 HTTP 경로 및 최상위 claimed/succeeded DTO를 연결하세요.
75초 caller timeout/180초 global lease와 원격 작업 종료·점유 해제 경계는 기존 M 요청을 읽어 안전하게 맞추세요.
전역 점유 연장/새 권한/모델 공급사 활성화/정책 추측으로 해결하지 마세요.
원래 J 파일에 구현하고 대체 runner/범용 서버 폴더를 만들지 마세요.

민규 소유 migrations/auth/config/client/최상위 문서/tools/package/worker-jobs 계약은 읽기만 하세요.
필요한 변경은 docs/collaboration/requests/jonghyun/ 자기 새 문서에 요청하세요.
민규 PC 임시 경로·키·토큰을 본인 필수 설정으로 복사하지 마세요.
현재65와 M API/cleanup 개별 검증을 실제 J 실행기/운영 배포 완료로 해석하지 마세요.

Node 구문 검사와 기존 background-runner 테스트를 실행하고 위 실패·재접속·세 종류·DTO 경계를 보강하세요.
키/환경이 없어도 구현·단위 테스트는 끝내고 실제 전용 LOGIN/DB/HTTP 연결은 NOT_RUN으로 남기세요.
실제 연결에 필요한 M 환경 준비를 자기 요청 문서에 구체적으로 남기세요.
바뀐 파일, 테스트 결과, 실제 검증 범위와 남은 M 연결 사항까지 보고하세요.
```
