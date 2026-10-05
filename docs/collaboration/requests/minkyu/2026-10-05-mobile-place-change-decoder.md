# 장소 포함 일정 변경: 종현 모바일 연결 요청

작성자 minkyu. 민규 독립 worktree의 53 SQL/HTTP 초안이며 운영 적용이나 receipt 완료를 뜻하지 않는다. 종현 소유 파일은 수정하지 않았다.

## 현재 확인

현재 authoritative foundation의 `apps/mobile/src/types.ts`에는 로컬 Appointment 모델이 있지만, `apps/mobile`의 TypeScript 파일에서 schedule-change/conditionVersion/oldSchedule/newSchedule 원격 변경 decoder는 발견하지 못했다. `apps/mobile/src/remote.tsx`의 기존 토큰·원격 연결과 구분한다. 다른 종현 브랜치에 decoder가 있다면 그 파일을 기준으로 아래 선택 계약을 연결해 주세요. 현재 파일 존재만으로 모바일 연결 완료라고 설명하지 않는다.

## 요청·응답 계약

`POST /appointments/:id/schedule-change/propose`의 기존 body `{changeId,startsAt,endsAt,expectedUpdatedAt}`를 유지한다. 장소를 포함할 때만 `location:{publicArea,registeredPlaceName,registeredAddress,meetingDetail}`을 추가한다. 네 키가 필수이고 registeredPlaceName은 null 허용이다. location 자체 null은 잘못된 입력이다. 장소만 제안할 때도 조회한 현재 일정 두 시각과 원본 6자리 정밀 updatedAt을 보낸다. 사용자 receivedAt/requestedAt/expiresAt을 추가하지 않는다.

공개 지역 17개/기존 별칭, publicArea 1~60자, 장소명 null 또는 1~200자, 등록 주소 1~300자, 상세 지점 2~300자 검증을 따른다. 공고 검색·표시는 상대 수락 전 원래 장소를 사용하며 제안 장소를 검색 결과에 넣지 않는다. 수락/거절 body는 기존 `{changeId,conditionVersion}`을 그대로 사용한다.

변경 객체 decoder는 `locationChanged?:true`, `newLocation?:LocationInput|null`을 선택으로 받아야 한다. 시간 전용 응답에는 두 필드 모두 없다. 장소 제안에만 locationChanged=true가 존재하고 newLocation은 대기 중 허용된 당사자에게 객체, 종료·취소·권한 회수 시 null이다. null을 이전 캐시 장소나 현재 공고 주소로 대체하지 말아 주세요. 현재 공고 위치는 기존 권한 조회로 별도 읽는다. 비당사자 오류·취소 snapshot unknown 등 기존 계약도 유지한다.

## 검증·남은 범위

M HTTP 18개, 독립 장소 DB SQL 8그룹 및 두 세션 5그룹 PASS. 시간 전용 exact shape, 선택 장소의 입력·출력, 수락 전 검색 불변과 수락 후 원자 반영을 확인했다. 모바일 실제 연결은 NOT_RUN이다. 51 철회 및 receipt 마감 판정은 미완료로, 이 요청이 철회 버튼 활성화나 마감 경합 완료의 근거가 되지 않는다. 대기 정확 장소 정리는 기술 최소안이며 제품 보관 정책 확정과 분리한다.
