# 민규 실행 계획 전체 완료 기록 — 2026-10-18

원계획1~4의 실행·준비 작업을 마쳤다. 전체 프로젝트 진행률은 **79%(22/28)**로 유지한다. 실제 운영 완료와 이번 계획 범위 완료를 구분한다.

## WBS별 결과

|WBS/계획|변경|실제 검증 범위|완료 증거|남은 조건·다음 작업|
|---|---|---|---|---|
|4.2 최신 코드·공백 감사|현재 source774개와 제어파일을 고정. SQL121/함수187/테스트412/tools28/contracts26|실제 실행·정리 후774 SHA와 HEAD 동일. 제품 함수187개는 이전과 동일|[소스 manifest](2026-10-18-source-manifest.json), `source-after-actual-auth` 영수증|과거119 PASS와 현재121을 구분. 최초 미추적 파일의 과거 byte 비교는 미확보이며 소급 주장하지 않음|
|7.11 격리 도구 정식화|기존 runner/Auth 검증 보완과 익명·다른 문맥 전용 typed 도구. 고정 ID·소스·경로·권한·기존 자원 검사 유지|기존 자원 변경 거절, OS/private tmp 경계, FIFO·링크·권한·파일/부모 교체 거절, Auth MFA 포함 정확 추가행, 판정 전 전후 증거, 실패 후 고정 신규 ID 정리 회귀|기존472·신규 복원25·인증31·기존 준비16의 원출력, [실제 증거 목록](2026-10-18-runtime-evidence.json)|검사 우회 옵션 없음. 공개 제품 API·종현 FE/앱 변경 없음|
|5.5 로컬 Auth·AI22/23|새 두 문맥에서 원 Auth6와 익명1 발급, 원 토큰으로 실제 제품 factory 거절 검증 추가|익명 Auth200→제품401, 다른 문맥 원 Auth200→대상 Auth403→제품401. 각 실제 Auth조회1/RPC0/provider0/외부0. 양178개 table bag·권한·제약·catalog·예약 보존|새 case/phase/정리 영수증66개와 독립317대조 PASS. 기존 정상 인증·원3600초 자연 만료·회수·Auth ban·합성 AI22/23 영수증은 보존|실회원·실제 네이버·공급사 호출은 보류. 기존 좁은 case 영수증을 전체 typed lifecycle 실행으로 바꾸지 않음|
|AI24 준비|현재 소스의 긍정 계획/영속계약 및 변경 거절과 원6세션·선택3·원JWT SHA·날짜·UNKNOWN·정리 연결|공통 준비 helper 변경 뒤57+33 비실행 회귀 재통과. 실제 자정·실제 fixture 실행은 하지 않음|`/private/tmp/yumidang-ai24-final-dependency-20261018/receipt.json`, SHA `811ad954fe7d811eb6bded278b81130a56a6feae087f6f3c5525c6fa8ea0ceb0`|OFFLINE_PREPARATION_DONE / LIVE_NOT_READY. 실제 실행 승인 후 새6세션·선택3·현재 source/날짜·만료/준비 시간창·단일 의도·UNKNOWN·정리를 다시 검사|
|7.14 복원 준비|최신121 reviewed/artifact와 role·권한·sequence·확정 삭제 재적용·UNKNOWN의 소스 계약/입력 상태 대조 도구|source16·SQL121·원영수증42 연결 및 신규25회귀 PASS. 실제 복원·운영 적용 미실행|`/private/tmp/yumidang-restoration-applied-20261018/receipt.json`, SHA `409f0857d6a933e08b594fcc43fdfc725202ce139902b1e75bdbc191eb55449e`|역사18원자료 현재 부재는 HISTORICAL_PINNED_NOT_REVALIDATED. Storage45 metadata/역사 매칭6/누락39를 유지하며 전체 복원 완료로 표시하지 않음|

## 실제 실행과 보존

