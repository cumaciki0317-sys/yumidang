# 수집한 API 입력 안내

## 현재 사용 범위

카카오 키는 장소 검색용이며 카카오 로그인을 켜는 근거가 아니다. 로그인은 네이버만, 현재 동행은 무료만이다. 서울 열린데이터의 HTTPS 등 연결 조건과 연결 여부는 팀 검토이며 키가 있어도 활성화를 뜻하지 않는다. 포텐스닷 실제 회원 정보 전송은 보관 조건 답변을 팀이 검토하고 사용자가 확인하기 전까지 보류하며 합성 입력만 사용한다.

**현재 개발자가 사용하는 저장소 최상위 `.env`가 로컬 입력 파일이다.** 다른 작업자의 절대 경로나 worktree 내부 `backend/.env` 사본을 최신 입력으로 단정하지 않는다. `KEY=""`의 따옴표 안에 발급받은 값을 넣고 저장한다. 기존 공용 양식인 루트 `.env.example`과 프런트 설정은 변경하지 않는다.

사용자가 수집했다고 확인한 항목은 **Kakao 장소검색·KOPIS 공연·서울 열린데이터광장·TourAPI·포텐스닷 API**다. 먼저 아래 다섯 서비스의 입력란을 채운다. 네이버 로그인 연결은 별도 인증 설정 계약으로 확인한다. 계좌·이메일 인증은 추후 도입 검토이며 기존 양식의 폐지된 로그인용 필드를 현재 발급 대상으로 삼지 않는다.

포텐스닷은 사용자 확인으로 **LLM 전용**, 요청 모델은 **Sonnet 5**다. `POTENS_REQUESTED_MODEL`은 사람이 선택한 이름이며 실제 호출 ID인 `POTENS_MODEL`과 다르다. 공급사 문서로 정확한 ID와 호출 주소를 확인하기 전에는 임의 ID로 호출하거나 다른 모델로 대체하지 않는다.

| 수집한 항목 | 입력란 | 연결 담당 |
|---|---|---|
| 카카오 장소 검색 | `KAKAO_REST_API_KEY` | 종현 |
| KOPIS 공연 정보 | `KOPIS_API_KEY` | 종현 |
| 서울 열린데이터 | `SEOUL_OPEN_DATA_API_KEY` | 종현 |
| TourAPI | `TOUR_API_SERVICE_KEY`, `TOUR_API_KEY_FORMAT` | 종현 |
| 포텐스닷 API | `POTENS_API_KEY`, `POTENS_API_BASE_URL`, `POTENS_MODEL`, `POTENS_API_DOCS_URL` | 종현 |
| AI 공급사·모델·키 | `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY` 또는 `GEMINI_API_KEY` | 종현 |
| 네이버 로그인 | 실제 서버 설정명·세션 연결은 인증 담당 계약 확인 | 민규 |
| 계좌 인증(추후 도입 검토) | 기존 `BANK_…` 양식, 현재 활성화하지 않음 | 민규 |
| 그 밖의 API | `OTHER_API_1_…`의 이름·용도·주소·문서·키 | 해당 기능 담당 |

캡처로 확인한 포텐스닷 계약은 `https://ai.potens.ai` + `POST /api/chat`, `Authorization: Bearer <서버 키>`, `{prompt, model}`이다. `/api/chat-stream`은 별도 스트리밍 경로다. 캡처 예제는 `claude-4-6-sonnet`이지만 사용자가 **Sonnet 5 유지**를 다시 선택했으므로 현재 공개 모델 목록과 최소 호출로 확인한 `POTENS_MODEL="claude-5-sonnet"`을 사용한다. 캡처의 실제 키나 키가 포함된 예시는 공유 문서에 저장하지 않는다. 노출된 키는 공급사에서 폐기·재발급한 뒤 최상위 `.env`의 키만 교체한다.

발급받지 않은 항목은 빈칸으로 둔다. 공급사마다 필요한 인증 필드가 다르므로 모든 칸을 채울 필요는 없다. TourAPI 키는 받은 원문을 그대로 넣는다. 사용자가 형식을 확인할 수 없다고 알려왔으므로 `TOUR_API_KEY_FORMAT`은 비워 두거나 `unknown`으로 둔다. 추측으로 인코딩/디코딩하거나 두 형태를 자동 재시도하지 않는다. 추가 API는 `OTHER_API_2_…`처럼 번호를 늘려 기록할 수 있다. 문서 URL에는 키가 붙은 요청 예시 URL을 넣지 않는다.

## 저장과 공유

- `.env`은 기존 `.gitignore` 규칙으로 Git에서 제외되고 최초 파일 권한은 소유자 읽기/쓰기(0600)다. 키를 채팅·공유 문서·`.env.example`에 복사하지 않는다.
- 공유하는 [빈 양식](.env.example)에는 실제 키를 넣지 않는다. 종현은 자기 작업 폴더에서 이 양식을 저장소 최상위 `.env`로 복사하여 사용한다. 기존 로컬 파일이 있으면 덮어쓰지 않는다.
- 서버 키를 `VITE_` 변수나 프런트 코드에 넣지 않는다. 이 파일은 키 입력·인계 장소이며 프런트에서 읽지 않는다.

## 입력 이후

설정 모듈은 `supabase/functions/_shared/config/providers.ts`다. `EnvReader`를 주입받아 기능별로 읽으며, 파일을 자동으로 탐색하거나 import 시 네트워크를 호출하지 않는다. 종현이 각 함수의 런타임에서 `Deno.env.get` 등 서버 환경 조회를 연결해야 실제 기능이 실행된다. 공통 service-api가 모든 외부 키를 필수로 요구하도록 바꾸지 않는다.

현재 작업 폴더의 입력 파일을 다음 오프라인 명령으로 점검한다. 키·URL·모델값을 출력하지 않고 입력 상태만 표시한다.

```sh
python3 -B tools/local/check_api_env.py --env-file .env
```

이 검사에 통과해도 키 유효성·공급사 API 성공을 뜻하지 않는다. 함수에 환경을 주입하는 작업, 공급사 어댑터 연결과 실제 호출 검증은 별도다. [이번 설정 연결 인계](../docs/collaboration/requests/minkyu/2026-09-29-provider-config-handoff.md)에 담당별 API·필드·검사 결과를 기록한다.

기존 서비스 API의 Supabase·내부 작업 설정은 [인증 런타임 계약](contracts/auth-runtime.md)을 따른다. 이 수집 파일을 그대로 운영 secret에 일괄 등록하지 않는다. 외부 키가 든 `.env`를 프런트에서 읽거나 공개 API로 내려주지 않는다.

포텐스닷의 채팅용 ID와 다른 공급사·코드 프록시 ID를 혼용하지 않는다.

## Sonnet 5 모델 ID 확인

포텐스닷 공개 웹앱의 채팅 모델 목록에서 `Claude Sonnet 5` → `claude-5-sonnet` 대응을 확인하여 현재 최상위 `.env`의 `POTENS_MODEL`에 반영했다. 별도 Claude Code proxy 목록의 `claude-sonnet-5`와 구분한다. 이 ID로 `/api/chat`에 합성 입력1회 요청하여 HTTP200·message·token_usage 반환을 확인했다. AI 서비스 전체 연결과 사용량 상세 매핑은 별도다. [포텐스닷 공개 모델 목록 소스](https://potens.ai/_next/static/chunks/2938-c5c734cf96c393f4.js)
