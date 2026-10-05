/** 민규: HTTP 입력/인증/고정 RPC 연결 검증. Storage 실제 파일 및 운영 권한 검증과 구분한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { JsonValue } from "../../../backend/supabase/functions/_shared/contracts/common.ts";
const id = "11111111-1111-4111-8111-111111111111";
const target = "22222222-2222-4222-8222-222222222222";
const asset = "33333333-3333-4333-8333-333333333333";
const report = "44444444-4444-4444-8444-444444444444";
const input = { clientRequestId: id, targetType: "post", targetId: target, context: "online", reasonCodes: ["spam", "other"], description: "본인이 제출한 설명", assetIds: [asset], hideTarget: true };
function setup() {
  const calls: Array<{ name: string; args: Record<string, JsonValue> }> = [];
  let malformed = false;
  const handler = createServiceApi({ allowedOrigins: [], maxBodyBytes: 20000,
    authenticateUser: async (request) => {
      if (request.headers.get("authorization") !== "Bearer synthetic-member") throw new HttpError("AUTH_REQUIRED");
      return { rpc: async (name, args): Promise<JsonValue> => {
        calls.push({ name, args });
        if (malformed) return { status: "pretend_success", hideTarget: true };
        if (name === "submit_member_report") return { reportId: report, status: "received", alreadySubmitted: false, hideTarget: args.p_hide_target };
        if (name === "reserve_report_capture") return { assetId: args.p_asset_id, bucket: "report-evidence", path: `${id}/${args.p_asset_id}.${args.p_extension}`, state: "reserved" };
        if (name === "confirm_report_capture") return { assetId: args.p_asset_id, state: "uploaded" };
        if (name === "cancel_report_capture") return { assetId: args.p_asset_id, state: "cancelled", storageDeletionRequired: true };
        return { items: [], nextCursor: null };
      } };
    }, authenticateInternal: async () => { throw new Error("일반 신고에서 내부 권한을 사용하면 안 된다"); } });
  return { calls, malformed: () => { malformed = true; }, send: (path: string, body: unknown = input, method = "POST", member = true) => handler(new Request(`https://example.invalid/functions/v1/service-api${path}`, {
    method, headers: { authorization: member ? "Bearer synthetic-member" : "Bearer invalid", "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  })) };
}
test("신고는 본인이 고른 대상·사유·설명·첨부만 회원 RPC에 전달한다", async () => {
  const { calls, send } = setup(); const response = await send("/reports"); assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ name: "submit_member_report", args: { p_client_request_id: id, p_target_type: "post", p_target_id: target, p_context: "online", p_reason_codes: ["spam", "other"], p_description: input.description, p_asset_ids: [asset], p_hide_target: true } }]);
  assert.deepEqual((await response.json()).data, { reportId: report, status: "received", alreadySubmitted: false, hideTarget: true });
});
test("온라인 공고·채팅·행사는 설명과 캡처가 필요하며 offline 우회를 거절한다", async () => {
  const { send, calls } = setup();
  for (const type of ["post", "chat", "event"]) for (const patch of [{ assetIds: [] }, { description: "" }, { context: "offline", assetIds: [] }]) assert.equal((await send("/reports", { ...input, targetType: type, ...patch })).status, 400);
  assert.equal(calls.length, 0);
});
test("대면·노쇼와 연결한 일반 대상은 설명만으로 접수할 수 있다", async () => {
  const { send, calls } = setup();
  for (const type of ["appointment", "member"]) assert.equal((await send("/reports", { ...input, targetType: type, context: "offline", reasonCodes: ["no_show", "other"], assetIds: [], hideTarget: false })).status, 200);
  assert.equal(calls.length, 2);assert.equal(calls[0].args.p_asset_ids?.toString(), "");
});
test("타인actor·raw chat·외부 URL·운영 상태·AI 결과를 일반 신고에 추가하지 않는다", async () => {
  const { send, calls } = setup();
  for (const patch of [{ userId: target }, { reporterId: target }, { chatHistory: "자동 복제 원문" }, { evidenceUrl: "https://example.invalid/private" }, { status: "resolved" }, { targetType: "ai_result" }]) assert.equal((await send("/reports", { ...input, ...patch })).status, 400);
  assert.equal(calls.length, 0);
});
test("복수 사유와 첨부의 중복·범위·자료형·길이를 검증한다", async () => {
  const { send, calls } = setup();
  const patches = [{ reasonCodes: [] }, { reasonCodes: ["spam", "spam"] }, { reasonCodes: ["unknown"] }, { assetIds: [asset, asset] }, { assetIds: ["not-uuid"] }, { description: "a".repeat(4001) }, { description: " leading" }, { hideTarget: "true" }, { targetType: ["post"] }, { context: ["online"] }];
  for (const patch of patches) assert.equal((await send("/reports", { ...input, ...patch })).status, 400);
  assert.equal(calls.length, 0);
});
test("캡처는 예약→Storage업로드→확인과 취소를 별도 RPC로 연결한다", async () => {
  const { send, calls } = setup();
  assert.equal((await send("/report-captures", { assetId: asset, extension: "png" })).status, 200);
  assert.equal((await send(`/report-captures/${asset}/confirm`, {})).status, 200);
  assert.equal((await send(`/report-captures/${asset}/cancel`, {})).status, 200);
  assert.deepEqual(calls.map((c) => c.name), ["reserve_report_capture", "confirm_report_capture", "cancel_report_capture"]);
  assert.equal(calls[0].args.p_asset_id, asset);
});
test("캡처 예약에 타인 소유자·외부URL·unsupported MIME·배열 extension을 받지 않는다", async () => {
  const { send, calls } = setup();
  for (const body of [{ assetId: asset, extension: "svg" }, { assetId: asset, extension: ["png"] }, { assetId: asset, extension: "png", ownerId: target }, { assetId: asset, extension: "png", url: "https://example.invalid" }]) assert.equal((await send("/report-captures", body)).status, 400);
  assert.equal((await send(`/report-captures/${asset}/confirm`, { uploaded: true })).status, 400);
  assert.equal(calls.length, 0);
});
test("내 신고 목록·상세는 본인 RPC와 검증된 페이지 인수만 사용한다", async () => {
  const { send, calls } = setup();assert.equal((await send("/me/reports", undefined, "GET")).status, 200);
  assert.deepEqual(calls[0], { name: "list_my_reports", args: { p_limit: 20, p_before: null } });
  assert.equal((await send(`/me/reports/${report}`, undefined, "GET")).status, 200);
  assert.deepEqual(calls[1], { name: "get_my_report", args: { p_report_id: report } });
  for (const query of ["limit=101", "limit=01", "limit=1&limit=2", `reporterId=${id}`]) assert.equal((await send(`/me/reports?${query}`, undefined, "GET")).status, 400);
});
test("미인증·잘못된 method는 신고 저장·조회 RPC에 도달하지 않는다", async () => {
  const { send, calls } = setup();assert.equal((await send("/reports", input, "POST", false)).status, 401);
  assert.equal((await send("/me/reports", undefined, "GET", false)).status, 401);
  assert.equal((await send("/reports", undefined, "GET")).status, 405);
  assert.equal((await send("/me/reports", {}, "POST")).status, 405);assert.equal(calls.length, 0);
});
test("변형 접수·캡처 성공 응답은503이며 hideTarget 성공을 꾸미지 않는다", async () => {
  const { send, malformed } = setup();malformed();
  for (const [path, body] of [["/reports", input], ["/report-captures", { assetId: asset, extension: "png" }], [`/report-captures/${asset}/confirm`, {}], [`/report-captures/${asset}/cancel`, {}]] as const) {
    const response = await send(path, body);assert.equal(response.status, 503);assert.equal((await response.json()).data, undefined);
  }
});

// 배열이 문자열처럼 변환되어 변형 성공 응답을 통과하지 않도록 실제 저장소 검증한다.
test("RPC 상태 배열은 성공 문자열로 변환하지 않는다", async () => {
  const repo = await import("../../../backend/supabase/functions/_shared/db/repositories/reports.ts");
  const invalid = (value: JsonValue) => ({ rpc: async () => value });
  await assert.rejects(() => repo.reserveReportCapture(invalid({ assetId: asset, bucket: "report-evidence", path: `${id}/${asset}.png`, state: ["reserved"] }), asset, "png"), HttpError);
  await assert.rejects(() => repo.confirmReportCapture(invalid({ assetId: asset, state: ["uploaded"] }), asset), HttpError);
  await assert.rejects(() => repo.submitMemberReport(invalid({ reportId: report, status: ["received"], alreadySubmitted: false, hideTarget: true }), input as Parameters<typeof repo.submitMemberReport>[1]), HttpError);
});


const safety = { permanent: false, restrictedUntil: "2026-10-12T12:00:00+00:00", hasWarning: true, sanctions: [{ sanctionId: report, kind: "general_7d", appliedAt: "2026-10-05T12:00:00.123456+00:00", expiresAt: "2026-10-12T12:00:00+00:00", notifiedAt: null }] };
function safetySetup(value: JsonValue = safety) {
  const calls: Array<{ name: string; args: Record<string, JsonValue> }> = [];
  const handler = createServiceApi({ allowedOrigins: [], maxBodyBytes: 20000,
    authenticateUser: async (request) => {
      if (request.headers.get("authorization") !== "Bearer synthetic-member") throw new HttpError("AUTH_REQUIRED");
      return { rpc: async (name, args) => { calls.push({ name, args }); return value; } };
    }, authenticateInternal: async () => { throw new Error("본인 조회에 내부 권한을 사용하면 안 된다"); } });
  return { calls, send: (suffix = "", method = "GET", member = true) => handler(new Request(`https://example.invalid/functions/v1/service-api/me/safety${suffix}`, {
    method, headers: { authorization: member ? "Bearer synthetic-member" : "Bearer invalid" }, ...(method === "POST" ? { body: "{}" } : {}),
  })) };
}
test("본인 제재 조회는 회원 고정 RPC에 빈 인수만 전달하고 통지 없음은 null로 보존한다", async () => {
  const { calls, send } = safetySetup(); const response = await send();
  assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, safety);
  assert.deepEqual(calls, [{ name: "get_my_safety_state", args: {} }]);
});
test("본인 제재 조회의 타인 선택·마감 입력·변경 method·미인증은 RPC 전 차단한다", async () => {
  const { calls, send } = safetySetup();
  for (const suffix of [`?userId=${target}`, `?identityId=${target}`, "?deadline=2026-10-12", "?limit=20"]) assert.equal((await send(suffix)).status, 400);
  assert.equal((await send("", "POST")).status, 405); assert.equal((await send("", "GET", false)).status, 401);
  assert.equal(calls.length, 0);
});
test("제재 원문·신고자·타인 사건·임의 마감과 변형 DTO는 응답으로 노출하지 않는다", async () => {
  const invalid: JsonValue[] = [
    { ...safety, reporterId: target }, { ...safety, hasWarning: "true" },
    { permanent: false, restrictedUntil: null, sanctions: [] },
    { ...safety, sanctions: [{ ...safety.sanctions[0], sanctionId: "not-a-uuid" }] }, { ...safety, permanent: [true] }, { ...safety, restrictedUntil: "2026-02-30T12:00:00Z" },
    { ...safety, restrictedUntil: "2026-10-05T24:00:00Z" },
    { ...safety, sanctions: null }, { ...safety, sanctions: [{ ...safety.sanctions[0], reason: "비공개 원문" }] },
    { ...safety, sanctions: [{ ...safety.sanctions[0], appealDeadline: "2026-10-12T12:00:00Z" }] },
    { ...safety, sanctions: [{ ...safety.sanctions[0], kind: "unknown" }] },
    { ...safety, sanctions: [{ ...safety.sanctions[0], sanctionId: target.split("-") }] },
    { ...safety, sanctions: [{ ...safety.sanctions[0], notifiedAt: "not-a-timestamp" }] },
    { ...safety, sanctions: [{ ...safety.sanctions[0], appliedAt: null }] },
  ];
  for (const value of invalid) {
    const response = await safetySetup(value).send(); assert.equal(response.status, 503);
    const body = JSON.stringify(await response.json()); assert.equal(body.includes("비공개 원문"), false); assert.equal(body.includes("appealDeadline"), false);
  }
});
test("유효 제재가 없거나 여섯 확정 종류일 때만 읽기 DTO를 허용한다", async () => {
  assert.equal((await safetySetup({ permanent: false, restrictedUntil: null, hasWarning: false, sanctions: [] }).send()).status, 200);
  for (const kind of ["cancel_warning", "cancel_restriction", "general_warning", "general_7d", "general_30d", "permanent"]) {
    assert.equal((await safetySetup({ ...safety, sanctions: [{ ...safety.sanctions[0], kind }] }).send()).status, 200);
  }
});
