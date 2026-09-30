# 2026-09-30 미정사항 답변 후속 작업 목록 (재개용)

현재 확정 정책·미정·검토 필요·팀 후속 작업은 [정책.md](../../../../정책.md#follow-ups)에서 확인한다. 아래 체크박스는 해당 작업 당시의 실행 기록이다.

근거: 사용자 결정표 답변(U1~U13, 2026-09-30 04:38). 커밋·푸시·원격 DB·배포 없음, 종현 소유 경로만. 완료하면 `[x]`와 근거를 적는다.

## 결정 기록
- [x] 결정 기록 완료: 설계 결정 표(U1~U13 행), 미정사항.md는 민규·팀 처리 목록(T1~T5, M1~M6)만 남김(U4 00:01, U5 C 현재 방식, U8 A, U9 A+대안, U10 A 두 형식 시도, U2는 정책 확인 보고 후)

## 작업(우선순위 순)
- [x] U2(보고 완료, 미정사항.md U2 절): 포텐스닷 약관·개인정보처리방침·보안 기술 문서(Notion 3개) 확인 → 보관·학습·제3자 제공 조건 요약 보고
- [x] U10 키 형식 확인 완료(두 형식 모두 0000, 로컬 TOUR_API_KEY_FORMAT=decoded) (재호출 불필요)
- [x] U10 완료(2026-09-30 08시대): `_shared/integrations/events/tourapi.ts`, event-sync 등록부·카드 표시 이름 추가, 가상 검사 `event-provider-tourapi.test.mjs` 5/5, 실제 1페이지(2026-10-05~11, rows 5) 5건 정규화 OK. 원래 항목: TourAPI(`https://apis.data.go.kr/B551011/KorService2/searchFestival2`) 공급사 어댑터·정규화·검사 구현(기존 KOPIS 구조 재사용), event-sync 등록부 추가. 실키 검증 호출은 1페이지만
- [x] U9 완료: 제안 SQL `05_event_filter_values.sql` + 검사 `event_filter_values.sql`(실제 로컬 DB PASS, 제안 5개 전체 5/5, 민규 회귀 8/8), 저장소 `listEventFilterValues` + 가상 검사. 원래 항목: 행사 필터 값 목록 조회(제공처별 지역·분류 원문 값) — 제안 SQL(04 확장 또는 05) + repository + 검사. 값 섞임 대안(제공처 라벨 표시·추후 매핑 층) 문서화
- [x] U6·U7 완료: `2026-09-30-operational-values-proposal.md`. 원래 항목: 운영 한도 보수 제안값 표(항목별 이유) + AI 예산 원장 교체 주기·한도 제안 → `2026-09-30-operational-values-proposal.md`(미정사항 T5가 이미 이 파일을 링크함), 민규 요청 M2와 연결
- [x] U13·U4·U9 민규 요청 반영(R1 표 5번, R2 허용 목록, R3 결정). 원래 항목: 민규 요청 R3에 ‘공개 프로필(S14) 성향 추가’, ‘일일 실행 00:01 Asia/Seoul’ 결정 반영
- [x] U11·U12: 미정사항 T4·M5에 기록
- [x] 인계 문서 ⑥절·하네스 갱신, 회귀 검사 260/260·97/97·Deno 5·DB 5/5. 원래 항목: 인계 문서·하네스 갱신, 회귀 검사(`node --test tests/*/jonghyun/*.test.mjs`)
