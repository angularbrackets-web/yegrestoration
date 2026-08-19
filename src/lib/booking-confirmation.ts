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
 * The Checkout Session whose conversion has already been reported.
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
 * Whether this PAYMENT's conversion still needs reporting.
 *
 * The confirmed page is a revisitable URL — a reload, a Back, a bookmark — and
 * every load would otherwise count another conversion. Comparing against an
 * identifier rather than a boolean is what lets a second, genuinely different
 * payment in the same tab report again.
 */
export function shouldReportConversion(marker: string | null, key: string): boolean {
  return marker !== key;
}

/**
 * The shape of a Stripe Checkout Session id.
 *
 * `cs_test_…` in test mode, `cs_live_…` in live mode, then a run of URL-safe
 * characters. Checked before the value is treated as a payment landing at all.
 *
 * **THIS IS A BAR, NOT A PROOF, AND SAYING SO IS THE POINT.** Nothing here
 * contacts Stripe — the page makes no network call — so a well-formed string
 * somebody typed passes. What it buys is that the leftover REQUEST payload in
 * `sessionStorage` cannot, on its own, turn `/book/confirmed/` into a
 * conversion and a confident heading; an arrival has to at least look like it
 * came back from a payment. The user's own framing when this was settled: the
 * old `/book/received/` conversion was equally spoofable, so nothing gets
 * worse, and a spoofed conversion pollutes only our own Ads data.
 */
const STRIPE_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,255}$/;

export function isCheckoutSessionId(value: string | null | undefined): value is string {
  return typeof value === 'string' && STRIPE_SESSION_ID.test(value);
}

/**
 * The Checkout Session id this page was reached with, or null.
 *
 * Takes the query string rather than reading `location`, so
 * `verify-booking-confirmation.ts` can drive it without a browser — the same
 * split the module header describes for `conversionCalls`.
 */
export function paidLandingSessionId(search: string, param: string): string | null {
  let value: string | null;
  try {
    value = new URLSearchParams(search).get(param);
  } catch {
    return null;
  }
  return isCheckoutSessionId(value) ? value : null;
}

/** One `gtag('event', …)` call, described rather than made. */
export type GtagCall = { event: string; params: Record<string, unknown> };

/**
 * The conversion calls for a PAID booking, in the order to fire them.
 *
 * ── THE CONVERSION IS THE PAYMENT, NOT THE REQUEST (BK-32, N5) ─────────────
 *
 * Under P9 a submitted form is a REQUEST that the office may decline and nobody
 * has paid for. Counting it as a conversion would bid Google Ads money against
 * leads, half of which never become jobs — so `/book/received/` fires nothing
 * at all, and this is reached only from the Stripe redirect.
 *
 * ── KEYED ON THE CHECKOUT SESSION, NOT ON THE BOOKING ID ───────────────────
 *
 * `sessionStorage` is EMPTY whenever the customer pays from the link in their
 * approval email in another tab, another browser, or on their phone — which is
 * the common case, not the edge one, because the email arrives after the office
 * reviews. Keying on the booking id would therefore drop the conversion for
 * most real payers. The session id is in the URL on every legitimate landing,
 * is unique per payment, and is identical whether or not the stored payload
 * survived — so one payment yields exactly one `transaction_id` either way.
 *
 * Google Ads fires only when both halves of `send_to` are configured — a
 * `send_to` of `undefined/undefined` is a silently discarded conversion, which
 * is worse than none because it looks like tracking. GA4's `booking_confirmed`
 * fires regardless: it needs no label, and GA4 is where the funnel is read.
 *
 * `booking_id` rides along on the GA4 event ONLY when a stored payload supplied
 * one. It is omitted rather than faked for the cross-device payer, on the same
 * rule the previous version applied to a non-positive id: a made-up identifier
 * collides across bookings and is worse than an absent one.
 *
 * **Accepted and not to be fixed:** a customer who pays and closes the tab
 * never lands here, so their conversion never registers. That undercount is
 * inherent to client-side conversion tracking. There is no server-side
 * conversion path and one must not be invented.
 */
export function conversionCalls(input: {
  awId: string | undefined;
  bookingLabel: string | undefined;
  sessionId: string;
  id: number;
}): GtagCall[] {
  const { awId, bookingLabel, sessionId, id } = input;
  const calls: GtagCall[] = [];

  if (awId && bookingLabel) {
    calls.push({
      event: 'conversion',
      params: {
        send_to: `${awId}/${bookingLabel}`,
        transaction_id: sessionId,
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
  /** The Checkout Session id from the URL. Null means this is not a payment landing. */
  sessionId: string | null;
  /** From the stored payload, when there is one. 0 when there is not. */
  id: number;
}): ConversionReport | null {
  const { marker, awId, bookingLabel, sessionId, id } = input;
  // NO SESSION, NO CONVERSION. This is what makes a leftover `/book/received/`
  // payload, a bookmark, and a hand-typed URL all fire nothing.
  if (!isCheckoutSessionId(sessionId)) return null;
  if (!shouldReportConversion(marker, sessionId)) return null;
  return { calls: conversionCalls({ awId, bookingLabel, sessionId, id }), marker: sessionId };
}
