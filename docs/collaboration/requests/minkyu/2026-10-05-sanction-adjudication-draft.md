# 제재 판정: owner-only 원자 적용 초안

작성자 minkyu. 정책 2-3·6-2·6-3·7-4·13과 검토된 lifecycle20135 후보를 기준으로 한다. 민규 독립 worktree의 제재 SQL·DB 테스트·이 문서만 수정했다. 운영 담당 계정이나 operator 역할을 만들지 않았고 PUBLIC/anon/authenticated/service_role의 표·함수 권한은 닫혀 있다. 원본·운영·native postgres·상대 담당 파일은 변경하지 않았다.

## 선행 자료와 판정 입력

신고 접수와 사람의 확정 판정을 분리한다. member_reports에는 FK 연결 키만 두고 신고 설명·캡처·채팅 원문을 복제하지 않는다. 외부 AI 판단으로 이 함수를 실행하지 않는다. actorReference는 향후 승인된 액터 연결 키이며 입력했다는 사실이 운영 권한 인증은 아니다.

record_incident_revision의 기존 서명은 유지한다. subjects는 identityId/sourceEpisodeId/confirmedKinds의 세 키 또는 추가 violationClass/violationType/victimIdentityId/cancellationAction까지 정확히 일곱 키를 받는다. violationClass는 none/minor/major/cancellation이다. minor는 유형 코드가 필수이며 동일 피해자 연결에는 검증된 네이버 identity와 회원 회차 이력이 필요하다. major는 major_violation 플래그와 일치해야 한다. cancellation의 cancel_warning에는 감점이 없고 cancel_restriction에는 cancel_sanction 플래그가 필요하다. 노쇼만으로 경미·중대 단계나 피해자를 자동 추론하지 않는다. 기존 세 키에서 major_violation은 major, cancel_sanction은 cancellation 제한으로 해석한다.

confirmed에는 대상이 한 명 이상 필요하다. 모든 대상은 검증된 naver_accounts.subject→naver_identity_keys→현재 member_episodes→완료된 실제 회원 프로필 연결을 통과해야 한다. 최신 qualification/female/19+ 자격은 판정 조건이 아니다. 정보 누락·불충족으로 바뀌어도 서버 검증 subject와 회원 연결이 유지되면 판정하며 성별·나이 변경으로 기존 제재를 회피하지 못한다. 네이버 로그인 기록만 있고 가입 완료가 없거나 회차가 없으면 42501로 전체 거절한다. episode/identity 불일치는 40001이다. sourceEpisodeId 없는 확정은 허용하지 않는다.

## 원자 적용과 정정

같은 사건 advisory transaction 잠금 후 기존/신규 대상 집합을 수집한다. lifecycle와 같은 계정→프로필→회차 잠금 순서를 보존한 뒤 identity UUID 순서→사건→제재 원장/당도 순서로 처리한다. expectedRevision, decisionId 재시도 및 대상 payload hash를 검사하고 사건 revision·회원별 판정·제재 원장·원 회차 sweetness 결정을 한 SQL transaction에 저장한다. 한 대상의 검증 실패나 미정 사슬이면 다른 대상의 변경도 롤백한다. hash에는 원문이나 증거를 넣지 않는다.

reviewing은 마지막 비검토 revision의 효력을 유지한다. invalidated가 명시적으로 기존 적용을 revoked로 만들고 당도 결정을 무효화한다. 재확정 시 유효 대상이 빠진 것도 해당 대상의 제재·감점을 철회한다. 같은 종류의 적용이 유지되면 적용 ID·appliedAt·expiresAt을 보존한다. 제한 종류가 정정되면 이전 원장을 남겨 취소 사유를 기록하고 같은 사건의 최초 실제 제한 시각을 새 제한의 기준으로 사용한다. 이의 검토나 정정만으로 제한 시계를 다시 시작하지 않는다. 신규 실제 제한은 성공한 적용 시각부터 168/720시간이다. 겹친 제한은 종료의 최대값이며 영구 제한은 종료가 없다.

감점은 기존 decide_incident_sweetness와 같은 사건·원 회차·종류의 다음 revision으로 연결한다. 취소 제재 −2, 노쇼 −3, 중대 −10 중 같은 사건의 최대 감점 하나만 현재 당도에 반영된다. 일반 경미 단계 자체에 새 감점을 만들지 않는다. 명백 오판 invalidated는 제재와 당도를 함께 정정한다. 임시 신고 숨김이나 단순 검토가 감점을 제거하지 않는다. 후기 최종 무효 판단의 별도 원자 연결은 이번 범위에 없다.

동일 identity의 안전 제한은 가입 회차가 바뀌어도 원 기간을 유지한다. 새 회차 당도는15이고 과거 감점을 복구하지 않는다. 종료 회차 사건에 최초 감점을 적용하거나 기존 사건을 새 회차로 옮기는 것은 55000으로 거절한다. 탈퇴 전 사건의 재가입 후 최초 감점 귀속은 사용자 선택 미정이다. 이미 존재하는 원 회차 결정의 무효 정정만 가능하다.

