# 회원 보관 정리 batch 초안

작업자 minkyu. 별도 worktree와 새 SQL `20261005030100_member_retention_batches.sql`만 사용한다. immutable20135/20136, 회원 탈퇴·제재·운영 판정 정책은 변경하지 않는다.

## 확정 정책과 기술 구현

PLAN 5·6과 정책 13에 따라 탈퇴 공고 일반 본문은 탈퇴 후1년, 대화는 마지막 활동과 관련 절차 최종 종료 중 늦은 시점부터1년이다. 내부 정리의 한 번 처리 예산은20건이다. 법적 근거·백업 삭제·운영 절차 준비는 별도로 확인해야 한다.

- 공고 본문, 보관 동의 본문, 대화 한 건을 각각1건으로 세어 최대20건을 공유한다. 원본 메시지와 첫 신청 `join_requests.message` 복제 본문은 같은 트랜잭션에서 제거/보관 종료 안내로 교체한다.
- 일반 종료 대화도 실제 종료 상태와 종결 receipt를 검증한 뒤 owner 포트에서 등록한다. 탈퇴 대화만 처리하는 제한을 두지 않는다. 진행 신청의 status만으로 절차를 종결하지 않는다.
- 대화의 `last_activity_at` 앵커와 `purged_at`/`last_purged_at`을 별도로 기록한다. placeholder UPDATE가 갱신하는 `updated_at`을 새로운 실제 활동으로 오해하지 않고, 이미 처리한 대화는 다시 처리하지 않는다.
- global worker token을 잠금 확보 전후와 각 삭제 이후 검사한다. 만료 시 전체 트랜잭션을 rollback한다. 점유 자동 연장은 없다.
- 관련 metadata 테이블 잠금은 NOWAIT로 확보하고 경합을40001로 반환한다. 진행 중 사용자 쓰기를 기다리며 서로 다른 row/table 잠금 순서의 교착을 만들지 않는다. 큐 재시도는 worker 담당 연결 사항이다.
- confirmed/disputed 약속, 열린 분쟁, 완료 후 남은 후기/분쟁 기한, 미종결 신고 또는 final_closed_at 없는 resolved 신고는 보류한다. 해당 공고의 모든 현재 관련 절차를 보수적으로 검사한다.
- 유효한 withdrawn/not_selected→pending 재활성화는 같은 세대의 이력을 유지한다. 실제 상태 전이·새 메시지의 마지막 활동 앵커를 갱신하며, 후속 실제 종결을 검증한 뒤 새1년 기한을 계산한다. 무관한 post metadata/placeholder 수정은 활동이 아니다.
- 이미 읽기 만료 또는 purged된 대화만 새 세대를 연다. `conversation_message_generations`의 UUID 맵으로 이전 메시지 범위를 보존하며 공개 chat 테이블/DTO에는 세대 필드를 추가하지 않는다. `conversation_generation_appointments`는 약속이 발생한 세대를 기록한다. 이전 만료 세대의 기한과 앵커는 새 활동으로 갱신되지 않는다.
- 만료됐지만 아직 삭제 보류/대기 중인 첫 신청 header는 owner-only 이전 세대 archive로 옮기고 공개 row는 보관 종료 안내로 교체한다. 미종결 절차 원문을 임의로 삭제하지 않는다. 실제 batch는 해당 만료 세대의 메시지/header만 삭제하고 활성 새 세대의 원문은 보존한다.
- 세대별 `read_until`과 삭제 대기 `purge_after`는 구분한다. 이미 읽기 만료된 원문의 cutoff는 실제 후속 절차 때문에 삭제를 더 보류하더라도 되돌리지 않는다. 후속 최종 절차 검증은 삭제 허용 판단이며 만료 원문 재공개 허가가 아니다.
- native chat SELECT, native join_requests header SELECT, list_conversation_messages/get_conversation/list_conversations 및 기존 list_sent/list_received 신청 조회 모두 동일한 cutoff를 적용한다. SECDEF 우회도 막는다. 기존 OUT/default/retired 상대 별칭을 유지하고 listConversations의 마지막 메시지는 읽기 가능한 메시지만 사용한다. 기존 읽기 helper OID와 외부 ACL은 유지한다.
- 신고 UUID와 관련 공고 UUID만 링크해 chat 삭제 뒤에도 해당 신고의 관계를 보존한다. 접수 대상 검사와 INSERT 사이에 chat가 삭제됐으면 AFTER trigger의 재검사가 전체 접수를 rollback한다. 신고 설명/캡처/원문을 복제하지 않는다.

## owner 종결 포트와 미연결 범위

`private.record_member_retention_closure(postId,requestId|null,receiptId,finalClosedAt,sourceSha256,workerRunToken,generation|null=현재세대)`는 실제 운영 workflow가 모든 관련 절차의 최종 종결을 검증한 receipt를 전달하는 닫힌 포트다. 단순 status나 현재시각으로 종료를 자동 합성하지 않는다. 입력 hash 자체를 외부 evidence의 진위를 검증한 것으로 취급하지 않는다. owner gateway가 발급한 원증거 검증/권한 배정은 아직 미연결이다.

