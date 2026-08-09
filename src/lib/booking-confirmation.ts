/**
 * The pure half of the booking confirmation handoff.
 *
 * `/book/` and `/book/confirmed/` are two different documents, so everything a
 * confirmation needs has to survive a navigation. It travels in `sessionStorage`
 * — tab-scoped, same-origin, unlinkable — rather than in the URL, where a
 * hand-crafted `?ref=` would render an equally convincing confirmation for a
 * booking that is not the visitor's, and where the reference number would ride
 * along in history and in every outbound `Referer`.
 *
 * No DOM and no `gtag` in here: `conversionCalls` returns the calls to make so
 * that `scripts/verify-booking-confirmation.ts` can assert them without a
 * browser, the same split `booking-form.ts` uses.
 */

/** Where the confirmation waits between `/book/` and `/book/confirmed/`. */
export const CONFIRMATION_KEY = 'yeg.booking.confirmation';

/**
 * The id of the booking whose conversion has already been reported.
 *
 * Kept separate from the confirmation itself so that reading the confirmation
 * stays a pure parse: a marker written back into the same record would mean the
 * render path has to write, and a failed write would then lose the booking.
 */
export const CONVERSION_MARKER_KEY = 'yeg.booking.conversionReported';

export type Confirmation = {
  /** The appointment's database id. Doubles as the conversion's `transaction_id`. */
  id: number;
  /** Server-formatted, America/Edmonton. Never re-derived from a timestamp here. */
  slotLabel: string;
  /** One display string — `address, city`. Rendered, never parsed. */
  address: string;
  /**
   * Whether the server said it sent the confirmation email.
   *
   * Never optional in the type, always defaulted to `false` on read: a payload
   * stored by the build that shipped before BK-05 has no such field, and the
   * page must render for that visitor rather than bounce them to an empty form.
   * One shape means the component has one condition to write.
   */
  emailSent: boolean;
};

export function serializeConfirmation(confirmation: Confirmation): string {
  return JSON.stringify(confirmation);
}

/**
 * The stored confirmation, or null if there is nothing usable to render.
 *
 * Shape only. It deliberately does **not** require `id > 0` or a non-empty
 * `slotLabel`: `mapCommitResponse` defaults those to `0` and `''` when a 201
 * arrives malformed, and a visitor whose booking genuinely committed must not be
 * bounced back to an empty form over a missing label. Null here means "no
 * booking happened in this tab", which is the only case that redirects.
 */
export function readConfirmation(raw: string | null): Confirmation | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  if (typeof record.id !== 'number' || !Number.isFinite(record.id)) return null;
  if (typeof record.slotLabel !== 'string') return null;

  return {
    id: record.id,
    slotLabel: record.slotLabel,
    address: typeof record.address === 'string' ? record.address : '',
    // Only a literal `true`. Absent, malformed, or written by a pre-BK-05
    // build all mean "do not tell this visitor we emailed them".
    emailSent: record.emailSent === true,
  };
}

/**
 * Whether this booking's conversion still needs reporting.
 *
 * The confirmed page is a revisitable URL — a reload, a Back, a bookmark — and
 * every load would otherwise count another conversion. Comparing against the
 * *id* rather than a boolean is what lets a second, genuinely different booking
 * in the same tab report again.
 */
export function shouldReportConversion(marker: string | null, id: number): boolean {
  return marker !== String(id);
}

/** One `gtag('event', …)` call, described rather than made. */
export type GtagCall = { event: string; params: Record<string, unknown> };

/**
 * The conversion calls for a confirmed booking, in the order to fire them.
 *
 * Google Ads first and only when both halves of `send_to` are configured — a
 * `send_to` of `undefined/undefined` is a silently discarded conversion, which
 * is worse than none because it looks like tracking. GA4's `booking_confirmed`
 * fires regardless: it needs no label, and GA4 is where the funnel is read.
 *
 * `transaction_id` is Google's own duplicate guard and covers what the
 * once-per-booking marker cannot see — a second tab, a cleared session, the
 * confirmed URL reopened tomorrow. It is omitted for a non-positive id, which
 * is not a real appointment number and would collide across bookings.
 */
export function conversionCalls(input: {
  awId: string | undefined;
  bookingLabel: string | undefined;
  id: number;
}): GtagCall[] {
  const { awId, bookingLabel, id } = input;
  const calls: GtagCall[] = [];

  if (awId && bookingLabel) {
    calls.push({
      event: 'conversion',
      params: {
        send_to: `${awId}/${bookingLabel}`,
        ...(id > 0 ? { transaction_id: String(id) } : {}),
      },
    });
  }

  calls.push({
    event: 'booking_confirmed',
    params: id > 0 ? { booking_id: id } : {},
  });

  return calls;
}

/** What to fire and what to remember afterwards, or null if this booking is already counted. */
export type ConversionReport = { calls: GtagCall[]; marker: string };

/**
 * The whole reporting decision, in one pure function.
 *
 * The "fire, then remember" sequence is the part that matters and the part a
 * browser would be needed to observe, so it lives here rather than in the
 * adapter: `marker` is the exact value that must be stored once `calls` have
 * been made, and a null return means nothing may be fired at all. That leaves
 * `reportBookingConversion` with no branching of its own beyond "is there a
 * tag to fire into".
 */
export function planConversionReport(input: {
  marker: string | null;
  awId: string | undefined;
  bookingLabel: string | undefined;
  id: number;
}): ConversionReport | null {
  const { marker, awId, bookingLabel, id } = input;
  if (!shouldReportConversion(marker, id)) return null;
  return { calls: conversionCalls({ awId, bookingLabel, id }), marker: String(id) };
}
