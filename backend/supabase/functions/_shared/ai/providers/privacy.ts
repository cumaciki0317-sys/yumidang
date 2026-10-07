/** 검토된 개인정보 검사기를 주입하는 포트. 연락처 정규식만으로 실명·상세 주소 검사를 승인하지 않는다. */
export interface ApprovedPrivacyCheck {
  decisionId: string;
  /** false이면 전체 요청/답변을 차단한다. 원문을 잘라 보내거나 저장하지 않는다. */
  check(value: unknown): Promise<boolean>;
}
export class AiPrivacyError extends Error {
  readonly direction: "input" | "output";
  constructor(direction: "input" | "output") { super("AI_PRIVACY_BLOCKED"); this.direction = direction; }
}
/** 명백한 연락처 보조 검사. 이것만으로 의미 검사·운영 승인을 대신하지 않는다. */
export function containsContact(value: unknown): boolean {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return typeof text !== "string" || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.test(text) ||
      /(?:\+82[-\s]?)?0?1[016789][-\s]?\d{3,4}[-\s]?\d{4}/u.test(text);
  } catch { return true; } // 직렬화할 수 없는 입력도 개인정보 검사 실패로 처리한다.
}
export async function assertPrivacy(value: unknown, check: ApprovedPrivacyCheck, direction: "input" | "output") {
  if (!check || typeof check.decisionId !== "string" || !check.decisionId.trim() || typeof check.check !== "function") {
    throw new Error("PRIVACY_CHECK_NOT_APPROVED");
  }
  try {
    if (containsContact(value) || (await check.check(value)) !== true) throw new AiPrivacyError(direction);
  } catch { throw new AiPrivacyError(direction); }
}

/**
 * A안: 서버 검토에서 개인정보 없음이 확인된 문자열만 정확 일치로 허용한다.
 * DB 원문·요청 내용 자체를 승인 목록으로 사용하지 않는다. 이름/주소를 정규식으로 추측하지 않는다.
 * 운영 전송 승인은 별도이며 이 factory를 만드는 것만으로 runtime hold가 해제되지 않는다.
 */
export function createConservativePrivacyCheck(options: {
  decisionId: string; approvedStrings: readonly string[];
}): ApprovedPrivacyCheck {
  if (!options?.decisionId?.trim() || !Array.isArray(options.approvedStrings) ||
      options.approvedStrings.some(text => typeof text !== "string" || containsContact(text))) {
    throw new Error("PRIVACY_CHECK_NOT_APPROVED");
  }
  const approved = new Set(options.approvedStrings);
  function safe(value: unknown, ancestors = new Set<object>()): boolean {
    if (typeof value === "string") return approved.has(value) && !containsContact(value);
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (!value || typeof value !== "object" || ancestors.has(value)) return false;
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    if (Object.getOwnPropertySymbols(value).length) return false;
    const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
    // JSON wire와 검사 대상이 달라지는 toJSON/getter/숨은 속성/배열 여분 키를 허용하지 않는다.
    if (entries.some(([key, descriptor]) => !(Array.isArray(value) && key === "length") &&
        (!descriptor.enumerable || !Object.hasOwn(descriptor, "value"))) ||
        entries.some(([key]) => key === "toJSON")) return false;
    if (Array.isArray(value)) {
      if (entries.length !== value.length + 1 || entries.some(([key]) => key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key))) return false;
    } else if (!entries.every(([key]) => approved.has(key) && !containsContact(key))) return false;
    const nested = new Set(ancestors); nested.add(value);
    return entries.filter(([key]) => !Array.isArray(value) || key !== "length").every(([, descriptor]) => safe(descriptor.value, nested));
  }
  return { decisionId: options.decisionId, async check(value) {
    try { return safe(value); } catch { return false; }
  } };
}
