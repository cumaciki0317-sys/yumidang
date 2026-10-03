# 연결 행사 최신 표시 정책과 종현 연결 요청 — 2026-10-02

작성자: 민규. 사용자 답변 **“항상 최신 행사 정보 표시”**를 [정책.md 9장](../../../../정책.md#events)에 반영했다. 정책 확정과 구현·실제 검증 완료는 별개다. 현재 진행률은 무료1:1 웹 베타 백엔드 체크리스트43%·6/14이며6번 전체 완료가 아니다.

## 확정 범위

- 이미 공고에 연결한 행사는 선택 당시 정보로 고정하지 않고 canonical 저장소의 최신 행사 정보를 표시한다.
- 행사 갱신은 기존 공고 입력·동행 일정을 자동 변경하지 않는다. 날짜가 바뀌어도 공고의 `startsAt`·`endsAt`을 덮어쓰지 않는다.
- 연결된 행사 취소는 행사 정보의 `sourceStatus: "cancelled"`로 반환·안내한다. 취소 행사의 신규 조회·선택 제외와 기존 연결 조회는 분리한다.
- **추가 사용자 결정:** 작성자가 행사 교체·연결 해제·새 연결로 선택 UUID를 직접 변경하면 기존 최종 동의를 무효화하고 새 동의를 받는다. 같은 행사 UUID의 공급사 정보 갱신은 공고 입력·일정·동의를 자동 변경하지 않는다. 공고 모집·약속 자동 취소를 추가하지 않는다.

## 담당과 연결 계약

민규는 공고 입력/조회·DB/RPC·마이그레이션과 역할별 권한을 담당한다. 종현은 다음 기존 파일의 검색·행사·AI 연결과 자기 테스트를 담당한다. 같은 기능의 새 저장소나 중복 구현 폴더를 만들지 않는다.

- `backend/supabase/functions/_shared/contracts/search.ts`·`contracts/ai.ts`: 공개 카드/AI 입력과 연결 행사 투영의 타입을 맞춘다.
- `backend/supabase/functions/_shared/db/repositories/search.ts`·`services/search-service.ts`: 공고 RPC의 최신 행사 투영을 그대로 검증·전달하고 행사명 검색을 연결한다.
- `backend/supabase/functions/_shared/integrations/events/port.ts`·`db/repositories/events.ts`·`services/event-service.ts`: 기존 `StoredEventRecord`·`sourceStatus`·날짜/시각 정밀도를 재사용한다. 신규 선택용 목록에서 숨긴 취소 기록을 기존 연결용 조회에서도 없어진 행사로 처리하지 않는다.
- `backend/supabase/functions/_shared/ai/Agents/chatbot/intent.ts`·`discovery.ts`·`event-discovery.ts`: 최신 연결 행사명을 사용하고 동행 일정과 행사 일정·입장료와 동행 비용을 구분한다. 비공개 만남 지점은 검색·AI 입력에 넣지 않는다.
- `backend/contracts/search.md`와 종현 자기 테스트: 새 계약·오류·권한·커서 회귀를 기록한다.

DB는 기존 `private.source_events`의 안정된 UUID를 참조하고 최신 record를 조회 시 투영한다. 선택 당시 행사 사본을 별도 canonical로 저장하지 않는다. 현재 HTTP의 `FreePostInput`에는 행사 연결 필드가 없다. 신규 민규 SQL은 `eventId`로 UUID를 저장하고 상세의 `eventId`·`linkedEvent`로 최신 행사를 반환하며 검색은 행사명 일치만 추가해 기존9필드 카드를 유지한다. 앞선 실제 SQL12그룹은 PASS였으며 이번 수동 교체·재동의 정책 추가 뒤에는 다시 검증한다. HTTP·종현 카드/AI 연결은 후속이며 SQL 검증으로 해당 연결을 완료 표시하지 않는다. 동의 지문에는 선택 UUID만 포함하고 공급사 최신 필드는 넣지 않는다. 연결 없는 과거 공고의 지문과 생성 입력 원문을 보존한다. `StoredEventRecord`의 `id`·`title`·`sourceStatus`·`precision`별 일정·`placeName`·`publicAddress`·`admission`·`sourceUrl`·`collectedAt`을 기준으로 필요한 공개 투영을 정하며 기존 공고 주소 공개 경계를 넓히지 않는다.

기존 [공고 계약](../../../../backend/contracts/posts-search.md)은 이번 하네스 보존 대상이라 직접 수정하지 않았다. 해당 계약의 행사 연결·검색 미완료 문구는 현재 구현 이력이며 사용자 최신 표시 결정을 대체하지 않는다. [행사 DB 계약](../../../../backend/contracts/event-storage.md)과 [숫자 나이 연결 요청](2026-10-02-search-numeric-contract.md)을 함께 따른다. 숫자 나이와 종현 HTTP3개·SQL2개 기존 기대 갱신은 별도 후속이며 행사 표시 결정으로 해소된 것이 아니다.

## 완료 확인 조건

1. 행사 연결 후 최신 title/기간/상태를 갱신하면 공고 조회·카드·AI의 행사 정보가 최신값을 사용한다. 동행 일정·등록 입력·공고 관계는 보존한다.
2. 취소 후 신규 선택에서는 제외되지만 기존 연결은 취소 상태를 제공한다. 공고 모집·신청·동의·약속을 임의 종료하지 않는다.
3. 행사명 검색과 최신 제목 변경의 일치가 실제 DB/RPC/HTTP 연결에서 확인된다. 등록 주소의 검색 일치와 비공개 표시 권한을 구분한다.
4. 공식 링크 null·비용 unknown·정밀도·기존 UUID·역순 수집 stale 보존을 확인한다. 제공처 장애나 자료 부재를 정상 행사·무료·0건 성공으로 만들지 않는다.
5. 작성자 수동 A→B 교체·해제·새 연결 때 기존 동의 무효화·변경 알림·기존 버전 수락 거절·새 동의 요청 가능을 확인한다. 신청·대화·동행 입력·일정과 최초 생성 입력은 보존한다. 공급사 같은 UUID 갱신은 동의와 공고 버전을 바꾸지 않는다.
6. 익명/회원/작성자/확정/취소 권한과 기존 숫자 나이·커서·비공개 회귀를 유지한다. 정책 반영만으로 이 검사를 PASS로 기록하지 않는다.

외부 메시지는 전송하지 않았다. 상대 담당 파일은 읽기만 했고 구현 수정은 담당별 새 하네스 범위에서 진행한다.
