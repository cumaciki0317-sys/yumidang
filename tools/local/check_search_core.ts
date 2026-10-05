/** 민규담당: 종현 검색 코어와 v2 DB 계약의 오프라인 연결 준비 검사. DB/HTTP 성공을 뜻하지 않는다. */
import process from "node:process";
import { normalizePublicPostListInput } from "../../backend/supabase/functions/_shared/contracts/search.ts";
import type { PublicPostListInput } from "../../backend/supabase/functions/_shared/contracts/search.ts";
import { createRpcPublicPostSearchRepository } from "../../backend/supabase/functions/_shared/db/repositories/search.ts";
import { searchPublicPosts } from "../../backend/supabase/functions/_shared/services/search-service.ts";
import type { JsonValue } from "../../backend/supabase/functions/_shared/contracts/common.ts";
import type { RpcClient } from "../../backend/supabase/functions/_shared/db/transport.ts";

export interface SearchCoreDependencies {
  normalize: typeof normalizePublicPostListInput;
  repository: typeof createRpcPublicPostSearchRepository;
  search: typeof searchPublicPosts;
}
export interface SearchCoreReport {
  status: "READY" | "BLOCKED";
  scope: "offline_core_contract";
  realDatabase: "NOT_RUN";
  deployedHttp: "NOT_RUN";
  probes: { name: string; status: "PASS" | "BLOCKED"; reason?: string }[];
}
const production: SearchCoreDependencies = {
  normalize: normalizePublicPostListInput, repository: createRpcPublicPostSearchRepository, search: searchPublicPosts,
};
const id = "11111111-1111-4111-8111-111111111111";
const sortAt = "2030-01-01T09:00:00.123456Z";
const fixture = {
  id, title: "검색 연결 검사", authorDisplayName: null, publicArea: "서울특별시 종로구 삼청동",
  startsAt: "2030-02-01T09:00:00.123456Z", endsAt: "2030-02-01T10:00:00.123456Z",
  cost: { kind: "free" }, state: "recruiting", canApply: false,
};
type V2Input = PublicPostListInput & { sort?: "created_desc" | "starts_asc" };
class ProbeFailure extends Error {}
function expect(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new ProbeFailure(reason);
}
function object(value: unknown): Record<string, unknown> {
  expect(value !== null && typeof value === "object" && !Array.isArray(value), "INVALID_OBJECT");
  return value as Record<string, unknown>;
}
function reason(error: unknown): string {
  if (error instanceof ProbeFailure) return error.message;
  // 원문 예외·응답·키를 출력하지 않는다. 알려진 계약 코드만 보고한다.
  const known = new Set(["UNSUPPORTED_FILTER", "AUTH_REQUIRED", "INVALID_CURSOR", "INVALID_PUBLIC_PROJECTION", "INVALID_SEARCH_RESPONSE", "INVALID_SEARCH_PAGE"]);
  return error instanceof Error && known.has(error.message) ? error.message : "CORE_PROBE_FAILED";
}
async function mustReject(run: () => unknown | Promise<unknown>, code: string) {
  try { await run(); } catch (error) {
    expect(error instanceof Error && error.message === code, "WRONG_REJECTION_CODE");
    return;
  }
  throw new ProbeFailure("EXPECTED_REJECTION");
}

