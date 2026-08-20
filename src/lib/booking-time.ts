/**
 * Timezone math for the booking system.
 *
 * Appointment instants are stored as UTC (TIMESTAMPTZ). Everything the client
 * and the office see is America/Edmonton wall-clock time. This module is the
 * only place that conversion happens.
 *
 * Node 22 has no `Temporal` and the site carries no date library, so the
 * conversion is done with `Intl` offset lookups. That is sufficient here:
 * every bookable time sits between 11:30 and 16:00 local, nowhere near the
 * 02:00 DST transition, so there are no ambiguous (fall-back) or nonexistent
 * (spring-forward) wall-clock times to disambiguate. `scripts/verify-slots.ts`
 * asserts this across a full year.
 */

import {
  CLOSED_WEEKDAYS,
  MAX_ADVANCE_DAYS,
  MIN_NOTICE_DAYS,
  SLOT_START_TIMES,
  TIMEZONE,
} from './booking-config';

/** A local calendar date as `YYYY-MM-DD`. Sorts lexicographically, which several checks rely on. */
export type DateKey = string;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      // h23 rather than hour12:false — the latter reports midnight as "24"
      // on some ICU builds, which would need a day-rollover correction.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** Wall-clock field values for `instant` in `tz`. */
export function toZonedParts(instant: Date, tz: string = TIMEZONE): ZonedParts {
  const out: Record<string, number> = {};
  for (const part of zoneFormatter(tz).formatToParts(instant)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour % 24,
    minute: out.minute,
    second: out.second,
  };
}

/** Offset of `tz` at `instant`, in ms (negative west of UTC — Edmonton is -7h MST / -6h MDT). */
export function zoneOffsetMs(instant: Date, tz: string = TIMEZONE): number {
  const p = toZonedParts(instant, tz);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Drop sub-second precision on both sides — formatToParts has none.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

export function isValidDateKey(value: unknown): value is DateKey {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { year, month, day } = parseDateKey(value);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Reject 2026-02-31 and friends by round-tripping through Date.
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

export function parseDateKey(key: DateKey): { year: number; month: number; day: number } {
  return {
    year: Number(key.slice(0, 4)),
    month: Number(key.slice(5, 7)),
    day: Number(key.slice(8, 10)),
  };
}

/** The local calendar date `instant` falls on. */
export function localDateKey(instant: Date, tz: string = TIMEZONE): DateKey {
  const p = toZonedParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 0 = Sunday … 6 = Saturday, for a local calendar date. */
export function weekdayOfDateKey(key: DateKey): number {
  const { year, month, day } = parseDateKey(key);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function addDays(key: DateKey, days: number): DateKey {
  const { year, month, day } = parseDateKey(key);
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Convert a local wall-clock date + `HH:MM` into the UTC instant it names.
 *
 * Two passes: the first guess uses the offset at the naive instant, the second
 * re-reads the offset at the corrected instant in case the guess landed on the
 * far side of a DST transition.
 */
export function zonedTimeToUtc(key: DateKey, time: string, tz: string = TIMEZONE): Date {
  const { year, month, day } = parseDateKey(key);
  const hour = Number(time.slice(0, 2));
  const minute = Number(time.slice(3, 5));
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstPass = wall - zoneOffsetMs(new Date(wall), tz);
  const secondPass = wall - zoneOffsetMs(new Date(firstPass), tz);
  return new Date(secondPass);
}

/** The five slot start instants for a local calendar date, in order. */
export function slotStartsForDate(key: DateKey): Date[] {
  return SLOT_START_TIMES.map((time) => zonedTimeToUtc(key, time));
}

/** True if `instant` is exactly one of the grid's start times. */
export function isSlotOnGrid(instant: Date): boolean {
  return slotStartsForDate(localDateKey(instant)).some((s) => s.getTime() === instant.getTime());
}

/** Fridays. Admin-set blackout dates are a separate, DB-backed check. */
export function isClosedWeekday(key: DateKey): boolean {
  return CLOSED_WEEKDAYS.includes(weekdayOfDateKey(key));
}

/** The earliest local DATE a public booking may fall on. Next-day earliest (BK-23). */
export function earliestBookableDate(now: Date = new Date()): DateKey {
  return addDays(localDateKey(now), MIN_NOTICE_DAYS);
}

/*
 * `earliestBookableInstant` was here and is deliberately GONE (BK-23 review).
 *
 * BK-23's own text called it "the single chokepoint both the picker and the
 * availability filter already read" — and by the time that sentence shipped it
 * was false. Moving the rule from a rolling window to a calendar one turned
 * both callers into date-key comparisons: `booking-form.ts` compares keys
 * directly and `booking-availability.ts` calls `isWithinBookingWindow`. Nothing
 * called it, and an exported instant-cutoff sitting beside a calendar rule is
 * an invitation to reintroduce the rolling comparison it replaced.
 *
 * `earliestBookableDate` is the real chokepoint. Use that.
 *
 * The name stays on `verify-booking-admin-entry.ts`'s banned-import list on
 * purpose: a banned name that no longer exists costs nothing and catches a
 * reintroduction.
 */

/** The last local date the public calendar offers. */
export function latestBookableDate(now: Date = new Date()): DateKey {
  return addDays(localDateKey(now), MAX_ADVANCE_DAYS);
}

/**
 * Minimum-notice and booking-horizon check. Does not consider blackouts or
 * existing bookings.
 *
 * BOTH BOUNDS ARE NOW CALENDAR COMPARISONS, which is what makes them agree.
 * The upper bound always was one (`latestBookableDate` returns a date); the
 * lower bound was a rolling instant until BK-23, so the two ends of the same
 * window were expressed in different units. Comparing date keys at both ends
 * means "next-day earliest, 14 days out" is one sentence in the code as well as
 * in the copy.
 */
export function isWithinBookingWindow(slotStart: Date, now: Date = new Date()): boolean {
  const date = localDateKey(slotStart);
  return date >= earliestBookableDate(now) && date <= latestBookableDate(now);
}

/** Every local date the public calendar covers, closed weekdays included (caller filters). */
export function bookableDateRange(now: Date = new Date()): DateKey[] {
  const start = localDateKey(now);
  const days: DateKey[] = [];
  for (let i = 0; i <= MAX_ADVANCE_DAYS; i++) days.push(addDays(start, i));
  return days;
}

/** e.g. `Tue, Aug 4 · 1:30 PM`. Used in emails, SMS, and the admin panel. */
export function formatSlot(instant: Date, tz: string = TIMEZONE): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(instant);
  const time = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(instant);
  return `${date} · ${time}`;
}

export { DAY_MS, HOUR_MS };
