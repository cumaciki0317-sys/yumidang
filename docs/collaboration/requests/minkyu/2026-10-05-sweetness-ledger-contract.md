# 당도 원장·가입 회차 구현 연결 — 민규

## 범위와 상태

- 기준: 정책.md 2-3·7-4, 최신 50개 SQL. 새 `20261005013901_current_sweetness_ledger.sql`은 민규 구현이다. 작업 순서상 52라고 지칭했으나 실제 최신50에 추가되는 SQL은 51번째이며 일정 제안 철회 draft와 구분한다.
- 초기 15, 반응과 별점 합산, 사건별 가장 큰 운영 감점 하나, 최종 표시 0~100을 구현한다. 완료·칭찬은 점수에 더하지 않는다.
- 기존 profile/약속을 최초 가입 회차에 연결하고 새 약속 참가 회차를 고정한다. 실제 탈퇴·재가입·제재 운영 권한·법적 보관 근거의 완료를 뜻하지 않는다.
- 원본·운영 DB는 변경하지 않는다. 별도 schema-only 복제 scratch에서만 적용·회귀를 진행한다. 실제 검증 결과는 부모 통합 기록으로 연결한다.

## 공통 회차 계약

- `private.member_episodes`: `id uuid` PK, `profile_id uuid`, `started_at timestamptz`, `ended_at timestamptz nullable`. 종료 시각 null이 현재 회차이며 profile별 현재 회차는 하나다.
- `private.active_member_episode(profile_id uuid) returns uuid`: 현재 회차 ID. 일반 사용자·anon·service_role에 직접 실행 권한이 없다.
- `private.appointment_member_episodes`: `appointment_id uuid` PK, `author_episode_id uuid`, `requester_episode_id uuid`. 약속 생성 시 고정하며 재가입 때 과거 약속의 회차를 바꾸지 않는다.
- 후속 탈퇴/재가입 담당은 기존 회차 종료와 새 회차 생성, 새 Auth UID 연결, 활성 개인정보 삭제 및 원 약속/상대 후기 익명 보존을 연결해야 한다. 기존 cascade와 profile_id 기록 보관은 해당 생애주기에서 검토한다.
- 본인/공개 profile의 `sweetness`와 완료 횟수는 현재 회차 기준이다. 공개 후기·칭찬·AI 입력도 현재 받는 회차에 해당하는 평가만 조회한다. 과거 익명 후기의 독립 역사 조회/생애주기 전체는 별도 작업이다.

## 기여·판정 계약

- `sweetness_review_contributions`: review별 한 행. 상대의 당시 회차, 원 반응 delta, 원 별점 delta, 최초 적격 시각을 저장한다. 한마디 없는 평가도 포함한다.
- 현재 적격 미기록 평가와 이미 시작한 기여를 중복 없이 합산한다. 기한 경계에 maintenance가 늦어도 조회 점수가 일치한다.
- 임시 숨김 직전 현재 적격 평가를 약속 잠금 아래 기록한다. 공개 전에 숨긴 평가는 미반영이고, 이미 반영한 평가는 숨김 중에도 유지한다.
- `sweetness_review_decisions`: decision UUID, review UUID, 순차 revision, 최종 유효 여부. owner-only `decide_review_sweetness`는 같은 결정 재시도만 멱등 허용하고 stale/충돌은 40001이다. 최종 무효는 공개 적격성·칭찬·AI 근거에서도 제외하며 정정은 원 기여를 복원한다. 정정만으로 임시 숨김을 자동 해제하지 않는다.
- no_show 판정의 후기는 점수에서 제외한다. 책임자 확정 운영 사건은 별도 신뢰된 결정 계층이 넣는다. 분쟁 접수·개별 취소·단순 신고는 감점으로 자동 변환하지 않는다.
- `sweetness_incidents` PK `(incident_id,recipient_episode_id)`, `sweetness_incident_decisions` unique `(incident_id,recipient_episode_id,kind,revision)`. 같은 사건에 복수 책임자가 있으면 각 회원 회차별로 판정할 수 있다. 회원 회차별 사건 감점은 −2/−3/−10 중 가장 큰 하나다.
- owner-only `decide_incident_sweetness`는 현재 회차의 첫 사건과 기존 사건의 순차 정정을 받는다. 종료 회차의 이미 기록한 사건도 무효/오판 정정 가능하며 새 회차로 이전하지 않는다. 종료 회차의 새 사건 최초 확정은 미정 교차 사례이므로 55000으로 보류한다.
- 실제 운영 담당·액터·권한·판정 승인 계층은 아직 연결하지 않는다. helper와 원장 모두 PUBLIC·anon·authenticated·service_role 권한을 닫는다.

