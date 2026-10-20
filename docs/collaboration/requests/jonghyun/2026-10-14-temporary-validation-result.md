<!-- current-policy-sync:2026-10-20 -->
> **현재 적용 기준 — 2026-10-20**
> 과거 검토·실행 기록입니다. 아래 당시 선택·담당·수치·보류 문구는 현재 실행 지시나 현재 정책으로 재사용하지 않습니다. 실제 관찰·검사 결과는 당시 환경의 증거로 보존합니다.
> 기준: [정책.md](../../../../정책.md) · [정책·구현 대조 및 QA 원장](2026-10-20-policy-implementation-audit/README.md)
> **AI 선택 동의:** AI 탐색은 첫 사용 동의·거절 시 일반 검색 유지. 후기 AI는 가입 시 열람/내 프로필 생성·노출/작성 후기 활용의 세 선택 항목·기본 미선택이며 전체 동의 편의 기능과 독립 철회를 제공한다. 기존 테스트 계정 간주와 실회원 동의 증거를 구분한다.
> **행사·순위:** KOPIS는 A안의 공식 사이트 분류별 대조를 통과한14분류 Top10·어제까지 최근7일·매일 갱신 기준이다. 공급사 회신만이 유일한 공개 조건은 아니다. 서울 안전 HTTPS 수집은 민규 담당 확인 과제다. 행사 직접 입력은 공고 전용이며 별도 공용 목록/상세를 만들지 않는다. 비표출 원천 값은 숨기고 공고·약속·내부 관계를 보존한다.
> **운영·역할:** 현재 BE·AI·서버는 민규, FE·UX/UI·앱 소비·빌드 준비는 종현, UT는 유미, QA는 공통이다. 운영·지원·허용 증거 열람·AI 비용 책임자는 대표 조유미이며 대체자 미지정이다. 신고 접수와 위반 확정, 정책 확정과 실제 권한/삭제/운영 검증은 구분한다.
<!-- /current-policy-sync -->

# 종현 한시 도구 수정·실제 격리 연결 검증 결과 — 2026-10-14

전체 진행률은 **79%(22/28)**를 유지한다. 아래 완료는 승인된 로컬 합성 연결 범위다. 기존 백엔드28항목의 실회원·공급사·전체 복원·운영 조건을 완료 수에서 제외하거나 분모를 줄이지 않는다.

이 문서는 [종현 구현 기록](2026-10-14-parallel-implementation.md), [도구 충돌 지원 요청](2026-10-14-live-validation-guard-conflict.md), [한시 수정 설계](2026-10-14-temporary-guard-patch-design.md)의 당시 대기 상태를 대신하는 최신 실행 결과다.

## 구현과 실행 범위

- 종현 전용 clone `/private/tmp/yumidang-jonghyun-parallel-20261014`, 브랜치 `jonghyun/backend-parallel-20261014`, actor=`jonghyun`, hook=`.githooks`를 유지했다. 원본 `/Users/b/Documents/Antigravity/yumidang`은 `minkyu/backend100-20261012`·`831ead2ce554a672793cf0da1546f351ddcf61ce`·clean을 보존했다. 원본의 actor/hook은 미설정으로 관측했으며 변경하지 않았다.
- 제품 코드는 행사 HTTP3필터, 탐색 AI의 **회원 요청 전체에서 확인된 미전송 일시 실패만 자동1회**, 탈퇴 첫 POST 응답 유실 후 **원 JWT·탈퇴 ID로 GET만 조회**하도록 구현했다. 도구 원복 뒤에도 이 제품 변경은 유지한다.
- 실제 실행은 승인된 Colima `jonghyun-backend100`·새 합성 격리 대상만 사용했다. 로컬 TLS bridge에서 고정 소스의 서비스 runtime을 조립하고 실제 GoTrue·PostgREST·PostgreSQL에 연결했다. 배포된 Edge gateway·실제 네이버 가입·화면 검증으로 표현하지 않는다.
- 민규 정책 관리 단계는 사용자 승인에 따른 별도 **AI 민규 역할**이었다. 사람 민규가 작업했다는 증거로 사용하지 않는다. 민규 예외 중 두 도구만 한시 배정했으며 다른10개·성호 화면·hook·원본 공유 공간은 수정하지 않았다. 외부 메시지·푸시·운영 변경은0이다.

