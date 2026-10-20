# WBS4.8 공유 시점 상태

2026-10-20 팀 통합용 커밋·푸시 요청에 따라 검토된 정확3파일을 `b581d12`로 로컬 커밋했다. 기존44개 PASS 당시 소스 SHA는 그대로다. 아래 기록의 커밋승인대기 문구는 이전 상태이며 이 커밋을 설명하는 현재 조건이 아니다. 실제 Auth/me/원3600초 자연만료 검증은 아직 NOT_RUN이고, 사용자의 실행 일시중지를 유지한다. 최종 공유 HEAD가 바뀌므로 과거 authority를 자동 재사용하지 않고 실행 재개 때 새 source/HEAD를 검토해야 한다.

---

# WBS4.8 내 정보 조회 검증

작업자 `minkyu`, 브랜치 `minkyu/wbs-backend-20261017`, 준비 시점 HEAD `1d9b46b69adbc52f693accbff04ca4a00d35c547`. 전체 기준은79%(22/28)이며 이번 준비로 완료 수를 올리지 않는다.

최신 상태: 정확3파일 반영·저장소44회귀 PASS·독립 검토 완료. 로컬 커밋 예외 응답 대기이며 실제 발급·HTTP·SQL0이다. 아래 준비 기록과 구분하며 최종 증거는 문서 하단에 연결했다.

## 최신 완료 기준

2026-10-20 Notion 페이지 `58ca6def75f88217980a010dda12b177`을 다시 읽었다. 완료 기준은 본인 조회·세션 만료·공개 DTO와 사적 정보 분리 증거 및 증빙 연결이다. 기존 API 작업과 별도로 검증하며 실제 네이버 회원 검증 HOLD는 유지한다. 상태는 `작업 중`이다.

## 이번 실행 범위

새 격리 환경에서 발급한 원 Auth6의 계정과 현재 제품 `service-api` factory·실제 로컬 Auth·PostgREST/RPC를 연결한다. 모델·공급사·예산 예약·fixture 쓰기는 이 읽기 검증에서 허용하지 않는다.

| 사례 | 기대 결과 | 인증/DB 호출 |
|---|---|---|
| 본인 `/me` | 200, 계약의5개 필드, 원 계정 일치 | Auth1/RPC1 |
| 인증 헤더 없음 | 401 | Auth0/RPC0 |
| 원 토큰의 서명 첫 문자 위조 | 401 | Auth1/RPC0 |
| 인증된 다른 계정의 공개 프로필 | 200, 공개11개 필드, 이름 마스킹, 사적 키 없음 | Auth1/RPC1 |

위조는 JWT 마지막 문자의 패딩 비트만 바꾸는 방법을 사용하지 않는다. 공개 프로필도 인증이 필요한 현재 서버 계약을 따른다. 로컬 Auth 계정의 프로필·활성 episode는 `/me` 접근 범위를 검증하며 실제 네이버 가입 적격성·사진·일반 활동 자격을 입증하지 않는다.

원 토큰의 자연 만료 검증은 위 네 사례와 분리한다. 동일 원 Auth 환경·세션·JWT·HEAD·실행 identity 및 변경되지 않은 행을 결합해야 한다. 다른 환경으로 토큰을 옮기거나 현재 시각을 과거로 전달하거나 표준 활성 토큰 검사를 우회하지 않는다. 원 수명3,600초를 실제로 기다리는 기존 승인은 유지한다. 현재 새 `/me` 만료 요청은 `NOT_RUN`이다.

## 보존과 실행 경계

사전·사후 전체178개 행 bag, 권한·constraint·catalog와 예산·UNKNOWN을 비교한다. 원 Auth/RPC·제품 응답은 private 원문 파일에 먼저 저장하고 SHA로 판정 결과에 연결한다. 공개 보고에는 토큰·회원 원문을 출력하지 않는다.

실행 직전 원 토큰의300초 여유, 소스·대상 identity, 시작1,048,576KiB/유지786,432KiB를 다시 확인한다. 메모리 또는 deadline 실패 뒤에는 추가 읽기 SQL·HTTP 전송을 거절한다. Node는 링크·FIFO를 거절하는 기존 정규 파일 검증을 재사용한다. 이 조건의 검사 우회 옵션을 추가하지 않는다.

기존 a002 환경은 원 데이터와 UNKNOWN을 보존한 채 네 컨테이너가 정상 종료됐다. 종료 영수증 SHA `1f9be22040e99e531ecd1f439843e9eba4931622aac6ae8a47a59e8a94bb71d5`, 독립 검토42개 PASS다. 종료된 환경의 intent·토큰을 새 실행에 재사용하지 않는다.

## 초기 후보와 확장 준비 기록

