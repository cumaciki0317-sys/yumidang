# 배정된 담당자의 신고 증거 Storage 접근 후보71

민규 진행률63.5%를 유지한다. 이 후보는 기존70의 폐쇄된 승인/사건 배정과 제출 metadata 읽기에 실제 Storage 권한 경계를 추가한다. 직원 HTTP·파일 bytes 전송·운영 판정·통지·이의 전체 절차 완료와 구분한다. 신규 CLI migration은20261005150558_assigned_report_capture_access.sql이며 immutable70 296cc4fc48fce2f66f1ad72d10b39b3a12d2f7a225033a61fb8ab2b56a4486fd를 재사용한다. actor minkyu의 독립 clone만 편집하고 B handler/index와 root main을 수정하지 않는다.

## 최소 권한과 실제 전달의 구분

새 private.assigned_report_capture_storage_read_allowed(name,owner_id)는 검증된 authenticated/nonanonymous 사용자에 대해70의 auth.users→session→명시 approval→사건 assignment 순서로 공유 잠금을 잡는다. 프로필이나 네이버 가입 자격이 직원 권한을 증명하지 않는다. 대상은 attached 상태이며 해당 report에 실제 배정된 capture만이다. owner/경로·객체ID·MIME·size는 기존 assigned_report_capture_json으로 재확인한다. report의 이의 포함 최종 종결+90일 retention_due_at이 지났으면 직원도 읽지 못한다. 원문 DB 채팅·다른 사건·전체 목록·AI/worker에는 권한을 열지 않는다.

새 helper는 RLS boolean만 반환한다. owner는 기존70 public.get_assigned_report_capture의 owner이며 신규 table grants/role/직원 승인/배정 행을 추가하지 않는다. 기존 schema/function/table/sequence 실효권한과 gateway의 owner USAGE/SET 가능 여부를 preflight해 불일치55000으로 중단한다. private helper 실행은 Storage predicate가 필요로 하는 authenticated에만 제공하고 PUBLIC/anon/service_role은 회수한다. 원문 metadata 반환 helper 및 승인 변경 helper의 닫힌 ACL은 보존한다.

기존 report_capture_owner_read는 report-evidence 버킷이며 object owner가 auth.uid()와 같은 경우에만 이전 회원 helper를 호출하는 CASE로 변경한다. 비회원 직원에게 기존 require_report_member 예외가 발생해 permissive OR 전체가 실패하는 것을 방지한다. 본인 회원의 기존 소유권/회차/감사/retention 조건은 이전 helper 그대로 유지한다. 그 helper 본문과 기존 upload/delete policy는 변경하지 않는다. 신규 permissive staff read는 reportbucket에서만 새 predicate를 호출한다.

## operation 제한과 접근 회수

report-evidence의 restrictive SELECT는 canonical authenticated GET·info·HEAD info와 기존 업로드/삭제 metadata 작업만 허용한다. staff predicate는 그중 GET/info/HEAD 세 종류만 허용한다. staff에게 upload/delete 권한을 주지 않는다. 서명/sign_many·signed upload·변환·S3·TUS·list·copy·move·upsert·미설정/미지 operation은 허용목록 밖이다. signed upload 발급은 INSERT 검사이므로 별도 restrictive INSERT로 canonical upload만 남긴다. 기존 member reserved 업로드 및 cancelled 객체 삭제 가드는 그대로 적용된다.

승인/배정의 exclusive 회수와 읽기의 share 잠금은 같은 행에서 직렬화된다. 세션 존재와 not_after도70 guard를 재사용하며 새로운 inactivity 정책은 만들지 않는다. 실제 두 세션 경합은 NOT_RUN이다. retire한 신고자의 report-evidence는 profile-images 삭제 task와 분리되어 보고서 보관 정책에 따라 남고, 다른 배정 담당의 읽기에는 탈퇴한 신고자의 active profile을 요구하지 않는다. 신고자가 탈퇴했다는 이유로 제출 증거를 지우거나 기한을 다시 계산하지 않는다.

기존 report_access_audit의 storage_read action으로 정확 actor/report/asset 접근을 남긴다. 이는 권한·metadata 접근 기록이며 Storage가 bytes를 실제 전달했다는 영수증이 아니다. 설명·캡처 bytes·token·signed URL을 감사에 복제하지 않는다. 기존 신고/asset 종결·삭제 관계와 audit cascade를 보존하고 별도 audit 보관기간을 임의로 확정하지 않는다.

