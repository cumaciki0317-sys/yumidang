# 백엔드100 재개 실행 기록 — 2026-10-12

## 2026-10-20 현행 기준과 이 문서의 적용 범위

이 문서는 과거 요청·설계·검증 기록이다. 아래 원 관찰·명령·해시·PASS/FAIL은 당시 증거로 보존한다. 재개할 때는 다음 현행 조건을 먼저 적용하며 과거 작업 권한·보류를 현재 지시로 재사용하지 않는다.

- 담당은 현재 민규=BE·AI·검색·행사·서버 운영, 종현=FE·UX/UI·앱 API/세션 소비·빌드, 유미=UT·출시/지원 책임이다. 아래 옛 종현 BE·성호 UI 배정은 당시 기록이며 현재 실행 권한으로 사용하지 않는다. 구체 파일은 현행 소유권 정책을 따른다.

- 포텐스닷 문의 회신은 사용자가 공유했다. 공급사는 교육·프로토타입 범위, 일일/기간 제한·기능 축소·보안 우려로 공개 서비스에는 다른 API를 권고했다. 보관·학습·삭제·공동 사용의 구체 조건은 여전히 미확인이다. 포텐스닷 제품 활성화를 기다리는 계획으로 읽지 않는다. Gemini는 종현 테스트 전용 프로젝트에 결제 연결·월50,000원 사용중단 예산을 준비했으나 최종 청구가 지연 없이 반드시 5만원 이하라는 보장은 아니다. 합성 테스트와 대표 유미 계정 전환·제품 adapter·실회원 전송은 별도다. 대표 계정 전환은 회의/브랜치 통합 때 진행한다. Potens 기술 토큰 원장과 Gemini 원화 지출 원장은 분리한다.

- AI 탐색 동의는 첫 사용 시 받고 거절하면 일반 검색을 유지한다. 후기 요약은 가입 시 열람·내 프로필 생성/노출·작성 후기 활용을 기본 미선택인 별도 선택 세 항목으로 받는다. 전체 동의와 개별 자세히 보기를 유지하고 미동의 가입/일반 동행을 허용한다. 세 동의의 철회는 독립적이다. 현재 서버의 summary_allowed 하나·review_summary 일괄 철회가 이 세분화 요구를 구현했다고 해석하지 않는다. 테스트 계정 동의 간주는 실제 동의 증거·DB 값 변경·회원 원문 전송 승인이 아니다.

- KOPIS는 전체 공연·연극·뮤지컬·클래식·국악·대중음악·무용·대중무용·서커스/마술·복합·아동·대학로·내한·축제 14항목, 어제까지 최근7일·매일 갱신이다. basedate 누락만으로 영구 공개 보류하지 않고 공식 사이트의 실제 기간·조건·공연ID/순위/순서를 대조한 분류만 공개하는 A안을 적용한다. 요청 날짜로 기간을 확정하거나 일일순위를 합산하지 않는다. 확인 기간·시각·출처를 표시하고 실패 때 마지막 검증 기간을 유지한다. 아래 all/musical·basedate 필수 parser·not_enabled는 현재 구현/당시 검증의 기술적 한계이며 최신 제품 정책이 아니다. 일반 공연 수집·칼럼 매핑은 순위 대조와 병행한다.

- 서울은 키/응답의 평문 HTTP 수집을 활성화하지 않는다. 검토된 HTTPS 자동 수집 경로·실제 최신 응답 envelope·페이지 재개·진행 중 갱신 확인까지 보류한다. 홈페이지 HTTPS 성공이나 HTTP 앞에 s를 붙인 주소는 API 전송 보안 검증이 아니다. 이 보류는 다른 공급사·공통 칼럼/화면 준비의 중단을 뜻하지 않는다.

- 일반 신고·허용된 증거 열람·비용 운영 책임은 대표 조유미(유미), 공개 지원 메일은 cumaciki0317@gmail.com이다. 별도 등록 사업자는 없고 대체 담당은 미지정이다. 평일09~18시/신고 첫 확인2영업일은 목표이며 실제 권한 설정·메일 수신·응답 보장 증거가 아니다. 앱 밖 삭제는 공개 방침의 직접 연결 구역과 이메일로 받고 첫 답변/본인확인 후 처리 목표는 정책13장을 따른다. 운영자는 회원 채팅 DB 원문을 직접 읽지 않는다.

최신 기준: [정책.md](../../../../정책.md). 구현과 남은 조건: [서버·DB 대조 원장](../jonghyun/2026-10-20-policy-implementation-audit/server-audit.json).


