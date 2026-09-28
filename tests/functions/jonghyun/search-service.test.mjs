import assert from "node:assert/strict";
import test from "node:test";
import {
  listProjectedPublicPosts,
  searchPublicPosts,
  toPublicPostCard,
} from "../../../backend/supabase/functions/_shared/services/search-service.ts";
import {
  createInMemoryPublicPostSearchRepository,
  filterPostSearchCandidates,
  matchesPostKeyword,
} from "../../../backend/supabase/functions/_shared/db/repositories/search.ts";

const base = {
  id: "post-01",
  title: "전시 같이 보기",
  anonymousAlias: "회원 01",
  maskedName: "김*현",
  publicAreaDistrict: "서울특별시 종로구",
  startsAt: "2026-10-03T14:00:00+09:00",
  endsAt: "2026-10-03T17:00:00+09:00",
  createdAt: "2026-09-23T09:00:00+09:00",
  cost: { kind: "free" },
  state: "recruiting",
  eligibleToApply: true,
  registeredAddress: "서울 종로구 새문안로 00",
  privateMeetingPoint: "가상 건물 3층",
  exact_location: "비공개 레거시 위치",
  authorName: "김종현",
};
const member = { caller: "member" };
const ids = (result) => result.posts.map((post) => post.id);
const period = {
  startsAt: "2026-10-03T00:00:00+09:00",
  endsAt: "2026-10-05T00:00:00+09:00",
};
const post = (id, overrides = {}) => ({ ...base, id, ...overrides });
const candidate = (row, category = "exhibition", index = {}) => ({
  publicRow: row,
  category,
  index: { title: row.title, registeredPlaceName: "Art  Hall", registeredAddress: base.registeredAddress, ...index },
});

// 가상 행 기반 순수 로직 테스트. 실제 DB/RLS·인증·HTTP 실행 검증은 아니다.
test("비공개 검색 필드와 중첩 비용 여분 필드는 회원·비회원 카드에 들어가지 않는다", () => {
  const row = post("private-row", {
    cost: { kind: "paid_request", amount: 15000, accountNumber: "PRIVATE-ACCOUNT", direction: "WRONG" },
  });
  for (const caller of ["anonymous", "member"]) {
    const result = listProjectedPublicPosts([row], { caller });
    assert.equal(result.status, "results");
    assert.equal(result.posts[0].publicArea, "서울특별시 종로구");
    assert.equal(result.posts[0].authorDisplayName, caller === "anonymous" ? "회원 01" : "김*현");
    assert.equal(result.posts[0].canApply, caller === "member");
    assert.deepEqual(result.posts[0].cost, {
      kind: "paid_request", amount: 15000, direction: "author_to_applicant",
    });
    for (const privateValue of [base.registeredAddress, base.privateMeetingPoint,
      base.exact_location, base.authorName, "PRIVATE-ACCOUNT", "WRONG"]) {
      assert.equal(JSON.stringify(result).includes(privateValue), false);
    }
    assert.equal("createdAt" in result.posts[0], false);
  }
});

test("무료·유료 요청·유료 제공의 지급 방향을 유형으로 정한다", () => {
  assert.deepEqual(toPublicPostCard(base, "member").cost, { kind: "free" });
  assert.deepEqual(toPublicPostCard(post("offer", {
    cost: { kind: "paid_offer", amount: 12000, accountNumber: "PRIVATE" },
  }), "member").cost, { kind: "paid_offer", amount: 12000, direction: "applicant_to_author" });
  for (const cost of [{ kind: "paid", amount: 100 }, { kind: "paid_offer", amount: 0 },
    { kind: "paid_request", amount: -1 }, { kind: "paid_offer", amount: Infinity },
    { kind: "paid_offer", amount: "10000" }, { kind: "other" }]) {
    assert.throws(() => toPublicPostCard(post("invalid", { cost }), "member"), /INVALID_POST_COST/);
  }
});

test("기본 목록은 모집 중 외 상태도 보이고 모집 중 필터에서 제외한다", () => {
  const rows = [base, post("post-02", { state: "closed" }),
    post("post-03", { state: "confirmed" }), post("post-04", { state: "expired" })];
  const all = listProjectedPublicPosts(rows, member);
  assert.deepEqual(ids(all), ["post-01", "post-02", "post-03", "post-04"]);
  assert.deepEqual(all.posts.map((card) => card.canApply), [true, false, false, false]);
  const recruiting = listProjectedPublicPosts(rows, { ...member, availability: "recruiting" });
  assert.deepEqual(ids(recruiting), ["post-01"]);
  const unavailable = listProjectedPublicPosts([post("ineligible", { eligibleToApply: false })], member);
  assert.equal(unavailable.posts[0].canApply, false);
});

