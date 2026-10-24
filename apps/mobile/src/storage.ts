import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Draft } from './types';
import { DAY } from './domain';
import { configureMemberDeviceCleanup } from './member-device-cleanup';

type RecentSearch = { text: string; at: number };
const MAX_AGE = 7 * DAY;
const key = (ownerId: string, kind: 'draft' | 'searches') => `yumidang:prototype:v1:${encodeURIComponent(ownerId)}:${kind}`;
// Persist only the explicit draft and recent searches. AI, session, messages and profiles stay in memory.
const ownerQueues = new Map<string, Promise<void>>();

/** A logout clear waits for earlier writes; one failed write must not prevent cleanup. */
function ordered<T>(ownerId: string, operation: () => Promise<T>): Promise<T> {
  const result = (ownerQueues.get(ownerId) ?? Promise.resolve()).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  ownerQueues.set(ownerId, tail);
  void tail.then(() => { if (ownerQueues.get(ownerId) === tail) ownerQueues.delete(ownerId); });
  return result;
}

export function loadDraft(ownerId: string, now = Date.now()): Promise<Draft | null> {
  return ordered(ownerId, async () => {
    const stored = await AsyncStorage.getItem(key(ownerId, 'draft'));
    if (!stored) return null;
    let draft: Draft;
    try { draft = JSON.parse(stored); }
    catch { await AsyncStorage.removeItem(key(ownerId, 'draft')); return null; }
    const fields = ['category', 'title', 'introduction', 'placeName', 'publicArea', 'address', 'meetingPoint', 'startsAt', 'endsAt', 'deadlineAt', 'desiredAgeMin', 'desiredAgeMax', 'wishes'] as const;
    if (!draft || !Number.isFinite(draft.updatedAt) || draft.updatedAt > now || now >= draft.updatedAt + MAX_AGE || fields.some((field) => typeof draft[field] !== 'string')) {
      await AsyncStorage.removeItem(key(ownerId, 'draft'));
      return null;
    }
    return draft;
  });
}

export function saveDraft(ownerId: string, draft: Draft): Promise<void> {
  const serialized = JSON.stringify(draft);
  return ordered(ownerId, () => AsyncStorage.setItem(key(ownerId, 'draft'), serialized));
}

export function clearDraft(ownerId: string): Promise<void> {
  return ordered(ownerId, () => AsyncStorage.removeItem(key(ownerId, 'draft')));
}

export function cleanSearches(searches: RecentSearch[], now = Date.now()): RecentSearch[] {
  const seen = new Set<string>();
  return searches.filter((item) => item && typeof item.text === 'string' && item.text.trim() && Number.isFinite(item.at) && item.at <= now && now < item.at + MAX_AGE)
    .sort((a, b) => b.at - a.at)
    .filter((item) => {
      const value = item.text.trim();
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    }).slice(0, 10).map((item) => ({ text: item.text.trim(), at: item.at }));
}

export function loadSearches(ownerId: string, now = Date.now()): Promise<RecentSearch[]> {
  return ordered(ownerId, async () => {
    const stored = await AsyncStorage.getItem(key(ownerId, 'searches'));
    if (!stored) return [];
    let raw: unknown;
    try { raw = JSON.parse(stored); }
    catch { await AsyncStorage.removeItem(key(ownerId, 'searches')); return []; }
    const searches = Array.isArray(raw) ? cleanSearches(raw, now) : [];
    await writeSearches(ownerId, searches);
    return searches;
  });
}

export function saveSearches(ownerId: string, searches: RecentSearch[], now = Date.now()): Promise<void> {
  const clean = cleanSearches(searches, now);
  return ordered(ownerId, () => writeSearches(ownerId, clean));
}

async function writeSearches(ownerId: string, clean: RecentSearch[]): Promise<void> {
  if (!clean.length) return AsyncStorage.removeItem(key(ownerId, 'searches'));
  await AsyncStorage.setItem(key(ownerId, 'searches'), JSON.stringify(clean));
}

