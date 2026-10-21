# 종현 앱 소비 요청 — 공고 전용 행사와 변경 합의

민규 / WBS4.4 / 로컬 구현 `62e52d8` 기준. 앱·FE 파일은 수정하지 않았으며 이 문서는 외부 메시지 발송이 아니다. 원격 공유·운영 기능 활성화는 별도다.

[서버 계약](../../../../backend/contracts/event-storage.md)의 직접 입력·합의·공개 응답을 연결한다. 기존 `GET /posts/:id`의 exact 응답 키를 보존한다. 새 기능을 적용하지 않은 기존 앱은 기존 상세를 계속 읽는다.

- 행사 확장은 별도 `GET /posts/:id/event-link`에서 `{postId,eventId,manualEvent,linkedEvent,eventLinkState}`를 받는다. 기존 상세의 공개·숨김·탈퇴 권한을 재사용한다. 익명에게 비공개 상세나 당사자 이름을 추가 제공하지 않는다. 잘못된 JWT를 익명으로 자동 재시도하지 않는다.
- 생성·수정의 `manualEvent`는 `{title,placeName,publicAddress,publicAddressConfirmed}`다. 직접 입력은 공고에만 속하며 공용 행사로 등록되지 않는다. 공급사 `eventId`와 동시에 선택하지 않는다. 키 생략·명시 null·새 선택의 의미는 계약을 따른다. 공개 주소 확인은 만남 상세 위치의 공개 동의가 아니다.
- 직접 입력 원문은 기존 콘텐츠 검사와 정확한 입력 ticket 결합을 거쳐야 한다. 서버의 검사 제어가 닫힌 상태에서는 새 입력을 활성 기능으로 표시하지 않는다. 임의 확인값·클라이언트 승인으로 검사를 대체하지 않는다.
- 확정 후에는 기존 공고 수정 요청에 새 `eventChangeId`를 붙여 행사만 제안한다. 제목·시간·장소 등 다른 변경을 끼워 넣지 않는다. 제안 시 기존 연결을 즉시 바꾸지 않는다. 대기 중 당사자에게 반환되는 `changeKind/eventFingerprint/newEventInput/newLinkedEvent`로 실제 변경 내용을 표시한다.
- 상대의 명시 확인 후 `POST /appointments/:id/schedule-change/accept-event`에 `{changeId,conditionVersion,eventFingerprint}`를 보낸다. 기존 날짜·장소 수락 endpoint는 행사 제안을 거절한다. UI에서 보지 않은 행사 내용을 날짜가 같다는 이유로 승인하지 않는다.
- 제안 재시도 응답의 `event_change_pending/accepted/declined/expired/cancelled/withdrawn`을 구분한다. 승인 후에는 실제 적용 시각이 고정된 영수증을 받고 재적용하지 않는다. 기존 수락 RPC의 `deduplicated`는 최초 false·재시도 true일 수 있다. 종료된 제안의 원문은 서버에서 정리되므로 재표시를 위해 회원 원문을 임의 보관하지 않는다.

[실제 SQL 증거](2026-10-21-server-sql-evidence.json)는 합성 archive의 새 사본에서 저장·검색·공개 키·합의·재시도·권한/RLS를 검사한 결과다. HTTP 합성42개와 실제 SQL 통과를 실제 발급 Auth·앱 화면·회원·공급사·운영 통합 완료로 계산하지 않는다. 서버 migration 적용·검사 제어·새 앱 소비의 통합 순서가 확인되기 전 새 기능을 운영 활성화하지 않는다. 실회원 QA는 사용자의 별도 재개 요청 전 HOLD다.
