import assert from "node:assert/strict";
import test from "node:test";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { ServiceApiClient } from "../../../apps/mobile/src/api.ts";
import { MemberService } from "../../../apps/mobile/src/member-service.ts";
import { YumidangService } from "../../../apps/mobile/src/service.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const resource = "11111111-1111-4111-8111-111111111111";
const deliveryId = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-07T00:00:00Z";
const notice = { noticeId: resource, appointmentId: null, appointmentOutcome: null, violationOutcome: "confirmed", reasonCode: "spam", violationClass: "minor", violationType: "spam", availableAt: at, firstReadAt: null };
const cancelled = { noticeId: resource, appointmentId: resource, appealState: null, planState: "policy_pending", eligibleCount: null, provisionalCount: null, hasCancellationWarning: false, restrictedUntil: null, availableAt: at, firstReadAt: null };
/** In-process real HTTP handler + synthetic RPC responses; no real Auth/DB/provider. */
function setup(respond: (name: string, args: Record<string, JsonValue>) => JsonValue, token: string | null = "synthetic-member") {
  const calls: { name: string; args: Record<string, JsonValue> }[] = [];
  const db = { rpc: async (name: string, args: Record<string, JsonValue>) => { calls.push({ name, args }); return respond(name, args); } };
  const handler = createServiceApi({ allowedOrigins: [], maxBodyBytes: 65536, authenticateUser: async request => {
    assert.equal(request.headers.get("authorization"), "Bearer synthetic-member"); return db;
  }, authenticateInternal: async () => { throw new Error("unexpected internal call"); } });
  const fetcher: typeof fetch = async (url, init) => handler(new Request(String(url), init));
  const options = { serviceApiUrl: "https://synthetic.invalid/service-api", accessToken: async () => token, fetcher };
  return { calls, member: new MemberService(new ServiceApiClient(options.serviceApiUrl, options.accessToken, fetcher)), public: new YumidangService(options) };
}
test("latest review-summary route uses exact server DTO and preserves null without invented reason", async () => {
  for (const summary of [null, { summaryId: resource, text: "공개 원문에 근거한 요약", sourceCount: 3, updatedAt: at }]) {
    const ports = setup(() => ({ summary }));
    assert.deepEqual(await ports.public.profileSummary(resource), { summary });
    assert.deepEqual(ports.calls, [{ name: "get_visible_review_summary", args: { p_profile_id: resource } }]);
  }
});
test("hidden listing and explicit unhide preserve type/id without cancelling report or unblock", async () => {
  const target = { targetType: "event" as const, targetId: resource };
  const ports = setup(name => name === "list_my_hidden_targets" ? { items: [target], nextCursor: null } : { ...target, hidden: false });
  assert.deepEqual(await ports.member.hiddenTargets(), { items: [target], nextCursor: null });
  await ports.member.unhide(target);
  assert.deepEqual(ports.calls.map(c => c.name), ["list_my_hidden_targets", "unhide_my_report_target"]);
  assert.deepEqual(ports.calls[1].args, { p_target_type: "event", p_target_id: resource });
});
test("hidden response with extra identity or mismatched target is rejected", async () => {
  await assert.rejects(setup(() => ({ items: [{ targetType: "member", targetId: resource, realName: "private" }], nextCursor: null })).member.hiddenTargets());
  await assert.rejects(setup(() => ({ targetType: "event", targetId: deliveryId, hidden: false })).member.unhide({ targetType: "event", targetId: resource }));
});
test("notice list/read are distinct from successful-delivery ACK and use server deadline", async () => {
  const ports = setup(name => {
    if (name === "list_my_decision_notices") return { items: [notice], nextCursor: null };
    if (name === "read_my_decision_notice") return { ...notice, firstReadAt: at };
    return { deliveryId, notice: { ...notice, firstReadAt: at }, appealPolicy: "general_7d", providedAt: name.startsWith("prepare_") ? null : at, deadlineAt: name.startsWith("prepare_") ? null : "2026-10-14T00:00:00Z" };
  });
  await ports.member.notices("decision"); await ports.member.readNotice("decision", resource);
  assert.equal(ports.calls.length, 2);
  const prepared = await ports.member.prepareNotice(resource);
  assert.equal(prepared.deadlineAt, null);
  assert.equal(ports.calls.length, 3);
  const ack = await ports.member.acknowledgeNotice(resource, prepared.deliveryId);
  assert.equal(ack.deadlineAt, "2026-10-14T00:00:00Z");
  assert.deepEqual(ports.calls[3], { name: "acknowledge_my_general_notice_provided", args: { p_notice_id: resource, p_delivery_id: deliveryId } });
});
test("pending cancellation counts remain unknown and read must bind the notice", async () => {
  const ports = setup(name => name === "list_my_cancellation_notices" ? { items: [cancelled], nextCursor: null } : { ...cancelled, firstReadAt: at });
  assert.equal((await ports.member.notices("cancellation")).items[0].noticeId, resource);
  assert.equal((await ports.member.readNotice("cancellation", resource)).firstReadAt, at);
  await assert.rejects(setup(() => ({ ...cancelled, firstReadAt: at, noticeId: deliveryId })).member.readNotice("cancellation", resource));
});
test("unexpected delivery/deadline and unacknowledged result cannot become success", async () => {
  for (const fields of [{ deliveryId: resource, providedAt: at, deadlineAt: "2026-10-14T00:00:00Z" }, { deliveryId, providedAt: null, deadlineAt: null }, { deliveryId, providedAt: at, deadlineAt: "2026-10-15T00:00:00Z" }]) {
    const ports = setup(() => ({ notice, appealPolicy: "general_7d", ...fields }));
    await assert.rejects(ports.member.acknowledgeNotice(resource, deliveryId));
  }
});
test("anonymous management is rejected before HTTP and no fallback account is used", async () => {
  const ports = setup(() => null, null);
  await assert.rejects(ports.member.hiddenTargets(), { code: "AUTH_REQUIRED" });
  await assert.rejects(ports.member.notices("decision"), { code: "AUTH_REQUIRED" });
  assert.equal(ports.calls.length, 0);
});
test("lost unhide/delivery response sends once and never auto retries", async () => {
  let sent = 0;
  const client = new MemberService(new ServiceApiClient("https://synthetic.invalid/service-api", async () => "synthetic", async () => { sent++; throw new TypeError("synthetic lost response"); }));
  await assert.rejects(client.unhide({ targetType: "post", targetId: resource }));
  assert.equal(sent, 1);
  await assert.rejects(client.acknowledgeNotice(resource, deliveryId));
  assert.equal(sent, 2);
});
const generalReceipt = { appealId: deliveryId, noticeId: resource, state: "reviewing", receivedAt: at, deadlineAt: "2026-10-14T00:00:00Z", alreadyApplied: false };
const cancellationReceipt = { appealId: null, appointmentId: resource, resultRevision: 1, state: null, cancelledAt: at, deadlineAt: "2026-10-08T00:00:00Z", receivedAt: null, resolvedAt: null };
test("general appeal sends exact notice/id/reason and reads receipt without local deadline inference", async () => {
  const ports = setup(() => generalReceipt);
  assert.deepEqual(await ports.member.submitGeneralAppeal(resource, deliveryId, "판정 근거를 재확인해 주세요"), generalReceipt);
  assert.deepEqual(ports.calls[0], { name: "submit_my_general_sanction_appeal", args: { p_notice_id: resource, p_client_request_id: deliveryId, p_reason: "판정 근거를 재확인해 주세요" } });
  await ports.member.generalAppeal(deliveryId);
  assert.deepEqual(ports.calls[1], { name: "get_my_general_sanction_appeal", args: { p_appeal_id: deliveryId } });
});
test("general appeal response is notice/receipt bound, and invalid reason sends nothing", async () => {
  await assert.rejects(setup(() => ({ ...generalReceipt, noticeId: deliveryId })).member.submitGeneralAppeal(resource, deliveryId, "설명"));
  await assert.rejects(setup(() => ({ ...generalReceipt, appealId: resource })).member.generalAppeal(deliveryId));
  const ports = setup(() => generalReceipt);
  for (const reason of ["", "  이유", "이유\n추가", "가".repeat(4001)]) await assert.rejects(ports.member.submitGeneralAppeal(resource, deliveryId, reason), { code: "INVALID_REQUEST" });
  assert.equal(ports.calls.length, 0);
});
test("cancellation appeal reads authoritative revision/deadline and submits one atomic report", async () => {
  const submitted = { ...cancellationReceipt, appealId: deliveryId, state: "reviewing", resultRevision: 2, receivedAt: at, alreadyApplied: false, reportId: resource };
  const ports = setup(name => name === "get_my_appointment_cancel_appeal" ? cancellationReceipt : submitted);
  const current = await ports.member.cancellationAppeal(resource);
  assert.equal(current.deadlineAt, cancellationReceipt.deadlineAt);
  const input = { clientRequestId: deliveryId, expectedResultRevision: current.resultRevision, reasonCodes: ["other"], description: "취소 사유를 다시 검토해 주세요", assetIds: [], hideTarget: false };
  assert.deepEqual(await ports.member.submitCancellationAppeal(resource, input), submitted);
  assert.deepEqual(ports.calls[1], { name: "submit_appointment_cancel_appeal_with_report", args: { p_appointment_id: resource, p_client_request_id: deliveryId, p_expected_result_revision: 1, p_reason_codes: ["other"], p_description: input.description, p_asset_ids: [], p_hide_target: false } });
});
test("cancellation appeal accepts exact microsecond deadline boundary and rejects stale revision", async () => {
  const submitted = { ...cancellationReceipt, appealId: deliveryId, state: "reviewing", resultRevision: 2, receivedAt: "2026-10-07T23:59:59.999999Z", alreadyApplied: false, reportId: resource };
  const input = { clientRequestId: deliveryId, expectedResultRevision: 1, reasonCodes: ["other"], description: "설명", assetIds: [], hideTarget: false };
  assert.equal((await setup(() => submitted).member.submitCancellationAppeal(resource, input)).receivedAt, submitted.receivedAt);
  for (const fields of [{ resultRevision: 1 }, { receivedAt: cancellationReceipt.deadlineAt }, { appointmentId: deliveryId }]) await assert.rejects(setup(() => ({ ...submitted, ...fields })).member.submitCancellationAppeal(resource, input));
});
test("appeal lost response preserves explicit request ID and does not retry automatically", async () => {
  const bodies: unknown[] = [];
  const service = new MemberService(new ServiceApiClient("https://synthetic.invalid/service-api", async () => "synthetic", async (_url, options) => { bodies.push(JSON.parse(String(options?.body))); throw new TypeError("lost"); }));
  await assert.rejects(service.submitGeneralAppeal(resource, deliveryId, "설명"));
  assert.equal(bodies.length, 1);
  await assert.rejects(service.submitGeneralAppeal(resource, deliveryId, "설명"));
  assert.deepEqual(bodies[0], bodies[1]);
});
test("unsupported public event detail/ranking stop before HTTP rather than call internal or invented routes", async () => {
  const ports = setup(() => { throw new Error("no unsupported RPC should be called"); });
  await assert.rejects(ports.public.getEvent(resource), { code: "EVENT_DETAIL_NOT_CONNECTED" });
  await assert.rejects(ports.public.performanceRankings("musical"), { code: "EVENT_RANKINGS_NOT_CONNECTED" });
  assert.equal(ports.calls.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(ports.public.getEvent(resource, controller.signal), { name: "AbortError" });
  assert.equal(ports.calls.length, 0);
});
