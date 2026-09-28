import type { DateSelection } from "../../../contracts/ai.ts";
import { parseCalendarDate, addCalendarDays, seoulCalendarDate, seoulWeekWindow } from "../../../integrations/events/normalize.ts";
export function resolveDateRange(selection: DateSelection | undefined, now: Date): { startsAt: string; endsAt: string } | undefined {
  if (!selection) return undefined;
  const today = seoulCalendarDate(now);
  let start: string, end: string;
  switch (selection.kind) {
    case "today": start = today; end = addCalendarDays(today,1); break;
    case "tomorrow": start = addCalendarDays(today,1); end = addCalendarDays(today,2); break;
    case "this_week": { const w = seoulWeekWindow(today); start=w.monday; end=w.nextMonday; break; }
    case "this_weekend": { const w = seoulWeekWindow(today); start=addCalendarDays(w.monday,5); end=w.nextMonday; break; }
    case "dates": parseCalendarDate(selection.startsOn); parseCalendarDate(selection.endsOn); if (selection.startsOn > selection.endsOn) throw new Error("INVALID_DATE_RANGE"); start=selection.startsOn; end=addCalendarDays(selection.endsOn,1); break;
    default: throw new Error("INVALID_DATE_RANGE");
  }
  return { startsAt: `${start}T00:00:00+09:00`, endsAt: `${end}T00:00:00+09:00` };
}
