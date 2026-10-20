// Runs the actual AI screen with isolated hook/HTTP ports; no React Native runtime or external requests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const appRoot = path.resolve(import.meta.dirname, "../../apps/mobile");
const ts = createRequire(path.join(appRoot, "package.json"))("typescript");
const source = process.env.AI_SCREEN_SOURCE || path.join(appRoot, "src/screens/RemoteScreens.tsx");
const compiled = ts.transpileModule(readFileSync(source, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
}).outputText;
const id = "10000000-0000-4000-8000-000000000001";
const response = (patch = {}) => ({ requestId: id, status: "no_results", interpretedFilters: { target: "posts" }, cards: [], explanations: [], ...patch });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const isNode = value => value && typeof value === "object" && "type" in value;
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isNode(value)) return [];
  return [value, ...Object.values(value.props || {}).filter(item => Array.isArray(item) || isNode(item)).flatMap(nodes)];
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join("");
  if (typeof value === "string") return value;
  return isNode(value) ? text(value.props.children) : "";
}
function harness(answer = async () => response()) {
  let slots = [], effects = [], index = 0, dirty = false, tree;
  let session = { epoch: 0, authenticated: true };
  const calls = [], routes = [];
  const react = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(initial) {
      const state = slots, key = index++;
      if (!(key in state)) state[key] = typeof initial === "function" ? initial() : initial;
      return [state[key], next => { const value = typeof next === "function" ? next(state[key]) : next; if (!Object.is(value, state[key])) { state[key] = value; if (slots === state) dirty = true; } }];
    },
    useRef(initial) { const key = index++; if (!(key in slots)) slots[key] = { current: initial }; return slots[key]; },
    useCallback(callback, deps) {
      const key = index++, previous = slots[key];
      if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at]))) slots[key] = { deps, callback };
      return slots[key].callback;
    },
    useEffect(effect, deps) {
      const state = slots, key = index++, previous = state[key];
      if (!previous || deps.some((value, at) => !Object.is(value, previous.deps[at]))) effects.push(() => { previous?.cleanup?.(); state[key] = { deps, cleanup: effect() }; });
    },
  };
  class ApiError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
  const ui = Object.fromEntries(["Badge", "Body", "Button", "Card", "Chip", "Empty", "Field", "Row", "Screen", "TextButton", "Title"].map(name => [name, name]));
  const exports = {};
  vm.runInNewContext(`${compiled}\nexports.screenUnderTest = RemoteAiSession;`, {
    exports, Date, Intl, AbortController,
    require(name) {
      if (name === "react") return react;
      if (name === "react-native") return { View: "View", Linking: {} };
      if (name === "expo-router") return { router: {}, useFocusEffect(callback) { react.useEffect(callback, [callback]); } };
      if (name === "../api") return { ApiError };
      if (name === "../ui") return ui;
      if (name === "../remote") return { useServiceSession: () => session, serviceSessionEpoch: () => session.epoch,
        useService: () => ({ askAi(input, signal) { calls.push({ input: structuredClone(input), signal }); return answer(input, signal); } }) };
      if (name === "../service") return { normalizeMobileRegion(value) { if (!value.trim()) return undefined; if (value === "서울") return "서울"; throw new Error("invalid region"); } };
      if (name === "../state") return { useApp: () => ({ navigate: route => routes.push(route), showToast() {} }) };
      if (name === "./RemoteAiFeedback") return { RemoteAiFeedback: "RemoteAiFeedback" };
      return {};
    },
  });
  function render() { index = 0; dirty = false; tree = exports.screenUnderTest(); effects.splice(0).forEach(run => run()); }
  async function flush() { for (let at = 0; at < 10; at++) { if (dirty) render(); await new Promise(resolve => setImmediate(resolve)); if (!dirty) return; } throw new Error("Hook harness did not settle"); }
  const find = (type, label) => nodes(tree).find(node => node.type === type && (label === undefined || text(node) === label));
  function cleanup() { for (const slot of slots) slot?.cleanup?.(); effects = []; }
  render();
  return { calls, routes, ApiError, flush, find, get tree() { return tree; }, get text() { return nodes(tree).filter(node => node.type === "Body").map(text).join("\n"); },
    input() { return nodes(tree).find(node => node.type === "Field" && node.props.placeholder === "찾고 싶은 동행과 지역을 알려 주세요"); },
    async enter(value) { this.input().props.onChangeText(value); await flush(); },
    async send() { find("Button", "보내기").props.onPress(); await flush(); },
    async leave() { cleanup(); await flush(); },
    async session(next) { cleanup(); slots = []; session = next; render(); await flush(); },
  };
}

test("successful response preserves a newer unsent draft typed during the request", async () => {
  const late = deferred(), h = harness(() => late.promise);
  await h.enter("첫 질문"); await h.send();
  await h.enter("응답 중 작성한 다음 질문");
  late.resolve(response()); await h.flush();
  assert.equal(h.input().props.value, "응답 중 작성한 다음 질문");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].input.messages.at(-1).content, "첫 질문");
});

