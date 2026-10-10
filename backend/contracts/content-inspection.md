# 일반 콘텐츠 사전검사·저장 연결 계약

기준은 [정책6-4](../../정책.md#6-4-공개글과-채팅-검사)와 [탐지 검토안](../../docs/collaboration/requests/minkyu/2026-10-09-content-inspection-draft.md)이다. 금지 범주는 확정이고 세부 탐지·오탐 품질은 미확정이다. 원문을 로그·별도 검사 원장·외부 AI에 보관/전송하지 않는다.

## 설치와 상태

`service-api/index.ts`의 신뢰된 `contentInspection` 조립값은 승인된 검사기·정책/검사기 버전을 받는다. HTTP 입력·환경 문자열·사용자 헤더로 활성화하지 않는다. 기본 runtime에는 검사 endpoint나 저장 adapter를 설치하지 않는다. SQL116의 `content_inspection_control.enabled`도 기본 false다. **기본 상태는 기존 작성 동작이며, 사전검사가 강제되는 상태가 아니다.** API 옵션과 DB control·issuer EXEC를 모두 검토하고 소비자를 연결해야 활성화할 수 있다.

검사 대상은 공고 생성/수정·성향/소개·가입 성향·후기·신청 첫 채팅·일반 채팅의8개 RPC다. 공고 제목/본문/성향 메모/공개 지역/등록 장소명/태그, 프로필 소개/관심사/대화 방식, 후기 한마디, 실제 메시지를 검사한다. 정상 등록 주소·상세 만남 지점·사진 경로·UUID는 문장 분류에 포함하지 않는다. 실제 저장 입력 전체는 DB digest 결합에 사용한다.

별도 signup factory에도 같은 승인 `readiness`로 저장 adapter와 두 결합 헤더의 CORS를 설치한다. `createSignupRuntimeHandler(read, fetchImpl, {contentInspection: readiness})`의 세 번째 인자이며 기본 두 인자 호출은 유지한다. 검사 발급은 service-api를 사용하고 가입 완료는 원 JWT의 ticket POST 조회 이후 가입 RPC로 전달한다. 상태 읽기는 티켓을 요구하지 않는다. 실제 Auth 사용자 검증을 기존 프로필 존재 검사로 대체하지 않으므로 최초 프로필 생성 전에 검사할 수 있다. 관련22개 모형 검증·Deno PASS, full8-v9의 8개 실제 작성 endpoint 전체 통합도 격리 합성 데이터에서 PASS다.

## HTTP 소비 순서

1. 검증된 본인 JWT로 `POST /content-inspections`에 `{rpc, operationId, input}`을 보낸다. `input`은 실제 작성 API가 검증·정규화한 RPC 인자 전체와 같아야 한다. 서버가 `userId`를 인증 결과에서 정하며 본문에 받지 않는다.
2. 응답은 `{decision, reasons, ticketId, operationId, action, targetId}`다. 판정은 `allow / confirm_required / block`, 이유는 공개글 `PERSONAL_DATA / PROHIBITED_CONTENT`, 채팅 `HIGH_RISK / AMBIGUOUS_RISK` enum이다. 원문/외부 이유/검사기 raw 응답은 반환하지 않는다.
3. `allow`는 기존 작성 endpoint에 같은 입력과 `x-content-operation-id`, `x-content-inspection-ticket` 두 헤더를 전달한다. **검사 성공은 아직 실제 저장 성공이 아니다.** 실제 API/DB 저장 영수증으로만 성공을 표시한다.
4. `confirm_required`는 채팅의 `AMBIGUOUS_RISK`만 허용한다. 수정하면 새 입력·새 operation/messageId로 다시 검사한다. 그대로 전송 선택은 `POST /content-inspections/confirm`에 `{rpc, operationId, input, ticketId}`을 보내 같은 원 채팅을 확인하고, 이후 두 키로 기존 작성 API를 호출한다. 서버 응답은 `{ticketId, operationId}`다. `block`을 확인으로 해제하지 않는다.

채팅의 operationId는 실제 원 messageId와 같다. 프로필 전체 교체·공고 수정에도 원 작업 UUID가 필요하다. 동일 작업의 응답 유실은 같은 키와 입력으로만 재조회한다. 검사기/발급/저장 오류를 새 ticket·새 messageId·가짜 allow로 자동 대체하지 않는다. 검사기는 서버 `UPSTREAM_TIMEOUT_MS`에 종료되며 취소를 무시한 늦은 allow도 발급을 시작하지 않는다.

## DB 경계와 복구

`issue_content_inspection_ticket`은 검토된 service 자격 전용이며 기본 EXEC 닫힘이다. authenticated의 전용 조회/확인은 본인 ticket만 사용한다. 직접 작성 RPC도 활성화된 gate를 적용하므로 HTTP adapter를 거치지 않는 호출이 새 저장을 우회할 수 없다.

ticket은 작성자·operation·action·target·전체 입력 SHA256·버전·판정·유효기간·최소 소비 결과만 저장한다. 자유 입력 원문/소개/성향 DTO를 복사하지 않는다. 같은 트랜잭션의 기존 validator·저장·소비가 함께 성공하거나 rollback한다. 프로필 전체 교체만 배타 잠금을 먼저 확보하고, 채팅/신청/약속의 기존 양쪽 공유 잠금을 유지한다.

소비한 ticket은 원 성공을 재실행하지 않는다. 공고/채팅/후기의 최소 결과를 재조회하고, 원문을 포함한 성향/가입 응답은 현재 동일 DTO의 digest가 원 결과와 같을 때만 반환한다. 이후 변경을 과거 요청으로 덮어쓰지 않는다. 실행 ticket의 유효기간과 미정 최소 멱등 키 보관기간은 별개다. 최소 기록 자동 파기·만료 뒤 새 전송 허가를 추가하지 않는다.

SQL116 확대 회귀와 실제 양쪽 채팅 동시성 PASS, 포트9·DB client8·HTTP6·runtime5 모형 검증 PASS다. 실제 제품 HTTP/최종114~117 결합 full8-v9는 PASS이며 8개 작성 경로의 정상 저장·ticket 소비·같은 키 재조회 시 전체 rows/catalog/roles/ACL 불변을 확인했다. 응답 유실·애매한 채팅 확인·차단·입력 변조·다른 사용자·익명·실제 종료 세션·직접 REST 무티켓·취소 무시 검사기 기한도 검증했다. 원 source186개 테이블은 불변이고 새3개 컨테이너는 제어/EXEC 닫힘·STOP 보존이다. [실행 기록4.16](../../docs/collaboration/requests/minkyu/2026-10-09-backend-execution.md)을 따른다. 분류기 품질·소비자 확인 화면·실회원·운영 활성화 완료로 확대하지 않는다.

실제 REST 검증에서 ticket 조회의 `STABLE` 실행이 회원 상태 확인의 `SELECT FOR SHARE`와 충돌했다. 조회 함수를 `VOLATILE`로 수정하고 원 사용자 JWT의 전용 POST RPC로만 호출한다. 업무 효과는 최소 ticket 조회이며 생성·갱신·소비는 없다. GET/HEAD는 여전히 READ ONLY이므로 지원하지 않는다. [PostgREST 트랜잭션 공식 문서](https://docs.postgrest.org/en/stable/references/transactions.html)의 실행 규칙을 따른다. 과거 SQL116 동시성 영수증은 변경 전 해시에 한정하고 수정 뒤 통합 검증은 별도로 기록한다.