## 실제 관찰 결과

| 항목 | 실제 확인 범위 | 판정과 한계 |
|---|---|---|
| J01 행사 | 현재 HTTP3필터·커서·limit·상세/숨김·잘못된 JWT, 합성 행사17행. 원 GoTrue6명 중2명, 로컬 HTTP→Auth/RPC/DB. 고정 callback28개·Auth23/RPC23/bridge44 | 로컬 연결 PASS. 행사/숨김 정리·합성 identity2 원복·원 Auth6 유지·전체6schema 행/권한/catalog/제약 기준 복구. 합성 identity만 연결했으며 네이버 가입 완료는 만들지 않았다. |
| J06 요약 | 정식 SQL119개에서 경쟁8·부족6, 합성 Auth/모델을 쓰는 요약14 | 당시 고정 소스의 실제 격리 DB PASS. 행·역할·membership·제품 ACL 복구. 시스템 임시 schema ACL은 미검증. 이후45소스 중 helper1개가 변경됐으므로 최신45개 전체 재실행 PASS나 실제 GoTrue/공급사 요약으로 확대하지 않는다. |
| J07 피드백 | `needs_clarification` 성공 영수증1개·helpful6 동시 제출 동일 ID·타인 거절·91일 전 합성 보관 자료의 파기. 첫 파기 응답 유실 뒤 같은 작업의 저장 완료 결과 조회·다른 limit409·만료 피드백404 | 로컬 Auth/HTTP/DB 연결 PASS. 모델 시작/실제 공급사 전송0. 전체 유지관리 RPC2회는 첫 파기1회와 다른 입력 거절 검사1회이며, 원 요청의 응답 유실 복구 중 파기를 반복하지 않았다. 다른 정상 결과 종류·신고 Storage 증거는 NOT_RUN. |
| J08 읽음 | 개별 messageIds·잘못된 혼합 batch 원자 거절·같은 메시지6 동시 읽음·새 메시지 전송과 읽음 경쟁·외부 회원 거절 | 모바일 서비스→로컬 runtime→실제 Auth/DB PASS. 숨김/나감/철회 조합·실제 화면은 NOT_RUN. |
| J09 탈퇴 | 마지막 원 합성 계정에서 실제 POST 후 응답을 모형으로 유실. 같은 JWT·탈퇴 ID의 GET으로 `processing` 복구·탈퇴 RPC 반복0 | 로컬 연결 PASS. 원5세션 유지·마지막 세션 삭제·Auth user6명 유지·원 탈퇴 영수증 보존·임시 guard/5함수 권한 정확 복구. 외부 삭제/ACK 완료·90일 자연 경과는 NOT_RUN. 마지막 회원 상태는 탈퇴 처리로 달라졌으므로 원6 최종 전체 기준 복구를 주장하지 않는다. |

J07/J08 자기 fixture와 모든 행·권한 기준은 J09 시작 전에 정확히 복구했다. J09 뒤에는 자기 마지막 회원의 정확한 행 해시만 제외해 다른 행·권한·catalog·제약 보존을 비교했다. 테이블 전체를 비교에서 제외하지 않았다. 탈퇴 영수증·ACK를 삭제해 성공을 만들지 않았다. 이후 새 검증 환경 전체 정리는 별도 승인된 자원 정리였다.

Node의 `ROOT_ATTESTATION_REQUIRED`/`ROOT_BOUNDARY_CHECKS_ONLY` 결과를 자체 실제 증거로 바꾸지 않았다. Root가 원 Auth6 발급 영수증·binding SHA·고정 소스/SQL·native 상태·정리 증거를 함께 확인해 별도 `root-attestation.json`에 실제 로컬 판정을 기록했다.

## 고정 소스와 비공개 증거

