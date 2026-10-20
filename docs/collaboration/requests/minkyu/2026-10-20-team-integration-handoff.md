# 민규 작업 팀 통합 인계 — 2026-10-20

공유 브랜치는 `minkyu/wbs-backend-20261017`, 실제 원격은 `https://github.com/jjackbb/yumidang.git`이다. 사용자 요청은 현재 민규 작업의 커밋·푸시다. 각 팀원 변경의 강제 덮어쓰기·공유 backend-work/main 병합·운영 배포는 실행하지 않는다. 기존 구현 목표의 일시중지는 유지하며 이번 공유가 Auth/API/DB 실행 재개 승인은 아니다.

## 포함 범위와 확인

공유 backend-work b164021 이후 민규 선행5커밋의 격리 Auth/AI·보존 검사와 현재 저장소에 반영된 준비 도구·테스트·담당44개 대장·정책/계약 차이·인계 문서를 포함한다. 내정보3파일은 b581d12로 별도 커밋했다. 최신 source manifest v2는 그 이후 공유 소스의 실제 파일SHA를 기록하며 원119/121/이전 manifest는 역사로 보존한다. manifest의 source_head는 인벤토리 생성 당시 HEAD이고 개별 working-tree 핀이 최종 공유 코드의 근거다.

기존 PASS와 현재 바이트 일치를 확인했다: 복원 준비61, 복원 증거검증25, 내정보 도구44, 주차 경계24. 이 숫자들은 각 오프라인/합성 범위이며 현재 실DB 복원·신규 Auth/me·운영 완료를 뜻하지 않는다. 변경 Python 구문·JSON 파싱·diff/소유권 검사와 명시적 비밀값 패턴 검사를 수행한다. 검사 hook/actor/소유권은 우회하지 않는다.

## 제외·보존

원 작업 공간의 중복 이름 SQL/FE·기존 미추적자료와 pycache는 그대로 두고 공유하지 않는다. `.env`·키·JWT·원회원 행·KOPIS 원본문·DB dump는 포함하지 않는다. 검토된 private runner74·retention SQL122/사전검사19·복원 composer26은 아직 제품 저장소에 적용하지 않은 후보이며 이번 커밋에 코드로 섞지 않는다. 관련 문서는 후보와 실제 적용을 구분한다.

검증 자료의 `/private/tmp` 원경로와 SHA는 당시 증거 참조다. 팀원 컴퓨터에 원자료가 자동 전달되거나 과거 실행 권한이 재생되는 것이 아니다. 일부 실행 하네스는 민규 로컬 repo/컨테이너·소스SHA에 고정되므로 다른 clone에서 경로만 바꾸거나 검사를 우회해 실행하지 않는다. 재개 시 새로운 전용 환경·HEAD·소유권·대상/메모리·authority를 확인한다.

## 팀 통합

각자 별도 clone에서 미커밋 변경을 보존한 뒤 실제 GitHub origin을 확인하고 `git fetch origin`으로 이 브랜치를 받는다. 통합 담당은 자기 통합 브랜치에서 `git merge origin/minkyu/wbs-backend-20261017`로 충돌을 검토한다. 강제 reset/clean/push를 사용하지 않는다. 종현은 FE·앱·UX, 유미는 UT/기획, 민규는 BE·AI·서버 경계를 현재 ownership.json과 팀 시작 안내로 확인한다. 원backend-work/main은 자동 갱신하지 않는다.

## 남은 실제 조건

전체 마지막 명시 기준79%(22/28), 민규44개 전체 미완료를 유지한다. /me 실제 Auth·자연만료, 새 DB121 복원, 실회원 HOLD·공급사 조건·운영 프로젝트 접근/적용·Storage39원본·앱/베타/출시 선행은 각 대장에 남는다. KOPIS는 승인된1GET의TLS/HTTP200 후 basedate없는 응답을 파서가 거절해 R2를 중단했다. 글로벌 intent는 소비됐고 다시 실행하지 않는다. Notion에는 승인받은 초기 준비 snapshot만 반영했다.
