# 민규 잔여 10개 작업 진행 기록

사용자가 2026-10-06 승인한 계획 기준. 과거63.5%는 과거 단계 점수이며 이 문서는 잔여 완료 개수를 따로 센다. 전체 서비스 출시와 민규 담당 완료는 별도다.

| 번호 | 상태 | 검증/남은 조건 |
|---|---|---|
| 1 최신 기준 | 완료 후 신규 후보 검증 유지 | 원격 handoff7b42957/J26aca72 동일 확인. SQL87 준비 READY, 준비검사107통과+1개 수정 후 재검사 통과. 새 SQL88도 READY/4개 영향 검사 PASS |
| 2 숨김/안내 | 완료 | 정식 로컬88 적용·기존 데이터 보존. 격리 프로젝트에서 실제 Auth JWT→소켓 HTTP→DB로 본인 숨김/해제·타인 차단·준비/읽기 무마감·중복 ACK 비연장 PASS. 원 환경 control=false 유지 |
| 3 일반 이의 | 완료 | SQL88 정식 로컬 적용·기존 데이터 보존. 실제 JWT HTTP 접수/조회·타인 차단·6개 경쟁 접수 단일 생성·재전송 PASS. DB 마감/보관 검사와 모형541/541 PASS |
| 4 검토/정정 | 완료 | 일반 이의 검토·정정·종결 및 취소 전용 종결 PASS. SQL94 명시적 원 제재 시각/회차 연결·신규 실제 시각·멱등·미배정 차단 실제 DB/직원 HTTP PASS. 탈퇴 후 동일 identity 재가입 제한 승계·당도15 실제 회원 HTTP PASS |
| 5 파기/실행기 | 종현 소비자 연결 대기 | 기존 포트/Storage 유실·복구 검증 보존. 실제 두 실행기 통합 미완료 |
| 6 AI 원자 예산 | 완료 | SQL92 계정/전체·기존 누적 호출 제한, 미확인 예약 유지, 멱등 정산. 실제 회원20회/요약 권한/마지막 슬롯 경쟁 HTTP와 종현 pool→민규 adapter→실제 DB 통합 PASS. 외부 제공처·운영 활성화 별도 |
| 7 AI 공개자료 | 완료 | 실제 종현 repository→민규 DB 연결·요약 게시 및 회원 JWT HTTP 조회 PASS. 공개 한마디 3개·비공개 제외·revision 변경 후 게시 무효화 PASS. 외부 모델 호출 0 |
| 8 검색/행사 | 완료 | current_public_search PASS. 행사 회귀의 옛 신청 인수/비로그인 별칭/검색RPC를 현행 계약으로 갱신하여 v4 PASS. 실제 HTTP 6페이지 재개·회원별 주소 권한·최신/취소 행사 표시 PASS |
| 9 전체 회원흐름 | 적격 계정 2개 준비 대기 | 실제 네이버 연결 성공 후 현재 계정의 가입 자격 미충족 차단 확인. 사용자 답변: 지금은 적격 계정 준비 어려움. 양쪽 전체 흐름 완료로 집계하지 않음 |
| 10 운영준비 | 완료 | 운영 이력과 후보 차이·순서/권한/cron/복구 체크리스트 및 공개 초안 연결. 별도 격리 DB+Storage 복구와 알려진 삭제 재적용 PASS. 실제 운영 배포·외부조건 별도 |

현재 잔여 완료8/10(80%). 5·9은 각 항목의 완료 조건 전체를 통과하기 전 집계하지 않는다. 운영변경·커밋·푸시0.

## 새 일반 이의 API

- POST `/me/general-sanction-appeals`: `{noticeId,clientRequestId,reason}`. 회원·마감·제재는 서버 검사. 정확히 동일한 요청의 재확인은 마감 뒤에도 기존 접수 facts를 반환한다. 같은 요청ID의 다른 내용 또는 같은 제재의 추가 접수는 거절한다.
- GET `/me/general-sanction-appeals/{appealId}`: 본인 현재 회차만 조회. exact6 `{appealId,noticeId,state,receivedAt,deadlineAt,alreadyApplied}` 반환. 원 신고자·운영자·원문 사유는 공개하지 않는다.
- 일반 이의를 원 사건 신고와 연결하여 검토 중 조기 종결·파기를 막는다. 사용자 이유는 신고와 함께 최종 종결+90일 보관 대상이다. 제재를 접수 시 해제하거나 다시 시작하지 않는다.
- 신규 제약은 취소 이의의 기존 연결을 보존하고 일반 이의에도 연결을 허용한다. 기존 적용SQL을 수정하지 않는다. 운영자 심사와 앱 ACK 연결 전 control=false 유지.

## 비공개 로컬 검증 근거

- `/private/tmp/yumidang-native87-rollout-v1/`: 첫 적용/검사 실패 기록. 반복 적용하지 않음.
- `/private/tmp/yumidang-native87-postflight-v2/receipt.json`: 읽기 사후검사PASS,87개 적용과 기존상태 보존.
- `/private/tmp/yumidang-general-appeal88-probe-v2/receipt.json`: 후보88 rollbackPASS/native87전체보존, 마감 후 신규거절·기존재확인.
- 원래 SQL87·숨김85/86의 검증 기록은 기존 인수인계 문서 참조.

