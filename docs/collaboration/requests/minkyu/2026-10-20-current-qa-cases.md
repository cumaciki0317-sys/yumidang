# 최신 main 정책의 서버·공동 QA 추가 사례

기준522be4e · WBS4.2/6.1/6.3/6.5 · 설계와 실제 실행을 구분한다. [기존70사례](../jonghyun/2026-10-20-policy-implementation-audit/qa-design.json)는 보존하며 아래는 최신 변경의 대응 누락을 보완한다. 이 문서는 제품 PASS가 아니다.

| 사례 | 절차와 기대 결과 | 실제 검증/증거 조건 | 후속 TASK |
|---|---|---|---|
| AIC01 가입 미동의 | 후기3동의 8조합 모두 일반 가입 허용. 기본false. 기존summary_allowed의 자동승계0 | SQL 저장·HTTP 응답·가입 결과를 별도 확인 | 4.3/5.1 |
| AIC02 독립 철회 | 열람은 본인 열람만, 생성/노출은 본인 요약 숨김·갱신 중단, 원문 활용은 작성자 전체 기존/향후 원문 제외·영향 요약 우선 숨김 | 타동의/일반후기/별점/당도/계정 불변; Auth와RLS 포함 | 5.7/6.3 |
| AIC03 경쟁·재생성 | 철회 중 publish/reserve/source 변경, 적격3개 미만·모델 실패·동의 미확인 | stale 결과 공개0·UNKNOWN/예약 보존·실패 시 숨김 유지 | 5.5/5.7 |
| AIC04 탐색 상태 | 첫사용 동의 거절·일한도·동시요청·철회 상태에서 모델/예산0, 일반검색 유지 | 서버 availability 응답과 종현 버튼/자동재전송0 대조 | 5.4a/6.3 |
| DDL01 잠금 마감 | 동일 원JWT command의 deadline전 DBentry·정확Lock관측, deadline후 해제, 업무거절/정리 저장 | HTTP접수와DBentry를 분리. timeout/Auth실패/다중backend는INCONCLUSIVE | 4.5/4.6 |
| RPT01 책임/대체 | 조유미 허용·부재 종현의 배정된 일반신고/제출증거만 허용; 타사건·원문채팅·타운영·미배정은 거절 | 실제 ACL·감사·역할 회수 후 거절 확인; 정책문서와권한설정 분리 | 4.7/6.3/7.13 |
| EVT01 공고 전용 행사 | API선택과직접입력 배타, 직접입력 공용목록0, 수정/핵심변경합의, 취소/연기/미제공 구분 | 실DB·DTO/관계·종현 앱소비 대조 | 4.4/7.12 |
| KOP01 공식대조 | 14분류 각각 기간/공식조건/ID/순위/순서 대조. basedate없어도 일치만통과 | 공홈+API원증거와분류별 snapshot. 합성자료는실제순위PASS아님 | 7.8 |
| KOP02 위조/실패 | verified필드/JSON위조·다른분류·기간/순서불일치거절, 실패시기존기간유지·미검증공식링크 | 실제영속저장 재독출까지검사; gate만으로게시활성화금지 | 7.8/7.12 |
| RST01 신규target전이 | 최초시작 OomKillDisable false→null만 조건부허용; 타HostConfig변경·기존자원·재시작거절 | raw-before-verdict/typedtarget/단일intent,원source/UNKNOWN/ACL/seq불변 | 7.14 |
| RET01 파기/감시 | 삭제ACK·응답유실UNKNOWN·재시도/lease/fence·실제알림수신·복구 | 기존회원자료0 합성먼저,운영승인후정확대상/감사 | 7.13/7.18 |

각 실행은 HEAD·대상identity·행위·예상/실제·원증거SHA·정리·미실행사유를 남긴다. Secret/JWT/회원원문은 일반 로그·Git·Notion에 넣지 않는다. 실제 회원/기기/운영 결과 없이 공동QA나출시를PASS로하지않는다.
