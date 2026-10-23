// Isolated hook/transport regression: no Expo runtime, OAuth or external API calls.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
const appRoot = path.resolve(import.meta.dirname, "../../apps/mobile");
const requireApp = createRequire(path.join(appRoot, "package.json"));
const ts = requireApp("typescript");
const sourceRoot = path.join(appRoot, "src");
const fallbackSourceRoot = process.env.YUMIDANG_UX_FALLBACK_SOURCE_ROOT;
const fixture = { id: "10000000-0000-4000-8000-000000000001", title: "합성 공연", state: "upcoming", sourceStatus: "active", precision: "date", startsOn: "2026-11-01", endsOn: "2026-11-01" };
const text = (node) => Array.isArray(node) ? node.map(text).join("") : typeof node === "string" ? node : node?.props?.children?.map(text).join("") ?? "";
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...(node.props?.children ?? []).flatMap(nodes)] : []; }
function harness(service, props = {}, detail = false) {
  const slots = [], effects = [], calls = [], selections = [], routes = [];
  let index = 0, dirty = false, tree;
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const key = index++;
      if (!(key in slots)) slots[key] = initial;
      return [slots[key], (next) => { const value = typeof next === "function" ? next(slots[key]) : next; if (!Object.is(slots[key], value)) { slots[key] = value; dirty = true; } }];
    },
    useRef(initial) { const key = index++; if (!(key in slots)) slots[key] = { current: initial }; return slots[key]; },
    useCallback(callback, deps) {
      const key = index++, previous = slots[key];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) slots[key] = { callback, deps };
      return slots[key].callback;
    },
    useEffect(effect, deps) {
      const key = index++, previous = slots[key];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        effects.push(() => { previous?.cleanup?.(); slots[key] = { deps, cleanup: effect() }; });
      }
    },
  };
  const ui = Object.fromEntries(["Badge", "Body", "Button", "Card", "Chip", "Empty", "Field", "Row", "Screen", "TextButton", "Title"].map(name => [name, name]));
  class ApiError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
  const servicePort = {
    async listEvents(query, cursor, signal) { calls.push({ query: JSON.parse(JSON.stringify(query)), cursor }); return service(query, cursor, signal); },
    async getEvent() { return fixture; },
  };
  function load(file) {
    const exports = {};
    const primary = path.join(sourceRoot, file);
    const sourceFile = !existsSync(primary) && fallbackSourceRoot ? path.join(fallbackSourceRoot, file) : primary;
    const compiled = ts.transpileModule(readFileSync(sourceFile, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(compiled, {
      exports, Date, Intl, AbortController,
      require(id) {
        if (id === "react") return react;
        if (id === "react-native") return { View: "View", Linking: {} };
        if (id === "expo-router") return { useFocusEffect(callback) { react.useEffect(callback, [callback]); }, router: { push(route) { routes.push(JSON.parse(JSON.stringify(route))); } } };
        if (id === "../api") return { ApiError };
        if (id === "../remote") return { useService: () => servicePort, useServiceSession: () => ({ epoch: 0, authenticated: false }), serviceSessionEpoch: () => 0 };
        if (id === "../state") return { useApp: () => ({ navigate() {} }) };
        if (id === "../ui") return ui;
        if (id === "../presentation/events/EventPresentation") return { EventListCard: "EventListCard", EventDetailContent: "EventDetailContent" };
        if(id === "../presentation/client-feedback") { const actual=load("presentation/client-feedback.tsx");return {...actual,RecoveryCard:"RecoveryCard"}; }
        if (id === "../presentation/events/event-selection") return load("presentation/events/event-selection.ts");
        return {};
      },
    });
    return exports;
  }
  const { RemoteEventPicker, RemoteEventDetail } = load("screens/RemoteScreens.tsx");
  function render() { index = 0; dirty = false; tree = detail ? RemoteEventDetail({ id: fixture.id }) : RemoteEventPicker({ onSelect(event) { selections.push(event); }, ...props }); effects.splice(0).forEach(run => run()); }
  async function flush() {
    for (let i = 0; i < 8; i++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); if (!dirty) return; }
    throw new Error("Hook harness did not settle");
  }
  render();
  return { flush, calls, selections, routes, get tree() { return tree; }, find(type, label) { return nodes(tree).find(node => node.type === type && (label === undefined || text(node) === label)); } };
}

test("picker loads without drafting dates and permits a nonoverlapping event", async () => {
  const h = harness(async () => ({ events: [fixture], nextCursor: null }), { startsAt: "2026-10-31T13:00:00+09:00", endsAt: "2026-10-31T14:00:00+09:00" });
  await h.flush();
  assert.deepEqual(h.calls, [{ query: { mode: "post_selection" }, cursor: undefined }]);
  const connect = h.find("Button", "이 행사 연결하기");
  assert.equal(connect.props.disabled, false);
  connect.props.onPress();
  assert.equal(h.selections[0].id, fixture.id);
});

