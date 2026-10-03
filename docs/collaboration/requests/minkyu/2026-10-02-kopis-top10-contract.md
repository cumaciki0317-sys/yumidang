# KOPIS 공식 Top10 연결 계약과 실제 확인 — 2026-10-02

민규가 종현에게 전달하는 연결 요청이다. 아래 확정 정책·공식 규격·실호출 결과·기술 제안을 구분한다. 종현 제품 파일, 기존 SQL, 운영 환경값은 변경하지 않았다. 새 저장·HTTP 계약은 아직 구현하거나 합의한 정식 API가 아니다.

## 현재 확정 정책과 남은 선택

[PLAN.md 3-6](../../../../PLAN.md), [상세 설계 8·11.3장](../../../../PLAN_상세설계.md), [정책.md 9장·D13](../../../../정책.md)에 따라 전국 전체 공연 Top10을 기본으로 제공하고 뮤지컬로 전환한다. 한국 날짜의 오늘을 D라 할 때 D-7일부터 D-1일까지 양 끝을 포함한 최근 7일을 요청한다. 고정 월요일~일요일 주간으로 대체하지 않는다. 매일 갱신하고 출처·집계 요청 기간·갱신 시각을 표시한다. 일반 행사 목록의 이번 주 신규 기본과 별개다. 자체 인기순·매출순·가상 순위를 만들지 않는다.

D13은 종료·취소 항목이 공식 순위에 포함될 때의 표시·작성 선택 처리를 남겨 둔다. 일반 행사 목록은 취소 숨김, 작성 선택은 진행 중·예정만이라는 기존 규칙이 있으나, 이를 이용해 공식 순위 항목을 삭제하거나 재번호하는 새 규칙을 만들면 안 된다. 필요한 후속 선택은 **종료·취소된 공식 순위 항목을 순위 영역에서 어떻게 표시하고 기존 행사 작성 선택 흐름으로 연결할지**다. 검증용 공급사 순위에 `active`·`canSelect:true`를 추정해서 넣지 않는다.

이미 공고에 연결된 행사 정보는 항상 최신 정보를 표시하고 동행 일정은 자동 변경하지 않는다는 사용자 결정도 보존한다. 아래 순위 수집 snapshot은 특정 집계 요청의 공식 순위 증거이며, 공고에 연결된 행사 내용을 고정해 보관하는 snapshot 제안이 아니다.

## 공식 원문과 요청 규격

