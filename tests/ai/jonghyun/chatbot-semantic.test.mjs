import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runChat } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/orchestrator.ts";
import { createPostDiscovery } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/discovery.ts";
import { validateFilters } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/intent.ts";
import { evaluatePreferenceCondition, parsePreferenceJudgments } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/preference-match.ts";
import { loadAiChatSettings, AI_CHAT_ENV } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/settings.ts";
import { ModelError } from "../../../backend/supabase/functions/_shared/ai/providers/provider-errors.ts";

// 전부 합성 사례·가상 모델(실제 모델 호출 없음). 아래 한도 숫자는 테스트 전용 합성값이며 운영값이 아니다.
const chatLimits = { maxMessages: 6, maxMessageChars: 400, maxTotalChars: 1000, maxOutputTokens: 200 };
const baseLimits = { pageSize: 2, maxSearchPages: 5, recheckMaxPages: 5, maxResultCards: 10, matchBatchSize: 2, maxMatchCalls: 10, matchMaxOutputTokens: 100 };
const principal = { userId: "synthetic-member" };
const input = { clientRequestId: "c1", messages: [{ role: "user", content: "가상 요청" }], currentFilters: { target:"posts",region:"서울특별시" } };
const now = new Date("2026-10-02T20:00:00+09:00");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** 가상 의미 사전: 요청 표현 → 비슷하다고 보는 등록값. 관련 있지만 다른 값(음악·영화 등)은 넣지 않는다. */
const SIMILAR = {
  "미술": ["현대미술", "그림", "미술관"],
  "등산": ["등산", "트레킹"],
  "조용한 대화": ["차분한 대화", "조용한 대화"],
  "시끄러운 대화": ["활발한 수다", "시끄러운 대화"],
  "사진": ["사진", "필름카메라"],
};
function semanticJudge(inputValue) {
  return { judgments: inputValue.candidates.map((c) => {
    const row = { ref: c.ref };
    for (const field of ["interests", "conversationStyles"]) {
      if (!c[field]) continue;
      row[field] = inputValue.requested[field].map((text) => c[field].some((v) => (SIMILAR[text] ?? [text]).includes(v)) ? "similar" : "different");
    }
    return row;
  }) };
}
function fakeModel(intentFilters, overrides = {}) {
  const calls = [];
  return { calls, async generate(req) {
    calls.push(req);
    if (req.task === "intent") return { value: overrides.intent ?? { status: "search", filters: intentFilters }, modelVersion: "synthetic", usage: null };
    if (req.task === "preference_match") {
      if (overrides.judge) return { value: overrides.judge(req.input, calls), modelVersion: "synthetic", usage: null };
      return { value: semanticJudge(req.input), modelVersion: "synthetic", usage: null };
    }
    throw new Error("unexpected task");
  } };
}

