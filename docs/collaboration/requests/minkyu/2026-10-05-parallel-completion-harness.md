# 민규100% 목표 병렬 하네스

[실행 정의](../../minkyu-parallel-completion-harness.json)는 기존 check_harness.py를 사용한다. 민규 담당13영역의 분모와60% 추정을 유지한다. 에이전트 추가나 준비 검사만으로 달성률을 올리지 않는다.

| 작업선 | 진행할 일 | 독립 작업/의존 관계 |
|---|---|---|
| A policy_audit | native67 적용 스크립트·권한·복구 gate | 스크립트 작성은 B/C와 동시; 실제 실행은 root |
| B sungho_scope | 정상 정정↔탈퇴 경합 검사 | 코드 작성은 A/C와 동시; native67 실제 적용 후 실행 |
| C runtime_connections | 요구 누락·다음 독립 구현 감사 | 읽기 전용, 실제 실행 상태 확인 후 결과 인수 |
| root | 통합·실제 DB 검사·진행률 | DB 작업은 직렬, 소유권과 고정 SHA로 통합 |

현재 세션은 새 agent 생성 thread limit에 도달하여 기존 agent를 재사용한다. capacity 실패가 반복되면 C는 root가 이어받아 A/B 작업을 계속한다. 실제 활성 agent 수는 collaboration 상태로 확인하며 명목상 목록을 실행 증거로 쓰지 않는다.

각 구현 agent는 별도 worktree를 사용한다. 같은 파일·Git 인덱스를 공유하지 않는다. 새 작업은 확정 정책·소유권·입출력 계약을 확인한 뒤 정확한 경로를 배정한다. 종현 AI·검색·행사와 성호 UI는 이 하네스의 구현 범위 밖이며 민규 연결 책임은 유지한다.

운영 읽기 재확인: yumidang Supabase ACTIVE_HEALTHY, migration20·profile3·post2·appointment1. 원격 Naver/예약/검토 hold/worker role 없음, 기존 매분 자동 완료 cron 활성. 회원 원문·키를 읽거나 운영을 변경하지 않았다. 실제 운영 전환과 Railway 서비스 연결은 추가 준비가 필요하다.

결과는 status·summary·next_actions·artifacts 형식으로 받고 실패에는 원인·안전 재시도·중단 조건을 기록한다. 단위/합성/로컬 통합/운영/화면 검증은 구분한다. 완료 전 요구별 증거를 대조해100%를 판단한다.


## 첫 단계 결과와 다음 단계

격리native67정식적용·반영후SQL회귀·정정/탈퇴경합2건PASS, 공개삭제HTML초안통합. 완료/후기75와공개삭제50단계로민규825/1300=63%다.100%미달이며운영·게시·실메일·법적검토는유지한다.

다음A는기존실제API driver에native67정확범위를확장하고최신완료/후기HTTP를검증한다. B는인증/사진의증거누락을읽기감사한다. C는기존/me/safety를보존하고새GET/me/sanctions 후보를작성한다. 세작업은별도파일/작업공간에서동시진행한다. C의root통합은A의67실제HTTP검증후수행해준비source49가변경되는경합을피한다.새SQL정확경로는CLI생성20261005135215_member_sanction_history.sql이며실제DB실행은아직하지않았다.

## 회원 API 실제 검증과 다음 병렬 작업

A의 검토된 driver `8f991caf9ab45c31fc46e878522dd6d80375fe6ea8ce243f1fa5a323cf6eff28`을 root가 격리 native67에서 실행했다.15그룹 및 정리 PASS이며 영수증은 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-naver-native67-J8W8Gy/result.json`이다. 실제 OAuth/운영 실행의 증거는 아니다. B는 기존 `member_cleanup_native_local.ts`에서 탈퇴 전 발급 사진 URL의 접근 회수 검증을 준비하며, C는 본인 제재 내역 읽기 후보를 준비한다. DB 쓰기는 root만 직렬 실행한다.


## 2026-10-06 현재 진행률 정정

현재 민규 단계 점수는63.5%다. native67 사진 실패로 내려간 두 영역은 native69 실제 인증 사진·탈퇴/정리 검증 후75로 복원한다.60%를 유지한 마지막 표시는 갱신 누락이며 [현재 진행표](../../minkyu-progress.md)의 고정13영역825/1300을 따른다. 기존 실패·운영 URL/CDN·모바일·배포 미완료는 보존한다.
