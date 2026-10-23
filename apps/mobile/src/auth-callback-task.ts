/** One callback exchange survives an immediate effect replay; departing screens receive nothing. */
export function createAuthCallbackTask<T>(start: (signal: AbortSignal) => Promise<T>) {
  const controller = new AbortController();
  type Listener = { success: (value: T) => void; failure: (error: unknown) => void };
  const listeners = new Set<Listener>();
  let pending: Promise<T> | null = null;
  return {
    subscribe(success: Listener["success"], failure: Listener["failure"]) {
      const listener = { success, failure };
      listeners.add(listener);
      pending ??= Promise.resolve().then(() => {
        if (listeners.size === 0 || controller.signal.aborted) {
          controller.abort(); throw new DOMException("Callback abandoned", "AbortError");
        }
        return start(controller.signal);
      });
      void pending.then(value => {
        if (listeners.has(listener) && !controller.signal.aborted) {
          try { success(value); } catch (error) { failure(error); }
        }
      }, error => { if (listeners.has(listener) && !controller.signal.aborted) failure(error); });
      return () => {
        listeners.delete(listener);
        queueMicrotask(() => { if (listeners.size === 0) controller.abort(); });
      };
    },
  };
}
