// Isolated presentation regression checks with RN primitives mocked; not device/browser evidence.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";

const appRoot = path.resolve(import.meta.dirname, "../../apps/mobile");
const requireApp = createRequire(path.join(appRoot, "package.json"));
const ts = requireApp("typescript");
const sourceRoot = path.join(appRoot, "src/presentation/events");
let state = false;
const react = {
  createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
  useState(initial) { return [state || initial, (next) => { state = next; }]; },
};
const ui = Object.fromEntries(["Badge", "Body", "Card", "Row", "Title"].map((name) => [name, name]));
ui.colors = { ink: "#202034" };
function load(file) {
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(path.join(sourceRoot, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(compiled, {
    exports, Intl, Date,
    require(id) {
      if (id === "react") return react;
      if (id === "react-native") return { Image: "Image", Text: "Text", View: "View" };
      if (id === "../../ui") return ui;
      if (id === "./event-display") return load("event-display.ts");
      throw new Error(`Unexpected dependency: ${id}`);
    },
  });
  return exports;
}
const { EventPoster, EventListCard, EventDetailContent } = load("EventPresentation.tsx");
const fixture = {
  title: "긴 행사명 전체가 상세에서는 생략되지 않아야 하는 합성 행사",
  category: "뮤지컬", region: "서울", placeName: "문화센터", publicAddress: null,
  state: "upcoming", sourceStatus: "active", admission: { kind: "unknown" },
  provider: "kopis", collectedAt: "2026-10-20T00:00:00Z",
  precision: "date", startsOn: "2026-10-24", endsOn: "2026-10-25",
};
const children = (element) => element.props.children.filter((value) => value && typeof value === "object");
const text = (element) => typeof element === "string" ? element : element?.props?.children?.map(text).join("") ?? "";

test("missing and failed posters remove the entire image node; available poster uses contain", () => {
  state = false;
  assert.equal(EventPoster({ title: "행사" }), null);
  const wrapper = EventPoster({ uri: "https://image.invalid/poster.jpg", title: "행사" });
  const image = wrapper.type(wrapper.props);
  assert.equal(image.props.resizeMode, "contain");
  image.props.onError();
  assert.equal(wrapper.type(wrapper.props), null);
  state = false;
});

test("list title is limited to two lines and opening card is delegated to its callback", () => {
  let opened = false;
  const card = EventListCard({ event: fixture, onPress: () => { opened = true; } });
  const title = children(card).find((item) => item.type === "Text");
  assert.equal(title.props.numberOfLines, 2);
  assert.equal(title.props.ellipsizeMode, "tail");
  card.props.onPress();
  assert.equal(opened, true);
});

test("detail preserves full title, raw complex fee and explicit missing basic information", () => {
  const detail = EventDetailContent({ event: { ...fixture, admission: { kind: "described", text: "성인 10,000원·청소년 5,000원" } } });
  const title = children(detail)[0];
  assert.equal(title.props.numberOfLines, undefined);
  assert.equal(text(title), fixture.title);
  assert.ok(text(detail).includes("성인 10,000원·청소년 5,000원"));
  assert.ok(text(detail).includes("주소 정보 없음"));
  assert.ok(text(detail).includes("시간 정보 없음"));
});

test("confirmed cancellation explains that companion plans are not automatically cancelled", () => {
  const detail = EventDetailContent({ event: { ...fixture, sourceStatus: "cancelled" } });
  assert.ok(text(detail).includes("동행 약속은 자동으로 취소되지 않아요"));
  const unknown = EventDetailContent({ event: { ...fixture, sourceStatus: "unknown" } });
  assert.ok(!text(unknown).includes("이 행사는 취소되었습니다"));
});

test("cards display real provider names and explicitly free described fees", () => {
  const tour = EventListCard({ event: { ...fixture, provider: "tour-api", admission: { kind: "described", text: "무료" } }, onPress() {} });
  assert.ok(text(tour).includes("출처: 한국관광공사 TourAPI"));
  assert.ok(text(tour).includes("무료"));
  assert.ok(!text(tour).includes("요금 상세 확인"));
  const seoul = EventListCard({ event: { ...fixture, provider: "seoul-open-data", admission: { kind: "described", text: "무료(체험 유료)" } }, onPress() {} });
  assert.ok(text(seoul).includes("출처: 서울 열린데이터"));
  assert.ok(text(seoul).includes("요금 상세 확인"));
});