동일 receipt의 대상/시각/hash/metadata가 바뀌면40001이다. target+generation+metadata와 target+source evidence의 immutable unique key로 새 UUID를 사용한 동일 종결자료의 시각 연장도40001로 막는다. 새 신고·분쟁·해당 세대의 활동 metadata가 바뀌면 기존 receipt가 stale이므로 purge를 보류하고 다시 검증한다. post receipt는 공고/동의 본문, request receipt는 해당 대화 세대/동의 본문에 연결한다. 공고와 대화의 보관 종료 앵커는 서로 바꾸지 않는다.

제재21810 담당자는 사건·이의 최종 종결 workflow가 없음을 확인했다. 관련 safety incident/report link 또는 appointment appeal 행이 존재하면 현재는 resolved 상태와 무관하게 보류한다. 원문이나 최소 안전 identity 삭제는 하지 않는다. 실제 최종 종결 gateway가 준비된 뒤 이 경계를 별도 수정·검증해야 한다.

55의 private 무인수 purge와 두 인수 무근거 closure는55000으로 닫는다. 신규 `private.purge_expired_member_retention(workerRunToken,limit=20)`도 사용자/service 권한은 닫는다. 내부 transport 연결용 `public.purge_expired_member_retention(workerRunToken,limit=20)`는 worker JWT 역할과 fence를 검사하고, service_role EXECUTE도 아직 열지 않는다. M internal allowlist/J worker는 이번에 수정하지 않는다. 원문 없이 boolean 판정만 하는 native RLS message/header helper 두 개의 authenticated EXECUTE만 유지한다. 그 밖의 새 helper/table은 owner-only다. 향후 실제 연결 때 RPC p_worker_run_token/p_limit와 `{processed,postBodiesRemoved,consentBodiesRemoved,conversationRecordsProcessed}` exact 정수0..20 계약을 재사용한다.

## safety 소유권 조합 교정 후보

source56 단독 검증과 별도로21810·21811·30100 조합59 실제 회귀가 safety table의 EXCLUSIVE 잠금 권한42501로 실패했다. 기존30100 SHA `869df692…`는 main에서 보존했으며 이 교정은 root 승인 후 별도 worktree에서만 작성했다. 기존 단독 PASS가 safety owner 경계를 검증했다고 설명하지 않는다.

새 `private.lock_retention_safety_metadata()`는 실제 safety4 table owner의 SECURITY DEFINER로 네 metadata table의 EXCLUSIVE NOWAIT만 수행한다. `private.retention_safety_pending(report_ids uuid[],appointment_ids uuid[])`는 같은 owner로 관련 incident/report UUID·appointment appeal 존재 여부 boolean만 반환한다. core helper는 자기 소유 metadata에서 UUID 배열을 만들며 safety 원문·행·판정자료를 반환받지 않는다. core에 SELECT/UPDATE 또는 전체 schema 권한을 주는 GRANT는 없다.

두 helper EXECUTE는 기존 core 함수 owner에만 부여하며 PUBLIC/anon/authenticated/service_role은 닫는다. migration은 safety4가 모두 없을 때만 standalone core owner를 사용한다. 존재하면 정확 네 ordinary table이 모두 있고 owner가 단일이어야 하며 불일치는55000으로 전체 migration을 중단한다. 호출 시에도 table 개수/type/실제 SECURITY DEFINER owner 일치를 재확인하고 partial/owner drift는55000이다. 권한 오류를 false로 삼키지 않는다. NOWAIT 경합은40001이다. safety4가 생성된 뒤에는 helper의 owner도 같은 경계여야 하므로 선행21810 이후30100 적용 순서를 유지한다.

최신 회귀 후보는 helper의 사용자/service ACL 닫힘·core의 직접 table GRANT 없음·effective UPDATE/DELETE0·anon/authenticated/service_role의 table SELECT/UPDATE/DELETE0, 실제 report UUID 관련/무관 boolean, core state 보류, 부분 스키마/함수 owner 드리프트55000을 추가했다. 드리프트 fixture는 BEGIN 안에서 함수 owner만 잠시 교체하고 복원하며 safety table 권한을 core에 부여하지 않는다. 실제 global role 생성/변경은 하지 않는다. 교정 SQL의 실제 fresh apply와 전후 table ACL·글로벌 role hash 불변 검사는 PASS였으나, 회귀의 core SELECT0 추가 assertion은 FAIL이었다. 최초 default ACL 때문이라는 추정은 실제 metadata로 정정했다: core postgres는 rolsuper=false/bypassrls=true이고 기존 pg_read_all_data의 inherit_option=true membership으로 SELECT가 유효하다. safety4 relacl에는 supabase_admin owner 권한만 있으며 명시 core GRANT가 없다. 이번 SQL은 raw GRANT를 추가하지 않고 기존 역할·ACL을 유지한다. 기존 상속 읽기 권한의 회수는 이 교정 범위가 아니다. 이 FAIL 기록을 보존하며 테스트만 실제 기준에 맞췄다. 수정된 테스트의 재실행은 아직 NOT_RUN이다. 전후 ACL·역할 hash 불변은 별도 실제 fresh apply runner에서 계속 확인해야 하며, BEGIN/ROLLBACK 테스트 단독 PASS로 대체하지 않는다.40100 예약 초안은 보존 대기한다.

