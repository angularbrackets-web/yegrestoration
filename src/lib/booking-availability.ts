/**
 * What the public calendar may offer: the slot grid minus everything that
 * blocks a slot.
 *
 * Deliberately pure — it takes an explicit clock plus already-fetched blockers,
 * touches no database and no environment, and has no `new Date()` default
 * anywhere in the computation. That is what lets `scripts/verify-availability.ts`
 * property-check it without a database.
 *
 * The input contract is primitives only — `DateKey` strings and epoch
 * milliseconds — never raw driver rows. `src/lib/db.ts` types
 * `blackout_dates.day` and `appointments.slot_start` as `string`, but the Neon
 * driver hands back `Date` objects for both. Matching a `Date` against an ISO
 * string typechecks and silently never fires, which would offer blacked-out
 * days and already-booked slots as free. Normalizing happens at the SQL
 * boundary in the endpoint; by the time anything reaches this module the
 * ambiguity is gone.
 */

import { SLOT_MINUTES, TIMEZONE } from './booking-config';
import {
  addDays,
  bookableDateRange,
  formatSlot,
  isClosedWeekday,
  isWithinBookingWindow,
  localDateKey,
  slotStartsForDate,
  toZonedParts,
  weekdayOfDateKey,
  zonedTimeToUtc,
  type DateKey,
} from './booking-time';

export type AvailableSlot = {
  /** UTC instant, ISO 8601. What the client sends back when booking. */
  start: string;
  /** Local wall clock, `HH:MM`. */
  time: string;
  /** e.g. `Tue, Aug 4 · 1:30 PM`. Rendered as-is; the client never re-derives the zone. */
  label: string;
};

export type AvailableDate = {
  date: DateKey;
  /** 0 = Sunday … 6 = Saturday, in America/Edmonton. */
  weekday: number;
  /**
   * Empty means nothing is bookable that day — closed weekday, blackout, fully
   * booked, or past the notice cutoff. Which of those is deliberately not said:
   * distinguishing "blacked out" from "already booked" leaks the schedule.
   */
  slots: AvailableSlot[];
};

export type Availability = {
  timezone: string;
  durationMinutes: number;
  /** Every date in the window, including the ones with no slots. */
  dates: AvailableDate[];
};

export type AvailabilityInput = {
  now: Date;
  /** Local calendar dates that are blacked out, as `YYYY-MM-DD`. */
  blackoutDays: readonly DateKey[];
  /** Start instants of non-cancelled appointments, as epoch milliseconds. */
  bookedSlotMs: readonly number[];
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Local `HH:MM` for an instant, read back *from the instant* rather than copied
 * from the grid constant — so a bad conversion surfaces here instead of being
 * papered over by the label it was supposed to produce.
 */
function localTime(instant: Date): string {
  const p = toZonedParts(instant);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * The four exclusion rules for a single slot, in one place.
 *
 * BK-02 must revalidate a submitted slot server-side and has to call *this*
 * rather than re-assembling the rules by hand — two hand-built copies of the
 * same predicate is exactly how the picker and the validator drift apart, which
 * is what `booking-config.ts` exists to prevent.
 *
 * Deliberately does not check `isSlotOnGrid`: `computeAvailability` only ever
 * feeds it grid instants, while BK-02 takes a slot from an untrusted request
 * body and must check that separately, before this.
 */
export function isSlotBookable(
  slotStart: Date,
  {
    now,
    blackoutDays,
    bookedSlotMs,
  }: { now: Date; blackoutDays: ReadonlySet<DateKey>; bookedSlotMs: ReadonlySet<number> },
): boolean {
  const date = localDateKey(slotStart);
  if (isClosedWeekday(date)) return false;
  if (blackoutDays.has(date)) return false;
  if (!isWithinBookingWindow(slotStart, now)) return false;
  return !bookedSlotMs.has(slotStart.getTime());
}

/**
 * Availability for the whole public booking window.
 *
 * Advisory only. Two visitors can be shown the same free slot; the partial
 * unique index on `appointments` is the sole real guard, and the commit
 * endpoint is what turns a lost race into a "just taken" response.
 */
export function computeAvailability({
  now,
  blackoutDays,
  bookedSlotMs,
}: AvailabilityInput): Availability {
  const rules = {
    now,
    blackoutDays: new Set(blackoutDays),
    bookedSlotMs: new Set(bookedSlotMs),
  };

  const dates = bookableDateRange(now).map((date) => ({
    date,
    weekday: weekdayOfDateKey(date),
    slots: slotStartsForDate(date)
      .filter((start) => isSlotBookable(start, rules))
      .map((start) => ({
        start: start.toISOString(),
        time: localTime(start),
        label: formatSlot(start),
      })),
  }));

  return { timezone: TIMEZONE, durationMinutes: SLOT_MINUTES, dates };
}

/**
 * Half-open `[from, to)` instants bounding the booked-slot query.
 *
 * Calendar-based on purpose. `latestBookableDate` returns a *date*, and its
 * 15:30 slot sits well past `now + MAX_ADVANCE_DAYS × 24h` — a naive instant
 * bound would miss a booking on the last offered afternoon and show it free,
 * and would drift by an hour across a DST transition. Exported so the endpoint
 * and the verification script share one definition.
 */
export function bookedQueryRange(now: Date): { from: Date; to: Date } {
  const dates = bookableDateRange(now);
  const last = dates[dates.length - 1];
  return {
    from: zonedTimeToUtc(dates[0], '00:00'),
    to: zonedTimeToUtc(addDays(last, 1), '00:00'),
  };
}

/** The window's first and last local calendar dates, inclusive, for the blackout query. */
export function blackoutQueryRange(now: Date): { from: DateKey; to: DateKey } {
  const dates = bookableDateRange(now);
  return { from: dates[0], to: dates[dates.length - 1] };
}