test("keyword application resets paging and more retains only the applied keyword", async () => {
  const second = { ...fixture, id: "10000000-0000-4000-8000-000000000002" };
  const h = harness(async (_query, cursor) => ({ events: [cursor ? second : fixture], nextCursor: cursor ? null : "next-10" }));
  await h.flush();
  h.find("Field").props.onChangeText("  합성  "); await h.flush();
  h.find("Button", "검색").props.onPress(); await h.flush();
  assert.deepEqual(h.calls.at(-1), { query: { mode: "post_selection", query: "합성" }, cursor: undefined });
  await h.find("Button", "행사 10개 더 보기").props.onPress(); await h.flush();
  assert.deepEqual(h.calls.at(-1), { query: { mode: "post_selection", query: "합성" }, cursor: "next-10" });
  assert.equal(nodes(h.tree).filter(node => node.type === "EventListCard").length, 2);
});

test("empty results offer direct input while network failure never says zero results", async () => {
  let entered = false;
  const empty = harness(async () => ({ events: [], nextCursor: null }), { onDirectInput() { entered = true; } });
  await empty.flush();
  assert.ok(empty.find("Empty").props.title.includes("조건에 맞는 행사가 없어요"));
  empty.find("Button", "행사 직접 입력").props.onPress();
  assert.equal(entered, true);
  const failed = harness(async () => { throw new Error("network"); });
  await failed.flush();
  assert.equal(failed.find("RecoveryCard").props.kind, "retry");
  assert.match(failed.find("RecoveryCard").props.message, /불러오지 못/);
  assert.ok(!nodes(failed.tree).some(node => node.type === "Empty" && node.props.title === "조건에 맞는 행사가 없어요"));
});

test("unknown or cancelled DTO events cannot invoke the selection callback", async () => {
  for (const sourceStatus of ["unknown", "cancelled"]) {
    const h = harness(async () => ({ events: [{ ...fixture, sourceStatus }], nextCursor: null }));
    await h.flush();
    const button = nodes(h.tree).find(node => node.type === "Button" && node.props.disabled);
    assert.ok(button);
    button.props.onPress();
    h.find("EventListCard").props.onPress();
    assert.equal(h.selections.length, 0);
  }
});

test("anonymous detail CTA preserves local event create return path without starting OAuth", async () => {
  const h = harness(async () => ({ events: [], nextCursor: null }), {}, true);
  await h.flush();
  h.find("Button", "이 행사로 동행 구하기").props.onPress();
  assert.equal(h.routes[0].pathname, "/login");
  const route = new URL(h.routes[0].params.returnPath, "https://local.invalid");
  assert.equal(route.pathname, "/create");
  assert.equal(route.searchParams.get("id"), `event:${fixture.id}`);
});

test("Enter and button execute the same query once, while composition and same-frame repeats do not send", async () => {
  let finish;
  const h = harness(async (query) => query.query ? new Promise(resolve => { finish = resolve; }) : { events: [fixture], nextCursor: null });
  await h.flush();
  h.find("Field").props.onChangeText("  한글 공연  "); await h.flush();
  const input = h.find("Field"), button = h.find("Button", "검색");
  input.props.onSubmitEditing({ nativeEvent: { isComposing: true } });
  assert.equal(h.calls.length, 1);
  input.props.onSubmitEditing({ nativeEvent: { isComposing: false } });
  button.props.onPress(); // Same render/event turn, before busy state commits.
  input.props.onSubmitEditing({ nativeEvent: {} });
  await h.flush();
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1], { query: { mode: "post_selection", query: "한글 공연" }, cursor: undefined });
  button.props.onPress(); await h.flush(); assert.equal(h.calls.length, 2);
  finish({ events: [fixture], nextCursor: null }); await h.flush();
  h.find("Field").props.onSubmitEditing({ nativeEvent: {} }); await h.flush();
  assert.equal(h.calls.length, 3); // A deliberate retry after completion is allowed.
  finish({ events: [fixture], nextCursor: null }); await h.flush();
});

test("service direct-input entry exposes its actual button ref for nested return focus", async () => {
  const directInputRef = { current: null };
  const h = harness(async () => ({ events: [], nextCursor: null }), { onDirectInput() {}, directInputRef });
  await h.flush();
  assert.equal(h.find("Button", "행사 직접 입력").props.focusRef, directInputRef);
});
