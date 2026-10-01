# 공통 연결 규칙

## 정책과 기술 계약의 경계

[정책.md](../../정책.md)의 현재 기준을 API 입력·권한·상태 전이에 적용한다. 네이버 전용 로그인, 무료 1:1, 개인 완료 후 후기 제출과 실제 완료/공개 시각의 구분이 대상이다. 기존 코드의 길이·배치·페이지 상한은 기술값이며 제품상 수량과 운영 로그 보관은 팀 검토다. 사용자 본문·인증 응답·비공개 위치·회원 간 채팅을 오류나 일반 로그에 넣지 않는다.

담당: 민규담당 · 상태: HTTP 형식 처리 구현, Node Web API 테스트 통과. API 진입점·인증·DB의 기존 연결은 [서비스 API](service-api.md), 현재 네이버 가입 전환은 [가입 계약](signup.md)에서 구분한다.

기준: [상세 설계](../../PLAN_상세설계.md) 3·11장, [작업 지침](../../AGENTS.md). 아래는 서비스 정책을 추가하지 않는 공통 기술 계약이다.

## 응답과 요청 ID

- 성공: `{ "data": ..., "requestId": "서버 UUID v4" }`.
- 실패: `{ "error": { "code": "...", "message": "고정 공개 메시지", "retryable": false }, "requestId": "서버 UUID v4" }`.
- 매 HTTP 요청 진입 시 `createRequestContext()`를 한 번 호출하고 같은 문맥을 모든 처리와 오류 응답에 전달한다. 클라이언트·프록시가 보낸 `X-Request-Id`를 반사하거나 내부 추적 ID로 사용하지 않는다. 신뢰 프록시 전달 기능은 아직 없다.
- JSON 응답은 `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Request-Id`를 갖는다. 본문·헤더의 ID는 같다. ID는 인증정보나 재시도 중복 방지 키가 아니다.
- `jsonSuccess(data, context, status?)`는 기본 200, 명시 201·202를 지원한다. `data`는 JSON 값이며 호출자가 기능별 공개 필드만 투영해야 한다. 이 함수는 권한 검사·민감 필드 제거를 대신하지 않는다. 순환 참조·JSON 불가 값 등 내부 직렬화 실패도 진입점의 catch에서 `jsonFailure`로 처리한다.
- `jsonFailure(error, context)`는 공개 오류 허용 목록만 사용한다. `Error.message`, `stack`, `cause`, SQL, 인증 응답, 토큰, 대화·후기 원문은 응답에 넣거나 로그로 기록하지 않는다.

## 공개 오류 계약

| 코드 | HTTP | 공개 메시지 | retryable |
|---|---:|---|---|
| AUTH_REQUIRED | 401 | 로그인이 필요합니다. | false |
| ACCESS_DENIED | 403 | 요청을 수행할 권한이 없습니다. | false |
| RESOURCE_NOT_FOUND | 404 | 대상을 찾을 수 없습니다. | false |
| INVALID_REQUEST | 400 | 요청 형식이 올바르지 않습니다. | false |
| STATE_CONFLICT | 409 | 현재 상태에서 요청을 처리할 수 없습니다. | false |
| EXTERNAL_UNAVAILABLE | 503 | 외부 서비스를 일시적으로 사용할 수 없습니다. | true |
| INTERNAL_ERROR | 500 | 요청 처리 중 오류가 발생했습니다. | false |
| PAYLOAD_TOO_LARGE | 413 | 요청 본문이 허용 크기를 초과했습니다. | false |
| UNSUPPORTED_MEDIA_TYPE | 415 | 지원하지 않는 요청 본문 형식입니다. | false |
| METHOD_NOT_ALLOWED | 405 | 지원하지 않는 요청 방식입니다. | false |

내부에서 확인한 실패만 `new HttpError(code)`로 생성한다. 외부 업체·DB 오류의 `code` 문자열 또는 객체를 그대로 신뢰하지 않는다. 실제 `HttpError`로 생성하지 않은 모든 값은 `INTERNAL_ERROR`로 변환한다. `HttpError.message`를 덮어써도 고정 공개 메시지가 유지된다.

`retryable=true`는 일시적 장애라는 표시다. 재제출 안전성·횟수·간격을 보장하거나 자동 재시도를 실행하지 않는다. 변경 요청의 중복 방지는 각 기능 계약에서 결정한다. 상태 충돌은 최신 상태 확인 뒤 명시적으로 재요청한다. 존재 여부를 숨겨야 하는 대상에는 핸들러/서비스가 동일한 `RESOURCE_NOT_FOUND`를 선택해야 한다. 공통 모듈은 대상 권한을 알지 못한다.

상세 설계에 예시로 있던 `PROFILE_INCOMPLETE`, `VERIFICATION_REQUIRED`, `CONDITION_CHANGED`, `RATE_LIMITED`는 이번 구현에서 의미·HTTP 상태를 추가 확정하지 않았다. 해당 기능 구현 시 공통 담당에게 추가 요청한다.

## JSON 입력

