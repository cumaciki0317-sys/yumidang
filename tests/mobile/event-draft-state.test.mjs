// Executes the real preview state adapter with mocked React hooks, storage and router.
// No OAuth, real member, server or provider request is performed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";

const app = path.resolve(import.meta.dirname, "../../apps/mobile");
const requireApp = createRequire(path.join(app, "package.json"));
const ts = requireApp("typescript");
const NOW = Date.parse("2026-10-20T00:00:00Z");

function setup() {
  let state;
  let lastRoute;
  const stored = new Map();
  const cache = new Map();
  const react = {
    createContext: () => ({ Provider: "Provider" }),
    createElement: (type, props) => ({ type, props }),
    useState: (initial) => { const value = typeof initial === "function" ? initial() : initial; state = value; return [value, (next) => { state = next; }]; },
    useRef: (initial) => ({ current: initial }),
    useCallback: (callback) => callback,
    useEffect: () => {},
    useContext: () => null,
  };
  const storage = {
    saveDraft: async (owner, draft) => { stored.set(owner, JSON.stringify(draft)); },
    clearDraft: async (owner) => { stored.delete(owner); },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(js, { exports, console, Date, Intl, setTimeout: () => 0, clearTimeout: () => {},
      require(id) {
        if (id === "react") return react;
        if (id === "expo-router") return { router: { push: (route) => { lastRoute = route; }, replace() {}, canGoBack: () => false }, usePathname: () => "/event", useGlobalSearchParams: () => ({ id: "source-event" }) };
        if (id === "./remote") return { serviceMode: false, useServiceSession: () => ({ authenticated: false, epoch: 0 }), serviceSessionEpoch: () => 0 };
        if (id === "./storage") return storage;
        let target = path.resolve(path.dirname(file), id);
        if (!path.extname(target)) target += ".ts";
        const value = load(target);
        if (id === "./data") return { ...value, initialState: () => value.initialState(NOW) };
        return value;
      },
    });
    return exports;
  }
  const adapter = load(path.join(app, "src/state.tsx"));
  const api = adapter.AppProvider({ children: null }).props.value;
  const data = load(path.join(app, "src/data.ts"));
  return { api, getState: () => state, stored, route: () => lastRoute,
    draft: { ...data.emptyDraft(NOW), category: "공연", title: "함께 공연 관람해요", introduction: "함께 감상할 동행을 구해요.", placeName: "공개 문화센터", publicArea: "서울 종로구", address: "서울 종로구 세종대로 175" } };
}

test("real preview publish stores direct info only on post and does not create an event", () => {
  const { api, getState, draft } = setup();
  api.login("me");
  const beforeEvents = JSON.stringify(getState().events);
  const manualEvent = { title: "주말 취미 합주 공연", placeName: "연습실", publicAddress: "", publicAddressConfirmed: false };
  const result = api.publish({ ...draft, manualEvent });
  assert.equal(result.ok, true);
  const post = getState().posts.find((item) => item.id === result.id);
  assert.equal(post.manualEvent.title, manualEvent.title);
  assert.equal(post.eventId, undefined);
  assert.equal(JSON.stringify(getState().events), beforeEvents);
});

test("real preview publish permits event connection outside the meeting period", () => {
  const { api, getState, draft } = setup();
  api.login("me");
  const event = { ...getState().events[0], id: "outside", startsAt: NOW + 86400000, endsAt: NOW + 2 * 86400000 };
  api.setPreview({ events: [event] });
  const result = api.publish({ ...draft, startsAt: "2026-12-01T10:00", endsAt: "2026-12-01T12:00", eventId: event.id });
  assert.equal(result.ok, true);
  assert.equal(getState().posts.find((item) => item.id === result.id).eventId, event.id);
});

test("invalid restored direct info cannot be published and valid direct draft roundtrips", async () => {
  const { api, getState, stored, draft } = setup();
  api.login("me");
  const bad = { ...draft, manualEvent: { title: "취미 공연", placeName: "", publicAddress: "공개 확인 전 주소", publicAddressConfirmed: false } };
  const count = getState().posts.length;
  assert.equal(api.publish(bad).ok, false);
  assert.equal(getState().posts.length, count);
  const good = { ...draft, manualEvent: { ...bad.manualEvent, publicAddress: "" } };
  await api.saveDraft(good);
  assert.equal(JSON.parse(stored.get("me")).manualEvent.title, good.manualEvent.title);
});

test("anonymous event-intent login route preserves the fixed create destination", () => {
  const { api, route } = setup();
  api.navigate("S05", "event:source-event");
  assert.equal(route().pathname, "/login");
  assert.equal(route().params.returnPath, "/create?id=event%3Asource-event");
});
