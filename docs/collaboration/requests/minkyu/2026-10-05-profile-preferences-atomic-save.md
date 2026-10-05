# 성향·한줄 소개 원자 저장 구현과 검증

작업자 minkyu, 2026-10-05. IA·USER_FLOW의 S15-2는 관심사·대화 방식·MBTI·한줄 소개를 같은 저장 버튼으로 반영한다. 기존 서버에는 성향 API만 있고 소개글 저장 경로가 없어 POST `/me/preferences`를 기존 계약·profile service/repository·routes·사용자 RPC 허용 목록에 추가했다. 종현 모바일은 수정하지 않았다.

## 현재 구현

본문은 정확 `{interests,conversationStyles,mbti,bio}`다. 기존 성향 검증을 재사용하고 `bio`는 null 또는 기존 DB 기준 300 Unicode 문자 이하 문자열을 허용한다. 빈 문자열·공백·개행을 임의 정규화하지 않는다. 본인 ID는 DB의 auth.uid()에서 결정한다. 새 `set_my_profile_preferences(text[],text[],text,text)`는 account SHARE→profile UPDATE→기존 공통 회원 관리 guard의 episode SHARE 순서로 잠금을 확보하고 성향 저장과 소개 UPDATE를 같은 트랜잭션에서 수행한다. 신규 활동 자격 guard를 본인 관리에 추가하지 않는다.

새 RPC는 기존 성향 RPC 소유자를 유지하며 빈 search_path·SECURITY DEFINER다. authenticated만 EXECUTE 가능하고 public/anon/service_role는 폐쇄한다. profiles.bio의 일반 회원 직접 UPDATE 권한만 회수해 공통 회원 관리·탈퇴 잠금 경계를 우회하지 못하게 한다. 기존 사진·성향3키 API와 다른 프로필 열은 변경하지 않는다. 조회는 기존 /me의 bio 및 /me/traits다.

## 실제 검증 범위

- main HTTP 회귀 32/32 및 가입·서비스 Deno 타입 검사 PASS다. 네 인자와 사용자 클라이언트 매핑, null/empty/공백·개행/300 Unicode 보존,301·추가키·타입·잘못된 성향 거절, 미인증 및 오류 원문 비노출을 검사했다. DB 포트는 주입했으므로 실제 REST 증거가 아니다.
- native60 격리 DB에40500과 합성 SQL 회귀를 하나의 owner 트랜잭션으로 실행한 뒤 전체 rollback해 PASS했다. 영수증: `/private/tmp/yumidang-preferences-sql-w_in7tzk/receipt.json`. 300/301 Unicode, null/empty, 기존 값 보존, 본인/타인 값 분리, 직접 bio UPDATE 차단, 자격 누락 회원의 기존 관리 허용, 탈퇴 이후 거절, 역할 권한·소유자·search_path를 확인했다.
- 성향 저장 이후 소개 UPDATE에서 실패하는 전용 임시 trigger를 합성 회원에 한정해 주입했다.23514 실패 후 이전 성향·소개를 유지해 실제 전체 rollback을 확인했다. 이 trigger는 제품 migration에 없으며 검증 트랜잭션과 함께 제거됐다.
- 실제 탈퇴 SQL을 검사하기 위해 검증 TX 안에서만 cleanup guard와 service_role의5개 cleanup RPC 권한을 준비했다. Provider를 호출하지 않았다. 최종 함수 정의/권한·프로필 열 ACL·이력60·guard false·Auth/Storage/앱 자료0·전역 점유 해제 등의 baseline이 정확히 복원됐다.

새 migration은 영속 native60 또는 운영 DB에 적용하지 않았다. 실제 REST/hosted HTTP·모바일 저장 전체 흐름·탈퇴와 저장의 실제 두 세션 경합은 NOT_RUN이다. 준비 도구의 검토 집합도 새62개 소스 기준으로 동기화하고 적용 후보 artifact를 검토해야 한다. 현재 전체 달성률55%는 유지한다.

## 최신 전체 회귀와 검토62개 준비

main 최신 민규 함수 전체370/370 PASS다. 로그는 `/private/tmp/yumidang-functions-preferences-tpvrdov9.log`다. 검토62개 준비 도구를 반영했으며 HEAD28/41/정확60/정확61/62만 인정하고 unknown·부분 집합·과거 SQL 해시 변경 거절과 strict41 도구는 유지한다.

root가 실제 main으로 생성한 준비 manifest는 `/private/tmp/yumidang-policy62-reviewed-omlrmcgb/prepared/migration-manifest.json`, SHA256 `abbfcac0065c6be95aaec61df99876f3d527fe4675d1e14802b31c719696feb3`다. 현재 HEAD41+pending21=62이며 SQL/Edge는 NOT_RUN이다. native60에서 필요한 미적용 SQL은40300과40500 두 개다. 준비 artifact 생성과 native62 실제 이력·REST/hosted 검증은 같은 결과로 표시하지 않는다.

## 후속 native62 적용과 실제 연결

