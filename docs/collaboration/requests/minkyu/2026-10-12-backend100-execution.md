# 백엔드100 재개 실행 기록 — 2026-10-12

전체 **79%(22/28)**, 핵심9/10·추가5/6·독립5/5·운영3/7. 관리 분모28을 유지한다. 코드·모형·격리 SQL·실제Auth·자정·공급사·실회원·운영 증거를 구분한다. 새 준비 파일만으로 완료 수를 올리지 않는다.

## 승인·소유권·하네스

사용자가 백엔드100 실행 계획 구현을 요청했고, 실제 로컬 Auth 포함 AI24를 선택했다. 현재 작업자는 minkyu다. 추가 답변 “필요한 경로만 민규로 재배정”으로 정책 단독 커밋 `eac8562`의11개와 `ffce766`의 observer회귀1개, 총12개 경로만 민규에게 이관했다. 나머지 종현 영역과 성호 화면·UI/UX는 유지한다. 본 작업은 새 `minkyu/backend100-20261012` 브랜치/worktree에서 진행하며 Auth·자정·복원 검토는 서로 다른 worktree의 같은 actor로 수행한다.

## A. 소스·증거 대조

인수 기준은 `9d3291b`. 최신 종현 [격리 실행](../jonghyun/2026-10-11-isolated-backend100-execution.md)과 [오프라인 잔여](../jonghyun/2026-10-11-offline-remainder.md)를 읽었다. summary14·AI22/23 실제 SQL/제품factory PASS는 해당 합성Auth/모델 범위에서 보존한다. 과거 민규0/14를 최신 종현14개 실패로 표현하지 않는다. 실제 signed Auth/PostgREST·자연 AI24·외부 공급사·실회원·운영 전체 복원으로 확대하지 않는다. 종현 비공개 영수증은 이 컴퓨터에 있다는 증거가 없으며 문서의 SHA만으로 독립 재검증 PASS를 만들지 않는다.

현재 추적된 정규 migration은 **119개**이며 `20261010030000_hidden_message_read_receipts.sql`(SQL120 번호)이 포함돼 있다. 후속 파일 SHA256은 `74653943bae50901d50c72b1f4ccd66502f2799fc8ea7a5115e73fde270fe6ef`다. 숫자119가 과거 준비 묶음119와 같다는 이유로 동일 집합/검증을 주장하지 않는다. [현재 파일 manifest](2026-10-12-backend100-source-manifest.json)는 파일별 버전·SHA만 기록하고 SQL 실행/운영 적용은 NOT_RUN/미관측이다.

| 잔여 항목 | 담당·선행조건 | 완료 증거 | 현재 |
|---|---|---|---|
| 실제 Auth·AI24 | 민규 이관 파일, 새 owned 합성 signed계정·정확한Auth/REST·실행 여유 | 원Bearer 실제 검증, 자연KST D/D+1, 원날짜정산, UNKNOWN보존·정리 | 구현 중 / 실제 NOT_RUN |
| 운영4·추가6 | 민규 연결 검증·종현 AI/행사·성호 화면, 공급사 조건 | 성공증거/유실복구/파기/개별읽음/행사소비와 활성화 조건 | 미완료 |
| 핵심10·운영5 | 사용자 실회원 HOLD 재개·팀 직접 로그인 | 두 네이버 계정 전과정·권한·탈퇴/재가입 | HOLD |
| 운영6 | 최신운영원본·역할·Storage 실제바이트·복구/지원 담당 | full복원·ACL/membership/grantor/sequence·삭제재적용·UNKNOWN·지원 | 미완료 / Storage39 누락 유지 |
| 운영7 | 전체 선행조건·구체적운영변경 승인 | 정확한 SQL/API/runner/cron 적용·실제 운영 동작 | NOT_RUN |

## 환경 읽기 결과

알려진 두 Colima profile 상태만 읽었다. 민규 `yumidang-minkyu` status는 성공했다. 종현 `jonghyun-backend100`의 로컬 profile 디렉터리는 **없다**. 다른 컴퓨터에서 중지된 종현 VM을 이 컴퓨터에서 재시작할 수 있다고 가정하지 않는다.

