# 종현 전용 환경의 현재 AI SQL 검증

전체 진행률은 **79%(22/28)**를 유지한다. 이 기록은 새 전용 환경 구축과 일부 실제 DB 단언 검증이며, 백엔드100·실회원·운영·후기14개·AI22/23 전체 검증 완료가 아니다.

## 승인·소스·환경

사용자의 구체적 승인으로 `cumaciki0317-sys/yumidang`의 `jonghyun/backend100`만 일반 push했다. `de885d2` 원격 SHA 일치를 확인했다. main·다른 브랜치·기존 작업 공간은 변경하지 않았다.

새 Colima `jonghyun-backend100`은 2CPU·4GiB·20GiB, host mount 없음, 기본 context 미전환으로 준비했다. 기존 VM/컨테이너를 중지·변경하지 않았다. Supabase CLI2.116.0은 공식 release archive·checksum·release digest를 대조해 별도 도구 폴더에 설치했다. telemetry를 비활성화하고 login/link를 하지 않았다.

새 project `jonghyun-backend100-077eabaa`의 SQL119개와 config는 현재 HEAD와 좁은 project/port overlay 해시를 고정했다. 첫 daemon 관찰에서 기존 컨테이너는 없었다. 시작은 66.2초, 메모리29표본 최저3,135,436KiB로 성공했다. 6개 새 컨테이너는 동일 project label과 실제 ID/image를 기록했고, 최초 users/profiles는0이었다. 전용 DB의 cron만 OFF로 닫았고 외부 AI guard는 CLOSED다. 생성된 로컬 키가 포함될 수 있는 시작 원로그는 비공개0600 파일에만 유지한다.

## 새 실행기 계약

`tools/local/run_database_tests.py`의 기존 기본 모드는 유지한다. 새 모드는 다음처럼 두 옵션과 명시 실행을 요구한다.

```sh
python3 -B tools/local/run_database_tests.py --prepared-root /절대/시스템임시루트 --current-ai --run
```

임시 루트의 canonical path·0700·uid, config overlay·SQL bytes/집합·현재 HEAD, 최초 빈 scope, 전용 socket/context, DB ID/image/label·실행 상태와 실제 적용 migration을 검사한다. 모든 실제 Docker 호출은 고정 socket을 사용한다. 회원·프로필·AI 요청·예약·큐의 빈 상태, cron OFF·외부 guard CLOSED·동일 application 세션0을 검사한다. 현재 시험 SQL은 Git HEAD와 정확히 동일해야 한다.

atomic·budget·scopes·summary를 각각 독립 rollback 트랜잭션으로 실행한다. scopes에는 budget의 정확한 임시 helper 정의만 공급한다. budget fixture 전체를 합치면 남은 예약량과 scopes의 전체 예약 단언이 충돌하므로 합치지 않는다. statement15초·lock10초·DB assertion ON·고정 advisory lock을 유지한다.

각 정상 종료 뒤 public/private/storage 전체 행 digest를 DB 내부에서 계산해 기준과 비교한다. 실패 뒤에도 행·guard·같은 application 세션 종료를 검사한다. 이 비교는 auth 전체·sequence·schema·물리 Storage 바이트·완전 복원 증거가 아니다. sequence 변경은 rollback으로 복원되지 않을 수 있다.

오류는 고정 FAIL·SQLSTATE·제한된 stdin 실행 행만 반환한다. SQL 원문·동적 예외·회원 본문·credential은 반환하지 않는다. 실행 행에는 runner의 설정/잠금 줄이 포함되므로 원본 파일 행과 동일하지 않을 수 있다.

## 실제 결과와 실패 보존

첫 실제 실행은 5.22초, 메모리4표본 최저3,257,204KiB, observer 실패 없음이었다.

| 검사 | 결과 |
|---|---|
| ai_atomic_requests | PASS |
| ai_account_budget | PASS |
| ai_account_scopes | PASS |
| current_summary_fences | FAIL / SQLSTATE42501 |
| 전체 네 검사 묶음 | FAIL |
| 실패 후 public/private/storage 행·닫힌 guard·세션 | VERIFIED |

별도 진단은 원로그를 출력하지 않고 원본 summary DO 끝88행·권한 대상 `mark_review_summary_insufficient`만 확인했다. 메모리 최저3,253,664KiB이며 observer 실패는 없었다. SQL109는5인수 `mark_review_summary_insufficient`와9인수 `publish_review_summary_for_job`의 service_role 직접 EXECUTE를 회수한다. 구형 `current_summary_fences.sql`은 service_role 직접 호출을 전제로 하므로 현재 권한 계약과 맞지 않는다. 제품 ACL을 넓히거나 owner로 전체 시험을 실행하거나 단언을 제거하지 않았다. 최신 invocation/dispatch 조립에 맞춘 요약 검증이 별도 필요하다.

행 진단 추가 후 재실행의 runner도 앞3PASS·요약FAIL42501·executionLine90·실패 후 종료 검사 VERIFIED를 기록했다. 다만 임시 부모 관찰 도구가 쓰기 전용 fd를 읽으면서 EBADF로 실패해 관찰 영수증 저장이 미완료다. 이 시도 전체를 PASS로 처리하지 않고 첫 실행과 별도로 보존한다. 같은 오류를 숨기기 위한 반복 실행은 하지 않았다.

새 runner의 대상 거절·SQL/config 변경·symlink·잘못된 scope·독립 TX·원문 없는 행 진단 회귀7개 PASS, 기존 database runner 회귀10개 PASS다. DB 실제 실패와 순수 회귀 PASS를 구분한다.

## 남은 조건

- 요약14개는0/14, AI22/23 전체 실제 실행과 AI24 자연 자정은 NOT_RUN을 유지한다.
- 구형 summary 시험과 SQL109의 역할·영속 invocation 계약을 정합화한 뒤 별도 검증한다. 기존 실패는 보존한다.
- 운영 원본 백업/복원·Storage39바이트·공급사 조건·실회원 HOLD·운영 적용 승인 조건은 변하지 않는다. 새 합성 DB의 성공으로 기존 원본 검증을 대신하지 않는다.
- 사용자 전달 WBS7.11·1.7은 잠정 인계 준비 참고이며 소유권 변경·운영 승인·과거 기여 판정으로 사용하지 않는다. Notion을 수정하지 않았다.
- 원본 키·JWT·DB 덤프·회원 본문·비공개 시작 로그는 Git에 넣지 않는다. 운영 DB 쓰기·배포·추가 결제·회원 원문 외부 전송은 하지 않았다.
