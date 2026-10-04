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
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return typeof text !== "string" || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u.test(text) ||
    /(?:\+82[-\s]?)?0?1[016789][-\s]?\d{3,4}[-\s]?\d{4}/u.test(text);
}
export async function assertPrivacy(value: unknown, check: ApprovedPrivacyCheck, direction: "input" | "output") {
  if (!check || typeof check.decisionId !== "string" || !check.decisionId.trim() || typeof check.check !== "function") {
    throw new Error("PRIVACY_CHECK_NOT_APPROVED");
  }
  if (containsContact(value) || (await check.check(value)) !== true) throw new AiPrivacyError(direction);
}
