/**
 * The pure half of the booking form island.
 *
 * No DOM, no network, no clock of its own — everything here is a function from
 * values to values, so `scripts/verify-booking-form.ts` can check it the way
 * `verify-booking-payload.ts` checks the server validator. The Svelte component
 * is then only wiring: state, markup, and `fetch`.
 *
 * Three rules drive most of what looks fussy below:
 *
 *   - **The server's field rules are imported, never re-typed.** `MAX_FIELD_LENGTHS`,
 *     `isPlausiblePhone` and `isPlausibleEmail` come from `booking-payload.ts`,
 *     which is what the endpoint actually runs. A second copy of "what a valid
 *     phone number is" is how a form starts rejecting what the server accepts.
 *   - **`null` is not the same as absent.** `booking-payload.ts` 422s on a
 *     `draft_token` or `sms_consent` of `null`, so the assembler omits keys
 *     rather than nulling them.
 *   - **The browser's limit checks are the only readable upload messages there
 *     are.** `@vercel/blob`'s client discards the upload-token route's response
 *     body and throws a fixed string, so nothing `upload-token.ts` says ever
 *     reaches a user. See BK-03.
 */

import {
  MAX_FILES_PER_BOOKING,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  SUPPORT_PHONE,
} from './booking-config';
import {
  MAX_FIELD_LENGTHS,
  isPlausibleEmail,
  isPlausiblePhone,
  type FieldError,
} from './booking-payload';
import { EXTENSION_TO_TYPE, formatBytes, isAllowedContentType } from './booking-uploads';

export type Step = 1 | 2 | 3;

export const FIRST_STEP: Step = 1;
export const LAST_STEP: Step = 3;

/** Everything the three steps collect. Strings stay strings until assembly. */
export type FormValues = {
  /** The exact `start` string an `AvailableSlot` carried. Never re-derived. */
  slotStart: string | null;
  name: string;
  phone: string;
  email: string;
  service: string;
  address: string;
  city: string;
  postal_code: string;
  description: string;
  payment_route: 'insurance' | 'private';
  insurer_name: string;
  policy_number: string;
  claim_number: string;
  smsConsent: boolean;
};

export function emptyFormValues(): FormValues {
  return {
    slotStart: null,
    name: '',
    phone: '',
    email: '',
    service: '',
    address: '',
    city: 'Edmonton',
    postal_code: '',
    description: '',
    payment_route: 'private',
    insurer_name: '',
    policy_number: '',
    claim_number: '',
    smsConsent: false,
  };
}

/**
 * Apply `?service=` / `?route=` to a fresh set of values.
 *
 * BK-10 points every service page's CTA at `/book/?service=<id>` and the
 * insurance page's at `/book/?route=insurance`, so a visitor who has already
 * said what they need does not say it twice.
 *
 * **NOTHING HERE IS TRUSTED.** Each parameter can only ever select an option
 * the form already offers: an unknown service id, a misspelled route, or an
 * injected string is ignored and the field keeps its default. No write path
 * reads these — the server re-validates `service` against its own allow-list
 * (`booking-payload.ts`) regardless of what the form did — so this is a
 * convenience, not an input channel.
 *
 * Pure, and takes the query string rather than reading `location`, so
 * `verify-booking-form.ts` can drive it.
 */
export function applyPrefill(
  values: FormValues,
  search: string,
  allowedServices: ReadonlySet<string>,
): FormValues {
  const params = new URLSearchParams(search);
  const next = { ...values };

  const service = params.get('service');
  if (service !== null && allowedServices.has(service)) next.service = service;

  const route = params.get('route');
  if (route === 'insurance' || route === 'private') next.payment_route = route;

  return next;
}

/**
 * Which step owns which field, for routing a server 422 back to the input the
 * visitor can actually see. Server field names, not local ones — this map is
 * read against `parseBookingPayload`'s error output.
 */
