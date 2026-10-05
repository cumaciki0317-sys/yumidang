# 독립 로컬 Auth·DB·사용자 API 검증

2026-10-05, 민규. main HEAD `0b59906`의41개 SQL과 미커밋9개 정책 SQL을 이식한 독립 `yumidang-minkyu-drift` DB만 사용했다. 실제 로컬 Auth admin/password로 생성한 합성 회원3명의 session과 자격 예약을 연결했다. 실제 네이버 OAuth·실회원·운영 검증은 아니다.

## 실행과 결과

43개 고정 소스 snapshot으로 Deno standalone service-api를127.0.0.1:56540에 실행하고 독립 Auth/PostgREST/Kong56531에 연결했다. 원본 네이버 로컬/운영 credentials는 사용하지 않았고 외부 AI·공급사 연결 없이 실행했다. 결과63개 검사의 업무 의미가 모두 통과했다. 직접 RPC와 사용자 HTTP의 상태를 구분했다.

- 보호된 프로필 이름·생일·성별·사진·ID·생성/수정 시각 PATCH403. 본인 bio 수정 허용, 다른 회원 수정은 RLS로 실제 값 불변.
- 작성자 조회 legacy3개 RPC의 회원 접근과 익명/anonymous claim 차단.
- 실제 사용자 API: 비로그인 `/me`401, 회원 `/me`200, 차단 대상 프로필404, 차단 중 신청403, 해제200.
- 두 신청자 중 한 명 확정→취소 후 공고closed 유지→작성자 모집 재개200/restoredCount1→반복 재개 멱등→복원 대화 전송. 다른 작성자 재개404.
- 차단/타작성자 실패 응답에 SQL 상세·실명·생일 등 개인정보 없음.

원시 PostgREST RPC는 두 숨겨진 대상 조회에서 P0002/HTTP500을 반환했다. 의미상 대상 비노출은 확인했지만 native HTTP404 계약과 차이는 `NATIVE_HTTP_STATUS_GAP`으로 남겼다. 사용자 service-api는 실제404/RESOURCE_NOT_FOUND로 변환했다. 이 차이를 지워 전체 native HTTP 계약이 통과했다고 설명하지 않는다.

## 정리와 증거

검증 후 public/auth/storage/naver/session/block 합성 자료 합계0, schema50 unchanged를 확인했다. 운영 DDL·회원 자료 export0. 결과는 private `native-and-standalone-execution.json`, 최초 실패는 `native-policy-probe-initial-http-gap.json`에 보존한다. source43 SHA를 main과 준비 artifact 양쪽에서 대조했다.

Supabase Edge 호스팅은 NOT_RUN이며 standalone 서버 성공을 Edge 배포 성공으로 확대하지 않는다. 모바일·실기기·실제 네이버·운영 상주 실행기·외부 AI·삭제/재가입 전체 기능은 별도 검증이 필요하다.

## 실제 Supabase 로컬 Edge 추가 검증

동일 독립 프로젝트의 Supabase Edge Runtime v1.74.3에서 `http://127.0.0.1:56531/functions/v1/service-api`를 실행했다. overlay는 edge_runtime.enabled=true와 service-api.verify_jwt=false 두 설정만 변경했으며 함수 자체의 Auth 검증을 실제 확인했다. 현재 main43개 소스·SQL50 snapshot은 변경하지 않았다.

`edge-policy-probe-results.json`을 부모가 열어65개 의미 검사 전부 성공·failure_code null을 확인했다. 실제 Edge HTTP에서 익명/위조 인증401, 회원조회200, 차단대상404/신청403, 해제200, 작성자 재개200·다른 작성자404였다. 실패 응답의 SQL 상세/개인정보 비노출을 검사했다. 내부 비밀이 설정되지 않은 사용자 JWT 내부 호출은503으로 닫혔으며, 실제 내부 비밀 설정 후403 비교와 내부 업무 성공은 이 검사에 포함되지 않는다.

원시RPC HTTP500/P0002 두 건의 native 상태 차이는 유지한다. 로컬 Edge 통과를 운영 배포·실제 네이버 OAuth·모바일·전체서비스 완료로 확대하지 않는다.

## 당도 포함51 이력과 실제 Edge 검증

당도 SQL1개를 공식 CLI local dry-run JSON의 정확 목록·빈 seeds/roles와 대조한 뒤 적용했다. 최초 파일명 문자열 검사는 JSON/안내문 중복 출력 때문에 적용 전에 중단했으며, 성공처럼 기록하지 않았다. authoritative migration 이력50 유지 확인 후 JSON 목록으로 정확1개를 판정하고 적용하여 최종51개 이력이 일치했다. 별도 `current51-upgrade-execution.json`·`current51-catalog.json`에 기록하며50 증거는 보존한다.

