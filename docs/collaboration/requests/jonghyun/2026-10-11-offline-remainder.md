# 종현 — 전용 VM 중지와 독립 오프라인 잔여 작업

전체 진행률은 **79%(22/28)** 유지. 이 기록은 운영·실회원·자정·실기기 완료가 아니다. 기준은 [최신 인계](../minkyu/2026-10-10-jonghyun-backend100-handoff.md), [소유권](../../../../backend/ownership.json), [현재 정책](../../../../정책.md)이다. 잠정 WBS 참고를 소유권 변경이나 운영 승인으로 사용하지 않는다.

## 승인과 실제 중지

사용자가 “중지 ㄱㄱ”, 이어 기존 승인 범위의 가능한 작업을 진행하고 마지막 커밋/푸시를 요청했다. `jonghyun-backend100`만 정상 `colima stop --profile jonghyun-backend100`했다. 2026-10-11 03:45 KST의 host agent·VZ 종료와 `not running` 상태,61621/61622/61624 리스너0을 확인했다. 다른 VM/컨테이너·네트워크 설정은 변경하지 않았다. 재시작·예약·전원 설정은 하지 않았다.

CPU2·RAM4GiB·disk20GiB 설정 유지. 전용 VM의20GiB `disk`와20GiB `datadisk` 파일 존재를 내용 읽기 없이 확인했다. 정상 중지는 DB/컨테이너 볼륨 삭제가 아니며, 실제 DB 재조회는 중지 이후 하지 않았다. 중지 직전 외부AI/invocation/runtime guard CLOSED·cron OFF·본 작업 시험 프로세스0·다른 활성 DB 세션0이었다.

기존 PASS/FAIL 영수증·공개 로그·manifest37개는 clone 밖 비공개 `yumidang-private-evidence/checkpoint-3ed3ee6-20261011/`에0600 파일·0700 폴더로 보존했고 원본·사본 SHA256 전부 일치했다. 별도 보존 manifest1개가 있다. 인증 파일·시작 원로그·factory transport fixture는 복사/출력/Git에 넣지 않았다. 원본 임시 자료는 삭제하지 않았다.

## 현재 가능한 작업과 실제 선택

| 항목 | 현재 근거와 결과 | 실제 완료와 구분 |
|---|---|---|
| AI24 준비 코드 | 신규 `prepare_isolated_midnight.py`의 오프라인 증거·소스·scope·시간창·baseline/정리 계획 검증, 회귀12개 | 실제 준비 DB/자정/실행기는 NOT_RUN/미구현 |
| 웹 세션·서비스 | 현재 `src/app/_layout.tsx`가 설정 포트를 구독하며 웹 adapter 설치/restore 연결 존재. 종현 서비스 소비 전체 단위 회귀 | 검토된 배포 설정 공급·실제 로그인은 미검증 |
| 네이티브 세션 | 공통 서비스/DTO·세션 포트 존재. 브라우저 Origin 계약을 native에서 위장하지 않음 | native 발급 앱ID·callback/백엔드 인증 계약 미제공, adapter 임의 생성 안함 |
| Android/iOS 정적 준비 | 현재 lockfile 그대로 설치, 타입/lint·웹/Android/iOS Hermes 번들 export | 설치 APK·서명·실기기·네이버 복귀가 아님 |
| 운영 입력 검증 | 기존 운영·catalog·migration·권한 준비 회귀 재검증 | 실제 원본 catalog/백업·Storage 바이트·접근 인계 대체 안함 |
| 공급사 확인 자료 | 아래 인계 입력 목록 정리 | 외부 문의·조건 확정·원문 전송·활성화 안함 |

이미 구현된 웹 연결·기존 native 예시/codec/export를 중복 기능으로 만들지 않았다. `apps/mobile/src/remote.tsx`는 중복 import 두 쌍만 합쳤다. UI·라우팅·화면은 성호 경로라 수정하지 않았다. Android SDK 디렉터리와 Java는 있지만 adb PATH 및 현재 생성된 android/ios 폴더는 없다. `app.json`에 제품 Android applicationId/iOS bundleIdentifier가 없으므로 예시 등록값이나 임의 ID로 제품 APK·인증 계약을 만들지 않았다.

## AI24 오프라인 계획의 경계

제품 AI graph·원 AI24 Python/TS 하네스·현재 준비 helper·자신의 코드까지 HEAD58파일 SHA256을 고정한다. 현재 private preserved public AI22/23 PASS 영수증과 공개 로그 해시·daily[3,20,3]·계정3,200,000/전체12,800,000·UNKNOWN 유지 단언을 검증한다. credential·원 채팅·raw startup·factory fixture는 열지 않는다. 기존 공개 영수증은 runner SHA만 직접 결합하므로 현재 제품 graph 전체 일치와 실제 DB target 연결은 `NOT_VERIFIED`/`MANIFEST_ONLY_LIVE_NOT_OBSERVED`로 명시한다.

