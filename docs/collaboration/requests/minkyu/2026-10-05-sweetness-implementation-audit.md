# 당도 구현 감사와 연결 설계 — 민규

- 기준: `정책.md` 2-3·6-2·7-1~7-4, `PLAN.md`, `PLAN_상세설계.md`, 최신 48개 마이그레이션과 현재 API 소스.
- 작업자: `minkyu`. 이번 산출물은 읽기 감사와 기술 제안이다. SQL·API·환경·운영 DB는 변경하거나 실행하지 않았다.
- 판정: 당도 산식은 확정됐지만 현재 48개 SQL에는 당도 계산기·기여 원장·운영 감점 원장·프로필 반환이 없다. 별점·반응·칭찬·공개 적격성과 완료 횟수가 있다는 이유로 당도가 구현됐다고 볼 수 없다.

## 1. 확정 정책과 현재 증거

| 항목 | 사용자 확정 | 현재 구현 근거와 차이 |
|---|---|---|
| 초기·표시 | 초기 15, 최종 표시만 0~100 정수 | profiles에 당도 필드/계산 함수 없음. `get_my_profile`과 `get_public_profile`에도 없음 |
| 반응 | positive +1, neutral 0, negative −2 | `appointment_reviews.experience`에 3종 저장·검사. 가감 계산 없음 |
| 별점 | 1~2 −2, 3 0, 4~5 +1 | rating 1~5 필수·immutable 리뷰로 저장. 가감 계산 없음 |
| 완료·칭찬 | 당도 가산 없음 | 완료 횟수는 별도 집계. 칭찬은 현재 공식 6종·positive만 최대 3개·top5 집계로 분리되어 있으므로 재사용 가능 |
| 반영 시점 | 실제 완료 후 양쪽 제출 즉시, 한쪽은 현재 작성 기한 종료 | 최신 `review_release_ready`가 조건을 적용. 실제 당도 기여 시작 시각·원장은 없음 |
| 숨김·무효 | 임시 숨김은 이미 반영한 당도 유지, 최종 무효는 기여 제외 | 현재 `review_publication`은 is_public와 policy/override뿐이다. 임시 숨김과 최종 무효를 구분할 판정·이력 없음 |
| 취소 제재 | 확정된 제재 1회 −2. 개별 취소 1회와 다름 | `appointment_cancellations`는 개별 취소 로그다. 순서·경고·확정 제재·이의 결과 원장은 현재 48개에 없음 |
| 노쇼·중대 | 확정 노쇼 −3, 중대 위반 −10 | 분쟁 resolution=no_show는 있으나 책임자와 확정 사건·감점 이력 없음. 중대 위반 판정 저장소 없음 |
| 같은 사건 | 운영 감점 최대 하나, 유효 후기 점수와는 합산 | 사건 식별자·위반 종류별 확정/정정 집계 없음. 동일 건 중복 감점 방지 필요 |
| 재가입 | 새 프로필 초기 15·완료 0, 과거 받은 후기/당도 복구 없음, 제재만 승계 | Naver subject→단일 user_id 매핑과 profile/auth FK 구조다. 탈퇴·회원 회차·재가입 기록 없음 |

### 읽은 구체적 구현

- `20260916111030_feature09_mutual_review.sql`: 리뷰 `(appointment_id,reviewer_id)` unique, rating 1~5, comment 선택. reviewer/profile·appointment 삭제 FK는 cascade다.
- `20260923101000_review_automation.sql`: experience/praises, 공개 후보 등록, `set_review_publication`, 공개 후기·칭찬 집계.
- `20261002110000_completion_review_policy.sql`: 최신 공식 칭찬 6개, 개인 확인 후 선제 제출, 공개 후기/칭찬/완료 횟수. 파일 말미도 공개 predicate에 당도 산식이 없다고 명시한다.
- `20261005001429_current_completion_consent_policy.sql`: 7일 작성 기한 공개, 검토 중 이미 공개된 후기 보존. 당도 원장은 추가하지 않는다.
- `20260923102000_core_service_api.sql:80`: 본인 프로필은 `{userId,realName,avatarUrl,bio}`.
- `20261002131000_events_public_profile.sql:320`: 공개 프로필은 이름·나이·성향·완료 횟수를 반환하며 sweetness는 없다.
- `apps/mobile/src/service.ts:979`: 공개 프로필 decoder는 sweetness를 선택 항목으로 허용하고 0~100 정수를 검사하지만 누락 값을 실제 계산했다고 증명하지 않는다.
- `20261002120000_appointment_changes.sql:199`: 개별 사유 취소 처리다. 파일 주석도 노쇼·제재 판정을 자동 확정하지 않는다고 명시한다.
- `20260917005621_retry_completion_dispute_review_policy.sql:322`: 기존 private 분쟁 해소는 actual_meetup/no_show 상태 전환만 수행한다. 감점 책임자·사건 판정을 수행하지 않는다.

