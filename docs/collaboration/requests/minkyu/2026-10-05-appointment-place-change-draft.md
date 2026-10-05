# 확정 후 일정·장소 변경 독립 초안

민규의 후속 SQL/API 설계 초안이다. 공식 CLI 생성 파일은 `20261005014629_appointment_place_change_draft.sql`이다. main50 파일과 운영·원본 DB를 수정하지 않았다. 부모 승인으로 기존 scratch50을 schema-only 복사한 별도 yumidang_place_20261005에53만 적용하여 기본 기능을 실제 검증했다. 기존 일정 변경의 clock 마감 경계는 이번 초안에 남아 있다. 51 철회·신뢰 접수 설계가 별도로 대기 중이므로 전체 정책 구현 완료나 배포 대상으로 설명하지 않는다.

## 기존 필드와 최소 입력

| API 필드 | 현재 저장소 | 기존 입력 경계 |
|---|---|---|
| publicArea | public.posts.public_area | 1~60자, 공개 시·도/동 지역. 공식17지역은 private.post_search_region으로 확인 |
| registeredPlaceName | private.post_search_locations.registered_place_name | 선택, null 또는1~200자 |
| registeredAddress | private.post_search_locations.registered_address | 1~300자 |
| meetingDetail | public.post_private_details.exact_location | 2~300자, 비공개 상세 지점 |

API 제안은 기존 `POST /appointments/:id/schedule-change/propose`에 optional `location`을 추가하는 것이다. 기존 필수 `changeId`, `startsAt`, `endsAt`, `expectedUpdatedAt`은 유지한다. location을 보내면 네 위치 key를 모두 포함하고 registeredPlaceName은 null을 허용한다. location 생략은 기존 일정 전용 요청이다. 장소만 변경할 때는 기존 startsAt/endsAt을 그대로 함께 보낸다. 행사 선택·제목·소개 변경을 이 제안에 넣지 않는다.

추가 DB overload는 `propose_appointment_schedule_change(uuid,uuid,timestamptz,timestamptz,timestamptz,jsonb)`다. 마지막 인수 p_location은 SQL NULL이면 장소 변경 없음, JSON null·배열·누락/추가 key는 invalid_location/22023이다. 기존5인수 RPC는 이 overload에 NULL을 전달하는 wrapper로 유지한다. 타임스탬프는 기존 offset ISO 및 정밀도 계약을 따른다.

## 수락 전후와 충돌

private.appointment_schedule_changes를 확장한다. 같은 기능을 담는 새 장소 변경 폴더·표·공개 post를 만들지 않는다. 신규 필드는 대기 새 위치 JSON, 새 입력 fingerprint, 기존 위치 fingerprint, locationChanged다. 기존 정확 위치 원문의 별도 snapshot을 만들지 않는다.

제안은 confirmed 당사자만 가능하다. 한 약속의 대기 제안은 기존 partial unique로 하나이며 시간과 장소를 하나의 조건 버전으로 묶는다. 6시간·기존 시작·새 시작의 최소 마감을 유지한다. 동일 changeId·제안자·약속·새 일정·expectedUpdatedAt·정규화 위치가 같으면 기존 결과를 반환한다. 다른 장소로 같은 ID를 재사용하면 충돌한다. raw 위치 입력이 정리된 이후에도 fingerprint로 재시도를 비교한다.

상대 수락 전에는 posts의 일정/공개 지역, 검색용 등록 장소/주소, 상세 지점을 전혀 변경하지 않는다. 따라서 미동의 새 장소는 일반·AI 공고 검색에 나타나지 않는다. 수락은 기존 post→requests→appointment→change→참가자 일정 잠금 아래에서 현재 일정/updatedAt/기존 위치 fingerprint와 조건 버전을 재검사한다. 기존 확정 약속과 일정이 겹치면 충돌하며 상대 약속을 자동 취소하지 않는다.

수락할 때만 posts의 일정·공개 지역과 기존 위치 두 저장소를 같은 transaction으로 갱신한다. 기존 public.set_post_search_location은 client EXECUTE가 없고 trusted service만 호출하므로, SECDEF 수락 함수의 내부 호출은 새 client 우회를 만들지 않는다. 모든 갱신 실패는 transaction 전체를 취소한다. 최초 생성 service_post_inputs·기존 match 동의 이력·연결 행사 UUID는 유지한다.

