// TourAPI 행사 제공처 가상 검사. fetch는 주입한 가상 응답이며 실제 공급사 검증은 인계 문서의 별도 기록을 따른다.
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTourApiResponse,
  createTourApiEventProvider,
  normalizeTourApiFestival,
  TOUR_API_CATEGORY,
} from "../../../backend/supabase/functions/_shared/integrations/events/tourapi.ts";
import { createEventSyncRuntime } from "../../../backend/supabase/functions/event-sync/index.ts";

const KEY = "SYNTHETICKEY+/=";
const item = (id, extra = {}) => ({
  contentid: id,
  title: "가상 축제 " + id,
  eventstartdate: "20261003",
  eventenddate: "20261005",
  addr1: "서울특별시 종로구 가상로 1",
  addr2: "가상 광장",
  tel: "02-000-0000",
  mapx: "126.9",
  mapy: "37.5",
  firstimage: "https://example.invalid/a.jpg",
  ...extra,
});
const ok = (items, total = items.length) =>
  new Response(
    JSON.stringify({
      response: {
        header: { resultCode: "0000", resultMsg: "OK" },
        body: {
          items: items.length ? { item: items } : "",
          numOfRows: 2,
          pageNo: 1,
          totalCount: total,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
function provider(respond, extra = {}) {
  const calls = [];
  const port = createTourApiEventProvider({
    serviceKey: KEY,
    keyFormat: "decoded",
    timeoutMs: 1000,
    rows: 2,
    now: () => new Date("2026-09-30T00:00:00Z"),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    },
    ...extra,
  });
  return { port, calls };
}
const period = { start: "2026-10-01", end: "2026-10-07" };

test("고정 HTTPS 목적지·명시 기간/페이지/rows, decoded 키는 한 번만 인코딩, redirect 금지", async () => {
  const { port, calls } = provider(() => ok([item("1"), item("2")], 5));
  const page = await port.fetchPage({ period, page: 1 });
  const url = new URL(calls[0].url);
  assert.equal(
    url.origin + url.pathname,
    "https://apis.data.go.kr/B551011/KorService2/searchFestival2",
  );
  assert.equal(url.searchParams.get("serviceKey"), KEY);
  assert.match(calls[0].url, /serviceKey=SYNTHETICKEY%2B%2F%3D&/);
  assert.deepEqual([
    url.searchParams.get("eventStartDate"),
    url.searchParams.get("eventEndDate"),
    url.searchParams.get("numOfRows"),
    url.searchParams.get("pageNo"),
  ], ["20261001", "20261007", "2", "1"]);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(page.events.length, 2);
  assert.equal(page.nextCursor, "2");
  const encoded = provider(() => ok([]), {
    serviceKey: "ALREADY%2BENC",
    keyFormat: "encoded",
  });
  await encoded.port.fetchPage({ period, page: 1 });
  assert.match(
    encoded.calls[0].url,
    /serviceKey=ALREADY%2BENC&/,
    "encoded는 이중 인코딩하지 않음",
  );
});

test("정규화: 날짜 정밀도, 공식 주소·시도 지역, 입장료 미상, 링크 없음, 전화·좌표·이미지 미저장", () => {
  const e = normalizeTourApiFestival(item("123"), {
    provider: "tour-api",
    collectedAt: "2026-09-30T00:00:00.000Z",
  });
  assert.deepEqual([
    e.sourceId,
    e.precision,
    e.startsOn,
    e.endsOn,
    e.region,
    e.placeName,
    e.publicAddress,
    e.category,
    e.admission.kind,
    e.sourceUrl,
  ], [
    "123",
    "date",
    "2026-10-03",
    "2026-10-05",
    "서울특별시",
    "가상 광장",
    "서울특별시 종로구 가상로 1",
    TOUR_API_CATEGORY,
    "unknown",
    null,
  ]);
  assert.doesNotMatch(JSON.stringify(e), /02-000|126\.9|example\.invalid/);
  assert.throws(() =>
    normalizeTourApiFestival(item("1", { eventstartdate: "20260230" }), {
      provider: "tour-api",
      collectedAt: "2026-09-30T00:00:00.000Z",
    })
  );
});

test("200 안의 공급사 오류·XML 공통 오류·0건·형식 오류를 구분하고 0건 성공으로 숨기지 않음", () => {
  assert.deepEqual(
    classifyTourApiResponse(
      JSON.stringify({
        response: {
          header: { resultCode: "0000" },
          body: { items: "", totalCount: 0 },
        },
      }),
      2,
      1,
    ),
    { items: [], hasMore: false },
  );
  assert.throws(
    () =>
      classifyTourApiResponse(
        JSON.stringify({
          response: { header: { resultCode: "10" }, body: {} },
        }),
        2,
        1,
      ),
    /SOURCE_REJECTED/,
  );
  assert.throws(
    () =>
      classifyTourApiResponse(
        "<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>",
        2,
        1,
      ),
    /SOURCE_AUTH_REJECTED/,
  );
  assert.throws(
    () =>
      classifyTourApiResponse(
        "<x><returnReasonCode>22</returnReasonCode></x>",
        2,
        1,
      ),
    /SOURCE_RATE_LIMITED/,
  );
  assert.throws(
    () => classifyTourApiResponse("not json", 2, 1),
    /SOURCE_INVALID_RESPONSE/,
  );
  const dup = JSON.stringify({
    response: {
      header: { resultCode: "0000" },
      body: { items: { item: [item("1"), item("1")] }, totalCount: 2 },
    },
  });
  assert.throws(
    () => classifyTourApiResponse(dup, 2, 1),
    /SOURCE_INVALID_RESPONSE/,
  );
});

test("totalCount는 실제 정수 또는 정수 문자열이어야 하며 null·누락 등을 정상 0건으로 바꾸지 않음", () => {
  const response = (body) =>
    JSON.stringify({ response: { header: { resultCode: "0000" }, body } });
  for (
    const totalCount of [
      undefined,
      null,
      false,
      true,
      "",
      " ",
      [],
      {},
      -1,
      0.5,
      "1e2",
      "0.5",
      Number.MAX_SAFE_INTEGER + 1,
    ]
  ) {
    assert.throws(
      () => classifyTourApiResponse(response({ totalCount, items: "" }), 2, 1),
      /SOURCE_INVALID_RESPONSE/,
      `잘못된 전체 건수: ${JSON.stringify(totalCount)}`,
    );
  }
  for (const totalCount of [0, "0"]) {
    assert.deepEqual(
      classifyTourApiResponse(response({ totalCount, items: "" }), 2, 1),
      { items: [], hasMore: false },
    );
    assert.deepEqual(
      classifyTourApiResponse(
        response({ totalCount, items: { item: [] } }),
        2,
        1,
      ),
      { items: [], hasMore: false },
    );
  }
  assert.equal(
    classifyTourApiResponse(
      response({ totalCount: "5", items: { item: [item("1"), item("2")] } }),
      2,
      1,
    ).hasMore,
    true,
  );
});

test("items 구조 누락·손상·건수 모순을 거절하고 마지막 단일 항목과 범위 밖 빈 페이지는 유지", () => {
  const response = (totalCount, items) =>
    JSON.stringify({
      response: { header: { resultCode: "0000" }, body: { totalCount, items } },
    });
  for (
    const items of [undefined, null, false, 123, [], {}, { item: null }, {
      item: "",
    }, { item: [[]] }]
  ) {
    for (const total of [0, 5]) {
      assert.throws(
        () => classifyTourApiResponse(response(total, items), 2, 1),
        /SOURCE_INVALID_RESPONSE/,
      );
    }
  }
  for (const empty of ["", { item: [] }]) {
    assert.throws(
      () => classifyTourApiResponse(response(5, empty), 2, 1),
      /SOURCE_INVALID_RESPONSE/,
    );
    assert.deepEqual(classifyTourApiResponse(response(5, empty), 2, 4), {
      items: [],
      hasMore: false,
    });
  }
  assert.throws(
    () => classifyTourApiResponse(response(0, { item: item("1") }), 2, 1),
    /SOURCE_INVALID_RESPONSE/,
  );
  assert.throws(
    () =>
      classifyTourApiResponse(
        response(1, { item: [item("1"), item("2")] }),
        2,
        1,
      ),
    /SOURCE_INVALID_RESPONSE/,
  );
  const last = classifyTourApiResponse(response(5, { item: item("5") }), 2, 3);
  assert.equal(last.items.length, 1);
  assert.equal(last.items[0].contentid, "5");
  assert.equal(last.hasMore, false);
});

test("키 형식 unknown·31일 초과 기간은 요청하지 않음, 오류에 키를 넣지 않음", async () => {
  assert.throws(
    () => provider(() => ok([]), { keyFormat: "unknown" }),
    /EVENT_PROVIDER_UNCONFIGURED/,
  );
  const { port, calls } = provider(() => ok([]));
  await assert.rejects(
    port.fetchPage({
      period: { start: "2026-10-01", end: "2026-11-15" },
      page: 1,
    }),
    /INVALID_EVENT_REQUEST/,
  );
  assert.equal(calls.length, 0);
  const failing = provider(() => {
    throw new TypeError("network " + KEY);
  });
  await assert.rejects(
    failing.port.fetchPage({ period, page: 1 }),
    (e) => e.message === "SOURCE_UNAVAILABLE" && !String(e.stack).includes(KEY),
  );
});

test("event-sync 등록부: tour-api를 허용 제공처로 쓸 수 있고 키 형식 unknown이면 인증 뒤 503", async () => {
  const SECRET = "t".repeat(40);
  const env = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: "a",
    SUPABASE_SERVICE_ROLE_KEY: "s",
    INTERNAL_WORKER_SECRET: SECRET,
    UPSTREAM_TIMEOUT_MS: "1000",
    MAX_REQUEST_BYTES: "4096",
    ALLOWED_ORIGINS: "[]",
    TOUR_API_SERVICE_KEY: KEY,
    TOUR_API_KEY_FORMAT: "decoded",
    EVENT_SYNC_PROVIDERS: "tour-api",
    EVENT_SYNC_MAX_PERIOD_DAYS: "7",
    EVENT_SYNC_MAX_PAGE: "1",
    EVENT_SYNC_PAGE_ROWS: "2",
  };
  let saves = 0;
  const post = (e, auth = SECRET, respond = () => ok([item("9")])) =>
    createEventSyncRuntime((k) => e[k], async () => respond(), {
      createRpcClient: () => ({
        async rpc(name, args) {
          saves++;
          return {
            receivedCount: args.p_events.length,
            insertedCount: args.p_events.length,
            updatedCount: 0,
            staleCount: 0,
          };
        },
      }),
      now: () => new Date("2026-09-30T00:00:00Z"),
    })(
      new Request("http://localhost/functions/v1/event-sync", {
        method: "POST",
        headers: {
          authorization: "Bearer " + auth,
          "content-type": "application/json",
        },
        body: JSON.stringify({ provider: "tour-api", period, page: 1 }),
      }),
    );
  const res = await post(env);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).data, {
    status: "synced",
    provider: "tour-api",
    fetchedCount: 1,
    savedCount: 1,
    hasMore: false,
  });
  const unknown = { ...env, TOUR_API_KEY_FORMAT: "" };
  assert.equal((await post(unknown, "w".repeat(40))).status, 403);
  assert.equal((await post(unknown)).status, 503);
  const savesBefore = saves;
  for (
    const malformed of [{ totalCount: null }, { totalCount: 5, items: {} }]
  ) {
    const response = await post(env, SECRET, () =>
      Response.json({
        response: { header: { resultCode: "0000" }, body: malformed },
      }));
    assert.equal(
      response.status,
      503,
      "공급사 자료 오류를 synced 0건으로 반환하지 않음",
    );
    assert.equal((await response.json()).error.code, "EXTERNAL_UNAVAILABLE");
  }
  assert.equal(
    saves,
    savesBefore,
    "손상된 응답은 행사 DB 저장을 호출하지 않음",
  );
});

// U9-A 행사 필터 값 목록(제공처 포함) 저장소 검사.
import { listEventFilterValues } from "../../../backend/supabase/functions/_shared/db/repositories/events.ts";
test("필터 값 목록: 제공처와 원문 값을 함께 돌려주고 형식 오류·중복은 거절", async () => {
  const good = {
    regions: [{ provider: "kopis", value: "서울특별시", count: 2 }, {
      provider: "tour-api",
      value: "서울특별시",
      count: 1,
    }],
    categories: [{ provider: "kopis", value: "연극", count: 2 }],
  };
  assert.deepEqual(
    await listEventFilterValues({
      async rpc(name) {
        assert.equal(name, "list_event_filter_values");
        return good;
      },
    }),
    good,
  );
  for (
    const bad of [{ regions: [] }, {
      regions: [{ provider: "kopis", value: "<b>x</b>", count: 1 }],
      categories: [],
    }, {
      regions: [{ provider: "kopis", value: "a", count: 1 }, {
        provider: "kopis",
        value: "a",
        count: 2,
      }],
      categories: [],
    }, {
      regions: [{ provider: "kopis", value: "a", count: -1 }],
      categories: [],
    }]
  ) {
    await assert.rejects(
      listEventFilterValues({
        async rpc() {
          return bad;
        },
      }),
      /INVALID_EVENT_REPOSITORY_RESPONSE/,
    );
  }
});

const commonDetail = (extra = {}) => ({
  contentid: "123",
  contenttypeid: "15",
  title: "합성 행사",
  addr1: "서울특별시 종로구 합성로",
  overview: "공식 합성 소개",
  ...extra,
});
const introDetail = (extra = {}) => ({
  contentid: "123",
  contenttypeid: "15",
  eventstartdate: "20260901",
  eventenddate: "20261006",
  eventplace: "합성 장소",
  playtime: "10시~17시",
  usetimefestival: "무료",
  ...extra,
});
function detailFixture(transform = (op, row) => row) {
  const calls = [];
  return import(
    "../../../backend/supabase/functions/_shared/integrations/events/tourapi.ts"
  ).then(({ createTourApiDetailProvider }) => ({
    calls,
    port: createTourApiDetailProvider({
      serviceKey: KEY,
      keyFormat: "decoded",
      timeoutMs: 1000,
      rows: 1,
      now: () => new Date("2026-10-05T00:00:00Z"),
      fetch: async (url, init) => {
        calls.push({ url, init });
        const op = new URL(url).pathname.split("/").at(-1);
        const row = transform(
          op,
          op === "detailCommon2" ? commonDetail() : introDetail(),
        );
        return ok(row === null ? [] : [row]);
      },
    }),
  }));
}
test("TourAPI 저장ID의 공통·소개 두 응답을 조합하여 실제 종료 변경과 공개 상세만 갱신한다", async () => {
  const { port, calls } = await detailFixture();
  const source = await port.fetchSourceEvent("123");
  assert.equal(source.endsOn, "2026-10-06");
  assert.equal(source.description, "공식 합성 소개");
  assert.equal(source.operatingInfo, "10시~17시");
  assert.equal(source.placeName, "합성 장소");
  assert.equal(
    source.admission.kind,
    "described",
    "가격 문구를 임의로 무료 확정하지 않음",
  );
  assert.equal(Object.hasOwn(source, "posterUrl"), false);
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname.split("/").at(-1)),
    ["detailCommon2", "detailIntro2"],
  );
  for (const { url, init } of calls) {
    assert.equal(new URL(url).origin, "https://apis.data.go.kr");
    assert.equal(new URL(url).searchParams.get("contentId"), "123");
    assert.equal(new URL(url).searchParams.get("serviceKey"), KEY);
    assert.equal(init.redirect, "error");
  }
  assert.equal(new URL(calls[1].url).searchParams.get("contentTypeId"), "15");
  const detail = await port.fetchDetail("123");
  assert.equal(detail.description, source.description);
});
test("TourAPI 0건·다른ID/유형·종료 누락을 삭제나 성공0건으로 추정하지 않는다", async () => {
  for (
    const transform of [
      (op, row) => op === "detailCommon2" ? null : row,
      (op, row) => ({ ...row, contentid: "999" }),
      (op, row) => ({ ...row, contenttypeid: "12" }),
      (op, row) => op === "detailIntro2" ? { ...row, eventenddate: "" } : row,
      (op, row) =>
        op === "detailIntro2" ? { ...row, eventenddate: "20260801" } : row,
    ]
  ) {
    const { port } = await detailFixture(transform);
    await assert.rejects(port.fetchSourceEvent("123"));
  }
  const f = await detailFixture();
  await assert.rejects(f.port.fetchSourceEvent("https://example.invalid"));
  assert.equal(f.calls.length, 0);
});
test("TourAPI 상세 HTML은 공개본문에 넣지 않으며 확인 안 된 원천 정보는 기존값을 지우지 않는다", async () => {
  const { port } = await detailFixture((op, row) =>
    op === "detailCommon2"
      ? {
        ...row,
        overview: "<p>원천HTML</p>",
        firstimage: "http://example.invalid/image.jpg",
        tel: "010-private",
      }
      : { ...row, playtime: "<br>시간", usetimefestival: "" }
  );
  const source = await port.fetchSourceEvent("123");
  assert.equal(Object.hasOwn(source, "description"), false);
  assert.equal(Object.hasOwn(source, "operatingInfo"), false);
  assert.equal(source.admission.kind, "unknown");
  assert.doesNotMatch(
    JSON.stringify(source),
    /원천HTML|example.invalid|010-private|<br>/,
  );
});
test("TourAPI ongoing 기본 runtime은 저장ID를 읽고 갱신 원천과 후속 상세ref를 한 RPC로 커밋한다", async () => {
  const token = "00000000-0000-4000-8000-000000000001",
    period = { start: "2026-10-05", end: "2026-10-05" },
    calls = [],
    urls = [],
    SECRET = "s".repeat(40);
  const env = {
    SUPABASE_URL: "https://synthetic.invalid",
    SUPABASE_ANON_KEY: "a",
    SUPABASE_SERVICE_ROLE_KEY: "SYNTHETIC_SERVER_KEY",
    INTERNAL_WORKER_SECRET: SECRET,
    ALLOWED_ORIGINS: "[]",
    MAX_REQUEST_BYTES: "8192",
    UPSTREAM_TIMEOUT_MS: "1000",
    TOUR_API_SERVICE_KEY: KEY,
    TOUR_API_KEY_FORMAT: "decoded",
    EVENT_SYNC_PROVIDERS: "tour-api",
    EVENT_SYNC_MAX_PERIOD_DAYS: "31",
    EVENT_SYNC_MAX_PAGE: "999",
    EVENT_SYNC_PAGE_ROWS: "100",
  };
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === "read_event_collection_contract") {
        return {
          version: "2026-10-05",
          capabilities: ["collection", "collection_details", "detail_jobs"],
        };
      }
      if (name === "acquire_worker_run") {
        return { token, expiresAt: "2099-01-01T00:00:00Z" };
      }
      if (name === "release_worker_run") return { status: "applied" };
      if (name === "claim_event_collection") {
        return {
          provider: "tour-api",
          lane: "ongoing",
          period,
          jobId: token,
          leaseToken: token,
          nextPage: 1,
          collectedPages: 0,
          cursor: null,
        };
      }
      if (name === "list_ongoing_event_source_ids") {
        assert.equal(args.p_provider, "tour-api");
        return { sourceIds: ["123"], nextCursor: null };
      }
      if (name === "commit_event_collection_page") {
        assert.equal(args.p_events[0].endsOn, "2026-10-06");
        assert.equal(args.p_events[0].description, "공식 합성 소개");
        assert.equal(args.p_detail_references[0].provider, "tour-api");
        assert.equal(args.p_detail_references[0].sourceId, "123");
        return { status: "applied" };
      }
      throw new Error(name);
    },
  };
  const runtime = createEventSyncRuntime((k) => env[k], async (url) => {
    urls.push(url);
    return ok([
      new URL(url).pathname.endsWith("detailCommon2")
        ? commonDetail()
        : introDetail(),
    ]);
  }, {
    createRpcClient: () => db,
    rpcAvailable: () => true,
    now: () => new Date("2026-10-05T00:00:00Z"),
  });
  const response = await runtime(
    new Request("http://localhost/functions/v1/event-sync/collect", {
      method: "POST",
      headers: {
        authorization: "Bearer " + SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "tour-api", lane: "ongoing", period }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, "complete");
  assert.equal(urls.length, 2);
  assert.equal(
    calls.filter((c) => c[0] === "commit_event_collection_page").length,
    1,
  );
  const oversized = createEventSyncRuntime(
    (k) => k === "EVENT_SYNC_PAGE_ROWS" ? "101" : env[k],
    async () => {
      throw new Error("must not call");
    },
    { createRpcClient: () => db, rpcAvailable: () => true },
  );
  const rejected = await oversized(
    new Request("http://localhost/functions/v1/event-sync", {
      method: "POST",
      headers: {
        authorization: "Bearer " + SECRET,
        "content-type": "application/json",
      },
      body: JSON.stringify({ provider: "tour-api", period, page: 1 }),
    }),
  );
  assert.equal(rejected.status, 503);
});

