export interface MemberDeviceCleanupState { readonly busy: boolean; readonly failed: boolean; }
let storage: { clear(userId: string): Promise<void>; invalidate(userId: string): void } | null = null;
/** Installed by the app's device storage module; auth/session code stays platform independent. */
export function configureMemberDeviceCleanup(adapter: NonNullable<typeof storage>) { storage = adapter; }
let snapshot: Readonly<MemberDeviceCleanupState> | null = null;
const listeners = new Set<() => void>();
const pending = new Map<string, number>();
let sequence = 0;
let active: Promise<void> | null = null;
export const memberDeviceCleanupSnapshot = () => snapshot;
export function subscribeMemberDeviceCleanup(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function publish(busy: boolean, failed: boolean) {
  snapshot = Object.freeze({ busy, failed });
  listeners.forEach(listener => listener());
}
async function drain(): Promise<void> {
  if (active) { await active.catch(() => undefined); return drain(); }
  const targets = [...pending];
  if (!targets.length) return;
  publish(true, false);
  active = (async () => {
    let failed = false;
    for (const [userId, version] of targets) {
      try {
        if (!storage) throw new Error("DEVICE_STORAGE_NOT_CONFIGURED");
        await storage.clear(userId);
        if (pending.get(userId) === version) pending.delete(userId);
      } catch { failed = true; }
    }
    publish(false, pending.size > 0);
    if (failed) throw new Error("DEVICE_CLEANUP_FAILED");
  })();
  const current = active;
  try { await current; } finally { if (active === current) active = null; }
}
/** Only a trusted session boundary supplies the owner; public state contains no identity. */
export function requestMemberDeviceCleanup(userId: string): Promise<void> {
  storage?.invalidate(userId);
  pending.set(userId, ++sequence);
  return drain();
}
export function retryMemberDeviceCleanup(): Promise<void> { return drain(); }
