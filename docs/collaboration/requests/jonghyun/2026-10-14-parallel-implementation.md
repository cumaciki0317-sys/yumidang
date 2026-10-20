<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **AI 선택 동의:** AI 탐색은 첫 사용 동의·거절 시 일반 검색 유지. 후기 AI는 가입 시 열람/내 프로필 생성·노출/작성 후기 활용의 세 선택 항목·기본 미선택이며 전체 동의 편의 기능과 독립 철회를 제공한다. 기존 테스트 계정 간주와 실회원 동의 증거를 구분한다.
> **공급사·비용:** 포텐스닷 공급사 회신은 수신됐고 교육·프로토타입 조건과 보안 우려로 실서비스 대체 API를 권고했다. Gemini는 종현 테스트 프로젝트·월50,000원 사용중단 예산·합성3건 검증 상태이며 최종 청구 상한 보장/운영 연결은 별도다. 대표 유미 계정 전환은 회의 때 확인한다. 포텐스닷320만 기술 토큰과 Gemini 원화 예산을 혼합하지 않는다. 실회원 원문 전송 HOLD.
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# 종현 병렬 구현·검증 기록 — 2026-10-14

> 최신 상태: 사용자 후속 한시 재배정 승인에 따른 실제 로컬 연결 검증·새 자원 정리·두 도구 원본 복구·민규 담당 복귀를 마쳤다. [최종 실행 결과](2026-10-14-temporary-validation-result.md)를 따른다. 아래 미실행/대기 표현은 당시 기록이며 전체 진행률은79%(22/28)다.

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

## 로컬 커밋 이후 허용된 준비 보완

- 승인받은15개 변경을 `7940643d0cfe893669ba964d6da7012693801bb0`으로 고정했다. staged 소유권과 hook이 통과했고 검사 당시234개+별도7개 파일 SHA가 커밋 바이트와 일치한다. 원본 민규 HEAD는831ead2이며 변경하지 않았다. 푸시하지 않았다.
- 커밋 기준 AI product50·signed helper 포함57·summary45·observer193개 source pins를 만들었다. `/private/tmp/yumidang-jonghyun-20261014-committed-source-pins.json`은 소스 고정 증거이며 실행 권한·실제 대상 READY를 뜻하지 않는다.
- 기존 `prepare_database.py`로 정식 SQL119개와 이름/포트만 바꾼 설정 사본을 실제 시스템 임시 폴더에 준비했다. 첫 `/private/tmp` 출력은 도구의 시스템 임시 경로 검사에서 거절돼 SQL/기동0이었다. 제한을 완화하지 않고 OS 임시 폴더를 사용했다. 위치는 `/private/tmp/yumidang-jonghyun-20261014-prepared-location.json`에 기록했다. 실제 port availability·inventory·VM·DB·Auth는 NOT_VERIFIED/NOT_RUN이며 owned ID 영수증을 가상 생성하지 않았다.
- Docker context metadata 읽기는 exit1이었다. daemon 연락 없이 metadata만 시도했으며 `expectedHostMatches:false`를 READY로 바꾸지 않았다. 실제 VM 재시작 후 context/socket과 전체 기존 inventory 확인이 필요하다.
- 현재 signed helper는 새 Supabase 정식 적용 이력 경로를 사용할 수 있어 민규12개 수정 없이 재사용 가능하다. native 원본 lineage가 있는 경우 별도의 고정 원본/영수증 검사를 요구한다. 해당 민규 native 원본 경로는 이 컴퓨터에 없어 새 빈 DB로 대체하지 않는다. 실제 Auth 발급은 새4대상 identity·현재 소스 pins·private 검토 객체·생성/정리 범위를 갖춘 원 발급 증거와 연결해야 한다.

### J01 실제 연결 검증 준비 코드

기존 `tests/integration/jonghyun/events-rest.mjs`와 책임 `event-sync.test.mjs`를 보완했다. 과거 민규 driver의 source/socket/private 경로를 종현 대상으로 임의 교체하지 않았다. 실제 callback을 제공하는 ROOT의 검토·관측 책임은 남는다.