## 2. 바로 피해야 할 구현

1. `SUM(rating)` 또는 평균 별점으로 당도를 계산하지 않는다. positive/negative와 별점을 각각 변환해 더해야 한다.
2. 완료 횟수나 praises 개수를 당도에 더하지 않는다.
3. `cancel_appointment` 성공마다 −2를 넣지 않는다. 정책 2-3의 순서·이의 대기·경고 이후 실제 취소 제재 확정이 근거다.
4. 현재 공개 후기만 매번 SUM해 임시 숨김 시 점수를 빼지 않는다. 공개/칭찬/AI 적격성과 이미 반영한 당도의 유효성은 다르다.
5. 각 사건마다 0~100으로 잘라 profile 누적 점수를 UPDATE하지 않는다. 원 기여 전체 합산 후 마지막 표시만 제한한다.
6. no_show가 판정됐다는 이유로 양쪽 모두 −3을 주지 않는다. 책임자가 확인된 확정 사건 근거가 필요하다.
7. 숨김 boolean을 최종 무효 판정으로 취급하거나, 과거 override=false의 공개 이력을 추측해서 backfill하지 않는다.
8. rejoin 때 같은 profile_id의 모든 과거 후기를 다시 합산하지 않는다. Naver 안전 식별자와 해당 가입 회차의 점수 대상은 분리한다.

## 3. 제안 데이터 계약 — 서비스 정책 추가 결정 아님

아래 이름과 저장 방식은 민규의 기술 제안이다. 신규 migration으로 작성하며 과거 48개 SQL을 수정하지 않는다.

### 가입 회차

`private.member_episodes`에 회차 UUID, 현재 profile/auth 연결, 시작/종료 시각과 활성 상태를 저장하고 현재 회차를 하나로 제한한다. Naver 검증 식별값에 연결한 제재·경고/연속 취소 이력은 별도 안전 저장소가 맡는다. 점수·완료/받은 후기 집계는 현재 회차를 기준으로 한다.

기존 profile PK가 auth.users.id라 회차 UUID만 새로 만든다고 탈퇴 전체가 해결되지 않는다. 프로필/사진의 실제 활성 자료 삭제, 역사 공고·상대 리뷰 유지, 재가입 Auth 연결, 익명화와 cascade FK를 함께 설계해야 한다. 현재 UID를 계속 사용하든 새 Auth UID를 발급하든, 과거 약속/후기의 받는 회차를 새 회차로 자동 이전하지 않는다. 기존 참가자 관계·약속은 원래 회차에 고정한다. Naver 식별값의 보관 근거가 확인됐다고 주장하지 않는다.

### 후기 기여

`private.sweetness_review_contributions` 제안 필드:

- review_id UUID unique, appointment_id UUID, recipient_episode_id UUID.
- immutable reaction_delta 및 star_delta. 각각 허용 집합 `{−2,0,+1}`, 합은 −4~+2다.
- 최초 공개 적격 시각 first_eligible_at. 실제 화면 열람 여부와 구분한다.
- 최종 평가 유효성 valid와 판정 revision/정정 근거 ID. 원문/정정 사유 전문은 저장하지 않는다.

후기는 본래 row의 reviewer와 원 약속 참가자에서 상대 회차를 도출한다. 외부 호출자가 targetUserId·delta를 정하지 않는다. text 없는 유효 평가도 점수에 포함한다. AI 요약의 텍스트 3개 기준과 혼동하지 않는다.

