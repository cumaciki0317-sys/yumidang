# 종현 병렬 구현·검증 기록 — 2026-10-14

전체 **79%(22/28)** 유지. 이 기록의 로컬 구현·합성 검사는 실회원·공급사·전체 복원·운영 완료 수를 올리지 않는다.

## 사용자 결정과 작업 공간

- 사용자는 J01~J09 설계 후 구현을 요청했고, 확인·충돌은 독립 작업을 마친 뒤 한꺼번에 질문하도록 지시했다.
- 탐색 AI는 **미전송이 확인된 일시 실패만 회원 요청 전체 자동1회**로 확정했다. 공급사 신규 자료는 없다고 답했다.
- 민규 원본 `/Users/b/Documents/Antigravity/yumidang`은 기준 HEAD `831ead2ce554a672793cf0da1546f351ddcf61ce`, `minkyu/backend100-20261012`이며 변경하지 않았다.
- 독립 clone은 `/private/tmp/yumidang-jonghyun-parallel-20261014`, 브랜치는 `jonghyun/backend-parallel-20261014`다. actor=`jonghyun`, hook=`.githooks`를 연결했고 파일별 단독 편집·소유권 검사를 적용했다. 실제 remote 전송은 없으며 clone의 origin은 로컬 원본이다.
- 아래241개 로컬 검사 당시 소스는 **UNCOMMITTED**였다. 이후 사용자의1번 승인에 따라 이 변경 묶음을 로컬 커밋으로 고정한다. 푸시·VM 재시작·실제 Auth/DB·모델·공급사·운영 쓰기·외부 메시지는 실행하지 않았다. 검사 당시 영수증을 커밋 후 실제 검증으로 바꾸지 않는다.

## 구현과 보존한 경계

| 묶음 | 현재 결과 | 남은 조건 |
|---|---|---|
| J01 | 기존 HTTP 입력에 includeOngoing/freeOnly/performanceGenre 연결. 정확한 boolean/장르·중복·충돌·필터 변경 커서 거절. 기존 DB119·상세·순위 endpoint 재사용 | 현재 소스의 실제 Auth/HTTP/DB 연결 증거 |
| J02 | 미검토 aiViewCulture envelope·HTTP transport를 성공으로 오인하지 않는 회귀 추가. 런타임 활성화 없음 | 공식 HTTPS·새 응답/identity/페이지·진행 중 갱신 근거 |
| J03 | 순위50개라도 basedate 부재·미검증 빈 응답을 verified로 만들지 않는 회귀 추가. 기존 공개 보류 유지 | 공식 기간·순위/동률·0건·갱신 계약. 확인 후 snapshot 저장 설계 |
| J04 | 실제 모델명/usage/출력 상한과 개인정보 승인 근거 없는 기본 entrypoint는 계속 비활성 | 공급사 회신·공식 단위·상한 적용·검토된 검사기의 실제 조립 |
| J05 | 단일 router·다계정 pool의 미전송 자동1회 통일. 같은 scope/예약 유지, 전송 후 추가 전송·대체 계정 호출0. 형식 실패의 확인 usage 원 예약 정산 | 실제 공급사 오류/usage와 현재 DB 연결 증거 |
| J06 | 요약 코드·기존14 시나리오 재작성 없음. 현재 graph45개를 과거 실행 HEAD와 읽기로 대조 | provider4파일 및 민규 helper1파일 차이. 원 private 영수증 미확인·현재 실제14 NOT_RUN |
| J07 | 기존 정상3상태 증거→feedback→maintenance 연결 보존. 기록/finish 실패를 성공으로 반환하지 않는 기존 검사 확인 | 실제 Auth·Storage/ACL/감사·철회/탈퇴·주기 파기 증거. 준비 전 신고 비활성 |
| J08 | 기존 개별 메시지 API·서비스·계약 옵션 재사용. 새 watermark fallback 없음 | C20 DB PASS와 구분된 현재 Auth→HTTP→서비스 실제 검증 |
| J09 | 원 JWT/withdrawalId/ACK, 같은 요청 조회와 최소 processing/completed store 보존 | 현재 signed Auth/HTTP/서비스 복구 실제 증거. 성호 화면 store 소비 잔여 유지 |

J04/J05의 내부 `ModelError`는 안전한 오류 코드·불변 비열거 전송 상태·확인된 사용량만 전달한다. 공급사 transport 함수 호출 순간부터 `sent`이며, 호출 뒤 transport가 `not_sent`를 주장해도 재전송하지 않는다. 사용량 미확인·잘못된 값은 UNKNOWN을 보존한다. 설정·개인정보·동의·취소·점유·예산·원장 예약/정산 실패는 자동 재시도하지 않는다. 요약은 탐색 자동 재시도를 사용하지 않는다.