전체 **79%(22/28)**, 핵심9/10·추가5/6·독립5/5·운영3/7. 관리 분모28을 유지한다. 코드·모형·격리 SQL·실제Auth·자정·공급사·실회원·운영 증거를 구분한다. 새 준비 파일만으로 완료 수를 올리지 않는다.

**최신 세부 진척:** 소스 `37863a66e50467f707961a7036a6efae604cb6dc`. AI24 서명 계정 선택/영속 준비 연결 구현과 54개 회귀가 완료됐고, SQL120 실제 DB의 같은/겹친 메시지 동시 읽음·숨김 거절·최초 읽음 시간·원본178개/권한 보존·정상 종료가 C20에서 최종 PASS했다. C21에서 실제 로컬 Auth·제품 AI 결과 없음·공개 동의 철회·철회 후 예약/모델0·원 행/UNKNOWN 보존·새4개 정상 종료도 통과했다. 전체 완료22/28은 아직 그대로이며 아래 여섯 완료 단위의 남은 조건을 제외하지 않는다.

| 미완료 단위 | 현재 남은 주요 조건 |
|---|---|
| 핵심10 | 실회원 두 계정 전 과정, 현재 HOLD |
| 추가6 | 현재 HTTP·실제 화면 소비·외부 활성화 조건 등 전체 연결 |
| 운영4 | 실제 Auth/AI·자연 자정·주기 파기 및 외부 조건의 실제 연결 |
| 운영5 | 실제 회원 운영 전 과정, 현재 HOLD |
| 운영6 | Storage39 실제 원본 바이트·전체 복원·지원/백업 담당 조건 |
| 운영7 | 선행 조건 충족 후 별도 승인된 운영 적용·복구 검증 |

검증 증거와 세부 범위는 [현재 coverage](2026-10-13-auth-lifecycle-coverage.json)의 actualSql120C20, [실행 기록](2026-10-13-auth-lifecycle-execution.md)을 따른다.


## 최신 사용자 병렬 배정

사용자는 성호 신규 작업 배정을 금지하고 종현 백엔드 잔여를 넓게 배정하도록 요청했다. [종현 J01~J09 병렬 인계](2026-10-13-jonghyun-parallel-backend.md)를 따르며 민규12개·Auth/AI22/23/24·복원은 민규가 유지한다. 기존 성호 소유권/변경을 보존하고 실제 화면 검증 조건도 분모에서 제외하지 않는다. 기존 성호 관련 기록은 과거 상태이며 이번 배정으로 새 화면 작업을 요청하지 않는다.

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



검증 완료19파일은 사용자 승인으로 로컬 commit7898a83에 고정했다.193개 구현/검증 그래프 파일의 HEAD바이트 일치와 sourcepins SHA e815f4598273114b547e31b555094bd2c144cf6b0c011953e06882a7d1844434를 확인했다. 푸시는 하지 않았다. 이 문서/검증 JSON의 UNCOMMITTED 표시는 해당 사전 동결 시점을 기록하며 이후 실제 실행 기준은7898a83이다.

사용자가 canonical 합성 원본 한 개의 재시작·읽기를 승인했다. exactID·정지·이미지·설정 해시를 재확인한 뒤 기동했고 읽기 전용·다른 접속0개를 확인했다. DB에 migration 이력 테이블은 없으며119개는 기존 private 적용 영수증으로 기록돼 있다. 영수증119개 버전·바이트 SHA와 현재SQL이 정확히 같고 inventory SHA e879b213c91b4da96479322896bc33fb6f216b4f297f1382f2f90c907d7e1c10을 root도 재검증했다. 실제SQL 재생은 하지 않았다.

[원본 읽기 증거](2026-10-13-native119-readonly-proof.json):178개 전체 테이블 행digest 조회와 원 ACL290,259바이트 조회PASS. 전체 상태 수집은 실효 권한 단일 쿼리의5초 timeout(SQLSTATE57014)로 FAIL이다. 권한 범위를 줄이지 않는 역할별 분할 조회를 기존 복원 helper와 재배정된 회귀에서 구현·검토한다. 원본/운영 데이터 쓰기·dump·Storage39원본 복구·전체 복원은 아직 하지 않았다.

