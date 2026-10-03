# 네이버 가입·로그인 구현 인계 — 2026-10-02

작업자 민규. 사용자 “일 시작하자” 요청으로 앞서 제안한 네이버 가입 첫 단위를 구현했다. 사용자는 네이버 개발자 앱이 아직 미등록이라고 확인했다. 작업 공간은 `.worktrees/minkyu-foundation`, 브랜치는 `minkyu/foundation-harness`, 기준 HEAD `58d1efc76b9d7e7b5b96aed7e47062f43652e06f`다.

## 구현과 담당 경계

[하네스](../../minkyu-naver-signup-harness.json)의 coordinator/A/B/C가 정확한28개 파일을 나눴다. 민규 소유만 편집했고 ownership·중복 범위·이전 미커밋29파일 SHA256을 검사했다. 이전 행사 RPC 추가가 있는 user-client는 기존 추가를 유지한 채 네이버/성향 이름만 덧붙였다. 기존 SQL28개·종현 파일·소유권/hook/Git 설정을 변경하지 않았다.

- HTTP signup start/callback/state/complete, 공통 CORS/오류/no-store, 서버 네이버 토큰·프로필 어댑터, 전용 설정 loader.
- private state/verifier hash·시작 Origin·내부 복귀·만료·일회 사용. 코드 교환보다 앞서 검사하며 잘못된 verifier/Origin으로 유효 state를 소비하지 않는다.
- 여성·만19세 이상(KST), 필수 정보·달력 날짜 확인, 네이버 계정별 비공개 별칭·UID 하나, 새로운 부적격 계정은 Auth 생성 안 함. 기존 누락/자격 상실은 정보 보존·제한 세션 제공.
- Auth admin generate_link/verify → 사용자·별칭·역할·session_id → private 예약/auth.sessions 귀속 확인 후 세션 전달. 기존 사용자 JWT 검증·RLS는 유지. 별도 password 세션의 신규 활동 우회를 막는다.
- 실제 보유 사진·JPEG·용량·소유권 확인, 선택 성향20개/40자·MBTI, 프로필/성향/완료 표시 원자 저장, 명시 완료. 기존 사진 교체/최종 사진 삭제 차단 유지.
- 종현 제안 `02_profile_traits.sql`을 검토해 신규 네이버 SQL에 통합. 나머지 제안4개는 미채택. GET/POST service-api `/me/traits`, 사용자 성향/AI 후보 RPC 이름 연결. 로그인한 회원에게만 조회.
- 새 공고·신청·최종 동의/확정 trigger로 자격·가입 완료·등록 Auth 세션·사진 검사. 최종 동행 생성 때 양 당사자의 최신 자격 확인. 기존 읽기/대화/동행 완료 경로를 네이버 확인 전 일괄 차단하지 않음.
- 기존 service-api `/internal/maintenance`의 Deno union undefined 타입 오류는 명시 `Promise<JsonValue>`로 수정, 동작 유지.

API와 브라우저 연결은 [가입 계약](../../../../backend/contracts/signup.md), 인증·RPC는 [실행 계약](../../../../backend/contracts/auth-runtime.md)을 따른다.

## 실제 검증

| 검증 | 결과·범위 |
|---|---|
| Node `tests/functions/minkyu/*.test.ts` | 127 PASS. 기존 공통/Auth/HTTP/검색/설정/행사 클라이언트 + 신규 네이버25검사 |
| Deno | signup/index.ts, service-api/index.ts 및 공급사/브리지 타입 검사 PASS |
| 로컬 PostgreSQL SQL | 6묶음 PASS + rollback PASS. ACL·state/Origin/만료/재사용·계정/세션·사진/성향 원자성·기존 읽기/활동 제한·실제 DB role |
| 실제 로컬 통합 | 150확인 PASS. 실제 Auth generate_link/verify/user·재로그인·refresh·PostgREST·SQL·가입 완료·성향·무료 공고·별도password 우회 차단·기존 정보 누락 제한·신규 부적격 미생성 |
| 네이버 | 합성 응답만. 공식 HTTPS token/profile 외부 실키 호출0, 앱 동의/심사/콜백 NOT_RUN |
| 이미지/화면/Edge | 객체 메타데이터 합성 fixture이며 실제 파일 업로드·브라우저·signup Edge gateway/CORS NOT_RUN |
| 원격/공유 | 원격 DB·배포·커밋·푸시 NOT_RUN |

