# 본인 제재 상태 조회 구현 및 검증

작업자 minkyu. 최신 계획의 S21 본인 자료 조회를 기존 신고 서비스 모듈에 연결한다. 신규 판정·통지 발송·이의 마감·운영자 접근 정책은 이 조회에서 만들지 않는다.

`GET /me/safety`는 인증한 회원 JWT와 anon key로 `get_my_safety_state()`를 빈 인수로 호출한다. 사용자/identity 선택·마감·페이지 인수를 받지 않는다. 반환은 `permanent`, `restrictedUntil`, `hasWarning`, `sanctions` 네 키이며 배열 원소는 `sanctionId`, `kind`, `appliedAt`, `expiresAt`, `notifiedAt` 다섯 키다. 기존 여섯 제재 종류만 허용하고 통지가 없으면 null을 보존한다. 원문·신고자·피해자·다른 사건 정보나 임의 이의 마감이 섞인 DB 응답은503으로 차단한다.

HTTP 신고15개+인증 DB transport28개=43개 PASS, 관련 Deno 타입 검사 PASS다. RPC와 인증 transport를 주입한 검증이며 실제 SQL·Auth/REST·hosted Edge·모바일·운영 검증은 아니다. SQL 후보는 독립 검토 중이며 본인 연결·유효 제재 필터·조회 일관성·기존 자격 누락 관리 허용을 실제 DB에서 검증할 예정이다. 제재 종료 이력·대표 사유·이의 절차 안내·상태 알림은 별도 미완료다.


## 실제 SQL 검증

검토한40700을 실제 native63의 단일 owner 트랜잭션 안에 적용하고 회원 조회 회귀를 실행한 뒤 전체 rollback해 PASS했다. 두 합성 회원은 실제 resolve/session/complete SQL로 준비했다. 여섯 유효 제재·최장 종료·경고·영구 제한·통지 null, 만료/무효/타인 원장 제외, 영구 제재와 경고 무효화 즉시 반영, 최신 가입 자격 정보 누락 시 기존 자료 조회, 같은 identity의 새 profile 승계, 옛 profile/탈퇴/익명/계정 연결 불일치 차단 및 auth-only/owner/search_path를 확인했다. 원장은 owner 합성 FK metadata이며 운영 판정·직원 계정·Provider 호출은 없다. 동일 identity의 새 profile도 합성 재바인딩이므로 실제 OAuth 재가입 증거가 아니다.

증거: `/private/tmp/yumidang-safety-native63-gqabm26r/final-receipt.json`. 제품 SQL SHA `39f2cabe90cc137252be7953f5c0078f087f78f8ce7a2fbeda469a7309e555cf`, 회귀 SHA `9967c68bfcde25c2ecfbae4f75b21f0d9d3f1f77a4feb705305d238ba8519d52`. 최종63 이력·기존 함수 정의/owner/ACL·역할/멤버십·소개 열 권한·30개 관계 자료 수·안전 원장6개 관계 수·guard false·전역 점유 해제·Storage 실제 파일0·보호 컨테이너 ID/시작/재시작 수를 복원 확인했다.40700은 rollback했으므로 로컬 영속 이력은 아직63개다.

첫 검증은 테스트 기대값 별칭 충돌로 FAIL했으며 수정했다. 이후 즉시 만료 fixture를 쓴 실행은 FAIL1/PASS2로 불안정을 관측했다. 그 원인은 확정하지 않았고 실패·진단 영수증을 보존했다. 최종 fixture는 종료를 삽입보다24시간 이전으로 명확히 두어 만료 필터를 검사하며 정확한 마감 시점 경합의 증거로 주장하지 않는다. 제품 SQL 바이트는 이 테스트 수정 동안 그대로다. 전체 S21 대표 사유·종료 이력·이의 기한/절차·알림·실제 Auth/REST·hosted Edge·모바일·운영은 별도 미완료다.


## 후속64개 준비 및 실제 로컬 영속 적용

검토64개 준비 도구를 갱신하고 main 합성 검사26개 PASS를 확인했다. 별도 WT의 기존 strict16개도 PASS이며 기존 strict 도구를 수정하지 않았다. HEAD28/41/60/61/62/63/64의 정확 집합만 허용하고 미검토·부분집합·40700 바이트 변조는 거절한다.

artifact `/private/tmp/yumidang-policy64-reviewed-f_r3zcwp/prepared`는 source64를 준비했으며 migration manifest SHA `aa180018d6b5139e1cd378cd9fbec62d3bd2272f75d072b56b06028ecea23085`다. HEAD41+pending23은 Git 기준이고64 SQL+49서버 파일 SHA가 main과 같다. manifest의 SQL/Edge NOT_RUN은 준비 도구 범위를 유지한다.

실제 격리63 DB에서 공식 CLI dry-run 대기는40700 하나였고 한 번 영속 적용해64 이력과 최종 대기0을 확인했다. 기존 모든 public/private 함수 정의/owner/ACL·역할/멤버십·profile 열 권한·제약·guard false·전역 점유 해제·자료 수·보호 컨테이너 ID/시작/재시작 수를 보존했다. 새 get_my_safety_state만 추가했고 auth-only/기존 get_my_profile owner/empty search_path를 확인했다. 영수증 `/private/tmp/yumidang-native64-rollout-ooji18q3/application-receipt.json`. 운영 DB·외부 Provider는 변경하지 않았으며 실제회원API 검사는 다음 단계다.


## 후속 실제 회원 API 통합

실제 native64 Auth·REST·Storage와 프로세스 내부 최신 회원 HTTP handler 연결13그룹 PASS, 정리 verified:true다. 증거 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-naver-native64-01znpW/result.json`, driver SHA `d8364111dfbfd76d9578317f8cfe1d08a16787d0c0f9a0ca380b3b4aa15ad7e2`. 새13번째 그룹은 본인의 비제재 초기 조회, 여섯 유효 제재의 exact4/5키·본인ID·최장 종료·경고, 타인/만료/무효 원장 제외, 영구/경고 정정 직후 조회, 최신 네이버 자격 정보 누락 후에도 본인 자료 조회를 확인했다. 기존 사진·성향·약속·철회·자격 변경12그룹도 현재64에서 통과했다.

실제 운영 판정은 실행하지 않았고 안전 원장은 owner 합성 자료다. 네이버 응답도 합성이며 real OAuth/hosted Edge/모바일/운영 증거가 아니다. 통지 발송·이의 마감도 검사하지 않았다. 최종38개 관계와Storage 실제 파일0·guard false·전역 점유 해제·역할/멤버십/RPC ACL·64 이력 불변을 확인했고 복구 파일은 성공영수증과 정리 확인 후 제거했다. 기존 real OAuth 환경과 격리 환경의 컨테이너 ID/시작/재시작 수는 최종 별도 검증했다.

첫 API 실행은49개 검토 소스 중 deno.json을 .ts 전용 경로 검사로 거절해 fixture 생성 전에 종료했다. 고정 manifest/edge SHA 및49개 전체파일 SHA 검사는 유지하고 정확한 deno.json 경로만 추가 허용했다. 실패 기록 `/private/tmp/yumidang-native64-rollout-ooji18q3/member-api-preflight-failure.json`을 보존했다. 전체 S21 사유/종료이력/이의/알림·모바일·운영은 계속 미완료다.
