import type { AiCard } from "../../../contracts/ai.ts";
export type ExplanationCheck = (text: string, card: AiCard) => Promise<boolean>;
/** 구조·ID 검사와 의미 검사를 분리한다. 실제 의미 검사기 없이 생성 설명을 노출하지 않는다. */
export async function checkExplanations(raw: unknown, cards: AiCard[], verify: ExplanationCheck): Promise<{kind:AiCard["kind"];id:string;text:string}[]> {
  if(!raw || typeof raw!=="object" || !Array.isArray((raw as {explanations?:unknown}).explanations)) throw new Error("INVALID_EXPLANATION");
  const rows=(raw as {explanations:unknown[]}).explanations;
  const seen=new Set<string>(); const result: {kind:AiCard["kind"];id:string;text:string}[]=[];
  for(const row of rows) {
    if(!row || typeof row!=="object") throw new Error("INVALID_EXPLANATION");
    const v=row as Record<string,unknown>; const card=cards.find(c=>c.id===v.id && c.kind===v.kind);
    const key=`${v.kind}:${v.id}`;
    if(!card || seen.has(key) || typeof v.text!=="string" || !v.text.trim() || !await verify(v.text,card)) throw new Error("INVALID_EXPLANATION");
    seen.add(key); result.push({kind:card.kind,id:card.id,text:v.text});
  }
  return result;
}
