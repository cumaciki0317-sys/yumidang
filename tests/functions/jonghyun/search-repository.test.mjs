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
  publicArea: "서울특별시 종로구 종로1가",
  startsAt: "2026-10-03T12:00:00.000002+09:00",
  endsAt: "2026-10-03T14:00:00.000002+09:00",
  cost: { kind: "free" },
  state: "recruiting",
  canApply: true,
};
const position = {
  sortAt: "2026-09-29T00:00:00.000001Z",
  id: secondId,
};
function setup(result = { items: [card], nextCursor: null }) {
  const calls = [];
  const db = { async rpc(name, args) { calls.push({ name, args }); return structuredClone(result); } };
  return { calls, repository: createRpcPublicPostSearchRepository(db) };
}
function rawCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
function unpackCursor(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

test("회원 필터·선택 정렬·제한을 v2 RPC에 전달하고 caller·토큰을 SQL 인자로 만들지 않는다", async () => {
  const input = {
    ...member, query: "전시", category: "전시", cost: "paid", availability: "recruiting",
    period: { startsAt: "2026-10-03T00:00:00+09:00", endsAt: "2026-10-05T00:00:00+09:00" },
    authorAge: "30s", sort: "starts_asc", limit: 7,
  };
  const { repository, calls } = setup({ items: [], nextCursor: null });
  assert.deepEqual(await repository.searchPage(input), { items: [], nextCursor: null });
  assert.deepEqual(calls, [{
    name: "search_public_posts_v2",
    args: {
      p_filters: {
        query: "전시", category: "전시", cost: "paid", availability: "recruiting",
        periodStart: input.period.startsAt, periodEnd: input.period.endsAt, authorAge: "30s", sort: "starts_asc",
      },
      p_cursor: null,
      p_limit: 7,
    },
  }]);
});

test("기본 등록일순 DB 페이지는 시작일로 재정렬하지 않고 별도 등록시각 커서를 보존한다", async () => {
  const second = { ...card, id: secondId, startsAt: "2026-10-03T12:00:00.000001+09:00" };
  const { repository, calls } = setup({ items: [card, second], nextCursor: position });
  const result = await searchPublicPosts(repository, member);
  assert.equal(result.status, "results");
  assert.deepEqual(result.posts.map((value) => value.id), [firstId, secondId]);
  assert.equal(result.posts[0].startsAt, card.startsAt);
  assert.equal(result.posts[1].startsAt, second.startsAt);
  assert.equal(calls[0].args.p_filters.sort, "created_desc");
  assert.equal(calls[0].args.p_filters.availability, "all");
  assert.deepEqual(decodePublicPostCursor(result.nextCursor, member), position);
  assert.deepEqual(Object.keys(unpackCursor(result.nextCursor).position).sort(), ["id", "sortAt"]);
  for (const row of result.posts) assert.equal("createdAt" in row, false);
  const next = setup({ items: [], nextCursor: null });
  await next.repository.searchPage({ ...member, cursor: result.nextCursor });
  assert.deepEqual(next.calls[0].args.p_cursor, position);
  assert.equal(next.calls[0].args.p_cursor.sortAt, "2026-09-29T00:00:00.000001Z");
});

test("시작일순 다음 커서는 마지막 시작시각과 같은 순간이어야 하며 offset·마이크로초를 보존한다", async () => {
  const input = { ...member, sort: "starts_asc" };
  const next = { sortAt: "2026-10-03T03:00:00.000002Z", id: firstId };
  const { repository } = setup({ items: [card], nextCursor: next });
  const page = await repository.searchPage(input);
  assert.deepEqual(decodePublicPostCursor(page.nextCursor, input), next);
  for (const sortAt of ["2026-10-03T03:00:00.000001Z", "2026-10-03T03:00:00.000003Z"]) {
    const bad = setup({ items: [card], nextCursor: { ...next, sortAt } });
    await assert.rejects(bad.repository.searchPage(input), /INVALID_SEARCH_RESPONSE/);
  }
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
    { items: [{ ...card, privateMeetingPoint: "PRIVATE_MEETING" }], nextCursor: null },
    { items: [{ ...card, realName: "PRIVATE_NAME" }], nextCursor: null },
    { items: [{ ...card, birthDate: "PRIVATE_BIRTH" }], nextCursor: null },
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

test("잘못된 카드·날짜·금액·페이지 구조와 구형 DB 커서를 빈 결과로 가장하지 않는다", async () => {
  const matchingPosition = { ...position, id: firstId };
  const pages = [
    { items: [{ ...card, id: "not-a-uuid" }], nextCursor: null },
    { items: [{ ...card, authorDisplayName: "" }], nextCursor: null },
    { items: [{ ...card, publicArea: "" }], nextCursor: null },
    { items: [{ ...card, publicArea: "서울특별시 종로구 종로1가 12-3" }], nextCursor: null },
    { items: [{ ...card, state: "deleted" }], nextCursor: null },
    { items: [{ ...card, endsAt: card.startsAt }], nextCursor: null },
    { items: [{ ...card, startsAt: "2026-02-30T12:00:00Z" }], nextCursor: null },
    { items: [{ ...card, cost: { kind: "paid_offer", amount: -1, direction: "applicant_to_author" } }], nextCursor: null },
    { items: [card, card], nextCursor: null },
    { items: [card], nextCursor: "unversioned-cursor" },
    { items: [], nextCursor: position },
    { items: [card], nextCursor: position },
    { items: [card], nextCursor: { ...matchingPosition, periodGroup: 0, recruitingGroup: 0 } },
    { items: [card], nextCursor: { ...matchingPosition, sortAt: "2026-09-29T00:00:00.0000001Z" } },
    { items: [card], nextCursor: { ...matchingPosition, sortAt: "2026-09-29T00:00:00" } },
    { items: [card] },
    { items: null, nextCursor: null },
  ];
  for (const [index, page] of pages.entries()) {
    const { repository } = setup(page);
    await assert.rejects(repository.searchPage(member), /INVALID_|DUPLICATE_/, "잘못된 페이지 사례 " + index);
  }
});

test("익명 기간·나이 all은 RPC로 전달하고 상세 나이와 잘못된 입력은 호출 전에 거절한다", async () => {
  const { repository, calls } = setup({ items: [{ ...card, authorDisplayName: "동행 1234" }], nextCursor: null });
  const period = { startsAt: "2026-10-03T00:00:00Z", endsAt: "2026-10-04T00:00:00Z" };
  for (const authorAge of ["20s", "30s", "40plus"]) {
    await assert.rejects(repository.searchPage({ caller: "anonymous", period, authorAge }), /AUTH_REQUIRED/);
  }
  for (const input of [
    { ...member, limit: 0 }, { ...member, limit: 51 }, { ...member, authorAge: "teen" },
    { ...member, category: "unregistered-category" }, { ...member, query: "가".repeat(301) },
    { ...member, sort: "recruiting_first" }, { ...member, sort: null },
  ]) await assert.rejects(repository.searchPage(input), /INVALID_/);
  assert.equal(calls.length, 0);
  const page = await repository.searchPage({ caller: "anonymous", period, authorAge: "all" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.p_filters.periodStart, period.startsAt);
  assert.equal(calls[0].args.p_filters.periodEnd, period.endsAt);
  assert.equal(calls[0].args.p_filters.authorAge, "all");
  assert.equal(calls[0].args.p_filters.sort, "created_desc");
  assert.equal(page.items[0].authorDisplayName, "동행 1234");
  assert.equal(page.items[0].publicArea, card.publicArea);
  assert.equal(page.items[0].canApply, false);
});

test("외부 커서는 v2·정규화 필터·정렬에 묶이며 구버전과 다른 조건을 거절한다", async () => {
  const input = { ...member, query: "  Art   Hall ", category: "전시", authorAge: "20s", limit: 5 };
  const cursor = encodePublicPostCursor(input, position);
  const parsed = unpackCursor(cursor);
  assert.equal(parsed.v, 2);
  assert.equal(parsed.filters.query, "art hall");
  assert.equal(parsed.filters.sort, "created_desc");
  assert.deepEqual(parsed.position, position);
  assert.deepEqual(decodePublicPostCursor(cursor, { ...input, query: "art hall", limit: 1 }), position);
  const { repository, calls } = setup();
  for (const changed of [
    { query: "식사" }, { category: "식사" }, { cost: "free" },
    { authorAge: "30s" }, { availability: "recruiting" }, { sort: "starts_asc" },
    { period: { startsAt: "2026-10-03T00:00:00Z", endsAt: "2026-10-04T00:00:00Z" } },
  ]) await assert.rejects(repository.searchPage({ ...input, ...changed, cursor }), /INVALID_CURSOR/);
  const oldFilters = { ...parsed.filters }; delete oldFilters.sort;
  const invalid = [
    rawCursor({ ...parsed, v: 1, filters: oldFilters, position: { ...position, periodGroup: 0, recruitingGroup: 0 } }),
    rawCursor({ ...parsed, v: 3 }),
    rawCursor({ ...parsed, position: { ...position, periodGroup: 0 } }),
    rawCursor({ ...parsed, position: { ...position, sortAt: "2026-09-29T00:00:00.0000001Z" } }),
    "malformed",
  ];
  for (const badCursor of invalid) {
    await assert.rejects(repository.searchPage({ ...input, cursor: badCursor }), /INVALID_CURSOR/);
  }
  assert.equal(calls.length, 0);
});

test("커서는 같은 순간의 다른 offset·같거나 작은 ID·반대 방향 시각으로 진행할 수 없다", async () => {
  const lowerId = "00000000-0000-4000-8000-00000000000a";
  const priorId = "00000000-0000-4000-8000-00000000000b";
  const higherId = "00000000-0000-4000-8000-00000000000c";
  const previous = { sortAt: "2026-10-03T03:00:00.000002Z", id: priorId };
  for (const sort of ["created_desc", "starts_asc"]) {
    const input = { ...member, sort };
    const cursor = encodePublicPostCursor(input, previous);
    const backwardAt = sort === "created_desc" ? "2026-10-03T03:00:00.000003Z" : "2026-10-03T03:00:00.000001Z";
    for (const next of [
      { sortAt: "2026-10-03T12:00:00.000002+09:00", id: priorId.toUpperCase() },
      { sortAt: previous.sortAt, id: lowerId },
      { sortAt: backwardAt, id: higherId },
    ]) {
      const row = { ...card, id: next.id, startsAt: sort === "starts_asc" ? next.sortAt : card.startsAt };
      const { repository } = setup({ items: [row], nextCursor: next });
      await assert.rejects(repository.searchPage({ ...input, cursor }), /INVALID_SEARCH_RESPONSE/);
    }
    const forwardAt = sort === "created_desc" ? "2026-10-03T03:00:00.000001Z" : "2026-10-03T03:00:00.000003Z";
    for (const next of [
      { sortAt: "2026-10-03T12:00:00.000002+09:00", id: higherId.toUpperCase() },
      { sortAt: forwardAt, id: lowerId },
    ]) {
      const row = { ...card, id: next.id, startsAt: sort === "starts_asc" ? next.sortAt : card.startsAt };
      const { repository } = setup({ items: [row], nextCursor: next });
      const result = await repository.searchPage({ ...input, cursor });
      assert.deepEqual(decodePublicPostCursor(result.nextCursor, input), { ...next, id: next.id.toLowerCase() });
    }
  }
});

test("두 정렬·전체/모집의 정적 여러 페이지를 독립 예상 순서와 비교해 중복·누락을 확인한다", async () => {
  const id = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  // 정렬 함수나 운영 timestamp parser를 재사용하지 않는 고정 oracle다.
  // 모든 자료가 선택 기간에 겹치며, 3번은 기간 전에 시작한 확정 공고다.
  const records = new Map([
    [1, { createdAt: "2026-09-29T00:00:00.000002Z", startsAt: "2026-10-03T10:00:00.000002Z", state: "recruiting" }],
    [2, { createdAt: "2026-09-29T00:00:00.000002Z", startsAt: "2026-10-03T10:00:00.000001Z", state: "closed" }],
    [3, { createdAt: "2026-09-29T00:00:00.000003Z", startsAt: "2026-10-02T23:00:00.000001Z", state: "confirmed" }],
    [4, { createdAt: "2026-09-29T00:00:00.000001Z", startsAt: "2026-10-03T10:00:00.000001Z", state: "recruiting" }],
    [5, { createdAt: "2026-09-29T00:00:00.000000Z", startsAt: "2026-10-04T00:00:00.000000Z", state: "expired" }],
    [6, { createdAt: "2026-09-29T00:00:00.000002Z", startsAt: "2026-10-03T10:00:00.000001Z", state: "recruiting" }],
  ]);
  const cases = [
    ["created_desc", "all", [3, 1, 2, 6, 4, 5]],
    ["created_desc", "recruiting", [1, 6, 4]],
    ["starts_asc", "all", [3, 2, 4, 6, 1, 5]],
    ["starts_asc", "recruiting", [4, 6, 1]],
  ];
  for (const caller of ["anonymous", "member"]) {
    for (const [sort, availability, expected] of cases) {
      const input = {
        caller, sort, availability, limit: 2,
        period: { startsAt: "2026-10-03T00:00:00Z", endsAt: "2026-10-05T00:00:00Z" },
      };
      let offset = 0;
      let previousPosition = null;
      let rpcCalls = 0;
      const db = { async rpc(name, args) {
        rpcCalls += 1;
        assert.equal(name, "search_public_posts_v2");
        assert.equal(args.p_filters.sort, sort);
        assert.equal(args.p_filters.availability, availability);
        assert.equal(args.p_filters.authorAge, "all");
        assert.equal(args.p_filters.periodStart, input.period.startsAt);
        assert.equal(args.p_filters.periodEnd, input.period.endsAt);
        assert.equal(args.p_limit, 2);
        assert.deepEqual(args.p_cursor, previousPosition);
        assert.ok(offset < expected.length, "마지막 페이지 뒤에 추가 호출하지 않는다");
        const numbers = expected.slice(offset, offset + 2);
        const items = numbers.map((number) => ({
          ...card, id: id(number), title: "가상 공고 " + number,
          authorDisplayName: caller === "anonymous" ? "동행 " + number : "김*현",
          startsAt: records.get(number).startsAt, endsAt: "2026-10-05T00:00:00.000000Z",
          state: records.get(number).state, canApply: caller === "member" && records.get(number).state === "recruiting",
        }));
        offset += numbers.length;
        const last = numbers.at(-1);
        const nextCursor = offset < expected.length ? {
          sortAt: records.get(last)[sort === "created_desc" ? "createdAt" : "startsAt"], id: id(last),
        } : null;
        previousPosition = nextCursor;
        return { items, nextCursor };
      } };
      const repository = createRpcPublicPostSearchRepository(db);
      const collected = [];
      const seenCursors = new Set();
      let cursor;
      for (let pageNumber = 0; ; pageNumber += 1) {
        assert.ok(pageNumber < 4, "페이지 순환을 허용하지 않는다");
        const result = await searchPublicPosts(repository, { ...input, ...(cursor ? { cursor } : {}) });
        collected.push(...result.posts);
        if (result.nextCursor === null) break;
        assert.equal(seenCursors.has(result.nextCursor), false);
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      assert.deepEqual(collected.map((row) => row.id), expected.map(id));
      assert.equal(new Set(collected.map((row) => row.id)).size, expected.length);
      assert.equal(rpcCalls, Math.ceil(expected.length / 2));
      assert.equal(collected.every((row) => row.publicArea === "서울특별시 종로구 종로1가"), true);
      assert.equal(collected.some((row) => "createdAt" in row), false);
      if (caller === "anonymous") assert.equal(collected.every((row) => !row.canApply), true);
    }
  }
});

test("RPC 실패는 구형 RPC·무료 추정·가상 저장소 fallback 없이 그대로 실패한다", async () => {
  const calls = [];
  const upstream = new Error("EXTERNAL_UNAVAILABLE");
  const repository = createRpcPublicPostSearchRepository({ async rpc(name) { calls.push(name); throw upstream; } });
  await assert.rejects(repository.searchPage(member), (error) => error === upstream);
  assert.deepEqual(calls, ["search_public_posts_v2"]);
});
