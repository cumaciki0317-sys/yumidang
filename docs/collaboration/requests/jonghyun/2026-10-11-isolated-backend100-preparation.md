# 종현 전용 합성 DB 준비와 실행 차단

작업자 `jonghyun`, 별도 clone `yumidang-jonghyun-backend100`, 브랜치 `jonghyun/backend100`. 전체 **79%(22/28)** 유지. 준비·모형 검증을 실제 DB/운영 완료로 집계하지 않는다.

## 현재 소스 준비

기존 `tools/local/prepare_database.py`에 `--project-id`와 `--port-base` 선택 옵션을 함께 추가했다. 기본 호출의 설정 바이트와 manifest는 유지한다. 명시적인 `jonghyun-backend100` 또는 뒤에 소문자 8자리 hex를 붙인 새 프로젝트만 허용한다. 원본과 동일한 project_id는 거절한다.

임시 실행 설정에서 project_id와 API/DB/shadow/pooler/Studio/SMTP/analytics 일곱 포트만 바꾼다. 최종 TOML이 허용된 변경만 포함한 예상값과 정확히 같아야 하며 인증·seed·Edge·함수 설정은 보존한다. SQL의 기존 HEAD/해시·출력 보호 검사를 그대로 사용한다. 원본/최종 설정 해시와 overlay를 manifest에 기록하고 runtime_readiness/port_availability를 NOT_VERIFIED로 남긴다. 서비스 기동·포트 예약·원격 호출은 하지 않는다.

현재119개 정식 SQL(SQL120 숨긴 메시지 읽음 포함)을 새 임시 폴더에 준비했다. 프로젝트 `jonghyun-backend100`, API61621·DB61622·shadow61620·pooler61629·Studio61623·SMTP61624·analytics61627을 복사본에만 적용했다. 포트는 아직 기동 전 실제 점검 대상이다. sql_execution=NOT_RUN이며 런타임 준비 완료가 아니다.

검증: 신규 합성 준비6개와 기존 DB 준비/대상 경계10개, 총16개 PASS. 독립 읽기 리뷰에서 확정 결함 없음. 기존 최종 커밋7b8147f의 관련 Node60/60와 Deno check:service/check:common은 직전 재검증 PASS이다. 이번 변경은 Python 준비 도구와 테스트/기록이며 서비스 코드 변경이 없다.

실행 예시(복사만 수행):

```sh
python3 -B tools/local/prepare_database.py --output <새 빈 시스템 임시 폴더> \
  --project-id jonghyun-backend100-<소문자8자리hex> --port-base 61621
```

## 실행과 푸시 상태

승인 전달에 따라 `origin`을 `https://github.com/cumaciki0317-sys/yumidang.git`로 설정했다. 원격 읽기에서 foundation=ba6038a, main=472c570이고 jonghyun/backend100은 없었다. 정상 push는 자동 승인 검토가 거절해 실행되지 않았다. 전달된 선택답변만으로 해당 목적지로 저장소 코드를 내보내는 사용자 승인을 명확히 확인하지 못했다는 이유다. 우회/강제 푸시를 하지 않았다.

전용 Colima jonghyun-backend100 생성도 자동 승인 검토가 거절했다. 전달된 5번A만으로 최초 읽기 전용/서비스 실행 금지 범위를 바꾸는 승인을 확인하지 못했다는 이유다. VM/CLI/이미지 설치와 서비스 시작은 모두 미실행이다. 사용자에게 정확한 목적지 푸시와 2CPU/4GiB/20GiB 새 환경·공식 CLI/이미지 다운로드·합성 서비스 실행을 명시한 직접 승인 확인이 필요하다. 기존 VM/컨테이너 수정·중지·삭제, 실회원 HOLD 해제, 운영 DB 쓰기/배포, 회원 원문 외부 전송은 요청 범위가 아니다.

현재 계정 전용 Docker socket 부재, Supabase CLI PATH 미설치가 확인됐다. 샌드박스 밖 Colima status는 timeout이므로 VM 전체 상태/캐시/자원 READY 또는 실제 중지를 단정하지 않는다. 과거 CPU 혼잡 기록을 현재 결과로 사용하지 않는다.

## 백업·복원 담당과 원본 의존

사용자가 원본 제공 항목을 처음 듣고 민규 담당 여부 확인을 요청했다. 사용자가 백업 위치나 원본 보유자라고 전제한 요청은 보류한다.

- 2026-10-09 백엔드100 계획7장4번은 “민규 독립 운영 준비”로 전체 DB/역할/Storage 복구를 배정했다.
- 2026-10-10 최신 backend100 인계22행은 backend·tools/local·기존 테스트의 종현 이관을 명시한다. 다음 실행5번은 최종 백업/격리 복원/운영 적용 검토 묶음 준비를 포함하므로 후속 기술 준비·검증은 종현 잔여 작업이다.
- 같은 인계32행은 원 영수증·폐쇄 wrapper/graph가 “민규 컴퓨터 /private/tmp” 비공개 자료이고 Git에 포함되지 않는다고 명시한다. 이 기술 작업 이관을 실제 운영 계정·원본자료 접근권·자료 보유 책임의 자동 이전으로 해석하지 않는다.
- 최종 복원 정적 기록은 작업자 민규이며 source112/Storage103과 합성 canonical native DB, 실제 운영 DB를 구분한다. Storage39개 누락은 과거 보호 합성 자료의 미해결 기록이며 실제 사용자 파일39개 누락이라고 단정하지 않는다.

해당 과거 private graph/receipt 경로와 현재 clone 옆 minkyu-foundation은 내용 없이 존재만 확인했으며 현재 머신에서 부재였다. 원본/.env/JWT/덤프/회원 자료는 읽거나 출력하지 않았다. 자료 보유·원본 위치·접근/보관/운영 책임은 민규 및 실제 운영 담당자의 인계 확인이 선행 의존이다. 명시적인 담당 문서 갱신·접근 승인 없이 이 책임을 사용자 또는 종현에게 임의 배정하지 않는다.
