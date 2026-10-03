# 공고·최종 동의 생명주기 구현 인계 — 2026-10-02

민규의 “네이버 개발자 앱 등록하는 동안 다음 작업해” 요청으로 공고·매칭의 다음 단위를 구현했다. 작업자 `minkyu`, 작업 공간 `.worktrees/minkyu-foundation`, 브랜치 `minkyu/foundation-harness`, 기준 HEAD `58d1efc76b9d7e7b5b96aed7e47062f43652e06f`다. [이번 하네스](../../minkyu-matching-lifecycle-harness.json)의 coordinator/A/B/C는 지정 24개 파일만 나눠 수정하고 이전 변경 52개 SHA256을 보존한다. 수정 허용 파일 중 6개 파일의 시작 해시도 별도로 기록했다. 네이버·행사 허용 RPC와 기존 HTTP 경로를 유지했다.

## 구현 결과

- 기존 무료 공고 입력을 재사용해 모집 마감 생략 시 시작 시각으로 채운다. 수정은 전체 입력과 최신 `expectedUpdatedAt`을 받아 오래된 화면의 덮어쓰기를 거절한다. 최초 생성 재시도 원본은 보존한다.
- 수동 마감은 새 신청만 막는다. 기존 유효 신청의 동의 요청·수락은 시작 전까지 가능하다. 삭제는 일반 목록에서 숨기고 미확정 관계를 종료·알림·읽기 전용으로 바꾼다. 확정 이력이 있는 약속 종료 전 삭제는 현재 정책 문구에 따라 막는다. 취소 이력을 이유로 공고를 자동 삭제·재모집하지 않는다.
- 공고당 유효 동의 요청은 한 명이다. 여러 신청·대화는 유지한다. 동의 만료는 요청+24시간과 시작 시각 중 이른 때이며 서버 시각으로 검사한다. 철회·거절은 대상 조건 버전을 요구하고 신청 철회·거절과 구분한다. 재요청마다 새 조건 버전을 사용한다.
- 핵심 조건 변경은 알림과 동의 무효화를 같은 공고 잠금 아래 처리한다. 실제 확정 후 미선정 신청을 종료하고 해당 대화를 읽기 전용으로 보존한다. 확정·종료 재시도로 약속·알림을 중복 생성하지 않는다.
- 기존 철회 후 재신청은 새 신청·대화 생성, 과거 대화는 읽기 전용, 신청 거절 이력은 재신청 금지인 최신 SQL을 재사용했다. 초기 검토에서 최초 정의만 보고 재신청 구현 누락으로 판단한 후보는 후속 마이그레이션 확인으로 철회했다.
- 과거 미수락 consent를 일괄 변환하지 않는다. 새 생명주기 정보가 없으면 `renewal_required`이며 재요청 전에 수락할 수 없다. 기존 완료·수락 이력은 보존한다.
- 네이버 등록 세션·가입 자격·사진 검사를 새 활동과 수정에 적용한다. 기존 정보 누락 회원도 관계 조회·신청/동의 종료는 가능하다. 사용자 직접 테이블 쓰기와 구형 단독 확정/생성 RPC는 허용하지 않는다.
- 취소 상태에서 상세/RLS를 통한 상대 전체 이름·정확한 장소 추가 조회를 막았다. 작성자 자신의 공고 입력 열람은 유지한다.
- 내부 `expire_match_consents`를 service-role 전용으로 추가하고 기존 maintenance에 만료→후기 공개→요약 등록 순서로 연결했다. 모델 설정이 없어도 만료·공개를 수행한다. 새 알림 이벤트는 상태/버전만 포함하고 주소·실명·원문을 복제하지 않는다. 기존 알림 유일키를 유지하며 새 사건에만 같은 관계 알림을 다시 미확인으로 표시한다.

HTTP·오류는 [서비스 API](../../../../backend/contracts/service-api.md), RPC·상태·잠금·알림은 [핵심 DB](../../../../backend/contracts/core-service-db.md), 서비스 규칙은 [매칭](../../../../backend/contracts/matching.md)과 [공고 계약](../../../../backend/contracts/posts-search.md)을 따른다.

## 실제 검증과 재현

