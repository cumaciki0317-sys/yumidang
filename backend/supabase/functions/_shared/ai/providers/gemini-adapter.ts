/** 민규: Gemini GenerateContent text1후보 전용 포트. 제품 runtime에는 연결하지 않는다.
 * 공식 계약: https://ai.google.dev/api/generate-content
 * maxOutputTokens는 thinking 포함: https://ai.google.dev/gemini-api/docs/generate-content/thinking
 * usage의 prompt 부분에는 cache가 포함되므로 중복 합산하지 않는다. 원문/키는 오류에 넣지 않는다.
 */
import type { ModelPort, ModelResponse, ModelUsage } from './model-port.ts';
import { ModelError } from './provider-errors.ts';
import { parseStructuredMessage, type FetchLike } from './potens-adapter.ts';

export interface GeminiAdapterConfig {
  apiKey: string;
  model: 'gemini-3.5-flash-lite';
  timeoutMs: number;
  fetch: FetchLike;
}
const origin = 'https://generativelanguage.googleapis.com';
const limits = { intent: 800, preference_match: 600, explanation: 800, review_chunk: 800, review_merge: 800 } as const;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function usageOf(raw: unknown): ModelUsage | null {
  if (!object(raw)) return null;
  const prompt = raw.promptTokenCount, candidates = raw.candidatesTokenCount, total = raw.totalTokenCount;
  if (!integer(prompt) || !integer(candidates) || !integer(total) || total < prompt || total - prompt < candidates) return null;
  if (raw.thoughtsTokenCount !== undefined && (!integer(raw.thoughtsTokenCount) || !Number.isSafeInteger(prompt + candidates + raw.thoughtsTokenCount) || total !== prompt + candidates + raw.thoughtsTokenCount)) return null;
  if (raw.thoughtsTokenCount === undefined && total - prompt !== candidates) return null;
  if (raw.cachedContentTokenCount !== undefined && (!integer(raw.cachedContentTokenCount) || raw.cachedContentTokenCount > prompt)) return null;
  // tools를 보내지 않는 계약이다. 그 외 과금 모드가 관측되면 추정 정산하지 않는다.
  if (raw.toolUsePromptTokenCount !== undefined && raw.toolUsePromptTokenCount !== 0) return null;
  return { inputTokens: prompt, outputTokens: total - prompt };
}

