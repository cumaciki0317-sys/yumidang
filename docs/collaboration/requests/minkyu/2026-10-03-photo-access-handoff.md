# 프로필 사진 접근 보완 — 2026-10-03

전체 **43% · 6/14**를 유지한다. 기존 authenticated 전체 bucket 읽기를 가입 중 본인 사진·일반 회원의 현재 프로필 사진으로 제한한다. 기존 미검증 회원 읽기 유지, 새 활동 네이버 자격 게이트를 일반 사진 조회에 적용하지 않는다. 탈퇴/삭제 절차는 이번에 임의 결정하지 않는다.

[이번 하네스](../../minkyu-photo-access-harness.json)의 단독 편집을 따른다. 공식 CLI가 생성한 `20261002170743_profile_image_access.sql`을 기존 작성 위치에 구현했다. DB·실제 Storage HTTP 검증 모두 통과했다. 운영·기존 네이버 프로젝트는 보존한다.

## 현재 실제 검증

40개 SQL의 별도 로컬 기동 exit0, 준비 도구11검사 PASS. SQL rollback 검사7그룹 exit0으로 가입전/회원/guest/잘못된 claims/현재 사진·미채택·교체전 사진/기존 업로드·삭제 보호를 확인했다. assertion 활성 상태와 rollback 뒤 Auth/프로필/사진0을 별도 확인했다.

실제 Auth·Storage HTTP **7그룹·606확인 PASS**다. 합성 JPEG 업로드·원본과 동일한 다운로드·서명 URL 발급/조회, 본인 가입중·현재·교체전 사진, 기존 네이버 미등록 회원의 타인 현재 사진 읽기, 가입전/익명/실제 GoTrue guest JWT의 타인 사진 거절을 확인했다. 타인의 미채택/교체전/프로필 없는 사진도 새 다운로드·새 서명 발급이 거절됐다. 자료 정리 뒤 앱37개 테이블·Auth·Storage0을 확인했다. 실제 외부 네이버나 운영 회원 사진은 사용하지 않았다.

- SQL SHA256: `933597ecfa225eefbc9fb51eeee5f71c239f5cdc63c524325dbd7b9bb55404b0`.
- rollback 검사 SHA256: `598d9e16d99f1755be8cfb57b259960fa143546500f6765e8585188919dda24c`.
- HTTP 검사 SHA256: `843e0105805c475cc06ca1990d410a4c178c585112bdeb4cf80bb4eaa09a2bb1`.

새 helper는 빈 search_path의 SECURITY DEFINER이며 authenticated에만 EXECUTE를 부여한다. 소유자와 UUID 경로를 함께 확인하고 타인 사진은 조회자 profiles 존재 및 대상의 현재 avatar 연결을 요구한다. 기존 회원의 읽기에 새 네이버 활동 자격을 요구하지 않는다. INSERT·DELETE·bucket·기존 RPC는 보존한다. CLI2.116의 로컬 security advisor는 exit0/`No issues found`를 보고했다. 이 제한된 도구 결과를 운영 Auth 설정·모든 보안 조건의 적정성으로 확대하지 않는다.

실행 루트는 `/private/tmp/yumidang-photo-access-20261003-hvyibwo7/edge`이며 API56521/DB56522를 사용한다. 원격 적용 후보는 이제 기존20 대비20개지만 운영에는 적용하지 않았다.

검증 후 CLI stop exit0, 임시 키 설정과 실행 로그 삭제, 보호158개 파일 해시 일치를 확인했다. 최종 Docker 실행 목록은 기존 네이버 전용5개 컨테이너뿐이다. 원본 .env와 정책.md 해시도 동일하며 Git 스테이징·커밋·푸시는 하지 않았다.

[공식 Storage 접근 안내](https://supabase.com/docs/guides/storage/security/access-control)에 따라 RLS를 실제 Storage 요청으로 확인한다. [signed URL 안내](https://supabase.com/docs/guides/storage/serving/downloads)처럼 이미 발급한 URL은 만료까지 유효하므로 사진 교체 뒤 즉시 회수된다고 주장하지 않는다. 새 인증 다운로드와 새 URL 발급 권한을 검사한다.
