# 원격 구조·권한 대조

2026-10-03 실제 대조를 완료했다. 전체 **43% · 6/14**를 유지하며, 운영 데이터·DDL·cron·Secrets를 변경하지 않았다. 직전 [완료 실행기 최소 권한](2026-10-03-completion-role-handoff.md)은 실제 로컬 검증·정리를 마쳤다.

## 검증 대상

권한을 받은 실제 유미당 프로젝트 `bndguguarijmghnkenvt`는 ACTIVE_HEALTHY이며 기존 이력20개를 다시 읽기 확인했다. 현재 원격 PostgreSQL 버전은17.6.1.166이다. 이전 함수46개 본문·권한 일부 대조는 전체 구조 일치 증거가 아니므로 실제 같은20개 SQL을 별도 로컬 DB에 재생한다.

[이번 하네스](../../minkyu-schema-drift-harness.json)는 허용8개·보존153개 파일이다. 민규 작업자·기존 브랜치/HEAD에서 담당 파일만 수정한다. 현재39개 구현용 SQL과 원격20개 기준은 서로 다른 대상이며 운영 자료를 로컬에 복사하지 않는다.

- A: 공통 metadata SELECT query. 정의·정책·본문·cron 명령 원문 대신 해시를 반환한다.
- B: 실제 확인한20개 버전만 HEAD 정식28개에서 고르는 로컬 사본 준비·입력/보존 검사.
- C: 정확한 메타데이터 구조·중복·권한·해시 차이 비교와 실제 결과의 현황 반영.
- 총괄: 원격 읽기 query·별도 로컬20개 재생·동일 query 실행·대조·정리.

예상 기준은 앱 테이블14개·컬럼93개·index35개·constraint80개·trigger6개·함수46개다. 현재 객체를 누락시켜 이 수량에 맞추지 않으며 추가·누락도 차이로 취급한다. 정책·함수 본문 해시와 모든 grant·열 권한·RLS·schema 접근을 별도로 검사한다. deparse 형식 차이는 곧바로 의미 있는 구조 차이로 단정하지 않고 근거를 확인한다.

## 실행·해석

검증 프로젝트는 `yumidang-minkyu-drift` API56531/DB56532를 사용하고 기존 네이버 프로젝트·운영 서버를 보존한다. 회원 본문·사진·채팅·키·cron 명령 원문은 조회하지 않는다. server 버전 등 context와 cron의 운영 상태는 정적 앱 구조와 구분한다.

원격에서 재확인한20개 이력을 격리 로컬 DB에 실제 재생하고 동일한 최종 query를 실행했다. 비교 도구 exit0, **STATIC_MATCH · 정적14분류 모두0차이**다. server context와 cron 메타데이터도 각각 일치했다. 준비 도구 검사7개·비교 도구 검사13개 PASS는 실제 DB 대조와 별도다.

앱 schema2·table14·column93·index35·constraint80·policy10·Storage policy3·trigger6·function46, table grant201·column grant7·schema grant10·default grant96·migration20을 양쪽에서 확인했다. 본문과 설정은 해시로만 비교했으며 회원 데이터는 조회하지 않았다.

- 최종 query SHA256: `4405360718ce6f5f5c3c249964390ed1dfba156369b55ab52982d800f4614772`.
- 정규화한 정적 catalog SHA256: `741cc9fc35eea8cc586f1dd4df17681922ece25e62d309123d68ee02c3e16a59`.
- 비공개 증거: `/private/tmp/yumidang-schema-drift-20261003-dts8tbvm/`의 `local-catalog.json`, `remote-catalog.json`, `comparison-summary.json`, `remote-versions.json`(각600).
- CLI start/stop 모두 exit0. 검증 DB를 중지하고 시작 로그를 삭제했다. 정리 후 실행 컨테이너5개는 기존 네이버 프로젝트뿐이다.

**정책 적정성은 NOT_ASSESSED**다. 기존 사진 정책까지 같다는 결과는 해당 정책이 최신 공개 범위에 적합하다는 뜻이 아니다. 현재 로컬39개와 원격20개 사이 신규19개 이력은 아직 운영에 적용하지 않았다. 복구 가능한 백업, 운영 실행기/비밀/한도, 기존 회원·클라이언트 전환, 미정 제품 정책과 프론트 검증이 남는다.

## Advisor와 복구 선행 확인

읽기 전용 security/performance advisor의 관측 시각은 `2026-10-02T16:57:18`이다. 최신 실요청으로 모든 경고가 재현됐다는 의미는 아니다. 에이전트가 기존20·목표39 SQL과 대조했으며 다음과 같이 구분한다.

- [RLS enabled no policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)6개 표는 직접 접근을 막고 RPC로 처리하는 설계다. 경고를 없애기 위한 직접 접근 정책을 추가하지 않았다.
- [회원이 실행 가능한 SECURITY DEFINER](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) 공개26개는 빈 search_path를 사용한다. 실행 가능하다는 경고만으로 취약점 또는 안전성을 단정하지 않는다. 기존 가입·신규 활동 RPC는 목표39의 네이버/매칭 SQL에서 회수하지만 운영에는 아직 미적용이다. 비사용 추천 코드 RPC의 실행 권한은 남아 있으므로 최종 전환 목록에서 따로 검토한다.
- [유출 비밀번호 보호](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)는 비활성으로 보고됐다. SQL 적용으로 Auth 설정까지 해결했다고 기록하지 않는다.
- [외래키 인덱스 누락](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys)은 기존 추천 가입 audit의 referrer_user_id다. 현재 사용 여부와 삭제/보관 결정을 확인한 뒤 성능 조치를 검토한다.
- [미사용 인덱스](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)로 보고된 알림 join_request 인덱스는 FK 조회 목적으로 만들었다. 통계만으로 삭제하지 않았다.

연결된 대상 조직 요금제는 실제 읽기 결과 `free`다. [공식 백업 안내](https://supabase.com/docs/guides/platform/backups)에 따라 유료 자동 일일 백업을 보유한다고 가정하지 않는다. 실제 백업 목록·복원 가능 시점은 아직 미확인이다. DB 백업과 Storage 파일 복구는 별개이며, 요금제를 변경하거나 복구를 실행하지 않았다.