- [KOPIS 개발가이드 PDF](https://kopis.or.kr/upload/openApi/공연예술통합전산망OpenAPI개발가이드.pdf): v5.0, 배포일 2026-04-23, 16~17쪽의 예매상황판 조회 서비스.
- [KOPIS 공통코드 PDF](https://kopis.or.kr/upload/openApi/공연예술통합전산망OpenAPI공통코드.pdf): 2쪽의 예매상황판 장르 코드 `GGGA`는 뮤지컬.
- [KOPIS 공식 이용가이드](https://kopis.or.kr/mob/cs/kopisGuide.do): 예매일 기준 티켓판매수 순위 1~50위, 연계기관 자료 집계·매일 갱신을 설명한다. 공연 상연일 기준 통계와 구분한다.

공식 서비스 경로는 `/openApi/restful/boxoffice`다. PDF에는 HTTP 예제가 있지만 프로젝트는 HTTPS만 사용한다. 실제 검증 주소는 `https://kopis.or.kr/openApi/restful/boxoffice`이며 redirect를 따라가지 않았다. GET 요청의 `service`는 서버 전용 키다. `stdate`·`eddate`는 `YYYYMMDD`, 최대 31일의 기간이고 실제 요청은 정확히 7일이다. 전국은 `area`를 생략하고 전체 공연은 `catecode`를 생략한다. 뮤지컬만 `catecode=GGGA`를 추가한다. 좌석 규모 필터도 생략한다. 문서 예제는 `stdate/eddate`를 사용한다. 문서 표의 별도 `date` 필수 표시와 예제 사이 차이가 있어 `date`·`ststype=week`를 추정해서 추가하지 않았다.

## 실제 공급사 증거와 한계

| 검사 | 전국 전체 | 전국 뮤지컬 |
|---|---|---|
| 요청 기간 | 20260925~20261001 | 20260925~20261001 |
| HTTPS 상태 | 200 | 200 |
| 반환 목록 | 50행 | 50행 |
| 공식 `rnum` | 1~50 연속 | 1~50 연속 |
| 공연 ID | 행 사이 중복 없음 | 행 사이 중복 없음 |
| 필수 공연 필드 | 확인 | 확인 |
| 장르 조건 | 전체 요청 | 반환 `cate` 모두 뮤지컬 |
| 응답 집계 기간 검증 | 미완료 | 미완료 |

각 모드 최초 1회와 기간 형식 재확인 1회를 읽기 요청했다. 이후 전국 전체 1회로 XML 구조만 추가 진단했다. 공연 원문·키·요청 URL을 출력하거나 저장하지 않았다. 실제 응답은 `boxofs` 아래 `boxof` 50개이며 `basedate` node·attribute가 없다. 문서에 있는 `basedate` 예제를 실제 응답에서 확인하지 못했다. 따라서 요청한 기간과 실제 집계 기간이 다르다고 판정한 것이 아니라 **응답만으로 집계 기간을 독립 확인하지 못한 상태**다. 응답 날짜 확인을 PASS로 꾸미거나 없는 `basedate`를 생성하지 않는다.

순위 1~10은 공식 `rnum`을 유지한 첫 10행 후보로 얻을 수 있다. 그러나 위 기간 검증 차이가 해소됐다는 증거 없이 전체 Top10 기능 완료로 표시하지 않는다. 판매수·판매액 필드는 실제 응답에 없었다. 공식 안내의 티켓판매수 순위라는 설명을 붙일 수 있지만 숫자 판매량·매출액·점수는 생성할 수 없다.

## 정규화 계약 요청: 종현

기존 `_shared/integrations/events/kopis.ts`·`port.ts`, `repositories/events.ts`, `event-sync/`, `scheduled-jobs/`의 책임 안에서 별도 순위 port와 수집·정규화·저장 호출을 연결한다. 현재 제품 함수·마이그레이션에서 `boxoffice`·Top10 구현은 발견하지 못했다. 일반 행사 `SourceEventRecord`에 순위를 섞거나 순위 응답만으로 행사 상태를 확정하지 않는다. 새 파일이 필요하면 현재 역할·소유권에 맞게 별도로 합의한다.

공급사 XML 필드는 다음 allowlist로 제한한다. 원문 XML 자체를 저장하지 않는다.

| 원천 필드 | 정규형 제안 | 처리 |
|---|---|---|
| `rnum` | `rank` | 공식 정수 순위 보존, 재번호·재정렬 금지 |
| `mt20id` | `sourceId` | `provider:'kopis'`와 함께 원천 identity, 다른 공급사와 제목 병합 금지 |
| `prfnm` | `title` | 공개 문자열 정제·한도 검사 |
| `cate` | `genre` | 원천 장르명 보존, musical 요청은 뮤지컬 여부 검증 |
| `prfpd` | `performancePeriodText` | 실제 날짜 형식 검증 후 정규화, 취소·운영 회차 추정 금지 |
| `prfplcnm` | `placeName` | 공개 장소명, 정확한 만남 지점으로 사용하지 않음 |
| `area` | `region` | 원천 지역명, 임의 대응표 생성 금지 |
| `seatcnt`, `prfdtcnt` | 이번 공개 카드에서 제외 | 좌석·상연횟수를 판매량으로 바꾸지 않음 |
| `poster` | 이번 최소 계약에서 제외 | 이미지 주소를 공식 상세 페이지 주소로 바꾸지 않음 |

서버에서 `requestedStart/End`, `collectedAt`을 별도로 붙인다. `basedate`가 없으면 `responsePeriod:null`, `periodVerification:'requested_only'`로 기록한다. 실제 응답 기간을 확인한 경우에만 `echo_confirmed`로 바꾸는 기술안이며 현재는 그 증거가 없다. 공식 상세 링크가 확인되지 않으면 `sourceUrl:null`이다. 공급사 오류·0행·권한 거절·형식 오류를 10개 가상 카드나 이전 기간 성공으로 대체하지 않는다.

## 저장·HTTP 계약 초안: 민규

아래 이름·오류·반환은 담당 간 합의가 필요한 **기술 제안**이다. 기존 구현·확정 운영 정책으로 표시하지 않는다.

```ts
type RankingItem = {
  rank: number; sourceId: string; title: string; genre: string;
  performancePeriodText: string; placeName: string; region: string;
};

// service_role 전용, 전체 배치 하나의 트랜잭션
upsert_kopis_ranking_snapshot({
  p_mode: 'all' | 'musical',
  p_requested_start: 'YYYY-MM-DD',
  p_requested_end: 'YYYY-MM-DD',
  p_collected_at: 'RFC3339',
  p_items: RankingItem[] // 최대 10행, 공식 rank 보존·실제 원천 ID·정제된 공개 필드
})
// -> {status:'saved'|'stale', itemCount:number, deduplicated:boolean}

// 첫 단위의 검증용 service_role 전용 읽기
get_kopis_ranking_snapshot({p_mode:'all'|'musical'})
// -> {status:'available'|'unavailable', requestedPeriod:{start,end}|null,
//     responsePeriod:null, periodVerification:'requested_only',
//     collectedAt:string|null, source:'kopis', items:RankingItem[]}
```

모드·요청 기간·수집 시각과 공식 순위 항목을 한 단위로 저장한다. canonical `source_events`와는 원천 ID 참조를 사용하고 행사 최신 정보를 독립 복제하지 않는다. 존재하지 않는 canonical 행사에 자동으로 `active` 행을 만들지 않는다. FK가 필요한지와 미수집 공연의 별도 정규화·상세 조회 책임은 종현과 확인한다. rank snapshot에 포함한 공개 필드가 공고 연결 행사의 최신 정보 표시를 대신하지 않는다.

입력은 exact keys·JSON types·유효 날짜·양 끝 포함 7일·유한 수집 시각·1~10행의 공식 연속 rank·sourceId 유일·장르 조건을 검증한다. 실제 순위가 10개 미만이면 존재하는 원천 순위를 보존하고 임의 카드를 채우지 않는다. 빈 응답을 기존 snapshot 삭제나 정상 10행 수집으로 처리하지 않는다. 틀린 입력은 `22023`, 역할 거절은 권한 ACL/`42501`이다. 같은 identity·수집 시각·동일 payload 재시도는 동일 결과, 같은 시각의 다른 payload는 `40001`로 제안한다. 더 오래된 수집본은 `stale`로 현재 값을 유지한다. 모드별 동일 순서의 잠금으로 배치 전체를 원자 갱신하고 직접 private 테이블 쓰기는 회수한다.

공개 조회는 모드별 가장 최신의 성공 snapshot 하나를 반환하는 기술안이다. 수집 실패·이전 수집본 도착 때 기존 snapshot을 삭제하지 않고 수집 시각·요청 기간을 그대로 반환한다. 언제부터 숨기거나 실패 상태로 표시할지는 정해지지 않은 TTL 정책이므로 추가하지 않는다. 원문·키·request URL은 DB·로그·오류에 남기지 않는다.

공개 API 후보는 정확한 `GET /events/top10?mode=all|musical`이며 생략 시 all이다. DB 읽기 RPC의 anon/authenticated 실행, 기존 선택 인증(Authorization 없음만 익명, 잘못된 인증401, Auth 장애503, fallback 없음), GET 전용·unknown/중복 query400·공통 no-store envelope를 재사용한다. 내부 저장은 기존 별도 secret 검증 뒤 service_role client만 사용한다. 공개 응답은 출처·요청 기간·갱신 시각·원천 순위·정제된 공개 카드만 포함하고 판매량·개인정보·원문을 반환하지 않는다. D13이 해결되기 전에는 이 공개 카드·선택 경로를 활성화했다고 주장하지 않는다.

## 첫 구현 단위와 검증 기준

**첫 단위는 후속 마이그레이션의 내부 저장·읽기 RPC와 내부 HTTP 수집 경계**로 제안한다. `POST /internal/events/kopis-top10`은 별도 내부 secret 인증과 위 exact 입력을 검증해 service_role RPC에 연결하고 count/status만 응답한다. 공개 카드의 종료·취소 표시나 작성 선택을 구현하지 않으므로 미정 정책을 선택하지 않고 진행할 수 있다. 이 단위의 신규 SQL·API 파일·단독 테스트 경로는 총괄이 별도 하네스로 승인한 뒤 편집한다.

필수 검증은 두 모드의 분리·전체 배치 원자성·잘못된 rank/중복 ID/기간/장르 거절·재시도/낡은 수집본·권한·키/원문 미출력이다. 공급사 기간 echo 부재는 별도 한계로 남기며 합성 SQL 자료와 실제 공급사 결과를 혼합하지 않는다. 이어 종현 실제 순위 port를 연결해 공급사 요청→정규화→저장→내부 읽기를 검증한다. 공개 카드·선택 흐름은 D13 처리 확인 후 연결한다. 일일 스케줄러 운영 반영도 실제 별도 검증한다.

## 이미 완료한 장소·일반 행사 연결과의 구분

[places_events_local.ts](../../../../tests/integration/minkyu/places_events_local.ts)는 기존 실제 factory를 재사용했다. 총괄 실제 실행은 232 checks PASS, 합성 Auth 회원 생성·로그인 후 Kakao1회, KOPIS1회, TourAPI1회, 실제 공개 행사2행 저장·공개 HTTP2행 재조회·정리 PASS다. `syntheticAuth:true`, `actualPublicProviders:true`, `inProcessHttp:true`, `gatewayHttp:false`, `cleanupPassed:true`였다. 이 실행은 일반 행사 연결이며 순위 API·gateway 함수 배포·우편번호 UI·일일 운영을 검증한 것이 아니다. 수집 identity와 합성 회원을 정확히 정리했고 다른 검증 종료 뒤 원래 비어 있던 로컬 업무 테이블로 복구했다. 실제 네이버 회원 토큰이나 공급사 원문은 이 문서에 포함하지 않는다.
