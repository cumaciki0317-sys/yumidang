# 일반 신고·캡처 초안과 AI 신고 연결 — 민규 → 종현

[종현 AI 피드백 요청](../jonghyun/2026-10-05-ai-feedback-connection.md)에 대한 현재 연결 경계다. [일반 신고 계약](../../../../backend/contracts/reports.md), 정책6-2·11·13을 따른다.

민규는 `20261005015709_member_reports.sql` 및 reports 서비스에서 공고·채팅·약속·회원·행사 접수와 private 캡처 예약/확인/취소를 구현했다. 기존 `ai-chat/feedback`, `AiFeedbackInput/Result`, `submit_ai_feedback(...,p_contract_version)` 계약은 수정하지 않았다. 일반 targetType에 AI를 임의 추가하거나 AI 대화 전체를 가져오지 않는다.

캡처는 report-evidence private bucket, 회원UUID/assetUUID 경로, 본인 active 가입 회차, 실제 Storage 객체 owner/MIME/size를 검사한다. 외부 URL과 타인 캡처를 허용하지 않는다. 일반 신고에 배정한 asset은 AI 사건에 재사용하면 안 된다. `installAiReportCaptureUpload` 후속 연결은 예약→실제 회원 Storage 업로드→confirm→assetId 순서여야 하며 취소는 cancel 후 실제 Storage 삭제 결과를 별도로 확인한다. UI는 RPC의 접수 성공 이전에 답변을 숨기거나 업로드 완료를 표시하지 않는다.

AI 결과의 소유권·requestId 수명·선택 답변 구간·정확한 fingerprint는 AI 전용 계약으로 별도 연결해야 한다. 본문 userId를 신뢰하지 않고 내부 인증된 호출자의 회원/현재 가입 회차를 검사하며 원문 없는 helpful과 명시 확인한 최소 첨부 report를 구분한다. 성공 `{status:'accepted',feedbackId,hideAnswer}`는 실제 AI 전용 원자 저장 이후에만 반환해야 한다. 일반 신고 SQL에 해당 내부 RPC나 반환 adapter는 아직 없다.

현재 일반 schema는 직원 역할/사건 배정 ACL/운영 판정/이의 종결 RPC를 생성하지 않는다. 접근감사 및 최종 종결+90일 후보 schema만 있고 실제 Storage·DB·백업 삭제 scheduler도 없다. 그러므로 `reportEvidenceHandling.isReady()`와 실제 AI 접수 capability를 true로 연결할 수 없다. 기존 not_enabled 동작을 유지하고 합성 true를 운영 준비로 대체하지 않는다. 운영자 원본 채팅 읽기·외부 AI 전송·전체 대화 저장은 추가하지 않는다.

일반 `hideTarget`은 저장만 했으며 실제 검색·읽기·모바일 화면 필터는 미연결이다. AI `hideAnswer`와 별개이며 해당 사용자/해당 requestId의 답변만 성공 후 숨기는 기존 계약을 유지한다. 종현 소유 검색/AI 파일 변경은 종현이 담당하고 민규 RPC 준비가 확정된 뒤 연결 검증한다.

현재 검증은 독립 scratch DB의 합성 metadata/RLS·접수/가입 회차 회귀와 handler 합성 HTTP11개다. 실제 이미지 업로드·내부 submit_ai_feedback·운영 ACL·90일 실제 삭제·네이티브·운영은 아직 검증하지 않았다.

Storage 보안 재검토에서 본인 reserved 객체 SELECT가 INSERT RETURNING에 필요함을 실제 SQL로 확인해 허용했다. 타인/다른 회차와 제출 후 변경은 계속 차단한다. 이는 blob 존재·내용을 검증한 증거가 아니며 미제출 예약 TTL/자동 정리도 아직 없다. 실제 업로드 포트 연결 검증 전에 이 경계를 별도로 확인한다.
