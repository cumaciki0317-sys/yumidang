// Actual controller/viewport TSX execution with mocked native APIs; emulator/AX observation is separate.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";
const appRoot = path.resolve(import.meta.dirname, "../../apps/mobile");
const ts = createRequire(path.join(appRoot, "package.json"))("typescript");
const frames = [], cleanups = [], listeners = new Map();
let keyboardMetrics;
const native = {
  Platform: { OS: "android" }, View: "View",
  Keyboard: {
    dismiss() {}, metrics: () => keyboardMetrics,
    addListener(name, callback) { listeners.set(name, callback); return { remove: () => listeners.delete(name) }; },
  }, AccessibilityInfo: { sendAccessibilityEvent() {} },
};
const react = {
  createContext(value) { return { value }; }, useCallback: callback => callback,
  useRef: current => ({ current }),
  useLayoutEffect(callback) { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); },
  useEffect(callback) { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); },
};
const exports = {};
const code = ts.transpileModule(fs.readFileSync(path.join(appRoot, "src/presentation/ux-form.tsx"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInNewContext(code, { exports, setTimeout: run => frames.push(run), requestAnimationFrame: run => frames.push(run), Map,
  require(id) { if (id === "react") return react; if (id === "react-native") return native; throw new Error(id); },
});
const { createUxFocusController, useUxScrollViewport, uxScrollCorrection } = exports;
function fixture(web = false) {
  const events = [], revealed = [];
  const controller = createUxFocusController({ isWeb: () => web, dismissKeyboard: () => events.push("keyboard-blur"), accessibilityFocus: node => events.push(["AX-focus", node]) });
  const unbind = controller.bindViewport({ rememberInput: node => events.push(["input-target", node]), reveal: (node, mode, done) => { revealed.push({ node, mode, done }); } });
  return { controller, events, revealed, unbind };
}
function reset() { cleanups.splice(0).forEach(cleanup => cleanup()); frames.length = 0; listeners.clear(); keyboardMetrics = undefined; }

test("native non-input error clears keyboard focus, reveals the control, then requests AX focus without View.focus", () => {
  const { controller, events, revealed } = fixture();
  const category = { focus() { throw new Error("View.focus is not native AX focus"); } };
  controller.focusTarget(category);
  assert.equal(events[0][0], "input-target"); assert.equal(events[0][1], null);
  assert.equal(events[1], "keyboard-blur");
  assert.equal(revealed[0].node, category); assert.equal(revealed[0].mode, "start");
  assert.equal(events.some(event => event[0] === "AX-focus"), false);
  revealed[0].done();
  assert.equal(events.at(-1)[0], "AX-focus"); assert.equal(events.at(-1)[1], category);
});

test("native input errors use actual TextInput focus and nearest scroll without dismissing keyboard", () => {
  const { controller, events, revealed } = fixture(); let inputFocus = 0;
  const input = { focus() { inputFocus++; } };
  controller.focusTarget(input, { input: true });
  assert.equal(inputFocus, 1); assert.equal(events.includes("keyboard-blur"), false);
  assert.equal(revealed[0].mode, "nearest"); revealed[0].done();
  assert.equal(events.at(-1)[0], "AX-focus");
});

test("blur, unmount and a newer target fence deferred native AX focus", () => {
  const { controller, events, revealed, unbind } = fixture();
  const target = { focus() {} };
  controller.focusTarget(target); controller.setEnabled(false); revealed[0].done();
  assert.equal(events.some(event => event[0] === "AX-focus"), false);
  controller.setEnabled(true); controller.focusTarget(target); unbind(); revealed[1].done();
  assert.equal(events.some(event => event[0] === "AX-focus"), false);
  const next = fixture(); next.controller.focusTarget(target); next.controller.focusTarget(target);
  next.revealed[0].done(); next.revealed[1].done();
  assert.equal(next.events.filter(event => event[0] === "AX-focus").length, 1);
});

test("web retains DOM focus without native keyboard or AX side effects", () => {
  const { controller, events, revealed } = fixture(true); let focused = 0;
  controller.focusTarget({ focus() { focused++; } });
  assert.equal(focused, 1); assert.equal(events.length, 0); assert.equal(revealed.length, 0);
});

test("keyboard opening remeasures and reveals the already focused input above its real top edge", () => {
  reset();
  const controller = createUxFocusController({ isWeb: () => false, dismissKeyboard() {}, accessibilityFocus() {} });
  let offset = 0; const scrolls = [];
  const scroll = { getNativeScrollRef: () => ({ measureInWindow: callback => callback(0, 100, 300, 600) }), scrollTo({ y }) { offset = y; scrolls.push(y); } };
  const viewport = useUxScrollViewport(controller, { current: scroll });
  const input = { focus() {}, measureInWindow: callback => callback(10, 650 - offset, 280, 80) };
  controller.revealTarget(input);
  assert.equal(offset, 42);
  keyboardMetrics = { screenY: 400 }; listeners.get("keyboardDidShow")();
  assert.equal(offset, 342);
  const inputBottom = 650 - offset + 80;
  assert.ok(inputBottom <= keyboardMetrics.screenY - 12);
  viewport.onScroll({ nativeEvent: { contentOffset: { y: offset } } });
  viewport.onLayout(); assert.equal(offset, 342);
  cleanups.splice(0).forEach(cleanup => cleanup());
  assert.equal(listeners.size, 0);
});

test("a non-input error stops future keyboard/layout events from scrolling the old title back into view", () => {
  reset(); let offset = 0;
  const controller = createUxFocusController({ isWeb: () => false, dismissKeyboard() { keyboardMetrics = undefined; }, accessibilityFocus() {} });
  const scroll = { getNativeScrollRef: () => ({ measureInWindow: callback => callback(0, 100, 300, 600) }), scrollTo({ y }) { offset = y; } };
  const viewport = useUxScrollViewport(controller, { current: scroll });
  const title = { focus() {}, measureInWindow: callback => callback(10, 650 - offset, 280, 80) };
  controller.revealTarget(title);
  const category = { focus() { throw new Error("not input focus"); }, measureInWindow: callback => callback(10, 200 - offset, 280, 44) };
  controller.focusTarget(category); frames.splice(0).forEach(run => run());
  assert.equal(offset, 88);
  keyboardMetrics = { screenY: 400 }; listeners.get("keyboardDidShow")(); viewport.onLayout();
  assert.equal(offset, 88);
  reset();
});

test("measured correction handles oversized controls and already visible targets without font-size guesses", () => {
  assert.equal(uxScrollCorrection({ y: 100, height: 600 }, { y: 200, height: 40 }, undefined, "nearest"), 0);
  assert.equal(uxScrollCorrection({ y: 100, height: 300 }, { y: 150, height: 500 }, 400, "nearest"), 38);
});


test("confirmation context is revealed before AX focuses its actual continue action", () => {
  const { controller, events, revealed } = fixture();
  const context = { measureInWindow() {} };
  const button = { focus() { throw new Error("native action uses AX focus"); } };
  controller.focusTarget(button, { reveal: context });
  assert.equal(revealed[0].node, context);
  assert.equal(revealed[0].mode, "start");
  assert.equal(events.some(event => event[0] === "AX-focus"), false);
  revealed[0].done();
  assert.equal(events.at(-1)[0], "AX-focus");
  assert.equal(events.at(-1)[1], button);
  const cancelled = fixture();
  cancelled.controller.focusTarget(button, { reveal: context });
  cancelled.controller.setEnabled(false);
  cancelled.revealed[0].done();
  assert.equal(cancelled.events.some(event => event[0] === "AX-focus"), false);
});

test("measured context reveal keeps the question and actions visible instead of aligning only the lower button", () => {
  reset();
  const focused = [], scrolls = [];
  let offset = 500;
  const controller = createUxFocusController({ isWeb: () => false, dismissKeyboard() {}, accessibilityFocus(target) { focused.push(target); } });
  const scroll = { getNativeScrollRef: () => ({ measureInWindow: callback => callback(0, 100, 300, 700) }), scrollTo({ y }) { offset = y; scrolls.push(y); } };
  const viewport = useUxScrollViewport(controller, { current: scroll });
  viewport.onScroll({ nativeEvent: { contentOffset: { y: offset } } });
  const context = { measureInWindow: callback => callback(0, 200 - offset, 300, 520) };
  const button = { focus() { throw new Error("not TextInput focus"); }, measureInWindow() { throw new Error("the lower action must not determine the context scroll position"); } };
  controller.focusTarget(button, { reveal: context });
  assert.equal(scrolls.length, 1);
  assert.ok(200 - offset >= 100);
  assert.ok(200 - offset + 520 <= 800);
  assert.equal(focused.length, 0);
  frames.splice(0).forEach(run => run());
  assert.equal(focused.length, 1);
  assert.equal(focused[0], button);
  viewport.onLayout();
  assert.equal(scrolls.length, 1);
  reset();
});
