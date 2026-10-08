# 종현 다음 작업 — 실행기·AI 연결

종현은 GitHub의 `minkyu/foundation-harness` 최신 변경을 본인 clone에 받아 별도 `jonghyun/` 브랜치에서 시작한다. 구현 기준은 `edfc624`와 이번 민규 SQL95~99·서버 변경이다. 기존8/10·추가5/6이며 서비스 출시 완료를 뜻하지 않는다.

먼저 [추가 백엔드 인계](2026-10-08-additional-backend.md), [소비자·복구 검증](2026-10-08-runner-recovery.md), 저장소 `PLAN.md`, `PLAN_상세설계.md` 11장과 `AGENTS.md`를 읽는다. 종현 소유 파일만 편집하고 SQL·공통 DB 포트 변경은 본인 요청 폴더에 명세를 남긴다.

## 착수 순서와 완료 기준

| 순서 | 종현 작업·대상 | 완료 기준·민규 의존 |
|---|---|---|
| 1 | `functions/ai-chat/`, `_shared/ai/Agents/chatbot/orchestrator.ts`: 실제 성공 경로에 민규 `recordAiResultAvailable` 연결 | 서버 request scope 사용. 실패·unavailable·차단·시간 초과는 증거 미생성. 기록 실패는 성공으로 처리하지 않는다. 실제 연결 검사와 helpful 허용/거절 증빙. 외부 AI 호출은 별도 준비 전 금지 |
| 2 | `functions/scheduled-jobs/`, `_shared/jobs/`: 기존 실행기에서 `/internal/ai-feedback-maintenance` 주기 소비 | 회당 bounded limit·내부 권한·재시작·만료 후 재접수 거절 검사. 새 cron 정책을 임의 생성하지 않는다. AI 신고는 준비 조건 충족 전 비활성 유지 |
| 3 | `_shared/jobs/safety-consumers.ts`, 작업 저장소·scheduler·`scheduled-jobs/queue-runner.mjs`: 공유 배정 한도와 영속 처리 상태 연결 | 기존 작업 수 예산과 RPC 호출 수를 혼동하지 않는다. 먼저 현 ABI와 필요한 포트를 종현 요청 문서로 고정 → 민규 후속 RPC/SQL100 이후 보완 → 실제 연결 검증. 이번 시험 cap20을 제품 정책으로 사용하지 않는다 |
| 4 | 같은 실행기: 자기 전역 점유 중 일정 조회, terminal next-due·유지관리, unknown 복구 | 필요한 자기 토큰·next-due·journal 공통 포트를 민규에게 요청. 오래된 점유 거절·중복 완료 방지·재시작 상태 보존·미확인 DELETE/ACK 자동 추가 전송0회. 파일 시험 journal을 제품 구현으로 복제하지 않는다 |
| 5 | 실제 queue-runner 환경 검사 | 검증 가능한 TLS DB·전용 LOGIN·HTTPS 함수에서 두 실행기 경쟁·연결 유실·자동 재시작을 검사. 로컬 소비자 시험으로 완료 표시하지 않는다 |

경로는 `backend/supabase/` 아래다. 1·2는 기존 민규 포트로 먼저 진행 가능하다. 3·4의 공통 SQL·DB 포트는 민규가 담당하고 종현은 자신의 실행기 구현과 변경 요청을 준비한다. 회원 정리 소비자의 limit/signal도 확인하고 event/member_cleanup을 미지원 claim_supported_job에 넣지 않는다.

## Railway 확인 상태와 담당

- 프로젝트 `yumidang`, 환경 `production`, 서비스 `completion-runner`가 존재하며 화면 접근 확인. 2026-10-08 조회 당시 CRASHED, Node22.23.2·US West·1 replica·Unexposed 상태다. 배포 로그 원인은 아직 미확인이다.
- [서비스 관리 화면](https://railway.com/project/b246af5a-b503-4a6b-81d5-be85e79f99f1/service/61b3f697-a30b-4d6a-82dc-d109aee88514?environmentId=474b39df-df3a-48b1-9d1b-3c0bb98ff3b0).
- 민규: Railway·Supabase 접근, CA/TLS·전용 LOGIN·HTTPS 대상과 최소 권한 준비. 종현: 현 completion-runner와 새 queue-runner 배포 경로 차이를 확인하고 로그·설정 이름·시작 명령을 조사해 본인 요청 문서에 남긴다. 서비스 재시작·운영 배포·권한 확대는 이번 인계 승인 범위에 포함하지 않는다.
- 실행기 자체에 공개 도메인을 생성해야 한다는 뜻이 아니다. HTTPS 함수 호출 대상과 실행기 공개 노출은 별개다. 키·비밀번호·원문·첨부 내용을 Git이나 증빙에 넣지 않는다.

## 제출할 결과

종현 담당 코드·계약·의미 있는 연결 테스트를 본인 브랜치에 제출하고 `docs/collaboration/requests/jonghyun/`에 이 문서를 연결한 완료 답변을 작성한다. 성공/실패 경로, 실제 검증 환경, 부분 검증, 민규 포트 의존을 구분한다. 민규의 실제 소비자·전체 복원 검증은 재사용하되 제품 실행기의 경쟁·재시작 검증은 별도로 수행한다. 실제 자격 있는 네이버 두 계정 준비는 민규의 별도 대기이며 종현의 위 구현 착수를 막지 않는다.
