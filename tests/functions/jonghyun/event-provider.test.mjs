import assert from "node:assert/strict";
import test from "node:test";
import {
  parseFlatDbsXml, classifyKopisListResponse, normalizeKopisListItem, createKopisTransport, createKopisEventProvider,
} from "../../../backend/supabase/functions/_shared/integrations/events/kopis.ts";
import { EventProviderError } from "../../../backend/supabase/functions/_shared/integrations/events/port.ts";

// 외부 호출 없는 가상 KOPIS 응답 검사. 실제 공급사 1회 검증 결과는 lane E 기록 문서에 따로 적는다.
const KEY = "SYNTHETIC-KOPIS-KEY";
const decl = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
const db = (id, extra = {}) => {
  const fields = { mt20id: id, prfnm: `가상 공연 ${id}`, prfpdfrom: "2026.10.05", prfpdto: "2026.10.11", fcltynm: "가상 극장",
    poster: "http://www.kopis.or.kr/upload/pfmPoster/PF_X.gif", area: "서울특별시", genrenm: "연극", openrun: "N",
    prfstate: "공연예정", ...extra };
  return `<db>${Object.entries(fields).map(([k, v]) => v === null ? "" : `<${k}>${v}</${k}>`).join("")}</db>`;
};
const page = (...dbs) => `${decl}<dbs>${dbs.join("")}</dbs>`;
const errorEnvelope = (code) => `${decl}<dbs><db><returncode>${code}</returncode><errmsg>SECRET-ISH MESSAGE</errmsg><responsetime>2026-09-29 22:23:30</responsetime></db></dbs>`;
const xml = (body, status = 200, type = "application/xml") => new Response(body, { status, headers: { "content-type": type } });
const period = { start: "2026-10-05", end: "2026-10-11" };
const codeIs = (code) => (error) => {
  assert.ok(error instanceof EventProviderError, String(error));
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  assert.equal(error.cause, undefined);
  assert.equal(String(error.stack).includes(KEY), false);
  return true;
};
const transport = (fetch, rows = 3) => createKopisTransport({ apiKey: KEY, timeoutMs: 1000, rows, fetch });

test("평면 XML: entity·CDATA 복호화, 공백 정리, 빈 요소, self-closing 루트", () => {
  const records = parseFlatDbsXml(`${decl}\n<dbs>\n  <db>\n    <mt20id>PF1</mt20id>\n    <prfnm> A &amp; B &lt;C&gt; &#39;D&#39; &#x41;&quot;</prfnm>\n    <fcltynm><![CDATA[극장 <1관> & 2관]]></fcltynm>\n    <genrenm/>\n  </db>\n</dbs>\n`);
  assert.deepEqual(records.map((r) => ({ ...r })), [{ mt20id: "PF1", prfnm: "A & B <C> 'D' A\"", fcltynm: "극장 <1관> & 2관", genrenm: "" }]);
  assert.deepEqual(parseFlatDbsXml(`${decl}<dbs/>`), []);
  assert.deepEqual(parseFlatDbsXml(`<dbs></dbs>`), []);
});

