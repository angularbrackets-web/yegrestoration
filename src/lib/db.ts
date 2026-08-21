import { neon } from '@neondatabase/serverless';

import type { AssessmentTier } from './booking-pricing';
import type { AppointmentStatus } from './booking-status';
import { readEnv } from './env';

export type Lead = {
  id: number;
  name: string;
  phone: string;
  email: string | null;
  /**
   * NULL since migration 004: the contact form is a general message channel
   * (BK-10), so "which service?" is optional and an absent one is a real,
   * expected value. Every render site must guard it — `SERVICE_LABELS[null]`
   * is `undefined`, and a template that falls back to the raw column prints
   * the word "null" into an admin page or, worse, a customer's email.
   */
  service: string | null;
  message: string | null;
  status: 'new' | 'read' | 'replied';
  /** `timestamptz` — the driver hands back a `Date`. See the note below. */
  replied_at: Date | null;
  created_at: Date;
};

/**
 * NOTE ON TIMESTAMP AND DATE COLUMNS
 *
 * `@neondatabase/serverless` deserializes `timestamptz` (OID 1184) and `date`
 * (OID 1082) into `Date` objects, so the booking types below say `Date` — that
 * is what a plain `SELECT` actually returns. Typing them as `string` (as they
 * originally were) let `row.slot_start === slot.toISOString()` typecheck while
 * never matching at runtime, which would show already-booked slots as free.
 *
 * `timestamptz` round-trips exactly: consume it as a `Date`, compare with
 * `.getTime()`. `date` does NOT — it is timezone-naive and parses at the
 * *server's* local midnight, which on Vercel (UTC) converts back to the
 * previous America/Edmonton day. So never read `blackout_dates.day` directly;
 * project it as `day::text` and use `BlackoutDayRow`.
 * `src/pages/api/booking/availability.ts` is the worked example.
 *
 * `Lead` above said `string` from BK-01 until BK-10 corrected it. It was a
 * documentation bug rather than a live one — every consumer wrapped the value
 * in `new Date(...)`, which takes either — but the corrected type is what the
 * driver returns, and `formatAdminTimestamp` takes a `Date`, so the leads
 * pages now hand it the column directly instead of re-parsing a lie.
 */

/** Where a job sits in the restoration process. Independent of `AppointmentStatus`. */
export type PipelineStage = 'assessment' | 'mitigation' | 'restoration';

/** Lifecycle of the booking itself. Only 'cancelled' releases the slot. */
/**
 * Re-exported from `booking-status.ts`, which owns the lifecycle and the
 * slot-hold predicate together — they are one decision, and separating the
 * enum from the rule that reads it is how the two drifted before BK-23.
 */
export type { AppointmentStatus };

/** Re-exported from the pricing module so a row type does not import a price table. */
export type { AssessmentTier };

