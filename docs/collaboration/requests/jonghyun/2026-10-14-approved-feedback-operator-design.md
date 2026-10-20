<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **AI 선택 동의:** AI 탐색은 첫 사용 동의·거절 시 일반 검색 유지. 후기 AI는 가입 시 열람/내 프로필 생성·노출/작성 후기 활용의 세 선택 항목·기본 미선택이며 전체 동의 편의 기능과 독립 철회를 제공한다. 기존 테스트 계정 간주와 실회원 동의 증거를 구분한다.
> **공급사·비용:** 포텐스닷 공급사 회신은 수신됐고 교육·프로토타입 조건과 보안 우려로 실서비스 대체 API를 권고했다. Gemini는 종현 테스트 프로젝트·월50,000원 사용중단 예산·합성3건 검증 상태이며 최종 청구 상한 보장/운영 연결은 별도다. 대표 유미 계정 전환은 회의 때 확인한다. 포텐스닷320만 기술 토큰과 Gemini 원화 예산을 혼합하지 않는다. 실회원 원문 전송 HOLD.
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미다. 일반 신고 처리와 해당 신고의 허용된 제출 증거 처리는 조유미 부재 시 종현이 대체한다. 이 지정은 고객지원·AI 비용·서버 운영의 대체 권한으로 확대하지 않는다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# 승인된 AI 평가·운영 담당 탈퇴 후속 설계 — 2026-10-14

전체 **79%(22/28)** 유지. 기존 구현·한시 격리 연결·도구/담당 원복·후속27개 로컬 커밋 ad08baf는 완료 범위로 보존한다. 이번 사용자 답변은1번과3번 추천안 진행을 승인했고,2번 추천안을 수용하면서 과거 대화가 남는다는 설명에 의문을 제기했다. 이 후속은 새 미커밋 작업이며 자동 커밋/푸시/운영 승인으로 확대하지 않는다.

## 대화 보관 설명 정정과 확정 범위

평가는 AI 챗봇 답변의 helpful이다. 월요일 답변을 화요일 동의 철회 뒤 수요일에 다시 여는 예시는 현재 정책/화면과 맞지 않아 철회한다. 정책9·AI 계약·S20은 대화/결과를 기기 메모리만 유지하고 화면 종료·로그아웃·새 대화/세션 교체 때 삭제한다. 현재 RemoteAiSession의 blur cleanup도 messages/result를 비운다. 자정 초기화는 하루20회 이용 한도이며 대화 기록의 다음날 재열람 기능이 아니다. 이 답변을 하루 보관·영구 대화함 도입 선택으로 해석하지 않는다.

사용자가 현재 화면에서 확인할 수 있는 기존 메모리 답변의 평가를 허용하는 방향을 유지한다. 동의 철회 후 새 모델 전송은 계속 중단한다. 현재 화면이 닫혀 답변이 없어졌다면 DB 상태 조회만으로 원문/카드/대화를 복원하거나 평가 버튼을 새로 만들지 않는다. 기존 helpful90일/탈퇴 파기와 같은 clientRequestId 접수 영수증 복구를 유지한다. 성호 화면 수정/신규 배정0이다.

## 승인1 — 원 정상 결과의 읽기 전용 상태 확인

현재 submit_ai_feedback는 본인 result receipt+원 request.finished를 접수 TX에서 이미 검사한다. record/finish 순서나 실패 정리를 변경할 이유가 없으며, 없는 연결은 원 결과의 GET-only 상태 조회다.

GET `/functions/v1/ai-chat/results/{requestId}`와 `/ai-chat/results/{requestId}`를 준비한다. requestId는 원 서버 UUID이며 clientRequestId/feedback 멱등키와 다르다. 본인 인증과 현재 회원 권한으로 정확한 요청만 읽고 model/search/일일차감/acquire/record/finish/feedback 쓰기0을 유지한다. 모델이 비활성이어도 상태 읽기 포트가 준비되면 조회 가능하다. 포트 미지원/오류503, 다른 회원/없는 ID는 같은404, query/hash/body/range/비허용 method는 거절한다.

