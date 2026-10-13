# 유미당 디자인시스템 · 현재 적용 기준

2026-10-13 · 홈·둘러보기·공고 상세 승인 디자인과 다른 기존 화면의 확장 잠정 검토를 구분한 Expo 인계 자료. 채팅목록 S10은 사용자 확정이며 나머지 확장 화면은 최종 사용자 확인 전이다. Expo는 미적용이다.


## 단일 화면 참조 경로

12개 화면의 디자인 진입점은 아래 한 곳씩이다. 구주소의 이동용 HTML은 별도 시안이 아니다. 파일명 index.html이나 폴더 위치만으로 최신 여부를 판단하지 않는다. 화면을 열어 연결된 CSS·JS·이미지와 최종 스타일을 함께 확인한다. HTML 디자인 완료와 Expo 적용·실기기 검증은 별개다.

| 화면 | 현재 디자인 원본 |
|---|---|
| S00 홈 | [유미당-홈-소스/유미당-홈.html](../../유미당-홈-소스/유미당-홈.html) |
| S01 둘러보기 | [유미당-둘러보기-소스/유미당-둘러보기.html](../../유미당-둘러보기-소스/유미당-둘러보기.html) |
| S02 공고 상세 | [유미당-공고상세-소스/유미당-공고상세.html](../../유미당-공고상세-소스/유미당-공고상세.html) |
| S05 로그인 | [유미당-S05-로그인-소스/yumidang-S05/S05-index.html](../../유미당-S05-로그인-소스/yumidang-S05/S05-index.html) |
| S06 가입 프로필 | [유미당-S06-가입프로필-소스/yumidang-S06/S06-index.html](../../유미당-S06-가입프로필-소스/yumidang-S06/S06-index.html) |
| S09-2 행사 목록 | [유미당-S09-2-행사목록-소스/list/index.html](../../유미당-S09-2-행사목록-소스/list/index.html) |
| S09-3 행사 상세 | [유미당-S09-3-행사상세-소스/detail/index.html](../../유미당-S09-3-행사상세-소스/detail/index.html) |
| S10 채팅 목록 | [유미당-S10-채팅목록-소스/index.html](../../유미당-S10-채팅목록-소스/index.html) |
| S11 채팅 | [유미당-S11-채팅-소스/index.html](../../유미당-S11-채팅-소스/index.html) |
| S12 알림 | [유미당-S12-알림-소스/index.html](../../유미당-S12-알림-소스/index.html) |
| S13 나 | [유미당-나-S13-소스/유미당-나-S13.html](../../유미당-나-S13-소스/유미당-나-S13.html) |
| S14 공개 프로필 | [유미당-S14-상대프로필-소스/index.html](../../유미당-S14-상대프로필-소스/index.html) |

둘러보기와 공고 탐색 연결 시안은 S01 원본으로 통합했다. 공고를 누르면 S02 원본을 상세 시트로 불러오며, 닫으면 목록 위치를 유지한다. 구버전 HTML·이동용 진입점·연결판 복사본과 사용하지 않는 하위 둘러보기·상세 CSS/JS는 제거했다. 현재 화면이 참조하는 자산과 장면 계약 문서는 보존한다. DS screens/home/assets는 행사 목록이 사용하는 이미지 자산만 보존한다. 기존 검증 JSON과 미대조 토큰은 전체 동기화 완료 근거가 아니며, HTML 디자인과 실제 Expo 적용은 구분한다.


## 1. 기준과 사용 순서

이 문서와 design-tokens.json은 현재 화면별 기준이다. source-manifest.json의 entry가 실제 참조 화면이며 예전 ZIP 버전·DS 내부 과거 보조 자료·Stitch를 기능 원본으로 쓰지 않는다. Expo와 정책.md가 기능·권한·공개 범위의 기준이다. HTML은 표시와 고정 장면 검토이며 실제 서비스 처리를 복제하지 않는다.

1. 아래 화면 참조에서 대상 시안을 연다.
2. 화면별 값과 예외, 상태·역할 차이를 확인한다.
3. expo-handoff.md의 표시 값/이벤트를 기존 Expo 상태·콜백에 연결한다.
4. 적용 담당자가 실제 글꼴·안전영역·키보드·줄바꿈·접근성을 확인한다.

화면 디자인 확정 후 다음 화면으로 넘어가기 전에 가이드·토큰·참조 해시를 함께 갱신한다. 이전 수치 아래 새 수치를 덧붙여 상충시키지 않는다. 소스에 남아 있는 오래된 CSS 선언보다 최종 cascade를 따른다. 화면 전용 예외를 전체 앱 표준으로 확대하지 않는다.

## 2. 공통 기반과 예외