test("평면 XML: 예상 밖 구조는 모두 거절한다", () => {
  for (const bad of [
    "", "not xml", `${decl}<dbs><db><mt20id>PF1</mt20id></db>`, `${decl}<dbs><db><mt20id>PF1</mt20</db></dbs>`,
    `${decl}<dbs a="1"></dbs>`, `${decl}<dbs><db><mt20id x="1">PF1</mt20id></db></dbs>`,
    `${decl}<!DOCTYPE dbs [<!ENTITY x "y">]><dbs></dbs>`, `${decl}<dbs><!-- c --></dbs>`,
    `${decl}<dbs><db><a><b>1</b></a></db></dbs>`, `${decl}<dbs><db><a>1</a><a>2</a></db></dbs>`,
    `${decl}<dbs><db><a>&nbsp;</a></db></dbs>`, `${decl}<dbs><db><a>A & B</a></db></dbs>`, `${decl}<dbs><db><a>&#0;</a></db></dbs>`,
    `${decl}<dbs><db><a>&#xD800;</a></db></dbs>`, `${decl}<dbs></dbs>trailing`, `${decl}<dbs><db></db></dbs>`,
    `${decl}<dbs><db/></dbs>`, `${decl}<other></other>`, `${decl}<dbs><item><a>1</a></item></dbs>`,
    `<?xml version="1.0" encoding="EUC-KR"?><dbs></dbs>`, `${decl}<dbs><db><a>x\u0001</a></db></dbs>`,
    `${decl}<dbs><db><a><![CDATA[x</a></db></dbs>`, `${decl}<dbs><?pi x?></dbs>`,
  ]) {
    assert.throws(() => parseFlatDbsXml(bad), codeIs("SOURCE_INVALID_RESPONSE"), bad);
  }
});

test("HTTP 200 안의 공급사 오류 envelope는 실패다(02=키 거절, 그 외=거절)", () => {
  assert.throws(() => classifyKopisListResponse(parseFlatDbsXml(errorEnvelope("02")), 5), codeIs("SOURCE_AUTH_REJECTED"));
  assert.throws(() => classifyKopisListResponse(parseFlatDbsXml(errorEnvelope("99")), 5), codeIs("SOURCE_REJECTED"));
  // 정상 항목과 섞인 오류, 알 수 없는 오류 필드는 형식 오류.
  assert.throws(() => classifyKopisListResponse(parseFlatDbsXml(page(db("PF1"), "<db><returncode>02</returncode></db>")), 5),
    codeIs("SOURCE_INVALID_RESPONSE"));
  assert.throws(() => classifyKopisListResponse(parseFlatDbsXml(`${decl}<dbs><db><returncode>02</returncode><x>1</x></db></dbs>`), 5),
    codeIs("SOURCE_INVALID_RESPONSE"));
});

test("목록 항목: 문서 필드만 허용, 필수값·ID 형식·중복·rows 상한 검사", () => {
  assert.equal(classifyKopisListResponse(parseFlatDbsXml(page(db("PF1"), db("PF2"))), 2).length, 2);
  assert.throws(() => classifyKopisListResponse(parseFlatDbsXml(page(db("PF1"), db("PF2"), db("PF3"))), 2), codeIs("SOURCE_INVALID_RESPONSE"));
  assert.throws(() => classifyKopisListResponse(parseFlatDbsXml(page(db("PF1", { price: "1000" }))), 5), codeIs("SOURCE_INVALID_RESPONSE"));
  assert.throws(() => classifyKopisListResponse(parseFlatDbsXml(page(db("PF1", { prfstate: null }))), 5), codeIs("SOURCE_INVALID_RESPONSE"));
  assert.throws(() => classifyKopisListResponse(parseFlatDbsXml(page(db("X1"))), 5), codeIs("SOURCE_INVALID_RESPONSE"));
  assert.throws(() => classifyKopisListResponse(parseFlatDbsXml(page(db("PF1"), db("PF1"))), 5), codeIs("SOURCE_INVALID_RESPONSE"));
  // 선택 필드가 없어도 필수 필드가 있으면 허용.
  const minimal = classifyKopisListResponse(parseFlatDbsXml(page(db("PF9", { fcltynm: null, poster: null, area: null, genrenm: null, openrun: null }))), 5);
  assert.equal(minimal.length, 1);
});

