# 배정 신고 판정·원 사건 정정 후보

작업자 minkyu, 하네스 C. 정식 source73의 검토 시작·상태 읽기·직원 배정 경계를 재사용한다. 운영자 조유미라는 이름이나 일반 회원 네이버 자격으로 직원 권한을 추정하지 않는다. 이 후보의 root 실제 SQL 단일 TX 회귀는 PASS다. HTTP/두 세션 실제 실행은 NOT_RUN이며 agent DB/API/Provider/CLI 호출은 0이다. 실제 운영 담당자 승인·배정은 미설정이다.

## 파일과 기존 연결

- `backend/supabase/migrations/20261005171606_assigned_report_adjudication.sql`
- `tests/database/minkyu/assigned_report_adjudication.sql`
- 이 요청 문서

CLI로 생성한 빈 leaf는 root가 예약한 정확 파일명으로 독립 복제본에 복사했다. immutable70~73 및 runtime graph52, 기존 client/HTTP/B 파일은 이 SQL 후보 단계에서 변경하지 않는다. 이후 승인된 C 전용 client/test 확장은 별도 후보로 전달한다. C3 소유권과 최신 root 하네스 경로를 검사했다.

현재 유효 `record_incident_revision`은21810 생성 본문에21811의 계정·프로필·회차 UPDATE NOWAIT와 활성 회차 포함 패치가 적용된 함수다. 원 사건 revision/제재 시계/회차 및 당도 최대1기여 계산을 그대로 사용한다. 약속 hold 정상/불발 정정은40900·41000의 `resolve_appointment_review`로 처리한다. 이 함수들은 판정·귀책·통지·최종 종결을 자동 추정하지 않는다.

## 정확 입력

`adjudicate_assigned_member_report`는 typed12인수 RPC다. HTTP에서 reportId는 path에만 두고 나머지11개 body key를 받는 계약이다. B가 제안한 경로는 `POST /operator/reports/:id/adjudications`이며 실제 HTTP 연결은 별도다.

| SQL 인수 | HTTP key | 값 |
| --- | --- | --- |
| p_report_id uuid | path reportId | canonical UUID |
| p_client_request_id uuid | clientRequestId | 멱등 UUID |
| p_mode text | mode | initial / correction |
| p_expected_report_version bigint | expectedReportVersion | 1..9007199254740990 |
| p_expected_hold_version bigint | expectedHoldVersion | 약속 신고는1..9007199254740990, 일반 신고는명시 null |
| p_expected_incident_revision bigint | expectedIncidentRevision | 0..9007199254740990; 신규/없음0, 기존정정은현재revision |
| p_appointment_outcome text | appointmentOutcome | normal / no_show / unchanged |
| p_incident_outcome text | incidentOutcome | none / confirmed / invalidated |
| p_responsible_role text | responsibleRole | none / author / companion / both / target |
| p_representative_reason_code text | representativeReasonCode | 아래 조합의 유한 코드 |
| p_violation_class text | violationClass | none / minor / major |
| p_violation_type text | violationType | 아래 코드 또는명시 null |

actor/user/identity/episode/약속/사건 ID, 감점·제한일수·적용시각·통지시각·이의기한, 원문·임의 subjects JSON은 받지 않는다. victim을 확인할 입력/근거가 없으므로 victimIdentityId는 NULL이다. 책임자로 명시한 상대와 신고자가 곧 피해자라고 기록하지 않는다. 목격 신고가 가능하다.

### 코드·조합 행렬

| incidentOutcome | class/type | responsibility | reason | 추가 조건 |
| --- | --- | --- | --- | --- |
| none | none / null | none | no_action | normal 또는 unchanged |
| none | none / null | none | no_show | 약속no_show. 불발 사실만이며 귀책·감점·제재없음 |
| invalidated | none / null | none | decision_corrected | correction, 기존사건revision>0 |
| confirmed | none / null | 명시당사자 | no_show | 약속no_show. 책임자로 선택한 당사자만운영기여−3 |
| confirmed | minor / spam 또는rule_violation | 명시당사자 | type와동일 | 명시저위험 판단. 성희롱·위협·개인정보 노출을minor로받지않음 |
| confirmed | major / sexual_harassment, threat, violence, stalking, privacy_exposure, sexual_exploitation | 명시당사자 | type와동일 | 확정중대판단, 즉시영구제한·운영기여−10 |

none/no_action+no_show는 불발이므로 reason no_show를 요구한다. none/no_action의 AP 결과가 no_show인 다른 조합은 보완 검토에서 명확히 거절하도록 유지한다. 약속 신고는 고정author/companion/both만 책임자로 선택할 수 있다. both는 사람이 명시한 양쪽 책임 선택이며 no_show에서 자동 설정하지 않는다. 일반 member/post/chat 신고는 target만 선택하고 AP outcome은unchanged다. 위반과 정상 동행은 별개이므로 normal+confirmedmajor도 가능하다. no_show+confirmedminor/major는 불발 사실과 명시 위반을 동시에 처리하며 같은 사건·회차의 운영기여 중 큰 하나만 사용한다.

