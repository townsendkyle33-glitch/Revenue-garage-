// Time resolution for spoken requests ("in five minutes", "tomorrow at 9") and quiet-hour rules.
// The model never does date math: it passes either a relative delay or a local wall-clock time, and the
// server resolves it in the owner's timezone (America/New_York by default).
import { DateTime, IANAZone } from "luxon";

export type TimeSpec = {
  delay_minutes?: number | null;
  local_datetime?: string | null; // "2026-11-14T09:00" in the given timezone
  timezone?: string | null;
};

export class TimeError extends Error {}

export function validZone(tz: string | null | undefined, fallback: string): string {
  return tz && IANAZone.isValidZone(tz) ? tz : fallback;
}

export function resolveTime(spec: TimeSpec, defaultTz: string, now: DateTime = DateTime.now()): { at: Date; zone: string } {
  const zone = validZone(spec.timezone, defaultTz);
  if (spec.delay_minutes != null && spec.local_datetime) {
    throw new TimeError("Give either delay_minutes or local_datetime, not both");
  }
  if (spec.delay_minutes != null) {
    const m = Number(spec.delay_minutes);
    if (!Number.isFinite(m) || m < 1 || m > 60 * 24 * 60) throw new TimeError("delay_minutes must be between 1 and 86400");
    return { at: now.plus({ minutes: m }).toJSDate(), zone };
  }
  if (spec.local_datetime) {
    const dt = DateTime.fromISO(spec.local_datetime, { zone });
    if (!dt.isValid) throw new TimeError(`Could not understand the time "${spec.local_datetime}"`);
    if (dt < now.minus({ minutes: 1 })) throw new TimeError(`That time (${describe(dt.toJSDate(), zone, now)}) is in the past`);
    if (dt > now.plus({ days: 366 })) throw new TimeError("That time is more than a year away");
    return { at: dt.toJSDate(), zone };
  }
  throw new TimeError("A time is required: delay_minutes or local_datetime");
}

function hm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
}

/** True when the local time falls inside quiet hours (which may wrap past midnight). */
export function inQuietHours(at: Date, zone: string, start: string, end: string): boolean {
  const t = DateTime.fromJSDate(at, { zone });
  const mins = t.hour * 60 + t.minute;
  const s = hm(start);
  const e = hm(end);
  if (s === e) return false;
  return s < e ? mins >= s && mins < e : mins >= s || mins < e;
}

/** First moment at or after `at` that is outside quiet hours. */
export function nextAllowed(at: Date, zone: string, start: string, end: string): Date {
  if (!inQuietHours(at, zone, start, end)) return at;
  let t = DateTime.fromJSDate(at, { zone });
  const e = hm(end);
  let candidate = t.set({ hour: Math.floor(e / 60), minute: e % 60, second: 0, millisecond: 0 });
  if (candidate <= t) candidate = candidate.plus({ days: 1 });
  return candidate.toJSDate();
}

/** Natural phrasing for speech: "today at 3:05 PM Eastern", "tomorrow at 9:00 AM", "Friday, Nov 20 at 9:00 AM". */
export function describe(at: Date, zone: string, now: DateTime = DateTime.now()): string {
  const t = DateTime.fromJSDate(at, { zone });
  const n = now.setZone(zone);
  const time = t.toFormat("h:mm a");
  const tzName = t.offsetNameShort ?? zone;
  let day: string;
  if (t.hasSame(n, "day")) day = "today";
  else if (t.hasSame(n.plus({ days: 1 }), "day")) day = "tomorrow";
  else if (t < n.plus({ days: 7 })) day = t.toFormat("cccc");
  else day = t.toFormat("cccc, LLL d");
  return `${day} at ${time} ${tzName}`;
}

export function nowContext(zone: string, now: DateTime = DateTime.now()): string {
  const t = now.setZone(zone);
  return `${t.toFormat("cccc, LLLL d, yyyy, h:mm a")} (${zone}, ISO ${t.toISO({ suppressMilliseconds: true })})`;
}
