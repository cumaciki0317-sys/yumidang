유미당 디자인시스템 v3 · 2026-10-13

시작: guide.html (현재 화면별 가이드와 실제 시안 링크)
편집 원문: guide.md
Expo 적용 경계/props·이벤트 매핑: expo-handoff.md
현재 화면별 수치: design-tokens.json
웹 전용 보조 CSS: tokens.css, common-navigation.css (현재 화면별 JSON/가이드 우선; Expo 직접 import 금지)
기존 승인 신규 입력/탭 예시: native-examples.html
화면 목록: components.html
현재 실행 entry / 소스 해시: source-manifest.json
검증: python3 <이 폴더>/verify-design-system.py (저장소 루트에서 실행)

둘러보기와 공고 탐색 연결 시안은 S01 원본으로 통합했다. 공고를 누르면 S02 원본을 상세 시트로 불러오며, 닫으면 목록 위치를 유지한다. 구버전 HTML·이동용 진입점·연결판 복사본과 사용하지 않는 하위 둘러보기·상세 CSS/JS는 제거했다. 현재 화면이 참조하는 자산과 장면 계약 문서는 보존한다. DS screens/home/assets는 행사 목록이 사용하는 이미지 자산만 보존한다. 기존 검증 JSON과 미대조 토큰은 전체 동기화 완료 근거가 아니며, HTML 디자인과 실제 Expo 적용은 구분한다.

화면을 확정하고 넘어갈 때 가이드/토큰/참조를 갱신합니다. Expo 적용 완료와 디자인 문서화를 구분합니다.

단일 기준: guide.md / expo-handoff.md의 단일 화면 참조 경로 표 (12개 화면 + 연결 데모).
경로만 검사: verify-design-system.py --references-only (소스 해시·시각 검증 제외).
기존 해시 불일치는 화면별 문서/토큰 검토가 끝나기 전 일괄 갱신하지 않습니다.
