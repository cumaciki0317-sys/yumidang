import type { WebSessionOptions } from "./web-member-session";
/** Trusted host supplies reviewed deployment values. No URL, Origin, key, or token is inferred. */
let configuration: WebSessionOptions | null = null;
const listeners = new Set<() => void>();
export function configureWebMemberConnection(options: WebSessionOptions | null) {
  configuration = options;
  listeners.forEach(listener => listener());
}
export const webMemberConfiguration = () => configuration;
export function subscribeWebMemberConfiguration(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