test("공개할 수 없는 상태·호출자·비정상 권한 값을 조용히 노출하지 않는다", () => {
  assert.throws(() => listProjectedPublicPosts([post("deleted", { state: "deleted" })], member), /INVALID_POST_STATE/);
  assert.throws(() => listProjectedPublicPosts([post("deleted", { state: "deleted" })], {
    ...member, availability: "recruiting",
  }), /INVALID_POST_STATE/);
  assert.throws(() => toPublicPostCard(base, "owner"), /INVALID_CALLER/);
  assert.throws(() => toPublicPostCard(post("bad", { eligibleToApply: "true" }), "member"), /INVALID_PUBLIC_PROJECTION/);
  assert.throws(() => toPublicPostCard(post("bad", { maskedName: "" }), "member"), /INVALID_PUBLIC_PROJECTION/);
});

test("제목·등록 장소명·등록 주소 한 필드의 부분 일치를 찾고 소개·레거시 위치는 제외한다", () => {
  const fields = {
    title: "가을 전시 동행",
    registeredPlaceName: "Art  Hall",
    registeredAddress: base.registeredAddress,
    introduction: "비공개 소개 문구",
    exact_location: "3층 좌석",
  };
  for (const query of ["전시", "art hall", "ART    HALL", "  Art\t Hall ", "새문안로"]) {
    assert.equal(matchesPostKeyword(fields, query), true);
  }
  for (const query of ["전시 Art", "비공개 소개", "3층 좌석"]) {
    assert.equal(matchesPostKeyword(fields, query), false);
  }
  assert.throws(() => matchesPostKeyword({ title: "전시", registeredAddress: 10 }, "전시"), /INVALID_SEARCH_INDEX/);
});

test("빈 검색어는 다른 카테고리·비용·모집 조건을 유지한 목록 요청이다", async () => {
  const repository = createInMemoryPublicPostSearchRepository([
    candidate(base),
    candidate(post("paid-request", { cost: { kind: "paid_request", amount: 10000 } })),
    candidate(post("paid-offer", { cost: { kind: "paid_offer", amount: 20000 } })),
    candidate(post("closed-paid", { state: "closed", cost: { kind: "paid_offer", amount: 20000 } })),
    candidate(post("other-category", { cost: { kind: "paid_request", amount: 10000 } }), "meal"),
  ]);
  assert.equal(matchesPostKeyword({ title: "전시" }, "   "), true);
  assert.deepEqual(ids(await searchPublicPosts(repository, {
    ...member, query: "   ", category: "exhibition", cost: "paid", availability: "recruiting",
  })), ["paid-offer", "paid-request"]);
  assert.deepEqual(ids(await searchPublicPosts(repository, { ...member, cost: "free" })), ["post-01"]);
});