`readJson(request, { maxBytes })`는 `Promise<JsonValue>`를 반환한다.

- `maxBytes`는 엔드포인트 계약/설정에서 양의 안전 정수로 반드시 주입한다. 이번 작업에서는 운영 기본 수치를 정하지 않는다. 잘못된 서버 한도는 `INTERNAL_ERROR`다.
- 미디어 형식은 `application/json`, 선택 UTF-8 charset만 지원한다. UTF-8 외 인코딩·gzip 등 압축 입력은 지원하지 않는다.
- `Content-Length`가 있으면 형식·한도와 실제 수신 바이트 일치를 확인한다. 헤더가 없어도 스트림의 실제 누적 바이트에 한도를 적용한다. 초과 시 스트림을 취소하고 413을 반환한다.
- 빈 본문, 잘못된 JSON, 잘못된 UTF-8, 읽기 오류는 `INVALID_REQUEST`다. 형식 오류 메시지에 입력 원문을 넣지 않는다.
- 객체/배열/필수 필드/허용 필드/값 범위 등 업무 스키마 검증은 이 단계 뒤 각 기능 계약에서 한다. JSON `null`도 유효 JSON이다. 요청 시간 제한·동시성·사용량 제한은 이번 모듈의 범위가 아니다.

## CORS와 진입점 연결

`createCors({ allowedOrigins, allowedMethods, allowedHeaders, allowCredentials? })`에 환경별 설정을 명시적으로 주입한다. origin은 `https://app.example.test`처럼 scheme·host·선택 port까지만 지정한다. wildcard, `null`, path, suffix 일치는 허용하지 않는다. 메서드는 대문자로 지정하고 헤더는 대소문자 구분 없이 비교한다. credentials 기본값은 false다. 설정 배열은 생성 시 복사한다.

- `responseHeaders(request)`는 허용 origin을 확인한다. 목록 밖 origin은 `ACCESS_DENIED`다. Origin 없는 요청에는 CORS 허용 헤더를 부여하지 않으며 호출자 검증은 따로 수행한다.
- `preflight(request, context)`는 OPTIONS와 `Access-Control-Request-Method`가 있는 경우 origin·요청 메서드·헤더를 검증해 204 또는 공통 오류 응답을 반환한다. 일반 요청은 null이다. 성공 preflight만 본문 없는 응답이며 JSON envelope 예외다. 실패 preflight에는 CORS 허용 헤더가 없어 브라우저에서 본문을 읽지 못할 수 있다.
- `apply(response, request)`는 허용 origin의 실제 성공·실패 응답에 CORS 헤더와 `Vary: Origin`을 붙인다. 호출 전 부작용을 일으키지 않도록 진입점 처음에 `responseHeaders(request)`로 출처를 확인한다. 실제 메서드 라우팅은 진입점의 책임이다.
- CORS는 브라우저 접근 규칙이며 회원 인증·권한·내부 작업 인증을 대체하지 않는다. 허용 origin 요청도 별도 인증 실패 시 401이어야 한다.

연결 예시(실제 인증·서비스 구현 전 참고용, 아래 placeholder 함수는 구현된 API가 아님):

```ts
const context = createRequestContext();
try {
  cors.responseHeaders(request); // 업무 처리 전 출처 확인
  const preflight = cors.preflight(request, context);
  if (preflight) return preflight;
  // 실제 메서드 검사 → 인증/권한 검사 → readJson(maxBytes 명시)
  // → 업무 입력 검증 → 서비스 호출 → 공개 필드 투영
  return cors.apply(jsonSuccess(publicData, context), request);
} catch (error) {
  const response = jsonFailure(error, context);
  try { return cors.apply(response, request); }
  catch { return response; } // 허용하지 않은 origin에는 CORS 헤더 없음
}
```

## 아직 연결하지 않은 계약

현재 호출자 문맥·DB/RPC·기존 URL/입력 크기는 기능별 실행 계약을 따른다. 네이버 세션·가입 자격 연결, 숫자 나이 범위·개인 완료 후 후기 제출 등 새 정책의 반영은 별도 구현·검증 대상이다. 공통 HTTP 계약만으로 운영 한도나 개인정보 보관을 승인하지 않는다. 종현은 이 공통 envelope와 오류를 자신의 어댑터에 연결하되, 공통 파일이 바뀌어야 하면 자신의 변경 요청 폴더에 기록한다. 대화·후기 본문을 로그에 저장하지 않는 정책은 유지한다.

## 검증

저장소 루트에서 `node --test tests/functions/minkyu/http.test.ts`로 실행한다. Node v25.9.0에서 서버 ID·성공/실패 envelope·고정 오류·민감정보 제외·UTF-8 바이트 한도·스트림 취소·잘못된 본문·CORS 허용/거절·401 유지 11개 테스트를 통과했다. 외부 패키지는 필요하지 않다.

Deno 타입 검사·Edge Functions 실행, 인증/DB/외부 공급사 연결·배포 검증은 `NOT_RUN`이다. Node에서 Web API 동작을 확인한 결과를 Deno 배포 준비 완료로 해석하지 않는다.
