# 일반 제재 안내 성공 제공 기록 — 민규 작업

## 현재 상태

후보 SQL·회원 API 구현 및 실제 로컬 DB 롤백 검증 완료. 기능 control은 기본 false이며 정식 로컬·운영 DB 적용, 앱 연결, 이의 접수 API는 미완료다. 기존 최초읽기 API는 성공 제공 시각의 근거가 아니다.

- `POST /decision-notices/{noticeId}/prepare-delivery`: 빈 body. 현재 본인 회차의 유효한 일반 제재 안내와 deliveryId를 반환한다. 준비만으로 마감은 생성되지 않는다.
- 앱이 반환 안내를 정상적으로 받은 후 `POST /decision-notices/{noticeId}/provided`: `{deliveryId}`만 전달한다. 서버 수신 시각과 +168시간을 기록하며 재시도해도 최초 시각을 보존한다. 클라이언트 시각·대리 회원·추가 query를 받지 않는다.
- 응답은 deliveryId·notice·providedAt·deadlineAt·appealPolicy의 정확한 5개 필드이며 기존 notice는 9개 필드 검증을 유지한다. 잘못된 nonce·타인·현재 효과가 해제된 판정은 성공 처리하지 않는다.
- 먼저 이의 접수·운영 검토 계약과 앱의 성공 제공 확인을 연결한 후 활성화한다. 앱 표시·외부 발송 성공은 이번 검증에 포함되지 않는다.

## 검증

실제 로컬 DB 전용 합성 회원·신고·판정으로 테스트했다. 준비·읽기 시 마감 미생성, 정확한 7일, 확인 재시도 비연장, 타인/잘못된 nonce 접근 차단, 판정 무효화 후 확인 차단, 직접 테이블/helper/서비스 역할 권한 차단, 절반 NULL 시간 제약을 검증했다.

첫 실행에서 JSON 연산자 결합 오류를 확인하고 괄호를 보강했다. 두 번째 실행 PASS, 전체 기존 native84 DB 상태 전후 동일. 모든 변경은 한 트랜잭션에서 롤백했다. 비공개 증빙은 `/private/tmp/yumidang-general-delivery87-probe-v2/receipt.json`이다.

HTTP 신규 3개와 기존 안내 16개: 19/19 PASS. `deno check service-api/index.ts` PASS. 실제 HTTP→DB 연결과 동시 ACK 부하 검증은 아직 하지 않았다.

## 다음 작업

1. 검증 SQL87 해시를 준비 도구에 등록하고 역사별 마이그레이션 보존 검사 갱신.
2. 일반 제재 이의 접수의 중복·마감·현재 회차·보관·담당 검토 연결 구현.
3. 앱 성공 제공 계약 연결 후 비활성화 해제 검토.
4. AI 다계정 원자적 예산 DB 연결은 별도 민규 작업으로 진행.

달성률 기존 63.5% 유지. 이번 단위의 구현·로컬 검증 통과를 서비스 출시나 운영 검증 완료로 계산하지 않는다.
