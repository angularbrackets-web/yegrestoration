/**
 * Parsing and validation for the admin write forms: manual entry, the
 * status/stage/notes edit, and the two blackout forms.
 *
 * Pure — no database, no environment, no clock of its own — so
 * `scripts/verify-booking-admin-entry.ts` can drive it exhaustively under `tsx`.
 * The set of valid services is injected rather than imported for the same
 * reason `booking-payload.ts` injects it: `SERVICE_LABELS` lives in `db.ts`
 * beside the Neon import.
 *
 * THE ONE RULE THAT MAKES THIS FILE SHORT. Manual entry does not restate the
 * field rules — it builds the slot instant, then hands a record to
 * `parseBookingPayload`. Contact, service, address, and insurance validation
 * are therefore the *same code* the public form runs, and cannot drift from it.
 * What admin changes is the slot rule alone: `isSlotOnGrid` and nothing else.
 *
 * Admin bypasses all four public windows — 4 h notice, 14-day horizon, closed
 * Fridays, blackout days — because emergencies and follow-ups are phoned in
 * (ROADMAP, and the user's decision 2 on this ticket). The bypass is expressed
 * by *not calling* `isSlotBookable`, never by a flag threaded through it: an
 * `isAdmin` parameter on a shared predicate is how the public path
 * accidentally inherits the bypass. Grid snap and the partial unique index
 * still hold, and they are what the locked 30-minute CHECK depends on.
 *
 * BK-22 added a second admin exemption — no mandatory email, no mandatory
 * photo — and it does NOT get the same treatment, because it cannot: those are
 * fields inside a parse both paths need in full, not a whole predicate admin
 * declines to call. It rides a `ParseOptions.entry` discriminator instead. What
 * preserves the rule above is that the exemption is unnameable from outside:
 * `parseAdminEntry` hard-codes `entry: 'admin'` at the call below and its
 * signature `Omit`s the field, so no caller can hand the public form the
 * bypass. The reasoning is written out at `ParseOptions` in `booking-payload.ts`.
 */

import { SLOT_START_TIMES } from './booking-config';
import {
  isSlotOnGrid,
  isValidDateKey,
  zonedTimeToUtc,
  type DateKey,
} from './booking-time';
import {
  parseBookingPayload,
  type BookingPayload,
  type FieldError,
  type ParseOptions,
} from './booking-payload';
import { isAssessmentTier, type AssessmentTier } from './booking-pricing';
import type { AppointmentStatus, PipelineStage } from './db';

export type { FieldError, ParseOptions };

/** The closed sets the update form validates against. Mirrors the DB CHECKs. */
export const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
  'booked',
  'completed',
  'cancelled',
  'no_show',
];

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  'assessment',
  'mitigation',
  'restoration',
];

/** `id` is a SERIAL; anything past int4 is a 22003 from Postgres, not a missing row. */
const MAX_ID = 2147483647;

/**
 * Notes are free text in a TEXT column, so the cap is a form-input sanity bound
 * rather than a schema one. Matched to `description`'s so the two office-typed
 * long fields behave alike.
 */
export const MAX_ADMIN_NOTES = 4000;

/** Blackout reasons are a short label ("Christmas Day"), not a note field. */
export const MAX_BLACKOUT_REASON = 200;

/**
 * BK-35's audit line, written when the office unticks send-confirmation.
 *
 * A sentence rather than a code, because a human reads it on the detail page.
 * The `console.warn` beside it is for whoever is debugging; THIS is for whoever
 * is answering a customer who says they were never told.
 */
export const UNTICKED_NOTE = 'Confirmation email not sent — send-confirmation was unticked.';

/**
 * Append the audit line to whatever the office typed.
 *
 * Appended, never overwriting: their note is the primary content of that column
 * and this is a footnote on it.
 *
 * DELIBERATELY NOT CAPPED AT `MAX_ADMIN_NOTES`. That constant is a form-input
 * sanity bound, not a schema one — `admin_notes` is a bare `TEXT` column, as
 * documented above it — so pushing a near-cap note past the line cannot fail
 * the insert. Truncating to stay under it could drop the office's own words to
 * make room for ours, which is the wrong trade on a record they typed. It lives
 * here rather than in the route so a verify script can reach it without
 * importing an API endpoint.
 */
export function appendUntickedNote(notes: string | null): string {
  return notes ? `${notes}\n\n${UNTICKED_NOTE}` : UNTICKED_NOTE;
}

