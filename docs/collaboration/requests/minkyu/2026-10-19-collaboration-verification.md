# 담당·문서·협업 검사 대조 — 2026-10-19

대상은 WBS **1.6·1.7·7.10**이다. 이번 검사는 로컬 문서·소유권·작업 환경·기존 검사 체계의 정합성을 확인한다. Notion 재조회/상태 변경, 제품 기능 실행, 배포 검증은 수행하지 않았다. 이 기록만으로 민규44개나 전체 프로젝트의 완료율을 올리지 않는다. 전체 프로젝트 마지막 명시 기준은 **79%(22/28)**다.

## 확인한 작업 환경

|항목|읽기 확인 결과|
|---|---|
|clone|`/private/tmp/yumidang-minkyu-wbs-20261017`|
|HEAD|`9676cb85736435d742e91283d1c30cff1bd8e609`|
|branch|`minkyu/wbs-backend-20261017`|
|작업자 설정|`yumidang.actor=minkyu`|
|hook|`core.hooksPath=.githooks`; 추적 `pre-commit` 실행 모드100755|
|정책 신뢰 기준|`HEAD:backend/ownership.json`; 작업트리/스테이징 정책으로 담당을 바꾸지 않음|
|현재 보호 파일|1,258개: 민규978·종현279·유미1; 미배정0·비활성 성호 소유0|

이 문서만 본 lane의 단독 편집 경로로 추가 승인받았고 편집 전 소유권 검사를 통과했다. 기존 미추적 자료·미커밋 소스7개·인덱스·작업자/hook 설정을 변경하지 않았다. 다른 lane이 맡은 공통 시작 문서와 지침은 직접 편집하지 않았다.

## WBS별 대조와 종료 기준

