# 민규 실행기 소비자·장애·SQL99 복구 검증 인계

기준 HEAD `edfc624`, actor `minkyu`, 전용 worktree `minkyu-foundation`. 기존 미커밋 변경을 보존했다. 신규 공개 API·제품 SQL 변경 없이 기존 종현 소비자와 민규 DB/Storage 포트를 실제로 검증했다. 검증 당시 운영·외부 AI·모바일·커밋·푸시는 수행하지 않았다. 이후 사용자 요청으로 관련 구현·인계를 GitHub에 공유한다.

## 완료 판정

**기존8/10 · 추가5/6 유지.** 이번 민규 독립 검증 범위는 완료했다. 제품 queue-runner의 TLS·전용 LOGIN·HTTPS 및 공통 예산/영속 기록 연결은 별도 미완료다. 추가 AI 피드백의 실제 성공 응답 기록 및 주기적 파기 연결도 종현 대기다. 원래 5번·추가4번을 이번 소비자 시험으로 완료 처리하지 않는다.

| 계획 단계 | 결과 |
|---|---|
| 1 계약 대조 | 아래 불일치 목록 고정. 기존 RPC와 실제 소비자 기본 wire는 통과 |
| 2 소비자 연결 | 실제 dedicated enqueue → supported claim → 취소 재계산/신고 Storage DELETE → ACK → 부재 확인 → 메타데이터 및 부모 완료 PASS |
| 3 경쟁·재시작 | 실제 두 OS 프로세스의 전역 점유 승자1명·stale token 거절. DELETE 유실은 보류, ACK 유실은 저장 ACK로 복구, 양쪽 재시작 추가 DELETE0 PASS |
| 4 읽음·피드백 | 실제 TCP 응답 유실 후 읽음 재접수 같은 위치·시각, AI helpful 유실 후6개 같은 ID, 만료/탈퇴/신고 파기 경쟁 PASS |
| 5 전체 복구 | SQL99 전체 DB+Storage 복원·권한/최소 기록 비교·확인된 삭제 재적용 PASS |
| 6 인계 | 재현 테스트3개·비공개 증빙·아래 종현 연결 요청 정리 |

## 실제 검증 환경과 재현 파일

검증은 민규 소유 `supabase_db_yumidang-release88-http`, API59621, M HTTP59642 및 J HTTP59641에서 합성 회원만 사용했다. 별도 전체 복구 대상은 기존 민규 소유 `yumidang-release92-restore` / API60621이며 이번에 SQL99 스냅샷으로 갱신했다. 갱신 전 대상의 DB dump·Storage tar도 보존했다. 운영 및 기존 정식 로컬88은 적용 대상이 아니다.

- `tests/integration/minkyu/backend_faults_local.py`: 실제 Auth JWT와 기존 HTTP 검증을 재사용한다. 두 subprocess의 singleton 경쟁, 실제 TCP 응답 유실, helpful 만료·실제 탈퇴 경쟁, 신고 파기와 같은 접수 키 경쟁, 실제 Storage 응답 유실·새 프로세스 복구를 검사한다. `--helpful-loss-only`는 AI 실제 TCP 유실만 검증하는 좁은 실행이다.
- `tests/integration/minkyu/safety_consumers_local.ts`: 기존 `createRpcSafetyConsumerPorts`·소비자 registry·작업 저장소를 수정 없이 조립한다. journal은 append+fsync로 시험 프로세스 밖에 영속화한다. 전송·ACK만 잃고 실제 upstream은 완료하는 장애를 주입한다. 외부 origin은 차단한다. 이는 제품 영속 journal 구현이 아니다.
- `tests/integration/minkyu/recovery99_local.py`: 고정 source/target만 허용한다. 전체 pg_dump/pg_restore, Storage byte hash, 함수 owner/ACL/search_path, 제약·정책·트리거, 읽음·숨김·AI receipt 원시 상태를 비교한다. 일회성 시작 marker로 무조건 재실행을 차단한다.

시험 readiness=true와 내부 operation20 cap은 시험 안전 장치이며 제품 공유 작업 예산을 정의하거나 준비 상태를 승인한 것이 아니다. 서비스 함수 EXEC·report/cancel/member-cleanup 제어는 시험 동안만 열고 finally에서 원래 상태로 되돌렸다. AI 신고 제어도 false로 복구했다. 실제 공급사 AI 전송은0회다.

최종 보존 검사에서 기존 정식 로컬88의 카탈로그14개 그룹은 변경이 없었다. 제어4개는 모두 false이며 시험 대상 함수17개의 `service_role` 유효 EXECUTE 권한은 원상복구됐다. 이 검사는 grantor·grant option을 포함한 전체 ACL 복원 검사가 아니다.

## 장애·파기 관찰

재시작 시험은 전역 점유를 명시적으로 해제하고 합성 job/task lease를 만료시킨 뒤 새 OS 프로세스로 실행했다. 이 결과는 시험의 명시적 lease 종료 후 DB fence·저장 ACK 복구이며 제품의 자동 재시작 복구 검증은 아니다.

- DELETE 응답을 버린 경우 실제 파일은 없어졌으나 ACK가 없다. 새 프로세스에서 DB dispatch fence가 재삭제·메타데이터 완료를 막았다. 이 합성 신고·작업·최소 intent는 미확정 상태로 보존했다. 부재만 보고 ACK를 만들어 넣지 않았다.
- ACK RPC 성공 응답을 버린 경우 DB에는 ACK가 남았다. 새 프로세스가 기존 ACK와 물리 부재를 확인해 추가 DELETE 없이 완료했다. 부모 job은 metadata 소비자가 원자적으로 완료하며 일반 complete_job을 다시 호출하지 않았다.
- 파기와 AI 동일 키 접수가 경쟁하면 기존 결과 또는 만료 거절을 반환했다. 파기 후 report FK=NULL인 최소 receipt가 남고 새 증거가 만들어지지 않았다.
- 새 합성 회원의 실제 JWT 탈퇴와 helpful 재접수를 경쟁시킨 뒤 helpful 및 결과 증거가 모두0개였다. 외부 Auth/Storage 회원 정리 실행은 호출하지 않았다.

