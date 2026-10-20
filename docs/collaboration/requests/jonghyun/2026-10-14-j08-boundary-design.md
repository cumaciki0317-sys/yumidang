<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **공급사·비용:** 포텐스닷 공급사 회신은 수신됐고 교육·프로토타입 조건과 보안 우려로 실서비스 대체 API를 권고했다. Gemini는 종현 테스트 프로젝트·월50,000원 사용중단 예산·합성3건 검증 상태이며 최종 청구 상한 보장/운영 연결은 별도다. 대표 유미 계정 전환은 회의 때 확인한다. 포텐스닷320만 기술 토큰과 Gemini 원화 예산을 혼합하지 않는다. 실회원 원문 전송 HOLD.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# J08 읽음 경계 추가 검증 설계 — 2026-10-14

전체 **79%(22/28)** 유지. 앞선 [실제 검증](2026-10-14-temporary-validation-result.md)은 당시 소스와 실행 범위로 보존한다. 이번 작업은 아직 실행하지 않은 100개·다른 실제 방·숨김·나감·네이버 세션 연결 회수·원 인증 오류의 검증 도구 준비다. 제품 정책·제품 코드·SQL·민규 도구·성호 화면을 바꾸지 않는다. 실제 Auth/DB/VM/외부 호출은 이번 준비에서0이다.

## 정책과 현재 소스

`MemberService.messages`는20개씩 페이지를 읽고 `markMessagesRead`는 중복 없는1~100개 ID를 받는다. DB는 전부 같은 방의 현재 읽기 가능한 메시지여야 원자적으로 기록하고 최초 read_at은 유지한다. 번호120 숨김 migration은 현재119개 실제 SQL 파일 집합에 포함된다.

나감은 `conversation_visibility`의 본인 목록만 숨기며 직접 읽기 권한을 없애지 않는다. 상대 목록과 직접 읽기를 함께 확인한다. 숨김은 본인 identity의 `member_hidden_targets` chat 항목으로 목록/읽음 대상에서 제외하지만 이전 읽음 영수증을 삭제하지 않는다.

회수는 이번에 생성한 합성 회원 자격의 **private 네이버 세션 연결 한 행**만 잠시 제거한다. 원 GoTrue JWT·auth.sessions·원6계정은 수정하거나 갱신하지 않는다. 복원은 캡처한 해당 행 전체값·시각으로 한 번만 수행하며 충돌이면 중단한다. Auth500은 주입한 장애 모형이며 실제 장애로 보고하지 않는다.

## 담당과 고정 인터페이스

Root는 `member-root-boundary.py`와 Python 책임 시험, 이 문서를 단독 수정한다. event_design은 `member-connections-rest.mjs`와 Node 책임 시험만 수정한다. 모두 actor=jonghyun이며 편집 전 소유권 검사를 한다. 실제 실행·커밋·푸시는 이번 준비에 포함하지 않는다.

Root 콜백3개만 추가한다. 기존 runId·bindingSha256·sequence·exact args 검사는 유지한다. 임의 SQL·준비 승인 flag는 받지 않는다.

- `prepareReadBoundaryCases(requestId)` → exact `{requestId,messageIds,foreignRequestId,foreignMessageId,hiddenMessageId}`. 기존3개가 있는 main 방에97개를 더해100개, 같은 두 합성 회원의 별도 실제 방에1개를 준비한다.
- `inspectReadBoundaryCases(requestId)` → exact `{requestId,scopeRowsSha256,reads,hidden,visibility,sessionBindingRestored}`. reads는 `{userId,requestId,messageId,readAt,rowSha256}`, hidden은 `{id,rowSha256}`, visibility는 `{userId,requestId,rowSha256}`. 배열은 명시된 키로 정렬하고 중복을 거절한다.
- `setReadBoundaryCase(requestId,stage)`의 stage는 `hidden/revoked/restored`만 허용한다. 같은 inspect 형태를 반환한 뒤 Node가 독립 inspect로 다시 관측한다. stage 반복·역순·충돌은 거절한다.

scopeRowsSha256는 main/foreign posts·requests·messages·reads·hidden·visibility·현재 private 네이버 세션 연결의 전체 네이티브 행과 직접 FK로 연결된 부속 행을 고정 범위에서 해시한다. 부속 행을 다시 참조하는 행이 있으면 소유라고 추정하지 않고 UNKNOWN으로 중단한다. 복합 FK는 모든 연결 열로 대조한다. 원 session 전체행 해시가 현재와 같을 때만 sessionBindingRestored=true다. 본문·토큰·민감한 행 전체값은 Node에 별도 전달하지 않는다.

## 실행 순서와 합격 조건

1. 기존3개·동시 읽음 검사를 먼저 한다. Root가97개와 foreign 방을 준비하고 API20개씩5페이지에서 실제 반환한100개 ID 집합을 대조한다.
2. 아직 안 읽은 main ID와 실제 foreign 방 ID 혼합은404, scoped 전체 해시는 그대로여야 한다.100개 읽음 후 unread0, 이전 최초시각 보존을 확인한다.101개/중복은 SDK와 HTTP 경계에서 거절하며 DB 변경이 없어야 한다.
3. Root가 소유 숨김 한 행을 생성한 뒤99개 목록과 숨김 포함 혼합 읽음404를 확인한다. 이전100개 영수증은 보존한다.
4. 실제 leave를 호출해 본인 목록 제외·상대 목록 유지·직접 읽음 허용을 확인한다.
5. Root가 소유 네이버 세션 연결만 CAS 삭제한다. 같은 유효 GoTrue JWT로401/403 및 DB 읽음 불변을 확인한다. 원 연결·숨김 행을 정확히 복원하면 같은 JWT로 직접 읽기가 된다.
6. 잘못된 JWT의 실제 Auth 거절과 주입 Auth500은 각각 DB/RPC0이며 watermark 우회가 없어야 한다.

