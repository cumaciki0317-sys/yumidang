<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **AI 선택 동의:** AI 탐색은 첫 사용 동의·거절 시 일반 검색 유지. 후기 AI는 가입 시 열람/내 프로필 생성·노출/작성 후기 활용의 세 선택 항목·기본 미선택이며 전체 동의 편의 기능과 독립 철회를 제공한다. 기존 테스트 계정 간주와 실회원 동의 증거를 구분한다.
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# 두 번째 한시 검증 소스 로컬 커밋 검토 — 2026-10-14

전체 **79%(22/28)** 유지. 대상은 종현 전용 clone `/private/tmp/yumidang-jonghyun-parallel-20261014`의 `jonghyun/backend-parallel-20261014`, 현재 HEAD `06e95bafb16de96bd7c7fdca81a84f5db3109d0c`다. 아래28개 작업 파일과 이 검토 문서1개, **총29개**만 새 로컬 커밋 대상으로 제시한다. 현재 staged0·코드 커밋 미실행·푸시0이다. 원 공유 clone은 이번 읽기 확인에서 clean이다.

## 변경 목적

- 승인된 AI 결과 상태 GET·정상 결과 평가 경계와 운영 담당 탈퇴 권한 회수/종결 영수증 별도 보존의 코드·SQL2개·책임 검사. 대화 영구 보관은 추가하지 않았다.
- 재승인된 도구2개 한시 지원: 기존6개 자원 보존, OS 비공개 임시 폴더/Auth 원 증거, 현재121개 SQL과 새 책임 후보2개의 검증.
- J07 GET/J08 읽음/J09 탈퇴의 제품 adapter 연결. J09 v2는 실제 Storage 업로드를 요구하며 Auth ACK 저장 후 응답 유실 복구(A)와 DELETE 응답 유실·ACK 없음 UNKNOWN 보존(B)을 별도 새 대상에서 검증한다.
- 새 합성 자원 생성 도구: 고정 CLI·커밋 소스·SQL 사본·기존 자원·메모리·포트 충돌 확인, 발급 자식 중단 정리, 원 생성 전후 영수증. 기본 실행은 NOT_RUN이며 기존 자원/VM을 중지하지 않는다.

## 검사와 현재 한계

현재 작업본 검사: 지원 도구16/16·DB 후보8/8·민규 원 signed-auth 책임 일부32/32·Node v2 20/20·Root v2 54/54·생성 도구8/8 PASS. 이들은 각각 별도 실행이며 실제 SQL/Auth/Storage 호출 결과로 합산하지 않는다. Python 문법, 전체28개 경로 종현 소유권, git diff --check도 통과했다.

승인 정책 코드의 이전 Node 묶음은 최초66 PASS/1 시험 입력 FAIL 후 해당1개만 수정 재검사 PASS였고 기존 DB/RPC 회귀8개·운영 탈퇴 정적5개·Deno 타입 검사는 별도 PASS다. 해당 기록은 approved-feedback-operator-design.md를 따른다. 원 민규 시험 전체 통과를 주장하지 않는다.

새 실제 SQL121 적용/신규 SQL2 책임·최신 행사/요약/AI 상태/읽음/탈퇴/Storage는 아직 NOT_RUN이다. J07 실제 직원 workflow·두 세션 경합·캡처 Storage/감사·파기에는 추가 실제 증거가 필요하다. 새 빈 DB 초기화 중 cron OFF·실행0은 미입증이며, 생성 직후 원 생성 ID의 새 DB만 OFF 설정/검증하고 계정/작업0·외부 guard 닫힘·실행 cron worker0을 확인한 뒤 본 검증을 진행한다. 전체 볼륨 물리 삭제를 Storage API 원본 접근 불가와 혼동하지 않는다. 상세 순서는 round2-validation-design.md다.

## 승인할 정확한 로컬 작업

1. 아래28개와 이 문서1개의 현재 검토 바이트만 로컬 커밋한다. staged 검사를 통과한 목록만 사용하며 자동 대량 add/다른 담당 변경/푸시는 없다.
2. 이미 승인된 새 합성 검증·새 자원 정리 후 두 한시 도구를 보존한 원 바이트로 되돌리는 로컬 복구 커밋만 수행한다. 이 두 파일 외 새 코드 변경은 이번 복구 승인에 넣지 않는다. 담당은 별도 정책 관리 clone의 정책 복귀를 통해 민규로 반환한다.

원복 고정 SHA: run_database_tests.py `5e848bc7a52cadb9409b3e487b00107944613dceb8d5ff8f11ca77d41bb54d49`; isolated_ai_contracts.py `04c68bb41214e3cf865637094fdc409cd901eaa8b0c31d1f0392d0979862ad8d`. 원 바이트는 비공개 원본 보존 루트의 manifest와 대조한다. 실제 검증/정리 완료 전에 원복하지 않는다.

AGENTS.md의 자동 커밋 금지 때문에 이번 새29개와 정해진 원복2개의 로컬 커밋만 확인한다. 두 도구 재배정·VM·확정 제품 정책 승인은 다시 묻지 않는다. 실회원·공급사 호출·운영 DB/배포·외부 메시지·추가 결제는 이번 범위에 없다.

## 작업 파일28개와 검토 SHA

