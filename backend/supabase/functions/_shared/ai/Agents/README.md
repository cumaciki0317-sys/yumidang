# 유미당 AI 에이전트 구현 위치

담당: 종현담당 · 상태(2026-09-30): AI 탐색(C 방식 의미 비교 포함)·후기 요약 worker·포텐스닷 어댑터·예산 포트를 구현하고 가상 검사와 로컬 DB(제안 SQL) 검증을 마쳤다. 실제 모델 호출·민규 허용 목록/정식 마이그레이션·Edge 배포는 대기이며 현재 런타임은 안전하게 비활성이다. [인계](../../../../../../docs/collaboration/requests/jonghyun/2026-09-29-claude-implementation-handoff.md)

- [chatbot/](chatbot/): 자연어 탐색 에이전트. 문맥 구성·조건 해석·공개 검색 도구·결과 카드·출력 검증 파일 8개.
- [review-summary/](review-summary/): 공개 리뷰 요약 에이전트. 원문 조회·3개 기준·요약·근거 검증·조건부 게시 파일 7개.
- [../providers/](../providers/): 두 에이전트가 사용하는 모델 계약·제공사 어댑터·오류 변환 파일 3개.

탐색 요청 진입점은 `functions/ai-chat/`, 요약 작업 진입점은 `functions/review-summary-worker/`에 유지한다. 두 진입점은 구현됐으며 실제 Edge 실행은 민규 연결 후 검증한다. 기존 `ai/chatbot/`과 `ai/review-summary/`의 구현용 파일을 이곳으로 이동했으므로 이전 위치에 중복 구현하지 않는다.