export const FIELD_STEPS: Readonly<Record<string, Step>> = {
  slot_start: 1,
  name: 2,
  phone: 2,
  email: 2,
  service: 2,
  address: 2,
  city: 2,
  postal_code: 2,
  description: 2,
  payment_route: 2,
  insurer_name: 2,
  policy_number: 2,
  claim_number: 2,
  // BK-22's server-side file requirement reports on a field no input owns. It
  // still needs a step, or `stepForErrors` returns undefined for it,
  // `mapCommitResponse` falls through to the generic form error, and the
  // visitor reads "Please check your details and try again" with nothing on the
  // page highlighted and no way to tell what is wrong.
  files: 3,
};

// ---------------------------------------------------------------------------
// Step validation
// ---------------------------------------------------------------------------

function tooLong(value: string, key: keyof typeof MAX_FIELD_LENGTHS): boolean {
  return value.trim().length > MAX_FIELD_LENGTHS[key];
}

/**
 * Field errors for one step, in the order the fields appear.
 *
 * Mirrors `parseBookingPayload` deliberately and incompletely: it cannot know
 * whether a slot is still free, and it does not try. The server decides that.
 *
 * `attachmentCount` is BK-22's file requirement, and it is **non-optional so
 * that every call site had to answer it** — a default of 0 would have blocked
 * every step-3 caller that had not been updated, and a default of 1 would have
 * silently exempted them. What it must be handed is the number of attachments
 * in `{done, failed}` — NOT `done` alone. See step 3.
 */
export function validateStep(
  step: Step,
  values: FormValues,
  allowedServices: ReadonlySet<string>,
  attachmentCount: number,
): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => errors.push({ field, message });

  if (step === 1) {
    if (!values.slotStart) add('slot_start', 'Choose an appointment time.');
    return errors;
  }

  if (step === 2) {
    const name = values.name.trim();
    if (!name) add('name', 'Name is required.');
    else if (tooLong(name, 'name')) add('name', `Name is too long (max ${MAX_FIELD_LENGTHS.name}).`);

    const phone = values.phone.trim();
    if (!phone) add('phone', 'Phone number is required.');
    else if (!isPlausiblePhone(phone)) add('phone', 'Enter a 10-digit phone number.');

    // Required since BK-22, mirroring `parseBookingPayload`'s public arm. The
    // island mirrors the server on purpose; leaving this permissive would let a
    // visitor walk to step 3, submit, and be bounced back here by a 422 for a
    // field the page told them was optional.
    const email = values.email.trim();
    if (!email) add('email', 'Email is required.');
    else if (!isPlausibleEmail(email)) add('email', 'Enter a valid email address.');

    if (!values.service) add('service', 'Choose the service you need.');
    else if (!allowedServices.has(values.service)) {
      add('service', 'Choose one of the listed services.');
    }

    const address = values.address.trim();
    if (!address) add('address', 'Address is required.');
    else if (tooLong(address, 'address')) add('address', 'Address is too long.');

    if (tooLong(values.city, 'city')) add('city', 'City is too long.');
    if (tooLong(values.postal_code, 'postal_code')) add('postal_code', 'Postal code is too long.');
    if (tooLong(values.description, 'description')) {
      add('description', `Please keep this under ${MAX_FIELD_LENGTHS.description} characters.`);
    }

    if (values.payment_route === 'insurance') {
      if (!values.insurer_name.trim()) add('insurer_name', 'Insurance company is required.');
      else if (tooLong(values.insurer_name, 'insurer_name')) {
        add('insurer_name', 'Insurance company is too long.');
      }
      if (tooLong(values.policy_number, 'policy_number')) {
        add('policy_number', 'Policy number is too long.');
      }
      if (tooLong(values.claim_number, 'claim_number')) {
        add('claim_number', 'Claim number is too long.');
      }
    }
    return errors;
  }

  // Step 3 collects a photo or video — required since BK-22 — and SMS consent,
  // which is not. Consent still never blocks a booking: under CASL it gates
  // reminders, not the appointment, and that is a legal position rather than a
  // UX preference.
  //
  // The count is of attachments in `{done, failed}`, not `done` alone, and the
  // difference is the whole of Q3. A 100 MB video stalled on bad wifi is
  // *exactly* the case this form is built for; `skipUpload` exists so that
  // visitor can escape without losing everything they typed. Counting only
  // completed uploads would let them out of the stall and straight into a step
  // that will not release them — while the **server would have accepted that
  // booking**, because the `appointment_files` row is written at token-mint
  // time, before the bytes. A client stricter than the server manufactures a
  // dead end out of nothing. The requirement still stops the visitor who
  // attaches nothing at all, who is the person the client actually asked about.
  if (attachmentCount === 0) add('files', 'Add at least one photo or video.');
  return errors;
}

