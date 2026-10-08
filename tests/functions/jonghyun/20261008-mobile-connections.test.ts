import assert from "node:assert/strict";
import test from "node:test";
import { appointmentCancellationGate, observedServerTime, MemberService } from "../../../apps/mobile/src/member-service.ts";
import { ServiceApiClient } from "../../../apps/mobile/src/api.ts";
import { bodyIntersectsViewport, dispatchVisibleMessages } from "../../../apps/mobile/src/chat-read-state.ts";
import { configureWebMemberConnection, webMemberConfiguration, subscribeWebMemberConfiguration } from "../../../apps/mobile/src/web-member-connection.ts";
const requestId = "11111111-1111-4111-8111-111111111111", messageId = "22222222-2222-4222-8222-222222222222";
const instant = "2026-10-08T01:00:00.123456Z";
function setup(result: unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const service = new MemberService(new ServiceApiClient("https://synthetic.invalid/service-api", async () => "synthetic", async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ data: result });
  }));
  return { service, calls };
}
test("own posts accepts verified owner and cursor without requiring conversation", async () => {
  const page = { items: [{ postId: requestId, title: "신청 없는 공고", createdAt: instant, isOwner: true }], nextCursor: null };
  const { service, calls } = setup(page);
  assert.deepEqual(await service.ownPosts(), page);
  assert.equal(await service.ownsPost(requestId), true);
  assert.ok(calls.every(call => call.url.endsWith("/me/posts?limit=20")));
  await assert.rejects(setup({ ...page, items: [{ ...page.items[0], isOwner: false }] }).service.ownPosts());
  assert.equal(await setup({ items: [], nextCursor: null }).service.ownsPost(requestId), false);
});
test("read submits message ID only and retains authoritative server watermark/count", async () => {
  const dto = { request_id: requestId, last_read_message_id: messageId, read_at: instant, unread_count: 3 };
  const { service, calls } = setup(dto);
  assert.deepEqual(await service.markRead(requestId, messageId), dto);
  assert.deepEqual(calls[0].body, { lastReadMessageId: messageId });
  assert.ok(calls[0].url.endsWith(`/conversations/${requestId}/read`));
  for (const invalid of [{ ...dto, request_id: messageId }, { ...dto, unread_count: -1 }, { ...dto, read_at: "bad" }]) await assert.rejects(setup(invalid).service.markRead(requestId, messageId));
});
test("partial long body intersection qualifies but offscreen body/padding-only do not", () => {
  const viewport = { x: 0, y: 100, width: 300, height: 300 };
  assert.equal(bodyIntersectsViewport({ x: 10, y: 399, width: 280, height: 2000 }, viewport), true);
  assert.equal(bodyIntersectsViewport({ x: 10, y: 400, width: 280, height: 20 }, viewport), false);
  assert.equal(bodyIntersectsViewport({ x: 10, y: 10, width: 280, height: 80 }, viewport), false);
});
test("optional per-message port dispatches explicit visible IDs only and never falls back", async () => {
  let calls = 0; const signal = new AbortController().signal;
  const port = { markVisible: async (id: string, ids: string[]) => { calls++; assert.equal(id, requestId); assert.deepEqual(ids, [messageId]); return { confirmedMessageIds: ids, unreadCount: 8 }; } };
  assert.equal(await dispatchVisibleMessages(null, requestId, [messageId], signal), null); assert.equal(calls, 0);
  assert.deepEqual(await dispatchVisibleMessages(port, requestId, [messageId, messageId], signal), { confirmedMessageIds: [messageId], unreadCount: 8 }); assert.equal(calls, 1);
  const aborted = new AbortController(); aborted.abort(); assert.equal(await dispatchVisibleMessages(port, requestId, [messageId], aborted.signal), null); assert.equal(calls, 1);
  await assert.rejects(dispatchVisibleMessages({ markVisible: async () => ({ confirmedMessageIds: [requestId], unreadCount: 0 }) }, requestId, [messageId], signal));
});
test("per-message late response cannot be accepted after session/focus abort", async () => {
  const controller = new AbortController();
  await assert.rejects(dispatchVisibleMessages({ markVisible: async (_id, ids) => { controller.abort(); return { confirmedMessageIds: ids, unreadCount: 0 }; } }, requestId, [messageId], controller.signal), /READ_CANCELLED/);
});
test("web configuration remains absent until explicit trusted host supplies values", () => {
  configureWebMemberConnection(null); assert.equal(webMemberConfiguration(), null);
  let changes = 0; const unsubscribe = subscribeWebMemberConfiguration(() => changes++);
  configureWebMemberConnection(null); assert.equal(changes, 1); unsubscribe();
  configureWebMemberConnection(null); assert.equal(changes, 1);
});

test("own post and read clients match actual member HTTP handler RPC contracts", async () => {
  const { createServiceApi } = await import("../../../backend/supabase/functions/service-api/handler.ts");
  const calls: { name: string; args: unknown }[] = [];
  const db = { rpc: async (name: string, args: Record<string, import("../../../backend/supabase/functions/_shared/contracts/common.ts").JsonValue>) => {
    calls.push({ name, args });
    if (name === "list_my_service_posts") return { items: [{ postId: requestId, title: "무신청 공고", createdAt: instant, isOwner: true }], nextCursor: null };
    if (name === "mark_conversation_read") return { request_id: requestId, last_read_message_id: messageId, read_at: instant, unread_count: 0 };
    throw new Error(`unexpected RPC ${name}`);
  } };
  const handler = createServiceApi({ allowedOrigins: [], maxBodyBytes: 65536, authenticateUser: async request => { assert.equal(request.headers.get("authorization"), "Bearer synthetic"); return db; }, authenticateInternal: async () => { throw new Error("unexpected internal"); } });
  const client = new MemberService(new ServiceApiClient("https://synthetic.invalid/service-api", async () => "synthetic", async (url, init) => handler(new Request(String(url), init))));
  assert.equal(await client.ownsPost(requestId), true); await client.markRead(requestId, messageId);
  assert.deepEqual(calls, [{ name: "list_my_service_posts", args: { p_limit: 20, p_before: null } }, { name: "mark_conversation_read", args: { p_request_id: requestId, p_last_read_message_id: messageId } }]);
});

test("cancellation uses authoritative server time, elapsed boundary and missing-time hold", () => {
  const row = { status: "confirmed", server_now: "2026-10-08T01:00:00Z", post_starts_at: "2026-10-08T01:00:01Z" };
  assert.equal(appointmentCancellationGate(row, 100, 1099), "before_start");
  assert.equal(appointmentCancellationGate(row, 100, 1100), "started");
  assert.equal(appointmentCancellationGate({ ...row, server_now: null }, 100, 200), "unavailable");
  assert.equal(appointmentCancellationGate({ ...row, status: "cancelled" }, 100, 200), "unavailable");
  assert.equal(observedServerTime(row, undefined, 200), null);
});
test("author rejection uses existing dedicated request action instead of withdrawing applicant", async () => {
  const { service, calls } = setup([{ id: requestId, status: "declined" }]);
  assert.equal((await service.requestAction(requestId, "decline")).status, "declined");
  assert.ok(calls[0].url.endsWith(`/requests/${requestId}/decline`));
});
