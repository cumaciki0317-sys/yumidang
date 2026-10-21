# WBS7.8 KOPIS 공식 대조 snapshot 영속 게시 후속 설계

민규 / 2026-10-21. 읽기 설계 문서다. 기존 순수 gate 회귀49개는 재작성하지 않는다. 이번 기록으로 WBS7.8 완료·공식14분류 실제 대조·게시·운영 적용을 표시하지 않는다. 외부 공급사 호출·키 사용·외부 메시지·DB 실행0이다.

## 실제 소스와 막힌 연결

| 경계 | 현재 소스·사실 | 후속 변경 |
|---|---|---|
| API 원문 수집 | `backend/supabase/functions/_shared/integrations/events/kopis-ranking.ts`의 provider는 all/musical만 요청하며 basedate 없는 응답을 network 경로에서 거절한다. `verifyKopisOfficialRanking`은 별도로 공식 관찰과 XML을 비교한다. | 같은 안전 transport로 받은 XML을 공개 관찰 수집기와 대조한 뒤 검증 snapshot으로 전달한다. 공식 계약을 확보하기 전 selector·JSON 경로·12분류 API 코드를 추정하지 않는다. |
| 프로세스 검증 | 같은 파일의 WeakSet·동결 객체는 임의 JSON의 `verified` 주장을 거절한다. JSON/DB 재로딩은 capability를 잃는다. | WeakSet은 수집 직후 검증에 유지하고, 영속 게시의 서명된 증명으로 명시 전환한다. DB JSON을 WeakSet에 다시 등록하는 우회는 만들지 않는다. |
| 작업 등록/실행 | `_shared/jobs/event-collection.ts`와 `event-runtime.ts`의 실제 lane·등록·dispatch는 all/musical 두 개다. 나머지는 현재 안전 중단한다. | 14개 고정 분류별 lane과 지원/미지원 상태를 연결한다. 미지원 분류는 held 상태에서 원천 호출0을 유지한다. |
| SQL 점유·원자 완료 | `20261009011100_event_collection_lane.sql`의 reference 검증/held CHECK/등록 날짜 검증/dispatch 판정은 두 lane이다. `complete_event_ranking_collection`은 항상55000, read capability에는 ranking_jobs가 없다. | 새 append migration으로 분류 검증·서명 검증·원자 게시/작업 완료를 연결한 뒤에만 capability를 열고 held를 해제한다. |
| 내부 RPC 허용 | `_shared/db/internal-client.ts`에는 `complete_event_ranking_collection`이 현재 허용돼 있지 않다. runtime의 supportsRpc 확인도 실행을 막는다. | 실제 SQL·계약 회귀가 통과한 완료 RPC만 명시 allowlist에 추가한다. 이름 요청만으로 capability를 선언하지 않는다. |
| 기존 저장/공개 | `20261002160000_event_rankings.sql`의 기존 저장은 all/musical requested-only이며 공개 근거가 아니다. `20261008013000_public_event_detail.sql`의 공개 상태는 not_enabled다. | 기존 requested-only를 승격하지 않고 별도 verified 저장소를 빈 상태로 추가한다. |
| 기존 앱 계약 | `apps/mobile/src/service.ts`의 performanceRankings는 두 mode를 허용하지만 `/events/rankings`에서 정확히 `{status,reason}` not_enabled만 읽는다. | 기존 경로/응답은 유지하고 새 분류별 명시 endpoint로 확장한다. 앱 수정은 종현에게 소비 계약으로 전달한다. |

## 공식 관찰 확보가 첫 선행 조건

공식 PC/모바일 공개 페이지 조회에서는 실제 순위 행·선택 기간/조건·공개 JSON 계약을 확보하지 못했다. 공식 검색에 나타난 query 문자열이나 API 요청 날짜를 실제 표시 기간으로 취급하지 않는다. 키 없는 공개 HTML의 로컬 읽기는 DNS 실패했다. 따라서 지금 자동 수집기를 추정 구현하지 않는다.

