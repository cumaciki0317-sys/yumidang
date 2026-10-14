# 종현 자기소개 시작 인계

“나 종현이야” 또는 “종현입니다”를 받으면 actor=`jonghyun`로 [공통 자동 시작 절차](../../team-start.md)를 적용한다. 사용자 승인된 본인 담당 업무를 바로 이어가며 별도 시작 승인을 반복 요청하지 않는다. 이 문서는 민규가 관리하는 공통 인계이며 실제 종현 산출물의 소유권을 바꾸지 않는다.

## 담당과 파일

- WBS 업무 책임: FE·UX/UI·웹/모바일 화면·클라이언트 API/인증/세션 소비·빌드/스토어 기술 준비.
- 편집 후보: `frontend/`, `apps/mobile/`(공통 `src/domain/` 예외), `docs/planning/design/`, 소유권에 지정된 UI/앱 테스트. 정확한 허용 여부는 HEAD 소유권 검사로 확인한다.
- 실제 파일 진입점: [IA](../../../planning/design/IA.md)·[USERFLOW](../../../planning/design/USERFLOW.md), `frontend/src/`, `apps/mobile/src/screens/`, `apps/mobile/src/service.ts`, `apps/mobile/src/remote.tsx`, `apps/mobile/src/web-member-session.ts`, `apps/mobile/README.md`.
- 본인 기록·상대 담당 요청: `docs/collaboration/requests/jonghyun/`. 상대 요청/현황 파일은 편집하지 않는다.
- QA는 세 사람 공동 책임이며 결함 수정은 해당 파일 단독 owner가 한다.

## 첫 작업 결정

현재 첫 후보는 **[3.1] 앱 라우팅·인증·서비스 연결 지점 확인**다. 카탈로그의 현재 상태·담당·Notion 링크를 확인하며 재개 시점 변경과 선행 조건에 따라 다음 독립 미완료를 선택한다.

[WBS 전체 작업과 담당/상태](2026-10-14-wbs-task-catalog.md)에서 본인 담당을 필터링하고 해당 Notion 페이지 본문·우선순위·선행 작업과 실제 파일 증거를 읽는다. 완료 항목을 시작 목록에 다시 넣지 않는다. 공동 담당 항목은 산출물과 수정 경로를 나눠 같은 파일 동시 편집을 피한다.

기존 모바일 앱을 먼저 확인한다. 웹 frontend는 현재 추적 파일과 기존 미추적 사용자 자료를 구분하며 임의로 기존 미추적 프로젝트를 덮어쓰거나 스테이징하지 않는다. 계정 탈퇴 화면의 직접 retire/로그아웃과 최신 requestMemberRetirement/useMemberRetirement 상태 소비 사이의 차이가 첫 점검 후보이며, 선택한 WBS의 요구와 현재 HEAD를 다시 확인한 뒤 진행한다. 현재 화면·서비스 연결의 구현과 WBS FE/UX/앱 연동 요구를 대조하여 첫 미완료의 화면/클라이언트 소비 차이를 확인하고 본인 소유 파일에서 수정한다. AI 서버·DB·RPC·검색/행사 서버는 민규에게 요청한다. 기존 종현 이름의 백엔드 파일은 현재 민규 소유일 수 있다.

현재 전체 백엔드 마지막 명시 기준79%(22/28)는 이번 인계 작성으로 늘리지 않는다. 실제 진행 보고에는 선택한 WBS ID·파일·검증·조건·다음 작업을 남긴다. Notion 완료 상태만으로 실제 구현/운영 완료를 판정하지 않는다. 공통 시작 절차의 실회원·공급사·운영·외부 전송·커밋/푸시 경계를 그대로 적용한다.
