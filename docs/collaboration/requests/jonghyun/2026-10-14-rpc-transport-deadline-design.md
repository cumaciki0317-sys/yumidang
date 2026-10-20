<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **AI 선택 동의:** AI 탐색은 첫 사용 동의·거절 시 일반 검색 유지. 후기 AI는 가입 시 열람/내 프로필 생성·노출/작성 후기 활용의 세 선택 항목·기본 미선택이며 전체 동의 편의 기능과 독립 철회를 제공한다. 기존 테스트 계정 간주와 실회원 동의 증거를 구분한다.
> **공급사·비용:** 포텐스닷 공급사 회신은 수신됐고 교육·프로토타입 조건과 보안 우려로 실서비스 대체 API를 권고했다. Gemini는 종현 테스트 프로젝트·월50,000원 사용중단 예산·합성3건 검증 상태이며 최종 청구 상한 보장/운영 연결은 별도다. 대표 유미 계정 전환은 회의 때 확인한다. 포텐스닷320만 기술 토큰과 Gemini 원화 예산을 혼합하지 않는다. 실회원 원문 전송 HOLD.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# 공통 DB 전송의 취소·총 대기 마감 설계 — 2026-10-14

전체 **79%(22/28)** 유지. J01~J09가 소비하는 공통 JSON RPC의 실제 연결 종료 공백을 보완한다. 실제 DB/Auth/Storage·공급사 실행은0이며 현재 담당/정책 선택/실회원 HOLD/민규12개/성호 화면/운영 조건을 유지한다.

## 현재 source와 재현

`db/transport.ts`의 fetchJson은 호출자 init.signal을 내부 controller.signal로 덮어쓰고 abort만 요청한다. fetch/json이 신호를 무시하면 미완료이거나 마감 이후 응답을 성공으로 반환한다. Root의 합성 재현은 사전 취소인데 fetch1·성공, timeout5ms/미협조fetch의25ms 관찰 미완료,15ms 뒤 fetch/JSON 응답의 늦은 성공을 확인했다. 실제 호출0이다.

source SHA256=`5a966d9afdeff612769c97607baa2f9d51788dffe823ff038abd7e55a08af88c`. 비공개 재현 `/private/tmp/yumidang-rpc-transport-deadline-reproduction-20261014.json`, SHA256=`72151b86b33b1dea110108400d94280ab64ea03b77314825d19a803559d3f7e7`. 짧은 합성 관찰을 실제 DB 장애나 실행 미적용 증거로 표현하지 않는다.

## 구현 설계·단독 담당

Root가 기존 `backend/supabase/functions/_shared/db/transport.ts`, 신규 `tests/functions/jonghyun/rpc-transport-deadline.test.mjs`, 이 문서만 actor=jonghyun으로 수정한다. exact 소유권3개 통과. 과거 source 상단 민규 주석보다 최신 ownership의 종현 배정이 기준이다. ai_design은 UNKNOWN/원 예약 소비, event_design은 책임 시험 영향 범위를 읽기 검토했으며 파일 쓰기는0이다.

1. 호출자 신호와 내부 timeout을 결합하고 사전 취소에서 transport 진입0으로 끝낸다. 같은 timeoutMs 예산의 monotonic deadline으로 fetch와 JSON 대기 모두를 거절 promise와 경합시킨다. 단계별 새 마감을 시작하지 않으며 늦은 성공을 반환하지 않는다.
2. 기존 EXTERNAL_UNAVAILABLE·원문 비노출만 반환한다. DB 함수 진입/commit 완료를 알 수 없으므로 새 not_sent·환불·실패 확정 metadata를 만들지 않는다. public retryable 표시는 mutation 자동 재실행 허가가 아니다. createRpcTransport의 원 함수1회·allowlist·exact 인자/API key/token·HTTP/SQLSTATE 매핑은 유지한다.
3. 정상204는 JSON을 읽지 않고 null이며 status/body 반환 계약은 유지한다. response JSON 필드·MIME·본문 상한·RPC 이름을 새로 추정하지 않는다. 유효한 대기 시간과 기존 원문 삭제 계약을 유지한다.
4. timer/listener는 종료 시 제거한다. 늦은 response는 body cancel만 best-effort로 요청하고 cancel Promise를 기다려 반환을 막지 않는다. 늦은 JSON/오류는 새 상태 변경·후속 RPC를 실행하지 않는다. 비협조 외부 작업의 실제 종료 보장으로 표현하지 않는다.

## 영향 검증

새 책임 시험은 pre/caller abort·비협조fetch/JSON·총 예산·늦은 body/cancel 거절·204·오류 비노출를 확인한다. 실제 createRpcTransport를 실제 configured runtime의 budgetDb로 연결하고 transport 응답만 합성해 단일/다중 계정의 예약 응답 유실→공급사0·새 예약/계정 전환0, 정산 응답 유실→원 예약/계정/일자·공급사1·추가 정산0을 확인한다. 서버 상태 모형의 적용 여부를 실제 DB UNKNOWN 보존으로 표현하지 않는다.

