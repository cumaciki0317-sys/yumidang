# 종현 구현 후 민규 공통 연결 요청

2026-10-07. actor jonghyun. 로컬 인계 HEAD `2d4cbf47c03e86e679b7c6cdea1d047cdb7f31a9` 기준 독립 clone 구현이다. 외부 메시지·운영 활성화·SQL 수정·커밋·푸시가 아니다. 새 원격 HEAD는 조회하지 않았다.

## J1: 가상 포트를 실제 연결로 바꿀 조건

종현은 `createSharedBackgroundQueueScheduler`, `createSafetyConsumerRegistry`, scoped claim과 완료 journal을 구현했다. 기존 RPC와 신고 Storage 어댑터를 실제로 조립하는 `createRpcSafetyConsumerPorts`와 enqueue→지원 claim→소비자→완료를 묶는 `createSafetyWorkerInvocation`도 완성했다. 민규 공통 코드·SQL은 편집하지 않았다. 아래 내부 주입 포트는 제안 계약이며 새 DB/HTTP wire를 이미 제공 중이라는 뜻이 아니다. 공통 계약 확정 전에는 신규 운영 소비자를 등록하지 않는다.

1. **공유 최대20의 단위**: 문서의 20회/20작업/호출 수와 신고 enqueue의 신고 수·첨부 task 수를 구분해 고정한다. scheduler `unitsFor(kind,result)`와 소비자 `reserve(operation)`은 같은 승인 원장/단위를 사용해야 한다. 모형은 1처리 항목=1단위이나 운영 정책으로 채택하지 않았다. 종류별 새 예산/토큰 재취득/연장으로 우회하지 않는다.
2. **소유한 토큰을 고려한 예약 조회**: 현재 read_worker_queue_schedule은 살아 있는 전역 lease까지 기한을 미룬다. 한 토큰으로 종류를 교대하는 cycle 내부 조회는 자신의 토큰까지 기다리면 안 된다. 종현 내부 `schedule({excludeKinds,afterKind,globalToken})` 포트에 연결할 권한·조회 계약을 제공한다. 무단 별도 RPC/공통파일 수정 없음.
3. **30일 완료 증거 만료 조회**: 현재 maintenance purge 포트는 있지만 다음 만료 조회가 없다. 서버 시계 기반 next due 조회·알림·권한을 제공한다. 내부 모형의 `{serverNow,nextDueAt}`는 제안 포트이며 확정 DB DTO가 아니다. 임의 cron/폴링 주기를 만들지 않는다.
4. **영속 journal과 복구**: due enqueue의 원 requestId/kind/global/limit, scoped claim의 requestId/worker/global/supported kinds, 실행의 원 job/task/fence/증거 해시, 취소 일반 완료의 원 job/global/request/status를 저장·조회하는 계약이 필요하다. scheduler 전체 intent도 원 토큰/처리 종류와 연결한다. Storage dispatch/ACK만으로 claim·metadata 완료·maintenance 응답 유실 복구를 대신하지 않는다. 원문·키·Storage 경로를 복제하지 않는다. 미확인 intent가 있으면 자동 dispatch0, 재시작 뒤 읽기 확인/명시 복구로 넘긴다. TTL·lease 자연 만료는 원격 종결 증거가 아니다.
5. **HTTP 조립·기존 소비자 공유예산**: 신규 endpoint를 추측해 만들지 않았다. scheduled index는 준비 소비자 factory를 내보낼 뿐이다. Node `sharedRuntime`에는 실제 안전 소비자·기존3소비자의 동일 limit/signal 소비 어댑터·공통 계약이 모두 필요하다. 종현 소유 요약은 `createReviewSummaryWorkerExecution(read, overrides)`가 반환하는 함수 `(token, external)`에 배정 작업수·시간·signal을 연결했고 행사는 `operations.worker(token, signal, execution)`에 같은 하향 제한을 연결했다. 둘은 원 token을 재사용하고 기존 한도를 늘리지 않는다. 승인 단위→작업수 변환과 민규 소유 member_cleanup의 배정 limit/signal 연결은 아직 필요하다. 기존 URL worker를 공유예산을 무시한 채 재사용하지 않는다. 전용LOGIN/TLS/ACL/guard 실제 승인 상태를 함께 제공한다.