실제 Auth6 생성 연결의 독립 검토에서 응답 유실 POST의 늦은 반영, 같은 이메일의 다른 UUID 삭제, 원 범위 밖 추가 행 및 닫힌 제어 검사 공백을 확인했다. 원 생성 UUID·불확실 송신 기록·정확한 생성 행 범위·현재 닫힌 제어를 연결하도록 수정 중이며 성공으로 기록하지 않는다. 실제 계정 생성은 아직 하지 않았다.

역할별 첫 조회는 inventory 함수key24개 충돌을 거절해 FAIL로 보존했다. 실제 원인은 UNION 첫 분기의current_database()/nspname 출력이name 타입이어서 긴 format 함수 식별자를63바이트로 자르는 것이다. 읽기 진단에서 두 출력만text로 캐스팅했을 때 전체15,128개 항목은 유지되고 충돌0개, 최대 식별자1,624바이트·63바이트 초과732항목을 확인했다. 기존 함수query를 그대로 보존한다는 초기 제안 대신 이 두 명시적text 캐스트를 수정하고 긴 식별자 회귀를 추가한다. 손실된 식별자·부분 권한 결과는 성공으로 판정하지 않는다.

Auth6 생성 API의 최종 동결84ef9d63을 독립 검토 후 통합했다. 기존runner/SignedMidnightRunner AST는 보존했고 원래29+신규20개 signed/provisioning 회귀49개, AI24/자정준비/관찰기와 합쳐128개 root 통합 오프라인 회귀PASS(skip0). 한 번의 준비 intent·POST 재전송 금지·유실UNKNOWN·원 UUID 삭제 대조·7개 생성테이블만 허용·나머지전체행 정확일치·13개 제어값과cronoff를 검증한다. 실제 실행은 ports=None 고정 어댑터만 허용해 증거로 채택하며 주입 모형 포트의 계약 출력은 실제 성공으로 집계하지 않는다. 새 대상 생성과 최초 닫힌cron 설정은 API가 자동 변경하지 않고 별도 준비 영수증이 필요하다. 실제 Auth6 생성/AI22·23·24는 아직 NOT_RUN이다.