위 미적용 문구는 최초 검증 시점이다. 이후 격리 로컬 DRIFT DB의 exact60 이력과62 manifest/source SHA를 대조하고 실제 CLI dry-run의 대기 목록이40300→40500 두 개임을 확인했다. `--db-url`의 대상은127.0.0.1:56532에 고정하고 `--skip-vault`로 config의 비밀 설정을 반영하지 않았다. 운영 DB·기존 네이버 실로그인 환경·외부 공급사는 변경하지 않았다. 실제 두 migration을 한 번 적용했고 최종 이력62·대기0·기존 역할/함수 소유자/정의·guard false·전역 점유 해제·자료/파일0·컨테이너 ID/시작 시각/재시작 횟수 보존을 확인했다.

적용 영수증은 `/private/tmp/yumidang-native62-rollout-liv4jo_y/application-receipt.json`이다.40300은 queue NOLOGIN 역할의3개 EXECUTE를 추가하며 기존 service_role acquire/release 실행권한을 회수하지 않는다. 따라서 common9 RPC×3역할은 기존2true·25false가 맞다. 신규 preferences는 authenticated만 실행 가능하고 직접 bio UPDATE는 차단된다. 처음 후보의27false 기대는 소스 검토에서 교정했으며 그 후보로 실행하지 않았다.

실제 Auth·REST·Storage 연결11그룹 PASS 및 합성 자료 정리 PASS: `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-naver-native62-Ujys6s/result.json`. 검사 파일 SHA는 `5b68c5b74baabed3d6dfeb9e0844aeee83ca5d5f7111fc686577d149f4f3189e`이며 기존 native60·기본 실행을 유지한다. 새 그룹은 null/빈 문자열/300 Unicode와 공백 보존 저장 후 /me.bio·/me/traits 재조회,301/잘못된 MBTI/추가 사용자 ID400 후 이전 DB 값 유지, 직접 REST profiles.bio PATCH403/42501, 명시 재시도를 검사했다. 기존 가입/사진/자격 변경10그룹도 통과했다. 최신 함수 handler는 프로세스 내부 실행이고 네이버 응답은 합성이므로 실제 OAuth·hosted Edge·모바일 증거는 아니다. stale 탈퇴 JWT 및 화면 입력 보존은 이 실행에서 NOT_ASSERTED다.

현재62 DB에서 queue 역할 및 preferences SQL 회귀를 각각 owner 트랜잭션으로 실행하고 rollback해 baseline 복원을 확인했다. 영수증: `/private/tmp/yumidang-native62-rollout-liv4jo_y/sql-regression-receipt.json`. 역할 SQL의 SESSION AUTHORIZATION은 실제 LOGIN 계정 접속 증거가 아니다. 별도의 전용 LOGIN/TLS 증거와 구분한다. 준비 도구 main20개와 gateway16개 회귀도 PASS다.

관측 실패도 보존했다. 첫 dry-run 관측은 CLI의 JSON·사람용 목록을 중복 집계해 실패했으며 DB 실행0이었다. 최초 적용 후 비교는 예상된 queue3EXEC 추가를 기존 ACL 불변으로 오인했다. 실제 이력62 및 정확 세 ACL 변화가 확인돼 비교만 교정했고 migration을 재실행하지 않았다. `dry-run-first-observation.log`·`first-observation-receipt.json`·`postflight-first-observation.json`을 같은 artifact에 유지했다.

남은 범위는 hosted/모바일·운영 연결, 저장과 탈퇴의 실제 두 세션 경합이다. 실제 로컬 핵심 검증이 늘었지만 전체15개 영역의 남은 요구가 있어 달성률55%를 유지한다.

## 후속 실제 두 세션 저장/탈퇴 경합

기존 native62에서 합성 SQL 회원으로 실제 세 사례가 PASS했다: 저장 COMMIT 후 대기한 탈퇴 COMMIT, 탈퇴 COMMIT 후 대기한 저장42501, 탈퇴 ROLLBACK 후 대기한 저장 정상 COMMIT. 실제 `pg_blocking_pids`로 기다리는 관계를 관찰한 뒤 holder를 해제했으며 단순 지연 시간으로 성공을 추정하지 않았다. 만료·교착·프로세스 타임아웃을 정상 결과로 흡수하지 않는다.

탈퇴 세션의 동일 TX 안에서만 guard true·cleanup5 EXECUTE를 준비하고 실제 retire RPC 후 원래 guard false·폐쇄 ACL로 돌린 뒤 COMMIT했다. 다른 세션에서 보는 catalog baseline은 계속 폐쇄였다. 저장 선행 때 최종 소개 null·성향0·회차 종료, 탈퇴 선행 때 새 저장42501·PII 재생성0, 탈퇴 롤백 때 소개/성향 저장·활성 회차 유지·탈퇴/작업0을 확인했다. 실제 Provider 삭제나 Auth JWT 검증을 수행한 경합 증거는 아니다.

영수증: `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-preferences-race62-ywv348p5/result.json`. 검사 파일 SHA `b42bcb0eb9061f0eba842a42ee6c732eea925e43f00e2dbc7063e3c8d1de9413`. 복구 목록을 private600 파일에 SQL fixture 작성 전 기록했고 최종 전체 catalog/이력/자료 건수 복원·프로세스 및 DB 세션0·영수증 저장 후 제거했다. 최종 자료 정리가 PASS다. hosted·모바일·운영 연결은 계속 남으며 전체55%를 유지한다.