- Pretendard, 브랜드 #852CFF, 보조 #6B7280, 입력 오류 #BD4465. 네이버 버튼 #03A94D와 채팅 재전송 #B32632는 용도별 예외다. 400/700 폰트 자산과 화면의 600 선언을 구분하며 Expo에서는 맞는 weight 자산을 연결한다.
- 모든 글자를 +1px 하는 규칙은 현재 기준이 아니다. 아래 화면별 최종 크기를 사용한다. HTML rem은 root16에서 비교한 값이며 RN 숫자는 dp/sp 환경에서 별도 검증한다.
- 새 일반 입력: 높이44, 모서리12, 글자14/400, 좌우12. 오류는 가까운 설명과 표시를 함께 제공한다. 새 독립 탭: 최소44, 글자14/700, 선택 밑줄2. 기존 화면의 검색·필터·내비게이션을 이 규격으로 강제 변경하지 않는다.
- 적용 필터 #F2E9FF/#D8B9F5, 선택 중 옵션 #F2EAFF/#A16CFF. 미선택400/선택700을 구분한다. 모집 상태 배지는 액션 버튼이 아니다.
- 눌림 .96/100ms는 기존 채택 컴포넌트의 값이며 hit area는 축소하지 않는다. reduced motion을 존중한다. 기존 일반 disabled .43, 채팅 전송 disabled .4는 각각 유지한다. 포커스는 입력2px 기준, 화면별 버튼 예외는 소스에서 확인한다.
- 필터/상세 시트: 열기280ms cubic-bezier(.22,1,.36,1), 닫기200ms cubic-bezier(.4,0,1,1). 검토 패널을 제외한 앱 경계에 맞춘다. 키보드 포커스 복귀와 닫기 기능을 유지한다.
- 같은 줄의 두 액션은 해당 화면에서 승인된 폭·순서를 따른다. 채팅은 부정 왼쪽, 긍정/유지 오른쪽. 강조색은 위치와 별개이며 사용자 실행 의도를 표시한다. 채팅 예외를 모든 기존 팝업에 자동 적용하지 않는다.

## 3. 공통 하단 내비게이션

내비게이션이 있는 화면에만 적용한다. 채팅방의 입력바를 내비게이션으로 바꾸지 않는다.

채팅 탭 아이콘은 둘러보기 기준으로 SVG만 translateY(-1px) 광학 보정한다. 활성·비활성 모두 동일하며 버튼 클릭 영역·다른 아이콘·행 중앙 배치는 유지한다. Expo에서는 아이콘 wrapper에 transform: [{translateY: -1}]을 적용하고 버튼에는 적용하지 않는다.

높이48px, 하단12px + safe-bottom, 좌10.285714286px + safe-left / 우9.904761905px + safe-right, radius25.142857143px. 아이콘24.380952381×24.761904762px. 기본 흰 배경80%(홈·둘러보기·나·채팅목록은 불투명 흰색 floatingWhite 예외), 아이콘 opacity1, 활성 #852CFF / 비활성 #6B7280. 보이는 라벨 없이 접근성 이름과 현재 탭을 제공한다. 예전 높이44.952381·하단8.304762 수치는 사용하지 않는다.

하단 고정 버튼과 본문 여백도 함께 계산한다. Expo 부모가 OS inset을 한 번 적용하며 Android 내비게이션 바를 앱 컴포넌트로 그리지 않는다. 키보드 회피도 부모 레이아웃 책임으로 연결한다.

## 4. 표면 구분

- 홈·둘러보기·공고 상세는 floatingWhite: 배경 #FAF8FE, 흰 표면 #FFFFFF, 경계는 투명, outline·blur 없음. 그림자 0 5px 14px rgba(76,47,125,.075), 0 1px 3px rgba(76,47,125,.025). 사용자 승인한 검토시안2 재질을 원본 세 화면에 적용한 기준이다. 채팅목록도 이 재질로 확정했다. 행사·로그인·가입·나·채팅에는 이 재질을 확장하여 잠정 검토 중이다.
- 홈·둘러보기 하단바는 불투명 흰색, 그림자 0 5px 20px rgba(76,47,125,.10). 로봇은 흰 표면 그림자, +는 단색 #852CFF와 0 5px 12px rgba(133,44,255,.2). 테두리·내부 액자·블러 없이 독립 SVG 아이콘을 사용한다. 뒤의 페이드는 높이100px + safe-bottom, 투명→45% 지점 rgba(250,248,254,.9)→76% 지점 #FAF8FE이며 터치를 가로채지 않는다.
- 확장 잠정 검토: 행사 목록/상세의 흰 카드 radius20, 행사 상세 관련 공고는 중앙 반원과 점선·좌우24px. 나의 카드·메뉴·하단바도 흰 표면이며 반원 장식을 임의로 추가하지 않는다. 로그인·가입은 안내/구역 카드만 흰 그림자로 맞추고 네이버 버튼과 선택·오류·포커스 의미는 유지한다.
- 채팅 확장 잠정 검토: radius24와 기존 배치는 유지하고 상단 패널·입력바 경계는 투명, 그림자는 floatingWhite와 동일. 상대 말풍선은 흰색·약한 그림자, 내 말풍선 #F0E7FC 유지. 채팅목록의 흰 표면과 목록 UI는 사용자 확정이며 실제 기능은 기존 Expo 상태를 따른다.

## 5. 화면별 실행 참조

### 홈 (home)

- 시안: [현재 화면](../../유미당-홈-소스/유미당-홈.html)
- Expo 참조: apps/mobile/src/screens/BrowseScreens.tsx
- 장면: guest / empty / booked / ongoing; 행사 normal / empty / error
- 적용 주의: 독립 HTML이 유일한 화면 기준이며 이전 진입점은 제거했다.