/** 가상 RPC는 DB wire만 제공한다. 정규화·서비스·repository는 실제 종현 모듈을 실행한다. */
export async function checkSearchCore(dependencies: Partial<SearchCoreDependencies> = {}): Promise<SearchCoreReport> {
  const deps = { ...production, ...dependencies };
  const probes: SearchCoreReport["probes"] = [];
  async function probe(name: string, run: () => unknown | Promise<unknown>) {
    try { await run(); probes.push({ name, status: "PASS" }); }
    catch (error) { probes.push({ name, status: "BLOCKED", reason: reason(error) }); }
  }
  function rpc(reply: JsonValue, inspect?: (args: Record<string, JsonValue>) => void): RpcClient {
    return { async rpc(name, args) {
      expect(name === "search_public_posts_v2", "WRONG_RPC");
      inspect?.(args);
      return reply;
    } };
  }
  await probe("default_created_desc_all", () => {
    const result = object(deps.normalize({ caller: "anonymous" }));
    expect(result.sort === "created_desc" && result.availability === "all" && result.authorAge === "all", "DEFAULT_POLICY_MISMATCH");
  });
  await probe("starts_asc_rpc_filter", async () => {
    const input: V2Input = { caller: "anonymous", sort: "starts_asc" };
    let called = false;
    const repository = deps.repository(rpc({ items: [], nextCursor: null }, (args) => {
      called = true;
      expect(object(args.p_filters).sort === "starts_asc", "SORT_NOT_FORWARDED");
      expect(args.p_cursor === null && args.p_limit === 10, "WRONG_FIRST_PAGE");
    }));
    await deps.search(repository, input);
    expect(called, "RPC_NOT_CALLED");
  });
  await probe("anonymous_period_requires_auth", async () => {
    const period = { startsAt: "2030-02-01T00:00:00Z", endsAt: "2030-02-02T00:00:00Z" };
    await mustReject(() => deps.normalize({ caller: "anonymous", period }), "AUTH_REQUIRED");
  });
  await probe("anonymous_age_requires_auth", async () => {
    await mustReject(() => deps.normalize({ caller: "anonymous", authorAge: { min: 30, max: 39 } }), "AUTH_REQUIRED");
    let called = false;
    const repository = deps.repository(rpc({ items: [], nextCursor: null }, () => { called = true; }));
    await mustReject(() => deps.search(repository, { caller: "anonymous", authorAge: { min: 30, max: 39 } }), "AUTH_REQUIRED");
    expect(!called, "REJECTED_INPUT_REACHED_RPC");
  });
  await probe("dong_public_projection", async () => {
    const page = await deps.search(deps.repository(rpc({ items: [fixture], nextCursor: null })), { caller: "anonymous" });
    expect(page.posts.length === 1 && page.posts[0].publicArea === fixture.publicArea &&
      page.posts[0].authorDisplayName === fixture.authorDisplayName && !page.posts[0].canApply, "PUBLIC_CARD_MISMATCH");
  });
  await probe("microsecond_two_field_cursor_roundtrip", async () => {
    const input: V2Input = { caller: "anonymous" };
    // SQL의 공개 지역 제약에 맞는 동 fixture로 커서 정밀도·필터 결합을 검사한다.
    const cursorFixture = { ...fixture };
    const first = await deps.search(deps.repository(rpc({ items: [cursorFixture], nextCursor: { sortAt, id } })), input);
    expect(typeof first.nextCursor === "string", "CURSOR_MISSING");
    let called = false;
    const second = deps.repository(rpc({ items: [], nextCursor: null }, (args) => {
      called = true;
      const position = object(args.p_cursor);
      expect(Object.keys(position).length === 2 && position.sortAt === sortAt && position.id === id, "CURSOR_PRECISION_OR_SHAPE_MISMATCH");
      expect(object(args.p_filters).sort === "created_desc", "SORT_NOT_FORWARDED");
    }));
    await deps.search(second, { ...input, cursor: first.nextCursor });
    expect(called, "RPC_NOT_CALLED");
    // 기존 커서를 정렬이 다른 목록에 재사용하지 않는다.
    await mustReject(() => deps.search(second, { ...input, sort: "starts_asc", cursor: first.nextCursor } as V2Input), "INVALID_CURSOR");
  });
  await probe("sensitive_wire_field_rejected", async () => {
    await mustReject(() => deps.search(deps.repository(rpc({
      items: [{ ...fixture, exactAddress: "synthetic-private-field" }], nextCursor: null,
    })), { caller: "anonymous" }), "INVALID_SEARCH_RESPONSE");
  });
  return { status: probes.every((p) => p.status === "PASS") ? "READY" : "BLOCKED",
    scope: "offline_core_contract", realDatabase: "NOT_RUN", deployedHttp: "NOT_RUN", probes };
}

export async function runSearchCoreCheck(write: (report: string) => void, dependencies: Partial<SearchCoreDependencies> = {}): Promise<number> {
  const report = await checkSearchCore(dependencies);
  write(JSON.stringify(report, null, 2));
  return report.status === "READY" ? 0 : 1;
}
if (import.meta.main) process.exitCode = await runSearchCoreCheck((report) => console.log(report));
