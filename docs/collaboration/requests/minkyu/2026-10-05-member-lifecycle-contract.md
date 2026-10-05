# 회원 탈퇴·재가입 생애주기 초안

상태: 독립 worktree에서 최신53 schema-only + 신고54 + 생애주기 SQL 실제 적용 및 합성 회귀 PASS. 운영/원본/native API 검증 DB는 변경하지 않았다. 실제 Storage 파일 삭제·Auth API 삭제·HTTP 탈퇴 연결은 NOT_RUN이다.

## 확정 정책과 데이터 분리

- 활성 profile과 역사 party UUID를 분리한다. `profiles.id → auth.users ON DELETE CASCADE`를 제거하고 탈퇴 profile의 이름·생년월일·성별·사진·소개는 실제 NULL로 지운다. 가짜 이름·생년월일을 저장하지 않는다.
- `member_retirements(profile_id, withdrawal_id, episode_id)`가 탈퇴 영수증이며 원래 episode를 종료한다. 새 Auth UID의 가입은 기존 당도 profile trigger로 새 episode를 만들고 초기 15를 적용한다. 기존 받은 후기·약속 회차는 새 profile로 이동하지 않는다.
- `naver_identity_keys(id, subject)`와 `member_episodes.identity_id`는 동일 본인 안전 연결만 보존한다. 제재·경고·연속 취소 최소 보관의 법적 근거와 종료 조건, 탈퇴 전 사건의 재가입 후 최초 감점은 미정이다. 새로운 운영 판정이나 회차 간 감점 이동을 구현하지 않는다.
- 확정 진행 약속이 있으면 탈퇴를 거절한다. 분쟁만 남았거나 후기 기간만 남은 경우는 허용하며 약속을 자동 취소하지 않는다. 본인의 신청만 종료하고 같은 공고의 다른 신청자 동의를 종료하지 않는다.
- 탈퇴 당사자는 새 후기·채팅을 쓸 수 없다. 상대의 원래 후기 기한은 그대로 유지한다. 기존 공개 후기의 역사 대상 회차는 탈퇴 영수증으로 찾으며 새 가입 회차에는 공개 후기를 이동하지 않는다.

## 공개 및 보관 경계

- 공고는 목록에서 숨기고 정확 장소·상세 지점·사진·연락처 구조화 필드를 지운다. 역사 body와 동의 snapshot은 소유자 전용 보관 테이블에 1년 보관하며 가림 검토 중인 공개 필드는 처리중 표시를 반환한다. 일반 본문 복원/가림 검토 완료 worker는 아직 없다.
- 기존 대화는 종료된 대화의 읽기 전용 정책을 적용한다. 기존 이름 출력은 `탈퇴한 사용자입니다.`이며 나이·사진·소개는 NULL이다. 화면의 NULL/탈퇴 표시 decoder 연결은 종현 요청 대상이다.
- 채팅 보관 기준은 마지막 활동과 관련 절차 종료 중 늦은 시각부터 1년이다. 소유자 전용 record_member_retention_closure/purge_expired_member_retention helper는 구현했으나 실제 절차 종료 확인 및 purge worker 연결은 미완성이다. 원문을 자동 익명화했다고 주장하지 않으며 직원의 전체 채팅 조회나 외부 AI 원문 전송 권한을 추가하지 않는다.
- 사진 RLS는 읽는 회원과 대상 owner/첫 경로의 탈퇴 상태를 모두 검사한다. 이미 발급된 signed URL은 RLS만으로 무효화되지 않으므로 실제 Storage 파일 삭제 전 사진 접근 완전 회수가 완료됐다고 주장할 수 없다.

## RPC 및 처리 완료

`retire_my_account(p_withdrawal_id uuid)`는 인증된 본인만 호출하며 같은 영수증의 재시도는 같은 결과를 반환한다. 응답은 `{withdrawalId,status:processing|completed,memberAccessRevoked:true}`이다. 여기서 memberAccessRevoked는 신규 회원 RPC·직접 table·Storage RLS 권한을 뜻하며 이미 발급한 signed URL의 무효화를 뜻하지 않는다.