/**
 * Why the office removed a file (BK-40). Optional, short, free text.
 *
 * A label, not a note field — "wrong appointment", "duplicate", "customer
 * asked" — which is why the bound is `MAX_BLACKOUT_REASON`-sized rather than
 * `MAX_ADMIN_NOTES`-sized.
 */
export const MAX_FILE_DELETE_NOTE = 200;

/**
 * Normalise the delete reason to what the column should hold.
 *
 * Empty and whitespace-only both become NULL rather than `''`. The two would
 * render identically and mean different things — one is "no reason given", the
 * other is "a reason was given and it was blank" — and only the first is true.
 *
 * TRUNCATED, NOT REJECTED. This is the audit trail on a delete that has
 * *already been decided*; refusing the whole action because the reason ran long
 * would lose the deletion over a footnote. Nothing downstream re-applies this
 * bound the way `parseAppointmentUpdate` re-applies the notes cap, so the
 * truncation cannot come back as a rejected edit later.
 */
export function parseFileDeleteNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, MAX_FILE_DELETE_NOTE);
}

/**
 * The longest value `admin_notes` can legitimately HOLD, as opposed to the
 * longest a human may type.
 *
 * These are two different bounds and conflating them was a real defect, caught
 * in implementation review. `MAX_ADMIN_NOTES` bounds the textarea; the append
 * above then adds a blank line and the audit line on top, so a note typed at the
 * cap is stored at 4063. `parseAppointmentUpdate` re-applies its cap on the way
 * back IN, and the detail page renders the stored value into the same form as
 * `status` and `pipeline_stage` — so above 3937 typed characters, every later
 * status change was rejected with "That edit was not valid. Nothing was saved.",
 * naming no field, and the appointment could not be moved through the pipeline
 * until somebody hand-deleted text the system itself had written. `maxlength`
 * does not save it either: per WHATWG HTML, `suffering from being too long`
 * requires the dirty value flag and a user edit, so a too-long INITIAL value is
 * submitted without complaint.
 *
 * Widening the read-back bound rather than reserving headroom at entry, because
 * the alternative makes the typing limit depend on a checkbox — the office would
 * see "max 4000" while being cut off at 3937, which trades a rare dead end for a
 * permanent lie.
 */
export const MAX_STORED_ADMIN_NOTES = MAX_ADMIN_NOTES + UNTICKED_NOTE.length + 2;

/**
 * Field names the entry form reports back through the redirect.
 *
 * Error CODES travel, never typed values (plan-review should-fix 4): a booking
 * carries a name, an address and insurance identifiers, and a query string is
 * written into platform request logs. The office retypes — the form is short
 * and it is theirs. The page renders labels from this map and drops anything
 * not in it, so a hand-crafted `?err=` cannot put arbitrary text on the page.
 */
export const ADMIN_ENTRY_FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  phone: 'Phone number',
  email: 'Email',
  service: 'Service',
  description: 'What happened',
  address: 'Address',
  city: 'City',
  postal_code: 'Postal code',
  payment_route: 'Payment route',
  insurer_name: 'Insurance company',
  policy_number: 'Policy number',
  claim_number: 'Claim number',
  slot_date: 'Date',
  slot_time: 'Time',
  slot_start: 'Time',
  admin_notes: 'Office notes',
  assessment_tier: 'Assessment',
};

export type AdminEntryResult =
  | {
      ok: true;
      payload: BookingPayload;
      sendConfirmation: boolean;
      /** Office note typed with the entry. Not a `BookingPayload` field — it is not the customer's. */
      adminNotes: string | null;
    }
  | { ok: false; errors: FieldError[] };

/**
 * A grid instant handed to `parseBookingPayload` only when the real slot has
 * already failed its own checks, so that the public parser does not report a
 * second, differently-worded error for a field this module already reported
 * on. Never stored: every path that reaches it returns errors.
 */
const PLACEHOLDER_SLOT = zonedTimeToUtc('2026-01-01', SLOT_START_TIMES[0]);

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * An unchecked HTML checkbox submits *nothing*; a checked one submits its
 * value. So presence is the whole signal, and it is deliberately not compared
 * against `'on'` — the value attribute is the template's to choose.
 *
 * This is how `sms_consent_at` gets set, which makes it a CASL rule and not a
 * form detail: the timestamp exists only when the office attested that consent
 * was given out loud. It is never defaulted and never backfilled.
 */
