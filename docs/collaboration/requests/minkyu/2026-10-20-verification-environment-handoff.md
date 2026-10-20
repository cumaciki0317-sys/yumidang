# WBS7.11 검증 환경·인계 대조

한국시간2026-10-20 · actor=minkyu. 이 Task의 명시 범위는 새 환경 manifest·경로/입력/대상/해시/사전 상태·실행 가능/불가와 기존 데이터 보존이다. 모든 제품/복원/운영 검증 성공을 이 환경 정리 Task의 추가 조건으로 만들지 않는다. 전체44개는 ACTIVE이고 프로젝트79%(22/28)는 유지한다.

## 고정 환경과 현재 소스

- 전용 clone `/private/tmp/yumidang-minkyu-wbs-20261017`, branch `minkyu/wbs-backend-20261017`, HEAD `1d9b46b69adbc52f693accbff04ca4a00d35c547`, actor=minkyu, hook=.githooks. 원본 clone은 변경하지 않는다.
- [현재 manifest v2](2026-10-19-source-manifest-v2.json):780파일,121SQL·187functions·417tests·29tools·26contracts. 과거119 PASS·10/18의774·10/19 최초779와 구분한다.121SQL은10/19 최초와 동일하다. manifest 자체는 실행 승인이 아니다.
- 민규 Colima daemon `879401ec-e2b7-4ad8-9915-0a16ea74e3f5`, context colima-yumidang-minkyu, 고정 socket. 시작1048576KiB·유지786432KiB·3초 이내 관측을 낮추지 않는다. 실제 Docker 접근은 승인된 sandbox escalation으로만 수행하며 권한거절을 VM중지로 오판하지 않는다.
- 사전 검토는 정확 HEAD/소스SHA·대상 ID/start/restart·경로/소유자/모드/링크·기존 container/network/volume 메타데이터를 고정한다. 대상·소스·자원이 달라지면 거절하며 우회/재시도 옵션은 없다. 원 JWT와 자격 자료는 private0600/0700에만 보존한다.

## 실행별 입력·상태·보존

|환경|소스/입력과 실제 결과|보존·정리·한계|
|---|---|---|
|10/18 새 Auth 두 문맥|[당시 완료 기록](2026-10-18-plan-completion.md), [영수증66 목록](2026-10-18-runtime-evidence.json). 원 Auth6·익명1 발급, 익명/다른문맥 실제Auth조회 후 제품401. RPC/provider/외부0.|양178table bag·권한/제약/catalog·예약 보존. 정확own8 Exit0/OOMfalse중지, network2/volume2 보존, 기존415container/158network/57volume 메타데이터 동일. 기존자원의 모든 저장bytes 검증 아님.|
|10/19 a001|실제Auth6·positive4 PASS 후 두 seed전 실패. 원seed명명불일치, 별도첫dispatch는 sandbox권한실패로 SQL0. 실패자료/소모intent를 보존하고 재전송하지 않음.|자체4 정상종료 receipt `45e2b75d910a22b2f5fe92ffa66f49724360b14ffea1f44ef44cea98be14a283`, 기존자원중지0. 네트워크/볼륨 보존.|
|10/19 a002|새 typed authority·HEAD198핀과 별도51file capsule, 실제Auth6·HTTP/REST/RPC positive4 PASS (`764cfd0a…cb233`), 합성모델/정산22. current public search SQL9 rollback PASS. 정확합성seed1회로UNKNOWN2·sequence41 생성.|positive 후fixture제거/기존Auth/예산/nonbudget보존. seed는명시SYNTHETIC_DB_SEED이며실제모델전송불확실성아님. a002자체4는현재복원source로유지중이며아직종료하지 않음.|
|b002 복원|a002백업5파일 생성 후 ICU provider를 기존도구가거절. targetIDnull/생성0인 FAIL_CLOSED.|sourceUnchanged·기존metadata 보존, child종료. 옛packet/reservation/실패영수증불변. 실패를PASS나재실행으로치환하지 않음.|
|b003 새 복원|core488fb1b2/test77e84024의locale raw-before-verdict·47회귀/독립검토PASS. 새6filecapture `329e726a8e8f11da08af38b4f71823c75097e75bcd0b314abbeae63f00c98509` PASS, 전후57MB상태원문 동일.|capture명령1659개모두exit0/childclosed, 최소2084472KiB. 복원은별도새target에서현재RUNNING이며결과미확정. source재seed/재시작0. 복원도구자동정리는신규target ID만정지하며원데이터보존. 최종상태는[실제증거](2026-10-19-runtime-evidence.json)를따름.|

## 도구 정식화·실행 가능과 불가

[10/18 도구 회귀544](2026-10-18-plan-completion.md)는 기존자원변경/잘못된대상·경로·권한·링크·Auth MFA포함정확신규행·판정전증거·실패후정리를 포함한다. 당시176 signedAuth 및AI24/midnight90 재실행은 중복합산하지 않는다. 새47복원회귀와 현재검색SQL/실제positive는 각각의범위를별도로기록한다.