현재 합성 AI22 회원은 정리됐으므로 기존 signed Auth/원 회원 세션을 현재 환경에 있다고 가정하지 않는다. 신규3회원·ledger는 **intent만** 생성하고 DB에 쓰지 않는다. 실제 재개 때는 새 owned AI22 baseline·creation receipts·prepared binding이 필요하다. 기존 signed Auth/PostgREST AI24 전체 성공으로 synthetic bridge 결과를 확대하지 않는다.

기존 자연 window는 그대로다: 최초 준비20~60분 전, fixture10~60분 전/완료 최소5분 전, resume5초 초과~120초 이하 전, 최종 idle3초 초과~60초 이하 전, 실제 경계 직전2.2초 미만·직후2초 미만, observer hold2.5초/provider hold2.8초. 오프라인 시간 계산 시험은 실제 자정 PASS가 아니다.

신규 ledger는 계정/global **공유 KST 일일 예산을 초기화하지 않는다**. 현재 AI23 full-cap day·UNKNOWN2건을 유지한다. 실제 자연 day와 headroom을 새로 관측해야 하며, cap 확대·UNKNOWN 삭제·환불·시각 변경으로 통과시키지 않는다. 계획의 baseline은 전체 auth/public/private/storage를 포함하고 보호5테이블 기존 원행 해시와 새 owned receipts의 자연 old/new day delta를 별도로 대조하도록 요구한다. 과거 모든 예산5테이블을 일괄 digest 제외한 결과를 새 full-row 복원으로 부르지 않는다. 정리는 creation receipt가 있는 exact IDs와 네이버 identity 없는 합성 episode만 대상으로 하고 보호90일 예산은 유지한다.

실제 출력은 `PREPARED_OFFLINE`, `executionAllowed=false`, `actualMidnight=NOT_RUN`, live DB/resource/clock/headroom은 미관측이다. 검토 묶음만 준비하며 VM/DB/모델 호출·타이머·예약 능력은 없다. 전용 AI24 실행기와 영속 live baseline/cleanup binding은 현재 미구현이며 재시작 승인·실제 경계 실행 전 별도 검토가 필요하다. 안전한 runtime 입력·승인 없이 원 민규 실행기를 그대로 호출하지 않는다.

## 최종 로컬 검증

- Node 함수·AI 전체146파일 **1,530/1,530 PASS**, fail0·skip0. 최초 실행의10FAIL은 보존한다. `20261008-followup-runner` fixture가 최신 `readSlots` 필수 포트·unique job 슬롯·provider별 독립 maintenance limit와 달랐다. DB 슬롯 fixture를 추가하고 claimed1/attachment3→queue unit1, provider limit[4,4]로 맞췄다. UNKNOWN·lease 미해제·취소·timer·시간 제한 단언은 유지했다. 제품 보호/권한은 변경하지 않았다.
- Python isolated 준비/observer/SQL runner/새 AI24 오프라인 **30/30 PASS**. 이 중 새12개는 증거 변조·실패 observer·잘못된 daily count·symlink/hardlink/mode·경로 traversal·미관측 readiness·KST/strict cutoff 거절 검사다.
- 기존 민규 Python 준비/권한/catalog/운영 입력 전체 **231/231 PASS**(460.957초). isolated30개와 서로 다른 검사이므로 Python 전체는261개다. 실제 원본 운영 환경은 실행하지 않았다.
- Deno ai-chat/review-summary-worker/service-api **타입3개 PASS**.
- 모바일 `npm run typecheck` **PASS**, `npm run lint -- --no-cache` **PASS/0error·0warning**. 처음 lint4 warning은 종현 import 중복만 정리했다.
- 현재 웹·Android/iOS clear export **PASS**. 네이티브 산출물은 Hermes `.hbc` 두 개이며 기기 설치·Auth/네이버·APK 서명은 NOT_RUN.
- 초기 native export는 샌드박스의 `.expo` 폴더 쓰기 EPERM으로 FAIL이었다. 승인된 작업 경로의 일반 권한으로 재실행해 PASS했으며 제품 코드를 완화하지 않았다.
- 독립 하네스 읽기 검토2명은 window/보호 예산/범위와 fixture 변경을 확인했다. 공개 영수증의 제품graph/DB 바인딩 미확인 표시 보완을 반영했다.

