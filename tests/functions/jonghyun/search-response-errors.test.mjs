// 5.1 검색 오류 분류 회귀. DB 연결은 주입한 가상 RpcClient이며 실제 DB/Edge 검증이 아니다.
import test from "node:test";
import assert from "node:assert/strict";
import { createRpcPublicPostSearchRepository } from "../../../backend/supabase/functions/_shared/db/repositories/search.ts";
import { searchPublicPosts } from "../../../backend/supabase/functions/_shared/services/search-service.ts";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { HttpError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const card = (overrides = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", title: "가상 전시", authorDisplayName: "김*수",
  publicArea: "서울특별시 강남구 역삼동", startsAt: "2026-10-03T01:00:00.000000Z", endsAt: "2026-10-03T03:00:00.000000Z",
  cost: { kind: "free" }, state: "recruiting", canApply: true, ...overrides,
});
function api(rpc) {
  return createServiceApi({
    allowedOrigins: [], maxBodyBytes: 1024,
    authenticateUser: async () => { throw new HttpError("AUTH_REQUIRED"); },
    authenticateInternal: async () => { throw new HttpError("ACCESS_DENIED"); },
    publicSearch: {
      authenticate: async () => ({ db: { rpc }, caller: "anonymous" }),
      execute: (db, input) => searchPublicPosts(createRpcPublicPostSearchRepository(db), input),
    },
  });
}
const get = (query) => new Request("https://project.example.invalid/functions/v1/service-api/posts" + query);

test("잘못된 DB 카드 날짜는 원문 없는 500 INTERNAL_ERROR (사용자 입력 400으로 오분류하지 않음)", async () => {
  for (const bad of [card({ startsAt: "2026-02-30T12:00:00Z" }), card({ publicArea: "서울 어딘가" }), card({ state: "unknown" })]) {
    const repo = createRpcPublicPostSearchRepository({ rpc: async () => ({ items: [bad], nextCursor: null }) });
    await assert.rejects(repo.searchPage({ caller: "anonymous" }), (e) => e.message === "INVALID_SEARCH_RESPONSE");
    const response = await api(async () => ({ items: [bad], nextCursor: null }))(get(""));
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.doesNotMatch(JSON.stringify(body), /2026-02-30|INVALID_SEARCH|어딘가/);
  }
});

test("잘못된 사용자 기간·커서는 DB 호출 전 400 INVALID_REQUEST를 유지", async () => {
  let calls = 0;
  const handler = api(async () => { calls++; return { items: [], nextCursor: null }; });
  for (const query of ["?periodStart=2026-02-30T00:00:00Z&periodEnd=2026-03-02T00:00:00Z",
    "?periodStart=2026-10-02T00:00:00Z&periodEnd=2026-10-01T00:00:00Z", "?cursor=not-a-valid-cursor"]) {
    const response = await handler(get(query));
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }
  assert.equal(calls, 0);
});

test("db.rpc의 공통 인증·권한·가용성 오류는 넓은 catch로 바꾸지 않고 그대로 전달", async () => {
  for (const [code, status] of [["AUTH_REQUIRED", 401], ["ACCESS_DENIED", 403], ["EXTERNAL_UNAVAILABLE", 503]]) {
    const repo = createRpcPublicPostSearchRepository({ rpc: async () => { throw new HttpError(code); } });
    await assert.rejects(repo.searchPage({ caller: "anonymous" }), (e) => e instanceof HttpError);
    const response = await api(async () => { throw new HttpError(code); })(get(""));
    assert.equal(response.status, status);
  }
});

test("정상 DB 카드와 커서는 기존대로 반환하고 순서를 바꾸지 않음", async () => {
  const second = card({ id: "22222222-2222-4222-8222-222222222222" });
  const response = await api(async () => ({ items: [card(), second], nextCursor: null }))(get("?sort=created_desc"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.posts.map((p) => p.id), [card().id, second.id]);
  assert.equal(body.data.status, "results");
});
