/**
 * The homepage's read-only view of the booking calendar (BK-39).
 *
 * Pure — a function from an availability payload to a string — so
 * `scripts/verify-booking-preview.ts` can check it with no DOM, no network and
 * no clock of its own, the same contract `booking-availability.ts` keeps.
 *
 * **This module is the foundation BK-28 extends, not a competitor to it.**
 * BK-28 owns the fuller preview: several slots, each deep-linked into `/book/`
 * with `?slot=`, and the `applyPrefill` hardening that a query parameter
 * feeding the public write path needs. What lives here is the one-line teaser
 * only, which reads nothing and links nowhere, and so carries none of that
 * risk. BK-28 should grow this file rather than start another one.
 */

import type { Availability, AvailableSlot } from './booking-availability';

/**
 * The first bookable slot in the window, or null.
 *
 * Null is a real and expected answer — a fully booked fortnight, a
 * closed-and-elapsed stretch — and the caller must render nothing rather than
 * a placeholder. "No openings" on a homepage is a sentence that costs bookings
 * and that the `/book/` page itself already says better, with the phone number
 * beside it.
 *
 * The payload's own order is trusted rather than re-sorted. `computeAvailability`
 * emits dates ascending and slots in grid order within each date, and
 * `verify-availability.ts` pins that ("determinism"). Re-sorting here would be a
 * second opinion about ordering that could disagree with the picker the visitor
 * lands on.
 */
export function firstOpenSlot(availability: unknown): AvailableSlot | null {
  const dates = (availability as Availability | null)?.dates;
  if (!Array.isArray(dates)) return null;
  for (const date of dates) {
    const slot = date?.slots?.[0];
    // `label` is the only field rendered, and it is taken verbatim — see below.
    if (slot && typeof slot.label === 'string' && slot.label !== '') return slot;
  }
  return null;
}

/**
 * The teaser line, or null when there is nothing to tease.
 *
 * **`slot.label` is rendered verbatim and never reformatted.** It arrives as
 * `formatSlot`'s output — `Mon, Aug 17 · 2:30 p.m.`, America/Edmonton, built
 * server-side — which is the same string the picker, the confirmation email and
 * the admin panel all show. Re-deriving a prettier form in the browser would
 * read the VISITOR'S timezone, so a customer in Vancouver would be told 1:30
 * and shown 2:30 one click later. That is the exact class of bug `db.ts` and
 * `booking-admin.ts` both carry warnings about.
 */
export function nextOpeningLine(availability: unknown): string | null {
  const slot = firstOpenSlot(availability);
  return slot ? `Next opening: ${slot.label}` : null;
}

/** How long the browser may reuse a fetched payload. */
export const PREVIEW_CACHE_MS = 60_000;

export const PREVIEW_CACHE_KEY = 'yeg:next-opening';

export type CachedPreview = { at: number; line: string };

/**
 * Read a cached teaser, or null if there is none, it is stale, or it is
 * unparseable.
 *
 * The availability endpoint answers `Cache-Control: no-store` on purpose — a
 * stale calendar offers slots that are gone — so this cache is deliberately
 * **short, client-side, and confined to the teaser string**, never to the slot
 * list. The worst outcome is a homepage naming an opening that was taken a
 * minute ago; the visitor then lands on `/book/`, which fetches fresh and shows
 * the truth. Caching the slots themselves, or letting this feed the picker,
 * would turn that into a booking attempt on a dead slot.
 *
 * Anything unexpected in storage is treated as absent rather than trusted:
 * `sessionStorage` is writable by anything else on the origin.
 */
export function readCachedPreview(raw: string | null, now: number): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedPreview>;
    if (typeof parsed?.line !== 'string' || typeof parsed?.at !== 'number') return null;
    const age = now - parsed.at;
    // A negative age means the clock moved backwards; treat it as stale rather
    // than as infinitely fresh.
    if (age < 0 || age > PREVIEW_CACHE_MS) return null;
    return parsed.line;
  } catch {
    return null;
  }
}