/** search_public_posts_v2·get_post_author_traits wire를 흉내 내는 가상 회원 RpcClient. */
function fakeDb(posts) {
  const calls = [];
  const version = (t) => createHash("md5").update(JSON.stringify([t?.interests ?? [], t?.conversationStyles ?? [], t?.mbti ?? null])).digest("hex");
  const db = { calls, posts, async rpc(name, args) {
    calls.push({ name, args: structuredClone(args) });
    const visible = posts.filter((p) => !p.deleted);
    if (name === "search_public_posts_v2") {
      const f = args.p_filters;
      let rows = visible.filter((p) => f.availability === "all" || p.state === "recruiting");
      const key = (p) => (f.sort === "starts_asc" ? p.startsAt : p.createdAt);
      rows.sort((a, b) => f.sort === "starts_asc" ? (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : 1)
        : (key(a) > key(b) ? -1 : key(a) < key(b) ? 1 : a.id < b.id ? -1 : 1));
      if (args.p_cursor) {
        const at = args.p_cursor.sortAt, id = args.p_cursor.id;
        rows = rows.filter((p) => f.sort === "starts_asc" ? (key(p) > at || (key(p) === at && p.id > id)) : (key(p) < at || (key(p) === at && p.id > id)));
      }
      const page = rows.slice(0, args.p_limit);
      const more = rows.length > args.p_limit;
      return { items: page.map((p) => ({ id: p.id, title: p.title, authorDisplayName: "김*현", publicArea: "서울특별시 종로구 종로1가",
        startsAt: p.startsAt, endsAt: p.endsAt, cost: { kind: "free" }, state: p.state, canApply: p.state === "recruiting" })),
        nextCursor: more ? { sortAt: key(page.at(-1)), id: page.at(-1).id } : null };
    }
    if (name === "get_post_author_traits") {
      return { items: args.p_post_ids.flatMap((id) => {
        const p = visible.find((x) => x.id === id);
        if (!p) return [];
        const t = p.traits ?? {};
        return [{ postId: p.id, interests: t.interests ?? [], conversationStyles: t.conversationStyles ?? [], mbti: t.mbti ?? null, traitsVersion: version(t) }];
      }) };
    }
    throw new Error("unexpected rpc");
  } };
  return db;
}
function post(n, traits, extra = {}) {
  const created = new Date(Date.UTC(2026, 8, 30, 0, 0, 0) - n * 60000).toISOString().replace(".000Z", ".000000Z");
  const starts = new Date(Date.UTC(2026, 9, 10, 0, 0, 0) + ((n * 7) % 13) * 3600000).toISOString().replace(".000Z", ".000000Z");
  const ends = new Date(Date.parse(starts) + 7200000).toISOString().replace(".000Z", ".000000Z");
  return { id: uuid(n), title: `가상 공고 ${n}`, createdAt: created, startsAt: starts, endsAt: ends, state: "recruiting", traits, ...extra };
}
async function run(posts, filters, { limits = {}, model: overrides = {}, events } = {}) {
  const db = fakeDb(posts);
  const model = fakeModel(filters, overrides);
  const discovery = createPostDiscovery({ db, model, limits: { ...baseLimits, ...limits } });
  const result = await runChat(input, principal, { model, discovery, ...(events ? { events } : {}), limits: chatLimits, now: () => now }, "req-1");
  return { result, db, model };
}
const include = (...texts) => texts.map((text) => ({ text, polarity: "include" }));

test("동의어·부분 관계는 일치, 관련 있지만 다른 값은 제외", async () => {
  const posts = [post(1, { interests: ["현대미술"] }), post(2, { interests: ["음악"] }), post(3, { interests: ["그림", "요리"] })];
  const { result } = await run(posts, { target:"posts",region:"서울특별시", interests: { values: include("미술") } });
  assert.equal(result.status, "results");
  assert.deepEqual(result.cards.map((c) => c.id), [uuid(1), uuid(3)]);
  assert.deepEqual(result.cards.map((c) => c.conditionStatus), [{ interests: "match" }, { interests: "match" }]);
});

test("부정 표현: 원하지 않는 대화 방식과 비슷하면 제외, 아니면 일치, 미입력은 확인 필요", async () => {
  const posts = [post(1, { conversationStyles: ["활발한 수다"] }), post(2, { conversationStyles: ["차분한 대화"] }), post(3, {})];
  const { result, model } = await run(posts, { target:"posts",region:"서울특별시", conversationStyles: { values: [{ text: "시끄러운 대화", polarity: "exclude" }] } });
  assert.deepEqual(result.cards.map((c) => [c.id, c.conditionStatus.conversationStyles]), [[uuid(2), "match"], [uuid(3), "needs_check"]]);
  assert.match(result.notice, /확인이 필요/);
  // 모델에는 부정 여부를 보내지 않고 값만 보낸다. 미입력 후보는 모델에 보내지 않는다.
  const judge = model.calls.filter((c) => c.task === "preference_match");
  assert.equal(JSON.stringify(judge).includes("exclude"), false);
  assert.equal(judge.flatMap((c) => c.input.candidates).length, 2);
});