완료 확인: 실제 격리 DB에서 두 runner의 경쟁·재시작·LISTEN 재접속·세대/fence 거절·공유예산·terminal 정리·UNKNOWN 복구를 확인하고 Storage DELETE/ACK 유실 뒤 추가 전송0을 입증한다. 모형 준비와 운영 활성화는 별도다.

## J3: 현재 소스에 없는 API와 필터

- **본인 공고 목록**: 신청이 없는 본인 공고를 관리할 회원 HTTP/RPC·페이지/정렬·작성자 권한 계약이 필요하다. 임의 GET /me/posts route를 호출하지 않았다.
- **대화 읽음**: 알림 읽음과 별도인 채팅 읽음 route/DTO/권한/서버 시각 계약이 필요하다.
- **공개 행사 상세·순위**: 현재 모바일의 행사 상세/순위 호출에 대응하는 공개 HTTP 경로가 service-api source에 없다. 경로·반환 권한·현재 상태·공급사 보류와 맞는 DTO를 제공한다. 모바일은 현재 없는 두 경로를 전송 전 차단하고 준비 안내를 표시한다. KOPIS/서울 보류를 해제하지 않는다.
- **신고 개인 숨김의 실제 조회 필터**: 저장/목록/해제만 존재하고 검색·공고·행사·채팅 조회에서 member_hidden_targets를 소비하는 필터는 확인되지 않았다. 자료 파기와 독립적인 최소 숨김 기록 유지·현재 본인 필터·해제를 연결해야 한다. 새 신고 숨김 선택은 계속 보류이며 기존 숨김 목록/해제만 모바일에 연결했다.

이미 있는 일반·취소 안내/성공제공ACK/일반·취소 이의/공개 후기요약은 최신 source와 HTTP handler+합성 RPC로 연결했다. 과거 문서의 전체 미연결 주장과 구요약 경로를 다시 요청하지 않는다.

## J2: 이미 있는 공통 연결과 남은 준비

loadPotensAccountPoolConfig + createRpcAccountBudget을 종현 runtime에 연결했다. 이중 예약 없이 계정/한국일자 고정·미확인 사용량 유지·전송 후 자동 전환0을 검사했다. 계정 순서·320만/전체합계·회원20회는 재질문 대상이 아니다.

A안 검사는 정확 인용/구조화된 근거와 서버에서 검토된 문자열 목록만 허용한다. 합성 문자열의 로컬 검사·평가는 인계 없이 준비하고 검증했으며, 이를 실제 회원 원문 승인으로 사용하지 않는다. 운영 approvedStrings/decisionId의 검토 담당·원천·갱신 절차는 확인이 필요하다. 요청/후기 원문을 자동 승인 목록으로 사용하지 않는다. 공식 사용량 필드·출력 상한·소진 판정·공동사용/보관/회원전송의 기존 확인 조건은 유지한다. 해당 자료 없이 real-ready를 선언하지 않는다.

## 인증 초기화·AI 피드백 추가 확인

- 모바일 Web 회원 연결 factory는 존재하나 제품 초기화에 설치되지 않았다. 확인된 `WebSessionOptions`의 signupUrl/supabaseUrl/publicApiKey/callbackUrl 공급과 설치가 필요하다. 토큰을 공개 환경변수로 넣거나 URL을 유추하지 않는다. native 회원 adapter·발급된 앱 식별자·두 실제 계정/기기 검증은 별도다.
- AI helpful/report의 종현 HTTP·RPC 소비자는 존재하지만 현재 공유 migrations/internal-client에서 `submit_ai_feedback`을 확인하지 못했다. 접수 저장/권한/멱등 DTO·allowlist와 reportEvidenceHandling의 실제 Storage/ACL/접근기록/정리 연결이 필요하다. 합성 성공과 실제 접수를 구분한다.
- 원문 없는 AI 지표 recorder와 보수 검사 합성 평가를 이번 후속 구현에 연결했다. 실제 sink/보관 설정·운영 검사 자료·배포 환경 증거는 별도이며 합성 목록을 회원 원문의 자동 승인에 사용하지 않는다.

## 원격 기준 후속 확인

읽기 전용 원격 조회에서 minkyu/handoff-20261005=2d4cbf47c03e86e679b7c6cdea1d047cdb7f31a9, jonghyun/queue-integration=26aca729fce4058332684294e0df89f24356a4ef를 확인했다. 새로운 공통 계약 커밋은 확인되지 않았다. 위 요청 사항과 AI 승인 목록은 미해결이며 임의 운영 활성화하지 않는다.
