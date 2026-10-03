# 실제 로컬 gateway 검증 — 2026-10-02

전체 목표는 무료 1:1 웹 베타 백엔드 100%이며 현재 **43% · 6/14 완료**다. 이 결과만으로 운영 배포 단계를 완료하지 않는다. [하네스](../../minkyu-gateway-harness.json)의 단독 파일 소유와 기존 파일 126개 보존 기준을 따른다.

## 실제 결과

- CLI 2.116.0·Kong 2.8.1·전용 프로젝트 `yumidang-minkyu-gateway`·API 56521/DB 56522에서 정식 SQL 36개와 현재 service-api 소스를 실행했다. 실제 네이버 프로젝트·원본 환경·종현 제품 파일은 변경하지 않는다.
- 최초 임시 경로가 Docker 공유 밖이어서 BOOT_ERROR 503을 관찰했다. 원인을 확인하고 `/private/tmp`에 다시 준비하여 해결했다. 이 실패는 CORS 결과와 분리한다.
- 기본 Kong 설정: 실제 검사 82개, API·인증 흐름 PASS, CORS 10개 실패, 종합 PARTIAL. 함수 서비스의 cors 플러그인이 앱 응답을 덮어쓰는 것을 확인했다.
- 명시 조정 도구: 기본 읽기 READY 뒤 `--apply` PASS. 함수 서비스의 cors 플러그인 하나만 제거하며 기존 ID·credential·키·권한·라우팅·설정·내부 배열 순서를 보존한다. Kong이 재로드 때 바꾸는 세 엔티티 목록 순서와 관리 `updated_at`은 유일 ID·단조 증가 정수 검증으로 구분한다. 실제 적용과 원형 재적용에서 나머지 의미가 동일함을 확인했다.
- 조정 후 동일 실제 검사 **82개 모두 PASS**, `workflowPassed:true`, `corsPassed:true`, 실패 목록 없음. 공개 빈 목록·없는 상세·익명/위장 인증 거절·내부 secret 경계·실제 유지 작업의 빈 결과·Origin/프리플라이트/no-store를 확인했다. 외부 네이버/AI 호출이나 사용자 생성은 하지 않았다.
- 준비 검사 11개·조정 도구 핵심 검사 6개·probe 자체 검사 4개 PASS. 자체 검사와 위 실제 HTTP 결과를 구분한다.

## 실행과 남은 범위

`tools/local/prepare_edge.py --gateway-probe`는 Docker 공유 경로만 허용하고 원형 DB 준비 도구를 재사용한다. `tools/local/configure_local_gateway.py`는 기본 읽기 검사, `--apply`는 전용 로컬 Kong에만 적용한다. 전체 설정과 비밀값은 메모리에서 처리하고 출력하지 않는다. API 검증은 `tests/integration/minkyu/gateway_cors_local.py --config <비공개 임시 설정>`이다. 자세한 경계는 [gateway 계약](../../../../backend/contracts/gateway-cors.md)을 따른다.

현재 조정은 실행 중 로컬 설정이다. CLI 재생성 후 영구 유지·원격 gateway 설정·운영 배포·실제 상주 프로세스·00:01 일일 작업 등록은 NOT_RUN이다. 자동 완료 실행기의 실제 복구 검증은 아래와 같이 PASS이며 운영 실행·최소 권한은 별도다. 임시 gateway DB는 합성 자료 검증에만 사용한다. 운영 최소 권한 연결과 별도다. 커밋·푸시는 하지 않았다.

## 실제 상주 완료 실행기 복구

`tests/integration/minkyu/completion_runner_local.mjs`를 전용 DB56522에서 실행했다. 기존 runner/scheduler 두 파일과 backend package/lockfile을 원형 그대로 임시 폴더에 복사하고 pg8.22.0을 설치했다. 제품 코드는 변경하지 않았다.

실제 원형 CLI·PostgreSQL **4개 그룹 PASS**: 시작 시 지난 예약 처리, COMMIT된 알림과 세대/일정 변경, 정확한 실행기 DB 세션 단절 후 재접속·단절 중 예약 처리, SIGTERM 후 정지 중 생긴 예약의 재시작 복구. 완료 시각·기한·알림 중복 방지와 이전 완료 불변을 확인했다. 해당 실행은 검사195회이며 대기 과정의 확인을 포함한다. 고정된 테스트 사례 개수로 표현하지 않는다.

