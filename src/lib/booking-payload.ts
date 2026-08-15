/**
 * Parsing and validation for a submitted booking.
 *
 * Pure: unknown JSON in, either a typed payload or a list of field errors out.
 * No database, no clock of its own, no environment. Slot *availability* is not
 * decided here — that needs the DB and lives in the endpoint; this module only
 * establishes that the shape is sane and the instant is a real grid time.
 *
 * Two rules worth not rediscovering:
 *   - `draft_id` is NEVER accepted from the client. The endpoint claims files
 *     using the id that `verifyDraftToken` returns, so a caller cannot present
 *     their own valid token alongside a victim's draft id.
 *   - Insurance identifiers are dropped for a private-pay booking rather than
 *     merely ignored, so stale form state cannot persist a claim number.
 *
 * The set of valid services is injected rather than imported. `SERVICE_LABELS`
 * lives in `db.ts` beside the Neon import, and importing it here would pull the
 * driver into every consumer — including BK-03's browser island. Same reason
 * `booking-uploads.ts` stays free of `@vercel/blob`.
 */

import { isSlotOnGrid } from './booking-time';

export const MAX_FIELD_LENGTHS = {
  name: 120,
  phone: 40,
  email: 200,
  service: 60,
  description: 4000,
  address: 300,
  city: 120,
  postal_code: 20,
  insurer_name: 160,
  policy_number: 80,
  claim_number: 80,
} as const;

/** Rejected outright — never stored, never echoed. */
const FORBIDDEN_KEYS = ['draft_id', 'draftId', 'id', 'status', 'pipeline_stage', 'source'];

export type BookingPayload = {
  name: string;
  phone: string;
  email: string | null;
  service: string;
  description: string | null;
  address: string;
  city: string;
  postal_code: string | null;
  payment_route: 'insurance' | 'private';
  insurer_name: string | null;
  policy_number: string | null;
  claim_number: string | null;
  /** A validated grid instant. Whether it is *bookable* is the endpoint's call. */
  slotStart: Date;
  /** Present only when consent was given; its presence IS the consent (CASL). */
  smsConsent: boolean;
  /**
   * Whether the assessment fee terms were acknowledged (BK-27). Always false on
   * an admin entry, which is exempt — see `ParseOptions.entry`. `insertBooking`
   * turns true into a `terms_acked_at` stamp.
   */
  termsAcked: boolean;
  /** The raw token, still unverified. The endpoint decides what it means. */
  draftToken: string | null;
};

export type FieldError = { field: string; message: string };

export type ParseResult =
  | { ok: true; payload: BookingPayload }
  | { ok: false; errors: FieldError[] };

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Digits only, 10 or 11 with a leading 1 — North American, which is all this
 * business serves.
 *
 * Exported so BK-03's island validates with the *same* predicate rather than a
 * second copy of the rule. Two hand-built copies drifting apart is the failure
 * this module's header already warns about.
 */
export function isPlausiblePhone(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

/**
 * Deliberately loose. A stricter pattern rejects valid addresses that a typo
 * check would never have caught anyway, and this predicate decides *shape*, not
 * presence — whether an address is required at all is `entry`'s business, below.
 *
 * Presence matters more than it used to. Since BK-22 a public booking cannot be
 * made without an email (client decision, ROADMAP P7), so this runs on a field
 * the visitor is now compelled to fill; a false rejection here is a customer
 * turned away rather than a nicety declined. Loose stays loose.
 */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= MAX_FIELD_LENGTHS.email;
}

export type ParseOptions = {
  /** Valid `service` values. The endpoint passes the keys of `SERVICE_LABELS`. */
  allowedServices: ReadonlySet<string>;
  /**
   * Which door this submission came through. Public bookings must carry an
   * email; admin entries need not — the office types what the customer gave
   * them over the phone, and that is often a number and nothing else (client
   * exemption, ROADMAP P7: "if we enter ourselves … it won't go to review
   * process").
   *
   * A discriminator rather than an `isAdmin`/`requireEmail` boolean, for two
   * reasons that are worth not rediscovering. A boolean's permissive value is
   * `false`, so every way of producing `undefined` — a `Partial`, an
   * `as ParseOptions` cast, a spread from a stale object — **fails open** and
   * silently exempts the public form, which is the one path that must not be
   * exempt. And it is non-optional so that adding it broke all six construction
   * sites at `astro check`, which is the only mechanism that makes "every caller
   * answered this question" true rather than hoped.
   *
   * Note this does NOT contradict `booking-admin-entry.ts`'s rule against
   * threading flags through shared predicates. That rule is about the slot
   * bypass, a *whole predicate* (`isSlotBookable`) admin skips by not calling
   * it. Email is one field inside a parse both paths need in full, so there is
   * nothing structural to skip. What keeps the rule's intent is that the public
   * path cannot name the exemption: `parseAdminEntry` hard-codes `'admin'`
   * itself and its signature forbids a caller supplying one.
   */
  entry: 'public' | 'admin';
};