`backend/contracts/ai-chat.md`에는 이번 사용자 결정과 현재 계정별320만 토큰 기준을 반영했다. 민규 소유 정책.md를 직접 바꾸지 않았다. 모바일 README의 과거 endpoint 부재·초기화 미호출 설명은 현재 소스에 맞게 바로잡았고, 실제 설정/서버 검증이 별도라는 조건은 유지했다.

## 검증 증거

- 마지막 root 통합 검사: 기존 책임 시험 **20파일·234/234 PASS**, fail0·skip0·cancelled0. 전송은 주입한 가상 fetch/모형이며 **LOCAL_SYNTHETIC_ONLY**다. 실행 전후 변경 파일·시험 파일 SHA 동일을 확인했다.
- 책임 묶음별 검사와 독립 review도 통과했다. 앞선 결과는 통합234개와 중복이므로 합산하지 않는다.
- `deno check --no-remote`의 ai-chat·review-summary-worker·service-api **3 entrypoint PASS**. 네트워크 의존성 설치 없음.
- diff 공백 검사와 실제 변경 경로 소유권 검사 PASS. 성호 화면·민규 예외12개·소유권 정책·hook 소스는 수정하지 않았다.
- GPT/Codex 구현·자체 검증 및 별도 읽기 검토다. Gemini·실회원·실제 공급사 검증으로 표현하지 않는다.
- 최초 AI 책임 검사61/62의 실패는 TypeScript 클래스 필드가 오류 metadata를 열거 가능하게 남긴 문제였다. 비열거·읽기전용 속성으로 수정하고 최종 검사에서 통과했다. 실패를 실제 공급사 실행으로 해석하지 않는다.

원문 없는 로컬 검증 영수증은 `/private/tmp/yumidang-jonghyun-20261014-local-verification.json`에 보존했다. stdout SHA는 `08ec356c04b39fe19401766418b8e56f3b2ac2eaee827791f13592af0d332020`이다. 소스 상태는 UNCOMMITTED이며 실제 AuthDatabase/Provider는 NOT_RUN이다. 코드·기록 변화 후에는 해당 영수증의 정확한 파일 집합과 해시 범위를 대조한다.

요약 graph 읽기 결과는 `/private/tmp/yumidang-jonghyun-20261014-summary-graph.json`이다. 과거 실행 HEAD `cc71b471e593ee50278aeeaa21551637d8c7989f`의45파일 중40개 동일, provider4개와 민규 `isolated_ai_contracts.py`1개가 다르다. 기존 private192핀/observer/로그는 읽지 않았으므로 NOT_VERIFIED다. 과거14 PASS는 당시 범위로 보존하고 현재 전체45 동일·실제14 PASS로 확대하지 않는다.

## 실제 검증을 위한 다음 실행 묶음

1. 사용자 승인 후 이번 종현 변경만 소유권/검토를 확인해 **로컬 커밋**으로 고정한다. 푸시하지 않는다. 현재 실제 검증 helper는 소스와 HEAD 바이트 일치를 요구하므로 미커밋 코드를 우회해서 실행하지 않는다.
2. 새 커밋에서 영향 source graph와 SQL119개 정확한 집합(SQL120 파일 포함)의 새 pins를 만들고, 민규 담당 helper의 현재 ABI를 읽기로 재검토한다. 종현이 민규12개 파일을 수정하지 않는다.
3. 이번 실제 읽기에서 Colima `jonghyun-backend100` profile은 **존재·Stopped**, aarch64·2CPU·4GiB·20GiB·docker로 확인됐다. 과거 인계의 ‘이 컴퓨터에 종현 profile 없음’은 현재 관찰과 다르다. 대상별 재시작 승인 전 기동하지 않는다. default·yumidang-minkyu도 Stopped이며 건드리지 않는다.
4. 승인받은 종현 profile만 재시작한 뒤 exact socket/context/VM identity·기존 inventory·시작 여유1GiB/실행768MiB 기준을 확인한다. 기존 자원/데이터/UNKNOWN은 보존하고 새 owned 격리 대상에서만 합성 검증한다. 확인 실패 시 생성·전송을 시작하지 않는다.
5. J01 현재 HTTP/RPC 필터, 변경된 provider 의존 J06 요약 경쟁, J07 성공 증거/피드백/파기, J08 개별 읽음, J09 원 요청 탈퇴 복구의 실제 연결 공백을 기존 책임 하네스로 검증한다. 실제 Auth 신규 합성 발급·DB·Storage 범위를 각 영수증에 분리한다. 실제 모델은 합성으로 유지한다.
6. 실패·응답 유실은 원 요청/원 예약을 보존해 조회로 확인한다. 정리는 생성 영수증이 있는 새 owned 대상만 수행하고 기존 컨테이너 중지·삭제·다른 VM 변경·민규 데이터 재사용은 하지 않는다. 실행 종료·보존·정리 증거 뒤에만 통합을 검토한다.

