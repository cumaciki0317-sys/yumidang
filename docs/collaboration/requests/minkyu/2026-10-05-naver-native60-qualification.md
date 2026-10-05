# 최신 native60 기존 회원 자격 변경 통합 검증

작성자 minkyu, 2026-10-05. 기존 민규 통합 검사 파일 `tests/integration/minkyu/naver_signup_local.ts`에 명시적인 native60 실행 모드를 추가했다. 기존 기본 모드는 보존했다. 네이버 응답만 합성으로 제공하고 최신 main의 가입·서비스 HTTP handler를 프로세스 내부에서 실행해 실제 로컬 Auth·REST·Storage와 연결했다. hosted Edge·실제 네이버 OAuth·모바일·운영 배포 증거는 아니다.

## 실제 결과

6개 그룹 PASS, 최종 합성 자료 정리 PASS. 증거는 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-naver-native60-QOEgZz/result.json`이다.

1. 정확한 60개 migration·소스 해시, 빈 테스트 자료, 외부 삭제 guard false, 권한 기대 행렬을 확인했다.
2. 합성 회원 두 명의 Auth 세션 발급·실제 JPEG 업로드·명시적 가입 완료·활성 가입 회차 생성을 확인했다.
3. 회원 HTTP로 약속 두 개를 확정하고 양쪽 역할의 대기 동의를 준비했다.
4. 기존 회원의 필수 이름 정보가 누락된 재로그인에서 같은 UID·회차를 유지했다. 신규 공고·신청·동의 제안·본인 수락·상대방 수락은 403이며 기존 약속 조회·동의 조회·offline 신고·취소는 성공했다.
5. 성별 자격이 불충족한 재로그인에서도 같은 신규 활동 제한과 기존 약속 관리·지원 접근을 확인했다.
6. 자격 회복 시 같은 UID·회차로 ready 상태 및 신규 공고 등록을 확인했다.

최종 30개 Auth·Storage·앱 관계 및 저장소 실제 파일이 0개다. guard, 역할의 안전한 flags·설정 해시, 이름 기준 역할 멤버십, 9개 RPC ACL, 전역 점유 해제와 migration60 이력이 실행 전후 동일하다. 키·세션 토큰·응답 원문을 결과에 기록하지 않는다.

## 권한과 실패 기록

native60에는 40300 역할 migration을 적용하지 않았다. 따라서 점유·해제 RPC의 service_role EXECUTE 2개는 true, 나머지 25개 권한은 false로 검사한다. DB 권한을 바꾸어 검사에 맞추지 않았다.

첫 실행은 회원 생성 전 잘못된 권한 기대값 때문에 실패했다. 영수증은 `yumidang-naver-native60-6bstmI/result.json`이다. 두 번째 실행은 가입·사진·약속 확정 3개 그룹을 통과한 뒤 약속 조회의 배열 응답을 객체로 가정한 테스트 오류로 실패했다. 저장소 삭제의 배열 응답도 같은 오류를 기록했으나 실제 Auth·앱·Storage 자료와 파일은 0개로 정리됐다. 영수증은 `yumidang-naver-native60-vQJX7N/result.json`이다. 최종 검사는 약속 조회의 1행 배열과 정확한 약속 ID·상태를 검사하고, 사진 삭제 200 응답 뒤 실제 메타데이터·파일 0개를 확인했다. 이전 실패 영수증은 보존하며 PASS로 변경하지 않았다.

## 재현 및 남은 범위

6그룹 실행 시점의 검사 파일 SHA256: `5848b1c3e78a4d005f8ed2386ea251047facfc29bf940fc17fd7a8568895e041`. Node 구문 검사와 main Deno 타입 검사 PASS다. 실행은 명시 옵션과 검토된 private 로컬 설정·manifest 경로를 모두 요구한다.

```sh
node --experimental-strip-types tests/integration/minkyu/naver_signup_local.ts \
  --native60-approved \
  /private/tmp/yumidang-drift-catalog-44g9wt_e/current52-local-status.json \
  /private/tmp/yumidang-policy60-reviewed-xze3cqci/prepared/migration-manifest.json
```

최신 환경의 실제 네이버 OAuth·사진 완료 전체 흐름, 사진 교체 실패 시 기존 사진 보존과 마지막 필수 사진 삭제 차단, 모바일 복귀와 운영 연결은 별도 검증이 남아 있다. 이번 결과만으로 인증 영역을 전체 완료로 표시하지 않는다.

## 후속 사진·성향 검증: 실제 10그룹 PASS

동일 명령의 후속 검사 파일 SHA256은 `dd9d6c29fe422a5542cf1d86fd9f4b8a407812dc0fe1ed4384ebd3586c50ee0b`다. 실제 native60 실행은 10그룹 PASS, 정리 PASS이며 영수증은 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-naver-native60-b48l3C/result.json`이다. 원래 6그룹도 모두 재통과했다.

- 존재하지 않는 본인 사진과 타인 경로 교체는 HTTP400 INVALID_REQUEST이며 기존 대표 사진 포인터·객체 metadata·실제 다운로드 bytes가 같음을 확인했다. 타인 경로는 소유 UUID 형식 검사를 먼저 거치므로 403으로 임의 가정하지 않았다.
- 현재 사진의 실제 Storage DELETE는 HTTP400, AccessDenied와 semantic statusCode403으로 거절됐다. clear RPC 직접 호출은 403/42501이며 두 경우 모두 기존 사진 정보·내용을 유지했다.
- 새 JPEG를 실제 업로드하고 /me/avatar의 정확한 snake_case 1행 배열로 포인터 교체를 확인했다. 회원 토큰으로 이전 사진을 삭제한 뒤 객체 metadata와 정확한 경로의 실제 파일이 없음을 확인했다. 새 현재 사진 DELETE도 차단되고 포인터·metadata·내용이 유지됐다.
- 성향 유효 값 저장·조회, 잘못된 MBTI와 41자 항목의 400 INVALID_REQUEST, 이전 DB 행·성향 반환 보존, 원래 입력의 명시 재시도가 통과했다. 실제 화면 입력 보존을 서버 결과만으로 주장하지 않는다.

최종 30개 관계 및 저장소 실제 파일은 0개이며 역할·멤버십·guard·9 RPC ACL·전역 점유·migration60 기준은 그대로다. 사진 내용·사진 경로·UUID·세션 토큰은 결과에 기록하지 않고 보존 여부의 boolean만 남겼다. 사진 응답 유실·동시 교체·기존 signed URL 철회 및 모바일 전체 연결은 이 검사 범위가 아니다.

인증 영역은 이 핵심 로컬 증거를 근거로 단계 지표 75가 됐으며 전체 달성률은 55%다. 실제 네이버 응답은 여전히 합성이므로 OAuth·hosted 가입·운영 완료와 구분한다.