export function parseBookingPayload(input: unknown, options: ParseOptions): ParseResult {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: [{ field: '_', message: 'Expected a JSON object.' }] };
  }
  const raw = input as Record<string, unknown>;

  for (const key of FORBIDDEN_KEYS) {
    if (key in raw) add(key, 'This field is not accepted.');
  }

  const required = (key: keyof typeof MAX_FIELD_LENGTHS, label: string) => {
    const value = str(raw[key]);
    if (!value) {
      add(key, `${label} is required.`);
      return '';
    }
    if (value.length > MAX_FIELD_LENGTHS[key]) {
      add(key, `${label} is too long (max ${MAX_FIELD_LENGTHS[key]}).`);
      return '';
    }
    return value;
  };

  const optional = (key: keyof typeof MAX_FIELD_LENGTHS, label: string) => {
    const value = str(raw[key]);
    if (value && value.length > MAX_FIELD_LENGTHS[key]) {
      add(key, `${label} is too long (max ${MAX_FIELD_LENGTHS[key]}).`);
      return null;
    }
    return value;
  };

  const name = required('name', 'Name');
  const phone = required('phone', 'Phone number');
  if (phone && !isPlausiblePhone(phone)) add('phone', 'Enter a 10-digit phone number.');

  // Email is required on the public form and optional for admin entry (see
  // `ParseOptions.entry`). It stays parsed by `optional` rather than `required`
  // so that the value handed to the payload is `null` and never `''` —
  // `required` returns an empty string on failure, and `BookingPayload.email`
  // is `string | null`. The presence test re-reads `raw.email` instead of
  // testing the parsed value on purpose: a too-long address parses to `null`
  // having already reported "too long", and reporting "required" beside it
  // would tell the visitor to fill a field they just filled.
  const email = optional('email', 'Email');
  if (email && !isPlausibleEmail(email)) add('email', 'Enter a valid email address.');
  if (options.entry === 'public' && str(raw.email) === null) add('email', 'Email is required.');

  const service = required('service', 'Service');
  if (service && !options.allowedServices.has(service)) {
    add('service', 'Choose one of the listed services.');
  }

  const address = required('address', 'Address');
  const city = str(raw.city) ?? 'Edmonton';
  if (city.length > MAX_FIELD_LENGTHS.city) add('city', 'City is too long.');

  const description = optional('description', 'Description');
  const postal_code = optional('postal_code', 'Postal code');

  const paymentRoute = str(raw.payment_route);
  if (paymentRoute !== 'insurance' && paymentRoute !== 'private') {
    add('payment_route', 'Choose insurance or private pay.');
  }

  // Read insurance fields only on the insurance route. On the private route
  // they are dropped, not merely unused, so a stale toggle cannot persist a
  // claim number against a private-pay job.
  const insurance = paymentRoute === 'insurance';
  const insurer_name = insurance ? optional('insurer_name', 'Insurance company') : null;
  const policy_number = insurance ? optional('policy_number', 'Policy number') : null;
  const claim_number = insurance ? optional('claim_number', 'Claim number') : null;
  if (insurance && !insurer_name) add('insurer_name', 'Insurance company is required.');

  const slotRaw = str(raw.slot_start);
  let slotStart: Date | null = null;
  if (!slotRaw) {
    add('slot_start', 'Choose an appointment time.');
  } else {
    const parsed = new Date(slotRaw);
    if (Number.isNaN(parsed.getTime())) {
      add('slot_start', 'That appointment time is not a valid timestamp.');
    } else if (!isSlotOnGrid(parsed)) {
      // The picker can only produce grid instants, so this means a hand-crafted
      // request. The endpoint still re-checks availability separately.
      add('slot_start', 'That is not an available appointment time.');
    } else {
      slotStart = parsed;
    }
  }

  const consentRaw = raw.sms_consent;
  if (consentRaw !== undefined && typeof consentRaw !== 'boolean') {
    add('sms_consent', 'Consent must be true or false.');
  }

  // BK-27's fee-terms acknowledgment. Two checks, deliberately separate: the
  // shape check runs on both doors, because `terms_ack: "true"` is a malformed
  // request whichever door it came through, while the *requirement* is public
  // only (the office explains the terms on the phone — the same exemption BK-22
  // gave email and photos, through the same discriminator).
  //
  // The requirement tests `!== true` rather than falsiness so that only a
  // literal boolean true clears it. An acknowledgment is a statement the
  // customer made; `1`, `"on"` and `"true"` are shapes a hand-built request can
  // wear, and none of them is that statement.
  const termsRaw = raw.terms_ack;
  if (termsRaw !== undefined && typeof termsRaw !== 'boolean') {
    add('terms_ack', 'Acknowledgment must be true or false.');
  } else if (options.entry === 'public' && termsRaw !== true) {
    add('terms_ack', 'Please confirm you understand the assessment terms.');
  }

  const draftTokenRaw = raw.draft_token;
  if (draftTokenRaw !== undefined && typeof draftTokenRaw !== 'string') {
    add('draft_token', 'Invalid upload session.');
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    payload: {
      name,
      phone,
      email,
      service,
      description,
      address,
      city,
      postal_code,
      payment_route: paymentRoute as 'insurance' | 'private',
      insurer_name,
      policy_number,
      claim_number,
      slotStart: slotStart as Date,
      smsConsent: consentRaw === true,
      // Not `options.entry === 'public'`: what is recorded is what the customer
      // actually ticked, not what the door required. An admin entry therefore
      // carries false and stamps nothing, which is what the exemption means.
      termsAcked: termsRaw === true,
      draftToken: typeof draftTokenRaw === 'string' ? draftTokenRaw : null,
    },
  };
}