유한 spam/rule_violation 코드는 신고 양식의자동분류가 아니라 정책6-3의명시저위험판단에사용하는기술분류다. major 코드는정책6-3에명시된안전침해분류다. 신고 reason_codes를 위반으로 승격하지 않는다. 독립검토 후 root/B가이코드집합을확정해HTTP strict decoder로연결해야한다.

초기판정은 이 report의 기존 판정 receipt와 사건revision이없을때만 허용한다. correction은 기존 receipt 또는 사건revision이 있어야 한다. 원 사건이 이미 연결됐는데 incidentOutcome none으로 효과를 남긴 채 no_action/normal로 표시하는 것은55000이다. 명시 invalidation 또는 confirmed 정정으로 처리한다. 새 사건으로 원 제재·회차를 갈아끼우지 않는다.

## 서버 도출과 반환

약속의 author/companion·회차는 `appointment_member_episodes` 고정 두 회차와 실제 posts/join_requests 관계에서 얻는다. member 대상은 해당 profile의 유일 회차, post는author, chat은sender_id metadata만 읽는다. 채팅 body·신고설명·캡처 bytes를 판정 입력 도출에 읽지 않으며 직원 rawchat/table권한을 추가하지 않는다. 회차가없거나 여러개/identity가없거나 chat이이미없으면명시55000이다. event제공처는회원으로변환하지않는다. event의no_action은구조화결정만기록할수있지만회원제재는event_operator_workflow_unresolved55000이며제공처조치workflow는전체목표후속이다.

한 report에 사건이여러개이거나 같은 사건에 다른report가연결되면 ambiguous55000이다. 다른linkedreport의담당권한을묵시승계하지않는다. 사건합침·다수사건정정은전체목표의후속연결로남아있다.

성공 반환은 exact5 `{reportId,status:"reviewing",version,decisionId,alreadyApplied}`다. version은expected+1이며status변경trigger가more_evidence→reviewing에도한번만증가하도록검사한다. 같은 actor/request/정규입력해시는원래version/decisionId와alreadyAppliedtrue를반환한다. 현재상태와과거영수증을혼동하지않는다.

새 `get_assigned_report_adjudication_state(p_report_id)`는 exact5 `{reportId,status,version,holdVersion,incidentRevision}`다. holdVersion은약속hold없으면null, 있으면1..MAX다. incidentRevision은없으면0, 있으면현재0..MAX다. reportversion은1..MAX다. 기존73 state3키와70 metadata6키는불변이다. getter는staffguard→reportSHARE→서버연결조회→freshguard/보관기한→read audit이며약속/identity를역순잠그지않는다.

판정성공이최종report종결을뜻하지않는다. report는reviewing으로남고final_closed_at/retention_due_at/notification/appealDeadline을생성하지않는다. 실제통지·이의·최종종결은전체완료요건으로남아있다.

## 잠금·원자성·폐쇄 경계

staff의Auth user→session→approval→assignment guard, actor/request advisory, 사건advisory, account(subject순)→profiles(UUID순)→원회차·기존subjects·identity현재활성회차(profile/id순) UPDATE NOWAIT→identity UPDATE→appointment UPDATE NOWAIT→report UPDATE NOWAIT→hold/incident다. 잠금후reporttarget/party/기존incidentlink를다시비교한다. 기존ownerhelper는같은선점잠금에재진입한다. NOWAIT충돌은40001이며자동retry/잠금완화가없다. 새actorprofile대기잠금을추가하지않는다.

원 사건·회차를유지하고confirmed/invalidated revision,제재재계산,당도재계산,hold해소,reportversion,최종freshstaff/retention검사,성공receipt가같은TX다. 중간오류는전부rollback이다. 현재미결hold/legacy분쟁이있으면기존helper가동행·후기재개를보류한다. 원제한applied_at/period는기존helper의원사건정정기준을유지한다. 임시후기숨김의점수유지/최종무효제외도원helper기준이다.

일반 첫minor warning은명시저위험판단으로지원하지만12개월내다른current confirmedminor가있으면notice/recurrence authoritative evidence부재55000이다. notified_at NULL을안내성공으로보지않고report접수시각을위반재발시각으로대체하지않는다. 심사·정정으로제재기간을재시작하지않는다. 같은피해자재발도victimNULL인현재단계에서는미지원이다. 7일/30일단계전체요건은후속근거포트가필요하다.

최초과거회차효과/회차이동은원21811/helper의55000을유지한다. 기존원회차의invalidation은가능하나회차종료뒤새confirmed효과는원검증이허용하지않으면그대로거절한다. 재가입UUID로원받은후기/제재사건을임의옮기지않는다. 법적최소identity보관근거와일반7일notice epoch·개인신고hideTarget90일은미정기준을만들지않는다.