test("등록 주소 일치 후 저장소 경계와 최종 응답 모두에 주소와 상세 지점을 전달하지 않는다", async () => {
  const candidates = [candidate(post("by-address", {
    cost: { kind: "paid_offer", amount: 12000, accountNumber: "PRIVATE-ACCOUNT" },
  }))];
  const input = { ...member, query: "새문안로" };
  const rows = filterPostSearchCandidates(candidates, input);
  const result = await searchPublicPosts(createInMemoryPublicPostSearchRepository(candidates), input);
  assert.deepEqual(ids(result), ["by-address"]);
  for (const value of [base.registeredAddress, base.privateMeetingPoint, base.exact_location, "PRIVATE-ACCOUNT"]) {
    assert.equal(JSON.stringify(rows).includes(value), false);
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test("기간 미선택: 모집 중은 빠른 시작순, 나머지는 최근 등록순, 동률은 ID순", () => {
  const rows = [
    post("closed-old", { state: "closed", createdAt: "2026-09-20T00:00:00Z" }),
    post("recruiting-late", { startsAt: "2026-10-04T01:00:00Z", endsAt: "2026-10-04T02:00:00Z" }),
    post("tie-b"), post("tie-a"),
    post("confirmed-new", { state: "confirmed", createdAt: "2026-09-25T00:00:00Z" }),
    post("expired-new", { state: "expired", createdAt: "2026-09-25T00:00:00Z" }),
  ];
  const original = structuredClone(rows);
  assert.deepEqual(ids(listProjectedPublicPosts(rows, member)), [
    "tie-a", "tie-b", "recruiting-late", "confirmed-new", "expired-new", "closed-old",
  ]);
  assert.deepEqual(rows, original);
});

test("기간 선택: 안에서 시작하는 그룹 우선, 각 그룹은 모집 우선과 시작/등록순 적용", () => {
  const rows = [
    post("overlap-recruiting", { startsAt: "2026-10-02T23:00:00+09:00" }),
    post("inside-closed-old", { state: "closed", createdAt: "2026-09-20T00:00:00Z" }),
    post("inside-closed-new", { state: "closed", createdAt: "2026-09-25T00:00:00Z" }),
    post("inside-recruiting-late", { startsAt: "2026-10-04T01:00:00+09:00", endsAt: "2026-10-04T02:00:00+09:00" }),
    post("inside-recruiting-early"),
    post("overlap-closed-old", { state: "closed", startsAt: "2026-10-02T23:00:00+09:00", createdAt: "2026-09-20T00:00:00Z" }),
    post("overlap-closed-new", { state: "closed", startsAt: "2026-10-02T23:00:00+09:00", createdAt: "2026-09-25T00:00:00Z" }),
  ];
  assert.deepEqual(ids(listProjectedPublicPosts(rows, { ...member, period })), [
    "inside-recruiting-early", "inside-recruiting-late", "inside-closed-new", "inside-closed-old",
    "overlap-recruiting", "overlap-closed-new", "overlap-closed-old",
  ]);
  assert.deepEqual(ids(listProjectedPublicPosts(rows, { ...member, period, availability: "recruiting" })), [
    "inside-recruiting-early", "inside-recruiting-late", "overlap-recruiting",
  ]);
});

test("기간 겹침은 양의 겹침만 허용하며 같은 시각의 UTC/KST 표현을 동일하게 처리한다", () => {
  const rows = [
    post("ends-at-start", { startsAt: "2026-10-02T13:00:00Z", endsAt: "2026-10-02T15:00:00Z" }),
    post("starts-at-end", { startsAt: "2026-10-04T15:00:00Z", endsAt: "2026-10-04T16:00:00Z" }),
    post("starts-at-start", { startsAt: "2026-10-02T15:00:00Z", endsAt: "2026-10-02T16:00:00Z" }),
    post("one-ms-overlap", { startsAt: "2026-10-02T14:00:00Z", endsAt: "2026-10-02T15:00:00.001Z" }),
  ];
  assert.deepEqual(ids(listProjectedPublicPosts(rows, { ...member, period })), ["starts-at-start", "one-ms-overlap"]);
});

test("시간대 누락·존재하지 않는 날짜·역전 기간과 알 수 없는 필터를 거절한다", () => {
  for (const input of [
    { ...member, availability: "closed" }, { ...member, availability: null },
    { ...member, cost: "paid_offer" }, { ...member, query: null },
    { ...member, category: "  " }, { ...member, radius: 1 }, { ...member, authorAge: 30 },
    { ...member, period: null },
    { ...member, period: { ...period, endsAt: period.startsAt } },
    { ...member, period: { ...period, startsAt: "2026-10-05T00:00:00+09:00" } },
    { ...member, period: { ...period, startsAt: "2026-02-30T00:00:00+09:00" } },
    { ...member, period: { ...period, startsAt: "2026-10-03T00:00:00" } },
  ]) {
    assert.throws(() => listProjectedPublicPosts([base], input), /INVALID_|UNSUPPORTED_FILTER/);
  }
  for (const overrides of [
    { createdAt: "bad" }, { startsAt: base.endsAt },
    { endsAt: "2026-02-30T17:00:00+09:00" },
    { startsAt: "2026-10-03T24:00:00+09:00" },
  ]) assert.throws(() => listProjectedPublicPosts([post("bad", overrides)], member), /INVALID_/);
  assert.throws(() => listProjectedPublicPosts([base, base], member), /DUPLICATE_POST_ID/);
});

test("0건과 저장소 실패를 구분하고 잘못된 조건일 때 저장소를 호출하지 않는다", async () => {
  const repository = createInMemoryPublicPostSearchRepository([candidate(base)]);
  assert.deepEqual(await searchPublicPosts(repository, { ...member, query: "없는 행사" }), {
    status: "no_results", posts: [],
  });
  let calls = 0;
  const failing = { async search() { calls += 1; throw new Error("SOURCE_UNAVAILABLE"); } };
  await assert.rejects(searchPublicPosts(failing, { ...member, radius: 5 }), /UNSUPPORTED_FILTER/);
  assert.equal(calls, 0);
  await assert.rejects(searchPublicPosts(failing, member), /SOURCE_UNAVAILABLE/);
  assert.equal(calls, 1);
});