탈퇴 영수증은 `pending_cleanup` 상태로 남는다. 삭제 task의 정확한 object/task/lease/global worker token과 증거 hash, metadata/Auth user 부재를 검사한다. DB metadata만으로 실제 파일 삭제를 증명하지 못하므로 신뢰 가능한 worker의 실제 삭제 성공 및 재조회 404 증거 연결이 필요하다. 현재 external_deletion_approved=false이며 cleanup RPC는 service_role에도 실행 권한을 주지 않았다. 실제 worker·운영 승인·사진 삭제 확인 이후만 completed를 허용한다. 사용자 RPC로 완료를 주입할 수 없다.

## 정적 진입 가드와 잠금 순서

- 기존 native51 metadata의 회원 SECURITY DEFINER RPC 57개와 새 장소 변경 6인자 1개를 exact OUT/default 서명 그대로 owner-only private alias로 옮긴 뒤 활성 회원 가드로 감싼다. 일반 행사 조회와 순수 날짜·마스킹 utility는 포괄 가드를 넣지 않는다.
- `require_member_uid`, `require_service_profile`, native RLS, Storage mutation에 탈퇴 상태를 적용하여 stale signed JWT의 직접 PostgREST 접근도 거절한다. 가입 전 사진 등록의 profile/episode 없음은 허용한다.
- 공통 회원 가드: account 공유 → profile KEY SHARE → episode 공유. profile KEY SHARE는 일반 소개 갱신과 호환되지만 탈퇴의 명시 FOR UPDATE와 충돌한다. 탈퇴: subject advisory → account UPDATE → profile UPDATE → episode UPDATE → 정렬한 pair → post → appointment. 가입 완료는 account를 처음부터 UPDATE로 잡아 공유→배타 잠금 승격 경합을 피한다. 신고 가드에도 account→profile→episode 순서를 협의했다.
- 사진 mutation은 실제 Storage row 쓰기와 탈퇴를 직렬화한다. 양쪽 신규 활동은 pair의 활성 회차를 공유로 잠근다. 실제 두 세션 7개 경합을 검증했다: 전송→탈퇴/탈퇴→전송, 차단 FK→탈퇴, 회원 공유 가드, 신고 가드, Naver callback→탈퇴/탈퇴→callback. 모두 PASS이며 fixture cleanup0이다.

## 적용 전 남은 검토

- 본문 가림 복원과 채팅 purge/절차 종료 anchor, 제재 최소 연결 보관의 법적 근거는 완료되지 않았다.
- 이전 함수의 service_role ACL을 일괄 확대하지 않았다. wrapper 이전 일부 legacy service_role 권한을 회수한 범위가 기존 내부 사용에 영향이 없는지 부모 검토가 필요하다.
- 장소 6인자 SQL 및 위치 보완 SQL이 선행해야 한다. 미적용 일정 변경 제안 철회 초안은 포함하지 않았다.
- 신규 신고/운영 초안의 자체 회원 가드는 이 정적 58개 목록 밖이므로 각 담당자가 탈퇴 caller를 거절하는 공통 helper를 연결한다.
- 새 격리 DB의 전체 적용·회원 회귀·기존 SQL 호환·2세션 경합 및 fixture cleanup을 통과하기 전에는 배포 완료로 표시하지 않는다.

## 실제 검증 영수증

