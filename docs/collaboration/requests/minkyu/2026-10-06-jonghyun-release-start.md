# 종현: 최신 GitHub를 받고 첫 작업 시작

## 2026-10-20 현행 기준과 이 문서의 적용 범위

이 문서는 과거 요청·설계·검증 기록이다. 아래 원 관찰·명령·해시·PASS/FAIL은 당시 증거로 보존한다. 재개할 때는 다음 현행 조건을 먼저 적용하며 과거 작업 권한·보류를 현재 지시로 재사용하지 않는다.

- 담당은 현재 민규=BE·AI·검색·행사·서버 운영, 종현=FE·UX/UI·앱 API/세션 소비·빌드, 유미=UT·출시/지원 책임이다. 아래 옛 종현 BE·성호 UI 배정은 당시 기록이며 현재 실행 권한으로 사용하지 않는다. 구체 파일은 현행 소유권 정책을 따른다.

- 포텐스닷 문의 회신은 사용자가 공유했다. 공급사는 교육·프로토타입 범위, 일일/기간 제한·기능 축소·보안 우려로 공개 서비스에는 다른 API를 권고했다. 보관·학습·삭제·공동 사용의 구체 조건은 여전히 미확인이다. 포텐스닷 제품 활성화를 기다리는 계획으로 읽지 않는다. Gemini는 종현 테스트 전용 프로젝트에 결제 연결·월50,000원 사용중단 예산을 준비했으나 최종 청구가 지연 없이 반드시 5만원 이하라는 보장은 아니다. 합성 테스트와 대표 유미 계정 전환·제품 adapter·실회원 전송은 별도다. 대표 계정 전환은 회의/브랜치 통합 때 진행한다. Potens 기술 토큰 원장과 Gemini 원화 지출 원장은 분리한다.

- KOPIS는 전체 공연·연극·뮤지컬·클래식·국악·대중음악·무용·대중무용·서커스/마술·복합·아동·대학로·내한·축제 14항목, 어제까지 최근7일·매일 갱신이다. basedate 누락만으로 영구 공개 보류하지 않고 공식 사이트의 실제 기간·조건·공연ID/순위/순서를 대조한 분류만 공개하는 A안을 적용한다. 요청 날짜로 기간을 확정하거나 일일순위를 합산하지 않는다. 확인 기간·시각·출처를 표시하고 실패 때 마지막 검증 기간을 유지한다. 아래 all/musical·basedate 필수 parser·not_enabled는 현재 구현/당시 검증의 기술적 한계이며 최신 제품 정책이 아니다. 일반 공연 수집·칼럼 매핑은 순위 대조와 병행한다.

- 서울은 키/응답의 평문 HTTP 수집을 활성화하지 않는다. 검토된 HTTPS 자동 수집 경로·실제 최신 응답 envelope·페이지 재개·진행 중 갱신 확인까지 보류한다. 홈페이지 HTTPS 성공이나 HTTP 앞에 s를 붙인 주소는 API 전송 보안 검증이 아니다. 이 보류는 다른 공급사·공통 칼럼/화면 준비의 중단을 뜻하지 않는다.

최신 기준: [정책.md](../../../../정책.md). 구현과 남은 조건: [서버·DB 대조 원장](../jonghyun/2026-10-20-policy-implementation-audit/server-audit.json).


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
