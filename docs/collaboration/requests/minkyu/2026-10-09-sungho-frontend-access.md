# 성호 프론트엔드·UI/UX 담당 배정

2026-10-09 사용자 요청을 반영했다. 담당자는 sungho다.

- 웹: frontend/ 전체
- 모바일: src/screens/, src/app/, src/components/, src/ui.tsx, src/presentation/, design/, assets/
- UI/UX 설계: docs/planning/design/
- 기존 성호 테스트·요청 폴더는 유지

RemoteMemberScreens.tsx의 기존 민규 작업을 보존하고 후속 화면 편집은 성호가 수행한다. 민규는 member-service.ts·remote.tsx·web-member-session.ts의 백엔드 연결을 계속 담당한다. 다른 모바일 API·인증·상태·서비스 및 모바일 공통 설정은 종현 담당을 유지한다. 백엔드·SQL·공통 정책·환경 권한은 이번 재배정에 포함되지 않는다.

정책만 별도 커밋하며 구현 변경·자동 푸시·외부 메시지는 수행하지 않는다. 성호는 자신의 clone/worktree에서 해당 정책을 갱신한 후 sungho 검사로 실제 화면 편집 가능 여부를 확인한다. GitHub 초대·Figma 등 외부 서비스 접근 권한 변경은 수행하지 않았다.