test("미입력은 제외하지 않고 확인 필요, 불일치는 제외, MBTI는 정확 일치 규칙 유지", async () => {
  const posts = [post(1, { interests: ["사진"], mbti: "ENFP" }), post(2, { mbti: "ENFP" }), post(3, { interests: ["사진"], mbti: "INTJ" }),
    post(4, { interests: ["요리"] }), post(5, {})];
  const { result } = await run(posts, { target:"posts",region:"서울특별시", mbti: "ENFP", interests: { values: include("사진") } });
  assert.deepEqual(result.cards.map((c) => [c.id, c.conditionStatus]), [
    [uuid(1), { mbti: "match", interests: "match" }],
    [uuid(2), { mbti: "match", interests: "needs_check" }],
    [uuid(5), { mbti: "needs_check", interests: "needs_check" }],
  ]);
});

test("여러 원하는 값: any는 하나 이상, all은 모두 일치해야 한다", async () => {
  const posts = [post(1, { interests: ["현대미술", "트레킹"] }), post(2, { interests: ["그림"] }), post(3, { interests: ["요리"] })];
  const any = await run(posts, { target:"posts",region:"서울특별시", interests: { values: include("미술", "등산"), combine: "any" } });
  assert.deepEqual(any.result.cards.map((c) => c.id), [uuid(1), uuid(2)]);
  const all = await run(posts, { target:"posts",region:"서울특별시", interests: { values: include("미술", "등산"), combine: "all" } });
  assert.deepEqual(all.result.cards.map((c) => c.id), [uuid(1)]);
  // 관심사+대화 방식 두 조건은 모두 만족해야 한다(조건 사이 AND).
  const both = await run([post(1, { interests: ["그림"], conversationStyles: ["차분한 대화"] }), post(2, { interests: ["그림"], conversationStyles: ["활발한 수다"] })],
    { target:"posts",region:"서울특별시", interests: { values: include("미술") }, conversationStyles: { values: include("조용한 대화") } });
  assert.deepEqual(both.result.cards.map((c) => c.id), [uuid(1)]);
});

test("AND/OR 미표시·대상 모호는 질문으로 끝나고 검색·성향 조회를 하지 않는다", async () => {
  const posts = [post(1, { interests: ["그림"] })];
  const missingCombine = await run(posts, { target:"posts",region:"서울특별시" }, { model: { intent: { status: "search", filters: { target:"posts",region:"서울특별시", interests: { values: include("미술", "등산") } } } } });
  assert.equal(missingCombine.result.status, "needs_clarification");
  assert.match(missingCombine.result.clarificationQuestion, /하나만|모두/);
  assert.equal(missingCombine.db.calls.length, 0);
  const clarify = await run(posts, { target:"posts",region:"서울특별시" }, { model: { intent: { status: "clarify", filters: { target:"posts",region:"서울특별시" }, question: "관심사 조건인가요, 대화 방식 조건인가요?" } } });
  assert.equal(clarify.result.status, "needs_clarification"); assert.equal(clarify.db.calls.length, 0);
  // include 1개 + exclude는 결합 방식 없이 해석 가능하다.
  assert.doesNotThrow(() => validateFilters({ target:"posts",region:"서울특별시", conversationStyles: { values: [{ text: "조용한 대화", polarity: "include" }, { text: "시끄러운 대화", polarity: "exclude" }] } }));
});