### 둘러보기 (browse)

- 시안: [현재 화면](../../유미당-둘러보기-소스/유미당-둘러보기.html)
- Expo 참조: apps/mobile/src/screens/BrowseScreens.tsx
- 장면: default / guest / applied / awaiting / confirmed / completed / empty / error / invalid / loading / moreError / longText / missingData / pagination / paginationExpanded
- 적용 주의: 스타일과 상세 열기·닫기는 현재 S01 원본 기준. 상세는 S02 원본을 직접 참조하고 복제 HTML을 포함하지 않는다.

### 공고 상세 (postDetail)

- 시안: [현재 화면](../../유미당-공고상세-소스/유미당-공고상세.html)
- Expo 참조: apps/mobile/src/screens/BrowseScreens.tsx, RemoteScreens.tsx
- 장면: design-scene-contract.json의 31장면
- 적용 주의: 현재 독립 HTML을 단독 상세와 S01 상세 시트가 함께 참조한다. 기능 기준은 Expo와 정책.

### 행사 목록 (events)

- 시안: [현재 화면](../../유미당-S09-2-행사목록-소스/list/index.html)
- Expo 참조: apps/mobile/src/screens/BrowseScreens.tsx, RemoteScreens.tsx
- 장면: 로그인 전·동의 누락·로딩·빈 목록·오류·카테고리 오류·긴 글·이미지 없음/실패·부분/만료 기간 등 기존 선택 장면
- 적용 주의: list/events.css와 events.js. 서비스 합성 데이터 시안이 기준이며 별도 Expo 미리보기 디자인으로 분기하지 않는다.

### 행사 상세 (eventDetail)

- 시안: [현재 화면](../../유미당-S09-3-행사상세-소스/detail/index.html)
- Expo 참조: apps/mobile/src/screens/BrowseScreens.tsx, RemoteScreens.tsx
- 장면: 현재 상세의 고정 장면 선택기
- 적용 주의: 목록과 글자 크기가 아직 다름. 이번 문서화로 화면까지 변경하거나 최종 통일됐다고 간주하지 않는다.

### 1:1 채팅 (chat)

- 시안: [현재 화면](../../유미당-S11-채팅-소스/index.html)
- Expo 참조: apps/mobile/src/screens/CommunityScreens.tsx, RemoteMemberScreens.tsx
- 장면: 대화 12·약속 9장면, 작성자/신청자; 입력 오류
- 적용 주의: hostEmpty는 소스에 남은 도달 불가 검토 장면이다. 작성자에게 신청 없이 대화방 진입 경로를 만들지 않는다.

### 채팅 목록 (chatList)

- 시안: [현재 화면](../../유미당-S10-채팅목록-소스/index.html)
- Expo 참조: apps/mobile/src/screens/CommunityScreens.tsx
- 장면: 기존 기본/비로그인/빈 목록/오류/로딩/긴 글/누락 선택 유지
- 적용 주의: 최종 확정된 목록 정보 배치·안 읽은 개수·길게 누르기 메뉴를 따른다. 공고 제목(15px/700, 최대 2줄) → 이름·만 나이·당도 → 마지막 메시지(14px) 순서다. 제목과 이름 간격4px, 이름과 메시지 간격10px. 상태 칩은 우측 상단12px, 당도는 보라색 텍스트다. 카드 간격18px, 목록 상단 여백12px다. 안 읽은 개수는 프로필 좌측 상단에 빨간색 #EF4444 배지로 표시한다(카드 기준 left/top23px, translate(-50%,-50%), 높이16px, 글자10px/700, 100개 이상99+, 0개 숨김). 마지막 메시지 우측 시간은11px다. 종 아이콘은18px이며 새 알림이 있으면 보라색과6px 빨간 점을 표시한다. 하단 채팅 탭에도6px 빨간 점을 사용하고 검토 패널에서 표시를 전환한다. 빈 상태 아이콘은 동일 말풍선 형태와 연보라색을 유지한다. 박*연 사진은 생성 프로필 스프라이트의 고정 예시이며 실제 회원 기본값이 아니다. 대화방 500ms 길게 누르기는 앱 프레임 중앙의 메뉴를 연다. 상대 이름20px/700, 대화방 알림끄기(켜기) → 차단 → 신고 → 나가기 순서이며 강조색·구분선은 없다. 스크롤/10px 초과 이동은 길게 누르기를 취소한다. 확인 대화상자와 닫은 후 포커스 복귀를 유지한다. 메시지 수신·읽음·알림 설정 및 신고/차단/나가기는 Expo 상태와 콜백으로 연결하며 HTML은 표시 예시다.

### 나 (me)

- 시안: [현재 화면](../../유미당-나-S13-소스/유미당-나-S13.html)
- Expo 참조: apps/mobile/src/screens/CommunityScreens.tsx, RemoteMemberScreens.tsx
- 장면: 현재 app.js의 12개 고정 장면과 내 동행/내 공고/프로필 탭
- 적용 주의: 현재 독립 HTML의 최종 스타일·마크업과 연결된 app.js가 기준. README의 예전 라우팅 기록을 구현 지시로 쓰지 않는다.