거절·철회·미응답·약속 취소는 실제 공고 위치/일정에 반영하지 않는다. 초안은 private.end_appointment_schedule_change에서 대기 위치 입력을 정리한다. 종료된 제안에는 locationChanged와 안전한 상태/ID/시각/fingerprint 비교 정보만 남기며, 새 위치 원문을 영구 장소 이력으로 보존하지 않는 기술안이다. 이 정리·표시 방식은 별도 업무 정책으로 주장하지 않으며 적용 전 계약 검토 대상이다.

## 표시 권한과 기존 관리 접근

변경 응답은 기존 schedule change 객체와 deduplicated를 유지하고 `locationChanged:true`, `newLocation:object|null`을 장소가 포함된 제안에만 추가한다. 시간 전용 제안에는 두 키가 존재하지 않아 기존 exact DTO를 보존한다. 정확한 newLocation은 해당 제안이 awaiting_response이고 현재 약속이 confirmed이며 실제 authenticated 당사자일 때만 반환한다. server/anon/PUBLIC나 다른 약속 관계에게 보이지 않는다. 알림 payload에는 장소 원문·정확 주소·상세 지점을 추가하지 않는다.

분쟁·차단의 관리 접근과 정확 위치 접근은 같은 조건이 아니다. main50의 block wrapper는 confirmed/disputed 약속의 공고·사진 관리 접근을 허용하지만, 내부 get_service_post의 full-location predicate는 confirmed/completed다. 분쟁이라는 이유로 모든 약속 관리를 막는 규칙을 추가하지 않는다. 본 초안의 새 제안 위치는 awaiting+confirmed 범위에 한정하며 분쟁의 정확 위치 정책을 확대하거나 새로 확정하지 않는다.

completed는 새 변경 제안 대상이 아니다. 기존 get_service_post가 completed 당사자의 현재 위치를 보여주는 것과 과거 제안의 새 위치 원문을 다시 보여주는 것은 별개다. 본 초안은 종료 제안의 newLocation을 null로 하고 현재 위치 조회는 기존 공고 계약을 사용한다. 취소 후 상대 정확 주소·상세 지점은 기존 predicate와 같이 숨긴다. 작성자의 자기 공고 현재 입력 관리 권한은 유지한다.

## 담당 충돌과 적용 순서

당도52 담당과 확인했다. `20261005013901_current_sweetness_ledger.sql`은 profile/appointment 회차와 후기 기여를 다루며 posts hook은 추가하지 않는다. 장소 초안은 후기·공개 프로필·당도/회차 함수를 수정하지 않는다. private.member_episodes/appointment_member_episodes를 중복 구현하지 않는다.

수정 함수는 private.appointment_schedule_response_open, private.appointment_schedule_change_json, private.end_appointment_schedule_change, public.propose_appointment_schedule_change(5인수 유지+6인수 추가), public.accept_appointment_schedule_change다. 새 helper 두 개는 위치 검증/기존 위치 fingerprint만 담당한다.

형식상 순서는 main50 → 검토된51 철회/receipt 연결 →52 당도 →14629 장소 초안이다. 실제51이 미확정이므로 아직 이 순서를 실행하지 않는다. 특히51의 helper 재정의가53의 위치 정리를 덮어쓰지 않도록 이후 timestamp/order를 검토한다. withdraw terminal을 지원하는 helper 확장은51의 status CHECK/RPC와 연결되며, 이 장소 파일만으로 철회를 구현했다고 설명하지 않는다. HTTP 연결은 민규의 routes/서비스/저장소와 응답 contract에서 나중에 별도로 반영한다. 종현 검색 파일은 직접 수정하지 않는다.

## 적용 전에 필요한 검증

아래는 기본 검증 행렬이다. 별도 DB SQL8그룹 및 실제 두 세션5그룹이 PASS했다. 51 철회와 receipt 마감 잠금 경합은 NOT_RUN이다.