/** The earliest step holding one of these errors, or null if none is mappable. */
export function stepForErrors(errors: readonly FieldError[]): Step | null {
  const steps = errors
    .map((e) => FIELD_STEPS[e.field])
    .filter((s): s is Step => s !== undefined);
  if (steps.length === 0) return null;
  return steps.reduce((a, b) => (a < b ? a : b));
}

// ---------------------------------------------------------------------------
// Payload assembly
// ---------------------------------------------------------------------------

/**
 * The request body for `POST /api/booking/create/`.
 *
 * Optional blanks are omitted rather than sent empty, insurance identifiers are
 * dropped on the private route (matching the server, so a stale toggle cannot
 * persist a claim number), and `draft_token` is absent — not null — when there
 * is no draft.
 */
export function assembleBookingPayload(
  values: FormValues,
  draftToken: string | null,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: values.name.trim(),
    phone: values.phone.trim(),
    service: values.service,
    address: values.address.trim(),
    payment_route: values.payment_route,
    slot_start: values.slotStart,
    sms_consent: values.smsConsent === true,
  };

  const optional: [string, string][] = [
    ['email', values.email],
    ['city', values.city],
    ['postal_code', values.postal_code],
    ['description', values.description],
  ];
  for (const [key, raw] of optional) {
    const value = raw.trim();
    if (value) payload[key] = value;
  }

  if (values.payment_route === 'insurance') {
    const insurance: [string, string][] = [
      ['insurer_name', values.insurer_name],
      ['policy_number', values.policy_number],
      ['claim_number', values.claim_number],
    ];
    for (const [key, raw] of insurance) {
      const value = raw.trim();
      if (value) payload[key] = value;
    }
  }

  if (draftToken !== null) payload.draft_token = draftToken;

  return payload;
}

// ---------------------------------------------------------------------------
// File acceptance
// ---------------------------------------------------------------------------

/** The parts of a `File` this module needs. Keeps the checks testable in Node. */
export type FileLike = { name: string; type: string; size: number };

/**
 * The content type to upload a file as, or null if we do not accept it.
 *
 * `file.type` first, then the filename extension. The fallback is not
 * defensive padding: browsers routinely report `''` for HEIC, which is what an
 * iPhone produces by default, and `buildUploadPathname` throws on an unknown
 * type. Without this, the most common phone in Edmonton cannot attach a photo.
 */
export function resolveContentType(file: FileLike): string | null {
  const declared = file.type?.trim().toLowerCase() ?? '';
  if (declared && isAllowedContentType(declared)) return declared;

  const dot = file.name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = file.name.slice(dot + 1).toLowerCase();
  // `UPLOAD_EXTENSIONS` maps image/jpeg to the single spelling 'jpg', so a
  // `.jpeg` file whose type the browser did not report would otherwise be
  // refused — the same failure the fallback exists to prevent. The pathname is
  // still built from the canonical extension, so the server sees only 'jpg'.
  const canonical = ext === 'jpeg' ? 'jpg' : ext;
  return EXTENSION_TO_TYPE[canonical] ?? null;
}

export type FileAcceptance =
  | { ok: true; contentType: string }
  | { ok: false; message: string };

/**
 * Whether one more file may be attached.
 *
 * Mirrors the token-mint checks in `upload-token.ts`; it does not replace them.
 * The server's copy is the enforcement — but because the Blob SDK swallows the
 * server's message, this copy is the only one a visitor ever reads.
 */
export function checkFileAcceptance(
  file: FileLike,
  attached: readonly { size: number }[],
): FileAcceptance {
  if (attached.length >= MAX_FILES_PER_BOOKING) {
    return { ok: false, message: `You can attach up to ${MAX_FILES_PER_BOOKING} files.` };
  }

  if (!Number.isInteger(file.size) || file.size <= 0) {
    return { ok: false, message: 'That file looks empty.' };
  }

  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, message: `Each file must be under ${formatBytes(MAX_FILE_BYTES)}.` };
  }

  const total = attached.reduce((sum, f) => sum + f.size, 0);
  if (total + file.size > MAX_TOTAL_BYTES) {
    return {
      ok: false,
      message: `Attachments must total under ${formatBytes(MAX_TOTAL_BYTES)}.`,
    };
  }

  const contentType = resolveContentType(file);
  if (!contentType) {
    return { ok: false, message: 'That file type is not supported. Photos and videos only.' };
  }

  return { ok: true, contentType };
}