### 로그인 (login)

- 시안: [현재 화면](../../유미당-S05-로그인-소스/yumidang-S05/S05-index.html)
- Expo 참조: apps/mobile/src/screens/AuthAiScreens.tsx
- 장면: 기존 로그인 오류/로딩/완료 검토 선택
- 적용 주의: s05.css. 네이버 브랜드 버튼 색 보존.

### 가입 프로필 (signup)

- 시안: [현재 화면](../../유미당-S06-가입프로필-소스/yumidang-S06/S06-index.html)
- Expo 참조: apps/mobile/src/screens/AuthAiScreens.tsx
- 장면: 사진/성향 선택·입력 오류/로딩/완료 고정 표시
- 적용 주의: auth.css. 로컬 사진 표시와 입력 피드백은 UI 검토; 실제 가입 처리 아님.

## 6. 화면별 확정값·관찰값

아래 값은 현재 소스의 최종 선언이다. 현재 HTML 치수의 관찰값을 임의의 S/M/L 전역 규격으로 바꾸지 않는다. 전체 상태 문구와 작은 예외는 연결된 소스를 함께 확인한다.

### 홈

| 항목 | 현재 값 |
|---|---|
| appointmentMinHeightPx | 136.6875 |
| categoryBannerGapPx | 8.304761905 |
| footerReservePx | 67.215238095 |
| robotBottomPx | 72.761904762 |
| addBottomPx | 72.571428572 |
| material | floatingWhite |
| appointmentIconDisc | transparent; no border, outline or shadow |
| countdown | {"background": "#F2E9FF", "border": "transparent", "shadow": "0 3px 8px rgba(104,65,164,.14)"} |

### 둘러보기

| 항목 | 현재 값 |
|---|---|
| searchPx | 14 |
| filterPx | 12 |
| sortPx | 13 |
| sortArrowPx | 12 |
| sortArrowGapPx | 5 |
| titlePx | 15.09523808 |
| badgePx | 11 |
| timePx | 12 |
| metaPx | 14 |
| profilePx | 12 |
| avatarPx | 32 |
| sugarTrackPx | [42, 3] |
| profileMinHeightPx | 44 |
| material | floatingWhite |
| blurPx | 0 |
| saturatePercent | 100 |
| radiusPx | 20 |
| cardPaddingXPx | 24 |
| profileDivider | 1px dashed #DCD2EB |
| bottomReserve | 140px + safe-bottom |
| ticketNotches | {"center": "50% card height", "decorationHeightPx": 38, "edgeOffsetPx": -5, "fillRadiusPx": 14.5, "shadowStopsPx": [15, 16, 18, 19], "shadowOpacities": [0.18, 0.08, 0.025, 0], "pointerEvents": "none"} |
| profileFixture | generated-profiles.png; 검토용 합성 인물, 실제 회원 기본 이미지로 사용 금지 |

### 공고 상세

| 항목 | 현재 값 |
|---|---|
| titlePx | 20 |
| badgePx | 11 |
| profilePx | 12 |
| sectionTitlePx | 15 |
| labelPx | 13 |
| mainValuePx | 16 |
| smallValuePx | 14 |
| bodyPx | 14 |
| bodyLineHeight | 1.75 |
| noticePx | 13 |
| sectionRadiusPx | 20 |
| sectionPaddingPx | 16 |
| sectionMarginTopPx | 20 |
| buttonMinHeightPx | 44 |
| primaryHeightPx | 49 |
| primaryFontPx | 16 |
| primaryRadiusPx | 18 |
| handleHitPx | [72, 36] |
| handleBarPx | [42, 4] |
| material | floatingWhite |
| conditionRowRadiusPx | 14 |

### 행사 목록

| 항목 | 현재 값 |
|---|---|
| cardPaddingPx | 16 |
| narrowCardPaddingPx | 14 |
| radiusPx | 20 |
| shadow | 0 5px 14px rgba(76,47,125,.075),0 1px 3px rgba(76,47,125,.025) |
| thumbnailPx | [80, 96] |
| narrowThumbnailWidthPx | 72 |
| thumbnailRadiusPx | 12 |
| titlePx | 16 |
| metaPx | 14 |
| badgePx | 12 |
| filterPx | 13 |
| filterMinHeightPx | 36 |
| footerMinHeightPx | 48 |
| footerFontPx | 14 |
| footerPaddingPx | [12, 16] |
| footerBackground | #FAF8FE |
| emptyFooterBackground | #FAF8FE |
| material | floatingWhite; 확장 잠정 검토 |


### 행사 상세

| 항목 | 현재 값 |
|---|---|
| titleRem | 1.22916669 |
| valueRem | 0.82440475 |
| bodyRem | 0.75297619 |
| posterPx | [116, 174] |
| narrowPosterPx | [100, 155] |
| panelRadiusPx | 20 |
| ctaMinHeightPx | 48 |
| ctaRadiusPx | 14 |
| status | 현재 소스 관찰값; 목록 타이포 통일 미실시 |
| relatedCardMaterial | floatingWhite + browse ticketNotches; 확장 잠정 검토 |


