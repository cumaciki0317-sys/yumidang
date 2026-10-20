# 서울 HTTP 보안 해결: HTTPS 수신 후보와 적용 경계

2026-10-19 / 작업자 jonghyun / 독립 clone. 이번 우선 작업은 서울 HTTP 보안이다. TourAPI 전체 칼럼 정리는 후순위로 되돌렸다.

## 결론과 실제 작업

- **수신 경로:** 공식 HTTPS 다운로드 대안은 이전 실제 TLS검증 HTTP200으로 확인됐다. 이번에는 같은19MB를 다시 받지 않고 기존 원본과 코드를 분석했다.
- **현재 앱 서버:** 서울HTTP를 호출중이 아니다. event-sync registry는 transport 없는 서울provider를 만들어 `EVENT_PROVIDER_UNCONFIGURED`로 닫힌다. 보안 가드를 제거하지 않는다.
- **패치 후보:** 기존 `seoul.ts`에 고정 HTTPS 공개POST 수신·스트림 크기/시간 제한·엄격한 UTF8/JSON/25필드 구조 검증 함수를 추가하는 [패치](2026-10-19-seoul-https-security-candidate.patch)를 작성했다. **backend 파일에는 적용하지 않았다.** provider/registry·DB·scheduler를 연결하지 않는 첫 단계다.
- **격리 검증:** [29개 검사 결과](2026-10-19-seoul-https-candidate-check.json) 전부 통과. 실제 저장원본19,631행 구조검증·고정URL/공개폼/인증미전송·리디렉션/HTML/잘린JSON/잘못된UTF8/오류JSON/과대응답/취소/헤더·본문대기타임아웃/오류비밀값비노출을 확인했다. 함수의 HTTP는 모형이며 **새 네트워크 호출0**이다.

## 패치가 고정하는 보안 조건

| 항목 | 후보 동작 |
|---|---|
| 목적지 | `https://datafile.seoul.go.kr/bigfile/iot/sheet/json/download.do` 고정. 환경/사용자/원천행에서 임의URL을 받지 않음 |
| 인증정보 | 공개폼만 전송. 쿠키/Authorization/API키 없음, credentials omit |
| 리디렉션 | manual로 받되200이외거절. 다른호스트/HTTP로따라가지않음 |
| 크기 | caller의 maxBytes를 실제 읽은 스트림 바이트에 적용. Content-Length없음/chunked도검사. 원본19,466,060bytes를근거로32MiB는초기검토값이며운영설정확정아님 |
| 제한 시간 | caller timeoutMs 적용, 취소·headers대기·body대기·늦게도착한응답정리. 검사는기존15초를사용했으며실제서버한도를올리지않음 |
| MIME | JSON과 실제관찰한application/x-msdownload만 고정경로에서허용. 후자도본문UTF8/JSON/스키마검증필수 |
| 오류 | 429/5xx/3xx, HTML·오류본문·잘림·빈스냅샷·스키마변경거절. 실패를0건성공으로바꾸지않음 |
| 처리 범위 | 구조검증원천행만반환. 날짜보정·active추정·누락삭제·저장·운영활성화 없음 |

함수 옵션의 상한은 방어용 후보 값이다. 실제 워커의 메모리/실행 시간·운영 크기와 timeout은 민규가 계측 후 확정한다. 이 패치만 적용해도 registry는 여전히 미설정으로 닫힌다.

## 기존 코드와 실제 원본이 다른 부분

- 기존은 `culturalEventInfo/RESULT/list_total_count/row`, 대문자 칼럼과 날짜 문자열을 소비한다. 새전체파일은 `DESCRIPTION/DATA`, 소문자25칼럼·epoch밀리초다. URL교체만으로호환되지않는다.
- 원본은19,631행·19,466,060bytes이고 Content-Type은 `application/x-msdownload;charset=UTF-8`, Transfer-Encoding chunked다. rows1000상한을전체행수로재사용하거나 JSON MIME만허용하면실패한다.
- 시작일>종료일54행. 임의교환/추정하지않고 격리해야한다. 전체KST변환과원문date일치는확인했다.
- 제목285행에꺾쇠/제어문자가있어기존plain()을그대로재사용하면탈락할수있다. 악성으로단정하지말고text정규화와화면escape를구분한다.
- 새원천에취소/정상상태필드없음. 기존active고정값을그대로복사하지않으며 sourceStatus unknown을허용할지게시존재의의미를어떻게정할지서버계약검토가필요하다.