test("판단 결과 형식 위반·모델 오류·결과 없는 예산 소진은 unavailable (미입력·일치·결과 없음으로 숨기지 않음)", async () => {
  const posts = [post(1, { interests: ["그림"] }), post(2, { interests: ["요리"] })];
  const filters = { target:"posts",region:"서울특별시", interests: { values: include("미술") } };
  const variants = {
    missingRef: (i) => ({ judgments: semanticJudge(i).judgments.slice(1) }),
    duplicateRef: (i) => ({ judgments: [...semanticJudge(i).judgments, semanticJudge(i).judgments[0]] }),
    extraKey: (i) => ({ judgments: semanticJudge(i).judgments.map((j) => ({ ...j, score: 0.9 })) }),
    extraTopKey: (i) => ({ ...semanticJudge(i), reasoning: "x" }),
    wrongLength: (i) => ({ judgments: semanticJudge(i).judgments.map((j) => ({ ...j, interests: [...j.interests, "similar"] })) }),
    unknownValue: (i) => ({ judgments: semanticJudge(i).judgments.map((j) => ({ ...j, interests: ["maybe"] })) }),
    unrequestedField: (i) => ({ judgments: semanticJudge(i).judgments.map((j) => ({ ...j, conversationStyles: ["similar"] })) }),
    unknownRef: (i) => ({ judgments: semanticJudge(i).judgments.map((j, k) => ({ ...j, ref: k ? "c9" : j.ref })) }),
    notObject: () => "similar",
  };
  for (const [name, judge] of Object.entries(variants)) {
    const { result } = await run(posts, filters, { model: { judge } });
    assert.equal(result.status, "unavailable", name);
    assert.deepEqual(result.cards, [], name);
    assert.deepEqual(result.interpretedFilters, filters, name);
  }
  for (const code of ["BUDGET_EXHAUSTED", "TIMEOUT", "MODEL_UNAVAILABLE"]) {
    const { result } = await run(posts, filters, { model: { judge: () => { throw new ModelError(code); } } });
    assert.equal(result.status, "unavailable", code); assert.equal(JSON.stringify(result).includes(code), false);
  }
});

test("판단 중 예산 소진은 확정한 카드만 재확인 후 partial로 반환하고 순서·미입력 상태를 보존한다", async () => {
  const posts = [post(1, {}), post(2, { interests: ["그림"] }), post(3, { interests: ["그림"] })];
  let judgments = 0;
  const { result, db } = await run(posts, { target:"posts",region:"서울특별시", interests: { values: include("미술") } }, {
    limits: { matchBatchSize: 1 }, model: { judge: (i) => {
      if (++judgments === 2) throw new ModelError("BUDGET_EXHAUSTED");
      return semanticJudge(i);
    } },
  });
  assert.equal(result.status, "results"); assert.equal(result.partial, true);
  assert.deepEqual(result.cards.map((c) => [c.id, c.conditionStatus.interests]), [[uuid(1), "needs_check"], [uuid(2), "match"]]);
  assert.match(result.notice, /일부만 확인/); assert.match(result.notice, /확인이 필요/);
  const traitQueries = db.calls.filter((c) => c.name === "get_post_author_traits");
  assert.deepEqual(traitQueries.at(-1).args.p_post_ids, [uuid(1), uuid(2)]);
  assert.equal(JSON.stringify(result).includes("BUDGET_EXHAUSTED"), false);
});

test("예산 소진 전 찾은 카드도 응답 직전 사라지면 반환하지 않는다", async () => {
  const posts = [post(1, { interests: ["그림"] }), post(2, { interests: ["그림"] })];
  let judgments = 0;
  const { result, db } = await run(posts, { target:"posts",region:"서울특별시", interests: { values: include("미술") } }, {
    limits: { matchBatchSize: 1 }, model: { judge: (i) => {
      if (++judgments === 2) { posts[0].deleted = true; throw new ModelError("BUDGET_EXHAUSTED"); }
      return semanticJudge(i);
    } },
  });
  assert.equal(result.status, "unavailable"); assert.deepEqual(result.cards, []);
  assert.equal(result.partial, undefined);
  assert.equal(db.calls.filter((c) => c.name === "search_public_posts_v2").length, 2);
});