## 잠금과 연결

- 약속 기반 후기 반영/최종 판정은 appointment lock 뒤 기여/판정 원장을 변경한다. publication 변경 직전·직후와 appointment 변경 직전에 반영 조건을 물질화한다.
- 사건 결정은 episode 공유 잠금 뒤 `(incident,episode)` 사건 행 잠금으로 직렬화한다. 다른 사건은 서로 점수를 덮어쓰지 않고 합산한다.
- 기존 차단 public profile wrapper·회원 인증·반환 계약을 보존한다. 민규 SQL 함수에 `sweetness`만 추가하며 종현 파일은 수정하지 않는다.

## 종현 연결 요청

- 모바일 own/public profile decoder와 타입에서 서버 `sweetness` 0~100 정수를 받는다. 공개 profile decoder는 기존 선택 필드 지원을 현재 서버 계약과 확인하고, 본인 profile exact 필드 목록도 갱신해야 한다.
- 서버 필드 누락을 frontend 임의 15로 성공 처리하지 않는다. 별도 초기값 안내 표식은 현재 exact decoder에 임의 추가하지 않으며 후속 API 계약으로 연결한다.
- 이 요청은 외부 메시지 전송이나 종현 파일 수정 승인이 아니다.

## 실제 로컬 검증 결과

- `yumidang_sweetness_20261005`: 정책 scratch의50 schema-only 복제에 이 신규 SQL만 적용 PASS. schema-only 복제에서 빠진 global lease singleton와 외부 AI 승인 false 기본 설정만 migration 원문대로 준비했다.
- `current_sweetness_ledger.sql` PASS: 반응3×별점5, 실제 완료/양쪽 제출/기한 경계, maintenance 지연, 공개 전후 임시 숨김, 최종 무효/정정, 노쇼 무효/정상 동행 정정, 같은 사건 복수 책임자, 최대 감점 하나, 결정 멱등/충돌, clamp 후 원 합계 복구, 새 회차15/완료0/과거 받은 후기 제외, 종료 회차 기존 사건 정정/미정 최초 사건 보류, ACL·익명 JWT 가드.
- 최신 main9 SQL 회귀 모두 PASS: 완료정책, 공개검색, global lease, 첫채팅 신청, AI 원자 요청, worker job fence, 현재 summary fence, 모집 재개, 회원 차단.
- `sweetness_concurrency_local.py` 실제2세션4그룹 PASS: 두 번째 제출 선행/숨김 선행, 최종 무효와 재공개, 서로 다른 사건 동시 확정. 무작위 합성 회원·회차·공고·사건 자료 모두 정리한 뒤 잔여0.
- 별도 `yumidang_sweetness_upgrade_20261005`:50 schema-only에서 먼저 합성 공개/override=false 역사 평가를 준비한 뒤 신규 SQL 적용 PASS. 현재 적격 평가만 backfill, 불명확 override=false 미이관, 이관 후 임시 숨김에도 기여 보존을 실제 확인했다. fixture 정리 첫 시도는 기존 FK cascade의 projection 오류로 실패하여 공고→Auth→회차 순서로 수정해 합성 자료 잔여0을 확인했다. 이 오류는 실제 탈퇴 생애주기의 별도 검토 근거이며 탈퇴 구현 완료로 처리하지 않는다.
- 원본postgres·운영 DB·독립50 API 검증 DB 변경0. original global role migration41을 새로 실행하지 않았으며41 native 권한 검증은 부모의 독립50 증거와 구분한다.
- 실제 Auth 재가입·사진 객체 파일 삭제·제재 승계·보관 법적 근거·운영 액터 workflow는 아직 미구현 또는 별도 확인 대상이다.
