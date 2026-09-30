# 유미당

현재 와이어프레임을 개선해 프로토타입을 만들고, 기존 Supabase에 연결합니다.

## 기획과 화면 기준

- [정책 — 확정·미정·검토 필요](정책.md): 팀 전체가 현재 정책과 남은 결정을 확인하는 문서
- [PRD](docs/planning/requirements/PRD.md): 팀의 제품 목적·대상·핵심 흐름
- [추가 요구 사항](<docs/planning/requirements/추가 요구 사항.md>): 추가 기능과 결정 이유
- [화면 수정 요청](docs/planning/requirements/전달.md): 구체적인 요청과 검토 사항
- [IA](docs/planning/design/IA.md): 화면과 정보 구조
- [사용자 흐름](docs/planning/design/USER_FLOW.md): 행동 순서와 예외
- [와이어프레임](docs/planning/design/yumidang-wireframes.html): 프론트 담당자가 개선하는 HTML 시안

와이어프레임은 HTML 파일을 브라우저에서 열어 확인합니다. 실제 서비스 연결 완료를 의미하지 않습니다.

## 보존한 기술 자료

- `backend/supabase/migrations/`: 기존 DB 변경 이력. 새 요구사항에 맞는 후속 변경을 설계합니다.
- `backend/supabase/functions/`: 기존 테스트용 인증 서버 함수와 신규 기능의 미구현 골격. 실제 본인인증이나 기능 완료의 근거로 사용하지 않습니다.
- `frontend/src/assets/logo.jpg`: 사용할 로고
- `.env.local`: 로컬 연결 설정. Git에 올리지 않습니다.
- [.env.example](.env.example): 기존 환경 항목 안내. 새 연결 방식에 맞춰 갱신할 대상입니다.
- `.gitignore`, `.git/`: 제외 규칙과 버전 이력

## 현재 작업 경계

2026-09-22 사용자 지시에 따라 기존 React 앱, 프론트 API 연결·인증·사진 처리 코드, 테스트, 실행·빌드·배포 설정, 과거 문서와 생성물을 삭제했습니다. 별도 백업은 만들지 않았습니다. 새로운 연결 코드·테스트·실행 환경은 현재 프로토타입에 맞춰 구성합니다.

최신 백엔드 계획은 [PLAN.md](PLAN.md), 파일별 책임·AI 구조·연결 계약은 [PLAN_상세설계.md](PLAN_상세설계.md), 작업 기준과 추가 사용자 결정은 [AGENTS.md](AGENTS.md)를 확인합니다. 신규 구현용 파일은 골격만 준비되어 있으며 작성 위치는 [백엔드 안내](backend/README.md)를 따릅니다.

이번 정리에서는 원격 Supabase와 Vercel을 변경하지 않았으며, 커밋·푸시·배포도 실행하지 않았습니다.
