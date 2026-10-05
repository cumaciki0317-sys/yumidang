# 일정·장소 변경 제안 철회 연결

작업자 minkyu. 최신 변경 정책은 제안자 철회 시 기존 약속을 유지한다. 현재 route/repo에는 propose/accept/decline만 있어 철회 경로를 기존 민규 모듈에 추가했다. 종현 모바일·검색·작업 실행기는 수정하지 않았다.

POST `/appointments/:id/schedule-change/withdraw` 본문은 `{changeId,conditionVersion}` 두 필드다. 경로 약속 ID와 함께 `withdraw_appointment_schedule_change`의 정확한 세 인자로 전달하고 검증된 회원의 원래 JWT를 사용한다. 사용자 ID·역할·상태·접수/만료 시각·장소 입력은 받지 않는다. 기존 수락·거절·약속 취소 경로를 유지한다.

HTTP52개·Deno 타입 검사 PASS다. 철회 DTO 및 withdrawn/expired/cancelled 결과 보존, 잘못된 입력·메서드·회원/시각 주입 차단, 내부 worker의 사용자 경로 사용 거절, 오류 시 사용자 client만 호출, 실제 runtime 조립의 JWT·세 인자 매핑을 검사했다. DB 포트/HTTP transport는 주입했으므로 실제 로컬 Auth/REST 연결 증거가 아니다.

40600 SQL 후보는 상태 CHECK에 withdrawn을 추가하고 기존 회원/탈퇴 guard·잠금·종료 helper를 재사용한다. 본인 제안자만 철회하며 이전 조건 버전 또는 수락/거절 완료 후 철회는 충돌로 처리한다. 동일 withdrawn/expired/cancelled 결과는 멱등 재조회한다. 기존 약속·공고·장소·완료 예약을 보존하고 종료 helper의 제안 위치 원문 정리·중복 없는 알림을 유지한다. 새 접수 시각 규칙은 임의 구현하지 않는다.

현재 SQL은 검토 후보이며 실제 DB 실행·영속 적용·철회/수락 두 세션·모바일·운영 연결은 NOT_RUN이다. 실제 검증 이후 이 문서에 범위와 영수증을 추가한다. 마감 전 서버 도착 요청의 잠금 대기 문제와 신뢰 접수 시각 경계도 별도 미완료다.

## 후속 실제 SQL 회귀

검토한40600을 실제 native62의 단일 owner 트랜잭션 안에서 적용하고8개 합성 약속·제안 회귀를 실행한 후 전체 rollback해 PASS했다. 본인/양방향 제안자만 철회, 비당사자PT404·상대 제안자42501·잘못된 ID/조건 버전40001, withdrawn/expired/cancelled 멱등, accepted/declined 충돌을 확인했다. 네이버 정보 누락 이후에도 실제 대기 제안의 철회가 성공했고, 익명·탈퇴 회원·anon/service/queue 역할의 실행은 차단됐다.

철회 전후 실제 공고·약속·완료 예약·검색 장소·상세 장소 snapshot은 같았다. 위치 제안 원문은 null로 정리됐고 종료 이벤트1개·양쪽 알림2개가 중복 없이 생성됐다. 시간 전용5인자 제안은 locationChanged/newLocation 키를 새로 추가하지 않았다. 만료 fixture는 두 시각에 동일 statement_timestamp를 사용해 정확한6시간 상한을 지켰다.

증거: `/private/tmp/yumidang-withdrawal-native62-txvzrgez/receipt.json`, 제품 SQL SHA `80d58914f8db461c9e5d961b4a5ebcc8c51aaa6a0ce76fd843333e2079d5a10b`, 회귀 SHA `0c52f0e7fefc5f4cc584022e5643ce4b25763f8b8c8a1466644e578c15bc4edd`. 최종62 이력·함수 정의/소유자/권한·역할·소개 열 ACL·guard false·전역 점유 해제·Auth/Storage/앱 자료0 등 baseline이 정확히 복원됐다. 임시 탈퇴 준비도 같은 검증 TX와 함께 원복했고 Provider를 호출하지 않았다.

영속 native63·실제 Auth/REST 경유 철회·수락/철회 두 세션·마감 접수·모바일·운영 연결은 아직 남는다. 검토63개 준비와 실제 회원 연결 검사를 별도로 진행한다.

## 후속 native63 영속 적용 및 실제 회원 API

검토63개 준비 도구를 반영했고 main 회귀23개가 PASS했다. artifact `/private/tmp/yumidang-policy63-reviewed-khq_kxpq/prepared`의63 SQL와49 서버 소스 SHA가 main과 같다. migration manifest SHA는 `53c58346cab037e08eb4c6e2842f76b3818700e5ca7bf4c8afb3d45cb5281e68`이며 HEAD41+pending22는 Git 기준이다. 실제62 DB에서 dry-run 대기는40600 하나였고CLI로 한 번 적용했다. 최종63 이력·대기0·기존 역할/멤버십/함수/권한/guard/자료/컨테이너 불변·상태CHECK의 withdrawn 추가만 확인했다. 증거: `/private/tmp/yumidang-native63-rollout-k5zhlaox/application-receipt.json`.

실제 Auth·REST·Storage 연결12그룹 PASS 및 정리 PASS: `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-naver-native63-9qaqpk/result.json`. 최신 검사 파일 SHA는 `86c875dcae8225f6919d3a8b576c77c8a17de945f947e31f65b2b5c410c4eddc`이고 기존 default/native60/native62 실행을 보존한다. 새 그룹은 실제 회원의 조회→장소 변경 제안→철회→재조회, 상대의 철회403·옛 버전409 및 원문 오류 비노출, 동일 요청 재시도 deduplicated:true, 기존 post/appointment/location/details/reservation snapshot 불변, 위치 제안 원문 null, 종료 이벤트1·알림2를 확인했다. 최종30개 관계와Storage 실제 파일0·guard/역할/멤버십/RPC권한/63 이력 불변도 PASS다.

네이버 응답은 합성이고 handler는 프로세스 내부에서 실행했다. actual OAuth·hosted Edge·모바일·운영 연결 또는 철회/수락 두 세션·신뢰 접수 마감 증거는 아니다. 다음은 철회와 수락의 실제 경합 검증이다.


## 후속 실제 철회·수락 경합

native63에서 별도 DB 세션 두 개의 실제 RPC 잠금 대기를 `pg_blocking_pids`로 확인한 뒤 세 경우를 검증해 PASS했다. 철회 commit 뒤 수락은40001이며 기존 약속을 보존했고, 수락 commit 뒤 철회는40001이며 변경 일정·장소·예약을 보존했다. 철회 rollback 뒤 대기 수락은 정상 commit했다. 종료 이벤트1개·알림2개·위치 원문 정리도 확인했다.

증거: `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-change-withdraw-race63-qq_w782z/result.json`. 검사 파일 `tests/integration/minkyu/appointment_change_withdrawal_concurrency_local.py` SHA `85c66f20fa010c66b4ddad08140f10fdec0ac39833fd9a912c69df24eb1127c1`. 정확한 합성 fixture 정리 후 관계별 자료 수·역할/멤버십·함수/권한·63 이력·guard false·전역 점유 해제·Storage 파일0·검사 세션0이 복원됐다. 실제 OAuth·Provider·모바일·운영 검증은 아니며 신뢰 접수 마감은 여전히 별도 과제다.
