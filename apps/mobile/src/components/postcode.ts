import {
  KAKAO_POSTCODE_SCRIPT,
  normalizeKakaoPostalSelection,
  type PostalSelectedAddress,
} from "../../../../backend/supabase/functions/_shared/integrations/places/postal.ts";
import type { PlaceInputCandidate } from "../../../../backend/supabase/functions/_shared/integrations/places/port.ts";
import { normalizeMobileRegion } from "../service.ts";

export { KAKAO_POSTCODE_SCRIPT };
export interface SelectedPostalAddress extends PostalSelectedAddress {
  publicArea: string;
}
export interface PostcodePickerProps {
  onSelect: (selection: SelectedPostalAddress) => void;
  onCancel?: () => void;
}
export const POSTCODE_DOCUMENT_URL = "https://yumidang-postcode.invalid/";
const providerHosts = new Set(["postcode.map.kakao.com", "postcode.map.daum.net"]);
const fields = ["zonecode", "userSelectedType", "noSelected", "address", "roadAddress", "jibunAddress", "sido", "sigungu", "bname", "bname1"] as const;
export function selectPostalAddress(raw: unknown): SelectedPostalAddress {
  const selected = normalizeKakaoPostalSelection(raw);
  const source = raw as Record<string, unknown>;
  if (source.noSelected !== "N") throw new Error("POSTCODE_SELECTION_REQUIRED");
  if ([selected.address, selected.roadAddress, selected.jibunAddress].some((value) => value !== null && /\u007f/u.test(value))) throw new Error("POSTCODE_INVALID_ADDRESS");
  const region = normalizeMobileRegion(selected.region);
  const district = selected.district;
  const bname = selected.neighborhood || "";
  const township = source.bname1;
  const neighborhood = /^[가-힣0-9·]+(?:동|가)$/u.test(bname) ? bname
    : typeof township === "string" && /^[가-힣0-9·]+(?:읍|면)$/u.test(township) ? township : null;
  if (!region || !neighborhood ||
    (region === "세종특별자치시" ? district !== "" : !/^[가-힣0-9·]+(?:시|군|구)(?: [가-힣0-9·]+구)?$/u.test(district))) {
    throw new Error("POSTCODE_PUBLIC_AREA_UNAVAILABLE");
  }
  return { ...selected, publicArea: [region, district, neighborhood].filter(Boolean).join(" ") };
}
/** Compare official road/jibun values, never infer a dong from a street or building number. */
export function postalMatchesPlace(place: PlaceInputCandidate, selection: SelectedPostalAddress): boolean {
  const canonical = (value: string) => {
    const parts = value.trim().replace(/\s+/gu, " ").split(" ");
    try { parts[0] = normalizeMobileRegion(parts[0]) || parts[0]; } catch { return ""; }
    return parts.join(" ");
  };
  const candidates = [place.address, place.roadAddress].filter((v): v is string => !!v).map(canonical).filter(Boolean);
  return [selection.address, selection.roadAddress, selection.jibunAddress]
    .some((value) => value !== null && candidates.includes(canonical(value)));
}
export function isPostcodeDocument(url: string): boolean {
  return url === POSTCODE_DOCUMENT_URL || url === "about:blank";
}
export function isPostcodeFrame(url: string): boolean {
  if (isPostcodeDocument(url)) return true;
  try {
    const value = new URL(url);
    return value.protocol === "https:" && !value.username && !value.password &&
      value.port === "" && providerHosts.has(value.hostname);
  } catch { return false; }
}
export function readPostcodeMessage(message: string, origin: string, nonce: string): SelectedPostalAddress {
  const payload = readPostcodeBridgeMessage(message, origin, nonce);
  if (payload.kind !== "selected") throw new Error("POSTCODE_UNTRUSTED_MESSAGE");
  return payload.selection;
}
export function readPostcodeBridgeMessage(message: string, origin: string, nonce: string): { kind: "ready" | "error" } | { kind: "selected"; selection: SelectedPostalAddress } {
  if (!isPostcodeDocument(origin) || !/^[a-f0-9]{32}$/u.test(nonce) || message.length > 8192) throw new Error("POSTCODE_UNTRUSTED_MESSAGE");
  const payload = JSON.parse(message);
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
    payload.nonce !== nonce) throw new Error("POSTCODE_UNTRUSTED_MESSAGE");
  if (["ready", "error"].includes(payload.kind) && Object.keys(payload).sort().join(",") === "kind,nonce") return { kind: payload.kind };
  if (Object.keys(payload).sort().join(",") !== "data,kind,nonce" || payload.kind !== "selected" ||
    !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data) ||
    Object.keys(payload.data).some((key) => !(fields as readonly string[]).includes(key))) throw new Error("POSTCODE_UNTRUSTED_MESSAGE");
  return {kind: "selected", selection: selectPostalAddress(payload.data)};
}
/** Static local document: no auth/session/member fields enter the provider iframe or bridge. */
export function postcodeHtml(nonce: string): string {
  if (!/^[a-f0-9]{32}$/u.test(nonce)) throw new Error("POSTCODE_INVALID_NONCE");
  return `<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://t1.kakaocdn.net; style-src 'unsafe-inline'; frame-src https://postcode.map.kakao.com https://postcode.map.daum.net; img-src https://t1.kakaocdn.net data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><style>html,body,#postcode{margin:0;width:100%;height:100%;}body{font-family:sans-serif}</style></head><body><div id="postcode">주소 검색을 준비하고 있어요.</div><script nonce="${nonce}" src="${KAKAO_POSTCODE_SCRIPT}"></script><script nonce="${nonce}">(function(){var fields=${JSON.stringify(fields)};function state(kind){window.ReactNativeWebView.postMessage(JSON.stringify({kind:kind,nonce:'${nonce}'}));}if(!window.kakao||!window.kakao.Postcode){state('error');return;}try{new kakao.Postcode({width:'100%',height:'100%',autoMapping:false,oncomplete:function(raw){var data={};fields.forEach(function(key){if(typeof raw[key]==='string')data[key]=raw[key];});window.ReactNativeWebView.postMessage(JSON.stringify({kind:'selected',nonce:'${nonce}',data:data}));}}).embed(document.getElementById('postcode'));state('ready');}catch(_){state('error');}})();</script></body></html>`;
}