### 나

| 항목 | 현재 값 |
|---|---|
| menuFontPx | 14 |
| requestTitlePx | 14 |
| requestMetaPx | 12 |
| scheduleTitleRem | 0.94345238 |
| scheduleMetaPx | 14 |
| scheduleBadgeDatePx | 12 |
| menuMinHeightPx | 60 |
| menuRadiusPx | 16 |
| avatarPx | 48 |
| namePx | 17 |
| scorePx | 32 |
| scoreUnitPx | 12 |
| infoIconPx | 16 |
| infoTargetPx | [28, 32] |
| accountHeadingPx | 13 |
| accountMarginTopPx | 28 |
| accountPaddingTopPx | 22 |
| material | floatingWhite; 확장 잠정 검토 |


### 로그인

| 항목 | 현재 값 |
|---|---|
| mainPaddingPx | 20 |
| logoPx | 88 |
| logoRadiusPx | 22 |
| brandPx | 24 |
| taglinePx | 15 |
| infoPx | 13 |
| caveatPx | 12 |
| naverColor | #03A94D |
| buttonHeightPx | 49 |
| buttonRadiusPx | 15 |
| buttonFontPx | 16 |
| dialogMaxWidthPx | 350 |
| dialogRadiusPx | 22 |
| dialogTitlePx | 21 |
| dialogBodyPx | 14 |
| naverLogoAsset | assets/naver-login-official.png |
| naverLogoRenderedPx | 18 |
| naverLogoLeftPx | 20 |
| naverLabelAlignment | 로고 영역 제외 나머지 중앙 |
| naverGuide | https://developers.naver.com/docs/login/bi/bi.md |
| background | #FAF8FE |
| material | floatingWhite 안내 카드; 네이버 버튼 유지 |


### 가입 프로필

| 항목 | 현재 값 |
|---|---|
| mainPaddingPx | [20, 16, 24] |
| headerPx | 18 |
| sectionTitlePx | 15 |
| sectionRadiusPx | 18 |
| sectionPaddingPx | [18, 16] |
| sectionGapPx | 16 |
| sectionBorder | transparent |
| sectionShadow | 0 5px 14px rgba(76,47,125,.075),0 1px 3px rgba(76,47,125,.025) |
| background | #FAF8FE |
| photoPx | 88 |
| photoButtonMinWidthPx | 104 |
| photoButtonMinHeightPx | 40 |
| photoButtonRadiusPx | 12 |
| photoButtonFontPx | 13 |
| labelPx | 12 |
| hintLineHeightPx | 19 |
| inputHeightPx | 44 |
| inputRadiusPx | 12 |
| inputFontPx | 14 |
| chipFontPx | 13 |
| chipMinHeightPx | 34 |
| chipRadiusPx | 22 |
| chipSelectedWeight | 400 |
| chipSelectedBackground | #F2E9FF |
| chipSelectedBorder | #CDB3F3 |
| mbtiColumns | 4 |
| mbtiGapPx | 8 |
| mbtiMinHeightPx | 40 |
| footerPrimaryHeightPx | 48 |
| footerPrimaryRadiusPx | 14 |
| footerPrimaryFontPx | 14 |
| footerBottomPx | 16 |
| safeBottomAdded | True |

## 7. 화면별 표시 규칙

- 홈: 약속 아이콘의 원형 표면은 제거하고 아이콘만 유지한다. D-day는 #F2E9FF·투명 경계·0 3px 8px rgba(104,65,164,.14). 비로그인·약속 없음·약속 있음 카드 최소 높이136.6875px로 통일, 내용 증가 허용. 비로그인·약속 없음 중앙 카드에는 안내 문구만 표시하고 로그인/동행 둘러보기 버튼을 넣지 않는다. 카테고리→배너 간격8.304761905px. 여유 높이 배분은 홈 전용 adaptive 소스 참조이며 다른 화면에 적용하지 않는다.
- 둘러보기: 카드 radius20, 본문·프로필 좌우24px. 양쪽 반원은 카드 높이 중앙에 고정한 비상호작용 장식이며 프로필 구분선은 1px dashed #DCD2EB. 모서리 끼움 효과·가로 띠 음영은 사용하지 않는다. 생성 프로필은 검토 예시 전용이고 실제 회원 사진 또는 기존 placeholder props로 대체한다. 비로그인은 실제 이름·사진을 전달하지 않는다. 무료 1:1 줄 제거, 연결 행사는 배지. 일정·지역14px, 프로필은 이름/당도 두 줄12px. 공고와 프로필은 별도 hit target. 긴 제목 자연 줄바꿈. 정렬은 두 옵션 전환, 12px 화살표가 누르는 동안에도 유지된다. 상단 필터12px는 행사 목록13px와 의도된 차이다.
- 공고 상세: 제목20px, 주요 일정/지역16px, 본문14px. 작성자 삭제는 제목 옆 더보기. 신청자 거절은 프로필 버튼 밖 별도44px target. guest 실제 신상 DOM을 CSS로 가리는 방식 금지, 중립 placeholder를 사용한다.
- 행사 목록: 시·도+장소+요금, 오른쪽80×96 이미지, 없는/실패한 이미지는 동일 자리표시자. 제목/장소는 자연 줄바꿈, 날짜 단위는 분리하지 않는다. 연결 공고 하단은 구분선과 전체폭48px 버튼; 0건은 회색 상태 영역. API 제공자 줄은 목록 카드에 표시하지 않는다. 진행중 보라·예정/종료 중립색.
- 행사 상세: 목록과 아직 타이포가 다르며 이번 동기화는 디자인 재작업이 아니다. 별도 결정 전 기존값 보존.
- 나: 당도 설명은 정보 아이콘을 탭했을 때만 표시. 보낸 신청 카테고리 아이콘, 안전·계정 및 프로필 메뉴14px, 일정 보조14px. 안전·계정 제목은13px 회색으로 유지한다.
- 로그인: 네이버 단일 로그인, 오류 팝업과 로딩/비활성 표현 보존. 가입: 필수 사진·선택 성향, 18px 모서리의 구역 카드, 16px 구역 간격, 88px 사진과 최소104×40px 사진 선택 버튼을 사용. 실제 인증·가입 조건은 기존 Expo 담당 영역이다.

