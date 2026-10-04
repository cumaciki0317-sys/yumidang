import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Draft } from './types';
import { DAY } from './domain';

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
