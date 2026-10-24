import { ApiError } from './api.ts';
import type { FreePostInput } from '../../../backend/supabase/functions/_shared/contracts/posts';
export type ManualEventInput = NonNullable<FreePostInput['manualEvent']>;
const invalid = (): never => { throw new ApiError(400, 'INVALID_REQUEST'); };
/** Exact public input, also used for server response validation by callers. */
export function manualEventInput(value: unknown): ManualEventInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'placeName,publicAddress,publicAddressConfirmed,title') return invalid();
  for (const [key, min, max] of [['title',1,200],['placeName',0,200],['publicAddress',0,300]] as const) {
    const s = r[key];
    if (typeof s !== 'string' || s !== s.trim() || [...s].length < min || [...s].length > max || /[<>\u0000-\u001f\u007f]/u.test(s)) return invalid();
  }
  if (typeof r.publicAddressConfirmed !== 'boolean' || (r.publicAddress && !r.publicAddressConfirmed)) return invalid();
  return { title: r.title as string, placeName: r.placeName as string, publicAddress: r.publicAddress as string, publicAddressConfirmed: r.publicAddressConfirmed };
}
/** Preserve omission/null semantics. The same canonical object goes to inspection and saving. */
export function postWriteInput(input: FreePostInput): FreePostInput {
  const keys = ['title','description','category','startsAt','endsAt','recruitmentEndsAt','publicArea','registeredPlaceName','registeredAddress','meetingDetail','preferenceNote','tags','costType','amount','eventId','manualEvent','eventChangeId'];
  if (!input || Object.keys(input).some(k => !keys.includes(k))) return invalid();
  const value: FreePostInput = { title: input.title, description: input.description, category: input.category,
    startsAt: input.startsAt, endsAt: input.endsAt, recruitmentEndsAt: input.recruitmentEndsAt ?? input.startsAt,
    publicArea: input.publicArea, registeredPlaceName: input.registeredPlaceName ?? null,
    registeredAddress: input.registeredAddress, meetingDetail: input.meetingDetail,
    preferenceNote: input.preferenceNote ?? null, tags: [...(input.tags ?? [])], costType: input.costType, amount: input.amount };
  for (const key of ['eventId','manualEvent','eventChangeId'] as const) {
    if (Object.hasOwn(input,key) && input[key] !== undefined) Object.assign(value,{[key]: input[key]});
  }
  if (value.eventId != null && value.manualEvent != null) return invalid();
  if (value.manualEvent != null) value.manualEvent = manualEventInput(value.manualEvent);
  return value;
}