## 8. 서비스 문구와 검토 설명

실제 서비스에 사용할 문구만 화면/모달에 둔다. 합성 예시·미구현·실제 처리 안 함·이벤트 연결 설명은 외부 검토 패널에만 둔다. 고정 날짜를 실제 현재 상태로 계산하지 않는다. 이름/상세주소 공개는 서버/기존 Expo의 표시값을 받으며 UI에서 정책을 재판정하지 않는다.

## 9. 검증과 남은 경계

이번 정리는 현재 소스 대조, 링크·토큰·해시 검증이다. Expo 적용 완료, 전 화면 실기기 QA, 접근성 준수를 뜻하지 않는다. 기존 validation.json 및 screens 내부 검증 자료는 작성 당시의 검사 결과이며 현재판 완료 증거로 사용하지 않는다. 현 기준 검증은 verify-design-system.py로 실행한다. 소스가 바뀌면 해시 차이를 보고하므로 최종 디자인 검토 후 문서와 함께 갱신한다.

## 10. S11 1:1 채팅 확정 디자인

### 적용 범위

2026-10-13 사용자 확정. S11 채팅 화면 전용 규칙이며 다른 화면의 스타일을 일괄 변경하지 않는다. 참조 소스는 ../../유미당-S11-채팅-소스/index.html 및 chat.css·chat.js·flow.css·flow.js다. HTML 디자인 반영과 Expo 실제 적용은 별개다. 기능·공개 조건은 기존 Expo 및 정책을 따른다.

### 상단 패널과 하단 입력바

프로필 헤더 아래 공고 토글·안내·상태별 액션을 하나의 흰 패널로 묶는다. 좌우 여백 12px, 모서리 24px, 경계는 확장 잠정 검토에서 투명으로 변경했다. 상단·입력바 그림자는 0 5px 14px rgba(76,47,125,.075), 0 1px 3px rgba(76,47,125,.025)다. 상단은 대화 스크롤 밖에 유지하며 긴 내용은 패널 내부에서 스크롤한다. 현재 HTML 높이 상한은 48dvh다. 하단 여백은 16px + safe-area이며 Expo 적용 시 부모의 시스템 inset과 중복하지 않는다.

### 글자와 정보 위계

공고 제목 15px/700, 프로필 이름·나이·당도 13px/400, 당도 숫자는 #852CFF. 안내 13px/20px, 색 #737580. 액션 버튼 14px, 기본 400·강조 600. 메시지 본문 15px/22px, 말풍선 상하 9px·좌우 13px(기본 폭 기준). 내 말풍선 배경 #F0E7FC·글자 #30283E, 상대 말풍선 흰 배경. 역할에 따라 내 메시지는 오른쪽, 상대는 왼쪽이며 헤더는 상대 프로필을 표시한다.

### 공고와 안내 문구

공고 제목과 화살표를 유지한 채 세부 카드만 접고 펼친다. 별도 공고 접기 문구는 사용하지 않는다. 안내는 별도 배경 없이 방패 아이콘과 두 문장으로 표시한다. 첫 문장: 상세 만남 주소는 약속 확정 후 당사자에게만 공개됩니다. 둘째 문장: 외부 메신저 유도에 주의하세요. 문장 사이 명시적 줄바꿈을 넣고 안심 안내: 접두어는 제거한다. 좁은 폭에서는 자연 줄바꿈을 허용한다.

### 액션 버튼과 확인 팝업

