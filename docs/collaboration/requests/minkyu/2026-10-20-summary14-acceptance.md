# WBS5.7 요약14사례 완료기준·기존 실제 증거 대응

2026-10-20 · actor=minkyu · 전용 clone `yumidang-minkyu-wbs-20261017` · 현재 HEAD `1d9b46b69adbc52f693accbff04ca4a00d35c547`.

이번 작업은 기존 실제 실행 기록과 완료기준의 읽기 대조다. 본인 신규 문서1개만 작성하며 사전 HEAD ownership 검사1경로를 통과했다. 신규 테스트·Auth·HTTP·DB·Docker·공급사 실행0, Notion 수정0, 커밋·푸시0이다. 전체79%(22/28)·민규44개 전체 완료를 선언하지 않는다.

## 원 완료기준과 근거

[WBS5.7 원문](https://app.notion.com/p/990a6def75f882c0afd281cef4c7e203)을 읽기 재조회했다. 최종 편집2026-10-14T12:30:29.533Z, 기존 대장 상태는 대기다.

- 14사례별 실제 결과·실패/미실행 기록; 회원 원문 외부 전송 보류 유지.
- 결과물 또는 검증 증빙 링크 연결.

실행 방법은 허용 격리 환경과 합성 모델의 최신 근거·게시 경쟁·철회·삭제 검증이며, 앱 연결·공급사 승인·운영 활성화를 서버 검사와 분리한다. 원문에 남은 ‘요약14 미실행’은 아래 후속 실제PASS와 구분해야 한다.

직접 대응할 저장소 근거는 [10/14 두 번째 격리 실행 기록](../jonghyun/2026-10-14-round2-validation-result.md)의 ‘두 번째 새 대상: 현재 요약14·두 연결7 완료 및 자원 정리’ 절과 [최종 인계 J06](../jonghyun/2026-10-14-minkyu-final-handoff.md)다. 이번에 읽은 문서 자체 SHA는 각각 `404bfb1c68b8fc94a591bd9ffdd16eb4ecd06b88130cbee65f2de53c8b9cae54`, `e3619e7c93a5f0c9fa49064b847de01f3a5607339343150601ba071b79efb8e9`다. 문서 SHA는 원 실행 영수증 SHA가 아니다.

## 기록된 실제 실행과 원자료 한계

| 항목 | 당시 기록된 실제 결과 | 이번 확인 한계 |
|---|---|---|
| 실행 | `observe_isolated.py --mode summary --run`, session99501 exit0/PASS,261.03초 | 새 실행0, 저장소 기록 읽기 |
| 대상 | source HEAD915fc31, 정식121 SQL, 새 DB `d3dfdeaba6af1e5f5ea886973757a37a7be1fdb408e97bfa94f48ad984f81f6d` | 기존 대상 접속0, 이전 ID/승인을 새 실행에 사용하지 않음 |
| 핀 | 소스194파일·Root170파일/Node 바이트·product/caller graph45개 고정 | 전체 원패키지194/170/45를 이번에 재검증하지 않음 |
| 결과 | 경쟁8+최신 후기부족6=14PASS, 외부 전송 시도0 | 아래 사례표는 실제 집계PASS와 현재 동일 caller/factory의 사례구조 대응. 개별 원출력 재검산은 아님 |
| 범위 | 실제 DB/RPC·제품 요약 factory, 인증/모델/privacy/safety 합성 | 실제 GoTrue/네이버·공급사 품질/비용·실회원·운영 증거로 확대하지 않음 |
| 메모리 | 당시 최소 가용2,791,044KiB | 현재 환경의 여유/실행 준비 판정이 아님 |

원 private 루트 `/private/var/folders/h7/6qzd7cp553q1qwhk592yhvs80000gn/T/yumidang-jonghyun-summary-native-ydxdldmm`는 이번 환경에서 발견되지 않았다. 따라서 원 영수증·로그·attestation 바이트를 열어 현재 재검산할 수 없다. 원자료가 삭제됐거나 과거 실제PASS가 무효라고 추정하지 않는다.

| 기록된 원증거 | 기록된 SHA256 | 현재 원바이트 |
|---|---|---|
| summary observer 영수증 | `ef9e2fb5ff7d7fc28ea9ef81beba3503226daa09977ff25e962477db7e2a5ba8` | 미확보·문서 인용 |
| summary 결과 로그 | `372d176e0331f8bfec511a5ea79afcc1a092225e0661c82e506f84462004282c` | 미확보·문서 인용 |
| `summary-root-attestation.json` | 해당 절에 개별SHA 없음 | 미확보·추정SHA 생성 안 함 |
| 새 자원 정리 | `5d991d982c743e60d61b8e4359952dd7d1e2966c428066eb81a5592ab83ee8d3` | 미확보·문서 인용 |

## 14사례별 대응

S01~S14는 이 문서의 대응 ID이며 원 영수증 case ID가 아니다. [caller](../../../../tests/integration/jonghyun/isolated_summary_contracts.py):349~350은 edit/consent/hide/delete×checkpoint/publish를 순회하고, :411은 결과8개·후속insufficient합계6을 요구한다. [factory](../../../../tests/integration/jonghyun/isolated_summary_factory.ts):76~97은 mutation이 반영된 실제 RPC의 stale_revision과 후속 부족 결과를 검사한다.

**전 행은 기존 실행 기록상PASS이며, 개별 원출력 현재 미재확인이다.** 코드 assertion의 존재만으로 새PASS를 만든 것이 아니다.14는 경쟁8개와 그중6개의 후속 부족 전환이며 Node14회 실행으로 표현하지 않는다.

| ID | 실제 사례 구조 | 기존 실행에서 대응하는 성공 판정 | 결과 등급 |
|---|---|---|---|
| S01 | 원문수정·checkpoint | 수정 hash·revision 변화, 저장1회 stale_revision·superseded·게시0 | 기록상PASS |
| S02 | 원문수정·publish | 수정 뒤 게시1회 stale_revision·superseded, 낡은 근거 게시 성공0 | 기록상PASS |
| S03 | 동의철회·checkpoint | 허용철회·적격근거0, 저장거절·superseded·게시0 | 기록상PASS |
| S04 | 동의철회·publish | 철회 뒤 게시거절·superseded | 기록상PASS |
| S05 | 후기숨김·checkpoint | 적격3→2, 저장거절·superseded·게시0 | 기록상PASS |
| S06 | 후기숨김·publish | 적격2에서 게시거절·superseded | 기록상PASS |
| S07 | 후기삭제·checkpoint | 선택 후기 실제 제거·적격3→2, 저장거절·superseded | 기록상PASS |
| S08 | 후기삭제·publish | 삭제된 근거로 게시거절·superseded | 기록상PASS |
| S09 | S03 후 최신부족 | 최신revision/새job·근거0, insufficient1회 applied | 기록상PASS |
| S10 | S04 후 최신부족 | publish계열 뒤 최신철회 근거0, insufficient1회 applied | 기록상PASS |
| S11 | S05 후 최신부족 | 최신revision/새job·근거2, insufficient1회 applied | 기록상PASS |
| S12 | S06 후 최신부족 | publish계열 뒤 최신숨김 근거2, insufficient1회 applied | 기록상PASS |
| S13 | S07 후 최신부족 | 최신revision/새job·근거2, insufficient1회 applied | 기록상PASS |
| S14 | S08 후 최신부족 | publish계열 뒤 최신삭제 근거2, insufficient1회 applied | 기록상PASS |

부족6개 모두 최신 작업의 추가모델0, checkpoint load/save/discard·publish·모델예약0을 검사한다. 그 이전 경쟁 작업의 모델 호출까지0이었다는 뜻이 아니다. edit2개는 적격수3 유지·내용변경이라 insufficient를 추가해16개로 늘리지 않는다. caller:238~269·289~304의 원scope·후기수·revision·완료 상태 검사와 대응한다.

## 보존·정리·이전 상태 구분

당시 summary 각 case 후 Auth/public/private/storage 행 bag·역할·membership·함수/제품 schema ACL 원복, 생성 역할8개 정리·행 차이0이 기록됐다. 시스템 임시 schema ACL·sequence·전체 볼륨 바이트는 미검증이다.

같은 새 대상에서 이후 **별도** 직원native7을 실행한 뒤 원 생성 영수증의 새6컨테이너·network1·volume2만 정확ID로 제거하고 원inventory 복귀·기존6개 실행 유지·VM중지0을 확인했다고 기록됐다. 직원native7을 summary14에 합산하거나 그 준비fixture 정리를 summary의 case별 원복과 혼합하지 않는다.

앞선7개 native SQL 후보만 검사한 시점의 ‘summary14 NOT_RUN’은 당시 기록으로 보존하고, 후속session99501 실제14PASS를 현재 인계 사실로 사용한다. 이전 member 도구의 descendant UNKNOWN 실패는 별도 실패로 유지하며 summary 성공으로 지우지 않는다. 반대로 그 이전 실패 때문에 요약을 현재0/14로 되돌리지 않는다. 실행기의 `CURRENT119_SUMMARY14_SYNTHETIC` 문자열은 옛 라벨이고 실제 적용 이력은121개라는 원기록을 따른다.

## 현재 source 동일성

확인한4개 경로 범위는 제품 `_shared/ai/Agents/review-summary/`, `review-summary-worker/`, 위 caller.py·factory.ts다. ‘4 source’는4파일이 아니다. 코드11파일과 빈 `.gitkeep`2개를 포함한13개 working-tree bytes가915fc31·현재1d9b46b 양쪽 Git snapshot과 각각 동일함을 확인했다. 코드11개의 현재SHA는 다음과 같다.

| 파일 | 현재 SHA256 |
|---|---|
| `backend/supabase/functions/_shared/ai/Agents/review-summary/eligibility.ts` | `655213747d630d45e971af6389ca2376e676d34683dd7328036ccd65f08a1ad3` |
| `backend/supabase/functions/_shared/ai/Agents/review-summary/evidence-check.ts` | `7b6405891c1ebf1a04b22735ec51677fd6c2d6db95649dd873e360920ffdad01` |
| `backend/supabase/functions/_shared/ai/Agents/review-summary/orchestrator.ts` | `fbfc07358667c7ba06adbc2a087650ae1e29063e3b41f803db84367203bae438` |
| `backend/supabase/functions/_shared/ai/Agents/review-summary/output-check.ts` | `044e82ad1318309d69da826e8dbd1f31d92a4715b423c9b3e54d74942bfd0020` |
| `backend/supabase/functions/_shared/ai/Agents/review-summary/prompts.ts` | `30595f0b5d4b94fc49529ff8288740e21da8a1bb03e880585e23beba4cec5370` |
| `backend/supabase/functions/_shared/ai/Agents/review-summary/publisher.ts` | `a85ecee4446782bf1c68885d83c902731df0237f3c06ea5d433110b002043505` |
| `backend/supabase/functions/_shared/ai/Agents/review-summary/source-loader.ts` | `683f0b4485d8ac6259925d8669fc28abf6222c070bf51f9a825863ca362159de` |
| `backend/supabase/functions/review-summary-worker/handler.ts` | `9aaf24f3914e6f04408f02f19079b3231a519668aaa7d8335f488d2c00be1012` |
| `backend/supabase/functions/review-summary-worker/index.ts` | `933246942cbaf9c7a94f96fddd51ff7a2c198860eff3a127c75e098168ca4e06` |
| `tests/integration/jonghyun/isolated_summary_factory.ts` | `d2fbd61a383efd54fbafeba89c29e6548ad3d8e21083ab6bcde99e400605c442` |
| `tests/integration/jonghyun/isolated_summary_contracts.py` | `e95358ce940033567258a18c6fcb4ea6c2cb17cb8674a6fee4efa55ce0b94dc7` |

이는 전체194 의존성·공통수송·환경·원 runtime 패키지의 현재 재검증이 아니다. 파일 동일성 검사와 실제 DB/RPC 성공 증거는 구분한다.

## 완료 판정 추천·남은 조건·다음 작업

**추천: WBS5.7의 명시된 격리 DB/RPC·합성 모델14사례 결과 기록·근거 연결 범위는 기존 실제PASS를 근거로 완료 판정 가능하다.** 증거 등급을 ‘저장소로 인계된 실제 실행 기록·원 private 바이트 현재 미확보’로 함께 표시해야 한다. 이번 신규실행PASS·원영수증 재검산PASS·전체194 동일성을 주장하지 않는다.

- 원 영수증/로그가 다시 제공되면 기록된SHA·개별결과·정리를 직접 대조할 수 있다. 지금은 해당 원자료 감사가 미실행이다. 별도 감사에서 원바이트를 필수로 요구하면 그 감사의 미완료를 별도로 남긴다.
- 실회원 원문 외부전송HOLD를 유지한다. 실제 GoTrue/네이버·공급사 품질/안전/비용·실회원·앱 소비·운영 활성화·외부 사본 삭제 이행은 이14 합성 검증의 완료로 표시하지 않는다. 이들을 원문에 없는 새 완료조건으로 추가하지 않는다.
- root가 이 대응표·기존 실행 기록·현재 대장을 연결하고 Notion의 과거0/14 설명과 후속14PASS를 구분해 판정한다. 이 문서 작성자는 원격 수정하지 않았다.
- 다음 독립 민규 미완료를 이어간다. 새 정책/source의 실제 영향이나 증거 충돌이 확인될 때만 해당 범위 재검증을 구체화하며 완료된 요약 로직을 재작성하지 않는다.
