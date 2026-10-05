# 모바일 대표 사진·성향 서버 연결 요청

작성자 minkyu, 2026-10-05. 읽기 기준은 main 최신 소스다. ownership 검사에서 CommunityScreens.tsx와 service.ts는 jonghyun, 이 요청 문서는 minkyu로 확인했다. 민규 별도 worktree의 후보를 검토해 main 요청 문서로 반영했다. 종현 코드·DB·Provider 변경은 없다. 가입·인증 공통 연결은 [네이버 가입 인계](2026-10-02-naver-signup-handoff.md), [native60 자격 검증](2026-10-05-naver-native60-qualification.md), backend/contracts/signup.md와 연결하고 중복 구현하지 않는다.

## 현재 화면과 실제 API

현재 대표 사진 화면은 CommunityScreens.tsx의 PhotoScreen이다. pickImage()는 JPEG/PNG 형식과 원본 크기를 확인하며 상한은10×1024×1024 bytes다. 사진 URI만 반환하고 ImagePicker quality=0.85만 지정한다. JPEG 재인코딩·최종2MiB 검증·Storage 업로드·RPC swap·old DELETE는 없다. 저장은 app.updateMember({photo})이며 state.tsx의 로컬 상태만 갱신한다. failNext는 미리보기 오류 주입이며 실제 서버 실패가 아니다.

PreferencesScreen도 interests/styles/mbti/intro를 로컬 app.member에서 읽고 updateMember로 저장한다. 현재 service.ts에는 사진 교체·본인 성향 GET/POST 메서드가 없다. 원격 public profile 조회 메서드가 있다고 본인 편집이 연결된 것으로 설명하지 않는다.

service-api 실제 경로는 아래와 같다. 서버 base URL의 /functions/v1/service-api 뒤 상대 경로이며 사용자 Bearer JWT가 필요하다.

| 경로 | 요청 | 실제 data 반환 |
| --- | --- | --- |
| POST /me/avatar | 정확 {avatarPath:string}, ownerUUID/newImageUUID.jpg, 길이77 | set_my_profile_avatar의 TABLE 반환: [{avatar_url:string,previous_avatar_path:string 또는 null}] 한 행 |
| GET /me/traits | 본문 없음 | {interests:string[],conversationStyles:string[],mbti:string 또는 null} |
| POST /me/traits | 정확 {interests:string[],conversationStyles:string[],mbti:string 또는 null} | GET과 같은 전체 성향 DTO |

avatar 응답은 repository가 db.rpc 값을 그대로 반환하고 handler envelope의 data에 담는다. 객체 하나로 가정하거나 snake_case를 무시하지 않고 정확 배열1행을 검증한다. 공개 프로필의 avatarPath DTO와 구분한다. GET/POST /me/traits는 전체 교체다. null arrays는 거절되고 빈 배열·null MBTI로 삭제한다. HTTP는 빈 문자열 MBTI를 허용하지 않으므로 화면의 빈 mbti를 null로 변환한다. interests/conversationStyles는 각20개 이하·각1~40 Unicode code point·앞뒤 공백/제어문자/연속 공백 금지·대소문자 무시 중복 금지다. MBTI는 대문자4글자 [EI][NS][TF][JP]다.

PreferencesScreen의 introduction은 이 DTO에 없다. 현 routes.ts에서 소개 수정 endpoint를 확인하지 못했다. public.profiles.bio의300자 및 기존 column 직접 UPDATE는 별도 기술 인터페이스이며 이 모바일 화면의 같은 저장 경로에 통합된 증거가 아니다. 최신 backend/contracts/service-api.md의 교정된 본인 편집 계약도 같은 경계를 따른다. /me/traits에 introduction을 추가하면 unknown key로400이다. 존재하지 않는 PATCH /me·/me/bio 등을 가정해 호출하지 않는다. 소개 서버 저장은 민규의 별도 계약/구현 연결 요청으로 분리하고, 그전에는 전체 편집이 서버에 저장됐다는 성공 안내를 하지 않는다.

## 대표 사진 교체 완료 기준

1. 원본 JPEG/PNG와 원본 크기를 확인한다. 알 수 없는 크기·형식은 거절한다. picker가 변환한 결과의 크기만 보고 원본10MB 검증을 끝냈다고 하지 않는다. 현재 소스 상한10MiB와 화면의10MB 표기를 정책의 정확 byte 기준과 대조한다.
2. 저장 결과는 실제 JPEG로 디코드·재인코딩하고 출력 MIME=image/jpeg·1~2097152 bytes를 확인한다. 파일명만 .jpg로 바꾸거나 picker quality만 설정하는 방식은 완료가 아니다. 출력이 크면 추가 압축/resize하고 한도 내 결과 없으면 기존 사진과 선택 입력을 유지한다. EXIF 등 원본 메타데이터 전달은 재인코딩 구현의 실제 제거 결과로 검증한다.
3. 검증된 현재 Auth 사용자 UUID/newImageUUID.jpg를 생성해 private profile-images 버킷에 JPEG binary INSERT한다. 매 교체의 새 path, upsert=false를 사용한다. 사용자 토큰만 사용하며 Storage 권한/관리키를 앱에 넣지 않는다. 서비스 API에 사진 binary upload endpoint가 있다고 가정하지 않고 실제 Storage SDK/REST 연결을 담당별로 정한다.
4. 업로드가 실제 성공한 뒤 POST /me/avatar로 pointer swap한다. 서버는 객체 존재·owner_id·경로·JPEG metadata·2MiB를 검사한다. SQL은 profile과 image row를 잠그며 새 avatar_url과 직전 path를 배열 한 행으로 반환한다. 응답의 새 path가 업로드 path와 정확 일치하는지 확인한 뒤 committed UI를 갱신한다.
5. 서버가 반환한 previous_avatar_path가 null이나 새 path와 같으면 DELETE하지 않는다. 다른 이전 path인 경우 현재 사용자 소유 prefix를 확인해 Storage에서만 삭제한다. 기존 대표 사진을 먼저 삭제하거나 같은 path를 덮어쓰지 않는다. 현재 대표 object 삭제는 DB trigger가42501로 차단하고 clear_my_profile_avatar는 사용자 실행권한이 없다. 마지막 대표 사진 삭제 UI/API는 추가하지 않는다.
6. old DELETE 실패는 새 pointer 교체 성공과 구분한다. 새 대표를 되돌리거나 전체 저장 실패라고 오판하지 않고 오래된 object 정리 상태로 기록·재시도한다. 회원/사진 원문·JWT·Storage 응답을 로그에 넣지 않는다.

