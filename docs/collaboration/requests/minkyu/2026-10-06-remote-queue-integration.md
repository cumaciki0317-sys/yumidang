# 최신 종현 푸시 수신과 민규 후속 연결

사용자 요청으로 origin을 fetch하고 `origin/jonghyun/queue-integration`의26aca72를 민규 `minkyu/foundation-harness` 브랜치에 fast-forward로 수신했다. 미커밋288개 파일은 private 백업과 Git stash로 보존한 뒤 복원했다. 겹친10개 충돌 후보는 원격 내용이 이전 민규 공유본9dfca36과 정확히 같아 최신 민규 내용을 유지했다. 나머지는 충돌 없는3-way 결과를 적용했다. 소유권288경로 검사 PASS·전체 diff-check PASS. 민규 작업 신규 커밋/푸시·운영 변경은 없으며 stash를 삭제하지 않았다.

통합 영수증은 `/private/tmp/yumidang-remote26aca72-integration/integration-receipt.json`에 보관했다. 종현 큐38·계정 포트14 총52개를 받은 소스에서 재검증해 PASS했다. 실제 TLS/LOGIN/호스트/취소·신고 소비자와 다중 계정 원장·공급사 호출은 미검증이다.

## 새 확정 정책

[종현 전달](../jonghyun/2026-10-06-minkyu-policy-and-potens-briefing.md)에 따라 신고 자료 종결+90일 삭제와 별개로 본인 숨김 최소 기록을 본인 해제까지 유지한다. 일반 제재 이의7일은 앱 안내 성공 제공 서버 시각부터이며 최초읽음/푸시/메일 시각은 아니다. 기존 DB available_at를 성공 제공 증거로 추정하지 않는다. 숨김/해제와 성공 안내·마감 계약은 후속DB/API 작업이다.

## 다중 계정 서버 설정

민규 기존 `config/env.ts`에 `loadPotensAccountPoolConfig`를 추가했다. 종현 제안 변수명을 사용하며 ORDER가 다중 모드 선택이다. 새 항목이 모두 비면 null로 기존 단일키 loader 경로를 유지하고, 잘못된 다중 설정에는 단일키 fallback을 허용하지 않는다.

등록 계정은 yumi→jonghyun→minkyu→sungho의 순서를 유지한다. 선택 계정은 모두 키를 제공하고, 미선택 계정에 키를 남기거나 같은 키를 여러 계정에 등록하면 거절한다. 모델 claude-5-sonnet·Asia/Seoul·계정당3200000을 명시 검사하고 전체는 등록 계정 합계로 계산한다. 네 계정이면12800000이다. 일부 등록에서는 해당 계정 상한 합계만 적용한다. 비밀키는 non-enumerable·불변이며 JSON/기본 로그/spread에 나오지 않는다. 설정 성공은 공급사 권한·실제 포함량·운영 준비 증거가 아니다.

새 설정4개+기존 공급사 설정8개 총12/12 PASS, Deno 타입 검사 PASS다. `.env.example`만 갱신했으며 실제 키·로컬 `.env`·운영 Secrets는 읽거나 변경하지 않았다. 종현 factory 조립과 민규 원자 예약/정산DB·내부RPC는 아직 미연결이다. 개인정보·출력 상한·기존 회원20회 조건을 유지한다.

## 병합 후 준비 검증

최신 HEAD26aca72에서84 SQL 해시와 gateway 소스 묶음 준비 READY를 확인했다. Git 추적65개·미커밋19개이며 실제 기존 로컬DB84개와 구분한다. 준비 경로 `/private/tmp/yumidang-policy84-after26aca72-gateway-prepared`다. 첫 실행은 필수 `--gateway-probe` 누락으로 BLOCKED·실행0이었고, 명시 옵션을 넣은 별도 새 경로의 준비는 READY다. SQL/Edge 실행은 NOT_RUN이며 이전 고정 준비 묶음은 수정하지 않았다.