test("카드를 찾은 뒤 일반 오류·취소·위조된 예산 코드는 partial 성공으로 바꾸지 않는다", async () => {
  const filters = { target:"posts",region:"서울특별시", interests: { values: include("미술") } };
  for (const error of [new ModelError("TIMEOUT"), new ModelError("CANCELLED"), new Error("BUDGET_EXHAUSTED"),
    Object.assign(new Error("private provider detail"), { code: "BUDGET_EXHAUSTED" })]) {
    let judgments = 0;
    const { result } = await run([post(1, { interests: ["그림"] }), post(2, { interests: ["그림"] })], filters, {
      limits: { matchBatchSize: 1 }, model: { judge: (i) => {
        if (++judgments === 2) throw error;
        return semanticJudge(i);
      } },
    });
    assert.equal(result.status, "unavailable"); assert.deepEqual(result.cards, []);
    assert.equal(result.partial, undefined);
    assert.equal(JSON.stringify(result).includes("private provider detail"), false);
  }
  const controller = new AbortController();
  const db = fakeDb([post(1, { interests: ["그림"] }), post(2, { interests: ["그림"] })]);
  let judgments = 0;
  const model = fakeModel(filters, { judge: (i) => {
    if (++judgments === 2) { controller.abort(); throw new ModelError("BUDGET_EXHAUSTED"); }
    return semanticJudge(i);
  } });
  const discovery = createPostDiscovery({ db, model, limits: { ...baseLimits, matchBatchSize: 1 } });
  const result = await runChat(input, principal, { model, discovery, limits: chatLimits, now: () => now }, "cancel-budget", controller.signal);
  assert.equal(result.status, "unavailable"); assert.deepEqual(result.cards, []);
  assert.equal(result.partial, undefined);
  assert.equal(db.calls.filter((c) => c.name === "search_public_posts_v2").length, 1);
});

test("여러 DB 페이지를 이어 처리하고 순서를 보존하며 분량을 채우면 멈춘다", async () => {
  const posts = [1, 2, 3, 4, 5, 6, 7].map((n) => post(n, { interests: [n % 2 ? "그림" : "요리"] }));
  const { result, db, model } = await run(posts, { target:"posts",region:"서울특별시", interests: { values: include("미술") } }, { limits: { maxResultCards: 3 } });
  assert.equal(result.status, "results");
  assert.deepEqual(result.cards.map((c) => c.id), [uuid(1), uuid(3), uuid(5)]);
  const searches = db.calls.filter((c) => c.name === "search_public_posts_v2");
  assert.equal(searches[0].args.p_cursor, null); assert.ok(searches[1].args.p_cursor);
  // 묶음 크기(합성 2)를 넘는 후보를 한 번에 보내지 않는다.
  assert.ok(model.calls.filter((c) => c.task === "preference_match").every((c) => c.input.candidates.length <= 2));
});

test("정렬: 의미 판단이 DB 정렬(등록일 최신순 기본/시작일 빠른순 선택)을 바꾸지 않는다", async () => {
  const posts = [1, 2, 3, 4, 5].map((n) => post(n, { interests: ["그림"] }));
  const created = await run(posts, { target:"posts",region:"서울특별시", interests: { values: include("미술") } });
  assert.deepEqual(created.result.cards.map((c) => c.id), [1, 2, 3, 4, 5].map(uuid));
  assert.equal(created.db.calls[0].args.p_filters.sort, "created_desc");
  const starts = await run(posts, { target:"posts",region:"서울특별시", sort: "starts_asc", interests: { values: include("미술") } });
  const expected = [...posts].sort((a, b) => a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : a.id < b.id ? -1 : 1).map((p) => p.id);
  assert.deepEqual(starts.result.cards.map((c) => c.id), expected);
  assert.equal(starts.db.calls[0].args.p_filters.sort, "starts_asc");
  // 모델이 판단 배열 순서를 뒤섞어 보내도(ref 기준) 결과 순서는 DB 순서다.
  const shuffled = await run(posts, { target:"posts",region:"서울특별시", interests: { values: include("미술") } }, { model: { judge: (i) => ({ judgments: semanticJudge(i).judgments.reverse() }) } });
  assert.deepEqual(shuffled.result.cards.map((c) => c.id), [1, 2, 3, 4, 5].map(uuid));
});