export function clearSearches(ownerId: string): Promise<void> {
  return ordered(ownerId, () => AsyncStorage.removeItem(key(ownerId, 'searches')));
}

export function clearOwnerStorage(ownerId: string): Promise<void> {
  return ordered(ownerId, () => AsyncStorage.multiRemove([key(ownerId, 'draft'), key(ownerId, 'searches')]));
}

export type ServiceStorageLease = { userId: string | null; epoch: number; generation: number };
export type ServiceStorageSnapshot = {
  status: 'loading' | 'ready' | 'error' | 'cleanup-required';
  draft: Draft | null;
  recentSearches: RecentSearch[];
  error: string;
  draftCleanupPending: boolean;
};
type DeviceBackend = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem' | 'multiRemove'>;
type StoredDraft = { version: 1; revision: string; draft: Draft };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requiredDraftFields = ['category', 'title', 'introduction', 'placeName', 'publicArea', 'address', 'meetingPoint', 'startsAt', 'endsAt', 'deadlineAt', 'desiredAgeMin', 'desiredAgeMax', 'wishes'] as const;
const optionalDraftFields = ['eventId', 'manualEvent', 'eventSectionPosition', 'editingPostId', 'serviceExpectedUpdatedAt'] as const;
const serviceKey = (userId: string | null, kind: 'draft' | 'searches' | 'clear-owner' | 'clear-draft') => `yumidang:service:v1:${userId === null ? 'guest' : userId.toLowerCase()}:${kind}`;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function deviceError() { return new Error('DEVICE_STORAGE_NOT_READY'); }

/** Stored drafts contain form values only. Runtime authority and unrecognised fields never roundtrip. */
export function serviceDraftPayload(value: unknown, now = Date.now()): Draft | null {
  if (!record(value) || requiredDraftFields.some(field => typeof value[field] !== 'string' || [...value[field] as string].length > 10000) || !Number.isFinite(value.updatedAt) || (value.updatedAt as number) > now || now >= (value.updatedAt as number) + MAX_AGE) return null;
  const allowed = new Set<string>([...requiredDraftFields, ...optionalDraftFields, 'updatedAt', 'serviceDraftEpoch', 'serviceDraftRevision']);
  if (Object.keys(value).some(field => !allowed.has(field))) return null;
  for (const field of ['eventId', 'editingPostId'] as const) if (value[field] !== undefined && (typeof value[field] !== 'string' || !uuidPattern.test(value[field]))) return null;
  if (value.eventSectionPosition !== undefined && !['top', 'bottom'].includes(String(value.eventSectionPosition))) return null;
  if (value.serviceExpectedUpdatedAt !== undefined && (typeof value.serviceExpectedUpdatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.serviceExpectedUpdatedAt) || !Number.isFinite(Date.parse(value.serviceExpectedUpdatedAt)))) return null;
  if (value.manualEvent !== undefined) {
    const event = value.manualEvent;
    if (!record(event) || Object.keys(event).sort().join(',') !== 'placeName,publicAddress,publicAddressConfirmed,title' || ['title', 'placeName', 'publicAddress'].some(field => typeof event[field] !== 'string' || [...event[field] as string].length > 10000) || typeof event.publicAddressConfirmed !== 'boolean' || value.eventId !== undefined) return null;
  }
  const result: Record<string, unknown> = { updatedAt: value.updatedAt };
  for (const field of [...requiredDraftFields, ...optionalDraftFields]) if (value[field] !== undefined) result[field] = value[field];
  return JSON.parse(JSON.stringify(result)) as Draft;
}

function decodeStoredDraft(value: string | null, now: number): StoredDraft | null {
  if (value === null) return null;
  try {
    const entry: unknown = JSON.parse(value);
    if (!record(entry) || entry.version !== 1 || typeof entry.revision !== 'string' || !entry.revision || Object.keys(entry).sort().join(',') !== 'draft,revision,version') return null;
    const draft = serviceDraftPayload(entry.draft, now);
    return draft ? { version: 1, revision: entry.revision, draft } : null;
  } catch { return null; }
}