test("정규화: 날짜 정밀도, 입장료 unknown, 주소·sourceUrl null, 제공처 값 그대로", () => {
  const context = { provider: "kopis", collectedAt: "2026-09-29T00:00:00.000Z" };
  const [item] = classifyKopisListResponse(parseFlatDbsXml(page(db("PF10", { prfnm: "  가상   공연  ", fcltynm: "" }))), 5);
  assert.deepEqual(normalizeKopisListItem(item, context), {
    provider: "kopis", sourceId: "PF10", sourceStatus: "active", precision: "date", startsOn: "2026-10-05", endsOn: "2026-10-11",
    title: "가상 공연", category: "연극", region: "서울특별시", placeName: null, publicAddress: null,
    admission: { kind: "unknown" }, sourceUrl: null, collectedAt: context.collectedAt,
  });
  for (const state of ["공연중", "공연완료"]) {
    assert.equal(normalizeKopisListItem({ ...item, prfstate: state }, context).sourceStatus, "active");
  }
  assert.throws(() => normalizeKopisListItem({ ...item, prfstate: "공연취소" }, context), /UNSUPPORTED_EVENT_SOURCE_STATUS/);
  assert.throws(() => normalizeKopisListItem({ ...item, prfpdfrom: "2026-10-05" }, context), /INVALID_EVENT_DATE/);
  assert.throws(() => normalizeKopisListItem({ ...item, prfpdfrom: "2026.02.30" }, context), /INVALID_EVENT_DATE/);
  assert.throws(() => normalizeKopisListItem({ ...item, prfnm: "   " }, context), /INVALID_EVENT_SOURCE_RECORD/);
});

test("transport: 고정 HTTPS 주소·명시 기간/페이지/rows, redirect 금지, 전체 페이지면 다음 페이지 가능", async () => {
  let calls = 0;
  const t = transport(async (url, init) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, "https://kopis.or.kr/openApi/restful/pblprfr");
    assert.deepEqual(Object.fromEntries(parsed.searchParams), { service: KEY, stdate: "20261005", eddate: "20261011", cpage: "2", rows: "3" });
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.ok(init.signal instanceof AbortSignal);
    return xml(page(db("PF1"), db("PF2"), db("PF3")));
  });
  const full = await t.fetchPage({ period, page: 2 });
  assert.equal(full.items.length, 3);
  assert.equal(full.nextCursor, "3");
  const partial = await transport(async () => xml(page(db("PF1")))).fetchPage({ period, page: 1 });
  assert.equal(partial.nextCursor, undefined);
  const empty = await transport(async () => xml(`${decl}<dbs/>`, 200, "application/xml;charset=UTF-8")).fetchPage({ period, page: 1 });
  assert.deepEqual(empty, { items: [] });
  assert.equal(calls, 1);
});

test("transport: 잘못된 요청은 호출 전에 거절(기간 31일 초과·페이지·커서·기간 누락)", async () => {
  let calls = 0;
  const t = transport(async () => { calls++; return xml(page()); });
  for (const request of [
    { period: { start: "2026-10-01", end: "2026-11-01" }, page: 1 }, { period, page: 0 }, { period, page: 1000 },
    { period, page: 1.5 }, { period }, { page: 1 }, { period, page: 1, cursor: "2" },
    { period: { start: "2026-10-11", end: "2026-10-05" }, page: 1 }, { period: { start: "2026-02-30", end: "2026-03-01" }, page: 1 },
  ]) {
    await assert.rejects(t.fetchPage(request), codeIs("INVALID_EVENT_REQUEST"), JSON.stringify(request));
  }
  assert.equal(calls, 0);
  // 31일(양 끝 포함)은 허용.
  await t.fetchPage({ period: { start: "2026-10-01", end: "2026-10-31" }, page: 1 });
  assert.equal(calls, 1);
});

