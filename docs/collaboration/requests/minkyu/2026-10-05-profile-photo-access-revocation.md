# 탈퇴 사진 접근 즉시 회수 결함

작업자 minkyu. 최신 정책의 사진 즉시 접근 회수를 충족해야 한다. 기존 signed URL의 실제 무인증 GET은 탈퇴 processing 직후에도 원본 사진을 반환했다.

## 실제 증거

영수증: `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-cleanup-native67-pWIGtL/result.json`. 파일 SHA: `b149566c513ae058ceb430f2edfe8e04784d6d48d9afe7f021e24372e54514a8`. 탈퇴 전HTTP200/634바이트, 처리 직후 삭제ACK0도HTTP200/동일 바이트, 실제 저장소 삭제ACK2 후HTTP400이다. URL·토큰은 기록하지 않았다. 전체 catalog·자료·권한·guard·worker·Auth 감사·사진 파일·보호 컨테이너 복원은 PASS다.

## 수정 기준

사진 즉시 회수 정책이나 검증을 완화하지 않는다. 인증 기반 사진 조회와 발급 단계 권한을 검토하고, 이미 발급된 bearer URL의 회수 조건과 운영 전환을 구분한다. [Supabase 다운로드 문서](https://supabase.com/docs/guides/storage/serving/downloads)는 signed URL이 Auth 키 변경과 무관하게 만료까지 유지된다고 설명한다. [Storage helper 문서](https://supabase.com/docs/guides/storage/schema/helper-functions)는 작업별 조회 권한을 구분하는 helper를 제공한다. 실제 설치 버전 호환성과 실제 접근 검증이 필요하다. 수정은 아직 NOT_RUN이며 운영 DB/실제 네이버/종현 모바일 파일을 변경하지 않았다.


## 로컬 보완 검증과 종현 연결 요청

신규69 후보는 단건·다건 서명 URL과 signed upload 발급을 차단하는 restrictive SELECT/INSERT 정책과 회원 인증 사진 GET을 추가한다. 실제 native68 단일 TX SQL 검증은 `/private/tmp/yumidang-photo69-candidate/receipt.json` PASS이며 기존 객체가 남아 있는 탈퇴 processing 단계의 조회 거절을 확인했다. 바이너리 HTTP 모형12개 PASS다. 신규69 영속 적용과 실제 Storage API 검증은 아직 NOT_RUN이다. 위 원본 정책 FAIL을 성공으로 덮어쓰지 않는다.

종현담당 모바일 연결은 [사진 전달 계약](../../../../backend/contracts/profile-images.md)을 따른다. 기존 avatarPath를 `GET /functions/v1/service-api/profile-images/{ownerUUID}/{imageUUID}.jpg`로 전달하고 현재 회원 Bearer를 붙인다. 로그아웃·회원 전환·탈퇴·대표사진 교체 때 이전 사진 상태와 캐시를 해제하며, 서명 URL 발급이나 서비스 키 fallback을 추가하지 않는다. 사진 요청/토큰/응답 bytes를 로그·저장 이력에 넣지 않는다. 이 문서는 연결 요청이며 종현 소유 파일은 수정하지 않았다. 실제 앱의 회원 전환·탈퇴 후 새 요청 차단 검증이 필요하다.

운영에서 이미 발급한 URL과 CDN 전환은 별도 작업이다. 새 발급 제한만으로 기존 URL이 즉시 회수됐다고 보고하지 않는다. 실제 대상 객체·캐시 전환과 운영 접근 검증 완료 전에는 인증/탈퇴 단계와 운영 배포를 완료로 표시하지 않는다.


## native69 실제 Auth·Storage·인증 사진 검증

민규 기준60% 유지. 최종 검증 파일 `3d892d005f4f2a1eb45476b532e15290fc832ae2c9cec76e860a2f86611c5848`의 실제 native69 결과 `/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-cleanup-native69-ienEqP/result.json`은 PASS11개다. 단건 서명400, 다건200이지만 signedURL NULL/항목 오류, JPEG/정상 크기의 signed upload400/RLS 거절, 변환 서명400으로 bearer 발급이 없음을 확인했다. 정상 canonical 업로드·현재사진 삭제 거절·회원 RPC 대표사진 교체·이전사진 삭제도 실제 Storage로 검증했다.

탈퇴 전 본인/활성 상대의 GET·HEAD·INFO·인증 바이너리 HTTP는200이며 GET/HTTP는 정확 JPEG였다. 실제 탈퇴 RPC의 processing·삭제 ACK0·사진 파일2개 상태에서 본인 Storage400/HTTP401, 상대 Storage400/HTTP404로 이미지 bytes가 차단됐고, 대상 Storage DELETE ACK2 뒤에도 차단됐다. 남은 상대의 본인 사진은 계속200이다. 외부 정리 task는 실제 Storage2회 삭제→Auth1회 삭제→completed이며 가짜 완료를 넣지 않았다.

정리는 기존 Auth 감사 정확한 ID·전체 catalog/행 수/사진 파일0·guardfalse·worker 해제·정리 RPC owner/ACL·보호된 네이버 컨테이너 복원 모두 PASS다. 새 인증 요청의 실제 차단과 과거 발급 URL 회수는 별개다. 기존 native67 pWIGtL FAIL을 유지하고, 이미 발급된 URL/운영 CDN 전환·hosted Edge·모바일 캐시는 미검증 상태다. 실제 네이버 OAuth나 운영 DB를 변경하지 않았다. 모바일 연결과 운영 전환이 남아 있으므로 전체 인증/탈퇴 정책을 완료로 표시하지 않는다.
