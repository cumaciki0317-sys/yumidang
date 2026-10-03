# 유미당 원격 적용 준비 — 2026-10-03 갱신

현재 전체43%·6/14 완료다. 대상과 변경을 구체적으로 검토하는 문서이며 **원격 적용 완료 또는 배포 승인 기록이 아니다**.

## 확인한 실제 대상과 보존 기준

사용자가 Project ID `bndguguarijmghnkenvt`를 직접 확인했다. 권한 수신 뒤 Supabase connector에서 프로젝트 이름 `yumidang`, ACTIVE_HEALTHY를 확인했다. 2026-10-03 읽기 전용 `list_migrations`에서 원격 이력20개가 앞선 catalog 검증 때의 버전과 동일함을 다시 확인했다. 모두 로컬 정식 이력28개에 포함되며, 검토된 pending13개를 더하면 목표 SQL은41개이고 원격 적용 후보는21개다. 앞선 원격20/격리로컬20의 정적 catalog14분류0차이 확인은 당시 구조의 증거다. 이번 이력 재확인은 함수·권한의 무변경이나 정책 적정성을 증명하지 않으므로 실제 적용 직전에 drift를 다시 확인한다.

앞선 원격 읽기에서 본문 없이 확인한 당시 개수는 다음과 같다: Auth3·프로필3·공고2·약속1·확정 약속0·후기2. 기존 데이터를 지우거나 합성 fixture/seed를 넣지 않는다. public/private 기존14개 테이블의 RLS는 모두 활성 상태다. Edge 함수는 기존 테스트 인증2개이며 삭제·대체하지 않는다.

앞선 원격 읽기에서 `yumidang-auto-complete-appointments` cron의 매분 활성 상태를 확인했다. 이번에는 cron 변경을 수행하지 않았다. 건별 영속 예약으로 바꾸는 migration을 적용할 때 기존 cron만 먼저 해제해서는 안 된다. 로컬 원형 Node 실행기의4그룹 복구 PASS는 운영 상주 호스팅·연결·프로세스 관리·최소 권한의 증거가 아니다.

## 검증된 준비와 미실행

로컬 gateway/CORS82확인과 Kong 재시작·명시 재적용, 실제 PostgreSQL 실행기 복구4그룹, 장소/행사3공급사→저장2건→공개조회, 합성 모델 요약worker 실제RPC3그룹, 최신 행사/수동 교체 동의 SQL12그룹, 내부 공식순위 저장 SQL5그룹은 실제 검증했다. 각 자료 정리 또는 rollback 보존을 확인했다. 원격 환경의 같은 결과를 대신하지 않는다.

행사 연결/내부 Top10 HTTP 통합8그룹769확인, 제한 LOGIN 실행기4그룹412확인, 사진 접근 실제 Auth/Storage7그룹606확인, 기존 합성자료20→40 CLI 업그레이드8그룹을 후속 검증했다. 최신41SQL은 격리 CLI 기동·DB 나가기6그룹·실제 Auth/Edge API8그룹525확인이 통과했고 합성 앱38표·Auth·Storage 자료를 정리했다. [나가기 인계](2026-10-03-conversation-visibility-handoff.md)와 [기존자료 업그레이드](2026-10-03-upgrade-handoff.md)가 각 검증 범위를 구분한다. 41개 전체 기능의 운영 인수나 실제 운영자료 복원 성공을 뜻하지 않는다.

공개 Top10 카드/취소·종료 표시 정책과 종현 숫자 검색·AI·순위 수집 어댑터 연결은 남아 있다. 실제 회원 AI 외부 전송·운영 공개 활성화·한도/보관 결정은 승인하지 않았다. free plan과 실제 backup 제공 조건을 확인했으며 DB와 Storage 복원은 별도다. 현재 `SUPABASE_DB_URL`이 없어 실제 운영 백업·복원은 미실행이다. [구조 확인 인계](2026-10-03-schema-drift-handoff.md)의 공식 백업 근거를 따른다.

## 준비할 전환 순서