test("TourAPI 새 목록의 후속 상세 lane은 원천 버전·전역/작업점유로 원자저장하고 오래된 버전은 공개하지 않는다", async () => {
  const { createEventOperations } = await import(
    "../../../backend/supabase/functions/_shared/jobs/event-runtime.ts"
  );
  const token = "00000000-0000-4000-8000-000000000001",
    now = new Date("2026-10-05T00:00:00Z"),
    reference = {
      provider: "tour-api",
      lane: "detail",
      sourceId: "123",
      sourceCollectedAt: now.toISOString(),
      period: { start: "2026-10-05", end: "2026-10-05" },
    };
  const f = await detailFixture();
  let stored = 0;
  const db = {
    async rpc(name, args) {
      if (name === "read_event_collection_contract") {
        return {
          version: "2026-10-05",
          capabilities: ["collection", "collection_details", "detail_jobs"],
        };
      }
      if (name === "acquire_worker_run") {
        return { token, expiresAt: "2099-01-01T00:00:00Z" };
      }
      if (name === "release_worker_run") return { status: "applied" };
      if (name === "claim_event_collection") {
        assert.equal(args.p_source_id, "123");
        assert.equal(args.p_source_collected_at, reference.sourceCollectedAt);
        return { ...reference, jobId: token, leaseToken: token };
      }
      if (name === "store_event_source_detail") {
        stored++;
        assert.equal(args.p_worker_run_token, token);
        assert.equal(args.p_lease_token, token);
        assert.equal(args.p_source_collected_at, reference.sourceCollectedAt);
        assert.equal(args.p_detail.description, "공식 합성 소개");
        assert.equal(Object.hasOwn(args.p_detail, "posterUrl"), false);
        return { status: "superseded" };
      }
      throw new Error(name);
    },
  };
  const operations = createEventOperations({
    db,
    providers: new Map(),
    detailProviders: new Map([["tour-api", f.port]]),
    now: () => now,
    maxPages: 5,
    providerMaxPage: 999,
  });
  assert.equal((await operations.collect(reference)).status, "superseded");
  assert.equal(stored, 1);
  assert.equal(f.calls.length, 2);
});