실제 Edge/Auth의 합성73개 의미 검증을 실행했다. own 초기 당도15, 공개된 positive+5점 후기 반영17, 공개 profile17/완료1, 임시숨김 후17 유지, owner 최종무효 판정15, 오판정정17, 정정 뒤에도 숨긴 후기 원문 비노출을 확인했다. owner 판정은 합성 fixture 제어이며 실제 운영자 권한/승인 경로를 구현했다고 뜻하지 않는다. 프로필/Auth/세션/객체/Naver/회차/기여·판정 원장 자료를 전부 정리하고 합계0을 확인했다.

재현 도구: `tests/integration/minkyu/current_policy_native_edge_local.py --status-file <private local CLI status JSON>`을 python3로 실행한다. file0600/parent0700·현재 소유자·symlink 금지·local API56531·독립 DB51 및 빈 회원자료를 먼저 검사한다. 비밀 설정·토큰은 stdout에 출력하지 않고 성공 후 합성 회원 토큰 파일을 제거하며 안전한 결과 JSON 경로만 출력한다. main의 도구 자체로 다시73개 검증 PASS/cleanup을 확인했다.

운영/원본 클러스터는 변경하지 않았다. 실제 네이버 로그인·모바일 화면·운영 제재·실제 탈퇴/재가입·AI 공급사 검증은 별도다.

## 장소 변경과 입력 검증 보완53 — 현재 로컬 실행 상태

장소52와 공개지역 사전 검증 보완53을 각각 공식 local CLI dry-run의 정확1개 목록·빈 seeds/roles와 대조해 적용했다. 현재 독립 migration 이력은53개이며 운영20개와 원본 네이버 로컬35개는 변경하지 않았다. 최신 소스43개를 별도 Edge53 runtime에 준비하고 SHA를 대조했다.

실제 Auth/DB/Edge85개 의미 검사 PASS다. 장소 제안 뒤 상대 조회에는 제안 위치가 보이지만 현재 공고 위치는 그대로다. 비당사자404·본인 수락403을 확인했고, 상대 수락 뒤 공개지역·등록 장소·상세 지점이 함께 바뀐다. 종료된 제안의 새 장소 입력은null이다. 불완전 공개지역은 HTTP와 직접RPC 모두 제안 단계에서400으로 거절한다. 별칭 표준화·17개 지역·기존 전체 공개지역 형식은 SQL/HTTP 경계 회귀로 검증했다. 합성 Auth/회원/회차/사진 객체 등을 정리한 잔여0이다.

최초52 실행에서 테스트 env의 허용주소 형식과 테스트 Origin 오타를 고쳐 재시도했고, 이어 동 누락 입력이 수락에서23514로 거절되는 실제 검증 틈을 찾았다. 기존52 SQL을 덮어쓰지 않고53 보완을 추가했다. 최초 실패의 합성 자료도 모두 정리했고 private 실행 로그와 실패 결과는 보존한다. 기존 장소 회귀의17지역 fixture도 저장 가능한 전체주소로 갱신한 뒤 PASS했다. 최종 증거는 private current53-upgrade-execution.json이다. 결과 파일의 edge52 이름은 이전 시험 이름을 유지한 것이며 DB53 preflight와 Edge53 소스로 실제 실행했다.

함수282/282·Deno 타입 검사·준비 도구15개 PASS다. 기존 원시RPC의P0002/500 두 상태 차이는 계속 기록하며 사용자API404 변환과 구분한다. 실제 마감 접수·철회·모바일·운영 장소 적용·실제 네이버 OAuth는 미완료다.

## native54 신고·실행기 검증 갱신

**전체 백엔드·출시 진행 중,100% 미달.** 신고10파일은 민규 통합 worktree에 반영했다. 독립 로컬 migration54/Edge46파일에서 실제 Auth·Storage·Edge106/106 의미 검사 PASS, 합성 DB/Auth 행0·Storage 파일0을 확인했다. 신고 예약·실제 바이너리 업로드·접수·본인 조회·타인 차단·제출 증거 보호를 포함한다. native RPC 상태 코드 차이2건은 남아 있으며 service-api404·개인정보 비노출은 통과했다. 함수293/293·Deno 타입 검사·준비 도구15개 PASS다. 운영 변경·실제 네이버 재로그인·모바일은 이 증거에 포함하지 않는다.

완료 실행기는 별도 빈 schema54 DB에서 원형 프로세스와 일시적인 최소 권한 LOGIN으로7그룹을 통과했다. 실제 권한 제한·시작 시 누락 처리·커밋 알림과 예약·양쪽 수동 완료·분쟁 제외·DB 연결 강제 종료 후 재접속 및 누락 처리·정상 종료를 검증했다. 합성 행·일시 역할·세션은 정리했다. Railway 운영 배포·TLS·기존 cron 전환은 미검증이며 팀원의 서비스 주소 확인을 기다린다.

탈퇴 SQL은 별도 worktree의 실제 격리 SQL·재가입·동시성 검증을 진행했다. 통합 SQL 적용과 실제 외부 파일/Auth 삭제는 아직 완료하지 않았다. 삭제 완료 후 DB 기록 실패의 안전한 재시도 증거 계약도 구현 중이다. 신고 운영 판정·제재·내용 숨김과 모바일·법적/공급사 연결이 남아 있다.
