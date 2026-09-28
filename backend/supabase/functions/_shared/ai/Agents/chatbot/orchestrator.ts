import type { AiChatResult, ChatInput, ChatLimits, TrustedChatContext } from "../../../contracts/ai.ts";
import type { ModelPort } from "../../providers/model-port.ts";
import { buildContext } from "./context.ts";
import { parseIntent, validateFilters } from "./intent.ts";
import { resolveDateRange } from "./date-range.ts";
import { INTENT_PROMPT, EXPLANATION_PROMPT } from "./prompts.ts";
import type { PublicDiscoveryPort } from "./tools.ts";
import { projectCards } from "./result-builder.ts";
import { checkExplanations, type ExplanationCheck } from "./output-check.ts";
export interface ChatDependencies { model: ModelPort; discovery: PublicDiscoveryPort; limits: ChatLimits; now: () => Date; verifyExplanation?: ExplanationCheck; }
export async function runChat(input: ChatInput, principal: TrustedChatContext, deps: ChatDependencies, requestId: string, signal?: AbortSignal): Promise<AiChatResult> {
  // 인증된 공통 서버 계층이 전달한 주체만 사용한다. 클라이언트 본문은 인증 근거가 아니다.
  if(!principal?.userId) throw new Error("UNAUTHENTICATED");
  if (!input || typeof input !== "object") throw new Error("INVALID_INPUT");
  const initial=validateFilters(input.currentFilters);
  const base: AiChatResult={requestId,status:"unavailable",interpretedFilters:initial,cards:[],explanations:[]};
  let context;
  try { context=buildContext(input,principal,deps.limits); }
  catch(error) {
    if(error instanceof Error && error.message==="NEW_EXPLORATION_REQUIRED") return {...base,status:"needs_clarification",clarificationQuestion:"확정한 조건을 유지한 채 새 탐색을 시작할까요?",notice:"대화 길이 한도에 도달했습니다."};
    throw error;
  }
  const checkCancelled=()=>{if(signal?.aborted) throw new Error("CANCELLED");};
  try {
    checkCancelled(); const now=deps.now();
    const interpreted=await deps.model.generate({task:"intent",system:INTENT_PROMPT,input:{...context,referenceTime:now.toISOString(),timeZone:"Asia/Seoul"},maxOutputTokens:deps.limits.maxOutputTokens,signal});
    checkCancelled(); const intent=parseIntent(interpreted.value); base.interpretedFilters=intent.filters;
    if(intent.status==="clarify") return {...base,status:"needs_clarification",clarificationQuestion:intent.question};
    const period=resolveDateRange(intent.filters.date,now);
    const cards=projectCards(await deps.discovery.search({principal,filters:intent.filters,period,now,signal}),intent.filters);
    checkCancelled();
    if(!cards.length) return {...base,status:"no_results",notice:"조건에 맞는 결과가 없습니다. 조건을 변경해 다시 찾아보세요."};
    let explanations: AiChatResult["explanations"]=[];
    let notice="검색 결과를 확인해주세요.";
    if(deps.verifyExplanation) {
      try {
        const response=await deps.model.generate({task:"explanation",system:EXPLANATION_PROMPT,input:{cards},maxOutputTokens:deps.limits.maxOutputTokens,signal});
        explanations=await checkExplanations(response.value,cards,deps.verifyExplanation); notice="";
      } catch { notice="설명을 만들지 못했습니다. 검색 결과를 확인해주세요."; }
    }
    checkCancelled();
    const allowed=new Map(cards.map(c=>[`${c.kind}:${c.id}`,JSON.stringify(c)]));
    const refreshed=projectCards(await deps.discovery.recheck({principal,filters:intent.filters,period,now,cards:cards.map(c=>({kind:c.kind,id:c.id})),signal}),intent.filters);
    // 재조회로 새 ID가 섞이면 반환하지 않으며 변경된 카드의 옛 설명도 제거한다.
    if(refreshed.some(c=>!allowed.has(`${c.kind}:${c.id}`))) throw new Error("INVALID_RECHECK");
    const order=new Map(cards.map((c,i)=>[`${c.kind}:${c.id}`,i]));
    refreshed.sort((a,b)=>order.get(`${a.kind}:${a.id}`)!-order.get(`${b.kind}:${b.id}`)!);
    const fresh=new Map(refreshed.map(c=>[`${c.kind}:${c.id}`,JSON.stringify(c)]));
    explanations=explanations.filter(e=>fresh.get(`${e.kind}:${e.id}`)===allowed.get(`${e.kind}:${e.id}`));
    checkCancelled();
    return {...base,status:refreshed.length ? "results":"no_results",cards:refreshed,explanations,notice:refreshed.some(c=>c.preferenceMatch==="missing") ? "성향 미입력 공고는 확인이 필요합니다." : notice};
  } catch { return {...base,status:"unavailable",notice:"탐색을 완료하지 못했습니다. 다시 시도하거나 일반 탐색을 이용해주세요."}; }
}