export type Appointment = {
  id: number;
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
  /** Insurance only. Never include in an SMS body. */
  policy_number: string | null;
  /** Insurance only. Never include in an SMS body. */
  claim_number: string | null;
  pipeline_stage: PipelineStage;
  status: AppointmentStatus;
  /**
   * Which assessment the customer chose (BK-31). NULL for admin entries and for
   * every row predating migration 007 — see the migration for why that is
   * permanent rather than a backfill waiting to happen.
   *
   * Typed as the union rather than `string` so a render site cannot silently
   * print an unknown tier; the DB CHECK is what makes the narrowing true.
   */
  assessment_tier: AssessmentTier | null;
  /** UTC instant. Compare with `.getTime()`, never against an ISO string. */
  slot_start: Date;
  duration_minutes: number;
  source: 'web' | 'admin';
  /** Timestamp of CASL opt-in. Null means no consent — do not send SMS. */
  sms_consent_at: Date | null;
  /**
   * When the customer acknowledged the assessment fee terms (BK-27). Null is
   * correct and permanent for admin entries — exempt, the office explains the
   * terms on the phone — and for every row that predates migration 005.
   */
  terms_acked_at: Date | null;
  reminder_sent_at: Date | null;
  /** Set only when the customer's confirmation email actually sent. NULL = never sent. */
  confirmation_sent_at: Date | null;
  /** Set only when the office notification actually sent. NULL = nobody was told. */
  internal_notified_at: Date | null;
  admin_notes: string | null;
  cancelled_at: Date | null;

  // ── The review lifecycle's own columns (BK-23, migration 008) ────────────
  //
  // These were added to the TABLE by migration 008 and read by the admin
  // detail page from the day it shipped, but never declared here — so
  // `astro check` had eight errors against `[id].astro` and the ticket's gate
  // table recorded "typecheck: pass". `npm run build` cannot catch it: Vite
  // strips types without checking them, so the gate that would have failed is
  // the only one that was misread. Same family as the ROADMAP's
  // `verify:booking:admin:db` trap — a gate reported green while red.

  /** Stamped by the approve transition. NULL for anything never approved. */
  approved_at: Date | null;
  /** Stamped by the decline transition and by the stale-request expiry sweep. */
  declined_at: Date | null;
  /** For BK-25's alert timers. Nothing writes it yet. */
  escalated_at: Date | null;
  /** For BK-23 Task 6's unseen-files badge. Nothing writes it yet. */
  files_reviewed_at: Date | null;

  // The amounts as the office SETTLED them at approval — a snapshot, never
  // recomputed. Prices change under live rows, and the figure the approval
  // email quoted is the figure the receipt has to match. All NULL until the row
  // is approved; `travel_fee_cents` is the exception, `NOT NULL DEFAULT 0`,
  // because a travel fee is never computed and never auto-charged.
  assessment_amount_cents: number | null;
  travel_fee_cents: number;
  gst_cents: number | null;
  total_amount_cents: number | null;

  /**
   * When payment is due, or NULL on the PAY-NOW branch.
   *
   * NULL is an answer, not a missing value, and the expiry cron's predicate
   * depends on it being one — see `isPaymentOverdue` and
   * `api/cron/expire-payments.ts`. Never COALESCE it to a date.
   */
  payment_due_at: Date | null;
  /**
   * `not_required` is correct and permanent ONLY for rows predating migration
   * 008. Everything since starts `pending` at approval.
   */
  payment_status:
    | 'not_required'
    | 'pending'
    | 'paid'
    | 'refunded'
    | 'partially_refunded'
    | 'failed';

  // ── The payment block (BK-32, migration 010) ────────────────────────────

  /**
   * How the money arrived. NULL until it does.
   *
   * `'none'` is a $0.00 approval confirmed through the same `markPaid()` as
   * every other payment — a booking with no payment STEP. It is not
   * `payment_status = 'not_required'`, which means the older and different
   * thing: a row predating prepay entirely.
   */
  payment_method: 'stripe' | 'interac' | 'onsite' | 'none' | null;
  /**
   * WHAT ACTUALLY ARRIVED — never `total_amount_cents`, which is the snapshot
   * the approval settled and the approval email quoted. The two are separate
   * columns precisely so a disagreement between them is a fact somebody can
   * query rather than a number that quietly overwrote the other.
   */
  paid_amount_cents: number | null;
  /**
   * The reference for whatever kind of payment it was — an e-Transfer
   * reference the office typed, or the Stripe reference on the card path.
   * Separate from `stripe_payment_intent_id` below, which BK-33 refunds from.
   */
  payment_reference: string | null;
  /** Who asserted the e-Transfer arrived, and when. The audit trail. */
  interac_marked_by: string | null;
  interac_marked_at: Date | null;
  /**
   * Money landed somewhere it should not have — a double pay, a payment after
   * the slot was released, a session we minted but could not record. Read by
   * the admin list and the detail page.
   *
   * **Appended to, never overwritten**, and nothing clears it (BK-32 scope).
   */
  needs_attention: string | null;
  /** At most one live Checkout Session at a time; a re-approval expires the old one. */
  stripe_session_id: string | null;
  /** Card path only. BK-33 issues its refund from this. */
  stripe_payment_intent_id: string | null;
  paid_at: Date | null;

  // ── The refund block (BK-33, migration 011) ─────────────────────────────

  /**
   * The LAST refund's id, for a human opening the Stripe dashboard.
   *
   * **Deliberately not a record of every refund, and never a key for control
   * flow over money.** A charge can carry several refunds and this column holds
   * one id, so "is this event about the refund on this row?" is a question it
   * cannot answer. BK-33's plan review found a `refund.failed` handler that
   * asked it exactly that: refund A of $300 succeeds, refund B replaces the id,
   * B fails, the guard matches, and the arm erases a refund that genuinely went
   * back — restoring "Payment received" over returned money, which is the
   * defect BK-33 exists to fix.
   */
  stripe_refund_id: string | null;
  /**
   * THE TOTAL THAT HAS GONE BACK on this charge.
   *
   * ── WHERE THE FIGURE COMES FROM, PRECISELY ─────────────────────────────
   *
   * On the WEBHOOK path it is `charge.amount_refunded` — Stripe's own running
   * total — written as an overwrite, so a dashboard refund, a screen refund and
   * a redelivery of any of them converge on one number instead of summing into
   * a figure belonging to nobody. It may move DOWN: Stripe lowers that total
   * when a refund fails, and accepting the lower value is how the record
   * corrects itself.
   *
   * On the SCREEN path it is `refundPayment`'s own addition — what was already
   * refunded plus what Stripe just returned. **That is arithmetic, and it is
   * safe only because the claim's WHERE pins the first operand**: the claim is
   * exclusive and names `refunded_amount_cents`, so nothing can move the
   * balance between the read and the write.
   *
   * This paragraph used to say "never our own arithmetic, on every path", which
   * was false of the screen path and would have justified removing exactly the
   * guard that makes it true. Three prior instances of a stale comment becoming
   * a later reader's justification are recorded in the ROADMAP.
   *
   * Compared against `paid_amount_cents` — what arrived — to decide `refunded`
   * from `partially_refunded`, never against `total_amount_cents`, which is the
   * quote (see its own note above).
   */
  refunded_amount_cents: number | null;
  refunded_at: Date | null;
  /**
   * The in-flight refund attempt. **Holds no money state, and that is the
   * point.**
   *
   * A Stripe idempotency key is not a dedupe: Stripe's documentation says keys
   * may be pruned once 24 hours old and a reused key then generates a NEW
   * request, and a request conflicting with another executing concurrently is
   * not saved as an idempotent result at all. So the exclusivity lives here.
   * `refund_claim_key IS NULL` in the claiming UPDATE is what makes a second
   * click, a second tab and a second office member match zero rows.
   *
   * Cleared on settle so a later deliberate partial refund can claim. Left
   * standing in exactly one case — a Stripe call whose answer never arrived —
   * where refusing further refunds until a human looks is the safe direction.
   */
  refund_claim_key: string | null;
  refund_started_at: Date | null;

  created_at: Date;
  updated_at: Date;
};