두 버튼은 같은 폭의 2열, 간격 8px, 최소 높이 44px, 모서리 12px다. 부정 행동은 왼쪽, 긍정·유지 행동은 오른쪽에 둔다. 위치와 강조는 독립적이며 사용자 의도에 맞는 실행 버튼을 보라색 #852CFF로 강조한다. 대화방 나가기 팝업은 왼쪽 나가기(보라색), 오른쪽 대화방 유지(테두리). 신청 거절 팝업은 왼쪽 신청 거절(보라색), 오른쪽 신청 유지(테두리). 확정 요청 팝업은 왼쪽 취소(테두리), 오른쪽 확정 요청 보내기(보라색). 신청 거절은 재신청 불가, 확정 요청은 상대 수락 후 확정됨을 안내한다. 처음 탭하면 팝업만 열고 확인 후 이벤트를 전달한다. 취소는 처리 없이 닫는다. 팝업은 검토 패널을 포함한 전체 페이지가 아닌 휴대폰 화면 중앙에 배치한다. 행동 없는 만료 등 상태는 불필요한 버튼 대신 같은 영역에 상태 문구를 표시한다.

### 입력과 전송 실패

플로팅 입력바 내부 패딩 8px, 입력 높이 44px·글자 14px, 전송 버튼 44px 원형. placeholder는 메시지를 입력하세요이며 말줄임표를 붙이지 않는다. 빠른 메시지는 안녕하세요! / 네, 좋아요 / 어디서 만날까요? / 감사합니다이며 13px, 최소 높이 36px, 흰 배경·테두리·10px 모서리다. 탭하면 입력창에 문구를 추가하고 전송은 별도 버튼으로 한다. 실패 표시는 작성자·신청자 모두 본인 말풍선 옆 하단에 재전송 아이콘을 붙인다. 아이콘 14px, 색 #B32632, 외곽 24px·모서리 6px·테두리 #DF9AA3·내부 투명, 터치 영역 44px. 별도 하단 실패 안내나 삭제 메뉴는 넣지 않는다.

### 검토와 구현 경계

변경 제안자는 작성자/신청자 역할과 별개로 내가 제안/상대가 제안 값을 받는다. 본인 제안은 철회, 상대 제안은 거절/수락을 표시한다. 차단은 입력을 막되 확정 약속의 상세·취소와 시작 후 중단/신고 접근을 유지한다. 첫 메시지 전·첫 전송 성공·신청 거절·모집 종료·철회·재신청·삭제·완료 고정 장면은 마스킹 이름을 사용한다. 차단된 확정 약속의 이름 공개는 기존 확정 상태를 유지한다. 전송 실패 이탈 안내는 신청자의 첫 전송 실패에만 신청 미생성을 설명하며 작성자에게 적용하지 않는다. 작성자가 보는 상대 철회 장면에는 상대의 철회 상태를 표시한다.

기존 대화·약속 상태 장면과 역할별 표시를 보존한다. 서비스 화면에는 실제 사용자 문구만 표시하며 예시·미구현·이벤트 연결 설명은 검토 패널로 분리한다. 현재 HTML 확인 버튼은 검토 이벤트를 표시하며 신청·메시지·약속을 실제 처리하지 않는다. 이 기록은 디자인 기준이며 Expo 연결 완료나 실기기 검증을 의미하지 않는다.


### 네이버 로그인 브랜드 규격

네이버 로그인 버튼은 공식 PNG의 N 로고를 사용한다. 배경 #03A94D, 로고 흰색, 실제 N 높이18px, 문구16px, 로고 왼쪽 여백20px, 문구는 로고 영역을 제외한 나머지 영역 중앙 정렬. 일반 글자 N으로 대체하지 않는다. 공식 원본192px 아이콘을48px로 비례 축소하며 이미지를 변형하지 않는다. [공식 가이드](https://developers.naver.com/docs/login/bi/bi.md) · 확인일 2026-10-13.


### S10 읽음 표시

모든 메시지 확인 장면은 대화방을 유지하고 개수 배지와 하단 채팅 점만 숨긴다. 비로그인도 채팅 점을 숨긴다. 목록 하단의 나가기 안내는 제거하고 나가기 확인 팝업에서 안내한다.

## 11. 외부 미리보기 조작 패널

미리보기 조작 패널은 서비스 화면 밖의 검토 도구이며 Expo 구현 대상이 아니다. 현재 10개 진입 화면은 preview-panel.css와 preview-panel.js를 공유한다. 데스크톱은 본화면 430px 옆에 패널 330px, 간격 24px로 배치하고 좁은 창에서는 패널을 본화면 아래로 보낸다. 패널 제목 24px, 설명 13px, 선택·버튼 14px/최소 높이 44px를 사용한다. 기존 상태 선택 항목과 이벤트는 유지한다. 스타일은 yd-preview-panel 및 외부 배치용 yd-preview-layout으로 제한하며 본화면 컴포넌트에 가져오지 않는다.


## 12. 구현 인계에서 제외할 요소

- 연결·미구현 안내 alert는 홈·행사 목록·행사 상세에서 제거했다. 실제 Expo의 기존 이동 이벤트를 연결하며 안내 팝업을 재현하지 않는다. 실제 거절·나가기 확인과 입력 오류 팝업은 유지한다.
- 홈 로그인 상태의 상단 프로필과 약속 카드의 본인/동행자 사진은 필수 표시 요소다. 홈 시안의 사진 경로는 yumidang-home/assets/ 아래이며 합성 인물 사진을 실제 회원 기본값으로 사용하지 않는다.
- 현재 가입 화면의 AI 법적 검토 안내 등 소스에 남은 검토 문구는 Expo 제품 문구로 복사하지 않는다. 해당 정책은 기존 Expo·정책 문서 기준으로 연결한다.
- HTML 다중 inset 그림자·backdrop-filter·rem·sticky·가상요소는 RN에 직접 복사할 수 없다. 재질 구현 후 Android 실제 화면에서 비교해야 하며 동일 구현이 완료됐다고 간주하지 않는다.