임시 비공개는 publication 상태만 바꾸고 이미 시작한 유효 점수 기여는 유지한다. final_invalid 판정일 때만 기여를 제외한다. 정상으로 판정이 정정되면 원 가감을 복원한다. 공개 전에 임시 숨김되어 아직 상대 열람 조건을 충족하지 못한 평가는 미반영을 유지한다.

### 확정 운영 사건과 감점

운영 저장소의 확정 결정에 `incident_id`, 책임 회원의 안전 식별 연결/당시 회차, 종류(cancel_sanction/no_show/major_violation), 확정 시각, 판정 revision, revoked/corrected 여부를 요구한다. 사건의 단순 report 접수나 검토 중 상태는 확정 감점 근거가 아니다. 탈퇴 전 사건이 재가입 후 처음 확정되는 경우의 당도 대상 회차는 현재 문서에 직접 명시돼 있지 않다. 과거 당도를 자동 복구하지 않는 확정 정책은 유지하되 이 교차 사례를 새 회차 감점 또는 완전 제외로 임의 확정하지 않는다. 저장 계약은 사건 당시 회차와 판정 시 회차를 구분해 정책 확인을 수용할 수 있어야 한다.

`private.sweetness_incident_contributions`는 `(recipient_episode_id,incident_id)` unique로 한 사건의 유효 확정 종류 중 절댓값 최대 감점을 산정한다. 즉 −2/−3/−10 중 한 값이다. −10이 정정 취소되어 −3만 유효하면 −3으로 재계산하며 둘 다 더하지 않는다. 취소 제재 여러 건이 서로 다른 사건이면 각각 반영한다. 한 사건의 유효 후기 점수는 별도로 합산한다.

초기 15와 원 기여를 numeric/bigint 안전 합산해 display만 `LEAST(100,GREATEST(0,raw))`로 반환한다. 표시값을 다음 계산의 시작값으로 쓰지 않는다. 운영 사유 원문과 신고자 신원은 공개 profile 응답에 넣지 않는다.

## 4. 정확한 RPC·상태 전환 연결

### 계산/읽기

- private `review_sweetness_delta(experience text,rating integer)`는 고정 변환 규칙만 수행하고 잘못된 값은 거절한다. raw 자료 변경이나 UI 계산을 단일 기준으로 사용하지 않는다.
- private `current_member_sweetness(profile_id uuid)`는 현재 회차의 유효 후기 기여와 사건별 확정 감점을 합산하고 0~100 정수를 반환한다. inactive/retired 회차는 일반 공개 profile에서 조회할 수 없다.
- `get_my_profile()`와 `get_public_profile(uuid)`에 동일 계산의 `sweetness`를 추가한다. 일반 사용자는 원 점수 ledger·운영 사건 정보를 직접 읽지 못한다. public profile 회원 가시 권한을 유지한다.
- 초기값 안내를 위한 평가 존재 표식은 API·모바일과 별도 연결한다. J의 exact decoder는 현재 sweetness 외 새 필드를 거절한다. 임의 응답 필드를 추가하지 않고 `backend/contracts` 합의 및 J 수정 요청으로 연결한다. 누락 점수에 frontend 임의 15 fallback을 넣어 구현 성공으로 표시하지 않는다.

### 최초 반영의 원자성

현재 `is_review_public_eligible`는 policy 후보의 시간이 도래하면 publication.is_public=false여도 true가 될 수 있다. 따라서 `pub.is_public=true` 업데이트 트리거만으로 반영하면 조회 시 공개 후 점수 지연이 생긴다.

제안: 현재 공개 적격인 아직 미기록 리뷰를 계산에 포함하고, 약속/후기의 공개·보류·숨김 전환 때 해당 순간의 적격 기여를 같은 트랜잭션에서 물질화한다. private `sync_appointment_sweetness(appointment_id)`를 약속 잠금 아래 호출한다. 원장에 이미 있는 review_id는 중복 insert하지 않는다. 조회는 현재 적격 기여와 이미 시작한 유효 기여를 review_id로 중복 제거해 계산하며 원문 로그를 남기지 않는다.

