import assert from "node:assert/strict";
import test from "node:test";
import { createRpcPublicPostSearchRepository } from "../../../backend/supabase/functions/_shared/db/repositories/search.ts";
import { searchPublicPosts } from "../../../backend/supabase/functions/_shared/services/search-service.ts";
import { decodePublicPostCursor, encodePublicPostCursor } from "../../../backend/supabase/functions/_shared/contracts/search.ts";

// 주입한 합성 RpcClient만 사용한다. 실제 DB 권한·SQL·HTTP 연결 검사가 아니다.
const firstId = "00000000-0000-4000-8000-000000000002";
const secondId = "00000000-0000-4000-8000-000000000001";
const member = { caller: "member" };
const card = {
  id: firstId,
  title: "가상 전시 공고",
  authorDisplayName: "김*현",
  publicArea: "서울특별시 종로구",
  startsAt: "2026-10-03T12:00:00.000002+09:00",
  endsAt: "2026-10-03T14:00:00.000002+09:00",
  cost: { kind: "free" },
  state: "recruiting",
  canApply: true,
};
const position = {
  periodGroup: 0,
  recruitingGroup: 0,
  sortAt: "2026-10-03T12:00:00.000001+09:00",
  id: secondId,
};
function setup(result = { items: [card], nextCursor: null }) {
  const calls = [];
  const db = { async rpc(name, args) { calls.push({ name, args }); return structuredClone(result); } };
  return { calls, repository: createRpcPublicPostSearchRepository(db) };
}

test("회원 필터와 제한을 v2 RPC에 명시 전달하고 토큰·caller를 SQL 인자로 만들지 않는다", async () => {
  const input = {
    ...member, query: "전시", category: "전시", cost: "paid", availability: "recruiting",
    period: { startsAt: "2026-10-03T00:00:00+09:00", endsAt: "2026-10-05T00:00:00+09:00" },
    authorAge: "30s", limit: 7,
  };
  const { repository, calls } = setup({ items: [], nextCursor: null });
  assert.deepEqual(await repository.searchPage(input), { items: [], nextCursor: null });
  assert.deepEqual(calls, [{
    name: "search_public_posts_v2",
    args: {
      p_filters: { query: "전시", category: "전시", cost: "paid", availability: "recruiting", periodStart: input.period.startsAt, periodEnd: input.period.endsAt, authorAge: "30s" },
      p_cursor: null,
      p_limit: 7,
    },
  }]);
});

test("DB 페이지의 순서를 재정렬하지 않고 마이크로초 일정과 다음 커서를 보존한다", async () => {
  const second = { ...card, id: secondId, startsAt: "2026-10-03T12:00:00.000001+09:00" };
  const { repository } = setup({ items: [card, second], nextCursor: position });
  const result = await searchPublicPosts(repository, member);
  assert.equal(result.status, "results");
  assert.deepEqual(result.posts.map((value) => value.id), [firstId, secondId]);
  assert.equal(result.posts[0].startsAt, card.startsAt);
  assert.equal(result.posts[1].startsAt, second.startsAt);
  assert.equal(typeof result.nextCursor, "string");
  assert.deepEqual(decodePublicPostCursor(result.nextCursor, member), position);
  const next = setup({ items: [], nextCursor: null });
  await next.repository.searchPage({ ...member, cursor: result.nextCursor });
  assert.deepEqual(next.calls[0].args.p_cursor, position);
  assert.equal(next.calls[0].args.p_cursor.sortAt, "2026-10-03T12:00:00.000001+09:00");
});

test("확인된 NULL 비용만 unknown으로 공개하며 신청 가능성을 만들지 않는다", async () => {
  const { repository } = setup({ items: [{ ...card, cost: null, canApply: true }], nextCursor: null });
  const result = await repository.searchPage(member);
  assert.deepEqual(result.items[0].cost, { kind: "unknown" });
  assert.equal(result.items[0].canApply, false);
  assert.equal("amount" in result.items[0].cost, false);
  assert.equal("direction" in result.items[0].cost, false);
  const missing = { ...card }; delete missing.cost;
  for (const row of [missing, { ...card, cost: { kind: "unknown" } }]) {
    const { repository: malformed } = setup({ items: [row], nextCursor: null });
    await assert.rejects(malformed.searchPage(member), /INVALID_/);
  }
});