공통 transport를 실제 소비하는 Auth/내부RPC/네이버 세션·원 탈퇴 영수증/신고 직원·queue/cleanup budget·ACK/완료/GET-only 소비 회귀와 앞선 J07/J09 책임 검사를 영향 범위에서 실행한다. 원 DbRpc 전체를 합성한 기존 AI 검사만으로 공통 전송 완료를 주장하지 않는다. 반복257 또는 기존 실제 SQL/공급사 PASS를 재작성하지 않는다. 변경 source Deno typecheck·소유권·diff·언어 검사와 팀 읽기 검토를 한다.

대기 중인 helpful2선택과 운영 계정 탈퇴 선택을 임의 확정하지 않는다. 민규 실제 검증 도구는 원복 상태이며 새 actual은 정식 지원이 필요하다. 후속 변경은 미커밋으로 보존하고 커밋/푸시/운영 적용을 실행하지 않는다.

회귀 중 기존 `tests/functions/minkyu/member_cleanup_budget.test.ts`의 가상 예산 만료 사례는 RPC1000ms에10000ms를 경과시켜 새 공통 마감이 먼저 닫혔다. 예산 만료의 STATE_CONFLICT 계약을 독립 검사하기 위해 해당 사례의 합성 transport 상한만20000ms로 지정한다. DB budget10000ms/경과10000ms·기대 오류·다른 fixture와 제품 timeout은 그대로다. 파일은 최신 소유권에서 종현이며 exact 검사를 통과해 Root 단독 수정 목록에 추가한다. transport EXTERNAL을 STATE로 바꾸거나 실제 대기를 늘려 시험을 맞추지 않는다.

## 구현·검사 결과

Root가 공통 fetchJson의 신호 결합·전송 전 중단·fetch/JSON 총 마감·늦은 본문 취소와 timer/listener 정리를 구현했다. 기존 RPC/JSON ABI·204·허용 목록·HTTP/SQLSTATE 분류·고정 공개 오류는 유지했고 새 not_sent나 환불 표식은 만들지 않았다. 팀 읽기 검토에서도 새 확정 결함은 발견하지 못했다.

- 신규11개 첫 검사:9 PASS·2 pool fixture FAIL. 기존 계정 로더가 허용하는 모델 선택값 대신 임의 synthetic-model을 넣어 조립이 disabled였다. 합성 설정에 기존 claude-5-sonnet 선택값을 넣었고 제품 selector/승인 조건을 완화하지 않았다. 공급사 모델의 실제 제공 증거는 아니다.
- fixture 교정 후 pool2개·영향받은 단일2개를 확인했다. runtime 오류 단언을 MODEL_UNAVAILABLE로 보완해 관찰용 timeout만으로 통과하지 않게 하고 해당4개만 재검사해4/4 PASS였다. 변경 없는 직접 transport7개와 함께 현재 신규 책임11개를 확인했다. 중간/재실행 개수를 더하지 않는다.
- 소비 회귀17파일 총206개:205 PASS·위 budget 시계 fixture1 FAIL. fixture만 교정해 해당1개 재검사1/1 PASS였다. 변경 없는205개와 함께 현재206책임을 확인했다. 실패한 첫 통합 결과를 단일206/206 실행으로 덮어쓰지 않는다. 비공개 첫 로그 `/private/tmp/yumidang-rpc-transport-consumer-check-20261014.log`, SHA256=`c32f7aaccf3742d623287a698656687010bf4ed931429081a7b0a2df7c65c605`.
- Deno typecheck PASS: 변경 transport만 no-config/no-remote/no-npm/no-lock으로 검사했다. 원격 모듈·실제 자격증명·환경을 읽지 않았다.

새 조립 시험은 실제 configured runtime→실제 createRpcTransport와 합성 fetch를 연결한다. 예약 응답 유실은 원 RPC1·공급사0, 정산 응답 유실은 원 RPC2·공급사1·원 예약/계정/일자와 확인된 사용량을 유지한다. 늦은 응답 뒤 추가 RPC/공급사 호출0이다. JS durable 효과는 상태 모형이며 DB 원자성·실제 UNKNOWN·rollback 증거가 아니다. 정산 유실은 DB에 이미 usage_reported가 반영됐을 가능성도 남기며 재정산/환불을 하지 않는다.

최종 transport SHA256=`ecc47220b1f0c094c68139e882f6fed662c47452b104fdc616b7f26cabd07733`, 신규 시험=`7a9fa4a7f41d2b229630155592e69f342bf36c03a14a42ad09cb17e0c83c0cf5`, 기존 budget 시험=`46218c56c310052b8be93198848ba1da74070f35d94a5c640f0a6feecc6d62ba`.

공통 source 변경으로 이전 실제 연결 영수증의 source closure와 현재 closure는 달라졌다. 기존 J01/요약/피드백/읽음/탈퇴 실제 PASS는 당시 고정 소스의 결과로 보존하고 현재 공통 transport 실제 PASS로 확대하지 않는다. 새 actual에는 민규 도구 정식 지원·새 source/SQL 핀·생성/정리 증거가 필요하다. 전체 **79%(22/28)** 유지. 후속26개는 종현 전용 branch의 미커밋 상태이며 원본 공유 clone은 clean이다. actual·커밋·푸시·운영0, 질문3개 답변 전 해당 정책 구현0이다.