연결 지점은 두 번째 후기 제출, 실제 완료 전환, 한쪽 작성 마감 도래 처리, 분쟁 보류 시작 전 공개 보존, 운영 임시 비공개 직전, 최종 무효/정정이다. 기존 `preserve_released_reviews_before_hold`와 결합해야 한다. 작성 마감이 지났는데 maintenance가 지연된 경우도 공개 predicate와 같은 점수를 반환해야 한다.

과거 override=false는 현재 저장된 boolean만으로 한때 공개됐는지 알 수 없다. 알려진 현재 공개 적격 자료와 확실한 이력만 이관하고, 근거 없는 과거 숨김을 최초 공개 또는 최종 무효로 확정하지 않는다. 역사 자료 이관 기준/미확인 목록은 운영 검토에 남긴다.

### 운영 판정

감점 반영 함수는 신뢰된 운영 결정 RPC에서만 호출한다. 결정 ID/version 일치·확정 상태·책임자·사건 중복을 검사하고 점수 원장 갱신과 상태/알림 outbox를 같은 트랜잭션에 처리한다. service_role만 있다는 이유로 사용자 요청의 임의 사건/감점을 신뢰하지 않는다. 운영 담당·접근 역할 배정이 미정이므로 실제 운영 액터 권한을 임의 발급하지 않는다.

`set_review_publication(review_id,bool)`의 임시 숨김 역할은 유지한다. 최종 무효·오판 정정은 별도 결정 ID/version이 있는 제한된 함수로 처리하고 final validity를 변경한다. `resolve_appointment_dispute`는 no_show 책임자 확정/평가 자격 무효와 연결할 때 같은 사건으로 한 번만 처리한다. 정상 동행 인정은 후기 기여와 완료 집계를 현재 정책대로 복원한다.

## 5. 잠금·이력·동시성 제안

- 동일 약속 이벤트는 기존 appointment `FOR UPDATE`를 먼저 유지한다. 대상 회차 집계/원장은 참가자 UUID 정렬 순서로 처리하고 같은 사건 기여 row를 잠근다. 기존 리뷰 projection→job 순서와도 대조한다.
- 후기 unique(review_id,recipient_episode_id) 또는 review_id unique, 사건 unique(recipient_episode_id,incident_id), 결정 ID unique를 DB 제약으로 둔다. 같은 결정 재전송은 최초 결과를 반환하고 다른 내용/다른 revision은 충돌한다.
- 임시 숨김 직전에 현재 공개 적격 기여를 기록하는 동작과 publication 변경을 원자 처리한다. hide와 두 번째 제출/완료/기한 도래의 경합에서 점수 유무가 transaction 순서와 일치해야 한다.
- 취소·노쇼·중대의 최대 감점을 결정 revision 아래 재계산한다. 공개 profile의 raw 누적 값을 read-modify-write하지 않는다. 서로 다른 두 사건 확정이 동시에 와도 한 건이 유실되지 않도록 원 기여 SUM 또는 잠긴 projection 재계산을 사용한다.
- 최종 무효와 반영/재공개가 경합하면 판정 version 검증으로 stale 복원을 거절한다. 신고 접수 자체는 원 score를 빼지 않는다.
- 탈퇴/재가입이 판정과 경합하면 안전 식별 기록은 승계하되 원 약속의 당시 회차를 새 회차로 바꾸지 않도록 active episode 잠금과 고정 리뷰 recipient_episode_id를 사용한다. 재가입 후 처음 확정된 과거 사건의 감점 대상은 위 미정 교차 사례를 따른다. 재가입에 과거 당도 감점까지 그대로 복원한다는 새 정책을 만들지 않는다.
- 상세 기여 보관기간·정정 이력 보관의 법적 근거와 삭제 구현은 정책 13 및 운영 검토에 남긴다. 목적에 필요하다는 이유만으로 원문/식별자를 무기한 저장한다고 확정하지 않는다.

## 6. 기존 차단·복원 작업과 충돌할 함수