// ---------------------------------------------------------------------------
// Availability response
// ---------------------------------------------------------------------------

export type AvailabilityOutcome =
  | { ok: true; dates: unknown[] }
  | { ok: false; message: string };

/**
 * `availability.ts` answers a database failure with 500 and a body carrying no
 * `dates` key at all — deliberately, because an empty calendar is
 * indistinguishable from "fully booked" and would turn every visitor away while
 * looking healthy. Consuming that distinction is this function's whole job:
 * reading `body.dates.map` off a failure would throw mid-render and leave a
 * blank card, discarding the care BK-01 took.
 */
export function readAvailabilityResponse(status: number, body: unknown): AvailabilityOutcome {
  const dates = (body as { dates?: unknown } | null)?.dates;
  if (status === 200 && Array.isArray(dates)) return { ok: true, dates };
  return {
    ok: false,
    message: 'We could not load available times. Please call us and we will book you in.',
  };
}

// ---------------------------------------------------------------------------
// Commit response
// ---------------------------------------------------------------------------

export type CommitOutcome =
  | {
      kind: 'booked';
      id: number;
      slotLabel: string;
      filesAttached: number;
      /**
       * Whether the server actually sent the confirmation email. False is the
       * safe answer and the default: a customer told "check your email" who has
       * nothing is a support call, the reverse is a pleasant surprise.
       */
      emailSent: boolean;
    }
  /** Per-field errors that map to a visible input. */
  | { kind: 'fields'; errors: FieldError[]; step: Step }
  /** The slot went away. Refetch availability and go back to step 1. */
  | { kind: 'slotGone'; message: string; code: string }
  /** The upload session died. Drop the draft; photos must be re-attached. */
  | { kind: 'draftExpired'; message: string }
  /** Anything with no field to attach it to. Shown at form level. */
  | { kind: 'formError'; message: string };

/**
 * Re-exported, not defined here.
 *
 * It moved to `booking-config.ts` in BK-05 so the email builder could reach it
 * without importing this module's validation machinery. The re-export keeps
 * BK-03's and BK-04's call sites untouched.
 */
export { SUPPORT_PHONE };

/**
 * Every message the island can show for a failed commit.
 *
 * **The island never renders server prose.** BK-02 split 409 into `slot_taken`
 * and `slot_unavailable`, and 422 from 409, precisely so the client could
 * decide from codes; rendering the server's sentence as well buys nothing and
 * costs three things. It drops the phone number from the messages that most
 * need it (429 and 500 both mean "stop trying and call"). It tells a visitor to
 * "Reload the page" on a 400, which is the one action that throws away the
 * address and description they just typed — the exact harm the 409 branch
 * exists to prevent. And it makes every response body a potential echo channel
 * for whatever the server put in `error`.
 */
const MESSAGES = {
  generic: `Something went wrong. Please call us at ${SUPPORT_PHONE}.`,
  slot_taken: 'That time was just booked by someone else. Please pick another.',
  slot_unavailable: 'That time is no longer available. Please pick another.',
  draftExpired:
    'Your photo session expired. Your booking details are safe — re-attach the photos and confirm again.',
  invalidFields: 'Please check your details and try again.',
  rateLimited: `Too many attempts just now. Please wait a moment, or call us at ${SUPPORT_PHONE}.`,
  serverError: `Something went wrong on our end. Please call us at ${SUPPORT_PHONE} and we'll book you in.`,
} as const;

/**
 * Maps a `create.ts` response onto something the island can render.
 *
 * The status codes carry the meaning; the prose is deliberately discarded.
 */