서명 발급 차단은 새 token 생성에 대한 경계다. 과거에 이미 발급한 회원 signed URL과 Provider/CDN token은 이 RLS 변경만으로 즉시 회수됐다고 주장하지 않는다. 새 staff 경로에는 기존 서명 발급 권한이 없었으며 이번에도 추가하지 않는다. 실제 서비스 전환에서는 reportbucket의 과거 발급 이력/만료·삭제·CDN 영향과 회원 UI의 authenticated 읽기 연결을 확인해야 한다.

## 검증 계획과 현재 상태

assigned_report_capture_access.sql은 실제 public 가입 및 owner 합성 신고/attached metadata를 준비한 BEGIN/ROLLBACK 회귀다. 회원 own read/타인 거절, 기본 staff0/미배정 거절, 프로필 없는 approved+assigned Auth staff의 GET/info/HEAD, 다른 담당 사건 거절, staff서명·변환·token·upload/delete operation 차단, owner 서명차단, canonical reserved upload→confirm→cancel→delete, signed upload INSERT거절, 승인/배정 회수·session not_after, 잘못된 metadata MIME/size/owner, 실제 신고자 retire 후 staff 접근 유지, 최종종결+90일 만료거절, ACL/roles/guard/worker 보존을 검사하도록 작성했다. 합성 Storage metadata는 실제 파일/blob 존재나 공급사 이미지 디코딩 증거가 아니다.

root가 실제 격리 native70에서 전체 SQL71과 회귀를 하나의 BEGIN/ROLLBACK 트랜잭션으로 실행해 후보 SQL PASS를 확인했다. SQLexit0이며 복원 검사14개가 모두 true다. 영수증은 /private/tmp/yumidang-report-capture71-reviewed/receipt.json, SHA d16bec8b120e654952ab6095992176c699ee7796d761c02651c6ca9f1c4ec115다. 실행 runner SHA는3532bf19ad510f6ca293af888091b44e48286ce266420b5cb1f38649d8b447de이며 SQL ead3e529ce957748af590d82339f6c9c0589680b8cf465c4f5975285d994699c, 회귀 c1764263cfe43e80541218a1dd33125c742f5db7ff5c072bbb7b065c1b53bd74를 고정했다.

전체 ROLLBACK 뒤 history70, 기존 catalog·정책·owner policy OID/식·정확한 인증 감사288개 ID·역할·자료 수·guardfalse·workeridle·cleanup 권한 닫힘·파일0·보호 컨테이너·다른 활성 DB세션0·소스 핀이 보존됐다. 새71 helper/정책은 복원 후 존재하지 않는다. 원래70 적용의 validator FAIL 영수증과 시작 자료, 별도 읽기 후검증 PASS 영수증도 정확한 해시로 전후 보존했다. 이번 후보 시험은71의 정식 적용이나 원래70 적용 당시 감사 ID 검증을 대신하지 않는다.

Agent 실제 DB/API/CLI/Provider 실행0이다. root의 후속 정식71 및 실제 로컬 API 검증은 아래 기록을 따른다. 후보 SQL의 합성 metadata 회귀 PASS와 실제 파일 전달 증거를 구분한다. 운영 staff 계정·hosted Edge·모바일·통지/이의·운영 및 실제 두 세션 잠금 직렬화는 NOT_RUN이다.

후속 직원 파일 HTTP 연결은 B의 별도 배정 파일에서 구현됐으며 실제 로컬 검증 범위는 아래 기록을 따른다. 신선한 staff principal/배정 재확인·no-store·제한 bytes·최종권한 재확인·provider 실패·취소·민감로그 금지·불명확 성공 거절이 필요하다. 이번에 새로운 signer·서버·메일·운영 role을 만들지 않았다. 안내7일 epoch 사용자답과 이의 전체 연결은 별도이며 이번 독립 파일권한 구현으로 대신하지 않는다.


## 탈퇴 UID와 담당자 자격의 경계 명시

기존 상위 retired_member_storage restrictive 거절은 변경하지 않는다. 이 후보가 필요한 허용 범위는 비회원 active Auth 담당자와 다른 신고자가 탈퇴한 뒤에도 보존된 제출 자료다. 담당자 자신의 UID가 탈퇴한 경우에는 approval/assignment가 남아 있거나 owner 합성 새 세션이 있어도 Storage 읽기 예외를 부여하지 않는다. 자신의 첨부 owner CASE에서 기존 회원 helper가42501을 반환하는 경우도 파일 내용 거절이며 이를 staff권한으로 우회하지 않는다. source70의 제출 metadata RPC 계약이나 기존 helper 본문은 이번에 변경하지 않았다.

