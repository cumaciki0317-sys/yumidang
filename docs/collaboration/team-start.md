# 세 팀원 자기소개로 작업 시작

사용자 승인: 브랜치를 받은 팀원이 “나 종현이야”, “나 유미야”, “나 민규야”라고 입력하면 Notion에 배정된 본인 업무를 바로 이어간다. “종현입니다/유미입니다/민규입니다”도 동일하게 처리한다. 자기소개는 작업자 구분이며 접근 인증이 아니다.

| 입력 | actor | 먼저 읽을 인계 |
|---|---|---|
| 나 종현이야 | jonghyun | [종현 시작](requests/minkyu/2026-10-14-jonghyun-start.md) |
| 나 유미야 | yumi | [유미 시작](requests/minkyu/2026-10-14-yumi-start.md) |
| 나 민규야 | minkyu | [민규 시작](requests/minkyu/2026-10-14-minkyu-start.md) |

## 자동 시작 절차

1. [정책](../../정책.md)·[PLAN](../../PLAN.md)·[상세설계](../../PLAN_상세설계.md)·[AGENTS](../../AGENTS.md)·[협업 규칙](README.md)·본인 인계·[WBS 작업 목록](requests/minkyu/2026-10-14-wbs-task-catalog.md)을 읽는다. WBS는 [Notion 원본](https://app.notion.com/p/3f9a6def75f880ae8f31f6cdbd69ea78)을 가능하면 다시 조회한다. 연결이 없으면 저장된 조회 날짜와 상태임을 밝히고 파일 증거와 대조한다.
2. HEAD·브랜치·미커밋·actor·hook을 읽기 확인한다. 기존 변경을 보존한다. 확인된 작업자는 다시 묻지 않는다. 다른 사람의 clone이면 설정을 바꾸거나 편집하지 말고 본인 전용 clone을 먼저 확보한다. Git worktree는 기본 local config를 공유할 수 있으므로 독립 clone을 우선한다.
3. 본인 전용 clone에서 `actor/작업명` 브랜치를 만들고 `python3 tools/collaboration/setup_actor.py --actor actor`로 준비한다. 여기의 actor를 표의 실제 값으로 바꾼다. 기존 다른 actor/custom hook을 덮어쓰지 않는다. 준비 실패 시 읽기·원인 해결을 계속하고 편집은 중단한다.
4. WBS 담당자 속성에 본인이 포함된 업무만 선택한다. 완료 상태도 소스·증거를 확인하며 완료 기능을 재작성하지 않는다. 미완료 중 선행 조건이 충족된 작업을 우선순위와 의존성 순으로 선택한다. 팀 검토/실회원/공급사/운영 조건이 필요한 항목은 조건을 기록하고 독립 작업을 계속한다. WBS 상태와 백엔드 실제 완료율은 서로 다른 지표다.
5. 첫 안내에 위 문서 링크·본인 담당·선택한 WBS ID/제목·관련 파일·첫 조치·남은 조건을 짧게 설명한 뒤 **이미 승인된 본인 담당 구현·문서 작성·격리 검증을 바로 진행한다.** “시작할까요?”를 다시 묻거나 계획 설명만으로 종료하지 않는다. 파일 수정 전에 `python3 tools/collaboration/check_ownership.py --actor actor --paths 대상파일...`을 통과한다. 거절 경로는 제외하고 자기 요청 폴더에 인계한다.
6. 복잡한 작업은 하네스 팀을 구성하고 동일 actor·파일별 단독 수정 경로를 전달한다. QA 공동 작업도 각 파일은 한 사람만 수정한다. 매 보고는 WBS 작업 ID·변경 파일·검증 증거·미완료/보류·다음 작업을 기록한다. 현재 백엔드 마지막 명시 기준79%(22/28)는 실제 증거로 닫힌 항목만 갱신하고 FE/기획 전체 완료율로 표현하지 않는다.

## 새 clone 준비 예시

아래는 각자 독립 경로에서 진행한다. 본인 actor와 원하는 작업명을 실제 값으로 바꾼다. 최신 backend-work를 받은 뒤 작업 브랜치를 만든다. 기존 본인 clone은 미커밋/원격 차이를 확인한 뒤 갱신하며 무조건 reset/clean하지 않는다.

```sh
git clone --branch backend-work https://github.com/jjackbb/yumidang.git yumidang-actor
cd yumidang-actor
git switch -c actor/wbs-followup
python3 tools/collaboration/setup_actor.py --actor actor
git status --short
git config --local --get yumidang.actor
git config --get core.hooksPath
```

## 승인 경계

자기소개는 본인 담당 업무의 시작 승인이다. 자동 커밋·푸시·운영 배포·운영 DB 쓰기·추가 결제·외부 메시지·회원 원문 외부 전송·VM 재시작/다른 컨테이너 중지로 확대하지 않는다. 실회원 검증은 사용자 재개 전 HOLD이며 공급사/법적 적합성/운영 실행 조건을 유지한다. 남은 조건을 이유로 모든 독립 작업을 멈추지 않는다. Notion 담당/상태 자동 변경도 이 시작 절차에 포함하지 않는다.

성호 시작 및 과거 종현 백엔드100/J01~J09 지시는 현재 실행 배정으로 사용하지 않는다. 옛 폴더명·실제 완료·PASS 기록은 보존한다. 현재 파일 배정은 [ownership.json](../../backend/ownership.json)의 가장 구체적인 규칙을 따른다.
