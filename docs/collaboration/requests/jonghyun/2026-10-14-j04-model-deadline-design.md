<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **공급사·비용:** 포텐스닷 공급사 회신은 수신됐고 교육·프로토타입 조건과 보안 우려로 실서비스 대체 API를 권고했다. Gemini는 종현 테스트 프로젝트·월50,000원 사용중단 예산·합성3건 검증 상태이며 최종 청구 상한 보장/운영 연결은 별도다. 대표 유미 계정 전환은 회의 때 확인한다. 포텐스닷320만 기술 토큰과 Gemini 원화 예산을 혼합하지 않는다. 실회원 원문 전송 HOLD.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미다. 일반 신고 처리와 해당 신고의 허용된 제출 증거 처리는 조유미 부재 시 종현이 대체한다. 이 지정은 고객지원·AI 비용·서버 운영의 대체 권한으로 확대하지 않는다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# J04·J05 모델 대기 마감과 원 예약 보존 설계 — 2026-10-14

전체 **79%(22/28)** 유지. 실제 모델·usage 단위·출력 강제·보관/학습/삭제/공동계정 근거와 실제 연결은 여전히 목표 잔여다. 이번 작업을 전체 공급사 연결 완료로 축소/대체하지 않는다. 공급사 신규 자료가 없다는 답과 **미전송 확인 때만 회원 요청 전체 자동1회** 결정은 다시 묻지 않는다.

## 현재 근거와 직접 재현

현재 adapter는 timer가 controller.abort()만 하고 transport/response.json 대기를 강제로 끝내지 않는다. JSON 응답 이후에도 마감/취소를 검사하지 않는다. 실제 source에 네트워크 없는 합성 FetchLike·Response와 실제 account-pool 코드를 연결해 다음을 재현했다.

| 조건 | 현재 관찰 |
|---|---|
| timeout5ms·fetch가 취소 신호를 무시 | 신호 aborted지만35ms 관찰 창에서 generate 미완료 |
| timeout5ms·합성 fetch15ms 뒤 응답 | aborted인데 정상 결과·usage10/3 반환 |
| timeout5ms·합성 JSON15ms 뒤 완료 | aborted인데 정상 결과·usage10/3 반환 |
| 같은 지연 adapter를 pool에 주입 | 원 계정a·fetch1·원 예약 사용량 정산1 뒤 늦은 성공 반환 |

원 source SHA256 `482206d90b635dbb9cd3ae3fc1ca4d6050faad0a034eefcde0bb79723fc67e22`. 비공개 증거 `/private/tmp/yumidang-potens-deadline-reproduction-20261014.json`, 증거 SHA256 `e27037cc7becb5ce7281931e3edf8742479e3527dfcfe6628d6ad97e4c155fb8`. 실제 공급사 API·키 읽기·DB·Auth·VM은0이다.35ms 관찰은 영구 미완료나 실제 공급사 장애 증거가 아니다.

단일 router와 pool은 이미 확인된 사용량만 원 예약에 정산하고, 없거나 잘못된 값은 UNKNOWN으로 보존한다. 전송 전 계정 예산 거절만 다음 계정으로 이동하고, 전송 후 오류/응답 유실은 추가 전송·계정 전환0이다. runtime의 승인/비용/법적 근거·출력 인코더 조건과 entrypoint의 승인된 privacy 포트 조건도 유지된다. 준비 작업을 새 ready/실회원 허용으로 해석하지 않는다.

## 이번 후속 구현 설계

기존 `potens-adapter.ts`의 대기 마감만 보완한다. event_design은 이 소스와 신규 `tests/ai/jonghyun/potens-deadline.test.mjs` 두 파일만 actor=jonghyun으로 단독 수정한다. Root는 문서·재현·최종 검사를 담당한다. 기존 router/pool/RPC/SQL·입출력 필드·원장 일자·민규12개·성호 화면은 수정하지 않는다. 편집 전 exact 소유권 확인을 한다.

1. 기존 upstreamTimeoutMs 예산으로 transport와 response.json 대기 모두를 별도 거절 promise와 경합한다. 경과 시 TIMEOUT, 호출자 취소 시 CANCELLED이며 늦은 성공을 반환하지 않는다. 늦은 응답 본문은 읽지 않고 취소를 요청한다. 비협조 transport의 실제 공급사 처리 종료를 보장한다는 주장은 하지 않는다.
2. 공급사 함수 진입 직전에만 dispatchState를 sent로 바꾼다. 동기 예외·자체 not_sent 주장도 진입 뒤에는 sent다. 진입 전 마감/취소는 실제 진입0이라는 코드 경계로 not_sent를 확인한다. 파일 부재나 HTTP 오류를 미전송으로 바꾸지 않는다.
3. 마감 전에 원 응답에서 확인한 valid usage는 기존 ModelError 내부 metadata로 보존한다. 마감 이후의 늦은 JSON은 새 소비/정산 근거로 받아들이지 않는다. 확인된 사용량이 없으면 sent 오류·usage=null이다. 예약 환불·늦은 자동 정산·추가 RPC·새 청구 단위 추정은 하지 않는다.
4. timer·listener·응답 본문의 취소 요청을 정리한다. 원문·키·공급사 오류·caller abort reason은 오류/로그에 넣지 않는다. ModelError의 비열거·불변 metadata 계약은 유지한다.
5. 실제 supplier wire body와 outputLimit·usageFields의 현재 계약은 유지한다. 미확인 응답 MIME·새 출력/본문 한도·JSON 필드명·모델/과금·공동 사용 정책을 이번에 추정하지 않는다. J07 post-record 평가 기준 두 질문과 관계없는 보완만 한다.

