import type { AiCard } from "../../../contracts/ai.ts";
export type ExplanationCheck = (text: string, card: AiCard) => Promise<boolean>;
/** 구조·ID 검사와 의미 검사를 분리한다. 실제 의미 검사기 없이 생성 설명을 노출하지 않는다. */
export async function checkExplanations(raw: unknown, cards: AiCard[], verify: ExplanationCheck): Promise<{kind:AiCard["kind"];id:string;text:string}[]> {
  if(!raw || typeof raw!=="object" || Array.isArray(raw) || Object.keys(raw).some(key => key !== "explanations") || !Array.isArray((raw as {explanations?:unknown}).explanations)) throw new Error("INVALID_EXPLANATION");
  const rows=(raw as {explanations:unknown[]}).explanations;
  const seen=new Set<string>(); const result: {kind:AiCard["kind"];id:string;text:string}[]=[];
  for(const row of rows) {
    if(!row || typeof row!=="object" || Array.isArray(row) || Object.keys(row).length !== 3 || Object.keys(row).some(key => !["kind", "id", "text"].includes(key))) throw new Error("INVALID_EXPLANATION");
    const v=row as Record<string,unknown>; const card=cards.find(c=>c.id===v.id && c.kind===v.kind);
    const key=`${v.kind}:${v.id}`;
    if(!card || seen.has(key) || typeof v.text!=="string" || !v.text.trim() || !await verify(v.text,card)) throw new Error("INVALID_EXPLANATION");
    seen.add(key); result.push({kind:card.kind,id:card.id,text:v.text});
  }
  return result;
}

/** A안: 카드의 한 공개 필드만 그대로 인용한다. 덧붙인 평가·추천·안전 보장은 거절한다. */
export const conservativeExplanationCheck: ExplanationCheck = async (text, card) => {
  if (typeof text !== "string" || !text.trim()) return false;
  const { containsContact } = await import("../../providers/privacy.ts");
  if (containsContact(text) || /(?:100\s*%|절대적으로|무조건)\s*(?:안전|신뢰)/u.test(text)) return false;
  return [card.title, card.locationLabel, card.startsAtOrDate, card.endsAtOrDate,
    card.costLabel, card.state, card.sourceName].some(value => typeof value === "string" && value === text);
};