검증 도구 세 파일은 `/private/tmp/yumidang-service-profile-readonly-20261020/`의 후보이며 아직 저장소에 반영하지 않았다. 예비 검토에서 발견한 바이너리 읽기·전송 직전 토큰 여유·monitor 실패 후 SQL 경계를 보강한 활성 세션 후보는 오프라인31개 PASS다. 영수증 SHA `49f539d6d20c1178daca76901c7e7f901f385b7fcafa4d85e1a30819fd6142d6`이며 실제 Docker/SQL/HTTP 검증은 아직0이다.

발급 후 만료 검증 코드를 추가해 HEAD를 바꾸면 원 활성 세션의 소스 연결을 유지할 수 없다. 따라서 이31개 PASS 버전을 보존하고, 같은 세 파일에 목적별 원 세션 만료 dispatcher를 먼저 준비한다. 표준 활성 토큰 검사에 만료 허용 옵션을 추가하는 방식은 사용하지 않는다. 최종 후보 동결·독립 검토·회귀 후 소유권 검사를 거쳐 정확한 세 파일만 반영한다. HEAD 일치가 필요한 실제 발급 전 로컬 커밋 예외는 구체적인 변경과 검증 결과가 준비된 뒤 확인한다. 푸시·운영 변경은 포함하지 않는다.

활성31개 후보의 독립 읽기 검토 영수증은 `/private/tmp/yumidang-service-profile-review-20261020/receipt.json`, SHA `309b03c3dd1f7d28c8c962546589182d34527183f073a9cfe1371347dc22cd3f`다. 원본은 후보의 `before-expired/`에 보존하며 만료 확장은 `with-original-expired/`에서만 작성한다. Notion4.8에 도구 검사의 실제 범위를 기존 문단 수정으로 반영하고 작업 중·완료기준 미체크를 재조회했다.

만료 원인 분류의 정적 근거는 cached Auth와 같은 [Supabase Auth v2.196.0의 HTTPError 정의](https://github.com/supabase/auth/blob/v2.196.0/internal/api/apierrors/apierrors.go)와 [JWT 파싱 경로](https://github.com/supabase/auth/blob/v2.196.0/internal/api/auth.go)다. API 버전 헤더가 없는 현재 제품 인증 요청은 기본 응답 형식을 사용하므로 `error_code`·`msg`를 검사하는 설계다. [버전별 오류 응답 코드](https://github.com/supabase/auth/blob/v2.196.0/internal/api/errors.go)도 대조했다. 이는 upstream 정적 소스에 근거한 예상이며 cached 이미지의 실제 만료 응답을 새로 관측했다는 뜻은 아니다. 기존10/17 자연 만료 영수증에는 HTTP 상태·원 토큰·원 행 보존 증거가 있지만 Auth 오류 원문은 없어 메시지 실측 근거로 사용하지 않는다.

## 최종 저장소 반영·재검사

정확한 세 파일을 전용 clone에 반영했고, 저장소에서44개 회귀가 통과했다. 영수증 `/private/tmp/yumidang-service-profile-formalization-20261020-v2/receipt.json`, SHA `1b363c58a54afb22124f7994af439262b8ad7c2f3d01e6bd79e1a747f884c7ec`. factory SHA `4e28e638e868c04812e0647c1f4e26db1ba5b1c64f1858f65391cd1995d06867`, helper SHA `d9b5728b040aeb688f849c3a9ea7d5ad2463ab088b6a514957c73805e89d8e67`, test SHA `4b156623355b004ac52c76b8e7efef17582cf48a85c4244c22e5028e6586dc22`다.

첫 저장소 이식 검사는21error/1failure였다. 코드 clone755 아래에 private 입력을 만든 테스트 설정 및 앞단 positive HEAD 검사와 helper HEAD 검사의 결합이 원인이었다. 실제 보호 검사는 바꾸지 않고 OS 임시경로.resolve/700과 독립 Git fixture로 테스트만 수정했다. 실패 영수증 `f7e5d5ebdf23bc7c03d40b17ebc18a51b677e93924cf13d375b434040ae87b6f`와 원 로그는 보존했다.

활성·만료 독립 검토 SHA `dec1fd3b10631d5cc9845d399948768fd81b746ae1b43e7c01169d61874a8c11`, 테스트 이식 수정 검토 SHA `bedf246428931a4252ec2d99ba53089f3e84b66e1d60cd9ec38124d55295b86f`다. 실제 Docker/SQL/HTTP·새 Auth 발급0, 새 커밋·푸시0이며 HEAD1d9를 유지한다. 원계획의 커밋 제외에 대한 정확3파일 로컬 커밋 예외를 요청했다. 승인 전에는 이에 의존하는 실제 발급을 하지 않고 독립 준비를 계속한다.