정확한 DTO는 `{requestId,status:'available'|'pending'|'unavailable',availableAt:null|string,helpfulAllowed:boolean}`이다. 본인 receipt와 finished가 함께 있고 현재 회원/원 준비 시각+90일이 유효한 때 available/helpfulAllowed=true다. availableAt은 서버 제공 준비 시각이며 열람 증거가 아니다. NULL outcome의 살아 있는 lease는 pending/false, 만료 lease·finished-without-receipt·output_privacy는 unavailable/false이며 이 둘의 availableAt은null이다. 원 결과90일 만료는 기존 helpful와 같은404로 닫는다. 정상 finished+receipt는 원 lease가 현재 만료됐다는 이유만으로 차단하지 않는다. 조회 결과가 평가를 예약하지 않으며 POST는 접수 시 다시 검사한다.

HTTP envelope의 requestId는 이번 GET의 새 context이고 data.requestId는 원 결과 ID다. 둘을 같은 ID로 검사하지 않는다. SDK에는 읽기 method를 추가하되 기존 feedback 동일키 복구 앞에 이 GET을 무조건 강제하지 않는다. accepted 접수 영수증90일과 새 helpful 가능 기한은 다른 분기다. 성호 화면의 실제 소비/배치는 이번 백엔드/서비스 포트 준비 완료와 구분한다.

필요 경로는 기존 contracts/ai.ts·db/ai-feedback-client.ts·internal-client.ts·ai-chat handler/index·모바일 service.ts와 새 readonly migration·종현 책임 시험이다. 편집 전 exact ownership을 확인하고 각 파일 단독 담당을 별도 배정한다. 임의 seen=true 표식·원문 저장·새 AI 재전송을 만들지 않는다.

## 승인3 — 일반 탈퇴·권한 회수·영수증 보존

신고 최종 종결·일반 이의 종결·취소 시계 수리의3 actor/Auth FK만 새 migration에서 정확한 catalog를 확인해 분리한다. actor UUID·원 clientRequestId 복합 PK·fingerprint/result·report/appeal 파기 관계·기존 최종종결+90일을 유지한다. approval.Auth CASCADE·assignment.Auth SET NULL은 권한 수명 관계이므로 그대로 둔다. 영수증 삭제/새 보관 시계/새 운영 역할·직원 seed는 만들지 않는다.

공통 require_assigned_report_operator에 탈퇴 상태를 확인해 일반 report/capture/Storage 및 mutation/기존 키 replay도 차단한다. owner-only 재승인/재배정 true는 탈퇴 UID를 거절하고 false 회수는 유지한다. 이 guard에서 회원 가입/네이버 자격을 새 직원 증명으로 요구하지 않는다.

member_retirements INSERT의 전용 trigger로 같은 탈퇴 TX에서 원 UID approval/assignment의 revoked_at을 회수한다. 직원 approval/assignment 이력이 둘 다 없는 일반 회원은 조기 반환해 새로운 Auth 강잠금/실패 조건을 추가하지 않는다. 핵심 public retire 함수를 통째로 복사하지 않는다. 기존 탈퇴가 account→profile→episode 잠금을 이미 잡으므로 직원 trigger는 Auth parent→approval→assignment(정렬된 id)를 NOWAIT로 얻어 기존 직원 경로와 충돌하면40001로 전체 TX를 되돌리고 부분 회수를 남기지 않는다. 신규 true provisioning은 기존 Auth parent 뒤 존재하는 profile을 KEY SHARE NOWAIT로 잠가 진행 중 탈퇴와 교차 승인/배정을 막고 profile_retired를 검사한다. Auth-only 비회원 직원의 새로운 탈퇴 endpoint는 추가하지 않는다. 기존 회원 탈퇴 조건·제재원장은 유지한다.

단독 담당: event_design은 새 `20261014010000_operator_receipts_retirement.sql`과 `tests/database/jonghyun/operator_receipts_retirement.sql`, 필요한 정적 schema 검증만 수정한다. ai_design은 AI 상태 migration·공통 계약·DB reader·내부 allowlist·DB 합성 시험·SQL 후보6개를 수정했다. Root는 설계/AI 계약 문서·HTTP runtime·모바일 service·HTTP/SDK 시험을 수정했다. progress_audit은 HTTP/SDK 읽기 검토, ai_design은 운영 담당 탈퇴 읽기 검토도 수행한다. 각 허용 경로는 actor=jonghyun 검사 후 단독 수정한다. 운영 담당자·다른 역할/회원의 행을 자동 변경하는 seed는 없다. migration 자체의 schema 수정과 승인된 퇴직 UID 범위의 trigger를 구분한다.

