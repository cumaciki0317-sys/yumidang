# 병합 공유와 로컬 준비 갱신 — 2026-09-28

사용자 요청은 1번 병합 결과 푸시와 2번 로컬 검증 준비 정리다. 검색 연결 구현은 다음 작업이며 이번에 시작하지 않았다.

## 완료 결과

1. `origin/minkyu/foundation-harness`에 `cce3eb2`까지 푸시했다. 민규 구현과 종현의 독립 코어, 병합 커밋 `115600e`와 검토 기록이 같은 원격 브랜치에 있다. 공유 backend-work나 main은 변경하지 않았다.
2. `prepare_database.py`의 과거 PENDING 6개 추가 복사를 제거했다. 현재 Git HEAD와 일치하는 정식 SQL만 사용하므로 이미 커밋된 SQL의 중복 버전 오류가 사라졌다. 현재 26개지만 숫자나 파일명을 고정하지 않아 다음 정식 커밋도 포함한다.
3. 설정의 일반 파일·저장소 내부 경로·UTF-8 TOML을 복사 전에 검사한다. DB 설정의 의미나 실제 서버 기동까지 검사한 것은 아니다.
4. 준비 manifest는 `pending=[]`, `total_count=count`, SQL/설정 SHA-256, `sql_execution=NOT_RUN`을 기록한다. 기존 사본과 미추적 SQL은 제외하고 보존한다. 변경된 정식 SQL·신규 staged SQL·기존 출력 덮어쓰기는 계속 거절한다.

## 검증 증거

| 확인 | 결과 |
|---|---|
| 새 준비 회귀·로컬 실행 경계 | 10개 PASS |
| 기존 정식 이력·환경 점검 단위 | 17개 PASS |
| 하네스 단위 | 6개 PASS |
| 합계 | 이번 변경 관련 33개 PASS |
| 실제 저장소 준비 | 정식 26개, pending 0, 중복 없이 복사 PASS |
| 해시·보존 | 복사 SQL 26개/설정의 manifest 해시 일치, 원본 SQL의 HEAD 일치 |
| 담당 경계 | 새 수정 8개 모두 민규, 에이전트 수정 중복 0, 종현 56개 파일 원격 원문과 일치 |
| 실제 실행 | DB 기동·SQL 재생·HTTP/Edge·외부 API·모델·배포 NOT_RUN |

실제 준비 루트: `/private/tmp/yumidang-merged-ready-20260928-jntg326r`. OS 임시 폴더이므로 장기 보존을 전제로 하지 않는다. [로컬 README](../../../../tools/local/README.md)의 새 빈 임시 폴더 명령으로 다시 만들 수 있다.

현재 환경 점검: Python 3.14.4, Node 25.9.0, Deno 2.9.6, Docker CLI 29.8.0 탐지. PATH의 `supabase`는 MISSING이라 `check_environment.py` 전체 판정은 NOT_READY다. 이전 검증은 공식 `npx --yes supabase@2.116.0`을 사용했으며 이번에는 CLI/DB 기동을 재실행하지 않았다. 복사 준비 PASS와 실제 실행 환경 READY를 혼동하지 않는다. 이번에 도구를 새로 설치하지 않았다.

```sh
python3 -B tests/database/minkyu/test_database_runner.py
python3 -B tests/database/minkyu/test_local_tools.py
python3 -B tests/functions/minkyu/test_harness.py
python3 -B tools/collaboration/check_harness.py --manifest docs/collaboration/minkyu-local-refresh-harness.json --all-changes
```

마지막 하네스 명령은 이 작업의 커밋 전 baseline `cce3eb2`에서 검사한 기록이다. 커밋 후 다음 작업에서는 새 baseline과 수정 목록을 정의한다. 과거 하네스의 정확한 HEAD 제한을 우회하거나 소유권을 넓히지 않는다.

## 이번 작업의 파일 분리

[이번 manifest](../../minkyu-local-refresh-harness.json)에 정확한 8개 수정 파일을 기록했다. 모두 actor=minkyu다.

- 총괄: AGENTS.md, 민규 현황, 이번 인계, 새 manifest, 하네스 명령의 새 manifest 선택지.
- A: `tools/local/prepare_database.py`.
- B: `tests/database/minkyu/test_database_runner.py`.
- C: `tools/local/README.md`.

SQL 이력 26개, 사본, 종현 코드, 원래 작업 폴더, 소유권 정책과 hook은 수정하지 않았다. 이번 갱신도 기존 hook으로 커밋하고 같은 민규 전용 브랜치로 공유한다. 실제 커밋·푸시 결과는 Git 로그/원격 브랜치를 확인한다.

## 다음 검색 연결 작업의 담당 경계

아래는 다음 작업 준비 계획이며 이번 수정 허용 목록이 아니다. 실제 시작 전에 새 기준 커밋과 정확한 파일 목록을 확정한다.

| 담당 | 맡을 내용 | 예정 파일·영역 |
|---|---|---|
| 민규 DB | 공개 지역·카드 필드·기간/상태/비용 필터·정렬/페이지·권한 RPC 정리 | `backend/contracts/public-post-search-db.md`, 새 후속 migration 1개, `tests/database/minkyu/`의 해당 SQL 검사 |
| 민규 공통 | 검색 RPC 허용 목록, 검증된 사용자 문맥, 공개 오류 연결 | `_shared/db/user-client.ts`, `_shared/auth/principal.ts`, 민규 인증/DB 테스트·계약 |
| 종현 검색 | 공통 RPC를 검색 포트에 맞추는 실제 어댑터와 검색 코어 연결 | `_shared/db/repositories/search.ts`, `_shared/services/search-service.ts`, `_shared/contracts/search.ts`, `backend/contracts/search.md`, 종현 검색 테스트 |
| 함께 확인 | HTTP 경로/담당 확정 후 실제 요청→권한→DB→카드 검증 | 민규 공통부와 종현 진입점을 교차 수정하지 않고 각 담당자가 자기 파일에서 연결 |

`_shared/`는 `backend/supabase/functions/_shared/`를 뜻한다. 새 SQL 파일명과 HTTP 경로는 후속 계약을 확정할 때 정하며 기존 migration을 고쳐 맞추지 않는다. 민규 에이전트는 종현 파일을 직접 수정하지 않고 요청 문서로 필요한 변경을 전달한다.

우선 해결할 차이는 [병합 검토](2026-09-28-jonghyun-merge-review.md)의 검색 공개 지역·전체 반환 필드·필터/정렬·인증/오류 항목이다. 이후 후기 요약의 점유 검증/checkpoint·작업 종결, 행사 DB 순으로 별도 진행한다. PASS/문자/계좌 공급사와 미정 정책 준비는 [민규 재개 메모](../../minkyu.md#다음-대화에서-재개할-순서)에 유지한다.