- source: 독립 컨테이너 supabase_db_yumidang-minkyu-drift의 postgres 최신53. dump 앞뒤 이력53, profiles/auth.users/member_episodes0을 읽기 확인하고 public/private/auth/storage/extensions schema-only만 private0600 파일로 보관했다. source에는 쓰지 않았다. 전역 역할 생성/변경은 하지 않았다.
- target: 새 yumidang_lifecycle_20261005. 단일 트랜잭션 schema-only 복원→신고15709→생애주기20135 전체 적용 PASS. 중간 권한 문제를 수정한 최종 SQL을 새 DB에 처음부터 재적용하여 별도 correction payload 없이 재현했다.
- 기존11개 rollback 회귀: 완료·공개검색·전역 lease·첫 채팅·AI 원자 요청·작업 fence·요약 fence·모집 재개·회원 차단·당도·신고 모두 PASS.
- 신규 회귀: 확정 약속 탈퇴 거절, 완료/분쟁만 남은 탈퇴 허용 및 약속 자동 취소 없음, 본인 stale JWT 읽기/쓰기 제한, 사진 대상 RLS 차단, NULL 실제 PII, 가림 검토중 본문, 탈퇴 별칭/읽기 전용, 같은 영수증 재시도, 상대 남은 후기 작성 및 기존 후기 보존, 새 UID/같은 안전 identity/새 회차15, Auth row 삭제 후 역사 party 보존 PASS. DB Auth row 삭제 검증은 실제 Auth Admin API 실행을 뜻하지 않는다.
- 신규 2세션7개 PASS 및 namespace 별 fixture finally cleanup0. 외부 파일 삭제나 운영 승인으로 대체하지 않았다.
- 기존 사진 RLS의 함수 OID를 CREATE OR REPLACE로 보존하며 원본 helper 복사는 기존 helper의 owner를 그대로 사용한다. 작성자3 legacy RPC의 OUT/default 및 미가입 P0002도 유지했다.
- 실제 파일 삭제 직전 check_member_cleanup_task와 durable ack write/read를 구현하고 합성 DB로 검증했다. 실제 adapter/API 연결 전 검토가 필요하며 guard=false와 사용자/service_role 실행 ACL 닫힘을 유지한다.

## 삭제 task 재검사와 durable ack

- `check_member_cleanup_task(p_task_id uuid,p_lease_token uuid,p_worker_run_token uuid,p_object_id uuid)`는 claim과 동일8key를 반환한다. 승인false·정확 task/현재 lease/global/object/만료·retirement 귀속을 검사하며 상태나 만료시각을 갱신하지 않는다. Storage metadata가 없어도 같은 task의 재시도를 허용하고 동일 name의 다른 object ID는 거절한다.
- `record_member_cleanup_delete_ack(...앞4인자,p_ack_sha256 text)`와 `get_member_cleanup_delete_ack(...앞4인자)`는 정확5key `{receiptId,taskId,kind,objectId,evidenceSha256}`를 반환한다. 조회만 proof가 없으면 null이다. 경로·원문·비밀키를 receipt에 저장하지 않으며 기존 최소 task의 withdrawal/profile/kind/object에 결합한다.
- 실제 provider exact DELETE200 acknowledgement 직후, 재조회 전에 현재 유효 lease에서 hash를 저장해야 한다. 동일 task의 첫 유효 ack는 수정하지 않는다. 다른 hash의 재기록은 첫 receipt를 반환하고 adapter는 불일치를 안전 실패로 처리하여 다음 시도에서 기존 proof를 조회한다.
- 새 task lease·새 global lease에서도 동일 immutable task/object의 기존 proof를 읽을 수 있다. 재조회404와 metadata/Auth user 부재를 확인한 뒤만 complete를 시도한다. complete는 durable ack가 없으면 거절하고 최종 재조회 증거 hash를 별도로 보존한다. 사용자/service_role의 모든 cleanup RPC/table ACL은 닫혀 있다.
- DELETE 응답 소실 또는 ack 기록 전 장애는 proof 없는 실패다. info404/GET404와 DB metadata 부재만으로 orphan backend bytes 삭제를 증명했다고 주장하지 않는다. 실제 DELETE acknowledgement 증거 없이 완료를 만들지 않는다. 공급사 backend orphan 처리와 실제 사진 삭제 검증은 미완료다.
- 별도 rollback 합성 DB에서 false gate/권한닫힘/잘못된 hash 형식/다른 task·object/오염된 task·receipt 귀속/만료·stale lease 거절/현재 점유 읽기 무변경/첫 ack 멱등/새 lease·새 global lease 복구/동일 name 재생성 차단/metadata 부재 뒤 기존 ack로 완료 PASS. 이 테스트의 hash는 owner synthetic fixture로 실제 provider 삭제 증거가 아니다.

