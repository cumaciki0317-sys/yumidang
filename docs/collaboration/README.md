# 민규·종현·성호 동시 작업 규칙

파일 소유권의 기준은 [backend/ownership.json](../../backend/ownership.json)이다. 민규는 `minkyu`, 종현은 `jonghyun`, 성호는 `sungho`로 표시한다. 보호 경로 안의 파일은 한 명만 수정하며, 더 구체적인 파일·하위 폴더 규칙이 상위 폴더 규칙보다 우선한다. 모바일·프론트도 보호하며 성호는 명시적으로 배정된 UX/UI 경로만 수정한다. 성호의 미배정 경로는 거절된다.

## 현재 문서 동기화의 승인 범위

현재 작업자는 종현이며, 사용자는 담당 구역을 나누지 않고 전체 폴더의 정책 문서를 갱신하도록 명시했다. 이번 작업의 문서 허용 목록은 하네스가 정하고 에이전트별 단독 편집을 유지한다. 정적 소유권 검사의 거절은 이 명시적 문서 예외와 함께 기록한다. ownership.json·hook·Git 설정을 바꾸어 통과시키지 않는다. 코드·SQL·배포·커밋·푸시에는 이 예외를 확대하지 않는다.

현재 기준은 [정책.md](../../정책.md)이며 역할별 연결 과제는 [종현 현황](jonghyun.md)·[민규 현황](minkyu.md)을 확인한다. 사용자 요청에 따라 협업 문서의 과거 원문·이전 승인·검증 수치·구계약 본문을 제거하고 현재 연결 요구로 정리한다. 날짜가 있는 파일명은 링크 연결을 위해 유지할 수 있으나 현재 승인이나 검증 완료를 뜻하지 않는다.

## 기본 규칙

1. 서로 다른 저장소 복제본 또는 worktree에서 작업한다. 같은 작업 디렉터리·Git 인덱스를 두 사람이 함께 쓰지 않는다. 각자 `minkyu/작업명`, `jonghyun/작업명`처럼 별도 브랜치를 사용한다.
2. AI에게 현재 작업자를 알려준다. 기존 대화에서 확인된 작업자는 재확인하지 않는다. AI는 수정 전에 대상 경로의 소유권을 확인하고 담당 밖 파일을 직접 수정하지 않는다.
3. 공통 코드·설정·마이그레이션·소유권 정책·최상위 설계와 지침은 민규만 편집한다. 종현의 AI·검색·행사·작업 실행 파일은 종현만 편집한다. 민규도 종현 파일을 직접 고치지 않는다.
4. 상대 파일 변경이 필요하면 자신의 요청 폴더에 새 요청 문서를 작성하고 자기 작업은 가상 어댑터나 현재 계약으로 계속한다. 요청 작성은 외부 메시지 전송을 뜻하지 않는다.
5. 파일 이동·삭제도 변경이다. 다른 담당의 파일을 자신의 폴더로 옮기거나 전체 포맷·코드 생성 명령으로 변경하지 않는다.
6. 소유권 변경은 두 사람의 합의를 기록한 뒤 민규가 정책만 별도 커밋하고, 양쪽이 갱신한 후 실제 작업한다. 진행 중인 파일을 일방적으로 재배정하지 않는다.

## 충돌하기 쉬운 파일의 담당

| 영역 | 민규만 수정 | 종현만 수정 |
|---|---|---|
| 공통 기반 | auth·http·config·DB 클라이언트, deno.json·config.toml | 해당 없음; 필요한 변경 요청 작성 |
| 서비스 | 회원·공고·매칭·채팅·완료·평가·알림 | search-service.ts·event-service.ts |
| 코드 계약 | common·signup·verification·posts·matching·reviews | search.ts·ai.ts |
| 문서 계약 | conventions·signup·verification·posts-search·matching·reviews | search.md·ai-chat.md·review-summary.md |
| 저장소 모듈 | 회원·인증·공고·매칭·채팅·완료·평가·알림 | search·events·review-summaries·jobs |
| AI·외부 연결 | identity·phone·email·bank | ai 전체·jobs·places·events |
| 로그 | logger.ts·redaction.ts | metrics.ts |
| DB 변경 | migrations 전체 | 자신의 요청 문서에 필요한 변경 명세 작성 |
| 테스트 | tests/각분류/minkyu/ | tests/각분류/jonghyun/ |
| 가상 데이터 | seeds/minkyu/ 및 로드 설정 | seeds/jonghyun/ |
| 작업 현황 | minkyu.md | jonghyun.md |
| 변경 요청 | requests/minkyu/ | requests/jonghyun/ |

기존 코드·SQL·테스트·실행 자료는 이번 문서 정리 범위 밖이며 변경하지 않는다. 현재 정책과 맞는 검사 범위를 확인해 재사용한다. 테스트 공통 설정과 각 분류 상위 폴더는 민규가 소유한다. 양쪽 테스트가 필요하면 서로 다른 파일에 작성하고 동일 파일 공동 편집을 하지 않는다.

