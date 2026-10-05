# native60 hosted runtime 검증 후보

## 상태와 기존 증거

민규 독립 worktree의 기존 driver와 이 문서만 수정했다. 소유권 검사 통과. 시작 source SHA는 main/WT 모두 `109dd01ecb0762bb21dd18c7d797155a353ae19a27393000f7b39d5354fc1e49`였다. 기존55/56 모드와 native60 Node runtime7그룹 PASS·artifact는 보존하며 hosted를 별도 모드와 private 결과 경로로 구분한다. main/J/SQL/serve/DB는 변경하거나 실행하지 않았다.

실행 인수는 고정 status 파일, `--native60-approved --hosted-runtime-batch`, 기존 고정 SQL migration manifest다. 실제 실행은 root의 별도 GO 이후에만 허용한다. 이번 준비에서는 `deno check`를 통과했으며 provider/DB/HTTP 실행은 NOT_RUN이다.

## 고정 hosted artifact 검사

`/private/tmp/yumidang-hosted60-9tkezn03` 부모0700·소유자·디렉터리 및 symlink 부재를 검사한다. `hosted-manifest.json`과 `hosted-local.env`는 일반 파일·소유자·0600을 요구한다. manifest SHA는 `bd95c0cd46f232a6f0396b9c641382da7d3984aefe0836922fc4c6ac26a80042`, bootstrap SHA는 `cb051c2739132606c7da07f788cd3fd60e8e74248fc44be27aa0f938ef080c0c`로 고정한다. manifest의 프로젝트·API56531·DB56532·config SHA·시험120000ms와 source50개 바이트를 검증한다. bootstrap을 제외한49개는 현재 main 바이트와도 같아야 한다. 별도 읽기 비교에서49개 불일치0을 확인했다.

env는 명시된4개 필드만 파싱하고 INTERNAL_WORKER_SECRET을 메모리로만 사용한다. local 자동 Supabase 키는 기존 status 파일에서만 가져오며 env로 복사하지 않는다. fresh worker key는 anon/service key와 달라야 한다. key 값·key hash·원문 환경파일·토큰·회원UUID를 결과나 로그에 남기지 않는다. 잘못된 env quoting의 parse 오류도 비밀 없는 고정 오류로 바꾼다.

## 실제 HTTP 검증 흐름

기존 strict native60 baseline·exact60 SQL SHA·자료0·guardfalse·8RPC common-role 폐쇄·역할 및6RPC ACL baseline을 유지한다. 실제 회원 두 사진 준비, 닫힌 최초 retire 거절, owner의 임시6RPC와 guard COMMIT, 최초 회원JWT retire 및 전역180초 획득까지 기존 검증 순서를 사용한다. caller supplied deadline·lease 갱신은 없다.

hosted 분기는 Node global fetch를 교체하거나 Node in-process handler를 호출하지 않는다. 실제 `POST http://127.0.0.1:56531/functions/v1/service-api/internal/member-cleanup`에 anon apikey, 내부 Bearer, 유효한 x-worker-run-token, 빈 JSON을 보낸다.

정상 실행 전에 잘못된 내부키와 회원JWT는403/ACCESS_DENIED, 유효한 내부키·header와 잘못된 body token 필드는400/INVALID_REQUEST를 요구한다. 각 응답 전후 task kind/state/count, ack 수, Auth 행 수, backend 파일 수의 동일성을 확인한다. 이것은 fixture 무변경 증거이며 hosted 내부의 모든 upstream 읽기가0이었다는 직접 trace는 아니다.

정상 응답은200과 exact data `{status:ran,claimed:3,succeeded:3}`를 요구한다. 실제 DB3작업 completed, 같은 withdrawal completed, ack3개를 확인하고 다음 시각 조건을 boolean으로 검사한다.

- Storage 각 ack.recorded_at ≤ 해당 task.completed_at
- max(Storage task.completed_at) ≤ Auth ack.recorded_at
- Auth ack.recorded_at ≤ Auth task.completed_at

각 사진의 authenticated GET은404 또는 Storage pin의 exact400/NoSuchKey/statusCode404만 부재로 인정한다. Auth admin GET은404이고 실제 Auth UID 행0, 정확 두 사진 metadata0, backend 파일0이어야 한다. DB 시각 조건은 원장 처리 순서의 증거이며 provider dispatch의 직접 trace가 아니다.

hosted 컨테이너 내부 fetch는 Node proxy가 볼 수 없다. hosted 결과의 providerDeleteCount/providerDispatchOrder는 NOT_OBSERVED_BY_NODE로 명시한다. root의 bootstrap 상수 로그 관찰은 별도 증거로 기록해야 한다. exact삭제1회·Storage→Auth의 Node trace는 과거 Node7그룹 증거에만 해당한다.

## 유한 HTTP 마감과 불확실 종료

거절 요청은10초, 정상 요청은 min(130초, 실제 DB 점유를 보수적으로 매핑한 host 잔여-5초)의 HTTP 상한을 사용한다. 이는 이번 hosted 시험값이며 J75초 caller의 운영 연결 안전성을 확정하지 않는다. 서버 trusted120초 옵션과 실제 DB budget/task fence도 계속 적용한다.

각 hosted 요청은 발행 전에 remote completion을 불확실 상태로 표시한다. 거절 응답의 exact code·fixture 동일성 또는 정상 응답·DB 완료·실제 부재 증거를 모두 확인한 뒤에만 이를 해제한다. timeout·응답 소실·예상 밖 응답·완료 증거 부족이면 FAIL이며 자동 재시작·lease 연장·owner의 completed 승격을 하지 않는다.

불확실 종료의 finally는 guardfalse/임시6RPC ACL을 즉시 COMMIT 복원하고 baseline/역할 불변을 검사한다. 원격 종료를 모르는 상태에서 전역 release, provider 삭제, fixture 행 삭제를 하지 않는다. private600 `fixture-recovery.json`에 정확한 합성 대상과 경로만 보존하며 키·전역 token은 기록하지 않는다. 상태는 INCOMPLETE_REMOTE_UNCERTAIN이고 all-zero PASS로 표시하지 않는다. 이후 정리는 root가 원격 상태를 확인하고 따로 승인할 작업이다. 자연 만료 역시 원격 backend 종료의 증거가 아니다.

정상 성공의 finally는 기존처럼 전역 release·정확 fixture 청소·파일/행0·guardfalse·6RPC baseline 및8RPC 폐쇄·역할/60 이력 불변을 확인한다. 결과는 새로운 `yumidang-cleanup-hosted-native60-*` private artifact에 저장한다. main 생산 기본 진입점404와 J queue 연결은 변경하지 않는다.