function checked(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

/**
 * Parse the manual-entry form.
 *
 * The slot arrives as a date input plus a select of the five grid times, so
 * `zonedTimeToUtc` builds the instant from wall-clock parts — the DST-aware,
 * red-verified helper. Hand-assembling the UTC instant from a `Date` and an
 * hour offset is the wrong-day bug this codebase already paid for once.
 *
 * `isSlotOnGrid` still runs afterwards even though the time comes from a
 * closed select: it is the check the partial unique index depends on, and the
 * select is client-side state that a form post does not have to respect.
 */
export function parseAdminEntry(
  input: unknown,
  options: Omit<ParseOptions, 'entry'>,
): AdminEntryResult {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ field: '_', message: 'Expected a form submission.' }] };
  }
  const raw = input;
  const errors: FieldError[] = [];

  const dateKey = str(raw.slot_date);
  const time = str(raw.slot_time);

  let slotStart: Date | null = null;
  if (!dateKey || !isValidDateKey(dateKey)) {
    errors.push({ field: 'slot_date', message: 'Choose a valid date.' });
  } else if (!time || !(SLOT_START_TIMES as readonly string[]).includes(time)) {
    errors.push({ field: 'slot_time', message: 'Choose one of the five appointment times.' });
  } else {
    const instant = zonedTimeToUtc(dateKey as DateKey, time);
    if (!isSlotOnGrid(instant)) {
      // Unreachable while SLOT_START_TIMES is the grid — which is the point.
      // If the two ever disagree, this is the assertion that says so rather
      // than an off-grid row the unique index cannot see.
      errors.push({ field: 'slot_time', message: 'That is not an appointment start time.' });
    } else {
      slotStart = instant;
    }
  }

  // Everything except the slot is validated by the public parser, from a record
  // it builds itself so no forbidden key can be smuggled through the form.
  const parsed = parseBookingPayload(
    {
      name: raw.name,
      phone: raw.phone,
      email: raw.email,
      service: raw.service,
      description: raw.description,
      address: raw.address,
      city: raw.city,
      postal_code: raw.postal_code,
      payment_route: raw.payment_route,
      insurer_name: raw.insurer_name,
      policy_number: raw.policy_number,
      claim_number: raw.claim_number,
      slot_start: (slotStart ?? PLACEHOLDER_SLOT).toISOString(),
      sms_consent: checked(raw.sms_consent),
    },
    // `entry` is hard-coded here and deliberately NOT forwarded from the
    // caller, which is why the parameter type omits it. The client's exemption
    // (ROADMAP P7, 2026-08-12) is: "if we enter ourselves we will ask them to
    // text pictures/videos. It won't go to review process." So an admin entry
    // needs neither an email address nor a photo, and BK-22's public
    // requirements must not reach it.
    //
    // Hard-coding is what makes that structural rather than conventional: no
    // caller of `parseAdminEntry` can make it behave like the public form,
    // because the type forbids them supplying the field at all. Forwarding
    // would additionally leave the admin route holding a live-looking
    // `entry: 'public'` that did nothing — a comment that lies in type form.
    // Do not "fix" this asymmetry with the public route.
    { ...options, entry: 'admin' },
  );

  const adminNotes = str(raw.admin_notes);
  if (adminNotes && adminNotes.length > MAX_ADMIN_NOTES) {
    errors.push({ field: 'admin_notes', message: `Notes are too long (max ${MAX_ADMIN_NOTES}).` });
  }

  if (!parsed.ok) errors.push(...parsed.errors);
  if (errors.length > 0 || !parsed.ok) {
    // The second half of that condition is unreachable — a failed parse pushes
    // errors — and is written anyway so `parsed` narrows without a cast.
    return { ok: false, errors };
  }

  return {
    ok: true,
    payload: parsed.payload,
    sendConfirmation: checked(raw.send_confirmation),
    adminNotes,
  };
}

export type AppointmentUpdate = {
  id: number;
  status?: AppointmentStatus;
  pipeline_stage?: PipelineStage;
  /** Present when the notes field was submitted at all; null clears them. */
  admin_notes?: string | null;
  /**
   * Present when the tier select was submitted at all; null is the "Not chosen"
   * option and clears it (BK-31).
   *
   * Editable because a customer who upgrades on site has to be recordable. It
   * does NOT re-charge anything — the control says so beside itself, because
   * under P9 this row may already have been paid against.
   */
  assessment_tier?: AssessmentTier | null;
};

export type UpdateParseResult =
  | { ok: true; update: AppointmentUpdate }
  | { ok: false; errors: FieldError[] };