## 구조화 장소 즉시 삭제 교정

- 실제 최신 `private.match_conditions` key는 공개 공고/일정/지역·본문이다. 정확 주소·상세 지점은 생성하지 않는다. 기존/legacy JSON에는 다른 key가 있을 수 있으므로 `public_retained_consent_body`는 공개 계약의 알려진 scalar/string-array key만 archive와 현재 snapshot에 보관한다. registeredAddress/meetingDetail/address/detail/newLocation 및 중첩 객체는 복사하지 않는다. 자유문 안에 적힌 식별정보의 가림은 미완료이며 owner-only 1년 보관과 별개다.
- 위치에서 파생된 `match_consents.condition_fingerprint`는 탈퇴 참여 관계의 snapshot에서 NULL로 지운다. `condition_version`은 random receipt이므로 변경하지 않는다. 새 활동의 일반 동의 함수는 기존대로 fingerprint를 생성한다.
- 탈퇴자가 참여한 약속의 일정/장소 변경 제안에서 new_location_input·old_location_fingerprint·new_location_fingerprint를 즉시 NULL로 지운다. 대기 제안만 cancelled로 종료하고 수락 제안의 상태는 유지한다. appointments 자체를 취소하거나 진행/분쟁 상태를 바꾸지 않는다.
- 기존 Naver 신규활동 trigger의 정확한 개인정보 정리 UPDATE만 예외로 인정한다: 실제 retirement가 존재하는 본인 참여 동의, receipt/version/작성자/작성시각/수락시각 불변, fingerprint NULL, 공개 allowlist와 가림 검토중 snapshot의 정확한 값. 사용자 GUC·역할 flag를 이용한 우회나 새 동의/수락 자격 예외는 추가하지 않았다.
- 신규 rollback 회귀는 실제 생성 match_conditions key, legacy 구조화 주소 sentinel이 원본/current/archive JSON에서 제거됨, condition_version 유지/fingerprint NULL, 대기·수락 제안 위치/input/hash 삭제, 완료·분쟁 탈퇴 후 약속 상태 유지, 상대 get_appointment_change_state/get_match_consent 응답 sentinel 부재를 확인했다. 실제 새 scratch 전체 적용·기존11·신규life·두 세션7개 재실행 PASS 및 cleanup0이다.

## native55 생애주기 통합 검증

전체 달성률 추정52% 유지. 탈퇴55를 공식CLI로 빈 독립 로컬DB에1개 적용했고 roles/seed 변경0이다. 준비15개·전체 함수326/326·SQL14개·실제Auth/Edge/Storage106/106 의미 검사 PASS다. API코드46파일은54 snapshot과 bytehash가동일하여 같은실행기를유지했으며 새SQL55 권한을검증했다. 합성회원/신고/안전identity 정리PASS, native P0002/500 차이2건은계속기록한다. 처음CLI연결실패와장소SQL의구형익명조회기대값실패를보존했고, 최신55 익명JWT28000거절로교정한회귀는PASS다.

실제provider의정확한사진·legacy파일명삭제직후backend파일0/Auth삭제를검증한어댑터4파일도통합했다. 여기서DBfence/ACK는합성이므로 전체탈퇴→worker→삭제완료통합증거로대체하지않는다. Auth삭제가사진정리뒤에만실행되도록별도20136 기술보완과실제연결검증을계속한다. 운영변경·모바일·자유문가림복원·법적/백업검증은완료하지않았다.
