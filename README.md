# 유미당

성인 여성의 무료 1:1 동행을 준비하는 서비스입니다. 현재 정책과 검토 항목은 [정책.md](정책.md) 한 곳에서 확인합니다.

## 현재 문서

- [정책](정책.md): 확정 정책, 팀 보류, 추후 기능, 사실·구현 확인의 구분
- [PRD](docs/planning/requirements/PRD.md): 제품 목적·대상·범위와 요구사항
- [IA](docs/planning/design/IA.md)·[사용자 흐름](docs/planning/design/USER_FLOW.md): 화면 구조·행동·예외·복귀
- [서비스 계획](PLAN.md)·[상세 설계](PLAN_상세설계.md): 적용할 흐름·기술 경계·담당 연결
- [프로젝트 지침](AGENTS.md)·[협업 규칙](docs/collaboration/README.md): 작업 범위와 결과 기록
- [종현 현황](docs/collaboration/jonghyun.md)·[민규 현황](docs/collaboration/minkyu.md): 후속 연결과 제한

[와이어프레임](docs/planning/design/yumidang-wireframes.html)은 프론트 담당자가 관리하는 시안입니다. 현재 정책 문서와 화면 표현·실제 연결·운영 검증은 각각 확인해야 합니다.

## 연결 및 검증 상태

네이버 전용 가입·로그인, 현재 무료 범위, 19~99세 검색 범위, 연결 행사명 검색, 한 사람의 완료 확인 후 선제 후기 제출, 최신 행사 정렬·Top 10은 적용할 요구사항입니다. 이번 문서 변경은 코드·DB·HTML·운영 설정을 변경하지 않았습니다.

기존 구현은 전부 골격인 상태가 아닙니다. [결함 수정 근거](docs/collaboration/requests/jonghyun/2026-09-30-five-defects-fixed.md)와 [Git 통합 인계](docs/collaboration/requests/jonghyun/2026-09-30-jonghyun-integration-handoff.md)에 당시 로컬 검증 범위가 있습니다. 해당 결과를 새 정책의 구현·운영 완료로 확대하지 않습니다.

`backend/supabase/migrations/`의 기존 이력과 테스트·실행 자료는 보존하고, 승인된 후속 구현에서 영향을 확인합니다. 실제 작성 위치는 [백엔드 안내](backend/README.md)를 따릅니다. 비밀 환경 파일은 Git에 넣지 않습니다. 사용자는 전체 문서 검토 후 커밋·푸시를 요청했습니다. 실제 공유 결과는 최종 인계와 Git 이력에서 확인하며 원격 DB 변경·배포는 별도입니다.