## 마지막 일괄 확인

새 공급사 자료가 없다는 답과 AI 재시도①는 다시 묻지 않는다. 새 제품 정책 충돌은 발견하지 못했다. 실제 실행 전에 남은 요청은 다음 두 가지다.

- 이번 검토된 종현 변경의 **로컬 커밋** 승인. 원본 민규 브랜치 변경과 푸시는 제외한다.
- 정확한 Colima **jonghyun-backend100 profile 재시작** 및 위 새 owned 합성 격리 검증 진행 승인. 다른 VM/기존 컨테이너 변경·외부 공급사 호출·실회원·운영 배포는 제외한다.

실회원 HOLD, 공급사 조건, 원 Storage39개 바이트·전체 복원, 지원/운영 적용 조건은 기존 미완료로 유지한다. 이번 기록으로 분모28을 줄이거나 100%를 선언하지 않는다.

## 승인 대기 중 실제 조립 계약 검증 보강

승인 응답이 없는 상태에서 커밋·VM 재시작은 하지 않았다. 남은 계약의 증거를 대조해 `tests/functions/jonghyun/20261007-ai-runtime.test.ts`에 실제 서버 조립 함수→공급사 어댑터→원장 RPC의 합성 전달 검사를 추가했다. 제품 코드는 추가 변경하지 않았다.

- 단일·다중 계정 각각에서 형식 실패의 확인 usage만 원 예약에 정산하고, 없거나 잘못된 usage는 UNKNOWN으로 전달한다. 원 계정/원 일자·예약 ID와 공급사 전송1회·정산1회를 검사한다.
- 예약/정산 RPC가 `not_sent` 표시가 있는 일시 오류를 던져도 원장 호출은 자동 재시도하지 않는다. 예약 실패는 공급사 전송0, 정산 실패는 전송1회·원장 호출2회를 유지한다.
- 최초 추가 검사는 단일 계정 fixture에 다중 계정 키/시간대가 남아 정상적으로 disabled되어2개 실패했다. 단일 fixture에서 pool 전용 설정을 제외했다. 기존 테스트의 반환값은 JsonValue를 명시해 Deno의 선택 속성 undefined 추론 오류를 교정했다. 제품 설정 검증을 완화하거나 disabled를 성공으로 바꾸지 않았다.
- 수정 후 기존5개+추가2개 **7/7 PASS·fail0·skip0**, Deno 해당 시험 파일 검사 PASS, 별도 읽기 검토 및 직접 실행도 PASS다. 실제 공급사/Auth/DB/VM은 NOT_RUN이다.
- 원234개 영수증의 파일 해시는 여전히 모두 동일하다. 이번7개 파일은 그20파일에 포함되지 않으므로 현재 로컬 증거는 **21파일·241개 PASS**다. 두 실행의 합계이며 한 번에241개를 실행했다고 표현하지 않는다.
- 보강 영수증은 `/private/tmp/yumidang-jonghyun-20261014-configured-runtime-verification.json`이다. 변경 경로는 기록을 포함해 현재 **15개**이고 전체 소유권 검사는 PASS다.

커밋과 정확한 종현 profile 재시작 승인은 계속 미응답이다. 이전14개 로컬 커밋 요청의 검토 범위에는 위 검증 파일1개가 추가되어 현재15개이며, 운영·외부·실회원·다른 자원 실행 범위는 늘리지 않았다. 승인 후 실제 검증 전에는 최종 변경 목록과 소스 해시를 다시 대조한다.

## 로컬 커밋 승인 수신

사용자가 “추천안은1번이지? 그럼1번ㄱ. 작업할 수 있는 부분은 최대한 작업 해”라고 답했다. 번호1은 로컬 커밋으로 적용한다. 이미 안내한 검증 보강 파일을 포함해 현재15개 변경의 정확한 목록·소유권·기존241개 검증 소스 일치를 확인한 뒤 종현 브랜치에 고정한다. 현재 origin은 민규 로컬 원본이며 푸시하지 않는다.

번호2인 VM 재시작·실제 합성 격리 검증은 이번 답변으로 승인됐다고 해석하지 않는다. source/SQL manifests·기존 실행 helper의 연결 준비 등 VM 없이 가능한 후속 작업을 진행한다. 원본 민규 clone·다른 VM·기존 컨테이너를 변경하지 않는다. 커밋 hash와 후속 manifest는 별도 원문 없는 로컬 영수증에 실제 Git 결과로 기록한다.