test("한도에 먼저 닿아 0건이면 no_results가 아니라 unavailable, 끝까지 확인한 0건만 no_results", async () => {
  const posts = [1, 2, 3, 4, 5].map((n) => post(n, { interests: ["요리"] }));
  const filters = { target:"posts",region:"서울특별시", interests: { values: include("미술") } };
  const pageLimited = await run(posts, filters, { limits: { maxSearchPages: 1 } });
  assert.equal(pageLimited.result.status, "unavailable"); assert.deepEqual(pageLimited.result.interpretedFilters, filters);
  const callLimited = await run(posts, filters, { limits: { maxMatchCalls: 1 } });
  assert.equal(callLimited.result.status, "unavailable");
  // 2026-09-30 사용자 결정(Q1-A): 일부를 찾고 한도에 닿으면 찾은 카드를 ‘일부만 확인’ 안내·partial 표시로 보여준다.
  const partial = await run([post(1, { interests: ["그림"] }), ...[2, 3, 4, 5].map((n) => post(n, { interests: ["요리"] }))], filters, { limits: { maxSearchPages: 1 } });
  assert.equal(partial.result.status, "results"); assert.equal(partial.result.partial, true);
  assert.equal(partial.result.cards.length, 1); assert.match(partial.result.notice, /일부만 확인/);
  assert.equal(pageLimited.result.partial, undefined);
  const exhausted = await run(posts, filters);
  assert.equal(exhausted.result.status, "no_results");
});

test("응답 직전 재확인: 성향 버전이 바뀐 카드·사라진 카드는 제외하고 새 ID는 넣지 않는다", async () => {
  const posts = [post(1, { interests: ["그림"] }), post(2, { interests: ["그림"] }), post(3, { interests: ["그림"] })];
  const db = fakeDb(posts);
  const model = fakeModel({ target:"posts",region:"서울특별시", interests: { values: include("미술") } });
  const inner = createPostDiscovery({ db, model, limits: baseLimits });
  const discovery = { search: inner.search, async recheck(q) {
    posts[0].traits = { interests: ["요리"] }; // 판정 후 작성자가 성향 변경
    posts[1].deleted = true;                   // 삭제
    posts.push(post(0, { interests: ["그림"] })); // 새 공고(맨 앞 등록일)
    return inner.recheck(q);
  } };
  const result = await runChat(input, principal, { model, discovery, limits: chatLimits, now: () => now }, "req-2");
  assert.equal(result.status, "results");
  assert.deepEqual(result.cards.map((c) => c.id), [uuid(3)]);
  // 재확인에서 새로 의미 판단을 하지 않는다(옛 판정 재사용은 버전이 같을 때만).
  assert.equal(model.calls.filter((c) => c.task === "preference_match").length, 2);
});

test("분량을 채워 멈춘 뒤 재확인에서 모두 사라지면 결과 없음으로 단정하지 않는다", async () => {
  const posts = [1, 2, 3].map((n) => post(n, { interests: ["그림"] }));
  const db = fakeDb(posts);
  const model = fakeModel({ target:"posts",region:"서울특별시", interests: { values: include("미술") } });
  const inner = createPostDiscovery({ db, model, limits: { ...baseLimits, maxResultCards: 1 } });
  const discovery = { search: inner.search, async recheck(q) { posts[0].deleted = true; return inner.recheck(q); } };
  const result = await runChat(input, principal, { model, discovery, limits: chatLimits, now: () => now }, "req-3");
  assert.equal(result.status, "unavailable"); assert.match(result.notice, /변경/);
});