- 기본 CLI와 `--check-j01`은 VM/대상/자격증명을 생성하지 않고 실행 NOT_RUN·ready:false다. 실제 실행 CLI `--run-j01`은 제공하지 않는다. 기존 55421/55422 REST 시험은 `--legacy-rest` 명시 선택으로 보존하며 DB host도 정확한 loopback으로 제한한다.
- 새 입력은 canonical root·HEAD·현재 source 전체 import closure와 HEAD blob SHA·migration 전체 set/SHA를 대조한다. code/target/Auth 입력은 복사·동결하며 변경 전후와 정리 직전에 대상 identity를 다시 확인한다.
- 대상은 기존 준비 ABI의 새 `jonghyun-backend100-8자리hex` project와 서로 다른 DB/Auth/REST ID를 요구한다. 실제 존재 여부는 root의 관측 경계가 확인하며, 입력 형식 통과만으로 실제 확인을 주장하지 않는다.
- 준비한 검증 흐름은 합성17행·원 Auth subject·모바일 서비스→로컬 TLS bridge→runtime→Auth/REST/DB의 세 필터/limit10/커서/10000자 가격/숨김/잘못된JWT 사례다. fixture SQL은 아직 실행하지 않았다. 공급사·모델·실회원·화면 검증을 포함하지 않는다.
- JWT metadata 검사를 서명 증거와 분리하고 실제 GoTrue subject 응답을 대조한다. table 집합을 SQL catalog와 비교하며 행 수·해시·catalog·roles·기존 UNKNOWN을 확인한다. 같은 runId의 정리 및 기준과의 일치를 요구한다.
- callback 검사 결과는 `ROOT_TYPED_BOUNDARY_CHECKS_ONLY`·`ROOT_ATTESTATION_REQUIRED`이며 actualAuth/Db는 `NOT_VERIFIED_BY_HARNESS`, wholeBaselineRestored는false다. 현재 실제 custody callback·대상 발급·live 실행은 남는다. 이 결과를 실제 기능 완료로 계산하지 않는다.

ROOT 최신 통합21파일 **248/248 PASS**, fail0·skip0·cancelled0, 검사 전후 소스 SHA 일치. 기존241개와 중복이므로 합산하지 않는다. 원문 없는 영수증은 `/private/tmp/yumidang-jonghyun-20261014-j01-preparation-verification.json`, stdout SHA는 `f38ce5cf7f99b46fbe0a23c31592f1cd7e0fb40e7b987f80f43e50f5ee970416`이다. driver syntax·소유권·diff 검사도 통과했다. 초기 SQL 문자열의 from을 import로 오인한 준비 검사 실패는 native module parser(평가0)와 type-only import 보완으로 교정했다.

후속2개 검증 파일과 이 기록은 같은 종현 업무의 승인된 로컬 커밋 범위에서 고정한다. 실행 시에는 최신 커밋으로 source manifest를 다시 발급한다. VM 재시작·정확한 새 합성 검증 대상/fixture 쓰기·정리는 별도2번 승인이 필요하며, 로컬 준비 코드·사본 존재를 그 승인으로 해석하지 않는다. 전체79%(22/28) 유지.

## 실제 실행 전 J01 준비 계약 호환 보완

첫 후속 준비 커밋은 `f4ff817132e90dba7907208e76ba211e5e46ab15`다. 승인 대기 중 기존 실행 도구와 입력 계약을 읽기로 대조해 두 불일치를 발견했다. 추가 제품 정책을 확정하거나 실제 자원을 실행하지 않고 준비 계약을 교정했다.