민규 VM의3초 제한 MemAvailable 읽기는 성공했고 **1,025,080KiB**였다. 시작 기준1,048,576KiB에 미달하므로 실제 새 검증은 READY가 아니다. 알려진 Docker 대상 목록15초 읽기는 TIMEOUT이었다. 컨테이너 상태·ID·이미지·원본DB는 미확인이다. 값 하나로 지속 여유나 장애 원인을 판정하지 않으며 동일 실패 환경에서 fixture/컨테이너를 생성하지 않았다. 기존DB 중지·VM 시작/중지·resize·외부AI·운영DB 쓰기는 수행하지 않았다.

## D. 복원/배포 준비 독립 검토

운영 프로젝트 `bndguguarijmghnkenvt`에 `BEGIN READ ONLY`와5초 statement timeout으로 이력·catalog 수량·권한 존재만 조회했다. [읽기 영수증](2026-10-12-operating-readonly.json)의 서버시각은 `2026-10-11T16:20:09.74986+00:00`이며 readOnly=on이다. 적용20개 버전·이름은 현재119개 파일과 일치하고, [적용 차이](2026-10-12-backend100-application-diff.json)는 미적용99개를 순서·SHA와 함께 기록한다. 운영 이력의 이름 일치는 적용 SQL 바이트 동일성 증거가 아니다.

public10/private4 tables, Storage metadata2 objects, cron1 job을 관측했다. `yumidang_worker_queue`·`yumidang_completion_scheduler` 역할은 없고 authenticated의public CREATE는 false다. 회원 행·파일 바이트·역할 비밀번호는 읽지 않았고 운영 쓰기0이다. 현재운영 Storage2개와 과거복원 대상39개 누락은 서로 다른 범위이므로39개 미해결을 지우지 않는다. 이 읽기 결과로 운영4~7 완료를 주장하지 않는다.

기존 `remote_schema_catalog.sql`을 읽기 트랜잭션에서 실행해 현재운영 catalog를 새로 수집했다. 원본은700 디렉터리/600 파일에 보관하고 `compare_schema_catalog` 정규 형식 검증을 통과했다. [공개 해시 증거](2026-10-12-operating-catalog-proof.json)는14개 table·46개 function·93개 column·80개 constraint·Storage policy3개 및 ACL 수량을 기록한다. 최신 로컬 baseline이 없어 비교/복원은 NOT_RUN이다. 별도 읽기로 [역할31개·membership25개 해시](2026-10-12-operating-roles-proof.json)를 수집했으며 비밀번호는 제외했다. 이 해시는 DB 내부 OID를 포함하므로 서로 다른 환경의 역할 동일성 비교에 쓰지 않는다. anon/authenticated public CREATE는 모두false다.

준비 도구는 항상 PREPARED_NOT_ACTIVATED/activationAllowed=false이며 승인 영수증으로 승격하는 경로가 없다.119개 전부 적용됐다는 합성 입력에서도 운영 실행을 닫는다. 기존 Python25회귀 PASS, 추가 자기해시 재생성 기반 승격 반례6개도 거절했다. 실제 restore가 없으므로 native-first timeout·Storage39누락·최종원본/역할/ACL/sequence/UNKNOWN 증거는 미해결이다. 결함 근거가 없어 준비 도구와 기존25테스트를 불필요하게 수정하지 않았다.

현재 실제운영20개 이력을 기존 준비 도구 `build_plan`에 전달하고 검토 고정 SQL119개 SHA를 재검사했다. 결과는 `PREPARED_NOT_ACTIVATED`, pending99, activationAllowed=false다.162개 제품소스 snapshot SHA는 `82f8ce56db45e1f0f57a267a5a74cdd8cfe62bdd88a4ea96f2166e2df443dcb1`이다. 이 snapshot은 제품 코드 범위이며 이번 테스트/도구 수정 전체를 포함하지 않는다. 최신 로컬catalog baseline 비교·실제복원이 없어 최종 닫힌 배포 묶음은 생성하지 않았다.

