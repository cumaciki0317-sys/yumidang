# 민규 순차 백엔드 작업

사용자의 “순서대로 진행해”에 따라 완료·후기 → 확정 후 일정 변경·취소 → 종현 공통 연결 순서로 구현·검증한다. 작업자는 `minkyu`, 전용 worktree는 `.worktrees/minkyu-foundation`, 브랜치는 `minkyu/foundation-harness`다. [하네스](../../minkyu-ordered-backend-harness.json)의 정확한 허용 경로와 담당별 단독 편집을 따른다. 커밋·푸시·원격 DB 적용·배포는 하지 않는다.

## 1. 완료·후기

- 개인 완료 확인 후 선제 후기 제출, 실제 완료 전 비공개, 실제 완료+7일 작성 기한과 +24시간 한쪽 공개를 분리했다. 실제 완료 후 양쪽 후기는 즉시 공개한다.
- 상대 열람·공개 프로필·칭찬·요약 입력에 같은 공개 적격성을 적용한다. 명시적 숨김과 공개 후보 없는 과거 후기는 보존한다.
- 정책 칭찬 6개와 `GET /reviews/praises`, 공개 후기 응답의 `completedCount`를 연결했다. 당도 점수 산식은 미정이므로 점수 생성은 하지 않았다.
- Node 단위 검사 154개 PASS. 독립 읽기 검토에서 구체적 추가 결함을 발견하지 못했다. 실제 DB 정책 검사 10묶음과 rollback PASS.
- 기존 로컬 DB는 정식 이력 27개였고 최신 HEAD는 28개다. 최초 검사 P0004는 완료 예약 전제 부재로 실패했다. runner가 누락된 정식 HEAD28 SQL을 같은 트랜잭션에서만 보충한 후 3개 pending SQL과 정책 검사를 실행·롤백한다. 기존 이력·함수·객체·cron 지문 및 합성 자료 제거를 확인했다. 기존 볼륨은 영구 변경하지 않았다.
- 별도 임시 프로젝트에서 실제 Auth·PostgREST·HTTP handler 통합 151확인 PASS. 네이버 자격과 사진 객체 메타데이터는 합성이다. 시간 경계 fixture의 알림 시각 변경에 연결 이의 기한을 누락한 첫 실행을 수정한 뒤 재검증했다. 저장소 컨테이너 unhealthy로 첫 시작이 실패했으며 저장소 API를 제외한 환경을 사용했다. 실제 사진 업로드·네이버 OAuth·브라우저·Edge gateway·원격 DB 적용은 NOT_RUN이다.

## 2. 확정 후 일정 변경·취소

HTTP 경로와 고정 RPC를 연결했으며 새 15개를 포함한 Node169개·Deno 서비스 타입 검사가 통과했다. 기존 후기10묶음과 새 일정/취소8묶음, 총18개 실제 DB 검사와 rollback PASS. 앞 단계를 포함한 실제 Auth·PostgREST·HTTP handler 통합315확인 PASS. 독립 DB 경합3개(동시 제안, 취소 대 수락, 같은 회원의 겹치는 변경 수락)와 합성 자료 정리 PASS.

- 제안·상대 수락/거절·시작 기한 만료·버전별 재시도를 분리한다. 수락 전에 기존 일정은 유지하며 양쪽 확정 일정 충돌을 다시 검사한다. 동시 대기 제안 한 개는 경합 방지 장치다.
- 수락 때 기존 공고 일정과 자동 완료 예약의 due/generation을 원자 갱신한다. 기존 최종 동의 근거는 바꾸지 않고 변경 동의 이력을 보존한다.
- 시작 전 사유 취소와 알림을 연결하고 예약을 삭제한다. 상대 실명·정확한 주소는 다시 숨기며 대화는 읽기 전용으로 보존한다. 미검증 기존 회원도 기존 약속 조회·취소는 가능하고 새 일정 제안/수락은 제한한다.
- 시작 이후 일반 취소는 거절하며 중단·불발 신고/운영 판단의 팀 검토 범위를 임의 구현하지 않았다. 취소·신고로 노쇼나 제재를 확정하지 않는다.

## 3. 종현 공통 연결

[R1~R7 요청](../jonghyun/2026-09-29-claude-minkyu-requests.md)의 기존 구현과 계약을 재사용했다. 성향 제안02는 네이버 단계에서 채택되어 중복 생성하지 않는다. 행사 저장소는 기존 `source_events`를 유일 실제 저장소로 유지하고 typed `events` view 및 현재 RPC로 연결한다. 기존 pending SQL·ID·원문 record를 삭제하거나 옮기지 않는다.