migration preflight는trusted canonical owner/게이트웨이USAGE와SET불가,auth schema/helperEXEC,현재표RLS우회/정확owner와필요실효권한을검사한다. 부족하면55000이며rawgrant/rolemembership을추가하지않는다. 새receipt/helper는사용자·service_role폐쇄이고공개staffRPC2만authenticated EXEC다. 이EXEC는승인·session·배정검증의대체가아니다.

## 후보 검증과 남은 실제 증거

SQL회귀는기존실제회원가입/공고/신청/확정/신고/검토시작fixture를재사용한BEGIN/ROLLBACK이다. bareAuth직원,명시노쇼책임,normal+major/원사건invalidation·당도복원,firstminor와미통지repeat거절,멱등/서로다른payload/3버전stale/안전정수MAX,중간receipt·최종session실패전체원복,다른linkedreport거절,권한·익명·metadata mapping/ACL, major→major의 원 제한 시각 보존, 종료 회차의 최초 효과 거절을 검증한다. 보관 만료와 실제 대기 중 보관 경계는 추가 통합 검증이 필요하다. ASSERT를 켠 root의 정식 source73 단일 TX 실제 후보 적용·회귀·전체 롤백은 아래 영수증에서 PASS로 확인됐다. 정식 migration 배포와 두 세션 검증은 별개다.

전체완료에는HTTP strict body/동일직원JWT연결,실제담당자판정/정정API,두세션판정↔탈퇴/동시판정/파기·취소경합,notice배송·본인알림·이의접수·판정·최종종결,기간/관계입증된minor재발,사건묶음/제공처·AI결과대상조치,모바일·운영배포가남는다. 이번SQL후보로읽기만구현한것을전체판정workflow완료라고부르지않는다.


## 첫 실제 후보 실패와 변수명 교정

Root가 첫 후보 SQL `8d7535ded428bb869c86a1ffa0cba4c0de22f15b48dfc2ea8931bcaecf2cf161`을 정식 source73에서 단일 TX로 실제 실행했으나 SQLSTATE 42702로 실패했다. `assigned_report_party_metadata`의 PL/pgSQL 회차 행 변수 `e`와 JOIN 별칭 `e`가 충돌했다. 첫 실패의 `/private/tmp/yumidang-adjudication74-candidate-reviewed/stderr.log` 및 `receipt.json`을 보존하며 정식73 snapshot·ACL·audit288·파일·보호 컨테이너 원복은 PASS다.

회차 행 변수는 `member_episode_row`로 교정했다. 읽기 점검에서 판정 본문의 JSON loop 변수 `x`도 조회 별칭 `x`와 겹치므로 `selected_subject`로 구분했다. SQL 의미·잠금·권한·허용 코드·테스트 기대값은 변경하지 않았다. 정적 이름 충돌 점검은 실제 SQL 재실행 증거를 대체하지 않는다. 교정 당시 실제 SQL 검증은 NOT_RUN이었다. 이후 아래 단일 TX 후보 검증이 PASS로 확인됐다. client/test 및 B HTTP 계약은 불변이다.


## 교정 후보 실제 SQL 검증

Root 영수증 `/private/tmp/yumidang-adjudication74-candidate-alias-reviewed/receipt.json` SHA `4f2712f38fc8de8eec208c7694dd6f0ef6b3c0ba525fcf3d24313626fe4b6eab`은 `candidate74_on_native73_single_tx_rollback` PASS, sqlExit 0을 기록한다. 고정 SQL `d2e3b141ea5ad7048d075f1568f7afd6fc1320e3daa4f71163b252a91b825133`과 test `0a369a7fa799400ee5c95678c5a1a91f49d821170ac99a0f558a894294b02b2b`가 실제 실행됐다.

전체 catalog·counts·policies·audit288, 정식73 증거, 보호 컨테이너, 파일0, 다른 활성 트랜잭션0, 폐쇄 cleanup 권한의 복원을 모두 확인했다. migrationCommitted는 false이며 정식 history는73이다. remoteCompletionUncertain false, autoRetry false다. 시퀀스 현재값의 복원은 이 검증의 주장 범위가 아니다.

첫 42702 실패 영수증 SHA `f4e2ad49ea49b65fa4dbbf400923cc3b17235a9c077ef4ea356380e5de49bfad`와 stderr를 삭제하거나 성공으로 바꾸지 않는다. 모형 client15 및 B HTTP29 결합44 PASS는 실제 HTTP 증거와 구분한다. 정식74 배포·실제 Auth/HTTP·Provider·두 세션·운영 담당자 배정·통지·이의·모바일·운영 배포는 아직 NOT_RUN이다.
