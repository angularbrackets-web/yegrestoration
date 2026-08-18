/**
 * What an assessment costs. One module, every consumer.
 *
 * Read by the Svelte island (to show the customer a price before they send a
 * request), by the API routes (to validate and to snapshot an amount at
 * approval), and by `tsx` verify scripts. It is therefore **pure and env-free**,
 * the same constraint `booking-config.ts` carries and the reason this is not in
 * `db.ts`: that module imports the Neon driver, which an island cannot load.
 *
 * ── THE ONE RULE ───────────────────────────────────────────────────────────
 *
 * **A price never originates in a request.** The form posts a tier KEY; the
 * server computes the amount from that key plus the stored service and the
 * stored slot. This is the whole defence against a hand-built payload paying
 * $1 for the sketch tier, and it is why every figure here is an integer of
 * cents rather than a float or a display string.
 *
 * That the form now *displays* a price changes nothing about it. Display is not
 * trust: the island renders `assessmentQuote(...)` for the customer's benefit,
 * and the server calls the same function again on data it stored itself.
 *
 * The one legitimate exception is BK-23's approval screen, where an
 * authenticated admin may adjust the amount before a Checkout Session exists.
 * That is a server-side action on an existing row, not an input to one.
 */

import { TIMEZONE } from './booking-config';
import { localDateKey, weekdayOfDateKey } from './booking-time';

/**
 * The three assessments, in the client's own structure (2026-08-14, unchanged
 * by the 2026-08-18 pricing update).
 *
 * They are ALTERNATIVES, not line items — `sketch` includes everything
 * `report` includes. The copy in `booking-copy.ts` says so for the same reason.
 */
export type AssessmentTier = 'standard' | 'report' | 'sketch';

/** Declaration order is render order on the form. */
export const ASSESSMENT_TIERS: readonly AssessmentTier[] = ['standard', 'report', 'sketch'];

export function isAssessmentTier(value: unknown): value is AssessmentTier {
  return typeof value === 'string' && (ASSESSMENT_TIERS as readonly string[]).includes(value);
}

/**
 * The default price of each tier, in CENTS, EX-GST.
 *
 * The client's own figures, relayed 2026-08-14: $399 / $699 / $1,199. They are
 * not implementer drafting and must not be edited on anybody's judgment.
 * `verify-booking-pricing.ts` asserts these against the figures in
 * `FEE_TERMS_ITEMS`, so the copy and the charge cannot drift apart silently.
 */
const TIER_DEFAULT_CENTS: Record<AssessmentTier, number> = {
  standard: 39900,
  report: 69900,
  sketch: 119900,
};

/**
 * Per-service overrides, keyed by the SERVICE_LABELS key.
 *
 * Client, 2026-08-18: *"we have to be a bit more competitive with mold
 * estimation"* — and *"for now"*, which is why this is a literal map a price
 * move edits in one line rather than a rules engine.
 *
 * A service with no entry falls through to the default, so an un-overridden
 * service is not a branch anywhere. Adding a second service later is one more
 * entry and no new code.
 *
 * NOTE THE SPELLING. The key is `mold`, matching `SERVICE_LABELS` in `db.ts`
 * and the value the form posts. The customer-facing copy says "mould"; the data
 * says "mold". Getting this wrong does not throw — it silently charges the
 * standard price, which is the failure mode nobody notices.
 */
const TIER_SERVICE_OVERRIDE_CENTS: Record<string, Partial<Record<AssessmentTier, number>>> = {
  mold: {
    standard: 38500,
    report: 64500,
    sketch: 118500,
  },
};

/**
 * The after-hours multiplier, as a fraction so the arithmetic stays integral.
 *
 * Client, 2026-08-18: *"Yes weekend is extra"* — 1.5x, and it applies to
 * ORDINARY weekend bookings made online, not only to emergencies. Saturday and
 * Sunday are normal bookable days here (`CLOSED_WEEKDAYS` closes Fridays only),
 * so this is a live path on every weekend slot the picker offers.
 *
 * A float `* 1.5` would be correct for all six of today's figures and wrong for
 * the first odd-cent price anybody enters. `round(cents * 3 / 2)` is right for
 * all of them.
 */
export const AFTER_HOURS_NUMERATOR = 3;
export const AFTER_HOURS_DENOMINATOR = 2;

/** Saturday and Sunday, as `Date.getDay()` numbers. */
const AFTER_HOURS_WEEKDAYS: readonly number[] = [0, 6];

/** GST, as a whole-number percent. Canada-wide 5%; Alberta adds no PST. */
export const GST_RATE_PERCENT = 5;