## 검증 범위

신규 책임 시험은 사전 취소/인코더 중 취소의 fetch0·not_sent, 전송 뒤 비협조 fetch/JSON timeout·late success0, 원 usage가 없는 실패의 null/UNKNOWN, 이미 확인된 형식 실패 usage 보존, timer/listener/늦은 body 정리와 원문 비노출을 확인한다.

단일 router와 pool을 실제 코드로 연결해 같은 원 예약·원 계정/일자·정산1·추가 fetch/계정전환0을 확인한다. 후기 scope도 탐색 자동 재시도를 사용하지 않는 기존 경계를 유지한다. 기존 adapter/router/pool/runtime 책임 시험에서 source를 소비하는 부분을 함께 확인하되 기존 AI23 원장 증거와257개 합성검증을 다시 작성하거나 이번 새 소스 증거로 승격하지 않는다. 모든 공급사/RPC는 합성 포트이며 실제 호출은0이다.

새 deadline이 먼저 끝난 뒤 도착한 응답은 UNKNOWN을 뒤늦게 자동 환불/정산하는 근거가 아니다. 실제 원장 해결은 기존 별도 확인 절차를 따른다. 같은 회원 요청의 확정 not_sent 일시 실패만 자동1회라는 기준과 전송 뒤0회 기준은 바꾸지 않는다.

## 남은 전체 조건

공식 모델·usage/단위·출력 강제와 보관/삭제/공동계정 근거, 승인된 privacy/output 포트의 실제 주입과 실측을 확보한 뒤 공급사 연결을 검증한다. 실회원 HOLD·운영 적용·실제 공급사 호출 제외는 유지한다. 현재 두 민규 도구는 원복/민규 담당 복귀가 끝났으므로 archive 로딩으로 새 실제 검증을 우회하지 않는다.

## 후속 구현·검사 결과

설계대로 기존 adapter 한 파일을 보완했다. 강제 대기 마감·전송 진입 경계·확인 사용량 보존·늦은 응답 본문 취소를 적용했으며 router/pool/RPC/SQL·공급사 wire·실제 승인 조건은 변경하지 않았다. 신규 책임 시험은 adapter9개와 실제 runtime 코드의 단일/다중 계정 및 회원/후기 조합4개다. 공급사와 RPC는 합성 포트이며 실제 공급사·키 읽기·DB·Auth·VM 실행은0이다.

- 첫 Node 통합: 신규13개와 기존 adapter11·router11·pool18·runtime7개, 합계60개 중58 PASS·후기 fixture2 FAIL. 기존 후기 예약의 최소3개 sourceReviewIds 조건에 신규 fixture가2개를 넣어 제한시간 검사 전에 거절됐다. 제품 source나 TIMEOUT/UNKNOWN 기대값을 완화하지 않았다.
- fixture를 서로 다른 합성 UUID3개로 교정하고 원 회원/후기 예약 인자 검사를 보완했다. 변경된 신규 파일13개만 재검사해13/13 PASS. 기존47개 PASS와 함께 현재 책임60개를 확인했다. 처음 실패와 재검사 수를 더해73개 검증으로 표현하지 않는다.
- 전송 후 TIMEOUT은 sent/null이며 원 예약의 usage_unknown 처리1회·원 계정/일자 유지·추가 전송/계정 전환0을 확인했다. 늦은 JSON 도착 뒤 usage 필드 접근0·추가 정산0이다. 사전/인코더 중 취소는 not_sent·공급사 함수 진입0이다. 이미 마감 전에 확인한 사용량은 형식 실패나 이후 취소에서도 유지된다.
- Deno typecheck PASS: `--no-config --no-remote --no-npm --no-lock`으로 변경 adapter만 검사했다. 원격 모듈·실제 환경 설정을 읽지 않았다. scoped 소유권3개, diff 공백 검사, 문서/소스의 다른 언어 문자 검사도 통과했다.
- 최종 adapter SHA256=`79dd179425aef939b0385fe1430417e6f38cf16fbf88d90730ef5467a8449f13`, 신규 시험 SHA256=`c2be73778adb328f5d881838dc3a68f563c53a91a937d783b5ba9cae3191567d`.

이번 후속14개 변경은 종현 전용 branch `jonghyun/backend-parallel-20261014`의 미커밋 상태로 보존한다. 기존 한시 도구 원복·민규 담당 복귀는 유지한다. 원본 공유 clone은 clean을 확인했고 커밋·푸시·운영 배포는0이다. 합성 검사를 실제 공급사 검증이나 전체 완료로 계산하지 않으며 전체 **79%(22/28)**를 유지한다.