- 행사 실행 HEAD: `b8302cdf3ee379a5932c6c2abedcb2c0b675c593`, source65개·SQL119개. 실행 ID `cb236c21-9ea9-480c-8dc9-81b195f06b28`, Root receipt SHA `ccc599549ce7bcd7508072e048205a2d67396816d3000a79c54e45abe1c7757f`.
- 회원 연결 실행 HEAD: `692957e37dcc56a2ea70205a17f4ce5836a5a5bb`, source100개·SQL119개. 실행 ID `f267244e-b059-44b0-b513-4f5530546b36`, Root callback21개 모두 관측. Root receipt SHA `538c40b6a6ed96527d9dcff5181aa2b23902ceddd12848d5399b2162cabd7f31`.
- 행사·회원 연결의 원 Auth6 creation receipt SHA: `fe36b6f5f7b6aa432b956d6ce9231fe4ab74740bbd3d05a550c1a4394fe7f6b5`, binding SHA `2b54cb33aa316d459bbefe86f95640ff28134ec85ca1eaca98acc7592f39dceb`. 생성·로그인·발급 증거와 가입/사진/동의 모형을 구분한다.
- 위 원 영수증과 별도 root 판정은 OS 비공개 임시 root `yumidang-jonghyun-run3-20261014-tvdp6p00`의 각 실행 폴더에 보존했다. 원 JWT·키·설정 원문은 이 문서에 넣지 않는다.
- 요약 observer `summary-observer-1791920616972494000.json`은 첫 새 root `yumidang-jonghyun-run-20261014-salbs3g6`에 있다. source193핀·301.13초, public log SHA `f791afbda96810544e687cd0eb77b81eda1688ac8d0d99745277db2175530c75`. 이후 helper AMR/일괄 조회 수정과 당시 요약 결과의 소스 차이를 보존한다.
- 행사·회원 연결 검증 당시 한시 도구 SHA: `run_database_tests.py`=`db37a30b18f7a1530e50fefbdeaa6cfa8b928b5b9a79502c5086f9dff85d0936`, `isolated_ai_contracts.py`=`48d1866c73944cea3721c5626fe20a70ce29e4e23e5b88faa0815a6f1f753cbb`.

## 실패 보존과 교정

다음 실패는 원 결과를 유지했다. 새 소스로 새 실행 번호를 발급했으며 원 요청의 전송 여부가 불명확한 상태에서 자동 재실행하지 않았다.

1. 첫 Auth 발급 검사에서 password 세션의 `auth.mfa_amr_claims`를 소유 행에 포함하지 못했다. 실제 session/user/password 귀속을 확인하는 한시 검사를 보완했다. 해당 새 계정6명은 생성 증거에 맞춰 삭제했고 새 환경을 정리했다.
2. 행사 fixture의 CREATE TEMP로 새 `pg_temp` namespace가 생겨 전체 권한 기준이 달라졌다. 진단 중 해당 namespace를 제외한 비교는 원인 확인에만 사용했다. 성공 기준은 유지하고 fixture 결과 전달을 transaction-local GUC로 바꿨다.
3. 행사 Node가 입력 종료를 기다리던 실행은 자료 원복 후에도 정상 종료 실패로 기록했다. 검증된 terminal 뒤 stdin을 닫고 실제 exit0을 확인하도록 수정했다.
4. 회원 첫 boolean 조회의 PostgreSQL `t`/`f`를 JSON으로만 해석하던 오류를 고쳤다. 그 외 값은 엄격한 JSON 검사로 유지했다.
5. qualification 상태/SQL 의도 파일의 O_EXCL 이름 충돌을 분리했다. SQL 진입 전 메모리 상태와 전체 native snapshot 동일 확인이 모두 있을 때만 미전송으로 닫고, 진입 후 오류는 UNKNOWN으로 보존했다.
6. PostgreSQL OID/소유자 ID가 JSON 문자열로 반환돼 탈퇴 준비가 실패했다. 두 조회 필드만 bigint로 반환해 엄격한 정수·원 pg_proc 행 SHA·OID/owner CAS·ACL 복구 기준을 유지했다. 읽기 준비 실패는 첫 변경 이전임과 전체 snapshot 동일 확인이 있을 때만 별도 닫고 원 실행 FAIL을 유지했다.

## 새 자원 정리와 도구·담당 원복