- 컨테이너 `image`는 기존 `isolated_prepared_target`·`ReviewedSignedProvisioning`·`SignedRunner`가 실제 Docker에서 관측하는 `.Image` ID인 `sha256:64hex`로 통일했다. registry `repository@sha256`·tag를 실제 Image ID로 대신하지 않는다. 이전 J01 준비 코드의 RepoDigest 요구는 이 교정으로 대체한다.
- 기존 `provision_signed_accounts`는 합성 Auth6명을 발급하며 profile의 active episode identity는 NULL이다. J01의 `createSyntheticAuth(target,2)`는 이 발급 계약과 맞지 않아 `readSyntheticMembers(target,2)`로 바꿨다. 이 callback은 root가 미리 준비한2명의 원 userId/JWT/합성 identityId를 읽기만 하며 생성·로그인·갱신·삭제를 수행하지 않는다.
- 향후 root 실행 순서는 원 영수증을 보존하는 Auth6명 발급 → 선택2명 합성 identity 준비 → J01 baseline/읽기/행사17행 검증 → J01 자기 행사·숨김 행 정리 → root identity2 원복 및 Auth6 정리 → outer baseline 대조다. J01은 전체6명 정리 범위를 소유하지 않으며 `wholeBaselineRestored:false`를 유지한다.
- 합성 identity 준비는 기존 `tests/database/minkyu/event_detail_projection.sql` 방식을 읽기로 확인했다. 자기 고유 subject의 naver_accounts는 user_id=NULL·verification_status=information_required로 두고 trigger가 만든 identity UUID만 사용한다. 선택2명의 원 active episode ID·NULL 상태·행 해시를 확인한 뒤 연결하고 원복한다. qualified·가입 완료·네이버 세션·실제 네이버 검증 증거를 만들지 않는다. 실제 SQL/callback 조립·CAS·생성/정리 영수증은 승인된 새 대상에서 다음 단계로 남는다.
- identity 원복과 자기 참조 정리가 끝난 뒤에만 기존 `unlink_profile` 경로를 사용한다. 알 수 없는 변경이나 타 참조는 임의 삭제하지 않는다. 민규 helper·SQL·성호 파일은 편집하지 않았다.

영향 범위인 event-sync 책임 검사 **21/21 PASS**(fail0·skip0·cancelled0), driver syntax·diff 검사 PASS다. RepoDigest/tag 거절과 기존 Auth 생성 callback을 실행0으로 거절하는 회귀를 기존 책임 시험에 보완했다. 검사 전후 두 파일 SHA는 동일하다. 영수증은 `/private/tmp/yumidang-jonghyun-20261014-j01-abi-verification.json`이다. 앞선248개 통합 검사는 당시 소스의 검증 이력으로 보존하며 이번21개와 합산하지 않는다.

동일한 사용자1번 로컬 커밋 승인 범위에서 이 준비 보완을 고정한다. 이후 최신 HEAD·source manifest를 새로 대조하며 오래된65개 source pin을 실행에 재사용하지 않는다. 대상 Colima profile은 다시 읽기로 확인해 Stopped다. VM② 승인 질문은 그대로 유지하며 실제 Auth·DB·공급사·VM 실행은0, 전체 **79%(22/28)** 유지다.

## VM② 승인 수신과 실제 사전검사

사용자가 **② VM 재시작과 새 합성 격리 검증을 승인**했다. 대상은 jonghyun-backend100·2CPU·4GiB·20GiB이며 다른 VM·기존 컨테이너 변경·실회원·실제 공급사·운영·푸시는 제외한다. 이 승인과 별개로 기존 소유권을 유지한다.

