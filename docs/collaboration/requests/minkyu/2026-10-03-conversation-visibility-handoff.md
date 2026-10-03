# 대화방 나가기 — 2026-10-03

전체 **43% · 6/14**를 유지한다. 확정 기준은 [정책.md](../../../../정책.md)의 회원 간 채팅과 [PLAN.md](../../../../PLAN.md)의 나가기다. 본인 대화 목록에서만 숨기고 상대방 기록·메시지·동행·알림을 보존한다.

[이번 하네스](../../minkyu-conversation-visibility-harness.json)는 민규 14개 파일을 네 단독 편집 범위로 나누고 기존 164개 파일의 SHA256을 보존한다. 공식 CLI가 생성한 `20261002174755_conversation_visibility.sql`을 기존 마이그레이션 위치에 구현했다. 원격·실제 네이버 환경·종현 담당 파일·Git 인덱스는 변경하지 않는다.

## 구현 계약

`POST /conversations/:requestId/leave`는 빈 JSON 객체를 받으며 사용자 JWT의 `leave_conversation(p_request_id)`를 호출한다. 반환값은 `{requestId, hidden: true}`다. 로그인한 당사자만 자기 숨김을 기록하고 반복 요청은 최초 숨김 시각을 보존한다. 기존 네이버 미등록 회원도 기존 대화를 숨길 수 있다. 나가기 때문에 기존 대화 조회·메시지 전송 권한을 변경하지 않는다.

비공개 숨김 표는 RLS와 직접 접근 회수로 보호한다. 대화 목록의 기존 반환 열·마스킹·정렬을 보존하며 자기 숨김 표만 제외한다. 복귀 API·새 메시지의 자동 복귀·신고·차단·탈퇴 정책은 이번 확정 기능에 추가하지 않는다.

## 검증 상태

신규 HTTP 단위 9개와 관련 회귀를 포함한 77개, Deno 검사, 41개 SQL 준비 도구의 합성 단위 11개가 통과했다. 격리 로컬 CLI start exit0으로 41개 이력을 적용했으며 실제 DB rollback 검사 6그룹이 통과했다. assertion 활성 상태와 rollback 뒤 Auth·프로필·숨김·메시지0을 확인했다.

실제 Supabase Auth·Edge API·RPC 통합은 **8그룹·525확인 PASS**다. 배포 로컬 gateway 32회·원형 factory 1회·fixture RPC 7회를 사용했다. 실제 로그인과 GoTrue guest JWT를 확인했으며, 동시 나가기 2회가 한 행으로 처리되고 최초 시각을 보존했다. 자기 목록만 제외·상대 목록 유지, 기존 회원 허용, 비당사자/없는 대화/비로그인/guest 거절, 나간 뒤 기존 읽기·열린 대화 전송·취소 대화 전송 거절을 확인했다. 메시지 전송 이후에도 숨김을 유지한다. 원본 공고·신청·약속·알림·예약·기존 메시지 해시가 동일했다.

합성 자료 정리 뒤 앱38개 표·Auth users/sessions·Storage objects0을 확인했다. 사진은 metadata만 사용했고 실제 업로드·외부 네이버·AI·원격 회원 자료는 호출하지 않았다. 로컬 security advisor exit0/`No issues found`이며 전체 운영 보안 적정성으로 확대하지 않는다.

실행 루트는 `/private/tmp/yumidang-conversation-20261003-9_fnq9a2/edge`이며 API56521/DB56522를 사용했다. 준비 manifest와 건수·해시만 담은 `result.json`을 보존하고 임시 키·환경값·실행 로그를 삭제했다. CLI stop exit0 뒤 기존 네이버 전용5개 컨테이너만 유지함을 확인했다. 기존164개 보존 파일과 원본 .env·정책.md 해시도 동일하다. 운영 적용은 미실행이다.

- `backend/supabase/migrations/20261002174755_conversation_visibility.sql` SHA256: `e476d098e82c52352b484b724b0f041b209b077821ca9d9642c69aca5a0999c6`.

- `tests/database/minkyu/conversation_visibility.sql` SHA256: `4af074dc2faa460a8ba2e950e02dbf34d222916c88b2f6377be7ea279b316594`.

- `tests/integration/minkyu/conversation_leave_local.ts` SHA256: `47c0ea4df08ef6a13fc8f39afc09fbdacbdff4821926f2b66b52ff42a00abfde`.

다음 운영 준비는 기존 요청한 DB 연결 URL의 로컬 입력과 백업·복원 증거, 상주 실행기 호스트·Secrets·cron 전환이다. 종현 담당 검색·Top10·AI 연결과 미정 팀 정책도 남아 있어 전체 12·13단계를 완료로 올리지 않는다.