전용 clone은 `/private/tmp/yumidang-minkyu-wbs-20261017`, 브랜치는 `minkyu/wbs-backend-20261017`, actor는 `minkyu`, hook은 `.githooks`다. 실제 검증 소스 HEAD는 `9676cb85736435d742e91283d1c30cff1bd8e609`다. 파일별 단독 수정과 편집 전/스테이징 후 소유권 검사를 통과했다.

새 합성 문맥 두 개에서 생성한 컨테이너는 정확히8개다. create/issue/dispatch/close가 모두 PASS이며 own8을 Exit0·OOMfalse로 정상 중지했고 남은 실행 ID는 없다. 새 network2·volume2와 원 Auth/DB 증거는 보존했다. 기존415개 컨테이너 기록·158개 custom network·57개 volume의 메타데이터는 같고 기존 자원은 중지하지 않았다. 기존 DB/Storage 전체 실제 byte 비교는 수행하지 않았다.

실행 전 대상 daemon과 시작 여유1048576KiB를3초 이내 확인했다. 시작 여유는2433148KiB, create 최소1959116KiB·issue 최소1904324KiB·dispatch 최소1918000KiB로 유지 기준786432KiB 이상이다. 기준·원 JWT 수명3600초·시계를 낮추거나 조작하지 않았다.

원본 clone은 `backend-work`/`b164021323975c241d7a73145bdd66d9c3e6f097`이며 읽기만 했다. 최종 읽기 확인은 추적 변경0·미추적 파일132개다. 최초 미추적 파일별 byte 사전표가 없다는 검증 한계는 그대로 남긴다.

## 검증과 실패 기록

서로 다른 회귀는544개다: 기존472, 복원25, 새 인증31, 기존 준비16. 공통 helper 변경 후 기존 signed Auth176 및 AI24/midnight90도 다시 통과했으며 중복 실행을544에 더하지 않았다. 각 단계의 source pin·exit·원 stdout/stderr SHA를 별도로 보존했고 실제 DB/HTTP 검증과 합산하지 않는다.

최초 소스 캡슐 준비는 OS 임시경로와 기존 source reader의 `/private/tmp` 경계 충돌로 거절됐다. 이때 Auth·Docker 변경·phase 시도는0이다. 실패 기록과 옛 descriptor/봉인 파일을 보존하고, 같은 승인3파일 범위에서 명시 typed capsule 경로를 분리했다. 기존 helper나 TMPDIR 검사를 완화하지 않았으며 실제51파일 회귀와 독립 검토 후 새 root로 실행했다. 이전 R1/R2/R3 실패 및 NO_REPLAY 자료도 [기존 원영수증 목록](2026-10-17-runtime-evidence.json) 그대로 유지한다.

독립 감사는 생성426대조, 발급116대조, 최종 거절·정리317대조에서 실패0이다. 실제7세션의 원 TTL3600초, 익명 소유4행과 정식 Auth6 소유54행, 원 JWT·세션·전체 행 bag·예약0·child group 정리까지 연결했다. 원 JWT/refresh/credentials는 private600/700 자료에만 있으며 공개 문서는 경로와 SHA만 담는다.

## 커밋·보류 경계

사용자가 승인한 새3파일만 로컬 커밋했다: `794648f`, 같은 범위의 캡슐 보완 `9676cb8`. 앞서 승인한5파일의 기존 로컬 커밋은 보존했고, 나머지 미커밋 source7개와 실행 문서는 자동 커밋하지 않았다. 푸시·원본 작업 폴더 변경·운영 DB 쓰기·배포·추가 결제·외부 메시지는 하지 않았다.

실회원 HOLD·공급사 조건/회신·회원 원문 외부 전송·운영 승인·Storage 원본39개 확보는 원계획의 별도 조건이다. AI24는 준비까지만 완료했다. 이 보류를 전체 프로젝트 완료 수에서 빼거나 준비·합성 검증을 실제 운영 완료로 올리지 않는다.
