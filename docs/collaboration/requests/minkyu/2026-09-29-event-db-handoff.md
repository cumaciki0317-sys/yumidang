# 행사 DB 기반·종현 연결 인계

2026-09-29 민규. 사용자 요청: 후속 작업을 계속하되 커밋·푸시는 더 작업한 뒤 진행한다. 현재 변경은 로컬이며 원격 공유 기준은 여전히 `ff9c14f`다.

## 작업 범위

[11차 하네스](../../minkyu-event-db-harness.json)에서 A는 행사 SQL·계약, B는 독립 DB 검사와 전용 실행 도구, C는 CORS 후속 검토를 맡았다. 총괄은 민규 공통 client 3개의 행사 RPC 허용 목록·역할별 테스트·실제 로컬 검증·보존 확인·인계를 담당한다. 기존 10차 미커밋 산출물11개를 SHA256으로 보존하며 종현94파일·기존 SQL27개는 수정하지 않는다.

## 종현 연결 순서

1. [행사 DB 계약](../../../../backend/contracts/event-storage.md)의 정규화 JSON과 기술 한도를 기존 `EventRepositoryPort`에 연결한다. 새 저장 RPC `upsert_source_events_v1(p_events)`는 내부 service_role로만 호출하고 사용자 요청에 service key를 전달하지 않는다.
2. `listCandidates`는 공개 조회 RPC `list_event_candidates_v1(p_region,p_category)`의 완전한 후보 배열을 받는다. 나머지 키워드·기간·진행 중·신규·작성 선택·정렬은 기존 `queryStoredEvents`/`selectEvents`를 재사용한다. 후보1000개 초과 오류를 정상 빈 목록이나 잘린 결과로 대체하지 않는다. 이것은 제품 페이지 크기가 아니라 연결 초기 기술 한도이며 규모 확장 시 필터·정렬을 보존하는 별도 DB 페이지 계약이 필요하다.
3. 공급사 어댑터는 원문 payload를 저장하지 않고 허용된 공개 필드만 만든다. 날짜 정밀도·입장료 미확인·취소 상태를 보존하고 sourceUrl에는 공개 안내 URL만 넣는다. API 키가 포함된 수집 URL을 저장하지 않는다.
4. 실제 제공처 → 정규화 → 저장 RPC → 후보 RPC → 기존 조회 코어 → 서비스 HTTP 검증은 종현 연결 후 별도로 수행한다. 이번 DB 검사와 이전 공급사 최소조회 성공을 이 전체 흐름의 성공으로 합치지 않는다.

## 실제 검증

**로컬 신규 SQL 검증 PASS.** 원격 이력 적용·실제 공급사 수집·종현 저장소 어댑터/HTTP 연결은 NOT_RUN이다.

| 검증 | 결과 |
|---|---|
| PostgreSQL 실제 행사 DB | 6개 묶음 PASS: ACL, identity/stale/cancel, 날짜·null·입장료·정확 필터, 잘못된 배치·원자성·URL, 실제 역할·직접 접근 거절, 후보 한도 |
| 새 로컬 실행 도구 | Python8개 PASS: 명시 실행·대상 격리·SQL transaction/psql 명령 검사·실패 상태 |
| 기존 하네스 | Python6개 PASS |
| 행사 공통 client | 신규 Node5개 + 기존 인증/DB21개 PASS |
| 기존 종현 행사 코어 | Node25개 PASS |
| Deno | 수정한 공통 client3개와 새 테스트 타입 검사 PASS |
| SQL 정리 | ROLLBACK PASS, 신규 테이블·RPC·helper 없음 |

Python14개, Node51개 및 실제 DB6묶음을 각각 구분한다. 코드 변경 없는 이전 API 진단35개 결과를 이번에 다시 실행한 것으로 합산하지 않는다.

재현 명령:

```sh
# 무호출 기본은 NOT_RUN(exit2)
python3 -B tools/local/run_event_database_tests.py
# 전용 로컬 DB가 준비됐을 때만 실행. 원격 URL 옵션 없음.
python3 -B tools/local/run_event_database_tests.py --run
node --test tests/functions/minkyu/event_db_client.test.ts tests/functions/minkyu/auth_db.test.ts
node --test tests/functions/jonghyun/event-service.test.mjs
python3 -B tests/database/minkyu/test_event_database_runner.py
```

이번 검증 SQL SHA256: `8b853ab4af4311552126bbf66f073a9b2baeaad2371fabb2d0afc1ee2196931c`, 테스트 SQL SHA256: `336eba911cd0f776d8524aa4b9f29b57c07c9b25f52d45ec28b5a0f73bf9ede2`. 향후 파일이 바뀌면 해당 변경본을 다시 검사한다.

- 전용 Colima `yumidang-minkyu` / Docker context `colima-yumidang-minkyu` / Supabase project `yumidang-minkyu-db`만 사용한다. PostgreSQL17.6, 기존 적용 SQL27개, 실행 전 사용자·공고·작업0건 및 신규 행사 테이블 없음 확인.
- Git 정식 SQL27개만 기존 준비 도구로 `/private/tmp/yumidang-event-db-6wtyto9w`에 복사했다. 신규 SQL은 정식 목록에 추가하지 않고 별도 검증 트랜잭션에서 적용한 뒤 롤백한다. 운영 DB나 기존 이력은 변경하지 않는다.
- 기존 종현 행사 코어 Node25개 PASS. 한국 주간·기간 겹침·정렬·취소·검색과 입장료 미확인 사례를 포함한다.
- 검증 후 별도 확인에서도 적용 이력27개, 사용자·공고·작업0건, 신규 행사 테이블·저장/조회 RPC 없음이었다. Supabase와 Colima를 정상 종료했고 기존 볼륨·이미지는 보존했다.
- 최종 담당 검사: 변경26파일 중 이번 허용15개·이전 보존11개, 수정 중복0. 종현94파일·기존 SQL27개가 HEAD와 일치하며 실제 로컬 비밀값의 변경 파일 내 검출0, 문서 링크·diff 검사 PASS다.

## CORS 및 남은 작업

[CORS 후속 검토](2026-09-29-cors-followup.md)에서 로컬 CLI의 gateway가 응답 헤더를 덮어쓰는 기존 문제를 확인했다. 현재 고정 CLI2.116.0에서 지원되는 프로젝트 설정 override는 확인하지 못했고, 앱 CORS 수정 필요 근거는 없다. 기존 로컬 CORS는 PARTIAL이며 이번에 기대값을 낮추거나 생성 gateway 설정을 수정하지 않았다. 운영 gateway·프런트 Origin을 정한 후 해당 환경의 설정과 실제 브라우저 응답을 검증해야 한다.

서울 열린데이터의 HTTPS 전송 경로, 수집 주기·최초 과거 범위, 포텐스닷 보관·사용량·예산 연결, PASS·문자·계좌 인증, 원격 운영 배포는 별도 남은 작업이다. 이 단계에서 임의 확정하지 않는다. 커밋·푸시는 수행하지 않는다.
