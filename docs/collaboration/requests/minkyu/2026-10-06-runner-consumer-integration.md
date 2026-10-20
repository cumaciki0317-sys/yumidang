# 종현 실행기 소비자 연결 요청

## 2026-10-20 현행 기준과 이 문서의 적용 범위

이 문서는 과거 요청·설계·검증 기록이다. 아래 원 관찰·명령·해시·PASS/FAIL은 당시 증거로 보존한다. 재개할 때는 다음 현행 조건을 먼저 적용하며 과거 작업 권한·보류를 현재 지시로 재사용하지 않는다.

- 담당은 현재 민규=BE·AI·검색·행사·서버 운영, 종현=FE·UX/UI·앱 API/세션 소비·빌드, 유미=UT·출시/지원 책임이다. 아래 옛 종현 BE·성호 UI 배정은 당시 기록이며 현재 실행 권한으로 사용하지 않는다. 구체 파일은 현행 소유권 정책을 따른다.

- 포텐스닷 문의 회신은 사용자가 공유했다. 공급사는 교육·프로토타입 범위, 일일/기간 제한·기능 축소·보안 우려로 공개 서비스에는 다른 API를 권고했다. 보관·학습·삭제·공동 사용의 구체 조건은 여전히 미확인이다. 포텐스닷 제품 활성화를 기다리는 계획으로 읽지 않는다. Gemini는 종현 테스트 전용 프로젝트에 결제 연결·월50,000원 사용중단 예산을 준비했으나 최종 청구가 지연 없이 반드시 5만원 이하라는 보장은 아니다. 합성 테스트와 대표 유미 계정 전환·제품 adapter·실회원 전송은 별도다. 대표 계정 전환은 회의/브랜치 통합 때 진행한다. Potens 기술 토큰 원장과 Gemini 원화 지출 원장은 분리한다.

- AI 탐색 동의는 첫 사용 시 받고 거절하면 일반 검색을 유지한다. 후기 요약은 가입 시 열람·내 프로필 생성/노출·작성 후기 활용을 기본 미선택인 별도 선택 세 항목으로 받는다. 전체 동의와 개별 자세히 보기를 유지하고 미동의 가입/일반 동행을 허용한다. 세 동의의 철회는 독립적이다. 현재 서버의 summary_allowed 하나·review_summary 일괄 철회가 이 세분화 요구를 구현했다고 해석하지 않는다. 테스트 계정 동의 간주는 실제 동의 증거·DB 값 변경·회원 원문 전송 승인이 아니다.

최신 기준: [정책.md](../../../../정책.md). 구현과 남은 조건: [서버·DB 대조 원장](../jonghyun/2026-10-20-policy-implementation-audit/server-audit.json).


민규 잔여5번의 통합 대기 항목이다. 현재 원격 `jonghyun/queue-integration`은26aca729이며 `policy-integration-20261005`의0b599065도 현재HEAD에 포함되어 있다. 최신 조회에서도 추가 소비자 푸시는 없었다. 문서 작성은 외부 메시지 전송·운영 활성화·푸시를 의미하지 않는다.

## 현재 실제 연결 차이

종현 소유 `_shared/jobs/background.mjs`의 허용 종류는 `review_summary`, `event_sync`, `member_cleanup`다. 신고 파기·취소 안전 처리 소비자가 없고 `review-summary-worker/index.ts`·job registry에도 해당 RPC 소비가 없다. 민규 내부 클라이언트와 DB schedule에 이름이 있다는 것만으로 실행기 통합 완료로 계산하지 않는다.

## 종현 담당 산출물

- 자신의 별도 브랜치에서 cancellation safety와 report retention 소비자를 registry/runtime/background schedule에 연결한다. 기존 요약·행사·회원 정리를 보존한다.
- 공통 유지관리 RPC와 report Storage port는 민규 제공 파일을 가져와 사용하고 직접 수정하지 않는다. 필요한 인터페이스 변경은 종현 요청 폴더에 남긴다.
- `createReportRetentionStoragePorts(config,{jobId,jobLeaseToken,globalToken})`와 `report-retention-storage.ts`의 현재 계약을 따른다. Storage DELETE 전에 dispatch intent를 기록하고, 응답 유실·ACK 미확인은 자동 재전송하지 않는다.
- 전역 worker 점유·job 점유·task 점유 및 budget을 각각 확인한다. 재시작 후 unknown 작업은 조회·검토로 넘기고 새 DELETE를 만들지 않는다.
- 현재 미확인 기능 guard는 계속 비활성 상태로 두고 readiness를 성공으로 대신하지 않는다.

## 민규 통합 완료 조건

새 브랜치를 받으면 실제 두 실행기의 경쟁·재시작, DELETE/ACK 유실 시 추가 전송0, 종결+90일 파기, 최소 숨김 기록의 별도 보존을 격리 환경에서 확인한다. 종현 소유 코드를 민규가 대신 수정하지 않는다. Railway와 운영 계정 준비는 별도 출시 대기다.

## AI 예산 준비 완료

민규의 `db/ai-account-budget-client.ts`에서 `createRpcAccountBudget`을 제공한다. 기존 누적 호출 원장ID와 promptOverheadBytes를 넘겨 `AccountReservationPort`에 연결한다. 신규 RPC는 SQL92 후보이며 동의/lease/공개근거/회원20회 검사를 보존한다. actual AccountPool→adapter→HTTP→DB 검증은 완료했고 외부 제공처 모델 호출은 하지 않았다. 기존 단일계정 예약 router와 겹쳐 차감하지 않도록 runtime 연결은 종현이 담당한다.

## 다계정 runtime 연결 시 필수 조건

- 계정 순서 `yumi → jonghyun → minkyu → sungho`, 등록 계정별 한국시간 하루320만 토큰, 전체 상한은 등록 계정 합계다. 회원20회와 기존 누적 호출/단위 원장은 별도로 유지한다.
- DB 계정은 초기 미등록 상태다. `configure_ai_budget_accounts(text[])`는 service-only 관리 RPC이며 비밀키를 받지 않는다. 실제 운영 등록은 별도 승인·공급사 조건 확인 후 진행하고 코드에서 임의 등록하지 않는다.
- `unknown` 정산은 `{settled:false,pending:true}`이며 예약을 보존한다. 같은 unknown은 멱등이고 이후 자동 `reported` 정산은55000으로 거절한다. 미확인 사용을 자동 반환·재전송하지 않는다.
- 현재 민규 어댑터는 `confirmedDepletion` 정산을 거절한다. 공급사 오류 분류/효력과 해당 DB 계약이 승인되기 전 depletion classifier를 주입하지 않는다.
- 최신 검증 결과와 남은 범위는 [진행 기록](2026-10-06-remaining-progress.md)을 따른다. DB 후보가 Git에 존재하는 것은 각 팀원 로컬/운영 DB에 적용됐다는 뜻이 아니다.