## 이전 후보 검증 상태

source56 이력56과 profiles/auth/member_episodes 합계0을 읽기 확인하고 schema-only dump를 새 `yumidang_member_retention_20261005`에 복원했다. source/native/운영 데이터·guard·권한 및 전역 역할은 변경하지 않았다. 30100 전체 실제 적용은 PASS였다. 첫 회귀의 PL/pgSQL alias 충돌을 고쳤으며 합성 fixture의 공고 status 오류도 교정했다. 이후 세대별 만료 원문/RPC/native SELECT,20+잔여 batch, global 문장중간 만료 rollback, 일반 종료 대화, 유효한 대화 동일 세대 재활성화/활동 앵커, 만료 대화 새 세대/활성 메시지 보존, 절차 보류/ACL 합성 BEGIN/ROLLBACK 회귀가 PASS했다.

read_until 보완 후 source56 schema-only를 같은 전용 scratch에 새로 복원하고 최종 후보 전체30100을 처음부터 적용한 증거도 PASS다. 최신 단독 회귀는 실제 PASS이며, 아직 삭제되지 않은 원문을 authenticated native SELECT에서도 숨기는 검사와 실제 후속 절차로 보관 기한이 늘어도 읽기 cutoff가 되돌아가지 않는 검사를 포함한다. 무작위 UUID 두 세션 harness는 NOWAIT 즉시 거절, purge transaction 뒤 재활성화 대기/새 세대 메시지 보존, finally fixture0을 실제 확인했다. 임시 harness 경로는 `/private/tmp/member-retention-concurrency.py`다.

기존 main SQL 호환은 먼저12개 PASS 후 member_reports의 schema-only report-evidence bucket seed 누락으로 중단한 실패를 보존했다. 버킷의 실제 제한(비공개/5MiB/jpeg·png·webp)을 합성 BEGIN 안에 넣어 rollback하는 fixture로 보충했다. 최신 최종 fresh 후보에서 신고/current_member_lifecycle/member_cleanup_dependencies3개가 실제 PASS했다. 이전12 PASS와 최신3 PASS는 각각의 실행 결과이며, 최신15개를 한 번에 실행했다고 표시하지 않는다. 원본/global 역할41은 이번 scratch 검증 목록에서 제외했다.

최종 인덱스를 포함한 전체 fresh apply와 최신 단독 회귀도 PASS다. 동일 최종 후보에서 두 세션 NOWAIT 및 purge→재활성화 대기/새 메시지 생존을 다시 검증해 PASS했다. 최종 합계 fixture_rows0, cleanup/AI guard false, cleanup5 service EXECUTE0, purge 사용자/service EXECUTE false, global released true를 확인했다. 운영/native source에 적용하지 않았다. 활성 handle은 없다.

초기 alias/합성 공고 enum/bucket 오류 이외에 미종결 신고 검사에서 예상40001 대신22023이1회 나온 기록도 보존한다. 상세 오류 원인을 당시 수집하지 못했고 이후 동일 검사들이 반복 통과했다. owner 포트는 미래 종료시각을 DB clock_timestamp 기준으로 거절하며 host/DB 시계 차이를 자동 보정했다고 주장하지 않는다.

모든 fixture는 rollback 또는 정확 UUID finally 정리한다. 실제 provider 파일 삭제·백업 파기·자유문 자동 가림·owner 종결 gateway 연결·제재/이의 종결 workflow 완료·직원 rawchat 열람은 이 검증 범위가 아니다.

## 교정 후보의 실제 조합 검증 결과

root가 c7877762 SQL/ec505db 테스트 후보의 실제 조합 증거를 확인해 반영했다. source56 schema-only+21810+21811+교정30100의 전체 fresh apply, 제재/활동제한/보관3회귀와 safety 연결1개, 명시 기존호환12개 합계16개 단계가 각각PASS다. 호환은 앞10개와 마지막2개를 별도 실행했으며 한 번에 전체검사했다고 표시하지 않는다. 마지막2개는 원래 마이그레이션의 빈 전역singleton을 테스트 BEGIN/ROLLBACK 안에서만 보충했다.

최종 합성자료/singleton/활성handle0, guard false, cleanup5 service권한0, raw safety ACL·전역rolehash불변·새직접core표권한0을 확인했다. 기존 inheritedSELECT는 preserved baseline이고 UPDATE/DELETE와 회원/service원문접근은 닫혀있다. 기존FAIL/fixture교정기록은보존했다. 증거는 로컬 비공개 `sanction-retention-combination-baseline-preserved/combined-final-receipt.json`이다. native56/운영/Provider/blob/실제Auth로그인이나전체저장소검증은이16개범위가아니다.