접근 가능한 환경에서 공식 페이지/공개 응답의 실제 기간, 분류/지역/특성, 정렬 기준, 공연ID·순위·표시 순서를 함께 읽을 수 있음을 먼저 입증한다. API 응답과 공식 관찰의 바이트 해시·원문 보존 위치·관찰 시각·parser 버전을 개인 증거로 묶는다. 원문에 인증 정보가 포함되지 않게 하며 API 키가 들어간 요청 URL은 증거/로그/공개 DTO에 기록하지 않는다. 특성·지역은 장르 코드와 별도로 검증한다. 해당 분류만 지원 상태로 승격한다.

collector는 HTTPS의 확인된 고정 host/path, redirect0, 총 deadline15초, 실제 본문2,000,000바이트 상한, UTF8/MIME/HTTP 상태 검사, caller 취소·늦은 body 취소를 갖춘다. 자동 재시도와 HTTP fallback은 없다. 실제 transport 지원은 공식 계약·별도 호출 승인 범위에서 확인하며 합성 fetch 검사를 실제 공급사 확인으로 계산하지 않는다.

## 최소 영속 증명과 append migration

구현 시점의 최신 migration 뒤에 오는 새 version을 정해 append migration을 추가하고, 아래 범위만 구현한다. 지금 파일명이나 과거 시각의 version을 예약하지 않는다. 과거 migration과 requested-only 기록은 변경하지 않는다.

1. 14분류 registry와 분류별 마지막 검증 snapshot·갱신 실패 상태, 사용한 증명/nonce 영수증을 별도 private 테이블로 추가한다. RLS와 제품/일반 service_role 직접 테이블 권한 회수를 적용한다. 기존 definer owner를 조회·검사하고 새 함수/테이블 owner를 맞춘다. 적용 세션 owner를 신뢰하지 않는다.
2. 별도 verifier 서명 키 registry를 owner-only로 두며 기본 비설치·게시 비활성이다. 일반 내부 RPC caller가 JSON의 `verified:true`나 임의 evidence를 보내는 것만으로 게시하지 못하게 한다. 관찰 parser와 비교를 통과한 동결 WeakSet 객체만 사용하는 내부 signer 포트가 검증본을 서명한다. 서명 포트는 회원 HTTP/일반 JSON 입력에 노출하지 않는다. 키를 배포에 설치하는 일은 별도 운영 준비 조건이다.
3. 서명 envelope는 `keyId`, 고정 purpose/계약 버전, 원문 payload text와 HMAC-SHA256을 갖춘다. payload는 신뢰 signer가 직접 생성한 JSON이며 mode·실제 공개 기간·공식 조건·확인 시각·API 기간 검증 여부·전체 공개 item 순서·양쪽 원문 해시·parser 버전·nonce·job/lease/global-run identity를 모두 포함한다. SQL은 서명한 UTF8 원문 바이트로 MAC을 검사한 뒤 JSON으로 읽으며 JSONB 재직렬화 해시를 다른 언어의 JSON.stringify와 같다고 가정하지 않는다. 게시 대상 snapshot은 그 signed payload에서만 생성하고 별도 unsigned p_snapshot 값을 섞지 않는다.
4. 기존 완료 RPC 서명은 유지하되 신규 snapshot envelope 버전만 허용한다. 내부 역할 확인→전역 run·job/lease의 현재 연결 및 만료→lane/mode/기간→키·서명·nonce→공식/API ID·순위·순서 일치·공개 문자열/허용 필드·크기 검증→분류별 최신 행 잠금 순서로 처리한다. 기존 worker/budget 점유 순서와 충돌하는 역순 잠금을 추가하지 않는다.
5. 같은 유효 proof의 완료 재시도는 원 영수증을 돌려주고 원문 호출·재게시를 하지 않는다. 다른 job/nonce 재사용·입력 변경·오래된 기간/확인 시각은 거절하거나 stale로 종결한다. 최신 verified snapshot을 과거 입력으로 덮지 않는다. snapshot 게시·작업 성공·증명 소비는 같은 transaction이어야 한다.
6. 14개 고정 `ranking_<mode>` lane을 단일 helper로 판정하고 reference 유효성·등록 날짜·held CHECK·추가/점유/완료/settle·worker dispatch를 모두 함께 수정한다. 기존 all/musical identity는 유지한다. 확인되지 않은 분류의 새 작업은 held이며 공급사 호출0이다. 운영/키/분류 parser 준비가 모두 충족될 때만 신규 `ranking_verified_v2` capability를 노출한다. 기존 비순위 collection 기능을 전역으로 막지 않는다.

