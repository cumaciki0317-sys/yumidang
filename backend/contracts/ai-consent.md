# AI 독립 선택 동의 서버 계약

민규 담당. 2026-10-20 정책 구현 소스이며 운영 적용·실회원 동의 증거·외부 사본 삭제 완료를 뜻하지 않는다.

## 회원 API와 앱 연결

- `GET /service-api/me/ai-consents`: 본인 JWT로만 조회한다. `data`는 `{exploration:boolean,summary_view:boolean,summary_generate:boolean,summary_source:boolean}` 네 필드를 반환한다. 저장 행이 없으면 모두 false다.
- `POST /service-api/me/ai-consents/set`: 정확히 `{kind,allowed}`를 받는다. `kind`는 `exploration | summary_view | summary_generate | summary_source`, `allowed`는 JSON boolean이며 다른 키·회원ID·쿼리를 받지 않는다. 성공 응답 `data`는 위 네 필드의 현재 상태다. 같은 설정 재시도는 부작용 없이 현재 상태를 반환한다.
- 미인증은401, 잘못된 종류·타입·추가 필드·쿼리는400이며 RPC를 실행하지 않는다. 다른 사용자 ID를 받지 않고 원래 JWT의 인증 회원을 SQL에서 다시 판정한다. 내부 서비스 키로 회원 동의를 설정하지 않는다.
- 종현 앱 소비: 후기 선택 체크3개는 기본 미선택. 전체 동의는 세 항목을 각각 설정하는 편의 기능이며 탐색은 포함하지 않는다. 세 요청은 원자 일괄 동의가 아니므로 실패한 항목을 성공으로 표시하지 않고 조회로 현재 상태를 확인한다. 탐색은 첫 사용 시 별도 설정한다. 가입·일반 검색·일반 동행에 동의를 필수화하지 않는다.
- 기존 `POST /me/ai-processing/withdraw`의 `exploration`은 탐색만, `review_summary`는 구형 전체 요약 철회로 유지한다. 신규 독립 철회는 `/ai-consents/set`의 해당 종류에 false를 사용한다.

## 저장과 실행 판정

추가 migration `20261020100000_ai_independent_consents.sql`은 기존 private 테이블에 열람·생성/노출·원문 활용 세 boolean을 false 기본값으로 추가한다. 기존 `summary_allowed=true`와 테스트 계정 간주는 이 열로 승계하지 않는다. 테스트 fixture는 합성 동의를 명시한다. 기존 탐색 상태와 전체 예산·요청·UNKNOWN 원장을 보존한다.

열람 철회는 본인 열람만 제한하고 다른 프로필의 공개 상태를 변경하지 않는다. 생성/노출 철회는 본인 projection을 숨기고 작업 checkpoint를 무효화하며 재생성 요청을 제거한다. 원문 활용 철회는 해당 작성자의 기존·향후 후기를 원천에서 제외하고 영향을 받은 대상의 projection을 먼저 숨긴다. 동의가 남은 대상에만 재검토 outbox를 등록한다. 재생성·공개는 기존 적격 공개 텍스트3개, 회차·revision·작업 점유·외부 처리 허용 조건을 모두 충족해야 하며 실패·미확인·자료 부족 시 숨김을 유지한다.

원문 활용과 생성 동의를 모델 예약·원천 조회·게시 전 재검사한다. 열람 동의는 공개 요약 조회에서 본인 기준으로 검사한다. AI 철회만으로 일반 후기·별점·당도·계정·일반 동행을 변경하지 않는다. AI 복사본·외부 사본의 실제 삭제는 별도 파기 검증 과제로 남긴다.

## 검증 경계

HTTP 합성 계약은 `ai_independent_consents.test.ts`, 구형 철회 호환은 `ai_withdrawal_http.test.ts`로 검사한다. `ai_independent_consents.sql`은 실제 가입·세션 등록 합성 fixture에서 신규 기본false, 구형true 미승계, 개별 변경·철회·계정 불변을 검사하도록 준비됐다. 실제 격리 DB 적용·경쟁 검증은 중앙 실행 슬롯에서 수행하며 이 문서 작성만으로 PASS 처리하지 않는다.

## AI 보내기 버튼의 서버 사전 상태

`GET /service-api/me/ai-availability`는 본인 JWT로 `get_my_ai_availability()`를 읽는다. 응답 data는 `{estimatedEligible:boolean,reason:"processing_disabled"|"consent_required"|"concurrent"|"daily_limit"|null,remaining:0..20,kstDay:YYYY-MM-DD,checkedAt:timestamp,resetsAt:timestamp,requestAuthoritative:true}`다. 우선순위는 처리 비활성→탐색 미동의→유효한 동시 요청→일일 한도다. 날짜·남은 횟수·자정은 DB 한국시간 기준이다. 미인증401, 조회 쿼리·다른 회원ID400이며 회원 자격 가드를 유지한다.

종현은 명시적 상태 새로 확인에서 이 응답을 소비할 수 있다. true는 현재 동의·개인 한도·동시 요청·전역 처리 스위치에 대한 사전 추정이며 공급사/계정별/전체 예산 예약 성공·네트워크·키 유효성을 보장하지 않는다. 실제 보내기 요청의 서버 판정이 항상 우선한다. 안내·입력을 보존하며 자동 재전송하지 않고, 앱 타이머·재진입만으로 이용 가능으로 전환하지 않는다. 이 조회는 모델·예산 예약·요청 점유·개인 횟수 증가를 실행하지 않는다.
