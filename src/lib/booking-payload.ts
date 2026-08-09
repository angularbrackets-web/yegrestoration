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
 * Deliberately loose. A stricter pattern rejects valid addresses, and email is
 * optional here anyway — the phone number is how this business actually calls
 * people back.
 */
export function isPlausibleEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= MAX_FIELD_LENGTHS.email;
}

export type ParseOptions = {
  /** Valid `service` values. The endpoint passes the keys of `SERVICE_LABELS`. */
  allowedServices: ReadonlySet<string>;
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

  const email = optional('email', 'Email');
  if (email && !isPlausibleEmail(email)) add('email', 'Enter a valid email address.');

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
      draftToken: typeof draftTokenRaw === 'string' ? draftTokenRaw : null,
    },
  };
}
