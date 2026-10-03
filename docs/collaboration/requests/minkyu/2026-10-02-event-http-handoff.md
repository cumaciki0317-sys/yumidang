# 행사 연결·내부 Top10 HTTP 검증 인계

2026-10-03 사용자 재개 요청 후 이번 로컬 연결·통합 검증을 완료했다. 전체 목표는 무료 1:1 웹 베타 백엔드 **43% · 6/14 완료**로 유지한다. 내부 연결만으로 공개 Top10·검색·운영 배포 완료를 주장하지 않는다.

## 구현과 검증 범위

- 공고 `eventId`는 생략 시 기존 연결 보존, `null`은 해제, UUID는 선택 행사 연결이다. 기존 공고 저장소와 RPC를 사용한다.
- 수동 행사 교체·연결·해제는 기존 최종 동의를 무효화하며 새 동의가 필요하다. 동일 행사의 제공처 정보 갱신은 일정·공고 입력·동의를 자동 변경하지 않는다.
- `POST /internal/events/kopis-top10`과 `GET /internal/events/kopis-top10/:mode`는 내부 비밀 인증 및 service_role 전용 RPC만 사용한다. 공개 사용자 권한을 추가하지 않았다.
- 신규 단위 8개 및 기존 관련 회귀 68개 PASS, Deno 검사 PASS. 단위 검사는 주입 모형이며 실제 DB 증거와 구분한다.
- 새 CLI 프로젝트에 정식28개와 후속10개, 총38개 SQL 적용 및 service-api 기동 성공. 실제 gateway HTTP/CORS 82개 PASS, 행사 연결 SQL12개·Top10 SQL5개 PASS 및 rollback.
- 회원 세션·행사 연결·최신 표시·재동의·Top10 HTTP 통합 **8개 그룹·769개 확인 PASS**. 원형 in-process factory와 실제 배포된 로컬 gateway를 함께 검사했다. gateway에는 공고 생성·생략/교체/해제 수정·최신 상세·Top10 저장/조회 7회가 포함된다. 관련23개 테이블의 합성 자료 정리를 확인했다.
- 초기 통합 실패는 테스트 URL 검사기의 `v2` 숫자 누락, JSONB 객체 키 순서를 문자열로 비교한 문제, 익명 RPC의 401 기대값 누락이었다. 테스트만 수정했으며 제품·SQL을 통과시키기 위해 변경하지 않았다. 구조 비교는 배열 순서와 모든 필드 값을 유지하고 직접 RPC 거절은 회원403/익명401·SQLSTATE42501을 각각 검사한다.
- 통합 파일 SHA256: `521a09adb13347766b7b1ebb3af924eb5677adb9f0d348b9978d4611cb0357f4`.

## 보존과 환경

[현재 하네스](../../minkyu-event-http-harness.json)의 14개 허용 경로와 135개 보존 해시를 사용한다. 작업자는 `minkyu`, 브랜치는 `minkyu/foundation-harness`, 기준 HEAD는 `58d1efc76b9d7e7b5b96aed7e47062f43652e06f`이다. 종현 제품 파일·기존 SQL 사본·Git 인덱스·운영 데이터는 변경하지 않았다.

새 합성 검증 환경은 `/private/tmp/yumidang-event-http-20261003-astheyz7/edge`, 프로젝트 `yumidang-minkyu-gateway`, API 56521·DB 56522이다. 23개 테이블 정리 PASS 후 정확히 일치하는 검증 Node 서버와 해당 CLI 프로젝트만 종료했다. 임시 키가 있는 config·worker.env·serve/start 로그를 삭제했다. 원본 소스·metadata 증거는 보존했다.

기존 별도 네이버 로컬 환경은 유지했으며 진단에서 `ready`·가입 완료 상태를 확인했다. 실제 네이버·외부 AI 호출을 이번 합성 검증에 추가하지 않았다.

## 다음 단계와 운영 전환

종현의 숫자 검색·카드·AI 연결, 순위 어댑터·공개 Top10 정책, 운영 실행기·프론트 전체 검증은 남아 있다.

원격은 [별도 적용 준비](2026-10-02-remote-deployment-plan.md)를 따른다. 예약 migration이 기존 매분 cron을 해제하므로 운영 상주 실행기와 복구 절차를 확보하기 전에 일괄 적용하지 않는다. 기존 회원·클라이언트 전환, 함수·ACL·RLS drift, 사진 bucket 권한, 백업·자료 보존을 별도로 검증한다. 이번 인계는 원격 적용·배포 승인 또는 완료 기록이 아니다.

병렬 에이전트의 원격 metadata 읽기 확인: 대상 프로젝트 ACTIVE_HEALTHY·이력20개 유지, public/private14개 테이블 RLS 활성, index35개 valid/ready·constraint80개 validated·trigger6개 활성이다. 함수46개의 본문 MD5와 SECURITY DEFINER를 로컬20개 이력의 순차 정의 및 과거 동적 오류코드 변경과 대조해 모두 일치했다. search_path는 모두 빈 값이다. 이는 구조 전체 무변경 또는 배포 준비 완료 증거가 아니다. 컬럼·기본값·제약·정책·ACL·index의 실제 로컬20 재생 대조, 사진 bucket의 회원 전체 읽기 권한, 백업/PITR와 운영 실행기는 추가 확인 대상이다. 기존 매분 cron은 활성 상태로 유지했다. 회원 본문·키·cron 명령 원문을 조회하거나 원격 쓰기를 수행하지 않았다.

metadata 증거는 임시 owner-only `remote-schema-evidence.json`에 저장했다. SHA256 `3eb05f4f0f53c0d8178b2500d92cdc98c8aafc3ec92cc7df933c89f5e2bc2e53`. 사용자 자료·키·함수 본문·정책식·cron 명령 원문은 포함하지 않았다.