## 실패와 정리

모든 상태 intent는 SQL 진입 전에 O_EXCL로 저장하고 전송은 한 번이다. 진입/응답 유실은 UNKNOWN으로 남긴다. 파일 부재를 미전송 증거로 쓰지 않는다. 독립 native 읽기로 exact 소유값을 확인하지 못하면 변경/정리를 중단한다.

숨김 행은 생성한 ID·identity·target·전체행 해시가 맞을 때만 삭제한다. 회수한 세션은 원 GoTrue parent proof가 유효하고 같은 session의 충돌 행이 없을 때 캡처한 전체행으로만 복원한다. foreign 방·추가 메시지는 고정 ID와 전체행 해시로 확인한 소유 fixture만 삭제한다. unknown 행이나 권한을 표 단위 예외로 제외하지 않는다.

나감 행도 해당 합성 회원·방 조합에 제한하며 고정 범위 밖 값이면 정리하지 않는다. 원 Auth parent→post→request→message→현재 child/부속 행 순서로 잠근 뒤 native scope 전체 JSON과 추가 후손 부재를 다시 비교해야 삭제할 수 있다. 부속 행뿐 아니라 reads·visibility·hidden·네이버 세션 연결을 다시 참조하는 행도 부재를 검사한다. 예상 밖의 후손이 있으면 부모 CASCADE 삭제를 하지 않는다. 최종 원6schema 전체 행·권한·catalog·constraints 비교를 유지한다. 그 비교가 맞아야 baselineRestored=true다.

실제 새 환경 실행은 원복된 민규 도구의 정식 지원과 새 고정 소스 packet을 확보한 뒤 한다. 보관된 한시 도구를 로딩하거나 옛 실행 PASS를 이번 새 소스 검증으로 바꾸지 않는다. 이번 로컬 책임 시험은 이 콜백의 범위·순서·충돌·정리 실패 검사를 다루며 실제 SQL 증거가 아니다.

## 이번 준비 결과

종현 clone의 기준 HEAD는 `86cec202a763bcf3864f792c19e275bd8a29196a`다. 이번 변경은 미커밋 작업본이며 위 실제 검증 기록의 소스 버전으로 승격하지 않는다. Root는 Python 두 파일·이 문서, event_design은 Node 두 파일만 수정했다. progress_audit은 Node/브리지/16개 ABI를 읽기 검토했고 ai_design은 Python 범위·UNKNOWN·CAS·부속 FK 후손 보호를 읽기 검토했다. 둘의 검토를 실제 실행 PASS로 계산하지 않는다.

- Python 책임 시험 **41/41 PASS**: 잘못된 범위/순서/중복, 세션 충돌/원 시각 복원/parent proof, 응답 유실 후 재전송0, 원3개 보존/97+1 준비, 잠금 뒤 native scope 비교, 미확인 후손 발견 시 변경·정리0을 포함한다.
- Node 책임 시험 **10/10 PASS**: 고정 입력·반환·메소드/단계·최초시각 보존·TLS 허용 경로·SDK101/중복 호출0을 포함한다.
- Python AST·Node 문법·diff 공백·종현5경로 소유권·문서 언어 혼입 검사 통과. Node 실행은 package module 형식이 명시되지 않았다는 기존 경고를 냈지만 실패는 없다. 공통 package 설정은 수정하지 않았다.
- 이번 준비의 실제 SQL/Auth/HTTP/VM/공급사/자격증명 읽기·커밋·푸시는0이다. 두 민규 도구의 원 SHA와 민규 담당 복귀를 다시 확인했으며 원본 작업 공간은 깨끗하다.

| 변경 소스 | 작업본 SHA256 |
|---|---|
| `tests/integration/jonghyun/member-root-boundary.py` | `f4a9da85dcc1c969238dc3241cf9960d3ac2d8cdf0405a775a9c06bdb1f1cdcb` |
| `tests/database/jonghyun/test_member_root_boundary.py` | `31215665206f97073d9d9127984b9aa32e80ca55082fe564364cb683dfb1e12e` |
| `tests/integration/jonghyun/member-connections-rest.mjs` | `0d7a7d8c94b981d59556dde6766c8d90f12220476b35014768f69c307af8a39f` |
| `tests/functions/jonghyun/member-connections-runtime.test.mjs` | `9a60036eda2cc4883d48d9fcad98e2e68f10295320d02966ba89e498b98b96b6` |

전체 **79%(22/28)** 유지. 다음은 정식 검증 도구 지원·고정 실행 소스의 준비 후 이번 추가 시나리오만 실제 확인하는 것이다. J07의 [미확정 평가 기준 두 선택](2026-10-14-j07-result-finalization-design.md)은 답변 전 구현하지 않는다.
