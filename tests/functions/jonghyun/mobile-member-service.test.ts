import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, ServiceApiClient } from "../../../apps/mobile/src/api.ts";
import { MemberService, timestamp } from "../../../apps/mobile/src/member-service.ts";
const user = "11111111-1111-4111-8111-111111111111", resource = "22222222-2222-4222-8222-222222222222";
const instant = "2026-10-05T03:00:00.123456Z";
function setup(result: unknown, token: string | null = "member") {
  const calls: { path: string; body: unknown; authorization: string | undefined }[] = [];
  const service = new MemberService(new ServiceApiClient("https://project.example/functions/v1/service-api", async () => token, async (url, init) => {
    calls.push({ path: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, authorization: (init?.headers as Record<string, string>).Authorization });
    return Response.json({ data: result, requestId: resource });
  }));
  return { service, calls };
}
test("본인 조회에는 실제 회원 JWT를 전달하고 익명 호출은 전송 전 중단", async () => {
  const { service, calls } = setup({ userId: user, realName: "김민규", avatarUrl: null, bio: null, sweetness: 15 });
  assert.equal((await service.profile()).userId, user); assert.equal(calls[0].authorization, "Bearer member");
  const anonymous = setup(null, null); await assert.rejects(anonymous.service.profile(), { code: "AUTH_REQUIRED" }); assert.equal(anonymous.calls.length, 0);
});
test("성향과 소개는 정확 네필드 한 POST이며 빈 값도 보존", async () => {
  const input = { interests: [], conversationStyles: [], mbti: null, bio: "  소개\n" };
  const { service, calls } = setup(input);
  assert.deepEqual(await service.preferences(input), input); assert.deepEqual(calls[0].body, input); assert.match(calls[0].path, /\/me\/preferences$/);
});
test("대표사진은 snake_case 한행 배열만 수용하고 다른 새경로는 거절", async () => {
  const path = `${user}/${resource}.jpg`;
  assert.equal((await setup([{ avatar_url: path, previous_avatar_path: null }]).service.avatar(path)).avatarPath, path);
  for (const value of [{ avatar_url: path, previous_avatar_path: null }, [], [{ avatar_url: "other", previous_avatar_path: null }]]) await assert.rejects(setup(value).service.avatar(path), { code: "INVALID_SERVICE_RESPONSE" });
});
test("첫 메시지 신청은 재전송 ID와 본문을 유지하고 다른 요청 ID 응답 거절", async () => {
  const result = { id: resource, post_id: user, status: "pending", created_at: instant, already_existed: false, messageId: resource, messageCreatedAt: instant, alreadySent: false };
  const { service, calls } = setup(result);
  await service.firstMessage(user, resource, "안녕하세요"); await service.firstMessage(user, resource, "안녕하세요");
  assert.deepEqual(calls[0].body, calls[1].body); assert.equal(calls.length, 2);
  await assert.rejects(setup({ ...result, post_id: resource }).service.firstMessage(user, resource, "안녕하세요"), { code: "INVALID_SERVICE_RESPONSE" });
});
test("신청 철회 table DTO와 확정 버전 본문을 구분", async () => {
  assert.equal((await setup([{ id: user, status: "withdrawn", updated_at: instant }]).service.requestAction(user, "withdraw")).status, "withdrawn");
  const { service, calls } = setup({ requestId: user, status: "confirmed", appointmentId: resource });
  await service.requestAction(user, "accept", "opaque-version"); assert.deepEqual(calls[0].body, { conditionVersion: "opaque-version" });
  await assert.rejects(service.requestAction(user, "accept"), { code: "INVALID_REQUEST" });
});
test("알림 read 실제 void/null 응답 수용 및 잘못된 객체는 거절", async () => {
  assert.equal(await setup(null).service.readNotification(user), undefined);
  await assert.rejects(setup({ ok: true }).service.readNotification(user), { code: "INVALID_SERVICE_RESPONSE" });
});
test("마감 timestamp는 6자리 유지하고 존재하지 않는 달력 날짜 거절", () => {
  assert.equal(timestamp(instant), instant);
  assert.throws(() => timestamp("2026-02-30T03:00:00Z"), ApiError);
});
test("취소 이력 unknown과 위치권한회수 null 보존", async () => {
  const value = { appointmentId: user, status: "cancelled", startsAt: null, endsAt: null, updatedAt: null, change: null, cancellation: null, scheduleProvenance: "unknown" };
  assert.deepEqual(await setup(value).service.changeState(user), value);
});
test("후기 공개 전 상대 원문 포함 응답은 전부 거절", async () => {
  const row = { appointment_id: user, appointment_completed: false, disputed: false, can_write: true, peer_submitted: true, released: false, deadline_at: null, peer_review: { comment: "비공개" } };
  await assert.rejects(setup([row]).service.reviewState(user), { code: "INVALID_SERVICE_RESPONSE" });
});
test("신고 캡처 예약 bucket/asset 바인딩과 confirmation 검증", async () => {
  const row = { assetId: user, bucket: "report-evidence", path: `${user}/${resource}.png`, state: "reserved" };
  assert.equal((await setup(row).service.reserveReportCapture(user, "png")).state, "reserved");
  await assert.rejects(setup({ ...row, bucket: "profile-images" }).service.reserveReportCapture(user, "png"), { code: "INVALID_SERVICE_RESPONSE" });
});
