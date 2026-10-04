/** 카카오 우편번호 JS oncomplete의 실제 선택만 정규화. 서버 REST 공급사로 가장하지 않는다.
 * https://postcode.map.kakao.com/guide
 */
import { PlaceLookupError } from "./port.ts";
export const KAKAO_POSTCODE_SCRIPT =
  "https://t1.kakaocdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
export interface PostalSelectedAddress {
  source: "kakao-postcode";
  postalCode: string;
  addressType: "road" | "jibun";
  address: string;
  roadAddress: string | null;
  jibunAddress: string | null;
  region: string;
  district: string;
  neighborhood: string | null;
}
/** 이 값은 공고 작성 입력이며 공개 카드의 주소 범위를 뜻하지 않는다. GPS·인증정보는 담지 않는다. */
export function normalizeKakaoPostalSelection(
  raw: unknown,
): PostalSelectedAddress {
  const bad = (): never => {
    throw new PlaceLookupError("SOURCE_INVALID_RESPONSE");
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad();
  const value = raw as Record<string, unknown>;
  const text = (key: string, optional = false): string | null => {
    const v = value[key];
    if (optional && (v === undefined || v === "")) return null;
    if (
      typeof v !== "string" || !v.trim() || v.length > 300 ||
      /[<>\u0000-\u001f]/u.test(v)
    ) return bad();
    return v.trim();
  };
  if (
    value.noSelected === "Y" ||
    !["R", "J"].includes(value.userSelectedType as string) ||
    typeof value.zonecode !== "string" || !/^\d{5}$/.test(value.zonecode)
  ) return bad();
  const roadAddress = text("roadAddress", true),
    jibunAddress = text("jibunAddress", true);
  text("address"); // 기본 첫 줄은 안전 문자만 검사하고 실제 선택 주소와 같다고 가정하지 않는다.
  const address = value.userSelectedType === "R" ? roadAddress : jibunAddress;
  if (!address) return bad();
  const region = text("sido")!;
  const district =
    ["세종", "세종특별자치시"].includes(region) && value.sigungu === ""
      ? ""
      : text("sigungu")!;
  return {
    source: "kakao-postcode",
    postalCode: value.zonecode,
    addressType: value.userSelectedType === "R" ? "road" : "jibun",
    address,
    roadAddress,
    jibunAddress,
    region,
    district,
    neighborhood: text("bname", true),
  };
}
