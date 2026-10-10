# 종현 새 격리 환경 실행 기록

전체 진행률은 **79%(22/28)**를 유지한다. 새 합성 검증을 실회원·공급사·운영 완료나 기존 보호 원본 검증으로 확대하지 않는다.

## 승인과 환경

- 부모 작업에서 전달한 사용자 승인: `cumaciki0317-sys/yumidang`의 `jonghyun/backend100` 일반 push, 새 전용 Colima CPU2·메모리4GiB·디스크20GiB, 공식 Supabase CLI·이미지, 격리 합성 검증.
- 별도 clone은 `/Users/b/Documents/Codex/2026-10-11/task-2/yumidang-jonghyun-backend100`이다. actor=`jonghyun`, hooks=`.githooks`를 확인했다. 원본 민규 저장소·기존 VM/컨테이너를 수정하지 않았다.
- Colima profile은 `jonghyun-backend100`, 프로젝트는 `jonghyun-backend100-077eabaa`다. 현재 Docker 기본 context는 바꾸지 않고 고정된 전용 socket만 사용한다. host mount·SSH agent 전달은 없다.
- 공식 Supabase CLI2.116.0 archive SHA256은 `8b750455d7b02c989cec0c6c26599d28b0aefcbeedf20a315bb1d5215a185a83`이다. release digest와 대조했다. CLI login/link와 원격 DB 변경은 하지 않았다.
- HEAD의 정식119개 migration과 설정의 좁은 project/port overlay를 새0700 임시 root에 준비했다. 논리 SQL 번호120을 migration 파일120개라고 표현하지 않는다.
- 시작은66.2초, 관찰29회, MemAvailable 최저3,135,436KiB로 통과했다. 새 소유 container6개가 healthy였다. 실제 DB cron을 비활성화하고 외부 AI guard를 닫았으며 회원·프로필·큐가 비었음을 확인했다.
- 시작 여유1GiB, 실행 중768MiB, probe3초 기준을 유지한다. 실제 회원 원문·공급사·운영 DB 쓰기·배포·추가 결제·외부 메시지는 승인 범위가 아니다.

## 소스 변경과 검증

직전 원격 commit은 `19c96aa`다. 이 commit은 새 준비 manifest/socket/container/migration 검증에 결합된 SQL 실행기를 추가했다. 이전 기본 실행과 보호 원본 환경 계약은 유지했다.

이후 현재 summary fences와 새 invocation 검사를 SQL109의 영속 prepare→첫 dispatch CAS→claim→효과→settle→완료 계약에 맞췄다. fixture 전용 제한 역할을 사용하며 제품 service_role의 직접 요약 게시 권한을 확대하지 않았다. transaction rollback 뒤 역할·control·거부 권한을 확인한다.

observer는0600/O_EXCL 영수증과 로그를 생성한다. stdout 로그는 공개 가능한 고정 결과만 받으며 stderr 원문을 저장하지 않는다. O_RDWR로 동일 로그를 읽어 해시하고, SIGTERM·자식 종료 경쟁·45초 정리 대기를 처리한다. 실행기뿐 아니라 제품 TS/MJS·준비 도구·factory·현재 SQL·기존 시나리오 소스를 HEAD와 대조한다. 메모리 실패나 종료 미확인은 성공으로 처리하지 않는다.

| 검사 | 실제 결과 | 범위 |
|---|---|---|
| 현재 AI atomic/account budget/account scopes | PASS | 새 실제 SQL·역할·원자 예약 |
| 현재 summary fences/invocation | PASS | 새 실제 SQL·영속 dispatch·settle·역할 |
| 관련 Node 회귀42파일 | 388/388 PASS | 합성 port/HTTP·제품 단위 검사 |
| Python observer/새 SQL runner/기존 runner | 5+7+10 PASS | 준비·경계·종료 보호 |
| Deno `ai-chat`·`review-summary-worker`·`service-api` | PASS | `check --no-remote` |
| summary14 | PASS | 경쟁8개·최신 부족6개, 전체 행·역할·제품 ACL 복원 |
| AI22/23 | PASS | 실제 제품 HTTP factory·실제 SQL·합성 Auth bridge/model, 보호 예산 보존 |
| AI24 자연 자정 | NOT_RUN | 시계 모형으로 대체하지 않음 |

새 HEAD 고정 SQL observer 영수증은 `sql-observer-1791653177563523000.json`이다. child0, observerFailure=null,189파일 pin,13.21초, 최저3,248,448KiB였다. 공개 로그 SHA256은 `c52793b39dffab69aa1a3f1650b55d5ee1036c5685354a6493215db6f1fa0e42`다.

