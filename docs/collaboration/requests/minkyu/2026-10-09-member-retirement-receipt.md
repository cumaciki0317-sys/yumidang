# Auth 세션 회수 후 탈퇴 응답 유실 복구

작업자: `minkyu`. 전용 `minkyu-backend-eventlane` worktree에서 소유권을 확인했다. 운영·네이버·외부 공급사·메일·SMS·DELETE·ACK는 실행하지 않는다. 기존 SQL108/109 원본은 읽기만 하며 새 격리 대상과 합성 fixture만 사용한다.

## 확인한 원래 경계

캐시 GoTrue `v2.196.0`의 실제 합성 계정·비밀번호 API 세션에서 최초 `/auth/v1/user`는 200이었다. 최초 탈퇴 HTTP 응답 200 뒤 `auth.sessions`가 삭제되었고 동일 access JWT의 `/user`는 **403**이었다. 제품은 이를 HTTP `401 AUTH_REQUIRED`로 변환했다. 401을 실제 관측했다고 기록하지 않는다.

v7의 첫 검사에서 `/user`를 401로 기대한 assertion이 실패했다. 원 탈퇴를 다시 실행하지 않고 GET만 허용한 후속 관측에서 같은 withdrawal HTTP 재시도 401, 변경 RPC 0을 확인했다. 실패 자료와 별도 관측 영수증을 보존했다. source109는 181테이블과 public/private static catalog 544함수·ACL, 역할/멤버십 전후가 동일했다. 후속 clone 전체 비교도 동일했다. Auth 사용자는 남았고 세션 0·정리 task 1·ACK 0이었다. 이는 전체 Auth 삭제나 정리 완료 검증이 아니다.

근거: `/private/tmp/yumidang-retirement-auth-20261009-v7/observation-receipt.json`, SHA256 `51d7ceff386c39e843adcf131615fcbe1caca8c0ece510ed96450046559bcfc2`.

## 구현 경계

최신 foundation의 `user-client.ts`, `member-lifecycle-service.ts`, `service-api/handler.ts`, `service-api/index.ts`를 동일 복사한 뒤 수정했다. 기존 cleanup110의 내부 인증·공유 배정 조회/CAS/시간 및 수량 전달과 활성 회원의 기존 탈퇴 RPC를 보존한다.

일반 `Principal`을 복구하지 않는다. retirement 전용 factory는 실제 `/user`의 401·403 응답 출처를 확인한 `AUTH_REQUIRED`만 분리한다. bearer 누락·형식 오류·내부 키·부적합 Auth200 body·Auth 장애에는 영수증 fallback을 하지 않는다. 기존 retirement 기본 비활성도 유지한다.

분리한 포트는 원 bearer와 anon API key로 `get_my_retirement_receipt(uuid,text)` 하나에 HTTP GET만 전송한다. 일반 user client나 service-role client를 만들지 않는다. 같은 POST 본문에 있는 withdrawalId를 정규화하고 `SHA256('retirement:v1:'+withdrawalId)`를 계산한다. UID를 로컬 JWT에서 해석하거나 신뢰하지 않는다.

SQL117은 기존 `private.member_retirements`에 저장된 withdrawalId로부터 generated fingerprint를 유도한다. 최초 탈퇴 INSERT와 같은 원자 트랜잭션이며, 이전 영수증도 실제 기존 행에서만 유도한다. 새 성공 행이나 새 탈퇴를 만들지 않는다. 새 RPC는 STABLE·SECURITY DEFINER·빈 search_path이며 authenticated만 EXEC 가능하다. 반환은 withdrawalId·processing/completed·memberAccessRevoked뿐이다.

PostgREST가 원 JWT 서명을 검증한다. DB는 default-off private control의 정확한 expected issuer/audience와 claims의 role·비익명·iss/aud 존재 및 문자열 형식·exp 존재 및 실제 만료를 검사한다. 본인 UID와 정확한 withdrawal/fingerprint, 종료된 원 episode·활성 episode 부재·현재 네이버 binding 부재·프로필 tombstone을 확인한다. 대상 불일치·누락·상태 불일치는 모두 닫힌다.