test("successful response clears only its own submitted draft, including surrounding whitespace", async () => {
  const h = harness(); await h.enter("  첫 질문  "); await h.send();
  assert.equal(h.input().props.value, "");
  assert.equal(h.calls[0].input.messages.at(-1).content, "첫 질문");
});

for (const reason of ["input_privacy", "output_privacy", "daily_limit", "concurrent", "consent", "temporary"]) {
  test(`${reason} preserves input and server notice without pretending that unavailable means zero results`, async () => {
    const h = harness(async () => response({ status: "unavailable", notice: `합성 안내 ${reason}`, recovery: { reason, retryAllowed: reason === "output_privacy" || reason === "temporary" } }));
    await h.enter("다시 확인할 질문"); await h.send();
    assert.equal(h.input().props.value, "다시 확인할 질문");
    assert.ok(h.text.includes(`합성 안내 ${reason}`));
    assert.ok(!h.text.includes("조건에 맞는 결과가 없어요."));
    assert.equal(h.calls.length, 1);
    const retry = h.find("Button", "답변 다시 확인하기");
    assert.equal(Boolean(retry), reason === "output_privacy");
    h.find("TextButton", "일반 둘러보기").props.onPress();
    assert.deepEqual(h.routes, ["S01"]);
    assert.equal(h.calls.length, 1);
  });
}

test("verified empty results are rendered separately from an incomplete unavailable result", async () => {
  const h = harness(); await h.enter("조건 확인"); await h.send();
  assert.ok(h.text.includes("조건에 맞는 결과가 없어요."));
  assert.equal(h.input().props.value, "");
});

test("rapid send attempts issue only one request while the synchronous lock is held", async () => {
  const late = deferred(), h = harness(() => late.promise);
  await h.enter("질문"); const press = h.find("Button", "보내기").props.onPress;
  press(); press(); await h.flush();
  assert.equal(h.calls.length, 1); assert.equal(h.find("Button", "보내기").props.disabled, true);
  late.resolve(response()); await h.flush();
  assert.equal(h.find("Button", "보내기").props.disabled, false);
});

test("output privacy retry sends the original server request ID once and obeys retryAllowed false", async () => {
  let attempt = 0;
  const h = harness(async () => response({ status: "unavailable", notice: "답변 숨김", recovery: { reason: "output_privacy", retryAllowed: ++attempt === 1 } }));
  await h.enter("질문"); await h.send();
  h.find("Button", "답변 다시 확인하기").props.onPress(); await h.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].input.outputRetryOf, undefined);
  assert.equal(h.calls[1].input.outputRetryOf, id);
  assert.notEqual(h.calls[1].input.clientRequestId, h.calls[0].input.clientRequestId);
  assert.equal(h.find("Button", "답변 다시 확인하기"), undefined);
});

test("new conversation aborts an old request and late success cannot replace the new draft", async () => {
  const late = deferred(), h = harness(() => late.promise);
  await h.enter("이전 질문"); await h.send();
  h.find("TextButton", "새 대화").props.onPress(); await h.flush(); await h.enter("새 질문");
  assert.equal(h.calls[0].signal.aborted, true);
  late.resolve(response({ notice: "늦은 이전 답변" })); await h.flush();
  assert.equal(h.input().props.value, "새 질문"); assert.ok(!h.text.includes("늦은 이전 답변"));
});

test("leaving the screen discards conversation and ignores a transport that resolves after abort", async () => {
  const late = deferred(), h = harness(() => late.promise);
  await h.enter("이전 질문"); await h.send(); await h.leave();
  assert.equal(h.calls[0].signal.aborted, true);
  late.resolve(response({ notice: "화면 밖 지연 답변" })); await h.flush();
  assert.equal(h.input().props.value, ""); assert.ok(!h.text.includes("화면 밖 지연 답변"));
});

test("logout remounts the anonymous screen and cannot restore a previous session's late answer", async () => {
  const late = deferred(), h = harness(() => late.promise);
  await h.enter("회원 질문"); await h.send(); await h.session({ epoch: 1, authenticated: false });
  late.resolve(response({ notice: "이전 회원 답변" })); await h.flush();
  assert.equal(h.find("Empty").props.title, "AI 탐색은 로그인 후 이용할 수 있어요");
  assert.ok(!h.text.includes("이전 회원 답변")); assert.equal(h.calls[0].signal.aborted, true);
});

test("fixed condition buttons do not call the model or invent local remaining quota", async () => {
  const h = harness(); h.find("Chip", "서울 전시").props.onPress(); await h.flush();
  assert.equal(h.calls.length, 0);
  assert.equal(nodes(h.tree).filter(node => typeof node.type === "function" && node.type.name === "RemotePostResults").length, 1);
  assert.ok(!/\d+\/20/.test(h.text));
});

test("a transport failure preserves the draft and does not automatically retry", async () => {
  const h = harness(async () => { throw new Error("synthetic connection failure"); });
  await h.enter("보존할 질문"); await h.send();
  assert.equal(h.input().props.value, "보존할 질문"); assert.equal(h.calls.length, 1);
  assert.ok(h.text.includes("입력한 조건을 유지"));
});
