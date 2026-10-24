// Invalidations carry no account, consent values, tokens, or review text.
// A mutation may have reached the server even when its response is lost.
let revision = 0;
let mutations = 0;
let stoppedEpoch: number | null = null;
export const aiRequiresManualCheck = (epoch: number) => stoppedEpoch === epoch;
export function markAiManualCheck(epoch: number, required: boolean) { stoppedEpoch = required ? epoch : stoppedEpoch === epoch ? null : stoppedEpoch; }
const listeners = new Set<() => void>();
export const aiConsentRevision = () => revision;
export const aiConsentMutationPending = () => mutations > 0;
export function subscribeAiConsentChange(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function invalidateAiConsent() {
  revision++;
  listeners.forEach(listener => listener());
}
export function beginAiConsentChange() { mutations++; invalidateAiConsent(); }
export function finishAiConsentChange() { mutations = Math.max(0, mutations - 1); invalidateAiConsent(); }