/** A single visible service owner. Preview storage and legacy keys are deliberately independent. */
export function createServiceDeviceStore(backend: DeviceBackend = AsyncStorage, now: () => number = Date.now) {
  let sequence = 0;
  let active: { lease: ServiceStorageLease; blocked: boolean; snapshot: ServiceStorageSnapshot } | null = null;
  const subscribers = new Set<() => void>(), queues = new Map<string, Promise<void>>();
  const invalidatedOwners = new Set<string>();
  const pendingDraftWrites = new Map<string, Set<string>>(), pendingDraftClears = new Map<string, string>();
  const empty = (status: ServiceStorageSnapshot['status']): ServiceStorageSnapshot => ({ status, draft: null, recentSearches: [], error: '', draftCleanupPending: false });
  const notify = () => subscribers.forEach(listener => listener());
  const ownerName = (userId: string | null) => userId ?? 'guest';
  const normalized = (userId: string | null) => {
    if (userId !== null && !uuidPattern.test(userId)) throw deviceError();
    return userId?.toLowerCase() ?? null;
  };
  const enqueue = <T,>(userId: string | null, operation: () => Promise<T>): Promise<T> => {
    const name = ownerName(userId), result = (queues.get(name) ?? Promise.resolve()).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    queues.set(name, tail);
    void tail.then(() => { if (queues.get(name) === tail) queues.delete(name); });
    return result;
  };
  const same = (lease: ServiceStorageLease) => active !== null && active.lease.userId === lease.userId && active.lease.epoch === lease.epoch && active.lease.generation === lease.generation;
  const requireReady = (lease: ServiceStorageLease, member = false) => {
    if (!same(lease) || active!.blocked || active!.snapshot.status !== 'ready' || active!.snapshot.draftCleanupPending || (member && lease.userId === null)) throw deviceError();
    return active!;
  };
  async function hydrate(lease: ServiceStorageLease) {
    try {
      // A failed read never becomes an empty successful load or a write-back.
      const values = await enqueue(lease.userId, () => Promise.all([
        backend.getItem(serviceKey(lease.userId, 'clear-owner')),
        backend.getItem(serviceKey(lease.userId, 'clear-draft')),
        lease.userId === null ? Promise.resolve(null) : backend.getItem(serviceKey(lease.userId, 'draft')),
        backend.getItem(serviceKey(lease.userId, 'searches')),
      ]));
      if (!same(lease)) return;
      if (values[0] !== null || invalidatedOwners.has(ownerName(lease.userId))) {
        active!.blocked = true;
        active!.snapshot = { ...empty('cleanup-required'), error: '이 기기의 이전 저장 내용 삭제를 확인해야 해요.' };
        notify(); return;
      }
      let rawSearches: unknown = [];
      try { rawSearches = values[3] === null ? [] : JSON.parse(values[3]); } catch { /* Corrupt values are not exposed or copied to another owner. */ }
      const stored = decodeStoredDraft(values[2], now()), pendingClear = values[1] !== null || pendingDraftClears.has(ownerName(lease.userId));
      const recentSearches = Array.isArray(rawSearches) ? cleanSearches(rawSearches, now()) : [];
      const pruneDraft = values[2] !== null && !stored && !pendingClear;
      const pruneSearches = values[3] !== null && values[3] !== JSON.stringify(recentSearches);
      if (pruneDraft || pruneSearches) await enqueue(lease.userId, async () => {
        // Only a successful read can authorize pruning. Compare again so a newer value survives.
        if (!same(lease)) return;
        if (pruneDraft && await backend.getItem(serviceKey(lease.userId, 'draft')) === values[2] && same(lease)) await backend.removeItem(serviceKey(lease.userId, 'draft'));
        if (pruneSearches && await backend.getItem(serviceKey(lease.userId, 'searches')) === values[3] && same(lease)) {
          if (recentSearches.length) await backend.setItem(serviceKey(lease.userId, 'searches'), JSON.stringify(recentSearches));
          else await backend.removeItem(serviceKey(lease.userId, 'searches'));
        }
      });
      if (!same(lease)) return;
      active!.snapshot = {
        status: 'ready', error: '', draftCleanupPending: pendingClear,
        draft: !pendingClear && stored ? { ...stored.draft, serviceDraftEpoch: lease.epoch, serviceDraftRevision: stored.revision } : null,
        recentSearches,
      };
      notify();
    } catch {
      if (same(lease)) { active!.snapshot = { ...empty('error'), error: '기기 저장 내용을 불러오지 못했어요. 다시 확인해 주세요.' }; notify(); }
    }
  }
  function invalidate(userId: string) {
    const id = normalized(userId)!;
    invalidatedOwners.add(id);
    if (active?.lease.userId === id) {
      active.lease = { ...active.lease, generation: ++sequence }; active.blocked = true;
      active.snapshot = { ...empty('cleanup-required'), error: '기기 저장 내용을 정리하고 있어요.' }; notify();
    }
  }
  async function clearOwner(userId: string) {
    const id = normalized(userId)!;
    invalidate(id);
    try {
      await enqueue(id, async () => {
        // If deletion fails, a written marker keeps the old data out of the next hydration.
        try { await backend.setItem(serviceKey(id, 'clear-owner'), '1'); } catch { /* Deletion itself may still succeed. */ }
        await backend.multiRemove([serviceKey(id, 'draft'), serviceKey(id, 'searches'), serviceKey(id, 'clear-draft')]);
        await backend.removeItem(serviceKey(id, 'clear-owner'));
      });
      invalidatedOwners.delete(id);
      pendingDraftClears.delete(id);
      if (active?.lease.userId === id) { active.snapshot = empty('ready'); notify(); }
    } catch (error) {
      if (active?.lease.userId === id) { active.snapshot = { ...empty('cleanup-required'), error: '기기 저장 내용 삭제를 확인하지 못했어요. 다시 삭제해 주세요.' }; notify(); }
      throw error;
    }
  }
  async function finishDraftClear(userId: string | null, markerValue: string | null) {
    await enqueue(userId, async () => {
      const marker = serviceKey(userId, 'clear-draft');
      let expected = markerValue ?? pendingDraftClears.get(ownerName(userId)) ?? null;
      if (expected === null) expected = await backend.getItem(marker);
      if (expected === null) return;
      try { await backend.setItem(marker, expected); } catch { /* Still try the actual removal. */ }
      let revisions: unknown;
      try { revisions = JSON.parse(expected); } catch { revisions = [expected]; }
      if (!Array.isArray(revisions) || revisions.some(value => typeof value !== 'string')) throw deviceError();
      const current = decodeStoredDraft(await backend.getItem(serviceKey(userId, 'draft')), now());
      if (!current || revisions.includes(current.revision)) await backend.removeItem(serviceKey(userId, 'draft'));
      await backend.removeItem(marker);
      pendingDraftClears.delete(ownerName(userId));
    });
  }
  return {
    subscribe(listener: () => void) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
    snapshot: () => active?.snapshot ?? empty('loading'),
    lease: () => active ? { ...active.lease } : null,
    activate(userId: string | null, epoch: number) {
      const id = normalized(userId);
      if (active?.lease.userId === id && active.lease.epoch === epoch && !active.blocked) return;
      const lease = { userId: id, epoch, generation: ++sequence };
      active = { lease, blocked: false, snapshot: empty('loading') }; notify();
      void hydrate(lease);
    },
    retryLoad() {
      if (!active) return Promise.resolve();
      active.lease = { ...active.lease, generation: ++sequence }; active.snapshot = empty('loading'); active.blocked = false; notify();
      return hydrate({ ...active.lease });
    },
    async saveDraft(lease: ServiceStorageLease, input: Draft) {
      requireReady(lease, true);
      const draft = serviceDraftPayload({ ...input, updatedAt: now() }, now());
      if (!draft) throw new Error('INVALID_DEVICE_DRAFT');
      const revision = `${now()}-${++sequence}-${Math.random().toString(36).slice(2)}`;
      const name = ownerName(lease.userId), revisions = pendingDraftWrites.get(name) ?? new Set<string>();
      revisions.add(revision); pendingDraftWrites.set(name, revisions);
      try {
        await enqueue(lease.userId, async () => {
          requireReady(lease, true);
          await backend.setItem(serviceKey(lease.userId, 'draft'), JSON.stringify({ version: 1, revision, draft }));
          const current = requireReady(lease, true);
          current.snapshot = { ...current.snapshot, draft: { ...draft, serviceDraftEpoch: lease.epoch, serviceDraftRevision: revision } }; notify();
        });
      } finally {
        revisions.delete(revision);
        if (!revisions.size) pendingDraftWrites.delete(name);
      }
    },
    async addSearch(lease: ServiceStorageLease, text: string) {
      requireReady(lease); const clean = text.trim();
      if (!clean) return;
      await enqueue(lease.userId, async () => {
        const current = requireReady(lease);
        const recentSearches = cleanSearches([{ text: clean, at: now() }, ...current.snapshot.recentSearches.filter(item => item.text !== clean)], now());
        await backend.setItem(serviceKey(lease.userId, 'searches'), JSON.stringify(recentSearches));
        const owner = requireReady(lease); owner.snapshot = { ...owner.snapshot, recentSearches }; notify();
      });
    },
    async clearSearches(lease: ServiceStorageLease) {
      requireReady(lease);
      await enqueue(lease.userId, async () => {
        requireReady(lease); await backend.removeItem(serviceKey(lease.userId, 'searches'));
        const current = requireReady(lease); current.snapshot = { ...current.snapshot, recentSearches: [] }; notify();
      });
    },
    async clearDraft(lease: ServiceStorageLease, expectedRevision?: string) {
      // A verified publication may finish after a same-owner manual storage reload.
      // Only its exact saved revision may be removed; newer acknowledged work is preserved.
      const publicationLease = expectedRevision !== undefined && active?.lease.userId === lease.userId && active.lease.epoch === lease.epoch ? active.lease : lease;
      const current = requireReady(publicationLease, true), revision = current.snapshot.draft?.serviceDraftRevision;
      if (expectedRevision !== undefined && revision !== expectedRevision) return;
      if (!revision) return;
      const marker = JSON.stringify([revision, ...pendingDraftWrites.get(ownerName(lease.userId)) ?? []]);
      pendingDraftClears.set(ownerName(lease.userId), marker);
      current.lease = { ...current.lease, generation: ++sequence };
      const nextLease = { ...current.lease };
      current.snapshot = { ...current.snapshot, draft: null, draftCleanupPending: true }; notify();
      try {
        await finishDraftClear(lease.userId, marker);
        if (same(nextLease)) { active!.snapshot = { ...active!.snapshot, draftCleanupPending: false, error: '' }; notify(); }
      } catch (error) {
        if (same(nextLease)) { active!.snapshot = { ...active!.snapshot, error: '공고는 등록됐지만 기기 초안 정리를 확인하지 못했어요.' }; notify(); }
        throw error;
      }
    },
    async retryDraftCleanup(lease: ServiceStorageLease) {
      if (!same(lease) || active!.blocked || !active!.snapshot.draftCleanupPending) throw deviceError();
      await finishDraftClear(lease.userId, null);
      if (same(lease)) { active!.snapshot = { ...active!.snapshot, draftCleanupPending: false, error: '' }; notify(); }
    },
    invalidate,
    clearOwner,
  };
}

export const serviceDeviceStore = createServiceDeviceStore();
export const invalidateServiceStorage = (userId: string) => serviceDeviceStore.invalidate(userId);
export const clearServiceOwnerStorage = (userId: string) => serviceDeviceStore.clearOwner(userId);
configureMemberDeviceCleanup({ clear: clearServiceOwnerStorage, invalidate: invalidateServiceStorage });