export function createGeminiModel(config: GeminiAdapterConfig): ModelPort {
  if (!config || typeof config.apiKey !== 'string' || !config.apiKey || /[\s\u0000-\u001f\u007f]/u.test(config.apiKey) || config.model !== 'gemini-3.5-flash-lite' ||
      !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647 || typeof config.fetch !== 'function') throw new ModelError('NOT_CONFIGURED');
  const { apiKey, model, timeoutMs, fetch: transport } = config;
  const endpoint = `${origin}/v1beta/models/${model}:generateContent`;
  return { async generate(request): Promise<ModelResponse> {
    const { signal, maxOutputTokens } = request;
    if (signal?.aborted) throw new ModelError('CANCELLED', { dispatchState: 'not_sent' });
    let body: string;
    try {
      if (!Object.hasOwn(limits, request.task) || !integer(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > limits[request.task] || typeof request.system !== 'string') throw new Error();
      const input = JSON.stringify(request.input);
      if (typeof input !== 'string') throw new Error();
      body = JSON.stringify({ systemInstruction: { parts: [{ text: request.system }] }, contents: [{ role: 'user', parts: [{ text: input }] }],
        generationConfig: { candidateCount: 1, maxOutputTokens: maxOutputTokens, responseMimeType: 'application/json' } });
      if (new TextEncoder().encode(body).byteLength > 65_536) throw new Error();
    } catch { throw new ModelError('INVALID_MODEL_RESPONSE', { dispatchState: 'not_sent' }); }
    const controller = new AbortController(), deadline = performance.now() + timeoutMs;
    let dispatchState: 'not_sent' | 'sent' = 'not_sent', usage: ModelUsage | null = null;
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let stopped: ModelError | undefined, finished = false;
    let rejectWait!: (error: ModelError) => void;
    const waitFailure = new Promise<never>((_, reject) => { rejectWait = reject; });
    const cancelBody = () => { try { const pending = reader ? reader.cancel() : response?.body?.cancel(); if (pending) void pending.catch(() => {}); } catch { /* 실제 공급사 중단/환불을 주장하지 않는다. */ } };
    const stop = (code: 'TIMEOUT' | 'CANCELLED') => {
      if (finished || stopped) return;
      stopped = new ModelError(code, { dispatchState, usage }); controller.abort(); cancelBody(); rejectWait(stopped);
    };
    const cancel = () => stop('CANCELLED');
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    const check = () => { if (signal?.aborted) stop('CANCELLED'); if (performance.now() >= deadline) stop('TIMEOUT'); if (stopped) throw stopped; };
    try {
      const pending = Promise.resolve().then(() => {
        check(); dispatchState = 'sent';
        return transport(endpoint, { method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      });
      void pending.then(late => { if (finished || stopped) { try { void late.body?.cancel().catch(() => {}); } catch { /* 늦은 응답 원문은 사용하지 않는다. */ } } }, () => {});
      try { response = await Promise.race([pending, waitFailure]); check(); }
      catch { check(); throw new ModelError('MODEL_UNAVAILABLE'); }
      if (response.redirected || (response.url && response.url !== endpoint)) throw new ModelError('PROVIDER_REJECTED');
      if (response.status === 429) throw new ModelError('RATE_LIMITED');
      if (response.status >= 500) throw new ModelError('MODEL_UNAVAILABLE');
      if (response.status !== 200) throw new ModelError('PROVIDER_REJECTED');
      let payload: unknown;
      try {
        reader = response.body?.getReader(); if (!reader) throw new Error();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          check(); const next = await Promise.race([reader.read(), waitFailure]); check(); if (next.done) break;
          size += next.value.byteLength; if (size > 1_048_576) throw new Error(); chunks.push(next.value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); check();
      } catch { check(); throw new ModelError('INVALID_MODEL_RESPONSE'); }
      if (!object(payload)) throw new ModelError('INVALID_MODEL_RESPONSE');
      usage = usageOf(payload.usageMetadata); // STOP/JSON 판정에 앞서 확인된 소비량을 유지한다.
      if (usage && usage.outputTokens > maxOutputTokens) throw new ModelError('INVALID_MODEL_RESPONSE');
      if (!Array.isArray(payload.candidates) || payload.candidates.length !== 1 || !object(payload.candidates[0])) throw new ModelError('INVALID_MODEL_RESPONSE');
      const candidate = payload.candidates[0];
      if (candidate.finishReason !== 'STOP' || !object(candidate.content) || !Array.isArray(candidate.content.parts) || !candidate.content.parts.length) throw new ModelError('INVALID_MODEL_RESPONSE');
      const texts: string[] = [];
      for (const part of candidate.content.parts) {
        if (!object(part) || typeof part.text !== 'string' || part.thought === true || Object.keys(part).some(name => !['text','thought','thoughtSignature'].includes(name))) throw new ModelError('INVALID_MODEL_RESPONSE');
        texts.push(part.text);
      }
      const value = parseStructuredMessage(texts.join(''));
      const reportedModel = typeof payload.modelVersion === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(payload.modelVersion) ? payload.modelVersion : undefined;
      check(); return { value, usage, modelVersion: `gemini.${model}`, ...(reportedModel ? { reportedModel } : {}) };
    } catch (error) {
      if (signal?.aborted) stop('CANCELLED'); if (performance.now() >= deadline) stop('TIMEOUT');
      throw new ModelError(stopped?.code ?? (error instanceof ModelError ? error.code : 'MODEL_UNAVAILABLE'), { dispatchState, usage });
    } finally {
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); controller.abort(); cancelBody();
      try { reader?.releaseLock(); } catch { /* 종료 중 read가 끝나지 않았으면 잠금 해제를 주장하지 않는다. */ }
    }
  } };
}
