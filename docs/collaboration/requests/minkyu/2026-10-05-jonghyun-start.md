# 종현 GitHub 작업 시작·병합 안내

작성자 minkyu, 2026-10-05. 공유 기준은 `minkyu/handoff-20261005`, 종현 작업은 `jonghyun/queue-integration`이다.

## 시작

종현 본인의 기존 clone에서 미커밋 작업을 먼저 확인하고 보존한다. 민규 clone/인덱스를 같이 쓰지 않는다. 깨끗한 본인 clone에서 다음을 실행한다. 같은 이름 브랜치가 이미 있으면 기존 작업을 삭제하지 말고 새 이름을 사용한다.

```sh
git status --short
git fetch origin
git switch --no-track -c jonghyun/queue-integration origin/minkyu/handoff-20261005
git config --local yumidang.actor jonghyun
git config --local core.hooksPath .githooks
```

기존 custom hook이 있으면 core.hooksPath를 덮어쓰기 전에 기존 hook과 연결 방식을 확인한다. 위 설정은 본인 clone에만 적용한다.

Codex/Claude에 다음을 입력한다.

```text
나는 종현이고 작업자 jonghyun이다.
docs/collaboration/requests/minkyu/2026-10-05-jonghyun-start-task.md를 읽고 첫 작업을 지금 시작해.
AGENTS.md와 최신 PLAN/상세 설계를 읽고 담당 범위를 확인한 뒤 구현과 테스트까지 진행해.
```

첫 작업은 queue-runner 전용 역할/TLS → 세 종류 작업·cleanup DTO → timeout·재접속이다. 키 없이 코드와 가상 테스트부터 진행한다. 실제 DB/운영 배포는 별도 검증하며 ZIP·launcher는 필요 없다.

## 작업 제출과 합치기

담당 J 경로만 선별한다. 소유권 검사 후 직접 제출 요청을 받은 시점에 커밋/푸시한다. 아래 명령은 제출 절차이며 첫 작업 프롬프트만으로 자동 커밋/푸시하지 않는다.

```sh
python3 tools/collaboration/check_ownership.py --actor jonghyun --staged
git commit -m "feat: 큐 실행기 권한과 회원 정리 연결"
git push -u origin jonghyun/queue-integration
```

GitHub PR의 base는 `minkyu/handoff-20261005`, compare는 `jonghyun/queue-integration`으로 설정한다. 민규가 해당 PR의 변경·소유권·검증 결과를 확인하고 공유 브랜치에 합친다. 그 뒤 전체 기능 통합 검증을 거쳐 main으로 반영한다. 소유권 분리가 main 병합이나 운영 배포 완료를 뜻하지 않는다.

작업 도중 공유 기준에 새 M 변경이 필요하면 본인 요청 문서를 남긴다. 기준 갱신은 깨끗한 작업 상태에서 명시적으로 fetch/merge하고 충돌은 담당자가 해결한다. force push·상대 담당 파일 직접 수정·대량 staging은 하지 않는다.

민규 담당은 인증·핵심 서비스·공통 DB/마이그레이션이다. 현재 공유 기준의 65 SQL과 회원 API는 격리 로컬 검증 범위이며 운영 적용은 대기다. 최초 사용자 확정이 필요한 완료 전 검토 보류 초안은 이번 구현 기준에 포함하지 않는다.

## 공유 전 확인

공유 스냅샷에서 `node --test tests/functions/minkyu/*.test.ts` 377개 PASS. J 기존 background-runner 12개 PASS는 이전 동일 J 소스 확인 결과다. Deno 타입 검사도 수행했으나 전체 Node 테스트를 Deno에서 실행한 시도는 권한과 Deno global 재대입 차이로 5개 실패했다. 테스트 실행기는 Node를 사용하며 이 실패를 새 기능 성공으로 바꾸어 기록하지 않는다. 소유권 staged 검사와 diff 공백 검사는 PASS다. SQL65는 앞선 실제 격리 로컬 검증 범위이며 이번 Git push는 운영 DB 변경을 하지 않는다.