## 대기 조건

종현 취소·신고 소비자/계정pool 런타임은 해당 담당만 편집한다. Railway 접근, 공급사 개인정보/공동사용/출력상한, 공개URL/지원배정, Apple계정, 서울HTTPS/KOPIS기간 확인은 별도 출시 조건이다. 이 문서는 완료되지 않은 연결을 대신하지 않는다.

## 추가 검증

공개 요약/검색 native87 rollbackPASS: `/private/tmp/yumidang-release-public87-regression-v1/receipt.json`의 개별 결과. 해당 묶음의 행사 실패는 보존한다. 행사 수정1~3 실패 원인은 차례로 구 신청RPC 인수, 구 비로그인 표시, 구 검색RPC였으며 후보를 현행 정책·계약에 맞춰 수정했다. 최종 `/private/tmp/yumidang-release-events87-regression-v4/receipt.json` PASS/native87보존이다. 실제 제공처 호출·운영 통합 완료의 증거는 아니다.

사용자는 실제 네이버 검증의 두 번째 계정에 팀원이 직접 로그인할 수 있다고 답변했다. 자격증명은 받지 않았으며 검증 화면·순서 준비 후9번에서 진행한다.

## 2026-10-06 실제 연결 증빙과 추가 결정

- `/private/tmp/yumidang-native88-rollout-v1/receipt.json`: 정식 로컬88 적용 PASS, 기존 자료·권한 보존.
- `/private/tmp/yumidang-release88-http-isolated/http-receipt.json`: 격리 환경 실제 Auth 비밀번호 발급 JWT·소켓 HTTP·DB 15개 검사 PASS. 네이버 공급사 로그인 검증을 뜻하지 않는다.
- `/private/tmp/yumidang-release88-http-isolated/resolution-http-receipt.json`: 배정된 운영자 실제 JWT HTTP 기각·멱등·미배정403·기존 제재 전체 값 유지 PASS. SQL89는 격리 환경 후보 적용이며 원 로컬 정식 적용 아님.
- `/private/tmp/yumidang-general-resolution89-probe-v3/receipt.json`: 인용/기각 실제 DB 및 원 로컬88 전체 롤백 보존 PASS.
- `/private/tmp/yumidang-historical90-probe-v3/receipt.json`: 실제 탈퇴 흐름·탈퇴 전 사건 최초 영구 제재·새 감점 미생성 및 원 로컬88 전체 보존 PASS. 재가입 후 전체 흐름은 별도 확인한다.
- 사용자는 AI 다계정 전환에서도 **기존 내부 모델 호출 수 제한 유지**를 확정했다. 회원 하루20회·계정별 한국시간 하루320만 토큰·전체 등록 계정 합계와 함께 적용하며 기존 호출 제한 숫자를 임의 변경하지 않는다.

## 준비 도구90 후보 등록

SQL89·90 검토 해시와 이전88/89의 정확한 경로 집합을 등록했다. `/private/tmp/yumidang-policy90-resolution-historical-prepared/current-policy-manifest.json`은 READY이며 Git86·미커밋 후보4·전체90, SQL/Edge실행 NOT_RUN이다. 이전 이력을 그대로 유지한다. 테스트의 옛 total_count88 기대값 두 건을90으로 수정한 뒤 해당 두 검사 PASS(`/private/tmp/yumidang-preparation90-focused.log`). 전체 검사 실행에서 같은 두 기대값 실패를 보존하고 중단했으므로 전체 통과로 보고하지 않는다. 후속 후보 정식 적용 전 전체 검사를 마친다.

AI 호출 제한의 확인된 누적 원장 방식과 종현 연결 요구는 [다계정 호출 제한](2026-10-06-ai-account-call-gate.md)에 기록했다. 구현 완료는 아니다.

## 실제 종결·검색·행사 추가 검증

SQL91 최종 종결 후보: `/private/tmp/yumidang-final-closure91-probe-v2/receipt.json` 실제 DB PASS·원 로컬88 전체 복원, `/private/tmp/yumidang-release88-http-isolated/closure-http-receipt.json` 실제 직원JWT→소켓HTTP→DB 종결/멱등/미배정403/90일/버전1회 PASS. 종결 지원은 typed assigned report 경로이며 취소 전용 판정 경로는 후속 통합이 필요하다. 4번 전체 완료 아님.

8번 완료: `/private/tmp/yumidang-release88-http-isolated/events-http-receipt.json` 행사 저장·공고 연결의 전체 SQL assertion과 공개 상세 HTTP PASS. `/private/tmp/yumidang-release88-http-isolated/search-events-http-receipt.json` 실제 소켓HTTP·회원JWT·6쪽 재개·비공개 등록주소 검색 일치/미반환·상세만남점 제외·취소 후 상대 재마스킹·최신 취소/종료 행사 표시 PASS. 제공처 실제 호출 승인·준비는 별도 출시 목록이다.

## AI 원자 예산 실제 통합 증빙

