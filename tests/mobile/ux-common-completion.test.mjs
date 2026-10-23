// Isolated actual TSX execution with mocked RN layout/focus; not native accessibility evidence.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";

const appRoot = path.resolve(import.meta.dirname, "../../apps/mobile");
const ts = createRequire(path.join(appRoot, "package.json"))("typescript");
const sourceRoot = process.env.YUMIDANG_UX_SOURCE_ROOT || path.join(appRoot, "src");
const slots = new Map();
let current = "", cursor = 0, app, activeController, providedController = null;
let dimensions = { width: 320, height: 568, fontScale: 1 }, insets = { bottom: 0 };
const scheduled = [], focuses = [];
const targets = new Map();
let contextCount = 0;
const react = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
  createContext(value) { return { value, Provider: `Provider-${contextCount++}` }; },
  useContext(context) { return context.Provider === "Provider-0" ? providedController : context.value; },
  useCallback(callback) { return callback; },
  useLayoutEffect(callback) { callback(); },
  useEffect() {},
  useState(initial) {
    const local = slots.get(current), index = cursor++;
    if (!(index in local)) local[index] = typeof initial === "function" ? initial() : initial;
    return [local[index], (value) => { local[index] = typeof value === "function" ? value(local[index]) : value; }];
  },
  useRef(initial) {
    const local = slots.get(current), index = cursor++;
    if (!(index in local)) local[index] = { current: initial };
    return local[index];
  },
};
const names = ["Avatar", "Badge", "Body", "Button", "Card", "Chip", "Divider", "Empty", "Field", "Icon", "IconButton", "MemberBox", "PostCard", "Row", "Screen", "Section", "TextButton", "Title"];
const ui = { ...Object.fromEntries(names.map(name => [name, name])), colors: { primary: "purple", faint: "gray", line: "gray", red: "red" } };
const Tabs = Object.assign(() => null, { Screen: "Tabs.Screen" });
function load(relative) {
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(path.join(sourceRoot, relative), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, { exports, setTimeout: run => scheduled.push(run), requestAnimationFrame: run => scheduled.push(run), Map, require(id) {
    if (id === "react") return react;
    if (id === "react-native") return { View: "View", Text: "Text", Pressable: "Pressable", Platform: { OS: "web" }, StyleSheet: { create: styles => styles }, useWindowDimensions: () => dimensions };
    if (id === "react-native-safe-area-context") return { useSafeAreaInsets: () => insets };
    if (id === "expo-router") return { Tabs, useFocusEffect() {}, useNavigation: () => ({ dispatch() {} }) };
    if (id === "expo-router/react-navigation") return { usePreventRemove() {} };
    if (id === "../presentation/member-ux" || id === "../presentation/ux-time") return {};
    if (id === "../ui" || id === "../../ui") return ui;
    if (id === "../presentation/ux-form") return { ...forms, useFormErrors: () => activeController };
    if (id === "../state") return { useApp: () => app };
    if (id === "../remote") return { serviceMode: false };
    if (id === "../domain" || id === "./RemoteMemberScreens" || id === "./RemoteScreens" || id === "expo-image-picker") return {};
    throw new Error(`Unexpected dependency ${id}`);
  } });
  return exports;
}
const forms = load("presentation/ux-form.tsx");
const community = load("screens/CommunityScreens.tsx");
const tabs = load("app/(tabs)/_layout.tsx");
function call(component, props = {}, key = component.name) {
  const previous = [current, cursor]; current = key; cursor = 0;
  if (!slots.has(key)) slots.set(key, []);
  const tree = component(props);
  [current, cursor] = previous;
  return tree;
}
const children = node => node?.props?.children?.flat(Infinity).filter(value => value && typeof value === "object") ?? [];
function visit(node, found = []) {
  if (!node || typeof node !== "object") return found;
  if (typeof node.type === "function") return visit(call(node.type, node.props, node.props.id || node.type.name), found);
  found.push(node);
  if (node.type === "Provider-0") {
    const previous = providedController;
    providedController = node.props.value;
    for (const child of children(node)) visit(child, found);
    providedController = previous;
    return found;
  }
  if (node.props.ref || node.props.focusRef) {
    const target = { focus: () => focuses.push(node) };
    const ref = node.props.ref || node.props.focusRef;
    if (typeof ref === "function") ref(target); else ref.current = target;
  }
  for (const child of children(node)) visit(child, found);
  if (node.props.footer) visit(node.props.footer, found);
  return found;
}
function reset() {
  slots.clear(); scheduled.length = 0; focuses.length = 0; targets.clear(); providedController = null;
  activeController = forms.createFormErrorController(run => scheduled.push(run));
  app = { member: { interests: ["전시"], conversationStyles: [], mbti: "", introduction: "남길 소개" }, failNext: false, setPreview(patch) { Object.assign(this, patch); }, updateMember() {}, showToast() {}, back() {} };
}
function preferences() {
  const outer = call(community.PreferencesScreen);
  return visit(call(outer.type, {}, "preferences"));
}
const text = node => node?.props?.children?.flat(Infinity).filter(value => typeof value === "string").join("");

