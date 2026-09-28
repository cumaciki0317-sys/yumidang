/** 제공사별 실제 HTTP 형식은 미연결. 검증된 transport/정규화 함수를 주입한다. */
import type { EventFetchRequest, EventProviderPort, SourceEventRecord } from "./port.ts";
import { assertSourceEventRecord, queryPeriodInterval } from "./normalize.ts";

export interface EventProviderTransport<Raw> {
  fetchPage(request: EventFetchRequest): Promise<{ items: readonly Raw[]; nextCursor?: string }>;
}

export function createEventProviderAdapter<Raw>(options: {
  provider: string;
  transport: EventProviderTransport<Raw>;
  normalize: (raw: Raw, context: { provider: string; collectedAt: string }) => SourceEventRecord;
  now: () => Date;
}): EventProviderPort {
  if (!options.provider.trim()) throw new Error("INVALID_EVENT_PROVIDER");
  return {
    provider: options.provider,
    async fetchPage(request) {
      request.signal?.throwIfAborted();
      if (request.period) queryPeriodInterval(request.period);
      const page = await options.transport.fetchPage(request);
      request.signal?.throwIfAborted();
      const collectedAt = options.now().toISOString();
      const events = page.items.map((raw) => {
        const event = options.normalize(raw, { provider: options.provider, collectedAt });
        assertSourceEventRecord(event);
        if (event.provider !== options.provider || event.collectedAt !== collectedAt) {
          throw new Error("EVENT_PROVIDER_CONTEXT_MISMATCH");
        }
        return event;
      });
      return { events, ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}) };
    },
  };
}

/** 외부 문서·계정 확인 전에는 빈 배열로 성공을 가장하지 않는다. */
export function unconfiguredEventProvider(provider: string): EventProviderPort {
  return { provider, async fetchPage() { throw new Error("EVENT_PROVIDER_NOT_CONFIGURED"); } };
}
