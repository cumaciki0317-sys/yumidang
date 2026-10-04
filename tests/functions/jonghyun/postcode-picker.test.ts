import assert from "node:assert/strict";
import test from "node:test";
import { isPostcodeDocument, isPostcodeFrame, postcodeHtml, POSTCODE_DOCUMENT_URL, postalMatchesPlace, readPostcodeBridgeMessage, readPostcodeMessage, selectPostalAddress } from "../../../apps/mobile/src/components/postcode.ts";

const nonce = "0123456789abcdef0123456789abcdef";
const raw = {
  zonecode: "13529", noSelected: "N", userSelectedType: "R",
  address: "경기 성남시 분당구 판교역로 166",
  roadAddress: "경기 성남시 분당구 판교역로 166",
  jibunAddress: "경기 성남시 분당구 백현동 532",
  sido: "경기", sigungu: "성남시 분당구", bname: "백현동", bname1: "",
};
const message = (data: unknown = raw) => JSON.stringify({kind: "selected", nonce, data});
test("official callback fields yield dong-only public area and separate exact address", () => {
  const chosen = selectPostalAddress(raw);
  assert.equal(chosen.publicArea, "경기도 성남시 분당구 백현동");
  assert.equal(chosen.address, raw.roadAddress);
  assert.equal(chosen.postalCode, "13529");
  assert.ok(!chosen.publicArea.includes("166"));
});
test("userSelectedType determines chosen address when default first row differs", () => {
  const selected = selectPostalAddress({...raw, userSelectedType: "J"});
  assert.equal(selected.address, raw.jibunAddress);
});
test("Sejong supports official empty sigungu but other provinces fail closed", () => {
  const chosen = selectPostalAddress({...raw, sido: "세종특별자치시", sigungu: "", bname: "나성동"});
  assert.equal(chosen.publicArea, "세종특별자치시 나성동");
  assert.throws(() => selectPostalAddress({...raw, sigungu: ""}));
  assert.throws(() => selectPostalAddress({...raw, sido: "세종특별자치시", sigungu: undefined}));
});
test("rural public area uses official bname1 eup/myeon and never infers from address text", () => {
  assert.equal(selectPostalAddress({...raw, sido: "강원특별자치도", sigungu: "평창군", bname: "횡계리", bname1: "대관령면"}).publicArea, "강원특별자치도 평창군 대관령면");
  assert.throws(() => selectPostalAddress({...raw, bname: "횡계리", bname1: ""}));
  assert.throws(() => selectPostalAddress({...raw, bname: "", bname1: ""}));
});
test("unselected mappings, unknown province, HTML and control fields are rejected", () => {
  for (const change of [{noSelected: "Y"}, {noSelected: undefined}, {sido: "unknown"}, {bname: "<동>"}, {sigungu: "종로구\n"}, {bname: "횡계리", bname1: "대관령면\n"}]) {
    assert.throws(() => selectPostalAddress({...raw, ...change}));
  }
});
test("place matching compares exact official road/jibun values with only province/space normalization", () => {
  const place = {source: "kakao" as const, sourceId: "1", placeName: "아지트", address: null, roadAddress: "경기도  성남시 분당구 판교역로 166"};
  assert.equal(postalMatchesPlace(place, selectPostalAddress(raw)), true);
  assert.equal(postalMatchesPlace({...place, roadAddress: "경기 성남시 분당구 판교역로 168"}, selectPostalAddress(raw)), false);
  assert.equal(postalMatchesPlace({...place, roadAddress: null}, selectPostalAddress(raw)), false);
});
test("native bridge requires document origin, fresh nonce and exact non-sensitive envelope", () => {
  assert.equal(readPostcodeMessage(message(), POSTCODE_DOCUMENT_URL, nonce).publicArea, "경기도 성남시 분당구 백현동");
  for (const origin of ["https://postcode.map.kakao.com/", "https://evil.invalid", "file:///tmp/page.html"]) assert.throws(() => readPostcodeMessage(message(), origin, nonce));
  assert.throws(() => readPostcodeMessage(message(), POSTCODE_DOCUMENT_URL, "f".repeat(32)));
  assert.throws(() => readPostcodeMessage(message({...raw, accessToken: "fake"}), POSTCODE_DOCUMENT_URL, nonce));
  assert.throws(() => readPostcodeMessage(JSON.stringify({kind:"selected",nonce,data:raw, extra:true}), POSTCODE_DOCUMENT_URL, nonce));
  assert.throws(() => readPostcodeMessage("x".repeat(8193), POSTCODE_DOCUMENT_URL, nonce));
  assert.throws(() => readPostcodeMessage("{}", POSTCODE_DOCUMENT_URL, nonce));
  assert.deepEqual(readPostcodeBridgeMessage(JSON.stringify({kind:"ready",nonce}), POSTCODE_DOCUMENT_URL, nonce), {kind:"ready"});
  assert.throws(() => readPostcodeBridgeMessage(JSON.stringify({kind:"ready",nonce,data:{}}), POSTCODE_DOCUMENT_URL, nonce));
});
test("navigation allows only local document and exact HTTPS provider frames", () => {
  assert.equal(isPostcodeDocument(POSTCODE_DOCUMENT_URL), true);
  assert.equal(isPostcodeDocument("about:blank"), true);
  assert.equal(isPostcodeFrame("https://postcode.map.kakao.com/search"), true);
  for (const url of ["http://postcode.map.kakao.com/", "https://user@postcode.map.kakao.com/", "https://postcode.map.kakao.com.evil.invalid/", "https://postcode.map.kakao.com:444/", "javascript:alert(1)"]) assert.equal(isPostcodeFrame(url), false);
});
test("native static HTML uses official embed, strict projected callback and nonce CSP", () => {
  const html = postcodeHtml(nonce);
  assert.ok(html.includes("https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js"));
  assert.ok(html.includes(".embed(")); assert.ok(html.includes("autoMapping:false"));
  assert.ok(html.includes(`'nonce-${nonce}'`));
  assert.equal(html.includes("accessToken"), false); assert.equal(html.includes(".open("), false);
  assert.throws(() => postcodeHtml("unsafe'"));
});