[운영 Edge Functions 읽기](2026-10-12-operating-edge-functions.json)에서는 기존 `test-phone-auth` v6·`test-institutional-email-auth` v4가 ACTIVE였다. Supabase Edge 범위에서 현재제품 service-api/ai-chat/scheduled-jobs 배포는 관측되지 않았다. 다른 호스팅의 현재기동은 읽지 않았으므로 전체 API 부재로 확대하지 않는다. 기존 테스트 함수는 실행·수정·삭제하지 않았고, 최종 운영전환 검토에 남긴다.

## 공급사 공식 자료 읽기

[포텐스닷 공식 홈](https://potens.ai/)에는 Claude Sonnet4.6 문구가 있다. 이 표시는 유미당 API의 현재 모델ID·보관·학습·삭제·공동계정·청구 계약 증거가 아니며 선택 모델을 임의 변경하지 않는다. API에 적용되는 조건은 미확인 유지, 회원 원문 전송0.

[서울시 문화행사 데이터셋](https://data.seoul.go.kr/dataList/OA-15486/S/1/datasetView.do)은 서울문화포털 원천의 문화행사·가격·유무료 정보를 안내한다. 공식페이지 읽기만으로 실제 API HTTPS 수집 PASS를 주장하지 않는다. [KOPIS 공식 개발가이드](https://kopis.or.kr/upload/openApi/%EA%B3%B5%EC%97%B0%EC%98%88%EC%88%A0%ED%86%B5%ED%95%A9%EC%A0%84%EC%82%B0%EB%A7%9DOpenAPI%EA%B0%9C%EB%B0%9C%EA%B0%80%EC%9D%B4%EB%93%9C.pdf)의 boxoffice 시작/종료 날짜 계약을 확인했지만 실제 공식7일 응답·권한·HTTPS·갱신 검증은 미완료다. 자체계산이나 요청 날짜만으로 공식집계 기간을 대체하지 않는다. 외부 문의·추가 결제·운영 활성화는 하지 않았다.

## 관찰기·소비자 검증

실제 `/auth/v1/user`와 PostgREST 원Bearer 전달을 사용하는 signedAuth runner/factory를 통합했다.6개의 미리 생성된 합성 계정과 원세션을 읽기로 확인한 뒤에만 AI fixture를 생성하며 Auth/users/profile 수명주기는 변경하지 않는다.4개 owned container·config·manifest·소스·원 UNKNOWN 전체행을 고정하고 정리는 단계별 실패에도 계속한다. 민규 테스트29개 PASS에는 실제 제품factory+모형Auth transport 정상/거절, 실제 기존 AI24 함수 본문 보존, 영속 재개 상태와 원 UNKNOWN, 자정 전 단일 준비 권한·누적 read timeout 검증이 포함되지만 실제 GoTrue/REST 연결이 아니다. UPDATE와 같은 SQL 트랜잭션에서 실제시각·원 자정·600~3600초 창을 먼저 검사하도록 구현했다. 이 SQL의 실제 실행은 NOT_RUN이다. 독립 읽기 검토에서 추가 확정 차단 결함은 발견하지 못했다. 실제signedAuth·만료/회수/익명 세션 거절·TLS는 NOT_RUN으로 남긴다.

[Supabase signout 문서](https://supabase.com/docs/guides/auth/signout)는 세션 회수 뒤에도 JWT 자체가 만료 전 유효할 수 있다고 설명하고, [서버 인증 가이드](https://supabase.com/docs/guides/auth/server-side/advanced-guide)는 `getUser()`로 서버의 세션 종료를 확인하는 경로를 안내한다. 현재 제품은 `/auth/v1/user`를 호출한다. 로컬 GoTrue 이미지와 회수된 실제 서명 세션 응답은 아직 없으므로 특정 버전의 회수 거절을 문서/토큰 모양만으로 PASS 또는 제품 결함으로 판정하지 않는다. 회수·만료·익명 실제 negative fixture 검증은 그대로 남긴다.

실제 signedAuth 전용 ai-signed 모드와 private binding 입력 전달을 연결했다. 단순 child exit0·합성Auth PASS로 실제Auth 성공을 판단하지 않는다. 서명Auth/PostgREST PASS 범위와 Naver/외부공급사/자정/TLS 미실행 표식을 함께 요구한다. private signed binding은 검증된 stable-fd 원본바이트의SHA로 실행 전후 동일성을 확인한다.

독립 검토에서 코드 해시 확인 전 runner import와 부모 종료 뒤 남은 자식 그룹 경계를 발견해 수정했다. 고정 dependency sourcepins·HEAD 바이트를 먼저 확인하고 캡처된 runner 바이트만 평가한다. 부모가 먼저 종료해도 start_new_session으로 소유한 동일 그룹을 종료·부재 확인하며, 확인할 수 없으면 FAIL/미확인이다. 기존1GiB/768MiB와3초 probe 기준은 유지했다.

관찰기13회귀PASS. 별도 실제 새소유 부모+자식1개 연기2초 smoke에서 부모exit0 뒤 살아 있는 자식 그룹을TERM하고 그룹 부재를 확인했다. 이 실제프로세스 종료 증거는 DB/VM/제품연결 검증이 아니다. DB/VM 호출0.

현재원격소스 메시지읽음·신고숨김/안내·탈퇴adapter/store37회귀PASS. 성호 화면은 여전히 직접 session.retire 호출 뒤 processing/completed 구분 없이 세션을 제거하므로 [기존 요청](2026-10-09-sungho-retirement-consumer.md)을 갱신했다. 실제 화면/회원/운영 완료로 집계하지 않는다.


## AI24 최종 통합과 검증

고정 signed runner를 쓰는 준비·실행 API와 새 프로세스 재개·부분 정리 전용 API를 구현했다. private 계약과 준비 상태의 SHA, 원 요청·예약·날짜·UNKNOWN, 전체 원 행 및 권한을 확인한다. 준비와 실행 중3초 간격 메모리 감시, 준비 전1GiB와 실행 중768MiB 기준을 유지한다. 실제 SQL 시각으로 원 자정 창을 다시 확인하며 시간 이동·예산 확대·재전송은 하지 않는다. 기본 CLI는 오프라인 전용이다. 검토 코드 객체만 고정 실행 API를 조립할 수 있고 JSON/env 승인 값으로 실행 권한을 만들지 않는다.

부분 준비 중단 뒤에는 원 제어값·행·권한 복원을 별도로 시도한다. 기존 자식의 종료 영수증이 없거나 전체 예산 증거가 불완전하면 FAIL/UNKNOWN을 보존하며 자정 전체 PASS로 승격하지 않는다. sequence 현재값과 Storage 실제 바이트는 이 검사 범위 밖이고 NOT_VERIFIED다. 캡처한 runner/helper 바이트 외 일반 dependency import 전체를 불변 실행으로 증명한 것은 아니다.

통합 worktree에서 AI24 48개·signedAuth 29개·기존 자정 준비13개·관찰기13개, **총103개 오프라인 회귀 PASS, skip0**. 별도 복구 검토는 최종 AI24 소스 a5c51233에서 추가 확정 차단 결함을 찾지 못했다. 실제 Auth/HTTP/DB 자연 자정 실행은 NOT_RUN이다. 기존 require/private_root/private_bytes/inspect_evidence/natural_windows/main 본문은 보존했고 contract_pins는 import 전 HEAD 검증, build_plan은 실행 상태 설명을 수정했다.

[최종 검증·소스 해시](2026-10-12-backend100-verification.json)에 통합 작업 파일과 결과를 기록한다. 정책 두 커밋 외 구현 변경은 아직 작업 트리에 있으며 커밋·푸시하지 않았다. 실제 실행 전 검토된 전체 소스를 HEAD로 고정해야 한다.

## 남은 실제 조건과 다음 실행

1. 시작 메모리 기준과 exact Docker 대상·이미지·기존 작업을 확인한 격리 환경, 미리 생성된 합성 Auth6계정 및 원 서명 세션의 비공개 입력을 준비한 뒤 실제 signedAuth를 실행한다. 중지된 종현 VM 재시작은 별도 실행 경계다.
2. 기존 AI23이 소모한 날짜의 예산을 초기화하지 않고, 새 자연 한국시간 날짜의 headroom과 시간창에서 AI24를 준비·재개한다. 만료/회수/익명 실제 인증 negative 증거도 필요하다.
3. 최신 전체 DB/역할/Storage 원본 바이트와 기존39개 누락 파일 확보·복원, 공급사 조건 및 지원·백업 정책 확정이 필요하다. 실제 화면 연결은 성호 요청으로 남긴다.
4. 실회원 HOLD를 유지한다. 사용자 재개 뒤 실제 두 회원 전 과정과 선행 조건을 마친 다음 검토 가능한 운영 적용 묶음을 제출하고 운영 변경 승인을 받는다.

현재 관리 완료율은 계속 **79%(22/28)**다. 이 작업의 코드·오프라인 회귀·운영 읽기는 남은 실제 실행6항목을 완료시키지 않는다.


## 2026-10-13 계속 실행

전체79%(22/28) 유지. [실제 읽기 재확인](2026-10-13-backend100-readiness.json)에서 민규 Docker 목록은 이번에는 성공했다. 실행 중28개 컨테이너를 확인했고 VM MemAvailable1,015,632KiB는 시작1,048,576KiB에 미달했다. 과거 행사112 격리 DB 한 개의 정확한ID·이미지·재시작no·다른 접속0개를 읽기로 확인해 정상 중지 승인 질문을 제출했다. 아직 중지·삭제·fixture 생성은 하지 않았다. 이전 Docker TIMEOUT 기록은 보존하며 이번 성공으로 현재 읽기 상태만 갱신한다.

추가 코드 검토에서 signedAuth runner는 민규/종현 owned socket을 지원하지만 observer 메모리 probe는 종현 profile로 고정된 실행 연결 공백을 확인했다. 재배정된 observer 두 파일만 별도 하네스에서 수정·회귀한다. 전체 복원 입력과 합성 Auth6계정 생성 영수증의 가용성도 독립 읽기 검토 중이다.

사용자가 행사112 격리 DB 한 개 정상 중지를 승인했다. exactID와 다른 접속0개를 재확인하고30초 정상 중지해 exit0·컨테이너 보존을 확인했다. 삭제·volume 제거·다른DB 중지는 하지 않았다. 직후 MemAvailable1,107,232KiB로 시작 기준을 충족했다. 정식119개SQL/config를 새 private700/600 임시 루트에 준비했으며 실제 기동·SQL은 아직 NOT_RUN이다. 최초 출력 루트는 시스템 temp 하위 조건에 걸려 BLOCKED였고 허용된 시스템 temp 루트로 다시 준비했다.

합성 signedAuth6계정의 admin 생성/로그인과 clone-only episode/session/profile 연결 영수증 producer가 기존 도구에 없다. 기존 탈퇴 fixture는 네이버 내부 이메일 형식이 달라 그대로 재사용할 수 없다. 기존 책임 runner와 민규 회귀에 이 연결을 구현하고 독립 검토한다. AI23 일별 예산 및 UNKNOWN은 유지하고 AI24는 별도 새 대상에서 실행한다.

observer를 통합해 signed binding의DB ID와 새로 검증한 준비 대상을 대조한 뒤 exact context/socket 쌍으로 민규/종현 메모리 profile을 선택한다. 실행 전후 전체 target/profile proof가 같아야 한다. 기존 합성 모드와 메모리 기준은 유지했다. 기존13+신규5,18개 오프라인 회귀PASS. 별도 읽기 검토에서 추가 확정 차단 결함은 없다. 실제 signedAuth 실행은 아직 NOT_RUN이다.
