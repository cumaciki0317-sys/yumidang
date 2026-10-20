<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **공급사·비용:** 포텐스닷 공급사 회신은 수신됐고 교육·프로토타입 조건과 보안 우려로 실서비스 대체 API를 권고했다. Gemini는 종현 테스트 프로젝트·월50,000원 사용중단 예산·합성3건 검증 상태이며 최종 청구 상한 보장/운영 연결은 별도다. 대표 유미 계정 전환은 회의 때 확인한다. 포텐스닷320만 기술 토큰과 Gemini 원화 예산을 혼합하지 않는다. 실회원 원문 전송 HOLD.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# J07 신고 캡처 조회 대기 마감 설계 — 2026-10-14

전체 **79%(22/28)** 유지. 실제 신고 캡처·Storage ACL·접근 감사·최종 종결90일 파기 연결은 여전히 검증 잔여다. 이번 보완은 그 연결에 필요한 기존 직원 캡처 조회 HTTP의 종료 경계이며 합성 검사를 실제 검증으로 대체하지 않는다. helpful 관련 두 사용자 선택은 답변 전 적용하지 않는다.

## 현재 소스와 재현

`service-api/report-operator-http.ts`는 요청 전체 신호에 upstreamTimeoutMs를 적용하지만 Storage GET/HEAD와 reader.read/cancel은 신호만 전달하거나 사후 검사한다. 비협조 대기가 계속되면 executor가 끝나지 않는다. 직원 Auth·본인 배정 확인 RPC는 기존 별도 클라이언트를 사용하며, Storage 단계는 직접 fetch한다.

현재 source SHA256=`a63a80d47334b8939430524610c5feedf000fa0298140d9770cc57982d74fb01`. 비공개 재현 `/private/tmp/yumidang-report-capture-deadline-reproduction-20261014.json`, SHA256=`a359500fc578e452ac25e4bd6545386187198dcfd6aecd2645ea5d503a346e49`.

공급사 대신 주입한 네 가지 응답에서 timeout50ms 뒤130ms 관찰 창에도 executor는 미완료였다. 첫 Storage GET 대기, 첫 reader.read 대기, 다 읽은 뒤 reader.cancel 대기, 최종 HEAD 대기 모두 해당 Storage 신호는 aborted였다. Auth/RPC도 합성 응답이며 실제 HTTP·Auth·DB·Storage·키 읽기는0이다. 관찰 창을 영구 장애나 실제 공급사 재현으로 표현하지 않는다.

## 후속 설계와 단독 편집

기존 `report-operator-http.ts`와 신규 `tests/functions/jonghyun/report-capture-deadline.test.mjs`만 구현 담당자가 actor=jonghyun으로 수정한다. Root는 이 설계·원 재현·최종 검사를 담당하고 다른 팀원은 읽기 검토만 한다. 세 경로의 소유권 검사를 통과했다. 공통 transport·Auth·RPC·마이그레이션·다른 신고 mutation·성호 화면·민규12개는 수정하지 않는다.

1. 기존 한 요청의 upstreamTimeoutMs 총 예산을 유지하며, 직접 Storage GET/HEAD와 본문 read 대기를 신호 거절과 경합시킨다. 단계마다 마감을 새로 시작하지 않는다. 취소/마감 시 기존 EXTERNAL_UNAVAILABLE로 종료하고 캡처 바이트를 응답하지 않는다. 늦은 응답은 본문 취소만 요청하며 새 RPC·HEAD·재전송을 하지 않는다.
2. reader/body의 취소는 best-effort로 요청하되 비협조 cancel promise가 HTTP 종료를 막지 않게 한다. 가능한 reader lock 해제와 timer/listener 정리를 수행한다. 실제 외부 처리/네트워크 종료를 보장했다고 주장하지 않는다. 늦게 해결되거나 실패한 promise가 unhandled rejection을 만들지 않게 한다.
3. 최초 직원 JWT·정확한 배정/객체 metadata·MIME/magic·최대5MiB·정확한 바이트 수·다 읽은 뒤 배정/객체 재확인·최종 HEAD 권한 검사·private/no-store 응답을 유지한다. 접근 감사 RPC와 Storage ACL을 우회하거나 일반 회원/서비스 키로 대체하지 않는다.
4. capture 전용 경계를 보완한다. review/adjudication/final-closure 등의 mutation을 자동 재실행하거나 결과 유실을 미전송으로 확정하지 않는다. caller abort reason·JWT·캡처 내용·공급사 오류는 공개 오류에 넣지 않는다.

## 필요한 검사

합성 Auth/RPC와 실제 executor 코드로 정상 GET→재확인→HEAD, 각 비협조 fetch/read/cancel/HEAD 마감, caller 취소, 총 예산, 늦은 결과/정리 거절, 후속 RPC/HEAD0 및 취소 전 공급사 호출0을 확인한다. 기존 직원 신고 HTTP 시험의 배정 철회·객체 변경·권한·크기/MIME·응답 비공개·mutation 인자 계약은 해당 소스의 회귀로 확인한다. 새 시험은 실제 Storage 검증이 아니며 기존 SQL/ACK PASS를 재작성하지 않는다.

민규 소유 두 실제 검증 도구는 원복/민규 담당 복귀 상태다. 새 실제 검증은 정식 지원과 정확한 새 대상/핀/생성·정리 증거가 필요하며 archive를 로딩하지 않는다. 승인된 종현 VM 외 다른 자원·실회원·공급사·운영은 실행하지 않는다. 후속 변경은 미커밋으로 보존한다.

## 구현·검사 결과

기존 executor의 capture 분기에만 강제 대기 마감과 총 monotonic deadline을 적용했다. 합성 Auth/metadata도 총 마감을 넘기면 이후 Storage를 시작하지 않는다. 늦은 fetch/reader 결과는 취소/lock 해제만 best-effort로 처리한다. 기존 직원 JWT·MIME/크기·metadata 재확인·HEAD·private/no-store와 noncapture mutation 인자/실행 경로를 유지한다.

Root Node 통합은 신규 캡처 책임10개·기존 report_operator_http37개·report_operator_client19개 합계 **66/66 PASS**다. 변경 모듈의 Deno typecheck는 no-config/no-remote/no-npm/no-lock으로 PASS였다. 팀 읽기 검토에서도 새 확정 결함을 발견하지 못했다. 실제 캡처/ACL/audit/파기 검증으로 확대하지 않는다.

최종 source SHA256=`71756bb1be993d2f27dee00de7b32a7e5018357d116233114b0a07483ab07df4`, 신규 시험 SHA256=`83b34c6c83da85a5cb4d3c36700b6291d160214cf5fb11a91290e0a2a978c02b`. 별도 [운영 담당 계정 보존 충돌](2026-10-14-j07-operator-retirement-conflict.md)은 제품 선택 전 SQL 변경 없이 남긴다. 전체 **79%(22/28)** 유지, actual·커밋·푸시0이다.
