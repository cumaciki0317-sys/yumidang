# 서울 문화행사 HTTPS 후속 확인 — 2026-10-19

작업자 종현. 공개 자료만 조회했으며 회원 데이터·공급사 키를 전송하지 않았다. 서버·클라이언트·환경 설정은 변경하지 않았다.

## 결론

공식 전체 JSON 다운로드를 **TLS 인증서 검증을 유지한 HTTPS로 다시 수신**했다. HTTP만 가능한 것은 아니다. 다만 현재 서버 파서는 다른 형식이며, 이 다운로드 경로의 자동 수집·삭제 반영·실패 복구가 운영 환경에 연결된 것은 아니다. 신규 서울 수집의 운영 보류는 유지한다.

## 현재 관찰과 출처

- [공식 데이터셋 OA-23041](https://data.seoul.go.kr/dataList/OA-23041/S/1/datasetView.do): 2026-10-19 확인. 페이지에는 데이터 갱신일 2026-10-18, 매일 1회, 서울특별시 제공, 공공누리 1유형(출처표시·상업적 이용 및 변경 가능)이라고 안내한다.
- 공식 페이지의 표시 용량은 **19,472건**, 실제 내려받은 JSON은 **19,631건**이다. 두 값이 일치한다고 보고하지 않는다. 내려받은 응답을 기준으로 검증한 수치다.
- 공개 POST: `https://datafile.seoul.go.kr/bigfile/iot/sheet/json/download.do`
- 폼: `srvType=S&infId=OA-23041&serviceKind=0&pageNo=1&ssUserId=SAMPLE_VIEW&strWhere=&strOrderby=DATE+DESC`
- curl 기본 TLS 검증과 `--proto '=https' --proto-redir '=https'` 사용. 인증 검증을 끄지 않았다. HTTP 200, 응답 서버 시각 `Mon, 19 Oct 2026 06:28:18 GMT`. 공개 폼이며 회원 인증정보를 사용하지 않았다.
- 응답 envelope는 `DESCRIPTION`(필드 설명)과 `DATA`(행 배열). 데이터 필드는 소문자 25개이며 기존 culturalEventInfo API와 다르다.

## 두 스냅샷 비교

| 비교 항목 | 결과 |
|---|---|
| 10/17 원본 행 수 | 19,637 |
| 10/19 원본 행 수 | 19,631 |
| `hmpg_addr`의 `cultcode` | 10/19 전 행 추출 가능, 19,631개 고유값, 중복·누락 0 |
| 10/17 대비 추가 ID | 0 |
| 10/17 대비 사라진 ID | 6 |
| 동일 ID의 필드 변경 | 0 |
| 동일 ID·동일 내용 | 19,631 |

따라서 **원천 스냅샷에서 6개가 빠진 사실**까지 확인했다. 원천의 삭제 사유·취소 의미를 확인한 것은 아니며, 우리 DB의 삭제 반영을 검증한 것도 아니다. 한 번의 누락만으로 기존 연결 공고까지 자동 삭제해서는 안 된다.

## 품질과 날짜 검증

- `strtdate`, `end_date`는 밀리초 epoch 숫자다. Asia/Seoul 날짜로 변환했을 때 모든 19,631행의 `date` 문자열과 일치했다. 이 표본의 시작 시각은 모두 UTC 15시(KST 다음 날 0시)다. 숫자를 UTC 날짜로 잘라 하루 앞당기는 변환을 피한다.
- epoch 해석 불가 0행, **시작일이 종료일보다 늦은 행 54개**. 예: cultcode159325는 시작 2026-09-25·종료2026-09-15다. 임의 교환·보정하지 않고 격리한다.
- 공식 페이지가 안내한 2021-10~2026-12 범위를 벗어나는 시작·종료일이 있는 행 29개. 범위 이탈만으로 전부 오류라고 확정하지 않는다. 365일 초과 기간은 34행이며 장기 전시일 수도 있으므로 별도 확인 대상이다.
- 10/19 기준 원시 날짜상 진행 중 245행. 검증·운영 수집이 끝난 앱 노출 건수를 뜻하지 않는다.
- 빈 값(null·빈 문자열·공백만 포함) 기준: 이용요금 `use_fee` 10,635행, 프로그램 `program`17,463행, 출연자 `player`17,656행, 좌표 각496행. `is_free`누락8행. 비용 누락을 무료로 해석하지 않는다.

## 현 SourceEventRecord에 맞추는 방안 — 민규 구현 인계

기준: `backend/supabase/functions/_shared/integrations/events/port.ts`, `seoul.ts`, `normalize.ts`. 아래는 설계 후보이며 서버 코드를 변경하지 않았다.

| 원천 필드 | 기존 계약에 넣을 값·주의 |
|---|---|
| `hmpg_addr` | 호스트·경로·cultcode 형식을 검증해 `sourceId`, 공식 상세 링크를 `sourceUrl`에 사용. 제목 해시로 ID를 새로 만들지 않음 |
| `title`, `codename`, `place` | `title`, `category`, `placeName`. 빈 제목 격리·제어문자/HTML 정제 필요 |
| `strtdate`, `end_date`, `date` | KST 달력일 `precision:date`, `startsOn`, `endsOn`. 두 표현 일치 검증·역전 격리 |
| 서울 데이터셋, `guname` | 기존 `region`은 서울특별시. 구 이름은 별도 원천값으로 보존하되 상세 주소로 만들지 않음 |
| `is_free`, `use_fee` | 명시 무료만 `free`; 요금 설명 있으면 `described`; 미상은 `unknown` |
| `pro_time` | `operatingInfo` 후보. 자유 서술 운영시간을 시작·종료 순간으로 추정하지 않음 |
| `program` | `description` 후보. 비어 있으면 설명이 없음을 유지 |
| `main_img` | 안전한 공개 URL 검증 후 `posterUrl` 후보. 원격 이미지 존재·MIME·저작권/출처 표시 별도 확인 |
| 수집 실행 시각 | `collectedAt`. 원천 갱신 시각으로 대신 표기하지 않음 |

현 계약에 직접 대응하지 않는 원천값은 `cgg_cd`, `guname` 세부값, `org_name`, `org_link`, `inquiry`, `player`, `etc_desc`, `use_trgt`, `ticket`, `themecode`, `lat`, `lot`, `rgstdate` 등이다. raw snapshot에 보존하고 필요 시 계약을 명시적으로 확장한다. `publicAddress`는 원천에 실제 도로명·지번 주소가 없어 null로 둔다. 문의처·기관명·좌표를 주소로 대체하지 않는다. `rgstdate`는 설명상 신청일이며 원천 수정일로 단정하지 않는다.

특히 원천에 명시 취소/정상 상태 필드가 없어 `sourceStatus`의 근거가 부족하다. 기존 정규화기의 `active` 고정값을 그대로 새로운 응답에 복사하지 말고, **게시된 행 존재를 앱 활성 상태로 취급할 수 있는지·누락/취소 처리를 어떻게 할지** 계약으로 정한다. 표본 수신만으로 취소가 없다고 판단하지 않는다.

현 `classifySeoulCultureResponse`는 대문자 필드의 `culturalEventInfo` envelope를 검증하며 새 형식을 바로 소비하지 못한다. 소문자 JSON 전체를 기존 transport에 억지 주입하지 않는다. 전용 snapshot decoder→정규화→검증→기존 저장 port를 연결하는 방향을 추천한다.

## 운영 연결 전 남은 순서

1. 소문자 JSON decoder와 날짜/ID/필수값 검증, 불량 행 격리·건수 보고. HTTP 200 안의 HTML·오류 본문·부분 다운로드도 성공 snapshot으로 취급하지 않음.
2. 전체 응답의 안전한 크기 제한·타임아웃·재시도·마지막 성공 snapshot 보존. 삭제 반영은 성공적으로 검증한 전체 snapshot끼리 비교하고, 일시 누락과 확정 삭제를 구분하는 규칙 마련.
3. 실제 배포환경에서 인증서·네트워크·전체 다운로드 시간·자원 사용량 확인, 하루 1회 수집 일정·관측·실패 알림 연결.
4. 출처와 마지막 성공 수집 시각 표시, 정상/불량/신규/갱신/누락 수 및 기존 연결 공고 영향 검증. 필요 시 누락·수정 원천 의미를 공급사에 확인.

## 원본·재현 근거

저장 원본은 공개 행사자료지만 용량이 커 Git에 추가하지 않았다.

- `/private/tmp/jh-seoul-all.json` — 10/17 SHA256 `63392fa13e9f08a40df454e2c3a458a11b1f1eb812ec06dbd4c128a4dfe5c84c`
- `/private/tmp/jh-seoul-20261019.json` — 10/19 SHA256 `939cd39cbb9a4effb4cf1006db94622c560e35a0739afc59e446b0f7d4e049d8`
- `/private/tmp/jh-seoul-20261019-headers.txt` — HTTP 응답 헤더
- `/private/tmp/jh-seoul-20261019-summary.json` — 행·원천 ID·스냅샷 비교·품질 검증 요약. `nulls`는 null/빈 문자열만 세며, 본문의 빈 값 수는 추가로 공백만인 값도 제외했다.

위 사실 확인은 인증키 발급·DB쓰기·배포·자동 수집 활성화·실회원 검증·공급사 문의 발송이 아니다.
