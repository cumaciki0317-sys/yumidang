# Android 대표 화면 검증 — 2026-10-23

사용자가 전용 에뮬레이터와 ADB 화면 조작을 승인한 뒤 진행한 **Codex 자체 검증**이다. 실제 회원·서버·독립 UT·출시용 앱 검증과 구분한다. [관찰 및 제한](results.json)을 기준으로 읽는다.

- 큰 글자 200%는 Q14를 확인하는 시험 조건이며 앱 기본 글자 크기를 바꾸지 않는다.
- 작성 입력이 키보드에 가려지는 문제와 비입력 오류 대상에 `.focus()`만 적용한 문제를 보완했다. 키보드 높이·화면 위치를 실제 측정해 스크롤하고, 입력 초점과 접근성 초점 이벤트를 구분한다.
- [수정 후 제목 입력](create-standard-keyboard-fixed-200.png), [카테고리 오류 초점](talkback-category-after-submit.png), [가입 사진 오류 초점](talkback-signup-photo-error.png), [취향 오류 초점](talkback-preferences-error-real.png)을 실제 Android에서 관찰했다. 녹색 테두리는 TalkBack 초점 관찰이며 음성 청취 검증을 뜻하지 않는다.
- 홈 탭 확대·미전송 메시지 이탈·공고 관리 메뉴는 별도 관찰 범위다. 일부는 공통 키보드 보완 전 관찰임을 JSON에 표시했다.
- 최초 필기 입력 안내·중간 화면 전환·도구 idle 실패 캡처를 제품 성공 근거로 사용하지 않는다. UIAutomator XML `focused`는 TalkBack 초점과 다르다.
- 글자 크기1.0·접근성 서비스null/꺼짐·필기 임시 설정null로 [원복 확인](restored-settings.json)했다. 이번 전용 에뮬레이터와 native Metro를 종료했다.

## 후속 관찰 N09~N14

현재 수정·실패 전후 비교는 [앱 검증 인계](../app-qa-followup.md)와 results.json의 followup_checks를 따른다. 행사 단계별 복귀·입력 보존·키보드 오류 보완, 이탈 안내 맥락과 TalkBack 초점을 재검증했다. [최종 설정 원복](final-restored-settings.json)은 expected와 actual이 일치한다. 전체 읽기 순서·음성 품질·모든 Android 크기 통과 주장은 하지 않는다.
