# 2026-10-09 권한 확대 — 최신 안내

사용자 승인으로 성호는 웹 frontend 전체와 모바일 src/screens·src/app·src/components·src/ui.tsx·src/presentation, design·assets 및 docs/planning/design을 직접 편집한다. RemoteMemberScreens.tsx도 성호 담당이다. 아래 2026-10-05의 실제 화면 편집 금지는 이번 배정 경로에 적용하지 않는다. 인증·API·세션·상태·서비스 연결 파일과 모바일 패키지·환경·공통 설정, 백엔드는 기존 담당을 유지한다. 화면의 정책·공개 권한 조건과 기존 변경 내용을 보존한다.

별도 clone/worktree에서 이번 정책 커밋을 반영하고 sungho 브랜치와 소유권 검사 후 작업한다. 현재 공유 작업 공간의 actor를 바꾸지 않는다. GitHub 저장소 초대나 외부 디자인 도구 계정 권한을 변경한 것은 아니다.

---

# 성호 UX/UI 시작 안내

작성자 minkyu, 2026-10-05. 사용자 승인에 따라 성호를 sungho로 등록했다. 공유 기준은 minkyu/handoff-20261005다.

GitHub Desktop에서 공유 기준을 Pull 받고 본인 별도 clone에서 sungho/ui-design 브랜치를 만든다. AI에 “나는 성호야. AGENTS.md와 성호 시작 안내를 읽고 UX/UI 작업을 시작해”라고 한다. AI는 setup_actor.py로 본인 actor/hook을 연결한 뒤 수정 전 소유권 검사를 수행한다. Python3가 필요하다.

## 수정 가능

- apps/mobile/design/sungho/: 화면 설계·HTML 시안
- apps/mobile/assets/sungho/: 본인 이미지·아이콘
- apps/mobile/src/presentation/sungho/: 표시 전용 컴포넌트·스타일
- frontend/src/assets/sungho/: 본인 프론트 자산
- docs/collaboration/requests/sungho/: 본인 연결 요청·작업 기록
- tests/functions/sungho/, tests/integration/sungho/, tests/fixtures/sungho/: 본인 검증

위 폴더는 새 파일이 필요할 때 생성한다. 기존 UI를 읽고 시안을 개선하되 기존 종현 파일을 복사해서 다른 백엔드나 API를 만들지 않는다. 실제 화면 반영은 담당자에게 구체적인 디자인·컴포넌트 적용 요청을 남긴다.

## 건드리면 안 되는 것

backend/ 전체, SQL/RPC, 인증·세션·데이터·API 계약, 환경변수·키·패키지·lock·배포·CI·hook·소유권 정책, PLAN/정책/AGENTS, 상대 테스트·요청·현황은 수정 금지다. 모바일 api.ts/service.ts/remote.tsx/state.tsx/domain.ts/storage.ts/types.ts/data.ts 및 src/screens/, src/app/, 기존 components/, ui.tsx도 수정 금지다. ui.tsx에는 정보 공개·이름 마스킹·복귀 정책이 섞여 있어 스타일 파일로 취급하지 않는다. 기존 Stitch 자산·시안도 보존한다. 미배정 경로는 허용되지 않는다.

presentation 컴포넌트는 props 기반이며 API·세션·domain·서비스 상태를 직접 import하거나 호출하지 않는다. 입력값·표시 조건·동의·버튼 동작 정책은 기존 정책을 유지한다. 필요한 연결은 요청 문서로 종현/민규에게 전달한다.

## 검사와 제출

수정 전에 AI가 sungho 소유권 검사하고, 커밋 때 pre-commit이 staged 변경·삭제·이동 양쪽 경로를 검사한다. 로컬 정책을 고쳐도 HEAD 정책을 사용해 권한 확대를 거절한다. PR은 base 브랜치의 정책·검사기를 사용한다. PR base는 minkyu/handoff-20261005, head는 sungho/ 브랜치다.

Pull만으로 Git hook이 설치되지는 않는다. AI의 최초 setup이 완료돼야 로컬 커밋 차단이 작동한다. 파일 편집 자체를 운영체제에서 잠그는 기능은 아니다. PR 검사는 실패를 표시하지만 GitHub의 필수 검사/브랜치 보호는 별도 설정 전에는 강제 병합 차단을 보장하지 않는다. 작업자 선언과 브랜치 접두사는 협업 규칙이며 사용자 신원 인증이 아니다.

## 검증 결과

격리 Git 저장소 테스트 8개 PASS: 본인 UI 자산 실제 커밋 성공, 백엔드/혼합 화면/미배정 사전 거절, 백엔드 실제 커밋 거절, 정책 조작 거절, 허용폴더에서 API로 이동 거절, 타 actor/custom hook 보존, trusted-base diff 거절, 허용폴더의 링크가 백엔드를 가리킬 때 사전 거절. 기존 소유권 테스트 14개도 PASS. GitHub Actions 실제 실행과 필수 검사/브랜치 보호 설정은 아직 검증·설정하지 않았다.
