# 종현 백엔드100 재개 — 요청 진단 설계·검증

## 기준과 담당

- 최신 [백엔드100 인계](../minkyu/2026-10-10-jonghyun-backend100-handoff.md), [정책](../../../../정책.md), [소유권](../../../../backend/ownership.json)을 따른다.
- 관리 진행률은 **79%(22/28)**, 핵심9/10·추가5/6·독립5/5·운영3/7을 유지한다. 이 독립 보완으로 기존 완료 항목을 추가 집계하지 않는다.
- 기존 민규 원본과 오래된 종현 clone을 수정하지 않는다. 기준 `ba6038a`의 별도 clone, `jonghyun/backend100`, actor=jonghyun, 기존 `.githooks`를 사용한다.
- 종현이 이관받은 공통 백엔드만 수정한다. 성호 화면, 소유권 정책·hook·최상위 문서는 수정하지 않는다.

## 구현 전 설계

빈 `observability/logger.ts`·`redaction.ts`를 원문 없는 요청 완료 진단으로 채우고 `service-api`에 선택 포트로 연결한다. 기존 RPC·응답·인증·멱등·승인 guard는 유지한다.

1. 허용 필드는 서버 UUIDv4 `requestId`, 응답 HTTP 상태에 따른 고정 `resultCode`, 숫자 `status`, 단조 시계 `durationMs` 네 개다. 실제 도메인 결과 판정이나 외부 오류 코드 기록으로 확대하지 않는다.
2. 추가 필드·symbol·getter·toJSON·Error·사용자 정의 prototype을 거절한다. 원문을 읽어 정규식으로 가리는 대신 검사한 primitive만 새 frozen 객체로 복사한다. 요청/응답 본문·헤더·URL·회원 ID·JWT·SQL·외부 응답을 전달하지 않는다.
3. 기존 dispatch 바깥 wrapper에서 서버 context를 하나 만들고 응답이 정해진 뒤 한 번만 기록한다. 조기 반환과 preflight도 같은 경계를 통과한다. 응답 본문을 추가로 읽지 않는다.
4. logger/clock/sink 실패는 응답을 바꾸지 않는다. sink는 선택 주입하며 지연·거절·throw를 HTTP 결과와 분리하고 재시도하지 않는다. 기본 console·외부 저장·DB 쓰기는 없다.
5. factory에서 명시적으로 logger를 주입할 수 있지만 기본 entrypoint는 비활성을 유지한다. 진단30일/보안90일의 실제 보관·파기·접근 권한은 호스트 검증 후 별도로 연결한다.

## 검증 계획

- 합성 sink로 정상/오류/OPTIONS/조기 반환의 정확한 한 번 기록 및 응답 불변을 검사한다.
- 추가 원문·비밀 필드, getter/toJSON, symbol, 잘못된 ID·코드·시계, sink 예외/응답 지연을 검사한다.
- 기존 HTTP·서비스 API 회귀와 Deno 정적 검사를 실행한다. 두 하네스 읽기 검토자의 정책/복구 리뷰를 받는다.
- DB·Docker·외부 공급사·실회원·운영 배포는 실행하지 않는다. 기존 summary14 0/14, AI22/23 NOT_RUN, 자정·최종 복원·회원 HOLD는 유지한다.

## 원격 충돌과 공유 조건

인계문 clone URL은 `github.com/jjackbb/yumidang`인데 현재 원본 origin은 `github.com/cumaciki0317-sys/yumidang.git`이다. 별도 clone의 origin은 로컬 원본이며 원격을 임의 변경하지 않는다. 문서와 실제 원격이 충돌하므로 종현 브랜치에 정상 hook 커밋까지 준비하고 **푸시는 대상 확인 전 보류**한다. 민규/main 브랜치에는 커밋·푸시하지 않는다.

## 결과

- `logger.ts`·`redaction.ts`의 골격을 strict allowlist/frozen record/고정 실패 코드로 구현했다. `handler.ts`의 기존 dispatch에 같은 서버 context를 전달하고 응답 생성 뒤 한 번 기록한다. `index.ts`에서 선택 포트를 전달하며 기본 entrypoint는 sink를 설치하지 않는다.
- HTTP 상태 기반 분류다. 자체 adapter의 내부 오류 코드를 추정하거나 응답 본문을 읽지 않는다. `PREFLIGHT`는 OPTIONS204에만 사용한다. duration은 handler 응답 생성까지이며 body 전송 완료나 공급사 완료를 의미하지 않는다.
- `node --test tests/functions/jonghyun/request-logging.test.ts tests/functions/minkyu/service_api.test.ts tests/functions/minkyu/http.test.ts`: **60/60 PASS**, skip0. 합성 HTTP/RPC/sink 검사이며 실제 DB·운영 성공이 아니다.
- 초기59개 실행 중 신규 테스트1개는 금지된 query가 있는 `/me`를200으로 가정해 FAIL이었다. 기존 서비스가400으로 거절하는 계약에 맞춰 정상 요청과 query 거절 검사를 분리했다. 구현 정책을 완화하지 않았다.
- 독립 리뷰에서 getter 거절 검사의 sink 예외가 logger catch에 삼켜질 수 있음을 확인했다. sink 호출0·rejected 결과를 직접 단언하도록 보강하고 변경된 신규14개를 다시 실행해 **14/14 PASS**였다. 이를60개와 합산해74개의 서로 다른 검사로 안내하지 않는다.
- `deno task check:service`: **PASS** (`--no-remote`). `git diff --check`: **PASS**.
- 하네스 기능/권한·정책/복구 읽기 검토자2명은 확정 결함 없음으로 회신했다. 진단 보관·파기·운영 관측은 이번에 검증하지 않았다. 실행 기록4.74에서 일반 로그 골격을 새 완료 요건으로 만들지 않도록 했으므로 관리 진행률79%(22/28)를 유지한다.
- 원본 민규 저장소는 `minkyu/foundation-harness`, `ba6038a`, clean을 재확인했다. 원본 actor/hook/index·오래된 종현 clone을 변경하지 않았다.
- 의존성 설치·DB/Docker·외부 호출·실회원·운영 배포·푸시는0회다. 원격 일치는 아직 확인하지 않았으며 원격 충돌 해소 전 공유하지 않는다.

## 남은 범위와 확인 질문

최신 인계의 summary14 실제0/14, AI22/23 실제 NOT_RUN, 실제 자정 검증, 최종 백업/복원 및 Storage39개 바이트 누락, 실회원 HOLD·공급사·운영 조건을 유지한다. 새 진단 모듈은 이 미완료를 닫지 않는다. 성호 탈퇴 화면은 기존 요청의 담당 경계를 유지한다.

원격 대상은 문서와 실제 origin이 충돌하므로 확인이 필요하다. 종현 브랜치 `jonghyun/backend100`의 대상 선택:

1. **추천:** 현재 원본 origin `cumaciki0317-sys/yumidang`에 종현 브랜치만 공유한다.
2. 인계문 URL `jjackbb/yumidang`을 사용한다.
3. 로컬 종현 커밋만 유지하고 원격 공유는 계속 보류한다.
4. 기타: 정확한 저장소·본인 브랜치를 직접 지정한다.

추천은 현재 실제 설정을 보존하는 방향이며 저장소 이전 승인이나 원격 동일성 증거를 대신하지 않는다. 답변 전 origin 변경·푸시·main/민규 브랜치 변경은 하지 않는다.
