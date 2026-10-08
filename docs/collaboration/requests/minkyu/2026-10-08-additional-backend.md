# 민규 추가 백엔드 구현·종현 연결 인계

기준 HEAD: `edfc624b8a248c19d63e9a848f30c050ae746f4b`, 민규 전용 worktree·브랜치 `minkyu/foundation-harness`. 구현·검증 당시 변경은 미커밋이었다. 이후 사용자 요청으로 이 인계와 관련 구현을 커밋·푸시한다. 운영 적용은 수행하지 않았다. 종현 코드와 기존 SQL을 보존했다.

## 진행률과 완료 판정

기존 잔여 **8/10(80%)** 유지, 추가 **5/6(83.3%)**. 추가 4번의 DB·HTTP 핵심 검증은 통과했지만 종현의 실제 성공 응답 증거 및 주기적 파기 연결은 미완료다. 준비 상태 검증 완료와 기능 운영 활성화를 구분한다.

| 묶음 | 상태 | 실제 확인 |
|---|---|---|
| 1 본인 공고 | 완료 | 신청 없는 공고·작성자 정보·동일 시각 커서·타인 커서 거절·삭제 제외·실제 JWT HTTP |
| 2 채팅 읽음 | 완료 | 서버 시각·중복/역순·6개 경쟁 요청·새 메시지·다른 메시지 거절·삭제 FK·실제 JWT HTTP |
| 3 본인 숨김 | 완료 | DB 제한 전 필터·직접 접근·타인 보존·해제·신고 metadata 삭제 후 유지·확정 일정 관리 보존 |
| 4 AI 피드백 | 연결 대기 | helpful 동시 중복·입력 충돌·실제 캡처 업로드·담당 ACL/감사·종결+90일·helpful 만료/탈퇴 삭제 통과. 성공 응답 및 실행기 연결 미완료 |
| 5 행사 상세·순위 | 완료 | 최신 수정·취소 행사·선택적 회원 권한·숨김·공식 순위 명시적 보류 |
| 6 AI 준비 계약 | 완료 | 기존 다계정 예산 재사용·미준비 실제 HTTP에서 외부 요청 0회·신고 기본 비활성 |

## 신규 서버·SQL

후속 SQL95~99:

1. `20261008010000_member_own_posts.sql` — `list_my_service_posts`, 회원 GET `/me/posts`.
2. `20261008011000_conversation_read_state.sql` — 읽음 상태·서버 생성 시각·`mark_conversation_read` 및 조회 DTO.
3. `20261008012000_member_hidden_content_filters.sql` — 검색/목록 제한 전 본인 필터·상세/RLS·필수 관리 보존.
4. `20261008013000_public_event_detail.sql` — 공개 상세 및 공식 순위 보류 RPC.
5. `20261008014000_ai_feedback_receipts.sql` — 결과 제공 증거·helpful/report 멱등 접수·권한·기한·탈퇴/파기 연계.

`tools/local/prepare_current_policy.py`에 고정 검토 해시로 등록했다. 최종 준비 루트는 `/private/tmp/yumidang-additional99-final-v2-prepared`이며 manifest는 **99개 / HEAD canonical94 / pending5 / READY**이며 준비 자체의 SQL/Edge 실행 상태는 NOT_RUN이다. 실제 적용 검증은 별도 격리 DB에서 수행했다. 원래 정식 로컬88 및 운영 DB에 이 5개를 적용했다는 뜻이 아니다.

## 종현 담당 연결 요청

### 실제 AI 결과 제공 증거

대상: `backend/supabase/functions/ai-chat/` 및 `_shared/ai/Agents/chatbot/`의 실제 응답 경로. 기존 구현을 유지하고 민규 포트 `_shared/db/ai-feedback-client.ts`의 `recordAiResultAvailable(db, scope)`를 연결한다. 검증된 성공 결과를 제공할 준비가 된 경로에서 활성 처리 종료 전에 기록한다. `scope`는 서버의 `MemberModelRequest`이며 본문 회원 ID나 임의 lease를 사용하지 않는다. unavailable·실패·개인정보 차단·시간 초과 경로는 기록하지 않는다. 과거 finished를 성공으로 backfill하지 않는다. 기록 실패 시 성공 처리로 넘기지 않는 오류 계약을 확인한다. 생성 원문·전체 대화를 증거 또는 오류 로그에 남기지 않는다.

