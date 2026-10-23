// Isolated UI logic/presentation checks. RN primitives are mocked: not device or browser evidence.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const appRoot = path.resolve(import.meta.dirname, "../../apps/mobile");
const requireApp = createRequire(path.join(appRoot, "package.json"));
const ts = requireApp("typescript");
let platform = "web";
const react = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
  createContext(value) { return { value, Provider: "Provider" }; },
  useContext(context) { return context.value; },
  useState(initial) { return [typeof initial === "function" ? initial() : initial, () => {}]; },
  useRef(value) { return { current: value }; },
  useId() { return ":test:"; },
  useCallback(callback) { return callback; },
  useImperativeHandle() {},
  useLayoutEffect() {},
};
function load(relative) {
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(path.join(appRoot, "src", relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, setTimeout, Map, require(id) {
    if (id === "react") return react;
    if (id === "react-native") return {
      Text: "Text", View: "View", TextInput: "TextInput", Pressable: "Pressable",
      StyleSheet: { create: (styles) => styles }, Platform: { get OS() { return platform; } },
    };
    if (id === "./presentation/ux-form") return forms;
    if (id === "@expo/vector-icons") return { Ionicons: "Ionicons" };
    if (id === "expo-linear-gradient") return { LinearGradient: "LinearGradient" };
    if (id === "react-native-safe-area-context") return {};
    if (id === "expo-router") return {};
    if (id === "./state" || id === "./domain") return {};
    if (id.startsWith("../assets/")) return 1;
    throw new Error(`Unexpected dependency: ${id}`);
  } });
  return exports;
}
const forms = load("presentation/ux-form.tsx");
const { Field, IconButton, Button, Chip, s } = load("ui.tsx");
const children = (node) => node.props.children.flat().filter((child) => child && typeof child === "object");

test("a submit focuses only the first invalid target, reading errors after the commit", () => {
  const queued = [], focused = [];
  const controller = forms.createFormErrorController((run) => queued.push(run));
  controller.register("first", { error: undefined, order: 0, focus: () => focused.push("first") });
  controller.register("second", { error: "오류", order: 1, focus: () => focused.push("second") });
  controller.focusFirstError();
  assert.equal(focused.length, 0);
  controller.register("first", { error: "필수", order: 0, focus: () => focused.push("first") });
  queued.shift()();
  assert.deepEqual(focused, ["first"]);
});

test("removed and resolved fields cannot steal error focus, and registration updates retain visual order", () => {
  const queued = [], focused = [];
  const controller = forms.createFormErrorController((run) => queued.push(run));
  controller.register("later", { error: "오류", order: 2, focus: () => focused.push("later") });
  controller.register("earlier", { error: "오류", order: 0, focus: () => focused.push("earlier") });
  controller.focusFirstError();
  controller.unregister("earlier");
  queued.shift()();
  assert.deepEqual(focused, ["later"]);
  controller.register("later", { error: undefined, order: 2, focus: () => focused.push("wrong") });
  controller.focusFirstError(); queued.shift()();
  assert.deepEqual(focused, ["later"]);
});

test("field keeps label, required badge, help, value and plain error in the approved order", () => {
  const tree = Field({ label: "소개 · 필수", hint: "연락처는 적지 마세요.", error: "활동을 소개해 주세요.", value: "보존할 입력" });
  const [label, hint, input, error] = children(tree);
  assert.equal(children(label)[0].props.children[0], "소개");
  assert.equal(children(children(label)[1])[0].props.children[0], "필수");
  assert.equal(hint.props.children[0], "연락처는 적지 마세요.");
  assert.equal(input.type, "TextInput");
  assert.equal(input.props.value, "보존할 입력");
  assert.equal(input.props.accessibilityLabel, "소개, 필수");
  assert.equal(input.props["aria-required"], true);
  assert.equal(input.props["aria-invalid"], true);
  assert.equal(input.props["aria-describedby"], `${hint.props.nativeID} ${error.props.nativeID}`);
  assert.equal(error.type, "Text");
  assert.equal(error.props.children[0], "활동을 소개해 주세요.");
  assert.ok(!error.props.style.some((style) => style.backgroundColor || style.borderWidth));
});

test("a required asterisk is presented as a badge rather than left inside the field label", () => {
  const [label, input] = children(Field({ label: "공고 제목 *", value: "보존" }));
  assert.equal(children(label)[0].props.children[0], "공고 제목");
  assert.equal(children(children(label)[1])[0].props.children[0], "필수");
  assert.equal(input.props.accessibilityLabel, "공고 제목, 필수");
  assert.equal(input.props.value, "보존");
});

test("a custom field accessibility name retains required meaning and native hints include help plus error", () => {
  platform = "android";
  const input = children(Field({ label: "제목", required: true, accessibilityLabel: "공고 제목", hint: "활동 이름", error: "제목을 입력해 주세요." }))[2];
  assert.equal(input.props.accessibilityLabel, "공고 제목, 필수");
  assert.equal(input.props.accessibilityHint, "활동 이름. 제목을 입력해 주세요.");
  assert.equal(input.props["aria-describedby"], undefined);
  platform = "web";
});

test("icon controls reserve a transparent target while leaving the icon small and keep flexible headers", () => {
  let presses = 0;
  const button = IconButton({ name: "close", accessibilityLabel: "닫기", size: 18, onPress: () => presses++ });
  const box = button.props.style({ pressed: false })[0];
  assert.equal(box.minWidth, 44); assert.equal(box.minHeight, 44);
  assert.equal(box.backgroundColor, undefined);
  assert.equal(children(button)[0].props.size, 18);
  button.props.onPress(); assert.equal(presses, 1);
  assert.equal(s.header.height, undefined); assert.equal(s.header.minHeight, 64);
  assert.equal(s.row.flexWrap, "wrap");
});

test("form controls expose their actual pressable ref for known validation errors", () => {
  const photo = { current: null }, mbti = { current: null };
  const button = Button({ children: "사진 선택", onPress() {}, focusRef: photo });
  const chip = Chip({ children: "E", onPress() {}, focusRef: mbti });
  assert.equal(button.props.ref, photo); assert.equal(chip.props.ref, mbti);
  assert.equal(button.type, "Pressable"); assert.equal(chip.type, "Pressable");
});