MAC은 공식 페이지의 사실 자체를 증명하지 않는다. 신뢰한 관찰 수집기와 비교기에서 DB까지의 payload 무결성을 보장하는 경계다. 공식 계약/관찰이 없으면 signer가 발급하지 않으며 키 설치만으로 공개를 허용하지 않는다. 서비스 키만으로 검증된 것처럼 만드는 저장 RPC·검사 우회 옵션은 만들지 않는다.

## 명시적인 새 읽기 계약과 소비 경계

새 `GET /events/rankings/:mode` → `get_public_verified_kopis_ranking(p_mode)`를 사용한다. 14개 외 mode/추가 query는 HTTP400이다. 기존 `/events/rankings`와 `get_public_event_ranking_state()`의 exact not_enabled 응답은 그대로 유지한다. 새 RPC만 public/user client의 allowlist에 추가하고 기존 행사 공개 인증 경로를 재사용한다. 잘못된 JWT를 익명으로 재시도하지 않는다.

새 응답은 기존 PublicKopisRanking의 `status/mode/sourceName/period/collectedAt/items/officialUrl/checkedAt/refreshDelayed` 계약이다. DB가 검증·소유권을 보호하는 verified 행에서만 읽고 requested-only 저장소는 조회하지 않는다. 첫 미검증/미지원 분류는 unavailable·빈 목록·공식 링크다. 갱신 실패 때는 해당 분류의 마지막 검증 목록/실제 기간/확인 시각을 그대로 유지하고 refreshDelayed를 표시한다. 다른 분류 성공으로 대체하거나 새 날짜를 붙이지 않는다. 새 공개 응답에 원문·해시·서명·nonce·job/lease·내부 경로는 포함하지 않는다.

관찰 원본/증명에서 DB에 확정된 검증 사실을 읽는 SQL 공개 투영을 사용한다. 이 응답을 기존 TypeScript WeakSet verifier에 JSON으로 재주입하지 않는다. 새 공개 DTO shape/type 검증과 기존 프로세스 capability의 역할을 분리한다. 종현은 14분류 선택·확인 기간/시각·공식 링크·지연 표시를 이 endpoint에 연결하며, 서버 계약 완성 전 모형을 실제 게시로 표시하지 않는다.

## 검증·적용 종료 기준

- 기존 gate49개와 일반 행사/worker 회귀를 보존한다. 순수 tests를 같은 assertions로 복제하지 않는다.
- 새 검증은 signer 비노출, 서명/키/기간/분류/ID/순위/순서 변조, JSON 복제/unsigned 입력, nonce 재사용, 잘못된 job/run/만료, 원자 완료 rollback, 재시도와 stale 보존에 집중한다.
- schema-only 새 격리 DB에서 기존/신규 owner 불일치, ACL/RLS, 공개·회원·내부 권한, 14분류 독립 상태와 fallback을 실제 SQL로 검증한다. 기존 자원과 원문 증거는 보존한다.
- 기존 앱의 not_enabled exact 응답과 새 분류별 endpoint를 각각 회귀한다. 실제 공식 관찰과 같은 기간의 API를 대조한 분류만 실제 완료 근거로 남긴다.
- 코드·합성/SQL 검증 후에도 공개 스위치·키 설치·일일 실행·소비 연결·실제14분류 검증은 각각 실행 조건을 충족할 때만 완료한다. 현재 설계에는 게시·배포·키 설치 승인이 포함되지 않는다.