현재 HTTP 검증은 합성 처리에 결과 증거 RPC를 직접 연결한 증빙이다. 실제 AI 생성 경로 연결 완료 증빙으로 대신하지 않는다. 기존 J HTTP는 증거 없는 helpful을 거절하므로 실제 연결 전 피드백 UI 활성화하지 않는다.

### 신고 준비 및 주기적 파기

`createAiReportEvidenceHandling(db)`는 준비 RPC를 엄격 검증하는 기존 `ReportEvidenceHandlingPort` 구현이다. `private.ai_report_handling_control.enabled`는 false다. 로컬 실제 캡처 업로드·담당자 ACL·감사·종결을 확인했으나 상주 파기 연결 및 운영 검토 전 true로 바꾸지 않는다.

기존 권한 있는 상주 실행 경로에 `POST /internal/ai-feedback-maintenance` 본문 `{limit:1..100}`을 연결한다. 이것은 `purge_expired_ai_feedback`로 helpful 접수+90일 메타데이터를 bounded 삭제한다. 결과 제공+90일 이후 새 helpful을 거절하며 신규 신고에 임의의 90일 마감을 추가하지 않는다. 원문 없는 성공 상태 증거는 요청 FK 및 탈퇴 수명주기를 따른다. 회원 탈퇴 시 helpful 및 성공 상태 증거는 실제 탈퇴 RPC의 DB 트리거로 즉시 삭제된다. 새 cron을 임의 생성하지 않는다. 실제 실행기의 재시작·반복 호출·만료 후 새 helpful 거절을 확인한 뒤 연결 완료로 기록한다. AI 신고 첨부 파기는 기존 종결+90일 Storage DELETE/ACK 경로를 재사용하며 미확인 DELETE를 자동 재전송하지 않는다. 미접수 업로드의 정리도 기존 캡처 수명주기로 연결한다.

### 앱·검색·행사 DTO

- GET `/me/posts?limit=20&before={postId}`는 `{items,nextCursor}`이며 각 행은 기존 공고 투영과 `createdAt`, `isOwner:true`다. 최대100, 작성자 본인 관리 경로다.
- POST `/conversations/{requestId}/read` 본문은 `{lastReadMessageId}`다. 조회의 기존 행에 `last_read_message_id`, `read_at`, `unread_count`가 추가된다. 회원 읽음 시각·회원 ID를 보내지 않는다. 서버 조회 RPC 이름은 `list_conversations_with_read_state`, `get_conversation_with_read_state`다.
- GET `/events/{eventId}`는 기존 공개 투영의 최신 정보다. 취소 행사 조회는 유지하되 신규 선택 금지는 기존 저장 정책을 따른다. GET `/events/rankings`는 공식 공급사 검증 보류 상태를 반환한다. 자체 순위·날짜 추정은 추가하지 않는다.
- 숨김은 개별 콘텐츠에 적용한다. 회원을 숨겨 모든 작성 공고까지 확대하거나 확정 일정·취소·신고·판정 안내를 감추지 않는다. 기존 목록·상세 DB 연결 완료와 앱 UI 연결은 별도다.

## 검증 재현 및 증빙

검증 대상은 민규 소유 `supabase_db_yumidang-release88-http`의 격리 API `http://127.0.0.1:59621`, 실제 M service-api59642와 J AI HTTP59641이다. Auth JWT는 실제 로컬 GoTrue에서 발급했으며 합성 회원만 사용했다. 실제 네이버 공급사 로그인·실제 여성/성인 두 회원·외부 AI 결과 생성 검증이 아니다. 인증정보는 프로세스 메모리에만 유지했고 증빙에는 상태·개수만 남겼다.