- 양쪽 각각 시간+장소/장소만/시간만 제안, optional location의 JSON 타입·길이·공식17지역 경계.
- proposal 전후 posts/검색 장소/상세 지점이 불변이고 제3자·익명·AI 검색에는 새 위치가 없다는 실제 SQL/RPC 검사.
- 상대 수락 한 번만 반영, 본인 수락 금지, 같은 입력 재시도 성공, 다른 장소·version 재사용 충돌.
- 기존 위치가 trusted service를 통해 바뀌었으나 post updatedAt은 같을 때도 fingerprint 충돌.
- 일정 충돌·거절·철회·만료·취소에서 원래 일정/위치/완료 예약 유지.
- 장소만 수락한 경우 자동 완료 예약 dueAt/generation 유지, 시간 변경이면 기존 예약 trigger로 정확히 변경.
- 장소 입력이 제안 종료 뒤 정리되고 재시도 fingerprint가 살아 있으며 알림/로그에 원문이 없는지 확인.
- cancelled/비당사자/anonymous JWT newLocation 회수, disputed 관리 접근과 위치 표시를 구분, completed 신규 변경 금지.
- 수락↔취소/철회/새 proposal/장소 수정 두 세션 경합 및 각 participant 일정 advisory 잠금.
- 접수 시각 계약은 별도 deadline receipt 검증 행렬로 검사. 현재 clock source만으로 정책 PASS로 세지 않음.

기본 일정·장소 상호 동의 정책은 문서에 있어 새 선택이 필요하지 않다. receipt 접수 경계·pending 보관은 앞선 요청에서 별도 확인 중이다. 종료 제안의 장소 입력 정리·표시 최소안은 기술 검토 사항으로 기록했다. 이 문서가 새 UI 또는 영구 장소 이력의 승인을 의미하지 않는다.

## 2026-10-05 별도 DB 실제 검증

source yumidang_policy_20261005의 schema-only를 읽어 새 yumidang_place_20261005에 import했다. source/native postgres/운영에는 쓰지 않았고 전역 role을 만들거나 변경하지 않았다.53만 적용했으며51 RPC는 존재하지 않는다.

SQL 회귀 `tests/database/minkyu/appointment_place_change_draft.sql`8그룹 PASS/rollback: 실제 SQL NULL/미지원·17지역·타입·300자, 시간+장소/장소만/시간전용·6h/새시작 상한, 익명 JWT·완료 신규제안 금지·분쟁 관리와 정확위치 분리, 상대 수락/자기수락·다른입력 거절/멱등/등록주소 검색과 상세지점 제외, 장소만 변경 예약 유지, 거절·만료 기존값 유지, 취소 후 위치 회수, old updatedAt 같아도 등록위치 fingerprint 충돌.

두 세션 harness `tests/integration/minkyu/appointment_place_change_concurrency_local.py`5그룹 PASS: 수락 transaction의 미commit 새 위치가 공개검색에 보이지 않음+거절 충돌, 취소 먼저 접수 후 수락 충돌, trusted 위치 수정 먼저 접수 후 대기 수락 fingerprint 충돌, 기존5인수 두 동시 수락의 단일 반영/이벤트, 무작위 합성 자료 삭제. 실제 pg_stat_activity PgSleep로 잠금 보유 세션을 확인한 뒤 다른 세션을 시작했다. 마감 직전 receipt race를 이 PASS에 포함하지 않는다.

NULL 지역 명시 거절을 validator에 추가했다. current region helper의 SQL NULL 반환 및 validator의 JSON null 지역/미지원 지역 거절을 직접 검사했다. SQL 시험 첫 fixture에서는 anon role만 바꾸고 authenticated JWT 문맥을 남겼는데 이를 anon JWT와 UID까지 함께 바꾸도록 교정한 최종 회귀가 PASS했다. 두 세션의 신청자 제안 fixture에서도 수락자는 상대 작성자로 맞춘 최종 harness가 PASS했다.

취소/거절/만료 후 새 장소 입력 정리와 종료 이력의 newLocation=null은 여전히 기술 최소안의 검증이다. 제품 정책으로 채택/배포 완료를 뜻하지 않는다. 실제 withdraw51 proof, receipt 경계, 모바일 실제 DTO 연결, 운영 DB 적용은 NOT_RUN이다. M HTTP 선택 location 입력과 응답 전달은 18개 테스트 PASS이며 시간 전용 5인자 RPC/DTO 호환성을 포함한다.
