/** 민규: 실제 삭제가 아닌 탈퇴 요청/응답 어댑터 경계 검증. HTTP 공개 연결은 실제 cleanup 검증 뒤다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRetirementRequest, retireMyAccount } from "../../../backend/supabase/functions/_shared/services/member-lifecycle-service.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
import { HttpError, toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
const id = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
const normalized = id.toLowerCase();
const valid = { withdrawalId: normalized, status: "processing", memberAccessRevoked: true };

test("탈퇴 입력에는 요청 ID만 허용하고 타인·외부 삭제 정보를 받지 않는다", () => {
  assert.equal(parseRetirementRequest({ withdrawalId: id }), normalized);
  for (const body of [null, [], {}, { withdrawalId: 1 }, { withdrawalId: "invalid" },
    { withdrawalId: id, userId: normalized }, { withdrawalId: id, storagePath: "other/file.jpg" },
    { withdrawalId: id, completed: true }, { withdrawalId: id, serviceRoleKey: "untrusted" }]) {
    assert.throws(() => parseRetirementRequest(body as JsonValue), (error: unknown) => error instanceof HttpError && toPublicError(error).error.code === "INVALID_REQUEST");
  }
});
test("탈퇴는 원래 회원 RPC와 정규화한 ID만 사용하며 processing을 completed로 바꾸지 않는다", async () => {
  const calls: unknown[] = [];
  const result = await retireMyAccount({ rpc: async (name, args) => { calls.push({ name, args });return valid; } }, id);
  assert.deepEqual(calls, [{ name: "retire_my_account", args: { p_withdrawal_id: normalized } }]);
  assert.deepEqual(result, valid);
});
test("동일 요청의 실제 완료 응답만 completed로 반환한다", async () => {
  assert.deepEqual(await retireMyAccount({ rpc: async () => ({ ...valid, status: "completed" }) }, id), { ...valid, status: "completed" });
});
test("변형·다른 요청·접근 미회수 응답은 성공으로 표시하지 않는다", async () => {
  for (const value of [null, [], {}, { ...valid, status: ["completed"] }, { ...valid, status: "pending" },
    { ...valid, memberAccessRevoked: false }, { ...valid, memberAccessRevoked: "true" },
    { ...valid, withdrawalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { ...valid, filesDeleted: true }]) {
    await assert.rejects(() => retireMyAccount({ rpc: async () => value as JsonValue }, id),
      (error: unknown) => error instanceof HttpError && toPublicError(error).error.code === "EXTERNAL_UNAVAILABLE");
  }
});
test("진행 중 약속의 충돌은 탈퇴 성공으로 대체하지 않는다", async () => {
  const conflict = new HttpError("STATE_CONFLICT");
  await assert.rejects(() => retireMyAccount({ rpc: async () => { throw conflict; } }, id), (error: unknown) => error === conflict);
});
test("잘못된 ID는 DB 호출 전에 거절한다", async () => {
  let called = false;
  await assert.rejects(() => retireMyAccount({ rpc: async () => { called = true;return valid; } }, "invalid"), HttpError);
  assert.equal(called, false);
});