- 새 대상3개를 각각 정리했다: `33d5aad3`, `3895eaf0`, `b8f9f897`. 각 컨테이너6개·네트워크1개·볼륨2개, 합계18/3/6개를 정확한 생성 영수증/ID/label에 맞춰 삭제했다. 매 단계 기존 자원의 전체 metadata와 예상 inventory를 확인했다.
- 각 `owned-resource-closure-receipt.json` PASS. SHA는 순서대로 `f5d31ce69afb636cbb3a1abdcaa79bf11d87238fe28dd070cd7ee710d44bb4e8`, `72f4ab1970543fa4657e6ec3ff220f116ac6689ffcf200aaa5996b3d2e08cbec`, `3d8e4ec94ec9857770bce9608932baf0bfb615d28dea70e8f8b35c290a9c6d65`다. 동결된 생성 영수증은 바꾸지 않았다.
- 기존 컨테이너6개·사용자 network1개·volume2개의 metadata는 보존됐다. 기존 DB/Storage 읽기·직접 변경 명령은0이며 **전체 기존 저장 바이트는 NOT_VERIFIED**다. VM 시작 이전 내부 상태는 미관측이다. 기존 컨테이너를 중지하지 않도록 승인된 종현 VM은 실행 상태로 남겼다.
- 두 도구는 시작 시점 `a5a12dfc79205e4ce43f82a26df4db4f31fe0aa0`의 원 바이트로 복구했다. `run_database_tests.py` 원 SHA=`5e848bc7a52cadb9409b3e487b00107944613dceb8d5ff8f11ca77d41bb54d49`, `isolated_ai_contracts.py` 원 SHA=`04c68bb41214e3cf865637094fdc409cd901eaa8b0c31d1f0392d0979862ad8d`. 원본 shared 파일·원 Git blob과도 일치한다.
- 한시 코드·책임 시험은 `/private/tmp/yumidang-jonghyun-20261014-temporary-tool-archive`에 비공개 보존했다. 한시 계약 전용 `test_preserved_resource_guard.py`는 저장소에서 제거했다. 원복 commit=`2f3d69026fb24eed1edc8dc4b7485ed4ce25566b`.
- 민규 정책 관리 clone에서 두 경로를 minkyu로 복귀한 commit=`80c63263cf4a34b2659e49a16e96e2bca33e73b7`을 정상 FF로 받았다. 모든 소유권 rules·protected_paths·version은 한시 배정 전 기준과 동일하다. 종현 actor/hook은 유지했고 두 도구는 다시 종현 편집 거절·민규 검사 통과 상태다.

## 필요한 검사와 남은 조건

제품 변경 묶음의 Root 통합 Node 책임 검사257/257은 당시 고정 소스의 로컬 합성 검사다. 앞선234/241/248 및 에이전트 부분 결과를 더하지 않는다. 이후 검증 경계의 실제 오류 교정은 member 책임30개·J01 Node EOF3개로 확인했다. 도구 원복 HEAD 고정 후 원 함수/과거 helper 검사2개와 위33개를 묶어 **35/35 PASS**를 확인했다. HEAD 고정 전 원 함수 검사1개가 임시 HEAD와 원복 작업 파일 차이로 실패했으며 원복 commit 후 통과했다.

기존 민규 `LifecycleSingleRowsTests.test_single_statement_exact_old_bags_duplicate_counts_and_sql_projection`의 AST 격리 fixture는 `signed_exact_json` 누락 NameError가 원본에서도 재현됐다. 해당 민규 시험은 수정하지 않았고 이 기록은 그 시험 또는 전체 시험군 통과를 주장하지 않는다.

복구된 원본 도구로 이번 v2 기존 자원 보존/OS 임시 경로/Auth AMR 발급을 다시 통과시켰다고 주장하지 않는다. 원 도구는 여전히 이 환경의 재실행에 필요한 정식 지원 변경이 필요하며 [민규 지원 요청](2026-10-14-live-validation-guard-conflict.md)과 한시 archive를 후속 검토 근거로 남긴다.

종현은 승인된 행사/AI 재시도/탈퇴 복구 구현, 위 실제 로컬 연결 검증, 자기 자원·도구 원복을 수행했다. 공급사 공식 응답/모델·단위/상한/개인정보 조건, 실회원 HOLD, 실제 Storage 원본/전체 복원·운영 적용, 자연 자정·실기기/화면 등은 기존 담당과 보류를 유지한다. 성호에게 새 작업을 배정하지 않았다. 추가 정책 선택을 임의 확정하지 않았으며 전체는 **79%(22/28)**다.
