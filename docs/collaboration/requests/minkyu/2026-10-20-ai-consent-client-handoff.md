# 종현 앱 소비 요청 — AI 선택 동의와 서버 사전 상태

민규 서버 로컬 구현 기준 a85a833 이후. 원격 공유·운영 적용 전이며 실제 회원 HOLD 유지. 현재 앱 파일은 수정하지 않았다. 본 문서는 외부 메시지 발송이 아니다.

기존 [AI 동의 계약](../../../../backend/contracts/ai-consent.md)의 GET /me/ai-consents, POST /me/ai-consents/set, GET /me/ai-availability를 소비한다. 경로 앞에는 기존 service-api prefix를 사용하고 현재 본인 JWT를 유지한다.

- 탐색은 첫 사용 시 별도 동의하고 거절하면 일반 검색을 유지한다.
- 가입의 후기 열람/본인 생성·노출/작성 원문 활용은 독립 선택3개·기본false·전체동의 편의 기능이다. 서버는 kind별 정확한 boolean만 받고 userId/원문/암묵적true를거절한다. 미동의 가입·일반 동행을허용한다.
- 전체동의 UI의 여러 저장 요청 중 일부 실패는 성공으로표시하지말고서버GET으로실제값을확인한다. 구형summary_allowed를새3동의로복사하지않는다.
- 독립철회는다른동의·일반후기/별점/당도·계정에영향주지않는다. 구형일괄review_summary철회는호환용이며새설정UI는개별setter를사용한다.
- availability.estimatedEligible은일회서버사전판정이다. reason은processing_disabled/consent_required/concurrent/daily_limit/null,remaining과KSTday/checkedAt/resetsAt이반환된다. 실제요청의서버판정이항상우선이다. 공급사연결/예산확보/모델가용성보장아님.
- 상태확인후버튼을제어하되클라이언트횟수/자정타이머/재진입만으로다시활성화하지않는다. 입력·안내는보존하고자동재전송하지않는다. 재확인경로실패시보수적으로상태를유지한다.

실제SQL3파일PASS와HTTP계약4개확인을 [증거요약](2026-10-20-current-runtime-evidence.json)에연결했다. 실제HTTPAuth/앱/회원/공급사검증과동시철회는후속이다. SDK응답검사·가입세션흐름·서버마이그레이션의통합순서와기능노출을종현앱변경/민규서버적용각담당에서함께검증한다. 커밋된코드존재를현재운영활성화로해석하지않는다.