| 검증 | 실제 결과 |
|---|---|
| Node 단위 | 전체 142개 PASS, 신규 15개 포함. 기존 네이버·Auth·HTTP·검색·행사 검사를 유지 |
| Deno | service-api 및 signup 진입점, 실제 통합 스크립트 타입 검사 PASS |
| 기존 전용 로컬 DB | 매칭 10묶음 + 네이버 6묶음 + rollback PASS. 실제 authenticated/service_role·직접 권한 우회·시각·원자성 검사 |
| 독립 DB 세션 | 4경합 PASS: 두 상대 제안, 마감/새 신청, 수정/오래된 동의 수락, 두 공고의 같은 사용자 일정 겹침 확정. 이번 합성 자료 정리와 계정/프로필/예약/세션 0개 확인 |
| 실제 로컬 Auth 통합 | 194확인 PASS. 실제 Auth 로그인·PostgREST·SQL·HTTP handler, 공고 생성→여러 신청→동의 철회/거절→마감→수정/무효화→재요청/확정→미선정/정보 제한→철회 후 새 신청/대화→삭제 |
| 독립 읽기 리뷰 | 현재 범위의 중대한 문제 없음. 검사 실행 결과를 대신하지 않음 |
| 네이버·사진·화면·gateway | 네이버 응답과 사진 객체 메타데이터만 합성. 실제 네이버 인증·이미지 파일 업로드·브라우저·Edge gateway NOT_RUN |
| 원격·공유 | 원격 DB·운영 실행기·배포·커밋·푸시 NOT_RUN |

최초 경합 검사에서는 JWT 설정용 `SELECT set_config` 출력이 실제 RPC 결과보다 먼저 파싱돼 실패했다. 검증 도구를 `DO/PERFORM`으로 수정해 설정값을 출력하지 않도록 했다. 합성 자료 0개를 확인한 뒤 재실행해 4개 모두 통과했다. 서비스 SQL을 검사에 맞춰 우회하지 않았다.

```sh
node --test tests/functions/minkyu/*.test.ts
deno check --no-remote backend/supabase/functions/signup/index.ts backend/supabase/functions/service-api/index.ts tests/integration/minkyu/matching_lifecycle_local.ts
python3 -B tools/local/run_matching_database_tests.py --run --include-naver
python3 -B tests/integration/minkyu/matching_races.py --run
```

DB runner는 기존 민규 전용 `yumidang-minkyu-db`에 두 신규 SQL을 단일 트랜잭션으로 적용·검사·rollback한다. 미적용 상태·고정 컨테이너/소켓을 확인하며 원격 URL을 받지 않는다. 새로운 SQL을 Git 정식 이력에 몰래 포함하지 않는다.

경합·실제 Auth 검사는 별도 임시 `yumidang-minkyu-matching`(:55821)에 HEAD SQL 28개와 네이버/매칭 신규 SQL 2개를 명시 적용했다. 경합은 빈 Auth/프로필만 허용하고 이번 UUID만 정리한다. Auth 검사는 권한 0600의 CLI status JSON 경로를 `YUMIDANG_MATCHING_LOCAL_CONFIG`로 전달해 `node tests/integration/minkyu/matching_lifecycle_local.ts`로 실행한다. 키·토큰·회원 원문을 결과에 출력하지 않는다.

최종 하네스·소유권 검사에서 24개 허용 파일, 기존 52개 해시 보존, 예상 밖 변경 0개, 기준 브랜치/HEAD 일치, 다른 언어 혼입 없음과 `git diff --check`를 확인했다. 임시 프로젝트는 `stop --no-backup`으로 종료하고 합성 자료 볼륨을 정리했다. 임시 로컬 키 파일은 삭제했으며 Colima를 작업 전 종료 상태로 복원했다. 원래 민규 DB 볼륨과 이전 작업 파일은 보존했다.

## 후속 연결과 한계

네이버 앱 등록 후 실제 동의·콜백·브라우저 세션/사진 연결을 검증한다. 이번 native 통합은 함수 factory를 실제 Auth·DB에 연결한 검사이며 Edge gateway/CORS 배포 검사가 아니다.

정시 만료 알림을 위해 종현 담당 실행기가 내부 만료 RPC를 기한에 맞춰 호출해야 한다. API 자체는 만료 시각 이후 수락을 거절하고 조회·정상 후속 처리에서도 만료를 반영한다. 운영 호출·재시도·지연 관측을 정하지 않은 채 정시 실행 완료로 보고하지 않는다. 새 `consent` maintenance 반환과 `renewal_required`/종료 상태·알림 종류는 프론트·종현 담당이 자기 파일에서 확인한다. 외부 메시지는 보내지 않았다.

확정 후 일정 변경·취소 신규 API, 개인 확인 후 선제 후기·실제 완료/공개 시점·칭찬/횟수 반영, 연결 행사명 검색과 나이 숫자 범위, 나머지 R1~R7 연결, 운영 배포는 이번 범위 밖이다. 분쟁 판단·지원·보관·제재·당도 산식 등 팀 검토 항목은 임의 결정하지 않았다. 종현 소유 파일·기존 SQL·소유권/hook·작업자/Git 설정은 변경하지 않았다.