최종 `syntheticCleanup:true`이며 회원·공고·작업·예약·약속·알림0을 확인했다. 원본 실제 네이버 환경은 진단 HTTP200·ready/가입 완료를 유지하며 root .env도 원형 해시와 동일하다. 이 실행은 로컬 관리자 연결이므로 운영 최소 권한·원격·상주 호스팅·일일00:01 등록의 완료 근거가 아니다.

## 병렬 추가 실제 검증

- 로컬 Kong만 재시작하여 기본 CORS가 복원됨을 확인했다. 명시 조정 재적용 PASS, 두 번째 적용은 변경 없음, 실제 gateway82검사 재확인 PASS다. 영구 자동적용·운영 재시작 관리로 확대하지 않는다.
- `places_events_local.ts` 실제 실행 PASS: 합성 Auth와 원형 HTTP factory·실제 Kakao1회/KOPIS1회/Tour1회·행사2건 저장/공개조회·정리 성공. 프로세스 내 HTTP와 실제 Auth/RPC를 사용했으며 해당 진입점의 gateway 배포는 NOT_RUN이다. Tour는 관찰된 literal 값을 한 번 직렬화하는 임시 검증 설정만 사용하고 원본 keyFormat을 변경하지 않았다. 우편번호 UI·Top10 상품 연결·운영 일일 수집은 별도다.
- 요약 worker의 실제 DB 파이프라인3그룹 PASS다. 최초 검사 UUID 정규식 오타를 바로잡은 뒤 실제 RPC91회·합성 모델4회·안전 검사5회·yield3/게시1/오래된 작업1/부족분1 처리와 정리 성공을 확인했다. 외부 AI·운영 공개 활성화의 성공으로 표시하지 않는다.
- 사용자가 운영 Project ID bndguguarijmghnkenvt와 접근 권한을 확인했다. 실제 프로젝트 yumidang/ACTIVE_HEALTHY를 읽기 확인했다. 원격20개 이력과 기존 데이터 개수/매분 완료 cron만 확인했고 원문·다른 프로젝트 DB는 읽지 않았다. 원격 SQL·Secrets·배포는 미실행이며 [준비 계획](2026-10-02-remote-deployment-plan.md)을 따른다.

## 최신 행사 및 공식 순위 내부 SQL

새 `20261002150000_post_event_links.sql`과 `post_event_links.sql`의12그룹은 실제 롤백 트랜잭션에서 모두 PASS다. 최신 행사 정보/취소 상태 조회·행사명 검색·신규 선택 제외·기존 연결과 생성 재시도·권한/재마스킹·입력/일정 보존을 확인했다. 사용자 추가 확정에 따라 직접 행사 교체/연결/해제 시 기존 동의를 무효화하고 선택 UUID만 동의 지문에 넣는다. 기존 연결 없는 지문과 원래 생성 입력은 보존하며 제공처 갱신은 동의를 자동 무효화하지 않는다. 수정 후 동일12그룹의 재동의·지문·알림·이력 검사도 PASS다.

새 `20261002160000_event_rankings.sql`의 내부 저장/읽기5그룹도 실제 PASS다. 공식순위1..N≤10·허용 필드·기간·원자 batch·최신 값/재시도/충돌·두 모드·서비스 역할 전용 ACL을 확인했다. 공식응답에는 집계기간 echo가 없어 요청기간과 실제 응답 검증은 구분한다. 세부는 [Top10 계약](2026-10-02-kopis-top10-contract.md)을 따른다.

두 SQL 검증 후 기존 함수(상세·검색·동의 지문)·행사 연결 컬럼 부재·순위 테이블/함수 부재·Auth/공고/행사/작업0·SQL이력36을 원형 그대로 확인했다. HTTP 연결과 갱신된38개 SQL의 통합·원격 적용은 다음 작업이며 이 결과로6/8/13번 완료를 올리지 않는다.

## 단위 마감

최종 하네스19개 수정 경로·보존126개·언어/diff 검사 PASS다. 전용 DB의 Auth/공고/작업/행사0을 확인한 뒤 해당 gateway 프로젝트와 자신의 serve 프로세스만 중지하고 임시 키/환경/로그 파일을 삭제했다. 실제 네이버 프로젝트/Node/원본.env는 보존했다. 다음 단위는38개 SQL과 행사/내부Top10 HTTP 연결을 갱신한 실제 통합이다.
