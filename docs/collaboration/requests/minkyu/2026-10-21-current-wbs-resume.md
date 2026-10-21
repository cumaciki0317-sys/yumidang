# 민규 WBS 재개 · 2026-10-21

actor=minkyu, 전용 clone `/private/tmp/yumidang-minkyu-wbs-20261017`, 브랜치 `minkyu/wbs-backend-20261017`에서 사용자의 재개 요청을 이어간다. 원본 작업 공간의 미추적 자료와 actor/hook은 변경하지 않았다. 원격 main은 재조회 시 `522be4ee3d594d53eec6978da0d0f23a3596c529`였다. 전체 기준은 79%(22/28), 개인44개 완료율은 아직 확정하지 않는다. 실회원 QA는 별도 재개 요청 전 HOLD다.

아래 표는 재개 초기 상태다. 이후 실행 결과와 현재 남은 조건은 하단의 후속 기록을 따른다.

| WBS ID | 변경 | 실제 검증 범위·증거 | 남은 조건 | 다음 작업 |
|---|---|---|---|---|
| 7.11·7.14 | 명시 HEAD·전체 migration 목록 SHA와 등록된 추가 SQL의 정확한 SHA를 연결하는 준비 모드 | `eeb7f0f`, 기존119·새9·manifest9 회귀 통과 및 독립 검토. 과거121 모드는 보존 | 준비는 실제 Auth·전체 복원 PASS가 아님. 미등록123은 거절 | 행사 SQL 검증 후 정확한 새 SHA를 별도 등록·검토 |
| 7.11 | 격리 scratch의 고정 서버 SQL2개·회귀4개 목록을 실제 소비 바이트에 결합 | `505ebac`, 회귀16개 통과·독립 검토. 기존 자원 메타데이터와 정확한 신규 ID 정리 검사 유지 | 이번123 SQL 실제 실행 전 | 행사 변경을 고정한 새 HEAD·새 intent·새 대상에서 실행 |
| 4.4 | 직접 입력 행사 및 행사 변경 합의 구현 중. 기존 상세 응답의 키를 보존하고 별도 `/posts/:id/event-link`로 확장 | HTTP 관련42개 통과. 기존 상세 exact 키 불변 SQL 사례 작성. 운영·실제 Auth 미실행 | 독립 검토에서 종료된 제안의 재요청이 대기로 표시되는 결함 발견. 소비 ticket 캐시까지 함께 수정 중 | 종료 상태·응답 유실 재시도 회귀와 독립 재검토 후 실제 SQL 실행 |
| 4.5·4.6·4.8 | 실제 Auth와 마감 경합 검증의 현재 소스 연결 준비 | 새 실행 전 4서비스·Auth3600·전체 자원/소스 목록·실제 발급 JWT를 확인하도록 분리 | 과거121 대상·토큰·intent를 재사용하지 않음. 마감 결함의 실제 경합 재현은 미실행 | 현행 소스의 새 격리 Auth 환경과 정확한 합성 업무 fixture 준비 |

이전 실제 AI SQL 영수증은 [기존 증거](2026-10-20-current-runtime-evidence.json)에 보존한다. 해당 PASS는 합성121 archive의 새 사본에 AI migration을 적용한 SQL 검증이며, 전체 신규 설치·실제 Auth·회원·모델·운영·Storage 전체 복원 완료를 뜻하지 않는다. 커밋은 승인된 로컬 범위이며 원격 푸시는 하지 않는다.


## 실제 서버 SQL 첫 실행과 보정

- WBS4.4·7.11: `d7327d5`의 새 행사 SQL을 새 합성 DB에서 실행했으나 권한 오류로 `FAIL_CLOSED`였다. 영수증은 `/private/tmp/yumidang-server-sql-20261021-a001/execution/receipt.json`이다. 신규 대상은 정상 중지·보존했고 기존 자원 메타데이터는 동일했다. 최소 가용 메모리는2,299,916KiB, 실제 Auth·회원·공급사 호출·운영 변경은0이다.
- 원인: archive의 기존 security-definer 함수 소유자는 postgres인 반면 새 함수 소유자는 migration 실행자인 supabase_admin이었다. 기존 함수가 새 private 함수를 실행할 때 권한 오류가 났다. 임의 EXECUTE 부여 없이 기존 migration의 동적 소유자 정렬 방식을 대조해 수정 중이다. 기존 실패 영수증은 변경하지 않는다.
- WBS7.11·4.8: 현행 Auth4역할 준비 도구를 `c660c61`에 로컬 커밋했다. 독립 검토가 발견한 늦은 import와 loader 재검증 문제를 수정했으며 실제 helper bytes·오염된 모듈 캐시를 포함한19회귀가 통과했다. 기본 NOT_RUN이며 실제 Auth 실행 adapter는 후속이다.
- Notion7.11의 해당 TASK 본문에10월21일 진행 기록을 저장·재조회했다. 부모 WBS 하단에는 추가하지 않았다.


## 서버 SQL 재실행 통과

WBS4.4·5.7·7.11: 기존 호출 체인의 owner에 새14함수·2테이블을 맞춘 `62e52d8`로 새 대상에서 AI·행사 migration2개 및 SQL 회귀4개를 실행해 **PASS_SQL_ONLY**였다. [영수증 요약](2026-10-21-server-sql-evidence.json)에 최초 실패와 새 성공의 원경로·SHA를 함께 연결했다. 행사 전용 저장·검색/공개 DTO·구형 상세 exact 키·행사 합의·최초/재시도·종료 상태·권한/RLS와 이전 AI/요약/완료 동의 회귀를 포함한다.

새 대상은 정상 중지·보존, 기존 자원 메타데이터 동일, UNKNOWN2 유지, 최소 가용 메모리2,288,432KiB였다. 기존 저장 바이트 전체·깨끗한123 신규 설치·실제 Auth·앱·회원·공급사·운영·전체 복원은 이 PASS에 포함하지 않는다. 다음은 정확한123 SQL 해시의 준비 프로필 등록, 현행 새 Auth4역할과 실제 인증/마감 검증이다.


WBS7.11·7.14: `38bae72`에서 검토된 두 추가 migration의 정확한 SHA를 등록했다. 신규 준비 프로필10회귀·기존 source manifest9회귀가 통과했다. `/private/tmp/yumidang-current-auth-preparation-20261021-a001/prepared`에 현행123개 SQL·188개 소스 핀의 새 Auth 준비 artifact를 만들고 loader로 실제 재검증했다(`READY_PREPARATION_ONLY`, manifest SHA `0b418eb540a4520a21b17fad241e4d295b035334c1205cf38e6e0407cb028bd3`). 이 준비에서 Docker 명령·실제 Auth 발급은0이다. 새 실행 adapter는 독립 검토 중이며 실행 전 최종 HEAD로 다시 준비한다.

Notion4.4 해당 TASK 본문에62e52d8의 실제 SQL 통과·실패 보존·검증 범위·잔여 조건을 저장하고 재조회했다. 해당 TASK의 기존 체크박스·진행 속성은 변경하지 않았다.