test("공개 카드 외 주소·실명·계좌·추가 metadata를 받은 경우 반환을 거절한다", async () => {
  const pages = [
    { items: [card], nextCursor: null, metadata: { raw: "PRIVATE_BODY" } },
    { items: [{ ...card, registeredAddress: "PRIVATE_ADDRESS" }], nextCursor: null },
    { items: [{ ...card, realName: "PRIVATE_NAME" }], nextCursor: null },
    { items: [{ ...card, cost: { kind: "free", accountNumber: "PRIVATE_ACCOUNT" } }], nextCursor: null },
  ];
  for (const page of pages) {
    const { repository } = setup(page);
    await assert.rejects(repository.searchPage(member), (error) => {
      assert.match(error.message, /INVALID_/);
      assert.equal(error.message.includes("PRIVATE_"), false);
      return true;
    });
  }
});

test("잘못된 카드·날짜·금액·페이지 구조를 빈 결과로 가장하지 않는다", async () => {
  const pages = [
    { items: [{ ...card, id: "not-a-uuid" }], nextCursor: null },
    { items: [{ ...card, authorDisplayName: "" }], nextCursor: null },
    { items: [{ ...card, publicArea: "" }], nextCursor: null },
    { items: [{ ...card, state: "deleted" }], nextCursor: null },
    { items: [{ ...card, endsAt: card.startsAt }], nextCursor: null },
    { items: [{ ...card, startsAt: "2026-02-30T12:00:00Z" }], nextCursor: null },
    { items: [{ ...card, cost: { kind: "paid_offer", amount: -1, direction: "applicant_to_author" } }], nextCursor: null },
    { items: [card, card], nextCursor: null },
    { items: [card], nextCursor: "unversioned-cursor" },
    { items: [], nextCursor: position },
    { items: [card], nextCursor: position },
    { items: [card] },
    { items: null, nextCursor: null },
  ];
  for (const [index, page] of pages.entries()) {
    const { repository } = setup(page);
    await assert.rejects(repository.searchPage(member), /INVALID_|DUPLICATE_/, `잘못된 페이지 사례 ${index}`);
  }
});

test("익명 날짜·나이 제한과 잘못된 입력을 RPC 호출 전에 거절한다", async () => {
  const { repository, calls } = setup();
  for (const input of [
    { caller: "anonymous", period: { startsAt: "2026-10-03T00:00:00Z", endsAt: "2026-10-04T00:00:00Z" } },
    { caller: "anonymous", authorAge: "20s" },
  ]) await assert.rejects(repository.searchPage(input), /AUTH_REQUIRED/);
  for (const input of [
    { ...member, limit: 0 }, { ...member, limit: 51 }, { ...member, authorAge: "teen" },
    { ...member, category: "unregistered-category" }, { ...member, query: "가".repeat(301) },
  ]) await assert.rejects(repository.searchPage(input), /INVALID_/);
  assert.equal(calls.length, 0);
});

test("불투명 커서는 버전과 필터에 묶이며 다른 조건으로 재사용할 수 없다", async () => {
  const input = { ...member, query: "전시", category: "전시", authorAge: "20s", limit: 5 };
  const cursor = encodePublicPostCursor(input, position);
  assert.deepEqual(decodePublicPostCursor(cursor, input), position);
  const { repository, calls } = setup();
  for (const changed of [
    { query: "식사" }, { category: "식사" }, { cost: "free" },
    { authorAge: "30s" }, { availability: "recruiting" },
  ]) await assert.rejects(repository.searchPage({ ...input, ...changed, cursor }), /INVALID_CURSOR/);
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  const otherVersion = Buffer.from(JSON.stringify({ ...parsed, v: 2 })).toString("base64url");
  await assert.rejects(repository.searchPage({ ...input, cursor: otherVersion }), /INVALID_CURSOR/);
  await assert.rejects(repository.searchPage({ ...input, cursor: "malformed" }), /INVALID_CURSOR/);
  assert.equal(calls.length, 0);
});

test("RPC 실패는 구형 RPC·무료 추정·가상 저장소 fallback 없이 그대로 실패한다", async () => {
  const calls = [];
  const upstream = new Error("EXTERNAL_UNAVAILABLE");
  const repository = createRpcPublicPostSearchRepository({ async rpc(name) { calls.push(name); throw upstream; } });
  await assert.rejects(repository.searchPage(member), (error) => error === upstream);
  assert.deepEqual(calls, ["search_public_posts_v2"]);
});
