# 격리 에뮬레이터 UI 확인 — 2026-10-25

사용자가 ADB 화면캡처·테스트입력을 명시 승인했다. 새 emulator-5580에서만 실행. 실제 계정·서버 연결 없이 APK 예시 모드, 기존 CarePlus 미사용.

|검사|관찰 결과|증거|
|---|---|---|
|홈 렌더링|예시 데이터 안내·행사 카드·하단탭 표시|emulator-current.png/xml|
|둘러보기 이동|13개 예시 목록, 비로그인 중립 자리표시자|browse.png/xml|
|검색 입력·제출|qa_no_match_20261025 입력 뒤0개·결과없음·초기화 표시|search-result.png/xml|
|탭 복귀|검색어·0개 결과 유지|search-result.xml|
|초기화|검색어 비워지고13개 목록 복원|reset.xml|
|목록→상세|선택한 제목·공개 동 지역·비로그인 자리표시자 표시|detail.png/xml|
|Android 뒤로가기|둘러보기13개 목록 복귀|detail-back.xml|
|강제종료→재실행|앱 데이터 삭제 없이 COLD Status ok538ms, 홈 재표시|cold-relaunch.txt,cold-home.png/xml|
|크래시|검사 후 crash buffer0bytes|ui-crash.txt|

검색 제출 후 추가 Back은 키보드 닫기가 아니라 홈으로 이동했다. 홈에서 둘러보기로 재진입해 검색어/결과 유지 확인했다. 이는 테스트 조작 경로이며 제품 결함으로 분류하지 않았다.

한계: UIAutomator tree·PNG 직접 관찰과 ADB 입력에 의한 자체 검증. 실제 물리기기·회원/nativeOAuth·Storage·외부모델·운영API·전체 접근성·키보드200%·스토어 검증 아님. 탭 복귀 상태 유지와 앱재시작 후 저장자료 유지의 의미를 구분하며 영속저장 전체 검증은 하지 않았다. 전체QA/릴리스 완료 판정 아님.

WBS7.3a 내부 preview APK 독립실행 검증 범위와6.4a 예시모드 일부QA 증거로 사용. 현재 설치본SHA b58d89d10b27db608a562f2cac258bcad4bab12acabc9e2a1935afcecd74f948.

WBS7.3a·6.4a 댓글에 현재 검증 결과와 미검증 범위를 반영하고 저장된 문구를 다시 읽어 확인했다. 상태/전체QA 완료는 변경하지 않았다.