/**
 * Whitelist the appointment edit. Nothing outside `AppointmentUpdate` survives.
 *
 * The whitelist is the point, not a formality. `slot_start` is not editable
 * (rescheduling is cancel + re-enter, because a slot-moving UPDATE needs its
 * own conflict story), `duration_minutes` is not editable (the locked
 * `= 30` CHECK is what makes the identical-start-time index sufficient), and
 * neither are the insurance identifiers — the entry form is where those are
 * set, once.
 *
 * Because the return type carries only these keys and the caller's SQL names
 * columns literally, an unknown key in the record cannot reach an UPDATE even
 * by accident. That is a stronger guarantee than filtering a key list.
 */
export function parseAppointmentUpdate(input: unknown): UpdateParseResult {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ field: '_', message: 'Expected a form submission.' }] };
  }
  const raw = input;
  const errors: FieldError[] = [];

  const id = parseAppointmentId(raw.id);
  if (id === null) errors.push({ field: 'id', message: 'Missing or invalid appointment.' });

  const update: AppointmentUpdate = { id: id ?? 0 };

  const status = str(raw.status);
  if (status !== null) {
    if ((APPOINTMENT_STATUSES as readonly string[]).includes(status)) {
      update.status = status as AppointmentStatus;
    } else {
      errors.push({ field: 'status', message: 'Choose one of the listed statuses.' });
    }
  }

  const stage = str(raw.pipeline_stage);
  if (stage !== null) {
    if ((PIPELINE_STAGES as readonly string[]).includes(stage)) {
      update.pipeline_stage = stage as PipelineStage;
    } else {
      errors.push({ field: 'pipeline_stage', message: 'Choose one of the listed stages.' });
    }
  }

  // Same absent-vs-empty distinction as the notes below: the select always
  // posts, and its empty option means "not chosen" rather than "leave alone".
  // A tier is never invented here — an unrecognised value is an error, not a
  // fallback, on the same reasoning as the public door's.
  if (typeof raw.assessment_tier === 'string') {
    const tier = str(raw.assessment_tier);
    if (tier === null) {
      update.assessment_tier = null;
    } else if (isAssessmentTier(tier)) {
      update.assessment_tier = tier;
    } else {
      errors.push({ field: 'assessment_tier', message: 'Choose one of the listed assessments.' });
    }
  }

  // Distinguished from absent on purpose: a submitted-but-empty textarea is the
  // office clearing the notes, and must write NULL rather than being ignored.
  if (typeof raw.admin_notes === 'string') {
    const notes = str(raw.admin_notes);
    // `MAX_STORED_ADMIN_NOTES`, not `MAX_ADMIN_NOTES` — see that constant. This
    // is the READ-BACK bound, and it has to tolerate what BK-35's audit line
    // appended on the way in, or a row the system wrote becomes a row nobody can
    // edit. The message still quotes the typing cap, which is the number the
    // office is actually working against.
    if (notes && notes.length > MAX_STORED_ADMIN_NOTES) {
      errors.push({ field: 'admin_notes', message: `Notes are too long (max ${MAX_ADMIN_NOTES}).` });
    } else {
      update.admin_notes = notes;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, update };
}

/**
 * `/admin/appointments/12/` and a hidden `id` field are the same value, parsed
 * the same way. No leading zeros — `0000000012` is a second URL for one row.
 */
export function parseAppointmentId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_ID) {
    return value;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[1-9][0-9]{0,9}$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return id <= MAX_ID ? id : null;
}

export type BlackoutInput = { day: DateKey; reason: string | null };

export type BlackoutParseResult =
  | { ok: true; input: BlackoutInput }
  | { ok: false; errors: FieldError[] };

/**
 * The add form: a local calendar date plus an optional label.
 *
 * `isValidDateKey` rather than `new Date(...)`, because the column is `DATE`
 * and the value is a *calendar day*, not an instant — parsing it as one puts it
 * on the server's midnight, which on Vercel is UTC and lands on the previous
 * Edmonton day. The PK column is `day`, not `date` (locked).
 */
export function parseBlackoutInput(input: unknown): BlackoutParseResult {
  if (!isRecord(input)) {
    return { ok: false, errors: [{ field: '_', message: 'Expected a form submission.' }] };
  }
  const errors: FieldError[] = [];

  const day = parseBlackoutDay(input.day);
  if (day === null) errors.push({ field: 'day', message: 'Choose a valid date.' });

  const reason = str(input.reason);
  if (reason && reason.length > MAX_BLACKOUT_REASON) {
    errors.push({ field: 'reason', message: `Reason is too long (max ${MAX_BLACKOUT_REASON}).` });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, input: { day: day as DateKey, reason } };
}

/** The delete form's only field, validated exactly as the add form's is. */
export function parseBlackoutDay(value: unknown): DateKey | null {
  const day = str(value);
  return day !== null && isValidDateKey(day) ? day : null;
}
