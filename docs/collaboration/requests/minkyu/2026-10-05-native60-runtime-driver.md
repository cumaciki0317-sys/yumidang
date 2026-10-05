# native60 runtime cleanup 검증 후보

## 상태와 소유 경계

작업자 민규. main `tests/integration/minkyu/member_cleanup_native_local.ts`의 정확 snapshot SHA `d9d4a9748c4e90602d7ca54698ee892a87d9276de2c0e5a000d7738b771c3234`를 독립 worktree 같은 경로에 복사한 뒤 후보를 작성했다. 대상 driver와 이 문서의 소유권 검사를 통과했다. main/J/SQL/기존 adapter 및 DB ports는 수정하지 않았다. 실제 driver 실행·DB 연결·쓰기·권한 변경은 NOT_RUN이며 native60 적용과 별도 GO를 기다린다.

기존55 관찰 모드, native56 기본9그룹 및 verify-rejoin12그룹 경로는 유지한다. native60은 새로운 명시 모드이며 기존56의 실제60초 task 만료/ACK 재사용 검증을60에서 실행한 것처럼 표시하지 않는다. 과거 결과 artifact/SHA는 그대로 보존한다.

## 명시 native60 실행 계약

승인 이후 사용할 인수는 기존 고정 private status 파일 뒤에 `--native60-approved --runtime-batch /private/tmp/yumidang-policy60-reviewed-xze3cqci/prepared/migration-manifest.json`이다.60 승인 플래그만 주거나56 모드에 runtime-batch를 주면 거절한다. 기존 모드의 인수와 rejoin56 제한은 바꾸지 않는다.

manifest는 고정 경로·일반 파일·소유자·private 부모 디렉터리와 고정 SHA `129cb1f10baf7ca4a225d3e7c7f7de34928de25d1ced9d1a282b7af9ad0e685a`를 요구한다. READY/current_policy_gateway/SQL NOT_RUN·정확60개를 검사하며 각 경로/버전/SHA와 main의 실제 SQL 바이트를 비교한다. DB의 정확60개 version 배열·최신40100도 비교한다. 이 source artifact는 gateway 준비 증거이지 native60 적용 증거가 아니다.

API56531·drift 컨테이너·DBpostgres·private status0600/parent0700·빈 회원/파일/작업·guardfalse·6RPC 및 schedule/notify helper 폐쇄를 먼저 검사한다. 추가 historical/신고/안전사건/보관 관계도 합성 자료0을 요구한다. 전역 역할의 비밀 없는 속성/멤버십과 임시6RPC의 owner/ACL을 메모리에 보존하고 finally에서 동일성을 확인한다. 역할 생성이나 멤버십 변경은 없다.

## 실제 연결할 경로

합성 회원의 두 실제 사진은 기존 경로처럼 회원JWT canonical UUID.jpg와 service API legacy 이름으로 준비한다. legacy 업로드는 일반 회원 INSERT RLS 지원 증거가 아니다. guardfalse에서 최초 retire 거절·task0·회원/사진 접근 유지를 검증한 뒤, 승인된 격리 환경에서 owner가 guardtrue와 cleanup5개+budget1개 service EXECUTE를 COMMIT한다. COMMIT 응답이 소실돼도 finally 복원을 시도하도록60 모드는 변경 시도 전에 opened를 표시한다. PostgREST schema reload NOTIFY도 같은 COMMIT에 포함한다.

최초 실제 회원JWT retire로3작업을 만들고 전역180초를 획득한다. 기존 토큰/DB 만료/remainingMs/보수 host mapping 검사는 유지한다.60 runtime의 실제 실행 budget은 해당 수동 계산값 대신 `createRuntimeHandler`가 조립한 budget reader의 실제 REST 결과를 사용한다.

main과 동일 module graph의 `createRuntimeHandler`를 import하고 `{memberCleanup:true,memberCleanupExecution:{maxExecutionMs:120000}}`로 조립한다.120초는 이번 합성 정상 연결 시험에만 사용하는 trusted 로컬 상한이며 운영 timeout 기본값이나75초 caller와의 안전한 연결을 확정한 값이 아니다.65초 경계는 기존 모형 회귀와 분리한다. 세 작업이 시작되기 전에 실제 잔여60초가 부족해 정상 yield하면 ran<3으로 이번 전체 연결 기대가 실패할 수 있으며 실패 artifact를 보존하고 lease를 연장하거나 자동 재실행하지 않는다. 키는 메모리의 local 자동 설정만 사용한다. 내부 Request를 handler에 직접 전달하되 upstream은 실제 localhost REST/Auth/Storage다.

기본 runtime의 내부 경로404, 잘못된 내부 비밀403·upstream0을 확인한다. 성공 요청은 budget REST가 첫 호출이고 기존5개 RPC가 실제 사용되는지 검사한다. Storage exact info/GET/DELETE와 Auth exact UID만 허용하며 각 삭제1회, 순서 Storage/Storage/Auth, Auth DELETE 직전 Storage 작업2개 completed 및 실제 backend파일0을 요구한다. 내부 응답은 `{status:ran,claimed:3,succeeded:3}`, 실제 DB3작업 completed·withdrawal completed·Auth0·파일0이어야 한다.

추적은 RPC 이름·삭제 종류·횟수·소스 SHA·안전한 실패 분류만 결과에 남긴다. 신규60 결과에서 회원 UUID/사진 경로는 제거한다. 키·원문·토큰을 출력하지 않는다. 기존55/56 private fixture 추적 방식은 보존한다. cleanup 실패 시에는 결과를 FAIL로 남기고 DB 읽기를 통해 잔여 합성 fixture를 확인해야 하며 자동 재실행하지 않는다.

finally는 fetch를 원래 함수로 복원하고 guardfalse·임시6RPC ACL을 COMMIT 복원한다. 전역 점유를 정상 release하고 관계별 합성 행·사진·Auth를 기존 정확 fixture 경로로 청소한다. 최종 파일0·회원/작업0·추가 관계0·6RPC effective ACL0 및 owner/ACL baseline·역할 baseline·60 이력 불변·global idle을 각각 확인한다. 새로운 결과는 native60 private artifact에 저장한다.

## 검증 범위와 남는 한계

`deno check`로 후보 driver의 타입 검사를 통과했다. 정적 대조에서 기존56의 wronglease·실제60초 만료·기존 durable receipt·재가입 검증 분기는 유지했다. 실제60 driver 실행은 아직 하지 않았다.

이 검증은 in-process runtime Request → 실제 native REST/provider 연결이며 호스팅 Edge 서비스나 J 상주 queue/LISTEN 호출은 아니다. 실제 provider 처리 중 abort/응답 소실/원격 종료와 caller75초 finally release 문제를 해결했다고 주장하지 않는다. 관련 timeout 연결 요청은 별도 선행조건으로 유지한다.

추가 정적 검사에서 native60Relations의26개 테이블 이름은 main 마이그레이션의 CREATE TABLE 소스에 모두 존재했다. 실제 native regclass catalog 조회는 실행하지 않았다. 원래 main driver d9d4 snapshot 및 main SQL/서비스 원본 바이트는 이 작업에서 변경하지 않았다.
