# 현재 구현·검증 공백 — 2026-10-19

actor=minkyu, 전용 clone의 HEAD `1d9b46b69adbc52f693accbff04ca4a00d35c547`, 정규 migration121 기준 독립 읽기 감사다. 아래 정적 차이는 실제 재현 PASS가 아니다. 전체79%(22/28)·민규44개 ACTIVE를 유지하며 기존 PASS를 재작성하지 않는다.

|WBS|보존 근거와 남은 조치|
|---|---|
|4.4|`tests/integration/minkyu/public_post_detail_local.ts:139`의 익명 이름 별칭 기대는 현재 SQL null과 다르다. 같은 파일165 및 `matching_lifecycle_local.ts:110,111,124`의 첫 신청에는 현 계약의 messageId가 없다. 실행 전 검증기만 최소 정합화해야 한다.|
|4.5·4.6|정책167의 서버 접수시각과 잠금 후 clock_timestamp 판정 사이 정적 차이. 마감 전 진입→잠금대기→마감 후 실행의 실제 재현이 필요하다.|
|4.7|사진 deadline 수정은 모형70개 범위다. 실제 Auth/Storage 연결 검증은 남는다. 신고 bytes·ACL·회수 및 탈퇴 ACK 유실 복구의 기존 실제 증거는 보존한다.|
|4.8·LEGACY-ME|본인5필드 API 및 과거 본인200·익명/위조401은 구현돼 있다. 현재 /me 만료세션 거절·5필드와 공개DTO 분리의 직접 증거 연결이 남는다.|
|5.2|현재 public search SQL의 나이·비검색필드·기간 회귀 소스는 있으나 회수 가능한 실제 영수증이 없다. 새 a002에서 고정 SQL의 rollback 검증 준비 중이다. 월·연경계 this_week→RPC 기간 조합 검사는 별도 모형 회귀로 준비한다.|
|5.3|최신 실제 로컬 positive4건과 과거 정상0건 증거를 구분해 연결한다. unavailable를 정상 검색0건으로 계산하지 않는다.|

## 접수시각 재현 경계

- `backend/supabase/migrations/20261005005459_current_recruitment_reopen.sql:77` accept_match는 잠금 뒤104에서 expires_at과 clock_timestamp를 비교한다.
- `backend/supabase/migrations/20261005014629_appointment_place_change_draft.sql:139` 일정변경 수락은 잠금 뒤157에서 response_open의 현재시각을 사용한다.
- `backend/supabase/migrations/20261002110000_completion_review_policy.sql:71` 후기 제출은77의 행 잠금 뒤99에서 can_submit의 현재시각을 사용한다.
- 최신 lifecycle wrapper와 content_inspection ticket 경로도 기존 본문을 호출하며 신뢰 접수시각 연결은 찾지 못했다.

후속 전용 scratch에서 두 세션으로 전/동일/후 경계와 잠금 대기를 관측하고 expiry worker 선행 처리까지 분리한다. statement_timestamp 초기 고정만으로 HTTP 검사 지연과 worker의 상태 변경까지 해결됐다고 주장하지 않는다. 클라이언트 timestamp·허용 GUC 우회·기존 migration 덮어쓰기·공개 RPC 시그니처 변경을 임의로 추가하지 않는다. 현재 a002 복원 실행과 동시 편집하거나 DB를 공유하지 않는다.

## 정상0건의 보존 근거

과거 실제 AI22/23 영수증 `/private/tmp/yumidang-wbs-ai-20261017-d017a004/signed-auth-7be00986bede4a1e9669a3039f9fb6db/receipt.json`의 SHA는 `a922282b25bb321d3cad1d143fa9e84e80096b86acad147e01e42b8dc3849737`이며 실제 Auth/PostgREST PASS다. activation-intent의 고정 실행기에서 aiLimitsHttpCase는 empty RPC와 HTTP no_results를 요구했다. 해당 함수는 현재와 동일하나 요청별 응답 원문은 남기지 않았으므로 집계·고정 실행기 결합 증거와 직접 raw 응답 재검산은 구분한다.

## 후속 해소 상태 — 한국시간10/20

위 표는 최초 읽기 시점의 공백이다. 4.4의 익명 null·messageId 입력과 matching 재신청 쿨다운(즉시409 후 실제61초 대기) fixture는 최소 정합화했고 Node 구문검사 PASS다. 실제 새 Auth/HTTP 통합 실행은 남는다.

5.2의 현재 검색 SQL9개는 a002에서 실제 실행/rollback과 전후 전체178개 bags 보존을 통과했다. 월/연·목요일 귀속 주차24개는 모형 RPC 전달 검증으로 구분했다. 5.2·5.3은 최신 명시 acceptance 대조 후 Notion 최종완료를 재조회 확인했으며 [완료근거](2026-10-19-search-acceptance.md)를 따른다.

4.5/4.6 deadline은 현재 소스의 정적 차이이며 아직 실제 재현하지 않았다. Auth6의 AI용 profile은 실제 Naver signup 적격 fixture가 아니므로 정상 수락/후기에 그대로 사용하지 않는다. 새 전용 scratch에서 권한·합성 가입/사진 fixture의 행차분과 원JWT 경로를 별도 검토하며 기존a002에는 쓰지 않는다.
