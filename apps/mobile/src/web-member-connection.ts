import type { WebSessionOptions } from "./web-member-session";
/** Trusted host supplies reviewed deployment values. No URL, Origin, key, or token is inferred. */
let configuration: WebSessionOptions | null = null;
const listeners = new Set<() => void>();
export type WebMemberConnectionStatus = "unconfigured" | "pending" | "installed" | "invalid";
let connectionStatus: WebMemberConnectionStatus = "unconfigured";
const statusListeners = new Set<() => void>();
export const webMemberConnectionStatus = () => connectionStatus;
export function subscribeWebMemberConnectionStatus(listener: () => void) {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}
/** Installation status only; installed never means an authenticated member. */
export function reportWebMemberConnectionStatus(status: WebMemberConnectionStatus) {
  if (connectionStatus === status) return;
  connectionStatus = status;
  statusListeners.forEach(listener => listener());
}
export function configureWebMemberConnection(options: WebSessionOptions | null) {
  const changed = configuration !== options;
  configuration = options;
  if (changed) reportWebMemberConnectionStatus(options ? "pending" : "unconfigured");
  listeners.forEach(listener => listener());
}
export const webMemberConfiguration = () => configuration;
export function subscribeWebMemberConfiguration(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Component-local lease: StrictMode's immediate replay reuses the installed port.
 * Real departure disposes after the current effect turn; replacement disposes immediately.
 */
export function createWebMemberConnectionLease(install: (options: WebSessionOptions) => void, dispose: () => void, report: (status: WebMemberConnectionStatus) => void = () => {}) {
  let current: WebSessionOptions | null = null;
  let installed = false, active = false, generation = 0;
  const clear = () => { if (installed) { installed = false; current = null; dispose(); report("unconfigured"); } };
  return {
    connect(options: WebSessionOptions | null) {
      const ownGeneration = ++generation;
      active = true;
      if (options !== current || !installed) {
        clear();
        if (options) {
          try { install(options); current = options; installed = true; report("installed"); }
          catch { dispose(); report("invalid"); }
        } else report("unconfigured");
      }
      return () => {
        if (generation !== ownGeneration) return;
        active = false;
        queueMicrotask(() => { if (!active && generation === ownGeneration) clear(); });
      };
    },
  };
}
