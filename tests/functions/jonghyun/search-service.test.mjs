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
  publicAreaDistrict: "서울특별시 종로구 종로1가",
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
const candidate = (row, category = "전시", index = {}) => ({
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
    assert.equal(result.posts[0].publicArea, "서울특별시 종로구 종로1가");
    assert.equal(result.posts[0].authorDisplayName, caller === "anonymous" ? null : "김*현");
    assert.equal(result.posts[0].canApply, false);
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

test("SQL 공개 지역 형식의 동·읍·면·숫자 가와 60자 경계를 원문 그대로 보존한다", () => {
  const sixty = "가".repeat(53) + "도 나군 다동";
  assert.equal(sixty.length, 60);
  for (const publicAreaDistrict of [
    "서울특별시 성동구 성수동", "서울특별시 종로구 종로1가",
    "경기도 수원시 영통구 영통동", "경기도 양평군 양평읍",
    "강원특별자치도 홍천군 서면", "세종특별자치시 아름동", "세종특별자치시 조치원읍", sixty,
  ]) {
    for (const caller of ["anonymous", "member"]) {
      assert.equal(toPublicPostCard(post("area", { publicAreaDistrict }), caller).publicArea, publicAreaDistrict);
    }
  }
  for (const publicAreaDistrict of [
    "서울특별시 종로구", "서울특별시 성동구 성수동 12-3", "서울특별시 성동구 성수동 3층",
    "서울특별시  성동구 성수동", " 서울특별시 성동구 성수동", "서울특별시 성동구 성수동\n",
    "가" + sixty,
  ]) {
    assert.throws(() => toPublicPostCard(post("invalid-area", { publicAreaDistrict }), "member"), /INVALID_PUBLIC_PROJECTION/);
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

test("비용 미확인 공고는 전체 목록에만 남기고 회원도 신청할 수 없다", async () => {
  const unknown = post("historical-unknown", {
    cost: { kind: "unknown", accountNumber: "PRIVATE-ACCOUNT" },
    eligibleToApply: true,
  });
  const repository = createInMemoryPublicPostSearchRepository([
    candidate(unknown), candidate(base),
    candidate(post("paid", { cost: { kind: "paid_offer", amount: 12000 } })),
  ]);
  for (const caller of ["anonymous", "member"]) {
    const all = await searchPublicPosts(repository, { caller, cost: "all" });
    const card = all.posts.find((value) => value.id === unknown.id);
    assert.ok(card);
    assert.deepEqual(card.cost, { kind: "unknown" });
    assert.equal(card.canApply, false);
    assert.equal(JSON.stringify(card).includes("PRIVATE-ACCOUNT"), false);
    assert.deepEqual(ids(await searchPublicPosts(repository, { caller, cost: "free" })), [base.id]);
    assert.deepEqual(ids(await searchPublicPosts(repository, { caller, cost: "paid" })), ["paid"]);
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
    candidate(post("other-category", { cost: { kind: "paid_request", amount: 10000 } }), "식사"),
  ]);
  assert.equal(matchesPostKeyword({ title: "전시" }, "   "), true);
  assert.deepEqual(ids(await searchPublicPosts(repository, {
    ...member, query: "   ", category: "전시", cost: "paid", availability: "recruiting",
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

test("기본 등록일 최신순과 선택 시작일 빠른순은 모집 여부보다 우선하고 동률은 ID순이다", () => {
  const rows = [
    post("old-recruiting", { createdAt: "2026-09-20T00:00:00Z", startsAt: "2026-10-03T13:00:00+09:00" }),
    post("late-recruiting", { createdAt: "2026-09-23T00:00:00Z", startsAt: "2026-10-04T01:00:00+09:00", endsAt: "2026-10-04T02:00:00+09:00" }),
    post("tie-b", { createdAt: "2026-09-24T00:00:00Z" }),
    post("tie-a", { createdAt: "2026-09-24T00:00:00Z", state: "confirmed" }),
    post("new-closed", { createdAt: "2026-09-25T00:00:00Z", state: "closed", startsAt: "2026-10-03T12:00:00+09:00" }),
  ];
  const original = structuredClone(rows);
  const cases = [
    [{}, ["new-closed", "tie-a", "tie-b", "late-recruiting", "old-recruiting"]],
    [{ sort: "created_desc" }, ["new-closed", "tie-a", "tie-b", "late-recruiting", "old-recruiting"]],
    [{ sort: "starts_asc" }, ["new-closed", "old-recruiting", "tie-a", "tie-b", "late-recruiting"]],
    [{ sort: "created_desc", availability: "recruiting" }, ["tie-b", "late-recruiting", "old-recruiting"]],
    [{ sort: "starts_asc", availability: "recruiting" }, ["old-recruiting", "tie-b", "late-recruiting"]],
  ];
  for (const [filters, expected] of cases) {
    assert.deepEqual(ids(listProjectedPublicPosts(rows, { ...member, ...filters })), expected);
  }
  assert.deepEqual(rows, original);
});

test("기간은 겹침 필터이며 기간 안 시작·모집 상태가 선택 정렬을 덮지 않는다", () => {
  const rows = [
    post("overlap-closed-new", { state: "closed", startsAt: "2026-10-02T23:00:00+09:00", createdAt: "2026-09-27T00:00:00Z" }),
    post("inside-recruiting-old", { createdAt: "2026-09-20T00:00:00Z" }),
    post("inside-confirmed", { state: "confirmed", startsAt: "2026-10-03T10:00:00+09:00", createdAt: "2026-09-25T00:00:00Z" }),
    post("overlap-recruiting", { startsAt: "2026-10-02T22:00:00+09:00", createdAt: "2026-09-26T00:00:00Z" }),
    post("outside-newest", { startsAt: "2026-10-05T00:00:00+09:00", endsAt: "2026-10-05T02:00:00+09:00", createdAt: "2026-09-28T00:00:00Z" }),
  ];
  const cases = [
    ["created_desc", "all", ["overlap-closed-new", "overlap-recruiting", "inside-confirmed", "inside-recruiting-old"]],
    ["starts_asc", "all", ["overlap-recruiting", "overlap-closed-new", "inside-confirmed", "inside-recruiting-old"]],
    ["created_desc", "recruiting", ["overlap-recruiting", "inside-recruiting-old"]],
    ["starts_asc", "recruiting", ["overlap-recruiting", "inside-recruiting-old"]],
  ];
  for (const [sort, availability, expected] of cases) {
    assert.deepEqual(ids(listProjectedPublicPosts(rows, { ...member, period, sort, availability })), expected);
  }
});

test("기간 겹침은 양의 겹침만 허용하며 같은 시각의 UTC/KST 표현을 동일하게 처리한다", () => {
  const rows = [
    post("ends-at-start", { startsAt: "2026-10-02T13:00:00Z", endsAt: "2026-10-02T15:00:00Z" }),
    post("starts-at-end", { startsAt: "2026-10-04T15:00:00Z", endsAt: "2026-10-04T16:00:00Z" }),
    post("starts-at-start", { startsAt: "2026-10-02T15:00:00Z", endsAt: "2026-10-02T16:00:00Z" }),
    post("one-ms-overlap", { startsAt: "2026-10-02T14:00:00Z", endsAt: "2026-10-02T15:00:00.001Z" }),
  ];
  assert.deepEqual(ids(listProjectedPublicPosts(rows, { ...member, period })), ["one-ms-overlap", "starts-at-start"]);
});

test("시간대 누락·존재하지 않는 날짜·역전 기간과 알 수 없는 필터를 거절한다", () => {
  for (const input of [
    { ...member, availability: "closed" }, { ...member, availability: null },
    { ...member, cost: "paid_offer" }, { ...member, query: null },
    { ...member, sort: "distance" }, { ...member, sort: null },
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

test("비로그인 기간·상세 숫자 나이는 저장소 요청 전에 거절하고 전체만 허용한다", async () => {
  const received = [];
  const repository = { async search(input) { received.push(input); return []; } };
  for (const input of [{ caller: "anonymous", period }, { caller: "anonymous", authorAge: { min: 19, max: 99 } }]) {
    await assert.rejects(searchPublicPosts(repository, input), /AUTH_REQUIRED/);
  }
  assert.equal(received.length, 0);
  assert.deepEqual(await searchPublicPosts(repository, { caller: "anonymous" }), { status: "no_results", posts: [] });
  assert.equal(received[0].authorAge, "all");
  assert.equal(received[0].limit, 10);
});

test("메모리 나이 범위는 내부 근거가 없으면 조용히 무시하지 않는다", async () => {
  const repository = createInMemoryPublicPostSearchRepository([candidate(base)]);
  await assert.rejects(searchPublicPosts(repository, { ...member, authorAge: { min: 19, max: 99 } }), /INVALID_SEARCH_SOURCE/);
});

test("두 정렬 모두 마이크로초 차이를 ID보다 먼저 비교하고 동률 ID와 원문 시각을 보존한다", () => {
  const rows = [
    post("a-later", { startsAt: "2026-10-03T00:00:00.000002Z", endsAt: "2026-10-03T01:00:00Z", createdAt: "2026-10-01T00:00:00.000001Z" }),
    post("z-earlier", { startsAt: "2026-10-03T00:00:00.000001Z", endsAt: "2026-10-03T01:00:00Z", createdAt: "2026-10-01T00:00:00.000002Z", state: "closed" }),
    post("b-tied", { startsAt: "2026-10-03T09:00:00.000001+09:00", endsAt: "2026-10-03T01:00:00Z", createdAt: "2026-10-01T09:00:00.000002+09:00", state: "confirmed" }),
  ];
  for (const sort of ["created_desc", "starts_asc"]) {
    const result = listProjectedPublicPosts(rows, { ...member, sort });
    assert.deepEqual(ids(result), ["b-tied", "z-earlier", "a-later"]);
    assert.equal(result.posts[0].startsAt, "2026-10-03T09:00:00.000001+09:00");
    assert.equal(result.posts[1].startsAt, "2026-10-03T00:00:00.000001Z");
  }
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
