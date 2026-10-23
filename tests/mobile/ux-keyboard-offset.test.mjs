// Production hook + installed RN KAV calculation. Native keyboard bounds still need device observation.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";
const appRoot = path.resolve(import.meta.dirname, "../../apps/mobile");
const requireApp = createRequire(path.join(appRoot, "package.json"));
const ts = requireApp("typescript");
function harness(platform = "android") {
  const slots = []; let index = 0;
  const react = {
    createContext: () => ({}),
    useCallback(callback, deps) { const i = index++, previous = slots[i]; if (!previous || deps.some((value, j) => value !== previous.deps[j])) slots[i] = { deps, callback }; return slots[i].callback; },
    useRef(initial) { const i = index++; return slots[i] ??= { current: initial }; },
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useLayoutEffect(callback, deps) { const i = index++, previous = slots[i]; if (!previous || deps.some((value, j) => value !== previous.deps[j])) { previous?.cleanup?.(); slots[i] = { deps, cleanup: callback() }; } },
  };
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(path.join(appRoot, "src/presentation/ux-form.tsx"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  vm.runInNewContext(code, { exports, Map, require(id) { if (id === "react") return react; if (id === "react-native") return { Platform: { OS: platform } }; throw new Error(id); } });
  return { render(rootWindowY = 0) { index = 0; return exports.useUxKeyboardOffset(rootWindowY); }, unmount() { slots.forEach(slot => slot?.cleanup?.()); } };
}
function frame(layoutY, pageY, pending = []) {
  return { currentTarget: null, target: { measure(callback) { pending.push(() => callback(0, layoutY, 320, 600, 0, pageY)); }, measureInWindow() { throw new Error("window coordinates can omit Android status-bar origin"); } }, nativeEvent: { layout: { y: layoutY, height: 600 } } };
}
// Execute the installed RN 0.86 method rather than copying its keyboard-overlap formula into the test.
const kavSource = fs.readFileSync(requireApp.resolve("react-native/Libraries/Components/Keyboard/KeyboardAvoidingView.js"), "utf8");
const start = kavSource.indexOf("    const frame = this._frame;", kavSource.indexOf("async _relativeKeyboardHeight("));
const end = kavSource.indexOf("\n  _onKeyboardChange", start);
const body = kavSource.slice(start, end).replace(/\n  }\s*$/, "");
const relativeKeyboardHeight = new Function("Platform", "AccessibilityInfo", `return async function(keyboardFrame) {${body}}`)({ OS: "android" }, {});

test("measured parent origin makes the installed native KAV protect the footer as well as the focused input", async () => {
  const h = harness(), pending = [];
  h.render().onLayout(frame(12, 70, pending)); pending.shift()();
  const offset = h.render().keyboardVerticalOffset; assert.equal(offset, 58);
  const native = { _frame: { y: 12, height: 600 }, state: { bottom: 0 }, props: { behavior: "height", keyboardVerticalOffset: offset } };
  const keyboardTop = 400;
  const avoided = await relativeKeyboardHeight.call(native, { screenY: keyboardTop });
  assert.equal(70 + 600 - avoided, keyboardTop);
  const oldAvoided = await relativeKeyboardHeight.call({ ...native, props: { ...native.props, keyboardVerticalOffset: 0 } }, { screenY: keyboardTop });
  assert.equal(70 + 600 - oldAvoided, keyboardTop + 58);
});

test("the persisted native target survives KAV's async forwarding and later layouts replace stale measurements", () => {
  const h = harness(), pending = [];
  h.render().onLayout(frame(20, 76, pending));
  h.render().onLayout(frame(0, 40, pending));
  pending[1](); pending[0]();
  assert.equal(h.render().keyboardVerticalOffset, 40);
  h.render().onLayout(frame(0, 0, pending)); pending.at(-1)();
  assert.equal(h.render().keyboardVerticalOffset, 0);
});

test("unmounted or non-finite native results cannot mutate the next screen; web retains zero offset", () => {
  const h = harness(), pending = [];
  h.render().onLayout(frame(0, Infinity, pending)); pending.shift()();
  assert.equal(h.render().keyboardVerticalOffset, 0);
  h.render().onLayout(frame(0, 90, pending)); h.unmount(); pending.shift()();
  assert.equal(h.render().keyboardVerticalOffset, 0);
  const web = harness("web"); web.render().onLayout({ target: { measureInWindow() { throw new Error("web must not measure native nodes"); } } });
  assert.equal(web.render().keyboardVerticalOffset, 0);
});


test("observed compact Android root-relative y restores the missing status-bar origin in RN KAV", async () => {
  const h = harness(), pending = [];
  const layoutY = 0, pageY = 82.6666565, reportedWindowY = 43.8095093;
  h.render(0).onLayout(frame(layoutY, pageY, pending)); pending.shift()();
  const offset = h.render(0).keyboardVerticalOffset;
  assert.equal(offset, pageY); assert.ok(offset - reportedWindowY > 38);
  const native = { _frame: { y: layoutY, height: 603.0476 }, state: { bottom: 0 }, props: { behavior: "height", keyboardVerticalOffset: offset } };
  const keyboardTop = 402.6666565;
  const avoided = await relativeKeyboardHeight.call(native, { screenY: keyboardTop });
  assert.ok(Math.abs(pageY + native._frame.height - avoided - keyboardTop) < 0.0001);
  const oldAvoided = await relativeKeyboardHeight.call({ ...native, props: { ...native.props, keyboardVerticalOffset: reportedWindowY } }, { screenY: keyboardTop });
  assert.ok(pageY + native._frame.height - oldAvoided > keyboardTop + 38);
});

test("a real provider window origin and later origin changes are measured without status-bar guesses", async () => {
  const h = harness(), pending = [];
  h.render(40).onLayout(frame(12, 70, pending)); pending.shift()();
  assert.equal(h.render(40).keyboardVerticalOffset, 98);
  const native = { _frame: { y: 12, height: 600 }, state: { bottom: 0 }, props: { behavior: "height", keyboardVerticalOffset: 98 } };
  const avoided = await relativeKeyboardHeight.call(native, { screenY: 400 });
  assert.equal(40 + 70 + 600 - avoided, 400);
  h.render(60); pending.shift()(); assert.equal(h.render(60).keyboardVerticalOffset, 118);
});
