import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runChat } from "../../../../../backend/supabase/functions/_shared/ai/Agents/chatbot/orchestrator.ts";
import { createPostDiscovery } from "../../../../../backend/supabase/functions/_shared/ai/Agents/chatbot/discovery.ts";
import { validateFilters } from "../../../../../backend/supabase/functions/_shared/ai/Agents/chatbot/intent.ts";
import { evaluatePreferenceCondition, parsePreferenceJudgments } from "../../../../../backend/supabase/functions/_shared/ai/Agents/chatbot/preference-match.ts";
import { loadAiChatSettings, AI_CHAT_ENV } from "../../../../../backend/supabase/functions/_shared/ai/Agents/chatbot/settings.ts";
import { ModelError } from "../../../../../backend/supabase/functions/_shared/ai/providers/provider-errors.ts";

// 전부 합성 사례·가상 모델(실제 모델 호출 없음). 아래 한도 숫자는 테스트 전용 합성값이며 운영값이 아니다.
const chatLimits = { maxMessages: 6, maxMessageChars: 400, maxTotalChars: 1000, maxOutputTokens: 200 };
const baseLimits = { pageSize: 2, maxSearchPages: 5, recheckMaxPages: 5, maxResultCards: 10, matchBatchSize: 2, maxMatchCalls: 10, matchMaxOutputTokens: 100 };
const principal = { userId: "synthetic-member" };
const input = { clientRequestId: "c1", messages: [{ role: "user", content: "가상 요청" }], currentFilters: { target: "posts" } };
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


const posts=[post(1,{interests:['현대미술']}),post(2,{interests:['그림']})];
let n=0;
const {result}=await run(posts,{target:'posts',interests:{values:include('미술')}},{limits:{matchBatchSize:1},model:{judge(v){if(++n===2)throw new ModelError('BUDGET_EXHAUSTED');return semanticJudge(v)}}});
console.log(JSON.stringify({case:'budget_exhausted_after_one_accepted',judgeCalls:n,status:result.status,cards:result.cards.length,partial:result.partial??false}));
assert.equal(result.status,'results');assert.equal(result.cards.length,1);assert.equal(result.partial,true);