|WBS|확인된 범위|자료 공백·종료 기준|
|---|---|---|
|[1.6 승인된 문서 차이 반영](https://app.notion.com/p/c85a6def75f883af940901663676f842)|정책/PLAN/상세설계/AGENTS와 협업 문서의 현재 역할은 BE·AI 민규, FE·UX/UI·앱 연동 종현, UT 유미, QA 공통 책임·파일 단독 owner로 일치한다. 현재 역할과 옛 작성자/검증 기록을 구분한다. root가 반영한 AGENTS·공통 시작·민규 시작의 민규 활성44개 전체 종료 기준과10/18 완료 기록 연결도 다시 읽어 확인했다.|전체 담당 대조 문서의 작성·연결을 마무리하고 Notion 최신 상태와 항목별 증거를 대조한다. 문서 반영과 제품 기능/운영 완료를 구분한다.|
|[1.7 담당·소유권·작업 환경 인계](https://app.notion.com/p/526a6def75f882d0a511014db6697359)|actor/본인 branch/hook·HEAD 정책이 일치한다. 실제 경로별10개 양방향 허용/거절 대조가 통과했다. 보호 파일 전체에 현재 단독 owner가 있다.|다른 팀원의 실제 clone 상태까지 검사한 결과는 아니다. 현재 인계는 자기소개 후 담당 잔여를 이어가며 운영/외부 전송/커밋 승인을 확대하지 않아야 한다. 최신 문서의 재개·종료 기준과 현재 파일 owner가 일치하는 것을 확인한 뒤 해당 범위 완료를 판정한다.|
|[7.10 협업 변경 검사 체계](https://app.notion.com/p/621a6def75f883f1a8fa81255cf24217)|순수 기존 회귀9개, HEAD 정책 기반 경로 검사, 담당 밖 거절, 비활성 actor 거절, 로컬 hook 연결과 빈 staged 검사, CI의 trusted base checker 사용을 확인했다.|빈 staged hook 통과는 미커밋 소스7개의 커밋 검사 완료가 아니다. 실제 커밋 요청 시 대상 목록을 확정하고 staged/hook 검사를 다시 한다. 원격 CI 실행은 이번에 수행하지 않았으며 설정 읽기 검토와 구분한다.|

10/14 [WBS 카탈로그](2026-10-14-wbs-task-catalog.json)의 세 작업 상태는 당시 `대기`다. 10/17 [실행 기록](2026-10-17-wbs-execution.md)도 세 작업을 당시 실행 대상 밖으로 남겼다. 최신 Notion 상태는 이번 로컬 검사로 추정하지 않는다.

카탈로그의 `repo_entrypoints`는 영역별 일반 후보라고 명시돼 있으나, 1.6/1.7에 `requests/yumi/`가 들어 있고 7.10에는 jobs/tools-local 후보가 들어 있어 실제 협업 검사 진입점과 다르다. 현재 수정 권한을 부여하는 목록으로 사용하면 안 된다. 실제 진입점은 다음과 같다.

- 1.6: `정책.md`, `PLAN.md`, `PLAN_상세설계.md`, `AGENTS.md`, 최신 실행·인계 문서.
- 1.7: `backend/ownership.json`, `docs/collaboration/README.md`, `team-start.md`, 팀원별 시작 인계.
- 7.10: `tools/collaboration/check_ownership.py`, `setup_actor.py`, `test_ownership.py`, `.githooks/pre-commit`, `.github/workflows/ownership.yml`.

## 실행한 기존 로컬 검사

모든 Python 실행은 `-B` 또는 `PYTHONDONTWRITEBYTECODE=1`로 캐시 쓰기를 막았다. Git 읽기 명령은 후속 검사에서 `GIT_OPTIONAL_LOCKS=0`을 사용했다.

|검사|결과와 범위|
|---|---|
|`python3 -B -m unittest test_ownership.PolicyTests -v` — `tools/collaboration`에서 실행|**9 PASS**. 가장 구체적인 owner, 미배정/다른 owner 거절, 경로 경계, 한국어·공백·rename/copy, 비활성 성호, 제한된 유미, 복수/공통 owner 거절을 검사한다.|
|`sh .githooks/pre-commit`|**PASS, staged0개**. 현재 actor와 hook 연결을 읽기 확인했다.|
|`check_ownership.py --actor minkyu --paths …`|문서·정책·hook·도구와 미커밋 소스7개를 포함한 **16개 경로 PASS**. 이 기록 경로도 별도 PASS.|
|`check_ownership.py --actor minkyu --paths frontend/src/App.tsx`|의도한 **exit1**, 실제 담당 종현.|
|`check_ownership.py --actor yumi --paths backend/ownership.json`|의도한 **exit1**, 실제 담당 민규.|
|`check_ownership.py --actor sungho --paths frontend/src/App.tsx`|의도한 **exit2**, 비활성 actor를 인자 단계에서 거절.|
|`start_jonghyun.py --prepare-only`|의도한 **exit1**. 이전 백엔드 시작을 차단하고 현재 FE·UX/UI·앱 연동 역할을 안내한다. clone/설정/Codex 실행 없음.|
|HEAD 정책의 실제 경로10개 소유자 대조|**10 PASS**. BE/AI·공통 domain·옛 종현 BE 테스트는 민규, FE/모바일 서비스/UI 테스트/설계는 종현, UT/유미 요청은 유미이며 다른 두 actor는 거절한다.|
|문서11개 상대 링크 존재 검사|시작 문서 후속 변경 전 **88개 링크, 결손0**. AGENTS/PLAN/상세설계/정책·협업 규칙·공통 시작·세 시작 인계·재배정·10/18 완료 기록을 확인했다. 후속 작성 중인 새 링크를 포함한 최종 재검사는 별도로 구분한다.|
|`git diff --check`|**PASS**. 당시 기존 추적 변경5개를 검사했으며 미추적 전체의 품질 검사를 뜻하지 않는다.|

`GitIntegrationTests`는 임시 Git 생성/스테이징/커밋을 수행하므로 이번 Git 쓰기 금지 범위에서 재실행하지 않았다. 10/14 [역할 동기화 하네스](../../2026-10-14-role-sync-harness.json)의 도구22·hook11 PASS는 당시 증거로 보존하며 이번9개 재실행과 합쳐 새 검증 수로 세지 않는다.

CI는 PR base SHA를 checkout하고 그 base의 정책·checker로 PR diff를 검사한다. 브랜치의 `minkyu/`, `jonghyun/`, `yumi/` 접두사를 actor로 사용하며 성호 시작은 거절한다. actor 선언과 검사기는 접근 인증이나 OS 파일 쓰기 잠금이 아니다.

## 기존 소스와 완료 증거 보존

미커밋 소스7개는 현재 HEAD 정책에서 모두 민규 담당이며 [10/18 소스 manifest](2026-10-18-source-manifest.json)에 기록된 SHA와 **7/7 일치**한다.

|파일|SHA256|
|---|---|
|`tools/local/prepare_current_policy.py`|`79ab091fe8a47189a949ca717d5b051340a1518ac148502adcb0edae19467111`|
|`tools/local/prepare_isolated_midnight.py`|`c77a06377984a261adb09fad91c061ace03ed52d2670fd54785ec303561b0f26`|
|`tests/database/minkyu/test_current_policy_preparation.py`|`fdc31a37258be58e121511b15008146524d3de11db59b12605c007ee8282c4df`|
|`tests/database/minkyu/test_production_preparation.py`|`4ce2c52370b1b4ffc2faae91eb2e176db0f07e3db382527efa308ce4261554a6`|
|`tests/database/minkyu/test_ai24_live_binding.py`|`90d4433292ac17fdf816e90003558751f2fef97b39160555f4599ed85a62ea18`|
|`tools/local/verify_restoration_readiness.py`|`741b2eb4e6e6a320f1f0959fe514ae4c462224cdef9588a5d56e4881dd93520f`|
|`tests/database/minkyu/test_restoration_readiness.py`|`9fc38a09f7aab06a508fc4bb35478ec22b926a506adc29acd832660d74c2137d`|

[10/18 계획 완료 기록](2026-10-18-plan-completion.md)과 [실제 영수증 목록](2026-10-18-runtime-evidence.json)은 원계획1~4의 한정된 완료를 기록한다. 소스 manifest 자체의 capture 단계는 실제 Auth 최종 판정 전 snapshot이며, 그 `PENDING` 문구를 새 실제 실행 결과로 덮어쓰지 않는다. 실제 결과와 사후 동일성은 별도 최종 영수증·감사에 연결한다.

기존 합성 검증·익명/다른 인증 문맥 거절·신규8개 정리와 AI24/복원 준비를 보존한다. AI24 실제 자정, 실회원/실제 네이버, 공급사 조건·운영 적용, Storage 원본39개와 전체 복원은 별도 잔여다. 이번 협업 검사로 해당 항목을 완료 처리하지 않는다.

## 후속 지침 읽기 확인

root가 단독 편집한 `AGENTS.md`·`docs/collaboration/team-start.md`·`2026-10-14-minkyu-start.md`에서 민규 활성44개 전체를 종료 기준으로 명시한 것을 확인했다. 좁은 실행계획 완료와 전체 프로젝트79%(22/28)를 개인 담당 완료로 바꾸지 않으며, 한 묶음 뒤 다음 독립 잔여를 계속하도록 연결되어 있다. 기존 실행 조건도 유지한다. 이 확인 시점에는 새 전체 실행 하네스가 존재하고 전체 담당 대조 문서는 아직 작성 중이므로, 새 문서 링크의 최종 존재·내용은 root의 작성 완료 후 재검사 대상으로 남겼다.

다음 조치는 새 전체 담당 대조와 하네스의 항목별 증거·잔여를 확인하고, Notion 최신 담당·상태와 로컬 종료 증거를 연결하는 것이다. 이 문서는 외부 메시지·원격 쓰기·추가 커밋·푸시 승인을 만들지 않는다.

## 후속 실제 대조 — 한국시간10/20

위 최초 검사 시점과 구분한다. 현재 전용 clone HEAD는 `1d9b46b69adbc52f693accbff04ca4a00d35c547`, actor=minkyu·hook=.githooks를 재확인했다. Notion1.7·7.10은 최신 실행 방법과 완료 기준을 재조회하고 기존 블록에 증거·제한·다음 조치를 반영한 뒤 최종 완료 상태를 다시 읽어 확인했다. 원격 검사 설정이나 CI 실행을 완료로 계산하지 않았다.

1.6의 선행1.2 승인 정책 차이는 [별도 처리 기록](2026-10-19-ai-budget-policy-document-sync.md)에 따라 PRD/상세설계만 반영하고 종현 USERFLOW 요청을 연결했다. 과거 역할 문서 대조만으로 정책 차이 처리까지 완료됐다고 판단하지 않는다. 전체79%(22/28)는 유지한다.
