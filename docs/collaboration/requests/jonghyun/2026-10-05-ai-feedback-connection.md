# AI 평가·최소 첨부 신고 연결 요청 — 종현 → 민규

기준은 [정책11·13](../../../../정책.md)과 [현재 AI 계약](../../../../backend/contracts/ai-chat.md)이다. 신고 자료는 이의 포함 최종 종결부터90일 보관, 배정 담당자/승인 책임자만 열람하고 접근 기록을 남기는 확정 정책을 그대로 구현한다. 새 승인·동의·보관 선택을 요청하지 않는다.

종현은 기존 ai-chat handler/runtime에 회원 전용 `/ai-chat/feedback`을 연결했다. helpful은 원문 없이 평가, report는 제출 확인한 답변 구간 또는 캡처asset UUID 하나만 받는다. 첨부 두 개·전체 대화·본문 userId·외부 URL은 거부한다. 모델 호출/하루20회 차감은 없다. 성공 report만 hideAnswer:true를 반환하며 UI는 본인의 해당 답변만 접수 성공 후 숨긴다. SDK와 `RemoteAiFeedback` UI도 연결했다. 답변 구간은 빈 값으로 시작하고 미리보기/명시 확인 뒤 한 첨부만 제출한다. 요청·세션·업로드 포트·화면 이탈 때 오래된 결과를 무시한다. `installAiReportCaptureUpload`는 실제 Storage 업로드 연결을 받는 포트이며 기본 null이다. 민규는 업로드 완료/소유권/멱등성·신고에 연결되지 않은 업로드 정리와 취소를 구현해야 한다. 캡처 업로드 포트가 없으면 사진 선택/업로드를 성공으로 표시하지 않는다.

민규의 변경 대상은 내부 DB 클라이언트 허용 목록, `submit_ai_feedback` SQL 및 reports 저장·Storage 소유권/접근 권한/정리 기능이다. 현재 저장소에는 재사용 가능한 reports 서비스/첨부 schema 구현이 없으므로 종현이 공통 파일을 임의로 만들거나 수정하지 않았다. 정확한 HTTP/RPC shape·길이·반환형은 AI 계약을 따른다.

`submit_ai_feedback(p_user_id,p_request_id,p_client_request_id,p_action,p_attachment,p_contract_version)`는 버전2026-10-05다. DB는 인증 회원의 실제 AI 결과 소유권·업로드 완료한 캡처 소유권, 정책13 ACL/접근 기록/최종종결+90일 정리를 접수와 원자 검사한다. 같은 회원/클라이언트키/동일본문은 같은 접수 ID를 반환하고 다른 대상/본문 키 재사용은409다. 삭제/백업 실제 이행도 기존 정책 기준으로 확인한다. 신규 retention 숫자·보고자 자동 제재를 추가하지 않는다.

실제 report 처리 준비는 서버의 `reportEvidenceHandling.isReady()`에 연결한다. 기본 runtime에는 준비 포트가 없어 AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED이며 미연결 RPC는 AI_FEEDBACK_STORAGE_NOT_CONNECTED다. 준비 확인을 합성 boolean으로 운영에서 우회하지 않는다. helpful도 RPC가 없으면 성공이 아니다. 준비 확인 이후 DB가 같은 조건을 원자 재검사한다. 민규 소유 README의 연결 미완료 안내에도 이 경계를 적어야 하며 종현은 해당 파일을 수정하지 않았다.

검증 기준은 미인증401, userId/대화/2첨부/미확인400, 대상/asset소유권403, 멱등 충돌409, 변형 성공503, 미준비 not_enabled, 성공 접수 ID/숨김 플래그, 원문 로그·외부 모델/공급사 호출 없음이다. 현재 합성 HTTP/RPC 검증만 수행했으며 실제 DB 동시 멱등성·Storage·ACL·접근 기록·90일 정리·네이티브·운영은 미실행이다. 최종 통합 검증 수치는 총괄의 마지막 회귀 검사 후 기록한다.