## 종현에게 필요한 제품 연결

1. **공유 한도:** `allocate`의 maxJobsPerRun·enqueueLimit은 각≤20뿐 아니라 전달된 잔여 배정 이하이어야 한다. scheduler의 unitsFor 작업 수와 소비자 reserve의 enqueue/claim/task/Storage/complete 호출 수를 혼용하지 않는다. 신고 job1개에 복수 Storage task가 있으므로 claim1건을 삭제1건으로 계산하지 않는다. 최종 단위·전송 전 예약·한도 소진 시 보존 계약을 민규 공통 연결 요청으로 고정하고 실제 제품 포트로 검증해야 한다.
2. **일정 조회:** 현재 `read_worker_queue_schedule`에는 자기 전역 토큰 인자가 없어 점유 중 후속 조회가 자기 만료까지 지연될 수 있다. 기존 ABI를 우회하거나 owner 조회로 제품 권한을 대체하지 않는다. 필요한 자기 토큰 검증 인터페이스를 요청한 뒤 후속 M SQL로 연결한다.
3. **terminal 유지관리:** 기존 M 포트는 bounded purge batch다. terminal receipt의 next-due 조회·알림·반복 처리·재시작 연결이 추가로 필요하다.
4. **영속 기록:** scheduler·due enqueue·claim·task·Storage·ACK·완료의 제품 journal 저장/확정/unknown/재시작 계약이 필요하다. 이번 파일 journal을 제품 DB 영속 계약 완료로 대신하지 않는다. unknown dispatch의 새 mutation을 자동 재생하지 않는다.
5. **다른 소비자:** 기존 회원 정리 소비자에 배정 limit·signal 연결을 확인한다. event/member_cleanup을 지원하지 않는 claim_supported_job에 넣지 않는다.
6. **실제 runner:** 검증 가능한 CA·TLS DB·전용 LOGIN·HTTPS 함수 대상에서 실제 LISTEN 연결, 두 runner 경쟁, 연결 유실·재시작을 확인한다. 이번 localhost HTTP 소비자 검증은 그 검증을 대체하지 않는다.

AI 피드백 연결 요청은 [추가 백엔드 인계](2026-10-08-additional-backend.md)의 실제 성공 응답 증거 기록·주기적 helpful 파기 항목을 유지한다. 위 J 파일은 수정하지 않았으며 독립 검토 팀에도 읽기 전용 경계를 적용했다.

## 복구 증빙·삭제 재적용

비공개 증빙 루트는 `/private/tmp/yumidang-runner-recovery99`이며 Git에 백업·키·원문을 넣지 않는다. `faults-consumers-receipt.json`, `helpful-response-loss-receipt.json`, `consumer-*.json`, `consumer-journal.jsonl`, `recovery99-receipt.json`에 상태를 남겼다.

- 전체 DB 복원 직후 테이블 수와 함수/권한 비교를 통과했다. CHECK2개는 pg_dump/restore가 중첩 AND를 평탄화한 표현 차이였다. 원 CHECK를 같은 타입의 TEMP 표에 재파싱해 동등한 정의를 비교했으며 다른 제약·정책·트리거 차이는 없었다. 괄호를 일괄 지워 검사하지 않았다.
- 복원 후 읽음 위치/시각, identity 숨김, AI 제공 시각, feedback ID·hash·fingerprint·NULL report FK, 신고 false 상태를 백업 시점과 동일하게 확인했다. 제공 시각을 현재 시각으로 갱신하지 않았다.
- 별도 합성 파일 `profile-images/recovery-fixture/release99-known-delete.jpg`를 백업한 후 source에서 DELETE200·부재를 확인했다. 복원에서 다시 나타난 bytes를 검증한 뒤 target에 확인된 삭제1건만 재적용했다. 이 파일은 복구용 canary이며 실제 회원 삭제 증거를 대신하지 않는다.
- 시작 직후 target GET이 연결 종료되어 DB/Storage 복원을 반복하지 않았다. 이미 복원된 대상만 읽기로 확인하는 `--verify-restored-storage-and-reapply`로 마무리했다. 읽기 준비 재시도와 mutation 재시도를 분리했다.
- 재삭제 dispatch marker를 먼저 저장한다. DELETE 결과가 불확실하면 동일 모드를 자동 재실행하지 않고 원 intent를 보존한다. 결과 확인·권한 검토 없이 ACK를 합성하거나 과거 삭제를 전체 재생하지 않는다.
- 복구 시작·삭제 dispatch marker는 배타 생성하며 파일과 부모 디렉터리를 fsync한 뒤 진행한다. 별도 임시 폴더에서 동시 생성 시 승자1명과 기존 기록 덮어쓰기 거절을 검증했다. 실제 전원 장애 시험은 수행하지 않았다.

복구 후 탈퇴 trigger가 INSERT만으로 정리하지 않는 점을 고려해, 실제 운영 복구에서는 백업 이후 탈퇴·파기 tombstone/확정 삭제 원장과 대조한 뒤 공개해야 한다. 최소 신고 receipt·숨김을 버리거나 만료 시각을 연장하지 않는다. 이번 운영 복구 활성화는 수행하지 않았다.
