# 취소 해소 v2: 유효 접수 뒤 기존 suffix 효과 보류 후보

작업자 minkyu/A. root 최신 A3 소유권 검사·하네스 검사는 PASS이며 저장소 source 파일 편집은 0이다. 이 private 후보는 v1 최소 오류 교정 SQL25a51/회귀dc4c15 위에 별도로 작성했다. v1 실제 단일TX PASS 영수증은 `/private/tmp/yumidang-cancel-resolution78-held-record-corrected-reviewed/receipt.json` / `9e47b7b2615c8398be8bde88199e82a9e69f83b2cae04a7a30a21c881c231481`이다. 원14af/36ead/f44b, revision 교정본, 두 FAIL, 설계375a 및 B 독립 리뷰0288은 변경하지 않는다. 이 v2의 실제 SQL/DB/API/CLI 실행은 NOT_RUN이다.

## 기존 계약과 변경 경계

기존 typed8 직원 해소 exact7, 직원 state exact6, 본인 통지 list2/item10, job/global fenced due 계약과 guardfalse/EXEC 폐쇄는 v1 그대로다. source76/77 공개 접수 본문·statement_timestamp trusted DB 수신 시각·성공 replay snapshot·fresh session/회차/상세 TTL 계약을 변경하지 않는다. 일반 incident·회원/직원 guard·record/recompute/sweetness helper의 권한이나 본문을 넓히지 않는다.

새 `private.cancellation_effect_suspensions`는 정확 원 application ID를 PK/FK CASCADE로 사용한다. 원 identity/incident/sourceEpisode/decisionRevision/kind/appliedAt/expiresAt, 원 cancel_sanction 유효 감점 여부, active/restored/invalidated와 보류/종료 사실만 저장한다. 신고 원문·기간·회원 입력을 복사하지 않는다. application 수명보다 lineage를 늘리지 않는다. active lineage를 가진 application 직접 삭제는 55000으로 닫아 predicate 소실 뒤 confirmed 효과 부활을 막는다. 실제 보관 엔진의 절차 종결 연결은 별도 미완료이며 새 보관 기간을 정하지 않는다.

현재 최소 결과의 reviewing own_cancel이 anchor 앞 또는 같은 순서이면 보류 근거다. 양쪽 기존 agreedStarts/confirmedAt/AP UUID 순서를 그대로 비교한다. 복수 reviewing 중 하나만 해소돼도 남은 근거가 있으면 suffix를 복원하지 않는다. report 삭제는 최소 결과를 바꾸지 않아 보류 해제를 일으키지 않는다. identity 내 ordering_unknown이 있으면 reviewing 접수 권리를 추가 거절하지 않고 이미 적용된 해당 identity의 취소 effect만 임시 보류한다. 증명할 수 없는 prefix/suffix를 추정하지 않으며 일반 제재는 유지하고 ordering_unknown policy_pending·두 횟수 NULL을 반환한다. 알려진 원순서가 회복되기 전 자동 복원/최초 효과는 열지 않는다.

## 같은 TX 보류와 복원

reviewing head 전이에 owner 전용 AFTER UPDATE trigger를 추가한다. 같은 접수 TX에서 기존 cancellation chain suffix의 활성 원 application을 `cancellation_review_suspended` 사유로 먼저 revoke하고 lineage를 active로 기록한다. 원 incident는 confirmed로 유지한다. 이후 기존 sweetness sync는 취소 감점을 임시 비효력으로 전환하며 generic recompute는 active suspension에 가려진 효과를 다시 만들지 않는다. 이미 만료된 기간도 원 기록 그대로 보존한다.

기존 `effective_safety_subjects(uuid)`만 정확 cancellation/identity/incident의 active suspension을 제외하는 조건으로 CREATE OR REPLACE한다. source21810의 원 prosrc를 정확 anchor로 검사하고 기존 OID/owner/ACL/config를 보존하며 예상 새 prosrc 전체를 검사한다. 다른 기존 핵심 함수5의 본문/메타데이터는 그대로 검사한다. 일반 minor/major/no_show 및 타 identity는 필터에서 제외하지 않는다.