## 일반 단계와 미정 경계

확정된 단일 동일유형 사슬 또는 단일 동일피해자 사슬은 경고→7일→30일, 이후 재발마다30일을 적용한다. 직전 확정 위반부터12 calendar months가 경과하면 경고부터 다시 센다. 서울 달력의 윤년 날짜와 정각 경계를 검사하며360/365일로 바꾸지 않는다. 같은 사건 수정이 사건 순서를 옮기지 않도록 해당 대상의 최초 confirmed 시각을 사용한다.

복수 유형·피해자 연결 사슬을 전역 단계로 합칠지, 각 사슬로 셀지는 사용자 답 대기다. 모든 사건이 하나의 공통 유형 또는 하나의 공통 피해자를 공유하지 않는 경우 general_multiple_chains_unresolved(55000)로 전체 거절한다. maxstage 등 미정 규칙을 구현하지 않는다. 원장 계산을 위해 owner가 확정 분류를 명시하며 시스템이 경미·중대를 자동 판정하지 않는다.

## 연속 취소와 이의: 구현 범위

cancellation_sanction_plan은 실제 SQL 계산 함수다. 최신 양측 합의 예정 시작→확정 시각→고유번호 순서, 첫3취소 경고·추가 매3취소7일, 정상 완료의 횟수만 초기화/경고 유지, 상대 취소·예외 제외, 중간 미정 보류, 취소 후24시간 전·검토 중 보류를 검증한다. 결과표 전수 등록과 실제 약속 결과 갱신 hook은 아직 없다. cancellationAction을 확정 판정에 명시하면 원자 제재·당도 적용은 가능하지만 후보 계산을 자동 판정 엔진으로 연결하지 않았다.

safety_appeals는 accepted/rejected에서 resolvedAt=NULL이 CHECK UNKNOWN으로 통과하지 못하게 막는다. 마감과 같은 접수는 거절하고1µs 전은 허용한다. 실제 취소24h/일반 안내7d에서 신뢰 접수 시각·deadline을 도출하는 공개 gateway는 없다. 이의 접수 원문·담당 증거 ACL·접근 감사·알림·종결 처리는 별도다. reviewing 기존 제한 유지와 명백 오류 invalidated의 원자 복원은 판정 계층에서 검증했다.

## 실제 검증과 한계

독립 컨테이너 supabase_db_yumidang-minkyu-drift의 데이터 없는54 schema-only와 검토된 lifecycle55 SHA를 새 yumidang_sanction_atomic_final_20261005 DB에 적용한 뒤 이 초안 전체를 적용했다. 전용 역할을 바꾸지 않았고 외부 삭제 guard는 닫혀 있다. 실제 SQL 회귀는 BEGIN/ROLLBACK 안에서 합성 네이버 subject/account metadata와 회원·사진 metadata를 만들었다. 이것은 실제 네이버 로그인·실제 blob upload·운영자 인증의 증거가 아니다.

전체 SQL 적용 및 회귀 PASS: revision 재시도/오래된 revision/ACL, 연속 취소 후보 전 사례, 정확 기간·최대 종료, NULL 이의 종결/엄격 마감, 필수 검증 신원·회차/다중 대상 부분 실패 롤백, qualification 정보누락·불충족/성별·나이 변경 시 판정 유지 및 미래 검증 시각·끊어진 account.userId 거절, 동일유형·동일피해자 경고7일30일,12calendar-month 윤년1µs 전/정각, reviewing 시계·당도 보존, 무효화 뒤 제재/당도 원자 복원과 후속 단계 정정, 종료 회차 최초 감점/사건 이동 거절, 새 당도15/identity 기존 제한 유지를 검사했다. 최초 fixture FK/bucket 누락 및 초기 회귀 실패 로그는 보존한다.

단일 transaction 회귀는 실제 두 세션 동시 판정/탈퇴 교차 실행 검증과 다르다. 잠금 순서를 코드 검토했으나 두 세션 경합은 후속 검증이다. 새 활동(공고 작성·신청·재신청·확정 요청/수락) gate, 기존 약속 관리 접근 유지, 본인 제재 S21 응답·알림, 결과 전수 hook, 후기 무효 연결, 이의 공개 gateway, 담당 배정, 보관·삭제 worker는 완료하지 않았다. 최소 연결 기록의 법적 보관/종료 조건은 승인하지 않는다. 운영 API나 배포 준비 완료로 설명하지 않는다.

최종 비공개 SHA·적용/회귀 로그·행0/guard 검사는 sanction-atomic-handoff.json에 따로 기록한다. 준비/실행 증거를 구분하고 다른 DB나 운영 성공으로 확대하지 않는다.
