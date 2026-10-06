# 배정 담당자의 현재 검토 상태·버전 조회 후보73

actor minkyu / 하네스 C. 후속 migration20261005161352_assigned_report_review_state.sql은 source72의 review_version을 읽는 좁은 API다. SQL70/71/72와 runtime graph52를 바꾸지 않는다. 원문 없이 현재 상태/버전만 읽으며 최초 작성 때 실제 SQL/HTTP/DB/API 실행은 NOT_RUN이었다. 후속 root 후보 SQL PASS는 아래 범위를 따른다. agent DB/API 실행은0이다.

## 계약과 잠금

public.get_assigned_report_review_state(p_report_id uuid)는 정확 {reportId,status,version} 3키를 반환한다. status는 received/reviewing/more_evidence/resolved, version은1~9007199254740991 안전 정수다. source72 성공 영수증의 과거 version을 현재 상태로 사용하지 않는다. 기존70 제출 자료의6키 DTO는 불변이다. 보관 유효한 resolved 상태도 현재 상태로 반환하며 임의 완료/통지/이의 성공을 뜻하지 않는다.

authenticated EXEC만 허용한다. 기존 fresh Auth user → session → 승인 → 해당 사건 배정 guard를 호출하고 actor 자신의 profile_retired면42501이다. 비회원 active Auth 직원은 회원/Naver 자격 없이 명시 승인/배정으로 조회할 수 있다. 다른 신고자의 탈퇴는 조회 거절 조건이 아니다. 없거나 타인/만료된 session과 익명은28000, 미승인/미배정42501, 없는/만료 신고는PT404, 잘못된 version은55000이다.

직원 guard 다음 report FOR SHARE만 잡고 retention을 판정한다. appointment/hold/identity 잠금은 추가하지 않아 쓰기 경로의 appointment → report 순서와 역전되지 않는다. 잠금 대기 뒤 guard/actor 탈퇴/현재 DB 보관 시각을 재검사한다. 마지막 통과 후 기존 report_access_audit의 report_read에 actor/report만 기록한다. 실패 시 해당 statement audit도 롤백하며 version/status/receipt는 쓰지 않는다. 접근 audit는 조회 사실이며 실제 판정/dispatch/통지 영수증이 아니다.

기존 staff 읽기 owner와 guard owner가 같고 schema USAGE·auth.uid/jwt/role·guard/profile_retired EXEC·report SELECT/row-lock UPDATE/RLS 우회·audit INSERT/sequence USAGE가 이미 적합해야 한다. gateway4가 owner USAGE 또는 SET이면55000 중단한다. 기존 역할·원문 table grants·70/71/72 helper ACL은 확장하지 않는다. 새 외부 권한은 이 public 고정 RPC의 authenticated EXEC뿐이다.

## 회귀와 남은 증거

BEGIN/ROLLBACK fixture는 기존 가입·공고·첫채팅 신청·확정·신고 public RPC로 준비한다. 프로필 없는 별도 Auth 직원에 owner 합성 승인/배정을 설정한다. default1 → actual start2, 일반 신고 more_evidence3와 과거 receipt2 분리, resolved4, MAX 안전 정수 조회, 미승인/미배정/타인 사건/일반 회원·회수된 approval/assignment·session 만료/타인/익명/삭제·retention 만료·NULL input 및 실패 audit0를 검사하도록 작성했다. 실패 audit count는 pg_temp의 고정 상태 RPC용 owner 합성 helper만 읽고 사용자 table privilege를 열지 않는다. 현재70/71/72 함수 owner/body/ACL과 역할/guard/worker를 비교한다.

실제 retired 직원 회원의 탈퇴·세션/권한 경합 시험은 실제 통합 후속 범위로 남으며 이 fixture로 완료를 주장하지 않는다. guard 뒤 session이 기다리는 동안 만료되거나 retention이 끝나는 실제 두 세션 시험도 별도다. 구조/언어/권한 범위 정적 검사는 실제 SQL parser/apply·DB·HTTP·모바일·운영·통지/이의를 대신하지 않는다.

후속 C client 인터페이스는 기존 dedicated JWT/anon transport에 get_assigned_report_review_state와 start_assigned_report_review만 추가한다. getter args는 p_report_id 하나, starter args는 p_report_id/p_request_id/p_expected_version 세 개다. getter result3키와 starter result5키를 exact decoder로 확인하고 safe integer·입력/출력 report 일치·starter status reviewing 및 version=expected+1·holdId UUID/null·alreadyApplied boolean을 검증한다. actor/identity/본문/추가 인자는 거절한다. B는 GET /operator/reports/{id}/review-state를 별도로 연결하며 기존 자료 GET6키를 바꾸지 않는다. 이 문서 작성은 runtime/client/handler를 수정하지 않는다.


## 후속 실제 후보 SQL73 및 client 증거

root가 실제 격리 native71에서 고정72+73 전체 SQL을 단일 TX에 적용하고73 회귀만 실행해 SQLexit0/PASS를 확인했다. 영수증은 /private/tmp/yumidang-review-state73-candidate-reviewed/receipt.json, SHA f48e0bec4bb3a711c35704623e886b22926c2a0ff84f707bc444443d3945c03a, driver SHA557d81c7a285a61120659f988626fa7a782edfc7e5b7b036936950fff1a71e64다. assertion을 명시적으로 켠 실제 회귀이며 SQL73 4c497604f20db4708f65750697fe8bc4f51ea5e1afe6d81d95c2e119a63f0846, test41e75580c03d3d99b3810f0b43e069c19081d7fa2d984dc8bc3c442f2f3d8e59는 불변이다. 이것은72 전체 회귀를 이 실행에서 다시 수행한 증거가 아니며72는 별도 PASS 영수증을 따른다.

전체 ROLLBACK 뒤 보존 검사12개가 모두 true다. history71·기존 proof·policy/catalog·역할·자료 수·정확한 인증 감사288개 ID/payload·guardfalse·workeridle·files0·컨테이너와 소스 핀을 보존했고 새72/73 objects는 없다. 정식72/73 적용은 아직 NOT_RUN이다.

C dedicated client의 신규 getter/starter exact3/5 및 safe-version transport는 기존5+신규5 mock10/10과 deno check --no-remote PASS다. client SHA4fc6e82f777e464596f25739ec56fc6432bb3683ffa9dab679df2f3f4921c6db, test SHA3e54b8c5e00b1e3fd8d432dce59265175f675b5e261e5b5028754b95d295e684다. 기존 신고 자료6키는 보존한다. B의 HTTP candidate 통합/실제 API 시험은 별도이며 mock fetch를 실제 DB/Provider 호출로 설명하지 않는다.

실제 retired 직원 회원 통합·두 세션 대기/회수·검토 state/start HTTP·hosted Edge·운영 계정·모바일·판정/통지/이의 및 운영은 NOT_RUN이다. 이 문서 갱신은 SQL/test72/73·runtime을 바꾸지 않는다.