## 검증 상태

관련 신규 단위 9개와 기존 HTTP·retirement·cleanup110·factory 검사 합계 **73 PASS**, Deno 검사 PASS다. 모의 응답 검사는 실제 JWT 검증으로 설명하지 않는다.

v8/v9 격리 복제본에서 SQL117 실제 apply와 SQL 권한·기본 닫힘·generated fingerprint 계약 검사는 PASS다. v8은 최초 탈퇴와 default-off 복구 거절까지 통과한 뒤 음성 fixture 생성 중 JWT에 iss가 없다는 것을 확인했다. `API_EXTERNAL_URL`만으로 이 캐시 GoTrue가 issuer claim을 넣지 않았다. issuer를 self-claim에서 선택하지 않으며 `GOTRUE_JWT_ISSUER`를 신뢰한 로컬 Auth URL로 명시해야 한다. v9는 발급 전 readiness GET의 Docker timeout에서 멈췄다. 실패 환경·로그·백업은 보존하고 원 탈퇴나 로그인 intent를 재전송하지 않는다.

새 v10에서 명시 issuer, `PGRST_JWT_AUD=authenticated`, SQL의 정확한 issuer/audience control을 사용한 **실제 복구 PASS**를 확인했다. default-off 때 같은 재시도는 HTTP401이며, owner가 정확한 gate를 구성한 뒤 같은 withdrawal은 HTTP200 processing으로 복구했다. 이 후속 경로는 retirement RPC0·receipt GET만 실행했고 clone의 전체 행/catalog/roles 전후가 동일했다.

실제 GET 음성 12개(expired, wrong signature, wrong/missing issuer·audience·expiry, wrong sub, anonymous, service role, wrong withdrawal, wrong fingerprint)는 모두401·403이었다. HTTP의 wrong signature·expired·wrong issuer/audience/sub와 bearer 누락도401이었다. owner가 원 episode의 종료 시각을 잠깐 변형한 current-state 검사도403이었으며 원값 복원 뒤 전체 clone hash가 동일했다. 원 탈퇴·DELETE·ACK를 재전송하지 않았다.

추가로 같은 v10의 Auth/REST를 중지한 채 DB만 잠깐 시작한 실제 장애 관측에서 HTTP503 EXTERNAL_UNAVAILABLE, Auth GET1, receipt GET0, retirement RPC0을 확인했다. source와 clone 전체가 동일했다. 모든 새 컨테이너는 중지했고 cleanup·receipt 두 gate는 닫혔다.

근거는 `/private/tmp/yumidang-retirement-auth-20261009-v10/receipt.json`, `receipt-current-state-negative.json`, `auth503-receipt.json`이다. SQL117은 source109에 적용한 격리 검증이며 SQL110~116을 함께 적용한 전체 조립 검증으로 확대하지 않는다. source109의181테이블 불변을 최종 파일로 재확인했다.

## 운영 준비 조건과 미검증 범위

운영 활성화 0. 기존 retirement와 새 receipt control은 기본 닫힘이다. 운영 Auth의 실제 issuer/audience와 PostgREST 서명·audience 구성을 확인하고 정확한 DB control을 소유자가 구성해야 한다. 이 로컬 issuer나 임시 URL을 운영 값으로 사용하지 않는다.

전체 Auth 사용자 DELETE, Storage 삭제, ACK 유실·UNKNOWN 재전송, 실제 네이버 로그인, 실회원·운영 배포는 이 작업에서 검증하지 않는다. 서명 불량·만료 토큰은 영수증을 통해 인증 세션으로 복귀하지 않으며 새 탈퇴·삭제를 실행하지 않는다.

검증 영수증 SHA256: `receipt.json` `8b96a161a22dd32deaee3dd8efb7e94efd1fa0eee1983626ad1f004304dc1876`, `receipt-current-state-negative.json` `6b17ca1382fb7e08490de07b241a8316a52acb22080cef1f297b1be314134c04`, `auth503-receipt.json` `02f4a703c05530cab13428a75e2d14494ee6902ea024cc6c2d3250a41b338320`