| 요청 | 구현과 현재 경계 |
|---|---|
| R1 | 예산 원장·예약/정산, 요약 실패 횟수/종결·점유/중간 저장·원자 게시, 현재 행사 저장/목록/필터를 새 migration으로 채택. 기존 성향 저장소 재사용 |
| R2 | user/public/internal client의 고정 RPC 허용 목록 연결. 미허용 요청 차단 유지 |
| R3 | `GET /events`, `GET /events/filters`, 회원 `GET /profiles/:id`와 공개 프로필 성향 연결. `/me` 응답 보존. 함수별 자체 인증에 맞춰 config 등록. 일일 실행은 등록 명세 준비, 실등록 NOT_RUN |
| R4 | 환경 변수 이름·빈 양식 동기화. 선택 secret/service-role 값이 빈 문자열이면 미설정으로 처리하여 공개 기능을 일괄503으로 막지 않음. 공백/줄바꿈 입력과 필수 공통값 검증 유지 |
| R5 | 작업·요약·행사·핵심 DB·서비스 API 계약 동기화 |
| R6 | 앞선 네이버 단계의 반환 타입 명시를 보존하고 이번 Deno 검사 확인 |
| R7 | gateway CORS 기존 PARTIAL 보존. handler의 Origin 검사를 gateway 검증 성공으로 설명하지 않음. 운영 gateway 정책/실재현·배포는 별도 |

현재 행사 목록 기본은 `new_this_week`다. 진행 중 포함 선택은 `overlapping`과 선택 기간으로 표현하며 `ongoingOnly=true`는 진행 중만 남기는 기술 필터다. HTTP `limit`은 1..50을 명시 입력한다. 새 공개 목록/필터는 종현 reader가 지원하는 provider 형식만 반환하고, underscore·33자 이상인 과거 provider는 v1 조회와 원본 저장을 보존한다. 이 호환 경계를 문서화하고 실제 v1 저장→조회 보존/신규 목록200 회귀를 검증했다.

새15개 포함 Node184개 PASS, Deno7개 진입점 PASS. 수정한 native 통합 도구의 Deno 검사와 실제 Auth·PostgREST·HTTP handler 누적413확인 PASS. 합성 회원, 예산 예약/정산, 점유 작업의 부족 자료 종결, 공개 프로필 관계별 이름·성향, `/me` 유지, 행사 null URL·페이지/cursor·필터·취소·legacy 보존, 모델 미설정 시 기존 후기 공개를 확인했다. 외부 네이버·모델·행사 제공처를 실제 호출한 증거는 아니다.

독립 읽기 검토가 발견한 legacy provider와 신규 reader 불일치를 수정한 뒤 재검증했다. 추가 구체적 차단 결함은 찾지 못했다. 실제 원본 DB 누적26묶음과 rollback·기존27이력/객체/함수/cron 보존 PASS. 누락된 HEAD28과 pending7개를 검사 트랜잭션에서만 적용하고 되돌렸다. legacy provider 회귀도 이 26묶음에 포함한다.

제안 SQL을 추가하지 않고 기존 종현 원본 SQL5개를 각각 분리 재생했다. `ai_budget.sql`, `review_summary_worker.sql`, `event_filter_values.sql`은 PASS. `profile_traits.sql`은 익명 실행권한 없음42501과 원본 기대28000의 차이로 FAIL, `events.sql`은 물리 table RLS 기대와 현재 typed view 차이로 FAIL이다. 각 재생의 누적정책26은 통과했지만 26×5로 검사 수를 부풀리지 않는다. 원본 파일의 HEAD 동일성과 rollback/보존을 확인했고 상대 파일은 수정하지 않았다. 독립 Phase3 경합4개와 cleanup PASS: 원자 예산 한도, 게시 후 비공개 무효화, 비공개 후 stale 게시 차단, 역순 행사 batch·stale·dedupe를 확인했다. 첫 경합 실행은 returns void인 재공개 fixture를 JSON 반환 helper로 호출해 실패했고 해당 테스트만 수정하여 전체 재검증했다. 제품 SQL 변경은 없었다. Phase2 경합3개를 포함한 독립 경합은 총7개 PASS이며, 마지막 회원·프로필·작업·예산·행사·체크포인트·게시 표식 합계0을 확인했다.

실제 네이버 앱 등록·AI 외부 호출·운영 한도·Edge gateway·원격 배포는 로컬 구현 검증과 구분한다. 실제 매일 작업 등록·정시 실행은 운영 수치·대상이 미확정이라 NOT_RUN이며 [등록 명세](../../../../backend/contracts/daily-jobs.md)를 준비했다.

### 종현 검사 갱신 요청