/**
 * One Stripe webhook delivery (BK-32, migration 010).
 *
 * `processed_at` is the load-bearing column: the insert CLAIMS an event, the
 * stamp records that it was handled, and an unstamped event is claimed again on
 * retry. Without it "already present" would mean "already handled", and a
 * handler dying between the two would let the expiry cron release the slot of a
 * booking the customer had paid for.
 */
export type StripeEvent = {
  event_id: string;
  type: string;
  received_at: Date;
  processed_at: Date | null;
};

export type AppointmentFile = {
  id: number;
  /** Null until the booking that owns this upload commits. */
  appointment_id: number | null;
  draft_id: string;
  pathname: string;
  url: string | null;
  content_type: string;
  /**
   * `BIGINT`, which `@neondatabase/serverless` deserializes as a STRING the way
   * `pg` does — a bigint does not fit a JS number, so the driver refuses to
   * guess. Typed `number` this column let `size_bytes / 1024` typecheck and
   * produce `NaN`; `formatFileSize` and `upload-token.ts` both already coerce.
   * See the note above on timestamp columns: same class of bug, opposite
   * direction.
   */
  size_bytes: string | number | null;
  original_name: string | null;
  upload_state: 'pending' | 'uploaded';
  /**
   * Who put this file here (BK-40, migration 006).
   *
   * `web` is the public booking funnel, `link` a customer using the texted
   * upload link, `office` an agent using the uploader on the admin page. The
   * last two are told apart by a signed claim inside the upload token, never by
   * anything the caller sends.
   *
   * NULL is correct and permanent for every row written before migration 006,
   * and renders as "source not recorded" — never as a guess. Nothing was
   * backfilled, because a backfilled guess is indistinguishable from a fact the
   * moment it lands.
   */
  source: 'web' | 'link' | 'office' | null;
  /**
   * Soft delete (BK-40). Non-null hides the row from the admin list, from the
   * file proxy, and from the upload caps — the BYTES ARE LEFT IN THE STORE on
   * purpose, so a mistaken click is recoverable. Every query that lists or
   * serves files must carry `deleted_at IS NULL`.
   */
  deleted_at: Date | null;
  /** The office's own words on why. The queryable half of the audit line. */
  deleted_note: string | null;
  created_at: Date;
};

export type BlackoutDate = {
  /**
   * A bare `SELECT day` returns this as a `Date` parsed at the server's local
   * midnight, which is the wrong calendar day once the server is UTC. Read it
   * through `BlackoutDayRow` instead.
   */
  day: Date;
  reason: string | null;
  created_at: Date;
};

/** The safe projection of `blackout_dates`: `SELECT day::text AS day`. */
export type BlackoutDayRow = {
  /** Local calendar date, `YYYY-MM-DD`. */
  day: string;
};

export function getDb() {
  const url = readEnv('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL is not configured');
  return neon(url);
}

export const SERVICE_LABELS: Record<string, string> = {
  water: 'Water Damage Restoration',
  fire: 'Fire Damage Restoration',
  mold: 'Mold Removal',
  storm: 'Storm Damage Repair',
  sewage: 'Sewage Cleanup',
  construction: 'Construction Services',
  contents: 'Contents Restoration',
  biohazard: 'Biohazard Cleaning',
  asbestos: 'Asbestos Abatement',
  other: 'Other Emergency',
};
