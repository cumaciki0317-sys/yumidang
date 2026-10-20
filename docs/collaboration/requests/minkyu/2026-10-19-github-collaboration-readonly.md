# WBS7.10 현재 GitHub 협업 검사 읽기

2026-10-19 Notion 책임/실행 방법에 따라 현재 hook·PR 검사·브랜치 보호의 설정과 실제 증거를 대조했다. 조회는 읽기 전용이며 설정·커밋·푸시·댓글 변경은0이다. Notion 조회 담당과 별개로 root가 이 결과를 기록한다.

## 저장소와 조회 사실

요청한 `jjackbb/yumidang`은 동일 repository ID `1372571886`의 현재 [cumaciki0317-sys/yumidang](https://github.com/cumaciki0317-sys/yumidang)으로 이동 응답을 반환했다. 다른 저장소를 대체 대상으로 선택하지 않았다. 로컬 remote URL을 변경하지 않았다.

|항목|관측 결과|증거 범위|
|---|---|---|
|default branch|main, HEAD `472c570ed609753a1d74b7016e5518f6d429213f`|현재 repository/branch 조회|
|작업 브랜치|backend-work, HEAD `b164021323975c241d7a73145bdd66d9c3e6f097`|로컬 새 커밋1d9b46b가 원격에 반영됐다는 뜻이 아님|
|보호 요약|main·backend-work 모두 protected:false|[branches API](https://api.github.com/repos/cumaciki0317-sys/yumidang/branches?per_page=100) 200|
|ruleset|부모 포함 조회 200, 빈 목록|[rulesets API](https://api.github.com/repos/cumaciki0317-sys/yumidang/rulesets?includes_parents=true)|
|상세 branch protection|두 브랜치 각각403 Resource not accessible by integration|connector admin=false. required checks/review/bypass의 상세를 읽지 못함.403을 미설정 증거로 사용하지 않음|
|ownership workflow|backend-work에는 존재, main root에는 .github·.githooks·tools가 없으며 해당 workflow 경로404|[고정 backend-work workflow](https://github.com/cumaciki0317-sys/yumidang/blob/b164021323975c241d7a73145bdd66d9c3e6f097/.github/workflows/ownership.yml)|
|최근 유지된 Actions runs|조회200 total_count0|[runs API](https://api.github.com/repos/cumaciki0317-sys/yumidang/actions/runs?per_page=10). 삭제 이력/과거 전체 실행을 증명하지 않음|
|HEAD check runs|backend-work에는 Vercel Preview Comments success1개, main0개|Vercel 댓글 검사를 ownership 검사 PASS로 계산하지 않음|

## 검사 연결과 남은 개선

backend-work의 workflow는 pull_request에서 contents:read 권한으로 trusted base SHA를 checkout하고, 브랜치의 minkyu/jonghyun/yumi actor와 base policy/checker를 사용해 PR head diff를 검사한다. [로컬 hook 원격 정의](https://github.com/cumaciki0317-sys/yumidang/blob/b164021323975c241d7a73145bdd66d9c3e6f097/.githooks/pre-commit)는 actor별 staged 소유권 검사다. 로컬 전용 clone의 actor=minkyu·core.hooksPath=.githooks·정확10파일 실제 staged/hook 통과와 원격 강제 보호는 다른 사실이다.

개선 요청은 다음 원격 쓰기를 수행하기 전에 검토해야 한다. 현재 default main에는 동일 ownership workflow가 없으므로 PR 대상/base에 실제 검사 정의가 있는지 먼저 확인하고, 승인된 PR에서 실제 ownership run 및 required check·리뷰·bypass 조건을 검증한다. 브랜치 보호/ruleset을 설정하려면 대상 브랜치·강제 검사·리뷰 정책과 권한을 구체화하고 별도 승인을 받는다. 이 점검을 근거로 보호를 이미 설정했다고 표시하거나 원격 설정을 임의 변경하지 않는다.

현재 문서는 검사 증거·미확인 상세·개선 요청의 산출물이다. 모든 서버 기능·배포·민규44개 완료를 주장하지 않으며 프로젝트79%(22/28)를 올리지 않는다. 로컬 상세 증거는 [협업 검사](2026-10-19-collaboration-verification.md)와 [현재 진행](2026-10-19-local-verification-progress.md)에 연결한다.