test("S15-2 invalid MBTI focuses the first incomplete choice and preserves other values", () => {
  reset();
  let nodes = preferences();
  nodes.find(node => node.type === "Chip" && text(node) === "E").props.onPress();
  nodes = preferences();
  nodes.find(node => node.type === "Button" && text(node) === "변경사항 저장").props.onPress();
  nodes = preferences();
  scheduled.splice(0).forEach(run => run());
  assert.equal(focuses.length, 1);
  assert.equal(focuses[0].type, "Chip"); assert.equal(text(focuses[0]), "S");
  assert.equal(nodes.find(node => node.type === "Field" && node.props.label === "한 줄 소개 (선택)").props.value, "남길 소개");
  assert.ok(nodes.some(node => node.type === "Body" && text(node).includes("네 가지를 모두")));
});

test("S15-2 unknown save failure focuses a neutral error rather than blaming an input", () => {
  reset(); app.failNext = true;
  let nodes = preferences();
  nodes.find(node => node.type === "Button" && text(node) === "변경사항 저장").props.onPress();
  nodes = preferences(); scheduled.splice(0).forEach(run => run());
  assert.equal(focuses.length, 1); assert.equal(focuses[0].type, "View");
  assert.match(focuses[0].props.accessibilityLabel, /저장에 실패/);
  assert.equal(nodes.find(node => node.type === "Field" && node.props.label === "한 줄 소개 (선택)").props.value, "남길 소개");
});

test("tab labels wrap without a scaling cap and measured text plus bottom safe area grows the bar", () => {
  reset(); dimensions = { width: 320, height: 568, fontScale: 1 }; insets = { bottom: 0 };
  let tree = call(tabs.default, {}, "tabs"); const baseHeight = tree.props.screenOptions.tabBarStyle.height;
  let me = children(tree).find(node => node.props.name === "me");
  let label = me.props.options.tabBarLabel({ color: "purple" });
  assert.equal(label.props.numberOfLines, undefined); assert.equal(label.props.allowFontScaling, true);
  dimensions.fontScale = 2; insets.bottom = 34;
  tree = call(tabs.default, {}, "tabs"); const scaledHeight = tree.props.screenOptions.tabBarStyle.height;
  assert.ok(scaledHeight > baseHeight);
  assert.equal(tree.props.screenOptions.tabBarStyle.paddingBottom, 34);
  me = children(tree).find(node => node.props.name === "me");
  label = me.props.options.tabBarLabel({ color: "purple" });
  label.props.onLayout({ nativeEvent: { layout: { height: 56 } } });
  tree = call(tabs.default, {}, "tabs");
  assert.ok(tree.props.screenOptions.tabBarStyle.height >= scaledHeight + 28);
  assert.equal(children(tree).length, 4);
  // Stale portrait text measurement must not force extra height in a wider window.
  dimensions.width = 800; tree = call(tabs.default, {}, "tabs");
  assert.equal(tree.props.screenOptions.tabBarStyle.height, scaledHeight);
});
