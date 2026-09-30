/**
 * 실제 로컬 Auth·PostgREST·DB(제안 02 적용) + 가상 모델로 C 방식 공고 탐색 어댑터를 실행한다.
 * - 회원 JWT의 RpcClient는 민규 createRpcTransport에 get_post_author_traits를 넣은 **테스트 전용 허용 목록**이다.
 *   운영 user-client 허용 목록 반영 전까지 실제 ai-chat 런타임은 unavailable이다(우회하지 않음).
 * - 모델 판단은 가상 규칙이며 실제 의미 품질 검증이 아니다. 가상 회원은 로컬 Auth 관리 API로 만들고 finally에서 삭제한다.
 * 환경(로컬 값, 출력 금지): AI_REST_DATABASE_URL, AI_REST_SUPABASE_URL, AI_REST_ANON_KEY, AI_REST_SERVICE_ROLE_KEY
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createRpcTransport } from "../../../backend/supabase/functions/_shared/db/transport.ts";
import { createPostDiscovery } from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/discovery.ts";
const { Client } = createRequire(new URL("../../../backend/package.json", import.meta.url))("pg");
const env = process.env;
for (const key of ["AI_REST_DATABASE_URL", "AI_REST_SUPABASE_URL", "AI_REST_ANON_KEY", "AI_REST_SERVICE_ROLE_KEY"]) {
  if (!env[key]) throw new Error("EXPLICIT_LOCAL_SETTING_REQUIRED");
}
const api = new URL(env.AI_REST_SUPABASE_URL), dbUrl = new URL(env.AI_REST_DATABASE_URL);
if (api.hostname !== "127.0.0.1" || api.port !== "55421" || dbUrl.hostname !== "127.0.0.1" || dbUrl.port !== "55422") throw new Error("DEDICATED_LOCAL_ONLY");
const config = { supabaseUrl: api.origin, supabaseAnonKey: env.AI_REST_ANON_KEY, upstreamTimeoutMs: 5000 };

async function authAdmin(path, init) {
  const response = await fetch(api.origin + path, { ...init, headers: { apikey: env.AI_REST_SERVICE_ROLE_KEY,
    Authorization: "Bearer " + env.AI_REST_SERVICE_ROLE_KEY, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error("LOCAL_AUTH_FAILED_" + response.status);
  return body;
}

test("회원 JWT로 검색 v2 순서 유지·성향 조회·C 판단·미입력 확인 필요·불일치 제외·성향 변경 재확인", { timeout: 60_000 }, async () => {
  const admin = new Client({ connectionString: env.AI_REST_DATABASE_URL, ssl: false, statement_timeout: 10000 });
  await admin.connect();
  const users = [], posts = [];
  try {
    const password = randomBytes(18).toString("hex");
    const make = async () => {
      const email = `synthetic-${randomUUID()}@example.invalid`;
      const user = await authAdmin("/auth/v1/admin/users", { method: "POST", body: JSON.stringify({ email, password, email_confirm: true }) });
      users.push(user.id);
      return { id: user.id, email };
    };
    const viewer = await make(), quiet = await make(), loud = await make(), blank = await make();
    await admin.query(`insert into public.profiles(id,real_name,birth_date) values($1,'가상조회자','1990-01-01'),($2,'가상조용','1991-01-01'),
      ($3,'가상활발','1992-01-01'),($4,'가상미입력','1993-01-01')`, [viewer.id, quiet.id, loud.id, blank.id]);
    // 등록일 순서: blank(가장 최근) → loud → quiet. 기본 정렬은 등록일 최신순이다.
    for (const [author, offset] of [[quiet, 3], [loud, 2], [blank, 1]]) {
      const id = randomUUID(); posts.push(id);
      await admin.query(`insert into public.posts(id,author_id,title,description,category,starts_at,ends_at,recruitment_ends_at,public_area,created_at)
        values($1,$2,'가상 전시 동행','가상 검사','전시',now()+interval '5 days',now()+interval '5 days 2 hours',now()+interval '4 days',
        '서울특별시 강남구 역삼동',now()-make_interval(mins=>$3))`, [id, author.id, offset]);
    }
    await admin.query(`insert into private.profile_traits(profile_id,interests,conversation_styles,mbti) values
      ($1,'{전시}','{차분한 대화}',null),($2,'{전시}','{활발한 수다}',null)`, [quiet.id, loud.id]);
    const session = await fetch(api.origin + "/auth/v1/token?grant_type=password", { method: "POST",
      headers: { apikey: env.AI_REST_ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ email: viewer.email, password }) });
    assert.equal(session.status, 200);
    const jwt = (await session.json()).access_token;
    const db = createRpcTransport(config, env.AI_REST_ANON_KEY, jwt, new Set(["search_public_posts_v2", "get_post_author_traits"]));
    const sent = [];
    // 가상 규칙: 요청 '조용한 대화'와 등록 '차분한 대화'만 similar.
    const model = { async generate(request) {
      sent.push(request.input);
      return { value: { judgments: request.input.candidates.map((c) => ({ ref: c.ref,
        conversationStyles: request.input.requested.conversationStyles.map(() => c.conversationStyles.includes("차분한 대화") ? "similar" : "different") })) },
        modelVersion: "fake", usage: null };
    } };
    // 가상 한도(합성 검사 전용).
    const discovery = createPostDiscovery({ db, model, limits: { pageSize: 1, maxSearchPages: 10, recheckMaxPages: 10, maxResultCards: 10,
      matchBatchSize: 5, maxMatchCalls: 5, matchMaxOutputTokens: 100 } });
    const filters = { target: "posts", query: "가상 전시 동행", conversationStyles: { values: [{ text: "조용한 대화", polarity: "include" }] } };
    const found = await discovery.search({ principal: { userId: viewer.id }, filters, now: new Date() });
    assert.equal(found.coverage, "exhausted");
    // 여러 페이지(pageSize 1)를 거쳐 DB 순서 유지: blank(확인 필요) → quiet(일치). loud(불일치)는 제외.
    assert.deepEqual(found.cards.map((c) => [c.id, c.conditionStatus?.conversationStyles]), [[posts[2], "needs_check"], [posts[0], "match"]]);
    assert.ok(sent.every((input) => !JSON.stringify(input).includes("가상 전시 동행") && !JSON.stringify(input).includes(posts[0])), "모델 입력에 제목·공고 ID 없음");
    // 응답 직전 성향 변경 → 해당 카드 제외.
    await admin.query("update private.profile_traits set conversation_styles='{활발한 수다}' where profile_id=$1", [quiet.id]);
    const rechecked = await discovery.recheck({ principal: { userId: viewer.id }, filters, now: new Date(),
      cards: found.cards.map((c) => ({ kind: c.kind, id: c.id, traitsVersion: c.traitsVersion, ...(c.conditionStatus ? { conditionStatus: c.conditionStatus } : {}) })) });
    assert.equal(rechecked.complete, true);
    assert.deepEqual(rechecked.cards.map((c) => c.id), [posts[2]]);
    // 비로그인 키로는 성향 RPC가 거절된다.
    const anon = createRpcTransport(config, env.AI_REST_ANON_KEY, env.AI_REST_ANON_KEY, new Set(["get_post_author_traits"]));
    await assert.rejects(anon.rpc("get_post_author_traits", { p_post_ids: [posts[0]] }));
  } finally {
    await admin.query("delete from public.posts where id=any($1::uuid[])", [posts]).catch(() => {});
    for (const id of users) await authAdmin("/auth/v1/admin/users/" + id, { method: "DELETE" }).catch(() => {});
    const left = await admin.query("select count(*) n from auth.users where id=any($1::uuid[])", [users]);
    await admin.end();
    assert.equal(Number(left.rows[0].n), 0, "synthetic users cleanup");
  }
});