1. 원격 DB의 구조·함수·권한·스케줄 drift와 백업/복구 준비를 확인한다. 기존 데이터의 개수 및 필요한 보존 불변식을 기준으로 삼고 원문을 로그에 저장하지 않는다.
2. 최신41SQL·함수·권한·인증/행사/worker의 기능별 로컬 증거와 소스 해시를 확인하고 남은 종현 연결·제품 인수를 마친다. 남은 정책·운영 입력을 임의 기본값으로 채우지 않는다.
3. 상주 실행기의 운영 호스트·연결 문자열·재연결/쿼리 제한·프로세스 관리·장애 복구를 준비한다. 비밀값은 로컬 비공개 설정 또는 Secrets로 주입하며 채팅/문서/커밋에 쓰지 않는다.
4. 완료 예약 RPC/영속 자료와 실제 상주 실행기 READY·기한 경과 복구·기존 cron 해제를 하나의 전환으로 검토한다. 중간 장애와 재개 방법을 정하고 cron 해제만 먼저 수행하지 않는다.
5. 원격 SQL21개와 관련 함수·Secrets의 구체적 변경 목록 및 검증 결과를 검토 가능한 상태로 준비한 뒤 적용 여부를 확인한다. 함수7개·CORS Origin·운영 수치·00:01 등록은 실제 준비/검증 전 완료로 표시하지 않는다.
6. 실제 원격 권한·Naver 콜백/사진·행사·worker·복구·기존 데이터 보존과 프론트 연결을 확인한다. 적용 이력만으로 전체13/14번을 완료하지 않는다.

## 현재 남은 SQL 후보와 해시

아래는 현재 디스크의 후보 순서와 SHA256이다. 실행 시에는 완료된 검증 후 다시 일치 여부를 확인한다. 운영 전환 조건이 충족되지 않은 상태에서 전체를 일괄 실행하지 않는다.

| 파일 | SHA256 |
|---|---|
| `20260923090000_worker_jobs.sql` | `35cc37ed31145fc59ec5ee0580db3f49ccfd36ca19abe2208eccc5f9fe7bee5f` |
| `20260923091000_public_post_search.sql` | `3d95413693ed39cccf4c40c9a4c642f8d75cf9c53590c35495a7c0f1cd0a5822` |
| `20260923092000_review_summary_storage.sql` | `71c58e1587d2949ed7292d591a5505cbc33b53fab2a9ae5ac38a77f68e6d5d52` |
| `20260923100000_bilateral_completion.sql` | `d49cd183f46738412f2fb5fff8737dee5bac30431011c18f939671ba3d7a8cd2` |
| `20260923101000_review_automation.sql` | `499a5f5867540179301f34ec82d5d6f15934e026febeaf267781c62fe5543e5b` |
| `20260923102000_core_service_api.sql` | `17039dccff591f32e05f8fd8af83cea729cd1b51721f8ac8ad9a6b388e045133` |
| `20260929090000_public_search_v2.sql` | `7291d87a34c6cdef707d97af502f7097ac6edf6ff2fd6fe34023116959683525` |
| `20260929100000_event_storage.sql` | `8b853ab4af4311552126bbf66f073a9b2baeaad2371fabb2d0afc1ee2196931c` |
| `20260929120000_review_release_and_completion_reservations.sql` | `8cd13df2cfa9e92a8a3ea0e21d2917cdc32d03441cb5a2957665fbbee60366b2` |
| `20261002090000_naver_signup.sql` | `835cedd273fbb901a8ecc1aff538bbb9f89c3f1ea49aa6e18fbfdc4d61722338` |
| `20261002100000_matching_lifecycle.sql` | `58e175eb4af6fd3e551c23c22c6a2d8b50c6d420d5c91389e460c39be29ec977` |
| `20261002110000_completion_review_policy.sql` | `4b9ee69e4230dd62f70d2fa711a69b857b93d6bf17afa297192543389fc57615` |
| `20261002120000_appointment_changes.sql` | `dec9b0753ff6b8da4db33c1044615ed7cd82f47c37170eff2bf3293ded7d3f86` |
| `20261002130000_ai_budget_worker.sql` | `ea61b1d1d8b0ea1b57e44f97c56c32ab3121b6273ef83f6364d64c5b979e30e6` |
| `20261002131000_events_public_profile.sql` | `8ac1eb3857d29ecbbccd543bbd0f58a440043234c086f734860d664562a0eb0b` |
| `20261002140000_public_search_age_range.sql` | `b9b7d00e6f6fd2af10252e30e371e635a55bcce00f2ee29b3f872eec974a14d0` |
| `20261002150000_post_event_links.sql` | `0d436dc31e8483603d8751ca25f7d50e79660f613c220aa220ab5a514b03475a` |
| `20261002160000_event_rankings.sql` | `a59ef5cdd304a5361f21b7e81d4cb3add630fedc0ebe6f51fd020ecf6dda203b` |
| `20261002170743_profile_image_access.sql` | `933597ecfa225eefbc9fb51eeee5f71c239f5cdc63c524325dbd7b9bb55404b0` |
| `20261002174755_conversation_visibility.sql` | `e476d098e82c52352b484b724b0f041b209b077821ca9d9642c69aca5a0999c6` |
| `20261003090000_completion_runner_role.sql` | `98425e7c855914bf49899b4a68704686e615fdfeac6a2852e9674f4ecd5e65fc` |