## 실제 검증과 실행 조건

승인된 기존 VM 재시작 경계는 다시 묻지 않는다. 두 도구의 원본/민규 담당 복귀는 완료돼 있으며 현재 원 도구는 기존 컨테이너 보존/OS 임시 root/현재 Auth 이력에 필요한 정식 지원이 없다. 한시 archive 재로딩이나 담당 우회는 하지 않는다. 새로운 migration 파일 수/핀과 신규 실제 읽음100·숨김/회수·탈퇴 completed/Auth/Storage/ACK·캡처 ACL/audit 검증에는 정확한 새 target/receipt·도구 지원·정리 검사가 필요하다.

SQL/계약 작성·정적/합성 검사와 실제 DB 적용·Auth/Storage/권한 경합 검증을 구분한다. 신규 actual은 NOT_RUN이며 운영/실회원/외부 공급사/추가 결제/외부 메시지0이다. 모든 기능과 외부 조건이 닫히기 전 전체 완료로 표시하지 않는다.

## 후속 구현·검사 결과

승인1/2의 상태 읽기 SQL·엄격한4필드 공통 검사·내부 allowlist·GET handler/runtime·SDK를 구현했다. 서버는 Auth와 RPC 조회의 총마감/호출자 취소·늦은 반환 폐기를 적용한다. 읽기 검토에서 기존 공통 SDK가 토큰 조회 완료 뒤에 타이머를 만들던 공백을 발견해 새 getAiResultState에만 토큰부터15초를 적용했다. 늦은 토큰의 새 HTTP 전송0·늦은 응답 폐기를 확인했고 기존 POST 전반을 수정하지 않았다.

승인3은 기존 영수증3개 Auth FK 분리·탈퇴 TX의 직원 권한 회수·공통 접근/재승인 guard를 새 SQL로 작성했다. 원 receipt UUID/PK/result/fingerprint·기존 파기 시각과 report/appeal CASCADE를 보존한다. 실제 SQL 실행/두 세션 경합/Auth삭제/Storage/90일 경과는 NOT_RUN이다. 정적 검사는 변경 허용 범위 검사이며 SQL 동작 PASS가 아니다.

- Root Node 묶음67개 최초 실행은 **66 PASS/1 FAIL**이다. 실패는 새 runtime 합성 JWT가 두 부분이라 기존 인증 검사를 통과하지 못한 시험 입력 오류였다. 세 부분 합성 JWT로 시험만 정정해 해당1개를 재검사했고 **1 PASS**다. 원 최초 실패를 덮어 단일67/67 실행으로 표현하지 않는다. 신규 DB reader7·HTTP7·SDK6과 기존 AI HTTP/feedback/mobile-service 회귀가 포함된다.
- 별도 기존 ai_feedback_client/internal_rpc_client 회귀 **8/8 PASS**. 앞선 agent7이나 Root67과 합산해 새 단일 총 검사로 표시하지 않는다.
- 운영 담당 탈퇴 Python 정적 범위 검사 **5/5 PASS**. SQL 실행/권한 경합 검증으로 확대하지 않는다. SQL parser 라이브러리는 현재 없어 추가 parser 판정은 하지 않았다.
- Deno 기본 검사 첫 실행은 기존 모바일 domain.ts의 확장자 없는 types import에서 실패했다. 파일/환경 설정을 바꾸지 않고 `--sloppy-imports`를 적용한 handler/index/service 타입 검사는 PASS다. 기존 import 해석 조건과 제품 오류를 구분한다.

이 문서는 기존 J07 result-finalization/operator-retirement 및 후속27개 검토 문서의 당시 정책 선택 대기를 대신하는 최신 후속이다. 이전27개는 ad08baf 로컬 커밋으로 보존하며 이번 새 변경을 그 커밋/검증 범위로 확대하지 않는다. 현재 두 신규 migration을 포함한 SQL은121개이며 새 실제 검증에서는 정확한 새 소스/SQL 핀이 필요하다. 이번 새 변경은 미커밋·푸시0이다.

## 완료한 이전 범위와 남은 실제 검증의 구분

행사3필터·확인된 미전송 자동1회·원 JWT/탈퇴 ID GET 복구는 제품 구현 완료다. 승인된 격리 환경의 행사·summary14·피드백 일부·읽음 개별/경합·탈퇴 processing 복구는 [당시 실제 실행 기록](2026-10-14-temporary-validation-result.md)의 소스/대상 한정 PASS다. 대기 마감 보완 등 후속27개도 로컬 구현·책임 검사·커밋 완료다.

