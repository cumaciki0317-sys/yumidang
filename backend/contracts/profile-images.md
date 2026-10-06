# 프로필 사진 전달 계약

민규담당. 기존 [가입](signup.md)의 사진 선택/완료·[코어 DB](core-service-db.md)의 pointer swap/삭제 계약을 재사용한다. 이 문서는 사진 bytes 전달·서명 금지·캐시·탈퇴 회수 경계만 설명하며 가입 기능을 중복 구현하지 않는다.

## 현재 구현과 로컬 검증

`20261005143045_profile_image_authenticated_access.sql`은 Storage v1.70.3에 맞춰 profile-images의 기존 SELECT/INSERT 정책에 restrictive operation 제한을 추가한다. 기존 본인 소유 path, 가입 전 본인 사진, 회원의 현재 대표 사진, 탈퇴한 조회자/대상 차단을 유지한다. Storage provider 함수·bucket·owner ACL·삭제 guard·마지막 대표사진 삭제 trigger를 변경하지 않는다.

허용 operation은 authenticated GET, legacy authenticated info GET/HEAD, canonical upload, single/multiple DELETE다. 미설정/알 수 없는 operation, 서명 단건·다건·signed upload, 변환, S3, TUS, 복사, 이동, upsert를 허용하지 않는다. INSERT 제한은 signed upload 발급 권한을 차단한다. 실제 v1.70.3에서 회원 JWT 업로드·대표사진 교체·현재사진 삭제 거절·이전사진 삭제와 authenticated GET/HEAD/info 흐름을 검증했다. S3/TUS 및 모든 변환 경로의 직접 프로토콜 검증은 별도이며, SQL operation 제한과 실제 검증 범위를 구분한다.

## 사진 GET

`GET /functions/v1/service-api/profile-images/{ownerUUID}/{imageUUID}.jpg` 또는 로컬 `/service-api/profile-images/...`다. query/body/Range를 받지 않는다. 회원 Bearer JWT와 기존 Origin 검사를 사용하며 익명·내부 키·서비스 키로 재시도하지 않는다.

Supabase Auth user 확인 → 같은 사용자 JWT로 private Storage GET → JPEG/최대2MiB 제한된 bytes 읽기 → 같은 사용자 JWT의 authenticated HEAD 권한 재확인 → image/jpeg 응답 순서다. HEAD가 탈퇴·대표사진 교체로 거절되면 이미 읽은 bytes를 응답하지 않는다. 업로드 원본 JPEG/PNG10MiB 선택·픽셀 재인코딩은 기존 업로드 계약을 따른다.

성공 응답은 `Cache-Control: private, no-store`, `Pragma: no-cache`, `Expires: 0`, `Vary: Authorization, Origin`, `nosniff`다. upstream ETag/캐시/쿠키/Location을 전달하지 않고 304·signed URL을 반환하지 않는다. 오류는 기존 JSON envelope/no-store다. 사진·토큰·URL을 로그나 DB에 복제하지 않는다.

공개 프로필 DTO는 기존 avatarPath를 유지한다. 모바일은 Bearer로 이 endpoint를 읽거나 인증 header를 전달하고 이미지 상태를 세션 변경·로그아웃·탈퇴 때 해제해야 한다. 종현 소유 service.ts/remote.tsx/ui.tsx 변경은 별도 연결 요청이며 이 구현에서 수정하지 않는다. 이미 내려받은 bytes 자체를 서버가 회수할 수 있다고 주장하지 않는다.

## 기존 발급 URL 전환과 증거

실제 native67 pWIGtL 검증은 정책 FAIL이다. 탈퇴 processing/ACK0 뒤 signed URL이 exact JPEG634bytes를 반환했고 Storage DELETE ACK2 후에만400이었다. 전체 자료/catalog/권한 원복 PASS와 정책 FAIL을 구분하며 이 증거를 덮어쓰지 않는다.

신규 발급 차단은 이미 발급한 bearer URL을 회수하지 않는다. 운영의 기존 객체/URL 전환은 실제 삭제·캐시/CDN 검증 전까지 미완료다. Auth 키 회전이나 TTL 단축으로 즉시 회수 성공을 주장하지 않는다. 공식 [다운로드](https://supabase.com/docs/guides/storage/serving/downloads)·[operation helper](https://supabase.com/docs/guides/storage/schema/helper-functions)·[Smart CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn)을 따른다. signed URL의 cache TTL은 토큰 만료와 독립이고 삭제 전파에 시간이 걸릴 수 있다.

## 실제 검증 결과와 남은 범위

2026-10-06 기준 독립 로컬 native69 정식 적용 PASS, 후속 SQL 회귀 PASS다. native68 위의69 SQL 후보 single-TX 검사도 PASS였으며 rollback 뒤 정책·catalog·자료·컨테이너·Storage 파일을 원복했다. 정식 적용은 이력69/pending0, 신규 restrictive 정책2개를 확인했고 기존 catalog·권한·자료·보호 컨테이너를 보존했다. 근거는 [정식 적용 receipt](/private/tmp/yumidang-native69-rollout-reviewed/application-receipt.json)·[후보 SQL receipt](/private/tmp/yumidang-photo69-candidate/receipt.json)다.

실제 로컬 Auth·REST·Storage v1.70.3 및 같은 source의 in-process service-api HTTP 검증은11개 검사 PASS다. [native69 결과](/private/var/folders/tp/_t18zyx52jn7sb6bg_9tjczc0000gn/T/yumidang-cleanup-native69-ienEqP/result.json)에 다음 관측과 원복 결과를 기록했다.

- 서명 단건400, 다건200의 항목별 signedURL=null, signed upload400의 RLS 거절, 변환 옵션을 포함한 서명400으로 bearer 발급이 없었다. 다건의200을 발급 성공으로 취급하지 않는다.
- 본인과 활성 peer는 탈퇴 전 authenticated GET/HEAD/info 및 HTTP wrapper에서200이었다. GET/wrapper는 합성 JPEG bytes와 일치했고 wrapper는 no-store·캐시 헤더 차단을 확인했다.
- 실제 탈퇴 RPC의 processing, Storage DELETE ACK0, 원본 파일2개가 아직 남은 시점에 본인과 활성 peer의 대상 사진 GET/HEAD/info는400이었다. wrapper는 탈퇴 본인401, 활성 peer404였으며 사진 bytes를 반환하지 않았다.
- 실제 Storage DELETE ACK2 이후에도 같은 접근 차단을 유지했고 활성 peer 자신의 사진은200이었다. 이후 실제 Auth 삭제를 완료했다. 대표사진 삭제 거절 → 회원 RPC로 교체 → 이전 사진 삭제도 실제 HTTP로 통과했다.
- finally에서 전체 relation counts·catalog·정책·role/ACL·Auth audit·원본 파일·guard·worker·보호 컨테이너를 정확히 원복했다. 정책 검증 PASS와 원복 PASS를 각각 기록했다.

회원의 네이버 자격/binding은 합성 fixture이며 실제 네이버 OAuth 검증을 뜻하지 않는다. hosted Edge, 모바일 연결·메모리 캐시 해제, 운영 CDN, 기존 발급 URL 회수는 NOT_RUN 또는 NOT_PROVEN이다. SQL/HTTP 모형·로컬 실제 검증·운영 검증을 구분하고 기존 native67 signed URL 정책 FAIL을 유지한다. 위 결과만으로 인증·탈퇴 전체 기능이나 운영 준비가 완료됐다고 판단하지 않는다.