| 파일 | SHA256 |
|---|---|
| `apps/mobile/src/service.ts` | `3e544cd376a8a45c82abb2091b022577db90fee2cc2e4bb567413da3d0ec20c0` |
| `backend/contracts/ai-chat.md` | `78db10611c1c3df7c1ceff46838fbaa044925be5d3d02b77c560c1617e4c7714` |
| `backend/supabase/functions/_shared/contracts/ai.ts` | `619909f47a333d3828d39225e714bf6467913283572bdc716c2bb829a95c82f8` |
| `backend/supabase/functions/_shared/db/ai-feedback-client.ts` | `666da927344990c1d78441a35fad829440b684ae1f4a1abcaedcf14543c585b4` |
| `backend/supabase/functions/_shared/db/internal-client.ts` | `c8783432038f445f3766bc23e5e22052ef7f9f86dec0f907be424d45c90be45e` |
| `backend/supabase/functions/ai-chat/handler.ts` | `02e8dda1a13f500570c914fdb7029f8c1031861f8771a9f8e7c42e54a7a1e1ad` |
| `backend/supabase/functions/ai-chat/index.ts` | `489be0f7c8dc6a8984e7b5ce0216fef49a8870da62c460a57e9ef056c7d0d5bf` |
| `backend/supabase/migrations/20261014010000_operator_receipts_retirement.sql` | `3ced5ccb5627ae9a2e5c9f3da6d3565af977ec302d390f6cc0bd111c239ac5c5` |
| `backend/supabase/migrations/20261014020000_ai_result_state.sql` | `406d316b51c653d850045a87c4d8e6480c303c5f099a1899f7c1335281856494` |
| `docs/collaboration/requests/jonghyun/2026-10-14-approved-feedback-operator-design.md` | `1f3cd5c96ff990e9a037e1e8302227dc7acb6c7e401d32ded4f60499e7c3d100` |
| `docs/collaboration/requests/jonghyun/2026-10-14-remaining-work.md` | `b1c2b22512f6f627e501eefd8318e7364062b563bb70a141035893df8ff33056` |
| `docs/collaboration/requests/jonghyun/2026-10-14-round2-validation-design.md` | `f1b9f5f90f455caa73a8a329d55548f6714cc592e750cbff5a2a1fd338bd1ea8` |
| `tests/database/jonghyun/ai_result_state.sql` | `c8b9843bb3603243e762d2caa55f4fb18a0aa3155ab97a5d1913ec213c851c77` |
| `tests/database/jonghyun/operator_receipts_retirement.sql` | `09c1374109a25e0500eba8528a63b99d10c4a45651cf1a01bd7de99e9add999c` |
| `tests/database/jonghyun/test_isolated_database_runner.py` | `1bfa6f8bd06ebd3e31d54bd5547262e3c940f79b005252b46651f0fe748ce430` |
| `tests/database/jonghyun/test_member_root_boundary.py` | `18440bf93408c278166373d1ce10323a7c19d6037d85948a6918f4e5c0797881` |
| `tests/database/jonghyun/test_operator_receipts_retirement.py` | `ccca9e188e0fda19814ad84d30e446ab2da653f4b220aae7a3173263e38db5c6` |
| `tests/database/jonghyun/test_owned_storage_receipt.py` | `23963220ca2fdbc3b6ec2473e29ac054c73222725aeecef7c2a8c884183f00a5` |
| `tests/database/jonghyun/test_preserved_resource_guard.py` | `1a3be60dfb8fbee10977f10843f5d0b7ec296b681ad5fc23d80af47f6806a744` |
| `tests/functions/jonghyun/ai-result-state-db.test.mjs` | `9378bcbb100c99b11838aa4c17e554122eba4d2d0083f4ed30373d303fc80922` |
| `tests/functions/jonghyun/ai-result-state-http.test.mjs` | `1d2eedc7b15b1c643b1e7368386e890f2db8fcc8791cf78aa17d5e84439cfb23` |
| `tests/functions/jonghyun/ai-result-state-service.test.mjs` | `78712cdab9087823560803086c29cb0c685ca2105880f10668273d4640ade217` |
| `tests/functions/jonghyun/member-connections-runtime.test.mjs` | `62e4df8bb16da95de2e354ec1b90cabfd3bda431649f359596cdd9401d5cb3a5` |
| `tests/integration/jonghyun/isolated_ai_contracts.py` | `48d1866c73944cea3721c5626fe20a70ce29e4e23e5b88faa0815a6f1f753cbb` |
| `tests/integration/jonghyun/member-connections-rest.mjs` | `24bcead5ce02ac961bb9f98e75cbcd6b77434f10e774cd4e83c1f0ae925fde1b` |
| `tests/integration/jonghyun/member-root-boundary.py` | `c0fe28196cd815daffe2e4478c830b05e84ee5dcbc275191756e24c84a32607e` |
| `tools/local/run_database_tests.py` | `8eec320c5d3cba1f6fc09a1d119c79776bd710aed8868f0f7d3213ba68356703` |
| `tools/local/start_owned_validation.py` | `75cfa09f69e491f82827134b62f8bc45c7ab0cd39acb359a7aab0ecb6e5f0632` |

이 문서는 검토 목록을 담는29번째 파일이며 자기 SHA를 내용에 순환 기재하지 않는다. 실행 승인 후 단계별 결과/원복 문서는 별도 기록하고 새 코드 범위를 추가하지 않는다.
