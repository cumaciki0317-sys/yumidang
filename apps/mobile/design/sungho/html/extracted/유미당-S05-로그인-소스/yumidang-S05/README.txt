S05 디자인 상태 시안

기준: apps/mobile/src/screens/AuthAiScreens.tsx. 상태 선택의 기존 오류/로딩/완료 장면 유지.
업무 버튼은 Expo에 연결할 이벤트를 검토 영역에 표시한다. 로그인 분기/가입 완료 처리/화면 이동 없음.
S06 입력 선택·사진 로컬 표시·입력 오류 피드백은 UI 검토용이며 서버 판정이 아니다.
디자인/폼/팝업/비활성 표현은 보존. 동의나 가입 자격을 실제 판정하지 않는다.
범위: apps/mobile/design/sungho/UI_SCOPE.md.

기준 진입점: S05-index.html (이 파일과 연결 CSS/JS를 직접 수정)
이전 package_s05.py 호환 명령은 제거했습니다. 위 기준 진입점을 직접 엽니다.
개별 ZIP/단일 HTML 생성은 지원하지 않습니다. ../../의 공통 preview 자원까지 포함해 extracted 폴더 구조를 유지하여 전달하세요.