test("재확인 페이지 한도 안에 확인한 카드만 partial로 제공한다", async () => {
  const posts = [1, 2, 3, 4, 5].map((n) => post(n, {}));
  const db = fakeDb(posts);
  const model = fakeModel({ target:"posts",region:"서울특별시" });
  const inner = createPostDiscovery({ db, model, limits: { ...baseLimits, recheckMaxPages: 1 } });
  const result = await runChat(input, principal, { model, discovery: inner, limits: chatLimits, now: () => now }, "req-4");
  assert.equal(result.status, "results");
  assert.equal(result.partial, true);
  assert.deepEqual(result.cards.map(card => card.id), [uuid(1), uuid(2)]);
});

test("응답·모델 입력에 원본 성향·유사도·성향 버전·이름·ID·제목이 없다", async () => {
  const posts = [post(1, { interests: ["현대미술", "PRIVATE_TRAIT_EXTRA"], conversationStyles: ["차분한 대화"], mbti: "ENFP" }), post(2, { interests: ["음악"] })];
  const filters = { target:"posts",region:"서울특별시", interests: { values: include("미술") }, conversationStyles: { values: include("조용한 대화") } };
  const { result, model } = await run(posts, filters);
  const out = JSON.stringify(result);
  for (const marker of ["현대미술", "PRIVATE_TRAIT_EXTRA", "차분한 대화", "similar", "different", "traitsVersion", "김*현", "score"]) {
    assert.equal(out.includes(marker), false, marker);
  }
  assert.deepEqual(Object.keys(result.cards[0]).sort(), ["canApply", "conditionStatus", "costLabel", "endsAtOrDate", "id", "kind", "locationLabel", "startsAtOrDate", "state", "title"]);
  const judgeInputs = JSON.stringify(model.calls.filter((c) => c.task === "preference_match").map((c) => c.input));
  for (const marker of [uuid(1), uuid(2), "가상 공고", "김*현", "종로", "synthetic-member", "ENFP"]) assert.equal(judgeInputs.includes(marker), false, marker);
  assert.match(judgeInputs, /"ref":"c1"/);
});

test("검색 v2에 정렬·작성자 나이·모집 중 조건을 전달하고 성향 조건이 없으면 성향 조회·판단을 하지 않는다", async () => {
  const posts = [post(1, {}), post(2, {}, { state: "closed" })];
  const { result, db, model } = await run(posts, { target:"posts",region:"서울특별시", authorAge: { min: 30, max: 39 }, availability: "recruiting", sort: "starts_asc", query: "전시" });
  assert.deepEqual(result.cards.map((c) => c.id), [uuid(1)]);
  assert.deepEqual(db.calls[0].args.p_filters, { query: "전시", category: null, cost: "all", availability: "recruiting", sort: "starts_asc", periodStart: null, periodEnd: null, authorAge: { min: 30, max: 39 } });
  assert.equal(db.calls[0].args.p_region, "서울특별시");
  assert.equal(db.calls[0].args.p_contract_version, "2026-10-05");
  assert.equal(db.calls.some((c) => c.name === "get_post_author_traits"), false);
  assert.equal(model.calls.some((c) => c.task === "preference_match"), false);
  assert.equal(result.cards[0].conditionStatus, undefined);
});

