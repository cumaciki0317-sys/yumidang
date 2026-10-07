/** 서버 recorder의 선택 연결. sink 응답은 제품 실행을 지연시키지 않으며 원문/회원 ID는 받지 않는다. */
import type { MetricsRecorder, MetricResultCode, MetricSpan } from "../../observability/metrics.ts";
import type { ModelResponse } from "./model-port.ts";
export function beginAiObservation(recorder: MetricsRecorder | undefined, feature: "ai_chat" | "review_summary", promptVersion?: string) {
  let span: MetricSpan | undefined;
  try { span = recorder?.begin(feature); } catch { /* 관측 시작 실패는 제품 실패가 아니다. */ }
  let modelVersion: string | undefined, calls = 0, unknown = false, mixedModels = false, inputTokens = 0, outputTokens = 0, finished = false;
  return {
    response(response: ModelResponse) {
      calls++;
      if (typeof response?.modelVersion !== "string" || !response.modelVersion.trim()) { unknown = true; return; }
      if (modelVersion && modelVersion !== response.modelVersion) { unknown = true; mixedModels = true; }
      modelVersion ??= response.modelVersion;
      const usage = response.usage;
      if (!usage || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) { unknown = true; return; }
      inputTokens += usage.inputTokens; outputTokens += usage.outputTokens;
      if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) unknown = true;
    },
    /** 응답 없이 끝난 모델 호출의 비용을 0으로 추정하지 않는다. */
    modelUnknown() { unknown = true; },
    finish(resultCode: MetricResultCode) {
      if (finished || !span) return; finished = true;
      try {
        // 이 wrapper 자체는 재전송하지 않는다. provider 내부 재시도 횟수로 해석하지 않는다.
        void Promise.resolve(span.finish({ resultCode, retryCount: 0,
          ...(modelVersion && !mixedModels ? { modelVersion } : {}), ...(promptVersion ? { promptVersion } : {}),
          ...(calls > 0 && !unknown ? { usage: { inputTokens, outputTokens } } : {}),
        })).catch(() => {});
      } catch { /* 주입 sink의 동기 예외도 제품에 전달하지 않는다. */ }
    },
  };
}