회귀에 회원 신고자1의 명시 staff approval/assignment를 추가하고 실제 retire RPC 뒤 원 auth.sessions 제거와 stale 읽기 거절을 검사한다. 그 UID에 합성 새 세션을 넣어도 Storage 읽기는 거절하고, 다른 active 승인 담당자3의 동일 증거 읽기는 계속 허용한다. 새 세션은 owner 합성 fixture로 실제 재로그인/운영 직원 인증 성공 증거가 아니다. expected28000/42501 또는 RLSfalse만 거절로 인정하며 다른 DB 오류를 성공으로 삼키지 않는다. 이 시나리오를 포함한 전체 BEGIN/ROLLBACK 후보 SQL 회귀는 위 영수증에서 PASS다. 이후 실제 bare Auth 합성 직원의 파일 bytes 전달을 확인했으며 운영 직원 로그인/배정은 NOT_RUN이다. SQL71 ead3e529ce957748af590d82339f6c9c0589680b8cf465c4f5975285d994699c 바이트와 상위 정책은 변경하지 않았다.


## 정식71 및 실제 로컬 Auth·REST·Storage·HTTP 후속 증거

root가 정식71을 로컬 격리 native에 적용하고 실제 source71 graph52로 API 12그룹 PASS를 확인했다. 실행 결과는 /var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-report-operator-native71-ST2mHj/result.json, SHA 91edc050e19998a9335c1cf70045ae57a2fc655415ef6e9ff054a24606274463이다. root의 고정 driver는246b…이며 결과의 manifest SHA는208068a523604cc3f7d6f4945770eef00d93e62b63750b92fa069d059cc032d3, Edge source snapshot SHA는a20a2cb75c46524e16275c919e426090009bf07eb5dd4b76d3d052f22eb13ec5다.

실제 신규 bare Auth 직원 JWT와 합성 owner 승인/사건 배정을 사용해 metadata RPC·Storage GET/HEAD/info·in-process HTTP를 연결했다. 승인/배정 없는 직원·일반 타인 회원·다른 사건은 파일을 받지 못했고, 배정 직원 GET/HTTP는 실제 저장 파일과 정확한 bytes로200이었다. GET 뒤 최종 RPC 재확인 전 배정 회수와 HEAD 전 회수는 이미지 bytes 없이 거절됐으며 승인 회수·logout 후 stale session도 RPC/Storage/HTTP에서 거절됐다. 이는 경로별 실제 회수 증거이며 별도의 두 세션 잠금 경합 전체 검증은 아니다. staff와 신고자 모두 single/many/signed upload/transform에서 bearer 발급이 차단됐다. sign_many의 HTTP200 자체를 발급 성공으로 해석하지 않고 bearer 없음으로 확인했다. S3/TUS 직접 프로토콜 시험은 NOT_RUN이다.

실제 신고자의 retirement processing 단계에서 첨부 신고 객체가 남고 다른 active bare 직원의 GET/HTTP는 exact bytes200을 유지했다. 실제 cleanup engine은 profile Storage DELETE200 뒤 Auth harddelete200을 처리했고 authRows0과 reportObjectRetained=true를 확인했다. processing 이전 확인과 처리 이후에도 같은 직원 조회가 유지됐다. 탈퇴한 담당자 자신의 UID는 계속 거절됐다. 이 실행의 teardown을 일반 신고 보관 만료 삭제 근거로 사용하지 않는다.

최종 정리는 정확한 인증 감사288개 ID와 payload, 전체 catalog·policy·index·column·schema ACL·roles·counts·보호 컨테이너를 복원했고 파일0·guardfalse·cleanup ACL 닫힘·workeridle·다른 활성 또는 transaction 세션0을 확인했다. 새 SQL71 ead3/test c176은 그대로다. 기존 원래70 validator FAIL 기록도 지우지 않는다.

실제 운영 직원 승인/배정·hosted Edge endpoint·모바일·운영 CDN·통지·이의·운영 판정 및 두 세션 잠금 직렬화는 NOT_RUN이다. 이 로컬 합성 직원/실제 파일 검증을 전체 신고 처리나 운영 승인 완료로 확대하지 않는다. 안내7일 epoch와 hideTarget 보관의 사용자 미정도 유지한다.
