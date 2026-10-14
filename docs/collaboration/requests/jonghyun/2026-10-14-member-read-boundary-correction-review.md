# 읽음 검증 도구 후속 로컬 커밋 검토 — 2026-10-14

전체 **79%(22/28)**. 이번 묶음은 이전에 승인·커밋한29개 이후 발견된 검증 도구 충돌의 보완이며, 제품 정책/SQL 변경은 없다. 커밋은 아직 실행하지 않았다.

## 대상과 정확한 변경 목록

- clone: `/private/tmp/yumidang-jonghyun-parallel-20261014`
- branch: `jonghyun/backend-parallel-20261014`
- 기준 HEAD: `915fc3154ef5183e24991f23efbac00551acaf00`
- actor `jonghyun`, hook `.githooks`; 아래3경로 소유권 통과.

| 경로 | 내용 SHA256 / 역할 |
|---|---|
| `tests/integration/jonghyun/member-root-boundary.py` | `e73c06dc2c92edad908cf6362fd63c4d7d395f879e73a366057d1a834777d8d2` / 동일 native 조회의 direct 추적 범위와 전체 JSON+SHA가 일치하는 후손만 허용 |
| `tests/database/jonghyun/test_member_root_boundary.py` | `808a19e74f86d4b64c304587ed129f9f2a43131009682f11f813dfb268b1812f` / 기존54+추가7개 책임 검사 |
| 이 검토 문서 | 위2파일과 실행 경계 검토; 자기 SHA는 별도 비공개 manifest에 고정 |

다른 미커밋 문서3개·native 경합 드라이버/시험2개는 이 커밋에서 제외한다. 대량 staging은 하지 않는다. 소유권 정책/hook/최상위 지침/성호 화면/민규 예외 경로/두 임시 지원 도구의 추가 편집은 없다. 푸시·운영 변경도 없다.

## 실제 원인과 보완

첫 새 대상에서 행사 실제 Auth→REST→DB·HTTP·SDK 검증은 Root 최종 baseline 확인까지 통과했다. Member 읽음100 경계 준비는 정상 자동 생성된 보관 세대 행을 미추적 후손으로 오인해 중단됐다. 실패 당시 고정 소스를 이용한 읽기 전용 진단에서 `conversation_message_generations`101행 모두 기존 direct FK 범위의 전체 행 JSON+SHA와 일치했다. 기존 실패 실행을 재전송하거나 성공으로 바꾸지 않았다.

보완은 동일 테이블이라는 이유로 무시하지 않는다. 현재 복합 FK 열 순서와 scoped 부모 조건을 유지하고, 동일 SELECT의 scoped direct union에 전체 행 JSON+SHA가 일치하여 포함되는 후손만 허용한다. 범위 밖 메시지·appointment 후손·추가 행은 계속 UNKNOWN으로 거절한다. cleanup은 부모/자식 행 잠금 후 같은 native 조회를 재검사하며 삭제 범위는 그대로다. 기존 정확 HEAD 검사도 유지한다.

## 검토와 실행 경계

구현 에이전트가 지정한 두 파일만 수정했고 Root가 SQL 보완/cleanup 조건과 최종 SHA를 읽기 검토했다. 책임 검사 **61/61 PASS**, AST2·소유권2·diff 검사 PASS다. 이는 모형 책임 검사이며 보완 SQL의 실제 실행 성공은 아니다.

원 생성 영수증의 첫 새 대상6컨테이너·1network·2volume만 정리했고, 기존6개 실행 metadata가 생성 전과 같음을 확인했다. 실패 run의 SQL 원복/연결 정리 성공으로 확대하지 않는다. [실제 단계 기록](2026-10-14-round2-validation-result.md)에 실패·진단·정리와 남은 순서를 보존했다.

승인 요청은 위3파일의 로컬 커밋만이다. 승인 후 staged3경로/HEAD/SHA/소유권을 다시 확인해 로컬 커밋하고, 이미 승인된 새 합성 환경에서 새 UUID·소스 증거로 남은 실제 검증을 계속한다. VM·한시 배정·제품 정책·검증 후 두 임시 지원 도구 원복 커밋 승인은 반복 요청하지 않는다. 두 임시 지원 도구의 원복/민규 담당 복귀는 아직 미완료이며 잔여 실제 검증과 자원 정리 뒤 진행한다.

AGENTS.md의 적용 근거는 “커밋·푸시를 자동 실행하지 않으며 실제 요청이 있을 때 대상 브랜치와 변경 목록을 확인한다”다. 이전 검토29개 승인을 새 변경3개로 확대하지 않기 위해 이번 로컬 커밋만 확인한다.