## 상대 담당 변경 요청

각자 `requests/작업자/날짜-주제.md`에 다음을 기록한다.

- 대상 파일과 담당자
- 필요한 변경과 이유
- 요청·응답 예시 또는 기대 동작
- 현재 작업에 미치는 영향과 임시 대체 방법
- 완료 확인 조건

일반 구현 작업에서는 상대 요청 문서를 직접 수정하지 않는다. 현재 전체 문서 동기화는 위의 명시적 문서 예외와 단독 편집 목록을 따른다. 응답·완료 결과는 자신의 요청 폴더에 새 파일로 작성하고 원래 요청을 링크한다. 상태 공유는 각자의 현황 파일만 갱신한다.

## 소유권 검사

수정할 파일을 정하기 전에 다음과 같이 확인한다.

```sh
python3 tools/collaboration/check_ownership.py --actor jonghyun --paths backend/supabase/functions/_shared/ai/Agents/chatbot/orchestrator.ts
```

커밋 대상은 다음과 같이 확인한다.

```sh
python3 tools/collaboration/check_ownership.py --actor jonghyun --staged
```

민규는 `--actor minkyu`를 사용한다. 검사에서는 수정·삭제·이동 전후의 경로를 확인한다. 이미 커밋된 소유권 정책이 있으면 HEAD의 정책을 사용하므로 작업 중 규칙을 바꿔 검사 대상을 자기 소유로 바꿀 수 없다. 최초 정책 커밋 전에는 작업 폴더의 정책을 사용한다.

각자의 복제본에서 한 번만 커밋 검사를 연결한다. 기존 커스텀 hook이 있다면 먼저 연결 방식을 확인하고 덮어쓰지 않는다.

```sh
# 민규 복제본
git config --local yumidang.actor minkyu
git config --local core.hooksPath .githooks

# 종현 복제본에서는 actor만 jonghyun으로 설정
git config --local yumidang.actor jonghyun
git config --local core.hooksPath .githooks
```

위의 두 작업자 설정을 한 복제본에서 차례로 실행하는 방식이 아니다. 자기 복제본에 해당하는 설정만 사용한다. Git 로컬 설정은 clone/pull로 전달되지 않으므로 각자 설정해야 한다.

## 적용 범위와 한계

AI 지침은 수정 전 담당 범위를 제한하고, Git hook은 커밋 직전에 담당 밖 변경을 거절한다. 파일 시스템 쓰기 권한을 잠그는 기능은 아니므로 수동 편집 자체를 차단하지는 않는다. `--no-verify`나 설정 변경으로 로컬 hook을 우회하지 않는다. 원격 저장소의 필수 검사·브랜치 보호는 이번 작업에서 설정하지 않았다.

새 작업은 현재 HEAD와 기존 변경을 먼저 확인한다. 과거 하네스의 baseline을 재사용해 현재 상태를 증명하지 않는다. 공유가 승인되면 대상 변경만 선별하고 다른 작업을 함께 스테이징하지 않는다. 이번 문서 동기화는 커밋·푸시를 수행하지 않는다.


## 성호 UX/UI 담당 및 수정 차단

성호는 `sungho`다. 사용자가 성호임을 밝히고 작업 시작을 요청하면 [성호 시작 안내](requests/minkyu/2026-10-05-sungho-start.md)를 먼저 읽는다. 본인 별도 clone과 `sungho/` 브랜치를 확인한 뒤 `python3 tools/collaboration/setup_actor.py --actor sungho`로 소유권 hook을 연결한다. 실패하면 편집을 시작하지 않고 이유를 설명한다. 기존 민규·종현 clone의 작업자 설정을 바꾸지 않는다.

성호는 ownership.json의 sungho 배정 경로만 수정·생성·삭제·이동할 수 있다. 편집 전 `check_ownership.py --actor sungho --paths 대상파일...`을 실행하고 거절된 파일은 편집하지 않는다. 미배정 파일도 성호에게는 거절된다. 백엔드·환경·공통 설정·정책·API·상태·인증·기존 실제 화면·ui.tsx 혼합 컴포넌트는 수정하지 않는다. 필요한 적용은 본인 요청 폴더에 남긴다.

새 presentation 컴포넌트는 props로 표시 값과 이벤트를 받는다. API 호출·인증 세션·서비스 상태·domain 정책을 직접 가져오거나 정책·민감정보 공개 조건을 바꾸지 않는다. 기존 실제 화면 적용은 종현이 담당 파일에서 연결한다. owner 선언은 협업 역할이며 사용자 인증이 아니다. AI 수정 전 검사·로컬 hook·PR 검사는 파일 쓰기 자체를 OS 권한으로 잠그지 않는다. --no-verify, actor 변경, hook/정책 수정으로 담당 검사를 우회하지 않는다.