거절 뒤 확정 plan에 원 anchor/kind가 다시 포함되고 다른 reviewing 근거가 없을 때, latest non-reviewing raw confirmed subject와 lineage의 원 revision/episode/kind/application/기간을 모두 검증한다. lineage predicate 해제와 정확 기존 application revoke 해제를 generic recompute 앞 같은 TX에서 수행한다. 원 appliedAt/expiresAt을 바꾸지 않아 만료된 원기간도 재시작하지 않는다. 종료 원회차도 실제 과거 sweetness_incidents와 원 valid 감점 기록이 있던 같은 사건만 기존 decide helper로 복원한다. 신규 회차나 과거 감점 없는 종료회차 최초효과는 여전히 policy_pending이다.

수락 또는 정상 정정으로 확정 prefix에서 빠진 효과는 filtered helper 부재를 무효 판정 근거로 쓰지 않는다. 별도 `raw_cancellation_subject(identity,incident)`로 최신 non-reviewing confirmed 판정과 원 subject를 읽고, 기존 record helper로 invalidated revision을 생성한 뒤 lineage를 invalidated로 마감한다. 감점 복구와 잘못된 효과 철회를 같은 TX에서 반영한다. 새 anchor 시계 승계는 계속 미정이며 기존 anchor_clock_transfer_unresolved를 유지한다.

## 잠금과 실패

기존 account/profile/episode SHARE 접수 경계 뒤의 lock upgrade가 다른 요청과 충돌하면 전체 40001 rollback이다. 관련 incident advisory는 UUID 정렬·try 방식으로 확보하여 반대 순서의 기다림을 만들지 않고, canonical account/profile/episode/identity/head UPDATE NOWAIT를 재검사한다. identity/head 확보 뒤 incident 집합이 바뀌면 추가 역순 잠금 대신 40001로 닫는다. 새 접수 trigger는 공개 source76/77의 최종 session/회차/TTL 재검사를 그대로 거치며, 해소는 기존 staff 최종 guard, due는 기존 job/global 최종 fence를 그대로 거친다. 교착·timeout·불확실 종료는 성공이나 자동 재시도로 처리하지 않는다.

## 회귀 후보와 한계

기존 v1 회귀를 유지하고 lineage/감점 결정까지 failure fingerprint에 포함했다. 추가 회귀는 실제 원회원 atomic appeal RPC로 기존 적용 suffix를 보류한다. owner가 과거 취소 시각과 과거 application 기간만 조정하므로 마감 전 statement가 due account 잠금을 기다리는 실제 두 세션 증거는 아니다. 원 warning prefix/타 identity 효과 불변, final session 만료 trigger 뒤 신고·접수·lineage·점수 전체 원복, replay 불변, active application 삭제 거절, 두 reviewing 중 첫 거절만으로 복원 없음, accepted 정정의 raw confirmed 확정 철회, 종료 원회차에서 같은 원application/이미 만료된 원기간/원점수 복원, closed ACL을 검사하도록 작성했다.

최종 SQL 실행·두 세션 교착/접수↔due 재현·실제 Auth/Storage/member/staff HTTP는 아직 NOT_RUN이다. 기존 v1 PASS를 v2 PASS로 확대하지 않는다. 무report 자동 변경 상세 통지는 목적종료 gate가 없어 여전히 생성/조회/ACK를 열지 않는다. J kind/예약/실행·재접속, 자동 통지 보관/외부 전달, 실제 최종종결/90일 engine 및 backup, hosted/mobile/운영과 일반7일 anchor/hide90·최소 identity 목적종료는 남아 있다. 전체 목표를 이 후보의 범위로 축소하지 않는다.


## 최신 실제 단일TX 검증

root가 격리 native77 위에서 후보 SQL542d2efcc3c44e45e4d3cd1f7caeb2f22e5649615a22ff547f319267a45b3efa/회귀f8fb5738345e5b3334e7fc254273de136b5c116589bb2494d8a426e98c03d478를 단일TX로 검증했다. 영수증 `/private/tmp/yumidang-cancel-resolution78-v2-single-tx-reviewed/receipt.json` SHA `a7b04d16c627720ccb65f724ec732cd1245250ad9230efaca6abb4a1fcd320a3`는 PASS이며 검사8개 true, commit0, remote uncertainty false, 전체 원복을 기록한다. 정식 이력은77로 유지된다. 이것은 SQL 기본 회귀와 합성 원회차/원기간/보류 관계 증거이며 실제 due↔접수 두 세션 경합·Auth/Storage API·정식78 적용·운영 증거가 아니다. 해당 단계는 NOT_RUN이며 원FAIL/v1 동결 증거를 유지한다.