- `colima start --profile jonghyun-backend100 --cpus 2 --memory 4 --disk 20 --runtime docker --activate=false`가 실제 완료됐다. 해당 VM만 Running이고 default·yumidang-minkyu는 Stopped다. Docker 활성 문맥을 바꾸지 않았다.
- 정확한 종현 Docker 소켓·문맥 일치를 확인했다. 실제 VM 여유 메모리는 관찰 시점3,218,924KiB였다. 시작 뒤 기존 프로젝트077eabaa의6개 컨테이너가 실행 중이고 사용자 정의 네트워크1개·볼륨2개가 존재했다. 기존 자원에 별도 시작·중지·삭제·SQL·Storage 명령을 실행하지 않았다. 시작 전 VM 내부 상태는 미관측이며 VM 시작 이전과 동일하다고 주장하지 않는다.
- 기준 자료는 `/private/tmp/yumidang-jonghyun-20261014-vm-baseline.json`에 보존했다. 뒤의 두 번째 메타데이터 읽기에서도 같은6개 ID를 확인했고 실제 Image ID·설정/호스트 설정/저장소 연결·네트워크/볼륨 해시를 새 비공개 준비 폴더의 `protected-resource-baseline.json`에 기록했다. 설정 원문·키를 출력하지 않았다. 이 메타데이터 확인은 기존 저장 바이트 전체 검증이 아니다.
- 새 후보 프로젝트ccad00b8의 정식 SQL119개·이름/포트만 바꾼 설정을 운영체제 임시 폴더에 준비했다. loopback 포트 묶음60021의 당시 사용 가능 여부를 확인했으나 예약하지 않았다. 첫 sandbox 포트 확인은 실행 권한 제한으로 실패해 대상을 만들지 않았고, 승인 범위의 실제 확인에서 다시 확인했다. 경로와 결과는 `/private/tmp/yumidang-jonghyun-20261014-live-preflight-receipt.json`에 있다.
- 실제 기존 목록6/1을 그대로 넣은 일반 준비 검사는 `ISOLATED_INTENT_INVALID`로 거절했다. 인증 준비 검사는 운영체제 임시 경로와 `/private/tmp`만 허용하는 비공개 경로 계약이 달라 `SIGNED_PRIVATE_DIRECTORY`로 먼저 거절했다. 코드에는 그 뒤에서도 기존 목록을 거절하는 `SIGNED_PREPARED_AUTHORITY` 조건이 있다. 도달하지 않은 오류를 실제 실행 결과로 기록하지 않는다.
- `tools/local/run_database_tests.py`와 `tests/integration/jonghyun/isolated_ai_contracts.py` 수정 권한은 민규여서 종현 검사가 거절됐다. 빈 목록 허위 기록·기존 자원 중지/삭제·검사 우회·actor 변경은 하지 않았다. 신규 컨테이너·새 Auth·실제 SQL/Storage·공급사 실행은0이다.

위 두 도구에 필요한 기존 자원 보존 계약과 비공개 경로 호환안을 [민규 지원 요청](2026-10-14-live-validation-guard-conflict.md)에 정리했다. 민규의 직접 지원 또는 정식 소유권 재배정 경로는 사용자의 마지막 일괄 확인으로 남긴다. VM② 승인을 다시 요청하지 않는다. 새 실제 검증은 해당 지원 후 이미 받은② 범위에서 이어간다. 전체 **79%(22/28)** 유지다.

## 최신 담당 결정 — 민규 직접 지원

사용자는 **① 민규가 두 도구 수정**을 선택했다. 지원 파일2개와 소유권은 민규 담당으로 유지한다. 위의 미확정 수행 경로는 이 답변으로 확정됐으며 같은 선택을 다시 묻지 않는다.

민규 원본의 두 지원 파일·소유권을 현재 종현 clone과 읽기로 비교했으며 아직 동일하다. 수정본 도착 전 종현이 대신 편집하거나 기존 자원을 없애는 우회는 하지 않는다. 지원 요청 문서에 민규용 시작 문구와 전달 시 확인할 커밋 SHA·변경 경로·회귀 결과·계약 버전을 적었다. 외부 메시지와 푸시는 실행하지 않았다.

수정본 인계 후 종현은 정식 소유권·두 지원 경로·현재 HEAD 바이트를 확인하고 source pins와 새 준비 자료를 다시 만든다. 기존6개 실제 관찰 및 새 대상과의 분리를 대조한 뒤 이미 승인된② 새 합성 실제 연결 검증을 이어간다. 현재 새 대상/Auth/SQL/Storage 검증은 NOT_RUN이며 전체 **79%(22/28)**다.
