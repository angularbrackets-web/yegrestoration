/**
 * The browser side of the confirmation handoff.
 *
 * Everything that touches `sessionStorage`, `window.gtag`, or `import.meta.env`
 * lives here so that `booking-confirmation.ts` stays importable from a plain
 * `tsx` script. Both callers — the form island on a successful commit, and the
 * confirmation island on load — go through these four functions.
 */

import {
  CONFIRMATION_KEY,
  CONVERSION_MARKER_KEY,
  planConversionReport,
  readConfirmation,
  serializeConfirmation,
  type Confirmation,
} from './booking-confirmation';

/**
 * `sessionStorage` access that never throws.
 *
 * Reading it is enough to throw in a browser with storage disabled, and by the
 * time either caller runs the booking has already committed — an exception on
 * the way to showing the confirmation would lose it.
 */
function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** False if the write did not happen, so the caller can fall back rather than assume. */
function writeSession(key: string, value: string): boolean {
  try {
    window.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Hand the confirmation to `/book/confirmed/`. False means navigating would lose it. */
export function storeConfirmation(confirmation: Confirmation): boolean {
  return writeSession(CONFIRMATION_KEY, serializeConfirmation(confirmation));
}

/** The confirmation this tab is carrying, or null if it is carrying none. */
export function loadConfirmation(): Confirmation | null {
  return readConfirmation(readSession(CONFIRMATION_KEY));
}

/**
 * The two ways the booking funnel can fail before a booking exists.
 *
 * Added by BK-10 so a post-cutover CPA regression is not a black box: with the
 * form demoted, `/book/` is the only quote path, and "availability would not
 * load" or "every day is full" are the two states that lose a visitor without
 * leaving any other trace. Neither event carries parameters — there is no PII
 * here and nothing to key on beyond the count.
 *
 * GA4 only, deliberately: these are diagnostics, not conversions, and Google
 * Ads has no business bidding on them.
 */
export type BookingFunnelEvent = 'booking_availability_error' | 'booking_availability_empty';

export function reportBookingFunnelEvent(event: BookingFunnelEvent): void {
  const gtag = window.gtag;
  if (typeof gtag !== 'function') return;
  gtag('event', event);
}

/**
 * Report a booked assessment to Google Ads and GA4, at most once per booking.
 *
 * Safe to call on every load of the confirmed page: the marker is what makes a
 * reload, a Back, or a bookmarked URL cost nothing, while a second and
 * genuinely different booking in the same tab still reports.
 *
 * When `window.gtag` is absent the whole tag is dormant (neither `PUBLIC_GA4_ID`
 * nor `PUBLIC_AW_ID` is set), so there is nothing to report and nothing to
 * mark — leaving the marker unwritten is correct, not an oversight.
 */
export function reportBookingConversion(id: number): void {
  const gtag = window.gtag;
  if (typeof gtag !== 'function') return;

  // `import.meta.env.PUBLIC_*` is read here directly and must stay that way.
  // Vite replaces these two expressions with string literals at build time; a
  // dynamic lookup through a helper (`readEnv`, `env[name]`) defeats the
  // substitution and the client bundle ships with the label undefined — which
  // fails silently, as an Ads conversion nobody notices is missing.
  const report = planConversionReport({
    marker: readSession(CONVERSION_MARKER_KEY),
    awId: import.meta.env.PUBLIC_AW_ID,
    bookingLabel: import.meta.env.PUBLIC_AW_BOOKING_LABEL,
    id,
  });
  if (!report) return;

  for (const call of report.calls) gtag('event', call.event, call.params);
  writeSession(CONVERSION_MARKER_KEY, report.marker);
}
