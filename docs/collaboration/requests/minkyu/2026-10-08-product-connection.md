# 민규·종현 제품 연결: 구현·검증·대기

기준 HEAD는 `ac06f86`이다. 최종 준비 검사는 검토107·기준99·후속8 READY다. 기존 8/10 · 추가 5/6 · 독립 보완 5/5를 유지한다. 운영 DB·Railway·외부 AI·모바일·커밋·푸시는 변경하지 않았다. 기존 SQL100~103은 보존했다.

## 민규 구현

- SQL104: SQL101 prepared/unknown/observed_response와 SQL102 external_pending을 함께 확인하는 복구 차단, 확정 종결+30일 다음 유지관리 일정. observed_response만으로 완료를 인정하지 않는다.
- SQL105: helpful 다음 만료 일정, 전역 토큰·요청 키·입력 fingerprint·삭제·저장 결과의 단일 트랜잭션. 같은 요청 조회는 저장 결과를 반환하고 다른 입력은 충돌한다. 기존 body `{limit}`를 유지하고 scoped 유지관리 배정은 1~20이다. 실행별 유지관리 배정은 큐20과 별개다. 기존 비범위 purge의 service_role 직접 실행은 닫았다.
- SQL106: 메시지별 읽음과 새 `unread_message_count`. 기존 watermark 및 `unread_count`는 보존하며 과거 watermark를 개별 읽음으로 변환하지 않는다.
- SQL107: 회원 Storage 삭제 전 영속 dispatch. task 잠금 뒤와 INSERT 뒤에 현재 점유를 재검사한다. 실제 DB에서 INSERT를 지연시켜 task 점유가 만료되면 dispatch 전체가 rollback하는 검사를 통과했다. dispatch 존재 작업은 만료 후에도 자동 재점유하지 않는다. ACK를 포함한 수동 확정 복구와 최소키 삭제 정책은 운영 활성화 전 대기다.
- 공통 DB 포트는 자기 토큰 일정, 복구 조회, scoped helpful 삭제를 제공한다. 회원 정리는 trusted limit·signal·마감과 beginDelete를 받으며 영속 최초 dispatch 없이 DELETE하지 않는다.

## 실제 검증 범위

`tests/database/minkyu/product_connection_v2.sql`은 실제 격리 DB에서 읽음 원자성·과거 미노출 보존·권한·dispatch 최초/중복·만료 후 재점유 제외를 rollback으로 검증했다.

`tests/integration/minkyu/product_connection_http.ts`는 실제 service-api handler와 종현 AI handler, 실제 PostgREST 및 TLS DB를 사용한다. 새 합성 회원의 서명 JWT를 DB가 검증했다. 실제 네이버 OAuth·전체 Auth 진입점 검증은 아니다. 메시지 읽음 동시 6회·잘못된 batch 전체 거절·새 메시지 도착·기존 watermark 호환이 통과했다. AI 추가 질문 결과의 실제 receipt, helpful 동시 6회 동일 결과·타인 차단·90일 이후 삭제, DB commit 뒤 응답 유실과 저장 결과 조회·동일 키 복구가 통과했다. 외부 모델 요청은 0회다. 회원 정리 HTTP·전용 RPC 회귀10개와 마감·영속 dispatch 장애9개도 통과했다. 정상 검색 답변·모델 호출·실제 주기 실행 전체를 검증했다고 주장하지 않는다.

복원 검증은 `tests/integration/minkyu/product_connection_restore_local.py`에서 전체 SQL107 DB를 별도 컨테이너로 복원하고 삭제 재적용 및 읽음·dispatch·영속 최소 기록 보존을 검사한다. 전체 복원, 삭제 재적용, 개별 읽음·기존 watermark·회원 dispatch·legacy intent hash 보존, 최소 fingerprint·external_pending 보존이 실제 실행 PASS다. cron 자동 실행은 끄고 앱 EXEC 차단을 확인했다. 비밀값·JWT·원문은 저장소 증빙에 포함하지 않는다.

## 종현 수정 요청 — 제품 활성화 보류

1. **큐20 단위:** 같은 전역 실행의 고유 큐 작업 ID 최대20이다. 첨부·metadata·ACK·완료 기록은 추가 차감하지 않는다. 현재 reserveItem의 첨부별 차감과 hasItemCapacity 조건을 고유 ID 예약으로 바꿔야 한다. 회원·행사 별도 저장소가 큐 원장에 연결됐다고 표시하지 않는다.
2. **별도 유지관리:** 현재 scheduler는 helpful processedItems를 queue remaining20에서 차감한다. helpful/terminal은 별도 배정 한도를 사용해야 하며 큐 잔여0이어도 필요한 유지관리 일정을 처리해야 한다. 민규 purgeFeedback의 processedItems는 예약 배정량이며 큐 작업 수가 아니다.
3. **helpful 요청 식별자:** `/internal/ai-feedback-maintenance`는 `{limit}`와 내부 인증, `x-worker-run-token`, `x-worker-request-id`를 요구한다. 현 종현 소비자는 token만 보내므로 거절된다. 최초 전송 전에 영속 요청 키를 만들고 응답 유실은 저장 결과 조회로 복구한다. 임의 새 키 재전송은 금지다.
4. **영속 cycle 확정:** SQL101 observed_response를 단독 성공 근거로 쓰지 않는다. 실제 DB 확정 결과나 검증된 ACK와 연결한 reconciliation이 필요하다. 현재 legacy 미확정 기록은 보수적으로 pending을 유지한다. 민규 어댑터가 confirm을 가짜 성공으로 제공하지 않는다.
5. **메시지별 읽음:** `POST /conversations/{requestId}/read/messages`, 회원 JWT, `{messageIds: UUID[]}` 고유 1~100개. 결과 `{messageIds,unreadCount}`이며 본인 ID/시간은 받지 않는다. 새 목록·상세의 `unread_message_count`를 사용하고 호환 `unread_count`와 같은 의미로 표시하지 않는다.
6. **회원 삭제 복구:** 이미 dispatch한 작업은 DELETE/ACK 자동 재전송 없이 확인 경로로 넘긴다. DB dispatch와 Storage의 결과를 확정하는 제품 복구 연결 전에는 기능을 활성화하지 않는다. 회원 HTTP의 배정 상한 연결 역시 종현 호출자가 실제 전달하는지 별도 검증해야 한다.

이 차이가 해소된 제품 실행기로 두 프로세스 경쟁·연결 유실·종료 및 재시작·자동 주기 파기를 통과해야 기존 5번과 추가 4번을 완료 처리한다. 공통 포트와 합성 HTTP 검증만으로 9/10 또는 6/6으로 올리지 않는다. 자격 있는 네이버 두 계정은 별도 대기다.

이전 연결 요청: [추가 백엔드 인계](2026-10-08-additional-backend.md), [독립 실행 포트](2026-10-08-independent-runtime.md).