[공식 Auth v2.196.0 audit 모델](https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/models/audit_log_entry.go)과 [admin 구현](https://raw.githubusercontent.com/supabase/auth/v2.196.0/internal/api/admin.go)을 참고해 admin 생성audit는 새 사용자traits의 UUID/email, 로그인audit는 원사용자actor를 묶었다. 공식 코드만으로 현재 새 이미지의schema 호환성·실제 연결 성공을 판정하지 않는다.


최종 text-cast helper8c0a6b15 통합 후 기존25+분할5+긴 식별자1,31개 root 회귀PASS. 실제 exact원본에서 두 번 전체 읽기에 성공했고178table·31role·4sequence·484,096실효권한 항목이 동일했다. 기존 canonical snapshot과 일치하며 stateSHA5cb91cff88044b86375acacc9a9e1f37e939594225058527ffabaddd2d3606d2, 다른 접속0개다. 별도 query들의 반복 동일성 증거이며 단일 전체MVCC snapshot 또는 복원 증거가 아니다.

원본Auth users/sessions/profiles0과cronoff를 재확인하고 DB custom archive1,999,065바이트와 비밀번호 제외 역할archive5,760바이트를600 비공개 파일로 만들었다. DB ef04ad912992c51345d8488c718e5c6b26435bd8f06e87b0095370bc9a3b3dc6, 역할6b6f60e45032548fc909404e09453afcf65a65ad518afda680828bf3d5cb64b0. 최초 roles-only 비밀번호 해시 덤프는 자동 승인 검토가 비밀번호 출력 금지와 충돌할 수 있다는 이유로 거절해 실행되지 않았다. --no-role-passwords 대안은 승인·실행됐고 비밀번호/해시가 역할 자료에 없음을 확인했다. Storage바이트·역할인증자료·운영 전체 백업/복원 완료로 확대하지 않는다.

Auth 새 target의 준비 루트는 signed_private_read가 허용하는 /private/tmp로 새로 준비했다. 기존 시스템T 루트는 보존하고 실행에 쓰지 않는다. private700/600, SQL119·manifest cdcb79d855746c88cd1dc212f1f449da6368a872fef9e8f7bdd949563bccb5a5, 실제SQL/기동 NOT_RUN. CLI2.116의 exclude는 최초 schema migration 작업을 제외하지 않고 실패 때 자동정리할 수 있어 이를 그대로 실행하지 않았다. 검증된 합성 원본archive와 캐시4서비스를 직접 생성하는 대안을 준비·검토한다. 이미지 다운로드·CLI시작·새Auth 생성은 하지 않았다.

## 2026-10-13 원본 읽기 종료와 native119 연결 검토

전체 **79%(22/28)**를 유지한다. 합성 원본 전체 행 digest·catalog·portable 역할·raw ACL·실효 권한 484,096개·비시스템 sequence 4개를 반복 읽기했으며, archive 이후에도 동일함을 확인했다. 다른 접속 0개를 확인하고 재시작했던 원본 DB를 정상 중지해 원래 상태로 반환했다. 컨테이너와 데이터는 보존했다.

새 archive의 `pg_restore --create --list`에서 테이블 데이터 178개와 원 DB 소유자 postgres·COMMENT·ACL 메타데이터를 확인했다. 역할 archive는 비밀번호와 비밀번호 hash를 제외했다. 실제 Storage 바이트와 전체 복원은 아직 미검증이다.

native119 경로는 원 적용 영수증 119개와 현재 준비 SQL의 버전·hash, 고정 원본 증거를 대조한 뒤 실제 새 대상의 schema·역할·membership을 읽어 비교한다. 일반 Supabase 이력 검사는 유지한다. 독립 검토에서 추가 확정 결함은 발견하지 않았다. 실제 Auth와 자연 자정은 아직 실행하지 않았다. 통합 120개 중 1개는 HEAD 기반 원 함수 보존 검사가 승인된 source pin 확장을 허용하지 않아 실패했으며, 필요한 변경만 허용하도록 교정 중이다. 이 실패를 PASS로 집계하지 않는다.

보존 검사는 승인된 helper 두 경로 추가와 두 history 검사 교체만 허용하고, 임의 추가 경로·다른 메서드 변경은 계속 거절하도록 교정했다. 7898a83 원본 비교를 포함한 통합 **169개 PASS·실패 0·skip 0**를 확인했다(Auth 57·AI24 48·준비 13·관찰기 18·복원 준비 33). 이전 1개 실패 기록은 보존한다. 전체는 **79%(22/28)**로 실제 Auth·자정·Storage·실회원·운영 검증은 계속 구분한다.

## 2026-10-13 첫 실제 새 Auth 환경 생성 결과

169개 통합 PASS 소스를 사용자 승인 범위의 로컬 커밋 `141240a`로 고정했다. 푸시는 하지 않았다. 검토·동결 생성기 `4746bcfa`의 실제 첫 시도는 네트워크 create 단계에서 실패했다. 시작 메모리 1,082,732 KiB와 실행 중 첫 관찰 1,069,924 KiB는 기준을 충족했다. 새 컨테이너·Auth 회원 0개, 기존 container identity·lifecycle 동일을 확인했다. 네트워크 생성 결과는 `LOST_NETWORK_UNKNOWN`으로 보존하며 부재 조회만으로 해소하거나 같은 요청을 재전송하지 않는다.

읽기 진단으로 기존 network 114개와 VM route를 확인했다. 새 후보 `10.254.200.0/24`·`10.254.201.0/24`는 현재 network·route와 겹침 0개다. 기존 자원을 삭제하지 않고, 별도 새 network 이름과 새 실행 영수증을 사용한 후속 생성기에서 명시 subnet과 오류 증거 보존을 검토 중이다. 이전 UNKNOWN은 그대로 유지한다. 전체 **79%(22/28)**, 실제 signed Auth·자연 자정·전체 Storage 복원은 미검증이다.

## 2026-10-13 명시 subnet 후속 실제 결과

후속 생성기 `7dbf371c`에서 최신 IPAM·비기본 IPv4 route 충돌 0개와 실제 subnet readback을 확인해 새 network 두 개가 생성됐다. 새 DB 한 개는 생성 후 시작 직전 1,040,736 KiB로 1,048,576 KiB 기준에 미달했다. DB 시작·SQL·Auth 생성 전에 실패로 종료하고 이번 새 DB의 정상 중지·OOM 없음과 기존 컨테이너 동일을 확인했다. 새 DB·network를 삭제하지 않고 이전 a1 UNKNOWN도 보존한다.

추가 메모리 확보를 위해 다른 접속 0개인 과거 격리 DB 세 개의 정상 중지를 사용자에게 확인 요청했다. queue-tls99는 idle 접속 한 개가 있어 요청에서 제외했다. 승인 전 중지하지 않는다. 그동안 새 project `jonghyun-backend100-7e14bf02`와 a3 준비 폴더에 현재 SQL119를 복사했다(manifest `2b6190e6`); SQL·runtime 실행 0이다. 전체 **79%(22/28)**를 유지한다.

a3 상수 전용 후속 생성기 `ca2f10da`를 동결했다. a2 로직을 보존하고 새 prepared manifest·project·network·subnet·영수증 이름만 변경했으며, 관련 시험 5개와 준비 SQL119의 실제 바이트 검증이 통과했다. 새 준비 폴더 3개는 700, 파일 122개는 600으로 설정하고 manifest 바이트 동일을 확인했다. 실제 생성은 위 세 DB의 정상 중지 승인 후 새 메모리·identity·IPAM 확인을 통과한 경우에만 실행한다. 승인 대기 중 이전 DB를 중지하거나 실패한 환경을 재시작하지 않는다.

## 2026-10-13 공급사 실제 연결 확인

메모리 승인 대기 중 독립 외부 조건을 확인했다. 알려진 로컬 .env 한 개의 값 존재 여부만 읽어 KOPIS 키·Potens 키/URL 설정과 AI 보관 결정 값 없음이 확인됐다. 키·URL 원문은 출력하거나 Git에 넣지 않았다. 회원 원문 전송과 외부 모델 호출은 0이다.

[서울 공개 HTTPS 실제 시험](2026-10-13-seoul-https-public-tls-proof.md)에서는 인증서·호스트명 검증을 유지한 443 시도가 시간 초과, 8088 시도가 TLS WRONG_VERSION_NUMBER로 실패했다. GET은 0회이며 HTTP fallback·TLS 완화·우회 proxy를 적용하지 않았다. 현재 환경에서 API HTTPS 확인을 하지 못한 결과로만 판정하고 서울 전체 지원 부재로 확대하지 않는다. 수집 활성화와 운영 완료로 집계하지 않는다. 전체 **79%(22/28)**를 유지한다.

[KOPIS 요청 경계와 TLS 관측](2026-10-13-kopis-provider-read-gates.json): 공식 boxoffice API에 기존 키를 전달하는 GET 1회는 자동 승인 검토에서 정확한 사용자 승인 부족으로 실행 전에 거절됐다. 해당 실행기의 키 읽기·API 호출·응답 parser는 0/NOT_RUN이며 우회하지 않았다. 정확한 host/path와 단일 요청의 승인을 별도 질문으로 제시했다.

키 없는 공개 호스트 시험에서 Python 기본 신뢰 체인은 verify_code 19로 실패했다. 시스템 curl의 기본 SecureTransport에서는 curlrc를 금지한 공개 홈페이지 HEAD가 HTTP307·ssl_verify_result0·리다이렉트0으로 통과했다. 서로 다른 실행 방식의 관측으로 한정하며 공식 API 응답이나 최근 7일 집계 성공으로 확대하지 않는다. 승인 후 사용할 시스템 curl 단일 HTTPS GET과 현재 제품 parser 연결 코드를 비공개로 준비했으며 기본 실행은 NOT_RUN이다. 키는 stdin으로만 전달하고 로그·argv·Git에 저장하지 않으며 원문 회원 전송·모델 호출·활성화는 없다. 실행일이 바뀌면 자연 날짜와 코드를 재검토해 준비한다. 전체 **79%(22/28)**를 유지한다.

## 2026-10-13 Auth 거절 검증의 실제 범위 보존

전체 **79%(22/28)**를 유지한다. 기존 네 가지 거절 검증의 영수증이 실제 만료·세션 회수·익명·회원 변경·다른 인증 문맥의 NOT_RUN을 누락하던 문제를 수정했다. 네 가지 결과와 RPC·모델 호출 0, 다섯 미검증 항목을 엄격히 검사하고 영수증에 함께 보존한다. 독립 읽기 검토에서 확인한 외부 호출 횟수의 bool/float 허용도 정수 0만 허용하도록 교정했다. 관련 오프라인 회귀 **58개 PASS·실패 0·skip 0**이며 실제 Auth 수명주기 성공 증거는 아니다. 기존 AI22·23·24 동작은 보존했다.

[Auth 범위 증거](2026-10-13-auth-lifecycle-coverage.json)에 현재 소스 hash와 미실행 항목을 기록했다. 별도 신규 사용자·세션에서 원 발급 토큰의 자연 만료, 현재 세션만 로그아웃, 신규 자기 사용자만 상태 변경을 검증하는 실행 경로를 구현 중이다. 익명 및 다른 발급 문맥은 실제 발급 근거가 있는 입력을 요구한다. 원래 여섯 계정의 인증 문맥이나 Auth 설정을 임의 변경하지 않는다. 실제 자원 호출은 아직 0이다.

## 2026-10-13 다음 실제 실행의 소스 연결

전체 **79%(22/28)**다. root에서 현재 signed_source_pins의 57개 파일을 실제 Git HEAD `3a0a42a37ab7bc40bc25bd9cafc543329e58c649`와 바이트 단위로 대조했다. sourcePins SHA `9298b1cc846eaa74869134f0512e6cc9e97da0b12ae09938fadfe92d5751faf5`, 비공개 영수증 SHA `b265413f4fe7b38613ea14987f09ca858bbad7f1f70ab15db01300275e18bb0b`다. 자원·Auth·SQL 호출은 0이며 실제 실행 결과가 아니다.

a3 생성기는 특정 과거 HEAD나 runner hash를 상수로 갖지 않고, 실행 전 현재 커밋에 고정된 두 helper의 바이트를 확인해 HEAD를 캡처하며 마지막에도 같은 HEAD를 요구한다. 독립 읽기 검토에서 helper 바이트는 현재 커밋과 동일하다. 생성기 상수 변경은 필요 없지만 실제 Auth 입력과 AI24 입력은 당시 최종 검증된 소스에 새로 연결해야 하며 오래된 바인딩을 수정해 재사용하지 않는다. 수명주기 경로가 통합되면 새 source pins를 다시 만든다.

수명주기 후보의 실제 발급 증거 연결, 승인 객체와 원 private 입력 hash 대조, 신규 로그아웃 세션의 refresh token·MFA 종속 행 검증을 검토·보강 중이다. 후보의 존재나 오프라인 모형은 실제 만료·세션 회수 검증 완료로 집계하지 않는다.

## 2026-10-13 Auth 수명주기 실행 경로 통합

전체 **79%(22/28)**를 유지한다. 기존 책임 runner/factory/민규 회귀에 전용 Auth 수명주기 경로를 통합했다. 실제 실행은 고정 검토 객체, 정확한 private 입력·binding hash, root가 별도로 검토한 실제 GoTrue 발급 응답·영수증 hash를 요구한다. CLI는 검증과 NOT_RUN만 제공하며 승인 표시만으로 API 변경을 실행하지 않는다. 원 토큰 자연 만료·신규 세션만 로그아웃·신규 자기 사용자만 Auth ban을 검증하고 원 여섯 계정과 예산·UNKNOWN을 보존한다. 익명·다른 문맥 입력이 없으면 해당 항목은 NOT_RUN이다. 서비스 회원 탈퇴·동의 철회는 Auth ban 검증과 별도 미실행이다.

독립 검토에서 감사 행의 NULL 조건으로 비소유 행을 누락하는 결함을 발견했다. 소유 조건이 명확히 TRUE인 행만 제외하도록 수정하고 빈 필드·NULL·비소유 일곱 행과 정확한 소유 두 행 회귀를 추가했다. 이는 SQLite 모델의 SQL NULL 논리 증거이며 실제 PostgreSQL 연결 증거가 아니다. 최종 root **70개 PASS·실패 0·skip 0**, ResourceWarning 오류 모드와 cached Deno 검사도 통과했다. 수정 후 독립 읽기 검토에서 추가 확정 차단 결함은 발견하지 않았다.

[실행 경로와 남은 발급 조건](2026-10-13-auth-lifecycle-execution.md): 실제 Auth·DB·자원 호출은 아직 0이다. 기본 JWT3600의 early 만료용 실제 발급→영속 준비→late 신규 회수·ban·baseline6 발급 producer가 필요하다. 기존 globally-empty/exact6 API는 보존하며 early 계정이 있는 상태를 빈 Auth로 위장해 재사용하지 않는다. A3의 익명 설정은 변경하지 않았고 전체 진행 수를 올리지 않는다.

## 2026-10-13 외부 조건의 독립 재확인

전체 **79%(22/28)**다. [Potens 공개 근거](2026-10-10-supplier-official-evidence-review.md)를 다시 읽었지만 실제 API 보관·학습·삭제·공동계정·모델·상한 조건의 새 적용 근거는 확보하지 못했다. 키·회원 원문·모델 API 호출은 0이며 공급사 활성화 보류를 유지한다.

[서울 기본 시스템 TLS 후속 시험](2026-10-13-seoul-https-public-tls-proof.md): curlrc를 금지한 공개 호스트 HEAD 1회는 exit28/HTTP0/TLS app-connect0으로 5초 연결 한도에서 실패했다. 이 결과의 ssl_verify_result0을 TLS 성공으로 오인하지 않는다. sample GET은 0회이며 Python 실패와 별도 클라이언트 증거로 보존했다. 키·HTTP fallback·인증서 완화·재시도는 없다. 현재 환경의 시험 결과로만 판정하며 실제 행사 수집 완료로 올리지 않는다.

## 2026-10-13 실제 발급 준비/재개와 동의 core 통합

전체 **79%(22/28)**를 유지한다. staged producer를 기존 runner에 통합하고 root Auth 회귀 **98개 PASS·실패0·skip0**를 확인했다. 원 f66356b 함수·클래스·CLI와 기존70개 검사를 보존했다. 최초 발급→원 응답·영수증 고정→영속 재개→GET-only 만료창 확인을 구현했으며, profile/Auth/예산의 원 상태와 원 토큰·UUID·날짜를 유지한다. 실제 native119 확인은 첫 POST 전에 수행한다.

독립 검토 및 공식 Auth source에서 metadata/삭제 audit/observer 실패 직전 POST/입력 파일 경로/비정상 응답 UNKNOWN의 다섯 문제를 확인해 corrected v2로 교정했다. 초기 후보92개 PASS를 실제 호환성 완료로 확대하지 않았고 실패 후보를 보존했다. 최종 v2 독립 읽기 검토에서 해당 문제의 해결을 확인했다.

동의 core는 ready 정상 대조군 뒤 원 JWT 공개 철회1회와 consent-specific AI 거절을 검사하도록 구성했다. 전체 쓰기·정확한 readback 보강 후 private 모형18개 PASS이며 actual CLI는 항상 NOT_RUN이다. 비공개 외부 정리 어댑터 모형32개 PASS도 root에서 재확인했다. 전용 프로세스 종료·전용4개의 STOP 단일시도와 마지막 상태/설정검증 계약을 준비했으나 실제 launch ABI 연결은 닫혀 있다. 실제 Root caller·runtime captured source·추가3DB중지 승인·새 메모리 확인·실제Auth 생성/자연 만료/자정은 계속 남는다. [구체적인 연결 계약](2026-10-13-auth-lifecycle-execution.md)을 따른다.


## 2026-10-13 typed dispatch와 실제 소스 캡처 연결

전체 **79%(22/28)**다. `fed9581aa69ae85d9a5dad17c6c5a2ecb551329e`에 실제 호출 연결 후보3개를 로컬 고정했다. 원 producer binding/input을 보존하고 별도 approved 복사본·단일 durable intent로 기존 lifecycle kernel을 호출한다. Node의 제품 codeRoot와 factory 경로는 검토 객체가 지정한 private source tree로 연결하며 원 REPO는 버전·native 이력 검증에 유지한다. 원 토큰·원 발급 응답·baseline6·UNKNOWN을 바꾸지 않는다. partial 영수증은 정확한 필드·정수 횟수·원 토큰 hash·세션 복구 없음과 보존 성공을 요구하며 익명/다른 문맥/서비스 탈퇴/동의/공급사/자정/물리 복원을 NOT_RUN 또는 NOT_VERIFIED로 유지한다.

source 파일400·디렉터리500 읽기와 token/state600·private 부모700 읽기를 구분해 실제 캡처 tree의 모드 불일치를 수정했다. 동의 typed caller는 committed union91개와 factory1개를 복사하고 native import를 그 tree에서 수행한다. pre/post pin 검증은 OS 불변성이나 실제 DB 검증을 뜻하지 않는다. CLI 동의는 계속 NOT_RUN이다. 실제 C 회원 발급·원 세션/동의·headroom·전체 baseline·정리는 고정 root 조립이 별도로 제공해야 하며 아직 실제 실행하지 않았다.

root 통합 시험은 처음 소스가 기존 HEAD와 달라 Auth114개 중8오류·동의 모형27개 중7실패로 거절됐다. 당시 실제 호출0이고 영수증SHA `962e0bf097d4513af69f1d627560fcd0fa5a60513f038bddd3274f558862b9df`로 보존했다. 로컬 소스 고정 후 같은 시험을 약화 없이 재실행해 Auth114·관련61 **175개 PASS**, 동의 모형27개 PASS와 cached Deno PASS를 확인했다. 초기 두 연락처형 clientRequestId 거절은 기존 사용자1A 기준에 맞는 개인정보 거절로 원인을 확인했으며 정상 입력 성공이나 운영 탐지 품질로 확대하지 않는다. 제품 privacy/handler 변경은 없다.

현재57개 source freeze는 HEAD fed9581, mapSHA `93c8d4a642acb64b30f82df6f802653367e4d26773a3e19ecc5c5a0d8fc4ed82`, 영수증SHA `2e5dba98543f4c46424b2d5c01861666f07f6033df1da279fe3e20766ba04951`다. 올바른 private700/600 경로에서 원 HEAD 바이트와 대조했으며 자원/Auth/DB 호출0이다. HEAD가 바뀌면 실행 전에 새로 고정한다. private 단일 자식 coordinator는 자연 발급/대기/재개/dispatch/정리와 연속 메모리 감시를 연결해 검토 중이다. 익명·별도 문맥·서비스 탈퇴·자연 자정·실회원 HOLD·Storage39·공급사·운영 조건은 여전히 남는다. 푸시·운영 적용은 하지 않았다.


private coordinator v4를 root에서 재실행해 **59개 모형 PASS**를 확인했다. 기존32개 정리 모형과 새27개 조립 모형이며 actual0이다. 코드 ABI는 구현됐지만 새4개 ID/creator 성공 영수증·메모리 슬롯이 없어 실제 미배정 상태다. source 모드400/500과 private 입력600/700을 맞췄으며 준비 읽기부터 마지막 source/capsule 검사까지 감시 후 종료한다. 실제 자연3600초 경과와 exp-60 창의 SQL/Auth 지연은 검증하지 않았다. Root는 Node25.9.0 실행 파일의 단일 링크·권한·안정 FD·SHA를 읽기로 확인했고 영수증SHA `81a1cc619521227b93cdb8b484768259628d69fa41c42de5eab933e3af7fcafe`를 보존했다. 전체 **79%(22/28)**를 유지하며 peer 검토와 C 회원/준비 조립은 계속한다.

## 2026-10-13 실제 Auth 환경 연결

전체 **79%(22/28)**를 유지한다. 승인된 기존 격리3개 정상 중지 뒤 새 A9 환경을 실행했다. source `4e28789`의 ACL 복원·현재 Auth 이력 검증 보완을 적용해 원119 전체행/권한/sequence 복원과 현재 history 읽기가 통과했다. Auth와 REST의 DB TLSv1.3/256bit를 각각 실제 관측했다. Auth 사용자 발급·AI24 자연 자정·서비스 탈퇴 복구는 아직 완료로 집계하지 않는다. 세부 실제 성공/실패와 원 영수증 해시는 [Auth 실행 기록](2026-10-13-auth-lifecycle-execution.md), [검증 범위](2026-10-13-auth-lifecycle-coverage.json)에 기록했다. 새4대상에 동일 원 인증 문맥·탈퇴 ID/ACK 보존을 검증하는 기존 typed 실행 경로를 연결하고 있다. 운영 변경·푸시·실회원 HOLD 변경은 없다.


## 실제 C15 결과와 승인 대기 중 독립 작업 재개

전체79%(22/28). 현재 소스 기준은 `7a47bc41c4803f324327bd8cbaa746171312fa59`이며 최신 상세 증거는 [Auth 실행 기록](2026-10-13-auth-lifecycle-execution.md)과 [coverage](2026-10-13-auth-lifecycle-coverage.json)을 따른다. 회귀162개, 실제 native119 복원/TLS 및 C15 합성 회원 생성·로그인은 PASS다. AI 실행 직전 여유 메모리1,019,872KiB가 시작 기준1,048,576KiB보다 낮아 거절됐고 AI 요청/READY/철회는 NOT_RUN이다. 신규4개 정상 중지와 기존 inventory 보존은 확인했으며 전체 C 원 행 보존 최종 조건은 UNPROVEN이다.

추가 격리 DB 정상 중지 승인은 아직 대기 중이다. 이 승인 대기 때문에 독립 작업까지 중단하지 않는다. AI24에서 실제 서명 회원6명 중 검증할3명을 명시적으로 지정해 영속 계약에 연결하는 준비 helper를 기존 파일에 구현하며, 원 window·원 인증 문맥·UNKNOWN·메모리 기준·실제 실행 승인 경계는 유지한다. 기존 offline CLI의 임의 합성 ID 생성은 실제 signed 계정 선택의 근거로 사용하지 않는다. 실회원 HOLD·원 Storage39 바이트·공급사·운영 적용 조건은 유지한다.
