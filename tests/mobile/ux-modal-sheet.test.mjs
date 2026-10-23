// Actual TSX handlers with synthetic refs/layout commits. Android overlay bounds/AX need device verification.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";
const appRoot = path.resolve(import.meta.dirname, "../../apps/mobile");
const ts = createRequire(path.join(appRoot, "package.json"))("typescript");
const names = ["Avatar", "Artwork", "Badge", "Body", "Button", "Card", "Chip", "Divider", "Empty", "Field", "Icon", "MemberBox", "PostCard", "Row", "Screen", "Section", "TextButton", "Title"];
const words = node => Array.isArray(node) ? node.map(words).join("") : typeof node === "string" ? node : node?.props?.children?.map(words).join("") || "";
function flatten(node, result = []) {
  if (Array.isArray(node)) { node.forEach(child => flatten(child, result)); return result; }
  if (!node || typeof node !== "object") return result;
  result.push(node);
  if (node.props.focusRef) node.props.focusRef.current = { label: words(node) };
  if (node.type === "UxModalSheet" && !node.props.visible) return result;
  flatten(node.props.children, result); if (node.props.header) flatten(node.props.header, result);
  return result;
}
function harness(kind = "create", existingManual = false) {
  const slots = [], effects = [], focusCalls = [], viewports = [], listeners = new Map(), focusCleanups = new Map();
  let index = 0, tree;
  const controller = () => ({ focusTarget: target => focusCalls.push(target?.label), setEnabled() {} });
  const mainFocus = controller();
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) { const i = index++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = index++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo(callback, deps) { const i = index++; const previous = slots[i]; if (!previous || deps.some((value, j) => value !== previous.deps[j])) slots[i] = { deps, value: callback() }; return slots[i].value; },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useLayoutEffect(callback, deps) { const i = index++; const previous = slots[i]; if (!previous || !deps || deps.some((value, j) => value !== previous.deps?.[j])) { slots[i] = { deps }; effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = callback(); }); } },
    useEffect(callback, deps) { react.useLayoutEffect(callback, deps); },
  };
  const manual = { title: "원래 수기 행사", placeName: "원래 장소", publicAddress: "서울 성동구 공개 행사장", publicAddressConfirmed: true };
  const draft = { category: "공연", title: "보존할 공고 제목", introduction: "초안 소개", meetingPoint: "", placeName: "만남 장소", publicArea: "서울 성동구", address: "서울 공개 장소", startsAt: "2026-11-01T14:00", endsAt: "2026-11-01T16:00", deadlineAt: "", desiredAgeMin: "", desiredAgeMax: "", wishes: "", updatedAt: Date.parse("2026-10-23T00:00:00Z"), ...(existingManual ? { manualEvent: manual } : {}) };
  const app = { now: Date.parse("2026-10-23T00:00:00Z"), member: { id: "self" }, draft: existingManual ? draft : null, blockedIds: [], events: [{ id: "event", title: "테스트 행사", endsAt: Date.parse("2026-11-03"), startsAt: Date.parse("2026-11-01"), publicArea: "서울", placeName: "공연장" }], posts: [{ id: "closed-newest", eventId: "event", status: "closed", authorId: "peer", createdAt: 30 }, { id: "recruiting-older", eventId: "event", status: "recruiting", authorId: "peer", createdAt: 20 }], saveDraft: async () => {}, navigate() {}, showToast() {} };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const compiled = ts.transpileModule(fs.readFileSync(path.join(appRoot, "src", file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(compiled, { exports, Date, Intl, Map, require(id) {
      if (id === "react") return react;
      if (id === "react-native") return { View: "View", Text: "Text", Modal: "Modal", ScrollView: "ScrollView", KeyboardAvoidingView: "KeyboardAvoidingView", Pressable: "Pressable", StyleSheet: { create: value => value }, Platform: { OS: "android" }, BackHandler: { addEventListener(event, callback) { listeners.set(event, callback); return { remove: () => listeners.delete(event) }; } } };
      if (id === "expo-router") return { useFocusEffect(callback) { const i = index++; const previous = slots[i]; if (previous?.callback !== callback) { slots[i] = { callback }; effects.push(() => { focusCleanups.get(i)?.(); const cleanup = callback(); if (cleanup) focusCleanups.set(i, cleanup); else focusCleanups.delete(i); }); } } };
      if (id === "react-native-safe-area-context") return { useSafeAreaInsets: () => ({ top: 24, left: 0, right: 0, bottom: 32 }), useSafeAreaFrame: () => ({ x: 0, y: 0, width: 320, height: 685 }) };
      if (id === "../state") return { useApp: () => app };
      if (id === "../ui") return { ...Object.fromEntries(names.map(name => [name, name])), colors: {}, dateLabel: () => "날짜", timeLabel: () => "시간" };
      if (id === "../remote") return { serviceMode: false, serviceSessionEpoch: () => 0, useServiceSession: () => ({ epoch: 0 }) };
      if (id === "../domain" || id === "../../domain.ts") return load("domain.ts");
      if (id === "../presentation/events/event-draft") return load("presentation/events/event-draft.ts");
      if (id === "../presentation/ux-modal-sheet") return { UxModalSheet: "UxModalSheet" };
      if (id === "../presentation/ux-form" || id === "./ux-form") return { FormErrors: "FormErrors", FormErrorTarget: "FormErrorTarget", FormErrorAnchor: "FormErrorAnchor", useFormErrors: () => ({ focusFirstError() {} }), useUxFocus: () => mainFocus, createUxFocusController: controller, UxFocusProvider: "UxFocusProvider", useUxKeyboardOffset: () => ({ keyboardVerticalOffset: 0, onLayout() {} }), useUxScrollViewport: (focus, ref) => { viewports.push({ focus, ref }); return { onScroll() {}, onLayout() {} }; } };
      if (id === "./RemoteScreens") return { useRemoteEventSource: () => ({ event: null }) };
      if (id === "./RemoteMemberScreens") return { useMemberAction: () => ({ busy: false }) };
      if (id === "./RemotePlacePicker") return { default: "RemotePlacePicker" };
      if (id === "expo-crypto") return {};
      throw new Error(`Unexpected import ${id}`);
    } });
    return exports;
  }
  const sheets = load("presentation/ux-modal-sheet.tsx");
  const browse = load("screens/BrowseScreens.tsx");
  const outer = kind === "create" ? browse.CreateScreen({ id: existingManual ? "resume" : undefined }) : browse.EventDetailScreen({ id: "event" });
  function render() { index = 0; tree = outer.type(outer.props); effects.splice(0).forEach(run => run()); flatten(tree); return tree; }
  render();
  return { app, render, sheets, react, focusCalls, viewports, listeners, mainFocus, blur: () => { focusCleanups.forEach(cleanup => cleanup()); focusCleanups.clear(); },
    all: () => flatten(tree), sheet: i => flatten(tree).filter(node => node.type === "UxModalSheet")[i],
    button: label => flatten(tree).find(node => ["Button", "TextButton", "Pressable", "Chip"].includes(node.type) && words(node) === label),
    field: label => flatten(tree).find(node => node.type === "Field" && node.props.label === label),
    callSheet(props, reset = true) { index = 0; if (reset) { slots.length = 0; focusCleanups.forEach(cleanup => cleanup()); focusCleanups.clear(); } const result = sheets.UxModalSheet(props); effects.splice(0).forEach(run => run()); return result; },
  };
}
function advance(h, index) { h.render(); h.sheet(index).props.onClosed(); h.render(); }
function show(h, index) { h.sheet(index).props.onShown(); h.render(); }
function enterManual(h) { const entry = h.button("행사 연결하기") || h.button("변경"); entry.props.onPress(); h.render(); show(h, 0); h.button("직접 입력").props.onPress(); advance(h, 0); show(h, 1); }

test("A back chain removes one layer at a time, restores exact controls and preserves unsaved manual values", () => {
  const h = harness("create", true); enterManual(h);
  h.field("행사명 *").props.onChangeText("이어쓴 행사"); h.render();
  h.field("장소명 (선택)").props.onChangeText("수정한 장소"); h.render();
  h.button("공개 행사장 주소 검색 (선택)").props.onPress(); h.render();
  assert.equal(h.sheet(1).props.visible, false); assert.equal(h.sheet(2).props.visible, false);
  advance(h, 1); show(h, 2); assert.equal(h.sheet(2).props.visible, true);
  h.sheet(2).props.onRequestClose(); advance(h, 2); show(h, 1);
  assert.equal(h.focusCalls.at(-1), "공개 행사장 주소 검색 (선택)");
  assert.equal(h.field("행사명 *").props.value, "이어쓴 행사");
  assert.equal(h.field("장소명 (선택)").props.value, "수정한 장소");
  assert.ok(h.all().some(node => node.props.accessibilityState?.checked === true));
  assert.ok(h.all().some(node => words(node) === "서울 성동구 공개 행사장"));
  assert.equal(h.button("닫기").props.onPress, h.sheet(1).props.onRequestClose);
  h.sheet(1).props.onRequestClose(); advance(h, 1); show(h, 0);
  assert.equal(h.focusCalls.at(-1), "직접 입력");
  h.button("직접 입력").props.onPress(); advance(h, 0); show(h, 1);
  assert.equal(h.field("행사명 *").props.value, "이어쓴 행사");
  assert.equal(h.field("공고 제목 *").props.value, "보존할 공고 제목");
  h.button("이 공고에 연결").props.onPress(); advance(h, 1);
  assert.equal(h.focusCalls.at(-1), "변경");
  assert.ok(h.all().some(node => node.props.value?.title === "이어쓴 행사"));
});

test("event close restores the post trigger and confirmed source connection resets stale manual editing context", () => {
  const h = harness("create", true); enterManual(h);
  h.field("행사명 *").props.onChangeText("미연결 편집"); h.render();
  h.sheet(1).props.onRequestClose(); advance(h, 1); show(h, 0);
  h.all().find(node => node.type === "Card" && words(node).includes("테스트 행사")).props.onPress(); advance(h, 0);
  assert.equal(h.focusCalls.at(-1), "변경");
  h.button("변경").props.onPress(); h.render(); show(h, 0);
  h.button("직접 입력").props.onPress(); advance(h, 0); show(h, 1);
  assert.equal(h.field("행사명 *").props.value, "");
  const fresh = harness(); enterManual(fresh); assert.equal(fresh.field("행사명 *").props.value, "");
});

test("event detail preview always uses all newest posts after returning from recruiting-only full list", () => {
  const h = harness("event");
  assert.deepEqual(h.all().filter(node => node.type === "PostCard").map(node => node.props.post.id), ["closed-newest"]);
  h.button("연결 공고 전체 보기").props.onPress(); h.render();
  h.button("모집 중").props.onPress(); h.render();
  assert.deepEqual(h.all().filter(node => node.type === "PostCard").map(node => node.props.post.id), ["recruiting-older"]);
  h.all().find(node => node.type === "Screen").props.onBack(); h.render();
  assert.deepEqual(h.all().filter(node => node.type === "PostCard").map(node => node.props.post.id), ["closed-newest"]);
});

test("modal lifecycle waits for actual close evidence, ignores obsolete events and cancels on route blur", () => {
  const { sheets } = harness(); const events = [];
  const lifecycle = sheets.createModalLifecycle({ shown: () => events.push("shown"), closed: () => events.push("closed") });
  lifecycle.didClose(); lifecycle.visibility(true); lifecycle.didShow(); lifecycle.visibility(false);
  assert.deepEqual(events, ["shown"]); lifecycle.didClose(); lifecycle.didClose(); assert.deepEqual(events, ["shown", "closed"]);
  lifecycle.visibility(true); lifecycle.didShow(); lifecycle.visibility(false); lifecycle.focus(false); lifecycle.didClose();
  assert.equal(events.filter(event => event === "closed").length, 1);
  lifecycle.focus(true); lifecycle.visibility(true); lifecycle.didShow(); lifecycle.visibility(false); lifecycle.visibility(true); lifecycle.didClose();
  assert.equal(events.filter(event => event === "closed").length, 1);
});

test("Android uses a bounded sibling overlay with its own viewport, safe area and hardware back", () => {
  const h = harness(); let closed = 0, back = 0, shown = 0;
  const props = { visible: true, onRequestClose() { back++; }, onShown() { shown++; }, onClosed() { closed++; }, children: "input" };
  const tree = h.callSheet(props);
  assert.notEqual(h.viewports.at(-1).focus, h.mainFocus);
  assert.equal(tree.type, "View"); assert.equal(tree.props.collapsable, false); assert.equal(tree.props.style.position, "absolute");
  assert.equal(tree.props.style.bottom, 0); assert.equal(tree.props.pointerEvents, "auto");
  assert.equal(flatten(tree).some(node => node.type === "Modal"), false);
  tree.props.onLayout(); tree.props.onLayout(); assert.equal(shown, 1);
  const provider = tree.props.children[0];
  assert.equal(provider.type, "UxFocusProvider");
  assert.equal(provider.props.children[0].type, "KeyboardAvoidingView");
  assert.equal(provider.props.children[0].props.behavior, "height");
  const scroll = flatten(tree).find(node => node.type === "ScrollView");
  assert.equal(scroll.props.ref, h.viewports.at(-1).ref);
  assert.equal(scroll.props.contentContainerStyle.at(-1).paddingBottom, 44);
  assert.equal(h.listeners.get("hardwareBackPress")(), true); assert.equal(back, 1);
  assert.equal(closed, 0);
  assert.equal(h.callSheet({ ...props, visible: false }, false), null);
  assert.equal(closed, 1); assert.equal(h.listeners.has("hardwareBackPress"), false);
  h.callSheet({ ...props, visible: false }, false); assert.equal(closed, 1);
});

test("late Android layout cannot enable hidden/blurred sheets or restore after a route blur", () => {
  const h = harness(); const enabled = []; let closed = 0;
  const focusController = { setEnabled: value => enabled.push(value), focusTarget() {} };
  const props = { visible: true, focusController, onRequestClose() {}, onClosed() { closed++; }, children: "input" };
  const shown = h.callSheet(props); shown.props.onLayout(); assert.equal(enabled.at(-1), true);
  h.callSheet({ ...props, visible: false }, false);
  assert.equal(enabled.at(-1), false); assert.equal(closed, 1);
  shown.props.onLayout(); assert.equal(enabled.at(-1), false); assert.equal(closed, 1);
  const next = h.callSheet(props, false); next.props.onLayout(); assert.equal(enabled.at(-1), true);
  h.blur(); assert.equal(enabled.at(-1), false); assert.equal(h.listeners.has("hardwareBackPress"), false);
  next.props.onLayout(); assert.equal(enabled.at(-1), false);
  assert.equal(h.callSheet(props, false), null);
  h.callSheet({ ...props, visible: false }, false); assert.equal(closed, 1);
});

test("a visible picker blocks underlying form touches and reader traversal outside the layer", () => {
  const h = harness(); h.button("행사 연결하기").props.onPress(); h.render();
  const wrapper = h.all().find(node => node.type === "View" && node.props.importantForAccessibility === "no-hide-descendants");
  assert.ok(wrapper); assert.equal(wrapper.props.collapsable, false); assert.equal(wrapper.props.pointerEvents, "none");
  assert.equal(wrapper.props.accessibilityElementsHidden, true);
  assert.equal(wrapper.props.children[0].type, "Screen");
  assert.equal(flatten(wrapper).some(node => node.type === "UxModalSheet"), false);
});

test("Android close before the first layout still advances after layer removal, without a timer", () => {
  const h = harness(); let closed = 0;
  const props = { visible: true, onRequestClose() {}, onClosed() { closed++; }, children: "input" };
  h.callSheet(props);
  assert.equal(h.callSheet({ ...props, visible: false }, false), null);
  assert.equal(closed, 1);
});

test("layer transitions keep the same non-flattening background boundary hidden through the removal commit", () => {
  const h = harness(); h.button("행사 연결하기").props.onPress(); h.render(); show(h, 0);
  h.button("직접 입력").props.onPress(); h.render();
  assert.equal(h.sheet(0).props.visible, false); assert.equal(h.sheet(1).props.visible, false);
  const hidden = h.all().find(node => node.type === "View" && node.props.importantForAccessibility === "no-hide-descendants");
  assert.ok(hidden); assert.equal(hidden.props.collapsable, false); assert.equal(hidden.props.pointerEvents, "none");
  advance(h, 0); show(h, 1);
  h.sheet(1).props.onRequestClose(); h.render();
  assert.ok(h.all().some(node => node.type === "View" && node.props.collapsable === false && node.props.importantForAccessibility === "no-hide-descendants"));
  advance(h, 1); show(h, 0); h.sheet(0).props.onRequestClose(); advance(h, 0);
  const restored = h.all().find(node => node.type === "View" && node.props.importantForAccessibility === "auto");
  assert.equal(restored.props.collapsable, false); assert.equal(restored.props.pointerEvents, "auto");
});