기존 실패도 보존했다. 초기3SQL PASS 뒤 summary42501은 최신 제한 실행 역할·invocation 계약과 옛 fixture의 차이였으며, 권한 확대 없이 fixture를 갱신했다. invocation 추가 검사의 제한 역할 private metadata 조회42501은 owner 검사 구간으로 옮겼다. 관련 단위 검사 첫387개 중5개 실패도 최신 prepare/readResult 및 readSlots fixture 계약 차이였으며 기존 핵심 단언을 유지해388개 재검사 PASS로 확인했다.

AI22의 `aiLimitsHttpCase`와 AI23의 `aiCapsHttpCase` 함수 본문은 기존 시나리오와 byte 동일하다. 각각 SHA256은 `bfd119e776ae18086fd456d43b23ec2829c668b21f833f30d5487e9edafa97f6`, `b4bb4ecd19e1edd50675e33fffc3521069b9c59dfbddc9296eb3742d5634c161`이다. 공급사 호출은 합성 응답으로만 처리하며 실제 외부 시도0을 확인하도록 했다. UNKNOWN/90일 보호 예산 metadata는 임의 삭제·환불·시간 이동하지 않는다.

## 남은 경계와 원격 확인

기존 `/private/tmp`의 summary14 폐쇄 graph와 AI22/23 wrapper는 이 기계에 없다. 기존 보호 원본181테이블·Auth 음성 검사·TLS·Storage 실제 바이트·최종 일관 백업/복원 증거를 새 빈 DB 검사로 대신하지 않는다. 기존 source pin을 지우거나 기존 container를 중지하지 않는다.

실회원은 HOLD다. AI 공급사 보관·학습·삭제·공동 사용·출력 상한, 서울 HTTPS·KOPIS 공식7일, 지원·비용·운영 적용 승인은 그대로 남는다.

GitHub Actions 공식 읽기 API의 `jonghyun/backend100` 결과는 실행0건이다. 저장소 workflow는 `pull_request`의 파일 소유권 검사만이며 제품 회귀 CI가 아니다. 최종 일반 push·원격 SHA 확인은 후속 기록한다.

## 체크포인트 재인수 검증과 최종 회귀

인수 HEAD는 `cc71b471e593ee50278aeeaa21551637d8c7989f`이고 원격은 `19c96aa71acf44ead866b40a6789da7d38559048`이었다. actor=`jonghyun`, hook=`.githooks`, 브랜치·승인 목적지를 다시 확인했다. 미추적 파일은 이 실행 기록 한 개였다. 실행 중인 기존 observer/factory는 없었으며 재실행으로 보호 UNKNOWN 예산을 지우지 않았다. 전용 Colima는 실행 중이고 고정 socket·DB ID/image/project와 실제 migration 집합을 검증했다.

중간보고 이후 생성된 영수증이 현재 파일에 남아 있었다. 당시 HEAD의192개 source pin과 공개 로그 SHA256을 다시 계산해 두 영수증과 정확히 대조했다. PASS를 중간보고만으로 추정하지 않았다.

| 실행 증거 | 결과 | 상세 |
|---|---|---|
| `summary-observer-1791654487877075000.json` | PASS | child0, observerFailure=null,94.93초, 최소3,235,256KiB |
| summary14 공개 로그 | PASS | 경쟁8개·부족6개, 실제 외부 시도0, 소유 정리 영수증8개 모두 행 차이[] |
| `ai-observer-1791654618113029000.json` | PASS | child0, observerFailure=null,39.96초, 최소3,230,692KiB |
| AI22 | PASS | 관찰28개, 일일 시작 횟수[3,20,3], UNKNOWN 유지 |
| AI23 | PASS | 관찰6개, 계정별3,200,000·전체12,800,000, UNKNOWN 유지 |

summary observer 영수증 SHA256은 `4e4bf03b99745a403b56dd34593a3999e1b00c078558c3923cd78aae881d67c0`, 공개 로그는 `0bf98dd03a0533635cfa51ca5a0b2f157654bc083ab07e6f251926b15c4aca07`이다. AI observer 영수증 SHA256은 `5a730a756a8627b6ca3562816bdb81dd20ae1b589cae6b36c01a156a969e57c3`, 공개 로그는 `5dc44209b82991a2cbd8a408c9cd8be502da24baf2a6ef427dfbfec31a598241`이다. 두192파일 pin 묶음 SHA256은 `d1e43d7d64b16ebd41552df491659110341aba017c1c6f68bbd46a913135ed08`이다. 원문·키·factory transport 자료는 Git에 넣지 않는다.