- `/private/tmp/yumidang-ai-account92-probe-v3/receipt.json`: 계정/전체 한도·기존 정산 우회 차단·unknown 원본 예약 유지·멱등 정산·권한 PASS, 원 로컬88 전체 보존.
- `/private/tmp/yumidang-ai-account92-scope-probe-v5/receipt.json`: 외부 guard·동일 회원 요청 중복 차감 방지·20회 마감의 모든 원장 롤백 PASS.
- `/private/tmp/yumidang-ai-account92-summary-probe-v1/receipt.json`: 기존 AI 원자 회귀에 새 요약 예약을 연결하여 동의·공개 근거·revision·worker/job 점유 검증 PASS.
- `/private/tmp/yumidang-release88-http-isolated/ai-budget-http-receipt.json`: 실제 service JWT HTTP 두 요청의 마지막 호출/계정 토큰 경쟁·unknown유지·원 일자 정산 PASS. 일자 경계는 원 일자 합성 fixture 검사이며 실제 자정을 기다린 결과가 아님.
- `/private/tmp/yumidang-release88-http-isolated/pool-adapter-http-receipt.json`: 종현 AccountPool→민규 RPC adapter→실제 InternalClient→HTTP→DB, 호출 전 계정 전환·한 번 모델 fixture 호출/정산 PASS. 외부 제공처 호출0.
- `/private/tmp/yumidang-preparation91-tests.log`: 준비 도구 전체108/108 PASS. SQL92 검토 해시 등록·정식 원 로컬 적용은 후속이며 현재 원 로컬88·격리 후보92, 운영 변경0이다.

## 2026-10-07 검증

SQL92 검토 해시/과거91 집합 등록, 준비 READY(92/86/6), 전체 준비 검사108/108 PASS. 복구·삭제 재적용은 `/private/tmp/yumidang-release92-recovery/recovery-receipt.json` PASS. [배포·복구 인수인계](2026-10-07-release-recovery-checklist.md)에 한계·외부 담당을 명시했다. 4번 제재 lineage/취소 전용 종결, 5번 종현 소비자, 9번 적격 두 계정은 미완료.

## 제재 정정 최종 연결

- SQL93 취소 전용 종결: `/private/tmp/yumidang-cancellation-closure93-probe-v3/receipt.json`, 격리 `cancellation-closure-http-receipt.json` PASS. 초기 기대 오류 코드와 변수/열 충돌 실패는 v1/v2에 보존했다.
- SQL94 동일 제재 clock lineage: `/private/tmp/yumidang-cancellation-clock94-probe-v5/receipt.json` PASS·원 로컬88 보존. 원 제재 시각/회차 보존, 신규 실제 시각, 원 근거 삭제 차단, 재계산 무변경, CAS·불완전 입력·권한·멱등을 검증했다. `clock-lineage-http-receipt.json`은 실제 직원 Auth JWT→HTTP→DB PASS.
- 실제 재가입: `/private/tmp/yumidang-historical90-rejoin-probe-v2/receipt.json` DB PASS, 격리 `historical-rejoin-http-receipt.json` 실제 회원 JWT HTTP PASS. 네이버 제공처 응답은 합성 fixture이며 9번의 실제 네이버 두 계정 검증을 대체하지 않는다.
- 일반 제재의 검토 중 기존 제한 유지와 취소의 24시간/판정 보류는 정책6-3에 따라 구분한다. 기존 취소 suffix suspension은 구현 해석이며 별도의 명시적 사용자 결정을 새로 받았다고 표현하지 않는다.

## 최신 마무리 증거

SQL94 준비 산출물 READY: `/private/tmp/yumidang-policy94-reviewed-prepared/current-policy-manifest.json`(전체94·Git86·후보8, 준비 시 SQL/Edge NOT_RUN). 전체 준비 검사 `/private/tmp/yumidang-preparation94-tests.log`108/108 PASS. 연결된 신고 HTTP 계약 회귀 `/private/tmp/yumidang-report94-connected-regression.log`11/11 PASS 및 Deno check PASS.

최신 후보·제재 clock lineage 2개까지 포함한 재복구와 알려진 삭제 재적용은 `/private/tmp/yumidang-release94-recovery/recovery-receipt.json` PASS. 최초 SQL92 복구 증거도 보존했다. 원 정식 로컬88은 변경하지 않았고 격리 검증용 guard는 다시 닫았다.

남은5번은 종현 소비자 구현/연결과 실제 두 실행기 경쟁·재시작, 9번은 가입 조건을 충족하는 실제 네이버 두 계정 및 기기 협업 검증이다. 계정 준비가 어렵다는 사용자 답변을 반영해 가입 자격을 우회하지 않았다. 운영 배포·공급사 답변·Railway·공개 게시·스토어는 별도 출시 상태로 유지한다.

취소 정정→원 시각 연결→최종 종결의 동일 신고 실제 직원 JWT HTTP 흐름도 `clock-repair-final-closure-http-receipt.json` PASS이며 서버 종결+90일을 확인했다. 이 추가 합성 종결은 최신 복구 snapshot 이후 수행했다.