| 함수/저장소 | 당도 연결점 | 협업 주의 |
|---|---|---|
| `get_public_profile`, `get_my_profile` | sweetness 동일 계산/현재 회차 | 공개 차단·탈퇴 가드와 동일 함수. 최종 소유자 수정 단위 하나로 통합 |
| `submit_appointment_review` | 두 번째 제출/최초 공개 기여 | 상태·중복·검토 보류를 보존. 상대 차단만으로 점수/칭찬을 바꾸지 않음 |
| `set_review_publication`, review_publication trigger | 임시 숨김 전 기여 물질화 | 임시와 final_invalid 구분. 기존 bool API에 최종 무효 의미를 덧붙이지 않음 |
| `resolve_appointment_dispute`, 검토 시작/복원 | 노쇼 자격 무효·정정·공개 보존 | 책임자/사건 판정 추가와 남은 리뷰 기한/완료 보류 규칙을 통합 |
| `review_release_ready`, `is_review_public_eligible` | 현재 열람 가능한 기여 | 이미 반영한 임시 숨김 score와 공개 적격성을 별도 취급 |
| `completed_appointment_count` | 회차별 완료 0 초기화 | 완료를 당도에 더하지 않음. 무효 동행 집계와 재가입 경계를 연결 |
| Naver accounts/profiles/auth FK | 새 회차·이력 보존 | 기존 cascade 삭제로 상대 후기/안전 이력이 없어지지 않게 전체 탈퇴 설계 필요 |
| 취소/제재 판정과 ledger | 확정 취소 제재 −2 | 개별 취소 함수에서 즉시 감점하지 않음. 이의·순서 판정 뒤 확정 사건 연결 |

관련 팀에 위 함수 충돌 후보와 helper/상태 구분 요구를 전달했다. 이번 감사에서는 함수를 편집하지 않았다. 실제 차단/재개 코드와 이 감사가 하나의 트랜잭션 연결 계약을 합의한 뒤 각각의 단독 소유 파일에서 구현한다.

## 7. 완료 증거로 요구할 검증

현재는 코드/정책 읽기만 수행했고 아래 점수 검증은 **NOT_RUN**이다. 과거 후기 공개 테스트 통과를 당도 테스트 통과로 전용하지 않는다.

1. 15→좋아요/5점=17, 15→별로/1점=11, 후자+동일 건 중대 −10=1.
2. 반응 3종×별점 5종 전 조합; text/praises 없음도 동일 점수; 완료/칭찬만으로 점수 변화 없음.
3. 양쪽 제출 전/실제 완료 전 미반영, 양쪽+완료 즉시 반영, 한쪽 기한 직전/경계 반영. 조회 전 maintenance 미실행에서도 동일.
4. 공개 전 임시 숨김은 미반영, 이미 반영 후 임시 숨김은 점수 유지·칭찬 제외·AI 요약 즉시 무효화. final invalid는 점수 제외, 유효 정정은 원 점수 복원.
5. no_show 자격 무효는 후기 기여 제외, 책임자 확정 감점만 반영. 같은 사건 취소/노쇼/중대는 최대 하나, 유효 후기와는 합산.
6. raw가 100 초과/0 미만인 뒤 기여 무효화·감점 정정해 정확한 원 합계를 복원. 매 사건 clamp 구현이 틀렸음을 잡는 사례 포함.
7. 취소 1건/첫 경고/이의 대기에는 취소 제재 감점 없음. 확정 제재만 한 번 −2, 오판 정정으로 복원.
8. 결정 중복·의도적 같은 사건 중복·다른 판정 revision 충돌, 사용자 score/target/incident 주입·직접 테이블/RPC 접근 거절.
9. 두 독립 DB 세션으로 제출 대 숨김, 판정 대 재공개, 다른 사건 동시 확정, 무효 대 조회, 탈퇴 대 판정/재가입 경합 검증.
10. 재가입 새15·완료0, 기존 받은 점수 복구 없음, 같은 네이버 안전 제재 기간/영구 제한은 그대로, 기존 익명 공개 후기와 상대의 남은 후기 작성 유지.
11. 실제 SQL/API 0~100 정수 일치, 익명 profile 가드, J 모바일 decoder 연결, 초기값 안내와 운영 근거 노출 없음.

법률/공급사/운영 담당 미정과 기술 구현 미완료를 구분한다. 현재 산식은 다시 사용자에게 묻지 않는다. 새로운 미정 사건 식별/판정 권한은 자동 확정하거나 가짜 성공으로 대체하지 않는다.