현재는 검토된source/identity/메모리/단일intent를통과한 로컬 합성 검증만 실행 가능하다. a001 실패intent·b002packet은 재사용할 수 없다. 기존환경 토큰을 다른새문맥의인증으로쓰지 않는다. 업무수락/후기정상검증은AI전용profile의자격과다르므로 새typed자격fixture/정리계약 검토가 필요하다.

AI24는 준비57+33PASS까지만이며 원세션은오래돼 실제실행에사용하지않는다. 현재소스·새Auth6·선택3·원JWT·날짜/만료/시간창·영속intent·UNKNOWN·정리를새로묶어야한다. 원계획의실제자정제외조건을자동해제하지않는다. 실제회원HOLD·회원원문외부전송·공급사조건/측정·운영프로젝트권한·Storage39원본·배포/출시승인도개별실행불가근거로남긴다.

## 인계와 다음 작업

실행자는 현재HEAD와증거입력을다시읽고해당작업의새대상만선택한다. 증거는[실제목록](2026-10-19-runtime-evidence.json), [현재진행](2026-10-19-local-verification-progress.md), [전체44개대장](2026-10-19-minkyu-full-scope.json), [최신협업규칙](../../README.md)에연결한다. 다음은b003의역할/ACL/sequence/UNKNOWN비교와정확own4종료결과를기록하고, 새업무검증환경을별도준비하는것이다. 이환경정리는실제복원/Storage전체성공을주장하지않는다. 추가커밋·푸시·운영변경0.

## b003 최종 실패·신규 대상 정리

b003 복원은 `TARGET_CONFIGURATION_CHANGED`로 FAIL_CLOSED이며 원영수증 SHA `5e8397bbef87fbad37b1a468535939c231ff236c065b3d422b9112e98fd3abcf`를 보존한다. 원 DB 불변·기존 metadata 보존·childclosed이며 역할/덤프 복원 전송은 시작하지 못했다. 새 target의 Config는 동일하고 HostConfig.OomKillDisable만 false→null로 바뀌었다. 역치환한 전체 HostConfig SHA가 생성 전핀과 일치함을 root와 독립 검토자가 확인했다.

원core/guard를 변경하지 않은 exact-ID 정리 도구를 독립 검토 후 실행했다. target5149bc31…57bba3 한 개 stop1회/재전송0/타stop0/삭제0/재시작0, 원 guard5파일 SHA·daemon·source·기존 metadata 전후 확인과 stop그룹 종료 증거를 저장했다. cleanup SHA `951c242f03763a0c924a12e19621fad6f1689af35ac8c81780742954b8445f6a`, 최소2125208KiB·metadata명령32개 모두exit0/closed다. target은 정지·보존됐으며 원 복원 실패를 PASS로 바꾸지 않는다.

후속은 새target의원관측선저장·명시시작전이만허용하는도구정식화와거절회귀다. 원source/기존자원guard를정규화하지않는다. 정지된b003는원a002baseline밖의새자원이므로, 후속검증은이를명시보호하는새typed계약이나완전히새source가필요하다. 기존intent/packet을재생하거나baseline을자동재설정하지않는다.

## a002 원source4 실제 종료 완료

고정 currentbinding+원baseline/정지b003 델타의18회귀·독립리뷰 뒤 실제53908에서 `PASS_SHUTDOWN_ONLY`를 저장했다. 원 영수증SHA `1f9be22040e99e531ecd1f439843e9eba4931622aac6ae8a47a59e8a94bb71d5`는 `/private/tmp/yumidang-source4-failure-closure-20261020/execution-a002/closure-receipt.json`이다. current121/closed13/합성UNKNOWN2와178개모든행bag/authority/constraints/catalog가seedfinal6c4c와정확일치했고 sequence[41,true]를보존했다. 정확own4만각1회정지·Exit0/OOMfalse/잔여0,타stop0·network/volume삭제0·SQL쓰기0·예산/UNKNOWN삭제0,정지b003와기존metadata보존·자기child종료PASS다. 최소2091616KiB/명령376개모두exit0·closed를확인했다.

실제run은성공한뒤마지막root요약print가반환dict에없는historicalRestoreStatus를읽어KeyError로wrapper exit1이었다. 디스크의save가덧붙인원FAIL표기는그대로존재하며원영수증·종료/보존자료를재확인했다. 표시실패와작업결과를분리하고실제명령을재실행하지않았다. 원b003복원은여전히FAIL_CLOSED다. source4·Auth6·합성정산/UNKNOWN·volume자료를보존하며새source승인/자정/운영완료로확대하지않는다.

다음은/me정상5키/공개DTO·인증거절의읽기전용3파일후보검토와새HEAD/새문맥준비다. 현재후보는private에만있고새실제실행·추가커밋·푸시0이다. 원a002만료token을새Auth문맥에보내만료단독검증으로표시하지않는다.
