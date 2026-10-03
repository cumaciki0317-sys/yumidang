# 일일 작업 등록 계약

## 시간과 호출

확정 주기는 매일 **00:01 Asia/Seoul**이다. UTC 스케줄러에서는 **매일 15:01 UTC**로 등록하며 한국에서는 다음 날 00:01이다. 서머타임이 없는 한국 시간 기준이다. 호출은 `POST /functions/v1/scheduled-jobs/daily`, JSON 본문은 `{ "limit": 확정된정수 }`다. 기존 handler의 기술 범위는 1..100이며 운영 limit의 승인이나 기본값이 아니다.

`Authorization: Bearer INTERNAL_WORKER_SECRET`으로 내부 호출자를 검증한다. 회원 JWT·anon key·service-role key를 이 내부 secret 대신 보내지 않는다. 원격 대상의 `SUPABASE_URL`, 내부 secret, 운영 limit, 행사·요약 실행 환경값이 모두 확정·주입되어야 실제 등록할 수 있다. secret을 저장소·작업 명령 원문·로그에 기록하지 않고 스케줄러의 비밀 설정으로 참조한다.

## 검토할 등록 명세

```json
{
  "name": "yumidang-daily",
  "timezone": "Asia/Seoul",
  "cron": "1 0 * * *",
  "method": "POST",
  "path": "/functions/v1/scheduled-jobs/daily",
  "authorizationSecretRef": "INTERNAL_WORKER_SECRET",
  "bodyLimitRef": "승인된 운영 limit",
  "response": "HTTP 상태와 구조화된 단계 결과",
  "automaticRetry": "운영 재시도 승인 후 설정"
}
```

UTC만 지원하는 등록 대상은 cron을 `1 15 * * *`, timezone을 `UTC`로 변환한다. 대상 스케줄러의 시간대 설정과 중복 등록 여부를 실제 등록 전에 확인한다. 동일 호출은 DB의 dedupe·upsert·점유를 재사용하지만 실패나 부분 성공을 정상 완료로 바꾸지 않는다. limit·시간 제한·재시도 횟수는 [운영값 제안](../../docs/collaboration/requests/jonghyun/2026-09-30-operational-values-proposal.md)의 팀 검토가 남아 있다.

## 기능별 분리

- 건별 자동 완료는 기존 DB 영속 예약·Node 상주 실행기다. 이 일일 cron으로 대체하지 않는다.
- 후기 공개는 모델 설정 없이 제출·조회에서 판정한다. 공개 정리·동의/일정 제안 만료와 요약 등록의 결과는 각각 확인한다.
- 행사 갱신과 새 요약 작업 등록은 일일 묶음이다. 정상 분할 요약은 기존 worker의 재개·yield로 계속 처리하며 하루마다 한 묶음만 처리하도록 바꾸지 않는다.
- 실제 AI 외부 호출은 비용 증빙·보관 조건·설정 부재 시 unavailable이다. 실제 회원 원문 전송은 별도 보류 조건을 유지한다.

## 현재 검증 범위

이번 작업은 공통 SQL·RPC·HTTP·환경 이름과 등록 명세를 준비한다. 배포 대상·운영 수치가 미확정이므로 실제 스케줄 등록·원격 호출·운영 정시 실행·Edge gateway 검증은 `NOT_RUN`이다. 등록 명세를 실행 성공으로 표시하지 않는다. [순차 작업 인계](../../docs/collaboration/requests/minkyu/2026-10-02-ordered-backend-handoff.md)에 코드와 실제 로컬 검사 결과를 구분해 기록한다.
