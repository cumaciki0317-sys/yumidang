# 숫자 나이 검색 선행 작업

사용자100%목표를 유지한다. 현재43%·6/14완료이며 실제 네이버 로그인·사진 업로드·명시적 가입 완료·완료 후 상태 조회를 검증했다. 이번 작업은 정책.md의 작성자 만 나이19~99 최소/최대 범위를 DB에 연결하고 종현 검색 코어·AI 계약에 필요한 변경을 자기 요청 폴더로 전달한다. 기존 나이 함수는 이미 만 나이를 계산한다.

[하네스](../../minkyu-search-range-harness.json)의 단독 소유 파일만 수정한다. 기존 SQL 이력·업무 자료·실제 로그인 계정은 보존하며 새 migration과 합성 SQL 검사는 별도 격리 DB에서 실행한다. 원격 적용·운영 배포·커밋·푸시는 이 단위에서 수행하지 않는다. 행사 연결 후 제공처 변경에 따른 표시 정책은 문서에 명시되지 않았으므로 독립된 숫자 나이 구현부터 진행한다.

## 완료 조건과 범위

- 기존 search_public_posts_v2 RPC를 새 migration으로 갱신한다. 숫자 범위는 양 끝 포함19..99, 전체는 상한 없음. 비로그인 상세 범위는 거절한다. 기존 이름/정확한 위치 반환 권한·정렬·커서 위치는 유지한다.
- 이전 코어의 enum 호출은 새 계약 반영 전까지 명시적 호환으로 남기며 최신 숫자 범위 구현 완료와 구분한다. 새 검색 코어를 복제하지 않는다.
- 종현 소유 TS/AI 코어·검사는 직접 편집하지 않고 요청 문서에 입력·RPC·커서 지문·검증 기준을 작성한다. 전체 HTTP/AI 연결 전에는6번을 완료로 올리지 않는다.
- 검사 증거는 실행 후 기록한다. 준비·파일 존재·문법 확인을 DB/HTTP 성공으로 표시하지 않는다.

## 인접 권한 표시 정합성

읽기 검토에서 기존 검색 카드의 canApply는 Auth 역할·프로필만 보고 네이버 자격·사진·활동 세션을 확인하지 않는 차이를 발견했다. 실제 신청 RPC는 기존 네이버 활동 검사로 거절하므로 권한 우회 성공은 아니지만 신청 가능 안내가 불일치한다. 사용자100%목표의 정확한 상태 반환을 위해 같은 새 migration에서 기존 활동 검사를 재사용하는 최소 불리언 판단으로 연결한다. 새 가입 정책을 만들거나 광범위한 DB 오류를 신청 불가로 숨기지 않는다. 적격/부적격 경계는 합성 SQL 자료로 검사하며 실제 사용자 증거와 구분한다.

## 실제 로컬 가입 검증

2026-10-02 로컬 서버의 비밀값 없는 진단을 직접 조회했다. `lastStatus=ready`, `sessionIssued=true`, `authStateVerified=true`, `photoUploaded=true`, `signupCompleted=true`다. 사용자가 브라우저에서 실제 네이버 로그인과 사진 업로드 및 가입 완료를 실행했고, 서버가 완료 후 가입 상태를 다시 조회했다. 호출 집계는 starts1/callbacks1/stateChecks2/uploads5/completions2/rejected2이며 성공 횟수와 동일하다고 해석하지 않는다.

초기 업로드 실패는 로컬 Auth의 ES256 서명을 Storage가 인식하지 못하는 설정 차이였다. 기존 공식 Storage 이미지에 Auth 공개 JWKS를 `JWT_JWKS`로 설정하고 동일 저장소 볼륨을 보존해 Storage 컨테이너만 재생성했다. Auth·DB·실행 중 로그인 서버·원본 환경 파일은 유지했다. 서비스 역할로 사용자 사진 업로드를 대신하지 않았다. 실제 사용자 재시도 후 위 완료 상태를 확인했다. 운영 배포와 전체 프론트 E2E 완료는 별도다.

## 검색 DB 실행 증거

실제 사용자 가입 DB와 다른 `yumidang-minkyu-search-range` 프로젝트의 DB 전용 컨테이너를 사용한다. 기존 이력 35개를 재생했으며 Auth 사용자와 공고는 각각 0개다. 새 SQL을 트랜잭션 안에서 컴파일한 후 롤백했고 기존 검색 함수 정의·사용자/공고 수·migration 이력 수·새 helper 부재가 동일했다. 이 컴파일 결과는 입력·반환 권한·페이지 동작 회귀 통과를 대신하지 않는다.

팀 검토에서 Supabase 익명 Auth 세션의 `is_anonymous=true`가 기존 회원 역할 검사만으로 나이 범위를 사용할 수 있는 차이를 확인했다. 새 SQL은 해당 claim이 없거나 정확한 JSON boolean false인 정상 회원만 상세 나이 범위를 사용하게 한다. true와 잘못된 유형은 전체 검색만 허용하며 별칭·신청 불가 표시를 유지한다. 실제 회귀 결과는 실행 후 기록한다.

### 최종 합성 회귀 결과

동일 격리 DB에서 새 migration과 새 검사를 하나의 트랜잭션에 합쳐 실행했다. 각 파일의 BEGIN/COMMIT 또는 BEGIN/ROLLBACK 바깥 문장을 제거하고 중첩 트랜잭션·psql 명령을 거절했다. PostgreSQL assertion을 활성화했으며 SQL 종료코드0과 아래9그룹 PASS를 확인했다.

- age_range_boundaries: 19/99 양 끝 포함, 전체에서100세 포함, 누락 기본값·수학적 정수 일치
- age_range_invalid_inputs: 역전·범위 밖·분수·큰 수·잘못된 유형·추가 키 거절
- age_range_legacy_compatibility: 기존 enum 기술 호환, 40plus의100세 포함 유지
- age_range_keyset_sort: 두 정렬·마이크로초·동률 ID·페이지 경계
- age_range_combined_filters: 카테고리·기간·모집 상태·비용 동시 적용
- age_range_private_projection: 9개 카드 필드, 실명·주소·생일·상세 만남 지점 원문 제외
- age_range_anonymous_and_spoofing: 익명 전체만, 역할·UID·요청 헤더 위조로 회원 필터 사용 불가
- age_range_naver_can_apply: 적격 회원 true, 미등록·가입 미완료·사진/소유권/metadata 오류·세션 철회 false, guest/잘못된 anonymous claim 전체만, 예상 밖22003 오류 전파
- age_range_storage_preserved: 기존 공고·프로필·비용 미상·비공개 상세 입력 보존

롤백 후 검색 함수 정의 해시 `fa13bc97316c9937e1f853b742736d25`, Auth0·공고0·이력35·새 helper 부재가 모두 실행 전과 같았다. 검증 파일 SHA256은 migration `b9b7d00e6f6fd2af10252e30e371e635a55bcce00f2ee29b3f872eec974a14d0`, tests `0b14299e3c4b41c9c6d77b47fc6bfbf11d26ad662922943b47d01b6aebcbee3d`다.

기존 public_search_v2.sql의 네이버 미등록 프로필도 canApply=true라는 기대는 최신 활동 게이트와 불일치한다. 원본을 수정하거나 기존 전체 회귀를 PASS로 표시하지 않았다. 새9그룹에서는 실제 적격 회원 true와 미등록 false를 구분했다. HTTP·AI 공유 계약·연결 행사명 검색은 남아 있어6번 전체 완료를 주장하지 않는다.