test("transport: HTTP 상태·형식 오류·200 오류 envelope를 0건 성공으로 바꾸지 않는다", async () => {
  const cases = [
    [() => xml(errorEnvelope("02")), "SOURCE_AUTH_REJECTED"],
    [() => xml("", 401), "SOURCE_AUTH_REJECTED"], [() => xml("", 403), "SOURCE_AUTH_REJECTED"],
    [() => xml("", 429), "SOURCE_RATE_LIMITED"], [() => xml("", 503), "SOURCE_UNAVAILABLE"],
    [() => xml("", 404), "SOURCE_REJECTED"], [() => xml("", 301), "SOURCE_REJECTED"],
    [() => xml("<html></html>", 200, "text/html"), "SOURCE_INVALID_RESPONSE"],
    [() => xml("{}", 200, "application/json"), "SOURCE_INVALID_RESPONSE"],
    [() => xml(`${decl}<dbs><db>`), "SOURCE_INVALID_RESPONSE"],
    [() => { throw new TypeError(`network failed for https://kopis.or.kr/?service=${KEY}`); }, "SOURCE_UNAVAILABLE"],
  ];
  for (const [respond, code] of cases) {
    await assert.rejects(transport(async () => respond()).fetchPage({ period, page: 1 }), codeIs(code), code);
  }
});

test("transport: 제한 시간과 호출자 취소", async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const slow = createKopisTransport({ apiKey: KEY, timeoutMs: 5, rows: 3, fetch: hang });
  await assert.rejects(slow.fetchPage({ period, page: 1 }), codeIs("SOURCE_TIMEOUT"));
  const controller = new AbortController();
  const pending = transport(hang).fetchPage({ period, page: 1, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, codeIs("CANCELLED"));
  const early = new AbortController();
  early.abort();
  let calls = 0;
  await assert.rejects(transport(async () => { calls++; return xml(page()); }).fetchPage({ period, page: 1, signal: early.signal }),
    codeIs("CANCELLED"));
  assert.equal(calls, 0);
});

test("설정 검사: 키·rows(1..100)·timeout·fetch 누락은 미구성", () => {
  const fetch = async () => xml(page());
  for (const config of [
    { apiKey: "", timeoutMs: 1, rows: 1, fetch }, { apiKey: "a b", timeoutMs: 1, rows: 1, fetch },
    { apiKey: KEY, timeoutMs: 0, rows: 1, fetch }, { apiKey: KEY, timeoutMs: 1, rows: 0, fetch },
    { apiKey: KEY, timeoutMs: 1, rows: 101, fetch }, { apiKey: KEY, timeoutMs: 1, rows: 1 },
  ]) {
    assert.throws(() => createKopisTransport(config), codeIs("EVENT_PROVIDER_UNCONFIGURED"));
  }
});

test("공통 어댑터 연결: provider·수집 시각 부여, 태그가 복호화된 제목은 저장 전에 거절", async () => {
  const now = () => new Date("2026-09-29T13:00:00.000Z");
  const provider = createKopisEventProvider({ apiKey: KEY, timeoutMs: 1000, rows: 5, now,
    fetch: async () => xml(page(db("PF1"), db("PF2", { prfstate: "공연중" }))) });
  const result = await provider.fetchPage({ period, page: 1 });
  assert.equal(provider.provider, "kopis");
  assert.deepEqual(result.events.map((e) => [e.provider, e.sourceId, e.collectedAt]),
    [["kopis", "PF1", "2026-09-29T13:00:00.000Z"], ["kopis", "PF2", "2026-09-29T13:00:00.000Z"]]);
  assert.equal(result.nextCursor, undefined);
  const tagged = createKopisEventProvider({ apiKey: KEY, timeoutMs: 1000, rows: 5, now,
    fetch: async () => xml(page(db("PF1", { prfnm: "&lt;b&gt;굵게&lt;/b&gt;" }))) });
  await assert.rejects(tagged.fetchPage({ period, page: 1 }), /INVALID_EVENT_PUBLIC_TEXT/);
  const reversed = createKopisEventProvider({ apiKey: KEY, timeoutMs: 1000, rows: 5, now,
    fetch: async () => xml(page(db("PF1", { prfpdfrom: "2026.10.12" }))) });
  await assert.rejects(reversed.fetchPage({ period, page: 1 }), /INVALID_EVENT_PERIOD/);
});
