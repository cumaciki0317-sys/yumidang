# gateway CORS 후속 연결

> 현재 기준: [정책.md](../../../../정책.md) · 문서 기준일: 2026-10-05

functions-v1 서비스/라우트/plugin 적용 범위를 실제로 조사한다. 생성 설정 임시 수정 결과를 기본 CLI 성공으로 부르지 않고 명시된 설정의 차이·재적용·복구 절차를 남긴다.

## HTTP·gateway 확인 계약

함수의 CORS와 앞단 gateway 응답을 별도로 검사한다. 허용 Origin의 GET·오류·OPTIONS, 미허용 Origin의 거절, 요청 헤더·메서드·Origin null/누락·브라우저 자격증명 모드를 확인한다. `ALLOWED_ORIGINS`, 정확한 ACAO·Vary·no-store·X-Request-Id 노출과 프로젝트 OPTIONS 계약을 유지한다.

gateway의 `preflight_continue`만 바꾸면 일반 응답 헤더 덮어쓰기가 남을 수 있다. 함수경로의 CORS를 앱에 위임하거나 정확한 origins와 전달조건을 함께 맞추는 설정을 해당 환경에서 확인한다. Auth·Storage·다른 서비스 설정을 일괄 수정하지 않는다. 재시작·재적용 후에도 실제응답을 확인하고 로컬·운영 결과를 합쳐 보고하지 않는다.

CORS는 JWT·RPC 권한검사를 대신하지 않는다. 내부 worker secret·회원 JWT·익명 공개조회 경계를 분리하고 원문·키가 들어갈 수 있는 gateway전체설정이나 URL은 출력하지 않는다.

## 확인할 범위

현재 정책에 맞춘 코드·SQL 적합성, 실제 Auth/DB/HTTP, 브라우저, 공급사, 운영 배포를 각각 확인합니다. 이번 작업은 문서만 갱신했으며 이 기능의 실행 검증을 수행하지 않았습니다. 필요한 변경은 담당별 허용 경로에서 진행하고 기존 코드·SQL·실제 자료를 변경하는 승인은 별도로 확인합니다.