통합 첫 공고 검사에서는 검증용 공개 지역 `서울 강남구 역삼동`이 기존 DB의 `서울특별시` 형식에 안 맞아400이었다. 합성 fixture를 수정해 재검증했고 서비스 정책/기존 SQL을 바꾸어 통과시키지 않았다.

원래 민규 로컬 DB에서 새 SQL과 검사를 단일 트랜잭션으로 적용·rollback했다. 실제 Auth 통합은 별도 임시 `yumidang-minkyu-naver` 프로젝트(:55621)에 기존 28개와 신규 1개 SQL을 적용해 수행했다. 원래 DB volume은 보존했다. 임시 키를 권한 0600 파일로 전달했고 테스트 출력은 상태/개수만 반환했다.

최종 재검사에서도 Node 127개와 Deno 두 진입점 검사, 하네스 28개 허용 파일·기존 29개 SHA256 보존·변경 범위·언어·`git diff --check`가 통과했다. 독립 읽기 리뷰에서 현재 범위의 중대한 기능·보안·개인정보 문제는 발견되지 않았다. 리뷰는 실제 네이버·브라우저 업로드·gateway 미검증 범위를 유지한다.

임시 프로젝트는 `stop --no-backup`으로 종료하고 합성 데이터 볼륨을 정리했다. 임시 로컬 키 파일을 삭제했으며 `yumidang-minkyu` Colima를 작업 전의 종료 상태로 복원했다. 원래 민규 DB의 보존 볼륨과 작업 파일은 유지했다. 커밋·푸시·배포는 실행하지 않았다.

## 재현과 한계

- `node --test tests/functions/minkyu/*.test.ts`
- `deno check --no-remote backend/supabase/functions/signup/index.ts backend/supabase/functions/service-api/index.ts`
- 원래 민규 전용 로컬 DB가 실행 중일 때 `python3 -B tools/local/run_naver_database_tests.py --run` (새 SQL 미적용 상태 필요, 적용 후 rollback).
- 실제 Auth 검사는 초기화된 별도 `yumidang-minkyu-naver` 프로젝트와 :55621, 지정 context/container·현재 SQL을 준비하고 CLI status JSON을0600 임시파일로 저장한 뒤 `YUMIDANG_NAVER_LOCAL_CONFIG=임시파일 node tests/integration/minkyu/naver_signup_local.ts`로 실행한다. Auth 계정0개가 아니면 변경 전 거절한다. 전용 합성 fixture만 쓴다.

Auth 내부 auth.sessions·generate_link REST 평면 응답에 의존한다. 공급사/세션 브리지는 실제 설치 Auth에서 검증했지만 Auth 버전 변경 시 다시 확인한다. 내부 .invalid 이메일은 로그인 구현용 별칭이며 실제 이메일 인증 기능/실명 동일인 보장이 아니다. 실명·실제 이메일로 과거 계정을 자동 연결하지 않는다.

state TTL은 환경 필수이며 운영 기본값을 임의 선택하지 않았다. state 저장의 운영 정리/보관·요청량 제한은 별도 운영 검토다. 실제 네이버 앱, 기존 계정 확인/전환, 프론트 callback·세션·이미지 업로드, 운영 Auth/gateway/CORS·Secrets·배포는 후속이다. 기존 gateway CORS PARTIAL을 이번 함수 factory의 CORS PASS로 해결됐다고 표시하지 않는다.

## 종현·프론트 연결 사항

종현 파일은 수정하지 않았다. 성향 저장소·조회/후보 RPC를 신규 SQL에 채택했으므로 기존 제안2번을 별도 중복 생성하지 않는다. 검색/AI용 공통 타입/관측의 네이버 전용 표현 반영은 각 담당이 자기 파일에서 확인한다. 나머지 AI 예산/요약/작업/행사 공통 연결 요청은 유지한다.

프론트 담당은 [가입 계약](../../../../backend/contracts/signup.md)의 proof 생성·callback POST·Supabase setSession·사진 업로드·명시 complete 흐름을 연결한다. 실제 API·화면은 본 인계의 로컬 확인과 구분한다.