## 외부 링크는 별도

저장원본에서 문화포털상세 `hmpg_addr`와대표이미지 `main_img`는19,631개모두HTTPS `culture.seoul.go.kr`다. 개별이미지실제접속/노출성공을새로검증한것은아니다.

기관홈페이지 `org_link`는HTTPS17,837개/HTTP1,455개/스킴없음72개/null267개다. HTTP를일괄HTTPS로바꾸거나원천링크를서버가임의로가져오지않는다. 검증되지않은링크는활성화하지않고확인된문화포털상세링크를사용하는안을추천한다. 이는외부링크표시안이며사용자정책을임의변경/실제화면수정한것은아니다.

## 민규가 적용할 다음 단위

1. 기존seoul.ts에후보수신함수검토/적용, backend정식테스트경로에검증이관. 기존보안가드·미설정동작유지.
2. 동일스냅샷의hash/version과기간·offset으로이어처리하는포트설계. 기존31일window/page·실행당5쪽마다전체19MB를다시받지않음. 메모리캐시만으로재개를보장하지않음.
3. lower-case행의ID·KST일자·텍스트·입장료·명시상태·결측정규화와불량격리. 전체유효성/행격리/삭제반영판정을분리.
4. event-sync/index.ts registry와 settings를명시연결, 지속스냅샷/정규화/저장port/조회/중단후재개격리검증. 미검증상태를빈성공으로바꾸지않음.
5. 실제허용된배포환경에서TLS·네트워크·메모리·다운로드시간·백업/마지막성공·하루1회일정·실패알림확인. 원천누락6개를즉시운영DB삭제로전파하지않음.

1번수신보안검사와2~5번연동·운영검증을구분한다. 서버파일은 [AGENTS](../../../../AGENTS.md)의 민규단독수정경로이며 이번 전체문서동기화예외는 서버코드/DB변경승인이 아니다. 종현폴더에후보패치/검증을준비했고 소유권/actor/hook을바꾸지않았다.

## 재현과 증거

- 원본: `/private/tmp/jh-seoul-20261019.json`, SHA256 `939cd39cbb9a4effb4cf1006db94622c560e35a0739afc59e446b0f7d4e049d8`.
- [이전 실제 HTTPS 수신 기록](2026-10-19-seoul-https-followup.md), [이번 원본 분석JSON](2026-10-19-seoul-https-security-probe.json).
- 검증재현: `node docs/collaboration/requests/jonghyun/2026-10-19-seoul-https-security-candidate-check.mjs /private/tmp/jh-seoul-20261019.json`.
- patch검토: `git apply --check docs/collaboration/requests/jonghyun/2026-10-19-seoul-https-security-candidate.patch`. 이명령은적용하지않음.
- 공식데이터셋: https://data.seoul.go.kr/dataList/OA-23041/S/1/datasetView.do . 오늘페이지의일1회/출처표시조건확인과실제운영스케줄작동은별개다.

## KOPIS 사용자 정정 반영

“집계기간빼고KOPIS호출계속”은지금추가호출/무기한폴링을지시한것이아니다. 집계기간대조결과를기다리는동안KOPIS일반기능개발과다른API·칼럼정리를병행해,해결시연결할준비를하라는뜻이다. 앞으로새호출은필요한미확인사항을검증할때만하고이설명만으로주기작업을등록하지않는다. Dots는프롬프트전달만확인했으며실제예약/대조가실행중이라고표시하지않는다.

독립 검토에서 제한시간 경계 직후 도착 응답의 본문 정리 누락 가능성을 발견해 후보를 수정했다. 해당 실패 모형을 추가한 최종29개 검사 전부 통과했다. 최초28개 통과만으로 최종 검증을 대신하지 않는다.