## 13. S12 알림 현재 검토 디자인

시안: [현재 화면](../../유미당-S12-알림-소스/index.html). 사용자 최종 확정 전이며 Expo 미적용이다.

S12 알림은 공고 제목15px/700을 우선 표시하고 상태 배지12px를 같은 행 오른쪽에 둔다. 설명13px/20px는 제목 아래10px, 약속 일정12px/18px는 설명 아래4px, 도착 시각11px/16px는 아래12px·오른쪽 정렬이다. 카드 모서리20px, 패딩18px 16px, 간격12px, 사진40px, 읽지 않은 점6px를 사용한다. 모두 읽음은 높이40px·13px/700·보라 글자/연보라 배경이며 불가능할 때 회색으로 비활성화한다. 버튼 눌림은 .96/100ms이며 reduced motion을 존중한다. 하단 안내문과 바텀바는 없다.

고정 장면: default / unread / read / empty / guest / loading / error / updates / missing / permission / expired / cancelled / read-error

전체/읽지 않음 필터, 동행 신청·확정 요청·동행 확정·변경 제안·후기·완료와 취소·조건 변경·변경 완료·모집 재개 예시를 유지한다. 읽지 않은 목록에서 모두 확인했으면 모든 알림을 확인했어요를 표시한다. 비로그인은 로그인 안내와 이벤트만 제공하며 개인 알림을 표시하지 않는다. 조회 불가 상태의 개수는 —이며 실제 빈 목록은 0이다. 누름·모두 읽음·재시도·로그인은 검토 패널에 이벤트만 표시하고 결과는 고정 장면에서 선택한다. 실제 읽음 처리·최신 대상 검증·이동은 기존 Expo 담당 영역이다.

## S14 공개 프로필 — 확정 디자인
사용자 확정: 2026-10-13. HTML 시안 완료이며 실제 Expo 적용은 별도다.
- 소스: ../../유미당-S14-상대프로필-소스/index.html, profile.css, profile.js.
- 하나의 흰 카드에 사진·기본 정보·관심사·대화 스타일을 통합한다. 이름 아래 나이·MBTI 텍스트, 그 아래 당도. 우측 상단 동행 완료 횟수와 후기 바로가기. 관심사 다음 대화 스타일 순서다. 자기소개·하단 안전 안내 문구는 표시하지 않는다.
- 사진 80px(좁은 화면68px), 당도 원형 게이지4px/#852CFF, 가이드 없음. 끝 하트15px/코랄#ED7185/흰 중심, SVG stroke4.5. 당도 범위와 공개 조건은 서버 값으로 받는다.
- 이름20px, 나이·MBTI12px, 당도13px/숫자18px. 이름 아래3px, 당도 위4px. 성향 영역 위16px, 항목 간12px, 라벨과 칩5px. 좁은 화면의 기존 줄바꿈을 유지한다.
- AI 요약은 준비·대기·실패·근거 부족·철회·숨김 모두 동일 아이콘과 화살표의 기본 접힘 토글이다. 펼침 시 최신 공개 조건 조회 이벤트를 연결한다.
- 칭찬은 상위5개 막대이며 정렬 조작은 없다. 후기는 작성자 사진·이름·당도·날짜, 평가 칩과 별점, 본문, 이모지 칭찬 칩 순서다. 양옆 중앙 반원 장식과 작성자 아래 점선 유지.
- 후기 본문14px/행간1.5/상하8px. 작성자 구분선 위아래10px, 작성자 이름·당도 간1px. 본문 없는 평가와 칭찬 칩 간10px.
- 긍정#24865F/#E7F7ED, 보통#946B0B/#FFF5CF, 부정#626975/#EEF0F3, 별#F2BC24. 별점 공개 여부 정책 검토 안건은 별도이며 시안에 별점이 남아 있다.
- 후기 더 보기 버튼 없음. 실제 앱은5개씩 하단 추가 조회, 중복 요청 차단, nextCursor 없음 종료. 실패 후 하단 이탈·재진입1회 재시도와 작은 다시 시도 버튼. HTML은 로딩·실패·추가 결과 고정 장면이며 실제 조회를 구현하지 않는다.
- 입력: 관계별 이름·사진·나이·MBTI·성향·당도·완료 수·공개 후기·칭찬5개·요약·조회 상태. 이벤트: 후기 위치 이동, 요약 조회, 추가 후기/재시도, 신고·차단. 비로그인·차단·탈퇴 공개 조건을 보존한다.
- 검증: 시안 주요 배치, 후기 바로가기, 요약6상태 동일 토글·아이콘, 추가 조회 실패 버튼 표시 확인. JS 문법 및 UI 범위 검사 통과. 실제 서버·실기기 검증은 미실시.