upload 실패는 이전 pointer/사진 유지, swap 실패는 이전사진·선택입력 유지 및 미연결 새object만 안전 정리다. timeout/응답 유실 때는 swap 여부를 모른다. 즉시 새 object DELETE하지 말고 authenticated /me 재조회로 현재 pointer를 확인한 뒤 자신이 만든 미연결 object만 정리한다. 이때 /me 자체 DTO는 실제 source 계약대로 별도 decode한다. 연속 저장/두 기기/중복 탭에서는 마지막 서버 pointer를 재조회하고 현재 object를 stale oldpath로 지우지 않는다. object cleanup 거절을 성공으로 바꾸지 않는다. 세션 교체/로그아웃 중 늦은 응답이 새 사용자 상태를 바꾸지 않도록 기존 session epoch/취소 흐름을 사용한다.

## 성향 편집 완료 기준

화면 진입 시 GET /me/traits의 실제 본인값을 가져오고 loading/error를 빈 성향 성공으로 대체하지 않는다. 편집중 늦은 GET이 입력을 덮지 않도록 세션·요청 시점을 확인한다. 저장은 입력 snapshot을 POST하고 성공 DTO를 검사한 뒤 반영한다. 실패·401·취소·네트워크 장애 때 입력을 보존하고 성공 toast/back을 실행하지 않는다. 빈배열/null 저장 후 재조회·재실행에도 삭제 상태가 유지되어야 한다. optional traits는 가입/동행 필수 단계로 바꾸지 않는다.

현재 소개 입력까지 같은 버튼에 묶여 있으므로 성향3필드만 성공해도 소개가 저장됐다는 안내를 하면 안 된다. 지원 계약이 확정되기 전의 처리 방식은 담당 협의가 필요하며 이 요청이 소개 API나 저장 정책을 임의 확정하지 않는다.

## 종현 인수·검증 범위

J 소유 기존 CommunityScreens.tsx/서비스 연결·상태/원격 세션 흐름에 반영한다. image 재인코딩 라이브러리 의존 추가와 공통 환경 변경은 파일 ownership를 각각 확인하고 필요하면 M에게 요청한다. 새로운 중복 모바일 백엔드·사진 저장 제품 경로는 만들지 않는다.

완료 증거는 실제 Auth 세션을 사용하는 모바일 선택→재인코딩→Storage upload→service-api swap→old DELETE·재조회까지다. 정상 JPEG/PNG, 원본10MiB 경계·초과, 출력2MiB 경계·초과, 잘못된형식, 다른owner, upsert 거절, 현재사진삭제거절, upload/swap/oldDELETE 각각의 실패와 응답유실, 연속교체, 로그아웃 늦은응답을 검사한다. DB metadata 합성이나 예제 URI local state만으로 실제 JPEG blob·모바일 서버연결 완료를 표시하지 않는다. 실제 기능검증과 운영 배포·Naver Provider 검증은 서로 구분한다.

이 문서의 구현 및 모바일 실제 서버 검증은 NOT_RUN이다. 현재 API와 기존 DB 보호를 읽기 확인한 연결 요청을 작성했다.

## 후속 민규 원자 저장 소스 구현

앞의 소개 endpoint 미구현 문구는 최초 읽기 시점이다. 이후 민규가 기존 모듈에 POST `/me/preferences`와 `set_my_profile_preferences`를 구현했다. 본문·응답은 정확히 `{interests,conversationStyles,mbti,bio}`이며 소개글은 nullable/300자 기존 DB 기준을 따른다. 기존 `/me/traits`에 소개 키를 추가한 방식이 아니며 이전 세 필드 API는 유지한다. 새 DB migration40500을 실제 연결 환경에 적용하기 전 모바일 성공 경로로 사용하지 않는다.

PreferencesScreen의 단일 저장은 이 새 원자 API 한 번으로 성향과 소개를 함께 반영하도록 연결한다. 실패 때 입력을 유지하고 늦은 응답·세션 교체는 기존 완료 기준을 따른다. 소스 구현·mock HTTP·단일 owner SQL rollback 검증과 실제 REST/모바일·운영 완료는 구분한다. [민규 구현 및 검증](2026-10-05-profile-preferences-atomic-save.md)을 연결한다. 종현 화면·서비스 코드는 민규가 직접 수정하지 않았다.

후속 격리 로컬 DRIFT 환경에는40500을 실제 적용했고 최신 handler→실제 Auth/REST/Storage11그룹이 PASS했다. 성향/소개 네 필드 저장·기존 조회 API 재조회·오류 후 DB 값 보존·직접 bio 수정 차단을 확인했다. 이 증거는 프로세스 내부 handler와 합성 네이버 응답을 사용하며 모바일·hosted Edge·운영 환경에는 확대하지 않는다. 실제 화면의 입력 보존·늦은 응답·세션 교체와 JPEG 재인코딩은 여전히 담당 모바일 연결 과제다.