읽음100/숨김/나감/철회·탈퇴 completed/Auth삭제/Storage/ACK와 현재 변경 소스의 실제 연결은 아직 실행하지 않았다. 첫 한시 실행의 일부 검증 범위를 전체 완료로 설명해서는 안 된다. 합의한 원복 전 잔여 검증을 끝까지 정리하지 못했고, 도구/담당 복귀 뒤 추가 범위가 남은 것은 작업 순서와 완료 보고의 한계로 기록한다. 기존 VM 승인 부족 때문이 아니며 승인 재요청 없이 독립 구현을 계속한다. 원복한 두 도구의 정식 지원이 없는 상태에서 기존 자원 검사나 담당 검사를 우회해 actual을 실행하지 않는다.

## 실제 실행 준비의 추가 공백과 후속

읽기 감사에서 기존 member-connections-rest 브리지가 새 GET 경로/내부 get_ai_result_state RPC를 허용하지 않는 준비 공백을 확인했다. ai_design이 해당 driver와 기존 책임 시험2개만 보완했다. 원 UUID의 GET/서비스 전용 RPC 두 인자만 허용하고, 기존 성공 영수증 직후 본인available·타인/missing404·HTTP envelope 새 ID·원91일 fixture 뒤404와 읽기 외 RPC/모델 증가0을 연결했다. query/POST는 이 좁은 TLS bridge에서 runtime 이전503으로 닫으며 제품 handler400/405는 앞선 HTTP 책임에서 별도 검증한다. 기존16콜백/원 Auth6/J08/J09/Root판정 요구를 보존했다.

Agent 첫13개는12 PASS/1 envelope fixture FAIL였고 실제 `{data,requestId}` ABI로 시험만 교정해13 PASS였다. 쓰기 종료 후 Root가 최종13개를 실행해 **13/13 PASS**를 확인했다. 실제 Auth/DB/VM/공급사 호출0이며 이 합성 결과를 새로운 실제 연결 PASS로 표현하지 않는다. 기존 inspectAiFeedback의 단일 O_EXCL 저장 계약을 반복 호출하거나 새 임의 SQL 콜백을 만들지 않았다.

J09 준비 설계는 두 실제 경우를 분리한다. A는 새 합성 사진 원 바이트/객체 ID 확인→원 탈퇴 POST1/processing GET→제품 cleanup/RPC·실제 Storage/Auth삭제·원ACK→원 작업의 저장 증거 조회 복구→원JWT/탈퇴ID completed 조회다. SQL115는 ACK가 저장됐으나 task가 미완료인 경우만 복구하므로 ACK 저장 뒤 응답 유실로 그 경계를 검증한다. task complete가 이미 커밋된 응답 유실을 SQL115의 미완료 task로 가장하지 않는다. B는 DELETE 응답 유실·ACK 없음일 때 원UNKNOWN과 새 삭제/ACK/complete0을 보존하는 별도 새 owned 경우다. B를 임의 정산해 A의 completed 성공으로 만들지 않는다. 기존 민규 이름의 provider harness에서 fixturePorts가 만드는 합성 complete/ACK, 고정 옛socket/port/private keyfile는 새 실제 완료 근거로 재사용하지 않는다.

제품 cleanup adapter/실제RPC 조립 및 새 Storage target/원바이트 custody·guard/ACL CAS 원복/다른5회원 보존과 영수증 파기 관계를 유지하는 전용 fixture 구현은 종현 독립 준비로 계속할 수 있다. 새 실제 실행만 두 도구 지원·새 owned target/관찰·순차 슬롯 조건에 의존한다. 새로운 제품 선택이나 VM 실행 승인은 현재 추가하지 않는다.

사용자가 두 번째 한시 재배정을 승인했고, 정책06e95baf를 별도 관리 clone에서 만든 뒤 종현이 FF로 받았다. 도구 지원·원본 보존과 후속 검증/원복 순서는 [두 번째 한시 검증 설계](2026-10-14-round2-validation-design.md)를 따른다. 이 승인 전의 도구 담당 대기는 당시 기록이며, 현재는 종현 한시 담당에서 지원 준비를 계속한다.