종현 소유의 아래 HTTP 검사3개는 이전 “공통 RPC 허용 목록 미연결” 상태를 기대한다. 기존 세 suite를 실행한 결과 27개 중24개 PASS,3개 FAIL이다. 원본 SQL5개는3개 PASS/2개 FAIL이며 SQLSTATE·저장 구조 차이는 아래에 구분한다. 해당 파일을 직접 수정하지 않았다.

| 종현 수정 대상 | 이전 기대와 현재 결과 | 새 검증 근거 |
|---|---|---|
| `tests/functions/jonghyun/ai-chat-http.test.mjs:169` | Auth 조회 뒤 traits RPC 전송이 차단된다는 기대. 현재 `get_my_profile_traits`가 전송됨 | 민규 common 검사에서 같은 runtime+실제 user/internal client의 가상 전송, 성향·예산 예약/정산·검색 no_results 확인 |
| `tests/functions/jonghyun/event-sync.test.mjs:111` | upsert 미허용500 기대. 현재 전송을 허용하여 fixture의 DB500을 upstream503으로 반환 | 같은 runtime+실제 internal client, 합성 HTTPS 제공처→upsert 성공·집계 확인 |
| `tests/functions/jonghyun/review-summary-worker.test.mjs:103` | `DB_RPC_NOT_ALLOWED` 기대. 현재 허용된 전송에서 fixture의 network 실패가 `DB_RPC_UNAVAILABLE`로 변환 | 같은 runtime+실제 internal client, worker 필수RPC probe→claim idle 확인 |
| `tests/database/jonghyun/profile_traits.sql` | 익명 `get_post_author_traits` 호출의28000 기대. 현재 익명 EXECUTE를 부여하지 않아42501로 거절 | 민규 commonSQL의 member 성향/RLS/권한과 native 공개 프로필/기존 me 유지 확인 |
| `tests/database/jonghyun/events.sql` | `private.events` 물리 table의 RLS=true 기대. 현재 기존 `source_events` RLS table + `events` typed view | 민규 commonSQL의 단일 물리 저장소/RLS/view, 동일 시각 stale·역할·신규/legacy 보존과 native HTTP 확인 |

완료 조건은 종현이 자기 브랜치에서 실패 fixture를 현재 전송 실패·SQL 권한·단일 저장소 계약에 맞춰 갱신하고 세 suite와 원본 SQL5개를 다시 실행하는 것이다. 성공으로 기대값만 바꾸지 말고 실제 요청명·인수·호출 수와 실패 변환도 검증한다. 민규의 새 검사 파일은 `tests/functions/minkyu/common_connections.test.ts`이며 실제 외부 모델·행사 제공사를 호출한 증거가 아니다.


## 최종 검증·환경 정리

- 순차 구현의 최종 Node184개, Deno7진입점 및 native 도구 타입 검사 PASS. 실제 누적 DB정책26묶음+rollback, Auth·PostgREST·HTTP handler413확인, 독립 경합7개 PASS다. 단위/DB/통합의 숫자는 서로 다른 확인 범위이며 서비스 전체 완료율이 아니다.
- 임시 프로젝트는 정식 HEAD28개와 선정 pending7개, 총35개 migration을 처음부터 재생했다. 과거 행사 SQL의 이름에 공백이 있는 사본은 재생 대상에서 제외하고 원본·사본의 소스 해시는 모두 보존했다.
- 종현의 기존 HTTP27개 중24PASS/3FAIL, 원본 SQL5개 중3PASS/2FAIL은 위 갱신 요청으로 남았다. 현재 연결을 원본 전체 검사 PASS로 설명하지 않는다.
- 하네스 허용32개와 보존76개 SHA256, actor/branch/HEAD, 소유권·한국어/영어·diff 검사를 확인한다. 커밋·푸시·원격 적용·배포는 하지 않았다.
- 환경 정리 PASS: 기존 프로젝트는 기본 백업으로 DB 볼륨을 보존하여 정지했다(exit0). 임시 프로젝트는 합성 자료0 확인 후 `--no-backup`으로 정지·테스트 볼륨 정리(exit0)했고 임시 status 키 파일을 제거했다. 전용 런타임의 실행 컨테이너0 확인 후 Colima 정지(exit0)로 이번 시작 전 상태를 복원했다.

네이버 앱의 발급 항목은 Client ID와 Client Secret이다. 등록한 프론트 Callback URL을 `NAVER_REDIRECT_URI`에 동일하게 설정한다. [가입 계약](../../../../backend/contracts/signup.md)의 필수 정보 제공·Origin·프론트 콜백 조건을 함께 따른다. 실제 비밀값은 채팅·Git에 기록하지 않는다.