- `tests/integration/minkyu/additional_backend_local.py`: 실제 JWT→HTTP→DB·Storage, 읽음6경쟁 및 helpful6경쟁, 캡처 실제 업로드/확인·담당자 다운로드·타인403·감사, 실제 신고 종결·90일 보관. 신고 DELETE/FK 검사는 격리 TX rollback이며 실제 상주 Storage 파기 실행 검증을 대신하지 않는다.
- `tests/database/minkyu/{member_own_posts,conversation_read_state,ai_feedback_receipts}.sql`: 실제 별도 DB의 baseline94 백업 복원 후 최신95~99 바이트 최초 적용과 전체 TX rollback. pg_cron은 postgres 전용 제약 때문에 이 별도 probe에서 제외했으며 기존 cron 설정은 변경하지 않았다. 만료 helpful 삭제·재생성 거절·90일 지난 신고의 준비 검사 도달 및 실제 탈퇴 RPC 삭제 포함.
- 민규 함수560/560 PASS, 준비 도구108/108 PASS, service-api 및 AI DB 포트 Deno 타입 검사 PASS. 종현 함수176/176 PASS.
- 로컬 비공개 상태 증빙: `/private/tmp/yumidang-additional-backend-20261008/http-receipt.json`, `fresh99-v2-private.log`, `final-minkyu-functions.log`, `preparation-tests.log`. 이 파일들은 Git에 포함하지 않는다.

## 외부·기존 대기

기존 잔여 5번 상주 실행기 경쟁·재시작/파기 통합과 9번 실제 자격 있는 네이버 두 계정 흐름은 그대로 별도 미완료다. 공급사 개인정보·공동 사용·출력 상한 승인, Railway, 공개 URL·지원 담당·스토어 등도 출시 대기 목록이다. 이번 추가 5/6은 서비스 출시 100%가 아니다.

AI 신고 파기 시 첨부·설명은 삭제하며 원문 없는 최소 접수 키 기록은 유지한다. 신고 FK는 SET NULL이고 동일 키 재접수는 만료로 거절해 삭제된 증거를 복원하지 않는다. helpful 중복 기록의 90일/탈퇴 삭제와 구분한다.

## 최종 추가 검증

- 신고 신규 접수에 helpful의 90일 제한이 확장되지 않는 실제 DB 검사 PASS. 파기 후 최소 접수 키를 유지하며 동일 키의 첨부·설명 재생성은 PT404로 거절했다. 실제 HTTP 경로와 파기 TX probe를 보정 후 다시 통과했다.
- `tests/integration/minkyu/ai_feedback_maintenance_local.ts`: 실제 TCP HTTP의 잘못된 내부 비밀403, 정상 내부 권한200, 회당 최대1개 파기, 신고 false 및 외부 요청0회 PASS. 설정은 `SUPABASE_SERVICE_ROLE_KEY`와 별도 `INTERNAL_WORKER_SECRET`이며 회원/anon/service 키를 내부 비밀로 재사용하지 않는다. 시험은 로컬 키를 메모리에 읽고 임시 listener를 종료한다.
- 변경된 SQL99 해시 재등록 후 실제 최종99개 준비 READY, 새 SQL 변조 거절·staged SQL 미적용 보존 추가2개 검사 PASS. 앞의 준비 도구108개 검사와 구분한다.
- 기존 정식 로컬88의 구조·함수·권한·트리거 등 동일14개 카탈로그 비교 PASS. 과거 자료의 행 개수 비교는 이 구조 보존 판정에 포함하지 않았다.
- 수정35개 경로 소유권·기존 SQL 무수정·혼합 언어·diff 공백 검사를 통과했다. 추가 내부 HTTP 테스트 역시 민규 소유권을 확인했다.

잔여 연결은 실제 AI 성공 응답 hook 및 기존 상주 실행기의 주기적 파기 소비다. 내부 파기 포트가 HTTP로 동작한다는 사실은 소비자 연결·운영 활성화 완료를 의미하지 않는다.

## 후속 실행기·복구 검증

민규 독립 소비자·장애·전체 SQL99 복구 검증은 [실행기·복구 인계](2026-10-08-runner-recovery.md)에 기록했다. 실제 DELETE/ACK와 재시작 추가 DELETE0을 확인했지만 제품 queue-runner·영속 journal·공유 예산 연결과 AI 성공 응답/주기적 파기는 별도 대기다. 기존8/10·추가5/6 유지.
