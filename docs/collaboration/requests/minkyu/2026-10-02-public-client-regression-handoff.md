# 공개 client 기존 인증 회귀 동기화

전체100%목표와43%·6/14 유지. [공개 상세 인계](2026-10-02-public-detail-handoff.md)의 단위15개·실제AuthDBHTTP346개 확인 통과 후, 기존 auth_db.test.ts의 get_service_post 익명차단 기대를 최신 좁은 공개 읽기 허용목록과 맞춘다. 실제 제품코드와 SQL은 변경하지 않는다.

허용5RPC의 익명 키 전용 전달을 양성으로 검사하고 사용자/내부/쓰기/임의RPC차단은 보존한다. 검사 실행 결과는 후속 기록한다.

## 최종 실행 결과

총괄이 최종 검사 SHA256 `97b40f54c81cbe29241714994ee4574c34731a716f182feb173407611d6b8834`를 확인하고 기존 service-api/auth-db/matching-lifecycle/appointment-changes/common-connections와 새 public-post-detail Node 검사를 함께 실행했다. 113/113 PASS, 실패·skip·todo0, 종료코드0이다. 인증 검사 자체는 기존23개에서27개로 늘었으며 허용된 공개 읽기5개를 각각 양성으로 확인한다.

과거 거절 목록에서는 최신 정책상 허용된 get_service_post만 제외하고 개인·쓰기·내부·구형·임의RPC 거절을 유지했다. 상세 query/path/case 위조5개를 추가했고, 비공개 인증·DB 검사는 수정 전 보존 내용과 비교했다. 서버 비밀값 getter에 접근하면 실패하도록 각 읽기에서 anon key 전용 전달을 검사한다. 기존94개에서 새 양성4개와 상세15개가 추가된113개이며, 실제AuthDB 통합346개 확인과 구분한다.

service-api/index, auth_db.test, public_post_detail.test, public_post_detail_local의 Deno check도 모두 통과했다. 제품코드·SQL·실제 사용자 자료는 이 단위에서 변경하지 않았다. 종현 기존HTTP3/SQL2의 별도 기대 불일치와 숫자HTTP·AI·연결 행사명은 남아 있다. 전체43%·6/14를 유지하며 다음은 로컬Edge gateway CORS·인증 재현 후 상주완료 실행기 복구 검증이다.