test("필터 검증: 결합 방식 누락·기술 상한 초과·행사 대상의 성향 조건 거절, 부정 값 보존", () => {
  assert.throws(() => validateFilters({ target:"posts",region:"서울특별시", interests: { values: include("미술", "등산") } }), /PREFERENCE_COMBINE_REQUIRED/);
  assert.throws(() => validateFilters({ target:"posts",region:"서울특별시", interests: { values: include("가".repeat(41)) } }), /INVALID_FILTER/);
  assert.throws(() => validateFilters({ target:"posts",region:"서울특별시", interests: { values: include(...Array.from({ length: 11 }, (_, i) => `값${i}`)), combine: "any" } }), /INVALID_FILTER/);
  assert.throws(() => validateFilters({ target:"posts",region:"서울특별시", interests: { values: [] } }), /INVALID_FILTER/);
  assert.throws(() => validateFilters({ target:"posts",region:"서울특별시", interests: { values: [{ text: "미술", polarity: "maybe" }] } }), /INVALID_FILTER/);
  assert.throws(() => validateFilters({ target: "events", interests: { values: include("미술") } }), /UNSUPPORTED_FILTER/);
  assert.throws(() => validateFilters({ target: "events", sort: "starts_asc" }), /UNSUPPORTED_FILTER/);
  assert.throws(() => validateFilters({ target:"posts",region:"서울특별시", sort: "similarity" }), /INVALID_FILTER/);
  assert.deepEqual(validateFilters({ target:"posts",region:"서울특별시", conversationStyles: { values: [{ text: "  시끄러운   대화 ", polarity: "exclude" }] } }).conversationStyles,
    { values: [{ text: "시끄러운 대화", polarity: "exclude" }] });
  assert.equal(evaluatePreferenceCondition({ values: [{ text: "a", polarity: "include" }, { text: "b", polarity: "exclude" }] }, ["similar", "similar"]), false);
  assert.equal(evaluatePreferenceCondition({ values: [{ text: "a", polarity: "include" }, { text: "b", polarity: "exclude" }] }, ["similar", "different"]), true);
  assert.throws(() => parsePreferenceJudgments({ judgments: [] }, { requested: { interests: ["a"] }, candidates: [{ ref: "c1", interests: ["x"] }] }));
});

test("운영 한도는 명시 설정만 사용하고 누락·잘못된 값은 오류(기본값 없음)", () => {
  const synthetic = Object.fromEntries(Object.values(AI_CHAT_ENV).map((k) => [k, "3"]));
  assert.equal(loadAiChatSettings((k) => synthetic[k]).discovery.pageSize, 3);
  for (const key of Object.values(AI_CHAT_ENV)) {
    assert.throws(() => loadAiChatSettings((k) => (k === key ? undefined : synthetic[k])), /SETTING_NOT_CONFIGURED/, key);
  }
  assert.throws(() => loadAiChatSettings((k) => (k === AI_CHAT_ENV.pageSize ? "51" : synthetic[k])), /SETTING_NOT_CONFIGURED/);
  assert.throws(() => createPostDiscovery({ db: fakeDb([]), model: fakeModel({}), limits: { ...baseLimits, maxMatchCalls: 0 } }), /DISCOVERY_LIMITS_NOT_CONFIGURED/);
});

test("취소된 요청은 다음 페이지·판단을 진행하지 않는다", async () => {
  const posts = [1, 2, 3, 4].map((n) => post(n, { interests: ["요리"] }));
  const db = fakeDb(posts);
  const controller = new AbortController();
  const model = fakeModel({ target:"posts",region:"서울특별시", interests: { values: include("미술") } }, { judge: (i) => { controller.abort(); return semanticJudge(i); } });
  const discovery = createPostDiscovery({ db, model, limits: baseLimits });
  const result = await runChat(input, principal, { model, discovery, limits: chatLimits, now: () => now }, "req-5", controller.signal);
  assert.equal(result.status, "unavailable");
  assert.equal(db.calls.filter((c) => c.name === "search_public_posts_v2").length, 1);
});

// 총괄 보완(2026-09-29): 공고 분류는 검색 v2 고정 목록만 허용한다.
import { validateFilters as validateCategoryFilters } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/intent.ts";
test("공고 분류는 검색 v2 고정 목록만 허용하고 목록 밖 값(예: exhibition)은 입력 오류", () => {
  assert.equal(validateCategoryFilters({ target:"posts",region:"서울특별시", category: "전시" }).category, "전시");
  assert.throws(() => validateCategoryFilters({ target:"posts",region:"서울특별시", category: "exhibition" }), /INVALID_FILTER/);
});
