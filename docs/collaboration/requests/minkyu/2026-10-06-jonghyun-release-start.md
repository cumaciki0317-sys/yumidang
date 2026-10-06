# 종현: 최신 GitHub를 받고 첫 작업 시작

사용자(민규)가 2026-10-06 “푸쉬해 종현이 나 종현이야 말하면 시작할 수 있도록” 요청한 현재 시작 안내다. GitHub 공유 브랜치는 `minkyu/handoff-20261005`, 종현의 기존 작업 브랜치는 `jonghyun/queue-integration`이다. 이미 공유된 종현26aca72를 포함하므로 이전 구현을 다시 만들지 않는다.

## 2026-10-07 최신 인계

종현은 동일한 `minkyu/handoff-20261005`의 최신 변경을 자기 작업 브랜치에 병합한다. 이번 공유 대상은 검토된94개 SQL·일반 이의/제재 정정/종결·다계정 예산 DB 어댑터·공개 요약 API와 실제 검증 기록이다. 민규 잔여 작업8/10 완료이며 운영 배포 완료는 아니다. 기존 원 로컬 이력88과 운영 마지막 읽기 이력20, 각 팀원 환경의 실제 적용 상태를 구분한다.

먼저 [실행기 소비자 연결 요청](2026-10-06-runner-consumer-integration.md)과 [최신 진행 기록](2026-10-06-remaining-progress.md)을 읽고 아래 J1을 진행한다. 이의·안내·AI·삭제 guard는 운영에서 임의 활성화하지 않는다. 아래의 GitHub 공유 완료86개 설명은 이전 인계 이력이다.

## GitHub 공유 완료

코드 인계64ba542를 `minkyu/handoff-20261005`에 푸시했다. 공유본은86개 SQL과 최신 민규 port/설정/숨김 API를 포함하며, 실제 기존 로컬DB84와 운영DB20 이력은 변경하지 않았다. GitHub가 안내한 현재 저장소 위치는 [cumaciki0317-sys/yumidang](https://github.com/cumaciki0317-sys/yumidang/tree/minkyu/handoff-20261005)이다. J는 이 브랜치 최신 내용을 자기 clone에 받아 J1을 시작한다.

## 시작 절차

“나 종현이야”를 받으면 작업자 jonghyun으로 구분한다. AGENTS.md의 현재 사용자 지정 J1 범위에 따라 담당과 첫 계획을 먼저 설명하고, 종현 본인의 별도 clone·브랜치·미커밋 작업을 확인한다. 미커밋은 보존하고 민규 clone/인덱스/설정을 사용하지 않는다. 원격 handoff를 자기 작업 브랜치에 가져와 충돌을 검토한다. 다른 담당 파일의 임의 편집·Git hook 우회로 해결하지 않는다.

처음 안내에는 현재 공간의 [PLAN](../../../../PLAN.md), [상세 설계](../../../../PLAN_상세설계.md), [AGENTS](../../../../AGENTS.md), [협업 규칙](../../README.md), [최종 출시 분담](2026-10-06-backend-release-work-split.md) 링크를 제공한다. 상세 설계11장 담당/계약을 먼저 확인한다. 자기 clone의 actor/hook 상태를 읽고 설정이 필요할 때만 기존 custom hook을 보존하며 연결한다. 민규 actor로 종현 변경을 통과시키지 않는다.

## J1 — 바로 할 일

기존 `_shared/jobs/`, `_shared/db/repositories/jobs.ts`, `scheduled-jobs/`에 취소·신고 소비자를 구현한다. 새 실행기/중복 폴더를 만들지 않는다.

1. DB 예약 exact `{serverNow,nextDueAt,nextKind}`에서 기존 review_summary/event_sync/member_cleanup + cancellation_safety/report_retention을 구분한다. 미지원 종류를 요약URL로 보내는 fallback을 금지한다.
2. `claim_supported_job`에 실제 소비자가 지원하는 종류만 전달한다. 취소 payload exact `{identityId,generation}`, 신고 exact `{reportId,closureProofId}`를 검증한다. generation은1~MAX_SAFE_INTEGER다.
3. 기존 enqueue/process/Storage/메타데이터 RPC 포트를 연결한다. 새 신고 메타데이터 task는 DB가 parent job 완료까지 처리하므로 다시 complete하지 않는다. 취소 반환세대로 임의 새 job을 만들지 않는다.
4. 공유180초·최대20회·DBclock budget·종류 교대와 terminal30일 유지관리 별도 timer를 연결한다. 신규 토큰 재취득·연장·기한 임의 조정을 하지 않는다.
5. 미확정 dispatch/DELETE/ACK는 일반 retry/fail로 전환하지 않고 journal·예약을 보존한다. 자동 재전송/재삭제·성공 집계·조기해제를 금지한다. 자연 lease 만료를 외부종결 증거로 쓰지 않는다.
6. 자기 테스트에서 혼합 큐·미지원 점유0·잘못된 DTO·stale generation/fence·공유예산·빈 큐 no-spin·중단/재접속·응답 유실을 확인한다.

처음은 합의된 typed port/가상 응답으로 시작한다. 민규의94개 SQL 검토 준비와 원 정식 로컬DB88 이력은 다르며, 종현의 로컬DB에 적용됐다고 가정하지 않는다. 민규가 실제 승인 환경·전용LOGIN/TLS·guard/ACL·HTTP 조립을 제공한 뒤 같은 소비자로 실제 통합한다. J1의 승인 범위는 로컬 구현·가상 검증이며 실제 외부호출/운영활성화/자동제출은 포함하지 않는다.

## 반드시 읽을 연결 계약

- [취소·신고 worker](2026-10-06-cancellation-due-worker-connection.md)
- [신고 파기 계약](2026-10-06-report-retention-purge-contract.md)
- [완료 증거 유지관리 포트](2026-10-06-report-retention-maintenance-port.md)
- [현재 숨김·해제 API](2026-10-06-report-hidden-targets.md)
- [다중 계정 서버 설정](2026-10-06-remote-queue-integration.md)
- [종현 다중 계정 인계](../jonghyun/2026-10-06-potens-account-pool-handoff.md)

후속은 출시 분담의 J2 AI 런타임/검증 → J3 검색·행사 → 실제 통합 순서다. 기존 개인정보/출력상한·KOPIS·서울 보류를 임의 해제하지 않는다.

## 산출물

J1 수정 파일과 모형 검사 결과·미검증 조건을 `requests/jonghyun/`에 작성한다. 공통 auth/config/client/SQL/민규 계약 수정은 정확한 인자·DTO·오류/권한 제안으로 요청한다. 커밋/푸시는 별도 사용자 제출 요청에 따라 자기 담당 파일만 검사해 수행한다. 외부 메시지는 보내지 않는다.