summary14의 이전42501·정리 digest FAIL은 보존한다. 프로필 INSERT trigger가 profile FK 없는 `private.member_episodes`를 만들었고 profile DELETE만으로 사라지지 않는 것이 정리 누락 원인이었다. 정확한 두 합성 UUID, identity 없음, 네이버 연결 없음 단언으로만 정리한다. 전체 auth/public/private/storage 행 digest 검사를 제거하거나 제품 권한을 넓히지 않았다. 과거 residue 정리 영수증의 `originalSetupFullDigest=NOT_VERIFIED`도 유지하며 최초 환경 전체 복원을 소급 주장하지 않는다. 정상14개 실행은 각 실행의 사전 baseline과 정리 후 전체행·역할·membership·제품 schema ACL을 비교했다. sequence 및 시스템 임시 schema ACL은 검증 범위 밖이다.

AI fixture는 기존 계약대로 UNKNOWN/90일 예산 metadata5테이블을 삭제하지 않는다. 이 다섯 테이블은 일반 fixture 복원 digest에서 제외되지만, 실제 reservation·settle/UNKNOWN·정확한 계정별/전체 상한을 별도 SQL 단언한다. 이를 전체 DB 모든 행 원상복원으로 표현하지 않는다. 기존검사 단언/보호 pin은 유지했고 새 제외 대상을 추가하지 않았다. 재인수 읽기에서 회원/프로필/episode/작업/invocation/slot/fence/합성 역할 모두0, cron OFF·세 guard CLOSED, UNKNOWN2건과 계정별/전체 상한 보존을 확인했다. 현재 전체행 digest는 `355c07ce9e677f6e39802d3b39e240b1`이며 보호 예산 생성 때문에 summary 실행 전 digest와 같다고 주장하지 않는다.

관련 회귀를63파일로 넓히자 Node572개 중 완료 HTTP의 늦은 전송 취소 검사1개가 FAIL이었다. 직렬 실행·단독 실행에서도 같은 FAIL을 재현했다. 응답/추가 RPC 기한 차단은 유지되지만 outbound 합성 signal의 aborted 상태가 false였다. AbortSignal.any 전달을 명시 AbortController listener 연결로 좁게 수정했다. RPC 본문 읽기 완료까지 연결하고 취소 자체에서도 listener를 정리한다. 본문 JSON이 영원히 대기하는 회귀를 추가했으며 원 invocation 배정/인증/권한은 유지한다. 독립 읽기 검토에서 본문/무응답 정리 경계 보완을 받았다.

최종 수정 후 결과:

- 관련 Node63파일 **573/573 PASS**, fail0·skip0. 단독 완료 HTTP17개도 PASS이며573개에 포함되므로 합산하지 않는다.
- Python isolated 준비/observer/SQL runner18개 및 기존 database runner10개 **28/28 PASS**.
- Deno `check --no-remote ai-chat/index.ts review-summary-worker/index.ts service-api/index.ts` **3개 PASS**.
- diff 공백·소유권 검사는 PASS. 제품 변경은 내부 완료 HTTP 취소 연결1파일이며 summary/AI 제품 graph와 factory는 변경하지 않았다. summary45파일 graph는 현재 파일 SHA와 재대조해 일치했다. 최종 source pin 집합은 내부 완료 포트 변경으로 달라지므로 위 관찰192파일 해시는 실행 HEAD `cc71b47`의 증거로 유지한다.

Node 회귀 선택은 tests 아래 `.test.ts`/`.test.mjs` 중 파일명에 `ai|summary|queue|budget|maintenance|worker|request-logging|http.test|service_api`가 포함된63파일이다. `node --experimental-strip-types --test --test-concurrency=1 <선택 파일>`로 실행한다. SQL/summary/AI 재현은0700 canonical prepared root의 고정 manifest·owned container·초기 baseline 검사를 통과해야 한다. summary는 `tools/local/observe_isolated.py --prepared-root <root> --mode summary --run`, AI는 `--mode ai --run`이다. AI 재실행은 보호 예산이 없는 새 승인된 합성 scope가 필요하며 현재 UNKNOWN을 삭제하거나 시간 이동해 fresh 검사를 통과시키지 않는다.

GitHub 공식 Actions 읽기 API는 해당 브랜치 실행0건을 반환했다. workflow는 PR 파일 소유권만 검사하며 제품 CI PASS로 확대하지 않는다. 자연자정AI24·실제 Auth/PostgREST/네이버·외부 모델·원본 보호환경/Storage/백업복원·실회원 HOLD·운영 적용은 NOT_RUN/별도대기다. 관리 진행률은79%(22/28) 유지한다.