export function mapCommitResponse(status: number, body: unknown): CommitOutcome {
  const data = (body ?? {}) as Record<string, unknown>;

  if (status === 201) {
    return {
      kind: 'booked',
      id: typeof data.id === 'number' ? data.id : 0,
      slotLabel: typeof data.slotLabel === 'string' ? data.slotLabel : '',
      filesAttached: typeof data.filesAttached === 'number' ? data.filesAttached : 0,
      // Only a literal `true` counts. A missing field, a string "true", or a
      // response from a build that predates BK-05 all mean "we cannot claim an
      // email was sent" — and claiming it wrongly is the expensive direction.
      emailSent: data.emailSent === true,
    };
  }

  if (status === 422) {
    const raw = Array.isArray(data.fields) ? (data.fields as FieldError[]) : [];
    const errors = raw.filter(
      (e): e is FieldError => !!e && typeof e.field === 'string' && typeof e.message === 'string',
    );
    const step = stepForErrors(errors);
    // A 422 can arrive with no `fields` at all (malformed JSON), or carrying
    // only fields with no input behind them — `_`, `sms_consent`, `draft_token`,
    // or one of the server's forbidden keys. Mapping blindly would either throw
    // or highlight nothing, and the form would look dead after submit.
    if (errors.length === 0 || step === null) {
      return { kind: 'formError', message: MESSAGES.invalidFields };
    }
    return { kind: 'fields', errors, step };
  }

  if (status === 409) {
    const code = typeof data.code === 'string' ? data.code : 'slot_unavailable';
    return {
      kind: 'slotGone',
      code,
      message: code === 'slot_taken' ? MESSAGES.slot_taken : MESSAGES.slot_unavailable,
    };
  }

  if (status === 400) {
    return { kind: 'draftExpired', message: MESSAGES.draftExpired };
  }

  if (status === 429) return { kind: 'formError', message: MESSAGES.rateLimited };
  if (status >= 500) return { kind: 'formError', message: MESSAGES.serverError };

  return { kind: 'formError', message: MESSAGES.generic };
}

// ---------------------------------------------------------------------------
// Single-flight submit
// ---------------------------------------------------------------------------

export type DraftSession<T> = {
  /** The session, minting at most once. Concurrent callers share one attempt. */
  get(): Promise<T | null>;
  /** Forget it, so the next `get()` mints again. Used when the server rejects the token. */
  reset(): void;
};

/**
 * One draft per form session, even when several files are chosen at once.
 *
 * Guarding on the *resolved* session is not enough: the value is only assigned
 * after the fetch settles, so selecting three files at once fires three mints
 * before the first returns. That burns three of the 20 drafts an IP gets per
 * hour, and — worse — leaves the last mint's token paired with pathnames built
 * from an earlier draft's id, so `parseUploadPathname` rejects them and the
 * photos silently never attach. Memoizing the *promise* is what makes "exactly
 * one draft per session" true rather than merely intended.
 *
 * A failed mint is not cached: the next file selection may legitimately retry.
 */
export function createDraftSession<T>(mint: () => Promise<T | null>): DraftSession<T> {
  let current: T | null = null;
  let inFlight: Promise<T | null> | null = null;

  return {
    async get() {
      if (current) return current;
      if (!inFlight) {
        inFlight = mint().then(
          (value) => {
            current = value;
            inFlight = null;
            return value;
          },
          (err) => {
            inFlight = null;
            throw err;
          },
        );
      }
      return inFlight;
    },
    reset() {
      current = null;
      inFlight = null;
    },
  };
}

export type SubmitGuard = {
  /** True if the caller may submit. False means one is already in flight. */
  begin(): boolean;
  end(): void;
  readonly inFlight: boolean;
};

/**
 * The guard behind the disabled submit button.
 *
 * It lives here rather than as a bare `disabled` attribute because BK-02
 * declined idempotency on the strength of this button — a double submit would
 * otherwise hit the visitor's *own* booking's 409 and read as "someone took
 * your slot". A DOM attribute cannot be asserted by a pure script, and "the
 * button looked greyed out" is not evidence.
 */
export function createSubmitGuard(): SubmitGuard {
  let busy = false;
  return {
    begin() {
      if (busy) return false;
      busy = true;
      return true;
    },
    end() {
      busy = false;
    },
    get inFlight() {
      return busy;
    },
  };
}