/**
 * The travel fee (BK-23 Task 7). Constants only — **nothing here computes a
 * distance.**
 *
 * Client, 2026-08-18: $1.15/km round trip beyond 30 km from the office. There
 * is no distance API in this infrastructure — no maps key, no geo code, nothing
 * billed — and the client's instruction was explicitly not to block on adding
 * one. So the office reads the rule, looks at the maps link the admin page
 * already renders, and types a number.
 *
 * TODO(BK-23): a computed suggestion needs an office origin coordinate, a
 * geocoder for the customer address, and a routing call — three new failure
 * modes and a billed key on a page the office loads all day. Revisit only if
 * the manual number turns out to be the bottleneck.
 *
 * **A travel fee is never applied automatically.** `assessmentQuote` defaults it
 * to zero and only ever uses what a caller passes in.
 */
export const TRAVEL_FEE_CENTS_PER_KM = 115;
export const TRAVEL_FEE_FREE_RADIUS_KM = 30;

/**
 * True when a slot falls on a Saturday or Sunday **in America/Edmonton**.
 *
 * The zone is the whole point. `slotStart.getDay()` reads the SERVER's zone,
 * which on Vercel is UTC — so a Friday 15:30 Edmonton slot (22:30 UTC) is still
 * Friday, but the boundary cases around midnight are not, and they move twice a
 * year with DST. Going through `localDateKey` is what makes this a statement
 * about the customer's Saturday rather than the server's.
 */
export function isAfterHoursSlot(slotStart: Date, tz: string = TIMEZONE): boolean {
  return AFTER_HOURS_WEEKDAYS.includes(weekdayOfDateKey(localDateKey(slotStart, tz)));
}

/** The base price for a tier on a service, before any multiplier or tax. */
export function tierBaseCents(tier: AssessmentTier, service: string): number {
  return TIER_SERVICE_OVERRIDE_CENTS[service]?.[tier] ?? TIER_DEFAULT_CENTS[tier];
}

/** The advertised figure for a tier, ignoring service overrides. What the terms box states. */
export function tierDefaultCents(tier: AssessmentTier): number {
  return TIER_DEFAULT_CENTS[tier];
}

export type AssessmentQuote = {
  /** The tier/service price with the after-hours multiplier already applied. */
  baseCents: number;
  /** Whether the multiplier was applied — the form has to say *why* a price is higher. */
  afterHours: boolean;
  /** Admin-entered at approval, never computed here. Zero on every customer-facing quote. */
  travelCents: number;
  subtotalCents: number;
  gstCents: number;
  totalCents: number;
};

/**
 * THE ONLY WAY ANYONE GETS A NUMBER. Every surface — the form, the approval
 * screen's pre-fill, the emails, the Stripe line items — reads this.
 *
 * Rounding happens twice and only twice: once on the multiplier, once on GST.
 * `totalCents` is `subtotalCents + gstCents` by construction rather than a
 * third rounded computation, so the itemization a customer reads always adds up
 * to the amount they are charged. BK-32 asserts that equality against the
 * Stripe session before creating it.
 */
export function assessmentQuote(input: {
  tier: AssessmentTier;
  service: string;
  slotStart: Date;
  /** Cents. Defaults to zero — a travel fee is only ever one an admin typed. */
  travelFeeCents?: number;
}): AssessmentQuote {
  const afterHours = isAfterHoursSlot(input.slotStart);
  const listed = tierBaseCents(input.tier, input.service);
  const baseCents = afterHours
    ? Math.round((listed * AFTER_HOURS_NUMERATOR) / AFTER_HOURS_DENOMINATOR)
    : listed;

  const travelCents = Math.max(0, Math.round(input.travelFeeCents ?? 0));
  const subtotalCents = baseCents + travelCents;
  const gstCents = Math.round((subtotalCents * GST_RATE_PERCENT) / 100);

  return {
    baseCents,
    afterHours,
    travelCents,
    subtotalCents,
    gstCents,
    totalCents: subtotalCents + gstCents,
  };
}

/**
 * `39900` → `$399.00`. Canadian dollars, and the symbol is bare `$` because
 * every surface this renders on is already unambiguously Canadian.
 *
 * Not `Intl.NumberFormat`: it emits a non-breaking space in some locales and a
 * `CA$` prefix in others, and the figures in `FEE_TERMS_ITEMS` are hand-written
 * as `$399`. Two spellings of the same price on one page is the confusion this
 * whole module exists to prevent.
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}$${dollars.toLocaleString('en-CA')}.${rest}`;
}