오프라인 구현 commit은 `2c88186`이다. 실제 계획 source pin SHA256은 `11b6eb7f547558aeced4095d709623cbe4886957c8f6f1cb3b6874ef9309d23c`이다. 계획·회귀/빌드 공개 로그·bundle metadata11개는 `yumidang-private-evidence/offline-2c88186-20261011/`에 비공개 보존하며 사본 해시 일치, 별도 manifest1개다. 웹/native 번들 전체는 현재 `/tmp/backend100-current-web`·`/tmp/backend100-current-native`에 있다. 비공개 자료는 Git에 추적/업로드하지 않는다.

## 후속 담당자가 제공해야 할 기존 인계 입력

| 범위 | 필요한 입력/근거 | 현재 처리 |
|---|---|---|
| 운영 원본 | 민규·운영 원본 위치/담당, 승인 접근 범위, 현재 catalog/history·역할·실제 Storage 바이트 inventory/일관 백업·복원 영수증 | 가상·새 빈 DB로 대체하지 않음, 운영 입력 검증기 재사용 |
| 웹 | 검토된 HTTPS signup/supabase URL, 공개 anon/publishable key 전달 방식, 같은 웹 origin의 `/auth-callback`, SQL 메시지읽음·탈퇴 영수증 배포 계약 | 값 추정·credentials 발급·UI 수정 없이 현재 포트 유지 |
| native/Android | 발급 제품 앱ID·백엔드가 승인한 native callback/세션 계약·빌드/서명 담당·실기기 | 브라우저 Origin 위장·예시 ID 재사용·서명키 생성 안함 |
| Potens/두AI | 공식 조건의 보관/학습/삭제/학습거부·공동계정·region/subprocessor, model/output상한·usage/account별 비용/일일한도, 법적 동의/철회·회원 전송 승인 | 원문 전송/활성화 guard CLOSED, 미정 숫자 임의 확정 안함 |
| 서울/KOPIS | 검토된 서울 HTTPS endpoint·KOPIS 전국전체 Top10/뮤지컬 전환의 어제까지7일 공식 API 계약·갱신/호출 권한 | 기존 adapter·합성 검사 유지, 공급사 사실확인 미완료 |
| 운영/support | 승인된 지원 이메일·앱 밖 탈퇴 안내·배포/예약/중지복구 책임·비용/보관 증거 | 운영 쓰기/배포/외부 메시지 없음 |
| 실제 회원/자정 | 두 네이버 계정 검증 HOLD 재개, AI24 전용VM 재시작/경계 실행/지속 연결 승인 | 기존 HOLD/중지 유지, 예약·전원 설정 없음 |

위 내용은 기존 미제공 입력/보류의 정리이며 사용자를 원본자료 보유자로 단정하지 않는다. 기존 팀 검토 숫자·정책을 재질문하거나 확정하지 않았다. 신규 제품 결정을 임의 생성하지 않았고 독립 작업은 해당 입력 없이 가능한 범위까지 마쳤다. 최종 정상 push·원격 SHA·CI와 전체 Python 결과는 이어 기록한다.


## 마지막 점검과 다음 실행의 확인

최종 소스에서 native clear export도 다시 PASS했다. 중지 VM/세 포트/본 작업 시험·빌드 프로세스 종료를04:00 KST에 재확인했다. 현재 소유권5경로·공백·비밀 패턴/다른 언어 혼입 검사에서 차단사항이 없었다. 새 credentials·VM 재시작·실회원·외부 모델·운영·UI 변경은 없었다. 본 작업 내 가능한 명확한 독립 수정·로컬 검증을 마쳤으며 새 정책 숫자는 확정하지 않았다.

다음 AI24 실행에는 한 가지 실제 계약 차이를 먼저 확인해야 한다. 현재 AI22 합성회원은 정리돼 있고 새 검증은 synthetic Auth bridge였다. 원 AI24는 원 회원·원 signed JWT/실제 Auth 계약을 요구하므로 같은 성공 범위라고 임의 처리하지 않는다. 다음 중 선택을 확인하기 전 live 준비/실행은 하지 않는다.

1. **추천:** 기존 AI24 전체 계약(실제 로컬 Auth 포함)을 유지하고, 새 합성 baseline/계정·VM 재시작·실제 경계 실행을 별도 승인한 뒤 진행.
2. 먼저 synthetic bridge의 실제 SQL/제품HTTP 자정 경계만 별도 범위로 검증하고, 원 signed Auth AI24는 NOT_RUN 유지.
3. AI24는 보류하고 운영 원본·native/웹 승인 계약의 담당 인계를 먼저 처리.
4. 기타: 원하는 검증 범위/담당/시점을 지정.

이 선택은 현재 보류의 해제나 credentials 생성 승인으로 자동 적용하지 않는다. 운영 원본·native 등록값·배포 설정·공급사 조건은 기존 팀/운영 인계 입력이며 사용자에게 원본 보유 책임을 다시 배정하지 않는다.
