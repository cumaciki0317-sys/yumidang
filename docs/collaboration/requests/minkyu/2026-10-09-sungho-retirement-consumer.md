# 성호 모바일 탈퇴 화면 연결 인계

작성자 minkyu, 2026-10-09. 정책50bbace에 따라 화면은 sungho 담당이다. 이 문서는 외부 메시지 전송이나 화면 수정 완료를 뜻하지 않는다.

대상은 apps/mobile/src/screens/RemoteMemberScreens.tsx의 탈퇴 및 최소 영수증 화면이다. 현재 handler는 processing/completed를 구분하지 않고 세션 삭제 후 로그인으로 이동하므로 실제 완료를 안내할 수 없다. 기존 변경은 보존한다.

민규 adapter/store 연결 후 화면은 withdrawalId·status(processing/completed)·memberAccessRevoked:true 최소 receipt만 보여준다. processing을 완료로 표시하지 않는다. 최초 응답 유실은 동일 원 ID로 사용자가 직접 재확인하며 새 ID·자동 재전송·일반 세션 복구를 하지 않는다. 확인된 권한 회수 후 일반 로그인 Guard 밖에 최소 영수증과 명시적 로그인 이동을 제공한다. JWT·원문을 화면/로그/영구 저장소에 넣지 않는다.

새 로그인·로그아웃·사용자 또는 port 교체 시 이전 receipt와 원 인증 문맥을 폐기한다. 기간·polling 정책을 새로 정하지 않는다. 성호는 정상/처리 중/완료/응답 유실/만료/사용자 교체 UI 소비를 검증한다.

## 2026-10-10 연결 인터페이스와 검증 결과

민규 연결은 root worktree에 반영했다. `remote.tsx`의 `useMemberRetirement()`로 상태를 구독하고 `requestMemberRetirement(withdrawalId, signal?)`로 최초 요청 또는 같은 ID의 수동 재확인을 수행한다. 비 React 소비자는 `memberRetirementSnapshot()`과 `subscribeMemberRetirement(listener)`를 사용한다. 상태는 `null` 또는 `{withdrawalId, receipt, busy, errorCode}`이며 receipt는 `null` 또는 `{withdrawalId, status, memberAccessRevoked:true}`다. `receipt:null`은 미확정이고 완료가 아니다. 오류 코드는 `AUTH_REQUIRED` 또는 `RETIREMENT_STATUS_UNCONFIRMED`이며 민감한 원 오류를 표시하지 않는다.

신뢰된 초기화의 `retirementContract:"2026-10-09-retirement-receipt"`가 있어야 탈퇴 연결이 활성화된다. 기본은 비활성이며 동일 HTTPS 프로젝트의 정확한 service-api 주소를 확인한다. 확인된 응답은 일반 회원 세션만 회수하고 원 인증 문맥을 메모리에 남겨 같은 ID를 재확인한다. 원 토큰 만료 뒤 일반 세션을 복구하거나 새 탈퇴 ID를 생성하지 않는다.

기존 화면의 직접 `session.retire` 호출 뒤 `installMemberSessionDetails(null)` 및 즉시 로그인 이동은 위 연결 함수로 교체해야 한다. 해당 세션 설치 호출은 원 영수증 재확인 문맥까지 폐기하므로 탈퇴 확인 처리에 넣지 않는다. 회원 Guard보다 먼저 최소 영수증 화면을 표시하고, 처리 중과 완료를 구분한다. 명시적 로그인 이동과 로그아웃은 이전 문맥을 폐기한다. 이 화면 변경은 성호 담당이며 아직 미완료다.

root 검증은 신규 adapter16·소비 상태14·기존 민규 읽음4·기존 종현 웹 세션7, 총41개 PASS/skip0다. 테스트는 합성 요청·응답과 상태 계약 검증이며 실제 화면·실회원·배포 검증으로 집계하지 않는다. 기존 메시지 읽음 연결도 보존했다. 별도 정적 영수증은 `/private/tmp/yumidang-mobile-retirement-static-20261009-v2/receipt.json`이며 SHA `cf7fe91c73446fb73e5438a6ecd649fd6d376a73167881675de1844124549689`다.
