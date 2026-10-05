import assert from "node:assert/strict";
import test from "node:test";
import { internalPath, sessionResult, signupState, retirementResult } from "../../../apps/mobile/src/member-session.ts";
const user = "11111111-1111-4111-8111-111111111111";
test("목적 화면은 내부 경로만 허용", () => {
  assert.equal(internalPath("/post?id=123"), "/post?id=123");
  for (const value of ["//other.example", "/%2fother.example", "/../secret", "/%5cother", "https://other.example"]) assert.throws(() => internalPath(value));
});
test("공식 가입 상태만 설치할 수 있고 테스트 주장/민감 추가필드 거절", () => {
  const value = { userId: user, accessToken: "token", status: "ready", returnTo: "/" };
  assert.equal(sessionResult(value).status, "ready");
  assert.throws(() => sessionResult({ ...value, status: "verified" }));
  assert.throws(() => sessionResult({ ...value, realName: "이름" }));
  assert.throws(() => sessionResult({ ...value, accessToken: "x\r\ny" }));
});
test("가입 미완료 상태와 선택 성향 null 보존", () => {
  assert.equal(signupState({ status: "completion_required", avatarPath: `${user}/${user}.jpg`, interests: [], conversationStyles: [], mbti: null }).status, "completion_required");
  assert.throws(() => signupState({ status: "ready", avatarPath: null, interests: [], conversationStyles: [], mbti: "invalid" }));
});
test("탈퇴 요청접수와 실제 외부삭제 완료는 서로 다른 상태", () => {
  assert.equal(retirementResult({ withdrawalId: user, status: "processing", memberAccessRevoked: true }, user).status, "processing");
  assert.throws(() => retirementResult({ withdrawalId: user, status: "completed", memberAccessRevoked: false }, user));
});
