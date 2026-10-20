<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# 공통 문서 통합 인수인계

2026-10-20 / 작업자 종현. 사용자는 전체 문서 동기화와 현재까지 커밋·푸시를 승인했다. 다만 HEAD 소유권 및 pre-commit 검사는 민규/유미 문서의 종현 직접 커밋을 거절한다. actor·hook·소유권을 바꾸거나 검사를 우회하지 않았다.

## 적용 대상

현재 승인된 전체 문서 동기화의 누적 변경 44개를 이 폴더의 `2026-10-20-common-docs-integration.patch` 하나로 인계한다. 정책.md·PRD·PLAN·최상위 지침·백엔드 계약·민규 인계·UT README가 포함된다. 실제 문서 로컬 수정본은 보존한다. 이전 10/19·10/20 개별 패치와 중복 적용하지 말고 이 누적 패치 또는 각 파일의 최종본 하나를 기준으로 통합한다.

기준 HEAD: `b164021323975c241d7a73145bdd66d9c3e6f097`
패치 SHA-256: `fe2954b691c647382fe0f2e508725299e925a041f340e06ce939edbbda3b0130`

민규는 최신 통합 브랜치에서 `git apply --check docs/collaboration/requests/jonghyun/2026-10-20-common-docs-integration.patch`로 먼저 대조한다. 충돌이 없고 승인된 문서 범위가 맞으면 담당 절차로 적용한다. 다른 변경이 있으면 파일별 대조하며 과거 정책을 새 정책 위에 덮지 않는다. UT README가 필요하면 유미 소유 경계도 확인한다. 이 패치를 푸시한 것만으로 원래 문서 경로의 GitHub 반영 완료가 아니다.

## 포함 경로

- `260929_종현담당_PLAN.md`
- `AGENTS.md`
- `PLAN.md`
- `PLAN_상세설계.md`
- `README.md`
- `backend/API_INPUT.md`
- `backend/README.md`
- `backend/contracts/ai-chat.md`
- `backend/contracts/auth-runtime.md`
- `backend/contracts/completion-db.md`
- `backend/contracts/core-service-db.md`
- `backend/contracts/daily-jobs.md`
- `backend/contracts/db-foundation.md`
- `backend/contracts/event-storage.md`
- `backend/contracts/matching.md`
- `backend/contracts/posts-search.md`
- `backend/contracts/public-post-search-db.md`
- `backend/contracts/reports.md`
- `backend/contracts/review-automation-db.md`
- `backend/contracts/review-summary-db.md`
- `backend/contracts/review-summary.md`
- `backend/contracts/reviews.md`
- `backend/contracts/search.md`
- `backend/contracts/service-api.md`
- `backend/contracts/signup.md`
- `backend/contracts/worker-jobs.md`
- `backend/supabase/functions/_shared/ai/Agents/README.md`
- `docs/collaboration/README.md`
- `docs/collaboration/requests/minkyu/2026-09-28-jonghyun-merge-review.md`
- `docs/collaboration/requests/minkyu/2026-09-29-event-db-handoff.md`
- `docs/collaboration/requests/minkyu/2026-09-29-events-live.md`
- `docs/collaboration/requests/minkyu/2026-09-29-live-api-handoff.md`
- `docs/collaboration/requests/minkyu/2026-09-29-provider-api-review.md`
- `docs/collaboration/requests/minkyu/2026-09-29-provider-config-handoff.md`
- `docs/collaboration/requests/minkyu/2026-09-29-tour-live.md`
- `docs/collaboration/requests/minkyu/2026-10-02-event-http-handoff.md`
- `docs/collaboration/requests/minkyu/2026-10-02-event-latest-display.md`
- `docs/collaboration/requests/minkyu/2026-10-02-kopis-top10-contract.md`
- `docs/collaboration/requests/minkyu/2026-10-08-additional-backend.md`
- `docs/collaboration/requests/minkyu/2026-10-09-backend-execution.md`
- `docs/planning/requirements/PRD.md`
- `docs/planning/ut/README.md`
- `유미당_출시결정_보류사항_민규전달_20261005.md`
- `정책.md`
